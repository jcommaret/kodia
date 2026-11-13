/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { IVoidSettingsService } from './voidSettingsService.js';
import { ILLMMessageService } from './sendLLMMessageService.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { RefreshableProviderName, refreshableProviderNames, SettingsOfProvider } from './voidSettingsTypes.js';
import { normalizeAutodetectedModelNamesForProvider } from './localSingleModelProviders.js';
import { OllamaModelResponse, OpenaiCompatibleModelResponse } from './sendLLMMessageTypes.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';




type RefreshableState = ({
	state: 'init',
	timeoutId: null,
} | {
	state: 'refreshing',
	timeoutId: ReturnType<typeof setTimeout> | null, // the timeoutId of the most recent call to refreshModels
} | {
	state: 'finished',
	timeoutId: null,
} | {
	state: 'error',
	timeoutId: null,
})


/*

user click -> error -> fire(error)
		   \> success -> fire(success)
	finally: keep polling

poll -> do not fire

*/
export type RefreshModelStateOfProvider = Record<RefreshableProviderName, RefreshableState>



const refreshBasedOn: { [k in RefreshableProviderName]: (keyof SettingsOfProvider[k])[] } = {
	ollama: ['_didFillInProviderSettings', 'endpoint'],
	vLLM: ['_didFillInProviderSettings', 'endpoint'],
	lmStudio: ['_didFillInProviderSettings', 'endpoint'],
	mlx: ['_didFillInProviderSettings', 'endpoint'],
	// openAICompatible: ['_didFillInProviderSettings', 'endpoint', 'apiKey'],
}
const REFRESH_INTERVAL = 5_000
const LIST_TIMEOUT = 10_000 // a local server lists its models at once
// const COOLDOWN_TIMEOUT = 300

const autoOptions = { enableProviderOnSuccess: true, doNotFire: true }

// element-wise equals
function eq<T>(a: T[], b: T[]): boolean {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false
	}
	return true
}
export interface IRefreshModelService {
	readonly _serviceBrand: undefined;
	startRefreshingModels: (providerName: RefreshableProviderName, options: { enableProviderOnSuccess: boolean, doNotFire: boolean }) => void;
	onDidChangeState: Event<RefreshableProviderName>;
	state: RefreshModelStateOfProvider;
}

export const IRefreshModelService = createDecorator<IRefreshModelService>('RefreshModelService');

export class RefreshModelService extends Disposable implements IRefreshModelService {

	readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = new Emitter<RefreshableProviderName>();
	readonly onDidChangeState: Event<RefreshableProviderName> = this._onDidChangeState.event; // this is primarily for use in react, so react can listen + update on state changes


	constructor(
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
	) {
		super()


		const disposables: Set<IDisposable> = new Set()

		const initializeAutoPollingAndOnChange = () => {
			this._clearAllTimeouts()
			disposables.forEach(d => d.dispose())
			disposables.clear()

			if (!voidSettingsService.state.globalSettings.autoRefreshModels) return

			for (const providerName of refreshableProviderNames) {

				// const { '_didFillInProviderSettings': enabled } = this.voidSettingsService.state.settingsOfProvider[providerName]
				this.startRefreshingModels(providerName, autoOptions)

				// every time providerName.enabled changes, refresh models too, like a useEffect
				let relevantVals = () => refreshBasedOn[providerName].map(settingName => voidSettingsService.state.settingsOfProvider[providerName][settingName])
				let prevVals = relevantVals() // each iteration of a for loop has its own context and vars, so this is ok
				disposables.add(
					voidSettingsService.onDidChangeState(() => { // we might want to debounce this
						const newVals = relevantVals()
						if (!eq(prevVals, newVals)) {

							const prevEnabled = prevVals[0] as boolean
							const enabled = newVals[0] as boolean

							// refresh unless the provider was just switched off: switched on, or its endpoint changed (switched on or not)
							if (enabled || !prevEnabled) {
								// if user just clicked enable, refresh
								this.startRefreshingModels(providerName, autoOptions)
							}
							else {
								// else if user just clicked disable, don't refresh

								// //give cooldown before re-enabling (or at least re-fetching)
								// const timeoutId = setTimeout(() => this.refreshModels(providerName, !enabled), COOLDOWN_TIMEOUT)
								// this._setTimeoutId(providerName, timeoutId)
							}
							prevVals = newVals
						}
					})
				)
			}
		}

		// on mount (when get init settings state), and if a relevant feature flag changes, start refreshing models
		voidSettingsService.waitForInitState.then(() => {
			initializeAutoPollingAndOnChange()
			this._register(
				voidSettingsService.onDidChangeState((type) => { if (typeof type === 'object' && type[1] === 'autoRefreshModels') initializeAutoPollingAndOnChange() })
			)
		})

	}

