/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 3 / acceptance scenario 5 with REAL test runners: TestToolService built by dependency injection, running
 * node:test and pytest projects through a real terminal and the real file system (temp projects), then the agent
 * loop doing discover → run → see the failure → fix → rerun failed.
 *
 * The VS Code Testing-API path is not exercised here (no test-controller extension in a unit test): the fake
 * ITestService exposes no tests, which is exactly the situation the command path exists for.
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { ITestService } from '../../../testing/common/testService.js';
import { ITestResultService } from '../../../testing/common/testResultService.js';
import { ITerminalToolService } from '../../browser/terminalToolService.js';
import { TestToolService } from '../../browser/testToolService.js';
import { DIVIDER, FINAL, ORIGINAL } from '../../common/prompt/prompts.js';
import { createHarness, ProcessTerminalToolService, runTurn, ScriptedLLMService, ScriptStep, toolMessages } from './agentHarness.js';

const BUGGY_MATH = `export const add = (a, b) => a + b;\nexport const sub = (a, b) => a + b; // bug\n`;
const MATH_TESTS = `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { add, sub } from '../src/math.mjs';\ntest('adds numbers', () => assert.strictEqual(add(2, 3), 5));\ntest('subtracts numbers', () => assert.strictEqual(sub(5, 3), 2));\ntest('skipped one', { skip: true }, () => {});\n`;

