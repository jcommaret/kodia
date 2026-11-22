/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Test history, regressions and flaky-test detection (roadmap 3). Pure logic; the test tool service persists it.
 *
 * Each recorded outcome carries a fingerprint of the code it ran against (git HEAD + uncommitted changes, when the
 * project is a git repository). A test is FLAKY only when it both passed and failed on the same fingerprint: a test
 * that fails after an edit and passes after the fix is not flaky, it was fixed. Without fingerprints (no git), history
 * alone cannot tell the two apart, so it never calls a test flaky — test_check_flaky (repeated runs on unchanged code)
 * can.
 */

import { TestCaseResult, TestRunResultData } from './testServiceTypes.js';

export type TestOutcomeState = TestCaseResult['state'];

export type TestHistoryOutcome = {
	runId: string;
	at: number;
	state: TestOutcomeState;
	/** the code the test ran against; undefined when it could not be determined */
	fingerprint?: string;
	durationMs?: number;
	/** the start of the failure message, for failed/errored outcomes */
	message?: string;
};

export type TestHistoryTest = { label: string; uri?: string; outcomes: TestHistoryOutcome[] };

export type TestHistoryRun = {
	runId: string; at: number; fingerprint?: string;
	source?: string; framework?: string;
	passed: number; failed: number; skipped: number; total: number; completed: boolean;
};

export type TestHistory = { version: 1; tests: Record<string, TestHistoryTest>; runs: TestHistoryRun[] };

export const MAX_OUTCOMES_PER_TEST = 20;
export const MAX_TRACKED_TESTS = 2000;
export const MAX_RECORDED_RUNS = 50;
const MESSAGE_CHARS = 300;

export function emptyTestHistory(): TestHistory { return { version: 1, tests: {}, runs: [] }; }

/** Reads stored history defensively: anything malformed is dropped rather than trusted. */
export function parseTestHistory(raw: string | undefined): TestHistory {
	if (!raw) { return emptyTestHistory(); }
	let data: unknown;
	try { data = JSON.parse(raw); } catch { return emptyTestHistory(); }
	const h = data as Partial<TestHistory>;
	if (!h || h.version !== 1 || typeof h.tests !== 'object' || h.tests === null || !Array.isArray(h.runs)) { return emptyTestHistory(); }
	const states = new Set<string>(['passed', 'failed', 'skipped', 'errored']);
	const tests: Record<string, TestHistoryTest> = {};
	for (const [id, t] of Object.entries(h.tests)) {
		if (!t || typeof t.label !== 'string' || !Array.isArray(t.outcomes)) { continue; }
		const outcomes = t.outcomes.filter(o => o && typeof o.runId === 'string' && typeof o.at === 'number' && states.has(o.state)).slice(-MAX_OUTCOMES_PER_TEST);
		if (outcomes.length) { tests[id] = typeof t.uri === 'string' ? { label: t.label, uri: t.uri, outcomes } : { label: t.label, outcomes }; }
	}
	const runs = h.runs.filter(r => r && typeof r.runId === 'string' && typeof r.at === 'number').slice(-MAX_RECORDED_RUNS);
	return { version: 1, tests, runs };
}

/** What changed compared with each test's previous recorded outcome. */
export type TestRunComparison = {
	/** passed (or was never seen failing) last time, fails now */
	newlyFailing: string[];
	/** failed last time, passes now */
	fixed: string[];
	/** failing now, and already known to be flaky */
	knownFlaky: string[];
};

const isFail = (s: TestOutcomeState) => s === 'failed' || s === 'errored';

/** A runner-level row ("jest could not run the tests") is not a test. */
const isRealTest = (r: TestCaseResult) => !r.id.endsWith('::(runner)');

/**
 * Adds a run to the history (mutates and returns it) and compares it with what came before.
 * Incomplete runs are recorded too: what a runner reported is still a real outcome.
 */
