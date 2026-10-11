/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INotificationService, IPromptChoice, Severity } from '../../../../platform/notification/common/notification.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { APPLE_FOUNDATION_MODELS_DEFAULT_ENDPOINT, FM_CLI_PATH, FM_LICENSE_COMMAND } from '../common/appleFoundationModelsTypes.js';
import { IAppleFoundationModelsService } from '../common/appleFoundationModelsService.js';
import { IRefreshModelService } from '../common/refreshModelService.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';

export class AppleFoundationModelsWorkbenchContrib extends Disposable {
	static readonly ID = 'workbench.contrib.appleFoundationModels';

	private _didRun = false;

	constructor(
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IAppleFoundationModelsService private readonly appleFoundationModelsService: IAppleFoundationModelsService,
		@IRefreshModelService private readonly refreshModelService: IRefreshModelService,
		@INotificationService private readonly notificationService: INotificationService,
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super();

		this.voidSettingsService.waitForInitState.then(() => this._maybeBootstrap());
		this._register(this.voidSettingsService.onDidChangeState((e) => {
			if (typeof e === 'object' && e[1] === 'autoSetupAppleFoundationModels') {
				this._didRun = false;
				this._maybeBootstrap();
			}
		}));
	}

	private async _maybeBootstrap(): Promise<void> {
		if (this._didRun) {
			return;
		}
		if (!isMacintosh) {
			return;
		}
		if (!this.voidSettingsService.state.globalSettings.autoSetupAppleFoundationModels) {
			return;
		}

		this._didRun = true;

		const result = await this.appleFoundationModelsService.ensureReady({
			installIfMissing: true,
			startServer: true,
		});

		if (result.ok) {
			const endpoint = result.endpoint || APPLE_FOUNDATION_MODELS_DEFAULT_ENDPOINT;
			if (this.voidSettingsService.state.settingsOfProvider.appleFoundationModels.endpoint !== endpoint) {
				await this.voidSettingsService.setSettingOfProvider('appleFoundationModels', 'endpoint', endpoint);
			}
			this.refreshModelService.startRefreshingModels('appleFoundationModels', { enableProviderOnSuccess: true, doNotFire: false });
			return;
		}

		const retry: IPromptChoice = { label: 'Retry', run: () => this._retry() };

		if (result.reason === 'fm-license-required') {
			const notification = this.notificationService.prompt(
				Severity.Info,
				`Apple Foundation Models: Apple asks you to accept its terms once on this Mac before Kodia can use the on-device model. "Review and Accept" runs \`${FM_LICENSE_COMMAND}\` in the terminal: enter your Mac password, read the terms, then answer yes.`,
				// keepOpen: the notification stays (with Retry) if the user declines or closes the terminal
				[{ label: 'Review and Accept', keepOpen: true, run: () => this._acceptLicenseInTerminal(() => notification.close()) }, retry],
			);
			return;
		}

		const detail = result.errorMessage ?? result.log.join('\n');
		const message = detail ? `Apple: automatic setup failed\n${detail}` : 'Apple: automatic setup failed';
		this.notificationService.prompt(Severity.Warning, message, [retry]);
	}

	private _retry(): void {
		this._didRun = false;
		this._maybeBootstrap();
	}

	// fm only records the agreement from a real terminal (it refuses redirected input), so the user answers it there.
	// The terminal runs `sudo fm license` itself rather than a shell, and setup resumes as soon as it succeeds.
	private async _acceptLicenseInTerminal(onAccepted: () => void): Promise<void> {
		const terminal = await this.terminalService.createTerminal({
			location: TerminalLocation.Panel,
			config: { name: 'Apple terms', executable: '/usr/bin/sudo', args: [FM_CLI_PATH, 'license'] },
		});
		Event.once(terminal.onExit)(exitCode => {
			if (exitCode !== 0) {
				return; // declined, wrong password or closed: the notification is still there
			}
			onAccepted();
			this._retry();
		});
		this.terminalService.setActiveInstance(terminal);
		await this.terminalService.revealActiveTerminal();
		await this.terminalService.focusActiveInstance();
	}
}

registerWorkbenchContribution2(AppleFoundationModelsWorkbenchContrib.ID, AppleFoundationModelsWorkbenchContrib, WorkbenchPhase.AfterRestored);
