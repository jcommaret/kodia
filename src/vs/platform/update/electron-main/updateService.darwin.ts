/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as electron from 'electron';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { memoize } from '../../../base/common/decorators.js';
import { Event } from '../../../base/common/event.js';
import { hash } from '../../../base/common/hash.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILifecycleMainService, IRelaunchHandler, IRelaunchOptions } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { asJson, IRequestService } from '../../request/common/request.js';
import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { isNewerUpdate } from '../common/kodiaUpdate.js';
import { AvailableForDownload, IUpdate, Overwriting, State, StateType, UpdateType } from '../common/update.js';
import { IMeteredConnectionService } from '../../meteredConnection/common/meteredConnection.js';
import { AbstractUpdateService, createUpdateURL, getUpdateRequestHeaders, IUpdateURLOptions, UpdateErrorClassification } from './abstractUpdateService.js';

export class DarwinUpdateService extends AbstractUpdateService implements IRelaunchHandler {

	/** Kodia: the feed's update Electron's autoUpdater was started for, which its events do not fully describe. */
	private feedUpdate: IUpdate | undefined;

	@memoize private get onRawError(): Event<string> { return Event.fromNodeEventEmitter(electron.autoUpdater, 'error', (_, message) => message); }
	@memoize private get onRawCheckingForUpdate(): Event<void> { return Event.fromNodeEventEmitter<void>(electron.autoUpdater, 'checking-for-update'); }
	@memoize private get onRawUpdateNotAvailable(): Event<void> { return Event.fromNodeEventEmitter<void>(electron.autoUpdater, 'update-not-available'); }
	@memoize private get onRawUpdateAvailable(): Event<void> { return Event.fromNodeEventEmitter(electron.autoUpdater, 'update-available'); }
	@memoize private get onRawUpdateDownloaded(): Event<IUpdate> {
		return Event.fromNodeEventEmitter(electron.autoUpdater, 'update-downloaded', (_, version: string, productVersion: string, releaseDate: Date | number) => ({
			version,
			productVersion,
			timestamp: releaseDate instanceof Date ? releaseDate.getTime() || undefined : releaseDate
		}));
	}

	constructor(
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@IConfigurationService configurationService: IConfigurationService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@IRequestService requestService: IRequestService,
		@ILogService logService: ILogService,
		@IProductService productService: IProductService,
		@IApplicationStorageMainService applicationStorageMainService: IApplicationStorageMainService,
		@IMeteredConnectionService meteredConnectionService: IMeteredConnectionService,
	) {
		super(lifecycleMainService, configurationService, environmentMainService, requestService, logService, productService, telemetryService, applicationStorageMainService, meteredConnectionService, true);

		lifecycleMainService.setRelaunchHandler(this);
	}

	handleRelaunch(options?: IRelaunchOptions): boolean {
		if (options?.addArgs || options?.removeArgs) {
			return false; // we cannot apply an update and restart with different args
		}

		if (this.state.type !== StateType.Ready) {
			return false; // we only handle the relaunch when we have a pending update
		}

		this.logService.trace('update#handleRelaunch(): running raw#quitAndInstall()');
		this.doQuitAndInstall();

		return true;
	}

	protected override async initialize(): Promise<void> {
		await super.initialize();

		this.onRawError(this.onError, this, this._store);
		this.onRawCheckingForUpdate(this.onCheckingForUpdate, this, this._store);
		this.onRawUpdateAvailable(this.onUpdateAvailable, this, this._store);
		this.onRawUpdateDownloaded(this.onUpdateDownloaded, this, this._store);
		this.onRawUpdateNotAvailable(this.onUpdateNotAvailable, this, this._store);
	}

	private onCheckingForUpdate(): void {
		this.logService.trace('update#onCheckingForUpdate - Electron autoUpdater is checking for updates');
	}

	private onError(err: string): void {
		this.telemetryService.publicLog2<{ messageHash: string }, UpdateErrorClassification>('update:error', { messageHash: String(hash(String(err))) });
		this.logService.error('UpdateService error:', err);

		// Only react while actively checking/downloading; a late error must not clobber Disabled or Ready.
		if (this.state.type !== StateType.CheckingForUpdates && this.state.type !== StateType.Downloading && this.state.type !== StateType.Overwriting) {
			return;
		}

		// only show message when explicitly checking for updates
		const message = (this.state.type === StateType.CheckingForUpdates && this.state.explicit) ? err : undefined;
		this.setState(State.Idle(UpdateType.Archive, message));
	}

	protected buildUpdateFeedUrl(quality: string, commit: string, options?: IUpdateURLOptions): string | undefined {
		const assetID = this.productService.darwinUniversalAssetId ?? (process.arch === 'x64' ? 'darwin-x64' : 'darwin-arm64'); // Kodia: darwin-x64, not darwin
		const url = createUpdateURL(this.productService.updateUrl!, assetID, quality, commit, options);
		const headers = getUpdateRequestHeaders(this.productService.version);
		try {
			this.logService.trace('update#buildUpdateFeedUrl - setting feed URL for Electron autoUpdater', { url, assetID, quality, commit, headers });
			electron.autoUpdater.setFeedURL({ url, headers });
		} catch (e) {
			// application is very likely not signed
			this.logService.error('Failed to set update feed URL', e);
			return undefined;
		}
		return url;
	}