	state: RefreshModelStateOfProvider = {
		ollama: { state: 'init', timeoutId: null },
		vLLM: { state: 'init', timeoutId: null },
		lmStudio: { state: 'init', timeoutId: null },
		mlx: { state: 'init', timeoutId: null },
	}


	// Kodia: each refresh of a provider has a number. Only the answer to the latest one counts and polls again: an older
	// one (a poll still in flight when the user clicks, or when MLX starts) neither overwrites newer models nor starts a
	// second polling loop.
	private readonly _generationOfProvider: Record<RefreshableProviderName, number> = { ollama: 0, vLLM: 0, lmStudio: 0, mlx: 0 }

	// start listening for models (and don't stop)
	startRefreshingModels: IRefreshModelService['startRefreshingModels'] = (providerName, options) => {

		this._clearProviderTimeout(providerName)
		const generation = ++this._generationOfProvider[providerName]
		const isLatest = () => generation === this._generationOfProvider[providerName]

		// a poll keeps the last answer shown meanwhile (see ProviderStatus): only a click shows the spinner
		if (!options.doNotFire) this._setRefreshState(providerName, 'refreshing')

		const autoPoll = () => {
			if (this.voidSettingsService.state.globalSettings.autoRefreshModels) {
				// resume auto-polling
				const timeoutId = setTimeout(() => this.startRefreshingModels(providerName, autoOptions), REFRESH_INTERVAL)
				this._setTimeoutId(providerName, timeoutId)
			}
		}

		// a server that accepts the connection but never answers (a model being loaded, a stuck process) must not stop
		// the polling for good: it counts as not running, and a late answer is ignored
		const requestTimeoutId = setTimeout(() => {
			if (!isLatest()) return
			this._generationOfProvider[providerName]++
			this._finish(providerName, 'error', options)
			autoPoll()
		}, LIST_TIMEOUT)

		const listFn = providerName === 'ollama' ? this.llmMessageService.ollamaList
			: this.llmMessageService.openAICompatibleList

		listFn({
			providerName,
			onSuccess: ({ models }) => {
				clearTimeout(requestTimeoutId)
				if (!isLatest()) return
				// set the models to the detected models
				const modelNames = models.map(model => {
					if (providerName === 'ollama') return (model as OllamaModelResponse).name;
					else if (providerName === 'vLLM' || providerName === 'lmStudio' || providerName === 'mlx') {
						return (model as OpenaiCompatibleModelResponse).id;
					}
					else throw new Error('refreshMode fn: unknown provider', providerName);
				});
				const normalizedModelNames = normalizeAutodetectedModelNamesForProvider(providerName, modelNames);
				this.voidSettingsService.setAutodetectedModels(
					providerName,
					normalizedModelNames,
					{ enableProviderOnSuccess: options.enableProviderOnSuccess, hideRefresh: options.doNotFire }
				)

				if (options.enableProviderOnSuccess && !this.voidSettingsService.state.settingsOfProvider[providerName]._didFillInProviderSettings) {
					this.voidSettingsService.setSettingOfProvider(providerName, '_didFillInProviderSettings', true)
				}

				this._finish(providerName, 'finished', options)
				autoPoll()
			},
			onError: () => {
				clearTimeout(requestTimeoutId)
				if (!isLatest()) return
				this._finish(providerName, 'error', options)
				autoPoll()
			}
		})


	}

	// a click always shows its answer; a poll only when the answer changed (the server started or stopped), so the
	// provider's status follows the server without the refresh button flashing every 5 seconds
	private _finish(providerName: RefreshableProviderName, state: 'finished' | 'error', options: { doNotFire: boolean }) {
		if (options.doNotFire && this.state[providerName].state === state) return
		this._setRefreshState(providerName, state)
	}

	_clearAllTimeouts() {
		for (const providerName of refreshableProviderNames) {
			this._clearProviderTimeout(providerName)
		}
	}

	_clearProviderTimeout(providerName: RefreshableProviderName) {
		// cancel any existing poll
		if (this.state[providerName].timeoutId) {
			clearTimeout(this.state[providerName].timeoutId)
			this._setTimeoutId(providerName, null)
		}
	}

	private _setTimeoutId(providerName: RefreshableProviderName, timeoutId: ReturnType<typeof setTimeout> | null) {
		this.state[providerName].timeoutId = timeoutId
	}

	private _setRefreshState(providerName: RefreshableProviderName, state: RefreshableState['state']) {
		this.state[providerName].state = state
		this._onDidChangeState.fire(providerName)
	}
}

registerSingleton(IRefreshModelService, RefreshModelService, InstantiationType.Eager);

