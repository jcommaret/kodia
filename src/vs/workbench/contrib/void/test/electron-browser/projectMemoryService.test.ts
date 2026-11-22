/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 9: project memory (.kodia/memory.md) with the real ProjectMemoryService on the real disk — concurrent
 * writers, edits made in the file meanwhile, and what one session leaves for the next.
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { createHarness, ProcessTerminalToolService, RecordedRequest, runTurn, ScriptedLLMService, ScriptStep, toolMessages } from './agentHarness.js';

suite('Kodia - project memory across writers and sessions (roadmap 9)', function () {
	this.timeout(90_000);

	let dir: string;
	const stores: DisposableStore[] = [];
	const memoryFile = () => path.join(dir, '.kodia', 'memory.md');
	const model = { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' };
	const newStore = () => { const s = new DisposableStore(); stores.push(s); return s; };

	setup(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-memory-')));
		fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'shop', scripts: { test: 'node -e "process.exit(1)"', 'check:unit': 'node -e "console.log(\'unit ok\')"' } }));
	});
	teardown(() => {
		for (const s of stores.splice(0)) { s.dispose(); }
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});

	test('concurrent writers (e.g. parallel subagents) all keep their sections (was: lost updates)', async () => {
		const memory = createHarness(dir, new ScriptedLLMService(() => ({ text: '' })), newStore(), { modelSelection: model, realProjectMemory: true }).projectMemory!;
		await Promise.all(Array.from({ length: 8 }, (_, i) => memory.writeSection(`Area ${i}`, `note ${i}`)));
		const titles = (fs.readFileSync(memoryFile(), 'utf8').match(/^## .+$/gm) ?? []).sort();
		assert.deepStrictEqual(titles, Array.from({ length: 8 }, (_, i) => `## Area ${i}`));
	});

	test('a write keeps what was written into the file meanwhile, even before the file watcher reports it (was: overwritten)', async () => {
		const memory = createHarness(dir, new ScriptedLLMService(() => ({ text: '' })), newStore(), { modelSelection: model, realProjectMemory: true }).projectMemory!;
		await memory.writeSection('Commands', 'npm run check:unit');
		fs.appendFileSync(memoryFile(), '\n## Team notes\nAsk Sam before changing the schema.\n'); // a teammate's edit (pulled from git, or typed)
		await memory.writeSection('Pitfalls', 'npm test exits 1 on purpose');
		const text = fs.readFileSync(memoryFile(), 'utf8');
		assert.match(text, /## Team notes\nAsk Sam before changing the schema\./);
		assert.match(text, /## Commands\nnpm run check:unit/);
		assert.match(text, /## Pitfalls\nnpm test exits 1 on purpose/);
	});

	test('what the agent learns in one session is in the next session\'s prompt, and the agent uses it', async () => {
		const last = (req: RecordedRequest) => JSON.stringify(req.messages[req.messages.length - 1]);

		// session 1: the agent finds out how this project's tests are really run, and saves it
		const llm1 = new ScriptedLLMService((i, req): ScriptStep => {
			if (i === 0) { return { text: '', toolCalls: [{ name: 'run_command', params: { command: 'npm test' } }] }; }
			if (i === 1) {
				assert.match(last(req), /exit code 1|exited with code 1|Exit code: 1/i, 'npm test really fails');
				return { text: '', toolCalls: [{ name: 'write_project_memory', params: { section: 'Commands', content: 'Run the unit tests with `npm run check:unit`. `npm test` always exits 1 on purpose.' } }] };
			}
			return { text: 'Use npm run check:unit; noted in the project memory.' };
		});
		const s1 = createHarness(dir, llm1, newStore(), { modelSelection: model, realProjectMemory: true, terminal: new ProcessTerminalToolService(dir, 60_000), globalSettings: { verifyBeforeFinishing: false } });
		const r1 = await runTurn(s1.chat, 'How do I run the tests here?', 60_000);
		assert.deepStrictEqual(llm1.scriptErrors, []);
		assert.deepStrictEqual(toolMessages(r1.messages).map((t: any) => `${t.name}:${t.type}`), ['run_command:success', 'write_project_memory:success']);

		// session 2: a new Kodia (new services) on the same project, a new conversation
		const llm2 = new ScriptedLLMService((i, req): ScriptStep => {
			if (i === 0) {
				const system = req.separateSystemMessage ?? JSON.stringify(req.messages[0]);
				assert.match(system, /PROJECT MEMORY[\s\S]*npm run check:unit/, 'the memory is in the system prompt of a new session');
				return { text: '', toolCalls: [{ name: 'run_command', params: { command: 'npm run check:unit' } }] };
			}
			assert.match(last(req), /unit ok/);
			return { text: 'The unit tests pass.' };
		});
		const s2 = createHarness(dir, llm2, newStore(), { modelSelection: model, realProjectMemory: true, terminal: new ProcessTerminalToolService(dir, 60_000), globalSettings: { verifyBeforeFinishing: false } });
		await s2.projectMemory!.whenReady;
		const r2 = await runTurn(s2.chat, 'Run the tests.', 60_000);
		assert.deepStrictEqual(llm2.scriptErrors, []);
		assert.deepStrictEqual(toolMessages(r2.messages).map((t: any) => `${t.name}:${t.type}`), ['run_command:success']);
	});

	test('a large memory gets a share of a small model\'s context window; the rest is named, not silently cut', async () => {
		// ~20k tokens: more than the 15% share of a 64k window (Kodia's tool definitions alone take much of a 16k one)
		const big = ['## Commands\nnpm run check:unit', ...Array.from({ length: 30 }, (_, i) => `## Module ${i}\n${`Details about module ${i}. `.repeat(120)}`)].join('\n\n');
		fs.mkdirSync(path.dirname(memoryFile()), { recursive: true });
		fs.writeFileSync(memoryFile(), big);
		let system = '';
		const llm = new ScriptedLLMService((_i, req): ScriptStep => { system = req.separateSystemMessage ?? JSON.stringify(req.messages[0]); return { text: 'ok' }; });
		const h = createHarness(dir, llm, newStore(), {
			modelSelection: model, realProjectMemory: true, globalSettings: { verifyBeforeFinishing: false },
			overridesOfModel: { openAICompatible: { 'kodia-scripted-model': { contextWindow: 64_000 } } },
		});
		await h.projectMemory!.whenReady;
		await runTurn(h.chat, 'hi', 30_000);
		const at = system.indexOf('PROJECT MEMORY (');
		assert.match(system, /## Commands(\s|\\n)+npm run check:unit/, `the first sections are there: ${at === -1 ? '(no PROJECT MEMORY section)' : system.slice(at, at + 400)}`);
		assert.match(system, /more sections not shown here, to fit this model's context window: .*\\?"Module 29\\?"/, system.slice(system.indexOf('more section'), system.indexOf('more section') + 200));
		assert.doesNotMatch(system, /Details about module 29/);
	});
});
