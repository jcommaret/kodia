/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { TestCaseResult, TestRunResultData } from '../../common/testServiceTypes.js';
import {
	analyzeTestHistory, classifyRepeatedRuns, emptyTestHistory, MAX_OUTCOMES_PER_TEST, parseTestHistory, queryTestHistory, recordTestRun,
} from '../../common/testHistory.js';
import { summarize } from '../../common/testCommandRunner.js';

const run = (runId: string, states: Record<string, TestCaseResult['state']>): TestRunResultData =>
	summarize(runId, Object.entries(states).map(([label, state]) => ({ id: `t.js::${label}`, label, state, message: state === 'failed' ? `${label} broke\nstack` : undefined })), { source: 'command', framework: 'node-test' });

suite('Kodia - test history and flaky detection (roadmap 3)', () => {

	test('a test that fails after a code change and passes after the fix is a regression then a fix — NOT flaky', () => {
		const h = emptyTestHistory();
		assert.deepStrictEqual(recordTestRun(h, run('r1', { a: 'passed', b: 'passed' }), 1, 'code-v1'), { newlyFailing: [], fixed: [], knownFlaky: [] });
		const c2 = recordTestRun(h, run('r2', { a: 'failed', b: 'passed' }), 2, 'code-v2');
		assert.deepStrictEqual(c2.newlyFailing, ['a']);
		const c3 = recordTestRun(h, run('r3', { a: 'passed', b: 'passed' }), 3, 'code-v3');
		assert.deepStrictEqual(c3.fixed, ['a']);
		const a = analyzeTestHistory('t.js::a', h.tests['t.js::a']);
		assert.strictEqual(a.flaky, false, 'each outcome ran on different code');
		assert.strictEqual(a.flips, 2);
	});

	test('passing and failing on the SAME code is flaky, with the evidence; a later failure is flagged as known flaky', () => {
		const h = emptyTestHistory();
		recordTestRun(h, run('r1', { a: 'passed' }), 1, 'same');
		const c2 = recordTestRun(h, run('r2', { a: 'failed' }), 2, 'same');
		assert.deepStrictEqual(c2.knownFlaky, ['a']);
		const a = analyzeTestHistory('t.js::a', h.tests['t.js::a']);
		assert.strictEqual(a.flaky, true);
		assert.match(a.flakyEvidence!, /passed 1× and failed 1× on the same code/);
		assert.strictEqual(a.lastFailureMessage, 'a broke\nstack');
	});

	test('without fingerprints (no git) history never calls a test flaky', () => {
		const h = emptyTestHistory();
		recordTestRun(h, run('r1', { a: 'passed' }), 1, undefined);
		recordTestRun(h, run('r2', { a: 'failed' }), 2, undefined);
		recordTestRun(h, run('r3', { a: 'passed' }), 3, undefined);
		assert.strictEqual(analyzeTestHistory('t.js::a', h.tests['t.js::a']).flaky, false);
	});

	test('skipped outcomes neither count as passes nor break the comparison; runner-error rows are not tests', () => {
		const h = emptyTestHistory();
		recordTestRun(h, run('r1', { a: 'passed' }), 1, 'v');
		recordTestRun(h, run('r2', { a: 'skipped' }), 2, 'v');
		const c = recordTestRun(h, run('r3', { a: 'failed' }), 3, 'v2');
		assert.deepStrictEqual(c.newlyFailing, ['a'], 'compared with the last non-skipped outcome');
		recordTestRun(h, summarize('r4', [{ id: 'jest::(runner)', label: 'jest could not run the tests', state: 'errored' }]), 4, 'v2');
		assert.strictEqual(h.tests['jest::(runner)'], undefined);
		assert.strictEqual(h.runs.length, 4);
	});

	test('bounded: outcomes per test are capped, and history survives a JSON round trip; garbage is rejected', () => {
		const h = emptyTestHistory();
		for (let i = 0; i < MAX_OUTCOMES_PER_TEST + 7; i++) { recordTestRun(h, run(`r${i}`, { a: i % 2 ? 'passed' : 'failed' }), i, `v${i}`); }
		assert.strictEqual(h.tests['t.js::a'].outcomes.length, MAX_OUTCOMES_PER_TEST);
		const back = parseTestHistory(JSON.stringify(h));
		assert.deepStrictEqual(back, JSON.parse(JSON.stringify(h)), 'what is stored is what comes back');
		assert.deepStrictEqual(parseTestHistory('{not json'), emptyTestHistory());
		assert.deepStrictEqual(parseTestHistory(JSON.stringify({ version: 2, tests: {}, runs: [] })), emptyTestHistory());
		const partlyBad = parseTestHistory(JSON.stringify({ version: 1, runs: [], tests: { ok: { label: 'ok', outcomes: [{ runId: 'r', at: 1, state: 'passed' }, { runId: 'r', at: 2, state: 'exploded' }] }, bad: { outcomes: 'x' } } }));
		assert.deepStrictEqual(Object.keys(partlyBad.tests), ['ok']);
		assert.strictEqual(partlyBad.tests.ok.outcomes.length, 1);
	});

	test('query: flaky first, then failing, then unstable, then the rest; name filter and problems-only', () => {
		const h = emptyTestHistory();
		// flaky: mixed on v1. broken: fails now. wobbly: failed on v2, fixed on v3 (unstable, not flaky, not failing).
		recordTestRun(h, run('r1', { stable: 'passed', flaky: 'passed', broken: 'passed', wobbly: 'passed' }), 1, 'v1');
		recordTestRun(h, run('r2', { stable: 'passed', flaky: 'failed', broken: 'passed', wobbly: 'passed' }), 2, 'v1');
		recordTestRun(h, run('r3', { stable: 'passed', flaky: 'passed', broken: 'passed', wobbly: 'failed' }), 3, 'v2');
		recordTestRun(h, run('r4', { stable: 'passed', flaky: 'passed', broken: 'failed', wobbly: 'passed' }), 4, 'v3');
		const all = queryTestHistory(h);
		assert.deepStrictEqual(all.tests.map(t => t.label), ['flaky', 'broken', 'wobbly', 'stable']);
		assert.strictEqual(all.tracked, 4);
		assert.deepStrictEqual(queryTestHistory(h, { onlyProblems: true }).tests.map(t => t.label), ['flaky', 'broken', 'wobbly']);
		assert.deepStrictEqual(queryTestHistory(h, { nameFilter: 'BROK' }).tests.map(t => t.label), ['broken']);
		assert.strictEqual(queryTestHistory(h, { limit: 1 }).tests.length, 1);
	});

	test('repeated runs on unchanged code: mixed outcomes are flaky, all-failing is a real failure', () => {
		const v = classifyRepeatedRuns([
			run('a1', { coin: 'passed', broken: 'failed', fine: 'passed', gone: 'passed' }),
			run('a2', { coin: 'failed', broken: 'failed', fine: 'passed' }),
			run('a3', { coin: 'passed', broken: 'failed', fine: 'passed', gone: 'passed' }),
		]);
		assert.strictEqual(v.attempts, 3);
		assert.deepStrictEqual(v.flaky.map(f => [f.label, f.passed, f.failed, f.messages]), [['coin', 2, 1, ['coin broke']]]);
		assert.deepStrictEqual(v.consistentlyFailing, ['broken']);
		assert.strictEqual(v.consistentlyPassing, 2);
		assert.deepStrictEqual(v.incomplete, ['gone']);
	});
});
