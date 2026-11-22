/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Shared harness for agent-loop integration tests: the real ChatThreadService agent loop, real ToolsService,
 * real EditCodeService, real ConvertToLLMMessageService and a real FileService over the local disk, wired to
 * whichever ILLMMessageService the test supplies (a deterministic script, or a live provider).
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { URI } from '../../../../../base/common/uri.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { ChatThreadService } from '../../browser/chatThreadService.js';
import { ConvertToLLMMessageService } from '../../browser/convertToLLMMessageService.js';
import { EditCodeService } from '../../browser/editCodeService.js';
import { ToolsService } from '../../browser/toolsService.js';
import { RawToolCallObj } from '../../common/sendLLMMessageTypes.js';
import { TaskPlanService } from '../../common/taskPlanService.js';
import { ProjectMemoryService } from '../../common/projectMemoryService.js';
import { defaultGlobalSettings, defaultSettingsOfProvider, SettingsOfProvider } from '../../common/voidSettingsTypes.js';

// ---------- real-disk model layer (stand-in for ITextFileService-backed IVoidModelService) ----------

export class DiskBackedVoidModelService {
	readonly _serviceBrand: undefined;
	private readonly models = new Map<string, TextModel>();
	private readonly savedVersion = new Map<string, number>();
	constructor(private readonly fileService: IFileService) { }
	initializeModel = async (uri: URI) => {
		if (this.models.has(uri.fsPath)) { return; }
		try {
			const content = await this.fileService.readFile(uri);
			const model = createTextModel(content.value.toString(), null, undefined, uri);
			this.models.set(uri.fsPath, model);
			this.savedVersion.set(uri.fsPath, model.getAlternativeVersionId());
		} catch { /* not on disk yet */ }
	};
	getModelFromFsPath = (fsPath: string) => ({ model: this.models.get(fsPath) ?? null, editorModel: null });
	getModel = (uri: URI) => this.getModelFromFsPath(uri.fsPath);
	getModelSafe = async (uri: URI) => { await this.initializeModel(uri); return this.getModel(uri); };
	saveModel = async (uri: URI) => {
		const model = this.models.get(uri.fsPath);
		if (!model) { return; }
		const version = model.getAlternativeVersionId();
		if (this.savedVersion.get(uri.fsPath) === version) { return; }
		await this.fileService.writeFile(uri, VSBuffer.fromString(model.getValue()));
		this.savedVersion.set(uri.fsPath, version);
	};
	dispose() { for (const m of this.models.values()) { m.dispose(); } this.models.clear(); }
}

// ---------- scripted model ----------

/** delayMs: answer after this long (default: next tick), e.g. to keep one of several parallel agents busy */
export type ScriptStep = { text: string; toolCalls?: { name: string; params: Record<string, string> }[]; finishReason?: 'stop' | 'length'; error?: string; delayMs?: number };
/** threadId: the agent loop's thread (several run at once with subagents); tools: the tool names offered, when a request names them */
export type RecordedRequest = { messages: unknown[]; separateSystemMessage: string | undefined; threadId?: string; tools?: string[]; modelName?: string };

export class ScriptedLLMService {
	readonly requests: RecordedRequest[] = [];
	/** non-chat requests (e.g. thread summarization) — answered outside the script, but recorded */
	readonly otherRequests: string[] = [];
	/** exceptions thrown by the script (e.g. failed expectations): surfaced by runTurn instead of a retry-loop timeout */
	readonly scriptErrors: string[] = [];
	private nextId = 0;
	constructor(private readonly script: (requestIdx: number, req: RecordedRequest) => ScriptStep) { }

