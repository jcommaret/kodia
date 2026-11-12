/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { SequencerByKey } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { IFileService } from '../../../files/common/files.js';
import { createDecorator } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import type { AgentChatMigrationResult, AgentProvider, AgentSignal, IActiveClient, IAgent, IAgentChatConfigCompletionsParams, IAgentChatContext, IAgentChatDataChange, IAgentChatMetadata, IAgentChats, IAgentCreateChatOptions, IAgentCreateChatResult, IAgentDescriptor, IAgentDiscoveredChat, IAgentMaterializeChatEvent, IAgentModelInfo, IAgentResolveChatConfigParams, IAgentSpawnChatEvent } from '../../common/agent.js';
import type { IByokLmBridgeConnection, IByokLmChatDelta, IByokLmChatResult, IByokLmFunctionCallItem, IByokLmFunctionTool, IByokLmModelInfo, IKodiaAutoApprove, IKodiaMcpTool, IKodiaMcpToolResult } from '../../common/agentHostByokLm.js';
import { createSchema, platformSessionSchema } from '../../common/agentHostSchema.js';
import { KODIA_AGENT_PROVIDER_ID, KODIA_AGENT_RESOURCE } from '../../common/kodiaAgentHostLm.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { ActionType, type ChatAction } from '../../common/state/sessionActions.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import type { ModelSelection, ProtectedResourceMetadata, ToolCallPendingConfirmationState, ToolDefinition } from '../../common/state/protocol/state.js';
import { createErrorResponsePart, MessageKind, ResponsePartKind, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, TurnState, type ChatInputAnswer, type ChatInputResponseKind, type ClientPluginCustomization, type Customization, type MessageAttachment, type ResponsePart, type ToolCallResult, type Turn } from '../../common/state/sessionState.js';
import type { IByokLmBridgeRegistry } from '../byokLmBridgeRegistry.js';
import { IAgentHostTerminalManager } from '../agentHostTerminalManager.js';
import { KodiaAgentSession, projectForWorkingDirectory } from './kodiaAgentSession.js';
import { KodiaReplyStream } from './kodiaReplyStream.js';
import { chooseKeepIdx, clearOldToolResults, estimateHistoryTokens, IKodiaCompaction, modelHistory, tokensOfChars, transcriptMessages } from './kodiaContext.js';
import { readProjectMemory, readProjectRules, readProjectSkills } from './kodiaProjectContext.js';
import { skillsPrompt } from '../../../kodia/common/projectInstructions.js';
import { projectMemoryPrompt } from '../../../kodia/common/projectMemory.js';
import { summarizeThread_systemMessage, summarizeThread_userMessage, summaryTranscriptMaxChars, transcriptForSummary } from '../../../kodia/common/threadSummary.js';
import { editorToolNames, isEditorToolName } from '../../../kodia/common/toolCatalog.js';
import { GIT_FUNCTION_TOOLS, gitToolNames } from './kodiaGitTools.js';
import { isPersistentTerminalToolName, KodiaTerminals, PERSISTENT_TERMINAL_FUNCTION_TOOLS, persistentTerminalToolNames } from './kodiaTerminals.js';
import { TODO_FUNCTION_TOOL, TODO_TOOL_NAME } from './kodiaTodoTool.js';
import { approvalOfTool, describeKodiaToolCall, editorFunctionTools, editorToolArguments, executeKodiaTool, IKodiaToolResult, KODIA_TOOLS, toolDisplayName } from './kodiaTools.js';

/**
 * The bridge to the Kodia windows that run the Kodia agent's model requests,
 * over {@link KODIA_AGENT_HOST_LM_CHANNEL}. Separate from the BYOK bridge.
 */
export const IKodiaLmBridgeRegistry = createDecorator<IByokLmBridgeRegistry>('kodiaLmBridgeRegistry');

/** Safety cap on tool-call rounds within a single user turn. */
const MAX_TOOL_ROUNDS = 50;

/** The share of the model's context window the history may take before it is made smaller. */
const CONTEXT_BUDGET = 0.8;

/** As for the agent's own tools, what a tool run by a Kodia window (an MCP tool, an editor tool) returns stays in the history: ~25k tokens at most. */
const MAX_WINDOW_TOOL_OUTPUT_CHARS = 100_000;

/** What the model receives when the user denies a tool call. */
const TOOL_DENIED_RESULT = 'The user denied this tool call.';

/**
 * A Kodia model's id in the Agents Window: `<provider>/<model>`. Model names
 * may contain `/` (OpenRouter), provider names never do.
 */
function toAgentModelId(model: IByokLmModelInfo): string {
	return `${model.vendor}/${model.id}`;
}

function parseAgentModelId(id: string): { readonly vendor: string; readonly modelId: string } | undefined {
	const slash = id.indexOf('/');
	return slash > 0 ? { vendor: id.slice(0, slash), modelId: id.slice(slash + 1) } : undefined;
}

