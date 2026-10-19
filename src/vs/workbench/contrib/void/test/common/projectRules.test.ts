/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { joinProjectRules, PROJECT_RULES_FILE_NAMES } from '../../common/prompt/prompts.js';

suite('Kodia - project rules files', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads Kodia\'s own rules first, then the other agents\'', () => {
		assert.strictEqual(PROJECT_RULES_FILE_NAMES[0], '.voidrules');
		assert.ok(PROJECT_RULES_FILE_NAMES.includes('AGENTS.md'));
	});

	test('labels each file with its path', () => {
		assert.strictEqual(
			joinProjectRules([{ path: '.voidrules', content: 'Use tabs.\n' }, { path: 'AGENTS.md', content: '# Tests\nnpm test' }]),
			'From .voidrules:\nUse tabs.\n\nFrom AGENTS.md:\n# Tests\nnpm test',
		);
	});

	test('leaves out empty files and a copy of an earlier file', () => {
		assert.strictEqual(
			joinProjectRules([{ path: 'AGENTS.md', content: 'Same rules' }, { path: 'CLAUDE.md', content: 'Same rules\n' }, { path: '.cursorrules', content: '  ' }]),
			'From AGENTS.md:\nSame rules',
		);
	});

	test('no files, no rules', () => {
		assert.strictEqual(joinProjectRules([]), '');
	});
});
