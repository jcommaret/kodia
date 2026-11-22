/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { CoverageSummary } from './testCoverage.js';
import type { RepeatedRunVerdict, TestHistoryAnalysis, TestHistoryRun, TestRunComparison } from './testHistory.js';

/**
 * Information about a discovered test framework/runner.
 */
export type TestFramework = {
	name: string;
	type: 'jest' | 'mocha' | 'vitest' | 'pytest' | 'go test' | 'cargo test' | 'dotnet test' | 'other';
	version?: string;
	configFile?: string;
	controllerId: string;
};

/**
 * Information about a single test file.
 */
export type TestFileInfo = {
	uri: string;
	label: string;
	testCount: number;
	framework?: string;
};

/**
 * Information about a single test case.
 */
export type TestCaseInfo = {
	id: string;
	label: string;
	uri?: string;
	line?: number;
	parentId?: string;
};

/**
 * Result for a single test case.
 */
export type TestCaseResult = {
	id: string;
	label: string;
	state: 'passed' | 'failed' | 'skipped' | 'errored';
	duration?: number;
	message?: string;
	stackTrace?: string;
	uri?: string;
	line?: number;
};

/**
 * Parameters for test_discover tool.
 */
export type TestDiscoverParams = {};

/**
 * Result for test_discover tool.
 */
export type TestDiscoverResult = {
	frameworks: TestFramework[];
};

/**
 * Parameters for test_list tool.
 */
export type TestListParams = {};

/**
 * Result for test_list tool.
 */
export type TestListResult = {
	testFiles: TestFileInfo[];
};

/**
 * Parameters for test_run tool.
 */
export type TestRunParams = {
	test_files?: string[];
	test_names?: string[];
};

/**
 * Result for test_run tool.
 */
export type TestRunResult = {
	results: TestRunResultData;
};

/**
 * Parameters for test_run_targeted tool.
 */
export type TestRunTargetedParams = {
	changed_files: string[];
};

/**
 * Result for test_run_targeted tool.
 */
export type TestRunTargetedResult = {
	results: TestRunResultData;
};

/**
 * Parameters for test_rerun_failed tool.
 */
export type TestRerunFailedParams = {};

/**
 * Result for test_rerun_failed tool.
 */
export type TestRerunFailedResult = {
	results: TestRunResultData;
};

/**
 * Parameters for test_cancel tool.
 */
export type TestCancelParams = {
	run_id?: string;
};

/**
 * Result for test_cancel tool.
 */
export type TestCancelResult = {
	cancelled: boolean;
};

/**
 * Internal result data structure shared across run tools.
 */
export type TestRunResultData = {
	runId: string;
	passed: number;
	failed: number;
	skipped: number;
	errored: number;
	total: number;
	duration?: number;
	completed: boolean;
	testResults: TestCaseResult[];
	/** where the results came from: a VS Code test controller, or the framework's own command run in the terminal */
	source?: 'vscode' | 'command';
	/** command runs: the framework and the exact command, its exit code, and the tail of its output */
	framework?: string;
	command?: string;
	exitCode?: number | null;
	outputTail?: string;
	/** why nothing (or not everything) was run or reported, in plain words — never omitted when total is 0 */
	note?: string;
	/** test_coverage runs: what the runners' coverage reports say */
	coverage?: CoverageSummary;
	/** compared with each test's previous recorded outcome (test history) */
	history?: TestRunComparison;
};

/**
 * Parameters for test_coverage tool.
 */
export type TestCoverageParams = {
	test_files?: string[];
	test_names?: string[];
	/** source files to report coverage for (e.g. the files just changed); default: every file in the report */
	files?: string[];
};

export type TestCoverageResult = {
	results: TestRunResultData;
};

/**
 * Parameters for test_history tool.
 */
export type TestHistoryParams = {
	test_name?: string;
	only_problems?: boolean;
	limit?: number;
};

export type TestHistoryResult = {
	tests: TestHistoryAnalysis[];
	matched: number;
	tracked: number;
	recentRuns: TestHistoryRun[];
	/** whether outcomes carry code fingerprints (git), which flaky detection needs */
	fingerprinted: boolean;
};

/**
 * Parameters for test_check_flaky tool.
 */
export type TestCheckFlakyParams = {
	test_files?: string[];
	test_names?: string[];
	attempts?: number;
};

export type TestCheckFlakyResult = {
	verdict: RepeatedRunVerdict;
	runs: { runId: string; passed: number; failed: number; total: number; completed: boolean }[];
	note?: string;
};

/**
 * Map of tool names to their parameter types.
 */
export type TestToolCallParams = {
	'test_discover': TestDiscoverParams;
	'test_list': TestListParams;
	'test_run': TestRunParams;
	'test_run_targeted': TestRunTargetedParams;
	'test_rerun_failed': TestRerunFailedParams;
	'test_cancel': TestCancelParams;
	'test_coverage': TestCoverageParams;
	'test_history': TestHistoryParams;
	'test_check_flaky': TestCheckFlakyParams;
};

/**
 * Map of tool names to their result types.
 */
export type TestToolResultType = {
	'test_discover': TestDiscoverResult;
	'test_list': TestListResult;
	'test_run': TestRunResult;
	'test_run_targeted': TestRunTargetedResult;
	'test_rerun_failed': TestRerunFailedResult;
	'test_cancel': TestCancelResult;
	'test_coverage': TestCoverageResult;
	'test_history': TestHistoryResult;
	'test_check_flaky': TestCheckFlakyResult;
};