export function recordTestRun(history: TestHistory, data: TestRunResultData, at: number, fingerprint: string | undefined): TestRunComparison {
	const comparison: TestRunComparison = { newlyFailing: [], fixed: [], knownFlaky: [] };
	for (const r of data.testResults.filter(isRealTest)) {
		const entry = history.tests[r.id] ?? (history.tests[r.id] = { label: r.label, uri: r.uri, outcomes: [] });
		entry.label = r.label;
		if (r.uri) { entry.uri = r.uri; }
		const previous = [...entry.outcomes].reverse().find(o => o.state !== 'skipped');
		if (previous && r.state !== 'skipped') {
			if (previous.state === 'passed' && isFail(r.state)) { comparison.newlyFailing.push(r.label); }
			if (isFail(previous.state) && r.state === 'passed') { comparison.fixed.push(r.label); }
		}
		entry.outcomes.push({
			runId: data.runId, at, state: r.state, fingerprint,
			durationMs: r.duration, message: isFail(r.state) && r.message ? r.message.slice(0, MESSAGE_CHARS) : undefined,
		});
		if (entry.outcomes.length > MAX_OUTCOMES_PER_TEST) { entry.outcomes.splice(0, entry.outcomes.length - MAX_OUTCOMES_PER_TEST); }
		if (isFail(r.state) && analyzeTestHistory(r.id, entry).flaky) { comparison.knownFlaky.push(r.label); }
	}
	history.runs.push({ runId: data.runId, at, fingerprint, source: data.source, framework: data.framework, passed: data.passed, failed: data.failed, skipped: data.skipped, total: data.total, completed: data.completed });
	if (history.runs.length > MAX_RECORDED_RUNS) { history.runs.splice(0, history.runs.length - MAX_RECORDED_RUNS); }
	pruneTests(history);
	return comparison;
}

/** Keeps the most recently seen tests when there are too many. */
function pruneTests(history: TestHistory): void {
	const ids = Object.keys(history.tests);
	if (ids.length <= MAX_TRACKED_TESTS) { return; }
	const lastSeen = (id: string) => history.tests[id].outcomes[history.tests[id].outcomes.length - 1]?.at ?? 0;
	ids.sort((a, b) => lastSeen(a) - lastSeen(b));
	for (const id of ids.slice(0, ids.length - MAX_TRACKED_TESTS)) { delete history.tests[id]; }
}

export type TestHistoryAnalysis = {
	id: string;
	label: string;
	uri?: string;
	runs: number;
	passed: number;
	failed: number;
	skipped: number;
	lastState: TestOutcomeState;
	lastRunAt: number;
	/** times the outcome changed between consecutive non-skipped runs */
	flips: number;
	flaky: boolean;
	/** why it is flaky, in plain words */
	flakyEvidence?: string;
	/** consecutive failures up to and including the latest run */
	failingStreak: number;
	lastFailureMessage?: string;
	averageDurationMs?: number;
};

export function analyzeTestHistory(id: string, t: TestHistoryTest): TestHistoryAnalysis {
	const ran = t.outcomes.filter(o => o.state !== 'skipped');
	let flips = 0;
	for (let i = 1; i < ran.length; i++) { if (isFail(ran[i].state) !== isFail(ran[i - 1].state)) { flips++; } }

	// same code, different result
	const byFingerprint = new Map<string, { passed: number; failed: number }>();
	for (const o of ran) {
		if (!o.fingerprint) { continue; }
		const c = byFingerprint.get(o.fingerprint) ?? { passed: 0, failed: 0 };
		if (isFail(o.state)) { c.failed++; } else { c.passed++; }
		byFingerprint.set(o.fingerprint, c);
	}
	const mixed = [...byFingerprint].find(([, c]) => c.passed > 0 && c.failed > 0);

	let failingStreak = 0;
	for (let i = t.outcomes.length - 1; i >= 0; i--) {
		const s = t.outcomes[i].state;
		if (s === 'skipped') { continue; }
		if (isFail(s)) { failingStreak++; } else { break; }
	}
	const durations = t.outcomes.map(o => o.durationMs).filter((d): d is number => typeof d === 'number');
	const last = t.outcomes[t.outcomes.length - 1];
	const lastFailure = [...t.outcomes].reverse().find(o => isFail(o.state));
	return {
		id, label: t.label, uri: t.uri,
		runs: t.outcomes.length,
		passed: t.outcomes.filter(o => o.state === 'passed').length,
		failed: t.outcomes.filter(o => isFail(o.state)).length,
		skipped: t.outcomes.filter(o => o.state === 'skipped').length,
		lastState: last.state, lastRunAt: last.at,
		flips,
		flaky: !!mixed,
		flakyEvidence: mixed ? `passed ${mixed[1].passed}× and failed ${mixed[1].failed}× on the same code (fingerprint ${mixed[0].slice(0, 12)})` : undefined,
		failingStreak,
		lastFailureMessage: lastFailure?.message,
		averageDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : undefined,
	};
}

