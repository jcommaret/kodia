/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * LIVE acceptance scenario 2 (complete application) against a real NVIDIA-hosted model. Nothing about the model's
 * behaviour is scripted. It must build a small full-stack app — backend with a REST API, file-based database,
 * frontend, tests, README — with no dependencies. The test then verifies independently: it starts the app, calls the
 * API over HTTP, uses the frontend in a real browser (adds a todo through the page), and runs the app's own tests.
 *
 * Needs NVIDIA_API_KEY (optionally NVIDIA_MODEL) in the git-ignored repo-root .env; skipped otherwise.
 * Evidence (no secrets): %TEMP%/kodia-live-app-evidence-<model>.json
 * Run: scripts\test.bat --runGlob vs/workbench/contrib/void/test/electron-browser/agentLoopLive.app.test.js
 */

import assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IBrowserService } from '../../common/browserServiceTypes.js';
import { defaultSettingsOfProvider, SettingsOfProvider } from '../../common/voidSettingsTypes.js';
import { createHarness, ProcessTerminalToolService, runTurn, toolMessages } from './agentHarness.js';
import { startBrowserServiceProcess } from './browserServiceProcess.js';
import { LiveLLMService, readDotEnv } from './liveModel.js';

const freePort = () => new Promise<number>((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); s.on('error', reject); });
const waitForPort = async (port: number, ms: number) => {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		const ok = await new Promise<boolean>(resolve => { const c = net.connect(port, '127.0.0.1', () => { c.end(); resolve(true); }); c.on('error', () => resolve(false)); });
		if (ok) { return true; }
		await new Promise(r => setTimeout(r, 300));
	}
	return false;
};

