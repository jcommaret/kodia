/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Acceptance scenario 8 (session recovery), roadmap 8. Kodia is killed while the agent is in the middle of a task
 * (a command running, after it already changed files); a new Kodia starts from what the first one left on disk —
 * its storage, as last flushed, and the workspace — and the user says "continue".
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { createHarness, FlushingStorage, ProcessTerminalToolService, runTurn, ScriptedLLMService, ScriptStep, toolMessages } from './agentHarness.js';

suite('Kodia - session recovery after a crash mid-task (roadmap 8, scenario 8)', function () {
	this.timeout(90_000);

	let dir: string;
	const stores: DisposableStore[] = [];
	const p = (rel: string) => path.join(dir, rel);

	setup(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-session-'))); });
	teardown(() => {
		for (const s of stores.splice(0)) { s.dispose(); }
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});

	test('the conversation survives up to the last change, the cut-off command is reported as such, and the agent continues', async () => {
		const model = { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' };

		// ---- process 1: works until it is killed during a long command ----
		const storage1 = new FlushingStorage();
		const store1 = new DisposableStore(); stores.push(store1);
		let commandRequested!: () => void;
		const requested = new Promise<void>(r => { commandRequested = r; });
		const llm1 = new ScriptedLLMService((i): ScriptStep => {
			if (i === 0) { return { text: '', toolCalls: [{ name: 'write_file', params: { uri: p('src/server.js'), new_content: 'require("http").createServer((q, s) => s.end("ok")).listen(0);\n' } }] }; }
			if (i === 1) {
				commandRequested();
				return { text: '', toolCalls: [{ name: 'run_command', params: { command: 'node -e "setTimeout(() => {}, 60000)"' } }] };
			}
			return { text: 'stopped' }; // (never reached in a real crash; keeps a lingering process 1 from starting more work)
		});
		const h1 = createHarness(dir, llm1, store1, { modelSelection: model, storage: storage1, terminal: new ProcessTerminalToolService(dir, 120_000), globalSettings: { verifyBeforeFinishing: false } });
		const threadId = h1.chat.state.currentThreadId;
		void runTurn(h1.chat, 'Create a tiny HTTP server in src/server.js and run the test suite.', 80_000).catch(() => { });
		await requested;
		// wait for the command to actually be running (a fixed 300 ms was too short on a loaded machine)
		for (const until = Date.now() + 10_000; h1.chat.streamState[threadId]?.isRunning !== 'tool' && Date.now() < until;) { await new Promise(r => setTimeout(r, 50)); }
		await new Promise(r => setTimeout(r, 300)); // and let it run a moment
		assert.strictEqual(h1.chat.streamState[threadId]?.isRunning, 'tool', 'process 1 is in the middle of the command');
		const disk = storage1.crash(); // kill: only flushed storage survives
		// a killed process does nothing more: stop process 1's loop and its command (in-process, it would live on)
		await h1.chat.abortRunning(threadId);
		store1.dispose();
		assert.ok(fs.existsSync(p('src/server.js')), 'the file written before the crash is on disk');

		// ---- process 2: starts from what process 1 left ----
		const storage2 = new FlushingStorage(disk);
		const store2 = new DisposableStore(); stores.push(store2);
		const llm2 = new ScriptedLLMService((i, req): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			if (i === 0) {
				assert.match(payload, /write_file/, 'the agent still knows it wrote src/server.js');
				assert.match(payload, /interrupted because Kodia stopped/, 'and that the command was cut off by Kodia stopping, not by the user');
				return { text: '', toolCalls: [{ name: 'read_file', params: { uri: p('src/server.js') } }] };
			}
			return { text: 'server.js is in place; the earlier command was cut off when Kodia stopped, so it needs to be run again.' };
		});
		const h2 = createHarness(dir, llm2, store2, { modelSelection: model, storage: storage2, globalSettings: { verifyBeforeFinishing: false } });
		const restored = h2.chat.state.allThreads[threadId];
		assert.ok(restored, 'the conversation was saved before the crash');
		// saved up to the running command, which the new Kodia marks as cut off at startup (before anyone opens it)
		const tools = toolMessages(restored!.messages);
		assert.deepStrictEqual(tools.map((t: any) => `${t.name}:${t.type}`), ['write_file:success', 'run_command:rejected']);
		assert.match(tools[1].content, /interrupted because Kodia stopped/);
		h2.chat.switchToThread(threadId); // the user opens the conversation
		assert.ok(!h2.chat.streamState[threadId]?.isRunning, 'nothing is shown as running');

		const shapeBefore = h2.chat.state.allThreads[threadId]!.messages.map(m => m.role === 'tool' ? `${m.name}:${m.type}` : m.role).join(' ');
		const checkpointIdx = h2.chat.state.allThreads[threadId]!.state.currCheckpointIdx;
		const { messages } = await runTurn(h2.chat, 'continue', 30_000);
		assert.deepStrictEqual(llm2.scriptErrors, []);
		assert.deepStrictEqual(toolMessages(messages).map((t: any) => `${t.name}:${t.type}`), ['write_file:success', 'run_command:rejected', 'read_file:success'],
			`before "continue" (current checkpoint ${checkpointIdx}): ${shapeBefore}\nafter: ${messages.map((m: any) => m.role === 'tool' ? `${m.name}:${m.type}` : m.role).join(' ')}`);
		assert.ok(storage2.flushes > 0, 'process 2 flushes what it does too');
	});
});
