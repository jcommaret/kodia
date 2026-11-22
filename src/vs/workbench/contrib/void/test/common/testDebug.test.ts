/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { buildTestDebugPlan, JS_ASSERTION_CONDITION, TestDebugPlan, TestDebugUnavailable } from '../../common/testDebug.js';

const plan = (r: TestDebugPlan | TestDebugUnavailable): TestDebugPlan => { assert.ok(!('unavailable' in r), JSON.stringify(r)); return r as TestDebugPlan; };

suite('Kodia - debug-a-test plans (roadmap 3 + 4)', () => {
	const none = () => false;

	test('node --test: arguments as an array (no shell), the name as an escaped pattern, internals not skipped', () => {
		const p = plan(buildTestDebugPlan('node-test', { cwd: '/p', files: ['test\\a.test.mjs'], names: ['adds (a+b) & "more"'], hasPackage: none }));
		assert.deepStrictEqual(p.configuration.runtimeArgs, ['--test', '--test-name-pattern=adds \\(a\\+b\\) & "more"', 'test/a.test.mjs']);
		assert.deepStrictEqual(p.configuration.skipFiles, [], 'a skipped node:assert would never pause on the failure');
		assert.deepStrictEqual([p.configuration.type, p.failureFilters, p.failureCondition], ['node', ['all'], JS_ASSERTION_CONDITION], 'only assertion failures stop, not the runtime\'s own try/catch');
		const condition = new Function('error', `return ${JS_ASSERTION_CONDITION};`) as (e: unknown) => boolean;
		class JestAssertionError extends Error { matcherResult = { pass: false }; }
		const assertionError = Object.assign(new Error('8 !== 2'), { name: 'AssertionError' });
		const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		assert.deepStrictEqual([assertionError, new JestAssertionError('x'), enoent, new TypeError('x'), null, 'thrown string'].map(condition), [true, true, false, false, false, false]);
	});

	test('pytest under debugpy stops where the exception leaves the user code; names become a -k expression', () => {
		const p = plan(buildTestDebugPlan('pytest', { cwd: '/p', files: ['tests/test_x.py'], names: ['test_one', 'test two'], hasPackage: none }));
		assert.deepStrictEqual([p.configuration.type, p.configuration.module, p.failureFilters], ['debugpy', 'pytest', ['userUnhandled']]);
		assert.deepStrictEqual(p.configuration.args, ['-q', '-p', 'no:cacheprovider', '-k', 'test_one or test_two', 'tests/test_x.py']);
	});

	test('jest and mocha run from the project install, or are refused; frameworks without a shipped debugger are refused', () => {
		assert.match((buildTestDebugPlan('jest', { cwd: '/p', files: [], names: [], hasPackage: none }) as TestDebugUnavailable).unavailable, /not installed/);
		const jest = plan(buildTestDebugPlan('jest', { cwd: '/p', files: ['a.test.js'], names: ['x'], hasPackage: pkg => pkg === 'jest' }));
		assert.deepStrictEqual([jest.configuration.program, jest.configuration.args], ['/p/node_modules/jest/bin/jest.js', ['--runInBand', '--watchAll=false', '-t', 'x', 'a.test.js']]);
		for (const fw of ['go', 'cargo', 'dotnet', 'phpunit', 'vitest'] as const) {
			assert.ok('unavailable' in buildTestDebugPlan(fw, { cwd: '/p', files: [], names: [], hasPackage: none }), fw);
		}
		assert.match((buildTestDebugPlan('node-test', { cwd: '/p', files: ['--inspect=0'], names: [], hasPackage: none }) as TestDebugUnavailable).unavailable, /looks like an option/);
	});
});