suite('Kodia - LIVE complete application against NVIDIA (acceptance scenario 2)', function () {
	this.timeout(40 * 60_000);

	const env = readDotEnv();
	const apiKey = env.NVIDIA_API_KEY ?? process.env.NVIDIA_API_KEY;
	const modelName = env.NVIDIA_MODEL ?? process.env.NVIDIA_MODEL ?? 'nvidia/nemotron-3.5-super-vl-120b-a12b';

	let store: DisposableStore;
	let dir: string;
	let app: cp.ChildProcess | undefined;
	let browser: IBrowserService;
	let stopBrowser: () => Promise<void>;

	setup(async function () {
		if (!apiKey) { this.skip(); }
		store = new DisposableStore();
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-live-app-')));
		({ service: browser, stop: stopBrowser } = await startBrowserServiceProcess());
	});
	teardown(async () => {
		if (!apiKey) { return; }
		if (app && app.exitCode === null) { cp.spawnSync('taskkill', ['/pid', String(app.pid), '/t', '/f']); app.kill(); }
		await stopBrowser?.();
		store.dispose();
	});

	test('a real model builds a full-stack todo app (API, file database, frontend, tests, README) that actually works', async () => {
		const settingsOfProvider: SettingsOfProvider = { ...defaultSettingsOfProvider, nvidia: { ...defaultSettingsOfProvider.nvidia, apiKey: apiKey!, _didFillInProviderSettings: true } };
		const llm = new LiveLLMService(settingsOfProvider);
		const terminal = new ProcessTerminalToolService(dir, 180_000);
		const { chat } = createHarness(dir, llm, store, {
			modelSelection: { providerName: 'nvidia', modelName }, settingsOfProvider, terminal,
			mainProcessServices: { 'void-channel-browser': browser },
		});

		const appDir = path.join(dir, 'todo-app');
		const instruction = [
			`Build a small but complete todo web application in the folder ${appDir} (it does not exist yet), using only Node.js built-in modules (no npm packages, nothing to install).`,
			`Requirements:`,
			`1. ${path.join(appDir, 'package.json')} with "type": "module", a "start" script "node server.js" and a "test" script "node --test".`,
			`2. ${path.join(appDir, 'server.js')}: an HTTP server listening on the port in the PORT environment variable (default 3000). It serves public/index.html at GET /, and a JSON REST API: GET /api/todos returns the array of todos; POST /api/todos with a JSON body {"title": "..."} creates a todo {id, title, done: false} and returns it with status 201; a POST with a missing or empty title returns 400.`,
			`3. The database is a JSON file (path from the DB_FILE environment variable, default data/todos.json); create it if it does not exist. Todos must survive a server restart.`,
			`4. ${path.join(appDir, 'public', 'index.html')}: a page that loads the todos from the API and shows each title in a list with id "todos" (one <li> per todo), and a form with an input with id "title" and a submit button that adds a todo through the API and shows it without reloading the page.`,
			`5. ${path.join(appDir, 'test', 'api.test.js')}: tests with node:test that start the server on a free port with a temporary DB_FILE and check creating and listing todos and the 400 case.`,
			`6. ${path.join(appDir, 'README.md')} explaining how to run and test it.`,
			`Run the tests and fix any problem until they pass. Then reply with a short summary.`,
		].join('\n');

		const started = Date.now();
		const { messages, streamState } = await runTurn(chat, instruction, 35 * 60_000);
		const elapsedMs = Date.now() - started;

		// ---- independent verification ----
		const exists = (...s: string[]) => fs.existsSync(path.join(appDir, ...s));
		const files = { packageJson: exists('package.json'), server: exists('server.js'), index: exists('public', 'index.html'), test: exists('test', 'api.test.js'), readme: exists('README.md') };
		const nodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
		const ownTests = files.test ? cp.spawnSync('node', ['--test'], { cwd: appDir, encoding: 'utf8', timeout: 180_000, env: nodeEnv }) : undefined;

		const port = await freePort();
		const dbFile = path.join(dir, 'verify-db.json');
		const startApp = () => { app = cp.spawn('node', ['server.js'], { cwd: appDir, env: { ...nodeEnv, PORT: String(port), DB_FILE: dbFile }, stdio: 'ignore', windowsHide: true }); return waitForPort(port, 15_000); };
		const api = `http://127.0.0.1:${port}`;
		const checks: Record<string, unknown> = {};
		if (files.server && await startApp()) {
			checks.listInitially = await (await fetch(`${api}/api/todos`)).json();
			const created = await fetch(`${api}/api/todos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'buy milk' }) });
			checks.createStatus = created.status;
			checks.created = await created.json().catch(() => null);
			checks.badStatus = (await fetch(`${api}/api/todos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '' }) })).status;
			// persistence: restart the server on the same database
			cp.spawnSync('taskkill', ['/pid', String(app!.pid), '/t', '/f']); app!.kill();
			await new Promise(r => setTimeout(r, 500));
			checks.restarted = await startApp();
			checks.listAfterRestart = await (await fetch(`${api}/api/todos`)).json();
			// the frontend, in a real browser: it lists the todo, and adds one through the form
			const { sessionId } = await browser.launchBrowser({ headless: true });
			const { tabId } = await browser.newTab(sessionId, { url: `${api}/` });
			await browser.waitForElement(sessionId, tabId, '#todos li', { timeoutMs: 10_000 });
			checks.pageListsTodo = (await browser.inspectPage(sessionId, tabId)).text.includes('buy milk');
			await browser.fillElement(sessionId, tabId, '#title', 'walk the dog');
			await browser.clickElement(sessionId, tabId, 'button[type="submit"], form button').catch(async () => browser.submitForm(sessionId, tabId, 'form'));
			await new Promise(r => setTimeout(r, 1000));
			checks.pageAddsTodo = (await browser.inspectPage(sessionId, tabId)).text.includes('walk the dog');
			checks.apiHasPageTodo = JSON.stringify(await (await fetch(`${api}/api/todos`)).json()).includes('walk the dog');
			await browser.closeBrowser(sessionId);
		}

		const tools = toolMessages(messages).map((t: any) => ({ name: t.name, type: t.type, error: t.type === 'success' ? undefined : String(t.content).slice(0, 300) }));
		const evidence = {
			when: new Date().toISOString(), provider: 'nvidia', model: modelName, elapsedMs, appDir,
			requests: llm.records, toolCalls: tools, terminalCommands: terminal.commands,
			streamState: { isRunning: streamState?.isRunning ?? null, error: streamState?.error?.message ?? null },
			files, ownTests: ownTests ? { exitCode: ownTests.status, output: `${ownTests.stdout}\n${ownTests.stderr}`.slice(-3000) } : null, checks,
			finalText: String((messages.filter((m: any) => m.role === 'assistant').at(-1) as any)?.displayContent ?? '').slice(0, 2000),
		};
		fs.writeFileSync(path.join(os.tmpdir(), `kodia-live-app-evidence-${modelName.replace(/[^a-z0-9.-]+/gi, '_')}.json`), JSON.stringify(evidence, null, 2));

		assert.ok(!streamState?.error, `agent ended with an error: ${streamState?.error?.message}`);
		assert.deepStrictEqual(files, { packageJson: true, server: true, index: true, test: true, readme: true }, 'all parts exist on disk');
		assert.strictEqual(ownTests?.status, 0, `the app's own tests pass:\n${evidence.ownTests?.output}`);
		assert.ok(Array.isArray(checks.listInitially), `GET /api/todos returns an array: ${JSON.stringify(checks.listInitially)}`);
		assert.strictEqual(checks.createStatus, 201, 'POST creates with 201');
		assert.strictEqual((checks.created as any)?.title, 'buy milk');
		assert.strictEqual(checks.badStatus, 400, 'an empty title is rejected');
		assert.ok(checks.restarted && JSON.stringify(checks.listAfterRestart).includes('buy milk'), 'the todo survives a restart (file database)');
		assert.ok(checks.pageListsTodo, 'the page lists the todos');
		assert.ok(checks.pageAddsTodo && checks.apiHasPageTodo, 'the page adds a todo through the API');
	});
});
