/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KodiaBrowserMainService } from '../../electron-main/browserMainService.js';

suite('Kodia - Browser Automation (Playwright/Chromium)', function () {
	// every test launches a real Chromium (1-5s here): mocha's 5s default made a different test time out each run
	this.timeout(60_000);

	let service: KodiaBrowserMainService;
	let sessionId: string;
	let tabId: string;
	const artifacts: string[] = [];

	setup(async () => {
		service = new KodiaBrowserMainService();
	});

	teardown(async () => {
		// Close any session we opened.
		if (sessionId) {
			try { await service.closeBrowser(sessionId); } catch { }
		}
		for (const f of artifacts) {
			try { fs.rmSync(f, { force: true, recursive: true }); } catch { }
		}
	});

	const writeArtifact = (name: string, content: string): string => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-browser-test-'));
		const filePath = path.join(dir, name);
		fs.writeFileSync(filePath, content);
		artifacts.push(dir);
		return filePath;
	};

	const fileUrl = (filePath: string): string => {
		// file:// URL for Windows and POSIX.
		const abs = path.resolve(filePath);
		return `file:///${abs.replace(/\\/g, '/')}`;
	};

	test('launches a browser session and reports its version', async () => {
		const result = await service.launchBrowser({ headless: true });
		assert.ok(result.sessionId, 'sessionId should be returned');
		assert.strictEqual(result.engine, 'chromium');
		assert.strictEqual(result.headless, true);
		assert.ok(result.version);
		sessionId = result.sessionId;
	});

	test('opens a tab, navigates, and reports title and URL', async () => {
		const launch = await service.launchBrowser({ headless: true });
		sessionId = launch.sessionId;

		const homepage = writeArtifact('homepage.html', `
			<!DOCTYPE html><html><head><title>WonderCommerce Home</title></head>
			<body>
				<h1>WonderCommerce</h1>
				<nav>
					<a id="nav-products" href="/products.html">Products</a>
					<a id="nav-about" href="/about.html">About</a>
				</nav>
			</body></html>`);
		const tab = await service.newTab(sessionId, { url: fileUrl(homepage) });
		tabId = tab.tabId;

		assert.ok(tabId);
		assert.strictEqual(tab.url, fileUrl(homepage));
		assert.strictEqual(tab.title, 'WonderCommerce Home');
	});

	test('inspectPage returns visible text, elements, and forms', async () => {
		const launch = await service.launchBrowser({ headless: true });
		sessionId = launch.sessionId;

		const page = writeArtifact('products.html', `
			<!DOCTYPE html><html><head><title>Products - WonderCommerce</title></head>
			<body>
				<h1>Our Products</h1>
				<p id="welcome">Welcome to the product catalog.</p>
				<button id="add-to-cart">Add to cart</button>
				<form id="contact" action="/contact" method="post">
					<input name="name" placeholder="Your name" />
					<input name="email" type="email" placeholder="Email" />
					<select name="topic">
						<option value="support">Support</option>
						<option value="sales">Sales</option>
					</select>
					<input type="checkbox" name="tos" id="tos" />
					<button type="submit">Send</button>
				</form>
			</body></html>`);
		const tab = await service.newTab(sessionId, { url: fileUrl(page) });
		tabId = tab.tabId;

		const inspected = await service.inspectPage(sessionId, tabId);
		assert.strictEqual(inspected.title, 'Products - WonderCommerce');
		assert.strictEqual(inspected.url, fileUrl(page));
		assert.ok(inspected.text.includes('Our Products'));
		assert.ok(inspected.text.includes('Welcome to the product catalog.'));

		const buttons = inspected.elements.filter(e => e.type === 'button');
		assert.ok(buttons.some(b => b.label === 'Add to cart' || b.label === 'Send'),
			'expect Add to cart / Send buttons, got: ' + JSON.stringify(buttons.map(b => b.label)));

		const selects = inspected.elements.filter(e => e.type === 'select');
		assert.ok(selects.length > 0, 'expect a <select>');
		assert.ok(selects[0].options && selects[0].options.includes('support'));

		const checkboxes = inspected.elements.filter(e => e.type === 'checkbox');
		assert.ok(checkboxes.length > 0, 'expect a checkbox');

		const forms = inspected.forms;
		assert.ok(forms.some(f => f.selector === '#contact'), 'expect #contact form');
		assert.strictEqual(forms.find(f => f.selector === '#contact')?.method, 'post');
	});

	test('clickElement navigates to a linked page', async () => {
		const launch = await service.launchBrowser({ headless: true });
		sessionId = launch.sessionId;

		const homepage = writeArtifact('homepage2.html', `
			<!DOCTYPE html><html><head><title>Home</title></head>
			<body><a id="go-products" href="products2.html">Products</a></body></html>`);
		const product = writeArtifact('products2.html', `<!DOCTYPE html><html><head><title>Products Page</title></head><body><h1>Products</h1></body></html>`);
		// serve both from the same dir so relative href resolves
		const dir = path.dirname(homepage);
		fs.writeFileSync(path.join(dir, 'products2.html'), fs.readFileSync(product, 'utf8'));

		const tab = await service.newTab(sessionId, { url: fileUrl(homepage) });
		tabId = tab.tabId;

		const inspected = await service.inspectPage(sessionId, tabId);
		const link = inspected.elements.find(e => e.type === 'link' && e.selector === '#go-products');
		assert.ok(link, 'expect #go-products link');

		await service.clickElement(sessionId, tabId, '#go-products');

		const after = await service.inspectPage(sessionId, tabId);
		assert.ok(after.url.includes('products2.html'), 'expected navigation to products2, got ' + after.url);
		assert.strictEqual(after.title, 'Products Page');
		tabId = after && after.url ? tabId : tabId;
	});

	test('fillElement and checkElement and selectOption', async () => {
		const launch = await service.launchBrowser({ headless: true });
		sessionId = launch.sessionId;

		const page = writeArtifact('form.html', `
			<!DOCTYPE html><html><head><title>Form</title></head>
			<body>
				<form id="f" action="/submit" method="post">
					<input name="user" />
					<select name="choice"><option value="a">A</option><option value="b">B</option></select>
					<input type="checkbox" name="agree" id="agree" />
				</form>
			</body></html>`);
		const tab = await service.newTab(sessionId, { url: fileUrl(page) });
		tabId = tab.tabId;

		await service.fillElement(sessionId, tabId, 'input[name="user"]', 'Ada');
		await service.selectOption(sessionId, tabId, 'select[name="choice"]', 'b');
		await service.checkElement(sessionId, tabId, 'input[name="agree"]', true);

		const inspected = await service.inspectPage(sessionId, tabId);
		const input = inspected.elements.find(e => e.selector === 'input[name="user"]');
		assert.strictEqual(input && input.value, 'Ada', 'input should be filled');
		const cb = inspected.elements.find(e => e.type === 'checkbox');
		assert.strictEqual(cb && cb.checked, true, 'checkbox should be checked');
	});

	test('submitForm submits and navigates', async () => {
		const launch = await service.launchBrowser({ headless: true });
		sessionId = launch.sessionId;

		const page = writeArtifact('form2.html', `
			<!DOCTYPE html><html><head><title>Form2</title></head>
			<body>
				<form id="f" action="thanks.html" method="get">
					<input name="user" />
					<button type="submit">Go</button>
				</form>
			</body></html>`);
		const thanks = writeArtifact('thanks.html', `<!DOCTYPE html><html><head><title>Thanks</title></head><body><h1>Thanks</h1></body></html>`);
		const dir = path.dirname(page);
		fs.writeFileSync(path.join(dir, 'thanks.html'), fs.readFileSync(thanks, 'utf8'));

		const tab = await service.newTab(sessionId, { url: fileUrl(page) });
		tabId = tab.tabId;

		await service.fillElement(sessionId, tabId, 'input[name="user"]', 'Ada');
		const result = await service.submitForm(sessionId, tabId, '#f');
		assert.ok(result.url.includes('thanks.html'), 'expected form submission to navigate to thanks.html, got ' + result.url);
		assert.strictEqual(result.title, 'Thanks');
	});

	test('waitForElement does not hang on a missing selector', async () => {
		const launch = await service.launchBrowser({ headless: true });
		sessionId = launch.sessionId;
		const tab = await service.newTab(sessionId, { url: fileUrl(writeArtifact('empty.html', '<html><body><h1>hi</h1></body></html>')) });
		tabId = tab.tabId;

		const start = Date.now();
		const found = await service.waitForElement(sessionId, tabId, '#does-not-exist', { timeoutMs: 2000 });
		const elapsed = Date.now() - start;
		assert.strictEqual(found.found, false);
		assert.ok(elapsed < 6000, 'should time out quickly, not hang (' + elapsed + 'ms)');
	});

	test('multiple tabs are independent', async () => {
		const launch = await service.launchBrowser({ headless: true });
		sessionId = launch.sessionId;

		const a = writeArtifact('a.html', '<html><head><title>Page A</title></head><body>A</body></html>');
		const b = writeArtifact('b.html', '<html><head><title>Page B</title></head><body>B</body></html>');

		const t1 = await service.newTab(sessionId, { url: fileUrl(a) });
		const t2 = await service.newTab(sessionId, { url: fileUrl(b) });

		let tabs = await service.listTabs(sessionId);
		assert.strictEqual(tabs.length, 2);
		// first opened tab is the active one
		assert.strictEqual(tabs.find(t => t.isActive)?.tabId, t1.tabId);

		await service.switchTab(sessionId, t2.tabId);
		tabs = await service.listTabs(sessionId);
		assert.strictEqual(tabs.find(t => t.isActive)?.tabId, t2.tabId);

		const inspected = await service.inspectPage(sessionId, t2.tabId);
		assert.strictEqual(inspected.title, 'Page B');

		await service.closeTab(sessionId, t1.tabId);
		const remaining = await service.listTabs(sessionId);
		assert.strictEqual(remaining.length, 1);
		assert.strictEqual(remaining[0].tabId, t2.tabId);
	});

	test('screenshot returns image data', async () => {
		const launch = await service.launchBrowser({ headless: true });
		sessionId = launch.sessionId;
		const tab = await service.newTab(sessionId, { url: fileUrl(writeArtifact('screenshot.html', '<html><body><h1>Smile</h1></body></html>')) });
		tabId = tab.tabId;

		const shot = await service.takeScreenshot(sessionId, tabId, { type: 'viewport' });
		assert.ok(shot.dataUrl.startsWith('data:image/png;base64,'), 'expected a PNG data URL');
		assert.ok(shot.width > 0 && shot.height > 0);
		assert.strictEqual(shot.type, 'viewport');
	});

	test('retrieves console errors', async () => {
		const launch = await service.launchBrowser({ headless: true });
		sessionId = launch.sessionId;
		const tab = await service.newTab(sessionId, { url: fileUrl(writeArtifact('console.html', '<html><body><script>console.error("boom");</script></body></html>')) });
		tabId = tab.tabId;

		// give the page a moment to execute the script
		await new Promise(r => setTimeout(r, 500));
		const messages = await service.getConsoleMessages(sessionId, tabId, { level: 'error' });
		assert.ok(messages.length > 0, 'expected at least one console error');
		assert.ok(messages.some(m => m.text.includes('boom')), 'expected "boom" error, got: ' + JSON.stringify(messages.map(m => m.text)));
	});

	test('failed navigation returns a useful error', async () => {
		const launch = await service.launchBrowser({ headless: true });
		sessionId = launch.sessionId;
		const tab = await service.newTab(sessionId, { url: 'about:blank' });
		tabId = tab.tabId;

		let threw = false;
		try {
			await service.navigate(sessionId, tabId, 'http://127.0.0.1:1/invalid-port-nonexistent.kodia.test/');
		} catch (e) {
			threw = true;
			assert.ok(String(e).includes('Navigation failed'), 'expected Navigation failed, got: ' + e);
		}
		assert.ok(threw, 'expected navigate to throw for an unreachable host');
	});

	test('shutdown closes all sessions and releases processes', async () => {
		const s2 = await service.launchBrowser({ headless: true });
		await service.newTab(s2.sessionId, { url: 'about:blank' });
		const countBefore = (await service.listSessions()).length;
		assert.ok(countBefore >= 1);

		await service.shutdown();
		const countAfter = await service.listSessions();
		assert.strictEqual(countAfter.length, 0, 'all sessions should be closed after shutdown');
	});
});
