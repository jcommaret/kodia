/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IKodiaOpsMainService, KODIA_OPS_CHANNEL } from '../common/kodiaOpsTypes.js';

registerMainProcessRemoteService(IKodiaOpsMainService, KODIA_OPS_CHANNEL);