suite('Kodia - test tools with real runners (roadmap 3, scenario 5)', function () {
	this.timeout(120_000);

	let store: DisposableStore;
	let dir: string;
	let tests: TestToolService;
	let terminal: ProcessTerminalToolService;
	const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

	const build = () => {
		const logService = new NullLogService();
		const fileService = store.add(new FileService(logService));
		store.add(fileService.registerProvider(Schemas.file, store.add(new DiskFileSystemProvider(logService))));
		terminal = store.add(new ProcessTerminalToolService(dir, 90_000));
		// a workbench with no test-controller extension: the Testing API exposes no tests
		const noVsCodeTests = { collection: { all: [], rootItems: [], getNodeById: () => undefined }, refreshTests: async () => { }, getTestController: () => undefined, getTestsRelatedToCode: async () => [], cancelTestRun: () => { } };
		const instantiation = store.add(new InstantiationService(new ServiceCollection(
			[ITestService, noVsCodeTests as any],
			[ITestResultService, { onResultsChanged: Event.None, getResult: () => undefined } as any],
			[ITerminalToolService, terminal as any],
			[IWorkspaceContextService, new TestContextService(testWorkspace(URI.file(dir)))],
			[IFileService, fileService],
		)));
		tests = store.add(instantiation.createInstance(TestToolService)); // the old class threw here
		return fileService;
	};

	setup(() => {
		store = new DisposableStore();
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-tests-')));
	});
	teardown(() => { store.dispose(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

	const nodeProject = () => { write('package.json', JSON.stringify({ name: 'm', type: 'module', scripts: { test: 'node --test' } })); write('src/math.mjs', BUGGY_MATH); write('test/math.test.mjs', MATH_TESTS); };

	test('discover and list (node:test project, no test extension)', async () => {
		nodeProject(); build();
		const { frameworks } = await tests.discoverFrameworks();
		assert.deepStrictEqual(frameworks.map(f => f.controllerId), ['command:node-test']);
		const { testFiles } = await tests.listTests();
		assert.deepStrictEqual(testFiles.map(f => [f.label, f.testCount]), [['test/math.test.mjs', 3]]);
	});

	test('run all: real counts, the real failure message, the exact command and exit code; no leftovers', async () => {
		nodeProject(); build();
		const { results: r } = await tests.runTests({});
		assert.deepStrictEqual([r.passed, r.failed, r.skipped, r.total, r.exitCode, r.completed, r.source], [1, 1, 1, 3, 1, true, 'command']);
		const failed = r.testResults.find(t => t.state === 'failed')!;
		assert.strictEqual(failed.label, 'test › subtracts numbers');
		assert.match(failed.message!, /8 !== 2/);
		assert.match(r.command!, /^node --test .*--test-reporter=junit/);
		assert.strictEqual(terminal.commands.length, 1, 'ran through the terminal service');
		assert.deepStrictEqual(fs.readdirSync(path.join(dir, '.kodia', 'test-results')), [], 'report files are cleaned up');
	});

	test('run one test by name, rerun only the failures, then the fix passes', async () => {
		nodeProject(); build();
		const byName = (await tests.runTests({ test_names: ['adds numbers'] })).results;
		assert.deepStrictEqual([byName.total, byName.passed], [1, 1]);
		await tests.runTests({});
		const rerun = (await tests.rerunFailedTests({})).results;
		assert.deepStrictEqual(rerun.testResults.map(t => [t.label, t.state]), [['test › subtracts numbers', 'failed']], 'only the failed test is rerun');
		write('src/math.mjs', BUGGY_MATH.replace('a + b; // bug', 'a - b;'));
		const fixed = (await tests.rerunFailedTests({})).results;
		assert.deepStrictEqual(fixed.testResults.map(t => [t.label, t.state]), [['test › subtracts numbers', 'passed']]);
		assert.strictEqual(fixed.exitCode, 0);
	});

	test('targeted run: a changed source file runs the tests that use it', async () => {
		nodeProject(); write('test/other.test.mjs', `import { test } from 'node:test';\ntest('unrelated', () => {});\n`); build();
		const r = (await tests.runTargetedTests({ changed_files: [path.join(dir, 'src', 'math.mjs')] })).results;
		assert.ok(r.command!.endsWith('test/math.test.mjs'), r.command);
		assert.strictEqual(r.total, 3);
	});

	test('pytest project: real counts and failure message', async () => {
		write('test_calc.py', 'import pytest\ndef test_add():\n    assert 1 + 1 == 2\ndef test_sub():\n    assert 5 - 3 == 3\n@pytest.mark.skip(reason="later")\ndef test_skip():\n    pass\n');
		build();
		const r = (await tests.runTests({})).results;
		assert.deepStrictEqual([r.framework, r.passed, r.failed, r.skipped, r.total], ['pytest', 1, 1, 1, 3]);
		assert.match(r.testResults.find(t => t.state === 'failed')!.message!, /assert \(5 - 3\) == 3/);
	});

	test('honest outcomes: nothing detected, and a test file that cannot even load', async () => {
		write('README.md', '# nothing to test\n'); build();
		const none = (await tests.runTests({})).results;
		assert.strictEqual(none.total, 0);
		assert.match(none.note!, /No test framework was detected/);

		write('package.json', JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }));
		write('test/broken.test.mjs', `import { test } from 'node:test';\ntest('x', () => {\n`); // syntax error
		const broken = (await tests.runTests({})).results;
		assert.ok(broken.failed >= 1 && broken.exitCode !== 0, `a file that cannot load is a failure, not "0 passed": ${JSON.stringify(broken)}`);
	});

	test('the agent loop: discover → run → see the failure → fix → rerun failed passes', async () => {
		nodeProject(); build();
		const { chat } = createHarness(dir, new ScriptedLLMService((i, req): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			switch (i) {
				case 0: return { text: '', toolCalls: [{ name: 'test_discover', params: {} }] };
				case 1:
					assert.ok(payload.includes('Node.js test runner'), 'the detected framework reached the model');
					return { text: '', toolCalls: [{ name: 'test_run', params: {} }] };
				case 2:
					assert.ok(payload.includes('1 failed') && payload.includes('subtracts numbers') && payload.includes('8 !== 2'), 'the real failure reached the model');
					return { text: '', toolCalls: [{ name: 'edit_file', params: { uri: path.join(dir, 'src', 'math.mjs'), search_replace_blocks: `${ORIGINAL}\nexport const sub = (a, b) => a + b; // bug\n${DIVIDER}\nexport const sub = (a, b) => a - b;\n${FINAL}` } }] };
				case 3: return { text: '', toolCalls: [{ name: 'test_rerun_failed', params: {} }] };
				default:
					assert.ok(payload.includes('1 passed, 0 failed'), 'the rerun result reached the model');
					return { text: 'Fixed sub(); the failing test now passes.' };
			}
		}), store, { modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' }, tests, globalSettings: { verifyBeforeFinishing: false } });

		const { messages } = await runTurn(chat, 'Run the tests and fix any failure.', 90_000);
		assert.deepStrictEqual(toolMessages(messages).map((t: any) => `${t.name}:${t.type}`), ['test_discover:success', 'test_run:success', 'edit_file:success', 'test_rerun_failed:success']);
		assert.match(fs.readFileSync(path.join(dir, 'src', 'math.mjs'), 'utf8'), /a - b/);
		assert.strictEqual(terminal.commands.map(c => c.exitCode).join(','), '1,0', 'the real runs: failing, then passing');
	});
});
