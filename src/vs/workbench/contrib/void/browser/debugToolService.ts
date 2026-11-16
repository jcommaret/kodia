/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IDebugService, State, IDebugSession, IConfig, ILaunch } from '../../debug/common/debug.js';
import { IDebugToolService, DebugSessionInfo, DebugSessionState, DebugThread, DebugStackFrame, DebugScope, DebugVariable, DebugBreakpoint, DebugStackTrace, DebugEvaluateResult, DebugExceptionInfo, DebugConfiguration, DebugRequestType, ConsoleOutputEntry } from '../common/debugServiceTypes.js';

const MAX_CONSOLE_OUTPUT_PER_SESSION = 500;

function stateToSessionState(state: State): DebugSessionState {
	switch (state) {
		case State.Initializing: return 'initializing';
		case State.Stopped: return 'stopped';
		case State.Running: return 'running';
		default: return 'inactive';
	}
}

function requestOf(config: IConfig): DebugRequestType {
	switch (config.request) {
		case 'launch': return 'launch';
		case 'attach': return 'attach';
		case 'test': return 'test';
		default: return 'launch';
	}
}

export class KodiaDebugToolService extends Disposable implements IDebugToolService {
	readonly _serviceBrand: undefined;

	private readonly debugService: IDebugService;
	private readonly consoleOutput = new Map<string, ConsoleOutputEntry[]>();

	constructor(
		@IDebugService debugService: IDebugService,
	) {
		super();
		this.debugService = debugService;

		// Buffer console ('output') events from every debug session so the agent
		// can inspect debug console output retroactively.
		this._register(debugService.onDidNewSession(session => this.trackSession(session)));
		for (const session of debugService.getModel().getSessions()) {
			this.trackSession(session);
		}
	}

	private trackSession(session: IDebugSession): void {
		const id = session.getId();
		if (!this.consoleOutput.has(id)) {
			this.consoleOutput.set(id, []);
		}
		const onOutput = (e: DebugProtocol.Event) => {
			if (e.event !== 'output') return;
			const body = e.body as { output?: string; source?: DebugProtocol.Source; line?: number; column?: number };
			const text = body.output ?? '';
			if (!text) return;
			const entries = this.consoleOutput.get(id)!;
			entries.push({
				sessionId: id,
				text,
				source: body.source?.path,
				line: body.line,
				column: body.column,
			});
			if (entries.length > MAX_CONSOLE_OUTPUT_PER_SESSION) {
				entries.shift();
			}
		};
		const disposable = session.onDidCustomEvent(onOutput);
		this._register(disposable);
	}

	private getModel() {
		return this.debugService.getModel();
	}

	private findSession(sessionId: string): IDebugSession {
		const session = this.getModel().getSession(sessionId);
		if (!session) {
			throw new Error(`Debug session "${sessionId}" not found.`);
		}
		return session;
	}

	// ------------------------------------------------------------------
	// Configurations
	// ------------------------------------------------------------------

	listConfigurations(): Promise<{ configurations: DebugConfiguration[] }> {
		const configManager = this.debugService.getConfigurationManager();
		const configurations: DebugConfiguration[] = [];
		for (const launch of configManager.getLaunches()) {
			const folder = launch.workspace ? launch.workspace.uri.fsPath : undefined;
			for (const name of launch.getConfigurationNames()) {
				const config = launch.getConfiguration(name);
				if (!config) continue;
				configurations.push({
					name: config.name,
					type: config.type,
					request: requestOf(config),
					folder,
				});
			}
		}
		return Promise.resolve({ configurations });
	}

	// ------------------------------------------------------------------
	// Sessions
	// ------------------------------------------------------------------

	listSessions(): Promise<{ sessions: DebugSessionInfo[] }> {
		const sessions: DebugSessionInfo[] = [];
		for (const session of this.getModel().getSessions()) {
			sessions.push(this.sessionInfo(session));
		}
		return Promise.resolve({ sessions });
	}

	private sessionInfo(session: IDebugSession): DebugSessionInfo {
		const config = session.configuration;
		return {
			sessionId: session.getId(),
			name: session.name,
			type: config.type,
			state: stateToSessionState(session.state),
			request: requestOf(config),
			configurationName: config.name,
			folder: session.root ? session.root.uri.fsPath : undefined,
		};
	}

	async getSessionStatus(sessionId: string): Promise<DebugSessionInfo> {
		return this.sessionInfo(this.findSession(sessionId));
	}

