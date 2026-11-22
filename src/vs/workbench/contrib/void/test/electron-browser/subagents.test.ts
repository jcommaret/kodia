/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 6 / acceptance scenario 7 (multi-agent) through the real agent loop: one parent agent delegates to three
 * subagents in parallel (two that change files, one read-only), each a real ChatThreadService agent loop in its own
 * thread with the real ToolsService on the real disk; then continues one of them and verifies with a real test run.
 *
 * The model is scripted per thread (requests carry their thread id). Each step asserts what it received.
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { DIVIDER, FINAL, ORIGINAL } from '../../common/prompt/prompts.js';
import { createHarness, ProcessTerminalToolService, RecordedRequest, runTurn, ScriptedLLMService, ScriptStep, toolMessages } from './agentHarness.js';

const FILES: Record<string, string> = {
	'package.json': '{ "name": "calc", "version": "1.0.0" }\n',
	'src/math.js': 'exports.add = (a, b) => a - b;\n',
	'src/strings.js': 'exports.shout = (s) => s.toLowerCase() + \'!\';\n',
	'test/math.test.js': 'const test = require(\'node:test\');\nconst assert = require(\'node:assert\');\nconst { add } = require(\'../src/math.js\');\ntest(\'add\', () => assert.strictEqual(add(2, 3), 5));\n',
	'test/strings.test.js': 'const test = require(\'node:test\');\nconst assert = require(\'node:assert\');\nconst { shout } = require(\'../src/strings.js\');\ntest(\'shout\', () => assert.strictEqual(shout(\'hi\'), \'HI!\'));\n',
};

const sr = (orig: string, final: string) => `${ORIGINAL}\n${orig}\n${DIVIDER}\n${final}\n${FINAL}`;

