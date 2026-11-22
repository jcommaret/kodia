/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Brave Search, in two layers:
 *  - BraveSearchMainService: the provider. search(request, settings) gets its settings (incl. the API key) from
 *    the caller and only talks to the Brave API.
 *  - WebSearchMainService: reads and decrypts the stored settings, skips disabled providers and validates the
 *    request before any provider is called. The settings/validation tests live there (they used to target the
 *    provider, from before that responsibility moved).
 *
 * No test may reach the network: fetch is replaced by a guard that fails unless a test mocks a response.
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IApplicationStorageMainService } from '../../../../../platform/storage/electron-main/storageMainService.js';
import { IEncryptionMainService } from '../../../../../platform/encryption/common/encryptionService.js';
import { BraveSearchMainService } from '../../electron-main/braveSearchMainService.js';
import { WebSearchMainService } from '../../electron-main/webSearchMainService.js';
import { SearchRequest, SearchProviderSettings } from '../../common/webSearchTypes.js';

const testSettings: SearchProviderSettings = { apiKey: 'test-key-123', enabled: true, priority: 0, maxResults: 10, timeoutMs: 15000 };
const validRequest: SearchRequest = { query: 'test query', maxResults: 5 };

const braveResponse = (status: number, body: string): Response =>
	new Response(body, { status, headers: { 'content-type': 'application/json' } });
const braveOkResponse = (webResults: unknown[]): Response =>
	braveResponse(200, JSON.stringify({ web: { results: webResults } }));

/** Replaces fetch for the duration of each test; unmocked calls fail the test instead of reaching the network. */
function useFetchGuard() {
	const realFetch = globalThis.fetch;
	const state = { calls: [] as string[], respond: undefined as ((url: string) => Response | Promise<Response>) | undefined };
	setup(() => {
		state.calls = [];
		state.respond = undefined;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = input instanceof URL ? input.href : String(input);
			state.calls.push(url);
			if (!state.respond) { throw new Error(`unexpected network access in a unit test: ${new URL(url).host}`); }
			return state.respond(url);
		}) as typeof fetch;
	});
	teardown(() => { globalThis.fetch = realFetch; });
	return state;
}

