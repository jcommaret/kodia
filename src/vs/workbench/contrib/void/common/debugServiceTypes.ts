/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

// ---------------------------------------------------------------------------
// Kodia AI debugger tool service types
//
// This service wraps VS Code's existing Debug Adapter Protocol (DAP) infrastructure
// (IDebugService, IDebugModel, IDebugSession, ...) so the Kodia agent can control
// real debugging sessions through the shared agent tool pipeline.
// ---------------------------------------------------------------------------

export type DebugSessionState = 'inactive' | 'initializing' | 'stopped' | 'running';

export type DebugRequestType = 'launch' | 'attach' | 'test';

// A debug session as seen by the agent. sessionId is stable for the lifetime
// of the session (it is IDebugSession.getId()).
export interface DebugSessionInfo {
	sessionId: string;
	name: string;
	type: string;
	state: DebugSessionState;
	request: DebugRequestType;
	configurationName: string;
	folder?: string;
}

// A thread in a debug session.
export interface DebugThread {
	threadId: number;
	name: string;
	stateLabel: string;
	stopped: boolean;
}

// A stack frame in a thread's call stack.
export interface DebugStackFrame {
	frameId: number;
	threadId: number;
	name: string;
	line: number;
	column: number;
	sourcePath: string | undefined;
	sourceName: string | undefined;
	canRestart: boolean;
}

// A variable scope (local, argument, global, ...) of a stack frame.
export interface DebugScope {
	name: string;
	variablesReference: number;
	expensive: boolean;
	hasChildren: boolean;
}

// A variable value. variablesReference > 0 means the variable has children
// that can be fetched with getVariables.
export interface DebugVariable {
	name: string;
	value: string;
	type: string;
	variablesReference: number;
	hasChildren: boolean;
	presentationHint?: string;
}

export interface DebugBreakpoint {
	id: string;
	uri: string;
	lineNumber: number;
	column: number | undefined;
	enabled: boolean;
	verified: boolean;
	message?: string;
	condition?: string;
	hitCondition?: string;
	logMessage?: string;
}

export interface DebugStackTrace {
	frames: DebugStackFrame[];
	totalFrames: number;
}

export interface DebugEvaluateResult {
	result: string;
	type: string;
	variablesReference: number;
	hasChildren: boolean;
}

export interface DebugExceptionInfo {
	id?: string;
	description?: string;
	breakMode: string | null;
}

export interface ConsoleOutputEntry {
	sessionId: string;
	text: string;
	source?: string;
	line?: number;
	column?: number;
}

export interface DebugConfiguration {
	name: string;
	type: string;
	request: DebugRequestType;
	folder?: string;
}

/**
 * What happened after start/continue/step/pause: the program stopped (where and why), ended, or is still running
 * when the wait ended. Reported from the debug session's real state, never assumed.
 */
export interface DebugStopInfo {
	state: 'stopped' | 'terminated' | 'running';
	threadId?: number;
	/** DAP stop reason: breakpoint, step, exception, pause, entry, ... */
	reason?: string;
	description?: string;
	/** exception text when stopped on an exception */
	text?: string;
	/** top frame of the stopped thread */
	location?: { name: string; sourcePath?: string; line: number; column: number; frameId: number };
	/** set when the wait timed out while the program was still running */
	waitedMs?: number;
}

export interface IDebugToolService {
	readonly _serviceBrand: undefined;

	// --- configurations ---
	listConfigurations(): Promise<{ configurations: DebugConfiguration[] }>;

	// --- sessions ---
	listSessions(): Promise<{ sessions: DebugSessionInfo[] }>;
	getSessionStatus(sessionId: string): Promise<DebugSessionInfo>;
	/**
	 * Start a configuration from launch.json by name, or an inline `configuration` object (no launch.json needed).
	 * Waits (bounded) for the program's first stop or its end and reports it in `stop`.
	 */
	startSession(configurationName: string | undefined, folder?: string, noDebug?: boolean, configuration?: Record<string, unknown>): Promise<DebugSessionInfo & { stop: DebugStopInfo }>;
	attachSession(configurationName: string, folder?: string): Promise<DebugSessionInfo & { stop: DebugStopInfo }>;
	stopSession(sessionId: string, restart?: boolean, suspend?: boolean): Promise<void>;
	restartSession(sessionId: string): Promise<void>;

	// --- execution control: each waits (bounded) for the next stop or the end, and reports it ---
	// threadId may be omitted: the stopped thread (or the only thread) is used
	continue(sessionId: string, threadId?: number): Promise<DebugStopInfo>;
	pause(sessionId: string, threadId?: number): Promise<DebugStopInfo>;
	stepOver(sessionId: string, threadId?: number): Promise<DebugStopInfo>;
	stepInto(sessionId: string, threadId?: number): Promise<DebugStopInfo>;
	stepOut(sessionId: string, threadId?: number): Promise<DebugStopInfo>;

	// --- breakpoints ---
	setBreakpoint(sessionId: string | undefined, uri: string, lineNumber: number, column?: number, condition?: string, hitCondition?: string, logMessage?: string): Promise<DebugBreakpoint>;
	removeBreakpoint(breakpointId: string): Promise<void>;
	setBreakpointEnabled(breakpointId: string, enabled: boolean): Promise<void>;
	listBreakpoints(): Promise<{ breakpoints: DebugBreakpoint[] }>;

	// --- inspection ---
	listThreads(sessionId: string): Promise<{ threads: DebugThread[] }>;
	getStackTrace(sessionId: string, threadId?: number, startFrame?: number, levels?: number): Promise<DebugStackTrace>;
	getScopes(sessionId: string, frameId: number, threadId?: number): Promise<{ scopes: DebugScope[] }>;
	getVariables(sessionId: string, variablesReference: number, start?: number, count?: number): Promise<{ variables: DebugVariable[] }>;
	evaluateExpression(sessionId: string, expression: string, frameId?: number): Promise<DebugEvaluateResult>;
	getExceptionInfo(sessionId: string, threadId?: number): Promise<DebugExceptionInfo>;

	// --- console ---
	getConsoleOutput(sessionId?: string, limit?: number): Promise<{ output: Array<{ sessionId: string; text: string; source?: string; line?: number; column?: number }> }>;
}

export const IDebugToolService = createDecorator<IDebugToolService>('kodiaDebugToolService');
