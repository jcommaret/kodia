/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 3 + 4: run ONE test under the debugger. Builds the debug launch configuration for a detected test framework
 * (arguments as an array: no shell is involved, so names need no quoting) and says which exception filter makes the
 * debugger stop where a test fails.
 *
 * - JavaScript (node --test, Jest, Mocha) runs under js-debug ("node" type). A failing assertion is an exception the
 *   test runner catches, so the filter is "all" (caught exceptions). skipFiles is set EMPTY: js-debug skips node
 *   internals by default and does not pause on an exception thrown in a skipped file, and `node:assert` (like
 *   expect/chai in node_modules) throws from inside them. Verified: with the default, a failing assert never pauses.
 * - Python (pytest) runs under debugpy. "userUnhandled" stops where an exception leaves the user's code into pytest's,
 *   which is exactly a failing assertion or an error in the test.
 * - Go (delve), Rust (lldb/CodeLLDB), .NET (vsdbg/netcoredbg) and PHP (Xdebug) need debuggers Kodia does not ship.
 */

import type { CommandFrameworkId } from './testCommandRunner.js';

export type TestDebugPlan = {
	configuration: Record<string, unknown>;
	/** exception filter ids that stop at a failing test */
	failureFilters: string[];
	/** a condition on those filters, so only a test failure stops (not the runtime's or the runner's own try/catch) */
	failureCondition?: string;
	/** what is run, for the report */
	describe: string;
};

export type TestDebugUnavailable = { unavailable: string };

const NODE_SKIP: string[] = [];

/**
 * js-debug exception-breakpoint condition (the thrown value is `error`): only assertion failures stop. With "all"
 * alone, Jest and Mocha stopped first on caught exceptions inside fs.statSync and the module loader (measured).
 * node:assert and chai throw AssertionError; Jest's expect throws an error carrying `matcherResult`.
 */
export const JS_ASSERTION_CONDITION = `error != null && (/AssertionError/.test(String(error.name)) || /AssertionError/.test(String(error.constructor && error.constructor.name)) || error.matcherResult !== undefined)`;

/**
 * @param files test files relative to `cwd`
 * @param names test names (a filter: substring/regex as the framework treats it)
 * @param hasPackage whether `node_modules/<pkg>` exists, for runners started from the project's own install
 */
export function buildTestDebugPlan(fw: CommandFrameworkId, opts: { cwd: string; files: string[]; names: string[]; hasPackage: (pkg: string) => boolean }): TestDebugPlan | TestDebugUnavailable {
	const files = opts.files.map(f => f.replace(/\\/g, '/'));
	for (const f of files) { if (f.startsWith('-')) { return { unavailable: `"${f}" looks like an option, not a test file.` }; } }
	const name = opts.names.length ? opts.names.map(n => n.trim()).filter(Boolean) : [];
	const regex = name.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, ch => `\\${ch}`)).join('|');
	const base = { request: 'launch', cwd: opts.cwd, console: 'internalConsole' };
	const what = `${files.join(' ') || 'all tests'}${name.length ? ` (${name.join(', ')})` : ''}`;

	switch (fw) {
		case 'node-test':
			return {
				configuration: { ...base, type: 'node', name: 'Kodia: debug test', runtimeArgs: ['--test', ...(regex ? [`--test-name-pattern=${regex}`] : []), ...files], skipFiles: NODE_SKIP },
				failureFilters: ['all'], failureCondition: JS_ASSERTION_CONDITION, describe: `node --test ${what}`,
			};
		case 'jest':
			if (!opts.hasPackage('jest')) { return { unavailable: 'Jest is not installed in this project (node_modules/jest); install the dependencies first.' }; }
			return {
				configuration: { ...base, type: 'node', name: 'Kodia: debug test', program: `${opts.cwd}/node_modules/jest/bin/jest.js`, args: ['--runInBand', '--watchAll=false', ...(regex ? ['-t', regex] : []), ...files], skipFiles: NODE_SKIP },
				failureFilters: ['all'], failureCondition: JS_ASSERTION_CONDITION, describe: `jest --runInBand ${what}`,
			};
		case 'mocha':
			if (!opts.hasPackage('mocha')) { return { unavailable: 'Mocha is not installed in this project (node_modules/mocha); install the dependencies first.' }; }
			return {
				configuration: { ...base, type: 'node', name: 'Kodia: debug test', program: `${opts.cwd}/node_modules/mocha/bin/mocha.js`, args: [...(regex ? ['-g', regex] : []), ...files], skipFiles: NODE_SKIP },
				failureFilters: ['all'], failureCondition: JS_ASSERTION_CONDITION, describe: `mocha ${what}`,
			};
		case 'vitest':
			return { unavailable: 'Debugging a Vitest test is not supported yet (its worker pools need a dedicated setup). Use test_run_targeted to run it, or debug_start_session with your own configuration.' };
		case 'pytest':
			return {
				configuration: { ...base, type: 'debugpy', name: 'Kodia: debug test', module: 'pytest', args: ['-q', '-p', 'no:cacheprovider', ...(name.length ? ['-k', name.map(n => n.replace(/\s+/g, '_')).join(' or ')] : []), ...files], justMyCode: true },
				failureFilters: ['userUnhandled'], describe: `pytest ${what}`,
			};
		case 'go': return { unavailable: 'Debugging Go tests needs Delve (dlv), which Kodia does not ship.' };
		case 'cargo': return { unavailable: 'Debugging Rust tests needs an LLDB adapter (e.g. CodeLLDB), which Kodia does not ship.' };
		case 'dotnet': return { unavailable: 'Debugging .NET tests needs a .NET debug adapter (vsdbg or netcoredbg), which Kodia does not ship.' };
		case 'phpunit': return { unavailable: 'Debugging PHPUnit tests needs Xdebug and a PHP debug adapter, which Kodia does not ship.' };
	}
}
