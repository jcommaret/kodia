/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * The agent's debugger (roadmap 4), on VS Code's debug platform (IDebugService / IDebugSession / DAP adapters).
 *
 * Fixed in this version (all verified against the platform's code and a real DAP adapter):
 * - Debug-console capture listened to `onDidCustomEvent` for 'output' events, but the platform routes output to the
 *   REPL (raw.onDidOutput → appendToRepl); only unknown events are "custom". It captured nothing. Now: REPL elements.
 * - `URI.parse('C:\\proj\\app.js')` reads "C:" as a scheme: breakpoints on plain file paths went to a bogus URI
 *   (verified: scheme "C"). Breakpoint ids now use the public getId() (the old code read a TS-private field, which
 *   happened to work at runtime).
 * - continue/step returned immediately: the agent could not know when or where execution stopped. They now wait
 *   (bounded) for the next stop or the end of the session and report it.
 * - thread ids defaulted to 1 (a Node-ism); other adapters (debugpy, ...) use other ids. Omitted ids now resolve to the
 *   stopped/only thread.
 * - Sessions could only start from launch.json; an inline configuration is now accepted.
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IDebugService, State, IDebugSession, IConfig, ILaunch, IBreakpoint, IThread, IExceptionBreakpoint } from '../../debug/common/debug.js';
import { ExceptionBreakpoint } from '../../debug/common/debugModel.js';
import {
	IDebugToolService, DebugSessionInfo, DebugSessionState, DebugThread, DebugStackFrame, DebugScope, DebugVariable, DebugBreakpoint,
	DebugStackTrace, DebugEvaluateResult, DebugExceptionInfo, DebugConfiguration, DebugRequestType, ConsoleOutputEntry, DebugStopInfo, DebugExceptionFilter,
} from '../common/debugServiceTypes.js';

const MAX_CONSOLE_OUTPUT_PER_SESSION = 500;
const START_WAIT_MS = 15_000;
const RUN_WAIT_MS = 30_000;

function stateToSessionState(state: State): DebugSessionState {
	switch (state) {
		case State.Initializing: return 'initializing';
		case State.Stopped: return 'stopped';
		case State.Running: return 'running';
		default: return 'inactive';
	}
}

function requestOf(config: IConfig): DebugRequestType {
	return config.request === 'attach' ? 'attach' : config.request === 'test' ? 'test' : 'launch';
}

/** Breakpoint locations from the model: a plain file path (Windows or POSIX) or a URI string. */
export function toBreakpointUri(value: string): URI {
	if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')) { return URI.file(value); }
	if (/^[a-zA-Z][\w+.-]+:/.test(value)) { return URI.parse(value); }
	return URI.file(value);
}

export class KodiaDebugToolService extends Disposable implements IDebugToolService {
	readonly _serviceBrand: undefined;

	private readonly consoleOutput = new Map<string, ConsoleOutputEntry[]>();
	private readonly sessionListeners = new Map<string, DisposableStore>();
	/** child session id → parent session id, kept after the sessions end (their console output stays queryable) */
	private readonly parentOf = new Map<string, string>();

	constructor(
		@IDebugService private readonly debugService: IDebugService,
	) {
		super();
		this._register(debugService.onDidNewSession(session => this.trackSession(session)));
		this._register(debugService.onDidEndSession(({ session }) => { this.sessionListeners.get(session.getId())?.dispose(); this.sessionListeners.delete(session.getId()); }));
		for (const session of debugService.getModel().getSessions()) { this.trackSession(session); }
		this._register({ dispose: () => { for (const d of this.sessionListeners.values()) { d.dispose(); } this.sessionListeners.clear(); } });
	}

