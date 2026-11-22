/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 5: what the agent learns from a page must be true. Real Chromium (Playwright) against a real local HTTP
 * server. Each test pins a defect of the previous implementation (noted inline).
 */

import assert from 'assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { KodiaBrowserMainService } from '../../electron-main/browserMainService.js';

type Route = { status?: number; type?: string; body: string; delayMs?: number; headers?: Record<string, string> };

suite('Kodia - browser automation signals (roadmap 5)', function () {
	this.timeout(60_000);

	let service: KodiaBrowserMainService;
	let server: http.Server;
	let base: string;
	let sessionId: string;
	let tabId: string;
	const routes = new Map<string, Route>();

	suiteSetup(async () => {
		server = http.createServer((req, res) => {
			if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; } // keep the browser's own request out of the counts
			const r = routes.get((req.url ?? '/').split('?')[0]);
			const send = () => {
				if (!r) { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<title>Not found</title>missing'); return; }
				res.writeHead(r.status ?? 200, { 'content-type': r.type ?? 'text/html', ...r.headers });
				res.end(r.body);
			};
			if (r?.delayMs) { setTimeout(send, r.delayMs); } else { send(); }
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		service = new KodiaBrowserMainService();
	});
	suiteTeardown(async () => {
		await service.shutdown();
		await new Promise<void>(resolve => server.close(() => resolve()));
	});
	setup(async () => {
		routes.clear();
		sessionId = (await service.launchBrowser({ headless: true, viewport: { width: 800, height: 600 } })).sessionId;
		tabId = (await service.newTab(sessionId, {})).tabId;
	});
	teardown(async () => { await service.closeBrowser(sessionId); });

	const page = (path: string, html: string, extra: Partial<Route> = {}) => routes.set(path, { body: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`, ...extra });

	test('every listed element has a selector that matches only it, at any DOM depth (were: unlabeled buttons collapsed to one bare "button"; depth > 12 was invisible)', async () => {
		const deep = '<div>'.repeat(20) + '<button>Deep</button>' + '</div>'.repeat(20);
		page('/', `<button>One</button><button>Two</button><button>Three</button><ul><li><a href="#a">A</a></li><li><a href="#b">B</a></li></ul>${deep}<p id="out"></p>
			<script>document.querySelectorAll('button').forEach(b => b.onclick = () => document.getElementById('out').textContent = 'clicked ' + b.textContent)</script>`);
		await service.navigate(sessionId, tabId, `${base}/`);
		const inspected = await service.inspectPage(sessionId, tabId);
		const buttons = inspected.elements.filter(e => e.type === 'button');
		assert.deepStrictEqual(buttons.map(b => b.label), ['One', 'Two', 'Three', 'Deep']);
		assert.strictEqual(new Set(inspected.elements.map(e => e.selector)).size, inspected.elements.length, 'selectors are unique');
		assert.strictEqual(inspected.elements.filter(e => e.type === 'link').length, 2);

		await service.clickElement(sessionId, tabId, buttons[2].selector);
		assert.match((await service.inspectPage(sessionId, tabId)).text, /clicked Three/, 'the third button was clicked, not the first');
		await service.clickElement(sessionId, tabId, buttons[3].selector);
		assert.match((await service.inspectPage(sessionId, tabId)).text, /clicked Deep/);
		await assert.rejects(service.clickElement(sessionId, tabId, 'button'), /matches 4 elements/, 'an ambiguous selector is refused, not silently resolved to the first match');
	});

	test('navigation reports the HTTP status; HTTP errors of subresources are network failures (were: dropped)', async () => {
		page('/broken', '<script src="/missing.js"></script><h1>Shop</h1>', { status: 500 });
		const nav = await service.navigate(sessionId, tabId, `${base}/broken`);
		assert.strictEqual(nav.status, 500);
		assert.match(nav.loadError ?? '', /HTTP 500/);
		const failures = await service.getNetworkFailures(sessionId, tabId);
		assert.ok(failures.some(f => f.url.endsWith('/missing.js') && f.errorText.startsWith('HTTP 404')), JSON.stringify(failures));

		page('/ok', '<h1>Fine</h1>');
		const ok = await service.navigate(sessionId, tabId, `${base}/ok`);
		assert.deepStrictEqual([ok.status, ok.loadError], [200, undefined]);
		assert.deepStrictEqual(await service.getNetworkFailures(sessionId, tabId), [], 'failures belong to the page they happened on');
	});

	test('a click that navigates to a slow page returns after the new page loaded (was: returned at once, on the old page)', async () => {
		page('/', '<a id="go" href="/slow">Next</a>');
		page('/slow', '<title>Slow page</title><h1>Arrived</h1>', { delayMs: 800 });
		await service.navigate(sessionId, tabId, `${base}/`);
		const clicked = await service.clickElement(sessionId, tabId, '#go');
		assert.strictEqual(clicked.navigated, true);
		assert.strictEqual(clicked.url, `${base}/slow`);
		assert.strictEqual(clicked.title, 'Slow page');
		assert.strictEqual(clicked.status, 200);

		page('/stay', '<button id="b" onclick="this.textContent=\'done\'">Go</button>');
		await service.navigate(sessionId, tabId, `${base}/stay`);
		const stayed = await service.clickElement(sessionId, tabId, '#b');
		assert.deepStrictEqual([stayed.navigated, stayed.url], [false, `${base}/stay`]);
	});

	test('a form submit to a slow handler waits for the response page (was: fixed 500ms sleep)', async () => {
		page('/form', '<form id="f" action="/thanks"><input name="q"><button>Send</button></form>');
		page('/thanks', '<title>Thanks</title>ok', { delayMs: 1200 });
		await service.navigate(sessionId, tabId, `${base}/form`);
		await service.fillElement(sessionId, tabId, 'input[name="q"]', 'shoes');
		const submitted = await service.submitForm(sessionId, tabId, '#f');
		assert.deepStrictEqual([submitted.navigated, submitted.url, submitted.title], [true, `${base}/thanks?q=shoes`, 'Thanks']);
	});

	test('downloads are actually fetched (was: waited for a download event nothing triggered; always failed after 30s)', async () => {
		routes.set('/report.csv', { body: 'a,b\n1,2\n', type: 'text/csv', headers: { 'content-disposition': 'attachment; filename="q3-report.csv"' } });
		page('/', '<a href="/report.csv">report</a>');
		await service.navigate(sessionId, tabId, `${base}/`);
		const started = Date.now();
		const d = await service.startDownload(sessionId, tabId, '/report.csv'); // relative to the page
		assert.strictEqual(d.status, 'completed', d.failureText);
		assert.ok(Date.now() - started < 10_000);
		assert.strictEqual(d.suggestedFilename, 'q3-report.csv');
		assert.strictEqual(fs.readFileSync(d.path!, 'utf8'), 'a,b\n1,2\n');
		fs.rmSync(d.path!, { force: true });

		const missing = await service.startDownload(sessionId, tabId, `${base}/nope.zip`);
		assert.strictEqual(missing.status, 'failed');
		assert.match(missing.failureText ?? '', /HTTP 404/);
		assert.strictEqual(missing.path, undefined, 'no path is reported for a file that was never written');
	});

	test('console limit keeps the most recent messages (was: the oldest); uncaught errors are named', async () => {
		page('/', '<script>for (let i = 1; i <= 8; i++) console.error("e" + i); setTimeout(() => { null.x }, 0)</script>');
		await service.navigate(sessionId, tabId, `${base}/`);
		await new Promise(r => setTimeout(r, 300));
		const last = await service.getConsoleMessages(sessionId, tabId, { level: 'error', limit: 2 });
		assert.deepStrictEqual(last.map(m => m.text.startsWith('Uncaught TypeError') ? 'uncaught' : m.text), ['e8', 'uncaught']);
		const inspected = await service.inspectPage(sessionId, tabId);
		assert.strictEqual(inspected.consoleErrors, 9);
		assert.match(inspected.recentConsoleErrors.join('\n'), /Uncaught TypeError: Cannot read properties of null/);
	});

	test('layout defects are measured: overflow, a covered button, an off-screen control, clipped text', async () => {
		page('/', `
			<style>body{margin:0;font:16px sans-serif} .banner{width:1400px;height:40px;background:#eee}
			.box{width:60px;height:20px;overflow:hidden;white-space:nowrap} .overlay{position:fixed;left:0;top:100px;width:400px;height:80px;background:rgba(0,0,0,.5)}
			#buy{position:absolute;left:20px;top:120px} #lost{position:absolute;left:-500px;top:10px}</style>
			<div class="banner">Wide banner</div><div class="box" id="name">A very long product name</div>
			<button id="buy">Buy now</button><button id="lost">Help</button><div class="overlay" id="cookie"></div>`);
		await service.navigate(sessionId, tabId, `${base}/`);
		const issues = (await service.inspectPage(sessionId, tabId)).layoutIssues;
		const kinds = (k: string) => issues.filter(i => i.kind === k);
		assert.deepStrictEqual(kinds('horizontal-overflow').map(i => i.selector), ['body > div:nth-of-type(1)'], JSON.stringify(issues));
		assert.match(kinds('horizontal-overflow')[0].detail, /x=1400px but the viewport is 800px/);
		assert.deepStrictEqual(kinds('covered').map(i => i.selector), ['#buy']);
		assert.match(kinds('covered')[0].detail, /covered by #cookie/);
		assert.deepStrictEqual(kinds('offscreen').map(i => i.selector), ['#lost']);
		assert.deepStrictEqual(kinds('clipped-text').map(i => i.selector), ['#name']);

		page('/clean', '<style>.t{width:60px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}</style><h1>Fine</h1><div class="t">Truncated on purpose</div><button>OK</button>');
		await service.navigate(sessionId, tabId, `${base}/clean`);
		assert.deepStrictEqual((await service.inspectPage(sessionId, tabId)).layoutIssues, [], 'a clean page (and a deliberate ellipsis) reports nothing');
	});

	test('a layout that only breaks at phone width is caught after set_viewport; visibility flags are reported', async () => {
		page('/', `<style>.row{display:flex;gap:8px}.card{flex:0 0 300px}</style><div class="row"><div class="card">A</div><div class="card">B</div></div>
			<button id="shown" style="display:block">Shown</button><button id="hidden" style="display:none">Hidden</button><button id="below" style="display:block;margin-top:2000px">Below</button>`);
		await service.navigate(sessionId, tabId, `${base}/`);
		assert.deepStrictEqual((await service.inspectPage(sessionId, tabId)).layoutIssues, []);
		await service.setViewport(sessionId, tabId, { width: 375, height: 667 });
		const phone = await service.inspectPage(sessionId, tabId);
		assert.deepStrictEqual(phone.viewport, { width: 375, height: 667 });
		assert.deepStrictEqual(phone.layoutIssues.map(i => `${i.kind} ${i.selector}`), ['horizontal-overflow body > div > div:nth-of-type(2)']);
		const flags = Object.fromEntries(phone.elements.map(e => [e.selector, [e.visible, e.inViewport]]));
		assert.deepStrictEqual(flags, { '#shown': [true, true], '#hidden': [false, false], '#below': [true, false] });
	});

	test('browser_shutdown closes every session but does not disable the browser for good (was: every later launch failed until restart)', async () => {
		await service.shutdown();
		assert.deepStrictEqual(await service.listSessions(), []);
		sessionId = (await service.launchBrowser({ headless: true })).sessionId; // teardown closes it
		tabId = (await service.newTab(sessionId, {})).tabId;
		page('/', '<h1>again</h1>');
		assert.match((await service.navigate(sessionId, tabId, `${base}/`)).url, /127\.0\.0\.1/);
	});

	test('screenshots are written to disk and the path is reported', async () => {
		page('/', '<h1>Smile</h1>');
		await service.navigate(sessionId, tabId, `${base}/`);
		const shot = await service.takeScreenshot(sessionId, tabId, { type: 'viewport' });
		assert.ok(fs.statSync(shot.path).size > 100);
		assert.deepStrictEqual(fs.readFileSync(shot.path).subarray(1, 4).toString(), 'PNG');
		fs.rmSync(shot.path, { force: true });
	});
});
