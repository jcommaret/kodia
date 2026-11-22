/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IDebugService, IDebugSession, IDebugModel, IConfigurationManager, IConfig, State } from '../../../debug/common/debug.js';
import { KodiaDebugToolService } from '../../../void/browser/debugToolService.js';


// ---------------------------------------------------------------------------
// Mocks for VS Code's IDebugService / debug model (deterministic, no real adapter)
// ---------------------------------------------------------------------------

class MockEvent {
	private listeners: Array<(e: any) => void> = [];
	fire(e: any): void {
		for (const l of this.listeners) l(e);
	}
	// Event<T> signature: (listener, thisArgs?, disposables?) => IDisposable
	listen(listener: (e: any) => void): IDisposable {
		this.listeners.push(listener);
		return toDisposable(() => {
			this.listeners = this.listeners.filter(l => l !== listener);
		});
	}
}

function mockSession(sessionId: string, configType: string, configName: string, request: 'launch' | 'attach', state: State = State.Stopped): IDebugSession {
	const configuration: IConfig = { type: configType, request, name: configName };
	const session: IDebugSession = {
		getId: () => sessionId,
		configuration,
		state,
		name: configName,
		root: undefined,
		getAllThreads: () => [
			{ threadId: 1, name: 'Main Thread', stateLabel: 'stopped', stopped: true, getCallStack: () => [], clearCallStack: () => {} },
		],
		stackTrace: async () => ({ body: { stackFrames: [], totalFrames: 0 } }),
		scopes: async () => ({ body: { scopes: [] } }),
		variables: async () => ({ body: { variables: [] } }),
		evaluate: async () => ({ body: { result: '42', type: 'number', variablesReference: 0 } }),
		exceptionInfo: async () => undefined,
		continue: async () => { },
		pause: async () => { },
		next: async () => { },
		stepIn: async () => { },
		stepOut: async () => { },
		terminate: async () => { },
		disconnect: async () => { },
		restart: async () => { },
		getSource: () => ({} as any),
		getSourceForUri: () => undefined,
		setConfiguration: () => { },
		rawUpdate: () => { },
		getThread: () => undefined,
		clearThreads: () => { },
		getStoppedDetails: () => undefined,
		getReplElements: () => [],
		hasSeparateRepl: () => false,
		removeReplExpressions: () => { },
		addReplExpression: async () => { },
		appendToRepl: () => { },
		cancelCorrelatedTestRun: () => { },
		onDidEndAdapter: new MockEvent().listen.bind(new MockEvent()),
		onDidChangeState: new MockEvent().listen.bind(new MockEvent()),
		onDidChangeReplElements: new MockEvent().listen.bind(new MockEvent()),
		onDidLoadedSource: new MockEvent().listen.bind(new MockEvent()),
		onDidCustomEvent: new MockEvent().listen.bind(new MockEvent()),
		onDidProgressStart: new MockEvent().listen.bind(new MockEvent()),
		onDidProgressUpdate: new MockEvent().listen.bind(new MockEvent()),
		onDidProgressEnd: new MockEvent().listen.bind(new MockEvent()),
		onDidInvalidateMemory: new MockEvent().listen.bind(new MockEvent()),
		initialize: async () => { },
		launchOrAttach: async () => { },
		restartFrame: async () => { },
		sendBreakpoints: async () => { },
		sendFunctionBreakpoints: async () => { },
		dataBreakpointInfo: async () => undefined,
		dataBytesBreakpointInfo: async () => undefined,
		sendDataBreakpoints: async () => { },
		sendInstructionBreakpoints: async () => { },
		sendExceptionBreakpoints: async () => { },
		breakpointsLocations: async () => [],
		getDebugProtocolBreakpoint: () => undefined,
		resolveLocationReference: async () => ({ line: 0, column: 0, source: {} as any }),
		cancel: async () => undefined,
		disassemble: async () => undefined,
		readMemory: async () => undefined,
		writeMemory: async () => undefined,
		completions: async () => undefined,
		setVariable: async () => undefined,
		setExpression: async () => undefined,
		loadSource: async () => undefined,
		getLoadedSources: async () => [],
		gotoTargets: async () => undefined,
		goto: async () => undefined,
		dispose: () => { },
		capabilities: {},
		rememberedCapabilities: undefined,
		setSubId: () => { },
		setName: () => { },
		onDidChangeName: new MockEvent().listen.bind(new MockEvent()),
		getLabel: () => configName,
		autoExpandLazyVariables: true,
		suppressDebugToolbar: false,
		suppressDebugStatusbar: false,
		suppressDebugView: false,
		lifecycleManagedByParent: false,
		compact: false,
		compoundRoot: undefined,
		saveBeforeRestart: false,
	} as any;
	return session;
}

