/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { canonicalModelNameForProvider, normalizeAutodetectedModelNamesForProvider } from '../../common/localSingleModelProviders.js';

suite('Kodia - autodetected model names', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('MLX lists every model of the server, once, in the server\'s order', () => {
		assert.deepStrictEqual(normalizeAutodetectedModelNamesForProvider('mlx', ['mlx-community/Qwen3-8B', 'mlx-community/Qwen2.5-Coder-1.5B-Instruct-4bit', 'mlx-community/Qwen3-8B', 'other']), ['mlx-community/Qwen3-8B', 'mlx-community/Qwen2.5-Coder-1.5B-Instruct-4bit', 'other']);
		assert.deepStrictEqual(normalizeAutodetectedModelNamesForProvider('mlx', []), []);
	});

	test('maps dated Anthropic ids to the catalog name, so one model is listed once', () => {
		assert.strictEqual(canonicalModelNameForProvider('anthropic', 'claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
		assert.strictEqual(canonicalModelNameForProvider('anthropic', 'claude-sonnet-5-5'), 'claude-sonnet-5-5');
	});

	test('a Gemini preview keeps its name', () => {
		assert.strictEqual(canonicalModelNameForProvider('gemini', 'gemini-3.1-pro-preview'), 'gemini-3.1-pro-preview');
	});
});
