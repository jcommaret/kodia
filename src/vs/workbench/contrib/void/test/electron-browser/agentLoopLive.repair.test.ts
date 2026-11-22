/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * LIVE acceptance scenarios 4 (debugger-driven repair) and 3 (browser-driven repair) against a real NVIDIA-hosted
 * model. Nothing about the model's behaviour is scripted; the debugger is VS Code's real DebugSession with debugpy,
 * the browser is real Chromium in its own process. Verified independently afterwards.
 *
 * Needs NVIDIA_API_KEY (optionally NVIDIA_MODEL) in the git-ignored repo-root .env; skipped otherwise.
 * Evidence (no secrets): %TEMP%/kodia-live-{debug,browser}-repair-evidence-<model>.json
 * Run: scripts\test.bat --runGlob vs/workbench/contrib/void/test/electron-browser/agentLoopLive.repair.test.js
 */

import assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IDebugService } from '../../../debug/common/debug.js';
import { KodiaDebugToolService } from '../../browser/debugToolService.js';
import { KodiaDebuggerActivityService } from '../../browser/debuggerActivityService.js';
import { defaultSettingsOfProvider, SettingsOfProvider } from '../../common/voidSettingsTypes.js';
import { createHarness, ProcessTerminalToolService, runTurn, toolMessages } from './agentHarness.js';
import { startBrowserServiceProcess } from './browserServiceProcess.js';
import { createRealDebugStack } from './debugHarness.js';
import { LiveLLMService, readDotEnv } from './liveModel.js';

const evidenceFile = (kind: string, model: string) => path.join(os.tmpdir(), `kodia-live-${kind}-repair-evidence-${model.replace(/[^a-z0-9.-]+/gi, '_')}.json`);

