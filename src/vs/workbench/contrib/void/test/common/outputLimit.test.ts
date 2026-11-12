/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MLX_MIN_OUTPUT_TOKENS, mlxMaxOutputTokens, OUTPUT_LIMIT_NOTICE, withOutputLimitNotice } from '../../common/outputLimit.js';

suite('Kodia - a reply cut at the output limit', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('says at the end of the reply that the model reached its output limit', () => {
		assert.strictEqual(withOutputLimitNotice('The first half of', true), `The first half of${OUTPUT_LIMIT_NOTICE}`);
		assert.ok(OUTPUT_LIMIT_NOTICE.includes('output limit') && OUTPUT_LIMIT_NOTICE.includes('continue'));
	});

	test('leaves a reply that ended by itself, and an empty one, as they are', () => {
		assert.strictEqual(withOutputLimitNotice('Done.', false), 'Done.');
		assert.strictEqual(withOutputLimitNotice('', true), '');
		assert.strictEqual(withOutputLimitNotice('  \n', true), '  \n');
	});

	test('gives an MLX model room for a long reply: mlx_lm.server stops at 512 tokens otherwise', () => {
		assert.strictEqual(mlxMaxOutputTokens(undefined), MLX_MIN_OUTPUT_TOKENS);
		assert.strictEqual(mlxMaxOutputTokens(null), MLX_MIN_OUTPUT_TOKENS);
		assert.strictEqual(mlxMaxOutputTokens(4_096), MLX_MIN_OUTPUT_TOKENS);
		assert.strictEqual(mlxMaxOutputTokens(32_000), 32_000);
		assert.ok(MLX_MIN_OUTPUT_TOKENS > 512);
	});
});