function instructionsFor(workingDirectory: URI | undefined): string {
	const lines = ['You are a coding agent. Use the tools to look at and change the user\'s project, then say briefly what you did.'];
	if (workingDirectory) {
		lines.push(`The project is at ${workingDirectory.fsPath}; relative paths resolve against it.`);
	}
	lines.push('Find files with search_pathnames_only and search_for_files, read just the lines you need of a large file with read_file, and change a file with edit_file: rewrite_file replaces all of one.');
	return lines.join('\n');
}

/** An MCP tool of the Kodia window, in the shape the model is offered tools in. */
function mcpFunctionTool(tool: IKodiaMcpTool): IByokLmFunctionTool {
	return {
		type: 'function',
		name: tool.name,
		description: [tool.description, `(MCP server: ${tool.serverName})`].filter(Boolean).join(' '),
		parametersSchema: tool.inputSchema ?? { type: 'object', properties: {} },
	};
}

function toToolCallResult(displayName: string, res: IKodiaToolResult): ToolCallResult {
	return {
		success: res.success,
		pastTenseMessage: res.success ? res.pastTenseMessage ?? `Ran ${displayName}` : `${displayName} failed`,
		// a command of a persistent terminal: the window shows the terminal with it, and what it printed once the terminal is gone
		content: [
			...res.terminal ? [{
				type: ToolResultContentType.Terminal as const,
				resource: res.terminal.resource,
				title: res.terminal.title,
				...(res.terminal.exitCode !== undefined || res.terminal.preview !== undefined ? { result: { exitCode: res.terminal.exitCode, preview: res.terminal.preview } } : {}),
			}] : [],
			{ type: ToolResultContentType.Text, text: res.output },
		],
		...(res.success ? {} : { error: { message: res.output } }),
	};
}

/**
 * Kodia: `IAgent` that runs every model shown in Kodia's model dropdown,
 * whatever its provider (Gemini, OpenRouter, Anthropic, local models…).
 *
 * The agent host cannot reach Kodia's providers, so each model request goes
 * back to a Kodia window, which runs it with Kodia's LLM service
 * ({@link IKodiaLmBridgeRegistry}). The agentic loop and the local tools
 * (`kodiaTools.ts`) run here. Kodia's providers keep no conversation server-side, so
 * each chat's history is kept in the backing Agent Host persists for it.
 * Sessions have a single chat (no `multipleChats` capability).
 */
export class KodiaAgent extends Disposable implements IAgent {
	readonly id: AgentProvider = KODIA_AGENT_PROVIDER_ID;
	readonly agentHostCapabilities = { workspaceConversion: false };

	private readonly _onDidChatProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidChatProgress = this._onDidChatProgress.event;

	private readonly _onDidMaterializeChat = this._register(new Emitter<IAgentMaterializeChatEvent>());
	readonly onDidMaterializeChat = this._onDidMaterializeChat.event;

	private readonly _onDidChangeChatData = this._register(new Emitter<IAgentChatDataChange>());
	readonly onDidChangeChatData = this._onDidChangeChatData.event;

	readonly onDidSpawnChat: Event<IAgentSpawnChatEvent> = Event.None;

	/** Kodia keeps no catalog of conversations, so there is nothing to discover. */
	readonly onDidDiscoverChats: Event<readonly IAgentDiscoveredChat[]> = Event.None;

	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	/** Every chat this process knows, keyed by chat URI. */
	private readonly _chats = this._register(new DisposableMap<string, KodiaAgentSession>());

	/** Serializes sends per chat so concurrent turns queue rather than interleave. */
	private readonly _chatSequencer = new SequencerByKey<string>();

	/** Resolvers for in-flight tool approvals, keyed by tool call id. */
	private readonly _pendingPermissions = new Map<string, (approved: boolean) => void>();

	/** The terminals the agent opened, which outlive a command (open_persistent_terminal and its two tools). */
	private readonly _terminals: KodiaTerminals;

