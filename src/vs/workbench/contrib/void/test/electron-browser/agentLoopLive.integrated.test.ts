/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * LIVE acceptance scenario 10 (full integrated workflow) against a real NVIDIA-hosted model. Nothing about the
 * model's behaviour is scripted. In one turn it must use git (branch, commit), find a bug from a failing test, edit
 * the code, run the tests in a real terminal, check the running web page in a real browser, and leave the user's
 * uncommitted work alone. Verification is independent: git history, the files, `node --test` and the page are
 * checked by the test itself afterwards.
 *
 * Needs NVIDIA_API_KEY (optionally NVIDIA_MODEL) in the git-ignored repo-root .env; skipped otherwise.
 * Evidence (no secrets): %TEMP%/kodia-live-integrated-evidence-<model>.json
 * Run: scripts\test.bat --runGlob vs/workbench/contrib/void/test/electron-browser/agentLoopLive.integrated.test.js
 */

import assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { GitToolService } from '../../browser/gitToolService.js';
import { IBrowserService } from '../../common/browserServiceTypes.js';
import { IKodiaGitMainService } from '../../common/gitService.js';
import { defaultSettingsOfProvider, SettingsOfProvider } from '../../common/voidSettingsTypes.js';
import { KodiaGitMainService } from '../../electron-main/kodiaGitMainService.js';
import { createHarness, ProcessTerminalToolService, runTurn, toolMessages } from './agentHarness.js';
import { startBrowserServiceProcess } from './browserServiceProcess.js';
import { LiveLLMService, readDotEnv } from './liveModel.js';

