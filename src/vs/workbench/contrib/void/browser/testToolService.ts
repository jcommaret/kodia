/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Test discovery and execution for the agent (roadmap 3).
 *
 * Two sources, never mixed within one run:
 * - VS Code test controllers (Testing API), when a test extension exposes the workspace's tests.
 * - Otherwise the framework's own command, detected from project files and run through Kodia's terminal service
 *   (visible, like run_command), with results read from the runner's machine-readable report (JUnit XML, Jest JSON)
 *   or its verbose output. See common/testCommandRunner.ts.
 *
 * Results are only what a runner reported. A run that found nothing, timed out or crashed says so in `note`; the
 * previous run's results are never returned as the current one's.
 *
 * Replaces an implementation that (a) could not be constructed by DI (no service decorators: its constructor threw on
 * `undefined.onResultsChanged`), (b) returned the *previous* run's results when a run timed out, (c) counted
 * queued/running tests as failed, (d) only saw tests exposed by a VS Code test extension.
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Position } from '../../../../editor/common/core/position.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	TestDiscoverResult, TestListResult, TestRunResult, TestRunParams, TestRunTargetedResult, TestRunTargetedParams,
	TestRerunFailedResult, TestRerunFailedParams, TestCancelResult, TestCancelParams, TestFramework, TestFileInfo,
	TestCaseResult, TestRunResultData,
} from '../common/testServiceTypes.js';
import { ITestService, IMainThreadTestController } from '../../testing/common/testService.js';
import { TestResultState, TestRunProfileBitset, IncrementalTestCollectionItem } from '../../testing/common/testTypes.js';
import { ITestResult } from '../../testing/common/testResult.js';
import { ITestResultService } from '../../testing/common/testResultService.js';
import { ITerminalToolService } from './terminalToolService.js';
import { wrapCommandForShell } from '../common/terminalUtils.js';
import { isTestFileName, testFileStrength } from '../common/testIntegrity.js';
import {
	buildTestCommand, CommandFrameworkId, DetectedFramework, detectTestFrameworks, dotnetSummary, parseCargo, parseDotnet,
	parseGoVerbose, parseJestJson, parseJUnit, summarize,
} from '../common/testCommandRunner.js';

export const ITestToolService = createDecorator<ITestToolService>('TestToolService');

export interface ITestToolService {
	readonly _serviceBrand: undefined;
	discoverFrameworks(): Promise<TestDiscoverResult>;
	listTests(): Promise<TestListResult>;
	runTests(params: TestRunParams): Promise<TestRunResult>;
	runTargetedTests(params: TestRunTargetedParams): Promise<TestRunTargetedResult>;
	rerunFailedTests(params: TestRerunFailedParams): Promise<TestRerunFailedResult>;
	cancelTestRun(params: TestCancelParams): Promise<TestCancelResult>;
	getTestRunStatus(runId: string): TestRunResultData | null;
	isTestRunRunning(): boolean;
	readonly onTestRunStart: Event<{ runId: string }>;
	readonly onTestRunComplete: Event<{ runId: string; results: TestRunResultData }>;
	getLastResults(): TestRunResultData | null;
}

const VSCODE_RUN_TIMEOUT_MS = 10 * 60_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.venv', 'venv', 'env', '__pycache__', '.pytest_cache', 'target', 'bin', 'obj', 'vendor', '.kodia', '.next', '.nuxt']);
const SOURCE_EXT: Record<CommandFrameworkId, RegExp> = {
	'node-test': /\.[cm]?[jt]sx?$/, jest: /\.[cm]?[jt]sx?$/, vitest: /\.[cm]?[jt]sx?$/, mocha: /\.[cm]?[jt]sx?$/,
	pytest: /\.py$/, go: /\.go$/, cargo: /\.rs$/, dotnet: /\.(cs|fs|vb)$/, phpunit: /\.php$/,
};

type CommandRunScope = { framework: CommandFrameworkId; files: string[]; names: string[] };

export class TestToolService extends Disposable implements ITestToolService {
	readonly _serviceBrand: undefined;