	/** Debug-console output: the platform puts DAP 'output' events into the session's REPL. */
	private trackSession(session: IDebugSession): void {
		const id = session.getId();
		if (this.sessionListeners.has(id)) { return; }
		const store = new DisposableStore();
		this.sessionListeners.set(id, store);
		const parent = session.parentSession?.getId();
		if (parent) { this.parentOf.set(id, parent); }
		this.consoleOutput.set(id, this.consoleOutput.get(id) ?? []);
		let seen = new Set<string>();
		const collect = () => {
			const entries = this.consoleOutput.get(id)!;
			const next = new Set<string>();
			for (const el of session.getReplElements()) {
				next.add(el.getId());
				if (seen.has(el.getId())) { continue; }
				const text = el.toString();
				if (!text) { continue; }
				entries.push({ sessionId: id, text, source: el.sourceData?.source.uri.fsPath, line: el.sourceData?.lineNumber, column: el.sourceData?.column });
				if (entries.length > MAX_CONSOLE_OUTPUT_PER_SESSION) { entries.shift(); }
			}
			seen = next;
		};
		store.add(session.onDidChangeReplElements(() => collect()));
		collect();
	}

	/** Active sessions only, unless `includeEnded` (status queries about a session that has finished). */
	private findSession(sessionId: string, includeEnded = false): IDebugSession {
		const session = this.debugService.getModel().getSession(sessionId, includeEnded);
		if (!session) { throw new Error(`Debug session "${sessionId}" not found. Use debug_list_sessions to see the active sessions.`); }
		return session;
	}

	/**
	 * A session and every session it spawned. js-debug (VS Code's JavaScript debugger) runs the program in a CHILD
	 * session it asks the client for (DAP `startDebugging`); the session the agent started never has threads or stops.
	 */
	private family(root: IDebugSession): IDebugSession[] {
		const all = this.debugService.getModel().getSessions(true);
		const out = [root];
		for (let i = 0; i < out.length; i++) {
			for (const s of all) { if (s.parentSession === out[i] && !out.includes(s)) { out.push(s); } }
		}
		return out;
	}

	/** The session running the program: a stopped one in the family, else one with threads, else the given one. */
	private target(session: IDebugSession): IDebugSession {
		const live = this.family(session).filter(s => s.state !== State.Inactive);
		return live.find(s => s.state === State.Stopped) ?? live.find(s => s.getAllThreads().length > 0) ?? session;
	}

	/** The thread to act on: the given one, else the stopped one, else the only one. */
	private resolveThread(session: IDebugSession, threadId: number | undefined): IThread {
		const threads = session.getAllThreads();
		if (threadId !== undefined) {
			const t = threads.find(x => x.threadId === threadId);
			if (!t) { throw new Error(`Thread ${threadId} not found in session "${session.getId()}". Threads: ${threads.map(x => `${x.threadId} (${x.name})`).join(', ') || 'none'}.`); }
			return t;
		}
		const stopped = threads.filter(t => t.stopped);
		if (stopped.length > 0) { return stopped[0]; }
		if (threads.length === 1) { return threads[0]; }
		throw new Error(`Session "${session.getId()}" has ${threads.length} threads and none is stopped; pass a threadId (${threads.map(x => `${x.threadId} (${x.name})`).join(', ') || 'none'}).`);
	}

	// ------------------------------------------------------------------ stop/end detection

	/** Snapshot identifying the current stop of every thread in the family (the platform creates new stoppedDetails per stop). */
	private stopMarks(root: IDebugSession): Map<string, unknown> {
		const marks = new Map<string, unknown>();
		for (const s of this.family(root)) { for (const t of s.getAllThreads()) { marks.set(`${s.getId()}:${t.threadId}`, t.stoppedDetails); } }
		return marks;
	}

	private newStop(root: IDebugSession, before?: Map<string, unknown>): { session: IDebugSession; thread: IThread } | undefined {
		for (const s of this.family(root)) {
			if (s.state !== State.Stopped) { continue; }
			const thread = s.getAllThreads().find(t => t.stopped && t.stoppedDetails && (!before || t.stoppedDetails !== before.get(`${s.getId()}:${t.threadId}`)));
			if (thread) { return { session: s, thread }; }
		}
		return undefined;
	}