suite('Kodia - subagents through the agent loop (roadmap 6, scenario 7)', function () {
	this.timeout(120_000);

	let store: DisposableStore;
	let dir: string;
	const p = (rel: string) => path.join(dir, rel);

	setup(() => {
		store = new DisposableStore();
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-subagents-')));
		for (const [rel, content] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(p(rel)), { recursive: true }); fs.writeFileSync(p(rel), content); }
	});
	teardown(() => {
		store.dispose();
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});

	test('parallel subagents fix separate modules, a read-only explorer stays read-only, one is continued, and the parent verifies', async () => {
		const last = (req: RecordedRequest) => JSON.stringify(req.messages[req.messages.length - 1]);
		const roleOf = new Map<string, string>(); // thread id → which agent (by its task marker)
		const stepOf = new Map<string, number>();
		const requestOrder: string[] = []; // agent of each request, in the order requests were made
		let parentId = '';

		const llm = new ScriptedLLMService((_i, req): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			const tid = req.threadId!;
			if (!roleOf.has(tid)) { roleOf.set(tid, tid === parentId ? 'P' : /TASK-(A|B|E)\b/.exec(payload)![1]); }
			const role = roleOf.get(tid)!;
			const step = stepOf.get(tid) ?? 0;
			stepOf.set(tid, step + 1);
			requestOrder.push(role);

			if (role === 'P') {
				switch (step) {
					case 0: return {
						text: '', toolCalls: [
							{ name: 'subagent', params: { agent: 'general', description: 'fix math', prompt: 'TASK-A: add() in src/math.js subtracts. Fix it.' } },
							{ name: 'subagent', params: { agent: 'build', description: 'fix strings', prompt: 'TASK-B: shout() in src/strings.js lowercases. Fix it.' } },
							{ name: 'subagent', params: { agent: 'explore', description: 'find tests', prompt: 'TASK-E: where are the tests and how are they run?' } },
							{ name: 'subagent', params: { agent: 'wizard', description: 'bad type', prompt: 'never runs' } },
							{ name: 'subagent', params: { agent: 'general', description: 'bad model', prompt: 'never runs', model: 'nowhere/none' } },
						],
					};
					case 1: {
						const reports = payload;
						assert.match(reports, /Subagent \\"fix math\\" \(general, session [\w-]+\) finished/);
						assert.match(reports, /Tool calls: 4 \(2 failed\)[^"]*\\nFiles changed: src[\\/]+math\.js\\n/, 'A: facts from its thread — one edit landed, the refused ones are counted');
						assert.match(reports, /is being changed by another subagent running in parallel \(\\"fix strings\\"/, 'A was refused the file B was changing');
						assert.match(reports, /A subagent cannot start subagents/);
						assert.match(reports, /Subagent \\"fix strings\\" \(general, session [\w-]+\) finished[^"]*Files changed: src[\\/]+strings\.js/, '"build" is the general type');
						assert.match(reports, /Subagent \\"find tests\\" \(explore[^"]*Files changed: none[^"]*A \\"explore\\" subagent cannot use edit_file/);
						assert.match(reports, /The subagent's own report \(not verified by Kodia\):\\nTests are in test\//);
						assert.match(reports, /Unknown subagent type \\"wizard\\"/);
						assert.match(reports, /Model \\"nowhere\/none\\" is not one of the models set up in Kodia: openAICompatible\/kodia-scripted-model/);
						const sessionA = /Subagent \\"fix math\\" \(general, session ([\w-]+)\)/.exec(reports)![1];
						return { text: '', toolCalls: [{ name: 'subagent', params: { agent: 'general', description: 'document add', prompt: 'TASK-A2: add a one-line comment above add().', session_i_d: sessionA } }] };
					}
					case 2:
						assert.match(last(req), /Subagent \\"document add\\" \(general, session [\w-]+\) finished[^"]*Files changed: src[\\/]+math\.js/, 'the follow-up ran in the same subagent');
						return { text: '', toolCalls: [{ name: 'run_command', params: { command: 'node --test --test-reporter=tap' } }] };
					case 3:
						assert.match(last(req), /# pass 2/, 'the parent checked the subagents\' work with a real test run');
						assert.match(last(req), /# fail 0/);
						return { text: 'Both bugs are fixed and the tests pass.' };
				}
			}
			if (role === 'A') {
				switch (step) {
					case 0:
						assert.ok(req.tools?.includes('edit_file') && req.tools.includes('run_command') && !req.tools.includes('subagent'), `a general subagent gets the change tools but not subagent: ${req.tools}`);
						assert.match(req.separateSystemMessage ?? payload, /YOU ARE A SUBAGENT \(\\?"fix math\\?", type general/);
						assert.doesNotMatch(payload, /TASK-B|TASK-E/, 'a subagent does not see the parent\'s conversation');
						return { text: '', toolCalls: [{ name: 'read_file', params: { uri: p('src/math.js') } }] };
					case 1:
						assert.match(last(req), /a - b/);
						return { text: '', toolCalls: [{ name: 'edit_file', params: { uri: p('src/math.js'), search_replace_blocks: sr('exports.add = (a, b) => a - b;', 'exports.add = (a, b) => a + b;') } }] };
					case 2: return { text: '', delayMs: 50, toolCalls: [{ name: 'edit_file', params: { uri: p('src/strings.js'), search_replace_blocks: sr('+ \'!\'', '+ \'!!\'') } }] };
					case 3:
						assert.match(last(req), /is being changed by another subagent/);
						return { text: '', toolCalls: [{ name: 'subagent', params: { agent: 'general', description: 'nested', prompt: 'never runs' } }] };
					case 4: return { text: 'Fixed add() in src/math.js (it subtracted). strings.js was being changed by another agent, so I left it.' };
					case 5:
						assert.match(payload, /TASK-A:.*TASK-A2/, 'a follow-up continues the same conversation');
						return { text: '', toolCalls: [{ name: 'edit_file', params: { uri: p('src/math.js'), search_replace_blocks: sr('exports.add = (a, b) => a + b;', '// Adds two numbers.\nexports.add = (a, b) => a + b;') } }] };
					default: return { text: 'Added the comment.' };
				}
			}
			if (role === 'B') {
				switch (step) {
					case 0: return { text: '', toolCalls: [{ name: 'edit_file', params: { uri: p('src/strings.js'), search_replace_blocks: sr('s.toLowerCase()', 's.toUpperCase()') } }] };
					default: return { text: 'shout() now uppercases.', delayMs: 400 }; // still running while A tries strings.js
				}
			}
			// role E: read-only
			switch (step) {
				case 0:
					assert.ok(req.tools?.includes('read_file') && !req.tools.includes('edit_file') && !req.tools.includes('run_command') && !req.tools.includes('subagent'), `an explore subagent is offered only read-only tools: ${req.tools}`);
					return { text: '', toolCalls: [{ name: 'edit_file', params: { uri: p('test/math.test.js'), search_replace_blocks: sr('5));', '6));') } }] };
				case 1: return { text: '', toolCalls: [{ name: 'ls_dir', params: { uri: p('test') } }] };
				default:
					assert.match(last(req), /math\.test\.js/);
					return { text: 'Tests are in test/ (node:test); run them with node --test.' };
			}
		});

		const { chat } = createHarness(dir, llm, store, {
			modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' },
			modelOptions: [{ name: 'kodia-scripted-model', selection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' } }],
			terminal: new ProcessTerminalToolService(dir, 60_000),
			globalSettings: { verifyBeforeFinishing: false },
		});
		parentId = chat.state.currentThreadId;

		const { messages } = await runTurn(chat, 'Fix the failing tests. Delegate the two modules to subagents.', 100_000);
		assert.deepStrictEqual(llm.scriptErrors, [], 'every step got what it expected');
		assert.strictEqual(chat.state.currentThreadId, parentId, 'the user\'s current thread never changed');

		// the parent's tool results
		assert.deepStrictEqual(toolMessages(messages).map((t: any) => `${t.name}:${t.type}`), [
			'subagent:success', 'subagent:success', 'subagent:success', 'subagent:tool_error', 'subagent:tool_error', 'subagent:success', 'run_command:success',
		]);

		// the three ran at the same time: each started before any of them finished
		const firstOf = (r: string) => requestOrder.indexOf(r), lastOf = (r: string) => requestOrder.lastIndexOf(r);
		const finishedFirst = Math.min(lastOf('B'), lastOf('E'), requestOrder.indexOf('P', 1));
		assert.ok(Math.max(firstOf('A'), firstOf('B'), firstOf('E')) < finishedFirst, `requests were interleaved: ${requestOrder.join('')}`);

		// independent checks on disk and in the threads
		assert.strictEqual(fs.readFileSync(p('src/math.js'), 'utf8'), '// Adds two numbers.\nexports.add = (a, b) => a + b;\n');
		assert.strictEqual(fs.readFileSync(p('src/strings.js'), 'utf8'), 'exports.shout = (s) => s.toUpperCase() + \'!\';\n', 'A\'s refused edit never reached the file');
		assert.strictEqual(fs.readFileSync(p('test/math.test.js'), 'utf8'), FILES['test/math.test.js'], 'the read-only explorer changed nothing');
		const children = Object.values(chat.state.allThreads).filter(t => t?.subagentOf);
		assert.deepStrictEqual(children.map(t => [t!.subagentOf!.parentThreadId, t!.subagentOf!.agent, t!.subagentOf!.description]).sort(), [
			[parentId, 'explore', 'find tests'], [parentId, 'general', 'fix math'], [parentId, 'general', 'fix strings'],
		], 'three child threads (the follow-up reused one), linked to the parent');
	});

	test('parallel subagents may both create the same folder (folders are shared; only files are owned) — seen live', async () => {
		let parentId = '';
		const llm = new ScriptedLLMService((_i, req): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			if (req.threadId === parentId) {
				return payload.includes('subagent_result') || payload.includes('Subagent \\"')
					? { text: 'both done' }
					: { text: '', toolCalls: [
						{ name: 'subagent', params: { agent: 'general', description: 'one', prompt: 'TASK-ONE' } },
						{ name: 'subagent', params: { agent: 'general', description: 'two', prompt: 'TASK-TWO' } },
					] };
			}
			const mine = payload.includes('TASK-ONE') ? 'one' : 'two';
			if (!payload.includes('create_file_or_folder_result')) { return { text: '', delayMs: mine === 'two' ? 50 : 0, toolCalls: [{ name: 'create_file_or_folder', params: { uri: p('shared') } }] }; }
			if (!payload.includes('write_file_result')) { return { text: '', toolCalls: [{ name: 'write_file', params: { uri: p(`shared/${mine}.js`), new_content: `// ${mine}\n` } }] }; }
			return { text: `${mine} written` };
		});
		const { chat } = createHarness(dir, llm, store, { modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' }, globalSettings: { verifyBeforeFinishing: false } });
		parentId = chat.state.currentThreadId;
		await runTurn(chat, 'make shared/one.js and shared/two.js in parallel', 60_000);
		assert.deepStrictEqual(llm.scriptErrors, []);
		const childTools = Object.values(chat.state.allThreads).filter(t => t?.subagentOf).flatMap(t => toolMessages(t!.messages).map((m: any) => `${m.name}:${m.type}`));
		assert.deepStrictEqual(childTools.sort(), ['create_file_or_folder:success', 'create_file_or_folder:success', 'write_file:success', 'write_file:success']);
		assert.deepStrictEqual(fs.readdirSync(p('shared')).sort(), ['one.js', 'two.js']);
	});

	test('stopping the parent stops its running subagent: the subagent\'s pending request is aborted and its edit never happens', async () => {
		let parentId = '';
		let chatRef: any;
		const llm = new ScriptedLLMService((_i, req): ScriptStep => {
			if (req.threadId === parentId) {
				return { text: '', toolCalls: [{ name: 'subagent', params: { agent: 'general', description: 'slow fix', prompt: 'TASK-S: fix add().' } }] };
			}
			setTimeout(() => chatRef.abortRunning(parentId), 100); // the user presses stop while the subagent waits for its model
			return { text: '', delayMs: 2000, toolCalls: [{ name: 'edit_file', params: { uri: p('src/math.js'), search_replace_blocks: sr('a - b', 'a + b') } }] };
		});
		const { chat } = createHarness(dir, llm, store, { modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' }, globalSettings: { verifyBeforeFinishing: false } });
		chatRef = chat;
		parentId = chat.state.currentThreadId;

		const { messages } = await runTurn(chat, 'Fix add() with a subagent.', 30_000);
		await new Promise(r => setTimeout(r, 2500)); // past the moment the aborted answer would have arrived
		assert.deepStrictEqual(llm.scriptErrors, []);
		assert.deepStrictEqual(toolMessages(messages).map((t: any) => `${t.name}:${t.type}`), ['subagent:rejected']);
		const child = Object.values(chat.state.allThreads).find(t => t?.subagentOf)!;
		assert.strictEqual(llm.requests.filter(r => r.threadId === child.id).length, 1, 'the subagent made no further request');
		assert.strictEqual(llm.aborted.length, 1, 'its request was aborted');
		assert.ok(!chat.streamState[child.id]?.isRunning, 'the subagent is not running');
		assert.strictEqual(fs.readFileSync(p('src/math.js'), 'utf8'), FILES['src/math.js'], 'the aborted answer\'s edit never ran');
	});
});
