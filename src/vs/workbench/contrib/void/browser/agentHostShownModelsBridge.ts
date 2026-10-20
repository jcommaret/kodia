/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { CLAUDE_AGENT_PROVIDER_ID, CODEX_AGENT_PROVIDER_ID } from '../../../../platform/agentHost/common/agent.js';
import { AgentHostShownModelsConfigKey } from '../../../../platform/agentHost/common/agentHostSchema.js';
import { IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { AgentHostRootConfigForwarder } from '../../chat/browser/agentSessions/agentHost/agentHostRootConfigForwarder.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { ProviderName } from '../common/voidSettingsTypes.js';

/** The Kodia provider whose models each Agents Window agent runs. */
const KODIA_PROVIDER_OF_AGENT: Readonly<Record<string, ProviderName>> = {
	[CLAUDE_AGENT_PROVIDER_ID]: 'anthropic',
	[CODEX_AGENT_PROVIDER_ID]: 'openAI',
	mistral: 'mistral',
};

/**
 * Makes the Agents Window offer only the models shown in Kodia's model dropdown
 * ("Show in Dropdown" in Void Settings).
 *
 * Forwards, per agent, the dropdown's models of the Kodia provider that agent
 * runs to the local agent host's root config ({@link AgentHostShownModelsConfigKey}),
 * where the host filters every agent's models by them. An agent whose provider
 * is not set up in Kodia has no dropdown entries and gets no entry, so it keeps
 * its own catalog: Claude and Codex can sign in on their own.
 */
class AgentHostShownModelsBridge extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.void.agentHostShownModelsBridge';

	constructor(
		@IVoidSettingsService private readonly _voidSettingsService: IVoidSettingsService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		// IAgentHostService is desktop-only; resolve it optionally so this
		// contribution is harmless in web builds.
		let agentHostService: IAgentHostService | undefined;
		try {
			agentHostService = instantiationService.invokeFunction(accessor => accessor.get(IAgentHostService));
		} catch {
			agentHostService = undefined;
		}
		if (!agentHostService) {
			return;
		}
		const forwarder = this._register(new AgentHostRootConfigForwarder([{
			key: AgentHostShownModelsConfigKey,
			computeValue: () => this._shownModels(),
			registerTriggers: (store, push) => store.add(this._voidSettingsService.onDidChangeState(push)),
		}], agentHostService));
		forwarder.start();
	}

	private async _shownModels(): Promise<Record<string, string[]>> {
		await this._voidSettingsService.waitForInitState;
		const { settingsOfProvider, _modelOptions } = this._voidSettingsService.state;
		const shown: Record<string, string[]> = {};
		for (const [agent, providerName] of Object.entries(KODIA_PROVIDER_OF_AGENT)) {
			if (!settingsOfProvider[providerName]?._didFillInProviderSettings) {
				continue;
			}
			shown[agent] = _modelOptions
				.filter(option => option.selection.providerName === providerName)
				.map(option => option.selection.modelName);
		}
		return shown;
	}
}

registerWorkbenchContribution2(AgentHostShownModelsBridge.ID, AgentHostShownModelsBridge, WorkbenchPhase.AfterRestored);
