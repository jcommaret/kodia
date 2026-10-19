/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { findDiffs } from '../../browser/helpers/findDiffs.js';

suite('Kodia - line diffs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('no diff between identical files', () => {
		assert.deepStrictEqual(findDiffs('a\nb\nc', 'a\nb\nc'), []);
	});

	test('an edited line', () => {
		assert.deepStrictEqual(findDiffs('a\nb\nc', 'a\nB\nc'), [
			{ type: 'edit', startLine: 2, endLine: 2, originalStartLine: 2, originalEndLine: 2, originalCode: 'b', code: 'B' },
		]);
	});

	test('an inserted line', () => {
		assert.deepStrictEqual(findDiffs('a\nc', 'a\nb\nc'), [
			{ type: 'insertion', startLine: 2, endLine: 2, originalStartLine: 2, originalEndLine: 1, originalCode: '', code: 'b' },
		]);
	});

	test('a deleted line', () => {
		assert.deepStrictEqual(findDiffs('a\nb\nc', 'a\nc'), [
			{ type: 'deletion', startLine: 2, endLine: 1, originalStartLine: 2, originalEndLine: 2, originalCode: 'b', code: '' },
		]);
	});

	test('separate changes give separate diffs', () => {
		const diffs = findDiffs('1\n2\n3\n4\n5', 'one\n2\n3\n4\nfive');
		assert.deepStrictEqual(diffs.map(d => [d.type, d.startLine, d.originalStartLine]), [['edit', 1, 1], ['edit', 5, 5]]);
	});

	test('adding a final newline is an insertion, not an edit of the last line', () => {
		const diffs = findDiffs('a', 'a\n');
		assert.deepStrictEqual(diffs.map(d => d.type), ['insertion']);
	});

	test('a change at the end of the file', () => {
		assert.deepStrictEqual(findDiffs('a\nb', 'a\nb\nc\nd'), [
			{ type: 'insertion', startLine: 3, endLine: 4, originalStartLine: 3, originalEndLine: 2, originalCode: '', code: 'c\nd' },
		]);
	});
});
