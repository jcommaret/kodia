/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * LIVE acceptance scenario 8 (session recovery) against a real NVIDIA-hosted model. Kodia is "killed" while the real
 * model is in the middle of a multi-file task (only what was flushed to storage survives, as after a crash); a new
 * Kodia starts from that storage and the same workspace, and the user says "continue". Verified independently: the
 * conversation spans both processes, and the finished project works.
 *
 * Needs NVIDIA_API_KEY (optionally NVIDIA_MODEL) in the git-ignored repo-root .env; skipped otherwise.
 * Evidence (no secrets): %TEMP%/kodia-live-recovery-evidence-<model>.json
 */

import assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { defaultSettingsOfProvider, SettingsOfProvider } from '../../common/voidSettingsTypes.js';
import { createHarness, FlushingStorage, ProcessTerminalToolService, runTurn, toolMessages } from './agentHarness.js';
import { LiveLLMService, readDotEnv } from './liveModel.js';

suite('Kodia - LIVE session recovery against NVIDIA (acceptance scenario 8)', function () {
	this.timeout(40 * 60_000);

	const env = readDotEnv();
	const apiKey = env.NVIDIA_API_KEY ?? process.env.NVIDIA_API_KEY;
	const modelName = env.NVIDIA_MODEL ?? process.env.NVIDIA_MODEL ?? 'nvidia/nemotron-3.5-super-vl-120b-a12b';
	const stores: DisposableStore[] = [];
	let dir: string;
	setup(function () { if (!apiKey) { this.skip(); } dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-live-recovery-'))); });
	teardown(() => { for (const s of stores.splice(0)) { s.dispose(); } });

	test('a real model is interrupted mid-task by a crash; a new Kodia continues the same conversation and finishes the work', async () => {
		const settingsOfProvider: SettingsOfProvider = { ...defaultSettingsOfProvider, nvidia: { ...defaultSettingsOfProvider.nvidia, apiKey: apiKey!, _didFillInProviderSettings: true } };
		const model = { providerName: 'nvidia' as const, modelName };
		const projectDir = path.join(dir, 'units');
		const instruction = [
			`Create a small Node.js ES-module project in ${projectDir} (it does not exist yet), one file at a time:`,
			`1. ${path.join(projectDir, 'package.json')} with "type": "module" and a "test" script "node --test".`,
			`2. ${path.join(projectDir, 'src', 'length.js')}: export function convert(value, from, to) converting between "mm", "cm", "m" and "km"; throw a RangeError for an unknown unit.`,
			`3. ${path.join(projectDir, 'src', 'temperature.js')}: export function toFahrenheit(c) and toCelsius(f).`,
			`4. ${path.join(projectDir, 'test', 'length.test.js')} and ${path.join(projectDir, 'test', 'temperature.test.js')} using node:test.`,
			`5. Run the tests and fix anything that fails. Then reply with a short summary.`,
		].join('\n');

		// ---- process 1: killed once the model has written two files ----
		const storage1 = new FlushingStorage();
		const store1 = new DisposableStore(); stores.push(store1);
		const llm1 = new LiveLLMService(settingsOfProvider);
		const h1 = createHarness(dir, llm1, store1, { modelSelection: model, settingsOfProvider, storage: storage1, terminal: new ProcessTerminalToolService(dir, 180_000) });
		const threadId = h1.chat.state.currentThreadId;
		const turn1 = runTurn(h1.chat, instruction, 30 * 60_000).catch(() => undefined);
		// any successful file change counts (models create files with write_file, or create_file_or_folder + edit_file)
		const fileTools = new Set(['write_file', 'rewrite_file', 'edit_file', 'create_file_or_folder']);
		// the crash trigger counts content writes only: creating folders (or empty files) is not yet "mid-task"
		const contentTools = new Set(['write_file', 'rewrite_file', 'edit_file']);
		const writtenFiles = () => toolMessages(h1.chat.state.allThreads[threadId]?.messages ?? []).filter((t: any) => t.type === 'success' && contentTools.has(t.name)).length;
		const failedFileTools = () => toolMessages(h1.chat.state.allThreads[threadId]?.messages ?? []).filter((t: any) => t.type !== 'success' && fileTools.has(t.name));
		const until = Date.now() + 20 * 60_000;
		// isRunning is undefined until the turn starts streaming: wait for the start first, or the "crash" fires at t=0
		let started = false;
		while (writtenFiles() < 2 && failedFileTools().length < 4 && Date.now() < until) {
			const running = !!h1.chat.streamState[threadId]?.isRunning;
			if (running) { started = true; } else if (started) { break; } // the turn ended on its own
			await new Promise(r => setTimeout(r, 300));
		}
		const fileToolErrors = failedFileTools().map((t: any) => `${t.name} ${JSON.stringify(t.rawParams ?? {}).slice(0, 300)} → ${String(t.content).slice(0, 400)}`);
		fs.writeFileSync(path.join(os.tmpdir(), 'kodia-live-recovery-file-tool-errors.txt'), fileToolErrors.join('\n\n'));
		const writtenBeforeCrash = writtenFiles();
		const disk = storage1.crash(); // the kill: only flushed storage survives
		await h1.chat.abortRunning(threadId); // a killed process does nothing more
		store1.dispose();
		await Promise.race([turn1, new Promise(r => setTimeout(r, 10_000))]); // a killed process's turn need not settle
		assert.ok(writtenBeforeCrash >= 2, `process 1 was interrupted mid-task (after ${writtenBeforeCrash} file changes); failed file tools:\n${fileToolErrors.join('\n')}`);

		// ---- process 2: starts from what process 1 left ----
		const storage2 = new FlushingStorage(disk);
		const store2 = new DisposableStore(); stores.push(store2);
		const llm2 = new LiveLLMService(settingsOfProvider);
		const h2 = createHarness(dir, llm2, store2, { modelSelection: model, settingsOfProvider, storage: storage2, terminal: new ProcessTerminalToolService(dir, 180_000) });
		const restored = h2.chat.state.allThreads[threadId];
		assert.ok(restored, 'the conversation survived the crash');
		const restoredToolCount = toolMessages(restored!.messages).length;
		h2.chat.switchToThread(threadId);
		const { messages, streamState } = await runTurn(h2.chat, 'continue', 30 * 60_000);

		// ---- independent verification ----
		const nodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
		const tests = cp.spawnSync('node', ['--test'], { cwd: projectDir, encoding: 'utf8', timeout: 120_000, env: nodeEnv });
		const url = (rel: string) => new URL(`file:///${path.join(projectDir, rel).replace(/\\/g, '/')}`).href;
		const behaviour = cp.spawnSync('node', ['--input-type=module', '-e', [
			`const { convert } = await import(${JSON.stringify(url('src/length.js'))});`,
			`const { toFahrenheit, toCelsius } = await import(${JSON.stringify(url('src/temperature.js'))});`,
			`const assert = (await import('node:assert')).default;`,
			`assert.strictEqual(convert(1, 'km', 'm'), 1000); assert.strictEqual(convert(250, 'cm', 'm'), 2.5);`,
			`assert.throws(() => convert(1, 'mile', 'm'), RangeError);`,
			`assert.strictEqual(toFahrenheit(100), 212); assert.strictEqual(toCelsius(32), 0);`,
			`console.log('behaviour ok');`,
		].join('\n')], { cwd: projectDir, encoding: 'utf8', timeout: 60_000, env: nodeEnv });
		const evidence = {
			when: new Date().toISOString(), model: modelName, writtenBeforeCrash, restoredToolCount,
			process1Requests: llm1.records.length, process2Requests: llm2.records.length,
			toolsAfter: toolMessages(messages).map((t: any) => `${t.name}:${t.type}`), streamState: { error: streamState?.error?.message ?? null },
			tests: { exitCode: tests.status, output: `${tests.stdout}\n${tests.stderr}`.slice(-2000) }, behaviour: { exitCode: behaviour.status, output: `${behaviour.stdout}\n${behaviour.stderr}`.slice(-1000) },
		};
		fs.writeFileSync(path.join(os.tmpdir(), `kodia-live-recovery-evidence-${modelName.replace(/[^a-z0-9.-]+/gi, '_')}.json`), JSON.stringify(evidence, null, 2));

		assert.ok(!streamState?.error, `agent ended with an error: ${streamState?.error?.message}`);
		assert.ok(restoredToolCount >= 2, `the restored conversation holds process 1's work: ${restoredToolCount} tool calls`);
		assert.ok(toolMessages(messages).length > restoredToolCount, 'process 2 continued with more tool calls in the same conversation');
		assert.strictEqual(behaviour.status, 0, `the finished project behaves as specified:\n${evidence.behaviour.output}`);
		assert.strictEqual(tests.status, 0, `its tests pass:\n${evidence.tests.output}`);
	});
});
