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
 * Exposed to the renderer/workbench through an IPC channel.
 */

import { IApiMainService } from '../common/apiServiceTypes.js';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as url from 'url';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10_000_000; // 10MB max response body

export class KodiaApiMainService implements IApiMainService {
	readonly _serviceBrand: undefined;

	async apiRequest(opts: {
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
	}> {
		const parsed = url.parse(opts.url);
		if (!parsed.protocol || !['http:', 'https:'].includes(parsed.protocol)) {
			throw new Error(`Invalid URL: "${opts.url}". Only http and https are supported.`);
		}

		const method = opts.method ?? 'GET';
		const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const startTime = Date.now();

		const isHttps = parsed.protocol === 'https:';
		const mod = isHttps ? https : http;

		const headers: Record<string, string> = {
			'User-Agent': 'Kodia/1.0 (API testing)',
			'Accept': 'application/json, text/plain, */*',
			...(opts.headers ?? {}),
		};

		if (opts.body && !headers['Content-Type']) {
			headers['Content-Type'] = 'application/json';
		}

		const options: http.RequestOptions = {
			method,
			hostname: parsed.hostname,
			port: parsed.port || (isHttps ? 443 : 80),
			path: parsed.path || '/',
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
					const body = bodyBuffer.toString('utf8');

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

			if (opts.body) {
				req.write(opts.body);
			}

			req.end();
		});
	}

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
				// Port is open - something is listening
				sendResult(true, 'unknown');
			});

			socket.on('error', (err: any) => {
				clearTimeout(timeout);
				// ECONNREFUSED means nothing is listening (port is free)
				// EACCES/EADDRINUSE etc. could mean something else
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
