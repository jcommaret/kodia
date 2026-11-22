/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { availableTools } from '../../common/prompt/prompts.js';
import { describeOmittedTools, toolDefinitionTokens, toolsWithinBudget } from '../../common/toolBudget.js';

// a stable stand-in for the tokenizer (its exact counts are tested elsewhere): ~4 characters per token
const count = (s: string) => Math.ceil(s.length / 4);

suite('Kodia - tool definitions within a small model\'s context (roadmap 10)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const all = availableTools('agent', undefined)!;
	const full = all.reduce((a, t) => a + toolDefinitionTokens(t, count), 0);

	test('a model with room for every tool gets all of them (nothing changes)', () => {
		assert.strictEqual(toolsWithinBudget(all, full * 2 + 10, count), undefined);
	});

	test('a small model gets a subset within half its window, core file/search/edit/terminal tools first, in the usual order', () => {
		const window = 16_000;
		const r = toolsWithinBudget(all, window, count)!;
		assert.ok(r.usedTokens <= window / 2, `${r.usedTokens} within ${window / 2}`);
		assert.ok(r.tools.length < all.length && r.omitted.length === all.length - r.tools.length);
		for (const core of ['read_file', 'edit_file', 'write_file', 'create_file_or_folder', 'ls_dir', 'search_for_files', 'run_command', 'code_semantic_search']) {
			assert.ok(r.tools.some(t => t.name === core), `${core} is offered`);
		}
		const order = r.tools.map(t => all.findIndex(a => a.name === t.name));
		assert.deepStrictEqual(order, [...order].sort((a, b) => a - b), 'offered in the usual order');
	});

	test('the model is told which groups it does not have', () => {
		const text = describeOmittedTools(['browser_launch', 'browser_click_element', 'debug_continue', 'api_request']);
		assert.match(text, /4 others are not \(browser_\* \(2\), debug_\*, api_\*\)/);
	});
});
