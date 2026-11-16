/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IApiMainService = createDecorator<IApiMainService>('ApiMainService');

// ---------------------------------------------------------------------------
// Cookie support
// ---------------------------------------------------------------------------

export type Cookie = {
	name: string;
	value: string;
	domain: string;
	path: string;
	expires?: number; // epoch ms
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: 'strict' | 'lax' | 'none';
};

export type CookieJar = {
	cookies: Cookie[];
};

// ---------------------------------------------------------------------------
// OAuth2 support
// ---------------------------------------------------------------------------

export type OAuth2Config = {
	clientId: string;
	clientSecret: string;
	authorizationUrl?: string;
	tokenUrl: string;
	redirectUri?: string;
	scope?: string;
	codeChallenge?: string; // PKCE
	codeVerifier?: string;  // PKCE
};

export type OAuth2Tokens = {
	accessToken: string;
	refreshToken?: string;
	expiresIn?: number; // seconds
	tokenType?: string; // e.g. "Bearer"
	scope?: string;
	createdAt?: number; // epoch ms
};

// ---------------------------------------------------------------------------
// Multipart upload support
// ---------------------------------------------------------------------------

export type MultipartField = {
	name: string;
	value: string;
};

export type MultipartFile = {
	name: string;
	filename: string;
	contentType: string;
	content: string; // base64 or raw text
};

export type MultipartBody = {
	fields: MultipartField[];
	files: MultipartFile[];
};

// ---------------------------------------------------------------------------
// API service interface
// ---------------------------------------------------------------------------

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
		cookies?: Cookie[];           // cookies to send (merged with jar)
		useCookieJar?: boolean;       // automatically store/send cookies from jar
		oauth2Tokens?: OAuth2Tokens;  // bearer token to send
		multipartBody?: MultipartBody;// multipart form data upload
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
		cookies?: Cookie[]; // cookies returned by server (if useCookieJar)
	}>;

	// --- Cookie management ---
	getCookies(): Promise<Cookie[]>;
	setCookies(cookies: Cookie[]): Promise<void>;
	addCookie(cookie: Cookie): Promise<void>;
	clearCookies(): Promise<void>;

	// --- OAuth2 ---
	generateAuthUrl(config: OAuth2Config): Promise<{ url: string; state: string; codeVerifier?: string }>;
	exchangeCodeForTokens(config: OAuth2Config, code: string, codeVerifier?: string): Promise<OAuth2Tokens>;
	refreshAccessToken(config: OAuth2Config, refreshToken: string): Promise<OAuth2Tokens>;

	// --- Port checking ---
	portCheck(opts: { port: number }): Promise<{
		port: number;
		inUse: boolean;
		process?: string;
	}>;
}
