/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { equals } from '../../../../base/common/arrays.js';
import { SequencerByKey } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import type { AgentChatMigrationResult, AgentProvider, AgentSignal, IActiveClient, IAgent, IAgentChatConfigCompletionsParams, IAgentChatContext, IAgentChatDataChange, IAgentChatMetadata, IAgentChats, IAgentCreateChatOptions, IAgentCreateChatResult, IAgentDescriptor, IAgentDiscoveredChat, IAgentMaterializeChatEvent, IAgentModelInfo, IAgentResolveChatConfigParams, IAgentSpawnChatEvent } from '../../common/agent.js';
import { resolveAgentChatContext } from '../../common/agent.js';
import { AgentHostShownModelsConfigKey, createSchema, platformRootSchema, platformSessionSchema } from '../../common/agentHostSchema.js';
import { getShownModelIds } from '../../common/agentShownModels.js';
import { AgentHostMistralApiKeyEnvVar, AgentHostMistralResource } from '../../common/agentService.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { ISessionDataService } from '../../common/sessionDataService.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';
import { ActionType, type ChatAction } from '../../common/state/sessionActions.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import type { ModelSelection, ProtectedResourceMetadata, ToolCallPendingConfirmationState, ToolDefinition } from '../../common/state/protocol/state.js';
import { createErrorResponsePart, MessageKind, ResponsePartKind, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, TurnState, type ChatInputAnswer, type ChatInputResponseKind, type ClientPluginCustomization, type Customization, type MessageAttachment, type ResponsePart, type ToolCallResult, type Turn } from '../../common/state/sessionState.js';
import type { ConversationEvents, ConversationHistory, FunctionResultEntry, InputEntries, MessageOutputContentChunks } from '@mistralai/mistralai/models/components/index.js';
import type { EventStream } from '@mistralai/mistralai/lib/event-streams.js';
import { IMistralApiService, IMistralModel } from './mistralApiService.js';
import { isRateLimitError } from './mistralRateLimiter.js';
import { MistralAgentSession, projectForWorkingDirectory } from './mistralAgentSession.js';
import { describeMistralToolCall, executeMistralTool, IMistralToolContext, IMistralToolResult, isMutatingTool, MISTRAL_TOOLS, toolDisplayName } from './mistralTools.js';

/** Safety cap on tool-call rounds within a single user turn. */
const MAX_TOOL_ROUNDS = 50;

/** What the model receives when the user denies a tool call. */
const TOOL_DENIED_RESULT = 'The user denied this tool call.';

/** How long a restore waits for the workbench to push the API key before giving up on history. */
const API_KEY_WAIT_MS = 5_000;

/** Legacy per-session metadata keys written by the pre-1.141 Mistral agent. */
const enum LegacyMistralSessionMetaKey {
	ConversationId = 'mistral.conversationId',
	Model = 'mistral.model',
	WorkingDirectory = 'mistral.workingDirectory',
	CreatedAt = 'mistral.createdAt',
}

