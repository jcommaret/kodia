/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 4 / acceptance scenario 4 with a REAL debug adapter: KodiaDebugToolService (built by DI) over VS Code's real
 * DebugModel/DebugSession/RawDebugSession and Microsoft's debugpy adapter, debugging a real Python program.
 * See debugHarness.ts for exactly what is real and what is shimmed (only DebugService orchestration).
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IDebugService } from '../../../debug/common/debug.js';
import { KodiaDebugToolService } from '../../browser/debugToolService.js';
import { KodiaDebuggerActivityService } from '../../browser/debuggerActivityService.js';
import { DIVIDER, FINAL, ORIGINAL } from '../../common/prompt/prompts.js';
import { createRealDebugStack } from './debugHarness.js';
import { createHarness, runTurn, ScriptedLLMService, ScriptStep, toolMessages } from './agentHarness.js';

// line numbers are used by the tests
const BUGGY_PROGRAM = [
	/* 1 */ 'def apply_discount(total, code):',
	/* 2 */ '    rate = 0.1 if code == "SAVE10" else 0',
	/* 3 */ '    return total * rate  # bug: should be total * (1 - rate)',
	/* 4 */ '',
	/* 5 */ 'def checkout(items, code):',
	/* 6 */ '    subtotal = sum(price * qty for price, qty in items)',
	/* 7 */ '    discounted = apply_discount(subtotal, code)',
	/* 8 */ '    print(f"total={discounted}")',
	/* 9 */ '    return discounted',
	/* 10 */ '',
	/* 11 */ 'checkout([(10, 2), (25, 1)], "SAVE10")',
].join('\n') + '\n';