const git = (cwd: string, ...args: string[]) => cp.execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const PROJECT: Record<string, string> = {
	'package.json': JSON.stringify({ name: 'mini-shop', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
	'src/cart.js': '// The total of a cart: each item is { price, qty }.\nexport function total(items) {\n\treturn items.reduce((sum, item) => sum + item.price, 0);\n}\n',
	'test/cart.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { total } from '../src/cart.js';\n\ntest('counts quantities', () => assert.strictEqual(total([{ price: 2, qty: 3 }]), 6));\ntest('sums items', () => assert.strictEqual(total([{ price: 1.5, qty: 2 }, { price: 4, qty: 1 }]), 7));\ntest('empty cart', () => assert.strictEqual(total([]), 0));\n",
	'index.html': '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Mini shop</title></head>\n<body>\n\t<h1>Mini shop</h1>\n\t<p id="total">loading...</p>\n\t<script type="module">\n\t\timport { total } from \'./src/cart.js\';\n\t\tdocument.getElementById(\'total\').textContent = \'Total: \' + total([{ price: 2, qty: 3 }]).toFixed(2);\n\t</script>\n</body></html>\n',
	'notes.txt': 'team notes\n',
};

suite('Kodia - LIVE integrated workflow against NVIDIA (acceptance scenario 10)', function () {
	this.timeout(30 * 60_000);

	const env = readDotEnv();
	const apiKey = env.NVIDIA_API_KEY ?? process.env.NVIDIA_API_KEY;
	const modelName = env.NVIDIA_MODEL ?? process.env.NVIDIA_MODEL ?? 'nvidia/nemotron-3.5-super-vl-120b-a12b';

	let store: DisposableStore;
	let repo: string;
	let server: http.Server;
	let browser: IBrowserService;
	let stopBrowser: () => Promise<void>;

	setup(async function () {
		if (!apiKey) { this.skip(); }
		store = new DisposableStore();
		repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-live-integrated-')));
		for (const [rel, content] of Object.entries(PROJECT)) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), content); }
		git(repo, 'init', '-q', '-b', 'main');
		git(repo, '-c', 'user.name=Kodia Test', '-c', 'user.email=kodia@test.local', 'add', '-A');
		git(repo, '-c', 'user.name=Kodia Test', '-c', 'user.email=kodia@test.local', 'commit', '-q', '-m', 'initial');
		git(repo, 'config', 'user.name', 'Kodia Test');
		git(repo, 'config', 'user.email', 'kodia@test.local');
		fs.appendFileSync(path.join(repo, 'notes.txt'), 'user draft: do not commit\n'); // the user's own uncommitted work
		// the app, served from the repository as it is on disk (a reload shows edits)
		server = http.createServer((req, res) => {
			const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
			const file = path.join(repo, rel);
			if (!file.startsWith(repo) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(rel === 'favicon.ico' ? 204 : 404); res.end(); return; }
			const type = { '.html': 'text/html', '.js': 'text/javascript' }[path.extname(file)] ?? 'text/plain';
			res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
			res.end(fs.readFileSync(file));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		({ service: browser, stop: stopBrowser } = await startBrowserServiceProcess());
	});
	teardown(async () => {
		if (!apiKey) { return; }
		await stopBrowser?.();
		await new Promise<void>(resolve => server.close(() => resolve()));
		store.dispose();
		// the repository is kept in the OS temp dir for inspection
	});

	test('a real model branches, fixes a bug found by a failing test, runs the tests, checks the page in a browser, and commits — leaving the user\'s work alone', async () => {
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
		const settingsOfProvider: SettingsOfProvider = { ...defaultSettingsOfProvider, nvidia: { ...defaultSettingsOfProvider.nvidia, apiKey: apiKey!, _didFillInProviderSettings: true } };
		const llm = new LiveLLMService(settingsOfProvider);
		const terminal = new ProcessTerminalToolService(repo, 180_000);

		const gitServer = ProxyChannel.fromService(new KodiaGitMainService(), store);
		const gitChannel = { call: (command: string, arg?: unknown) => gitServer.call(null, command, arg), listen: () => Event.None };
		const instantiation = store.add(new InstantiationService(new ServiceCollection(
			[IKodiaGitMainService, ProxyChannel.toService<IKodiaGitMainService>(gitChannel as any)],
			[IWorkspaceContextService, new TestContextService(testWorkspace(URI.file(repo)))],
		)));
		const gitTools = store.add(instantiation.createInstance(GitToolService));

		const { chat } = createHarness(repo, llm, store, {
			modelSelection: { providerName: 'nvidia', modelName },
			settingsOfProvider,
			terminal,
			git: gitTools,
			mainProcessServices: { 'void-channel-browser': browser },
		});

		const instruction = [
			`You are working in the git repository at ${repo} (a small web shop). Users report that the cart total shown on the web page is wrong.`,
			`1. Create a new git branch named fix/cart-total and switch to it (use the git tools).`,
			`2. Run the tests (\`node --test\` in ${repo}) to see what fails, then find and fix the bug in the source code. Do not change the tests.`,
			`3. Run the tests again until they pass.`,
			`4. The app is already running at ${url} (it serves the files of the repository; reload to see your changes). Check in the browser (launch it headless) that the page shows "Total: 6.00".`,
			`5. Commit your fix on the branch with a short message. notes.txt contains the user's own uncommitted work: do not change, stage or commit it.`,
			`When you are done, reply with a short summary of what you did and verified.`,
		].join('\n');

		const started = Date.now();
		const { messages, streamState } = await runTurn(chat, instruction, 25 * 60_000);
		const elapsedMs = Date.now() - started;

		// ---- independent verification ----
		const branches = git(repo, 'branch', '--format=%(refname:short)').split(/\r?\n/);
		const branchLog = branches.includes('fix/cart-total') ? git(repo, 'log', '--format=%s', 'main..fix/cart-total').split(/\r?\n/).filter(Boolean) : [];
		const changedInBranch = branchLog.length ? git(repo, 'diff', '--name-only', 'main', 'fix/cart-total').split(/\r?\n/).filter(Boolean) : [];
		const status = git(repo, 'status', '--porcelain');
		const notes = fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8');
		const testsUnchanged = fs.readFileSync(path.join(repo, 'test', 'cart.test.js'), 'utf8') === PROJECT['test/cart.test.js'];
		const nodeTest = cp.spawnSync('node', ['--test'], { cwd: repo, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
		const { sessionId } = await browser.launchBrowser({ headless: true });
		const { tabId } = await browser.newTab(sessionId, { url });
		const page = await browser.inspectPage(sessionId, tabId);
		await browser.closeBrowser(sessionId);

		const tools = toolMessages(messages).map((t: any) => ({ name: t.name, type: t.type, error: t.type === 'success' ? undefined : String(t.content).slice(0, 300) }));
		const used = (prefix: string) => tools.some(t => t.type === 'success' && t.name.startsWith(prefix));
		const finalText = String((messages.filter((m: any) => m.role === 'assistant').at(-1) as any)?.displayContent ?? '');
		const evidence = {
			when: new Date().toISOString(), provider: 'nvidia', model: modelName, elapsedMs, repo,
			requests: llm.records, toolCalls: tools, terminalCommands: terminal.commands,
			streamState: { isRunning: streamState?.isRunning ?? null, error: streamState?.error?.message ?? null },
			branches, branchLog, changedInBranch, statusAfter: status, notesKept: notes.includes('user draft: do not commit'), testsUnchanged,
			nodeTest: { exitCode: nodeTest.status, output: `${nodeTest.stdout}\n${nodeTest.stderr}`.slice(-3000) },
			pageText: page.text.slice(0, 300), finalText: finalText.slice(0, 2000),
		};
		fs.writeFileSync(path.join(os.tmpdir(), `kodia-live-integrated-evidence-${modelName.replace(/[^a-z0-9.-]+/gi, '_')}.json`), JSON.stringify(evidence, null, 2));

		assert.ok(!streamState?.error, `agent ended with an error: ${streamState?.error?.message}`);
		assert.ok(used('git_'), 'the model used the git tools');
		assert.ok(tools.some(t => t.type === 'success' && (t.name === 'run_command' || t.name.startsWith('test_'))), 'the model ran the tests');
		assert.ok(used('browser_'), 'the model used the browser');
		assert.ok(branches.includes('fix/cart-total'), `branch fix/cart-total exists: ${branches}`);
		assert.ok(branchLog.length >= 1, 'the fix is committed on the branch');
		assert.deepStrictEqual(changedInBranch, ['src/cart.js'], 'the commit changes only the source file');
		assert.ok(testsUnchanged, 'the tests were not changed');
		assert.strictEqual(nodeTest.status, 0, `the tests pass:\n${evidence.nodeTest.output}`);
		assert.match(page.text, /Total: 6\.00/, 'the page shows the right total');
		// (git() trims its output, so the porcelain line's leading space may be gone)
		assert.ok(evidence.notesKept && /^ ?M notes\.txt$/m.test(status), `the user's uncommitted notes.txt is still there and still uncommitted: ${status}`);
	});
});
