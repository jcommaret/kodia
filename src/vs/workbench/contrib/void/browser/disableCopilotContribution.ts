/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { areSameExtensions } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { EnablementState } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IExtensionsWorkbenchService } from '../../extensions/common/extensions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ChatConfiguration } from '../../chat/common/constants.js';

const COPILOT_EXTENSION_IDS = [
	'GitHub.copilot-chat',
	'github.copilot-chat',
	'github.copilot',
];

export class DisableCopilotContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voidDisableCopilot';

	constructor(
		@IExtensionsWorkbenchService private readonly extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.initialize();
	}

	private async initialize(): Promise<void> {
		if (this.configurationService.getValue<boolean>(ChatConfiguration.AIDisabled) !== true) {
			await this.configurationService.updateValue(ChatConfiguration.AIDisabled, true);
		}

		await this.extensionsWorkbenchService.queryLocal();

		for (const extension of this.extensionsWorkbenchService.local) {
			if (!COPILOT_EXTENSION_IDS.some(id => areSameExtensions(extension.identifier, { id }))) {
				continue;
			}

			if (
				extension.enablementState !== EnablementState.DisabledGlobally &&
				extension.enablementState !== EnablementState.DisabledWorkspace
			) {
				await this.extensionsWorkbenchService.setEnablement([extension], EnablementState.DisabledGlobally);
			}
		}
	}
}

registerWorkbenchContribution2(DisableCopilotContribution.ID, DisableCopilotContribution, WorkbenchPhase.AfterRestored);
