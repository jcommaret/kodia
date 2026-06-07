/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { MistralCore } from '@mistralai/mistralai/core.js';
import { betaConversationsStartStream } from '@mistralai/mistralai/funcs/betaConversationsStartStream.js';
import { betaConversationsAppendStream } from '@mistralai/mistralai/funcs/betaConversationsAppendStream.js';
import { betaConversationsGetHistory } from '@mistralai/mistralai/funcs/betaConversationsGetHistory.js';
import { modelsList } from '@mistralai/mistralai/funcs/modelsList.js';
import type { ConversationAppendStreamRequest, ConversationEvents, ConversationHistory, ConversationStreamRequest } from '@mistralai/mistralai/models/components/index.js';
import type { EventStream } from '@mistralai/mistralai/lib/event-streams.js';
import type { Result } from '@mistralai/mistralai/types/fp.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../instantiation/common/instantiation.js';

/**
 * A tool-capable Mistral model, normalized for the agent host. Derived from
 * the Mistral `/v1/models` catalog (`modelsList`).
 */
export interface IMistralModel {
	readonly id: string;
	readonly name: string;
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

	/** The full model catalog, normalized. Callers filter by capability. */
	models(apiKey: string, options?: IMistralRequestOptions): Promise<IMistralModel[]>;

	/** Open a new conversation and stream its events. Creates the conversation server-side. */
	startConversationStream(apiKey: string, request: ConversationStreamRequest, options?: IMistralRequestOptions): Promise<EventStream<ConversationEvents>>;

	/** Append to an existing conversation (next turn, or a tool result) and stream its events. */
	appendConversationStream(apiKey: string, conversationId: string, request: ConversationAppendStreamRequest, options?: IMistralRequestOptions): Promise<EventStream<ConversationEvents>>;

	/** Fetch the server-side transcript for a conversation (used for restoration). */
	getConversationHistory(apiKey: string, conversationId: string, options?: IMistralRequestOptions): Promise<ConversationHistory>;
}

export class MistralApiService extends Disposable implements IMistralApiService {
	declare readonly _serviceBrand: undefined;

	/** `MistralCore` is cheap but holds config; cache one per API key. */
	private readonly _coreByKey = new Map<string, MistralCore>();

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
		const list = await this._unwrap(modelsList(this._core(apiKey), undefined, this._requestOptions(options)));
		return (list.data ?? []).map(m => ({
			id: m.id,
			name: m.name ?? m.id,
			maxContextWindow: m.maxContextLength ?? undefined,
			supportsFunctionCalling: m.capabilities?.functionCalling ?? false,
			supportsVision: m.capabilities?.vision ?? false,
		}));
	}

	startConversationStream(apiKey: string, request: ConversationStreamRequest, options?: IMistralRequestOptions): Promise<EventStream<ConversationEvents>> {
		return this._unwrap(betaConversationsStartStream(this._core(apiKey), request, this._requestOptions(options)));
	}

	appendConversationStream(apiKey: string, conversationId: string, request: ConversationAppendStreamRequest, options?: IMistralRequestOptions): Promise<EventStream<ConversationEvents>> {
		return this._unwrap(betaConversationsAppendStream(
			this._core(apiKey),
			{ conversationId, conversationAppendStreamRequest: request },
			this._requestOptions(options),
		));
	}

	getConversationHistory(apiKey: string, conversationId: string, options?: IMistralRequestOptions): Promise<ConversationHistory> {
		return this._unwrap(betaConversationsGetHistory(this._core(apiKey), { conversationId }, this._requestOptions(options)));
	}

	override dispose(): void {
		this._coreByKey.clear();
		super.dispose();
	}
}
