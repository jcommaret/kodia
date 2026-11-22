/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { terminalCommandOutcome } from '../../common/terminalUtils.js';

suite('Kodia - terminal command outcome', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('exit code 0 is a success', () => {
		assert.deepStrictEqual(terminalCommandOutcome({ result: 'ok', resolveReason: { type: 'done', exitCode: 0 } }), { success: true, exit_code: 0, output: 'ok' });
	});

	test('a non-zero exit code is a failure with that code', () => {
		assert.deepStrictEqual(terminalCommandOutcome({ result: 'npm ERR!', resolveReason: { type: 'done', exitCode: 1 } }), { success: false, exit_code: 1, output: 'npm ERR!' });
	});

	test('a command killed for inactivity is never a success', () => {
		const o = terminalCommandOutcome({ result: 'installing...', resolveReason: { type: 'timeout' } });
		assert.strictEqual(o.success, false);
		assert.strictEqual(o.exit_code, undefined);
		assert.match(o.output, /did not finish/);
	});
});
