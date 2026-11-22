/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * A real debugging stack for tests: VS Code's DebugModel, DebugSession and RawDebugSession, with an
 * ExecutableDebugAdapter running a real DAP adapter process (Microsoft's debugpy) against a real Python program.
 *
 * Only the DebugService *orchestration* is replaced (ShimDebugService), because the real service needs the whole
 * workbench. The shim does what DebugService does for these paths — create the session, initialize it with the
 * adapter, launch, and send breakpoints through the session — by calling the same real session/model methods.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { FileAccess } from '../../../../../base/common/network.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { TestAccessibilityService } from '../../../../../platform/accessibility/test/common/testAccessibilityService.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IExtensionHostDebugService } from '../../../../../platform/debug/common/extensionHostDebug.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { ICustomEndpointTelemetryService, ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { TestContextService, TestFileService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { DebugSession } from '../../../debug/browser/debugSession.js';
import { IBreakpoint, IConfig, IDebugger, IDebugService, IDebugSession, IDebugSessionOptions, IExceptionBreakpoint } from '../../../debug/common/debug.js';
import { DebugModel } from '../../../debug/common/debugModel.js';
import { ExecutableDebugAdapter, SocketDebugAdapter } from '../../../debug/node/debugAdapter.js';
import { MockDebugStorage } from '../../../debug/test/common/mockDebug.js';
import { ITestService } from '../../../testing/common/testService.js';
import { ITestResultService } from '../../../testing/common/testResultService.js';

/** Adapter launchers by debug type (only what this machine has). */
const ADAPTERS: Record<string, { command: string; args: string[] }> = {
	debugpy: { command: 'python', args: ['-m', 'debugpy.adapter'] },
};

/**
 * Microsoft's js-debug (the adapter behind VS Code's "node"/"pwa-node"/"chrome" types), as its standalone DAP server:
 * the same adapter code the built-in extension runs. Fetched by `node scripts/kodia-fetch-js-debug-dap.mts`.
 */
export const JS_DEBUG_DAP_SERVER = path.join(FileAccess.asFileUri('').fsPath, '..', '.build', 'js-debug-dap', 'js-debug', 'src', 'dapDebugServer.js');
const JS_DEBUG_TYPES = new Set(['node', 'pwa-node', 'chrome', 'pwa-chrome']);

