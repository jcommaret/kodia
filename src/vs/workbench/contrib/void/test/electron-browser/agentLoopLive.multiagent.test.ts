/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * LIVE acceptance scenario 7 (multi-agent) against a real NVIDIA-hosted model. Nothing about the model's behaviour is
 * scripted. The model is asked to delegate two independent modules to subagents in parallel, then check and
 * consolidate. Verified independently: subagents really ran (child threads with their own tool calls), each module
 * behaves as specified, and the combined test suite passes.
 *
 * Needs NVIDIA_API_KEY (optionally NVIDIA_MODEL) in the git-ignored repo-root .env; skipped otherwise.
 * Evidence (no secrets): %TEMP%/kodia-live-multiagent-evidence-<model>.json
 * Run: scripts\test.bat --runGlob vs/workbench/contrib/void/test/electron-browser/agentLoopLive.multiagent.test.js
 */

import assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { defaultSettingsOfProvider, SettingsOfProvider } from '../../common/voidSettingsTypes.js';
import { createHarness, ProcessTerminalToolService, runTurn, toolMessages } from './agentHarness.js';
import { LiveLLMService, readDotEnv } from './liveModel.js';

suite('Kodia - LIVE multi-agent work against NVIDIA (acceptance scenario 7)', function () {
	this.timeout(40 * 60_000);

	const env = readDotEnv();
	const apiKey = env.NVIDIA_API_KEY ?? process.env.NVIDIA_API_KEY;
	const modelName = env.NVIDIA_MODEL ?? process.env.NVIDIA_MODEL ?? 'nvidia/nemotron-3.5-super-vl-120b-a12b';

	let store: DisposableStore;
	let dir: string;
	setup(function () {
		if (!apiKey) { this.skip(); }
		store = new DisposableStore();
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-live-multiagent-')));
		fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'text-utils', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
	});
	teardown(() => { store?.dispose(); });

	test('a real model delegates two independent modules to parallel subagents, then verifies and consolidates', async () => {
		const settingsOfProvider: SettingsOfProvider = { ...defaultSettingsOfProvider, nvidia: { ...defaultSettingsOfProvider.nvidia, apiKey: apiKey!, _didFillInProviderSettings: true } };
		const llm = new LiveLLMService(settingsOfProvider);
		const terminal = new ProcessTerminalToolService(dir, 180_000);
		const { chat } = createHarness(dir, llm, store, { modelSelection: { providerName: 'nvidia', modelName }, settingsOfProvider, terminal });
		const parentId = chat.state.currentThreadId;

		const instruction = [
			`The project at ${dir} is an empty Node.js ES-module package. Two independent modules are needed. Delegate them to two subagents of type "general" IN PARALLEL (both subagent calls in the same reply), each with a complete prompt:`,
			`A) ${path.join(dir, 'src', 'slug.js')}: export function slugify(text) — lowercase, trim, replace every run of characters that are not a-z or 0-9 with a single "-", and remove leading/trailing "-". With tests in ${path.join(dir, 'test', 'slug.test.js')} using node:test.`,
			`B) ${path.join(dir, 'src', 'wordcount.js')}: export function wordCount(text) — the number of words, where words are separated by any whitespace; an empty or whitespace-only string has 0 words. With tests in ${path.join(dir, 'test', 'wordcount.test.js')} using node:test.`,
			`After both subagents report, check their work yourself (read the files, run \`node --test\` in ${dir}), fix anything that is wrong, and reply with a short consolidated summary.`,
		].join('\n');

		const started = Date.now();
		const { messages, streamState } = await runTurn(chat, instruction, 35 * 60_000);
		const elapsedMs = Date.now() - started;

		// ---- independent verification ----
		const parentTools = toolMessages(messages).map((t: any) => ({ name: t.name, type: t.type, error: t.type === 'success' ? undefined : String(t.content).slice(0, 300) }));
		const subagentCalls = toolMessages(messages).filter((t: any) => t.name === 'subagent');
		const children = Object.values(chat.state.allThreads).filter(t => t?.subagentOf?.parentThreadId === parentId).map(t => ({
			agent: t!.subagentOf!.agent, description: t!.subagentOf!.description,
			tools: toolMessages(t!.messages).map((m: any) => `${m.name}:${m.type}`),
		}));
		// were the two first subagent calls made in the same reply (one assistant message, run as a parallel batch)?
		const firstSubagentIdx = messages.findIndex((m: any) => m.role === 'tool' && m.name === 'subagent');
		const sameReply = firstSubagentIdx >= 0 && messages[firstSubagentIdx + 1]?.role === 'tool' && (messages[firstSubagentIdx + 1] as any).name === 'subagent';

		const nodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
		const suite = cp.spawnSync('node', ['--test'], { cwd: dir, encoding: 'utf8', timeout: 120_000, env: nodeEnv });
		const url = (rel: string) => new URL(`file:///${path.join(dir, rel).replace(/\\/g, '/')}`).href;
		const behaviour = cp.spawnSync('node', ['--input-type=module', '-e', [
			`const { slugify } = await import(${JSON.stringify(url('src/slug.js'))});`,
			`const { wordCount } = await import(${JSON.stringify(url('src/wordcount.js'))});`,
			`const assert = (await import('node:assert')).default;`,
			`assert.strictEqual(slugify('  Hello, World!  '), 'hello-world');`,
			`assert.strictEqual(slugify('Déjà vu -- 2024'), 'd-j-vu-2024');`,
			`assert.strictEqual(wordCount('one  two\\tthree\\nfour'), 4);`,
			`assert.strictEqual(wordCount('   '), 0);`,
			`assert.strictEqual(wordCount(''), 0);`,
			`console.log('behaviour ok');`,
		].join('\n')], { cwd: dir, encoding: 'utf8', timeout: 60_000, env: nodeEnv });

		const evidence = {
			when: new Date().toISOString(), provider: 'nvidia', model: modelName, elapsedMs, dir,
			requests: llm.records, parentTools, subagentReports: subagentCalls.map((t: any) => String(t.content).slice(0, 800)), sameReply, children,
			streamState: { isRunning: streamState?.isRunning ?? null, error: streamState?.error?.message ?? null },
			suite: { exitCode: suite.status, output: `${suite.stdout}\n${suite.stderr}`.slice(-3000) },
			behaviour: { exitCode: behaviour.status, output: `${behaviour.stdout}\n${behaviour.stderr}`.slice(-1500) },
			finalText: String((messages.filter((m: any) => m.role === 'assistant').at(-1) as any)?.displayContent ?? '').slice(0, 2000),
		};
		fs.writeFileSync(path.join(os.tmpdir(), `kodia-live-multiagent-evidence-${modelName.replace(/[^a-z0-9.-]+/gi, '_')}.json`), JSON.stringify(evidence, null, 2));

		assert.ok(!streamState?.error, `agent ended with an error: ${streamState?.error?.message}`);
		assert.ok(subagentCalls.filter((t: any) => t.type === 'success').length >= 2, `at least two subagents ran: ${parentTools.map(t => `${t.name}:${t.type}`).join(', ')}`);
		assert.ok(children.length >= 2 && children.every(c => c.tools.some(x => x.endsWith(':success'))), `the subagents did real work in their own threads: ${JSON.stringify(children)}`);
		assert.strictEqual(behaviour.status, 0, `both modules behave as specified (checked independently):\n${evidence.behaviour.output}`);
		assert.strictEqual(suite.status, 0, `the combined test suite passes:\n${evidence.suite.output}`);
	});
});