	private async sessionStartedMatching(configurationName: string, type: string, request: DebugRequestType): Promise<IDebugSession | undefined> {
		const start = Date.now();
		while (Date.now() - start < 5000) {
			for (const session of this.getModel().getSessions()) {
				const config = session.configuration;
				if (config.name === configurationName && config.type === type && requestOf(config) === request && session.state !== State.Inactive) {
					return session;
				}
			}
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		return undefined;
	}

	private resolveLaunch(folder: string | undefined): ILaunch | undefined {
		const configManager = this.debugService.getConfigurationManager();
		const launches = configManager.getLaunches();
		if (folder) {
			return launches.find(l => l.workspace && l.workspace.uri.fsPath === folder) || launches[0];
		}
		return launches[0] || configManager.selectedConfiguration.launch;
	}

	async startSession(configurationName: string, folder?: string, noDebug?: boolean): Promise<DebugSessionInfo> {
		const launch = this.resolveLaunch(folder);
		if (!launch) {
			throw new Error('No debug configurations are available. Open a launch.json or add a debug configuration first.');
		}
		const config = launch.getConfiguration(configurationName);
		if (!config) {
			const names = launch.getConfigurationNames().join(', ') || '(none)';
			throw new Error(`Debug configuration "${configurationName}" not found. Available: ${names}`);
		}
		const ok = await this.debugService.startDebugging(launch, config, { noDebug: !!noDebug });
		if (!ok) {
			throw new Error(`Failed to start debug session for configuration "${configurationName}".`);
		}
		const session = await this.sessionStartedMatching(configurationName, config.type, requestOf(config));
		if (!session) {
			throw new Error(`Debug session for "${configurationName}" did not become available.`);
		}
		return this.sessionInfo(session);
	}

	async attachSession(configurationName: string, folder?: string): Promise<DebugSessionInfo> {
		// Attach is a start against an 'attach' request configuration.
		return this.startSession(configurationName, folder, false);
	}

	async stopSession(sessionId: string, restart?: boolean, suspend?: boolean): Promise<void> {
		await this.debugService.stopSession(this.findSession(sessionId), restart, suspend);
	}

	async restartSession(sessionId: string): Promise<void> {
		await this.debugService.restartSession(this.findSession(sessionId));
	}

	// ------------------------------------------------------------------
	// Execution control
	// ------------------------------------------------------------------

	async continue(sessionId: string, threadId: number): Promise<void> {
		await this.findSession(sessionId).continue(threadId);
	}

	async pause(sessionId: string, threadId: number): Promise<void> {
		await this.findSession(sessionId).pause(threadId);
	}

	async stepOver(sessionId: string, threadId: number): Promise<void> {
		await this.findSession(sessionId).next(threadId);
	}

	async stepInto(sessionId: string, threadId: number): Promise<void> {
		await this.findSession(sessionId).stepIn(threadId);
	}

	async stepOut(sessionId: string, threadId: number): Promise<void> {
		await this.findSession(sessionId).stepOut(threadId);
	}

	// ------------------------------------------------------------------
	// Breakpoints
	// ------------------------------------------------------------------

	async setBreakpoint(sessionId: string | undefined, uriString: string, lineNumber: number, column?: number, condition?: string, hitCondition?: string, logMessage?: string): Promise<DebugBreakpoint> {
		const uri = URI.parse(uriString);
		const raw: { lineNumber: number; column?: number; condition?: string; hitCondition?: string; logMessage?: string; enabled: boolean }[] = [{
			lineNumber,
			column,
			condition,
			hitCondition,
			logMessage,
			enabled: true,
		}];
		const bps = await this.debugService.addBreakpoints(uri, raw);
		const bp = bps[0];
		if (!bp) {
			throw new Error(`Failed to set breakpoint at ${uriString}:${lineNumber}.`);
		}
		return this.mapBreakpoint(bp);
	}

	async removeBreakpoint(breakpointId: string): Promise<void> {
		await this.debugService.removeBreakpoints(breakpointId);
	}

	async setBreakpointEnabled(breakpointId: string, enabled: boolean): Promise<void> {
		const bp = this.getModel().getBreakpoints().find(b => b.getId() === breakpointId);
		if (!bp) {
			throw new Error(`Breakpoint "${breakpointId}" not found.`);
		}
		await this.debugService.enableOrDisableBreakpoints(enabled, bp);
	}

	async listBreakpoints(): Promise<{ breakpoints: DebugBreakpoint[] }> {
		const bps = this.getModel().getBreakpoints();
		return Promise.resolve({ breakpoints: bps.map(bp => this.mapBreakpoint(bp)) });
	}

	private mapBreakpoint(bp: { id?: string; uri: URI; lineNumber: number; column?: number; enabled: boolean; verified: boolean; message?: string; condition?: string; hitCondition?: string; logMessage?: string }): DebugBreakpoint {
		return {
			id: bp.id ?? '',
			uri: bp.uri.toString(),
			lineNumber: bp.lineNumber,
			column: bp.column ?? undefined,
			enabled: bp.enabled,
			verified: bp.verified,
			message: bp.message,
			condition: bp.condition,
			hitCondition: bp.hitCondition,
			logMessage: bp.logMessage,
		};
	}

	// ------------------------------------------------------------------
	// Inspection
	// ------------------------------------------------------------------

	async listThreads(sessionId: string): Promise<{ threads: DebugThread[] }> {
		const session = this.findSession(sessionId);
		const threads: DebugThread[] = [];
		for (const thread of session.getAllThreads()) {
			threads.push({ threadId: thread.threadId, name: thread.name, stateLabel: thread.stateLabel, stopped: thread.stopped });
		}
		return Promise.resolve({ threads });
	}

	async getStackTrace(sessionId: string, threadId: number, startFrame = 0, levels = 50): Promise<DebugStackTrace> {
		const session = this.findSession(sessionId);
		const response = await session.stackTrace(threadId, startFrame, levels, CancellationToken.None);
		if (!response || !response.body) {
			throw new Error(`Failed to retrieve stack trace for thread ${threadId} in session "${sessionId}".`);
		}
		const frames: DebugStackFrame[] = [];
		for (const f of response.body.stackFrames) {
			const source = f.source;
			frames.push({
				frameId: f.id,
				name: f.name,
				line: f.line ?? 0,
				column: f.column ?? 0,
				sourcePath: source?.path,
				sourceName: source?.name ?? source?.path,
				threadId,
				canRestart: f.canRestart ?? false,
			});
		}
		return Promise.resolve({ frames, totalFrames: response.body.totalFrames ?? frames.length });
	}

	async getScopes(sessionId: string, frameId: number, threadId?: number): Promise<{ scopes: DebugScope[] }> {
		const session = this.findSession(sessionId);
		let resolvedThreadId = threadId;
		if (resolvedThreadId === undefined) {
			const stoppedThreads = session.getAllThreads().filter(t => t.stopped);
			if (stoppedThreads.length === 0) {
				throw new Error(`No stopped thread in session "${sessionId}"; provide a threadId.`);
			}
			resolvedThreadId = stoppedThreads[0].threadId;
		}
		const response = await session.scopes(frameId, resolvedThreadId);
		if (!response || !response.body) {
			throw new Error(`Failed to retrieve scopes for frame ${frameId} in session "${sessionId}".`);
		}
		const scopes: DebugScope[] = [];
		for (const s of response.body.scopes) {
			scopes.push({ name: s.name, variablesReference: s.variablesReference, expensive: !!s.expensive, hasChildren: s.variablesReference > 0 });
		}
		return Promise.resolve({ scopes });
	}

	async getVariables(sessionId: string, variablesReference: number, start?: number, count?: number): Promise<{ variables: DebugVariable[] }> {
		const session = this.findSession(sessionId);
		const response = await session.variables(variablesReference, undefined, undefined, start, count);
		if (!response || !response.body) {
			throw new Error(`Failed to retrieve variables for reference ${variablesReference} in session "${sessionId}".`);
		}
		const variables: DebugVariable[] = [];
		for (const v of response.body.variables) {
			variables.push({
				name: v.name,
				value: v.value,
				type: v.type ?? '',
				variablesReference: v.variablesReference,
				hasChildren: v.variablesReference > 0,
			});
		}
		return Promise.resolve({ variables });
	}

	async evaluateExpression(sessionId: string, expression: string, frameId?: number): Promise<DebugEvaluateResult> {
		const session = this.findSession(sessionId);
		const response = await session.evaluate(expression, frameId, 'repl');
		if (!response || !response.body) {
			throw new Error(`Failed to evaluate expression in session "${sessionId}".`);
		}
		return Promise.resolve({
			result: response.body.result ?? '',
			type: response.body.type ?? '',
			variablesReference: response.body.variablesReference ?? 0,
			hasChildren: (response.body.variablesReference ?? 0) > 0,
		});
	}

	async getExceptionInfo(sessionId: string, threadId: number): Promise<DebugExceptionInfo> {
		const session = this.findSession(sessionId);
		const info = await session.exceptionInfo(threadId);
		if (!info) {
			return { breakMode: null };
		}
		return {
			id: info.id,
			description: info.description,
			breakMode: info.breakMode ?? null,
		};
	}

	// ------------------------------------------------------------------
	// Console
	// ------------------------------------------------------------------

	async getConsoleOutput(sessionId?: string, limit = 200): Promise<{ output: ConsoleOutputEntry[] }> {
		const output: ConsoleOutputEntry[] = [];
		if (sessionId) {
			const entries = this.consoleOutput.get(sessionId) ?? [];
			output.push(...entries.slice(-limit));
		} else {
			for (const entries of this.consoleOutput.values()) {
				output.push(...entries);
			}
			output.splice(limit);
		}
		return Promise.resolve({ output });
	}
}

registerSingleton(IDebugToolService, KodiaDebugToolService, InstantiationType.Delayed);
