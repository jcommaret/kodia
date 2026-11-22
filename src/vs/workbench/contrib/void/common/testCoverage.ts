/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Test coverage (roadmap 3): the coverage command for each framework and parsers for the reports they write (lcov,
 * Go cover profiles). Pure logic; the test tool service runs the commands.
 *
 * Coverage comes only from the runner's own report. Frameworks that need a plugin that is not installed (pytest-cov,
 * @vitest/coverage-v8, c8 for mocha) fail with the runner's own error, which is reported as such; frameworks with no
 * coverage support here say so before anything runs.
 */

import { buildTestCommand, CommandFrameworkId, TestCommand } from './testCommandRunner.js';

export type FileCoverage = {
	/** relative to the project root, forward slashes */
	file: string;
	linesFound: number;
	linesHit: number;
	/** line numbers with no hits, ascending */
	uncoveredLines: number[];
	branchesFound?: number;
	branchesHit?: number;
	functionsFound?: number;
	functionsHit?: number;
};

export type CoverageSummary = {
	linesFound: number;
	linesHit: number;
	/** 0–100, one decimal; undefined when there are no measurable lines */
	linePercent?: number;
	branchesFound: number;
	branchesHit: number;
	branchPercent?: number;
	files: (FileCoverage & { linePercent?: number; uncoveredRanges: string })[];
	/** files asked about that the report does not mention (never loaded by any test) */
	notInReport: string[];
};

export type CoverageCommand = TestCommand & { coverageFile: string; coverageFormat: 'lcov' | 'go-profile' };

const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** Makes a report path relative to the project root when it is inside it. */
export function relativeToRoot(file: string, root: string): string {
	const f = normalize(file), r = normalize(root).replace(/\/+$/, '');
	return f.toLowerCase().startsWith(r.toLowerCase() + '/') ? f.slice(r.length + 1) : f;
}

/**
 * The coverage variant of each framework's test command, or the reason coverage is not available for it.
 * @param coverageDir relative to the project root (no spaces); reports are written there
 */
export function buildCoverageCommand(fw: CommandFrameworkId, opts: { files?: string[]; names?: string[]; reportFile: string; coverageDir: string; hasC8?: boolean }): CoverageCommand | { unavailable: string } {
	const base = buildTestCommand(fw, opts);
	const dir = opts.coverageDir.replace(/\\/g, '/');
	if (!/^[\w./-]+$/.test(dir)) { throw new Error(`Unsafe coverage directory: ${dir}`); }
	switch (fw) {
		case 'node-test': {
			const lcov = `${dir}/lcov.info`;
			return { ...base, command: base.command.replace(/^node --test /, `node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=${lcov} `), coverageFile: lcov, coverageFormat: 'lcov' };
		}
		case 'jest':
			return { ...base, command: `${base.command} --coverage --coverageReporters=lcov --coverageDirectory=${dir}`, coverageFile: `${dir}/lcov.info`, coverageFormat: 'lcov' };
		case 'vitest':
			return { ...base, command: `${base.command} --coverage.enabled=true --coverage.reporter=lcov --coverage.reportsDirectory=${dir}`, coverageFile: `${dir}/lcov.info`, coverageFormat: 'lcov' };
		case 'mocha':
			if (!opts.hasC8) { return { unavailable: 'Mocha has no built-in coverage. Install c8 (npm i -D c8) and run test_coverage again.' }; }
			return { ...base, command: base.command.replace(/^npx --no-install mocha /, `npx --no-install c8 --reporter=lcov --report-dir=${dir} mocha `), coverageFile: `${dir}/lcov.info`, coverageFormat: 'lcov' };
		case 'pytest': {
			const lcov = `${dir}/lcov.info`;
			return { ...base, command: base.command.replace(/^python -m pytest /, `python -m pytest --cov=. --cov-report=lcov:${lcov} `), coverageFile: lcov, coverageFormat: 'lcov' };
		}
		case 'go': {
			const profile = `${dir}/cover.out`;
			return { ...base, command: base.command.replace(/^go test /, `go test -coverprofile=${profile} `), coverageFile: profile, coverageFormat: 'go-profile' };
		}
		case 'cargo': return { unavailable: 'cargo test has no built-in coverage; it needs cargo-llvm-cov or cargo-tarpaulin, which Kodia does not drive yet.' };
		case 'dotnet': return { unavailable: 'dotnet coverage needs the coverlet collector and a Cobertura parser, which Kodia does not have yet.' };
		case 'phpunit': return { unavailable: 'PHPUnit coverage needs Xdebug or PCOV and a Clover parser, which Kodia does not have yet.' };
	}
}

/** The runner's error when a coverage plugin is missing, in plain words; undefined when the output shows none. */
export function missingCoveragePlugin(fw: CommandFrameworkId, output: string): string | undefined {
	if (fw === 'pytest' && /unrecognized arguments: --cov|no module named 'pytest_cov'/i.test(output)) { return 'pytest-cov is not installed (pip install pytest-cov).'; }
	if (fw === 'vitest' && /@vitest\/coverage-(v8|istanbul)/.test(output)) { return '@vitest/coverage-v8 is not installed (npm i -D @vitest/coverage-v8).'; }
	if (fw === 'mocha' && /could not determine executable to run|c8: (command )?not found/i.test(output)) { return 'c8 is not installed (npm i -D c8).'; }
	return undefined;
}