	private lastResults: TestRunResultData | null = null;
	/** for rerunFailedTests on the command path: the failed tests' names and files, per framework */
	private lastCommandScopes: CommandRunScope[] = [];
	private readonly runningVsCodeRuns = new Map<string, { waiter: DeferredPromise<TestRunResultData>; started: number }>();
	private readonly runningCommandRuns = new Map<string, () => void>();

	private readonly _onTestRunStart = this._register(new Emitter<{ runId: string }>());
	readonly onTestRunStart = this._onTestRunStart.event;
	private readonly _onTestRunComplete = this._register(new Emitter<{ runId: string; results: TestRunResultData }>());
	readonly onTestRunComplete = this._onTestRunComplete.event;

	constructor(
		@ITestService private readonly testService: ITestService,
		@ITestResultService private readonly testResultService: ITestResultService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		this._register(testResultService.onResultsChanged(ev => {
			if ('completed' in ev) {
				const run = this.runningVsCodeRuns.get(ev.completed.id);
				if (run) {
					this.runningVsCodeRuns.delete(ev.completed.id);
					run.waiter.complete(this.vscodeResultToData(ev.completed, run.started));
				}
			}
		}));
	}

	// ---------------------------------------------------------------- discovery

	async discoverFrameworks(): Promise<TestDiscoverResult> {
		const frameworks: TestFramework[] = this.vscodeControllers().map(ctrl => ({ name: ctrl.label.get(), type: inferFrameworkType(ctrl.label.get()), controllerId: ctrl.id }));
		const root = this.workspaceRoot();
		if (root) {
			for (const fw of await detectTestFrameworks(await this.probe(root))) {
				frameworks.push({ name: fw.name, type: fw.type, controllerId: `command:${fw.id}`, configFile: fw.evidence });
			}
		}
		return { frameworks };
	}

	async listTests(): Promise<TestListResult> {
		const fromVsCode = await this.vscodeTestFiles();
		if (fromVsCode.length > 0) { return { testFiles: fromVsCode }; }
		const root = this.workspaceRoot();
		if (!root) { return { testFiles: [] }; }
		const probe = await this.probe(root);
		const testFiles: TestFileInfo[] = [];
		for (const rel of probe.testFiles) {
			const text = await probe.readText(rel);
			testFiles.push({ uri: URI.joinPath(root, rel).fsPath, label: rel, testCount: text === undefined ? 0 : testFileStrength(text, rel).cases });
		}
		return { testFiles };
	}

	// ---------------------------------------------------------------- execution

	async runTests(params: TestRunParams): Promise<TestRunResult> {
		if (await this.hasVsCodeTests()) {
			const tests = await this.resolveVsCodeTests(params.test_files, params.test_names);
			return { results: tests.length ? await this.runVsCode(tests) : this.empty('vscode', 'The test controllers found no tests matching the given files/names.') };
		}
		return { results: await this.runCommand({ files: params.test_files, names: params.test_names }) };
	}

	async runTargetedTests(params: TestRunTargetedParams): Promise<TestRunTargetedResult> {
		if (await this.hasVsCodeTests()) {
			const tests: IncrementalTestCollectionItem[] = [];
			for (const changed of params.changed_files) {
				for (const t of await this.testService.getTestsRelatedToCode(URI.file(changed), new Position(1, 1), CancellationToken.None)) {
					const item = t as IncrementalTestCollectionItem;
					if (!tests.some(x => x.item.extId === item.item.extId)) { tests.push(item); }
				}
			}
			return { results: tests.length ? await this.runVsCode(tests) : this.empty('vscode', 'No tests are related to the changed files.') };
		}
		const root = this.workspaceRoot();
		if (!root) { return { results: this.empty('command', 'No workspace folder is open.') }; }
		const probe = await this.probe(root);
		const related = new Set<string>();
		for (const changed of params.changed_files) {
			const rel = this.relative(root, changed);
			if (isTestFileName(rel)) { related.add(rel); continue; }
			const stem = (rel.split('/').pop() ?? rel).replace(/\.[^.]+$/, '');
			for (const testFile of probe.testFiles) {
				if ((testFile.split('/').pop() ?? '').startsWith(stem + '.') || (testFile.split('/').pop() ?? '').includes(stem) || (await probe.readText(testFile) ?? '').includes(stem)) { related.add(testFile); }
			}
		}
		if (related.size === 0) {
			const all = await this.runCommand({});
			all.note = `No test file references the changed files (${params.changed_files.join(', ')}), so the whole suite was run.${all.note ? ' ' + all.note : ''}`;
			return { results: all };
		}
		return { results: await this.runCommand({ files: [...related] }) };
	}