	/**
	 * Wait until a thread of the session or of a child session stops anew (relative to `before`) or the session ends,
	 * up to `timeoutMs`. `action` (continue/step/...) runs after the listeners are attached, so its stop cannot be missed.
	 */
	private async runAndWaitForStop(root: IDebugSession, timeoutMs: number, action?: () => Promise<unknown>): Promise<DebugStopInfo> {
		const before = this.stopMarks(root);
		const started = Date.now();
		const store = new DisposableStore();
		try {
			const outcome = new Promise<'stopped' | 'ended' | 'timeout'>(resolve => {
				const check = () => {
					if (root.state === State.Inactive) { resolve('ended'); return; }
					if (this.newStop(root, before)) { resolve('stopped'); }
				};
				const watched = new Set<IDebugSession>();
				const watch = () => { for (const s of this.family(root)) { if (!watched.has(s)) { watched.add(s); store.add(s.onDidChangeState(check)); } } };
				watch();
				store.add(this.debugService.onDidNewSession(() => { watch(); check(); })); // a child session started (js-debug)
				store.add(this.debugService.onDidEndSession(e => { if (e.session === root) { resolve('ended'); } }));
				const timer = setTimeout(() => resolve('timeout'), timeoutMs);
				store.add({ dispose: () => clearTimeout(timer) });
				setTimeout(check, 0);
			});
			if (action) { await action(); }
			const result = await outcome;
			if (result === 'ended') { return { state: 'terminated' }; }
			if (result === 'timeout') { return { state: 'running', waitedMs: Date.now() - started }; }
			return this.describeStop(root, before);
		} finally {
			store.dispose();
		}
	}

	private async describeStop(root: IDebugSession, before?: Map<string, unknown>): Promise<DebugStopInfo> {
		const found = this.newStop(root, before) ?? this.newStop(root);
		if (!found) { return { state: root.state === State.Inactive ? 'terminated' : 'running' }; }
		const { session, thread } = found;
		const d = thread.stoppedDetails;
		const info: DebugStopInfo = { state: 'stopped', threadId: thread.threadId, reason: d?.reason, description: d?.description, text: d?.text };
		try {
			const frames = (await session.stackTrace(thread.threadId, 0, 20, CancellationToken.None))?.body?.stackFrames ?? [];
			const loc = (f: DebugProtocol.StackFrame) => ({ name: f.name, sourcePath: f.source?.path, line: f.line, column: f.column, frameId: f.id });
			if (frames[0]) { info.location = loc(frames[0]); }
			// stopped inside the runtime or a library (an assertion library throwing): also say where the user's code is
			const isLibrary = (f: DebugProtocol.StackFrame) => !f.source?.path || /^<node_internals>|[\\/]node_modules[\\/]|^node:/.test(f.source.path);
			if (frames[0] && isLibrary(frames[0])) {
				const user = frames.find(f => !isLibrary(f));
				if (user) { info.userLocation = loc(user); }
			}
		} catch { /* the location is a convenience; the stop itself is real */ }
		return info;
	}

	// ------------------------------------------------------------------ configurations & sessions

	listConfigurations(): Promise<{ configurations: DebugConfiguration[] }> {
		const configurations: DebugConfiguration[] = [];
		for (const launch of this.debugService.getConfigurationManager().getLaunches()) {
			for (const name of launch.getConfigurationNames()) {
				const config = launch.getConfiguration(name);
				if (config) { configurations.push({ name: config.name, type: config.type, request: requestOf(config), folder: launch.workspace?.uri.fsPath }); }
			}
		}
		return Promise.resolve({ configurations });
	}

	listSessions(): Promise<{ sessions: DebugSessionInfo[] }> {
		return Promise.resolve({ sessions: this.debugService.getModel().getSessions().map(s => this.sessionInfo(s)) });
	}

	private sessionInfo(session: IDebugSession): DebugSessionInfo {
		const config = session.configuration;
		return {
			sessionId: session.getId(), name: session.name, type: config.type, state: stateToSessionState(this.target(session).state), request: requestOf(config), configurationName: config.name, folder: session.root?.uri.fsPath,
			parentSessionId: session.parentSession?.getId(),
		};
	}

	async getSessionStatus(sessionId: string): Promise<DebugSessionInfo> {
		return this.sessionInfo(this.findSession(sessionId, true)); // an ended session reports 'inactive', not "not found"
	}

	private resolveLaunch(folder: string | undefined): ILaunch | undefined {
		const configManager = this.debugService.getConfigurationManager();
		const launches = configManager.getLaunches();
		if (folder) { return launches.find(l => l.workspace?.uri.fsPath === folder) ?? launches[0]; }
		return launches[0] ?? configManager.selectedConfiguration.launch;
	}

