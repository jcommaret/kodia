/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { MistralCore } from '@mistralai/mistralai/core.js';
import { betaConversationsStartStream } from '@mistralai/mistralai/funcs/betaConversationsStartStream.js';
import { betaConversationsAppendStream } from '@mistralai/mistralai/funcs/betaConversationsAppendStream.js';
import { betaConversationsGetHistory } from '@mistralai/mistralai/funcs/betaConversationsGetHistory.js';
import { modelsList } from '@mistralai/mistralai/funcs/modelsList.js';
import type { BaseModelCard, ConversationAppendStreamRequest, ConversationEvents, ConversationHistory, ConversationStreamRequest, FTModelCard } from '@mistralai/mistralai/models/components/index.js';
import type { EventStream } from '@mistralai/mistralai/lib/event-streams.js';
import type { Result } from '@mistralai/mistralai/types/fp.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../instantiation/common/instantiation.js';
import { AgentHostMistralRequestsPerSecondEnvVar } from '../../common/agentService.js';
import { isRateLimitError, retryAfterMs, TokenBucketRateLimiter } from './mistralRateLimiter.js';

/**
 * A tool-capable Mistral model, normalized for the agent host. Derived from
 * the Mistral `/v1/models` catalog (`modelsList`).
 */
export interface IMistralModel {
	readonly id: string;
	readonly name: string;
	/** Alias ids that point to this model (e.g. `mistral-large-latest` for `mistral-large-2512`). */
	readonly aliases?: readonly string[];
	/** `maxContextLength` from the catalog, when advertised. */
	readonly maxContextWindow: number | undefined;
	/** Whether the model advertises the `function_calling` capability. */
	readonly supportsFunctionCalling: boolean;
	readonly supportsVision: boolean;
}

export interface IMistralRequestOptions {
	readonly signal?: AbortSignal;
}

export const IMistralApiService = createDecorator<IMistralApiService>('mistralApiService');

/**
 * Thin wrapper over `@mistralai/mistralai` (the tree-shakable `MistralCore` +
 * `funcs/*` surface, matching the existing FIM usage in
 * `workbench/contrib/void/.../sendLLMMessage.impl.ts`).
 *
 * The agent host's Mistral provider builds its turn loop on the **Conversations
 * / Agents API** (`beta.conversations.*`), which manages conversation state and
 * history server-side and natively models client-executed function tools — see
 * `node/mistral/roadmap.md`. This service is the single seam to that API so the
 * agent (and its tests) never construct a `MistralCore` directly.
 *
 * The API key is passed per call (mirroring `ICopilotApiService.models(token)`);
 * a `MistralCore` is cached per key.
 */
export interface IMistralApiService {
	readonly _serviceBrand: undefined;

	/**
	 * Set the client-side requests-per-second cap applied to every call below.
	 * `0` (or negative) disables the proactive throttle; `429` responses are
	 * still retried with backoff regardless. Initialized at construction from
	 * {@link AgentHostMistralRequestsPerSecondEnvVar}; exposed so a future live
	 * config channel (or tests) can update the rate without a restart.
	 */
	setRateLimit(requestsPerSecond: number): void;

	/** The full model catalog, normalized. Callers filter by capability. */
	models(apiKey: string, options?: IMistralRequestOptions): Promise<IMistralModel[]>;

	/** Open a new conversation and stream its events. Creates the conversation server-side. */
	startConversationStream(apiKey: string, request: ConversationStreamRequest, options?: IMistralRequestOptions): Promise<EventStream<ConversationEvents>>;

	/** Append to an existing conversation (next turn, or a tool result) and stream its events. */
	appendConversationStream(apiKey: string, conversationId: string, request: ConversationAppendStreamRequest, options?: IMistralRequestOptions): Promise<EventStream<ConversationEvents>>;

	/** Fetch the server-side transcript for a conversation (used for restoration). */
	getConversationHistory(apiKey: string, conversationId: string, options?: IMistralRequestOptions): Promise<ConversationHistory>;
}

/** Cap on automatic retries of a `429` response before the error propagates. */
const MISTRAL_RATE_LIMIT_MAX_RETRIES = 4;
/** Base delay for exponential backoff (doubles each attempt). */
const MISTRAL_RATE_LIMIT_BASE_BACKOFF_MS = 500;
/**
 * Ceiling for a single backoff wait (before jitter). Matches the 60-second
 * token-per-minute window: after waiting this long the budget is guaranteed to
 * have reset, so a retry should succeed without a further 429.
 */
const MISTRAL_RATE_LIMIT_MAX_BACKOFF_MS = 60_000;
/** Random jitter added to a computed backoff to avoid thundering herds. */
const MISTRAL_RATE_LIMIT_JITTER_MS = 250;

