/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * The web search IPC channel, as production wires it: app.ts registers 'void-channel-webSearch' as
 * ProxyChannel.fromService(IWebSearchService), and IWebSearchService is WebSearchMainService, which reads the
 * encrypted settings, picks the enabled providers and calls BraveSearchMainService.search(request, settings).
 * (These tests used to call BraveSearchMainService directly, which production no longer exposes.)
 *
 * No test may reach the network: fetch is replaced by a guard that fails the test unless a test mocks it.
 */

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IApplicationStorageMainService } from '../../../../../platform/storage/electron-main/storageMainService.js';
import { IEncryptionMainService } from '../../../../../platform/encryption/common/encryptionService.js';
import { WebSearchMainService } from '../../electron-main/webSearchMainService.js';
import { SearchRequest, SearchResponse } from '../../common/webSearchTypes.js';

const encryptedBlob = 'encrypted-blob';
const settingsWithBrave = (brave: object) => JSON.stringify({ globalSettings: { webSearchProviders: { brave } } });
const enabledBrave = settingsWithBrave({ apiKey: 'test-key-123', enabled: true, priority: 0, maxResults: 10, timeoutMs: 15000 });

const mockStorage = (value: string | undefined) => ({
	get: (_key: string, _scope: StorageScope) => value,
}) as unknown as IApplicationStorageMainService;

const mockEncryption = (decrypted: string) => ({
	decrypt: async (_value: string) => decrypted,
}) as unknown as IEncryptionMainService;

const braveOkResponse = (webResults: unknown[]): Response =>
	new Response(JSON.stringify({ web: { results: webResults } }), { status: 200, headers: { 'content-type': 'application/json' } });

const validRequest: SearchRequest = { query: 'test query', maxResults: 5 };

suite('Brave Search - IPC Channel (via WebSearchMainService)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const channelDisposables = new DisposableStore();

	const realFetch = globalThis.fetch;
	const realWarn = console.warn;
	const realLog = console.log;
	let fetchCalls: { url: string; headers: Record<string, string> }[] = [];
	let respond: ((url: string) => Response | Promise<Response>) | undefined;

	setup(() => {
		fetchCalls = [];
		respond = undefined;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof URL ? input.href : String(input);
			fetchCalls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
			if (!respond) { throw new Error(`unexpected network access in a unit test: ${new URL(url).host}`); }
			return respond(url);
		}) as typeof fetch;
		// the service logs provider fallbacks with console.warn/log; that is expected here, not a test failure
		console.warn = () => { };
		console.log = () => { };
	});
	teardown(() => {
		globalThis.fetch = realFetch;
		console.warn = realWarn;
		console.log = realLog;
		channelDisposables.clear();
	});

	const channelFor = (decryptedSettings: string | undefined) => {
		const service = new WebSearchMainService(mockStorage(decryptedSettings === undefined ? undefined : encryptedBlob), mockEncryption(decryptedSettings ?? ''));
		return ProxyChannel.fromService(service, channelDisposables);
	};

	test('channel exposes search operation and returns Brave results', async () => {
		respond = () => braveOkResponse([{ title: 'Kodia Homepage', url: 'https://kodia.example.com', description: 'A code editor.', page_age: '2026-01-01' }]);
		const result = await channelFor(enabledBrave).call(null, 'search', [validRequest]) as SearchResponse;

		assert.strictEqual(result.provider, 'brave');
		assert.strictEqual(result.query, 'test query');
		assert.strictEqual(result.results.length, 1);
		assert.strictEqual(result.results[0].title, 'Kodia Homepage');
		assert.strictEqual(result.results[0].source, 'brave');
		assert.strictEqual(fetchCalls.length, 1);
		assert.strictEqual(new URL(fetchCalls[0].url).host, 'api.search.brave.com');
		assert.strictEqual(fetchCalls[0].headers['X-Subscription-Token'], 'test-key-123', 'the stored key is sent as the auth header');
		assert.ok(!JSON.stringify(result).includes('test-key-123'), 'the key never comes back over IPC');
	});

	test('channel propagates missing API key error without calling the network', async () => {
		const noKey = settingsWithBrave({ apiKey: undefined, enabled: true, priority: 0, maxResults: 10, timeoutMs: 15000 });
		await assert.rejects(
			channelFor(noKey).call(null, 'search', [validRequest]),
			(err: Error) => /API key/i.test(err.message) && !err.message.includes('test-key')
		);
		assert.strictEqual(fetchCalls.length, 0);
	});

	test('channel reports that no provider is enabled when Brave is disabled, without calling fetch', async () => {
		const disabled = settingsWithBrave({ apiKey: 'test-key-123', enabled: false, priority: 0, maxResults: 10, timeoutMs: 15000 });
		await assert.rejects(
			channelFor(disabled).call(null, 'search', [validRequest]),
			(err: Error) => err.message.includes('No web search providers are enabled')
		);
		assert.strictEqual(fetchCalls.length, 0, 'fetch must not be called when Brave is disabled');
	});

	test('channel propagates HTTP error safely', async () => {
		respond = () => new Response(JSON.stringify({ error: 'invalid key' }), { status: 401, headers: { 'content-type': 'application/json' } });
		await assert.rejects(
			channelFor(enabledBrave).call(null, 'search', [validRequest]),
			(err: Error) => err.message.includes('401') && !err.message.includes('test-key-123')
		);
	});

	test('channel propagates network failure safely', async () => {
		respond = () => { throw new Error('network unreachable'); };
		await assert.rejects(
			channelFor(enabledBrave).call(null, 'search', [validRequest]),
			(err: Error) => err.message.includes('network unreachable') && !err.message.includes('test-key-123')
		);
	});

	test('channel throws for unknown command', () => {
		assert.throws(
			() => channelFor(enabledBrave).call(null, 'nonexistentCommand', [validRequest]),
			(err: Error) => err.message.includes('Method not found')
		);
	});

	test('channel call passes request correctly to service', async () => {
		respond = () => braveOkResponse([]);
		const result = await channelFor(enabledBrave).call(null, 'search', [{ query: 'custom query', maxResults: 3 }]) as SearchResponse;
		assert.strictEqual(result.query, 'custom query');
		assert.strictEqual(result.results.length, 0);
		const url = new URL(fetchCalls[0].url);
		assert.strictEqual(url.searchParams.get('q'), 'custom query');
		assert.strictEqual(url.searchParams.get('count'), '3');
	});

	test('service registration does not require an API key at startup', () => {
		// constructing the service and its channel with no stored settings must not throw; the key is only needed to search
		assert.ok(channelFor(undefined));
		assert.strictEqual(fetchCalls.length, 0);
	});
});