	async startSession(configurationName: string | undefined, folder?: string, noDebug?: boolean, inline?: Record<string, unknown>, waitMs = START_WAIT_MS): Promise<DebugSessionInfo & { stop: DebugStopInfo }> {
		let launch: ILaunch | undefined = this.resolveLaunch(folder);
		let config: IConfig | undefined;
		if (inline) {
			if (typeof inline.type !== 'string' || typeof inline.request !== 'string') { throw new Error('An inline debug configuration needs at least "type" (e.g. "node", "debugpy", "php") and "request" ("launch" or "attach").'); }
			config = { name: configurationName ?? `Kodia: ${inline.type} ${inline.request}`, ...inline } as IConfig;
		} else {
			if (!configurationName) { throw new Error('Give a configuration name from launch.json (see debug_list_configurations) or an inline "configuration".'); }
			if (!launch) { throw new Error('No launch.json configurations are available; pass an inline "configuration" instead.'); }
			config = launch.getConfiguration(configurationName);
			if (!config) { throw new Error(`Debug configuration "${configurationName}" not found. Available: ${launch.getConfigurationNames().join(', ') || '(none)'}`); }
		}
		const known = new Set(this.debugService.getModel().getSessions().map(s => s.getId()));
		let newSession: IDebugSession | undefined;
		const listener = this.debugService.onDidNewSession(s => { if (!known.has(s.getId()) && !newSession) { newSession = s; } });
		try {
			const ok = await this.debugService.startDebugging(inline ? undefined : launch, config, { noDebug: !!noDebug });
			if (!ok) { throw new Error(`The debugger did not start "${config.name}". Check that a debug adapter for type "${config.type}" is installed and that the configuration is valid.`); }
			newSession ??= this.debugService.getModel().getSessions().find(s => !known.has(s.getId()));
		} finally {
			listener.dispose();
		}
		if (!newSession) { throw new Error(`No debug session appeared for "${config.name}".`); }
		this.trackSession(newSession);
		// the program may already have stopped (stopOnEntry, an early breakpoint) or even ended
		const stop = this.newStop(newSession) ? await this.describeStop(newSession) : await this.runAndWaitForStop(newSession, waitMs);
		return { ...this.sessionInfo(newSession), stop };
	}

	/**
	 * Launch with the given exception filters on, and run to the first such exception (or the end).
	 * A debugger declares its exception filters while it initializes, before the program runs (DebugSession.initialize →
	 * setExceptionBreakpointsForSession, synchronously announced by the model). They are enabled at that moment, so the
	 * session's first breakpoint batch (sent at the adapter's `initialized` event) already carries them, for child
	 * sessions too (test runners run tests in child processes). No stop on entry is needed (node --test has none).
	 */
	async startAndRunToException(configuration: Record<string, unknown>, filters: string[], waitMs = RUN_WAIT_MS * 2, condition?: string): Promise<DebugSessionInfo & { stop: DebugStopInfo; exceptionBreakpoints: DebugExceptionFilter[] }> {
		const model = this.debugService.getModel();
		// the user's own exception-breakpoint settings, restored when this session ends
		const previous = new Map<IExceptionBreakpoint, { enabled: boolean; condition: string | undefined }>();
		const arm = async () => {
			for (const e of model.getExceptionBreakpoints()) {
				if (!filters.includes(e.filter)) { continue; }
				if (!previous.has(e)) { previous.set(e, { enabled: e.enabled, condition: e.condition }); }
				// both model changes are synchronous; the sends that follow are not needed before the adapter is ready
				if (condition && e instanceof ExceptionBreakpoint && e.supportsCondition && e.condition !== condition) { void this.debugService.setExceptionBreakpointCondition(e, condition); }
				if (!e.enabled) { await this.debugService.enableOrDisableBreakpoints(true, e); }
			}
		};
		await arm(); // filters already known from an earlier session of this debugger
		const listener = model.onDidChangeBreakpoints(() => { void arm(); });
		let started: DebugSessionInfo & { stop: DebugStopInfo };
		try {
			started = await this.startSession(undefined, undefined, false, configuration, waitMs);
		} catch (err) {
			await this.restoreExceptionBreakpoints(previous);
			throw err;
		} finally {
			listener.dispose();
		}
		const root = model.getSession(started.sessionId, true);
		if (!root || root.state === State.Inactive) { await this.restoreExceptionBreakpoints(previous); }
		else {
			const ended = this.debugService.onDidEndSession(e => { if (e.session === root) { ended.dispose(); void this.restoreExceptionBreakpoints(previous); } });
			this._register(ended);
		}
		const exceptionBreakpoints = [...previous.keys()].map(e => ({ filter: e.filter, label: e.label, description: e.description, enabled: e.enabled, condition: e.condition }));
		return { ...started, exceptionBreakpoints };
	}

