/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { fitMemoryToBudget, parseMemorySections } from '../../common/projectMemoryService.js';
import { estimateTokens } from '../../common/tokenizer.js';

suite('Kodia - project memory in a prompt budget (roadmap 9)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const memory = ['<!-- header -->', '## Commands\nnpm run check:unit', '## Architecture\n' + 'The server is in src/server. '.repeat(80), '## Pitfalls\nNever run migrations on prod.'].join('\n\n') + '\n';

	test('a memory that fits is passed through unchanged', () => {
		assert.strictEqual(fitMemoryToBudget(memory, 10_000), memory);
		assert.strictEqual(fitMemoryToBudget('', 10), '');
	});

	test('a memory that does not fit keeps whole sections in order while they fit, and names the rest', () => {
		const fitted = fitMemoryToBudget(memory, 100);
		assert.deepStrictEqual(parseMemorySections(fitted.split('\n(')[0]).sections.map(s => s.title), ['Commands']);
		assert.match(fitted, /2 more sections not shown here, to fit this model's context window: "Architecture", "Pitfalls"\. Read \.kodia\/memory\.md/);
		assert.ok(estimateTokens(fitted) < 150, `fits about the budget: ${estimateTokens(fitted)}`);
		assert.match(fitted, /<!-- header -->/, 'text before the first section is kept');
	});

	test('after a section that does not fit, later (smaller) ones are not skipped ahead: order is kept', () => {
		const fitted = fitMemoryToBudget(memory, 100);
		assert.doesNotMatch(fitted, /Never run migrations/, 'Pitfalls is listed, not shown out of order');
	});
});
