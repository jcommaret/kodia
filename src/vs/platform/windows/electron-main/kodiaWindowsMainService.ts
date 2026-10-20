/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { INativeRunActionInWindowRequest } from '../../window/common/window.js';
import { IKodiaWindowsService, KODIA_OPEN_SETTINGS_COMMAND_ID } from '../common/kodiaWindows.js';
import { IWindowsMainService } from './windows.js';

export class KodiaWindowsMainService implements IKodiaWindowsService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IWindowsMainService private readonly _windowsMainService: IWindowsMainService,
	) { }

	async openSettingsInWindow(windowId: number): Promise<void> {
		const window = this._windowsMainService.getWindowById(windowId);
		if (!window) {
			throw new Error(`No window with id ${windowId}`);
		}
		window.focus();
		// sendWhenReady waits for a window that is still loading, like one the Agents Window just opened
		const request: INativeRunActionInWindowRequest = { id: KODIA_OPEN_SETTINGS_COMMAND_ID, from: 'menu' };
		window.sendWhenReady('vscode:runAction', CancellationToken.None, request);
	}
}
