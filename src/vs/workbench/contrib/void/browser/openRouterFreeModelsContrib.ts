/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { freeCodingModelsOfOpenRouter, OPENROUTER_MODELS_URL, OpenRouterModel } from '../common/openRouterFreeModels.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Kodia: lists OpenRouter's free models that can run the agent (chat or vision, with tool calling) in the OpenRouter
// section, switched off, with the capabilities OpenRouter gives. At startup, then every day.
export class OpenRouterFreeModelsContrib extends Disposable {
	static readonly ID = 'workbench.contrib.kodia.openRouterFreeModels';

	constructor(
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.voidSettingsService.waitForInitState.then(() => this._refresh());
		this._register(new IntervalTimer()).cancelAndSet(() => this._refresh(), REFRESH_INTERVAL_MS, mainWindow);
	}

	private async _refresh(): Promise<void> {
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

registerWorkbenchContribution2(OpenRouterFreeModelsContrib.ID, OpenRouterFreeModelsContrib, WorkbenchPhase.Eventually);
