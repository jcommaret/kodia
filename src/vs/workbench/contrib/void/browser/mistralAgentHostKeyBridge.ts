/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { AgentHostMistralApiKeySettingId, AgentHostMistralResource, IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';

/**
 * Makes the Mistral agent in the Agents Window reuse the Mistral API key the
 * user already configured in Void Settings — without re-entering it and without
 * an extra restart.
 *
 * The agent host runs in a separate process that cannot read Void's
 * renderer-side encrypted settings store. This renderer contribution reads the
 * decrypted key and pushes it to the running agent host via
 * `IAgentHostService.authenticate({ resource, token })` (the agent advertises
 * {@link AgentHostMistralResource} so the host routes the key to it). It
 * re-pushes whenever the key changes and whenever the agent host (re)starts, so
 * a cold start picks it up on the first launch.
 *
 * If the user set the dedicated `chat.agentHost.mistralAgent.apiKey` setting
 * explicitly, that is treated as an override and this bridge stays out of the
 * way.
 */
class MistralAgentHostKeyBridge extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.void.mistralAgentHostKeyBridge';

	private _lastPushed: string | undefined;
	/** Absent in web, where there is no agent host. */
	private readonly _agentHostService: IAgentHostService | undefined;

	constructor(
		@IVoidSettingsService private readonly _voidSettingsService: IVoidSettingsService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		// IAgentHostService is desktop-only; resolve it optionally so this
		// contribution is harmless in web builds.
		try {
			this._agentHostService = instantiationService.invokeFunction(accessor => accessor.get(IAgentHostService));
		} catch {
			this._agentHostService = undefined;
		}
		if (!this._agentHostService) {
			return;
		}
		this._push();
		this._register(this._voidSettingsService.onDidChangeState(() => this._push()));
		// Re-push on (re)start so the running agent host always has the key, even
		// though it boots before this renderer contribution.
		this._register(this._agentHostService.onAgentHostStart(() => { this._lastPushed = undefined; this._push(); }));
	}

	private _push(): void {
		// Respect an explicit per-agent override.
		const override = this._configurationService.getValue<string>(AgentHostMistralApiKeySettingId);
		if (override) {
			return;
		}
		const voidKey = this._voidSettingsService.state.settingsOfProvider.mistral?.apiKey ?? '';
		if (!voidKey || voidKey === this._lastPushed) {
			return;
		}
		this._lastPushed = voidKey;
		this._agentHostService!.authenticate({ resource: AgentHostMistralResource, token: voidKey })
			.catch(err => this._logService.warn(`[Mistral] Failed to push Mistral key to the agent host: ${err}`));
	}
}

registerWorkbenchContribution2(MistralAgentHostKeyBridge.ID, MistralAgentHostKeyBridge, WorkbenchPhase.AfterRestored);
