/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * LIVE acceptance scenario 1 against a real NVIDIA-hosted model.
 *
 * The same real agent stack as agentLoopFilesystem.test.ts (ChatThreadService, ToolsService, EditCodeService,
 * ConvertToLLMMessageService, FileService on disk), but every model request goes through Kodia's real
 * main-process provider code (electron-main sendLLMMessage -> NVIDIA OpenAI-compatible adapter) to
 * integrate.api.nvidia.com. Nothing about the model's behaviour is scripted.
 *
 * Verification is independent of the model's claims: files are read from disk and the generated project's own
 * tests are executed with `node --test`.
 *
 * Needs NVIDIA_API_KEY (and optionally NVIDIA_MODEL) in the git-ignored repo-root .env; skipped otherwise.
 * Evidence (no secrets) is written to <tmp>/kodia-live-nvidia-evidence.json.
 *
 * Run: scripts\test.bat --runGlob vs/workbench/contrib/void/test/electron-browser/agentLoopLive.nvidia.test.js
 */

import assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { defaultSettingsOfProvider, SettingsOfProvider } from '../../common/voidSettingsTypes.js';
import { COMPLETION_CHECK_REQUEST } from '../../common/completionCheck.js';
import { createHarness, ProcessTerminalToolService, runTurn, toolMessages } from './agentHarness.js';
import { LiveLLMService, readDotEnv } from './liveModel.js';