	async rerunFailedTests(_params: TestRerunFailedParams): Promise<TestRerunFailedResult> {
		const last = this.lastResults;
		if (!last) { return { results: this.empty(undefined, 'No test run has happened yet in this session, so there is nothing to rerun.') }; }
		if (last.failed === 0) { return { results: this.empty(last.source, 'The last test run had no failures.') }; }
		if (last.source === 'vscode') {
			const tests = last.testResults.filter(r => r.state === 'failed' || r.state === 'errored').map(r => this.testService.collection.getNodeById(r.id)).filter((t): t is IncrementalTestCollectionItem => !!t);
			return { results: tests.length ? await this.runVsCode(tests) : this.empty('vscode', 'The failed tests are no longer known to the test controllers.') };
		}
		return { results: await this.runCommand({ scopes: this.lastCommandScopes }) };
	}

	async cancelTestRun(params: TestCancelParams): Promise<TestCancelResult> {
		if (params.run_id && this.runningCommandRuns.has(params.run_id)) { this.runningCommandRuns.get(params.run_id)!(); return { cancelled: true }; }
		if (params.run_id && this.runningVsCodeRuns.has(params.run_id)) { this.testService.cancelTestRun(params.run_id); return { cancelled: true }; }
		if (!params.run_id) {
			let any = false;
			for (const cancel of this.runningCommandRuns.values()) { cancel(); any = true; }
			for (const id of this.runningVsCodeRuns.keys()) { this.testService.cancelTestRun(id); any = true; }
			return { cancelled: any };
		}
		return { cancelled: false };
	}

	getLastResults(): TestRunResultData | null { return this.lastResults; }
	getTestRunStatus(runId: string): TestRunResultData | null {
		if (this.lastResults?.runId === runId) { return this.lastResults; }
		const r = this.testResultService.getResult(runId);
		return r ? this.vscodeResultToData(r, this.runningVsCodeRuns.get(runId)?.started) : null;
	}
	isTestRunRunning(): boolean { return this.runningVsCodeRuns.size > 0 || this.runningCommandRuns.size > 0; }

	// ---------------------------------------------------------------- command path

