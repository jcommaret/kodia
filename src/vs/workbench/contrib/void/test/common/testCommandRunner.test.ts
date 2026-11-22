/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Pure logic of the command-based test runner. The node:test and pytest samples are REAL reports captured from
 * Node 24.22 and pytest 9.1 on this project's dev machine (paths shortened); the Jest/Go/Cargo/dotnet samples follow
 * those tools' documented output formats (not executed here: those toolchains are not installed).
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildTestCommand, detectTestFrameworks, dotnetSummary, nameFilterRegex, parseCargo, parseDotnet, parseGoVerbose, parseJestJson, parseJUnit, ProjectProbe } from '../../common/testCommandRunner.js';

const NODE_JUNIT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testcase name="adds numbers" time="0.000950" classname="test" file="C:\\p\\test\\math.test.mjs"/>
	<testcase name="subtracts numbers" time="0.001021" classname="test" file="C:\\p\\test\\math.test.mjs" failure="Expected values to be strictly equal:&#10;&#10;2 !== 3&#10;">
		<failure type="testCodeFailure" message="Expected values to be strictly equal:&#10;&#10;2 !== 3">
[Error [ERR_TEST_FAILURE]: Expected values to be strictly equal:

2 !== 3
] {
      at TestContext.&lt;anonymous> (file:///C:/p/test/math.test.mjs:4:40)
}
		</failure>
	</testcase>
	<testcase name="skipped one" time="0.000126" classname="test" file="C:\\p\\test\\math.test.mjs">
		<skipped type="skipped" message="true"/>
	</testcase>
	<!-- tests 3 -->
</testsuites>`;

const PYTEST_JUNIT = `<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="0" failures="1" skipped="1" tests="3" time="0.398"><testcase classname="test_calc" name="test_add" time="0.001" /><testcase classname="test_calc" name="test_sub" time="0.001"><failure message="assert (5 - 3) == 3">def test_sub():
&gt;       assert 5 - 3 == 3
E       assert (5 - 3) == 3

test_calc.py:5: AssertionError</failure></testcase><testcase classname="test_calc" name="test_skip" time="0.000"><skipped type="pytest.skip" message="later">test_calc.py:6: later</skipped></testcase></testsuite></testsuites>`;

const probe = (files: Record<string, string>, testFiles: string[] = []): ProjectProbe => ({
	readText: async p => files[p],
	exists: async p => p in files,
	testFiles,
	rootFiles: Object.keys(files).filter(f => !f.includes('/')),
});

suite('Kodia - test command runner (pure logic)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses a real node --test JUnit report: pass, fail with message and location, skip', () => {
		const r = parseJUnit(NODE_JUNIT);
		assert.deepStrictEqual(r.map(t => [t.label, t.state]), [['test › adds numbers', 'passed'], ['test › subtracts numbers', 'failed'], ['test › skipped one', 'skipped']]);
		assert.match(r[1].message!, /2 !== 3/);
		assert.match(r[1].message!, /math\.test\.mjs:4:40/);
		assert.strictEqual(r[1].uri, 'C:\\p\\test\\math.test.mjs');
		assert.strictEqual(r[0].duration, 1);
	});

	test('parses a real pytest JUnit report', () => {
		const r = parseJUnit(PYTEST_JUNIT);
		assert.deepStrictEqual(r.map(t => [t.label, t.state]), [['test_calc › test_add', 'passed'], ['test_calc › test_sub', 'failed'], ['test_calc › test_skip', 'skipped']]);
		assert.match(r[1].message!, /assert \(5 - 3\) == 3/);
		assert.ok(r[1].message!.includes('>       assert 5 - 3 == 3'), 'XML entities are decoded');
	});

	test('parses Jest --json, including a test file that could not run', () => {
		const r = parseJestJson(JSON.stringify({
			testResults: [
				{ name: '/p/a.test.js', status: 'failed', assertionResults: [{ fullName: 'math adds', status: 'passed', duration: 3 }, { fullName: 'math subtracts', status: 'failed', failureMessages: ['Expected: 3\nReceived: 2'], location: { line: 9 } }, { fullName: 'math todo', status: 'pending' }] },
				{ name: '/p/broken.test.js', status: 'failed', message: 'SyntaxError: Unexpected token', assertionResults: [] },
			],
		}));
		assert.deepStrictEqual(r.map(t => t.state), ['passed', 'failed', 'skipped', 'errored']);
		assert.strictEqual(r[1].line, 9);
		assert.match(r[3].message!, /SyntaxError/);
	});

	test('parses go test -v, cargo test and dotnet test output', () => {
		const go = parseGoVerbose(`=== RUN   TestAdd\n--- PASS: TestAdd (0.00s)\n=== RUN   TestSub\n    math_test.go:12: got 2, want 3\n--- FAIL: TestSub (0.01s)\n=== RUN   TestSkip\n    math_test.go:20: later\n--- SKIP: TestSkip (0.00s)\nFAIL\n`);
		assert.deepStrictEqual(go.map(t => [t.label, t.state]), [['TestAdd', 'passed'], ['TestSub', 'failed'], ['TestSkip', 'skipped']]);
		assert.match(go[1].message!, /got 2, want 3/);
		const cargo = parseCargo(`running 2 tests\ntest tests::adds ... ok\ntest tests::subs ... FAILED\n\nfailures:\n\n---- tests::subs stdout ----\nthread 'tests::subs' panicked at src/lib.rs:9:9:\nassertion failed: left == right\n\nfailures:\n    tests::subs\n\ntest result: FAILED. 1 passed; 1 failed; 0 ignored\n`);
		assert.deepStrictEqual(cargo.map(t => [t.label, t.state]), [['tests::adds', 'passed'], ['tests::subs', 'failed']]);
		assert.match(cargo[1].message!, /panicked/);
		assert.deepStrictEqual(parseDotnet(`  Passed Calc.Tests.Adds [3 ms]\n  Failed Calc.Tests.Subs [5 ms]\n`).map(t => t.state), ['passed', 'failed']);
		assert.deepStrictEqual(dotnetSummary('Failed!  - Failed:     1, Passed:     3, Skipped:     0, Total:     4, Duration: 1 s'), { failed: 1, passed: 3, skipped: 0, total: 4 });
	});

	test('detects frameworks from project files', async () => {
		assert.deepStrictEqual((await detectTestFrameworks(probe({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) }))).map(f => f.id), ['node-test']);
		assert.deepStrictEqual((await detectTestFrameworks(probe({ 'package.json': JSON.stringify({ devDependencies: { vitest: '^3' } }) }))).map(f => f.id), ['vitest']);
		assert.deepStrictEqual((await detectTestFrameworks(probe({ 'package.json': '{}', 'test/a.test.mjs': `import { test } from 'node:test';` }, ['test/a.test.mjs']))).map(f => f.id), ['node-test']);
		assert.deepStrictEqual((await detectTestFrameworks(probe({ 'tests/test_x.py': '' }, ['tests/test_x.py']))).map(f => f.id), ['pytest']);
		assert.deepStrictEqual((await detectTestFrameworks(probe({ 'go.mod': 'module x', 'Cargo.toml': '', 'App.sln': '', 'phpunit.xml': '' }))).map(f => f.id).sort(), ['cargo', 'dotnet', 'go', 'phpunit']);
		assert.deepStrictEqual(await detectTestFrameworks(probe({ 'README.md': '' })), []);
	});

	test('builds commands; names become shell-safe regexes; unsafe input is refused', () => {
		const c = buildTestCommand('node-test', { files: ['test/math.test.mjs'], names: ['subtracts numbers'], reportFile: '.kodia/test-results/r.xml' });
		assert.strictEqual(c.command, 'node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=.kodia/test-results/r.xml --test-name-pattern=subtracts\\snumbers test/math.test.mjs');
		assert.strictEqual(nameFilterRegex(['a.b (x)']), 'a\\.b\\s\\(x\\)');
		assert.match(buildTestCommand('pytest', { reportFile: 'r.xml', names: ['test_sub'] }).command, /-k test_sub$/);
		assert.throws(() => buildTestCommand('node-test', { files: ['test/a b.test.mjs'], reportFile: 'r.xml' }), /safely/);
		assert.throws(() => buildTestCommand('node-test', { files: ['a.js & del *'], reportFile: 'r.xml' }), /safely/);
		assert.throws(() => buildTestCommand('node-test', { files: ['--require=evil.js'], reportFile: 'r.xml' }), /safely/);
		assert.throws(() => buildTestCommand('jest', { names: ['x"; calc; "'], reportFile: 'r.json' }), /safely/);
	});
});
