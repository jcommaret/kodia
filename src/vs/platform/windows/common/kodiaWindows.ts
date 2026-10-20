/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * Kodia: lets the Agents Window, which doesn't load Kodia's contribution, show Kodia's UI in an editor window.
 */

/** Opens Kodia's settings, on the Models tab (registered by Kodia's contribution in editor windows). */
export const KODIA_OPEN_SETTINGS_COMMAND_ID = 'workbench.action.openVoidSettings';

export const KODIA_WINDOWS_CHANNEL = 'void-channel-windows';

export const IKodiaWindowsService = createDecorator<IKodiaWindowsService>('kodiaWindowsService');

export interface IKodiaWindowsService {
	readonly _serviceBrand: undefined;

	/** Focuses the editor window `windowId` and opens Kodia's settings in it, once that window has loaded. */
	openSettingsInWindow(windowId: number): Promise<void>;
}
