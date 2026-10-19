/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { DisablementReason, IUpdateService, StateType } from '../../../../platform/update/common/update.js';
import { IVoidUpdateService } from '../common/voidUpdateService.js';
import { VoidCheckUpdateRespose } from '../common/voidUpdateServiceTypes.js';
import { KODIA_LATEST_RELEASE_API_URL } from '../common/kodiaLinks.js';



export class VoidMainUpdateService extends Disposable implements IVoidUpdateService {
	_serviceBrand: undefined;

	// the release the automatic check last announced, so it isn't announced again every 3 hours
	private _autoAnnouncedRelease: string | undefined

	constructor(
		@IProductService private readonly _productService: IProductService,
		@IEnvironmentMainService private readonly _envMainService: IEnvironmentMainService,
		@IUpdateService private readonly _updateService: IUpdateService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super()
	}

	// Whether the user (or a policy, or --disable-updates) turned off automatic update checks. Release builds
	// have no update URL, so VS Code's updater is disabled for that reason and never reads update.mode itself.
	private _automaticChecksTurnedOff(): boolean {
		const updateMode = this._configurationService.getValue<string>('update.mode')
		if (updateMode === 'none' || updateMode === 'manual') return true
		const { state } = this._updateService
		return state.type === StateType.Disabled
			&& (state.reason === DisablementReason.ManuallyDisabled || state.reason === DisablementReason.Policy || state.reason === DisablementReason.DisabledByEnvironment)
	}


	async check(explicit: boolean): Promise<VoidCheckUpdateRespose> {

		const isDevMode = !this._envMainService.isBuilt // found in abstractUpdateService.ts

		if (isDevMode) {
			return { message: null } as const
		}

		if (!explicit && this._automaticChecksTurnedOff()) {
			return { message: null } as const
		}

		this._updateService.checkForUpdates(false) // implicity check, then handle result ourselves

		console.log('updateState', this._updateService.state)

		if (this._updateService.state.type === StateType.Uninitialized) {
			// The update service hasn't been initialized yet
			return { message: explicit ? 'Checking for updates soon...' : null, action: explicit ? 'reinstall' : undefined } as const
		}

		if (this._updateService.state.type === StateType.Idle) {
			// No updates currently available
			return { message: explicit ? 'No updates found!' : null, action: explicit ? 'reinstall' : undefined } as const
		}

		if (this._updateService.state.type === StateType.CheckingForUpdates) {
			// Currently checking for updates
			return { message: explicit ? 'Checking for updates...' : null } as const
		}

		if (this._updateService.state.type === StateType.AvailableForDownload) {
			// Update available but requires manual download (mainly for Linux)
			return { message: 'A new update is available!', action: 'download', } as const
		}

		if (this._updateService.state.type === StateType.Downloading) {
			// Update is currently being downloaded
			return { message: explicit ? 'Currently downloading update...' : null } as const
		}

		if (this._updateService.state.type === StateType.Downloaded) {
			// Update has been downloaded but not yet ready
			return { message: explicit ? 'An update is ready to be applied!' : null, action: 'apply' } as const
		}

		if (this._updateService.state.type === StateType.Updating) {
			// Update is being applied
			return { message: explicit ? 'Applying update...' : null } as const
		}

		if (this._updateService.state.type === StateType.Ready) {
			// Update is ready
			return { message: 'Restart Kodia to update!', action: 'restart' } as const
		}

		if (this._updateService.state.type === StateType.Disabled) {
			return await this._manualCheckGHTagIfDisabled(explicit)
		}
		return null
	}






	private async _manualCheckGHTagIfDisabled(explicit: boolean): Promise<VoidCheckUpdateRespose> {
		try {
			const response = await fetch(KODIA_LATEST_RELEASE_API_URL);

			const data = await response.json();
			const latestVersion: string = data.tag_name;

			// Release tags are "<VS Code version>-<Kodia version>", e.g. 1.141.0-2.5.0
			const myVersion = `${this._productService.version}-${this._productService.voidVersion}`

			const isUpToDate = !isNewerRelease(latestVersion, myVersion) // only makes sense if response.ok

			let message: string | null
			let action: 'reinstall' | undefined

			// explicit
			if (explicit) {
				if (response.ok) {
					if (!isUpToDate) {
						message = 'A new version of Kodia is available! Please reinstall (auto-updates are disabled on this OS) - it only takes a second!'
						action = 'reinstall'
					}
					else {
						message = 'Kodia is up-to-date!'
					}
				}
				else {
					message = `An error occurred when fetching the latest GitHub release tag. Please try again in ~5 minutes, or reinstall.`
					action = 'reinstall'
				}
			}
			// not explicit: once per release
			else {
				if (response.ok && !isUpToDate && latestVersion !== this._autoAnnouncedRelease) {
					this._autoAnnouncedRelease = latestVersion
					message = 'A new version of Kodia is available! Please reinstall (auto-updates are disabled on this OS) - it only takes a second!'
					action = 'reinstall'
				}
				else {
					message = null
				}
			}
			return { message, action } as const
		}
		catch (e) {
			if (explicit) {
				return {
					message: `An error occurred when fetching the latest GitHub release tag: ${e}. Please try again in ~5 minutes.`,
					action: 'reinstall',
				}
			}
			else {
				return { message: null } as const
			}
		}
	}
}


/** Whether release tag `a` is newer than `b`, comparing "<VS Code version>-<Kodia version>" numerically. */
function isNewerRelease(a: string, b: string): boolean {
	const parse = (tag: string) => /^(\d+)\.(\d+)\.(\d+)-(\d+)\.(\d+)\.(\d+)$/.exec(tag)?.slice(1).map(Number);
	const pa = parse(a), pb = parse(b);
	if (!pa || !pb) {
		return a !== b;
	}
	for (let i = 0; i < pa.length; i++) {
		if (pa[i] !== pb[i]) {
			return pa[i] > pb[i];
		}
	}
	return false;
}