/** lcov tracefile (Node's lcov reporter, Jest, Vitest, c8, pytest-cov). */
export function parseLcov(text: string, root: string): FileCoverage[] {
	const out: FileCoverage[] = [];
	let cur: (FileCoverage & { lines: Map<number, number>; lf?: number; lh?: number }) | undefined;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith('SF:')) {
			cur = { file: relativeToRoot(line.slice(3), root), linesFound: 0, linesHit: 0, uncoveredLines: [], lines: new Map() };
		} else if (!cur) {
			continue;
		} else if (line.startsWith('DA:')) {
			const [ln, hits] = line.slice(3).split(',');
			const n = Number(ln), h = Number(hits);
			if (Number.isFinite(n) && Number.isFinite(h)) { cur.lines.set(n, Math.max(cur.lines.get(n) ?? 0, h)); }
		} else if (line.startsWith('LF:')) { cur.lf = Number(line.slice(3)); }
		else if (line.startsWith('LH:')) { cur.lh = Number(line.slice(3)); }
		else if (line.startsWith('BRF:')) { cur.branchesFound = Number(line.slice(4)); }
		else if (line.startsWith('BRH:')) { cur.branchesHit = Number(line.slice(4)); }
		else if (line.startsWith('FNF:')) { cur.functionsFound = Number(line.slice(4)); }
		else if (line.startsWith('FNH:')) { cur.functionsHit = Number(line.slice(4)); }
		else if (line === 'end_of_record') {
			const { lines, lf, lh, ...fc } = cur;
			fc.linesFound = lines.size ? lines.size : (Number.isFinite(lf) ? lf! : 0);
			fc.linesHit = lines.size ? [...lines.values()].filter(h => h > 0).length : (Number.isFinite(lh) ? lh! : 0);
			fc.uncoveredLines = [...lines].filter(([, h]) => h === 0).map(([n]) => n).sort((a, b) => a - b);
			mergeInto(out, fc);
			cur = undefined;
		}
	}
	return out;
}

/** Go cover profile: `mode: set`, then `file.go:startLine.startCol,endLine.endCol numStatements count` per block. */
export function parseGoCoverProfile(text: string, root: string, modulePath?: string): FileCoverage[] {
	const byFile = new Map<string, { stmts: number; hit: number; lines: Map<number, number> }>();
	for (const line of text.split(/\r?\n/)) {
		const m = /^(.+):(\d+)\.\d+,(\d+)\.\d+ (\d+) (\d+)$/.exec(line.trim());
		if (!m) { continue; }
		let file = m[1];
		if (modulePath && file.startsWith(modulePath + '/')) { file = file.slice(modulePath.length + 1); }
		const e = byFile.get(file) ?? { stmts: 0, hit: 0, lines: new Map<number, number>() };
		const stmts = Number(m[4]), count = Number(m[5]);
		e.stmts += stmts;
		if (count > 0) { e.hit += stmts; }
		for (let l = Number(m[2]); l <= Number(m[3]); l++) { e.lines.set(l, Math.max(e.lines.get(l) ?? 0, count)); }
		byFile.set(file, e);
	}
	return [...byFile].map(([file, e]) => ({
		file: relativeToRoot(file, root), linesFound: e.stmts, linesHit: e.hit,
		uncoveredLines: [...e.lines].filter(([, c]) => c === 0).map(([n]) => n).sort((a, b) => a - b),
	}));
}

/** Two frameworks (or a report listing a file twice) can both cover a file: a line is hit if any report hit it. */
function mergeInto(list: FileCoverage[], fc: FileCoverage): void {
	const existing = list.find(f => f.file === fc.file);
	if (!existing) { list.push(fc); return; }
	const uncovered = new Set(existing.uncoveredLines.filter(l => fc.uncoveredLines.includes(l)));
	existing.linesFound = Math.max(existing.linesFound, fc.linesFound);
	existing.linesHit = Math.max(existing.linesHit, fc.linesHit, existing.linesFound - uncovered.size);
	existing.uncoveredLines = [...uncovered].sort((a, b) => a - b);
}

export function mergeCoverage(lists: FileCoverage[][]): FileCoverage[] {
	const out: FileCoverage[] = [];
	for (const l of lists) { for (const f of l) { mergeInto(out, { ...f, uncoveredLines: [...f.uncoveredLines] }); } }
	return out;
}

/** `[3,4,5,9,11,12]` → `"3-5, 9, 11-12"` */
export function lineRanges(lines: number[], max = 40): string {
	const parts: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		let j = i;
		while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) { j++; }
		parts.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`);
		i = j;
	}
	return parts.length > max ? `${parts.slice(0, max).join(', ')}, … (${parts.length - max} more ranges)` : parts.join(', ');
}

const pct = (hit: number, found: number) => found > 0 ? Math.round((hit / found) * 1000) / 10 : undefined;

/**
 * @param focus files to report on (e.g. the files just changed), relative to the root; empty = every file in the report
 */
export function summarizeCoverage(files: FileCoverage[], focus: string[] = []): CoverageSummary {
	const wanted = focus.map(normalize);
	const selected = wanted.length ? files.filter(f => wanted.some(w => w.toLowerCase() === f.file.toLowerCase())) : files;
	const notInReport = wanted.filter(w => !files.some(f => f.file.toLowerCase() === w.toLowerCase()));
	const linesFound = selected.reduce((a, f) => a + f.linesFound, 0), linesHit = selected.reduce((a, f) => a + f.linesHit, 0);
	const branchesFound = selected.reduce((a, f) => a + (f.branchesFound ?? 0), 0), branchesHit = selected.reduce((a, f) => a + (f.branchesHit ?? 0), 0);
	return {
		linesFound, linesHit, linePercent: pct(linesHit, linesFound),
		branchesFound, branchesHit, branchPercent: pct(branchesHit, branchesFound),
		files: selected
			.map(f => ({ ...f, linePercent: pct(f.linesHit, f.linesFound), uncoveredRanges: lineRanges(f.uncoveredLines) }))
			.sort((a, b) => (a.linePercent ?? 100) - (b.linePercent ?? 100) || a.file.localeCompare(b.file)),
		notInReport,
	};
}