export type TestHistoryQuery = { nameFilter?: string; onlyProblems?: boolean; limit?: number };

/** Flaky tests first, then failing ones, then the rest; most recently run first within each group. */
export function queryTestHistory(history: TestHistory, q: TestHistoryQuery = {}): { tests: TestHistoryAnalysis[]; matched: number; tracked: number } {
	const filter = q.nameFilter?.trim().toLowerCase();
	let all = Object.entries(history.tests).map(([id, t]) => analyzeTestHistory(id, t));
	const tracked = all.length;
	if (filter) { all = all.filter(a => a.label.toLowerCase().includes(filter) || (a.uri ?? '').toLowerCase().includes(filter)); }
	if (q.onlyProblems) { all = all.filter(a => a.flaky || a.failingStreak > 0 || a.flips > 0); }
	const group = (a: TestHistoryAnalysis) => a.flaky ? 0 : a.failingStreak > 0 ? 1 : a.flips > 0 ? 2 : 3;
	all.sort((a, b) => group(a) - group(b) || b.lastRunAt - a.lastRunAt || a.label.localeCompare(b.label));
	const matched = all.length;
	return { tests: all.slice(0, Math.max(1, Math.min(q.limit ?? 30, 200))), matched, tracked };
}

export type RepeatedRunVerdict = {
	attempts: number;
	/** passed in some attempts and failed in others, on the same code */
	flaky: { label: string; passed: number; failed: number; messages: string[] }[];
	consistentlyFailing: string[];
	consistentlyPassing: number;
	/** tests that did not appear in every attempt (renamed, filtered, runner error) */
	incomplete: string[];
};

/** Classifies the same tests run several times back to back, with no code change in between. */
export function classifyRepeatedRuns(runs: TestRunResultData[]): RepeatedRunVerdict {
	const per = new Map<string, { label: string; passed: number; failed: number; seen: number; messages: Set<string> }>();
	for (const run of runs) {
		for (const r of run.testResults.filter(isRealTest)) {
			if (r.state === 'skipped') { continue; }
			const c = per.get(r.id) ?? { label: r.label, passed: 0, failed: 0, seen: 0, messages: new Set<string>() };
			c.seen++;
			if (isFail(r.state)) { c.failed++; if (r.message) { c.messages.add(r.message.split('\n')[0].slice(0, 200)); } } else { c.passed++; }
			per.set(r.id, c);
		}
	}
	const verdict: RepeatedRunVerdict = { attempts: runs.length, flaky: [], consistentlyFailing: [], consistentlyPassing: 0, incomplete: [] };
	for (const c of per.values()) {
		if (c.seen < runs.length) { verdict.incomplete.push(c.label); }
		if (c.passed > 0 && c.failed > 0) { verdict.flaky.push({ label: c.label, passed: c.passed, failed: c.failed, messages: [...c.messages].slice(0, 3) }); }
		else if (c.failed > 0) { verdict.consistentlyFailing.push(c.label); }
		else { verdict.consistentlyPassing++; }
	}
	return verdict;
}
