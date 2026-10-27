/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { IntervalTimer, RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { freeCodingModelsOfOpenRouter, OPENROUTER_MODELS_URL, OpenRouterModel } from '../common/openRouterFreeModels.js';
import { detectedModelsOfProvider, ListableProviderName, listableProviderNames } from '../common/providerModels.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const KEY_CHANGE_DELAY_MS = 2_000; // a key being typed or pasted

// Kodia: lists in each provider's section, switched off, the models its API has that Kodia's catalog doesn't, with the
// capabilities the API gives: OpenRouter's free models that can run the agent (its list is public), and the chat models
// of every provider with an API key. At startup, then every day, and when a key changes.
export class ProviderModelsContrib extends Disposable {
	static readonly ID = 'workbench.contrib.kodia.providerModels';

	private readonly _refreshOnKeyChange = new Map<ListableProviderName, RunOnceScheduler>();

	constructor(
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IRequestService private readonly requestService: IRequestService,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.voidSettingsService.waitForInitState.then(() => {
			this._refreshAll();
			let apiKeys = this._apiKeys();
			this._register(this.voidSettingsService.onDidChangeState(() => {
				const newApiKeys = this._apiKeys();
				for (const providerName of listableProviderNames) {
					if (newApiKeys[providerName] !== apiKeys[providerName]) {
						this._keyChangeScheduler(providerName).schedule();
					}
				}
				apiKeys = newApiKeys;
			}));
		});
		this._register(new IntervalTimer()).cancelAndSet(() => this._refreshAll(), REFRESH_INTERVAL_MS, mainWindow);
	}

	private _apiKeys(): Record<ListableProviderName, string> {
		const { settingsOfProvider } = this.voidSettingsService.state;
		return Object.fromEntries(listableProviderNames.map(providerName => [providerName, settingsOfProvider[providerName].apiKey])) as Record<ListableProviderName, string>;
	}

	private _keyChangeScheduler(providerName: ListableProviderName): RunOnceScheduler {
		let scheduler = this._refreshOnKeyChange.get(providerName);
		if (!scheduler) {
			scheduler = this._register(new RunOnceScheduler(() => this._refreshProvider(providerName), KEY_CHANGE_DELAY_MS));
			this._refreshOnKeyChange.set(providerName, scheduler);
		}
		return scheduler;
	}

	private _refreshAll(): void {
		this._refreshOpenRouter();
		for (const providerName of listableProviderNames) {
			this._refreshProvider(providerName);
		}
	}

	private async _refreshProvider(providerName: ListableProviderName): Promise<void> {
		const { apiKey } = this.voidSettingsService.state.settingsOfProvider[providerName];
		if (!apiKey) {
			return;
		}
		const models = await this.llmMessageService.listProviderModels(providerName, apiKey);
		if (!models) {
			// the provider couldn't be reached, or refused the key: keep the models found last time
			this.logService.info(`[Kodia] Could not list ${providerName}'s models`);
			return;
		}
		this.voidSettingsService.setDetectedModels(providerName, detectedModelsOfProvider(providerName, models));
	}

	private async _refreshOpenRouter(): Promise<void> {
		try {
			const context = await this.requestService.request({ type: 'GET', url: OPENROUTER_MODELS_URL, callSite: 'kodia.openRouterFreeModels' }, CancellationToken.None);
			const models = (await asJson<{ data?: OpenRouterModel[] }>(context))?.data;
			if (!Array.isArray(models)) {
				return;
			}
			this.voidSettingsService.setDetectedModels('openRouter', freeCodingModelsOfOpenRouter(models, Date.now()));
		} catch (e) {
			// offline, or OpenRouter is down: keep the models found last time
			this.logService.info('[Kodia] Could not list OpenRouter\'s free models', e);
		}
	}
}

registerWorkbenchContribution2(ProviderModelsContrib.ID, ProviderModelsContrib, WorkbenchPhase.Eventually);
