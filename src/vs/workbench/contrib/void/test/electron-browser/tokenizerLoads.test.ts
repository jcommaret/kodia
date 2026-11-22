/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 10: found by launching the app. The real BPE tokenizer must load in the renderer; it never did (the module
 * path had the package name twice), so every token count in Kodia was the chars/4 estimate.
 */

import assert from 'assert';
import { estimateTokens, isTokenizerLoaded, whenTokenizerLoaded } from '../../common/tokenizer.js';

suite('Kodia - the real tokenizer loads in the renderer (roadmap 10)', function () {
	this.timeout(30_000);

	test('o200k_base loads, and counts are real BPE counts, not the chars/4 estimate', async () => {
		await whenTokenizerLoaded('o200k_base');
		assert.ok(isTokenizerLoaded('o200k_base'));
		// "hello world" is 2 o200k tokens; the estimate says ceil(11/4) = 3
		assert.strictEqual(estimateTokens('hello world'), 2);
		const code = 'export function add(a: number, b: number): number {\n\treturn a + b;\n}\n';
		assert.notStrictEqual(estimateTokens(code), Math.ceil(code.length / 4));
	});

	test('cl100k_base loads too', async () => {
		await whenTokenizerLoaded('cl100k_base');
		assert.ok(isTokenizerLoaded('cl100k_base'));
	});
});