	private async restoreExceptionBreakpoints(previous: Map<IExceptionBreakpoint, { enabled: boolean; condition: string | undefined }>): Promise<void> {
		for (const [e, was] of previous) {
			if (e.condition !== was.condition) { await this.debugService.setExceptionBreakpointCondition(e, was.condition); }
			if (e.enabled !== was.enabled) { await this.debugService.enableOrDisableBreakpoints(was.enabled, e); }
		}
	}

	async attachSession(configurationName: string, folder?: string): Promise<DebugSessionInfo & { stop: DebugStopInfo }> {
		return this.startSession(configurationName, folder, false);
	}

	/** Returns once the session has really ended (bounded), so the next debug action never hits a half-closed adapter. */
	async stopSession(sessionId: string, restart?: boolean, suspend?: boolean): Promise<void> {
		const session = this.findSession(sessionId, true);
		if (session.state === State.Inactive && !restart) { return; } // already ended
		if (restart || suspend || session.state === State.Inactive) { await this.debugService.stopSession(session, restart, suspend); return; }
		const ended = this.runAndWaitForStop(session, START_WAIT_MS, () => this.debugService.stopSession(session, restart, suspend));
		const outcome = await ended;
		const stateNow = (): State => session.state; // read again: the state changed while we waited
		if (outcome.state !== 'terminated' && stateNow() !== State.Inactive) { throw new Error(`The debug session "${sessionId}" did not end within ${START_WAIT_MS / 1000}s.`); }
	}

	async restartSession(sessionId: string): Promise<void> {
		await this.debugService.restartSession(this.findSession(sessionId));
	}

	// ------------------------------------------------------------------ execution control

	async continue(sessionId: string, threadId?: number): Promise<DebugStopInfo> {
		const root = this.findSession(sessionId);
		const session = this.target(root);
		const thread = this.resolveThread(session, threadId);
		return this.runAndWaitForStop(root, RUN_WAIT_MS, () => session.continue(thread.threadId));
	}

	async pause(sessionId: string, threadId?: number): Promise<DebugStopInfo> {
		const root = this.findSession(sessionId);
		const session = this.target(root);
		const id = threadId ?? session.getAllThreads()[0]?.threadId;
		if (id === undefined) { throw new Error(`Session "${sessionId}" has no threads to pause.`); }
		return this.runAndWaitForStop(root, RUN_WAIT_MS, () => session.pause(id));
	}

	async stepOver(sessionId: string, threadId?: number): Promise<DebugStopInfo> {
		const root = this.findSession(sessionId);
		const session = this.target(root);
		const thread = this.resolveThread(session, threadId);
		return this.runAndWaitForStop(root, RUN_WAIT_MS, () => session.next(thread.threadId));
	}

	async stepInto(sessionId: string, threadId?: number): Promise<DebugStopInfo> {
		const root = this.findSession(sessionId);
		const session = this.target(root);
		const thread = this.resolveThread(session, threadId);
		return this.runAndWaitForStop(root, RUN_WAIT_MS, () => session.stepIn(thread.threadId));
	}

	async stepOut(sessionId: string, threadId?: number): Promise<DebugStopInfo> {
		const root = this.findSession(sessionId);
		const session = this.target(root);
		const thread = this.resolveThread(session, threadId);
		return this.runAndWaitForStop(root, RUN_WAIT_MS, () => session.stepOut(thread.threadId));
	}

