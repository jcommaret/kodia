/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { availableTools, builtinTools, chat_userMessageContent, isABuiltinToolName, summarizeThread_systemMessage, summarizeThread_userMessage } from '../common/prompt/prompts.js';
import { formatSubagentReport, MAX_PARALLEL_SUBAGENTS, resolveSubagentType, SUBAGENT_TIMEOUT_MS, SUBAGENT_TOOL_NAME, SubagentFileClaims, SubagentReport, SubagentStatus, SubagentToolCallFact, SubagentType, subagentRoleText, subagentToolNames, summarizeSubagentRun } from '../common/subagents.js';
import { FILE_CHANGING_TOOLS } from '../common/completionCheck.js';
import { describeOmittedTools, toolsWithinBudget } from '../common/toolBudget.js';
import { estimateTokens } from '../common/tokenizer.js';
import { InternalToolInfo } from '../common/prompt/prompts.js';
import { chooseSummaryKeepIdx, transcriptForSummary } from '../common/helpers/threadSummary.js';
import { getModelCapabilities } from '../common/modelCapabilities.js';
import { autoSelectModel } from '../common/modelCapabilities.js';
import { AnthropicReasoning, getErrorMessage, LLMUsage, RawToolCallObj, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { FeatureName, ModelSelection, ModelSelectionOptions, OverridesOfModel, providerNames, ProviderName } from '../common/voidSettingsTypes.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { approvalTypeOfBuiltinToolName, BuiltinToolCallParams, BuiltinToolName, ToolCallParams, ToolName, ToolResult } from '../common/toolsServiceTypes.js';
import { IToolsService } from './toolsService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { evaluateAutonomy, isPathOutsideWorkspace, AutonomyMode } from '../common/autonomyPolicy.js';
import { TaskPlan, formatTaskPlanForLLM } from '../common/autonomousTask.js';
import { ITaskPlanService } from '../common/taskPlanService.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ChatMessage, CheckpointEntry, CodespanLocationLink, StagingSelectionItem, ToolMessage } from '../common/chatThreadServiceTypes.js';
import { Position } from '../../../../editor/common/core/position.js';
import { IMetricsService } from '../common/metricsService.js';
import { shorten } from '../../../../base/common/labels.js';
import { IVoidModelService } from '../common/voidModelService.js';
import { findLast, findLastIdx } from '../../../../base/common/arraysFind.js';
import { IEditCodeService } from './editCodeServiceInterface.js';
import { VoidFileSnapshot } from '../common/editCodeServiceTypes.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { truncate } from '../../../../base/common/strings.js';
import { THREAD_STORAGE_KEY } from '../common/storageKeys.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { timeout } from '../../../../base/common/async.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IMCPService } from '../common/mcpService.js';
import { RawMCPToolCall } from '../common/mcpServiceTypes.js';
import { looksLikeUnfulfilledAction, UNFULFILLED_ACTION_NUDGE } from '../common/unfulfilledActionDetection.js';
import { contextLimitFromError, isContextOverflowError } from '../common/contextOverflow.js';
import { COMPLETION_CHECK_REQUEST, shouldRequestCompletionCheck } from '../common/completionCheck.js';
import { isTestFilePath, testFileWithoutTestCases, testFileWithoutTestCasesNote, testWeakeningNote, testWeakeningReasons } from '../common/testIntegrity.js';
import { IToolOutputService } from '../common/toolOutputService.js';
import { RetryPolicy, createRetryErrorInfo } from '../common/retryPolicy.js';


// related to retrying when LLM message has error
// Retry is now handled by RetryPolicy (exponential backoff with jitter, retry-after support)
// in retryPolicy.ts, integrated via _retryPolicy in _runChatAgent.

// Maximum number of LLM -> tool steps in one autonomous turn. Keeps long-running
// Maximum number of LLM -> tool steps in one autonomous turn.
// Set to unlimited - agent runs until work is finished and verified.
const MAX_AGENT_STEPS_PER_TURN = 999999
// A model stream that produces nothing for this long is treated as hung (see armInactivityTimer).
const LLM_INACTIVITY_TIMEOUT_MS = 120_000
// How many times one turn may shrink its budget after a provider's context-length error before giving up.
const MAX_CONTEXT_OVERFLOW_RECOVERIES_PER_TURN = 2

// Recovery snapshots are kept in the thread: bounded per file and per change (a bigger file cannot be rewound).
const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024
const MAX_SNAPSHOT_FILES_PER_CHANGE = 500
const MAX_SNAPSHOT_CHARS_PER_THREAD = 20_000_000 // ~20 MB of file contents kept for rewinding, per conversation
// conversations are written to disk this soon after a change (and at once after a file change or a tool start)
const THREADS_FLUSH_DELAY_MS = 1_000

// Stuck detection disabled - agent runs until work is complete.
const MAX_STUCK_STEPS = 999999

// Track progress across steps: files modified/created, terminal commands run,
// test results obtained. Used by stuck detection and for resumable checkpoints.


// File tools that access the filesystem and require workspace containment approval
const FILE_ACCESS_TOOLS: Set<BuiltinToolName> = new Set([
	'read_file',
	'ls_dir',
	'get_dir_tree',
	'search_in_file',
	'go_to_definition',
	'find_references',
	'read_lint_errors',
	'create_file_or_folder',
	'delete_file_or_folder',
	'rewrite_file',
	'write_file',
	'edit_file',
	'search_for_files',
]);

const isFileAccessTool = (toolName: ToolName): toolName is BuiltinToolName => FILE_ACCESS_TOOLS.has(toolName as BuiltinToolName);

// Get the file URI parameter from tool params - handles tools that use 'uri' or 'searchInFolder'
const getFileToolUri = (toolName: ToolName, toolParams: ToolCallParams<ToolName>): URI | null => {
	switch (toolName) {
		case 'search_for_files':
			return (toolParams as BuiltinToolCallParams['search_for_files']).searchInFolder;
		default:
			return (toolParams as BuiltinToolCallParams['read_file']).uri;
	}
};

const findStagingSelectionIndex = (currentSelections: StagingSelectionItem[] | undefined, newSelection: StagingSelectionItem): number | null => {
	if (!currentSelections) return null

	for (let i = 0; i < currentSelections.length; i += 1) {
		const s = currentSelections[i]

		// attachments (images, PDFs, text files) have no uri, and each one is its own item
		if (!s.uri || !newSelection.uri) continue
		if (s.uri.fsPath !== newSelection.uri.fsPath) continue

		if (s.type === 'File' && newSelection.type === 'File') {
			return i
		}
		if (s.type === 'CodeSelection' && newSelection.type === 'CodeSelection') {
			if (s.uri.fsPath !== newSelection.uri.fsPath) continue
			// if there's any collision return true
			const [oldStart, oldEnd] = s.range
			const [newStart, newEnd] = newSelection.range
			if (oldStart !== newStart || oldEnd !== newEnd) continue
			return i
		}
		if (s.type === 'Folder' && newSelection.type === 'Folder') {
			return i
		}
	}
	return null
}


/*

Store a checkpoint of all "before" files on each x.
x's show up before user messages and LLM edit tool calls.

x     A          (edited A -> A')
(... user modified changes ...)
User message

x     A' B C     (edited A'->A'', B->B', C->C')
LLM Edit
x
LLM Edit
x
LLM Edit


INVARIANT:
A checkpoint appears before every LLM message, and before every user message (before user really means directly after LLM is done).
*/


type UserMessageType = ChatMessage & { role: 'user' }
type UserMessageState = UserMessageType['state']

// a tool call running alongside sibling calls of the same turn: the caller owns the stream state and combines the interruptors
type ParallelToolRun = { onInterruptor: (interruptor: Promise<() => void>) => void }
const defaultMessageState: UserMessageState = {
	stagingSelections: [],
	isBeingEdited: false,
}

// a 'thread' means a chat message history

type WhenMounted = {
	textAreaRef: { current: HTMLTextAreaElement | null }; // the textarea that this thread has, gets set in SidebarChat
	scrollToBottom: () => void;
}



export type ThreadType = {
	id: string; // store the id here too
	createdAt: string; // ISO string
	lastModified: string; // ISO string

	messages: ChatMessage[];
	filesWithUserChanges: Set<string>;

	// Autonomous task plan for this thread (Stage 5A Day 2)
	taskPlan?: TaskPlan;

	// set when this thread is a subagent started by another thread's `subagent` tool call
	subagentOf?: { parentThreadId: string; agent: SubagentType; description: string };

	// this doesn't need to go in a state object, but feels right
	state: {
		currCheckpointIdx: number | null; // the latest checkpoint we're at (null if not at a particular checkpoint, like if the chat is streaming, or chat just finished and we haven't clicked on a checkpt)

		stagingSelections: StagingSelectionItem[];
		focusedMessageIdx: number | undefined; // index of the user message that is being edited (undefined if none)

		linksOfMessageIdx: { // eg. link = linksOfMessageIdx[4]['RangeFunction']
			[messageIdx: number]: {
				[codespanName: string]: CodespanLocationLink
			}
		}


		mountedInfo?: {
			whenMounted: Promise<WhenMounted>
			_whenMountedResolver: (res: WhenMounted) => void
			mountedIsResolvedRef: { current: boolean };
		}


	};
}

type ChatThreads = {
	[id: string]: undefined | ThreadType;
}


export type ThreadsState = {
	allThreads: ChatThreads;
	currentThreadId: string; // intended for internal use only
}

export type IsRunningType =
	| 'LLM' // the LLM is currently streaming
	| 'tool' // whether a tool is currently running
	| 'awaiting_user' // awaiting user call
	| 'idle' // nothing is running now, but the chat should still appear like it's going (used in-between calls)
	| undefined

export type ThreadStreamState = {
	[threadId: string]: undefined | {
		isRunning: undefined;
		error?: { message: string, fullError: Error | null, };
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | { // an assistant message is being written
		isRunning: 'LLM';
		error?: undefined;
		llmInfo: {
			displayContentSoFar: string;
			reasoningSoFar: string;
			toolCallSoFar: RawToolCallObj | null;
		};
		toolInfo?: undefined;
		interrupt: Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
	} | { // a tool is being run (or several, when a turn's read-only calls run in parallel)
		isRunning: 'tool';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: { // the running tool; absent for a parallel batch
			toolName: ToolName;
			toolParams: ToolCallParams<ToolName>;
			id: string;
			content: string;
			rawParams: RawToolParamsObj;
			mcpServerName: string | undefined;
		};
		interrupt: Promise<() => void>;
	} | {
		isRunning: 'awaiting_user';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | {
		isRunning: 'idle';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt: 'not_needed' | Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
	}
}

const newThreadObject = () => {
	const now = new Date().toISOString()
	return {
		id: generateUuid(),
		createdAt: now,
		lastModified: now,
		messages: [],
		state: {
			currCheckpointIdx: null,
			stagingSelections: [],
			focusedMessageIdx: undefined,
			linksOfMessageIdx: {},
		},
		filesWithUserChanges: new Set()
	} satisfies ThreadType
}



export interface IChatThreadService {
	readonly _serviceBrand: undefined;

	readonly state: ThreadsState;
	readonly streamState: ThreadStreamState; // not persistent

	onDidChangeCurrentThread: Event<void>;
	onDidChangeStreamState: Event<{ threadId: string }>

	getCurrentThread(): ThreadType;
	openNewThread(): void;
	switchToThread(threadId: string): void;

	// thread selector
	deleteThread(threadId: string): void;
	duplicateThread(threadId: string): void;

	// exposed getters/setters
	// these all apply to current thread
	getCurrentMessageState: (messageIdx: number) => UserMessageState
	setCurrentMessageState: (messageIdx: number, newState: Partial<UserMessageState>) => void
	getCurrentThreadState: () => ThreadType['state']
	setCurrentThreadState: (newState: Partial<ThreadType['state']>) => void

	// you can edit multiple messages - the one you're currently editing is "focused", and we add items to that one when you press cmd+L.
	getCurrentFocusedMessageIdx(): number | undefined;
	isCurrentlyFocusingMessage(): boolean;
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined): void;

	popStagingSelections(numPops?: number): void;
	addNewStagingSelection(newSelection: StagingSelectionItem): void;

	dangerousSetState: (newState: ThreadsState) => void;
	resetState: () => void;

	// // current thread's staging selections
	// closeCurrentStagingSelectionsInMessage(opts: { messageIdx: number }): void;
	// closeCurrentStagingSelectionsInThread(): void;

	// codespan links (link to symbols in the markdown)
	getCodespanLink(opts: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined;
	addCodespanLink(opts: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }): void;
	generateCodespanLink(opts: { codespanStr: string, threadId: string }): Promise<CodespanLocationLink>;
	getRelativeStr(uri: URI): string | undefined

	// entry pts
	abortRunning(threadId: string): Promise<void>;
	dismissStreamError(threadId: string): void;

	// call to edit a message
	editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId }: { userMessage: string, messageIdx: number, threadId: string }): Promise<void>;

	// call to add a message
	addUserMessageAndStreamResponse({ userMessage, threadId }: { userMessage: string, threadId: string }): Promise<void>;
	addUserMessage({ userMessage, threadId }: { userMessage: string, threadId: string }): void;

	// Run one autonomous turn: send current thread to LLM, execute any tool calls returned
	runAutonomousTurn(threadId: string): Promise<void>;

	// approve/reject
	approveLatestToolRequest(threadId: string): void;
	rejectLatestToolRequest(threadId: string): void;

	// jump to history
	/** resolves once every file is restored on disk */
	jumpToCheckpointBeforeMessageIdx(opts: { threadId: string, messageIdx: number, jumpToUserModified: boolean }): Promise<void>;

	focusCurrentChat: () => Promise<void>
	blurCurrentChat: () => Promise<void>
}