suite('Brave Search - Main Service (provider)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const net = useFetchGuard();
	const search = (request: SearchRequest = validRequest, settings: SearchProviderSettings = testSettings) => new BraveSearchMainService().search(request, settings);

	test('successful search returns normalized results with page_age', async () => {
		net.respond = () => braveOkResponse([{ title: 'Kodia Homepage', url: 'https://kodia.example.com', description: 'A code editor.', page_age: '2026-01-01' }]);
		const response = await search();

		assert.strictEqual(response.provider, 'brave');
		assert.strictEqual(response.query, 'test query');
		assert.strictEqual(response.results.length, 1);
		assert.strictEqual(response.results[0].title, 'Kodia Homepage');
		assert.strictEqual(response.results[0].url, 'https://kodia.example.com/', 'URLs are normalized (WHATWG form)');
		assert.strictEqual(response.results[0].displayUrl, 'kodia.example.com', 'displayUrl is the bare domain');
		assert.strictEqual(response.results[0].snippet, 'A code editor.');
		assert.strictEqual(response.results[0].source, 'brave');
		assert.strictEqual(response.results[0].publishedDate, '2026-01-01');
		assert.strictEqual(response.results[0].score, undefined);
		assert.ok(typeof response.results[0].retrievalTimestamp === 'number');
		assert.ok(response.responseTimeMs >= 0);
		assert.ok(!JSON.stringify(response).includes('test-key-123'), 'API key must not appear in the response');
	});

	test('page_age is mapped to publishedDate', async () => {
		net.respond = () => braveOkResponse([{ title: 'Example Result', url: 'https://example.com', description: 'An example result.', page_age: '2025-06-15' }]);
		assert.strictEqual((await search()).results[0].publishedDate, '2025-06-15');
	});

	test('missing page_age leaves publishedDate undefined', async () => {
		net.respond = () => braveOkResponse([{ title: 'Example Result', url: 'https://example.com', description: 'An example result.' }]);
		const response = await search();
		assert.strictEqual(response.results[0].publishedDate, undefined);
		assert.strictEqual(response.results[0].title, 'Example Result');
		assert.strictEqual(response.results[0].snippet, 'An example result.');
	});

	test('missing optional fields are handled safely', async () => {
		net.respond = () => braveOkResponse([{ title: 'Minimal Result', url: 'https://example.com/minimal' }]);
		const response = await search();
		assert.strictEqual(response.results[0].title, 'Minimal Result');
		assert.strictEqual(response.results[0].snippet, '');
		assert.strictEqual(response.results[0].publishedDate, undefined);
		assert.strictEqual(response.results[0].source, 'brave');
	});

	test('no rank field does not invent a score', async () => {
		net.respond = () => braveOkResponse([{ title: 'Unranked Result', url: 'https://example.com/unranked', description: 'A result with no rank.', page_age: '2026-03-01' }]);
		const response = await search();
		assert.strictEqual(response.results[0].score, undefined);
		assert.strictEqual(response.results[0].title, 'Unranked Result');
	});

	test('safe search parameter is set to moderate', async () => {
		net.respond = () => braveOkResponse([{ title: 'Safe Result', url: 'https://example.com/safe', description: 'A safe result.' }]);
		const response = await search();
		assert.strictEqual(response.results[0].title, 'Safe Result');
		const url = new URL(net.calls[0]);
		assert.strictEqual(url.host, 'api.search.brave.com');
		assert.strictEqual(url.searchParams.get('safesearch'), 'moderate');
		assert.strictEqual(url.searchParams.get('search_lang'), 'en');
		assert.strictEqual(url.searchParams.get('q'), 'test query');
	});

	test('missing API key throws without calling the network', async () => {
		await assert.rejects(search(validRequest, { ...testSettings, apiKey: undefined }), (err: Error) => err.message.includes('not configured'));
		assert.strictEqual(net.calls.length, 0);
	});

	test('HTTP 401 authentication failure throws safely', async () => {
		net.respond = () => braveResponse(401, JSON.stringify({ error: 'invalid key' }));
		await assert.rejects(search(), (err: Error) => err.message.includes('401') && !err.message.includes('test-key-123'));
	});

	test('HTTP 429 rate limit throws safely', async () => {
		net.respond = () => braveResponse(429, JSON.stringify({ error: 'rate limited' }));
		await assert.rejects(search(), (err: Error) => err.message.includes('429') && !err.message.includes('test-key-123'));
	});

	test('other HTTP failure throws safely', async () => {
		net.respond = () => braveResponse(500, 'Internal Server Error');
		await assert.rejects(search(), (err: Error) => err.message.includes('500') && !err.message.includes('test-key-123'));
	});

	test('malformed JSON response throws safely', async () => {
		net.respond = () => braveResponse(200, 'not json at all');
		await assert.rejects(search(), (err: Error) => err.message.includes('invalid response'));
	});

	test('empty results array returns empty results', async () => {
		net.respond = () => braveOkResponse([]);
		const response = await search();
		assert.strictEqual(response.results.length, 0);
		assert.strictEqual(response.totalResults, 0);
	});

	test('fetch network failure throws safely', async () => {
		net.respond = () => { throw new Error('network unreachable'); };
		await assert.rejects(search(), (err: Error) => err.message.includes('network unreachable') && !err.message.includes('test-key-123'));
	});

	test('AbortError from fetch is reported as timeout', async () => {
		net.respond = () => { const e = new Error('The operation was aborted.'); e.name = 'AbortError'; throw e; };
		await assert.rejects(search(), (err: Error) => err.message.includes('timed out'));
	});

	test('TimeoutError from fetch is reported as timeout', async () => {
		net.respond = () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };
		await assert.rejects(search(), (err: Error) => err.message.includes('timed out'));
	});

	test('query is not leaked in error messages', async () => {
		net.respond = () => braveResponse(401, JSON.stringify({ error: 'invalid key' }));
		await assert.rejects(search({ query: 'super secret query', maxResults: 5 }), (err: Error) => !err.message.includes('super secret query'));
	});

	test('API key is not in error messages', async () => {
		net.respond = () => braveResponse(401, JSON.stringify({ error: 'invalid key' }));
		await assert.rejects(search(), (err: Error) => !err.message.includes('test-key-123'));
	});
});