suite('Kodia - LIVE repair workflows against NVIDIA (acceptance scenarios 4 and 3)', function () {
	this.timeout(40 * 60_000);

	const env = readDotEnv();
	const apiKey = env.NVIDIA_API_KEY ?? process.env.NVIDIA_API_KEY;
	const modelName = env.NVIDIA_MODEL ?? process.env.NVIDIA_MODEL ?? 'nvidia/nemotron-3.5-super-vl-120b-a12b';
	const settingsOfProvider = (): SettingsOfProvider => ({ ...defaultSettingsOfProvider, nvidia: { ...defaultSettingsOfProvider.nvidia, apiKey: apiKey!, _didFillInProviderSettings: true } });

	let store: DisposableStore;
	let dir: string;
	setup(function () {
		if (!apiKey) { this.skip(); }
		store = new DisposableStore();
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-live-repair-')));
	});
	teardown(() => { store?.dispose(); });

	test('scenario 4: a real model debugs a Python program with breakpoints and variables, finds the bug and fixes it', async () => {
		const program = path.join(dir, 'invoice.py');
		fs.writeFileSync(program, [
			'def line_total(price, qty, discount_pct):',
			'    discount = price * discount_pct / 100',
			'    return (price - discount) * qty',
			'',
			'def invoice_total(lines):',
			'    total = 0',
			'    for price, qty, discount_pct in lines:',
			'        total = line_total(price, qty, discount_pct)',
			'    return round(total, 2)',
			'',
			'if __name__ == "__main__":',
			'    lines = [(10.0, 2, 0), (5.0, 4, 10), (20.0, 1, 50)]',
			'    print(f"TOTAL={invoice_total(lines)}")',
			'',
		].join('\n'));

		const { debugService } = createRealDebugStack(dir, store);
		const inst = store.add(new InstantiationService(new ServiceCollection([IDebugService, debugService as any]), true));
		const debugTools = store.add(inst.createInstance(KodiaDebugToolService));
		const llm = new LiveLLMService(settingsOfProvider());
		const { chat } = createHarness(dir, llm, store, {
			modelSelection: { providerName: 'nvidia', modelName }, settingsOfProvider: settingsOfProvider(),
			terminal: new ProcessTerminalToolService(dir, 120_000), debug: debugTools, debuggerActivity: new KodiaDebuggerActivityService(),
		});

		const config = JSON.stringify({ type: 'debugpy', request: 'launch', name: 'invoice', program, console: 'internalConsole', justMyCode: true, cwd: dir });
		const instruction = [
			`${program} prints TOTAL=10.0 but the expected total is 48.0 (20 + 18 + 10). Investigate it WITH THE DEBUGGER: set a breakpoint inside the loop of invoice_total, start a debug session with this launch configuration: ${config}`,
			`then inspect the variables over a few iterations (continue / step / evaluate) to find out why the total is wrong. Then stop the debug session, fix the bug in the file, and run \`python "${program}"\` to confirm it prints TOTAL=48.0. Reply with what the bug was and how you found it.`,
		].join('\n');

		const started = Date.now();
		const { messages, streamState } = await runTurn(chat, instruction, 30 * 60_000);
		const run = cp.spawnSync('python', [program], { encoding: 'utf8', timeout: 60_000 });
		const tools = toolMessages(messages).map((t: any) => ({ name: t.name, type: t.type, error: t.type === 'success' ? undefined : String(t.content).slice(0, 300) }));
		const evidence = {
			when: new Date().toISOString(), model: modelName, elapsedMs: Date.now() - started, program, requests: llm.records, toolCalls: tools,
			streamState: { error: streamState?.error?.message ?? null }, programOutput: `${run.stdout}${run.stderr}`.slice(-1000), source: fs.readFileSync(program, 'utf8'),
			finalText: String((messages.filter((m: any) => m.role === 'assistant').at(-1) as any)?.displayContent ?? '').slice(0, 2000),
		};
		fs.writeFileSync(evidenceFile('debug', modelName), JSON.stringify(evidence, null, 2));

		const ok = (name: string) => tools.some(t => t.name === name && t.type === 'success');
		assert.ok(!streamState?.error, `agent ended with an error: ${streamState?.error?.message}`);
		assert.ok(ok('debug_set_breakpoint') && ok('debug_start_session'), `a breakpoint and a real debug session: ${tools.map(t => `${t.name}:${t.type}`).join(', ')}`);
		assert.ok(['debug_get_variables', 'debug_evaluate_expression', 'debug_get_scopes', 'debug_get_stack_trace'].some(ok), 'execution state was inspected');
		assert.match(evidence.programOutput, /TOTAL=48\.0/, `the fixed program prints the right total:\n${evidence.programOutput}`);
	});

	test('scenario 3: a real model finds a JS error and a covered button on a live page, fixes both, and verifies in the browser', async () => {
		const files: Record<string, string> = {
			'index.html': '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Shop</title><link rel="stylesheet" href="styles.css"></head>\n<body>\n\t<h1>Shop</h1>\n\t<button id="add">Add to cart</button>\n\t<p id="cartCount">Cart (0)</p>\n\t<button id="checkout">Checkout</button>\n\t<div id="promo" class="promo">Free shipping this week!</div>\n\t<script src="app.js"></script>\n</body></html>\n',
			'styles.css': 'body { margin: 0; padding: 16px; font: 16px sans-serif; }\n#checkout { position: fixed; right: 16px; bottom: 16px; padding: 8px 16px; }\n.promo { position: fixed; left: 0; right: 0; bottom: 0; height: 64px; background: #fde68a; z-index: 10; }\n',
			'app.js': "let count = 0;\ndocument.getElementById('add').addEventListener('click', () => {\n\tcount++;\n\tdocument.getElementById('cart-count').textContent = `Cart (${count})`;\n});\n",
		};
		for (const [rel, c] of Object.entries(files)) { fs.writeFileSync(path.join(dir, rel), c); }
		const server = http.createServer((req, res) => {
			const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
			const file = path.join(dir, rel);
			if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(rel === 'favicon.ico' ? 204 : 404); res.end(); return; }
			const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' }[path.extname(file)] ?? 'text/plain';
			res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
			res.end(fs.readFileSync(file));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		store.add({ dispose: () => server.close() });
		const { service: browser, stop } = await startBrowserServiceProcess();
		try {
			const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
			const llm = new LiveLLMService(settingsOfProvider());
			const { chat } = createHarness(dir, llm, store, { modelSelection: { providerName: 'nvidia', modelName }, settingsOfProvider: settingsOfProvider(), mainProcessServices: { 'void-channel-browser': browser } });
			const instruction = `The shop page at ${url} (served from ${dir}; reload to see changes) is broken: users say "Add to cart" does nothing and they cannot click "Checkout". Use the browser tools (launch it headless) to inspect the page — its measured layout problems and console errors — find the causes, fix the files in ${dir}, then reload and verify in the browser that the layout problem is gone and that clicking "Add to cart" updates the cart to "Cart (1)". Reply with what you found and fixed.`;
			const started = Date.now();
			const { messages, streamState } = await runTurn(chat, instruction, 30 * 60_000);
			const tools = toolMessages(messages).map((t: any) => ({ name: t.name, type: t.type, error: t.type === 'success' ? undefined : String(t.content).slice(0, 300) }));
			const evidence: Record<string, unknown> = {
				when: new Date().toISOString(), model: modelName, elapsedMs: Date.now() - started, requests: llm.records, toolCalls: tools,
				streamState: { error: streamState?.error?.message ?? null },
				files: Object.fromEntries(Object.keys(files).map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')])),
				finalText: String((messages.filter((m: any) => m.role === 'assistant').at(-1) as any)?.displayContent ?? '').slice(0, 2000),
			};
			fs.writeFileSync(evidenceFile('browser', modelName), JSON.stringify(evidence, null, 2)); // before the checks: they may throw

			// independent check, in a fresh browser session (this also proves the browser still works after the agent's own cleanup)
			const { sessionId } = await browser.launchBrowser({ headless: true });
			const { tabId } = await browser.newTab(sessionId, { url });
			const before = await browser.inspectPage(sessionId, tabId);
			let clickError: string | undefined;
			try { await browser.clickElement(sessionId, tabId, '#add'); } catch (e) { clickError = String(e); }
			const after = await browser.inspectPage(sessionId, tabId);
			await browser.closeBrowser(sessionId);
			Object.assign(evidence, { layoutIssuesAfter: before.layoutIssues, consoleErrorsAfterClick: after.recentConsoleErrors, clickError, pageTextAfterClick: after.text.slice(0, 300) });
			fs.writeFileSync(evidenceFile('browser', modelName), JSON.stringify(evidence, null, 2));

			assert.ok(!streamState?.error, `agent ended with an error: ${streamState?.error?.message}`);
			assert.ok(tools.some(t => t.name === 'browser_inspect_page' && t.type === 'success'), 'the model inspected the page in the browser');
			assert.ok(tools.some(t => (t.name === 'edit_file' || t.name === 'write_file' || t.name === 'rewrite_file') && t.type === 'success'), 'the model changed the files');
			assert.deepStrictEqual(before.layoutIssues.filter(i => i.kind === 'covered'), [], `no control is covered any more: ${JSON.stringify(before.layoutIssues)}`);
			assert.strictEqual(clickError, undefined);
			assert.match(after.text, /Cart \(1\)/, 'clicking Add to cart updates the cart');
			assert.strictEqual(after.consoleErrors, 0, `no console errors: ${after.recentConsoleErrors}`);
		} finally {
			await stop();
		}
	});
});
