/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { SequencerByKey } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { ISyncedCustomization } from '../../common/agentPluginManager.js';
import { platformSessionSchema } from '../../common/agentHostSchema.js';
import { AgentHostMistralApiKeyEnvVar, AgentHostMistralResource, AgentProvider, AgentSession, AgentSignal, IAgent, IAgentCreateSessionConfig, IAgentCreateSessionResult, IAgentDescriptor, IAgentMaterializeSessionEvent, IAgentModelInfo, IAgentResolveSessionConfigParams, IAgentSessionConfigCompletionsParams, IAgentSessionMetadata, IAgentSessionProjectInfo } from '../../common/agentService.js';
import { ISessionDataService } from '../../common/sessionDataService.js';
import type { SessionAction } from '../../common/state/sessionActions.js';
import { ActionType } from '../../common/state/protocol/actions.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import { ProtectedResourceMetadata, ResponsePartKind, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, type ModelSelection, type ToolCallPendingConfirmationState, type ToolDefinition } from '../../common/state/protocol/state.js';
import { CustomizationRef, SessionInputResponseKind, type MessageAttachment, type SessionInputAnswer, type ToolCallResult, type Turn } from '../../common/state/sessionState.js';
import type { ConversationEvents, FunctionResultEntry, MessageOutputContentChunks } from '@mistralai/mistralai/models/components/index.js';
import type { EventStream } from '@mistralai/mistralai/lib/event-streams.js';
import { IMistralApiService, IMistralModel } from './mistralApiService.js';
import { MistralAgentSession } from './mistralAgentSession.js';
import { executeMistralTool, IMistralToolContext, IMistralToolResult, isMutatingTool, MISTRAL_TOOLS, toolDisplayName } from './mistralTools.js';

/** Safety cap on tool-call rounds within a single user turn. */
const MAX_TOOL_ROUNDS = 50;

/** One client tool call requested by the model in a stream. */
interface IMistralToolCall {
	readonly toolCallId: string;
	readonly name: string;
	readonly arguments: string;
}

function toToolCallResult(name: string, res: IMistralToolResult): ToolCallResult {
	return {
		success: res.success,
		pastTenseMessage: res.success ? `Ran ${toolDisplayName(name)}` : `${toolDisplayName(name)} failed`,
		content: [{ type: ToolResultContentType.Text, text: res.output }],
		...(res.success ? {} : { error: { message: res.output } }),
	};
}

/**
 * Normalize one `message.output.delta` payload into assistant text and/or
 * reasoning text. Mistral delivers a delta either as a bare string or as a
 * typed content chunk (text / thinking / tool refs / media). Phase 4 only
 * surfaces text and thinking; other chunk kinds are ignored until later phases.
 */
function extractDelta(content: string | MessageOutputContentChunks): { text?: string; reasoning?: string } {
	if (typeof content === 'string') {
		return { text: content };
	}
	switch (content.type) {
		case 'text':
			return { text: content.text };
		case 'thinking': {
			const reasoning = content.thinking.map(c => (c.type === 'text' ? c.text : '')).join('');
			return reasoning ? { reasoning } : {};
		}
		default:
			return {};
	}
}

/** Metadata keys persisted in the per-session SQLite DB (see {@link ISessionDataService}). */
const enum MistralSessionMetaKey {
	ConversationId = 'mistral.conversationId',
	Model = 'mistral.model',
	WorkingDirectory = 'mistral.workingDirectory',
	CreatedAt = 'mistral.createdAt',
}

/**
 * In-memory record for a session that has been created but not yet
 * materialized. Holds everything needed to promote it on the first
 * `sendMessage` without any network or disk I/O at create time.
 */
interface IMistralProvisionalSession {
	readonly sessionId: string;
	readonly sessionUri: URI;
	readonly workingDirectory: URI | undefined;
	readonly model: ModelSelection | undefined;
	readonly project: IAgentSessionProjectInfo | undefined;
}

/**
 * Static seed of tool-capable Mistral models advertised before the first
 * live `modelsList` fetch (Phase 2 replaces this with the real catalog,
 * filtered to models that advertise `function_calling`). All entries use the
 * OpenAI-style tool-calling format Void already exercises in
 * `sendLLMMessage.impl.ts`, so they are valid agent backends.
 *
 * Mirrors `defaultModelsOfProvider.mistral` /  `mistralModelOptions` in
 * `workbench/contrib/void/common/modelCapabilities.ts`.
 */
