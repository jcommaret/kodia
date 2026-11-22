/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { IChatThreadService } from './chatThreadService.js';
import { KODIA_CYCLE_AUTONOMY_ACTION_ID } from './kodiaEditorActions.js';
import { VOID_OPEN_SETTINGS_ACTION_ID } from './voidSettingsPane.js';

export class KodiaStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.kodiaStatusBar';

	private readonly _modelEntry: IStatusbarEntryAccessor;
	private readonly _autonomyEntry: IStatusbarEntryAccessor;

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
	) {
		super();

		this._modelEntry = this._register(statusbarService.addEntry(
			this._buildModelEntry(),
			'kodia.statusbar.model',
			StatusbarAlignment.RIGHT,
			102,
		));

		this._autonomyEntry = this._register(statusbarService.addEntry(
			this._buildAutonomyEntry(),
			'kodia.statusbar.autonomy',
			StatusbarAlignment.RIGHT,
			101,
		));

		this._register(this._settingsService.onDidChangeState(() => {
			this._modelEntry.update(this._buildModelEntry());
			this._autonomyEntry.update(this._buildAutonomyEntry());
		}));

		let lastRunning = this._isAnyThreadRunning();
		this._register(this._chatThreadService.onDidChangeStreamState(() => {
			const nowRunning = this._isAnyThreadRunning();
			if (nowRunning !== lastRunning) {
				lastRunning = nowRunning;
				this._modelEntry.update(this._buildModelEntry());
			}
		}));
	}

	private _isAnyThreadRunning(): boolean {
		const ss = this._chatThreadService.streamState;
		for (const tid of Object.keys(ss)) {
			if (ss[tid]?.isRunning) { return true; }
		}
		return false;
	}

	private _buildModelEntry() {
		const running = this._isAnyThreadRunning();
		const sel = this._settingsService.state.modelSelectionOfFeature.Chat;
		const shortModel = sel ? (sel.modelName.split('/').pop() ?? sel.modelName).slice(0, 26) : 'No Model';
		return {
			name: 'Kodia AI Model',
			text: running ? `$(sync~spin) Kodia · ${shortModel}` : `$(sparkle) Kodia · ${shortModel}`,
			ariaLabel: running ? `Kodia Agent running with ${shortModel}` : `Kodia AI model ${shortModel}`,
			tooltip: sel
				? `Kodia AI (${sel.providerName} / ${sel.modelName}) — Click to open Kodia Settings`
				: 'Kodia AI — Click to configure a model provider',
			command: VOID_OPEN_SETTINGS_ACTION_ID,
		};
	}

	private _buildAutonomyEntry() {
		const mode = this._settingsService.state.globalSettings.agentAutonomyMode ?? 'agent';
		const icon = mode === 'autonomous' ? '$(zap)' : mode === 'agent' ? '$(rocket)' : '$(shield)';
		const label = mode === 'autonomous' ? 'Auto' : mode === 'agent' ? 'Agent' : 'Assist';
		return {
			name: 'Kodia Autonomy Mode',
			text: `${icon} ${label}`,
			ariaLabel: `Kodia Autonomy Mode: ${label}`,
			tooltip: `Kodia Autonomy Mode: ${label} — Click to cycle Assist / Agent / Auto`,
			command: KODIA_CYCLE_AUTONOMY_ACTION_ID,
		};
	}
}

registerWorkbenchContribution2(KodiaStatusBarContribution.ID, KodiaStatusBarContribution, WorkbenchPhase.AfterRestored);
