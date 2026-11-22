/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Deterministic detection of test weakening: an edit to a test file that makes it check less (fewer test cases or
 * assertions, the test framework import removed, tests skipped, or the file deleted).
 *
 * Measured motivation (live NVIDIA runs, 2026-11-20): with a real terminal, a smaller model made failing tests "pass"
 * by rewriting the node:test file as a plain script in 7 of 13 runs. The agent loop appends the finding to the tool
 * result, so the model sees it on its next step (and the user sees it in the tool card).
 *
 * Heuristic and language-agnostic by design. It cannot see semantic weakening (e.g. changing an expected value to
 * whatever the code returns) and is not a substitute for running the tests.
 */

const TEST_PATH = /(^|[\\/])(tests?|__tests__|spec)[\\/]|[._-](test|spec)\.[cm]?[jt]sx?$|(^|[\\/])test_[^\\/]*\.py$|_test\.(py|go)$|Tests?\.(cs|java|kt|php)$/i;

export function isTestFilePath(fsPath: string): boolean {
	return TEST_PATH.test(fsPath);
}

// named like a test file (not just inside a test folder, where helpers and fixtures live)
const TEST_FILE_NAME = /[._-](test|spec)\.[cm]?[jt]sx?$|(^|[\\/])test_[^\\/]*\.py$|_test\.(py|go)$|Tests?\.(cs|java|kt|php)$/i;

export function isTestFileName(fsPath: string): boolean {
	return TEST_FILE_NAME.test(fsPath);
}

/**
 * A file named like a test that registers no test case a test runner can see (e.g. a plain script that logs results,
 * or an exported array of checks). Runners then report the whole file as one passing test, or nothing at all.
 * Measured: in 10 of 11 failed live runs the model wrote exactly such a file once, and its own "test run" passed.
 */
export function testFileWithoutTestCases(fsPath: string, text: string | undefined): boolean {
	if (text === undefined || !TEST_FILE_NAME.test(fsPath) || text.trim().length === 0) { return false; }
	return testFileStrength(text, fsPath).cases === 0;
}

export function testFileWithoutTestCasesNote(displayPath: string): string {
	return `Kodia: ${displayPath} is named like a test file but defines no test case a test runner can see (no test()/it()/def test_/@Test...). A runner will report it as a single pass, or not run it at all. Register real test cases with the project's test framework.`;
}

const TEST_CASE = /\b(?:test|it)(?:\.(?:only|each\([^)]*\)))?\s*\(|^\s*def\s+test_\w*\s*\(|@Test\b|\bfunc\s+Test\w*\s*\(|#\[test\]|\bpublic function test\w*\s*\(/gm;
const ASSERTION = /\bassert\w*\b|\bexpect\s*\(|\.should\b|\bself\.assert\w*|\bt\.(?:Error|Fatal|Fail)\w*\(|\$this->assert\w*/g;
const SKIP = /\b(?:it|test|describe)\.(?:skip|todo)\s*\(|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.skip|@unittest\.skip|@Ignore\b|@Disabled\b|\bt\.Skip\w*\(|\{\s*skip\s*:\s*true/g;
const FRAMEWORKS: [string, RegExp][] = [
	['node:test', /['"]node:test['"]/],
	['vitest', /['"]vitest['"]/],
	['@jest/globals', /['"]@jest\/globals['"]/],
	['mocha', /['"]mocha['"]/],
	['pytest', /\bimport pytest\b|\bfrom pytest\b/],
	['unittest', /\bimport unittest\b|\bfrom unittest\b/],
	['testing (Go)', /"testing"/],
	['PHPUnit', /PHPUnit\\Framework/],
	['JUnit', /org\.junit/],
];

function stripComments(text: string, fsPath: string): string {
	let t = text.replace(/\/\*[\s\S]*?\*\//g, ''); // block comments
	t = t.replace(/(^|[^:'"\\])\/\/.*$/gm, '$1'); // line comments, not URLs
	if (/\.py$/i.test(fsPath)) { t = t.replace(/(^|\s)#.*$/gm, '$1'); }
	return t;
}

export type TestFileStrength = { cases: number; assertions: number; skips: number; frameworks: string[] };

export function testFileStrength(text: string, fsPath: string): TestFileStrength {
	const code = stripComments(text, fsPath);
	// `import assert from 'node:assert'` is not an assertion: count assertions outside import/require lines
	const body = code.replace(/^\s*(?:import\b|from\s+\S+\s+import\b|const\s+.*=\s*require\().*$/gm, '');
	return {
		cases: (code.match(TEST_CASE) ?? []).length,
		assertions: (body.match(ASSERTION) ?? []).length,
		skips: (code.match(SKIP) ?? []).length,
		frameworks: FRAMEWORKS.filter(([, re]) => re.test(code)).map(([name]) => name),
	};
}

/** Human-readable reasons the edit weakened the test file; empty if it did not (or the file is new). */
export function testWeakeningReasons(fsPath: string, before: string | undefined, after: string | undefined): string[] {
	if (before === undefined) { return []; } // a new test file cannot be weaker than nothing
	const b = testFileStrength(before, fsPath);
	if (after === undefined) {
		return b.cases > 0 || b.assertions > 0 ? [`the test file was deleted (it had ${b.cases} test case(s) and ${b.assertions} assertion(s))`] : [];
	}
	const a = testFileStrength(after, fsPath);
	const reasons: string[] = [];
	if (a.cases < b.cases) { reasons.push(`test cases ${b.cases} → ${a.cases}`); }
	if (a.assertions < b.assertions) { reasons.push(`assertions ${b.assertions} → ${a.assertions}`); }
	if (a.skips > b.skips) { reasons.push(`skipped tests ${b.skips} → ${a.skips}`); }
	const dropped = b.frameworks.filter(f => !a.frameworks.includes(f));
	if (dropped.length > 0) { reasons.push(`test framework removed: ${dropped.join(', ')}`); }
	return reasons;
}

export function testWeakeningNote(displayPath: string, reasons: string[]): string {
	return `Kodia: this change WEAKENS the test file ${displayPath} (${reasons.join('; ')}). Making tests pass by testing less is not a fix. Restore the tests and fix the code under test instead — or, if a test itself is genuinely wrong, say exactly why.`;
}
