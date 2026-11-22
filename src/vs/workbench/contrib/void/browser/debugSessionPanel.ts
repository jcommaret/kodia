/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Orientation } from '../../../../base/browser/ui/sash/sash.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	Extensions as ViewContainerExtensions, IViewContainersRegistry,
	ViewContainerLocation, IViewsRegistry, Extensions as ViewExtensions,
} from '../../../common/views.js';
import { IDebugService, State, getStateLabel, IDebugSession } from '../../debug/common/debug.js';
import * as nls from '../../../../nls.js';
import { IDebugToolService } from '../common/debugServiceTypes.js';

export const DEBUG_SESSION_PANEL_ID = 'workbench.view.debugSessionPanel';
export const DEBUG_SESSION_CONTAINER_ID = 'workbench.view.debugSessionContainer';

// ---------------------------------------------------------------------------
// View Pane
// ---------------------------------------------------------------------------

// @ts-ignore - ViewPane is abstract but extendable; same pattern as sidebarPane.ts
class DebugSessionViewPane extends ViewPane {

	private readonly debugService: IDebugService;
	private readonly debugToolService: IDebugToolService;
	private readonly disposables = new DisposableStore();

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IDebugService debugService: IDebugService,
		@IDebugToolService debugToolService: IDebugToolService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this.debugService = debugService;
		this.debugToolService = debugToolService;
	}

	protected override renderHeader(container: HTMLElement): void {
		// Header is rendered in renderBody
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		parent.style.overflow = 'auto';
		parent.style.userSelect = 'text';
		parent.style.padding = '8px';
		parent.style.display = 'flex';
		parent.style.flexDirection = 'column';
		parent.style.gap = '8px';

		// Header
		const header = document.createElement('div');
		header.style.display = 'flex';
		header.style.justifyContent = 'space-between';
		header.style.alignItems = 'center';
		header.style.fontWeight = '600';
		header.style.fontSize = '13px';
		header.style.color = 'var(--vscode-foreground)';
		header.innerHTML = `
			<span style="display:flex;align-items:center;gap:6px;">
				<span style="color:var(--vscode-debugIcon-startForeground)">🐛</span>
				Debug Sessions
			</span>
			<div id="kodia-debug-session-count" style="font-size:11px;opacity:0.7;"></div>
		`;
		parent.appendChild(header);

		// Controls toolbar
		const toolbar = document.createElement('div');
		toolbar.style.display = 'flex';
		toolbar.style.gap = '6px';
		toolbar.style.fontSize = '11px';
		toolbar.style.marginBottom = '4px';

		const btnRefresh = this.createToolbarBtn('↻', 'Refresh');
		const btnStart = this.createToolbarBtn('▶', 'Start Session', 'var(--vscode-button-primaryForeground)', 'var(--vscode-button-primaryBackground)');
		const btnStopAll = this.createToolbarBtn('⏹', 'Stop All');

		toolbar.appendChild(btnRefresh);
		toolbar.appendChild(btnStart);
		toolbar.appendChild(btnStopAll);
		parent.appendChild(toolbar);

		// Sessions list container
		const sessionsContainer = document.createElement('div');
		sessionsContainer.id = 'kodia-debug-sessions-list';
		sessionsContainer.style.display = 'flex';
		sessionsContainer.style.flexDirection = 'column';
		sessionsContainer.style.gap = '4px';
		parent.appendChild(sessionsContainer);

		// Empty state
		const emptyState = document.createElement('div');
		emptyState.id = 'kodia-debug-empty-state';
		emptyState.style.color = 'var(--vscode-descriptionForeground)';
		emptyState.style.fontSize = '12px';
		emptyState.style.opacity = '0.6';
		emptyState.textContent = 'No active debug sessions.';
		parent.appendChild(emptyState);

		// Event listeners
		this.disposables.add(this.debugService.onDidNewSession(() => this.render()));
		this.disposables.add(this.debugService.onDidEndSession(() => this.render()));
		this.disposables.add(this.debugService.onDidChangeState(() => this.render()));

		// Initial render
		this.render();

		// Wire up buttons
		btnRefresh.onclick = () => this.render();
		btnStart.onclick = async () => {
			try {
				const configs = await this.debugToolService.listConfigurations();
				if (configs.configurations.length > 0) {
					const first = configs.configurations[0];
					await this.debugToolService.startSession(first.name, first.folder);
				} else {
					alert('No debug configurations available. Add a launch.json to your workspace.');
				}
			} catch (e: any) {
				alert(`Failed to start session: ${e?.message || e}`);
			}
		};
		btnStopAll.onclick = async () => {
			for (const session of this.debugService.getModel().getSessions()) {
				try { await this.debugService.stopSession(session); } catch { }
			}
		};
	}

	private createToolbarBtn(text: string, title: string, color?: string, bg?: string): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.textContent = text;
		btn.title = title;
		btn.style.fontSize = '11px';
		btn.style.padding = '2px 6px';
		btn.style.border = '1px solid var(--vscode-button-border)';
		btn.style.borderRadius = '3px';
		btn.style.cursor = 'pointer';
		if (color) btn.style.color = color;
		if (bg) btn.style.backgroundColor = bg;
		return btn;
	}

	private override render(): void {
		const container = document.getElementById('kodia-debug-sessions-list');
		const emptyState = document.getElementById('kodia-debug-empty-state');
		const countEl = document.getElementById('kodia-debug-session-count');

		if (!container) return;

		const sessions = this.debugService.getModel().getSessions();
		countEl!.textContent = `(${sessions.length})`;

		if (sessions.length === 0) {
			emptyState!.style.display = 'block';
			container.innerHTML = '';
			return;
		}
		emptyState!.style.display = 'none';
		container.innerHTML = '';

		for (const session of sessions) {
			const sessionEl = this.createSessionElement(session);
			container.appendChild(sessionEl);
		}
	}

	private createSessionElement(session: IDebugSession): HTMLElement {
		const el = document.createElement('div');
		const sessionId = session.getId();
		const state = session.state;
		const config = session.configuration;

		const stateColor = state === State.Running ? 'var(--vscode-debugIcon-breakpointCurrentForeground)' :
			state === State.Stopped ? 'var(--vscode-debugIcon-breakpointForeground)' :
			state === State.Initializing ? 'var(--vscode-debugIcon-breakpointDisabledForeground)' :
			'var(--vscode-descriptionForeground)';

		el.style.border = '1px solid var(--vscode-widget-border)';
		el.style.borderRadius = '4px';
		el.style.padding = '8px';
		el.style.background = 'var(--vscode-editor-widget-background)';
		el.style.display = 'flex';
		el.style.flexDirection = 'column';
		el.style.gap = '4px';

		// Session header
		const header = document.createElement('div');
		header.style.display = 'flex';
		header.style.justifyContent = 'space-between';
		header.style.alignItems = 'center';

		const title = document.createElement('div');
		title.style.fontWeight = '600';
		title.style.fontSize = '12px';
		title.textContent = config.name;

		const stateBadge = document.createElement('span');
		stateBadge.style.fontSize = '10px';
		stateBadge.style.padding = '1px 6px';
		stateBadge.style.borderRadius = '3px';
		stateBadge.style.background = 'var(--vscode-dropdown-background)';
		stateBadge.style.color = stateColor;
		stateBadge.textContent = getStateLabel(state);

		header.appendChild(title);
		header.appendChild(stateBadge);
		el.appendChild(header);

		// Info row
		const info = document.createElement('div');
		info.style.fontSize = '11px';
		info.style.color = 'var(--vscode-descriptionForeground)';
		info.innerHTML = `<span style="opacity:0.7;">${config.type}</span> • ${config.request} • ID: ${sessionId.slice(0, 8)}`;
		el.appendChild(info);

		// Controls row
		const controls = document.createElement('div');
		controls.style.display = 'flex';
		controls.style.gap = '4px';
		controls.style.marginTop = '4px';

		const canControl = state === State.Stopped || state === State.Running;

		if (canControl) {
			const threads = session.getAllThreads();
			const firstThread = threads.length > 0 ? threads[0] : undefined;

			// continue/step act on the stopped thread (resolved by the service); pause targets a running thread
			const btnContinue = this.createSessionBtn('▶', 'Continue', async () => { await this.debugToolService.continue(sessionId); });
			const btnPause = this.createSessionBtn('⏸', 'Pause', async () => { if (firstThread) { await this.debugToolService.pause(sessionId, firstThread.threadId); } });
			const btnStepOver = this.createSessionBtn('⇥', 'Step Over', async () => { await this.debugToolService.stepOver(sessionId); });
			const btnStepInto = this.createSessionBtn('⇣', 'Step Into', async () => { await this.debugToolService.stepInto(sessionId); });
			const btnStepOut = this.createSessionBtn('⇪', 'Step Out', async () => { await this.debugToolService.stepOut(sessionId); });
			const btnStop = this.createSessionBtn('⏹', 'Stop', () => this.debugService.stopSession(session));

			controls.appendChild(btnContinue);
			controls.appendChild(btnPause);
			controls.appendChild(btnStepOver);
			controls.appendChild(btnStepInto);
			controls.appendChild(btnStepOut);
			controls.appendChild(btnStop);
		} else {
			controls.textContent = 'Session initializing...';
			controls.style.fontSize = '11px';
			controls.style.color = 'var(--vscode-descriptionForeground)';
		}
		el.appendChild(controls);

		// Stack trace (expandable)
		if (state === State.Stopped) {
			const stackEl = document.createElement('div');
			stackEl.style.fontSize = '11px';
			stackEl.style.color = 'var(--vscode-foreground)';
			stackEl.style.marginTop = '4px';
			stackEl.innerHTML = '<div style="font-weight:600;margin-bottom:2px;">Call Stack</div>';
			el.appendChild(stackEl);

			this.loadStackTrace(sessionId, stackEl);
		}

		return el;
	}

	private createSessionBtn(text: string, title: string, action: () => Promise<void>): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.textContent = text;
		btn.title = title;
		btn.style.fontSize = '10px';
		btn.style.padding = '1px 5px';
		btn.style.border = '1px solid var(--vscode-button-border)';
		btn.style.borderRadius = '3px';
		btn.style.cursor = 'pointer';
		btn.style.background = 'var(--vscode-button-secondaryBackground)';
		btn.style.color = 'var(--vscode-button-secondaryForeground)';
		btn.onclick = async () => {
			try {
				await action();
			} catch (e: any) {
				alert(`Debug operation failed: ${e?.message || e}`);
			}
		};
		return btn;
	}

	private async loadStackTrace(sessionId: string, container: HTMLElement): Promise<void> {
		try {
			const threads = await this.debugToolService.listThreads(sessionId);
			if (threads.threads.length === 0) {
				container.innerHTML += '<div style="opacity:0.6;">No threads</div>';
				return;
			}

			const thread = threads.threads[0];
			if (!thread.stopped) {
				container.innerHTML += '<div style="opacity:0.6;">Thread not stopped</div>';
				return;
			}

			const trace = await this.debugToolService.getStackTrace(sessionId, thread.threadId, 0, 10);
			for (const frame of trace.frames.slice(0, 5)) {
				const frameEl = document.createElement('div');
				frameEl.style.display = 'flex';
				frameEl.style.gap = '6px';
				frameEl.style.fontSize = '11px';
				frameEl.style.marginBottom = '2px';
				frameEl.innerHTML = `
					<span style="font-family:monospace;opacity:0.8;">Frame ${frame.frameId}</span>
					<span style="font-weight:500;">${frame.name}</span>
					<span style="opacity:0.6;">${frame.sourceName || '?'}:${frame.line}</span>
				`;
				container.appendChild(frameEl);
			}
		} catch {
			container.innerHTML += '<div style="color:var(--vscode-errorForeground);">Failed to load stack trace</div>';
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	override dispose(): void {
		this.disposables.dispose();
		super.dispose();
	}
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

// Register view container
const container = viewContainerRegistry.registerViewContainer({
	id: DEBUG_SESSION_CONTAINER_ID,
	title: nls.localize2('debugSessionContainer', 'Debug'),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [DEBUG_SESSION_CONTAINER_ID, {
		mergeViewWithContainerWhenSingleView: true,
		orientation: Orientation.HORIZONTAL,
	}]),
	hideIfEmpty: false,
	order: 2,
	icon: Codicon.debug,
}, ViewContainerLocation.AuxiliaryBar);

// Register view
viewsRegistry.registerViews([{
	id: DEBUG_SESSION_PANEL_ID,
	hideByDefault: true,
	name: nls.localize2('debugSessionPanel', 'Debug Sessions'),
	ctorDescriptor: new SyncDescriptor(DebugSessionViewPane),
	canToggleVisibility: true,
	canMoveView: true,
	weight: 90,
	order: 1,
}], container);
