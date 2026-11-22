/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Command-based test discovery and execution (roadmap 3), for projects whose tests no VS Code test extension exposes
 * (plain node:test, pytest, Go, Cargo, dotnet, PHPUnit... with no test controller installed).
 *
 * Pure logic only: framework detection from project files, safe command construction, and parsers for each runner's
 * machine-readable output (JUnit XML, Jest JSON) or, where none exists without extra packages, its verbose text.
 * Results come only from what the runner reported; nothing is inferred or invented.
 */

import { TestCaseResult, TestFramework, TestRunResultData } from './testServiceTypes.js';

export type CommandFrameworkId = 'node-test' | 'jest' | 'vitest' | 'mocha' | 'pytest' | 'go' | 'cargo' | 'dotnet' | 'phpunit';

export type DetectedFramework = { id: CommandFrameworkId; name: string; type: TestFramework['type']; evidence: string };

/** What detection may look at, relative to the project root. */
export type ProjectProbe = {
	readText(relPath: string): Promise<string | undefined>;
	exists(relPath: string): Promise<boolean>;
	/** test-like files found by a bounded walk (relative paths, forward slashes) */
	testFiles: string[];
	/** names of files directly in the root */
	rootFiles: string[];
};

export async function detectTestFrameworks(p: ProjectProbe): Promise<DetectedFramework[]> {
	const found: DetectedFramework[] = [];
	const add = (id: CommandFrameworkId, evidence: string) => {
		if (found.some(f => f.id === id)) { return; }
		const meta: Record<CommandFrameworkId, [string, TestFramework['type']]> = {
			'node-test': ['Node.js test runner (node --test)', 'other'], jest: ['Jest', 'jest'], vitest: ['Vitest', 'vitest'], mocha: ['Mocha', 'mocha'],
			pytest: ['pytest', 'pytest'], go: ['go test', 'go test'], cargo: ['cargo test', 'cargo test'], dotnet: ['dotnet test', 'dotnet test'], phpunit: ['PHPUnit', 'other'],
		};
		found.push({ id, name: meta[id][0], type: meta[id][1], evidence });
	};

	const pkgText = await p.readText('package.json');
	if (pkgText) {
		let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
		try { pkg = JSON.parse(pkgText); } catch { /* invalid package.json: ignore */ }
		const deps = { ...pkg.dependencies, ...pkg.devDependencies };
		const testScript = pkg.scripts?.test ?? '';
		if ('vitest' in deps || /\bvitest\b/.test(testScript)) { add('vitest', 'package.json: vitest'); }
		if ('jest' in deps || /\bjest\b/.test(testScript)) { add('jest', 'package.json: jest'); }
		if ('mocha' in deps || /\bmocha\b/.test(testScript)) { add('mocha', 'package.json: mocha'); }
		if (/\bnode\s+(?:[^&|;]*\s)?--test\b/.test(testScript)) { add('node-test', `package.json scripts.test: ${testScript}`); }
	}
	if (!found.some(f => ['jest', 'vitest', 'mocha'].includes(f.id))) {
		for (const file of p.testFiles.filter(f => /\.[cm]?[jt]s$/.test(f)).slice(0, 50)) {
			if (/['"]node:test['"]/.test(await p.readText(file) ?? '')) { add('node-test', `${file} imports node:test`); break; }
		}
	}
	const pyproject = await p.readText('pyproject.toml');
	if (await p.exists('pytest.ini') || await p.exists('conftest.py') || /\[tool\.pytest/.test(pyproject ?? '') || p.testFiles.some(f => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(f))) {
		add('pytest', 'pytest configuration or test_*.py files');
	}
	if (await p.exists('go.mod')) { add('go', 'go.mod'); }
	if (await p.exists('Cargo.toml')) { add('cargo', 'Cargo.toml'); }
	if (p.rootFiles.some(f => /\.(sln|csproj|fsproj)$/i.test(f))) { add('dotnet', 'a .sln/.csproj in the project root'); }
	if (await p.exists('phpunit.xml') || await p.exists('phpunit.xml.dist')) { add('phpunit', 'phpunit.xml'); }
	return found;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Arguments are interpolated into a shell command (the integrated terminal runs it via `cmd /c "..."` on Windows), so
 * only characters that are inert in cmd, PowerShell and POSIX shells are accepted. Anything else is refused with a
 * clear error rather than risk the shell interpreting it.
 */
const SAFE_ARG = /^[\w./\\@:+=,-]+$/;

function safeArg(kind: string, value: string): string {
	if (!SAFE_ARG.test(value) || value.startsWith('-')) {
		throw new Error(`Cannot pass the ${kind} "${value}" to the test runner safely (allowed: letters, digits and . / \\ _ - @ : + = ,). Use run_command for unusual paths.`);
	}
	return value;
}

/** A test-name filter as a shell-safe regular expression: whitespace matches any whitespace, regex characters are escaped. */
export function nameFilterRegex(names: string[]): string {
	const parts = names.map(n => n.trim()).filter(Boolean).map(n => {
		if (/[&|<>^%!"'`$;]/.test(n)) { throw new Error(`Cannot pass the test name "${n}" to the test runner safely.`); }
		return n.replace(/[.*+?()[\]{}\\]/g, ch => `\\${ch}`).replace(/\s+/g, '\\s');
	});
	return parts.join('|');
}

export type TestCommand = { command: string; reportFile?: string; parse: 'junit' | 'jest-json' | 'go-verbose' | 'cargo' | 'dotnet' };

/**
 * @param reportFile relative to the project root (no spaces), where structured reports are written
 * @param files test files relative to the project root
 */
export function buildTestCommand(fw: CommandFrameworkId, opts: { files?: string[]; names?: string[]; reportFile: string }): TestCommand {
	const files = (opts.files ?? []).map(f => safeArg('test file', f.replace(/\\/g, '/')));
	const pattern = opts.names && opts.names.length ? nameFilterRegex(opts.names) : undefined;
	if (pattern !== undefined && !/^[\w\\.|\-:/]+$/.test(pattern)) { throw new Error('Cannot build a safe test-name filter from the given names.'); }
	const report = safeArg('report file', opts.reportFile);
	const f = files.length ? ' ' + files.join(' ') : '';
	switch (fw) {
		case 'node-test': return { command: `node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=${report}${pattern ? ` --test-name-pattern=${pattern}` : ''}${f}`, reportFile: report, parse: 'junit' };
		case 'vitest': return { command: `npx --no-install vitest run --reporter=default --reporter=junit --outputFile=${report}${pattern ? ` -t ${pattern}` : ''}${f}`, reportFile: report, parse: 'junit' };
		case 'jest': return { command: `npx --no-install jest --json --outputFile=${report}${pattern ? ` -t ${pattern}` : ''}${f}`, reportFile: report, parse: 'jest-json' };
		case 'mocha': return { command: `npx --no-install mocha --reporter xunit --reporter-option output=${report}${pattern ? ` -g ${pattern}` : ''}${f}`, reportFile: report, parse: 'junit' };
		case 'pytest': return { command: `python -m pytest -q -rA --junitxml=${report}${pattern ? ` -k ${opts.names!.map(n => safeArg('test name', n.replace(/\s+/g, '_'))).join(' or ')}` : ''}${f}`, reportFile: report, parse: 'junit' };
		case 'phpunit': return { command: `php vendor/bin/phpunit --log-junit ${report}${pattern ? ` --filter ${pattern}` : ''}${f}`, reportFile: report, parse: 'junit' };
		case 'go': return { command: `go test -v -count=1${pattern ? ` -run ${pattern}` : ''} ${files.length ? files.join(' ') : './...'}`, parse: 'go-verbose' };
		case 'cargo': return { command: `cargo test${pattern ? ` ${safeArg('test name', opts.names![0])}` : ''}`, parse: 'cargo' };
		case 'dotnet': return { command: `dotnet test${pattern ? ` --filter ${safeArg('test name', opts.names![0])}` : ''}`, parse: 'dotnet' };
	}
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

const decodeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&amp;/g, '&');
const attrsOf = (s: string) => { const a: Record<string, string> = {}; for (const m of s.matchAll(/([\w:-]+)="([^"]*)"/g)) { a[m[1]] = decodeXml(m[2]); } return a; };

/** JUnit / xUnit XML (node --test junit reporter, pytest, vitest, mocha xunit, PHPUnit). */
export function parseJUnit(xml: string): TestCaseResult[] {
	const out: TestCaseResult[] = [];
	for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
		const a = attrsOf(m[1]);
		const body = m[2] ?? '';
		const name = a.name ?? '(unnamed)';
		const label = a.classname && !name.includes(a.classname) ? `${a.classname} › ${name}` : name;
		const failure = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
		const skipped = /<skipped\b/.test(body);
		let message: string | undefined;
		if (failure) {
			const fa = attrsOf(failure[2]);
			message = [fa.message, decodeXml((failure[3] ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim()].filter(Boolean).join('\n').slice(0, 4000);
		}
		const seconds = a.time !== undefined ? Number(a.time) : NaN;
		const line = a.line !== undefined ? Number(a.line) : undefined;
		out.push({
			id: `${a.classname ?? a.file ?? ''}::${name}`, label,
			state: failure ? (failure[1] === 'error' ? 'errored' : 'failed') : skipped ? 'skipped' : 'passed',
			duration: Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined,
			message, uri: a.file, line: Number.isFinite(line) ? line : undefined,
		});
	}
	return out;
}

/** `jest --json` output. */
export function parseJestJson(json: string): TestCaseResult[] {
	const data = JSON.parse(json) as { testResults?: { name: string; assertionResults?: { fullName: string; status: string; failureMessages?: string[]; duration?: number; location?: { line: number } }[]; message?: string; status?: string }[] };
	const out: TestCaseResult[] = [];
	for (const file of data.testResults ?? []) {
		const assertions = file.assertionResults ?? [];
		if (assertions.length === 0 && file.status === 'failed') { // the file itself failed (syntax error, missing import)
			out.push({ id: `${file.name}::(file)`, label: `${file.name} (could not run)`, state: 'errored', message: (file.message ?? '').slice(0, 4000), uri: file.name });
		}
		for (const t of assertions) {
			out.push({
				id: `${file.name}::${t.fullName}`, label: t.fullName,
				state: t.status === 'passed' ? 'passed' : t.status === 'failed' ? 'failed' : 'skipped',
				duration: t.duration ?? undefined, message: t.failureMessages?.join('\n').slice(0, 4000) || undefined, uri: file.name, line: t.location?.line,
			});
		}
	}
	return out;
}

/** `go test -v` output: `--- PASS: TestX (0.00s)` / `--- FAIL:` / `--- SKIP:` lines, with the failure output above them. */
export function parseGoVerbose(text: string): TestCaseResult[] {
	const out: TestCaseResult[] = [];
	const lines = text.split(/\r?\n/);
	let outputSinceRun: string[] = [];
	for (const line of lines) {
		if (/^=== RUN\s/.test(line)) { outputSinceRun = []; continue; }
		const m = /^\s*--- (PASS|FAIL|SKIP): (\S+) \(([\d.]+)s\)/.exec(line);
		if (m) {
			out.push({ id: m[2], label: m[2], state: m[1] === 'PASS' ? 'passed' : m[1] === 'FAIL' ? 'failed' : 'skipped', duration: Math.round(+m[3] * 1000), message: m[1] === 'FAIL' ? outputSinceRun.join('\n').trim().slice(0, 4000) || undefined : undefined });
			outputSinceRun = [];
		} else { outputSinceRun.push(line); }
	}
	return out;
}

/** `cargo test` output: `test path::name ... ok|FAILED|ignored`, plus the `---- name stdout ----` failure sections. */
export function parseCargo(text: string): TestCaseResult[] {
	const out: TestCaseResult[] = [];
	for (const m of text.matchAll(/^test (\S+) \.\.\. (ok|FAILED|ignored)/gm)) {
		const section = new RegExp(`---- ${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} stdout ----\\r?\\n([\\s\\S]*?)(?=\\r?\\n\\r?\\n|\\r?\\n----|$)`).exec(text);
		out.push({ id: m[1], label: m[1], state: m[2] === 'ok' ? 'passed' : m[2] === 'FAILED' ? 'failed' : 'skipped', message: m[2] === 'FAILED' ? section?.[1]?.trim().slice(0, 4000) : undefined });
	}
	return out;
}

/** `dotnet test` console output: per-test `Failed X [..]`/`Passed X [..]` lines when present, else the summary counts. */
export function parseDotnet(text: string): TestCaseResult[] {
	const out: TestCaseResult[] = [];
	for (const m of text.matchAll(/^\s*(Passed|Failed|Skipped) ([\w.<>`,]+) \[[^\]]*\]/gm)) {
		out.push({ id: m[2], label: m[2], state: m[1] === 'Passed' ? 'passed' : m[1] === 'Failed' ? 'failed' : 'skipped' });
	}
	return out;
}

/** dotnet prints only a summary unless verbose: `Failed!  - Failed: 1, Passed: 3, Skipped: 0, Total: 4`. */
export function dotnetSummary(text: string): { passed: number; failed: number; skipped: number; total: number } | undefined {
	const m = /(?:Passed|Failed)!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/.exec(text);
	return m ? { failed: +m[1], passed: +m[2], skipped: +m[3], total: +m[4] } : undefined;
}

export function summarize(runId: string, results: TestCaseResult[], extra: Partial<TestRunResultData> = {}): TestRunResultData {
	const count = (s: TestCaseResult['state']) => results.filter(r => r.state === s).length;
	return { runId, passed: count('passed'), failed: count('failed') + count('errored'), skipped: count('skipped'), errored: count('errored'), total: results.length, completed: true, testResults: results, ...extra };
}
