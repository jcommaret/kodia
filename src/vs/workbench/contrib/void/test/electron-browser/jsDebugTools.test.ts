/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 4, JavaScript: KodiaDebugToolService over VS Code's real DebugModel/DebugSession/RawDebugSession and
 * Microsoft's js-debug adapter (the one behind VS Code's "node" type, fetched by scripts/kodia-fetch-js-debug-dap.mts),
 * debugging real Node.js programs. js-debug runs each program in a CHILD debug session it requests from the client
 * (DAP `startDebugging`); the agent only ever sees the session id it started.
 */

import assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IDebugService } from '../../../debug/common/debug.js';
import { KodiaDebugToolService } from '../../browser/debugToolService.js';
import { KodiaDebuggerActivityService } from '../../browser/debuggerActivityService.js';
import { createRealDebugStack } from './debugHarness.js';
import { createHarness, runTurn, ScriptedLLMService, ScriptStep, toolMessages } from './agentHarness.js';

/** js-debug names a script's top-level functions "global.applyDiscount" */
const fn = (name: string | undefined) => name?.replace(/^global\./, '');

// line numbers are used by the tests
const PROGRAM = [
	/* 1 */ 'function applyDiscount(total, code) {',
	/* 2 */ '  const rate = code === "SAVE10" ? 0.1 : 0;',
	/* 3 */ '  return total * rate; // bug: should be total * (1 - rate)',
	/* 4 */ '}',
	/* 5 */ 'function checkout(items, code) {',
	/* 6 */ '  const subtotal = items.reduce((s, [price, qty]) => s + price * qty, 0);',
	/* 7 */ '  const discounted = applyDiscount(subtotal, code);',
	/* 8 */ '  console.log(`total=${discounted}`);',
	/* 9 */ '  return discounted;',
	/* 10 */ '}',
	/* 11 */ 'checkout([[10, 2], [25, 1]], "SAVE10");',
].join('\n') + '\n';

