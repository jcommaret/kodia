/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 5 / acceptance scenario 3 (browser-driven repair) through the real agent loop: ChatThreadService →
 * ToolsService → the browser channel (ProxyChannel, serialized like IPC) → KodiaBrowserMainService → real Chromium
 * → a real web app served from the workspace by a real HTTP server. The agent finds the defects from what the
 * browser reports, fixes the files on disk, reloads and verifies; the test then re-checks independently.
 *
 * The model is scripted (deterministic), but every decision it makes is gated on the real tool output it
 * received: a step asserts the signal is in the payload before acting on it.
 */

import assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IBrowserService } from '../../common/browserServiceTypes.js';
import { DIVIDER, FINAL, ORIGINAL } from '../../common/prompt/prompts.js';
import { createHarness, runTurn, ScriptedLLMService, ScriptStep, toolMessages } from './agentHarness.js';
import { startBrowserServiceProcess } from './browserServiceProcess.js';

const INDEX_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Kodia Shop</title><link rel="stylesheet" href="styles.css"></head>
<body>
	<h1>Kodia Shop</h1>
	<p class="item">Trail shoes — $80</p>
	<button id="add">Add to cart</button>
	<p id="cartCount">Cart (0)</p>
	<button id="checkout">Checkout</button>
	<div id="promo" class="promo">Free shipping this week!</div>
	<script src="app.js"></script>
