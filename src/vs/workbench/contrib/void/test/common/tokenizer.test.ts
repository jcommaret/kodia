/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { estimateTokens, tokenizerReady } from '../../common/tokenizer.js';

suite('Kodia - counting the tokens of a text', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('counts a text that holds a special token, as the text it is', async () => {
		await tokenizerReady;
		assert.strictEqual(estimateTokens(''), 0);
		assert.ok(estimateTokens('It should work.') > 0);
		// the counter throws on `<|im_end|>` by default: a turn of a local server's reply that holds it must not fail
		assert.ok(estimateTokens('It should work.<|im_end|>') >= estimateTokens('It should work.'));
		assert.ok(estimateTokens('Ok<|endoftext|>') > 0);
	});
});