suite('Kodia - LIVE agent loop against NVIDIA (acceptance scenario 1)', function () {
	this.timeout(20 * 60_000);

	const env = readDotEnv();
	const apiKey = env.NVIDIA_API_KEY ?? process.env.NVIDIA_API_KEY;
	const modelName = env.NVIDIA_MODEL ?? process.env.NVIDIA_MODEL ?? 'nvidia/nemotron-3.5-super-vl-120b-a12b';
	// KODIA_VERIFY=0 turns the completion check off (A/B measurements); default is Kodia's default (on)
	const verifyBeforeFinishing = (env.KODIA_VERIFY ?? process.env.KODIA_VERIFY) !== '0';

	let store: DisposableStore;
	let tmpDir: string;
	setup(function () {
		if (!apiKey) { this.skip(); }
		store = new DisposableStore();
		tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-live-nvidia-')));
	});
	teardown(() => {
		store?.dispose();
		// keep the generated project for inspection; it lives in the OS temp dir
	});

	test('a real model builds a small Node project through the agent loop; its own tests pass on disk', async () => {
		const settingsOfProvider: SettingsOfProvider = {
			...defaultSettingsOfProvider,
			nvidia: { ...defaultSettingsOfProvider.nvidia, apiKey: apiKey!, _didFillInProviderSettings: true },
		};
		const llm = new LiveLLMService(settingsOfProvider);
		const terminal = new ProcessTerminalToolService(tmpDir);
		const { chat } = createHarness(tmpDir, llm, store, {
			modelSelection: { providerName: 'nvidia', modelName },
			settingsOfProvider,
			terminal, // a real terminal, as in Kodia: the model can run its tests
			globalSettings: { verifyBeforeFinishing },
		});

		const projectDir = path.join(tmpDir, 'live-shop');
		const instruction = [
			`Create a small Node.js project in the folder ${projectDir} (it does not exist yet).`,
			`1. ${path.join(projectDir, 'package.json')}: name "live-shop", "type": "module", and a "test" script "node --test".`,
			`2. ${path.join(projectDir, 'src', 'cart.js')}: export a function total(items) where items is an array of { price, qty }; return the sum of price*qty rounded to 2 decimals. Throw a TypeError if items is not an array.`,
			`3. ${path.join(projectDir, 'test', 'cart.test.js')}: tests using node:test and node:assert that cover a normal cart, an empty cart (0) and the TypeError.`,
			`Do not install any packages (none are needed). When you are done, reply with a short summary.`,
		].join('\n');

		const started = Date.now();
		const { messages, streamState } = await runTurn(chat, instruction, 15 * 60_000);
		const elapsedMs = Date.now() - started;

		// ---- independent verification ----
		const exists = (...s: string[]) => fs.existsSync(path.join(projectDir, ...s));
		const files = { packageJson: exists('package.json'), cart: exists('src', 'cart.js'), cartTest: exists('test', 'cart.test.js') };
		let pkgName: string | undefined;
		try { pkgName = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')).name; } catch { }
		let nodeTest: { exitCode: number | null; output: string; testCount: number | null } = { exitCode: null, output: '', testCount: null };
		let behaviour: { exitCode: number | null; output: string } = { exitCode: null, output: '' };
		let testFileUsesNodeTest = false;
		if (files.packageJson && files.cart && files.cartTest) {
			const nodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
			const r = cp.spawnSync('node', ['--test'], { cwd: projectDir, encoding: 'utf8', timeout: 120_000, env: nodeEnv });
			const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
			nodeTest = { exitCode: r.status, output: out.slice(-4000), testCount: Number(/(?:^|\n)\D{0,4}tests (\d+)/.exec(out)?.[1] ?? NaN) || null };
			testFileUsesNodeTest = /from\s+['"]node:test['"]|require\(\s*['"]node:test['"]\s*\)/.test(fs.readFileSync(path.join(projectDir, 'test', 'cart.test.js'), 'utf8'));
			// The model's own tests prove little (they may assert nothing): check the required behaviour ourselves.
			const cartUrl = new URL(`file:///${path.join(projectDir, 'src', 'cart.js').replace(/\\/g, '/')}`).href;
			const check = [
				`const { total } = await import(${JSON.stringify(cartUrl)});`,
				`const assert = (await import('node:assert')).default;`,
				`assert.strictEqual(total([{ price: 10.99, qty: 2 }, { price: 5.5, qty: 3 }]), 38.48, 'normal cart');`,
				`assert.strictEqual(total([{ price: 0.1, qty: 3 }]), 0.3, 'rounded to 2 decimals');`,
				`assert.strictEqual(total([]), 0, 'empty cart');`,
				`assert.throws(() => total('nope'), TypeError, 'non-array input');`,
				`console.log('behaviour ok');`,
			].join('\n');
			const b = cp.spawnSync('node', ['--input-type=module', '-e', check], { cwd: projectDir, encoding: 'utf8', timeout: 60_000, env: nodeEnv });
			behaviour = { exitCode: b.status, output: `${b.stdout ?? ''}\n${b.stderr ?? ''}`.slice(-2000) };
		}

		const tools = toolMessages(messages).map((t: any) => ({ name: t.name, type: t.type, uri: t.params?.uri?.fsPath ?? undefined, error: t.type === 'success' ? undefined : String(t.content).slice(0, 300) }));
		const finalText = String((messages.filter((m: any) => m.role === 'assistant').at(-1) as any)?.displayContent ?? '');
		const nudges = messages.filter((m: any) => m.role === 'user' && /did not call any tool/.test(m.displayContent)).length;
		const completionChecks = messages.filter((m: any) => m.role === 'user' && m.displayContent === COMPLETION_CHECK_REQUEST).length;
		const testWeakeningWarnings = toolMessages(messages).filter((t: any) => /WEAKENS the test file/.test(String(t.content))).length;
		const noTestCaseWarnings = toolMessages(messages).filter((t: any) => /defines no test case a test runner can see/.test(String(t.content))).length;
		const evidence = {
			when: new Date().toISOString(), provider: 'nvidia', model: modelName, verifyBeforeFinishing, elapsedMs, projectDir,
			requests: llm.records, toolCalls: tools, narrationNudges: nudges, completionChecks, testWeakeningWarnings, noTestCaseWarnings,
			terminalCommands: terminal.commands,
			streamState: { isRunning: streamState?.isRunning ?? null, error: streamState?.error?.message ?? null },
			files, pkgName, nodeTest, testFileUsesNodeTest, behaviour, finalText: finalText.slice(0, 2000),
		};
		const evidenceName = `kodia-live-nvidia-evidence-${modelName.replace(/[^a-z0-9.-]+/gi, '_')}${verifyBeforeFinishing ? '' : '-noverify'}.json`;
		fs.writeFileSync(path.join(os.tmpdir(), evidenceName), JSON.stringify(evidence, null, 2));

		assert.ok(!streamState?.error, `agent ended with an error: ${streamState?.error?.message}`);
		assert.ok(tools.some(t => t.type === 'success' && (t.name === 'write_file' || t.name === 'rewrite_file' || t.name === 'create_file_or_folder')), 'the model must actually call file tools');
		assert.deepStrictEqual(files, { packageJson: true, cart: true, cartTest: true }, 'all requested files exist on disk');
		assert.strictEqual(pkgName, 'live-shop');
		assert.strictEqual(behaviour.exitCode, 0, `src/cart.js must behave as specified (checked independently):\n${behaviour.output}`);
		assert.ok(testFileUsesNodeTest, 'the test file must use node:test as instructed');
		assert.strictEqual(nodeTest.exitCode, 0, `the generated project's own tests must pass:\n${nodeTest.output}`);
		assert.ok((nodeTest.testCount ?? 0) >= 3, `node --test must run the 3 requested cases, ran ${nodeTest.testCount}`);
	});
});