	private async runCommand(opts: { files?: string[]; names?: string[]; scopes?: CommandRunScope[] }): Promise<TestRunResultData> {
		const root = this.workspaceRoot();
		if (!root) { return this.empty('command', 'No workspace folder is open.'); }
		const runId = generateUuid();
		let scopes = opts.scopes;
		if (!scopes) {
			const frameworks = await detectTestFrameworks(await this.probe(root));
			if (frameworks.length === 0) {
				return this.finish(this.empty('command', 'No test framework was detected (looked for: jest/vitest/mocha or `node --test` in package.json, files importing node:test, pytest config or test_*.py, go.mod, Cargo.toml, a .sln/.csproj, phpunit.xml) and no VS Code test extension exposes tests. Run the project\'s test command with run_command instead.'));
			}
			const files = (opts.files ?? []).map(f => this.relative(root, f));
			scopes = frameworks.map((fw: DetectedFramework) => ({ framework: fw.id, files: files.filter(f => SOURCE_EXT[fw.id].test(f)), names: opts.names ?? [] }))
				// when files were given, only the frameworks that own one of them run
				.filter(s => files.length === 0 || s.files.length > 0);
			if (scopes.length === 0) { return this.finish(this.empty('command', `None of the detected frameworks (${frameworks.map(f => f.name).join(', ')}) handles the given files: ${files.join(', ')}.`)); }
		}

		this._onTestRunStart.fire({ runId });
		const results: TestCaseResult[] = [];
		const notes: string[] = [];
		const commands: string[] = [];
		const tails: string[] = [];
		let exitCode: number | null = 0;
		let completed = true;
		let cancelled = false;
		this.runningCommandRuns.set(runId, () => { cancelled = true; });
		const started = Date.now();
		try {
			for (const scope of scopes) {
				if (cancelled) { break; }
				const reportFile = `.kodia/test-results/${runId.slice(0, 8)}-${scope.framework}.${scope.framework === 'jest' ? 'json' : 'xml'}`;
				const cmd = buildTestCommand(scope.framework, { files: scope.files, names: scope.names, reportFile });
				commands.push(cmd.command);
				const reportUri = cmd.reportFile ? URI.joinPath(root, cmd.reportFile) : undefined;
				if (reportUri) { await this.fileService.createFolder(URI.joinPath(reportUri, '..')).catch(() => { }); await this.fileService.del(reportUri).catch(() => { }); }

				const { resPromise, interrupt } = await this.terminalToolService.runCommand(wrapCommandForShell(cmd.command), { type: 'temporary', cwd: root.fsPath, terminalId: `kodia-test-${runId}-${scope.framework}` });
				this.runningCommandRuns.set(runId, () => { cancelled = true; interrupt(); });
				const res = await resPromise;
				const output = res.result ?? '';
				tails.push(output.slice(-3000));
				const code = res.resolveReason.type === 'done' ? res.resolveReason.exitCode : null;
				if (res.resolveReason.type !== 'done') { completed = false; notes.push(`${scope.framework}: the run was stopped before it finished (inactivity/timeout).`); }
				if (code !== 0) { exitCode = code; }

				let parsed: TestCaseResult[] = [];
				try {
					if (cmd.parse === 'junit' || cmd.parse === 'jest-json') {
						const report = reportUri ? await this.readText(reportUri) : undefined;
						if (report !== undefined) { parsed = cmd.parse === 'junit' ? parseJUnit(report) : parseJestJson(report); }
						else { notes.push(`${scope.framework}: the runner wrote no report file.`); }
					} else if (cmd.parse === 'go-verbose') { parsed = parseGoVerbose(output); }
					else if (cmd.parse === 'cargo') { parsed = parseCargo(output); }
					else {
						parsed = parseDotnet(output);
						const s = parsed.length === 0 ? dotnetSummary(output) : undefined;
						if (s) { notes.push(`dotnet reported only totals: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped (${s.total}); per-test details need a verbose logger.`); }
					}
				} catch (e) { notes.push(`${scope.framework}: could not read the runner's report (${e instanceof Error ? e.message : String(e)}).`); }
				finally { if (reportUri) { await this.fileService.del(reportUri).catch(() => { }); } }

				if (parsed.length === 0 && code !== 0 && code !== null) {
					// the runner itself failed (missing tool, syntax error, bad config): an error, not "0 tests passed"
					parsed = [{ id: `${scope.framework}::(runner)`, label: `${scope.framework} could not run the tests`, state: 'errored', message: output.trim().slice(-3000) || `exit code ${code}` }];
				}
				if (parsed.length === 0 && code === 0) { notes.push(`${scope.framework}: the runner exited successfully but reported no tests.`); }
				results.push(...parsed);
			}
		} finally {
			this.runningCommandRuns.delete(runId);
		}
		if (cancelled) { completed = false; notes.push('The run was cancelled.'); }

		const data = summarize(runId, results, { source: 'command', completed, duration: Date.now() - started, framework: scopes.map(s => s.framework).join(', '), command: commands.join(' && '), exitCode, outputTail: tails.join('\n').slice(-3000), note: notes.join(' ') || undefined });
		this.lastCommandScopes = scopes.map(s => {
			const failed = results.filter(r => (r.state === 'failed' || r.state === 'errored') && !r.id.endsWith('::(runner)'));
			return { framework: s.framework, files: [...new Set(failed.map(r => r.uri).filter((u): u is string => !!u).map(u => this.relative(root, u)).filter(f => SOURCE_EXT[s.framework].test(f)))], names: [...new Set(failed.map(r => r.label.split(' › ').pop()!))] };
		}).filter(s => s.names.length > 0);
		return this.finish(data);
	}

