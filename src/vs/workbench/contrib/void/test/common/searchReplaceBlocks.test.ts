/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applySearchReplaceBlocks, DIVIDER, FINAL, findTextInCode, ORIGINAL } from '../../../../../platform/kodia/common/searchReplaceBlocks.js';

const block = (orig: string, final: string) => `${ORIGINAL}\n${orig}\n${DIVIDER}\n${final}\n${FINAL}`;

suite('Kodia - editing a file with search/replace blocks', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const file = ['import a;', 'function f() {', '\treturn 1;', '}', '', 'function g() {', '\treturn 2;', '}', ''].join('\n');

	test('a block replaces the lines its ORIGINAL text is on', () => {
		assert.strictEqual(
			applySearchReplaceBlocks(file, block('\treturn 1;', '\treturn 10;')),
			['import a;', 'function f() {', '\treturn 10;', '}', '', 'function g() {', '\treturn 2;', '}', ''].join('\n'),
		);
		// several lines, with more lines coming back
		assert.strictEqual(
			applySearchReplaceBlocks(file, block('function f() {\n\treturn 1;\n}', 'const f = () => {\n\tconst one = 1;\n\treturn one;\n};')),
			['import a;', 'const f = () => {', '\tconst one = 1;', '\treturn one;', '};', '', 'function g() {', '\treturn 2;', '}', ''].join('\n'),
		);
	});

	test('several blocks apply together, wherever they come in the call', () => {
		const blocks = `${block('\treturn 2;', '\treturn 20;')}\n${block('import a;', 'import b;')}\n${block('\treturn 1;', '\treturn 10;')}`;
		assert.strictEqual(
			applySearchReplaceBlocks(file, blocks),
			['import b;', 'function f() {', '\treturn 10;', '}', '', 'function g() {', '\treturn 20;', '}', ''].join('\n'),
		);
	});

	test('an ORIGINAL with other indentation still finds its lines, if there is only one place for it', () => {
		assert.strictEqual(
			applySearchReplaceBlocks(file, block('    return 1;', '\treturn 10;')),
			['import a;', 'function f() {', '\treturn 10;', '}', '', 'function g() {', '\treturn 2;', '}', ''].join('\n'),
		);
		assert.throws(() => applySearchReplaceBlocks('a\n\tx = 1;\nb\n\tx = 1;\n', block('  x = 1;', 'x = 2;')), /must be unique/);
	});

	test('tells the model what is wrong with a block it can\'t apply', () => {
		assert.throws(() => applySearchReplaceBlocks(file, block('return 3;', 'x')), /there was no match for/);
		assert.throws(() => applySearchReplaceBlocks('a\nb\nc\nd\n', `${block('b\nc', 'x')}\n${block('c\nd', 'y')}`), /must not overlap/);
		assert.throws(() => applySearchReplaceBlocks(file, 'no block in here'), /No Search\/Replace blocks were received!/);
	});

	test('an ORIGINAL that is on several lines of the file goes to the first, unless the edit must be certain', () => {
		const duplicated = 'a\nx = 1;\nb\nx = 1;\n';
		assert.strictEqual(applySearchReplaceBlocks(duplicated, block('x = 1;', 'x = 2;')), 'a\nx = 2;\nb\nx = 1;\n');
		assert.throws(() => applySearchReplaceBlocks(duplicated, block('x = 1;', 'x = 2;'), { requireUnique: true }), /appears multiple times/);
		assert.strictEqual(applySearchReplaceBlocks(duplicated, block('a\nx = 1;', 'a\nx = 2;'), { requireUnique: true }), 'a\nx = 2;\nb\nx = 1;\n');
	});

	test('finds the lines of a text, from 1, and says when it isn\'t there', () => {
		assert.deepStrictEqual(findTextInCode('b\nc', 'a\nb\nc\nd', false, { returnType: 'lines' }), [2, 3]);
		assert.deepStrictEqual(findTextInCode('a', 'a\nb', false, { returnType: 'lines' }), [1, 1]);
		assert.strictEqual(findTextInCode('z', 'a\nb', true, { returnType: 'lines' }), 'Not found');
		// other indentation: only when the whitespace may be ignored
		assert.strictEqual(findTextInCode('    b', 'a\n\tb', false, { returnType: 'lines' }), 'Not found');
		assert.deepStrictEqual(findTextInCode('    b', 'a\n\tb', true, { returnType: 'lines' }), [2, 2]);
	});
});
