/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { similarSnippets, snippetsAsComments } from '../../common/helpers/autocompleteContext.js';

suite('Kodia - autocomplete context from open files', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const userService = [
		'import { db } from "./db"',
		...Array.from({ length: 30 }, (_, i) => `// filler line ${i}`),
		'export async function getUserById(userId: string) {',
		'	return db.users.findOne({ id: userId })',
		'}',
	].join('\n');
	const styles = '.button { color: red; }\n.title { font-size: 2em; }';
	const code = 'const user = await getUserById(req.params.userId)\nif (!user) return db';

	test('picks the part of a file that shares identifiers with the code', () => {
		const snippets = similarSnippets({ code, files: [{ path: 'styles.css', text: styles }, { path: 'src/userService.ts', text: userService }], maxSnippets: 3, maxChars: 2000 });
		assert.deepStrictEqual(snippets.map(s => s.path), ['src/userService.ts']);
		assert.ok(snippets[0].snippet.includes('getUserById'));
		assert.ok(!snippets[0].snippet.includes('filler line 0'), 'the window should be the one around the function');
	});

	test('keeps within the character budget', () => {
		const snippets = similarSnippets({ code, files: [{ path: 'a.ts', text: userService }], maxSnippets: 3, maxChars: 10 });
		assert.deepStrictEqual(snippets, []);
	});

	test('no identifiers, no context', () => {
		assert.deepStrictEqual(similarSnippets({ code: '{ }', files: [{ path: 'a.ts', text: userService }], maxSnippets: 3, maxChars: 2000 }), []);
	});

	test('writes the snippets as comments with their path', () => {
		assert.strictEqual(
			snippetsAsComments([{ path: 'src/a.py', snippet: 'def f():\n    pass', score: 1 }], '#', '\n'),
			'# Path: src/a.py\n# def f():\n#     pass\n\n',
		);
		assert.strictEqual(snippetsAsComments([], '//', '\n'), '');
	});
});
