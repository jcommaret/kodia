/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 3 + 4: `test_debug` runs one failing test under a real debugger and stops where it fails. Real
 * TestToolService (framework detection), real KodiaDebugToolService over VS Code's DebugSession with js-debug
 * (node --test) and debugpy (pytest), real test runners; driven through the agent loop.
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { FileAccess, Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { IDebugService } from '../../../debug/common/debug.js';
import { ITestService } from '../../../testing/common/testService.js';
import { ITestResultService } from '../../../testing/common/testResultService.js';
import { KodiaDebugToolService } from '../../browser/debugToolService.js';
import { KodiaDebuggerActivityService } from '../../browser/debuggerActivityService.js';
import { GitToolService, IGitToolService } from '../../browser/gitToolService.js';
import { ITerminalToolService } from '../../browser/terminalToolService.js';
import { TestToolService } from '../../browser/testToolService.js';
import { IKodiaGitMainService } from '../../common/gitService.js';
import { KodiaGitMainService } from '../../electron-main/kodiaGitMainService.js';
import { createRealDebugStack } from './debugHarness.js';
import { createHarness, ProcessTerminalToolService, removeRepo, runTurn, ScriptedLLMService, ScriptStep, toolMessages } from './agentHarness.js';

suite('Kodia - debug a failing test (roadmap 3 + 4)', function () {
	this.timeout(150_000);

	let store: DisposableStore;
	let dir: string;
	let tests: TestToolService;
	let debugTools: KodiaDebugToolService;
	const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

	setup(() => {
		store = new DisposableStore();
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-testdebug-')));
		const logService = new NullLogService();
		const fileService = store.add(new FileService(logService));
		store.add(fileService.registerProvider(Schemas.file, store.add(new DiskFileSystemProvider(logService))));
		const noVsCodeTests = { collection: { all: [], rootItems: [], getNodeById: () => undefined }, refreshTests: async () => { }, getTestController: () => undefined, getTestsRelatedToCode: async () => [], cancelTestRun: () => { } };
		const instantiation = store.add(new InstantiationService(new ServiceCollection(
			[ITestService, noVsCodeTests as any],
			[ITestResultService, { onResultsChanged: Event.None, getResult: () => undefined } as any],
			[ITerminalToolService, store.add(new ProcessTerminalToolService(dir, 90_000)) as any],
			[IWorkspaceContextService, new TestContextService(testWorkspace(URI.file(dir)))],
			[IFileService, fileService],
			[IStorageService, store.add(new InMemoryStorageService())],
			[IKodiaGitMainService, new KodiaGitMainService()],
			[IGitToolService, new SyncDescriptor(GitToolService)],
		)));
		tests = store.add(instantiation.createInstance(TestToolService));
		const { debugService } = createRealDebugStack(dir, store);
		debugTools = store.add(new InstantiationService(new ServiceCollection([IDebugService, debugService as any]), true).createInstance(KodiaDebugToolService));
	});
	teardown(async () => {
		for (const s of (await debugTools.listSessions()).sessions) { await debugTools.stopSession(s.sessionId).catch(() => { }); }
		store.dispose();
		// a junction to the shared Jest/Mocha install: remove the link itself first, never what it points to
		const link = path.join(dir, 'node_modules');
		if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) { fs.unlinkSync(link); }
		removeRepo(dir);
	});

	const agent = (script: (i: number, payload: string) => ScriptStep) => createHarness(dir, new ScriptedLLMService((i, req) => script(i, JSON.stringify(req.messages))), store, {
		modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' }, debug: debugTools, debuggerActivity: new KodiaDebuggerActivityService(), tests, globalSettings: { verifyBeforeFinishing: false },
	});

	test('node --test: the agent debugs the failing test, stops at the failed assertion and sees the wrong value', async () => {
		write('package.json', JSON.stringify({ name: 'm', type: 'module', scripts: { test: 'node --test' } }));
		write('src/math.mjs', 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a + b; // bug\n');
		write('test/math.test.mjs', [
			/* 1 */ `import { test } from 'node:test';`,
			/* 2 */ `import assert from 'node:assert';`,
			/* 3 */ `import { add, sub } from '../src/math.mjs';`,
			/* 4 */ `test('adds numbers', () => assert.strictEqual(add(2, 3), 5));`,
			/* 5 */ `test('subtracts numbers', () => {`,
			/* 6 */ `  const got = sub(5, 3);`,
			/* 7 */ `  assert.strictEqual(got, 2);`,
			/* 8 */ `});`,
		].join('\n') + '\n');
		const { chat } = agent((i, payload) => {
			switch (i) {
				case 0: return { text: '', toolCalls: [{ name: 'test_debug', params: { test_file: 'test/math.test.mjs', test_names: 'subtracts numbers' } }] };
				case 1: {
					assert.ok(payload.includes('Stopped (reason: exception)'), `stopped at the failure: ${payload.slice(-1500)}`);
					assert.ok(payload.includes('This is where the test failed'));
					assert.match(payload, /First frame in your code: [^"]*math\.test\.mjs:7:/, 'the stop inside node:assert also points at the failing line');
					const sessionId = /Started debug session ([\w-]+)/.exec(payload)![1];
					return { text: '', toolCalls: [{ name: 'debug_get_stack_trace', params: { session_id: sessionId } }] };
				}
				case 2: {
					assert.match(payload, /math\.test\.mjs:7:/, 'the failing assertion line is on the stack');
					const sessionId = /Started debug session ([\w-]+)/.exec(payload)![1];
					// the payload is JSON: the tool result's lines are separated by an escaped "\n"
					const frameLine = payload.split('\\n').find(l => /Frame \d+:/.test(l) && /math\.test\.mjs:7:/.test(l))!;
					const frame = /Frame (\d+):/.exec(frameLine)![1];
					return { text: '', toolCalls: [{ name: 'debug_evaluate_expression', params: { session_id: sessionId, expression: 'got', frame_id: frame } }] };
				}
				case 3: {
					assert.ok(payload.includes('Result: 8'), 'the real wrong value reached the model');
					const sessionId = /Started debug session ([\w-]+)/.exec(payload)![1];
					return { text: '', toolCalls: [{ name: 'debug_stop_session', params: { session_id: sessionId } }] };
				}
				default: return { text: 'sub(5, 3) returns 8: sub adds instead of subtracting.' };
			}
		});
		const { messages } = await runTurn(chat, 'The subtract test fails; debug it.', 140_000);
		const tools = toolMessages(messages);
		assert.deepStrictEqual(tools.map((t: any) => `${t.name}:${t.type}`), ['test_debug:success', 'debug_get_stack_trace:success', 'debug_evaluate_expression:success', 'debug_stop_session:success'],
			tools.map((t: any) => `${t.name}: ${t.content}`).join('\n'));
	});

	test('pytest: stops on the failing assert with the locals of the test', async () => {
		write('pytest.ini', '[pytest]\n');
		write('calc.py', 'def total(prices):\n    return sum(prices[1:])  # bug: skips the first\n');
		write('test_calc.py', [
			/* 1 */ 'from calc import total',
			/* 2 */ '',
			/* 3 */ 'def test_ok():',
			/* 4 */ '    assert total([]) == 0',
			/* 5 */ '',
			/* 6 */ 'def test_total():',
			/* 7 */ '    got = total([1, 2, 3])',
			/* 8 */ '    assert got == 6',
		].join('\n') + '\n');
		const plan = await tests.planTestDebug(path.join(dir, 'test_calc.py'), ['test_total']);
		assert.strictEqual(plan.framework, 'pytest');
		const r = await debugTools.startAndRunToException(plan.configuration, plan.failureFilters, undefined, plan.failureCondition);
		assert.deepStrictEqual([r.stop.state, r.stop.reason, r.stop.location?.name?.replace(/ \(Current frame\)$/, ''), r.stop.location?.line], ['stopped', 'exception', 'test_total', 8], JSON.stringify(r.stop)); // debugpy marks the frame
		assert.strictEqual((await debugTools.evaluateExpression(r.sessionId, 'got')).result, '5');
		assert.ok(r.exceptionBreakpoints.find(f => f.filter === 'userUnhandled')?.enabled, JSON.stringify(r.exceptionBreakpoints));
	});

	/** Jest 29.7.0 and Mocha 10.7.3, installed once: npm install --prefix .build/kodia-js-test-deps jest@29.7.0 mocha@10.7.3 */
	const JS_DEPS = path.join(FileAccess.asFileUri('').fsPath, '..', '.build', 'kodia-js-test-deps', 'node_modules');
	const linkDeps = () => {
		if (!fs.existsSync(path.join(JS_DEPS, 'jest')) || !fs.existsSync(path.join(JS_DEPS, 'mocha'))) {
			throw new Error(`Jest/Mocha are not installed for these tests; run: npm install --prefix .build/kodia-js-test-deps jest@29.7.0 mocha@10.7.3`);
		}
		fs.symlinkSync(JS_DEPS, path.join(dir, 'node_modules'), 'junction');
	};
	const SUB_TEST = (expectLine: string) => [
		/* 1 */ `const { sub } = require('./math');`,
		/* 2 */ `${expectLine.startsWith('expect') ? 'test' : 'it'}('subtracts numbers', () => {`,
		/* 3 */ `  const got = sub(5, 3);`,
		/* 4 */ `  ${expectLine}`,
		/* 5 */ `});`,
	].join('\n') + '\n';

	for (const [fw, file, expectLine] of [
		['Jest', 'math.test.js', 'expect(got).toBe(2);'],
		['Mocha', 'test/math.spec.js', 'require("assert").strictEqual(got, 2);'],
	] as const) {
		test(`${fw}: stops at the failing assertion, pointing at the test line, with the wrong value`, async () => {
			linkDeps();
			write('package.json', JSON.stringify({ name: 'm', scripts: { test: fw.toLowerCase() }, devDependencies: { [fw.toLowerCase()]: '*' } }));
			write(path.join(path.dirname(file), 'math.js'), 'exports.sub = (a, b) => a + b; // bug\n');
			write(file, SUB_TEST(expectLine));
			const plan = await tests.planTestDebug(file, ['subtracts numbers']);
			assert.strictEqual(plan.framework, fw);
			const r = await debugTools.startAndRunToException(plan.configuration, plan.failureFilters, undefined, plan.failureCondition);
			const where = r.stop.userLocation ?? r.stop.location;
			assert.deepStrictEqual([r.stop.state, r.stop.reason, path.basename(where?.sourcePath ?? ''), where?.line], ['stopped', 'exception', path.basename(file), 4], JSON.stringify(r.stop));
			assert.strictEqual((await debugTools.evaluateExpression(r.sessionId, 'got', where!.frameId)).result, '8');
			assert.ok(r.exceptionBreakpoints.some(f => f.filter === 'all' && f.enabled && /AssertionError/.test(f.condition ?? '')), JSON.stringify(r.exceptionBreakpoints));

			await debugTools.stopSession(r.sessionId);
			const after = (await debugTools.listBreakpoints()).exceptionBreakpoints.find(f => f.filter === 'all');
			assert.deepStrictEqual([after?.enabled, after?.condition], [false, undefined], 'the user\'s own exception-breakpoint settings are back once the session ends');
		});
	}

	test('a passing test runs to its end under the debugger; unsupported frameworks are refused with the reason', async () => {
		write('pytest.ini', '[pytest]\n');
		write('test_fine.py', 'def test_fine():\n    assert 1 + 1 == 2\n');
		const plan = await tests.planTestDebug('test_fine.py', []);
		const r = await debugTools.startAndRunToException(plan.configuration, plan.failureFilters, undefined, plan.failureCondition);
		assert.strictEqual(r.stop.state, 'terminated', JSON.stringify(r.stop));

		write('go.mod', 'module example.com/m\n');
		write('m_test.go', 'package m\n');
		await assert.rejects(tests.planTestDebug('m_test.go', []), /needs Delve/);
		write('package.json', JSON.stringify({ name: 'm', devDependencies: { mocha: '*' } }));
		write('t.test.js', '');
		await assert.rejects(tests.planTestDebug('t.test.js', []), /Mocha is not installed in this project/);
	});
});
