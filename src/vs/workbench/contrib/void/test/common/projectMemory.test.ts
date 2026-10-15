/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { memoryWithSection, parseMemorySections } from '../../common/projectMemoryService.js';

suite('Kodia - project memory sections', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const memory = [
		'<!-- header -->',
		'',
		'## Build',
		'npm run compile',
		'',
		'## Conventions',
		'Tabs, not spaces.',
		'',
	].join('\n');

	test('parses the preamble and each "## " section', () => {
		assert.deepStrictEqual(parseMemorySections(memory), {
			preamble: '<!-- header -->',
			sections: [
				{ title: 'Build', body: 'npm run compile' },
				{ title: 'Conventions', body: 'Tabs, not spaces.' },
			],
		});
	});

	test('replaces a section matched case-insensitively, keeping its title and the others', () => {
		const updated = memoryWithSection(memory, 'build', 'npm run watch');
		assert.deepStrictEqual(parseMemorySections(updated).sections, [
			{ title: 'Build', body: 'npm run watch' },
			{ title: 'Conventions', body: 'Tabs, not spaces.' },
		]);
		assert.ok(updated.startsWith('<!-- header -->'));
	});

	test('appends a new section at the end', () => {
		const updated = memoryWithSection(memory, 'Testing', 'npm run test-node');
		assert.deepStrictEqual(parseMemorySections(updated).sections.map(s => s.title), ['Build', 'Conventions', 'Testing']);
	});

	test('empty content deletes the section', () => {
		const updated = memoryWithSection(memory, 'Conventions', '  ');
		assert.deepStrictEqual(parseMemorySections(updated).sections.map(s => s.title), ['Build']);
	});

	test('starts from an empty memory', () => {
		assert.strictEqual(memoryWithSection('', 'Notes', 'first note'), '## Notes\nfirst note\n');
	});
});
