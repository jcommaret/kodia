/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { fetchWebPage } from '../../../../platform/kodia/node/webFetch.js';
import { IKodiaWebFetchService, WebFetchResult } from '../common/webFetchTypes.js';

export class KodiaWebFetchMainService implements IKodiaWebFetchService {
	readonly _serviceBrand: undefined

	// shared with the Kodia agent of the Agents window
	async fetchURL(url: string): Promise<WebFetchResult> {
		return fetchWebPage(url)
	}
}
