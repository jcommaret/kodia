/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IKodiaHooksMainService, KODIA_HOOKS_CHANNEL } from '../common/kodiaHooks.js';

// Renderer-side proxy for Kodia Lifecycle Hooks. Hook commands run in the main process,
// never in the renderer.
registerMainProcessRemoteService(IKodiaHooksMainService, KODIA_HOOKS_CHANNEL);