export const IChatThreadService = createDecorator<IChatThreadService>('voidChatThreadService');
export class ChatThreadService extends Disposable implements IChatThreadService {
	_serviceBrand: undefined;

	// this fires when the current thread changes at all (a switch of currentThread, or a message added to it, etc)
	private readonly _onDidChangeCurrentThread = new Emitter<void>();
	readonly onDidChangeCurrentThread: Event<void> = this._onDidChangeCurrentThread.event;

	private readonly _onDidChangeStreamState = new Emitter<{ threadId: string }>();
	readonly onDidChangeStreamState: Event<{ threadId: string }> = this._onDidChangeStreamState.event;

	readonly streamState: ThreadStreamState = {}
	state: ThreadsState // allThreads is persisted, currentThread is not

	// Per thread: agent loops of several threads (a parent's subagents) run at the same time, and must not reset
	// each other's retry backoff or progress tracking.
	private readonly _retryPolicyOfThread = new Map<string, RetryPolicy>()
	private _retryPolicy(threadId: string): RetryPolicy {
		let p = this._retryPolicyOfThread.get(threadId)
		if (!p) { p = new RetryPolicy(); this._retryPolicyOfThread.set(threadId, p) }
		return p
	}
	// Progress tracking for stuck detection (reset per agent turn)
	private readonly _progressOfThread = new Map<string, { filesTouched: Set<string>; terminalCommands: Set<string>; testResults: Map<string, { passed: number; failed: number }>; stepsSinceLastProgress: number }>()
	private _progress(threadId: string) {
		let p = this._progressOfThread.get(threadId)
		if (!p) { p = { filesTouched: new Set(), terminalCommands: new Set(), testResults: new Map(), stepsSinceLastProgress: 0 }; this._progressOfThread.set(threadId, p) }
		return p
	}