	private finish(data: TestRunResultData): TestRunResultData {
		this.lastResults = data;
		this._onTestRunComplete.fire({ runId: data.runId, results: data });
		return data;
	}

	// ---------------------------------------------------------------- VS Code Testing API path

	private vscodeControllers(): IMainThreadTestController[] {
		const controllers: IMainThreadTestController[] = [];
		for (const item of this.testService.collection.all) {
			const ctrl = this.testService.getTestController(item.controllerId);
			if (ctrl && !controllers.includes(ctrl)) { controllers.push(ctrl); }
		}
		return controllers;
	}

	private async hasVsCodeTests(): Promise<boolean> {
		await this.testService.refreshTests();
		for (const item of this.testService.collection.all) { if (item.item.uri) { return true; } }
		return false;
	}

	private async vscodeTestFiles(): Promise<TestFileInfo[]> {
		if (!(await this.hasVsCodeTests())) { return []; }
		const byFile = new Map<string, TestFileInfo>();
		for (const item of this.testService.collection.all) {
			if (!item.item.uri || item.children.size > 0) { continue; } // count leaf tests only
			const key = item.item.uri.fsPath;
			const e = byFile.get(key) ?? { uri: key, label: key.split(/[\\/]/).pop() ?? key, testCount: 0, framework: inferFrameworkType(item.controllerId) };
			e.testCount++;
			byFile.set(key, e);
		}
		return [...byFile.values()].sort((a, b) => a.label.localeCompare(b.label));
	}

	private async resolveVsCodeTests(files?: string[], names?: string[]): Promise<IncrementalTestCollectionItem[]> {
		let tests = [...this.testService.collection.all];
		if (files && files.length) {
			const wanted = new Set(files.map(f => URI.file(f).fsPath.toLowerCase()));
			tests = tests.filter(t => t.item.uri && wanted.has(t.item.uri.fsPath.toLowerCase()));
		}
		if (names && names.length) {
			const n = names.map(x => x.toLowerCase().trim());
			tests = tests.filter(t => n.some(x => t.item.label.toLowerCase().includes(x)));
		} else if (!files || !files.length) {
			tests = [...this.testService.collection.rootItems]; // the roots run everything beneath them
		}
		return tests;
	}

	private async runVsCode(tests: IncrementalTestCollectionItem[]): Promise<TestRunResultData> {
		const started = Date.now();
		const result = await this.testService.runTests({ group: TestRunProfileBitset.Run, tests, preserveFocus: true }, CancellationToken.None);
		this._onTestRunStart.fire({ runId: result.id });
		if (result.completedAt !== undefined) { return this.finish(this.vscodeResultToData(result, started)); }
		const waiter = new DeferredPromise<TestRunResultData>();
		this.runningVsCodeRuns.set(result.id, { waiter, started });
		const timer = setTimeout(() => {
			if (waiter.isSettled) { return; }
			this.runningVsCodeRuns.delete(result.id);
			// the run's own partial results, marked incomplete — never another run's results
			const partial = this.vscodeResultToData(result, started);
			partial.completed = false;
			partial.note = `The test run did not finish within ${VSCODE_RUN_TIMEOUT_MS / 60_000} minutes; these are its partial results.`;
			waiter.complete(partial);
		}, VSCODE_RUN_TIMEOUT_MS);
		const data = await waiter.p;
		clearTimeout(timer);
		return this.finish(data);
	}