const MISTRAL_SEED_MODELS: ReadonlyArray<{ id: string; name: string; maxContextWindow: number }> = [
	{ id: 'devstral-latest', name: 'Devstral', maxContextWindow: 256_000 },
	{ id: 'codestral-latest', name: 'Codestral', maxContextWindow: 256_000 },
	{ id: 'mistral-large-latest', name: 'Mistral Large', maxContextWindow: 256_000 },
	{ id: 'mistral-medium-latest', name: 'Mistral Medium', maxContextWindow: 256_000 },
	{ id: 'mistral-small-latest', name: 'Mistral Small', maxContextWindow: 256_000 },
	{ id: 'magistral-medium-latest', name: 'Magistral Medium', maxContextWindow: 128_000 },
];

/**
 * `IAgent` backed by the Mistral API (`@mistralai/mistralai`).
 *
 * Unlike {@link import('../claude/claudeAgent.js').ClaudeAgent}, there is no
 * drop-in coding-agent SDK for Mistral: the agentic loop and all local tool
 * execution are implemented natively in this folder (`node/mistral/`). See
 * `roadmap.md` for the full phase plan and the architectural rationale.
 *
 * Phase 1 (this file): scaffold + registration + gating only. The provider is
 * discoverable, exposes its descriptor and a seed model list, and accepts an
 * API key via {@link authenticate}. Session operations throw `TODO: Phase N`
 * until later phases land — a workbench client can list Mistral and pick a
 * model, but cannot yet send a message.
 */
export class MistralAgent extends Disposable implements IAgent {
	readonly id: AgentProvider = 'mistral';

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	/** Fired by the native turn loop starting in Phase 4. */
	readonly onDidSessionProgress = this._onDidSessionProgress.event;

	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	/** Fired when a provisional session is promoted to a live {@link MistralAgentSession}. */
	private readonly _onDidMaterializeSession = this._register(new Emitter<IAgentMaterializeSessionEvent>());
	readonly onDidMaterializeSession = this._onDidMaterializeSession.event;

	/** Live, materialized sessions, keyed by raw session id. */
	private readonly _sessions = this._register(new DisposableMap<string, MistralAgentSession>());

	/** Created-but-not-yet-materialized sessions, keyed by raw session id. */
	private readonly _provisionalSessions = new Map<string, IMistralProvisionalSession>();

	/** Serializes `sendMessage` (incl. materialize) per session id. */
	private readonly _sessionSequencer = new SequencerByKey<string>();
	/** Serializes `disposeSession` per session id. */
	private readonly _disposeSequencer = new SequencerByKey<string>();

	/** Resolvers for in-flight tool approvals, keyed by tool call id. */
	private readonly _pendingPermissions = new Map<string, (approved: boolean) => void>();

