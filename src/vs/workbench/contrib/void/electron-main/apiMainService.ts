/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Main-process API testing service.
 *
 * Runs in the Electron main process where full Node.js access is available.
 * Uses Node's built-in http/https modules to make real HTTP requests to any
 * backend API (Laravel, Django, FastAPI, Express, etc.) and the net module
 * to check if ports are in use.
 *
 * Supports:
 *   - Cookie jar (automatic cookie storage & sending across requests)
 *   - OAuth2 authorization code flow (generate URL, exchange code, refresh)
 *   - Multipart/form-data file uploads
 *   - JWT Bearer tokens
 *
 * Exposed to the renderer/workbench through an IPC channel.
 */

import { IApiMainService, Cookie, CookieJar, OAuth2Config, OAuth2Tokens, MultipartBody } from '../common/apiServiceTypes.js';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as crypto from 'crypto';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10_000_000; // 10MB max response body

// In-memory cookie jar (persists for the lifetime of the service)
const cookieJar: CookieJar = { cookies: [] };

export class KodiaApiMainService implements IApiMainService {
	readonly _serviceBrand: undefined;

	// ---------------------------------------------------------------------------
	// Cookie helpers
	// ---------------------------------------------------------------------------

	private cookieMatches(cookie: Cookie, requestUrl: string): boolean {
		const now = Date.now();
		if (cookie.expires && now > cookie.expires) return false;

		const parsed = new URL(requestUrl);
		const domain = parsed.hostname || '';

		// Domain matching: cookie domain must match or be a suffix of request domain
		const cookieDomain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
		const reqDomain = domain.startsWith('.') ? domain.slice(1) : domain;

		if (!reqDomain.endsWith(cookieDomain)) return false;

		// Path matching
		const cookiePath = cookie.path || '/';
		const reqPath = parsed.pathname || '/';
		if (!reqPath.startsWith(cookiePath)) return false;

		// Secure flag: if cookie is secure, request must be HTTPS
		if (cookie.secure && parsed.protocol !== 'https:') return false;

		return true;
	}

	private getCookieHeader(requestUrl: string): string {
		const matching = cookieJar.cookies.filter(c => this.cookieMatches(c, requestUrl));
		if (matching.length === 0) return '';
		return matching.map(c => `${c.name}=${c.value}`).join('; ');
	}

	private storeSetCookieHeaders(resHeaders: http.IncomingHttpHeaders, requestUrl: string): void {
		const setCookie = resHeaders['set-cookie'];
		if (!setCookie) return;

		const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
		const parsed = new URL(requestUrl);

		for (const raw of cookies) {
			const parts = raw.split(';').map(p => p.trim());
			const [nameVal] = parts.shift()?.split('=') ?? [];
			if (!nameVal) continue;

			const [name, ...valParts] = nameVal.split('=');
			const value = valParts.join('=');

			const cookie: Cookie = {
				name: name.trim(),
				value: value.trim(),
				domain: parsed.hostname || '',
				path: '/',
			};

			for (const p of parts) {
				const [key, ...val] = p.split('=');
				const k = key.trim().toLowerCase();
				const v = val.join('=').trim();
				switch (k) {
					case 'domain': cookie.domain = v; break;
					case 'path': cookie.path = v; break;
					case 'expires': cookie.expires = new Date(v).getTime(); break;
					case 'max-age': cookie.expires = Date.now() + parseInt(v, 10) * 1000; break;
					case 'httponly': cookie.httpOnly = true; break;
					case 'secure': cookie.secure = true; break;
					case 'samesite': cookie.sameSite = v as any; break;
				}
			}

			// Remove existing cookie with same name
			cookieJar.cookies = cookieJar.cookies.filter(c => c.name !== cookie.name || c.domain !== cookie.domain);
			cookieJar.cookies.push(cookie);
		}
	}

	// ---------------------------------------------------------------------------
	// Multipart helpers
	// ---------------------------------------------------------------------------

	private buildMultipartBody(body: MultipartBody): { body: string; contentType: string } {
		const boundary = `----KodiaFormBoundary${crypto.randomBytes(16).toString('hex')}`;
		const parts: string[] = [];

		for (const field of body.fields) {
			parts.push(`--${boundary}`);
			parts.push(`Content-Disposition: form-data; name="${field.name}"`);
			parts.push('');
			parts.push(field.value);
		}

		for (const file of body.files) {
			parts.push(`--${boundary}`);
			parts.push(`Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"`);
			parts.push(`Content-Type: ${file.contentType}`);
			parts.push('');
			parts.push(file.content);
		}

		parts.push(`--${boundary}--`);
		parts.push('');

		return {
			body: parts.join('\r\n'),
			contentType: `multipart/form-data; boundary=${boundary}`,
		};
	}

	// ---------------------------------------------------------------------------
	// Core API request
	// ---------------------------------------------------------------------------

