/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * The codebase index as hosted in the Electron main process (registered in app.ts on 'void-channel-code-index').
 * The implementation is node/codeIndexService.ts (so renderer-side tests can run the same class); here it gets the
 * NVIDIA reranker, which reads the NVIDIA key from the main process's encrypted settings (no key crosses IPC).
 */

import { IEncryptionMainService } from '../../../../platform/encryption/common/encryptionService.js';
import { IApplicationStorageMainService } from '../../../../platform/storage/electron-main/storageMainService.js';
import { KodiaCodeIndexService } from '../node/codeIndexService.js';
import { NvidiaRerankerMainService } from './nvidiaRerankerMainService.js';

export class KodiaCodeIndexMainService extends KodiaCodeIndexService {
	constructor(
		@IApplicationStorageMainService storageService: IApplicationStorageMainService,
		@IEncryptionMainService encryptionService: IEncryptionMainService,
	) {
		super(undefined, new NvidiaRerankerMainService(storageService, encryptionService));
	}
}