	private vscodeResultToData(result: ITestResult, startTime: number | undefined): TestRunResultData {
		const testResults: TestCaseResult[] = [];
		let notFinished = 0;
		const isFinal = (s: TestResultState) => s === TestResultState.Passed || s === TestResultState.Failed || s === TestResultState.Errored || s === TestResultState.Skipped;
		for (const test of result.tests) {
			const state = test.ownComputedState;
			if (!isFinal(state)) {
				// a suite/file node has no state of its own but a final state rolled up from its children: not a test
				if (!isFinal(test.computedState)) { notFinished++; }
				continue;
			}
			const messages: string[] = [];
			let stackTrace: string | undefined, uri: string | undefined, line: number | undefined;
			for (const task of test.tasks) {
				for (const msg of task.messages) {
					if (msg.type !== 0) { continue; }
					messages.push(typeof msg.message === 'string' ? msg.message : msg.message.value);
					if (msg.stackTrace) { stackTrace = msg.stackTrace.map(f => f.label).join('\n'); }
					if (msg.location) { uri = msg.location.uri.fsPath; line = msg.location.range.startLineNumber; }
				}
			}
			testResults.push({
				id: test.item.extId, label: test.item.label,
				state: state === TestResultState.Passed ? 'passed' : state === TestResultState.Failed ? 'failed' : state === TestResultState.Errored ? 'errored' : 'skipped',
				duration: test.ownDuration, message: messages.length ? messages.join('\n') : undefined, stackTrace, uri: uri ?? test.item.uri?.fsPath, line,
			});
		}
		return summarize(result.id, testResults, {
			source: 'vscode', completed: result.completedAt !== undefined, duration: result.completedAt && startTime !== undefined ? result.completedAt - startTime : undefined,
			note: notFinished ? `${notFinished} test(s) never reached a final state (not run, queued or still running) and are not counted.` : undefined,
		});
	}

	// ---------------------------------------------------------------- helpers

	private empty(source: TestRunResultData['source'], note: string): TestRunResultData {
		return { runId: generateUuid(), passed: 0, failed: 0, skipped: 0, errored: 0, total: 0, completed: true, testResults: [], source, note };
	}

	private workspaceRoot(): URI | undefined { return this.workspaceContextService.getWorkspace().folders[0]?.uri; }

	private relative(root: URI, file: string): string {
		const abs = URI.file(file).fsPath, base = root.fsPath;
		const rel = abs.toLowerCase().startsWith(base.toLowerCase()) ? abs.slice(base.length).replace(/^[\\/]+/, '') : file;
		return rel.replace(/\\/g, '/');
	}

	private async readText(uri: URI): Promise<string | undefined> {
		try { return (await this.fileService.readFile(uri)).value.toString(); } catch { return undefined; }
	}

	/** A bounded view of the project for framework detection and test-file listing. */
	private async probe(root: URI) {
		const testFiles: string[] = [];
		const rootFiles: string[] = [];
		let budget = 5000;
		const walk = async (dir: URI, rel: string, depth: number) => {
			if (depth > 6 || budget <= 0) { return; }
			let stat;
			try { stat = await this.fileService.resolve(dir); } catch { return; }
			for (const child of stat.children ?? []) {
				if (--budget <= 0) { return; }
				const childRel = rel ? `${rel}/${child.name}` : child.name;
				if (child.isDirectory) { if (!SKIP_DIRS.has(child.name) && !child.name.startsWith('.')) { await walk(child.resource, childRel, depth + 1); } }
				else {
					if (!rel) { rootFiles.push(child.name); }
					if (isTestFileName(childRel)) { testFiles.push(childRel); }
				}
			}
		};
		await walk(root, '', 0);
		testFiles.sort();
		return {
			testFiles, rootFiles,
			readText: (relPath: string) => this.readText(URI.joinPath(root, relPath)),
			exists: async (relPath: string) => { try { return await this.fileService.exists(URI.joinPath(root, relPath)); } catch { return false; } },
		};
	}
}

function inferFrameworkType(label: string): TestFramework['type'] {
	const l = label.toLowerCase();
	if (l.includes('jest')) { return 'jest'; }
	if (l.includes('mocha')) { return 'mocha'; }
	if (l.includes('vitest')) { return 'vitest'; }
	if (l.includes('pytest') || l.includes('python')) { return 'pytest'; }
	if (l.includes('go')) { return 'go test'; }
	if (l.includes('cargo') || l.includes('rust')) { return 'cargo test'; }
	if (l.includes('dotnet') || l.includes('.net')) { return 'dotnet test'; }
	return 'other';
}

registerSingleton(ITestToolService, TestToolService, InstantiationType.Delayed);