/** One js-debug server per harness; every session (parent and child) is its own connection, as in VS Code. */
class JsDebugServer {
	private port: Promise<number> | undefined;
	private proc: cp.ChildProcess | undefined;
	getPort(): Promise<number> {
		this.port ??= new Promise<number>((resolve, reject) => {
			if (!fs.existsSync(JS_DEBUG_DAP_SERVER)) { reject(new Error(`js-debug is not installed at ${JS_DEBUG_DAP_SERVER}; run: node scripts/kodia-fetch-js-debug-dap.mts`)); return; }
			const proc = this.proc = cp.spawn(process.execPath, [JS_DEBUG_DAP_SERVER, '0', '127.0.0.1'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
			let out = '';
			proc.stdout!.on('data', d => { out += d; const m = /listening at [\d.]+:(\d+)/.exec(out); if (m) { resolve(Number(m[1])); } });
			proc.stderr!.on('data', d => { out += d; });
			proc.on('exit', code => reject(new Error(`js-debug exited (${code}): ${out.slice(0, 500)}`)));
		});
		return this.port;
	}
	dispose() { this.proc?.kill(); }
}

export class ShimDebugService {
	readonly _serviceBrand: undefined;
	private readonly _onDidNewSession = new Emitter<IDebugSession>();
	readonly onDidNewSession = this._onDidNewSession.event;
	private readonly _onDidEndSession = new Emitter<{ session: IDebugSession; restart: boolean }>();
	readonly onDidEndSession = this._onDidEndSession.event;
	readonly onDidChangeState = Event.None;
	private instantiation!: InstantiationService;
	private readonly jsDebug = new JsDebugServer();

	constructor(readonly model: DebugModel, private readonly store: DisposableStore) { store.add(this._onDidNewSession); store.add(this._onDidEndSession); store.add(this.jsDebug); }
	setInstantiation(i: InstantiationService) { this.instantiation = i; }

	getModel() { return this.model; }
	getViewModel() { return { updateViews() { }, focusedSession: undefined, focusedStackFrame: undefined, focusedThread: undefined, setFocus() { }, onDidFocusSession: Event.None, onDidFocusStackFrame: Event.None } as any; }
	getConfigurationManager() { return { getLaunches: () => [], selectedConfiguration: { launch: undefined } } as any; }
	focusStackFrame() { return Promise.resolve(); }
	/** As DebugService: the session's adapter-declared exception filters become model exception breakpoints. */
	setExceptionBreakpointsForSession(session: IDebugSession, filters: DebugProtocol.ExceptionBreakpointsFilter[]) { this.model.setExceptionBreakpointsForSession(session.getId(), filters); }

	async sendExceptionBreakpoints(session?: IDebugSession) {
		for (const s of session ? [session] : this.model.getSessions()) {
			if (s.capabilities.supportsConfigurationDoneRequest && !s.capabilities.exceptionBreakpointFilters?.length) { continue; }
			await s.sendExceptionBreakpoints(this.model.getExceptionBreakpointsForSession(s.getId()).filter(e => e.enabled));
		}
	}

	async sendAllBreakpoints(session?: IDebugSession) {
		const uris = new Map<string, URI>();
		for (const bp of this.model.getBreakpoints()) { uris.set(bp.uri.toString(), bp.uri); }
		for (const uri of uris.values()) { await this.sendBreakpoints(uri, false, session); }
		await this.sendExceptionBreakpoints(session);
	}

	async sendBreakpoints(uri: URI, sourceModified = false, session?: IDebugSession) {
		const bps = this.model.getBreakpoints({ uri, enabledOnly: true }) as IBreakpoint[];
		for (const s of session ? [session] : this.model.getSessions()) { await s.sendBreakpoints(uri, bps, sourceModified); }
	}

	async addBreakpoints(uri: URI, raw: any[]) {
		const bps = this.model.addBreakpoints(uri, raw);
		await this.sendBreakpoints(uri);
		return bps;
	}

	async removeBreakpoints(id?: string) {
		const toRemove = this.model.getBreakpoints().filter(b => !id || b.getId() === id);
		this.model.removeBreakpoints(toRemove);
		for (const bp of toRemove) { await this.sendBreakpoints(bp.uri); }
	}

	async enableOrDisableBreakpoints(enable: boolean, bp?: IBreakpoint | IExceptionBreakpoint) {
		if (!bp) { return; }
		this.model.setEnablement(bp, enable);
		if ('filter' in bp) { await this.sendExceptionBreakpoints(); } else { await this.sendBreakpoints(bp.uri); }
	}

	async startDebugging(_launch: unknown, config: IConfig, options?: IDebugSessionOptions): Promise<boolean> {
		const adapter = ADAPTERS[config.type];
		const jsDebug = JS_DEBUG_TYPES.has(config.type);
		if (!adapter && !jsDebug) { return false; }
		// the js-debug extension contributes "node"/"chrome" as aliases and resolves them to its "pwa-*" types before the
		// adapter sees the configuration (its standalone server drops a "node" launch without answering)
		if (jsDebug && !config.type.startsWith('pwa-')) { config = { ...config, type: `pwa-${config.type}` }; }
		const dbgr = {
			type: config.type, label: config.type,
			createDebugAdapter: async () => jsDebug
				? new SocketDebugAdapter({ type: 'server', port: await this.jsDebug.getPort(), host: '127.0.0.1' })
				: new ExecutableDebugAdapter({ type: 'executable', command: adapter.command, args: adapter.args }, config.type),
			// js-debug runs the program in a child session it asks for with the DAP `startDebugging` reverse request
			// (RawDebugSession → IDebugger.startDebugging → IDebugService.startDebugging with the parent), as in common/debugger.ts
			startDebugging: (childConfig: IConfig, parentSessionId: string) => this.startDebugging(undefined, childConfig, { parentSession: this.model.getSession(parentSessionId) }),
			getCustomTelemetryEndpoint: () => undefined,
		} as unknown as IDebugger;
		const session = this.instantiation.createInstance(DebugSession, generateUuid(), { resolved: config, unresolved: config }, undefined, this.model, options);
		this.store.add(session);
		this.model.addSession(session);
		this._onDidNewSession.fire(session);
		this.store.add(session.onDidEndAdapter(() => this._onDidEndSession.fire({ session, restart: false })));
		await session.initialize(dbgr);
		await session.launchOrAttach(session.configuration);
		return true;
	}

	async stopSession(session: IDebugSession | undefined) { if (session) { await session.terminate(); } }
	async restartSession() { throw new Error('restart is not supported by the test shim'); }
}

/** Builds the real debug stack; the returned debugService is what KodiaDebugToolService is constructed with. */
export function createRealDebugStack(workspaceDir: string, store: DisposableStore) {
	const fileService = store.add(new TestFileService());
	const uriIdentity = store.add(new UriIdentityService(fileService));
	const storage = store.add(new TestStorageService());
	const model = store.add(new DebugModel(store.add(new MockDebugStorage(storage)), { isDirty: () => false } as any, uriIdentity, new NullLogService()));
	const debugService = new ShimDebugService(model, store);
	const noop = new Proxy({}, { get: () => () => undefined });
	const instantiation = store.add(new InstantiationService(new ServiceCollection(
		[IDebugService, debugService as any],
		[ITelemetryService, NullTelemetryService],
		[IHostService, { focus: async () => { }, hasFocus: true } as any],
		[IConfigurationService, new TestConfigurationService({ debug: { console: { collapseIdenticalLines: false }, showSubSessionsInToolBar: false } })],
		[IPaneCompositePartService, noop as any],
		[IWorkspaceContextService, new TestContextService(testWorkspace(URI.file(workspaceDir)))],
		[IProductService, { nameLong: 'Kodia (test)' } as any],
		[INotificationService, new TestNotificationService()],
		[ILifecycleService, { onWillShutdown: Event.None, onDidShutdown: Event.None } as any],
		[IUriIdentityService, uriIdentity],
		[ICustomEndpointTelemetryService, noop as any],
		[IWorkbenchEnvironmentService, {} as any],
		[ILogService, new NullLogService()],
		[ITestService, { cancelTestRun() { } } as any],
		[ITestResultService, { onResultsChanged: Event.None } as any],
		[IAccessibilityService, new TestAccessibilityService()],
		[IExtensionHostDebugService, { onAttachSession: Event.None, onTerminateSession: Event.None, onReload: Event.None, onClose: Event.None } as any],
		[IOpenerService, noop as any],
		[IDialogService, noop as any],
	), true));
	debugService.setInstantiation(instantiation);
	return { debugService, model, instantiation };
}
