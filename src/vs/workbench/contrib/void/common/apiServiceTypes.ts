/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IApiMainService = createDecorator<IApiMainService>('ApiMainService');

export interface IApiMainService {
	readonly _serviceBrand: undefined;

	// --- Direct API testing ---
	// Makes an HTTP request to a backend API and returns status, headers, and body.
	// Works with any API: Laravel, Django, FastAPI, Express, etc.
	apiRequest(opts: {
		url: string;
		method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
		headers?: Record<string, string>;
		body?: string;
		timeoutMs?: number;
	}): Promise<{
		ok: boolean;
		status: number;
		statusText: string;
		headers: Record<string, string>;
		body: string;
		bodyType: 'json' | 'text' | 'other';
		url: string;
		method: string;
		elapsedMs: number;
	}>;

	// --- Port checking ---
	// Checks if a TCP port is in use on localhost.
	portCheck(opts: { port: number }): Promise<{
		port: number;
		inUse: boolean;
		process?: string;
	}>;
}
