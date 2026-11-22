/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Mandatory acceptance scenario 1 — "Real filesystem work", end to end through the agent loop.
 *
 *   scripted model (ILLMMessageService)  ->  ChatThreadService agent loop  ->  validateParams
 *   -> autonomy policy  ->  ToolsService.callTool  ->  EditCodeService  ->  FileService/DiskFileSystemProvider
 *   -> tool result message  ->  ConvertToLLMMessageService  ->  NEXT model request
 *
 * Everything in that chain is real Kodia code except the model itself, which is a deterministic script that
 * emits tool calls exactly as a provider adapter would (RawToolCallObj via onFinalMessage). The script also
 * records every request it receives, so the test can prove that tool RESULTS actually reached the model.
 * The temp project is created fresh per test; assertions read the disk with Node's fs.
 * (The same stack against a live provider: agentLoopLive.nvidia.test.ts.)
 *
 * Run (electron): scripts\test.bat --runGlob vs/workbench/contrib/void/test/electron-browser/agentLoopFilesystem.test.js
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { DIVIDER, FINAL, ORIGINAL } from '../../common/prompt/prompts.js';
import { COMPLETION_CHECK_REQUEST } from '../../common/completionCheck.js';
import { createHarness as createAgentHarness, ProcessTerminalToolService, RecordedRequest, runTurn, ScriptedLLMService, ScriptStep, toolMessages } from './agentHarness.js';

// set up like a user would for a bring-your-own model (Settings > model overrides)
const configuredOverrides = { openAICompatible: { 'kodia-scripted-model': { contextWindow: 128_000, reservedOutputTokenSpace: 8_192, specialToolFormat: 'openai-style', supportsSystemMessage: 'system-role' } } };

function createHarness(tmpDir: string, script: (i: number, req: RecordedRequest) => ScriptStep, store: DisposableStore, opts: { configuredModel: boolean } = { configuredModel: true }) {
	return createAgentHarness(tmpDir, new ScriptedLLMService(script), store, {
		modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' },
		// otherwise the model is unrecognized and Kodia uses its fallback capabilities
		overridesOfModel: opts.configuredModel ? configuredOverrides : {},
	});
}

/** how many times Kodia asked the model to verify its work (visible user messages) */
const completionChecks = (messages: readonly any[]) => messages.filter(m => m.role === 'user' && m.displayContent === COMPLETION_CHECK_REQUEST).length;

// ---------- tests ----------