	sendLLMMessage = (params: any) => {
		const requestId = `req-${this.nextId++}`;
		const loggingName: string = params.logging?.loggingName ?? '';
		if (!loggingName.startsWith('Chat - ')) {
			this.otherRequests.push(loggingName);
			setTimeout(() => params.onFinalMessage({ fullText: '', fullReasoning: '', anthropicReasoning: null }), 0);
			return requestId;
		}
		const req: RecordedRequest = {
			messages: JSON.parse(JSON.stringify(params.messages)), separateSystemMessage: params.separateSystemMessage,
			threadId: params.promptCacheKey, tools: params.tools?.map((t: { name: string }) => t.name), modelName: params.modelSelection?.modelName,
		};
		const idx = this.requests.length;
		this.requests.push(req);
		this.pending.set(requestId, params);
		setTimeout(async () => {
			let step: ScriptStep;
			try { step = this.script(idx, req); }
			catch (e) { this.scriptErrors.push(`request ${idx}: ${e instanceof Error ? e.message : String(e)}`); params.onError({ message: String(e), fullError: e instanceof Error ? e : null }); return; }
			if (step.delayMs) { await new Promise(r => setTimeout(r, step.delayMs)); }
			if (!this.pending.delete(requestId)) { return; } // aborted meanwhile: like a provider, send nothing more
			if (step.error) { params.onError({ message: step.error, fullError: new Error(step.error) }); return; }
			const toolCalls: RawToolCallObj[] = (step.toolCalls ?? []).map((c, i) => ({
				name: c.name as RawToolCallObj['name'],
				rawParams: c.params,
				doneParams: Object.keys(c.params) as RawToolCallObj['doneParams'],
				id: `call_${idx}_${i}`,
				isDone: true,
			}));
			// stream the text in two chunks like a provider would, then finish
			params.onText({ fullText: step.text.slice(0, Math.ceil(step.text.length / 2)), fullReasoning: '' });
			params.onText({ fullText: step.text, fullReasoning: '', toolCall: toolCalls[0] });
			params.onFinalMessage({ fullText: step.text, fullReasoning: '', toolCalls, anthropicReasoning: null, finishReason: step.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop') });
		}, 0);
		return requestId;
	};
	private readonly pending = new Map<string, any>();
	readonly aborted: string[] = [];
	/** like the real service: an aborted request reports onAbort and never answers */
	abort = (requestId: string) => {
		const params = this.pending.get(requestId);
		if (!params) { return; }
		this.pending.delete(requestId);
		this.aborted.push(requestId);
		params.onAbort?.();
	};
}

export const noopService: any = new Proxy(function () { }, {
	get: (_t, p) => p === 'then' ? undefined : noopService,
	apply: () => noopService,
});

// ---------- real terminal (stand-in for the integrated-terminal-backed ITerminalToolService) ----------

export type RecordedCommand = { command: string; cwd: string | undefined; exitCode: number | null; timedOut: boolean; ms: number; outputTail: string };

/**
 * Deletes a temp folder that may hold a git repository: git marks object files read-only on Windows, and Electron's
 * fs.rmSync then fails with EPERM, so they are made writable first.
 */
export function removeRepo(dir: string): void {
	const makeWritable = (p: string) => {
		for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
			const full = path.join(p, entry.name);
			if (entry.isDirectory()) { makeWritable(full); } else { fs.chmodSync(full, 0o666); }
		}
	};
	if (fs.existsSync(dir)) { makeWritable(dir); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

/**
 * Runs run_command's commands as real processes. It receives exactly the string Kodia's run_command builds
 * (on Windows: `cmd /c '...'`, meant for a PowerShell integrated terminal) and runs it in PowerShell there,
 * /bin/sh elsewhere. Returns Kodia's own result shape ({ result, resolveReason }).
 */
export class ProcessTerminalToolService {
	readonly commands: RecordedCommand[] = [];
	private readonly running = new Set<cp.ChildProcess>();
	constructor(private readonly defaultCwd: string, private readonly timeoutMs = 120_000) { }

	/** kill a command and everything it started (PowerShell -> cmd -> node ...) */
	private killTree(child: cp.ChildProcess) {
		if (child.exitCode !== null || child.pid === undefined) { return; }
		if (isWindows) { cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
		else { child.kill('SIGKILL'); }
	}

	runCommand = async (command: string, opts: { cwd?: string | null }) => {
		const cwd = opts.cwd ?? this.defaultCwd;
		const started = Date.now();
		// stdin is not used: commands are non-interactive, and an open stdin pipe must never be able to block one
		const child = isWindows
			// `exit $LASTEXITCODE`: powershell -Command otherwise reports 1 for any failing native command, while the
			// integrated terminal reports the command's real exit code
			? cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${command}; exit $LASTEXITCODE`], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
			: cp.spawn('/bin/sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		this.running.add(child);
		let output = '';
		child.stdout!.on('data', d => { output += d; });
		child.stderr!.on('data', d => { output += d; });
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; this.killTree(child); }, this.timeoutMs);
		const resPromise = new Promise<{ result: string; resolveReason: { type: 'done'; exitCode: number } | { type: 'timeout' } }>(resolve => {
			child.on('error', err => { output += `\n${err.message}`; });
			child.on('close', code => {
				clearTimeout(timer);
				this.running.delete(child);
				const result = output.length > 20_000 ? '...(truncated)...\n' + output.slice(-20_000) : output;
				this.commands.push({ command, cwd, exitCode: timedOut ? null : code, timedOut, ms: Date.now() - started, outputTail: output.slice(-1500) });
				resolve({ result, resolveReason: timedOut ? { type: 'timeout' } : { type: 'done', exitCode: code ?? 1 } });
			});
		});
		return { resPromise, interrupt: () => this.killTree(child) };
	};
	listPersistentTerminalIds = () => [];
	/** no command outlives its test */
	dispose() { for (const child of this.running) { this.killTree(child); } this.running.clear(); }
}

// ---------- harness ----------

export type HarnessOptions = {
	modelSelection: { providerName: string; modelName: string };
	overridesOfModel?: object;
	settingsOfProvider?: SettingsOfProvider;
	/** a real terminal for run_command; without it terminal tools fail */
	terminal?: ProcessTerminalToolService;
	/** overrides of Kodia's global settings (e.g. verifyBeforeFinishing) */
	globalSettings?: Record<string, unknown>;
	/** the git tools' service (IGitToolService); without it git tools fail */
	git?: object;
	/** the test tools' service (ITestToolService); without it test tools fail */
	tests?: object;
	/** the debug tools' service (IDebugToolService) and the live debugger-activity feed (IDebuggerActivityService) */
	debug?: object;
	debuggerActivity?: object;
	/**
	 * Main-process services by IPC channel name (e.g. 'void-channel-browser'). Exposed exactly as app.ts does
	 * (ProxyChannel.fromService), and every argument and result is serialized, as it would be over real IPC.
	 */
	mainProcessServices?: Record<string, object>;
	/** the models switched on in Settings (the model dropdown) */
	modelOptions?: { name: string; selection: { providerName: string; modelName: string } }[];
	/** the storage service (IStorageService) the threads are kept in; default: a fresh in-memory one */
	storage?: object;
	/** use the real ProjectMemoryService (.kodia/memory.md in the workspace) for the tools and the system prompt; default: empty memory */
	realProjectMemory?: boolean;
};

/**
 * Storage that, like the real one, only keeps on "disk" what was flushed: `crash()` returns what a process killed
 * now would leave behind, and `new FlushingStorage(thatDisk)` is the next process starting from it.
 */
export class FlushingStorage {
	private readonly live = new Map<string, string>();
	readonly disk: Map<string, string>;
	flushes = 0;
	constructor(disk?: ReadonlyMap<string, string>) { this.disk = new Map(disk ?? []); for (const [k, v] of this.disk) { this.live.set(k, v); } }
	get(key: string, _scope: unknown, fallback?: string) { return this.live.get(key) ?? fallback; }
	store(key: string, value: string) { this.live.set(key, value); }
	remove(key: string) { this.live.delete(key); }
	async flush() { this.flushes++; for (const [k, v] of this.live) { this.disk.set(k, v); } }
	crash(): ReadonlyMap<string, string> { return new Map(this.disk); }
}

function mainProcessServiceOf(services: Record<string, object>, store: DisposableStore) {
	const roundTrip = (v: unknown) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
	const unavailable = { call: async () => undefined, listen: () => Event.None };
	return {
		getChannel: (name: string) => {
			const service = services[name];
			if (!service) { return unavailable; }
			const server = ProxyChannel.fromService(service, store);
			return {
				call: async (command: string, arg?: unknown) => roundTrip(await server.call(null, command, roundTrip(arg))),
				listen: (event: string, arg?: unknown) => server.listen(null, event, roundTrip(arg)),
			};
		},
	};
}

export function createHarness<L extends object>(tmpDir: string, llm: L, store: DisposableStore, opts: HarnessOptions) {
	const logService = new NullLogService();
	const fileService = store.add(new FileService(logService));
	store.add(fileService.registerProvider(Schemas.file, store.add(new DiskFileSystemProvider(logService))));
	const workspace = new TestContextService(testWorkspace(URI.file(tmpDir)));

	const voidModelService = new DiskBackedVoidModelService(fileService);
	store.add({ dispose: () => voidModelService.dispose() });
	if (opts.terminal) { store.add(opts.terminal); }
	const projectMemory = opts.realProjectMemory ? store.add(new ProjectMemoryService(fileService, workspace, store.add(new InMemoryStorageService()))) : undefined;

	const settingsService = {
		state: {
			globalSettings: { ...defaultGlobalSettings, chatMode: 'agent', agentAutonomyMode: 'agent', autoAcceptLLMChanges: true, includeToolLintErrors: false, ...opts.globalSettings },
			modelSelectionOfFeature: { Chat: opts.modelSelection },
			optionsOfModelSelection: { Chat: {}, 'Ctrl+K': {}, Autocomplete: {}, Apply: {}, SCM: {} },
			overridesOfModel: opts.overridesOfModel ?? {},
			settingsOfProvider: opts.settingsOfProvider ?? defaultSettingsOfProvider,
			mcpUserStateOfName: {},
			_modelOptions: opts.modelOptions ?? [],
		},
		onDidChangeState: Event.None,
	};
	const directoryStrService = { getAllDirectoriesStr: async () => '(file tree omitted in test)', getDirectoryStrTool: async () => '' };
	const mcpService = { getMCPTools: () => [], stringifyResult: () => '', onDidChangeState: Event.None };

	const editCodeService = store.add(new EditCodeService(
		{ listCodeEditors: () => [], onCodeEditorAdd: Event.None } as any,
		{ getModels: () => [], onModelAdded: Event.None } as any,
		{ pushElement: () => { }, undo: () => { } } as any, // IUndoRedoService (a refused edit undoes its history entry)
		noopService, noopService, noopService, noopService, noopService, noopService,
		settingsService as any, fileService, voidModelService as any, noopService,
	));

	const DUMMY = {};
	const tools = new ToolsService(
		fileService as any, workspace,
		DUMMY as any, { createInstance: () => ({}) } as any,
		voidModelService as any, editCodeService as any,
		(opts.terminal ?? DUMMY) as any, // ITerminalToolService
		(opts.git ?? DUMMY) as any, // IGitToolService
		(opts.tests ?? DUMMY) as any, // ITestToolService
		(opts.debug ?? DUMMY) as any, // IDebugToolService
		{ getStreamState: () => 'idle-no-changes' } as any,
		directoryStrService as any,
		{ read: () => [] } as any,
		settingsService as any,
		(projectMemory ?? DUMMY) as any, DUMMY as any, DUMMY as any, // IProjectMemoryService, ILanguageFeaturesService, ITextModelService
		mainProcessServiceOf(opts.mainProcessServices ?? {}, store) as any, // IMainProcessService
		(opts.debuggerActivity ?? DUMMY) as any, // IDebuggerActivityService
		DUMMY as any, DUMMY as any, DUMMY as any, // notebook services
	);

	const converter = store.add(new ConvertToLLMMessageService(
		{ getModels: () => [] } as any, // IModelService
		workspace,
		{ activeEditor: undefined } as any, // IEditorService
		directoryStrService as any,
		{ listPersistentTerminalIds: () => [] } as any,
		settingsService as any,
		voidModelService as any,
		mcpService as any,
		(projectMemory ?? { getMemory: () => '', whenReady: Promise.resolve() }) as any,
		{ findAgentSkills: async () => [] } as any,
	));

	const chat = store.add(new ChatThreadService(
		(opts.storage ?? store.add(new InMemoryStorageService())) as any,
		voidModelService as any,
		llm as any,
		tools as any,
		settingsService as any,
		DUMMY as any, // ILanguageFeaturesService
		{ capture: () => { } } as any, // IMetricsService
		editCodeService as any,
		noopService, // INotificationService
		converter,
		workspace,
		directoryStrService as any,
		fileService as any,
		{ truncateAsync: async (text: string) => ({ text }) } as any, // IToolOutputService
		mcpService as any,
		store.add(new TaskPlanService()),
	));

	return { chat, llm, fileService, tools, projectMemory };
}

/** Run one user turn and wait until the agent loop has fully stopped. */
export async function runTurn(chat: ChatThreadService, userMessage: string, timeoutMs = 30_000) {
	const threadId = chat.state.currentThreadId;
	const done = new Promise<void>((resolve, reject) => {
		const t = setTimeout(() => {
			sub.dispose();
			const scriptErrors = ((chat as any)._llmMessageService?.scriptErrors ?? []) as string[];
			reject(new Error(`agent turn did not finish in ${timeoutMs}ms; state=${JSON.stringify(chat.streamState[threadId])}${scriptErrors.length ? `; scripted model errors: ${scriptErrors.join(' | ')}` : ''}`));
		}, timeoutMs);
		let started = false;
		const sub = chat.onDidChangeStreamState(({ threadId: id }) => {
			if (id !== threadId) { return; }
			const s = chat.streamState[threadId];
			if (s?.isRunning) { started = true; return; }
			if (started && !s?.isRunning) { clearTimeout(t); sub.dispose(); resolve(); }
		});
	});
	await chat.addUserMessageAndStreamResponse({ userMessage, threadId });
	await done;
	return { threadId, messages: chat.state.allThreads[threadId]!.messages, streamState: chat.streamState[threadId] };
}

export const toolMessages = (messages: readonly any[]) => messages.filter(m => m.role === 'tool');