	readonly chats: IAgentChats = {
		createChat: (chat, _context, options) => this._createChat(chat, options),
		disposeChat: async chat => {
			// the chat is deleted: so are the terminals the agent opened for it
			this._terminals.shutdownChat(chat);
			this._chats.deleteAndDispose(chat.toString());
		},
		// The backing is plain data; keep it so a later send continues the chat.
		releaseChat: async () => { },
		sendMessage: (chat, prompt, workingDirectoriesOrDirectory, attachments, turnId) => {
			const workingDirectories = Array.isArray(workingDirectoriesOrDirectory) ? workingDirectoriesOrDirectory : workingDirectoriesOrDirectory ? [workingDirectoriesOrDirectory] : undefined;
			return this._sendMessage(chat, prompt, workingDirectories, attachments, turnId);
		},
		// Aborting cancels the model request in the window and unblocks any
		// approval wait. The host has already recorded the turn as cancelled.
		abort: async chat => this._chats.get(chat.toString())?.abortTurn(),
		getModel: chat => this._chats.get(chat.toString())?.model,
		changeModel: async (chat, model) => this._changeModel(chat, model),
		// Kodia has no custom agents.
		changeAgent: async () => { },
		getMessages: async chat => this._getMessages(chat),
	};

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IKodiaLmBridgeRegistry private readonly _bridge: IByokLmBridgeRegistry,
		@IFileService private readonly _fileService: IFileService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@IAgentHostTerminalManager terminalManager: IAgentHostTerminalManager,
	) {
		super();
		this._terminals = this._register(new KodiaTerminals(terminalManager, this._logService));
		this._publishModels();
		this._register(this._bridge.onDidChangeModels(() => this._publishModels()));
	}

	// #region Descriptor, auth and models

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: localize('kodiaAgent.displayName', "Kodia"),
			description: localize('kodiaAgent.description', "Runs the models shown in Kodia's model dropdown, with a native, local tool-using harness"),
		};
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		// Not a sign-in: advertising a resource that is not required keeps the
		// Agents Window from asking for GitHub. Kodia's settings hold the keys.
		return [{ resource: KODIA_AGENT_RESOURCE, resource_name: 'Kodia', required: false }];
	}

	async authenticate(): Promise<boolean> {
		return true;
	}

	/** The models of the Kodia window serving the bridge: none while no Kodia window is open. */
	private _publishModels(): void {
		this._models.set(this._bridge.getModels().map(model => ({
			provider: this.id,
			id: toAgentModelId(model),
			name: model.name ?? model.id,
			maxContextWindow: model.maxContextWindowTokens,
			supportsVision: model.supportsVision ?? false,
		})), undefined);
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
	 * Create a chat *provisionally*: an in-memory record. The first send
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
			this._logService.warn(`[Kodia] Chat ${chatKey} starts empty: importing or forking a conversation is not supported`);
		}
		const workingDirectory = options?.workingDirectories?.[0];
		const session = new KodiaAgentSession(chat, {
			model: options?.model,
			workingDirectory,
			project: options?.project ?? projectForWorkingDirectory(workingDirectory),
			materialized: false,
		});
		this._chats.set(chatKey, session);
		this._logService.info(`[Kodia] Chat created (provisional): ${chatKey}`);
		return this._chatResult(session);
	}

	private _chatResult(session: KodiaAgentSession): IAgentCreateChatResult {
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
		const session = KodiaAgentSession.fromProviderData(chat, providerData);
		if (!session) {
			this._logService.warn(`[Kodia] materializeChat: dropping corrupt providerData for ${chatKey}`);
			return;
		}
		this._chats.set(chatKey, session);
		return this._chatResult(session);
	}

	async getChatMetadata(chat: URI, _context: URI | IAgentChatContext, providerData?: string): Promise<IAgentChatMetadata | undefined> {
		const live = this._chats.get(chat.toString());
		const session = live ?? (providerData !== undefined ? KodiaAgentSession.fromProviderData(chat, providerData) : undefined);
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
		// No provider-native catalog: every Kodia chat is created through Agent Host.
		return [];
	}

	async setWorkingDirectory(_chat: URI, _context: URI | IAgentChatContext, _workingDirectory: URI): Promise<void> {
		throw new Error('The Kodia agent does not support changing the working directory of an existing session.');
	}

	private async _changeModel(chat: URI, model: ModelSelection): Promise<void> {
		const session = this._chats.get(chat.toString());
		if (!session) {
			return;
		}
		session.model = model;
		this._fireChatDataChanged(session);
	}

	private _fireChatDataChanged(session: KodiaAgentSession): void {
		this._onDidChangeChatData.fire({ chat: session.chat, providerData: session.toProviderData() });
	}

	// #endregion

	// #region History

	/** Rebuild a chat's turns from its history, so a restored session shows what was said. */
	private _getMessages(chat: URI): readonly Turn[] {
		const session = this._chats.get(chat.toString());
		if (!session) {
			return [];
		}
		const outputs = new Map<string, string>();
		for (const item of session.history) {
			if (item.type === 'function_call_output') {
				outputs.set(item.callId, item.output);
			}
		}
		const turns: Turn[] = [];
		let current: { id: string; text: string; responseParts: ResponsePart[] } | undefined;
		let userTurn = 0;
		const finish = () => {
			if (current) {
				turns.push({ id: current.id, message: { text: current.text, origin: { kind: MessageKind.User } }, responseParts: current.responseParts, usage: undefined, state: TurnState.Complete });
			}
		};
		for (const item of session.history) {
			switch (item.type) {
				case 'message': {
					const text = item.content.map(part => part.type === 'text' ? part.text : '').join('');
					if (item.role === 'user') {
						finish();
						current = { id: session.turnIds[userTurn++] ?? generateUuid(), text, responseParts: [] };
					} else if (item.role === 'assistant' && current && text) {
						current.responseParts.push({ kind: ResponsePartKind.Markdown, id: generateUuid(), content: text });
					}
					break;
				}
				case 'reasoning': {
					const reasoning = item.summary.join('\n');
					if (current && reasoning) {
						current.responseParts.push({ kind: ResponsePartKind.Reasoning, id: generateUuid(), content: reasoning });
					}
					break;
				}
				case 'function_call': {
					const output = outputs.get(item.callId);
					if (!current || output === undefined) {
						break;
					}
					const denied = output === TOOL_DENIED_RESULT;
					const description = describeKodiaToolCall(item.name, item.argumentsJson, undefined);
					current.responseParts.push({
						kind: ResponsePartKind.ToolCall,
						toolCall: {
							status: ToolCallStatus.Completed,
							toolCallId: item.callId,
							toolName: item.name,
							displayName: toolDisplayName(item.name),
							invocationMessage: description.invocationMessage,
							toolInput: description.toolInput,
							success: !denied,
							pastTenseMessage: denied ? `${toolDisplayName(item.name)} denied` : `Ran ${toolDisplayName(item.name)}`,
							content: [{ type: ToolResultContentType.Text, text: output }],
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

	/**
	 * Drop tool calls left without a result by an aborted or failed turn: a
	 * provider rejects a history where a tool call has no result.
	 */
	private _settleHistory(session: KodiaAgentSession): void {
		const answered = new Set<string>();
		for (const item of session.history) {
			if (item.type === 'function_call_output') {
				answered.add(item.callId);
			}
		}
		const kept = session.history.map(item => item.type !== 'function_call' || answered.has(item.callId));
		if (kept.every(Boolean)) {
			return;
		}
		// the compaction points into the history: it follows the items that stay
		const indexAfter = (idx: number) => kept.slice(0, idx).filter(Boolean).length;
		const compaction = session.compaction;
		session.compaction = compaction && {
			clearedBefore: indexAfter(compaction.clearedBefore),
			...(compaction.summary ? { summary: { text: compaction.summary.text, keepFromIdx: indexAfter(compaction.summary.keepFromIdx) } } : {}),
		} satisfies IKodiaCompaction;
		session.history = session.history.filter((_, i) => kept[i]);
	}

	// #endregion

	// #region Turn loop

	private async _sendMessage(chat: URI, prompt: string, workingDirectories: readonly URI[] | undefined, _attachments: readonly MessageAttachment[] | undefined, turnId: string | undefined): Promise<void> {
		const chatKey = chat.toString();
		await this._chatSequencer.queue(chatKey, async () => {
			const session = this._chats.get(chatKey);
			if (!session) {
				throw new Error(`[Kodia] Unknown chat: ${chatKey}`);
			}
			// The host's resolved directory (e.g. a worktree) is where the tools run.
			const workingDirectory = workingDirectories?.[0];
			if (workingDirectory && workingDirectory.toString() !== session.workingDirectory?.toString()) {
				session.workingDirectory = workingDirectory;
				session.project ??= projectForWorkingDirectory(workingDirectory);
			}
			if (!session.materialized) {
				session.materialized = true;
				this._logService.info(`[Kodia] Chat materialized: ${chatKey}`);
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

	private async _runTurn(session: KodiaAgentSession, prompt: string, turnId: string): Promise<void> {
		const startedAt = Date.now();
		const fire = (action: ChatAction) => this._onDidChatProgress.fire({ kind: 'action', resource: session.chat, action });
		const fireError = (errorType: string, message: string) => fire({ type: ActionType.ChatError, turnId, duration: Date.now() - startedAt, part: createErrorResponsePart({ errorType, message }) });

		const model = parseAgentModelId(session.model?.id ?? this._models.get()[0]?.id ?? '');
		if (!model) {
			fireError('NoModel', localize('kodiaAgent.noModel', "No model to run. Show at least one model in Kodia's model dropdown."));
			return;
		}
		const connection = this._bridge.getServingConnection();
		if (!connection) {
			fireError('NoKodiaWindow', localize('kodiaAgent.noWindow', "Kodia's models run in a Kodia window. Open one and try again."));
			return;
		}

		const signal = session.abortSignal;
		const toolCtx = { workingDirectory: session.workingDirectory, signal };
		const usage = { inputTokens: 0, outputTokens: 0 };
		session.contextTokens = (session.contextTokens ?? estimateHistoryTokens(modelHistory(session.history, session.compaction))) + tokensOfChars(prompt.length);
		session.history.push({ type: 'message', role: 'user', content: [{ type: 'text', text: prompt }] });
		session.turnIds.push(turnId);

		try {
			// read once a turn: the rules and skills don't change between its rounds
			const instructions = await this._instructions(session);
			// and so do the MCP tools of the Kodia window, which has the user's MCP servers
			const mcpTools = await this._mcpTools(connection);
			// and what the user's Kodia settings let run without asking
			const autoApprove = await this._autoApprove(connection);
			// and the editor tools (language server, lint errors), when an editor window is open to run them
			const editor = await this._editorTools(connection);
			const tools = [...KODIA_TOOLS, ...GIT_FUNCTION_TOOLS, TODO_FUNCTION_TOOL, ...PERSISTENT_TERMINAL_FUNCTION_TOOLS, ...editorFunctionTools(editor?.names ?? []), ...[...mcpTools.values()].map(mcpFunctionTool)];
			for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
				await this._fitContext(connection, session, model, signal);
				if (signal.aborted) {
					return;
				}
				// what the model writes is shown as it comes, when the window streams it
				const reply = new KodiaReplyStream(turnId, fire);
				const result = await this._chat(connection, session, model, instructions, tools, signal, delta => { if (!signal.aborted) { reply.append(delta); } });
				if (signal.aborted) {
					return;
				}
				if (result.error) {
					fireError('KodiaModelError', result.error);
					return;
				}
				if (result.usage) {
					usage.inputTokens = result.usage.inputTokens ?? usage.inputTokens;
					usage.outputTokens += result.usage.outputTokens ?? 0;
					// what was sent, and what came back: what the next request starts from
					if (result.usage.inputTokens !== undefined) {
						session.contextTokens = result.usage.inputTokens + (result.usage.outputTokens ?? 0);
					}
					fire({ type: ActionType.ChatUsage, turnId, usage: { ...usage, model: model.modelId } });
				}

				const toolCalls: IByokLmFunctionCallItem[] = [];
				for (const item of result.output) {
					if (item.type === 'message') {
						session.history.push({ type: 'message', role: 'assistant', content: item.content });
						const text = item.content.map(part => part.text).join('');
						if (text) {
							reply.completeText(text);
						}
					} else {
						session.history.push(item);
						if (item.type === 'reasoning' && item.summary.length) {
							reply.completeReasoning(item.summary.join('\n'));
						} else if (item.type === 'function_call') {
							toolCalls.push(item);
						}
					}
				}
				if (toolCalls.length === 0) {
					break;
				}

				// Execute each requested tool locally and record its result.
				for (const call of toolCalls) {
					// Registers the call with the host, which is what lets a later
					// pending_confirmation round-trip through respondToPermissionRequest.
					const mcpTool = mcpTools.get(call.name);
					const displayName = mcpTool ? `${mcpTool.displayName} (${mcpTool.serverName})` : toolDisplayName(call.name);
					fire({ type: ActionType.ChatToolCallStart, turnId, toolCallId: call.callId, toolName: call.name, displayName });
					const description = mcpTool ? { invocationMessage: displayName, toolInput: call.argumentsJson } : describeKodiaToolCall(call.name, call.argumentsJson, session.workingDirectory);
					const approvalKind = mcpTool ? 'MCP tools' as const : approvalOfTool(call.name);
					if (approvalKind && autoApprove[approvalKind] !== true) {
						// Mutating tools, and every MCP tool, go through the host's permission flow, which
						// applies the session's approval settings or asks the user.
						const approved = await this._requestApproval(session, call, description, mcpTool ? displayName : undefined);
						if (signal.aborted) {
							return;
						}
						if (!approved) {
							fire({ type: ActionType.ChatToolCallComplete, turnId, toolCallId: call.callId, result: { success: false, pastTenseMessage: `${displayName} denied`, content: [{ type: ToolResultContentType.Text, text: TOOL_DENIED_RESULT }] } });
							session.history.push({ type: 'function_call_output', callId: call.callId, output: TOOL_DENIED_RESULT });
							session.contextTokens = (session.contextTokens ?? 0) + tokensOfChars(TOOL_DENIED_RESULT.length);
							continue;
						}
					} else {
						fire({
							type: ActionType.ChatToolCallReady, turnId, toolCallId: call.callId,
							invocationMessage: description.invocationMessage, toolInput: description.toolInput,
							// a kind the user switched on in Kodia's settings is approved, as in the chat
							confirmed: approvalKind ? ToolCallConfirmationReason.Setting : ToolCallConfirmationReason.NotNeeded,
						});
					}
					const res = mcpTool ? await this._callMcpTool(connection, call, signal)
						: editor?.names.includes(call.name) ? await this._callEditorTool(editor.connection, call, session.workingDirectory, signal)
							: isPersistentTerminalToolName(call.name) ? await this._terminals.execute(call.name, call.argumentsJson, { chat: session.chat, turnId, toolCallId: call.callId, workingDirectory: session.workingDirectory, signal })
								: await executeKodiaTool(call.name, call.argumentsJson, toolCtx);
					if (signal.aborted) {
						return;
					}
					fire({ type: ActionType.ChatToolCallComplete, turnId, toolCallId: call.callId, result: toToolCallResult(displayName, res) });
					session.history.push({ type: 'function_call_output', callId: call.callId, output: res.output });
					session.contextTokens = (session.contextTokens ?? 0) + tokensOfChars(res.output.length);
				}
			}

			fire({ type: ActionType.ChatTurnComplete, turnId, duration: Date.now() - startedAt });
		} catch (err) {
			if (!signal.aborted) {
				this._logService.error(`[Kodia] Turn failed: ${err}`);
				fireError('TurnError', err instanceof Error ? err.message : String(err));
			}
		} finally {
			// A turn the user stopped takes with it the terminals it opened. The others stay for the next turn, until the
			// agent kills them or the chat goes.
			if (signal.aborted) {
				this._terminals.shutdownChat(session.chat, turnId);
			}
			// Keep what happened, even in an aborted or failed turn, so the next one continues from it.
			this._settleHistory(session);
			session.modifiedAt = Date.now();
			this._fireChatDataChanged(session);
		}
	}

	/**
	 * What the model is told besides the conversation: the agent's own instructions, then the project's rules files,
	 * skills and memory, from the most stable part to the most changing one so a provider's prompt cache keeps the
	 * longest prefix. They are the project's own, as in Kodia's chat: a failure to read them leaves them out.
	 */
	private async _instructions(session: KodiaAgentSession): Promise<string> {
		const sections = [instructionsFor(session.workingDirectory)];
		try {
			const [rules, skills, memory] = await Promise.all([
				readProjectRules(session.workingDirectory, this._fileService),
				readProjectSkills(session.workingDirectory, this._environmentService.userHome, this._fileService),
				readProjectMemory(session.workingDirectory, this._fileService),
			]);
			if (rules) {
				sections.push(`PROJECT RULES (from the project's rules files):\n${rules}`);
			}
			if (skills.length > 0) {
				sections.push(skillsPrompt(skills));
			}
			// the notes the agent keeps with write_project_memory, as in the chat
			if (memory) {
				sections.push(projectMemoryPrompt(memory));
			}
		} catch (err) {
			this._logService.warn(`[Kodia] Could not read the project's rules and skills: ${err}`);
		}
		return sections.join('\n\n');
	}

	/**
	 * Before a request: if the history no longer fits the model's context window, make it smaller, as Kodia's chat does.
	 * First the results of the tool calls of earlier turns are cleared; if that isn't enough, the model summarizes the
	 * older messages, and the summary takes their place. A conversation that can't be made smaller is sent as it is.
	 */
	private async _fitContext(connection: IByokLmBridgeConnection, session: KodiaAgentSession, model: { readonly vendor: string; readonly modelId: string }, signal: AbortSignal): Promise<void> {
		const contextWindow = this._bridge.getModels().find(m => m.vendor === model.vendor && m.id === model.modelId)?.maxContextWindowTokens;
		if (!contextWindow) {
			return;
		}
		const budget = Math.floor(contextWindow * CONTEXT_BUDGET);
		let tokens = session.contextTokens ?? estimateHistoryTokens(modelHistory(session.history, session.compaction));
		if (tokens <= budget) {
			return;
		}
		const cleared = clearOldToolResults(session.history, session.compaction);
		if (cleared) {
			session.compaction = cleared.compaction;
			tokens = Math.max(0, tokens - tokensOfChars(cleared.clearedChars));
			session.contextTokens = tokens;
			if (tokens <= budget) {
				this._logService.info(`[Kodia] Cleared the results of old tool calls to fit the context window (${cleared.clearedChars} characters).`);
				return;
			}
		}
		if (await this._summarizeOlderHistory(connection, session, model, contextWindow, signal)) {
			session.contextTokens = estimateHistoryTokens(modelHistory(session.history, session.compaction));
		}
	}

	/** The model summarizes the older part of the history, and the summary is what the model is sent in its place. False if there was nothing to summarize or it failed. */
	private async _summarizeOlderHistory(connection: IByokLmBridgeConnection, session: KodiaAgentSession, model: { readonly vendor: string; readonly modelId: string }, contextWindow: number, signal: AbortSignal): Promise<boolean> {
		// what is before this is in the latest summary already
		const before = session.compaction?.summary?.keepFromIdx ?? 0;
		const keepFromIdx = chooseKeepIdx(session.history, before);
		// a summary that failed isn't tried again until the history has grown
		if (keepFromIdx === undefined || (session.summaryTriedAtLength !== undefined && session.history.length - session.summaryTriedAtLength < 4)) {
			return false;
		}
		session.summaryTriedAtLength = session.history.length;
		const transcript = transcriptForSummary(transcriptMessages(session.history, before, keepFromIdx), { previousSummary: session.compaction?.summary?.text, maxChars: summaryTranscriptMaxChars(contextWindow) });
		const cts = new CancellationTokenSource();
		const onAbort = () => cts.cancel();
		signal.addEventListener('abort', onAbort, { once: true });
		try {
			const result = await connection.chat({
				vendor: model.vendor,
				modelId: model.modelId,
				instructions: summarizeThread_systemMessage,
				input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: summarizeThread_userMessage(transcript) }] }],
				tools: [],
			}, cts.token);
			const summary = result.output.flatMap(item => item.type === 'message' ? item.content.map(part => part.type === 'text' ? part.text : '') : []).join('').trim();
			if (result.error || !summary || signal.aborted) {
				this._logService.warn(`[Kodia] Could not summarize the conversation: ${result.error ?? 'no summary'}`);
				return false;
			}
			session.compaction = { clearedBefore: session.compaction?.clearedBefore ?? 0, summary: { text: summary, keepFromIdx } };
			session.summaryTriedAtLength = undefined;
			this._logService.info(`[Kodia] Summarized the conversation to fit the context window (${keepFromIdx - before} items).`);
			return true;
		} catch (err) {
			this._logService.warn(`[Kodia] Could not summarize the conversation: ${err}`);
			return false;
		} finally {
			signal.removeEventListener('abort', onAbort);
			cts.dispose();
		}
	}

	/**
	 * The MCP tools of the Kodia window, by the name the model calls them. The window runs the MCP servers, so there
	 * are none when it doesn't offer them (an older window) or can't be asked: the agent then has its own tools.
	 */
	private async _mcpTools(connection: IByokLmBridgeConnection): Promise<Map<string, IKodiaMcpTool>> {
		if (!connection.listMcpTools || !connection.callMcpTool) {
			return new Map();
		}
		try {
			const ownTools = new Set<string>([...KODIA_TOOLS.map(tool => tool.name), ...gitToolNames, TODO_TOOL_NAME, ...persistentTerminalToolNames, ...editorToolNames]);
			return new Map((await connection.listMcpTools()).filter(tool => !ownTools.has(tool.name)).map(tool => [tool.name, tool]));
		} catch (err) {
			this._logService.warn(`[Kodia] Could not list the MCP tools of the Kodia window: ${err}`);
			return new Map();
		}
	}

	/**
	 * What the user's Kodia settings let run without asking (Settings > Auto-approve), as the chat honors it. Nothing is
	 * approved when the window doesn't say (an older one) or can't be asked: the host's permission flow decides then.
	 */
	private async _autoApprove(connection: IByokLmBridgeConnection): Promise<IKodiaAutoApprove> {
		if (!connection.getAutoApprove) {
			return {};
		}
		try {
			return await connection.getAutoApprove() ?? {};
		} catch (err) {
			this._logService.warn(`[Kodia] Could not read the auto-approval settings of the Kodia window: ${err}`);
			return {};
		}
	}

	/**
	 * The Kodia window that can run the editor tools (the language server's, the lint errors) this turn, and which of
	 * them it runs. Every Kodia window serves the model, but only an editor window has the tools: the Agents Window says
	 * it has none. The serving window is asked first, then the others. Nothing when no window can, or none can be asked:
	 * the agent then has its own tools, and searches by text.
	 */
	private async _editorTools(connection: IByokLmBridgeConnection): Promise<{ readonly connection: IByokLmBridgeConnection; readonly names: string[] } | undefined> {
		for (const candidate of new Set([connection, ...(this._bridge.getServingConnections?.() ?? [])])) {
			if (!candidate.listEditorTools || !candidate.callEditorTool) {
				continue;
			}
			try {
				const names = (await candidate.listEditorTools()).filter(isEditorToolName);
				if (names.length > 0) {
					return { connection: candidate, names };
				}
			} catch (err) {
				this._logService.warn(`[Kodia] Could not list the editor tools of a Kodia window: ${err}`);
			}
		}
		return undefined;
	}

	/** One MCP tool call, run by the Kodia window and cancelled with the turn. */
	private async _callMcpTool(connection: IByokLmBridgeConnection, call: IByokLmFunctionCallItem, signal: AbortSignal): Promise<IKodiaToolResult> {
		const callMcpTool = connection.callMcpTool?.bind(connection);
		if (!callMcpTool) {
			return { success: false, output: 'MCP tools are not available.' };
		}
		return this._runInWindow(signal, token => callMcpTool(call.name, call.argumentsJson, token));
	}

	/** One editor tool call, run by the editor window that offered it. The path is made absolute: that window has another working directory. */
	private async _callEditorTool(connection: IByokLmBridgeConnection, call: IByokLmFunctionCallItem, workingDirectory: URI | undefined, signal: AbortSignal): Promise<IKodiaToolResult> {
		const callEditorTool = connection.callEditorTool?.bind(connection);
		if (!callEditorTool) {
			return { success: false, output: 'Editor tools are not available.' };
		}
		const argsJson = editorToolArguments(call.argumentsJson, workingDirectory);
		return this._runInWindow(signal, token => callEditorTool(call.name, argsJson, token));
	}

	// A tool a Kodia window runs: cancelled with the turn, and its output cut where it would fill the context.
	private async _runInWindow(signal: AbortSignal, run: (token: CancellationToken) => Promise<IKodiaMcpToolResult>): Promise<IKodiaToolResult> {
		const cts = new CancellationTokenSource();
		const onAbort = () => cts.cancel();
		signal.addEventListener('abort', onAbort, { once: true });
		try {
			const { isError, output } = await run(cts.token);
			return { success: !isError, output: output.length > MAX_WINDOW_TOOL_OUTPUT_CHARS ? `${output.slice(0, MAX_WINDOW_TOOL_OUTPUT_CHARS)}\n(The output is cut here.)` : output };
		} catch (err) {
			return { success: false, output: err instanceof Error ? err.message : String(err) };
		} finally {
			signal.removeEventListener('abort', onAbort);
			cts.dispose();
		}
	}

	/**
	 * One model request, run by the serving Kodia window and cancelled with the turn. `onDelta` gets the text and the
	 * reasoning as the model writes them, before the result, if the window streams: an older one answers at the end.
	 */
	private async _chat(connection: IByokLmBridgeConnection, session: KodiaAgentSession, model: { readonly vendor: string; readonly modelId: string }, instructions: string, tools: IByokLmFunctionTool[], signal: AbortSignal, onDelta: (delta: IByokLmChatDelta) => void): Promise<IByokLmChatResult> {
		const cts = new CancellationTokenSource();
		const onAbort = () => cts.cancel();
		signal.addEventListener('abort', onAbort, { once: true });
		try {
			const request = {
				vendor: model.vendor,
				modelId: model.modelId,
				instructions,
				input: modelHistory(session.history, session.compaction),
				tools,
			};
			return await (connection.chatStream ? connection.chatStream(request, onDelta, cts.token) : connection.chat(request, cts.token));
		} finally {
			signal.removeEventListener('abort', onAbort);
			cts.dispose();
		}
	}

	/**
	 * Ask the host whether a mutating tool may run. The `pending_confirmation`
	 * signal makes the host apply its auto-approval policy (session approvals,
	 * terminal rules, workspace paths) and otherwise prompt the user; the
	 * verdict arrives via {@link respondToPermissionRequest}.
	 */
	private _requestApproval(session: KodiaAgentSession, call: IByokLmFunctionCallItem, description: ReturnType<typeof describeKodiaToolCall>, mcpDisplayName?: string): Promise<boolean> {
		const approval = approvalOfTool(call.name);
		const isShell = approval === 'terminal';
		const isWeb = approval === 'web pages';
		const isMcp = mcpDisplayName !== undefined;
		// a fetched URL has no auto-approval rule, so the host asks unless the session auto-approves everything, as
		// Kodia's chat does for web pages
		const confirmationTitle = isMcp ? localize('kodiaAgent.runMcpTool', "Run MCP tool")
			: call.name === 'open_persistent_terminal' ? localize('kodiaAgent.openTerminal', "Open persistent terminal")
				: call.name === 'kill_persistent_terminal' ? localize('kodiaAgent.killTerminal', "Close persistent terminal")
					: isShell ? localize('kodiaAgent.runInTerminal', "Run in terminal")
				: isWeb ? localize('kodiaAgent.fetchUrl', "Fetch web page")
					: call.name === 'edit_file' ? localize('kodiaAgent.editFile', "Edit file")
						: call.name === 'create_file_or_folder' ? localize('kodiaAgent.createFile', "Create file or folder")
							: call.name === 'delete_file_or_folder' ? localize('kodiaAgent.deleteFile', "Delete file or folder")
								: call.name === 'write_project_memory' ? localize('kodiaAgent.saveProjectMemory', "Save project memory")
									: localize('kodiaAgent.writeFile', "Write file");
		const state: ToolCallPendingConfirmationState = {
			toolCallId: call.callId,
			toolName: call.name,
			displayName: mcpDisplayName ?? toolDisplayName(call.name),
			invocationMessage: description.invocationMessage,
			toolInput: description.toolInput,
			status: ToolCallStatus.PendingConfirmation,
			confirmationTitle,
		};
		this._onDidChatProgress.fire({
			kind: 'pending_confirmation',
			chat: session.chat,
			state,
			permissionKind: isShell ? 'shell' : isMcp ? 'mcp' : isWeb ? 'url' : 'write',
			...(description.path ? { permissionPath: description.path } : {}),
			// `child_process.exec` runs commands through cmd.exe on Windows.
			...(isShell && !isWindows ? { shellLanguage: 'bash' as const } : {}),
		});
		return this._awaitPermission(call.callId, session.abortSignal);
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
		// The toolset has no `ask_user` elicitation, so there is nothing to route back.
	}

	// #endregion

	// #region Clients and customizations (not supported by this harness)

	getOrCreateActiveClient(_chat: URI, _context: URI | IAgentChatContext, client: { readonly clientId: string; readonly displayName?: string }): IActiveClient {
		// Client-provided tools and plugin customizations are not forwarded to
		// the model; the handle only keeps what the host assigns.
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
		this._logService.trace('[Kodia] shutdown');
		// Aborts any in-flight turn, and kills the terminals; the backings live in Agent Host's catalog.
		this._chats.clearAndDisposeAll();
		this._terminals.dispose();
	}
}