suite('Kodia - debugger with a real DAP adapter (roadmap 4, scenario 4)', function () {
	this.timeout(120_000);

	let store: DisposableStore;
	let dir: string;
	let program: string;
	let debugTools: KodiaDebugToolService;
	let sessions: string[];
	const launchConfig = () => ({ type: 'debugpy', request: 'launch', name: 'app', program, console: 'internalConsole', justMyCode: true, cwd: dir });

	setup(() => {
		store = new DisposableStore();
		sessions = [];
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-debug-')));
		program = path.join(dir, 'app.py');
		fs.writeFileSync(program, BUGGY_PROGRAM);
		const { debugService } = createRealDebugStack(dir, store);
		const inst = store.add(new InstantiationService(new ServiceCollection([IDebugService, debugService as any]), true));
		debugTools = store.add(inst.createInstance(KodiaDebugToolService));
		store.add(debugService.onDidNewSession(s => sessions.push(s.getId())));
	});
	teardown(async () => {
		for (const s of (await debugTools.listSessions()).sessions) { await debugTools.stopSession(s.sessionId).catch(() => { }); }
		store.dispose();
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});

	test('breakpoint on a plain file path, launch with an inline config (no launch.json), stop reported with location', async () => {
		const bp = await debugTools.setBreakpoint(undefined, program, 3);
		assert.ok(bp.id.length > 0, 'breakpoints have ids');
		assert.strictEqual(URI.parse(bp.uri).scheme, 'file', 'a plain Windows path is a file URI (URI.parse made "C:" the scheme)');
		assert.strictEqual(URI.parse(bp.uri).fsPath.toLowerCase(), program.toLowerCase());

		const started = await debugTools.startSession(undefined, undefined, false, launchConfig());
		assert.strictEqual(started.stop.state, 'stopped');
		assert.strictEqual(started.stop.reason, 'breakpoint');
		assert.strictEqual(started.stop.location?.name, 'apply_discount');
		assert.strictEqual(started.stop.location?.line, 3);
		assert.ok(path.resolve(started.stop.location!.sourcePath!).toLowerCase() === path.resolve(program).toLowerCase());
		assert.ok((await debugTools.listBreakpoints()).breakpoints[0].verified, 'the adapter verified the breakpoint');
	});

	test('inspect: stack, scopes, variables, expressions — then find the bug, step, and run to the end', async () => {
		await debugTools.setBreakpoint(undefined, program, 3);
		const { sessionId, stop } = await debugTools.startSession(undefined, undefined, false, launchConfig());

		const stack = await debugTools.getStackTrace(sessionId); // no thread id: the stopped thread is used
		assert.deepStrictEqual(stack.frames.slice(0, 3).map(f => [f.name, f.line]), [['apply_discount', 3], ['checkout', 7], ['<module>', 11]]);

		const scopes = await debugTools.getScopes(sessionId, stack.frames[0].frameId);
		const locals = await debugTools.getVariables(sessionId, scopes.scopes.find(s => /local/i.test(s.name))!.variablesReference);
		const value = (n: string) => locals.variables.find(v => v.name === n)?.value;
		assert.deepStrictEqual([value('total'), value('code'), value('rate')], ['45', '\'SAVE10\'', '0.1']);

		assert.strictEqual((await debugTools.evaluateExpression(sessionId, 'total * rate', stop.location!.frameId)).result, '4.5', 'what the buggy line returns');
		assert.strictEqual((await debugTools.evaluateExpression(sessionId, 'total * (1 - rate)', stop.location!.frameId)).result, '40.5', 'what it should return');
		assert.strictEqual((await debugTools.evaluateExpression(sessionId, 'total')).result, '45', 'without a frame id: evaluated where the program stopped (was the global scope: NameError)');

		const stepped = await debugTools.stepOut(sessionId);
		assert.strictEqual(stepped.state, 'stopped');
		assert.strictEqual(stepped.reason, 'step');
		assert.strictEqual(stepped.location?.name, 'checkout');

		const end = await debugTools.continue(sessionId);
		assert.strictEqual(end.state, 'terminated', 'continue reports that the program ended');
		const out = (await debugTools.getConsoleOutput(sessionId)).output.map(o => o.text).join('');
		assert.match(out, /total=4\.5/, 'program output is captured from the debug console (was never captured)');
	});

	test('conditional breakpoint, remove by id, and a program that never stops', async () => {
		const conditional = await debugTools.setBreakpoint(undefined, program, 2, undefined, 'code == "NOPE"');
		let r = await debugTools.startSession(undefined, undefined, false, launchConfig());
		assert.strictEqual(r.stop.state, 'terminated', 'the condition was false, so the program ran to completion');

		const plain = await debugTools.setBreakpoint(undefined, program, 8);
		await debugTools.removeBreakpoint(conditional.id);
		assert.deepStrictEqual((await debugTools.listBreakpoints()).breakpoints.map(b => b.id), [plain.id]);
		r = await debugTools.startSession(undefined, undefined, false, launchConfig());
		assert.deepStrictEqual([r.stop.state, r.stop.location?.line], ['stopped', 8]);
		// stop means stopped: the very next breakpoint change must not hit a half-closed adapter ("Canceled")
		await debugTools.stopSession(r.sessionId);
		assert.strictEqual((await debugTools.getSessionStatus(r.sessionId)).state, 'inactive');
		await debugTools.removeBreakpoint(plain.id);
		await assert.rejects(debugTools.removeBreakpoint('no-such-id'), /not found/);
	});

	test('exception breakpoints with debugpy: "raised" stops where a handled exception is raised', async () => {
		fs.writeFileSync(program, [
			/* 1 */ 'def parse(s):',
			/* 2 */ '    return int(s)',
			/* 3 */ 'try:',
			/* 4 */ '    parse("x")',
			/* 5 */ 'except ValueError as e:',
			/* 6 */ '    print("handled", e)',
		].join('\n') + '\n');
		const { sessionId, stop } = await debugTools.startSession(undefined, undefined, false, { ...launchConfig(), stopOnEntry: true });
		assert.deepStrictEqual([stop.state, stop.reason], ['stopped', 'entry'], JSON.stringify(stop));
		const set = await debugTools.setExceptionBreakpoints(sessionId, ['raised']);
		assert.ok(set.exceptionBreakpoints.some(f => f.filter === 'uncaught'), `debugpy also offers "uncaught": ${JSON.stringify(set.exceptionBreakpoints)}`);
		assert.ok(set.exceptionBreakpoints.find(f => f.filter === 'raised')?.enabled);
		const hit = await debugTools.continue(sessionId);
		assert.deepStrictEqual([hit.state, hit.reason, hit.location?.name, hit.location?.line], ['stopped', 'exception', 'parse', 2], JSON.stringify(hit));
		assert.match((await debugTools.getExceptionInfo(sessionId)).description ?? '', /invalid literal for int/);
		await debugTools.setExceptionBreakpoints(sessionId, []);
		assert.strictEqual((await debugTools.continue(sessionId)).state, 'terminated', 'with the filters off, the program runs to its end');
	});

	test('the agent loop debugs the failure: breakpoint → launch → inspect → fix → rerun shows the right total', async () => {
		const activity = new KodiaDebuggerActivityService();
		const events: string[] = [];
		store.add(activity.onDidChangeDebuggerActivity(e => events.push(`${e.type}:${e.activity.type}`)));
		const config = JSON.stringify(launchConfig());
		const { chat } = createHarness(dir, new ScriptedLLMService((i, req): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			switch (i) {
				case 0: return { text: '', toolCalls: [{ name: 'debug_set_breakpoint', params: { uri: program, line_number: '3' } }] };
				case 1: return { text: '', toolCalls: [{ name: 'debug_start_session', params: { configuration: config } }] };
				case 2: {
					assert.ok(payload.includes('Stopped (reason: breakpoint) in apply_discount') && payload.includes(':3:'), 'the real stop location reached the model');
					const sessionId = /Started debug session ([\w-]+)/.exec(payload)![1];
					return { text: '', toolCalls: [{ name: 'debug_evaluate_expression', params: { session_id: sessionId, expression: 'total * rate' } }] };
				}
				case 3:
					assert.ok(payload.includes('Result: 4.5'), 'the real evaluation reached the model');
					return { text: '', toolCalls: [{ name: 'edit_file', params: { uri: program, search_replace_blocks: `${ORIGINAL}\n    return total * rate  # bug: should be total * (1 - rate)\n${DIVIDER}\n    return total * (1 - rate)\n${FINAL}` } }] };
				case 4: {
					const sessionId = /Started debug session ([\w-]+)/.exec(payload)![1];
					return { text: '', toolCalls: [{ name: 'debug_stop_session', params: { session_id: sessionId } }] };
				}
				case 5: {
					const bpId = /Breakpoint (\S+) at /.exec(payload)![1];
					return { text: '', toolCalls: [{ name: 'debug_remove_breakpoint', params: { breakpoint_id: bpId } }] };
				}
				case 6: return { text: '', toolCalls: [{ name: 'debug_start_session', params: { configuration: config } }] };
				case 7: {
					assert.ok(payload.includes('The program has ended'), 'the rerun ran to completion');
					const sessionId = [...payload.matchAll(/Started debug session ([\w-]+)/g)].pop()![1];
					return { text: '', toolCalls: [{ name: 'debug_get_console_output', params: { session_id: sessionId } }] };
				}
				default:
					assert.ok(payload.includes('total=40.5'), 'the fixed program printed the right total');
					return { text: 'Fixed apply_discount: it returned the discount instead of the discounted total.' };
			}
		}), store, { modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' }, debug: debugTools, debuggerActivity: activity, globalSettings: { verifyBeforeFinishing: false } });

		const { messages } = await runTurn(chat, 'checkout() prints the wrong total; debug it and fix it.', 100_000);
		const errors = toolMessages(messages).filter((t: any) => t.type !== 'success').map((t: any) => `${t.name}: ${t.content}`).join('\n');
		assert.deepStrictEqual(toolMessages(messages).map((t: any) => `${t.name}:${t.type}`), [
			'debug_set_breakpoint:success', 'debug_start_session:success', 'debug_evaluate_expression:success', 'edit_file:success',
			'debug_stop_session:success', 'debug_remove_breakpoint:success', 'debug_start_session:success', 'debug_get_console_output:success',
		], errors);
		assert.match(fs.readFileSync(program, 'utf8'), /return total \* \(1 - rate\)/);
		assert.strictEqual(sessions.length, 2, 'two real debug sessions ran');
		assert.ok(events.includes('started:start_session') && events.includes('completed:evaluate_expression'), `the live debugger activity feed saw the actions: ${events.join(', ')}`);
	});
});
