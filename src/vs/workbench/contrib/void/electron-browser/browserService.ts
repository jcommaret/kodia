/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Registers a renderer-side proxy for IBrowserService. When resolved through
// dependency injection, calls are proxied over IPC to the
// KodiaBrowserMainService in the Electron main process (void-channel-browser).
// All arguments and results are JSON-serializable. Screenshots are returned as
// data URLs and can be large; callers should treat them as opaque blobs for
// display rather than logging them.
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IBrowserService } from '../common/browserServiceTypes.js';

registerMainProcessRemoteService(IBrowserService, 'void-channel-browser');
