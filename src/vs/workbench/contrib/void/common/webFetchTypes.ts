/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

// the page as text; url is where redirects ended
export type WebFetchResult = { url: string, title: string | null, text: string }

// Fetches web pages for the fetch_url tool. It runs in the main process: a window's requests are
// blocked by CORS on most sites.
export interface IKodiaWebFetchService {
	readonly _serviceBrand: undefined;
	fetchURL(url: string): Promise<WebFetchResult>;
}

export const IKodiaWebFetchService = createDecorator<IKodiaWebFetchService>('kodiaWebFetchService');
