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
import { defaultModelsOfProvider } from '../common/modelCapabilities.js';
import { freeCodingModelsOfOpenRouter, mostUsedModelsOfOpenRouter, OPENROUTER_MODELS_BY_USAGE_URL, OpenRouterModel, stillListedModelsOfOpenRouter } from '../common/openRouterModels.js';
import { detectedModelsOfProvider, ListableProviderName, listableProviderNames, mostUsedModelNames } from '../common/providerModels.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const KEY_CHANGE_DELAY_MS = 2_000; // a key being typed or pasted
const MOST_USED_COUNT = 5;
const BEST_FREE_COUNT = 5;

// the providers whose key changes what Kodia lists
const keyedProviderNames = [...listableProviderNames, 'openRouter'] as const;
type KeyedProviderName = typeof keyedProviderNames[number];

// Kodia: lists in each provider's section, besides its default model, the models its API has, with the capabilities
// the API gives: for OpenRouter, the 5 best free models for code and the 5 most used others that can run the agent;
// for every provider with an API key, its chat models. These OpenRouter models and each provider's 5 most used on
// OpenRouter last week start switched on, the others switched off. At startup, then every day, and when a key changes.
// Kodia reads OpenRouter's list (public) only once a provider has a key: until then, it contacts no one.
export class ProviderModelsContrib extends Disposable {
	static readonly ID = 'workbench.contrib.kodia.providerModels';

	private readonly _refreshOnKeyChange = new Map<KeyedProviderName, RunOnceScheduler>();
	// OpenRouter's list, the most used last week first, fetched once per refresh: undefined when it couldn't be
	private _openRouterModels: Promise<OpenRouterModel[] | undefined> | undefined;

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
				for (const providerName of keyedProviderNames) {
					if (newApiKeys[providerName] !== apiKeys[providerName]) {
						this._keyChangeScheduler(providerName).schedule();
						// the first key: OpenRouter's section gets its models too
						if (!this._openRouterModels && providerName !== 'openRouter') {
							this._keyChangeScheduler('openRouter').schedule();
						}
					}
				}
				apiKeys = newApiKeys;
			}));
		});
		this._register(new IntervalTimer()).cancelAndSet(() => this._refreshAll(), REFRESH_INTERVAL_MS, mainWindow);
	}

	private _apiKeys(): Record<KeyedProviderName, string> {
		const { settingsOfProvider } = this.voidSettingsService.state;
		return Object.fromEntries(keyedProviderNames.map(providerName => [providerName, settingsOfProvider[providerName].apiKey])) as Record<KeyedProviderName, string>;
	}

	private _keyChangeScheduler(providerName: KeyedProviderName): RunOnceScheduler {
		let scheduler = this._refreshOnKeyChange.get(providerName);
		if (!scheduler) {
			scheduler = this._register(new RunOnceScheduler(() => providerName === 'openRouter' ? this._refreshOpenRouter() : this._refreshProvider(providerName), KEY_CHANGE_DELAY_MS));
			this._refreshOnKeyChange.set(providerName, scheduler);
		}
		return scheduler;
	}

	private _refreshAll(): void {
		this._openRouterModels = undefined; // fetched again, once
		this._refreshOpenRouter();
		for (const providerName of listableProviderNames) {
			this._refreshProvider(providerName);
		}
	}

	// OpenRouter's list by usage, when a provider has a key
	private _openRouterModelsByUsage(): Promise<OpenRouterModel[] | undefined> {
		const apiKeys = Object.values(this._apiKeys());
		if (!apiKeys.some(apiKey => !!apiKey)) {
			return Promise.resolve(undefined);
		}
		this._openRouterModels ??= this._fetchOpenRouterModels();
		return this._openRouterModels;
	}

	private async _fetchOpenRouterModels(): Promise<OpenRouterModel[] | undefined> {
		try {
			const context = await this.requestService.request({ type: 'GET', url: OPENROUTER_MODELS_BY_USAGE_URL, callSite: 'kodia.openRouterModels' }, CancellationToken.None);
			const models = (await asJson<{ data?: OpenRouterModel[] }>(context))?.data;
			return Array.isArray(models) ? models : undefined;
		} catch (e) {
			this.logService.info('[Kodia] Could not list OpenRouter\'s models', e);
			return undefined;
		}
	}

	private async _refreshOpenRouter(): Promise<void> {
		const models = await this._openRouterModelsByUsage();
		if (!models) {
			// no key yet, offline, or OpenRouter is down: keep the models found last time
			return;
		}
		const now = Date.now();
		// the best free models for code first, then the most used
		const free = freeCodingModelsOfOpenRouter(models, now).slice(0, BEST_FREE_COUNT);
		const mostUsed = mostUsedModelsOfOpenRouter(models, now, MOST_USED_COUNT);
		// a model selected in the chat (or another feature) stays when it leaves these lists
		const selected = Object.values(this.voidSettingsService.state.modelSelectionOfFeature)
			.flatMap(selection => selection?.providerName === 'openRouter' ? [selection.modelName] : []);
		const detected = [...free, ...mostUsed, ...stillListedModelsOfOpenRouter(models, now, selected)];
		const unique = detected.filter((m, i) => detected.findIndex(other => other.modelName === m.modelName) === i);
		this.voidSettingsService.setDetectedModels('openRouter', unique, [...free, ...mostUsed].map(m => m.modelName));
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
		const detected = detectedModelsOfProvider(providerName, models);
		const modelNames = [...defaultModelsOfProvider[providerName], ...detected.map(m => m.modelName)];
		const mostUsed = mostUsedModelNames(providerName, modelNames, await this._openRouterModelsByUsage() ?? [], MOST_USED_COUNT);
		this.voidSettingsService.setDetectedModels(providerName, detected, mostUsed);
	}
}

registerWorkbenchContribution2(ProviderModelsContrib.ID, ProviderModelsContrib, WorkbenchPhase.Eventually);