</body></html>
`;
const STYLES_CSS = `body { margin: 0; padding: 16px; font: 16px sans-serif; }
#checkout { position: fixed; right: 16px; bottom: 16px; padding: 8px 16px; }
.promo { position: fixed; left: 0; right: 0; bottom: 0; height: 64px; background: #fde68a; z-index: 10; }
`;
const APP_JS = `let count = 0;
document.getElementById('add').addEventListener('click', () => {
	count++;
	document.getElementById('cart-count').textContent = \`Cart (\${count})\`;
});
`;

suite('Kodia - browser-driven repair through the agent loop (roadmap 5, scenario 3)', function () {
	this.timeout(120_000);

	let store: DisposableStore;
	let dir: string;
	let server: http.Server;
	let base: string;
	let browser: IBrowserService;
	let stopBrowser: () => Promise<void>;

	setup(async () => {
		store = new DisposableStore();
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-browser-repair-')));
		fs.writeFileSync(path.join(dir, 'index.html'), INDEX_HTML);
		fs.writeFileSync(path.join(dir, 'styles.css'), STYLES_CSS);
		fs.writeFileSync(path.join(dir, 'app.js'), APP_JS);
		// serves the workspace as it is on disk now: an edit is visible on the next reload
		server = http.createServer((req, res) => {
			const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
			const file = path.join(dir, rel);
			if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(rel === 'favicon.ico' ? 204 : 404); res.end(); return; }
			const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' }[path.extname(file)] ?? 'application/octet-stream';
			res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
			res.end(fs.readFileSync(file));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		({ service: browser, stop: stopBrowser } = await startBrowserServiceProcess());
	});
	teardown(async () => {
		await stopBrowser();
		await new Promise<void>(resolve => server.close(() => resolve()));
		store.dispose();
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});

	test('the agent sees a JS error and a covered button in the browser, fixes both files, and verifies in the browser', async () => {
		const lastToolOutput = (req: { messages: unknown[] }) => JSON.stringify(req.messages[req.messages.length - 1]);
		const sessionOf = (payload: string) => /Browser launched \(session ([\w-]+)/.exec(payload)![1];
		const ids = (payload: string) => ({ session_id: sessionOf(payload), tab_id: /Opened tab ([\w-]+)/.exec(payload)![1] });

		const llm = new ScriptedLLMService((i, req): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			const last = lastToolOutput(req);
			switch (i) {
				case 0: return { text: '', toolCalls: [{ name: 'browser_launch', params: { headless: 'true' } }] };
				case 1: return { text: '', toolCalls: [{ name: 'browser_new_tab', params: { session_id: sessionOf(payload), url: `${base}/` } }] };
				case 2:
					assert.match(last, /Kodia Shop \(HTTP 200\)/, 'the real page loaded');
					return { text: '', toolCalls: [{ name: 'browser_inspect_page', params: ids(payload) }] };
				case 3:
					assert.match(last, /\[covered\] #checkout .*covered by #promo/, 'the measured layout defect reached the model');
					assert.match(last, /\[button\] #add — Add to cart/);
					return { text: '', toolCalls: [{ name: 'browser_click_element', params: { ...ids(payload), selector: '#add' } }] };
				case 4:
					assert.match(last, /no navigation/);
					return { text: '', toolCalls: [{ name: 'browser_console', params: { ...ids(payload), level: 'error' } }] };
				case 5:
					assert.match(last, /Uncaught TypeError: Cannot set properties of null \(setting 'textContent'\)/, 'the real uncaught error reached the model');
					return { text: '', toolCalls: [{ name: 'read_file', params: { uri: path.join(dir, 'index.html') } }] };
				case 6:
					assert.match(last, /id=\\"cartCount\\"/, 'the element id is cartCount, not cart-count');
					return { text: '', toolCalls: [{ name: 'edit_file', params: { uri: path.join(dir, 'app.js'), search_replace_blocks: `${ORIGINAL}\n\tdocument.getElementById('cart-count').textContent\n${DIVIDER}\n\tdocument.getElementById('cartCount').textContent\n${FINAL}` } }] };
				case 7: return { text: '', toolCalls: [{ name: 'edit_file', params: { uri: path.join(dir, 'styles.css'), search_replace_blocks: `${ORIGINAL}\n.promo { position: fixed; left: 0; right: 0; bottom: 0; height: 64px; background: #fde68a; z-index: 10; }\n${DIVIDER}\n.promo { margin-top: 16px; height: 64px; background: #fde68a; }\n${FINAL}` } }] };
				case 8: return { text: '', toolCalls: [{ name: 'browser_reload', params: ids(payload) }] };
				case 9: return { text: '', toolCalls: [{ name: 'browser_click_element', params: { ...ids(payload), selector: '#add' } }] };
				case 10: return { text: '', toolCalls: [{ name: 'browser_inspect_page', params: ids(payload) }] };
				case 11:
					assert.match(last, /Layout problems: none detected/, 'the reloaded page has no layout defect');
					assert.doesNotMatch(last, /CONSOLE ERRORS/, 'and no console error after the click');
					assert.match(last, /Cart \(1\)/, 'the click now updates the cart');
					return { text: '', toolCalls: [{ name: 'browser_close', params: { session_id: sessionOf(payload) } }] };
				default:
					return { text: 'Fixed: app.js used the wrong element id (cart-count → cartCount), and the fixed promo bar covered the Checkout button. Verified in the browser.' };
			}
		});
		const { chat } = createHarness(dir, llm, store, {
			modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' },
			mainProcessServices: { 'void-channel-browser': browser },
			globalSettings: { verifyBeforeFinishing: false },
		});

		const { messages } = await runTurn(chat, 'The shop page is broken: "Add to cart" does nothing and I cannot click Checkout. Find out why in the browser and fix it.', 100_000);
		assert.deepStrictEqual(llm.scriptErrors, [], 'every step found the signal it acts on');
		const tools = toolMessages(messages);
		const errors = tools.filter((t: any) => t.type !== 'success').map((t: any) => `${t.name}: ${t.content}`).join('\n');
		assert.deepStrictEqual(tools.map((t: any) => `${t.name}:${t.type}`), [
			'browser_launch:success', 'browser_new_tab:success', 'browser_inspect_page:success', 'browser_click_element:success',
			'browser_console:success', 'read_file:success', 'edit_file:success', 'edit_file:success', 'browser_reload:success',
			'browser_click_element:success', 'browser_inspect_page:success', 'browser_close:success',
		], errors);
		assert.deepStrictEqual(await browser.listSessions(), [], 'the agent closed its browser');

		// independent check, outside the agent: the files on disk now give a working page
		assert.match(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), /getElementById\('cartCount'\)/);
		const { sessionId } = await browser.launchBrowser({ headless: true });
		const { tabId } = await browser.newTab(sessionId, { url: `${base}/` });
		await browser.clickElement(sessionId, tabId, '#checkout'); // throws if another element would receive the click
		await browser.clickElement(sessionId, tabId, '#add');
		const after = await browser.inspectPage(sessionId, tabId);
		assert.deepStrictEqual([after.layoutIssues, after.consoleErrors], [[], 0]);
		assert.match(after.text, /Cart \(1\)/);
	});
});