	// ------------------------------------------------------------------ breakpoints

	async setBreakpoint(_sessionId: string | undefined, uriString: string, lineNumber: number, column?: number, condition?: string, hitCondition?: string, logMessage?: string): Promise<DebugBreakpoint> {
		const uri = toBreakpointUri(uriString);
		const [bp] = await this.debugService.addBreakpoints(uri, [{ lineNumber, column, condition, hitCondition, logMessage, enabled: true }]);
		if (!bp) { throw new Error(`Failed to set a breakpoint at ${uri.fsPath}:${lineNumber}.`); }
		return this.mapBreakpoint(bp);
	}

	async removeBreakpoint(breakpointId: string): Promise<void> {
		if (!this.debugService.getModel().getBreakpoints().some(b => b.getId() === breakpointId)) { throw new Error(`Breakpoint "${breakpointId}" not found (see debug_list_breakpoints).`); }
		await this.debugService.removeBreakpoints(breakpointId);
	}

	async setBreakpointEnabled(breakpointId: string, enabled: boolean): Promise<void> {
		const bp = this.debugService.getModel().getBreakpoints().find(b => b.getId() === breakpointId);
		if (!bp) { throw new Error(`Breakpoint "${breakpointId}" not found (see debug_list_breakpoints).`); }
		await this.debugService.enableOrDisableBreakpoints(enabled, bp);
	}

	async listBreakpoints(): Promise<{ breakpoints: DebugBreakpoint[]; exceptionBreakpoints: DebugExceptionFilter[] }> {
		return { breakpoints: this.debugService.getModel().getBreakpoints().map(bp => this.mapBreakpoint(bp)), exceptionBreakpoints: this.exceptionFilters() };
	}

	/** The exception filters debuggers have declared (deduplicated by filter id), or those of one session. */
	private exceptionFilters(session?: IDebugSession): DebugExceptionFilter[] {
		const model = this.debugService.getModel();
		const list = session ? model.getExceptionBreakpointsForSession(session.getId()) : model.getExceptionBreakpoints();
		return list.map(e => ({ filter: e.filter, label: e.label, description: e.description, enabled: e.enabled, condition: e.condition }));
	}

	/**
	 * Stop on thrown exceptions: enables exactly the given filters (adapter-defined ids, e.g. js-debug "all"/"uncaught",
	 * debugpy "raised"/"uncaught") and disables the others; [] turns exception breakpoints off. The choice is kept by
	 * the platform for later sessions of the same debugger.
	 */
	async setExceptionBreakpoints(sessionId: string, filters: string[]): Promise<{ exceptionBreakpoints: DebugExceptionFilter[] }> {
		const session = this.target(this.findSession(sessionId));
		const available = this.debugService.getModel().getExceptionBreakpointsForSession(session.getId());
		if (available.length === 0) { throw new Error(`The "${session.configuration.type}" debugger declares no exception breakpoints.`); }
		const unknown = filters.filter(f => !available.some(a => a.filter === f));
		if (unknown.length) { throw new Error(`Unknown exception filter${unknown.length > 1 ? 's' : ''} ${unknown.map(f => `"${f}"`).join(', ')}. This debugger has: ${available.map(a => `"${a.filter}" (${a.label})`).join(', ')}.`); }
		for (const e of available) {
			const want = filters.includes(e.filter);
			if (e.enabled !== want) { await this.debugService.enableOrDisableBreakpoints(want, e); }
		}
		return { exceptionBreakpoints: this.exceptionFilters(session) };
	}

	private mapBreakpoint(bp: IBreakpoint): DebugBreakpoint {
		return {
			id: bp.getId(), uri: bp.uri.toString(), lineNumber: bp.lineNumber, column: bp.column ?? undefined, enabled: bp.enabled, verified: bp.verified,
			message: bp.message, condition: bp.condition, hitCondition: bp.hitCondition, logMessage: bp.logMessage,
		};
	}

	// ------------------------------------------------------------------ inspection

	async listThreads(sessionId: string): Promise<{ threads: DebugThread[] }> {
		return { threads: this.target(this.findSession(sessionId)).getAllThreads().map(t => ({ threadId: t.threadId, name: t.name, stateLabel: t.stateLabel, stopped: t.stopped })) };
	}