	protected doCheckForUpdates(explicit: boolean, pendingCommit?: string): void {
		if (!this.quality) {
			return;
		}

		// Kodia: read before the state changes, to compare the feed with the update being overwritten
		const baseline = this.getBaselineUpdate(pendingCommit);
		const overwriting = this.state.type === StateType.Overwriting ? this.state : undefined;

		this.setState(State.CheckingForUpdates(explicit));

		const internalOrg = this.getInternalOrg();
		const background = !explicit && !internalOrg;
		const url = this.buildUpdateFeedUrl(this.quality, pendingCommit ?? this.productService.commit!, { background, internalOrg });

		if (!url) {
			this.setState(State.Idle(UpdateType.Archive));
			return;
		}

		// When connection is metered and this is not an explicit check, avoid electron call as to not to trigger auto-download.
		const download = explicit || !this.meteredConnectionService.isConnectionMetered;
		if (!download) {
			this.logService.info('update#doCheckForUpdates - checking for update without auto-download because connection is metered');
		}

		// Kodia: Electron's autoUpdater downloads whatever the feed describes, so it only runs once the feed is newer
		this.checkFeed(url, explicit, baseline, download, overwriting);
	}

	/**
	 * Kodia: checks the update feed, then starts Electron's auto-download if `download` and the feed's release is
	 * newer than `baseline`, else reports it available for download. Electron's autoUpdater does no such comparison.
	 */
	private async checkFeed(url: string, explicit: boolean, baseline: IUpdate, download: boolean, overwriting: Overwriting | undefined): Promise<void> {
		const headers = getUpdateRequestHeaders(this.productService.version);
		this.logService.trace('update#checkFeed - checking update feed', { url, headers });

		try {
			const context = await this.requestService.request({ url, headers, callSite: 'updateService.darwin.checkForUpdates' }, CancellationToken.None);
			const statusCode = context.res.statusCode;
			this.logService.trace('update#checkFeed - response', { statusCode });

			const update = await asJson<IUpdate>(context);

			// If updates were disabled mid-check, ignore the result so we don't leave the Disabled state.
			if (this.state.type !== StateType.CheckingForUpdates) {
				return;
			}

			if (!isNewerUpdate(update, baseline)) {
				this.logService.trace('update#checkFeed - no update available');
				if (overwriting) {
					// Nothing newer than the pending update after all: restore the Ready state with it
					this._overwrite = false;
					this.setState(State.Ready(overwriting.update, overwriting.explicit, false));
				} else {
					this.setState(State.Idle(UpdateType.Archive, undefined, explicit || undefined));
				}
			} else if (download) {
				this.logService.trace('update#checkFeed - update available, using Electron autoUpdater', { version: update.version, name: update.name });
				this.feedUpdate = update;
				electron.autoUpdater.checkForUpdates();
			} else {
				this.logService.trace('update#checkFeed - update available', { version: update.version, name: update.name });
				this.setState(State.AvailableForDownload(update));
			}
		} catch (err) {
			if (this.state.type !== StateType.CheckingForUpdates) {
				return;
			}

			this.logService.error('update#checkFeed - failed to check for update', err);
			// only show message when explicitly checking for updates
			const message: string | undefined = explicit ? (err.message || err) : undefined;
			this.setState(State.Idle(UpdateType.Archive, message));
		}
	}

	private onUpdateAvailable(): void {
		this.logService.trace('update#onUpdateAvailable - Electron autoUpdater reported update available');

		if (this.state.type !== StateType.CheckingForUpdates && this.state.type !== StateType.Overwriting) {
			return;
		}

		this.setState(State.Downloading(this.state.type === StateType.Overwriting ? this.state.update : undefined, this.state.explicit, this._overwrite));
	}

	private onUpdateDownloaded(update: IUpdate): void {
		if (this.state.type !== StateType.Downloading) {
			return;
		}

		// Kodia: Electron reports the feed's name as the product version and no commit, the feed's update has both
		update = this.feedUpdate ?? update;
		this.feedUpdate = undefined;

		this.setState(State.Downloaded(update, this.state.explicit, this._overwrite));
		this.logService.info(`Update downloaded: ${JSON.stringify(update)}`);

		this.setState(State.Ready(update, this.state.explicit, this._overwrite));
	}

	private onUpdateNotAvailable(): void {
		this.logService.trace('update#onUpdateNotAvailable - Electron autoUpdater reported no update available');

		if (this.state.type !== StateType.CheckingForUpdates) {
			return;
		}

		const notAvailable = this.state.explicit;
		this.setState(State.Idle(UpdateType.Archive, undefined, notAvailable || undefined));
	}

	protected override async doDownloadUpdate(state: AvailableForDownload): Promise<void> {
		// Rebuild feed URL and trigger download via Electron's auto-updater
		this.buildUpdateFeedUrl(this.quality!, state.update.version, { internalOrg: this.getInternalOrg() });
		this.setState(State.CheckingForUpdates(true));
		this.feedUpdate = state.update; // Kodia: see onUpdateDownloaded
		electron.autoUpdater.checkForUpdates();
	}

	protected override doQuitAndInstall(): void {
		this.logService.trace('update#quitAndInstall(): running raw#quitAndInstall()');
		electron.autoUpdater.quitAndInstall();
	}
}