	async apiRequest(opts: {
		url: string;
		method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
		headers?: Record<string, string>;
		body?: string;
		timeoutMs?: number;
		cookies?: Cookie[];
		useCookieJar?: boolean;
		oauth2Tokens?: OAuth2Tokens;
		multipartBody?: MultipartBody;
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
		cookies?: Cookie[];
	}> {
		const parsed = new URL(opts.url);
		const method = opts.method ?? 'GET';
		const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const startTime = Date.now();

		const isHttps = parsed.protocol === 'https:';
		const mod = isHttps ? https : http;

		// Build headers
		const headers: Record<string, string> = {
			'User-Agent': 'Kodia/1.0 (API testing)',
			'Accept': 'application/json, text/plain, */*',
			...(opts.headers ?? {}),
		};

		// Add OAuth2 Bearer token
		if (opts.oauth2Tokens?.accessToken) {
			headers['Authorization'] = `Bearer ${opts.oauth2Tokens.accessToken}`;
		}

		// Add cookies from jar + explicit cookies
		const cookieStrings: string[] = [];
		if (opts.useCookieJar) {
			const jarCookie = this.getCookieHeader(opts.url);
			if (jarCookie) cookieStrings.push(jarCookie);
		}
		if (opts.cookies && opts.cookies.length > 0) {
			cookieStrings.push(opts.cookies.map(c => `${c.name}=${c.value}`).join('; '));
		}
		if (cookieStrings.length > 0) {
			headers['Cookie'] = cookieStrings.join('; ');
		}

		// Handle multipart body
		let bodyString: string | undefined = opts.body;
		if (opts.multipartBody) {
			const { body, contentType } = this.buildMultipartBody(opts.multipartBody);
			bodyString = body;
			headers['Content-Type'] = contentType;
		} else if (bodyString && !headers['Content-Type']) {
			headers['Content-Type'] = 'application/json';
		}

		const options: http.RequestOptions = {
			method,
			hostname: parsed.hostname,
			port: parsed.port || (isHttps ? 443 : 80),
			path: parsed.pathname + (parsed.search ?? ''),
			headers,
			timeout: timeoutMs,
		};

		return new Promise((resolve, reject) => {
			const req = mod.request(options, (res) => {
				const chunks: Buffer[] = [];
				let size = 0;

				res.on('data', (chunk: Buffer) => {
					chunks.push(chunk);
					size += chunk.length;
					if (size > MAX_RESPONSE_BYTES) {
						res.destroy();
					}
				});

				res.on('end', () => {
					const bodyBuffer = Buffer.concat(chunks);
					const body = bodyBuffer.toString();

					const contentType = (res.headers['content-type'] ?? '').toLowerCase();
					let bodyType: 'json' | 'text' | 'other' = 'other';
					if (contentType.includes('application/json')) {
						bodyType = 'json';
					} else if (contentType.startsWith('text/')) {
						bodyType = 'text';
					}

					const elapsedMs = Date.now() - startTime;

					// Convert headers to a plain object
					const respHeaders: Record<string, string> = {};
					for (const [key, value] of Object.entries(res.headers)) {
						if (typeof value === 'string') {
							respHeaders[key] = value;
						} else if (Array.isArray(value)) {
							respHeaders[key] = value.join(', ');
						}
					}

					// Store cookies from response if jar is enabled
					if (opts.useCookieJar) {
						this.storeSetCookieHeaders(res.headers, opts.url);
					}

					const responseCookies = opts.useCookieJar ? [...cookieJar.cookies] : undefined;

					resolve({
						ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300,
						status: res.statusCode ?? 0,
						statusText: res.statusMessage ?? '',
						headers: respHeaders,
						body,
						bodyType,
						url: opts.url,
						method,
						elapsedMs,
						cookies: responseCookies,
					});
				});

				res.on('error', (err: Error) => {
					reject(new Error(`Response error: ${err.message}`));
				});
			});

			req.on('error', (err: Error) => {
				reject(new Error(`Request failed: ${err.message}`));
			});

			req.on('timeout', () => {
				req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
			});

			if (bodyString) {
				req.write(bodyString);
			}

			req.end();
		});
	}

	// ---------------------------------------------------------------------------
	// Cookie management
	// ---------------------------------------------------------------------------

	async getCookies(): Promise<Cookie[]> {
		return [...cookieJar.cookies];
	}

	async setCookies(cookies: Cookie[]): Promise<void> {
		cookieJar.cookies = [...cookies];
	}

	async addCookie(cookie: Cookie): Promise<void> {
		cookieJar.cookies = cookieJar.cookies.filter(c => c.name !== cookie.name || c.domain !== cookie.domain);
		cookieJar.cookies.push(cookie);
	}

	async clearCookies(): Promise<void> {
		cookieJar.cookies = [];
	}

	// ---------------------------------------------------------------------------
	// OAuth2
	// ---------------------------------------------------------------------------

	async generateAuthUrl(config: OAuth2Config): Promise<{ url: string; state: string; codeVerifier?: string }> {
		const state = crypto.randomBytes(16).toString('hex');
		const codeVerifier = crypto.randomBytes(32).toString('base64url');

		const params: Record<string, string> = {
			client_id: config.clientId,
			redirect_uri: config.redirectUri,
			response_type: 'code',
			scope: config.scope ?? '',
			state,
			code_challenge: config.codeChallenge ?? crypto.createHash('sha256').update(codeVerifier).digest('base64url'),
			code_challenge_method: 'S256',
		};

		const query = Object.entries(params)
			.filter(([, v]) => v !== '')
			.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
			.join('&');

		const authUrl = `${config.authorizationUrl}?${query}`;

		return { url: authUrl, state, codeVerifier };
	}

	async exchangeCodeForTokens(config: OAuth2Config, code: string, codeVerifier?: string): Promise<OAuth2Tokens> {
		const parsed = new URL(config.tokenUrl);
		const isHttps = parsed.protocol === 'https:';
		const mod = isHttps ? https : http;

		const bodyParams: Record<string, string> = {
			grant_type: 'authorization_code',
			client_id: config.clientId,
			client_secret: config.clientSecret,
			code,
			redirect_uri: config.redirectUri,
		};

		if (codeVerifier) {
			bodyParams.code_verifier = codeVerifier;
		}

		const bodyString = Object.entries(bodyParams)
			.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
			.join('&');

		const options: http.RequestOptions = {
			method: 'POST',
			hostname: parsed.hostname,
			port: parsed.port || (isHttps ? 443 : 80),
			path: parsed.pathname + (parsed.search ?? ''),
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Content-Length': Buffer.byteLength(bodyString),
				'User-Agent': 'Kodia/1.0 (API testing)',
			},
			timeout: DEFAULT_TIMEOUT_MS,
		};

		return new Promise((resolve, reject) => {
			const req = mod.request(options, (res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => {
					const body = Buffer.concat(chunks).toString();
					try {
						const data = JSON.parse(body);
						const tokens: OAuth2Tokens = {
							accessToken: data.access_token ?? '',
							refreshToken: data.refresh_token,
							expiresIn: data.expires_in,
							tokenType: data.token_type ?? 'Bearer',
							scope: data.scope,
							createdAt: Date.now(),
						};
						resolve(tokens);
					} catch (e) {
						reject(new Error(`Failed to parse token response: ${body}`));
					}
				});
				res.on('error', (err: Error) => reject(new Error(`Response error: ${err.message}`)));
			});

			req.on('error', (err: Error) => reject(new Error(`Request failed: ${err.message}`)));
			req.on('timeout', () => req.destroy(new Error('Token request timed out')));
			req.write(bodyString);
			req.end();
		});
	}

	async refreshAccessToken(config: OAuth2Config, refreshToken: string): Promise<OAuth2Tokens> {
		const parsed = new URL(config.tokenUrl);
		const isHttps = parsed.protocol === 'https:';
		const mod = isHttps ? https : http;

		const bodyString = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}&client_id=${encodeURIComponent(config.clientId)}&client_secret=${encodeURIComponent(config.clientSecret)}`;

		const options: http.RequestOptions = {
			method: 'POST',
			hostname: parsed.hostname,
			port: parsed.port || (isHttps ? 443 : 80),
			path: parsed.pathname + (parsed.search ?? ''),
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Content-Length': Buffer.byteLength(bodyString),
				'User-Agent': 'Kodia/1.0 (API testing)',
			},
			timeout: DEFAULT_TIMEOUT_MS,
		};

		return new Promise((resolve, reject) => {
			const req = mod.request(options, (res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => {
					const body = Buffer.concat(chunks).toString();
					try {
						const data = JSON.parse(body);
						const tokens: OAuth2Tokens = {
							accessToken: data.access_token ?? '',
							refreshToken: data.refresh_token ?? refreshToken,
							expiresIn: data.expires_in,
							tokenType: data.token_type ?? 'Bearer',
							scope: data.scope,
							createdAt: Date.now(),
						};
						resolve(tokens);
					} catch (e) {
						reject(new Error(`Failed to parse token response: ${body}`));
					}
				});
				res.on('error', (err: Error) => reject(new Error(`Response error: ${err.message}`)));
			});

			req.on('error', (err: Error) => reject(new Error(`Request failed: ${err.message}`)));
			req.on('timeout', () => req.destroy(new Error('Token refresh timed out')));
			req.write(bodyString);
			req.end();
		});
	}

	// ---------------------------------------------------------------------------
	// Port checking
	// ---------------------------------------------------------------------------

	async portCheck(opts: { port: number }): Promise<{
		port: number;
		inUse: boolean;
		process?: string;
	}> {
		const port = opts.port;

		return new Promise((resolve) => {
			const socket = new net.Socket();

			let resultSent = false;

			const sendResult = (inUse: boolean, processName?: string) => {
				if (resultSent) return;
				resultSent = true;
				socket.destroy();
				resolve({ port, inUse, process: processName });
			};

			const timeout = setTimeout(() => {
				sendResult(false);
			}, 3000);

			socket.on('connect', () => {
				clearTimeout(timeout);
				sendResult(true, 'unknown');
			});

			socket.on('error', (err: any) => {
				clearTimeout(timeout);
				if (err.code === 'ECONNREFUSED') {
					sendResult(false);
				} else if (err.code === 'EACCES') {
					sendResult(true, 'permission-denied');
				} else {
					sendResult(false);
				}
			});

			socket.connect(port, '127.0.0.1');
		});
	}
}