	/**
	 * Mistral API key. Seeded from {@link AgentHostMistralApiKeyEnvVar} (the
	 * gate that registered this provider in the first place); {@link authenticate}
	 * can also set it. Used by the chat client from Phase 2.
	 */
	private _apiKey: string | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IMistralApiService private readonly _apiService: IMistralApiService,
		@ISessionDataService private readonly _sessionDataService: ISessionDataService,
	) {
		super();
		this._apiKey = process.env[AgentHostMistralApiKeyEnvVar] || undefined;
		// Seed synchronously so the picker is never empty, then replace with the
		// real, capability-filtered catalog from the Mistral API.
		this._models.set(this._buildSeedModels(), undefined);
		void this._refreshModels();
	}

	// #region Descriptor + auth

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: localize('mistralAgent.displayName', "Mistral"),
			description: localize('mistralAgent.description', "Mistral agent with a native, local tool-using harness backed by the Mistral API"),
		};
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		// Advertise a Mistral resource so the workbench can route the API key to
		// this agent via `authenticate`. It is NOT an OAuth resource — the
		// standard token resolver finds no token for it and skips it; the Void
		// key bridge pushes the key explicitly. `required: false` keeps it from
		// gating the agent behind a sign-in prompt.
		return [{ resource: AgentHostMistralResource, resource_name: 'Mistral', required: false }];
	}

	async authenticate(_resource: string, token: string): Promise<boolean> {
		const changed = token !== this._apiKey;
		this._apiKey = token || undefined;
		if (changed) {
			await this._refreshModels();
		}
		return !!this._apiKey;
	}

	private _buildSeedModels(): readonly IAgentModelInfo[] {
		return MISTRAL_SEED_MODELS.map(m => ({
			provider: this.id,
			id: m.id,
			name: m.name,
			maxContextWindow: m.maxContextWindow,
			supportsVision: false,
		}));
	}

	/**
	 * Replace the seed catalog with the user's real, tool-capable Mistral
	 * models. Agent sessions require function calling, so models that don't
	 * advertise it are filtered out. On any failure (no key, network, empty
	 * result) the existing models are left untouched so the picker keeps
	 * working with the seed list.
	 */
	private async _refreshModels(): Promise<void> {
		const apiKey = this._apiKey;
		if (!apiKey) {
			return;
		}
		try {
			const all = await this._apiService.models(apiKey);
			const usable = all.filter(m => m.supportsFunctionCalling);
			if (usable.length === 0) {
				return;
			}
			this._models.set(usable.map(this._toAgentModelInfo, this), undefined);
		} catch (err) {
			this._logService.warn(`[Mistral] Failed to refresh models; keeping seed list. ${err}`);
		}
	}

	private _toAgentModelInfo(m: IMistralModel): IAgentModelInfo {
		return {
			provider: this.id,
			id: m.id,
			name: m.name,
			maxContextWindow: m.maxContextWindow,
			supportsVision: m.supportsVision,
		};
	}

	// #endregion

	// #region Session config schema

	resolveSessionConfig(_params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		// Phase 1 reuses the platform session schema (Approvals + Mode +
		// Permissions) so the new-session config UI renders without
		// Mistral-specific knobs. Phase 3 refines this with model/isolation/
		// branch once the session lifecycle lands.
		const values = platformSessionSchema.validateOrDefault(_params.config, {});
		return Promise.resolve({
			schema: platformSessionSchema.toProtocol(),
			values,
		});
	}

	sessionConfigCompletions(_params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		// No dynamic-enum properties yet (branch completion arrives with
		// worktree isolation in Phase 3).
		return Promise.resolve({ items: [] });
	}

	// #endregion

	// #region Session lifecycle

	/**
	 * Create a session *provisionally*: allocate an id and an in-memory record,
	 * with no network call and no disk write. The Mistral conversation and the
	 * persisted metadata are created lazily on the first {@link sendMessage}
	 * via {@link _materializeProvisional}; until then the session is invisible
	 * to other clients (the `provisional: true` flag tells the host to defer the
	 * `sessionAdded` notification). Fork is out of scope for the core roadmap.
	 */
	async createSession(config?: IAgentCreateSessionConfig): Promise<IAgentCreateSessionResult> {
		const sessionId = config?.session ? AgentSession.id(config.session) : generateUuid();
		const sessionUri = AgentSession.uri(this.id, sessionId);
		const workingDirectory = config?.workingDirectory;
		const project = this._projectFor(workingDirectory);

		// Idempotency: a duplicate create for an already-materialized session is
		// a no-op; return a non-provisional result so the caller doesn't re-fire
		// `sessionAdded`. A duplicate create for a still-provisional session
		// keeps the existing record (don't clobber accumulated selections).
		if (this._sessions.has(sessionId)) {
			return { session: sessionUri, workingDirectory, ...(project ? { project } : {}) };
		}
		if (!this._provisionalSessions.has(sessionId)) {
			this._provisionalSessions.set(sessionId, { sessionId, sessionUri, workingDirectory, model: config?.model, project });
		}

		this._logService.info(`[Mistral] Session created (provisional): ${sessionUri.toString()}`);
		return { session: sessionUri, workingDirectory, provisional: true, ...(project ? { project } : {}) };
	}

	/**
	 * Promote a provisional session into a live {@link MistralAgentSession}:
	 * persist the durable mapping (model, working directory) and notify the host
	 * so it fires the deferred `sessionAdded`. The Mistral conversation itself is
	 * still opened lazily by the turn loop (Phase 4) — materialization only
	 * settles local state. Called from {@link sendMessage} inside the session
	 * sequencer.
	 */
	protected async _materializeProvisional(sessionId: string): Promise<MistralAgentSession> {
		const existing = this._sessions.get(sessionId);
		if (existing) {
			return existing;
		}
		const provisional = this._provisionalSessions.get(sessionId);
		if (!provisional) {
			throw new Error(`Cannot materialize unknown provisional session: ${sessionId}`);
		}

		const session = new MistralAgentSession(sessionId, provisional.sessionUri, provisional.workingDirectory, provisional.model);
		this._provisionalSessions.delete(sessionId);
		this._sessions.set(sessionId, session);

		await this._storeSessionMetadata(session);

		this._logService.info(`[Mistral] Session materialized: ${session.sessionUri.toString()}`);
		this._onDidMaterializeSession.fire({ session: session.sessionUri, workingDirectory: session.workingDirectory, project: provisional.project });
		return session;
	}

	async disposeSession(session: URI): Promise<void> {
		const sessionId = AgentSession.id(session);
		await this._disposeSequencer.queue(sessionId, async () => {
			// Disposing tears down in-memory resources only; persisted session
			// data survives for restoration (Phase 6). Removing a provisional
			// record has no disk/network footprint to clean up.
			this._provisionalSessions.delete(sessionId);
			this._sessions.deleteAndDispose(sessionId);
		});
	}

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		// Live, materialized sessions only. Provisional sessions are invisible by
		// contract, and durable listing of sessions from previous agent-host
		// lifetimes lands with restoration (Phase 6 — `conversations.getHistory`).
		const result: IAgentSessionMetadata[] = [];
		for (const [, session] of this._sessions) {
			result.push(this._toSessionMetadata(session));
		}
		return result;
	}

	getSessionMetadata(session: URI): Promise<IAgentSessionMetadata | undefined> {
		const live = this._sessions.get(AgentSession.id(session));
		return Promise.resolve(live ? this._toSessionMetadata(live) : undefined);
	}

	getSessionMessages(_session: URI): Promise<readonly Turn[]> {
		// Transcript restoration from `conversations.getHistory(conversationId)`
		// (mapping server-side history entries back to protocol Turns) is the
		// remaining follow-up. Returning [] keeps reopening a session graceful
		// rather than throwing; the live turn stream still drives the UI.
		return Promise.resolve([]);
	}

	private _toSessionMetadata(session: MistralAgentSession): IAgentSessionMetadata {
		return {
			session: session.sessionUri,
			startTime: session.createdAt,
			modifiedTime: session.createdAt,
			project: this._projectFor(session.workingDirectory),
			model: session.model,
			workingDirectory: session.workingDirectory,
		};
	}

	private _projectFor(workingDirectory: URI | undefined): IAgentSessionProjectInfo | undefined {
		return workingDirectory ? { uri: workingDirectory, displayName: basename(workingDirectory) } : undefined;
	}

	/** Persist the durable session mapping so Phase 6 can restore it. */
	private async _storeSessionMetadata(session: MistralAgentSession): Promise<void> {
		const ref = this._sessionDataService.openDatabase(session.sessionUri);
		try {
			const db = ref.object;
			await db.setMetadata(MistralSessionMetaKey.CreatedAt, String(session.createdAt));
			if (session.conversationId) {
				await db.setMetadata(MistralSessionMetaKey.ConversationId, session.conversationId);
			}
			if (session.model) {
				await db.setMetadata(MistralSessionMetaKey.Model, JSON.stringify(session.model));
			}
			if (session.workingDirectory) {
				await db.setMetadata(MistralSessionMetaKey.WorkingDirectory, session.workingDirectory.toString());
			}
		} finally {
			ref.dispose();
		}
	}

	// #endregion

	// #region Turn loop (native, over the Conversations API)

	/**
	 * Run one user turn. Materializes the session on the first call, opens (or
	 * appends to) the server-side Mistral conversation, and maps the streamed
	 * {@link ConversationEvents} to protocol {@link SessionAction}s emitted on
	 * {@link onDidSessionProgress}. Serialized per session so concurrent sends
	 * queue rather than interleave. No tools yet — those arrive in Phase 5.
	 */
	async sendMessage(session: URI, prompt: string, _attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> {
		const sessionId = AgentSession.id(session);
		await this._sessionSequencer.queue(sessionId, async () => {
			const agentSession = await this._materializeProvisional(sessionId);
			await this._runTurn(agentSession, prompt, turnId ?? generateUuid());
		});
	}

	private async _runTurn(agentSession: MistralAgentSession, prompt: string, turnId: string): Promise<void> {
		const sessionUri = agentSession.sessionUri;
		// Protocol actions carry the session URI in its serialized (string) form.
		const session = sessionUri.toString();
		const apiKey = this._apiKey;

		this._fireAction({ type: ActionType.SessionTurnStarted, session, turnId, userMessage: { text: prompt } });

		if (!apiKey) {
			this._fireError(session, turnId, 'AuthError', 'No Mistral API key configured.');
			return;
		}

		const signal = agentSession.abortSignal;
		const model = agentSession.model?.id ?? this._defaultModelId();
		const toolCtx: IMistralToolContext = { workingDirectory: agentSession.workingDirectory, signal };

		try {
			// Round 0 opens the conversation with the user prompt (declaring the
			// tool set); subsequent rounds append the tool results so the model
			// can continue. Loop until the model stops calling tools.
			let stream = agentSession.conversationId
				? await this._apiService.appendConversationStream(apiKey, agentSession.conversationId, { inputs: prompt }, { signal })
				: await this._apiService.startConversationStream(apiKey, { model, inputs: prompt, tools: MISTRAL_TOOLS, store: true }, { signal });

			for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
				const { toolCalls, errored } = await this._consumeStream(stream, agentSession, session, turnId);
				if (errored) {
					return;
				}
				if (toolCalls.length === 0) {
					break;
				}

				// Execute each requested tool locally and collect its result.
				const results: FunctionResultEntry[] = [];
				for (const tc of toolCalls) {
					if (signal.aborted) {
						this._fireAction({ type: ActionType.SessionTurnComplete, session, turnId });
						return;
					}
					// Mutating tools are gated through the host's permission flow;
					// read-only tools were already auto-confirmed in _consumeStream.
					if (isMutatingTool(tc.name)) {
						const approved = await this._requestApproval(agentSession, tc);
						if (!approved) {
							const denied = 'The user denied this tool call.';
							this._fireAction({ type: ActionType.SessionToolCallComplete, session, turnId, toolCallId: tc.toolCallId, result: { success: false, pastTenseMessage: `${toolDisplayName(tc.name)} denied`, content: [{ type: ToolResultContentType.Text, text: denied }] } });
							results.push({ type: 'function.result', toolCallId: tc.toolCallId, result: denied });
							continue;
						}
					}
					const res = await executeMistralTool(tc.name, tc.arguments, toolCtx);
					this._fireAction({ type: ActionType.SessionToolCallComplete, session, turnId, toolCallId: tc.toolCallId, result: toToolCallResult(tc.name, res) });
					results.push({ type: 'function.result', toolCallId: tc.toolCallId, result: res.output });
				}

				// Feed results back; the conversation id is set by now.
				stream = await this._apiService.appendConversationStream(apiKey, agentSession.conversationId!, { inputs: results }, { signal });
			}

			this._fireAction({ type: ActionType.SessionTurnComplete, session, turnId });
		} catch (err) {
			if (agentSession.abortSignal.aborted) {
				// Abort is a user action, not an error; surface a clean completion.
				this._fireAction({ type: ActionType.SessionTurnComplete, session, turnId });
				return;
			}
			this._logService.error(`[Mistral] Turn failed: ${err}`);
			this._fireError(session, turnId, 'TurnError', err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Consume one conversation event stream: stream assistant text/reasoning as
	 * protocol actions, surface any tool calls (start + auto-confirmed ready),
	 * and capture the conversation id. Returns the tool calls the model
	 * requested (empty when the assistant turn is final) and whether an error
	 * terminated the stream.
	 *
	 * NOTE (Phase 5): mutating tools are auto-approved (`confirmed: NotNeeded`).
	 * Interactive approval (the `IAgentToolPendingConfirmationSignal` ↔
	 * `respondToPermissionRequest` round-trip through `SessionPermissionManager`)
	 * is deferred to Phase 6 — see roadmap.
	 */
	private async _consumeStream(
		stream: EventStream<ConversationEvents>,
		agentSession: MistralAgentSession,
		session: string,
		turnId: string,
	): Promise<{ toolCalls: IMistralToolCall[]; errored: boolean }> {
		const toolCalls: IMistralToolCall[] = [];
		let textPartId: string | undefined;
		let reasoningPartId: string | undefined;
		const ensureTextPart = (): string => {
			if (!textPartId) {
				textPartId = generateUuid();
				this._fireAction({ type: ActionType.SessionResponsePart, session, turnId, part: { kind: ResponsePartKind.Markdown, id: textPartId, content: '' } });
			}
			return textPartId;
		};
		const ensureReasoningPart = (): string => {
			if (!reasoningPartId) {
				reasoningPartId = generateUuid();
				this._fireAction({ type: ActionType.SessionResponsePart, session, turnId, part: { kind: ResponsePartKind.Reasoning, id: reasoningPartId, content: '' } });
			}
			return reasoningPartId;
		};

		for await (const ev of stream) {
			const data = ev.data;
			switch (data.type) {
				case 'conversation.response.started': {
					if (!agentSession.conversationId) {
						agentSession.conversationId = data.conversationId;
						void this._persistConversationId(agentSession);
					}
					break;
				}
				case 'message.output.delta': {
					const { text, reasoning } = extractDelta(data.content);
					if (reasoning) {
						this._fireAction({ type: ActionType.SessionReasoning, session, turnId, partId: ensureReasoningPart(), content: reasoning });
					}
					if (text) {
						this._fireAction({ type: ActionType.SessionDelta, session, turnId, partId: ensureTextPart(), content: text });
					}
					break;
				}
				case 'function.call.delta': {
					const { toolCallId, name } = data;
					const args = data.arguments ?? '';
					toolCalls.push({ toolCallId, name, arguments: args });
					const displayName = toolDisplayName(name);
					// `SessionToolCallStart` registers this tool call with the host,
					// which is what lets the later `pending_confirmation` signal (for
					// mutating tools) round-trip back through respondToPermissionRequest.
					this._fireAction({ type: ActionType.SessionToolCallStart, session, turnId, toolCallId, toolName: name, displayName });
					if (!isMutatingTool(name)) {
						// Read-only tools run without confirmation. Mutating tools get
						// their `Ready` from the host once the pending_confirmation
						// signal is resolved (see _requestApproval).
						this._fireAction({
							type: ActionType.SessionToolCallReady, session, turnId, toolCallId,
							invocationMessage: displayName, toolInput: args,
							confirmed: ToolCallConfirmationReason.NotNeeded,
						});
					}
					break;
				}
				case 'conversation.response.error': {
					this._fireError(session, turnId, `MistralError(${data.code})`, data.message);
					return { toolCalls, errored: true };
				}
				case 'conversation.response.done':
				default:
					break;
			}
		}
		return { toolCalls, errored: false };
	}

	private _fireAction(action: SessionAction): void {
		this._onDidSessionProgress.fire({ kind: 'action', session: URI.parse(action.session), action });
	}

	/** `session` is the serialized (string) session URI used by protocol actions. */
	private _fireError(session: string, turnId: string, errorType: string, message: string): void {
		this._fireAction({ type: ActionType.SessionError, session, turnId, error: { errorType, message } });
	}

	private _defaultModelId(): string {
		return this._models.get()[0]?.id ?? 'devstral-latest';
	}

	private async _persistConversationId(agentSession: MistralAgentSession): Promise<void> {
		if (!agentSession.conversationId) {
			return;
		}
		const ref = this._sessionDataService.openDatabase(agentSession.sessionUri);
		try {
			await ref.object.setMetadata(MistralSessionMetaKey.ConversationId, agentSession.conversationId);
		} catch (err) {
			this._logService.warn(`[Mistral] Failed to persist conversation id: ${err}`);
		} finally {
			ref.dispose();
		}
	}

	/**
	 * Request user approval for a mutating tool. Emits a `pending_confirmation`
	 * signal (the host applies its auto-approval policy / session AutoApprove
	 * config and otherwise prompts the client), then waits for the verdict to
	 * arrive via {@link respondToPermissionRequest}. The earlier
	 * `SessionToolCallStart` is what registers this tool call with the host so
	 * the round-trip can complete.
	 */
	private _requestApproval(agentSession: MistralAgentSession, tc: IMistralToolCall): Promise<boolean> {
		const displayName = toolDisplayName(tc.name);
		const state: ToolCallPendingConfirmationState = {
			toolCallId: tc.toolCallId,
			toolName: tc.name,
			displayName,
			invocationMessage: displayName,
			toolInput: tc.arguments,
			status: ToolCallStatus.PendingConfirmation,
			confirmationTitle: tc.name === 'run_bash' ? 'Run in terminal' : 'Write file',
		};
		this._onDidSessionProgress.fire({
			kind: 'pending_confirmation',
			session: agentSession.sessionUri,
			state,
			permissionKind: tc.name === 'run_bash' ? 'shell' : 'write',
		});
		return this._awaitPermission(tc.toolCallId, agentSession.abortSignal);
	}

	private _awaitPermission(toolCallId: string, signal: AbortSignal): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			if (signal.aborted) {
				resolve(false);
				return;
			}
			const settle = (approved: boolean) => {
				this._pendingPermissions.delete(toolCallId);
				signal.removeEventListener('abort', onAbort);
				resolve(approved);
			};
			const onAbort = () => settle(false);
			this._pendingPermissions.set(toolCallId, settle);
			signal.addEventListener('abort', onAbort, { once: true });
		});
	}

	respondToPermissionRequest(requestId: string, approved: boolean): void {
		this._pendingPermissions.get(requestId)?.(approved);
	}

	respondToUserInputRequest(_requestId: string, _response: SessionInputResponseKind, _answers?: Record<string, SessionInputAnswer>): void {
		// The Mistral toolset does not use the `ask_user` elicitation flow, so
		// there is nothing to route back. No-op.
	}

	async abortSession(session: URI): Promise<void> {
		// Aborting the session's turn controller unblocks both the in-flight
		// conversation stream and any tool-approval wait; the turn loop then
		// surfaces a clean `SessionTurnComplete`.
		this._sessions.get(AgentSession.id(session))?.abortTurn();
	}

	async changeModel(session: URI, model: ModelSelection): Promise<void> {
		const sessionId = AgentSession.id(session);
		const provisional = this._provisionalSessions.get(sessionId);
		if (provisional) {
			this._provisionalSessions.set(sessionId, { ...provisional, model });
			return;
		}
		const live = this._sessions.get(sessionId);
		if (live) {
			live.model = model;
			await this._storeSessionMetadata(live);
		}
	}

	// #endregion

	// #region Client tools / customizations (out of scope for the core roadmap — no-op)

	setClientTools(_session: URI, _clientId: string, _tools: ToolDefinition[]): void {
		// Client-provided (in-process MCP) tools are a follow-up. No-op so the
		// `activeClientChanged` clear-call is harmless before the feature exists.
	}

	onClientToolCallComplete(_session: URI, _toolCallId: string, _result: ToolCallResult): void {
		// Paired with setClientTools; no-op until client tools are supported.
	}

	setClientCustomizations(_clientId: string, _customizations: CustomizationRef[], _progress?: (results: ISyncedCustomization[]) => void): Promise<ISyncedCustomization[]> {
		// Host customizations (instructions / slash commands / skills) are a
		// follow-up; report nothing synced.
		return Promise.resolve([]);
	}

	setCustomizationEnabled(_uri: string, _enabled: boolean): void {
		// No-op until customizations are supported.
	}

	// #endregion

	// #region Teardown

	async shutdown(): Promise<void> {
		this._logService.trace('[Mistral] shutdown');
		// Dispose every live session (aborts any in-flight turn), then let
		// fire-and-forget metadata writes settle before the process exits.
		this._provisionalSessions.clear();
		this._sessions.clearAndDisposeAll();
		await this._sessionDataService.whenIdle();
	}

	// #endregion
}