suite('Kodia - agent loop drives the real filesystem (acceptance scenario 1)', function () {
	this.timeout(120_000);

	let store: DisposableStore;
	let tmpDir: string;
	setup(() => {
		store = new DisposableStore();
		tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-agent-e2e-')));
	});
	teardown(() => {
		store.dispose();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
	const p = (...s: string[]) => path.join(tmpDir, ...s);

	test('model tool calls create directories and files on disk, results reach the model, and it continues to completion', async () => {
		const serverV1 = `import { createServer } from 'node:http';\n\nconst PORT = 3000;\ncreateServer((_req, res) => res.end('ok')).listen(PORT);\n`;
		const pkg = JSON.stringify({ name: 'shop', version: '0.0.1', type: 'module' }, null, 2) + '\n';

		const { chat, llm } = createHarness(tmpDir, (i, req): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			if (i === 0) {
				return {
					text: 'Creating the project structure.',
					toolCalls: [
						{ name: 'create_file_or_folder', params: { uri: p('shop', 'src', 'routes') + path.sep } },
						{ name: 'write_file', params: { uri: p('shop', 'package.json'), new_content: pkg } },
						{ name: 'write_file', params: { uri: p('shop', 'src', 'server.ts'), new_content: serverV1 } },
					],
				};
			}
			if (i === 1) {
				// The model only continues correctly if it actually received the results of its previous calls.
				assert.ok(payload.includes('server.ts'), 'second request must contain the write_file result for server.ts');
				return {
					text: 'Now making the port configurable.',
					toolCalls: [
						{ name: 'edit_file', params: { uri: p('shop', 'src', 'server.ts'), search_replace_blocks: `${ORIGINAL}\nconst PORT = 3000;\n${DIVIDER}\nconst PORT = Number(process.env.PORT ?? 3000);\n${FINAL}` } },
						{ name: 'read_file', params: { uri: p('shop', 'package.json') } },
					],
				};
			}
			// The read_file result must contain the real file content that the first write produced.
			assert.ok(payload.includes('\\"name\\": \\"shop\\"') || payload.includes('"name": "shop"'), 'third request must contain the read_file result with real file content');
			return { text: 'Done: created shop/ with package.json, src/server.ts (configurable port) and src/routes/.' };
		}, store);

		const { messages, streamState } = await runTurn(chat, 'Create a minimal Node HTTP server project called shop.');

		// --- the disk is the source of truth ---
		assert.ok(fs.statSync(p('shop', 'src', 'routes')).isDirectory(), 'routes/ directory exists');
		assert.strictEqual(fs.readFileSync(p('shop', 'package.json'), 'utf8'), pkg);
		assert.strictEqual(fs.readFileSync(p('shop', 'src', 'server.ts'), 'utf8'), serverV1.replace('const PORT = 3000;', 'const PORT = Number(process.env.PORT ?? 3000);'));

		// --- the execution history matches the disk ---
		const tools = toolMessages(messages);
		assert.deepStrictEqual(tools.map(t => `${t.name}:${t.type}`), [
			'create_file_or_folder:success', 'write_file:success', 'write_file:success', 'edit_file:success', 'read_file:success',
		]);
		assert.strictEqual(llm.requests.length, 4, 'loop: tools -> tools -> final answer -> completion check answer');
		assert.strictEqual(completionChecks(messages), 1, 'files changed, so the work is checked once');
		assert.deepStrictEqual(llm.otherRequests, [], 'a short turn on a configured model needs no summarization calls');
		const last = messages.filter(m => m.role === 'assistant').at(-1) as any;
		assert.match(last.displayContent, /^Done:/);
		assert.ok(!streamState?.isRunning && !streamState?.error, `agent finished cleanly: ${JSON.stringify(streamState)}`);
	});

	test('invalid tool arguments are reported back to the model, which can repair the call', async () => {
		const { chat, llm } = createHarness(tmpDir, (i, req): ScriptStep => {
			if (i === 0) { return { text: '', toolCalls: [{ name: 'write_file', params: { uri: p('a.txt') } }] }; } // missing new_content
			if (i === 1) {
				const payload = JSON.stringify(req.messages);
				assert.ok(/newContent|new_content/.test(payload), 'the validation error must be sent back to the model');
				return { text: '', toolCalls: [{ name: 'write_file', params: { uri: p('a.txt'), new_content: 'fixed\n' } }] };
			}
			return { text: 'Wrote a.txt.' };
		}, store);

		const { messages } = await runTurn(chat, 'write a.txt');
		assert.deepStrictEqual(toolMessages(messages).map(t => `${t.name}:${t.type}`), ['write_file:invalid_params', 'write_file:success']);
		assert.strictEqual(fs.readFileSync(p('a.txt'), 'utf8'), 'fixed\n');
		assert.strictEqual(llm.requests.length, 4, '+1 completion check');
	});

	test('narrated-but-not-executed actions: the model is told nothing ran, then performs the real tool calls', async () => {
		const { chat, llm } = createHarness(tmpDir, (i, req): ScriptStep => {
			if (i === 0) { return { text: 'I will create the src folder and write src/index.ts now.' }; } // the historical failure: no tool call
			if (i === 1) {
				assert.ok(JSON.stringify(req.messages).includes('did not call any tool'), 'the model must be told that nothing was executed');
				return { text: '', toolCalls: [{ name: 'write_file', params: { uri: p('src', 'index.ts'), new_content: 'export {};\n' } }] };
			}
			return { text: 'Created src/index.ts.' };
		}, store);

		const { messages } = await runTurn(chat, 'Create src/index.ts');
		assert.strictEqual(fs.readFileSync(p('src', 'index.ts'), 'utf8'), 'export {};\n');
		assert.deepStrictEqual(toolMessages(messages).map(t => `${t.name}:${t.type}`), ['write_file:success']);
		assert.strictEqual(llm.requests.length, 4, 'narration -> nudge -> tool -> summary -> completion check');
		assert.strictEqual(messages.filter((m: any) => m.role === 'user' && /did not call any tool/.test(m.displayContent)).length, 1, 'the nudge is visible in the thread');
		assert.strictEqual(completionChecks(messages), 1);
	});

	test('a model that keeps narrating is nudged exactly once, then the turn ends without fake success', async () => {
		const { chat, llm } = createHarness(tmpDir, (): ScriptStep => ({ text: "I'll create the files now." }), store);
		const { messages, streamState } = await runTurn(chat, 'Create files');
		assert.strictEqual(llm.requests.length, 2, 'one nudge, no loop');
		assert.strictEqual(toolMessages(messages).length, 0);
		assert.deepStrictEqual(fs.readdirSync(tmpDir), [], 'nothing was written');
		assert.ok(!streamState?.isRunning);
	});

	test('a reply cut off by the output limit (finishReason=length) is continued automatically', async () => {
		const { chat, llm } = createHarness(tmpDir, (i, req): ScriptStep => {
			if (i === 0) { return { text: 'Here is the first half of the expla', finishReason: 'length' }; }
			assert.ok(JSON.stringify(req.messages).includes('cut off by the output token limit'));
			return { text: 'nation, finished.' };
		}, store);
		await runTurn(chat, 'Explain something long');
		assert.strictEqual(llm.requests.length, 2, 'the loop continued after the cut-off reply');
	});

	test('an UNconfigured unknown model receives the whole instruction, untrimmed, and no summarization calls (32k fallback)', async () => {
		// a realistic multi-requirement instruction (~1.5k tokens); with the old 4,096/4,096 fallback it got truncated
		const requirements = Array.from({ length: 60 }, (_, n) => `REQ-${n}: the service must validate field_${n} and log a structured error when it is invalid.`);
		const { chat, llm } = createHarness(tmpDir, (i, req): ScriptStep => {
			if (i === 0) {
				const payload = JSON.stringify(req.messages) + (req.separateSystemMessage ?? '');
				const missing = requirements.filter(r => !payload.includes(r));
				assert.deepStrictEqual(missing.map(r => r.slice(0, 6)), [], 'every requirement must reach the model');
				return { text: '', toolCalls: [{ name: 'write_file', params: { uri: p('x.txt'), new_content: 'x\n' } }] };
			}
			return { text: 'Wrote x.txt.' };
		}, store, { configuredModel: false });
		const { streamState } = await runTurn(chat, `Write x.txt, then follow these requirements:\n${requirements.join('\n')}`);
		assert.strictEqual(fs.readFileSync(p('x.txt'), 'utf8'), 'x\n');
		assert.deepStrictEqual(llm.otherRequests, [], 'no summarization requests');
		assert.strictEqual(llm.requests.length, 3, '+1 completion check');
		assert.ok(!streamState?.error);
	});

	test('a provider context-length error: Kodia learns the stated limit, rebuilds the request and continues', async () => {
		const { chat, llm } = createHarness(tmpDir, (i): ScriptStep => {
			if (i === 0) { return { text: '', error: `400 This model's maximum context length is 8192 tokens. However, your messages resulted in 40000 tokens.` }; }
			if (i === 1) { return { text: '', toolCalls: [{ name: 'write_file', params: { uri: p('y.txt'), new_content: 'y\n' } }] }; }
			return { text: 'Wrote y.txt.' };
		}, store, { configuredModel: false });
		const { messages, streamState } = await runTurn(chat, 'write y.txt');
		assert.strictEqual(fs.readFileSync(p('y.txt'), 'utf8'), 'y\n');
		// With real token counts (the tokenizer now loads), Kodia's prompt does not fit the learned ~7.4k window, so it also
		// tries to summarize the thread — a separate request. The agent's own requests are what this test is about.
		const agentRequests = llm.requests.filter((r: any) => !JSON.stringify(r.messages).includes('You summarize a conversation'));
		assert.strictEqual(agentRequests.length, 4, 'rejected request, retried request, final answer, completion check');
		assert.ok(!streamState?.error, `no error surfaced: ${JSON.stringify(streamState)}`);
		assert.deepStrictEqual(toolMessages(messages).map(t => `${t.name}:${t.type}`), ['write_file:success']);
	});

	test('a provider that keeps rejecting for length: bounded retries, then the error is shown (no loop, no fake success)', async () => {
		const { chat, llm } = createHarness(tmpDir, (): ScriptStep => ({ text: '', error: 'context_length_exceeded: prompt is too long' }), store, { configuredModel: false });
		const { streamState, messages } = await runTurn(chat, 'anything');
		assert.strictEqual(llm.requests.length, 3, 'first attempt + 2 recoveries');
		assert.ok(streamState?.error, 'the error is surfaced to the user');
		assert.match(streamState!.error!.message, /context window/, 'with guidance on what to do');
		assert.strictEqual(toolMessages(messages).length, 0);
	});

	test('completion check: the model runs the real tests, sees the failure, repairs the code and re-verifies', async () => {
		const terminal = new ProcessTerminalToolService(tmpDir, 30_000); // a stuck command fails fast instead of hanging the suite
		const testFile = `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { sum } from '../src/sum.mjs';\ntest('adds', () => assert.strictEqual(sum(2, 3), 5));\n`;
		const { chat, llm } = createAgentHarness(tmpDir, new ScriptedLLMService((i, req): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			switch (i) {
				case 0: return {
					text: '', toolCalls: [
						{ name: 'write_file', params: { uri: p('src', 'sum.mjs'), new_content: 'export const sum = (a, b) => a - b;\n' } }, // the bug
						{ name: 'write_file', params: { uri: p('test', 'sum.test.mjs'), new_content: testFile } },
					],
				};
				case 1: return { text: 'Done: sum() and its test are written.' }; // claims done without running anything
				case 2:
					assert.ok(payload.includes('check your work against the request'), 'Kodia asks for verification');
					return { text: '', toolCalls: [{ name: 'run_command', params: { command: 'node --test', cwd: tmpDir } }] };
				case 3:
					assert.match(payload, /exit code 1/, 'the real failing test result reaches the model');
					return { text: '', toolCalls: [{ name: 'edit_file', params: { uri: p('src', 'sum.mjs'), search_replace_blocks: `${ORIGINAL}\nexport const sum = (a, b) => a - b;\n${DIVIDER}\nexport const sum = (a, b) => a + b;\n${FINAL}` } }] };
				case 4: return { text: '', toolCalls: [{ name: 'run_command', params: { command: 'node --test', cwd: tmpDir } }] };
				default:
					assert.match(payload, /exit code 0/);
					return { text: 'Verified: `node --test` passes (1 test).' };
			}
		}), store, { modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' }, overridesOfModel: configuredOverrides, terminal });

		const { messages, streamState } = await runTurn(chat, 'Write sum(a, b) in src/sum.mjs with a node:test test.', 60_000);
		assert.ok(!streamState?.error, JSON.stringify(streamState));
		assert.strictEqual(fs.readFileSync(p('src', 'sum.mjs'), 'utf8'), 'export const sum = (a, b) => a + b;\n', 'the bug was fixed on disk');
		assert.deepStrictEqual(terminal.commands.map(c => c.exitCode), [1, 0], 'tests really ran: failed, then passed');
		assert.strictEqual(completionChecks(messages), 1, 'checked once, no loop');
		assert.strictEqual(llm.requests.length, 6);
	});

	test('test weakening is detected on the real file and reported to the model in that tool result', async () => {
		const strong = `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { sum } from '../src/sum.mjs';\ntest('adds', () => assert.strictEqual(sum(2, 3), 5));\ntest('zero', () => assert.strictEqual(sum(0, 0), 0));\n`;
		const weak = `import { sum } from '../src/sum.mjs';\nconsole.log('sum', sum(2, 3));\nconsole.log('All tests passed!');\n`; // the pattern seen live
		const testPath = p('test', 'sum.test.mjs');
		const { chat, llm } = createHarness(tmpDir, (i, req): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			switch (i) {
				case 0: return { text: '', toolCalls: [{ name: 'write_file', params: { uri: testPath, new_content: strong } }] }; // new file: never flagged
				case 1:
					assert.ok(!payload.includes('WEAKENS'), 'creating a test file is not a weakening');
					return { text: '', toolCalls: [{ name: 'write_file', params: { uri: testPath, new_content: weak } }] };
				case 2:
					assert.ok(payload.includes('WEAKENS the test file test'), 'the model is told, in the result of the weakening write');
					return { text: '', toolCalls: [{ name: 'write_file', params: { uri: testPath, new_content: strong } }] }; // restores
				default: return { text: 'Restored the tests.' };
			}
		}, store);

		const { messages } = await runTurn(chat, 'Write tests for sum.');
		const writes = toolMessages(messages).filter((t: any) => t.name === 'write_file');
		assert.strictEqual(writes.length, 3);
		assert.ok(!/WEAKENS/.test(writes[0].content), 'creation not flagged');
		assert.match(writes[1].content, /WEAKENS the test file test[\\/]sum\.test\.mjs \(test cases 2 → 0; assertions 2 → 0; test framework removed: node:test\)/);
		assert.ok(!/WEAKENS/.test(writes[2].content), 'restoring is not flagged');
		assert.strictEqual(fs.readFileSync(testPath, 'utf8'), strong);
		assert.ok(llm.requests.length >= 4);
	});

	test('a new test file with no runner-visible test cases is reported to the model', async () => {
		const scriptLike = `import assert from 'node:assert';\nexport const tests = [{ name: 'adds', fn: () => assert.strictEqual(1 + 1, 2) }];\n`; // seen live
		const { chat } = createHarness(tmpDir, (i, req): ScriptStep => {
			if (i === 0) { return { text: '', toolCalls: [{ name: 'write_file', params: { uri: p('test', 'sum.test.mjs'), new_content: scriptLike } }] }; }
			if (i === 1) { assert.ok(JSON.stringify(req.messages).includes('defines no test case'), 'the model is told'); }
			return { text: 'ok' };
		}, store);
		const { messages } = await runTurn(chat, 'Write tests.');
		assert.match(toolMessages(messages)[0].content, /test[\\/]sum\.test\.mjs is named like a test file but defines no test case/);
	});

	test('the completion check can be turned off (Settings: verifyBeforeFinishing)', async () => {
		const { chat, llm } = createAgentHarness(tmpDir, new ScriptedLLMService((i): ScriptStep => i === 0
			? { text: '', toolCalls: [{ name: 'write_file', params: { uri: p('b.txt'), new_content: 'b\n' } }] }
			: { text: 'Wrote b.txt.' }), store, {
			modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' }, overridesOfModel: configuredOverrides,
			globalSettings: { verifyBeforeFinishing: false },
		});
		const { messages } = await runTurn(chat, 'write b.txt');
		assert.strictEqual(fs.readFileSync(p('b.txt'), 'utf8'), 'b\n');
		assert.strictEqual(completionChecks(messages), 0);
		assert.strictEqual(llm.requests.length, 2);
	});

	test('read-only turns are not completion-checked', async () => {
		fs.writeFileSync(p('notes.txt'), 'hello\n');
		const { chat, llm } = createHarness(tmpDir, (i): ScriptStep => i === 0
			? { text: '', toolCalls: [{ name: 'read_file', params: { uri: p('notes.txt') } }] }
			: { text: 'The file says hello.' }, store);
		const { messages } = await runTurn(chat, 'What does notes.txt say?');
		assert.strictEqual(llm.requests.length, 2);
		assert.strictEqual(completionChecks(messages), 0);
	});

	test('a failing tool is reported as an error (never as success) and nothing is written', async () => {
		const { chat } = createHarness(tmpDir, (i) => {
			if (i === 0) { return { text: '', toolCalls: [{ name: 'edit_file', params: { uri: p('missing.ts'), search_replace_blocks: `${ORIGINAL}\na\n${DIVIDER}\nb\n${FINAL}` } }] }; }
			return { text: 'The file does not exist.' };
		}, store);

		const { messages } = await runTurn(chat, 'edit missing.ts');
		assert.deepStrictEqual(toolMessages(messages).map(t => `${t.name}:${t.type}`), ['edit_file:tool_error']);
		assert.strictEqual(fs.existsSync(p('missing.ts')), false);
	});
});