suite('Brave Search - stored settings and request validation (WebSearchMainService)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const net = useFetchGuard();

	// the service logs provider fallbacks and unreadable settings with console.warn/log: expected here
	const realWarn = console.warn;
	const realLog = console.log;
	setup(() => { console.warn = () => { }; console.log = () => { }; });
	teardown(() => { console.warn = realWarn; console.log = realLog; });

	const storage = (value: string | undefined) => ({ get: (_key: string, _scope: StorageScope) => value }) as unknown as IApplicationStorageMainService;
	const encryption = (decrypted: string, fail = false) => ({
		decrypt: async () => { if (fail) { throw new Error('decryption failed'); } return decrypted; },
	}) as unknown as IEncryptionMainService;
	const withBrave = (brave: object) => JSON.stringify({ globalSettings: { webSearchProviders: { brave } } });
	const enabledBrave = withBrave(testSettings);
	const service = (stored: string | undefined, decrypted: string, decryptFails = false) =>
		new WebSearchMainService(storage(stored), encryption(decrypted, decryptFails));

	test('reads the key from encrypted settings and calls Brave once', async () => {
		net.respond = () => braveOkResponse([{ title: 'Hit', url: 'https://example.com/a' }]);
		const response = await service('blob', enabledBrave).search(validRequest);
		assert.strictEqual(response.provider, 'brave');
		assert.strictEqual(net.calls.length, 1);
	});

	test('no stored settings: Brave is off by default, nothing is called', async () => {
		await assert.rejects(service(undefined, '').search(validRequest), (err: Error) => err.message.includes('No web search providers are enabled'));
		assert.strictEqual(net.calls.length, 0);
	});

	test('decryption failure throws safely, nothing is called', async () => {
		await assert.rejects(service('blob', enabledBrave, true).search(validRequest), (err: Error) => err.message.includes('decryption failed') && !err.message.includes('test-key-123'));
		assert.strictEqual(net.calls.length, 0);
	});

	test('disabled provider does not call fetch and throws', async () => {
		await assert.rejects(service('blob', withBrave({ ...testSettings, enabled: false })).search(validRequest), (err: Error) => err.message.includes('No web search providers are enabled'));
		assert.strictEqual(net.calls.length, 0, 'fetch must not be called when Brave is disabled');
	});

	test('enabled without an API key: configuration error, nothing is called', async () => {
		await assert.rejects(service('blob', withBrave({ ...testSettings, apiKey: undefined })).search(validRequest), (err: Error) => /API key/i.test(err.message));
		assert.strictEqual(net.calls.length, 0);
	});

	test('malformed stored settings JSON falls back to defaults (Brave off)', async () => {
		await assert.rejects(service('blob', 'not json').search(validRequest), (err: Error) => err.message.includes('No web search providers are enabled'));
		assert.strictEqual(net.calls.length, 0);
	});

	for (const [name, request, pattern] of [
		['invalid empty query throws', { query: '' }, /query is required/],
		['invalid whitespace-only query throws', { query: '   ' }, /query is required/],
		['invalid maxResults below 1 throws', { query: 'q', maxResults: 0 }, /maxResults/],
		['invalid maxResults above 50 throws', { query: 'q', maxResults: 100 }, /maxResults/],
	] as [string, SearchRequest, RegExp][]) {
		test(name, async () => {
			await assert.rejects(service('blob', enabledBrave).search(request), (err: Error) => pattern.test(err.message));
			assert.strictEqual(net.calls.length, 0);
		});
	}
});