/** A `setTimeout`-based delay that rejects (rather than waits) on abort. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error('Aborted'));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal!.reason ?? new Error('Aborted'));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

export class MistralApiService extends Disposable implements IMistralApiService {
	declare readonly _serviceBrand: undefined;

	/** `MistralCore` is cheap but holds config; cache one per API key. */
	private readonly _coreByKey = new Map<string, MistralCore>();

	/**
	 * Smooths request *starts* to stay under Mistral's per-workspace rate limit.
	 * Seeded from {@link AgentHostMistralRequestsPerSecondEnvVar} (the setting
	 * defaults to `1`); falls back to `0` — no proactive throttle — only when the
	 * env var is unset, e.g. an agent host started outside the workbench starters.
	 */
	private readonly _rateLimiter = this._register(
		new TokenBucketRateLimiter(Number(process.env[AgentHostMistralRequestsPerSecondEnvVar]) || 0),
	);

	setRateLimit(requestsPerSecond: number): void {
		this._rateLimiter.setRate(requestsPerSecond);
	}

	/**
	 * Runs `fn` behind the rate limiter, retrying `429` responses with
	 * exponential backoff (honouring a `Retry-After` header when present). Other
	 * errors, an exhausted retry budget, or an aborted signal propagate at once.
	 */
	private async _rateLimited<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			await this._rateLimiter.acquire();
			try {
				return await fn();
			} catch (err) {
				if (signal?.aborted || attempt >= MISTRAL_RATE_LIMIT_MAX_RETRIES || !isRateLimitError(err)) {
					throw err;
				}
				let backoffMs = retryAfterMs(err);
				if (backoffMs === undefined) {
					const exponential = Math.min(MISTRAL_RATE_LIMIT_MAX_BACKOFF_MS, MISTRAL_RATE_LIMIT_BASE_BACKOFF_MS * (2 ** attempt));
					backoffMs = exponential + Math.floor(Math.random() * MISTRAL_RATE_LIMIT_JITTER_MS);
				}
				await delay(backoffMs, signal);
			}
		}
	}

	private _core(apiKey: string): MistralCore {
		let core = this._coreByKey.get(apiKey);
		if (!core) {
			core = new MistralCore({ apiKey });
			this._coreByKey.set(apiKey, core);
		}
		return core;
	}

	private _requestOptions(options?: IMistralRequestOptions): { fetchOptions: { signal: AbortSignal } } | undefined {
		return options?.signal ? { fetchOptions: { signal: options.signal } } : undefined;
	}

	/** Unwrap the SDK's `Result` (`.ok`/`.value`/`.error`) into a plain promise. */
	private async _unwrap<T>(p: Promise<Result<T, unknown>>): Promise<T> {
		const res = await p;
		if (!res.ok) {
			throw res.error;
		}
		return res.value;
	}

	async models(apiKey: string, options?: IMistralRequestOptions): Promise<IMistralModel[]> {
		const list = await this._rateLimited(options?.signal, () => this._unwrap(modelsList(this._core(apiKey), undefined, this._requestOptions(options))));
		// v2 types the catalog as `BaseModelCard | FTModelCard | Unknown<"type">`; drop the
		// Unknown fallback (no id/capabilities) before reading model fields.
		const cards = (list.data ?? [])
			.filter((m): m is BaseModelCard | FTModelCard => m.type === 'base' || m.type === 'fine-tuned');
		// The catalog returns alias ids (e.g. `mistral-large-latest`) as their own
		// entries alongside the concrete dated id they point to (e.g. `mistral-large-2512`),
		// so a model shows up twice in the picker. Drop any card whose id is listed as
		// another card's alias, keeping the single canonical entry.
		const aliasedIds = new Set<string>();
		for (const m of cards) {
			for (const alias of m.aliases ?? []) {
				aliasedIds.add(alias);
			}
		}
		return cards
			.filter(m => !aliasedIds.has(m.id))
			.map(m => ({
				id: m.id,
				name: m.name ?? m.id,
				aliases: m.aliases ?? [],
				maxContextWindow: m.maxContextLength ?? undefined,
				supportsFunctionCalling: m.capabilities?.functionCalling ?? false,
				supportsVision: m.capabilities?.vision ?? false,
			}));
	}

	startConversationStream(apiKey: string, request: ConversationStreamRequest, options?: IMistralRequestOptions): Promise<EventStream<ConversationEvents>> {
		return this._rateLimited(options?.signal, () => this._unwrap(betaConversationsStartStream(this._core(apiKey), request, this._requestOptions(options))));
	}

	appendConversationStream(apiKey: string, conversationId: string, request: ConversationAppendStreamRequest, options?: IMistralRequestOptions): Promise<EventStream<ConversationEvents>> {
		return this._rateLimited(options?.signal, () => this._unwrap(betaConversationsAppendStream(
			this._core(apiKey),
			{ conversationId, conversationAppendStreamRequest: request },
			this._requestOptions(options),
		)));
	}

	getConversationHistory(apiKey: string, conversationId: string, options?: IMistralRequestOptions): Promise<ConversationHistory> {
		return this._rateLimited(options?.signal, () => this._unwrap(betaConversationsGetHistory(this._core(apiKey), { conversationId }, this._requestOptions(options))));
	}

	override dispose(): void {
		this._coreByKey.clear();
		super.dispose();
	}
}
