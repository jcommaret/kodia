/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * The codebase index as hosted in the Electron main process (registered in app.ts on 'void-channel-code-index').
 * The implementation is node/codeIndexService.ts (so renderer-side tests can run the same class); here it gets the
 * NVIDIA reranker and NVIDIA's embedding model, which read the NVIDIA key from the main process's encrypted settings
 * (no key crosses IPC). Vectors are cached in the user-data folder, per model.
 */

import * as path from 'path';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { IEncryptionMainService } from '../../../../platform/encryption/common/encryptionService.js';
import { IApplicationStorageMainService } from '../../../../platform/storage/electron-main/storageMainService.js';
import { NVIDIA_EMBEDDINGS, OpenAICompatibleEmbedder } from '../node/codeEmbedder.js';
import { KodiaCodeIndexService } from '../node/codeIndexService.js';
import { NvidiaRerankerMainService } from './nvidiaRerankerMainService.js';

export class KodiaCodeIndexMainService extends KodiaCodeIndexService {
	constructor(
		@IApplicationStorageMainService storageService: IApplicationStorageMainService,
		@IEncryptionMainService encryptionService: IEncryptionMainService,
		@IEnvironmentMainService environmentService: IEnvironmentMainService,
	) {
		const nvidia = new NvidiaRerankerMainService(storageService, encryptionService);
		super(undefined, nvidia, {
			embedder: new OpenAICompatibleEmbedder({ ...NVIDIA_EMBEDDINGS, nvidiaInputType: true, getApiKey: () => nvidia.getApiKey() }),
			cacheDir: path.join(environmentService.userDataPath, 'kodia', 'code-embeddings'),
		});
	}
}