/** One client tool call requested by the model in a stream. */
interface IMistralToolCall {
	readonly toolCallId: string;
	readonly name: string;
	arguments: string;
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
 * Normalize Mistral message content (a bare string or typed chunks) into
 * assistant text and reasoning text. Other chunk kinds (tool refs, media) are
 * not surfaced.
 */
function extractContent(content: string | MessageOutputContentChunks | MessageOutputContentChunks[]): { text: string; reasoning: string } {
	if (typeof content === 'string') {
		return { text: content, reasoning: '' };
	}
	let text = '';
	let reasoning = '';
	for (const chunk of Array.isArray(content) ? content : [content]) {
		if (chunk.type === 'text') {
			text += chunk.text;
		} else if (chunk.type === 'thinking') {
			reasoning += chunk.thinking.map(c => (c.type === 'text' ? c.text : '')).join('');
		}
	}
	return { text, reasoning };
}

/**
 * Keep only the fields the Conversations API accepts as inputs, so a
 * conversation's history can seed a new one (see {@link MistralAgent._openStream}).
 */
function toReplayInput(entry: ConversationHistory['entries'][number]): InputEntries | undefined {
	switch (entry.type) {
		case 'message.input':
			return { type: 'message.input', role: entry.role, content: entry.content };
		case 'message.output':
			return { type: 'message.output', role: 'assistant', content: entry.content };
		case 'function.call':
			return { type: 'function.call', toolCallId: entry.toolCallId, name: entry.name, arguments: entry.arguments };
		case 'function.result':
			return { type: 'function.result', toolCallId: entry.toolCallId, result: entry.result };
		default:
			return undefined;
	}
}

/**
 * Static seed of tool-capable Mistral models advertised before the first
 * live `modelsList` fetch replaces it with the user's real catalog, filtered
 * to models that advertise function calling.
 *
 * Mirrors `defaultModelsOfProvider.mistral` / `mistralModelOptions` in
 * `workbench/contrib/void/common/modelCapabilities.ts`.
 */
const MISTRAL_SEED_MODELS: ReadonlyArray<{ id: string; name: string; maxContextWindow: number }> = [
	{ id: 'zai-glm-5-3', name: 'Z.ai GLM 5.3', maxContextWindow: 1_000_000 },
	{ id: 'zai-glm-5-2', name: 'Z.ai GLM 5.2', maxContextWindow: 1_000_000 },
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
 * There is no coding-agent SDK for Mistral, so the agentic loop and the local
 * tools are implemented here (`node/mistral/`) on top of the Conversations
 * API: each chat is one server-side conversation, continued turn after turn.
 * Sessions have a single chat (no `multipleChats` capability).
 */
export class MistralAgent extends Disposable implements IAgent {
	readonly id: AgentProvider = 'mistral';
	readonly agentHostCapabilities = { workspaceConversion: false };

	private readonly _onDidChatProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidChatProgress = this._onDidChatProgress.event;

	private readonly _onDidMaterializeChat = this._register(new Emitter<IAgentMaterializeChatEvent>());
	readonly onDidMaterializeChat = this._onDidMaterializeChat.event;

	private readonly _onDidChangeChatData = this._register(new Emitter<IAgentChatDataChange>());
	readonly onDidChangeChatData = this._onDidChangeChatData.event;

	readonly onDidSpawnChat: Event<IAgentSpawnChatEvent> = Event.None;

	/** Mistral keeps no local catalog of conversations, so there is nothing to discover. */
	readonly onDidDiscoverChats: Event<readonly IAgentDiscoveredChat[]> = Event.None;

	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	/** Every chat this process knows, keyed by chat URI. */
	private readonly _chats = this._register(new DisposableMap<string, MistralAgentSession>());

	/** Serializes sends per chat so concurrent turns queue rather than interleave. */
	private readonly _chatSequencer = new SequencerByKey<string>();

	/** Resolvers for in-flight tool approvals, keyed by tool call id. */
	private readonly _pendingPermissions = new Map<string, (approved: boolean) => void>();

	private readonly _onDidChangeApiKey = this._register(new Emitter<void>());

	/**
	 * Mistral API key. Seeded from {@link AgentHostMistralApiKeyEnvVar} when the
	 * starters forward one; Kodia's key bridge pushes the key from its settings
	 * through {@link authenticate}.
	 */
	private _apiKey: string | undefined;

	/** The live Mistral catalog for {@link _apiKey}, once fetched. */
	private _catalog: readonly IMistralModel[] | undefined;

	/**
	 * Kodia: the Mistral models shown in Kodia's model dropdown, forwarded through
	 * {@link AgentHostShownModelsConfigKey}. `undefined` until Kodia has forwarded
	 * them.
	 */
	private _shownModelIds: readonly string[] | undefined;

	readonly chats: IAgentChats = {
		createChat: (chat, _context, options) => this._createChat(chat, options),
		disposeChat: async chat => this._chats.deleteAndDispose(chat.toString()),
		// The backing is a few fields; keep it so a later send continues the
		// conversation. There is no runtime to release between turns.
		releaseChat: async () => { },
		sendMessage: (chat, prompt, workingDirectoriesOrDirectory, attachments, turnId) => {
			const workingDirectories = Array.isArray(workingDirectoriesOrDirectory) ? workingDirectoriesOrDirectory : workingDirectoriesOrDirectory ? [workingDirectoriesOrDirectory] : undefined;
			return this._sendMessage(chat, prompt, workingDirectories, attachments, turnId);
		},
		// Aborting unblocks both the in-flight stream and any approval wait. The
		// host has already recorded the turn as cancelled, so the loop then
		// returns without emitting anything else.
		abort: async chat => this._chats.get(chat.toString())?.abortTurn(),
		getModel: chat => this._chats.get(chat.toString())?.model,
		changeModel: async (chat, model) => this._changeModel(chat, model),
		// Mistral has no custom agents.
		changeAgent: async () => { },
		getMessages: chat => this._getMessages(chat),
	};

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IMistralApiService private readonly _apiService: IMistralApiService,
		@ISessionDataService private readonly _sessionDataService: ISessionDataService,
		@IAgentConfigurationService private readonly _configurationService: IAgentConfigurationService,
	) {
		super();
		this._apiKey = process.env[AgentHostMistralApiKeyEnvVar] || undefined;
		this._shownModelIds = this._readShownModelIds();
		this._register(this._configurationService.onDidRootConfigChange(() => {
			const shownModelIds = this._readShownModelIds();
			if (!equals(shownModelIds, this._shownModelIds)) {
				this._shownModelIds = shownModelIds;
				this._publishModels();
			}
		}));
		// Publish synchronously when there is a key, then refine with the real,
		// capability-filtered catalog from the Mistral API.
		this._publishModels();
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
		// standard token resolver finds no token for it and skips it; the Kodia
		// key bridge pushes the key explicitly. `required: false` keeps it from
		// gating the agent behind a sign-in prompt.
		return [{ resource: AgentHostMistralResource, resource_name: 'Mistral', required: false }];
	}

	async authenticate(_resource: string, token: string): Promise<boolean> {
		const changed = token !== this._apiKey;
		this._apiKey = token || undefined;
		if (changed) {
			this._catalog = undefined;
			this._publishModels();
			this._onDidChangeApiKey.fire();
			await this._refreshModels();
		}
		return !!this._apiKey;
	}

	refreshModels(): Promise<void> {
		return this._refreshModels();
	}

	private _readShownModelIds(): readonly string[] | undefined {
		return getShownModelIds(this._configurationService.getRootValue(platformRootSchema, AgentHostShownModelsConfigKey), this.id);
	}

	/**
	 * Kodia: models are only advertised while there is an API key, so the Agents
	 * window never offers a Mistral model it cannot use.
	 */
	private _publishModels(): void {
		this._models.set(this._apiKey ? this._buildModels() : [], undefined);
	}

	/**
	 * Kodia: once Kodia has forwarded the models shown in its dropdown, exactly
	 * those are offered, in the same order, under the ids Kodia uses (the host
	 * filters every agent's models by them). The live catalog only fills in their
	 * metadata (a dropdown entry is usually an alias such as `mistral-large-latest`)
	 * and drops the ones known to lack function calling, which agent chats require.
	 *
	 * Before that, the seed list stands in until the live catalog replaces it.
	 */
	private _buildModels(): readonly IAgentModelInfo[] {
		if (!this._shownModelIds) {
			const usable = this._catalog?.filter(m => m.supportsFunctionCalling);
			return usable ? usable.map(this._toAgentModelInfo, this) : this._buildSeedModels();
		}
		return this._shownModelIds.flatMap(id => {
			const card = this._catalog?.find(m => m.id === id || m.aliases?.includes(id));
			if (card && !card.supportsFunctionCalling) {
				return [];
			}
			const seed = MISTRAL_SEED_MODELS.find(m => m.id === id);
			return [{
				provider: this.id,
				id,
				name: seed?.name ?? id,
				maxContextWindow: card?.maxContextWindow ?? seed?.maxContextWindow,
				supportsVision: card?.supportsVision ?? false,
			}];
		});
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
	 * Fetch the user's real Mistral catalog and republish the models from it.
	 * Without a key there is nothing to fetch. On any other failure (network,
	 * no tool-capable model) the previous catalog is kept so the picker keeps
	 * working with the seed list.
	 */
	private async _refreshModels(): Promise<void> {
		const apiKey = this._apiKey;
		if (!apiKey) {
			return;
		}
		try {
			const catalog = await this._apiService.models(apiKey);
			if (apiKey !== this._apiKey || !catalog.some(m => m.supportsFunctionCalling)) {
				return;
			}
			this._catalog = catalog;
			this._publishModels();
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

	/** Resolves once an API key is available, or after {@link API_KEY_WAIT_MS}. */
	private async _whenApiKey(): Promise<string | undefined> {
		if (this._apiKey) {
			return this._apiKey;
		}
		await Promise.race([
			Event.toPromise(this._onDidChangeApiKey.event),
			new Promise(resolve => setTimeout(resolve, API_KEY_WAIT_MS)),
		]);
		return this._apiKey;
	}

	// #endregion

	// #region Chat config

	resolveChatConfig(params: IAgentResolveChatConfigParams): Promise<ResolveSessionConfigResult> {
		// Only the host-applied approval knobs: tool calls go through the host's
		// permission flow. Sandbox, plan mode and shell init scripts are not
		// supported by this harness, so their pickers stay hidden.
		const schema = createSchema({
			[SessionConfigKey.AutoApprove]: platformSessionSchema.definition[SessionConfigKey.AutoApprove],
			[SessionConfigKey.Permissions]: platformSessionSchema.definition[SessionConfigKey.Permissions],
		});
		return Promise.resolve({
			schema: schema.toProtocol(),
			values: schema.validateOrDefault(params.config, {}),
		});
	}

	getInheritedChatConfig(config: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
		const inherited: Record<string, unknown> = {};
		for (const key of [SessionConfigKey.AutoApprove, SessionConfigKey.Permissions]) {
			if (config[key] !== undefined) {
				inherited[key] = config[key];
			}
		}
		return Object.keys(inherited).length > 0 ? inherited : undefined;
	}

	chatConfigCompletions(_params: IAgentChatConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return Promise.resolve({ items: [] });
	}

	// #endregion

	// #region Chat lifecycle

	/**
	 * Create a chat *provisionally*: an in-memory record, with no network call.
	 * The Mistral conversation is opened by the first send, which also
	 * materializes the chat so the host publishes the session.
	 */
	private async _createChat(chat: URI, options?: IAgentCreateChatOptions): Promise<IAgentCreateChatResult> {
		const chatKey = chat.toString();
		// Agent Host re-issues creation for an existing chat on reconnect.
		const existing = this._chats.get(chatKey);
		if (existing) {
			return this._chatResult(existing);
		}
		if (options?.importConversation || options?.fork) {
			this._logService.warn(`[Mistral] Chat ${chatKey} starts empty: importing or forking a conversation is not supported`);
		}
		const workingDirectory = options?.workingDirectories?.[0];
		const session = new MistralAgentSession(chat, {
			model: options?.model,
			workingDirectory,
			project: options?.project ?? projectForWorkingDirectory(workingDirectory),
			materialized: false,
		});
		this._chats.set(chatKey, session);
		this._logService.info(`[Mistral] Chat created (provisional): ${chatKey}`);
		return this._chatResult(session);
	}

	private _chatResult(session: MistralAgentSession): IAgentCreateChatResult {
		return {
			providerData: session.toProviderData(),
			...(session.materialized ? {} : { provisional: true }),
			...(session.workingDirectory ? { resolvedWorkingDirectory: session.workingDirectory } : {}),
			...(session.project ? { project: session.project } : {}),
		};
	}

	/** Re-attach a chat from the backing Agent Host persisted for it. */
	async materializeChat(chat: URI, _context: URI | IAgentChatContext, providerData: string | undefined): Promise<IAgentCreateChatResult | void> {
		const chatKey = chat.toString();
		const existing = this._chats.get(chatKey);
		if (existing || providerData === undefined) {
			return existing ? this._chatResult(existing) : undefined;
		}
		const session = MistralAgentSession.fromProviderData(chat, providerData);
		if (!session) {
			this._logService.warn(`[Mistral] materializeChat: dropping corrupt providerData for ${chatKey}`);
			return;
		}
		this._chats.set(chatKey, session);
		return this._chatResult(session);
	}

	/**
	 * Recover a chat created by the pre-1.141 Mistral agent, which kept its
	 * conversation in the session database instead of a host-persisted backing.
	 */
	async recoverLegacyChat(chat: URI, context: URI | IAgentChatContext): Promise<IAgentCreateChatResult | void> {
		const existing = this._chats.get(chat.toString());
		if (existing) {
			return this._chatResult(existing);
		}
		const { configurationResource } = resolveAgentChatContext(context, chat);
		const ref = await this._sessionDataService.tryOpenDatabase(configurationResource);
		if (!ref) {
			return;
		}
		try {
			const db = ref.object;
			const conversationId = await db.getMetadata(LegacyMistralSessionMetaKey.ConversationId);
			if (!conversationId) {
				return;
			}
			const model = await db.getMetadata(LegacyMistralSessionMetaKey.Model);
			const workingDirectory = await db.getMetadata(LegacyMistralSessionMetaKey.WorkingDirectory);
			const createdAt = Number(await db.getMetadata(LegacyMistralSessionMetaKey.CreatedAt));
			const parsedModel: ModelSelection | undefined = model ? JSON.parse(model) : undefined;
			const session = new MistralAgentSession(chat, {
				model: parsedModel,
				workingDirectory: workingDirectory ? URI.parse(workingDirectory) : undefined,
				conversationId,
				conversationModel: parsedModel?.id,
				materialized: true,
			}, Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now());
			this._chats.set(chat.toString(), session);
			return this._chatResult(session);
		} catch (err) {
			this._logService.warn(`[Mistral] Failed to recover legacy chat ${chat.toString()}: ${err}`);
			return;
		} finally {
			ref.dispose();
		}
	}

	async getChatMetadata(chat: URI, _context: URI | IAgentChatContext, providerData?: string): Promise<IAgentChatMetadata | undefined> {
		const live = this._chats.get(chat.toString());
		const session = live ?? (providerData !== undefined ? MistralAgentSession.fromProviderData(chat, providerData) : undefined);
		if (!session) {
			return undefined;
		}
		const metadata: IAgentChatMetadata = {
			chat,
			startTime: session.createdAt,
			modifiedTime: session.modifiedAt,
			...(session.model ? { model: session.model } : {}),
			...(session.workingDirectory ? { workingDirectories: [session.workingDirectory] } : {}),
			...(session.project ? { project: session.project } : {}),
		};
		if (!live) {
			session.dispose();
		}
		return metadata;
	}

	async listChatsToMigrate(): Promise<AgentChatMigrationResult> {
		// No provider-native catalog: every Mistral chat is created through Agent Host.
		return [];
	}

	async setWorkingDirectory(_chat: URI, _context: URI | IAgentChatContext, _workingDirectory: URI): Promise<void> {
		throw new Error('The Mistral agent does not support changing the working directory of an existing session.');
	}

	private async _changeModel(chat: URI, model: ModelSelection): Promise<void> {
		const session = this._chats.get(chat.toString());
		if (!session) {
			return;
		}
		session.model = model;
		this._fireChatDataChanged(session);
	}

	private _fireChatDataChanged(session: MistralAgentSession): void {
		this._onDidChangeChatData.fire({ chat: session.chat, providerData: session.toProviderData() });
	}

	// #endregion

	// #region History

	/**
	 * Rebuild a chat's turns from its Mistral conversation history, so a
	 * restored session shows what was said before the restart.
	 */
	private async _getMessages(chat: URI): Promise<readonly Turn[]> {
		const session = this._chats.get(chat.toString());
		if (!session?.conversationId) {
			return [];
		}
		const apiKey = await this._whenApiKey();
		if (!apiKey) {
			this._logService.warn(`[Mistral] No API key; cannot restore the history of ${chat.toString()}`);
			return [];
		}
		try {
			const history = await this._apiService.getConversationHistory(apiKey, session.conversationId);
			return this._turnsFromHistory(history);
		} catch (err) {
			this._logService.warn(`[Mistral] Failed to read the history of ${chat.toString()}: ${err}`);
			return [];
		}
	}

	private _turnsFromHistory(history: ConversationHistory): Turn[] {
		const turns: Turn[] = [];
		let current: { id: string; text: string; responseParts: ResponsePart[] } | undefined;
		const calls = new Map<string, { name: string; arguments: string }>();
		const finish = () => {
			if (current) {
				turns.push({ id: current.id, message: { text: current.text, origin: { kind: MessageKind.User } }, responseParts: current.responseParts, usage: undefined, state: TurnState.Complete });
			}
		};
		for (const entry of history.entries) {
			switch (entry.type) {
				case 'message.input': {
					// Assistant-role inputs are prefixes we never send; only user inputs start a turn.
					if (entry.role !== 'user') {
						break;
					}
					finish();
					const content = typeof entry.content === 'string' ? entry.content : entry.content.map(c => (c.type === 'text' ? c.text : '')).join('');
					current = { id: entry.id ?? generateUuid(), text: content, responseParts: [] };
					break;
				}
				case 'message.output': {
					current ??= { id: entry.id ?? generateUuid(), text: '', responseParts: [] };
					const { text, reasoning } = extractContent(entry.content);
					if (reasoning) {
						current.responseParts.push({ kind: ResponsePartKind.Reasoning, id: generateUuid(), content: reasoning });
					}
					if (text) {
						current.responseParts.push({ kind: ResponsePartKind.Markdown, id: generateUuid(), content: text });
					}
					break;
				}
				case 'function.call':
					calls.set(entry.toolCallId, { name: entry.name, arguments: typeof entry.arguments === 'string' ? entry.arguments : JSON.stringify(entry.arguments) });
					break;
				case 'function.result': {
					const call = calls.get(entry.toolCallId);
					if (!current || !call) {
						break;
					}
					// Tool results don't record success; a denial reads as a failure.
					const denied = entry.result === TOOL_DENIED_RESULT;
					const description = describeMistralToolCall(call.name, call.arguments, undefined);
					current.responseParts.push({
						kind: ResponsePartKind.ToolCall,
						toolCall: {
							status: ToolCallStatus.Completed,
							toolCallId: entry.toolCallId,
							toolName: call.name,
							displayName: toolDisplayName(call.name),
							invocationMessage: description.invocationMessage,
							toolInput: description.toolInput,
							success: !denied,
							pastTenseMessage: denied ? `${toolDisplayName(call.name)} denied` : `Ran ${toolDisplayName(call.name)}`,
							content: [{ type: ToolResultContentType.Text, text: entry.result }],
							confirmed: ToolCallConfirmationReason.NotNeeded,
						},
					});
					break;
				}
			}
		}
		finish();
		return turns;
	}

	// #endregion

	// #region Turn loop (native, over the Conversations API)

	private async _sendMessage(chat: URI, prompt: string, workingDirectories: readonly URI[] | undefined, _attachments: readonly MessageAttachment[] | undefined, turnId: string | undefined): Promise<void> {
		const chatKey = chat.toString();
		await this._chatSequencer.queue(chatKey, async () => {
			const session = this._chats.get(chatKey);
			if (!session) {
				throw new Error(`[Mistral] Unknown chat: ${chatKey}`);
			}
			// The host's resolved directory (e.g. a worktree) is where the tools run.
			const workingDirectory = workingDirectories?.[0];
			if (workingDirectory && workingDirectory.toString() !== session.workingDirectory?.toString()) {
				session.workingDirectory = workingDirectory;
				session.project ??= projectForWorkingDirectory(workingDirectory);
				if (session.materialized) {
					this._fireChatDataChanged(session);
				}
			}
			if (!session.materialized) {
				session.materialized = true;
				this._logService.info(`[Mistral] Chat materialized: ${chatKey}`);
				this._onDidMaterializeChat.fire({
					chat,
					result: { providerData: session.toProviderData() },
					workingDirectories: session.workingDirectory ? [session.workingDirectory] : undefined,
					project: session.project,
				});
			}
			await this._runTurn(session, prompt, turnId ?? generateUuid());
		});
	}

	private async _runTurn(session: MistralAgentSession, prompt: string, turnId: string): Promise<void> {
		const startedAt = Date.now();
		const fire = (action: ChatAction) => this._onDidChatProgress.fire({ kind: 'action', resource: session.chat, action });
		const fireError = (errorType: string, message: string) => fire({ type: ActionType.ChatError, turnId, duration: Date.now() - startedAt, part: createErrorResponsePart({ errorType, message }) });

		const apiKey = this._apiKey;
		if (!apiKey) {
			fireError('AuthError', localize('mistralAgent.noApiKey', "No Mistral API key configured. Add one in Kodia's settings."));
			return;
		}

		const signal = session.abortSignal;
		const toolCtx: IMistralToolContext = { workingDirectory: session.workingDirectory, signal };
		const usage = { inputTokens: 0, outputTokens: 0 };

		try {
			let { stream, startingModel } = await this._openStream(session, apiKey, prompt, signal);
			for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
				const { toolCalls, errored, model } = await this._consumeStream(stream, session, startingModel, turnId, fire, fireError, usage);
				startingModel = undefined;
				if (errored || signal.aborted) {
					return;
				}
				if (usage.inputTokens || usage.outputTokens) {
					fire({ type: ActionType.ChatUsage, turnId, usage: { ...usage, ...(model ? { model } : {}) } });
				}
				if (toolCalls.length === 0) {
					break;
				}

				// Execute each requested tool locally and collect its result.
				const results: FunctionResultEntry[] = [];
				for (const tc of toolCalls) {
					const description = describeMistralToolCall(tc.name, tc.arguments, session.workingDirectory);
					if (isMutatingTool(tc.name)) {
						// Mutating tools go through the host's permission flow, which
						// applies the session's approval settings or asks the user.
						const approved = await this._requestApproval(session, tc, description);
						if (signal.aborted) {
							return;
						}
						if (!approved) {
							fire({ type: ActionType.ChatToolCallComplete, turnId, toolCallId: tc.toolCallId, result: { success: false, pastTenseMessage: `${toolDisplayName(tc.name)} denied`, content: [{ type: ToolResultContentType.Text, text: TOOL_DENIED_RESULT }] } });
							results.push({ type: 'function.result', toolCallId: tc.toolCallId, result: TOOL_DENIED_RESULT });
							continue;
						}
					} else {
						fire({
							type: ActionType.ChatToolCallReady, turnId, toolCallId: tc.toolCallId,
							invocationMessage: description.invocationMessage, toolInput: description.toolInput,
							confirmed: ToolCallConfirmationReason.NotNeeded,
						});
					}
					const res = await executeMistralTool(tc.name, tc.arguments, toolCtx);
					if (signal.aborted) {
						return;
					}
					fire({ type: ActionType.ChatToolCallComplete, turnId, toolCallId: tc.toolCallId, result: toToolCallResult(tc.name, res) });
					results.push({ type: 'function.result', toolCallId: tc.toolCallId, result: res.output });
				}

				// Feed the results back; the conversation exists by now.
				stream = await this._apiService.appendConversationStream(apiKey, session.conversationId!, { inputs: results }, { signal });
			}

			session.modifiedAt = Date.now();
			this._fireChatDataChanged(session);
			fire({ type: ActionType.ChatTurnComplete, turnId, duration: Date.now() - startedAt });
		} catch (err) {
			if (signal.aborted) {
				return;
			}
			if (isRateLimitError(err)) {
				// The workbench renders this error type as a countdown (chatMistralRateLimitPart).
				fireError('MistralRateLimitExceeded', localize('mistralAgent.rateLimitExceeded', "Mistral token rate limit reached — automatic retries exhausted."));
			} else {
				this._logService.error(`[Mistral] Turn failed: ${err}`);
				fireError('TurnError', err instanceof Error ? err.message : String(err));
			}
		}
	}

	/**
	 * Open the stream for a user prompt: append to the chat's conversation, or
	 * start one. The Conversations API fixes the model per conversation, so after
	 * a model change the previous conversation's history seeds a new one.
	 * `startingModel` is set when a new conversation is being started.
	 */
	private async _openStream(session: MistralAgentSession, apiKey: string, prompt: string, signal: AbortSignal): Promise<{ stream: EventStream<ConversationEvents>; startingModel: string | undefined }> {
		const model = session.model?.id ?? this._defaultModelId();
		if (session.conversationId && session.conversationModel === model) {
			const stream = await this._apiService.appendConversationStream(apiKey, session.conversationId, { inputs: prompt }, { signal });
			return { stream, startingModel: undefined };
		}
		let inputs: string | InputEntries[] = prompt;
		if (session.conversationId) {
			const history = await this._apiService.getConversationHistory(apiKey, session.conversationId, { signal });
			const replay = history.entries.map(toReplayInput).filter((e): e is InputEntries => !!e);
			inputs = [...replay, { type: 'message.input', role: 'user', content: prompt }];
			this._logService.info(`[Mistral] Model changed to ${model}; continuing ${session.chat.toString()} in a new conversation`);
		}
		// The chat keeps its current conversation until the new one has started (see _consumeStream).
		const stream = await this._apiService.startConversationStream(apiKey, { model, inputs, tools: MISTRAL_TOOLS, store: true }, { signal });
		return { stream, startingModel: model };
	}

	/**
	 * Consume one conversation event stream: stream assistant text/reasoning as
	 * protocol actions, surface the tool calls the model requests, and capture
	 * the id of a conversation the stream starts. Returns the tool calls (empty
	 * when the assistant turn is final) and whether an error terminated the stream.
	 */
	private async _consumeStream(
		stream: EventStream<ConversationEvents>,
		session: MistralAgentSession,
		startingModel: string | undefined,
		turnId: string,
		fire: (action: ChatAction) => void,
		fireError: (errorType: string, message: string) => void,
		usage: { inputTokens: number; outputTokens: number },
	): Promise<{ toolCalls: IMistralToolCall[]; errored: boolean; model: string | undefined }> {
		const toolCalls = new Map<string, IMistralToolCall>();
		let model: string | undefined;
		let textPartId: string | undefined;
		let reasoningPartId: string | undefined;
		const ensurePart = (kind: ResponsePartKind.Markdown | ResponsePartKind.Reasoning): string => {
			const existing = kind === ResponsePartKind.Markdown ? textPartId : reasoningPartId;
			if (existing) {
				return existing;
			}
			const id = generateUuid();
			if (kind === ResponsePartKind.Markdown) {
				textPartId = id;
			} else {
				reasoningPartId = id;
			}
			fire({ type: ActionType.ChatResponsePart, turnId, part: { kind, id, content: '' } });
			return id;
		};

		for await (const ev of stream) {
			const data = ev.data;
			switch (data.type) {
				case 'conversation.response.started': {
					if (startingModel && data.conversationId !== session.conversationId) {
						session.conversationId = data.conversationId;
						session.conversationModel = startingModel;
						this._fireChatDataChanged(session);
					}
					break;
				}
				case 'message.output.delta': {
					model = data.model ?? model;
					const { text, reasoning } = extractContent(data.content);
					if (reasoning) {
						fire({ type: ActionType.ChatReasoning, turnId, partId: ensurePart(ResponsePartKind.Reasoning), content: reasoning });
					}
					if (text) {
						fire({ type: ActionType.ChatDelta, turnId, partId: ensurePart(ResponsePartKind.Markdown), content: text });
					}
					break;
				}
				case 'function.call.delta': {
					// Arguments may stream over several deltas for the same call.
					const existing = toolCalls.get(data.toolCallId);
					if (existing) {
						existing.arguments += data.arguments ?? '';
						break;
					}
					toolCalls.set(data.toolCallId, { toolCallId: data.toolCallId, name: data.name, arguments: data.arguments ?? '' });
					// Registers the call with the host, which is what lets a later
					// pending_confirmation round-trip through respondToPermissionRequest.
					fire({ type: ActionType.ChatToolCallStart, turnId, toolCallId: data.toolCallId, toolName: data.name, displayName: toolDisplayName(data.name) });
					break;
				}
				case 'conversation.response.done': {
					usage.inputTokens = data.usage.promptTokens;
					usage.outputTokens += data.usage.completionTokens;
					break;
				}
				case 'conversation.response.error': {
					fireError(`MistralError(${data.code})`, data.message);
					return { toolCalls: [...toolCalls.values()], errored: true, model };
				}
				default:
					break;
			}
		}
		return { toolCalls: [...toolCalls.values()], errored: false, model };
	}

	private _defaultModelId(): string {
		return this._models.get()[0]?.id ?? 'devstral-latest';
	}

	/**
	 * Ask the host whether a mutating tool may run. The `pending_confirmation`
	 * signal makes the host apply its auto-approval policy (session approvals,
	 * terminal rules, workspace paths) and otherwise prompt the user; the
	 * verdict arrives via {@link respondToPermissionRequest}.
	 */
	private _requestApproval(session: MistralAgentSession, tc: IMistralToolCall, description: ReturnType<typeof describeMistralToolCall>): Promise<boolean> {
		const isShell = tc.name === 'run_bash';
		const state: ToolCallPendingConfirmationState = {
			toolCallId: tc.toolCallId,
			toolName: tc.name,
			displayName: toolDisplayName(tc.name),
			invocationMessage: description.invocationMessage,
			toolInput: description.toolInput,
			status: ToolCallStatus.PendingConfirmation,
			confirmationTitle: isShell ? localize('mistralAgent.runInTerminal', "Run in terminal") : localize('mistralAgent.writeFile', "Write file"),
		};
		this._onDidChatProgress.fire({
			kind: 'pending_confirmation',
			chat: session.chat,
			state,
			permissionKind: isShell ? 'shell' : 'write',
			...(description.path ? { permissionPath: description.path } : {}),
			// `child_process.exec` runs commands through cmd.exe on Windows.
			...(isShell && !isWindows ? { shellLanguage: 'bash' as const } : {}),
		});
		return this._awaitPermission(tc.toolCallId, session.abortSignal);
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

	respondToUserInputRequest(_requestId: string, _response: ChatInputResponseKind, _answers?: Record<string, ChatInputAnswer>): void {
		// The Mistral toolset has no `ask_user` elicitation, so there is nothing to route back.
	}

	// #endregion

	// #region Clients and customizations (not supported by this harness)

	getOrCreateActiveClient(_chat: URI, _context: URI | IAgentChatContext, client: { readonly clientId: string; readonly displayName?: string }): IActiveClient {
		// Client-provided tools and plugin customizations are not forwarded to
		// Mistral; the handle only keeps what the host assigns.
		let tools: readonly ToolDefinition[] = [];
		let customizations: readonly ClientPluginCustomization[] = [];
		return {
			clientId: client.clientId,
			displayName: client.displayName,
			get tools() { return tools; },
			set tools(value: readonly ToolDefinition[]) { tools = value; },
			get customizations() { return customizations; },
			set customizations(value: readonly ClientPluginCustomization[]) { customizations = value; },
		};
	}

	removeActiveClient(_chat: URI, _context: URI | IAgentChatContext, _clientId: string): void {
		// No per-client state to drop.
	}

	onClientToolCallComplete(_chat: URI, _toolCallId: string, _result: ToolCallResult): void {
		// No client tools are advertised to the model, so none can complete.
	}

	async getChatCustomizations(_chat: URI, _context: URI | IAgentChatContext, _hostCustomizations?: readonly Customization[]): Promise<readonly Customization[]> {
		return [];
	}

	// #endregion

	async shutdown(): Promise<void> {
		this._logService.trace('[Mistral] shutdown');
		// Aborts any in-flight turn; the backings live in Agent Host's catalog.
		this._chats.clearAndDisposeAll();
	}
}