	async getStackTrace(sessionId: string, threadId?: number, startFrame = 0, levels = 50): Promise<DebugStackTrace> {
		const session = this.target(this.findSession(sessionId));
		const thread = this.resolveThread(session, threadId);
		const response = await session.stackTrace(thread.threadId, startFrame, levels, CancellationToken.None);
		if (!response?.body) { throw new Error(`Failed to retrieve the stack trace of thread ${thread.threadId}.`); }
		const frames: DebugStackFrame[] = response.body.stackFrames.map(f => ({
			frameId: f.id, name: f.name, line: f.line ?? 0, column: f.column ?? 0, sourcePath: f.source?.path, sourceName: f.source?.name ?? f.source?.path, threadId: thread.threadId, canRestart: f.canRestart ?? false,
		}));
		return { frames, totalFrames: response.body.totalFrames ?? frames.length };
	}

	async getScopes(sessionId: string, frameId: number, threadId?: number): Promise<{ scopes: DebugScope[] }> {
		const session = this.target(this.findSession(sessionId));
		const thread = this.resolveThread(session, threadId);
		const response = await session.scopes(frameId, thread.threadId);
		if (!response?.body) { throw new Error(`Failed to retrieve scopes for frame ${frameId}.`); }
		return { scopes: response.body.scopes.map(s => ({ name: s.name, variablesReference: s.variablesReference, expensive: !!s.expensive, hasChildren: s.variablesReference > 0 })) };
	}

	async getVariables(sessionId: string, variablesReference: number, start?: number, count?: number): Promise<{ variables: DebugVariable[] }> {
		const response = await this.target(this.findSession(sessionId)).variables(variablesReference, undefined, undefined, start, count);
		if (!response?.body) { throw new Error(`Failed to retrieve variables for reference ${variablesReference}.`); }
		return { variables: response.body.variables.map(v => ({ name: v.name, value: v.value, type: v.type ?? '', variablesReference: v.variablesReference, hasChildren: v.variablesReference > 0, presentationHint: v.presentationHint?.kind })) };
	}

	/** Without a frameId, a stopped program evaluates in the top frame of the stopped thread (where it stopped), not globally. */
	async evaluateExpression(sessionId: string, expression: string, frameId?: number): Promise<DebugEvaluateResult> {
		const session = this.target(this.findSession(sessionId));
		if (frameId === undefined && session.state === State.Stopped) {
			const thread = session.getAllThreads().find(t => t.stopped);
			if (thread) { frameId = (await session.stackTrace(thread.threadId, 0, 1, CancellationToken.None))?.body?.stackFrames[0]?.id; }
		}
		const response = await session.evaluate(expression, frameId, 'repl');
		if (!response?.body) { throw new Error('The debugger returned no result for the expression.'); }
		return { result: response.body.result ?? '', type: response.body.type ?? '', variablesReference: response.body.variablesReference ?? 0, hasChildren: (response.body.variablesReference ?? 0) > 0 };
	}

	async getExceptionInfo(sessionId: string, threadId?: number): Promise<DebugExceptionInfo> {
		const session = this.target(this.findSession(sessionId));
		const info = await session.exceptionInfo(this.resolveThread(session, threadId).threadId);
		return info ? { id: info.id, description: info.description, breakMode: info.breakMode ?? null } : { breakMode: null };
	}

	// ------------------------------------------------------------------ console

	async getConsoleOutput(sessionId?: string, limit = 200): Promise<{ output: ConsoleOutputEntry[] }> {
		const descends = (id: string): boolean => { for (let cur: string | undefined = id; cur; cur = this.parentOf.get(cur)) { if (cur === sessionId) { return true; } } return false; };
		const all = sessionId ? [...this.consoleOutput.entries()].filter(([id]) => descends(id)).flatMap(([, entries]) => entries) : [...this.consoleOutput.values()].flat();
		return { output: all.slice(-limit) }; // the latest entries
	}
}

registerSingleton(IDebugToolService, KodiaDebugToolService, InstantiationType.Delayed);