suite('Kodia - JavaScript debugging with js-debug (roadmap 4)', function () {
	this.timeout(120_000);

	let store: DisposableStore;
	let dir: string;
	let program: string;
	let debugTools: KodiaDebugToolService;
	const procs: cp.ChildProcess[] = [];
	const launchConfig = (extra: Record<string, unknown> = {}) => ({ type: 'node', request: 'launch', name: 'app', program, cwd: dir, console: 'internalConsole', ...extra });

	setup(() => {
		store = new DisposableStore();
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-jsdebug-')));
		program = path.join(dir, 'app.js');
		fs.writeFileSync(program, PROGRAM);
		const { debugService } = createRealDebugStack(dir, store);
		const inst = store.add(new InstantiationService(new ServiceCollection([IDebugService, debugService as any]), true));
		debugTools = store.add(inst.createInstance(KodiaDebugToolService));
	});
	teardown(async () => {
		for (const s of (await debugTools.listSessions()).sessions) { await debugTools.stopSession(s.sessionId).catch(() => { }); }
		for (const p of procs.splice(0)) { p.kill(); }
		store.dispose();
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});

	test('launch with a breakpoint: stop location, stack, variables, evaluate, step out, run to the end, console output', async () => {
		const bp = await debugTools.setBreakpoint(undefined, program, 3);
		const { sessionId, stop } = await debugTools.startSession(undefined, undefined, false, launchConfig());
		assert.deepStrictEqual([stop.state, stop.reason, fn(stop.location?.name), stop.location?.line], ['stopped', 'breakpoint', 'applyDiscount', 3], JSON.stringify(stop));
		assert.strictEqual(path.resolve(stop.location!.sourcePath!).toLowerCase(), program.toLowerCase());
		assert.ok((await debugTools.listBreakpoints()).breakpoints.find(b => b.id === bp.id)?.verified, 'js-debug verified the breakpoint');

		const listed = (await debugTools.listSessions()).sessions;
		assert.ok(listed.some(s => s.parentSessionId === sessionId), `the program runs in a child session of the one the agent started: ${JSON.stringify(listed)}`);
		assert.strictEqual(listed.find(s => s.sessionId === sessionId)?.state, 'stopped', 'the started session reports its program\'s state');

		const stack = await debugTools.getStackTrace(sessionId);
		assert.deepStrictEqual(stack.frames.slice(0, 2).map(f => [fn(f.name), f.line]), [['applyDiscount', 3], ['checkout', 7]]);
		const scopes = await debugTools.getScopes(sessionId, stack.frames[0].frameId);
		const locals = await debugTools.getVariables(sessionId, scopes.scopes.find(s => /local/i.test(s.name))!.variablesReference);
		const value = (n: string) => locals.variables.find(v => v.name === n)?.value;
		assert.deepStrictEqual([value('total'), value('code'), value('rate')], ['45', '\'SAVE10\'', '0.1']);

		assert.strictEqual((await debugTools.evaluateExpression(sessionId, 'total * rate')).result, '4.5', 'evaluated where the program stopped');
		assert.strictEqual((await debugTools.evaluateExpression(sessionId, 'total * (1 - rate)')).result, '40.5');

		const out = await debugTools.stepOut(sessionId);
		// js-debug finishes the caller's statement (the assignment on line 7) and stops at the next one
		assert.deepStrictEqual([out.state, fn(out.location?.name), out.location?.line], ['stopped', 'checkout', 8], JSON.stringify(out));

		const end = await debugTools.continue(sessionId);
		assert.strictEqual(end.state, 'terminated', 'continue reports that the program ended');
		const console = (await debugTools.getConsoleOutput(sessionId)).output.map(o => o.text).join('\n');
		assert.match(console, /total=4\.5/, 'the program output reached the console, under the id the agent knows');
	});

	test('logpoint: the program does not stop, and the interpolated message is in the console', async () => {
		const lp = await debugTools.setBreakpoint(undefined, program, 3, undefined, undefined, undefined, 'discount on {total} with {code}');
		assert.strictEqual(lp.logMessage, 'discount on {total} with {code}');
		const { sessionId, stop } = await debugTools.startSession(undefined, undefined, false, launchConfig());
		assert.strictEqual(stop.state, 'terminated', 'a logpoint never stops the program');
		const console = (await debugTools.getConsoleOutput(sessionId)).output.map(o => o.text).join('\n');
		assert.match(console, /discount on 45 with SAVE10/, console);
		assert.match(console, /total=4\.5/);
	});

	const THROWING = [
		/* 1 */ '"use strict"; // (stopOnEntry breaks on line 1: keep code that runs again off it)',
		/* 2 */ 'function parse(s) { return JSON.parse(s); }',
		/* 3 */ 'try { parse("{caught"); } catch (e) { console.log("handled: " + e.name); }',
		/* 4 */ 'setTimeout(() => { parse("{uncaught"); }, 10);',
	].join('\n') + '\n';

	test('exception breakpoints: unknown filter refused with the real list; "uncaught" skips the handled throw and stops on the other', async () => {
		fs.writeFileSync(program, THROWING);
		const { sessionId, stop } = await debugTools.startSession(undefined, undefined, false, launchConfig({ stopOnEntry: true }));
		assert.deepStrictEqual([stop.state, stop.reason], ['stopped', 'entry'], JSON.stringify(stop));

		await assert.rejects(debugTools.setExceptionBreakpoints(sessionId, ['raised']), /Unknown exception filter "raised"\. This debugger has: "all" \(Caught Exceptions\), "uncaught" \(Uncaught Exceptions\)/);
		const set = await debugTools.setExceptionBreakpoints(sessionId, ['uncaught']);
		assert.deepStrictEqual(set.exceptionBreakpoints.map(f => `${f.filter}:${f.enabled}`), ['all:false', 'uncaught:true']);

		const hit = await debugTools.continue(sessionId);
		assert.deepStrictEqual([hit.state, hit.reason], ['stopped', 'exception'], JSON.stringify(hit));
		const info = await debugTools.getExceptionInfo(sessionId);
		assert.match(`${info.id} ${info.description ?? ''}`, /SyntaxError: Expected property name/, JSON.stringify(info)); // js-debug puts the message in the id
		const stack = await debugTools.getStackTrace(sessionId);
		assert.ok(stack.frames.some(f => fn(f.name) === 'parse' && f.line === 2), stack.frames.map(f => `${f.name}:${f.line}`).join(' '));
		assert.match((await debugTools.getConsoleOutput(sessionId)).output.map(o => o.text).join('\n'), /handled: SyntaxError/, 'the caught exception did not stop the program');
		assert.ok((await debugTools.listBreakpoints()).exceptionBreakpoints.find(f => f.filter === 'uncaught')?.enabled);

		await debugTools.setExceptionBreakpoints(sessionId, []);
		assert.deepStrictEqual((await debugTools.listBreakpoints()).exceptionBreakpoints.map(f => f.enabled), [false, false]);
	});

	test('attach to a Node process started with --inspect-brk: breakpoint hit, then the process runs to its end', async () => {
		const target = cp.spawn('node', ['--inspect-brk=0', program], { cwd: dir });
		procs.push(target);
		const port = await new Promise<number>((resolve, reject) => {
			let err = '';
			target.stderr!.on('data', d => { err += d; const m = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err); if (m) { resolve(Number(m[1])); } });
			target.on('exit', code => reject(new Error(`node exited ${code}: ${err}`)));
		});
		let out = '';
		target.stdout!.on('data', d => { out += d; });

		await debugTools.setBreakpoint(undefined, program, 3);
		const { sessionId, stop, request } = await debugTools.startSession(undefined, undefined, false, { type: 'node', request: 'attach', name: 'attach', port, continueOnAttach: true });
		assert.strictEqual(request, 'attach');
		assert.deepStrictEqual([stop.state, fn(stop.location?.name), stop.location?.line], ['stopped', 'applyDiscount', 3], JSON.stringify(stop));
		assert.strictEqual((await debugTools.evaluateExpression(sessionId, 'total')).result, '45');

		await debugTools.continue(sessionId);
		const exited = await new Promise<number | null>(r => target.exitCode !== null ? r(target.exitCode) : target.on('exit', r));
		assert.strictEqual(exited, 0);
		assert.match(out, /total=4\.5/, 'the attached process kept running to its end after continue');
	});

	test('the agent loop: launch stopped on entry, turn on uncaught exceptions (filters as a string), continue to the throw, read it', async () => {
		fs.writeFileSync(program, THROWING);
		const config = JSON.stringify(launchConfig({ stopOnEntry: true }));
		const { chat } = createHarness(dir, new ScriptedLLMService((i, req): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			const sessionId = () => /Started debug session ([\w-]+)/.exec(payload)![1];
			switch (i) {
				case 0: return { text: '', toolCalls: [{ name: 'debug_start_session', params: { configuration: config } }] };
				case 1:
					assert.ok(payload.includes('Stopped (reason: entry)'), 'the entry stop reached the model');
					return { text: '', toolCalls: [{ name: 'debug_set_exception_breakpoints', params: { session_id: sessionId(), filters: 'uncaught' } }] };
				case 2:
					assert.ok(payload.includes('[on]  uncaught') || payload.includes('[on] uncaught'), 'the model sees which exception breakpoints are on');
					return { text: '', toolCalls: [{ name: 'debug_continue', params: { session_id: sessionId() } }] };
				case 3:
					assert.ok(payload.includes('Stopped (reason: exception)'), 'the exception stop reached the model');
					return { text: '', toolCalls: [{ name: 'debug_get_exception_info', params: { session_id: sessionId() } }] };
				default:
					assert.ok(payload.includes('SyntaxError'), 'the real exception reached the model');
					return { text: 'parse() throws a SyntaxError on "{uncaught" in the timer callback; nothing catches it.' };
			}
		}), store, { modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' }, debug: debugTools, debuggerActivity: new KodiaDebuggerActivityService(), globalSettings: { verifyBeforeFinishing: false } });

		const { messages } = await runTurn(chat, 'The app crashes with an exception; find where.', 100_000);
		const tools = toolMessages(messages);
		assert.deepStrictEqual(tools.map((t: any) => `${t.name}:${t.type}`), [
			'debug_start_session:success', 'debug_set_exception_breakpoints:success', 'debug_continue:success', 'debug_get_exception_info:success',
		], tools.filter((t: any) => t.type !== 'success').map((t: any) => `${t.name}: ${t.content}`).join('\n'));
	});
});
