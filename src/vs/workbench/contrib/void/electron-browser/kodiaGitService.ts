/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IKodiaGitMainService, KODIA_GIT_CHANNEL } from '../common/gitService.js';

// Renderer-side proxy for the agent's git runner. Calls go over IPC to KodiaGitMainService in the main process,
// which runs git with an argument vector (no shell) and re-validates every request.
registerMainProcessRemoteService(IKodiaGitMainService, KODIA_GIT_CHANNEL);