	// --- subagents (roadmap 6) ---
	// the tools a subagent thread may run (absent: the chat mode decides, as for any thread)
	private readonly _toolPolicyOfThread = new Map<string, { agent: SubagentType; allowed: ReadonlySet<string> }>()
	// the model each running agent loop uses, so a subagent can default to its parent's
	private readonly _modelOfRunningThread = new Map<string, { modelSelection: ModelSelection | null; modelSelectionOptions: ModelSelectionOptions | undefined }>()
	private readonly _subagentFileClaims = new SubagentFileClaims()
	private readonly _runningSubagentsOfParent = new Map<string, Set<string>>()


	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IVoidModelService private readonly _voidModelService: IVoidModelService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IToolsService private readonly _toolsService: IToolsService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IMetricsService private readonly _metricsService: IMetricsService,
		@IEditCodeService private readonly _editCodeService: IEditCodeService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessagesService: IConvertToLLMMessageService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IDirectoryStrService private readonly _directoryStringService: IDirectoryStrService,
		@IFileService private readonly _fileService: IFileService,
		@IToolOutputService private readonly _toolOutputService: IToolOutputService,
		@IMCPService private readonly _mcpService: IMCPService,
		@ITaskPlanService private readonly taskPlanService: ITaskPlanService,
	) {
		super()
		this.state = { allThreads: {}, currentThreadId: null as unknown as string } // default state

		// Sync taskPlan from TaskPlanService to thread.taskPlan
		this._register(this.taskPlanService.onDidChangePlan(({ threadId, plan }) => {
			const thread = this.state.allThreads[threadId];
			if (thread) {
				this._setThreadTaskPlan(threadId, plan);
			}
		}));

		const readThreads = this._readAllThreads() || {}

		const allThreads = readThreads
		this.state = {
			allThreads: allThreads,
			currentThreadId: null as unknown as string, // gets set in startNewThread()
		}
		// Session recovery: nothing runs in a freshly started Kodia, so a tool saved as running was cut off by the
		// previous one stopping. Say so in every thread now (not only when one is opened), and say why.
		for (const threadId in allThreads) {
			if (allThreads[threadId]?.messages.some(m => m.role === 'tool' && m.type === 'running_now')) {
				this._rejectRunningTools(threadId, this.toolErrMsgs.interruptedByShutdown)
			}
		}

		// always be in a thread
		this.openNewThread()



	}

	async focusCurrentChat() {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const s = await thread.state.mountedInfo?.whenMounted
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.focus()
		}
	}
	async blurCurrentChat() {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const s = await thread.state.mountedInfo?.whenMounted
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.blur()
		}
	}



	dangerousSetState = (newState: ThreadsState) => {
		this.state = newState
		this._onDidChangeCurrentThread.fire()
	}
	resetState = () => {
		this.state = { allThreads: {}, currentThreadId: null as unknown as string } // see constructor
		this.openNewThread()
		this._onDidChangeCurrentThread.fire()
	}

	// !!! this is important for properly restoring URIs from storage
	// should probably re-use code from void/src/vs/base/common/marshalling.ts instead. but this is simple enough
	private _convertThreadDataFromStorage(threadsStr: string): ChatThreads {
		return JSON.parse(threadsStr, (key, value) => {
			if (value && typeof value === 'object' && value.$mid === 1) { // $mid is the MarshalledId. $mid === 1 means it is a URI
				return URI.from(value); // TODO URI.revive instead of this?
			}
			return value;
		});
	}

	private _readAllThreads(): ChatThreads | null {
		const threadsStr = this._storageService.get(THREAD_STORAGE_KEY, StorageScope.APPLICATION);
		if (!threadsStr) {
			return null
		}
		const threads = this._convertThreadDataFromStorage(threadsStr);

		return threads
	}

	private _storeAllThreads(threads: ChatThreads) {
		const serializedThreads = JSON.stringify(threads);
		this._storageService.store(
			THREAD_STORAGE_KEY,
			serializedThreads,
			StorageScope.APPLICATION,
			StorageTarget.USER
		);
		this._scheduleThreadsFlush()
	}

	// Session recovery: the storage service writes to disk only about once a minute, but an agent changes files on
	// disk at once — a crash in between left files the restored conversation knew nothing about. Flush soon after
	// any change, and right away (awaited) after the agent changes a file or starts a tool.
	private _flushTimer: ReturnType<typeof setTimeout> | undefined
	private _scheduleThreadsFlush() {
		if (this._flushTimer) return
		this._flushTimer = setTimeout(() => { this._flushTimer = undefined; void this._flushThreads() }, THREADS_FLUSH_DELAY_MS)
	}
	private async _flushThreads() {
		if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = undefined }
		try { await this._storageService.flush() } catch { /* the next flush retries */ }
	}
	override dispose() {
		if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = undefined }
		super.dispose()
	}


	// this should be the only place this.state = ... appears besides constructor
	private _setState(state: Partial<ThreadsState>, doNotRefreshMountInfo?: boolean) {
		const newState = {
			...this.state,
			...state
		}

		this.state = newState

		this._onDidChangeCurrentThread.fire()


		// if we just switched to a thread, update its current stream state if it's not streaming to possibly streaming
		const threadId = newState.currentThreadId
		const streamState = this.streamState[threadId]
		if (streamState?.isRunning === undefined && !streamState?.error) {

			// set streamState
			const messages = newState.allThreads[threadId]?.messages
			const lastMessage = messages && messages[messages.length - 1]
			// if awaiting user but stream state doesn't indicate it (happens if restart Kodia)
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'tool_request')
				this._setStreamState(threadId, { isRunning: 'awaiting_user', })

			// if running now but stream state doesn't indicate it (happens if restart Kodia), cancel those tools
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'running_now') {
				this._rejectRunningTools(threadId, this.toolErrMsgs.interruptedByShutdown)
			}

		}


		// if we did not just set the state to true, set mount info
		if (doNotRefreshMountInfo) return

		let whenMountedResolver: (w: WhenMounted) => void
		const whenMountedPromise = new Promise<WhenMounted>((res) => whenMountedResolver = res)

		this._setThreadState(threadId, {
			mountedInfo: {
				whenMounted: whenMountedPromise,
				mountedIsResolvedRef: { current: false },
				_whenMountedResolver: (w: WhenMounted) => {
					whenMountedResolver(w)
					const mountInfo = this.state.allThreads[threadId]?.state.mountedInfo
					if (mountInfo) mountInfo.mountedIsResolvedRef.current = true
				},
			}
		}, true) // do not trigger an update



	}


	private _setStreamState(threadId: string, state: ThreadStreamState[string]) {
		this.streamState[threadId] = state
		this._onDidChangeStreamState.fire({ threadId })
	}


	// ---------- streaming ----------



	private _autoResolvedModels = new Map<string, { modelSelection: ModelSelection, reason: string }>()

	private _currentModelSelectionProps = (threadId: string) => {
		// these settings should not change throughout the loop (eg anthropic breaks if you change its thinking mode and it's using tools)
		const featureName: FeatureName = 'Chat'
		const settingsSelection = this._settingsService.state.modelSelectionOfFeature[featureName]

		// Auto mode: resolve the best model for the current user message
		if (settingsSelection?.modelName === '__auto__') {
			const cached = this._autoResolvedModels.get(threadId)
			if (cached) {
				const modelSelectionOptions = this._settingsService.state.optionsOfModelSelection[featureName][cached.modelSelection.providerName]?.[cached.modelSelection.modelName]
				return { modelSelection: cached.modelSelection, modelSelectionOptions, autoReason: cached.reason }
			}

			// Get the last user message for this thread to analyze the task
			const thread = this.state.allThreads[threadId]
			const lastUserMsg = thread?.messages.findLast(m => m.role === 'user')
			const userMessage = lastUserMsg?.displayContent || ''

			// Build list of available models from settings
			const availableModels: { providerName: ProviderName, modelName: string }[] = []
			for (const providerName of providerNames) {
				const providerModels = this._settingsService.state.settingsOfProvider[providerName]?.models ?? []
				for (const { modelName, isHidden } of providerModels) {
					if (isHidden) continue
					if (modelName === '__auto__') continue
					availableModels.push({ providerName, modelName })
				}
			}

			let selected
			try {
				selected = autoSelectModel(userMessage, availableModels, this._settingsService.state.overridesOfModel)
			} catch (e) {
				console.error('Auto model selection failed:', e)
			}
			if (selected) {
				this._autoResolvedModels.set(threadId, { modelSelection: { providerName: selected.providerName, modelName: selected.modelName }, reason: selected.reason })
				const modelSelectionOptions = this._settingsService.state.optionsOfModelSelection[featureName][selected.providerName]?.[selected.modelName]
				return { modelSelection: { providerName: selected.providerName, modelName: selected.modelName }, modelSelectionOptions, autoReason: selected.reason }
			}
			// Fallback: auto-select failed (no models or scoring error). Use the first available model
			// instead of falling through to '__auto__' which is not a real model.
			if (availableModels.length > 0) {
				const fallback = availableModels[0]
				const modelSelectionOptions = this._settingsService.state.optionsOfModelSelection[featureName][fallback.providerName]?.[fallback.modelName]
				return { modelSelection: fallback, modelSelectionOptions, autoReason: 'auto-select fallback: first available model' }
			}
		}

		const modelSelection = settingsSelection
		const modelSelectionOptions = modelSelection ? this._settingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName] : undefined
		return { modelSelection, modelSelectionOptions }
	}



	// Find the tool's message by id rather than taking the last message: tools of one turn can run in
	// parallel, so the last message may belong to a sibling call.
	private _swapOutLatestStreamingToolWithResult = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const messages = this.state.allThreads[threadId]?.messages
		if (!messages) return false

		// only a call still in progress is updated: providers can reuse ids across turns (e.g. "call_0" every time),
		// and matching a finished result by id overwrote an earlier turn's tool call in the history
		const idx = findLastIdx(messages, m => m.role === 'tool' && (m.type === 'running_now' || m.type === 'tool_request') && m.id === tool.id)
		if (idx === -1) return false

		this._editMessageInThread(threadId, idx, tool)
		return true
	}
	private _updateLatestTool = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const swapped = this._swapOutLatestStreamingToolWithResult(threadId, tool)
		if (swapped) return
		this._addMessageToThread(threadId, tool)
	}

	approveLatestToolRequest(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]
		if (!(lastMsg.role === 'tool' && lastMsg.type === 'tool_request')) return // should never happen

		const callThisToolFirst: ToolMessage<ToolName> = lastMsg

		this._wrapRunAgentToNotify(
			this._runChatAgent({ callThisToolFirst, threadId, ...this._currentModelSelectionProps(threadId) })
			, threadId
		)
	}
	rejectLatestToolRequest(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]

		let params: ToolCallParams<ToolName>
		if (lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params') {
			params = lastMsg.params
		}
		else return

		const { name, id, rawParams, mcpServerName } = lastMsg

		const errorMessage = this.toolErrMsgs.rejected
		this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: params, name: name, content: errorMessage, result: null, id, rawParams, mcpServerName })
		this._setStreamState(threadId, undefined)
	}

	// The thread no longer fits the model's context window: from now on, send the results of the tool calls made
	// before the latest user message as a stub (ContextClearedEntry). Returns false if there was nothing to clear.
	private _clearOldToolResults(threadId: string): boolean {
		const messages = this.state.allThreads[threadId]?.messages
		if (!messages) return false

		const latestUserIdx = findLastIdx(messages, m => m.role === 'user')
		const lastClearing = findLast(messages, m => m.role === 'context_cleared')
		const alreadyClearedBefore = lastClearing?.role === 'context_cleared' ? lastClearing.keepFromIdx : 0
		if (latestUserIdx <= alreadyClearedBefore) return false
		if (!messages.slice(alreadyClearedBefore, latestUserIdx).some(m => m.role === 'tool')) return false

		this._addMessageToThread(threadId, { role: 'context_cleared', keepFromIdx: latestUserIdx })
		return true
	}

	// the keepFromIdx of the latest summary tried per thread, so a summary that failed isn't retried on every request
	private readonly _summaryTriedAt = new Map<string, number>()

	// The thread still doesn't fit after clearing old tool results: have the chat model summarize its older messages
	// (ContextSummaryEntry). Returns false if there was nothing new to summarize, or the summary failed or was stopped.
	private async _summarizeOlderMessages(threadId: string, { modelSelection, modelSelectionOptions, overridesOfModel, onInterrupt }: {
		modelSelection: ModelSelection, modelSelectionOptions: ModelSelectionOptions | undefined, overridesOfModel: OverridesOfModel, onInterrupt: () => void,
	}): Promise<boolean> {
		const messages = this.state.allThreads[threadId]?.messages
		if (!messages) return false

		const lastSummary = findLast(messages, m => m.role === 'context_summary')
		const previousSummary = lastSummary?.role === 'context_summary' ? lastSummary : undefined
		const summarizedBefore = previousSummary?.keepFromIdx ?? 0
		const keepFromIdx = chooseSummaryKeepIdx(messages, summarizedBefore)
		if (keepFromIdx === null || (this._summaryTriedAt.get(threadId) ?? -1) >= keepFromIdx) return false
		this._summaryTriedAt.set(threadId, keepFromIdx)

		// the transcript takes up to half the window (~3 characters per token)
		const { contextWindow } = getModelCapabilities(modelSelection.providerName, modelSelection.modelName, overridesOfModel)
		const maxChars = Math.max(8_000, Math.floor((contextWindow - 8_000) * 0.5 * 3))
		const transcript = transcriptForSummary(messages.slice(summarizedBefore, keepFromIdx), { previousSummary: previousSummary?.summary, maxChars })
		const { messages: llmMessages, separateSystemMessage } = this._convertToLLMMessagesService.prepareLLMSimpleMessages({
			simpleMessages: [{ role: 'user', content: summarizeThread_userMessage(transcript) }],
			systemMessage: summarizeThread_systemMessage,
			modelSelection,
			featureName: 'Chat',
		})

		const summary = await new Promise<string | null>(resolve => {
			const requestId = this._llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: llmMessages,
				separateSystemMessage,
				chatMode: null,
				modelSelection,
				modelSelectionOptions,
				overridesOfModel,
				logging: { loggingName: 'Chat - Summarize thread', loggingExtras: { threadId } },
				onText: () => { },
				onFinalMessage: ({ fullText }) => resolve(fullText.trim() || null),
				onError: (e) => { console.error('Error summarizing the thread:', e.message); resolve(null) },
				onAbort: () => resolve(null),
			})
			if (!requestId) return resolve(null)
			// stopping the chat stops the summary too
			this._setStreamState(threadId, { isRunning: 'idle', interrupt: Promise.resolve(() => { onInterrupt(); this._llmMessageService.abort(requestId) }) })
		})
		if (!summary) return false

		this._addMessageToThread(threadId, { role: 'context_summary', summary, keepFromIdx })
		return true
	}

	// every tool still marked running — several when a turn's calls run in parallel
	private _rejectRunningTools(threadId: string, content: string = this.toolErrMsgs.interrupted) {
		const messages = this.state.allThreads[threadId]?.messages ?? [] // snapshot: updates below replace the array, not mutate it
		// last first: _setState re-checks whether the *last* message is running (restart recovery), so
		// rejecting it first keeps that check from recursing back in here
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			const m = messages[i]
			if (m.role !== 'tool' || m.type !== 'running_now') continue
			this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', name: m.name, params: m.params, id: m.id, content, rawParams: m.rawParams, result: null, mcpServerName: m.mcpServerName })
		}
	}

	private _computeMCPServerOfToolName = (toolName: string) => {
		return this._mcpService.getMCPTools()?.find(t => t.name === toolName)?.mcpServerName
	}

	async abortRunning(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		// add assistant message
		if (this.streamState[threadId]?.isRunning === 'LLM') {
			const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId].llmInfo
			this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null })
			if (toolCallSoFar) this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) })
		}
		// reject the tools that are running
		else if (this.streamState[threadId]?.isRunning === 'tool') {
			this._rejectRunningTools(threadId)
		}
		// reject the tool for the user if relevant
		else if (this.streamState[threadId]?.isRunning === 'awaiting_user') {
			this.rejectLatestToolRequest(threadId)
		}
		else if (this.streamState[threadId]?.isRunning === 'idle') {
			// do nothing
		}

		this._addUserCheckpoint({ threadId })

		// interrupt any effects
		const interrupt = await this.streamState[threadId]?.interrupt
		if (typeof interrupt === 'function')
			interrupt()


		this._setStreamState(threadId, undefined)
	}



	private readonly toolErrMsgs = {
		rejected: 'Tool call was rejected by the user.',
		interrupted: 'Tool call was interrupted by the user.',
		interruptedByShutdown: 'Tool call was interrupted because Kodia stopped (it was closed, restarted or crashed) while the tool ran; it may not have finished. Check what it changed before relying on it, or run it again.',
		errWhenStringifying: (error: any) => `Tool call succeeded, but there was an error stringifying the output.\n${getErrorMessage(error)}`
	}


	// private readonly _currentlyRunningToolInterruptor: { [threadId: string]: (() => void) | undefined } = {}


	// Runs the calls of one LLM turn, in order. Consecutive read-only builtin tools run in parallel.
	// Edits, terminal commands and MCP tools run one at a time; when one of them needs approval the turn
	// stops there and the calls after it are dropped — they never reach the history, so the model only
	// sees the calls that ran and can make the others again.
	private async _runToolCallsOfTurn(threadId: string, toolCalls: RawToolCallObj[]): Promise<{ awaitingUserApproval?: boolean, interrupted?: boolean }> {
		const isParallelSafe = (toolName: ToolName) => isABuiltinToolName(toolName) && !(toolName in approvalTypeOfBuiltinToolName)
		const runOne = (c: RawToolCallObj, parallel?: ParallelToolRun) =>
			this._runToolCall(threadId, c.name, c.id, this._computeMCPServerOfToolName(c.name), { preapproved: false, unvalidatedToolParams: c.rawParams }, parallel)

		let i = 0
		while (i < toolCalls.length) {
			// abortRunning clears the stream state; if the user stopped between two calls, don't start the next
			if (this.streamState[threadId]?.isRunning === undefined) return { interrupted: true }

			const batch: RawToolCallObj[] = []
			while (i < toolCalls.length && isParallelSafe(toolCalls[i].name)) batch.push(toolCalls[i++])

			if (batch.length === 0) {
				const res = await runOne(toolCalls[i++])
				if (res.interrupted || res.awaitingUserApproval) return res
			}
			else if (batch.length === 1) {
				const res = await runOne(batch[0])
				if (res.interrupted) return res
			}
			else {
				const interruptors: Promise<() => void>[] = []
				const runs = batch.map(c => runOne(c, { onInterruptor: p => { interruptors.push(p) } }))
				// interrupting waits for every call's interruptor, like a single call's does
				this._setStreamState(threadId, { isRunning: 'tool', interrupt: Promise.all(interruptors).then(fns => () => { for (const f of fns) f() }) })
				const results = await Promise.all(runs)
				if (results.some(r => r.interrupted)) return { interrupted: true }
			}
		}
		return {}
	}

	// returns true when the tool call is waiting for user approval
	private _runToolCall = async (
		threadId: string,
		toolName: ToolName,
		toolId: string,
		mcpServerName: string | undefined,
		opts: { preapproved: true, unvalidatedToolParams: RawToolParamsObj, validatedParams: ToolCallParams<ToolName> } | { preapproved: false, unvalidatedToolParams: RawToolParamsObj },
		parallel?: ParallelToolRun,
	): Promise<{ awaitingUserApproval?: boolean, interrupted?: boolean }> => {

		// compute these below
		let toolParams: ToolCallParams<ToolName>
		let toolResult: ToolResult<ToolName>
		let toolResultStr: string

		// Check if it's a built-in tool
		const isBuiltInTool = isABuiltinToolName(toolName)


		if (!opts.preapproved) { // skip this if pre-approved
			// 1. validate tool params
			try {
				if (isBuiltInTool) {
					const params = this._toolsService.validateParams[toolName](opts.unvalidatedToolParams)
					toolParams = params
				}
				else {
					toolParams = opts.unvalidatedToolParams
				}
			}
			catch (error) {
				const errorMessage = getErrorMessage(error)
				this._addMessageToThread(threadId, { role: 'tool', type: 'invalid_params', rawParams: opts.unvalidatedToolParams, result: null, name: toolName, content: errorMessage, id: toolId, mcpServerName })
				return {}
			}
		}
		else {
			toolParams = opts.validatedParams
		}

		// Subagents: a tool outside the subagent's type is refused (offering only its tools is not enough: a model
		// can name any tool), and a file another subagent running in parallel is changing is left to that agent.
		const subagentRefusal = this._subagentRefusal(threadId, toolName, toolParams)
		if (subagentRefusal) {
			this._addMessageToThread(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: subagentRefusal, name: toolName, content: subagentRefusal, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			return {}
		}

		// 2. Centralized autonomy decision. Replaces the previous
		//    workspace-containment gate and the ad-hoc autoApprove check.
		//    Runs for every call (including pre-approved ones) so explicit
		//    block policies are always respected. Access outside the
		//    workspace is NOT, by itself, grounds for approval or denial;
		//    only operation risk and mode drive the decision. Applies to
		//    builtin tools and MCP tools alike.
		const targetUri = isBuiltInTool && isFileAccessTool(toolName)
			? getFileToolUri(toolName, toolParams)
			: null;
		const isOutside = isPathOutsideWorkspace(targetUri, this._workspaceContextService.getWorkspace().folders);
		const mode = this._settingsService.state.globalSettings.agentAutonomyMode as AutonomyMode;
		const evaluation = evaluateAutonomy({
			mode,
			autoApprove: this._settingsService.state.globalSettings.autoApprove,
			operationPolicy: this._settingsService.state.globalSettings.autonomyOperationPolicy,
			toolName,
			params: toolParams,
			isOutsideWorkspace: isOutside,
		});
		if (evaluation.decision === 'block') {
			this._addMessageToThread(threadId, {
				role: 'tool',
				type: 'tool_error',
				params: toolParams,
				result: `Blocked by autonomy policy (${mode} mode): ${evaluation.reason}`,
				name: toolName,
				content: `Blocked by autonomy policy: ${evaluation.reason}`,
				id: toolId,
				rawParams: opts.unvalidatedToolParams,
				mcpServerName,
			});
			return {};
		}

		if (evaluation.decision === 'requireApproval' && !opts.preapproved) {
			// Pre-approved calls have already been user-approved; only
			// explicit block policies can stop them at this point.
			this._addMessageToThread(threadId, {
				role: 'tool',
				type: 'tool_request',
				content: `(Awaiting user permission to ${toolName}: ${evaluation.reason})`,
				result: null,
				name: toolName,
				params: toolParams,
				id: toolId,
				rawParams: opts.unvalidatedToolParams,
				mcpServerName,
			});
			return { awaitingUserApproval: true };
		}




		// Task plan tools are handled directly (they need thread context for the plan service)
		const taskPlanTools: Set<string> = new Set(['create_task_plan', 'update_task_plan', 'get_task_plan']);
		if (isBuiltInTool && taskPlanTools.has(toolName)) {
			const params = toolParams as any;
			let toolResult: any;
			let toolError: string | null = null;
			try {
				if (toolName === 'create_task_plan') {
					const plan = this.taskPlanService.createPlan(threadId, params.title, params.description, params.tasks);
					this._setThreadTaskPlan(threadId, plan);
					toolResult = { plan };
				} else if (toolName === 'update_task_plan') {
					const plan = this.taskPlanService.updateTask(threadId, params.taskId, params.status, params.result, params.error);
					if (!plan) {
						toolError = 'No task plan found for thread ' + threadId + '. Create one first with create_task_plan.';
					} else {
						this._setThreadTaskPlan(threadId, plan);
						toolResult = { plan };
					}
				} else if (toolName === 'get_task_plan') {
					const plan = this.taskPlanService.getPlan(threadId);
					if (!plan) {
						toolError = 'No task plan found for thread ' + threadId + '. Create one first with create_task_plan.';
					} else {
						toolResult = { plan };
					}
				}
			} catch (error) {
				toolError = getErrorMessage(error);
			}

			const runningTool = { role: 'tool', type: 'running_now', name: toolName, params: toolParams, content: '(value not received yet...)', result: null, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName } as const
			this._updateLatestTool(threadId, runningTool)

			if (toolError) {
				this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: toolError, name: toolName, content: toolError, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
				return {};
			}

			const planObj = this.taskPlanService.getPlan(threadId);
			const toolResultStr = planObj ? formatTaskPlanForLLM(planObj) : '';
			this._updateLatestTool(threadId, { role: 'tool', type: 'success', params: toolParams, result: toolResult, name: toolName, content: toolResultStr, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			return {};
		}

		// Subagent delegation (roadmap 6): runs the child agent to completion and returns its report
		if (isBuiltInTool && toolName === SUBAGENT_TOOL_NAME) {
			return this._runSubagent(threadId, toolId, toolParams as BuiltinToolCallParams['subagent'], opts.unvalidatedToolParams, mcpServerName, parallel)
		}

		// Test-integrity guard: remember a test file's content before a change, to detect weakening afterwards
		const testFileUri = isBuiltInTool ? this._testFileChangedBy(toolName, toolParams) : null
		const testFileBefore = testFileUri ? await this._readTextIfExists(testFileUri) : undefined

		// Recovery: what this call is about to change, as it is on disk now (a checkpoint the user can rewind to)
		// (awaits only for file-changing tools: read-only tools of a parallel batch must reach onInterruptor below
		// without awaiting anything, or the batch could not be interrupted)
		const changedPaths = isBuiltInTool && FILE_CHANGING_TOOLS.has(toolName) ? await this._pathsChangedBy(toolName, toolParams) : []
		if (changedPaths.length > 0) await this._addFileChangeCheckpoint(threadId, changedPaths)

		// 3. call the tool
		// this._setStreamState(threadId, { isRunning: 'tool' }, 'merge')
		const runningTool = { role: 'tool', type: 'running_now', name: toolName, params: toolParams, content: '(value not received yet...)', result: null, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName } as const
		this._updateLatestTool(threadId, runningTool)


		let interrupted = false
		let resolveInterruptor: (r: () => void) => void = () => { }
		const interruptorPromise = new Promise<() => void>(res => { resolveInterruptor = res })
		parallel?.onInterruptor(interruptorPromise) // synchronous, so the caller has every interruptor before its first await
		try {

			// set stream state
			if (!parallel) this._setStreamState(threadId, { isRunning: 'tool', interrupt: interruptorPromise, toolInfo: { toolName, toolParams, id: toolId, content: 'interrupted...', rawParams: opts.unvalidatedToolParams, mcpServerName } })
			void this._flushThreads() // a tool can run for minutes: the conversation up to it must survive a crash meanwhile

			if (isBuiltInTool) {
				const toolCallPromise = this._toolsService.callTool[toolName](toolParams as any)
				// Terminal commands (composer, npm, migrations, seeders, etc.) can run for many
				// minutes. Give them a generous timeout so they finish and return output instead
				// of being killed mid-run. The terminal service itself has its own inactivity
				// guard (MAX_TERMINAL_INACTIVE_TIME) so runaway commands are still bounded.
				const TOOL_TIMEOUT_MS = 10 * 60_000 // 10 minutes
				let toolTimer: ReturnType<typeof setTimeout> | undefined
				const toolTimeout = new Promise<never>((_, reject) => {
					toolTimer = setTimeout(() => reject(new Error(`Tool call '${toolName}' timed out after ${TOOL_TIMEOUT_MS / 1000} seconds`)), TOOL_TIMEOUT_MS)
				})
				let toolResultObj: Awaited<typeof toolCallPromise>
				try { toolResultObj = await Promise.race([toolCallPromise, toolTimeout]) }
				finally { clearTimeout(toolTimer) } // don't keep a 10-minute timer alive per tool call
				const interruptor = () => { interrupted = true; toolResultObj.interruptTool?.() }
				resolveInterruptor(interruptor)

				toolResult = await toolResultObj.result
			}
			else {
				const mcpTools = this._mcpService.getMCPTools()
				const mcpTool = mcpTools?.find(t => t.name === toolName)
				if (!mcpTool) { throw new Error(`MCP tool ${toolName} not found`) }

				// MCP calls can't be cancelled, but mark them interrupted so an aborted call neither
				// overwrites its 'rejected' message nor lets the agent loop continue when it returns
				resolveInterruptor(() => { interrupted = true })

				toolResult = (await Promise.race([
					this._mcpService.callMCPTool({
						serverName: mcpTool.mcpServerName ?? 'unknown_mcp_server',
						toolName: toolName,
						params: toolParams
					}),
					new Promise<never>((_, reject) => {
						setTimeout(() => reject(new Error(`MCP tool '${toolName}' timed out after 60 seconds`)), 60000)
					})
				])).result
			}

			if (interrupted) { return { interrupted: true } } // the tool result is added where we interrupt, not here
		}
		catch (error) {
			resolveInterruptor(() => { }) // resolve for the sake of it
			if (interrupted) { return { interrupted: true } } // the tool result is added where we interrupt, not here

			const errorMessage = getErrorMessage(error)
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			if (changedPaths.length > 0) { // a failed change may still have changed something
				await this._addFileChangeCheckpoint(threadId, changedPaths)
				await this._flushThreads()
			}
			return {}
		}

		// 4. stringify the result to give to the LLM
		try {
			if (isBuiltInTool) {
				toolResultStr = this._toolsService.stringOfResult[toolName](toolParams as any, toolResult as any)
			}
			// For MCP tools, handle the result based on its type
			else {
				toolResultStr = this._mcpService.stringifyResult(toolResult as RawMCPToolCall)
			}

			// OpenCode tool-output adaptation: truncate very large results so they don't
			// fill the context window, saving the full output to a retained file.
			const truncated = await this._toolOutputService.truncateAsync(toolResultStr)
			toolResultStr = truncated.text
			if (truncated.outputPath) {
				toolResultStr += `\n\n[Full output (${truncated.text.length} chars shown) saved to: ${truncated.outputPath}]`
			}
		} catch (error) {
			const errorMessage = this.toolErrMsgs.errWhenStringifying(error)
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			return {}
		}

		// the change weakened a test file (fewer tests/assertions, framework removed, skipped, deleted): say so to the model
		if (testFileUri) {
			const testFileAfter = await this._readTextIfExists(testFileUri)
			const displayPath = this._workspaceRelativePath(testFileUri)
			const reasons = testWeakeningReasons(testFileUri.fsPath, testFileBefore, testFileAfter)
			if (reasons.length > 0) toolResultStr += `\n\n${testWeakeningNote(displayPath, reasons)}`
			else if (testFileWithoutTestCases(testFileUri.fsPath, testFileAfter)) toolResultStr += `\n\n${testFileWithoutTestCasesNote(displayPath)}`
		}

		// 5. add to history and keep going
		this._updateLatestTool(threadId, { role: 'tool', type: 'success', params: toolParams, result: toolResult, name: toolName, content: toolResultStr, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
		// ...and as it is after the change, so rewinding can be undone (jumping forward again); then on disk, so a
		// crash cannot leave changed files that the restored conversation does not know about
		if (changedPaths.length > 0) {
			await this._addFileChangeCheckpoint(threadId, changedPaths)
			await this._flushThreads()
		}

		// Update progress tracking for stuck detection
		this._updateProgressTracking(threadId, toolName, toolParams, toolResult as any)

		return {}
	};

	/** The test file a file-changing tool call will modify or delete, if any. */
	private _testFileChangedBy(toolName: ToolName, toolParams: ToolCallParams<ToolName>): URI | null {
		if (toolName !== 'write_file' && toolName !== 'rewrite_file' && toolName !== 'edit_file' && toolName !== 'delete_file_or_folder') return null
		const uri = (toolParams as { uri?: URI }).uri
		if (!uri) return null
		if (toolName === 'delete_file_or_folder' && (toolParams as BuiltinToolCallParams['delete_file_or_folder']).isFolder) return null
		return isTestFilePath(uri.fsPath) ? uri : null
	}

	private async _readTextIfExists(uri: URI): Promise<string | undefined> {
		try { return (await this._fileService.readFile(uri)).value.toString() }
		catch { return undefined }
	}

	private _workspaceRelativePath(uri: URI): string {
		const folder = this._workspaceContextService.getWorkspaceFolder(uri)
		return folder ? uri.fsPath.slice(folder.uri.fsPath.length).replace(/^[\\/]/, '') : uri.fsPath
	}

	// ---------- subagents (roadmap 6) ----------

	private _toolInfosOf(names: ReadonlySet<string>): InternalToolInfo[] {
		const mcpTools = this._mcpService.getMCPTools() ?? []
		const out: InternalToolInfo[] = []
		for (const name of names) {
			if (isABuiltinToolName(name)) { out.push(builtinTools[name]) }
			else { const t = mcpTools.find(m => m.name === name); if (t) { out.push(t) } }
		}
		return out
	}

	/** Why a subagent thread may not make this call, or undefined. Claims the file for the caller when it may. */
	private _subagentRefusal(threadId: string, toolName: ToolName, toolParams: ToolCallParams<ToolName>): string | undefined {
		const policy = this._toolPolicyOfThread.get(threadId)
		if (!policy) { return undefined }
		if (!policy.allowed.has(toolName)) {
			return toolName === SUBAGENT_TOOL_NAME
				? 'A subagent cannot start subagents. Do the work yourself, or finish and say what should be delegated, so the agent that started you can do it.'
				: `A "${policy.agent}" subagent cannot use ${toolName}: its tools are ${[...policy.allowed].sort().join(', ')}.`
		}
		// creating a folder is not claimed: folders are shared containers (seen live: two parallel subagents both
		// create src/ and test/, and the second one was refused), and creating one that exists changes nothing
		const createsFolder = toolName === 'create_file_or_folder' && (!!(toolParams as { isFolder?: boolean }).isFolder || !/\.[^\\/.]+$/.test((toolParams as { uri?: URI }).uri?.fsPath ?? ''))
		const uri = FILE_CHANGING_TOOLS.has(toolName) && !createsFolder ? (toolParams as { uri?: URI }).uri : undefined
		if (uri) {
			const owner = this._subagentFileClaims.claim(uri.fsPath, threadId)
			if (owner) {
				const desc = this.state.allThreads[owner]?.subagentOf?.description ?? owner
				return `${this._workspaceRelativePath(uri)} is being changed by another subagent running in parallel ("${desc}", session ${owner}), so this change was not made. Leave that file to it; if your task needs a change there, say so in your final reply.`
			}
		}
		return undefined
	}

	/** "provider/model" or a model name, among the models switched on in Settings; default: the parent's model. */
	private _resolveSubagentModel(parentId: string, requested: string | undefined): { modelSelection: ModelSelection | null; modelSelectionOptions: ModelSelectionOptions | undefined } | { error: string } {
		if (!requested) {
			const p = this._modelOfRunningThread.get(parentId)
			if (p) { return p }
			const { modelSelection, modelSelectionOptions } = this._currentModelSelectionProps(parentId)
			return { modelSelection, modelSelectionOptions }
		}
		const options = this._settingsService.state._modelOptions.map(o => o.selection)
		const wanted = requested.trim().toLowerCase()
		const matches = options.filter(s => `${s.providerName}/${s.modelName}`.toLowerCase() === wanted)
		const byName = matches.length ? matches : options.filter(s => s.modelName.toLowerCase() === wanted)
		if (byName.length !== 1) {
			const list = options.slice(0, 20).map(s => `${s.providerName}/${s.modelName}`).join(', ')
			return { error: byName.length > 1 ? `Model "${requested}" is ambiguous; use provider/model: ${byName.map(s => `${s.providerName}/${s.modelName}`).join(', ')}.` : `Model "${requested}" is not one of the models set up in Kodia: ${list || '(none)'}. Leave model out to use the current one.` }
		}
		const modelSelection = byName[0]
		return { modelSelection, modelSelectionOptions: this._settingsService.state.optionsOfModelSelection['Chat'][modelSelection.providerName]?.[modelSelection.modelName] }
	}

	/**
	 * Run a subagent to completion in its own thread and put its report in the parent's tool result. The report's
	 * facts (status, tool calls, files changed, errors) come from the child's thread, not from its reply.
	 */
	private async _runSubagent(parentId: string, toolId: string, params: BuiltinToolCallParams['subagent'], rawParams: RawToolParamsObj, mcpServerName: string | undefined, parallel?: ParallelToolRun): Promise<{ interrupted?: boolean }> {
		const name = SUBAGENT_TOOL_NAME
		const fail = (message: string) => {
			this._updateLatestTool(parentId, { role: 'tool', type: 'tool_error', params, result: message, name, content: message, id: toolId, rawParams, mcpServerName })
			return {}
		}
		// everything up to the interruptor is synchronous: a parallel batch collects every interruptor before awaiting
		if (this.state.allThreads[parentId]?.subagentOf) { return fail('A subagent cannot start subagents. Do the work yourself, or finish and say what should be delegated.') }
		const running = this._runningSubagentsOfParent.get(parentId) ?? new Set<string>()
		this._runningSubagentsOfParent.set(parentId, running)
		if (running.size >= MAX_PARALLEL_SUBAGENTS) { return fail(`At most ${MAX_PARALLEL_SUBAGENTS} subagents can run at the same time; ${running.size} are running. Wait for their reports.`) }
		const model = this._resolveSubagentModel(parentId, params.model)
		if ('error' in model) { return fail(model.error) }

		let childId: string
		let agent: SubagentType
		if (params.sessionID) {
			const existing = this.state.allThreads[params.sessionID]
			if (!existing?.subagentOf || existing.subagentOf.parentThreadId !== parentId) { return fail(`There is no subagent session "${params.sessionID}" started from this conversation.`) }
			if (running.has(existing.id) || this.streamState[existing.id]?.isRunning) {
				return fail(this.streamState[existing.id]?.isRunning === 'awaiting_user'
					? `Subagent session ${existing.id} is waiting for the user to approve a tool call in its thread; it cannot take a follow-up until then.`
					: `Subagent session ${existing.id} is still running.`)
			}
			childId = existing.id
			agent = existing.subagentOf.agent // the type it was started with
		} else {
			const resolved = resolveSubagentType(params.agent)
			if ('error' in resolved) { return fail(resolved.error) }
			agent = resolved.type
			// created directly: never reuse one of the user's empty threads, never switch the user's current thread
			const thread: ThreadType = { ...newThreadObject(), subagentOf: { parentThreadId: parentId, agent, description: params.description } }
			childId = thread.id
			const newThreads: ChatThreads = { ...this.state.allThreads, [childId]: thread }
			this._storeAllThreads(newThreads)
			this._setState({ allThreads: newThreads })
		}

		const offered = (availableTools(this._settingsService.state.globalSettings.chatMode, this._mcpService.getMCPTools()) ?? []).map(t => t.name)
		const allowed = new Set(subagentToolNames(agent, offered, n => !isABuiltinToolName(n) || n in approvalTypeOfBuiltinToolName))
		this._toolPolicyOfThread.set(childId, { agent, allowed })
		running.add(childId)

		this._updateLatestTool(parentId, { role: 'tool', type: 'running_now', name, params, content: `(subagent "${params.description}" is working...)`, result: null, id: toolId, rawParams, mcpServerName })
		let interrupted = false
		const interruptor = Promise.resolve(() => { interrupted = true; this.abortRunning(childId) })
		if (parallel) { parallel.onInterruptor(interruptor) }
		else { this._setStreamState(parentId, { isRunning: 'tool', interrupt: interruptor, toolInfo: { toolName: name, toolParams: params, id: toolId, content: 'interrupted...', rawParams, mcpServerName } }) }

		const startedAt = Date.now()
		const startIdx = this.state.allThreads[childId]?.messages.length ?? 0
		let timedOut = false
		let crash: string | undefined
		const timer = setTimeout(() => { timedOut = true; this.abortRunning(childId) }, SUBAGENT_TIMEOUT_MS)
		try {
			await this.addUserMessage({ userMessage: params.prompt, threadId: childId }) // awaited: the task must be in the thread before the first request
			await this._runChatAgent({ threadId: childId, ...model })
		} catch (e) {
			crash = getErrorMessage(e)
		} finally {
			clearTimeout(timer)
			running.delete(childId)
			this._subagentFileClaims.releaseAll(childId)
		}
		if (interrupted) { return { interrupted: true } } // the parent's abort marks this call interrupted

		const messages = this.state.allThreads[childId]?.messages.slice(startIdx) ?? []
		const facts: SubagentToolCallFact[] = []
		let awaitingApprovalOf: string | undefined
		for (const m of messages) {
			if (m.role !== 'tool') { continue }
			if (m.type === 'tool_request') { awaitingApprovalOf = `${m.name} — ${m.content}`; continue }
			if (m.type === 'running_now') { continue }
			const uri = m.type !== 'invalid_params' ? (m.params as { uri?: URI } | undefined)?.uri : undefined
			facts.push({ name: m.name, type: m.type, target: uri ? this._workspaceRelativePath(URI.revive(uri)) : undefined, error: m.type === 'success' ? undefined : m.content })
		}
		const lastReply = findLast(messages, m => m.role === 'assistant')
		const output = lastReply?.role === 'assistant' ? lastReply.displayContent : ''
		const streamError = this.streamState[childId]?.error?.message
		const status: SubagentStatus = timedOut ? 'timed_out'
			: crash || streamError ? 'failed'
				: this.streamState[childId]?.isRunning === 'awaiting_user' ? 'awaiting_approval'
					: /^Agent (turn reached its step limit|appears stuck)/.test(output) ? 'stopped'
						: 'completed'
		const summary = summarizeSubagentRun(facts, FILE_CHANGING_TOOLS)
		const report: SubagentReport = {
			sessionID: childId, agent, description: params.description, status, output, ...summary,
			problems: [...summary.problems, ...[crash, streamError].filter((e): e is string => !!e).map(e => `the subagent stopped with an error: ${e}`)],
			awaitingApprovalOf: status === 'awaiting_approval' ? awaitingApprovalOf : undefined,
			durationMs: Date.now() - startedAt,
		}
		const content = formatSubagentReport(report)
		this._updateLatestTool(parentId, { role: 'tool', type: status === 'failed' || status === 'timed_out' ? 'tool_error' : 'success', params, result: status === 'failed' || status === 'timed_out' ? content : report, name, content, id: toolId, rawParams, mcpServerName } as ChatMessage & { role: 'tool' })
		return {}
	}

	/** Update progress tracking based on tool result, used by stuck detection. */
	private _updateProgressTracking(threadId: string, toolName: ToolName, toolParams: ToolCallParams<ToolName>, toolResult: any): void {
		const progress = this._progress(threadId)
		progress.stepsSinceLastProgress = 0 // reset stuck counter on any progress

		// Track file touches
		if (isFileAccessTool(toolName)) {
			const uri = getFileToolUri(toolName, toolParams)
			if (uri) {
				progress.filesTouched.add(uri.fsPath)
			}
		}
		// Track terminal commands
		if (toolName === 'run_command' || toolName === 'run_persistent_command' || toolName === 'send_command_to_terminal') {
			const cmd = (toolParams as any).command || (toolParams as any).persistent_terminal_id
			if (cmd) progress.terminalCommands.add(String(cmd))
		}
		// Track test results
		if (toolName.startsWith('test_') && toolResult) {
			const results = (toolResult as any)?.results
			if (results) {
				progress.testResults.set(String(Date.now()), {
					passed: results.passed || 0,
					failed: results.failed || 0,
				})
			}
		}
	}




	private async _runChatAgent({
		threadId,
		modelSelection,
		modelSelectionOptions,
		callThisToolFirst,
		autoReason,
	}: {
		threadId: string,
		modelSelection: ModelSelection | null,
		modelSelectionOptions: ModelSelectionOptions | undefined,
		callThisToolFirst?: ToolMessage<ToolName> & { type: 'tool_request' },
		autoReason?: string
	}) {


		let interruptedWhenIdle = false
		const idleInterruptor = Promise.resolve(() => { interruptedWhenIdle = true })
		// _runToolCall does not need setStreamState({idle}) before it, but it needs it after it. (handles its own setStreamState)

		// above just defines helpers, below starts the actual function
		const { chatMode } = this._settingsService.state.globalSettings // should not change as we loop even if user changes it, so it goes here
		const { overridesOfModel } = this._settingsService.state
		const turnId = generateUuid()

		let nMessagesSent = 0
		let nudgedForUnfulfilledAction = false
		let requestedCompletionCheck = false
		// messages from here on belong to this turn; an approved tool's request message (updated in place) is the turn's first
		const nMessagesBeforeTurn = this.state.allThreads[threadId]?.messages.length ?? 0
		const turnStartIdx = callThisToolFirst ? Math.max(0, nMessagesBeforeTurn - 1) : nMessagesBeforeTurn
		let overflowRecoveries = 0
		let shouldSendAnotherMessage = true
		let isRunningWhenEnd: IsRunningType = undefined

		// Stuck detection: track progress across steps. If no file/terminal/test
		// progress for MAX_STUCK_STEPS steps, pause and alert the user.
		this._progressOfThread.delete(threadId)
		const progress = this._progress(threadId)
		// what a subagent started now inherits by default
		this._modelOfRunningThread.set(threadId, { modelSelection, modelSelectionOptions })
		// a subagent thread is offered only its type's tools (the policy is also enforced when a tool is called)
		const toolPolicy = this._toolPolicyOfThread.get(threadId)
		const policyTools: InternalToolInfo[] | undefined = toolPolicy ? this._toolInfosOf(toolPolicy.allowed) : undefined
		// a small-context model gets a prioritized subset of the tools when all of them would take over half its window
		const budgeted = modelSelection ? toolsWithinBudget(
			policyTools ?? availableTools(chatMode, this._mcpService.getMCPTools()) ?? [],
			getModelCapabilities(modelSelection.providerName, modelSelection.modelName, overridesOfModel).contextWindow,
			estimateTokens,
		) : undefined
		const explicitTools: InternalToolInfo[] | undefined = budgeted?.tools ?? policyTools
		const subagentOf = this.state.allThreads[threadId]?.subagentOf
		const promptNotes = [
			toolPolicy && subagentOf ? subagentRoleText(subagentOf.agent, subagentOf.description) : '',
			budgeted ? describeOmittedTools(budgeted.omitted) : '',
		].filter(Boolean).join('\n\n')
		const subagentPrompt = explicitTools ? { tools: explicitTools, role: promptNotes } : undefined

		// before enter loop, call tool
		if (callThisToolFirst) {
			const { interrupted } = await this._runToolCall(threadId, callThisToolFirst.name, callThisToolFirst.id, callThisToolFirst.mcpServerName, { preapproved: true, unvalidatedToolParams: callThisToolFirst.rawParams, validatedParams: callThisToolFirst.params })
			if (interrupted) {
				this._setStreamState(threadId, undefined)
				this._addUserCheckpoint({ threadId })

			}
		}
		this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })  // just decorative, for clarity


		// tool use loop
		while (shouldSendAnotherMessage) {
			// OpenCode-style max-steps: stop cleanly once the turn has used its
			// step budget, leaving a checkpoint so the user can resume.
			if (nMessagesSent >= MAX_AGENT_STEPS_PER_TURN) {
				this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })
				this._addMessageToThread(threadId, {
					role: 'assistant',
					displayContent: `Agent turn reached its step limit (${MAX_AGENT_STEPS_PER_TURN} LLM → tool steps). The work is paused at a checkpoint: send another message to resume, or break the request into smaller steps.`,
					reasoning: '',
					anthropicReasoning: null,
				})
				isRunningWhenEnd = undefined
				break
			}

			// Stuck detection: if no file/terminal/test progress for too many steps,
			// pause and report so the user can intervene or break the task down.
			if (progress.stepsSinceLastProgress >= MAX_STUCK_STEPS) {
				this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })
				const filesList = Array.from(progress.filesTouched).slice(0, 10).join(', ')
				const cmdsList = Array.from(progress.terminalCommands).slice(0, 5).join(', ')
				const msg = `Agent appears stuck: no file changes, terminal commands, or test results for ${MAX_STUCK_STEPS} consecutive steps. ` +
					`Progress so far: files touched [${filesList || 'none'}], commands run [${cmdsList || 'none'}]. ` +
					`Send another message to resume, or break the request into smaller steps.`
				this._addMessageToThread(threadId, {
					role: 'assistant',
					displayContent: msg,
					reasoning: '',
					anthropicReasoning: null,
				})
				isRunningWhenEnd = undefined
				break
			}

			// false by default each iteration
			shouldSendAnotherMessage = false
			isRunningWhenEnd = undefined
			nMessagesSent += 1

			this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })

			const prepare = () => this._convertToLLMMessagesService.prepareLLMChatMessages({
				chatMessages: this.state.allThreads[threadId]?.messages ?? [],
				modelSelection,
				chatMode,
				turnId, // the same system prompt for every request of this turn, so the prompt cache holds
				subagent: subagentPrompt,
			})
			let prepared = await prepare()
			// too long for the model: clear old tool results once, rather than truncating messages on every request
			if (prepared.wasStillOverBudgetAfterTrimming && this._clearOldToolResults(threadId)) prepared = await prepare()
			// still too long: summarize the older messages (when that fails, prepare's truncation is the fallback)
			if (prepared.wasStillOverBudgetAfterTrimming && modelSelection && !interruptedWhenIdle) {
				const summarized = await this._summarizeOlderMessages(threadId, { modelSelection, modelSelectionOptions, overridesOfModel, onInterrupt: () => { interruptedWhenIdle = true } })
				if (!interruptedWhenIdle) this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
				if (summarized && !interruptedWhenIdle) prepared = await prepare()
			}
			const { messages, separateSystemMessage, estimatedInputTokens } = prepared

			if (interruptedWhenIdle) {
				this._setStreamState(threadId, undefined)
				return
			}

			let shouldRetryLLM = true
			while (shouldRetryLLM) {
				type ResTypes =
					| { type: 'llmDone', toolCalls?: RawToolCallObj[], info: { fullText: string, fullReasoning: string, anthropicReasoning: AnthropicReasoning[] | null, usage?: LLMUsage, finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null } }
					| { type: 'llmError', error?: { message: string; fullError: Error | null; } }
					| { type: 'llmAborted' }

				let resMessageIsDonePromise: (res: ResTypes) => void // resolves when user approves this tool use (or if tool doesn't require approval)
				const messageIsDonePromise = new Promise<ResTypes>((res, rej) => { resMessageIsDonePromise = res })

				// Inactivity timeout: a long but healthy stream (e.g. a large write_file) must not be cut off, so the
				// clock restarts on every chunk. When it fires, the request is really aborted (not left running).
				let inactivityTimer: ReturnType<typeof setTimeout> | undefined
				let llmCancelToken: string | null = null
				const armInactivityTimer = () => {
					if (inactivityTimer) clearTimeout(inactivityTimer)
					inactivityTimer = setTimeout(() => {
						resMessageIsDonePromise({ type: 'llmError', error: { message: `The model sent no output for ${LLM_INACTIVITY_TIMEOUT_MS / 1000} seconds. It may be overloaded. Try again or break your request into smaller steps.`, fullError: null } })
						if (llmCancelToken) this._llmMessageService.abort(llmCancelToken)
					}, LLM_INACTIVITY_TIMEOUT_MS)
				}

				llmCancelToken = this._llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					chatMode,
					messages: messages,
					promptCacheKey: threadId, // every request of the agent loop resends the thread's prefix
					tools: explicitTools,
					promptCacheTTL: this._settingsService.state.globalSettings.oneHourPromptCache ? '1h' : undefined,
					modelSelection,
					modelSelectionOptions,
					overridesOfModel,
					logging: { loggingName: `Chat - ${chatMode}`, loggingExtras: { threadId, nMessagesSent, chatMode } },
					separateSystemMessage: separateSystemMessage,
					onText: ({ fullText, fullReasoning, toolCall }) => {
						armInactivityTimer() // the stream is alive
						this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: fullText, reasoningSoFar: fullReasoning, toolCallSoFar: toolCall ?? null }, interrupt: Promise.resolve(() => { if (llmCancelToken) this._llmMessageService.abort(llmCancelToken) }) })
					},
					onFinalMessage: async ({ fullText, fullReasoning, toolCalls, anthropicReasoning, usage, finishReason }) => {
						if (usage && modelSelection) this._convertToLLMMessagesService.recordInputTokens(modelSelection, estimatedInputTokens, usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0))
						// finishReason must be passed on: the output-limit continuation below depends on it
						resMessageIsDonePromise({ type: 'llmDone', toolCalls, info: { fullText, fullReasoning, anthropicReasoning, usage, finishReason } }) // resolve with tool calls
					},
					onError: async (error) => {
						resMessageIsDonePromise({ type: 'llmError', error: error })
					},
					onAbort: () => {
						// stop the loop to free up the promise, but don't modify state (already handled by whatever stopped it)
						resMessageIsDonePromise({ type: 'llmAborted' })
						this._metricsService.capture('Agent Loop Done (Aborted)', { nMessagesSent, chatMode })
					},
				})

				// mark as streaming
				if (!llmCancelToken) {
					this._setStreamState(threadId, { isRunning: undefined, error: { message: 'There was an unexpected error when sending your chat message.', fullError: null } })
					break
				}

				const cancelToken = llmCancelToken
				this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: '', reasoningSoFar: '', toolCallSoFar: null }, interrupt: Promise.resolve(() => this._llmMessageService.abort(cancelToken)) })
				armInactivityTimer() // so the agent doesn't hang forever if the model never responds
				const llmRes = await messageIsDonePromise
				if (inactivityTimer) clearTimeout(inactivityTimer)

				// if something else started running in the meantime
				if (this.streamState[threadId]?.isRunning !== 'LLM') {
					// console.log('Chat thread interrupted by a newer chat thread', this.streamState[threadId]?.isRunning)
					return
				}

				// llm res aborted
				if (llmRes.type === 'llmAborted') {
					this._setStreamState(threadId, undefined)
					return
				}
				// llm res error
				else if (llmRes.type === 'llmError') {
					const { error } = llmRes
					if (!error) {
						const { displayContentSoFar, reasoningSoFar } = this.streamState[threadId].llmInfo
						this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null })
						this._setStreamState(threadId, { isRunning: undefined, error: { message: 'LLM error', fullError: null } })
						this._addUserCheckpoint({ threadId })
						return
					}
					// The request was longer than the model's real context window (common when the window was only
					// guessed for an unrecognized model): learn the limit, rebuild the request under it, and retry.
					const errorText = `${error.message ?? ''} ${error.fullError?.message ?? ''}`
					const isOverflow = !!modelSelection && isContextOverflowError(errorText)
					if (modelSelection && isOverflow && overflowRecoveries < MAX_CONTEXT_OVERFLOW_RECOVERIES_PER_TURN) {
						overflowRecoveries += 1
						this._convertToLLMMessagesService.recordContextOverflow(modelSelection, contextLimitFromError(errorText))
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
						shouldRetryLLM = false
						shouldSendAnotherMessage = true // the outer loop prepares the messages again, now under the learned budget
						continue
					}
					const fullError = error.fullError
					const errInfo = createRetryErrorInfo({
						name: fullError?.name,
						message: fullError?.message,
						code: (fullError as any)?.code ?? null,
						status: (fullError as any)?.status ?? null,
						headers: (fullError as any)?.headers ?? null,
					})
					// resending a request the provider already rejected as too long cannot succeed: never back off and retry it
					const decision = isOverflow ? { retry: false, delayMs: 0 } : this._retryPolicy(threadId).decide(errInfo, true)
					if (decision.retry) {
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
						await timeout(decision.delayMs)
						if (interruptedWhenIdle) {
							this._setStreamState(threadId, undefined)
							return
						}
						continue // retry with exponential backoff
					}
					// retry policy says stop
					const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId].llmInfo
					this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null })
					if (toolCallSoFar) this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) })

					const shownError = isOverflow
						? { ...error, message: `${error.message}\n\nThe conversation is longer than this model's context window, and Kodia already reduced the request ${overflowRecoveries} time(s). Set this model's context window in Settings → Models, or start a new chat.` }
						: error
					this._setStreamState(threadId, { isRunning: undefined, error: shownError })
					this._addUserCheckpoint({ threadId })
					return
				}

				// llm res success - reset retry policy for the next turn
				this._retryPolicy(threadId).reset()
				shouldRetryLLM = false
				const { toolCalls, info } = llmRes

				this._addMessageToThread(threadId, { role: 'assistant', displayContent: info.fullText, reasoning: info.fullReasoning, anthropicReasoning: info.anthropicReasoning, modelSelection: modelSelection ?? undefined, usage: info.usage })

				// OpenCode-style output-limit continuation: when the model hit its output token limit
				// mid-response (finishReason === 'length') and made no tool calls, inject a synthetic
				// "continue" user message so the agent can finish its work instead of abandoning it.
				if (info.finishReason === 'length' && (!toolCalls || toolCalls.length === 0)) {
					this._addMessageToThread(threadId, {
						role: 'user',
						displayContent: `Your previous reply was cut off by the output token limit. Continuing...`,
						content: `Your previous reply was cut off by the output token limit. Continue from where you left off. Do not apologize, recap, or repeat yourself—just complete the remaining work.`,
						selections: null,
						state: { stagingSelections: [], isBeingEdited: false },
					})
					shouldSendAnotherMessage = true
					this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })
					continue
				}

				this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative for clarity

				// Weak-model guard: the reply announces actions but calls no tool, so nothing ran. Say so to the
				// model once per turn (visibly, as a message in the thread) instead of ending as if work was done.
				if ((!toolCalls || toolCalls.length === 0) && chatMode === 'agent' && !nudgedForUnfulfilledAction && looksLikeUnfulfilledAction(info.fullText)) {
					nudgedForUnfulfilledAction = true
					this._addMessageToThread(threadId, {
						role: 'user',
						displayContent: UNFULFILLED_ACTION_NUDGE,
						content: UNFULFILLED_ACTION_NUDGE,
						selections: null,
						state: { stagingSelections: [], isBeingEdited: false },
					})
					shouldSendAnotherMessage = true
					continue
				}

				// Evidence-based completion: the model is about to finish a turn in which it changed files. Ask it once
				// (visibly) to verify against the request — read the files, run the tests/build — and fix what fails.
				if ((!toolCalls || toolCalls.length === 0) && this._settingsService.state.globalSettings.verifyBeforeFinishing !== false && shouldRequestCompletionCheck({
					chatMode,
					alreadyRequested: requestedCompletionCheck,
					messagesThisTurn: (this.state.allThreads[threadId]?.messages ?? []).slice(turnStartIdx),
				})) {
					requestedCompletionCheck = true
					this._addMessageToThread(threadId, {
						role: 'user',
						displayContent: COMPLETION_CHECK_REQUEST,
						content: COMPLETION_CHECK_REQUEST,
						selections: null,
						state: { stagingSelections: [], isBeingEdited: false },
					})
					shouldSendAnotherMessage = true
					continue
				}

				// call the tools if there are any
				if (toolCalls && toolCalls.length > 0) {
					const { awaitingUserApproval, interrupted } = await this._runToolCallsOfTurn(threadId, toolCalls)
					if (interrupted) {
						this._setStreamState(threadId, undefined)
						return
					}
					if (awaitingUserApproval) { isRunningWhenEnd = 'awaiting_user' }
					else { 
						shouldSendAnotherMessage = true 
						// Increment stuck counter - _updateProgressTracking resets to 0 when progress is made
						progress.stepsSinceLastProgress++
					}

					this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative, for clarity
				}

			} // end while (attempts)
		} // end while (send message)

		// if awaiting user approval, keep isRunning true, else end isRunning
		this._setStreamState(threadId, { isRunning: isRunningWhenEnd })

		// add checkpoint before the next user message
		if (!isRunningWhenEnd) this._addUserCheckpoint({ threadId })

		// capture number of messages sent
		this._metricsService.capture('Agent Loop Done', { nMessagesSent, chatMode })
	}


	private _addCheckpoint(threadId: string, checkpoint: CheckpointEntry) {
		this._addMessageToThread(threadId, checkpoint)
		this._pruneOldSnapshots(threadId) // every kind of checkpoint holds file contents
		// // update latest checkpoint idx to the one we just added
		// const newThread = this.state.allThreads[threadId]
		// if (!newThread) return // should never happen
		// const currCheckpointIdx = newThread.messages.length - 1
		// this._setThreadState(threadId, { currCheckpointIdx: currCheckpointIdx })
	}



	private _editMessageInThread(threadId: string, messageIdx: number, newMessage: ChatMessage,) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		// update state and store it
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages.slice(0, messageIdx),
					newMessage,
					...oldThread.messages.slice(messageIdx + 1, Infinity),
				],
			}
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads }) // the current thread just changed (it had a message added to it)
	}


	private _getCheckpointInfo = (checkpointMessage: ChatMessage & { role: 'checkpoint' }, fsPath: string, opts: { includeUserModifiedChanges: boolean }) => {
		const voidFileSnapshot = checkpointMessage.voidFileSnapshotOfURI ? checkpointMessage.voidFileSnapshotOfURI[fsPath] ?? null : null
		if (!opts.includeUserModifiedChanges) { return { voidFileSnapshot, } }

		const userModifiedVoidFileSnapshot = fsPath in checkpointMessage.userModifications.voidFileSnapshotOfURI ? checkpointMessage.userModifications.voidFileSnapshotOfURI[fsPath] ?? null : null
		return { voidFileSnapshot: userModifiedVoidFileSnapshot ?? voidFileSnapshot, }
	}

	private _computeNewCheckpointInfo({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const lastCheckpointIdx = findLastIdx(thread.messages, (m) => m.role === 'checkpoint') ?? -1
		if (lastCheckpointIdx === -1) return

		const voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined } = {}

		// add a change for all the URIs in the checkpoint history
		const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: 0, hiIdx: lastCheckpointIdx, }) ?? {}
		for (const fsPath in lastIdxOfURI ?? {}) {
			const { model } = this._voidModelService.getModelFromFsPath(fsPath)
			if (!model) continue
			const checkpoint2 = thread.messages[lastIdxOfURI[fsPath]] || null
			if (!checkpoint2) continue
			if (checkpoint2.role !== 'checkpoint') continue
			const res = this._getCheckpointInfo(checkpoint2, fsPath, { includeUserModifiedChanges: false })
			if (!res) continue
			const { voidFileSnapshot: oldVoidFileSnapshot } = res

			// if there was any change to the str or diffAreaSnapshot, update. rough approximation of equality, oldDiffAreasSnapshot === diffAreasSnapshot is not perfect
			const voidFileSnapshot = this._editCodeService.getVoidFileSnapshot(URI.file(fsPath))
			if (oldVoidFileSnapshot === voidFileSnapshot) continue
			voidFileSnapshotOfURI[fsPath] = voidFileSnapshot
		}


		return { voidFileSnapshotOfURI }
	}


	private _addUserCheckpoint({ threadId }: { threadId: string }) {
		const { voidFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {}
		this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'user_edit',
			voidFileSnapshotOfURI: voidFileSnapshotOfURI ?? {},
			userModifications: { voidFileSnapshotOfURI: {}, },
		})
	}
	// ---------- recovery: file-change checkpoints (roadmap 8) ----------
	// Was: only edit_file/rewrite_file were checkpointed, and only when the file happened to be open in an editor
	// (no model → no checkpoint), so rewinding an agent's turn restored nothing it wrote, created or deleted.

	/** every path a file-changing tool call may change: its target, and for a deleted folder everything inside it */
	private async _pathsChangedBy(toolName: ToolName, toolParams: ToolCallParams<ToolName>): Promise<URI[]> {
		if (!FILE_CHANGING_TOOLS.has(toolName)) return []
		const uri = (toolParams as { uri?: URI }).uri
		if (!uri) return []
		if (toolName !== 'delete_file_or_folder') return [uri]
		const out: URI[] = []
		const visit = async (u: URI) => {
			if (out.length >= MAX_SNAPSHOT_FILES_PER_CHANGE) return
			out.push(u)
			let children: { resource: URI }[] | undefined
			try { children = (await this._fileService.resolve(u)).children } catch { return }
			for (const c of children ?? []) { await visit(c.resource) }
		}
		await visit(uri)
		return out
	}

	/** a path as it is now: its content (and Kodia's diff areas when it is open), a folder, or nothing */
	private async _snapshotOfPath(uri: URI): Promise<VoidFileSnapshot | undefined> {
		let stat
		try { stat = await this._fileService.stat(uri) }
		catch { return { snapshottedDiffAreaOfId: {}, entireFileCode: '', absent: true } }
		if (stat.isDirectory) return { snapshottedDiffAreaOfId: {}, entireFileCode: '', isFolder: true }
		if (stat.size > MAX_SNAPSHOT_FILE_BYTES) return undefined // not kept in the thread; this file cannot be rewound
		if (this._voidModelService.getModel(uri).model) return this._editCodeService.getVoidFileSnapshot(uri)
		try { return { snapshottedDiffAreaOfId: {}, entireFileCode: (await this._fileService.readFile(uri)).value.toString() } }
		catch { return undefined }
	}

	private async _addFileChangeCheckpoint(threadId: string, uris: URI[]) {
		if (uris.length === 0) return
		const voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined } = {}
		for (const uri of uris) {
			const s = await this._snapshotOfPath(uri)
			if (s) voidFileSnapshotOfURI[uri.fsPath] = s
		}
		this._addCheckpoint(threadId, { role: 'checkpoint', type: 'tool_edit', voidFileSnapshotOfURI, userModifications: { voidFileSnapshotOfURI: {} } })
	}

	// Every snapshot is kept in the saved conversation, and every save serializes all conversations: without a bound,
	// a long session over big files grows without limit. Newest first, snapshot contents are kept up to this many
	// characters per conversation; older ones are dropped (marked pruned) and rewinding that far says so.
	private _maxSnapshotCharsPerThread = MAX_SNAPSHOT_CHARS_PER_THREAD
	private _pruneOldSnapshots(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		let kept = 0
		let changed = false
		const messages = [...thread.messages]
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i]
			if (m.role !== 'checkpoint') continue
			const prune = (snaps: { [fsPath: string]: VoidFileSnapshot | undefined }) => {
				let out: typeof snaps | undefined
				for (const [fsPath, s] of Object.entries(snaps)) {
					if (!s || s.pruned || s.absent || s.isFolder) continue
					kept += s.entireFileCode.length
					if (kept > this._maxSnapshotCharsPerThread) {
						out ??= { ...snaps }
						out[fsPath] = { snapshottedDiffAreaOfId: {}, entireFileCode: '', pruned: true }
					}
				}
				return out
			}
			const own = prune(m.voidFileSnapshotOfURI)
			const user = prune(m.userModifications.voidFileSnapshotOfURI)
			if (own || user) {
				messages[i] = { ...m, voidFileSnapshotOfURI: own ?? m.voidFileSnapshotOfURI, userModifications: { voidFileSnapshotOfURI: user ?? m.userModifications.voidFileSnapshotOfURI } }
				changed = true
			}
		}
		if (!changed) return
		const newThreads: ChatThreads = { ...this.state.allThreads, [threadId]: { ...thread, messages } }
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads })
	}

	/**
	 * Put paths back as snapshotted: folders first (outermost first), then file contents, then remove what did not
	 * exist (innermost first; a folder only when it is empty, so nothing the snapshot did not know about is lost).
	 * Returns the paths that could not be restored, with the reason.
	 */
	private async _restoreSnapshots(entries: [string, VoidFileSnapshot][]): Promise<string[]> {
		const failures: string[] = []
		const depth = (p: string) => p.split(/[\\/]/).length
		const attempt = async (fsPath: string, f: () => Promise<unknown>) => { try { await f() } catch (e) { failures.push(`${fsPath}: ${getErrorMessage(e)}`) } }
		for (const [fsPath] of entries.filter(([, s]) => s.pruned)) {
			failures.push(`${fsPath}: this point is too old to restore — its saved copy was dropped to keep the conversation's history small`)
		}
		entries = entries.filter(([, s]) => !s.pruned)
		for (const [fsPath] of entries.filter(([, s]) => s.isFolder).sort((a, b) => depth(a[0]) - depth(b[0]))) {
			await attempt(fsPath, async () => { if (!await this._fileService.exists(URI.file(fsPath))) await this._fileService.createFolder(URI.file(fsPath)) })
		}
		for (const [fsPath, s] of entries.filter(([, s]) => !s.isFolder && !s.absent)) {
			await attempt(fsPath, async () => {
				const uri = URI.file(fsPath)
				if (!await this._fileService.exists(uri) || !this._voidModelService.getModel(uri).model) {
					await this._fileService.writeFile(uri, VSBuffer.fromString(s.entireFileCode))
				}
				if (this._voidModelService.getModel(uri).model) await this._editCodeService.restoreVoidFileSnapshot(uri, s) // the open model and diff areas too
			})
		}
		for (const [fsPath] of entries.filter(([, s]) => s.absent).sort((a, b) => depth(b[0]) - depth(a[0]))) {
			await attempt(fsPath, async () => {
				const uri = URI.file(fsPath)
				let stat
				try { stat = await this._fileService.resolve(uri) } catch { return } // already gone
				if (stat.isDirectory && (stat.children?.length ?? 0) > 0) throw new Error('the folder is not empty, so it was kept')
				await this._fileService.del(uri, { recursive: false })
			})
		}
		return failures
	}


	private _getCheckpointBeforeMessage = ({ threadId, messageIdx }: { threadId: string, messageIdx: number }): [CheckpointEntry, number] | undefined => {
		const thread = this.state.allThreads[threadId]
		if (!thread) return undefined
		for (let i = messageIdx; i >= 0; i--) {
			const message = thread.messages[i]
			if (message.role === 'checkpoint') {
				return [message, i]
			}
		}
		return undefined
	}

	private _getCheckpointsBetween({ threadId, loIdx, hiIdx }: { threadId: string, loIdx: number, hiIdx: number }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return { lastIdxOfURI: {} } // should never happen
		const lastIdxOfURI: { [fsPath: string]: number } = {}
		for (let i = loIdx; i <= hiIdx; i += 1) {
			const message = thread.messages[i]
			if (message?.role !== 'checkpoint') continue
			for (const fsPath in message.voidFileSnapshotOfURI) { // do not include userModified.beforeStrOfURI here, jumping should not include those changes
				lastIdxOfURI[fsPath] = i
			}
		}
		return { lastIdxOfURI }
	}

	private _readCurrentCheckpoint(threadId: string): [CheckpointEntry, number] | undefined {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const { currCheckpointIdx } = thread.state
		if (currCheckpointIdx === null) return

		const checkpoint = thread.messages[currCheckpointIdx]
		if (!checkpoint) return
		if (checkpoint.role !== 'checkpoint') return
		return [checkpoint, currCheckpointIdx]
	}
	private _addUserModificationsToCurrCheckpoint({ threadId }: { threadId: string }) {
		const { voidFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {}
		const res = this._readCurrentCheckpoint(threadId)
		if (!res) return
		const [checkpoint, checkpointIdx] = res
		this._editMessageInThread(threadId, checkpointIdx, {
			...checkpoint,
			userModifications: { voidFileSnapshotOfURI: voidFileSnapshotOfURI ?? {}, },
		})
	}


	private _makeUsStandOnCheckpoint({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (thread.state.currCheckpointIdx === null) {
			const lastMsg = thread.messages[thread.messages.length - 1]
			if (lastMsg?.role !== 'checkpoint')
				this._addUserCheckpoint({ threadId })
			this._setThreadState(threadId, { currCheckpointIdx: thread.messages.length - 1 })
		}
	}

	async jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified }: { threadId: string, messageIdx: number, jumpToUserModified: boolean }): Promise<void> {
		const toRestore: [string, VoidFileSnapshot][] = []

		// if null, add a new temp checkpoint so user can jump forward again
		this._makeUsStandOnCheckpoint({ threadId })

		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (this.streamState[threadId]?.isRunning) return

		const c = this._getCheckpointBeforeMessage({ threadId, messageIdx })
		if (c === undefined) return // should never happen

		const fromIdx = thread.state.currCheckpointIdx
		if (fromIdx === null) return // should never happen

		const [_, toIdx] = c
		if (toIdx === fromIdx) return

		// console.log(`going from ${fromIdx} to ${toIdx}`)

		// update the user's checkpoint
		this._addUserModificationsToCurrCheckpoint({ threadId })

		/*
if undoing

A,B,C are all files.
x means a checkpoint where the file changed.

A B C D E F G H I
  x x x x x   x           <-- you can't always go up to find the "before" version; sometimes you need to go down
  | | | | |   | x
--x-|-|-|-x---x-|-----     <-- to
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-------     <-- from
	  x

We need to revert anything that happened between to+1 and from.
**We do this by finding the last x from 0...`to` for each file and applying those contents.**
We only need to do it for files that were edited since `to`, ie files between to+1...from.
*/
		if (toIdx < fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: toIdx + 1, hiIdx: fromIdx })

			const idxes = function* () {
				for (let k = toIdx; k >= 0; k -= 1) { // first go up
					yield k
				}
				for (let k = toIdx + 1; k < thread.messages.length; k += 1) { // then go down
					yield k
				}
			}

			for (const fsPath in lastIdxOfURI) {
				// find the first instance of this file starting at toIdx (go up to latest file; if there is none, go down);
				// a pruned snapshot is skipped for the next one (the "before" snapshot of the following change holds the same
				// content), and reported only when no usable one is left
				let pruned: VoidFileSnapshot | undefined
				let found = false
				for (const k of idxes()) {
					const message = thread.messages[k]
					if (message.role !== 'checkpoint') continue
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified })
					if (!res) continue
					const { voidFileSnapshot } = res
					if (!voidFileSnapshot) continue
					if (voidFileSnapshot.pruned) { pruned ??= voidFileSnapshot; continue }
					toRestore.push([fsPath, voidFileSnapshot])
					found = true
					break
				}
				if (!found && pruned) toRestore.push([fsPath, pruned])
			}
		}

		/*
if redoing

A B C D E F G H I J
  x x x x x   x     x
  | | | | |   | x x x
--x-|-|-|-x---x-|-|---     <-- from
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-----|---     <-- to
	  x           x


We need to apply latest change for anything that happened between from+1 and to.
We only need to do it for files that were edited since `from`, ie files between from+1...to.
*/
		if (toIdx > fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: fromIdx + 1, hiIdx: toIdx })
			for (const fsPath in lastIdxOfURI) {
				// apply lowest down content for each uri (newest snapshots are never pruned first, but stay safe)
				let pruned: VoidFileSnapshot | undefined
				let found = false
				for (let k = toIdx; k >= fromIdx + 1; k -= 1) {
					const message = thread.messages[k]
					if (message.role !== 'checkpoint') continue
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified })
					if (!res) continue
					const { voidFileSnapshot } = res
					if (!voidFileSnapshot) continue
					if (voidFileSnapshot.pruned) { pruned ??= voidFileSnapshot; continue }
					toRestore.push([fsPath, voidFileSnapshot])
					found = true
					break
				}
				if (!found && pruned) toRestore.push([fsPath, pruned])
			}
		}

		this._setThreadState(threadId, { currCheckpointIdx: toIdx })
		// was fire-and-forget: the jump "finished" before any file was written, and failures were lost
		const failures = await this._restoreSnapshots(toRestore)
		if (failures.length > 0) {
			this._notificationService.notify({ severity: Severity.Warning, message: `Kodia could not restore ${failures.length} file(s) to that checkpoint:\n${failures.join('\n')}` })
		}
	}


	private _wrapRunAgentToNotify(p: Promise<void>, threadId: string) {
		// Capture auto-selected model reason before cleanup
		const autoInfo = this._autoResolvedModels.get(threadId)

		const notify = ({ error }: { error: string | null }) => {
			const thread = this.state.allThreads[threadId]
			if (!thread) return
			const userMsg = findLast(thread.messages, m => m.role === 'user')
			if (!userMsg) return
			if (userMsg.role !== 'user') return
			const messageContent = truncate(userMsg.displayContent, 50, '...')

			// If Auto mode was used, append the selected model info
			let finalMessage = error ? `Error: ${error} ` : `A new Chat result is ready.`
			if (!error && autoInfo) {
				finalMessage = `Auto picked: ${autoInfo.modelSelection.providerName}/${autoInfo.modelSelection.modelName} — ${autoInfo.reason}`
			}

			this._notificationService.notify({
				severity: error ? Severity.Warning : Severity.Info,
				message: finalMessage,
				source: messageContent,
				sticky: true,
				actions: {
					primary: [{
						id: 'void.goToChat',
						enabled: true,
						label: `Jump to Chat`,
						tooltip: '',
						class: undefined,
						run: () => {
							this.switchToThread(threadId)
							// scroll to bottom
							this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
								m.scrollToBottom()
							})
						}
					}]
				},
			})
		}

		p.then(() => {
			if (threadId !== this.state.currentThreadId) notify({ error: null })
		}).catch((e) => {
			if (threadId !== this.state.currentThreadId) notify({ error: getErrorMessage(e) })
			throw e
		})
		// Clean up auto-resolved model for this thread after the turn completes
		p.finally(() => {
			this._autoResolvedModels.delete(threadId)
		})
	}

	dismissStreamError(threadId: string): void {
		this._setStreamState(threadId, undefined)
	}


	private async _addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		// interrupt existing stream
		if (this.streamState[threadId]?.isRunning) {
			await this.abortRunning(threadId)
		}

		// add dummy before this message to keep checkpoint before user message idea consistent
		if (thread.messages.length === 0) {
			this._addUserCheckpoint({ threadId })
		}


		// add user's message to chat history
		const instructions = userMessage
		const currSelns: StagingSelectionItem[] = _chatSelections ?? thread.state.stagingSelections

		const userMessageContent = await chat_userMessageContent(instructions, currSelns, { directoryStrService: this._directoryStringService, fileService: this._fileService }) // user message + names of files (NOT content)
		// the editor state (active file, open files...) now, frozen into the message: in the system prompt, it
		// would change between messages and void the prompt cache of the whole thread
		const workspaceContext = this._convertToLLMMessagesService.getWorkspaceContext(this._settingsService.state.globalSettings.chatMode)
		const content = workspaceContext ? `${userMessageContent}\n\n${workspaceContext}` : userMessageContent
		const userHistoryElt: ChatMessage = { role: 'user', content, displayContent: instructions, selections: currSelns, state: defaultMessageState }
		this._addMessageToThread(threadId, userHistoryElt)

		this._setThreadState(threadId, { currCheckpointIdx: null }) // no longer at a checkpoint because started streaming

		this._wrapRunAgentToNotify(
			this._runChatAgent({ threadId, ...this._currentModelSelectionProps(threadId) }),
			threadId,
		)

		// scroll to bottom
		this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
			m.scrollToBottom()
		})
	}


	async addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string }) {
		const thread = this.state.allThreads[threadId];
		if (!thread) return

		// if there's a current checkpoint, delete all messages after it
		if (thread.state.currCheckpointIdx !== null) {
			const checkpointIdx = thread.state.currCheckpointIdx;
			const newMessages = thread.messages.slice(0, checkpointIdx + 1);

			// Update the thread with truncated messages
			const newThreads = {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					lastModified: new Date().toISOString(),
					messages: newMessages,
				}
			};
			this._storeAllThreads(newThreads);
			this._setState({ allThreads: newThreads });
		}

		// Now call the original method to add the user message and stream the response
		await this._addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId });

	}

	// Add a user message to the thread without triggering the LLM stream.
	// Used by the autonomous executor to inject task instructions.
	addUserMessage: IChatThreadService['addUserMessage'] = async ({ userMessage, threadId }: { userMessage: string, threadId: string }) => {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const instructions = userMessage
		const currSelns: StagingSelectionItem[] = thread.state.stagingSelections

		const userMessageContent = await chat_userMessageContent(instructions, currSelns, { directoryStrService: this._directoryStringService, fileService: this._fileService })
		const workspaceContext = this._convertToLLMMessagesService.getWorkspaceContext(this._settingsService.state.globalSettings.chatMode)
		const content = workspaceContext ? userMessageContent + "\n\n" + workspaceContext : userMessageContent
		const userHistoryElt: ChatMessage = { role: 'user', content, displayContent: instructions, selections: currSelns, state: defaultMessageState }
		this._addMessageToThread(threadId, userHistoryElt)
	}

	// Run one autonomous turn: prepare LLM messages from thread history, send to LLM,
	// and execute any tool calls returned. Used by the autonomous executor.
	runAutonomousTurn: IChatThreadService['runAutonomousTurn'] = async (threadId: string) => {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const modelSelection = this._settingsService.state.modelSelectionOfFeature['Chat']
		const modelSelectionOptions = modelSelection ? this._settingsService.state.optionsOfModelSelection['Chat'][modelSelection.providerName]?.[modelSelection.modelName] : undefined

		await this._runChatAgent({ threadId, modelSelection, modelSelectionOptions })
	}

	editUserMessageAndStreamResponse: IChatThreadService['editUserMessageAndStreamResponse'] = async ({ userMessage, messageIdx, threadId }) => {

		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		if (thread.messages?.[messageIdx]?.role !== 'user') {
			throw new Error(`Error: editing a message with role !=='user'`)
		}

		// get prev and curr selections before clearing the message
		const currSelns = thread.messages[messageIdx].state.stagingSelections || [] // staging selections for the edited message

		// clear messages up to the index
		const slicedMessages = thread.messages.slice(0, messageIdx)
		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					messages: slicedMessages
				}
			}
		})

		// re-add the message and stream it
		this._addUserMessageAndStreamResponse({ userMessage, _chatSelections: currSelns, threadId })
	}

	// ---------- the rest ----------

	private _getAllSeenFileURIs(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return []

		const fsPathsSet = new Set<string>()
		const uris: URI[] = []
		const addURI = (uri: URI) => {
			if (!fsPathsSet.has(uri.fsPath)) uris.push(uri)
			fsPathsSet.add(uri.fsPath)
			uris.push(uri)
		}

		for (const m of thread.messages) {
			// URIs of user selections
			if (m.role === 'user') {
				for (const sel of m.selections ?? []) {
					if (sel.uri) addURI(sel.uri) // images have none
				}
			}
			// URIs of files that have been read
			else if (m.role === 'tool' && m.type === 'success' && m.name === 'read_file') {
				const params = m.params as BuiltinToolCallParams['read_file']
				addURI(params.uri)
			}
		}
		return uris
	}



	getRelativeStr = (uri: URI) => {
		const isInside = this._workspaceContextService.isInsideWorkspace(uri)
		if (isInside) {
			const f = this._workspaceContextService.getWorkspace().folders.find(f => uri.fsPath.startsWith(f.uri.fsPath))
			if (f) { return uri.fsPath.replace(f.uri.fsPath, '') }
			else { return undefined }
		}
		else {
			return undefined
		}
	}


	// gets the location of codespan link so the user can click on it
	generateCodespanLink: IChatThreadService['generateCodespanLink'] = async ({ codespanStr: _codespanStr, threadId }) => {

		// process codespan to understand what we are searching for
		// TODO account for more complicated patterns eg `ITextEditorService.openEditor()`
		const functionOrMethodPattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/; // `fUnCt10n_name`
		const functionParensPattern = /^([^\s(]+)\([^)]*\)$/; // `functionName( args )`

		let target = _codespanStr // the string to search for
		let codespanType: 'file-or-folder' | 'function-or-class'
		if (target.includes('.') || target.includes('/')) {

			codespanType = 'file-or-folder'
			target = _codespanStr

		} else if (functionOrMethodPattern.test(target)) {

			codespanType = 'function-or-class'
			target = _codespanStr

		} else if (functionParensPattern.test(target)) {
			const match = target.match(functionParensPattern)
			if (match && match[1]) {

				codespanType = 'function-or-class'
				target = match[1]

			}
			else { return null }
		}
		else {
			return null
		}

		// get history of all AI and user added files in conversation + store in reverse order (MRU)
		const prevUris = this._getAllSeenFileURIs(threadId).reverse()

		if (codespanType === 'file-or-folder') {
			const doesUriMatchTarget = (uri: URI) => uri.path.includes(target)

			// check if any prevFiles are the `target`
			for (const [idx, uri] of prevUris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// shorten it

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(prevUriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}

					return { uri, displayText }
				}
			}

			// else search codebase for `target`
			let uris: URI[] = []
			try {
				const { result } = await this._toolsService.callTool['search_pathnames_only']({ query: target, includePattern: null, pageNumber: 0 })
				const { uris: uris_ } = await result
				uris = uris_
			} catch (e) {
				return null
			}

			for (const [idx, uri] of uris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(prevUriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}


					return { uri, displayText }
				}
			}

		}


		if (codespanType === 'function-or-class') {


			// check all prevUris for the target
			for (const uri of prevUris) {

				const modelRef = await this._voidModelService.getModelSafe(uri)
				const { model } = modelRef
				if (!model) continue

				const matches = model.findMatches(
					target,
					false, // searchOnlyEditableRange
					false, // isRegex
					true,  // matchCase
					null, //' ',   // wordSeparators
					true   // captureMatches
				);

				const firstThree = matches.slice(0, 3);

				// take first 3 occurences, attempt to goto definition on them
				for (const match of firstThree) {
					const position = new Position(match.range.startLineNumber, match.range.startColumn);
					const definitionProviders = this._languageFeaturesService.definitionProvider.ordered(model);

					for (const provider of definitionProviders) {

						const _definitions = await provider.provideDefinition(model, position, CancellationToken.None);

						if (!_definitions) continue;

						const definitions = Array.isArray(_definitions) ? _definitions : [_definitions];

						for (const definition of definitions) {

							return {
								uri: definition.uri,
								selection: {
									startLineNumber: definition.range.startLineNumber,
									startColumn: definition.range.startColumn,
									endLineNumber: definition.range.endLineNumber,
									endColumn: definition.range.endColumn,
								},
								displayText: _codespanStr,
							};

						}
					}
				}
			}

			// unlike above do not search codebase (doesnt make sense)

		}

		return null

	}

	getCodespanLink({ codespanStr, messageIdx, threadId }: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined {
		const thread = this.state.allThreads[threadId]
		if (!thread) return undefined;

		const links = thread.state.linksOfMessageIdx?.[messageIdx]
		if (!links) return undefined;

		const link = links[codespanStr]

		return link
	}

	async addCodespanLink({ newLinkText, newLinkLocation, messageIdx, threadId }: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({

			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						linksOfMessageIdx: {
							...thread.state.linksOfMessageIdx,
							[messageIdx]: {
								...thread.state.linksOfMessageIdx?.[messageIdx],
								[newLinkText]: newLinkLocation
							}
						}
					}

				}
			}
		})
	}


	getCurrentThread(): ThreadType {
		const state = this.state
		const thread = state.allThreads[state.currentThreadId]
		if (!thread) throw new Error(`Current thread should never be undefined`)
		return thread
	}

	getCurrentFocusedMessageIdx() {
		const thread = this.getCurrentThread()

		// get the focusedMessageIdx
		const focusedMessageIdx = thread.state.focusedMessageIdx
		if (focusedMessageIdx === undefined) return;

		// check that the message is actually being edited
		const focusedMessage = thread.messages[focusedMessageIdx]
		if (focusedMessage.role !== 'user') return;
		if (!focusedMessage.state) return;

		return focusedMessageIdx
	}

	isCurrentlyFocusingMessage() {
		return this.getCurrentFocusedMessageIdx() !== undefined
	}

	switchToThread(threadId: string) {
		this._setState({ currentThreadId: threadId })
	}


	openNewThread() {
		// if a thread with 0 messages already exists, switch to it
		const { allThreads: currentThreads } = this.state
		for (const threadId in currentThreads) {
			if (currentThreads[threadId]!.messages.length === 0) {
				// switch to the existing empty thread and exit
				this.switchToThread(threadId)
				return
			}
		}
		// otherwise, start a new thread
		const newThread = newThreadObject()

		// update state
		const newThreads: ChatThreads = {
			...currentThreads,
			[newThread.id]: newThread
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads, currentThreadId: newThread.id })
	}


	deleteThread(threadId: string): void {
		const { allThreads: currentThreads } = this.state

		// delete the thread
		const newThreads = { ...currentThreads };
		delete newThreads[threadId];

		// store the updated threads
		this._storeAllThreads(newThreads);
		this._setState({ ...this.state, allThreads: newThreads })
	}

	duplicateThread(threadId: string) {
		const { allThreads: currentThreads } = this.state
		const threadToDuplicate = currentThreads[threadId]
		if (!threadToDuplicate) return
		const newThread = {
			...deepClone(threadToDuplicate),
			id: generateUuid(),
		}
		const newThreads = {
			...currentThreads,
			[newThread.id]: newThread,
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads })
	}


	private _addMessageToThread(threadId: string, message: ChatMessage) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		// update state and store it
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages,
					message
				],
			}
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads }) // the current thread just changed (it had a message added to it)
	}

	// sets the currently selected message (must be undefined if no message is selected)
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined) {

		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						focusedMessageIdx: messageIdx,
					}
				}
			}
		})

		// // when change focused message idx, jump - do not jump back when click edit, too confusing.
		// if (messageIdx !== undefined)
		// 	this.jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified: true })
	}


	addNewStagingSelection(newSelection: StagingSelectionItem): void {

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		// if matches with existing selection, overwrite (since text may change)
		const idx = findStagingSelectionIndex(selections, newSelection)
		if (idx !== null && idx !== -1) {
			setSelections([
				...selections!.slice(0, idx),
				newSelection,
				...selections!.slice(idx + 1, Infinity)
			])
		}
		// if no match, add it
		else {
			setSelections([...(selections ?? []), newSelection])
		}
	}


	// Pops the staging selections from the current thread's state
	popStagingSelections(numPops: number): void {

		numPops = numPops ?? 1;

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		setSelections([
			...selections.slice(0, selections.length - numPops)
		])

	}

	// set message.state
	private _setCurrentMessageState(state: Partial<UserMessageState>, messageIdx: number): void {

		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					messages: thread.messages.map((m, i) =>
						i === messageIdx && m.role === 'user' ? {
							...m,
							state: {
								...m.state,
								...state
							},
						} : m
					)
				}
			}
		})

	}

	// set thread.state
	private _setThreadState(threadId: string, state: Partial<ThreadType['state']>, doNotRefreshMountInfo?: boolean): void {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					state: {
						...thread.state,
						...state
					}
				}
			}
		}, doNotRefreshMountInfo)

	}

	// set thread.taskPlan
	private _setThreadTaskPlan(threadId: string, plan: TaskPlan | null): void {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const newThread: ThreadType = {
			...thread,
			taskPlan: plan ?? undefined,
			lastModified: new Date().toISOString()
		}

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: newThread
			}
		})
	}



	getCurrentThreadState = () => {
		const currentThread = this.getCurrentThread()
		return currentThread.state
	}
	setCurrentThreadState = (newState: Partial<ThreadType['state']>) => {
		this._setThreadState(this.state.currentThreadId, newState)
	}

	// gets `staging` and `setStaging` of the currently focused element, given the index of the currently selected message (or undefined if no message is selected)

	getCurrentMessageState(messageIdx: number): UserMessageState {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return defaultMessageState
		return currMessage.state
	}
	setCurrentMessageState(messageIdx: number, newState: Partial<UserMessageState>) {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return
		this._setCurrentMessageState(newState, messageIdx)
	}



}

registerSingleton(IChatThreadService, ChatThreadService, InstantiationType.Eager);
