/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { endsWithAnyPrefixOf, extractCodeFromFIM, extractCodeFromRegular, extractSearchReplaceBlocks, ExtractedSearchReplaceBlock } from '../../common/helpers/extractCodeFromResult.js';
import { DIVIDER, FINAL, ORIGINAL } from '../../common/prompt/prompts.js';

const block = (orig: string, final: string) => `${ORIGINAL}\n${orig}\n${DIVIDER}\n${final}\n${FINAL}`;

const stateRank: Record<ExtractedSearchReplaceBlock['state'], number> = { writingOriginal: 0, writingFinal: 1, done: 2 };

suite('Kodia - search/replace blocks (Fast Apply)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses one block', () => {
		assert.deepStrictEqual(extractSearchReplaceBlocks(block('const a = 1', 'const a = 2')), [
			{ orig: 'const a = 1', final: 'const a = 2', state: 'done' },
		]);
	});

	test('parses several blocks and ignores the text around them', () => {
		const text = `Here are the changes:\n${block('a', 'b')}\nand\n${block('c\nd', 'e')}\nDone.`;
		assert.deepStrictEqual(extractSearchReplaceBlocks(text), [
			{ orig: 'a', final: 'b', state: 'done' },
			{ orig: 'c\nd', final: 'e', state: 'done' },
		]);
	});

	test('an empty replacement deletes the original', () => {
		assert.deepStrictEqual(extractSearchReplaceBlocks(`${ORIGINAL}\nremove me\n${DIVIDER}\n${FINAL}`), [
			{ orig: 'remove me', final: '', state: 'done' },
		]);
	});

	test('hides a half-written divider while the original streams', () => {
		assert.deepStrictEqual(extractSearchReplaceBlocks(`${ORIGINAL}\nfoo\n===`), [
			{ orig: 'foo', final: '', state: 'writingOriginal' },
		]);
	});

	test('hides a half-written end marker while the replacement streams', () => {
		assert.deepStrictEqual(extractSearchReplaceBlocks(`${ORIGINAL}\nfoo\n${DIVIDER}\nbar\n>>>`), [
			{ orig: 'foo', final: 'bar', state: 'writingFinal' },
		]);
	});

	test('no block before the original marker is complete', () => {
		assert.deepStrictEqual(extractSearchReplaceBlocks('Sure! <<<<<<< ORIG'), []);
		assert.deepStrictEqual(extractSearchReplaceBlocks(ORIGINAL), []);
	});

	test('while streaming, blocks only get added and their state only moves forward', () => {
		const text = `Intro\n${block('if (a) {\n\treturn 1\n}', 'if (a) {\n\treturn 2\n}')}\n${block('x', '')}\n${block('', 'y')}`;
		let prev: ExtractedSearchReplaceBlock[] = [];
		for (let len = 1; len <= text.length; len++) {
			const blocks = extractSearchReplaceBlocks(text.slice(0, len));
			assert.ok(blocks.length >= prev.length, `block count went down at ${len}`);
			for (let k = 0; k < prev.length; k++) {
				assert.ok(stateRank[blocks[k].state] >= stateRank[prev[k].state], `block ${k} went back at ${len}`);
				if (prev[k].state === 'done') {
					assert.deepStrictEqual(blocks[k], prev[k], `done block ${k} changed at ${len}`);
				}
			}
			prev = blocks;
		}
		assert.deepStrictEqual(prev.map(b => b.state), ['done', 'done', 'done']);
	});
});

suite('Kodia - extracting code from a model reply', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('removes a fenced code block and its language', () => {
		const [code] = extractCodeFromRegular({ text: '```ts\nconst a = 1\n```', recentlyAddedTextLen: 0 });
		assert.strictEqual(code, 'const a = 1');
	});

	test('keeps a reply that has no code fence', () => {
		const [code] = extractCodeFromRegular({ text: 'const a = 1', recentlyAddedTextLen: 0 });
		assert.strictEqual(code, 'const a = 1');
	});

	test('removes the opening fence while the code still streams', () => {
		const [code, delta] = extractCodeFromRegular({ text: '```ts\nconst a', recentlyAddedTextLen: 2 });
		assert.strictEqual(code, 'const a');
		assert.strictEqual(delta, ' a');
	});

	test('takes the middle out of FIM tags', () => {
		const [code] = extractCodeFromFIM({ text: '<MID>return x</MID>', recentlyAddedTextLen: 0, midTag: 'MID' });
		assert.strictEqual(code, 'return x');
	});

	test('finds a partially written tag at the end of a string', () => {
		assert.strictEqual(endsWithAnyPrefixOf('abc<PR', '<PRE>'), '<PR');
		assert.strictEqual(endsWithAnyPrefixOf('abc', '<PRE>'), null);
	});
});