function mockDebugService(sessions: IDebugSession[]): IDebugService {
	const model: IDebugModel = {
		getSession: (sessionId: string) => sessions.find(s => s.getId() === sessionId),
		getSessions: () => sessions,
		getBreakpoints: () => [],
		getFunctionBreakpoints: () => [],
		getDataBreakpoints: () => [],
		getExceptionBreakpoints: () => [],
		getExceptionBreakpointsForSession: () => [],
		getInstructionBreakpoints: () => [],
		getWatchExpressions: () => [],
		registerBreakpointModes: () => { },
		getBreakpointModes: () => [],
		onDidChangeBreakpoints: new MockEvent().listen.bind(new MockEvent()),
		onDidChangeCallStack: new MockEvent().listen.bind(new MockEvent()),
		onDidChangeWatchExpressions: new MockEvent().listen.bind(new MockEvent()),
		onDidChangeWatchExpressionValue: new MockEvent().listen.bind(new MockEvent()),
		fetchCallstack: async () => { },
	} as any;

	const onDidNewSession = new MockEvent();
	const configManager: IConfigurationManager = {
		getLaunches: () => [],
		getLaunch: () => undefined,
		getAllConfigurations: () => [],
		selectedConfiguration: { launch: undefined, getConfig: async () => undefined, name: undefined, type: undefined },
		selectConfiguration: async () => { },
		removeRecentDynamicConfigurations: () => { },
		getRecentDynamicConfigurations: () => [],
		hasDebugConfigurationProvider: () => false,
		getDynamicProviders: async () => [],
		getDynamicConfigurationsByType: async () => [],
		registerDebugConfigurationProvider: () => toDisposable(() => { }),
		unregisterDebugConfigurationProvider: () => { },
		resolveConfigurationByProviders: async () => null,
		onDidSelectConfiguration: new MockEvent().listen.bind(new MockEvent()),
		onDidChangeConfigurationProviders: new MockEvent().listen.bind(new MockEvent()),
	} as any;

	for (const s of sessions) {
		onDidNewSession.fire(s);
	}

	return {
		getModel: () => model,
		getConfigurationManager: () => configManager,
		startDebugging: async () => true,
		stopSession: async () => { },
		restartSession: async () => { },
		addBreakpoints: async () => [],
		removeBreakpoints: async () => { },
		enableOrDisableBreakpoints: async () => { },
		state: State.Stopped,
		initializingOptions: undefined,
		onDidChangeState: new MockEvent().listen.bind(new MockEvent()),
		onWillNewSession: new MockEvent().listen.bind(new MockEvent()),
		onDidNewSession: onDidNewSession.listen.bind(onDidNewSession),
		onDidEndSession: new MockEvent().listen.bind(new MockEvent()),
		focusStackFrame: async () => { },
		canSetBreakpointsIn: () => true,
		updateBreakpoints: async () => { },
		setBreakpointsActivated: async () => { },
		setExceptionBreakpointCondition: async () => { },
		setExceptionBreakpointsForSession: () => { },
		sendAllBreakpoints: async () => { },
		sendBreakpoints: async () => { },
		addWatchExpression: () => { },
		renameWatchExpression: () => { },
		moveWatchExpression: () => { },
		removeWatchExpressions: () => { },
		sourceIsNotAvailable: () => { },
		runTo: async () => { },
	} as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('Kodia - Debug Tool Service (mocked adapter)', () => {
	let service: KodiaDebugToolService;
	let debugService: IDebugService;

	setup(() => {
		const sessions: IDebugSession[] = [mockSession('session-1', 'node', 'Launch Node', 'launch', State.Stopped)];
		debugService = mockDebugService(sessions);
		service = new KodiaDebugToolService(debugService);
	});

	teardown(() => {
		service.dispose();
	});

	test('listSessions returns active sessions', async () => {
		const { sessions } = await service.listSessions();
		assert.strictEqual(sessions.length, 1);
		assert.strictEqual(sessions[0].sessionId, 'session-1');
		assert.strictEqual(sessions[0].state, 'stopped');
		assert.strictEqual(sessions[0].type, 'node');
		assert.strictEqual(sessions[0].request, 'launch');
	});

	test('getSessionStatus returns session state', async () => {
		const status = await service.getSessionStatus('session-1');
		assert.strictEqual(status.sessionId, 'session-1');
		assert.strictEqual(status.state, 'stopped');
	});

	test('getSessionStatus throws for unknown session', async () => {
		let threw = false;
		try { await service.getSessionStatus('nope'); } catch { threw = true; }
		assert.ok(threw, 'expected throw for unknown session');
	});

	test('listConfigurations returns configurations', async () => {
		const { configurations } = await service.listConfigurations();
		assert.ok(Array.isArray(configurations));
	});

	// Breakpoints (set / list / remove by id), start/continue/step/pause with stop reporting, and console capture are
	// verified against a REAL DAP adapter (debugpy) in test/electron-browser/debugTools.test.ts. The mock-based versions
	// that used to be here asserted the previous implementation's calls on mocks that do not follow the real API
	// (breakpoints without getId(), sessions that never stop or start), so they were removed.

	test('setBreakpointEnabled toggles a breakpoint', async () => {
		let seen: { id: string; enabled: boolean } | undefined;
		const bp = { getId: () => 'bp-1', enabled: false } as any;
		(debugService.getModel() as any).getBreakpoints = () => [bp];
		(debugService as any).enableOrDisableBreakpoints = async (enable: boolean, b: any) => { seen = { id: b.getId(), enabled: enable }; };
		await service.setBreakpointEnabled('bp-1', true);
		assert.ok(seen, 'enableOrDisableBreakpoints should be called');
		assert.strictEqual(seen.enabled, true);
	});

	test('listThreads returns threads', async () => {
		const { threads } = await service.listThreads('session-1');
		assert.strictEqual(threads.length, 1);
		assert.strictEqual(threads[0].threadId, 1);
		assert.strictEqual(threads[0].stopped, true);
	});

	test('getStackTrace returns frames', async () => {
		(debugService.getModel().getSession('session-1') as any).stackTrace = async () => ({
			body: { stackFrames: [{ id: 0, name: 'main', source: { path: '/repo/app.js', name: 'app.js' }, line: 5, column: 1 }], totalFrames: 1 },
		});
		const { frames, totalFrames } = await service.getStackTrace('session-1', 1);
		assert.strictEqual(frames.length, 1);
		assert.strictEqual(frames[0].name, 'main');
		assert.strictEqual(frames[0].sourcePath, '/repo/app.js');
		assert.strictEqual(totalFrames, 1);
	});

	test('getScopes returns scopes', async () => {
		(debugService.getModel().getSession('session-1') as any).scopes = async () => ({
			body: { scopes: [{ name: 'local', variablesReference: 3, expensive: false, hasChildren: true }] },
		});
		const { scopes } = await service.getScopes('session-1', 0);
		assert.strictEqual(scopes.length, 1);
		assert.strictEqual(scopes[0].name, 'local');
		assert.strictEqual(scopes[0].variablesReference, 3);
	});

	test('getVariables returns variables', async () => {
		(debugService.getModel().getSession('session-1') as any).variables = async () => ({
			body: { variables: [{ name: 'x', value: '1', type: 'number', variablesReference: 0 }] },
		});
		const { variables } = await service.getVariables('session-1', 3);
		assert.strictEqual(variables.length, 1);
		assert.strictEqual(variables[0].name, 'x');
		assert.strictEqual(variables[0].value, '1');
		assert.strictEqual(variables[0].hasChildren, false);
	});

	test('evaluateExpression returns result', async () => {
		(debugService.getModel().getSession('session-1') as any).evaluate = async () => ({
			body: { result: '42', type: 'number', variablesReference: 0 },
		});
		const result = await service.evaluateExpression('session-1', 'x + 1');
		assert.strictEqual(result.result, '42');
		assert.strictEqual(result.type, 'number');
		assert.strictEqual(result.hasChildren, false);
	});

	test('getExceptionInfo returns exception', async () => {
		(debugService.getModel().getSession('session-1') as any).exceptionInfo = async () => ({
			id: 'Error', description: 'boom', breakMode: 'always',
		});
		const info = await service.getExceptionInfo('session-1', 1);
		assert.strictEqual(info.id, 'Error');
		assert.strictEqual(info.description, 'boom');
		assert.strictEqual(info.breakMode, 'always');
	});

	test('getConsoleOutput returns buffered output', async () => {
		const { output } = await service.getConsoleOutput();
		assert.ok(Array.isArray(output));
		assert.strictEqual(output.length, 0);
	});

});
