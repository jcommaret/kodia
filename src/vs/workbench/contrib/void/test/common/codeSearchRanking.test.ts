/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { describePassages, MAX_SEARCH_FILE_CHARS, rankPassages, searchTermsOf } from '../../../../../platform/kodia/common/codeSearchRanking.js';

suite('Kodia - search_codebase ranks the passages of a project', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const filler = (n: number, word = 'line') => Array.from({ length: n }, (_, i) => `// ${word} ${i}`).join('\n');
	const retry = `${filler(40)}\nexport const shouldRetryModelRequest = (attempt: number) => {\n\t// a failed request to the model is sent again\n\treturn attempt < MAX_ATTEMPTS\n}\n${filler(40)}`;
	const files = [
		{ path: '/p/src/modelRequestRetry.ts', content: retry },
		{ path: '/p/src/theme.ts', content: `${filler(10)}\nconst request = 'colors'\n${filler(10)}` },
		{ path: '/p/src/unrelated.ts', content: filler(100, 'nothing') },
	];

	test('searches by the words of a question, an identifier whole and by its parts', () => {
		assert.deepStrictEqual(searchTermsOf('Where is the retry policy for model requests?'), ['retry', 'policy', 'model', 'request']);
		assert.deepStrictEqual(searchTermsOf('shouldRetryModelRequest'), ['shouldretrymodelrequest', 'retry', 'model', 'request']);
		assert.deepStrictEqual(searchTermsOf('HTTPServer snake_case_name'), ['httpserver', 'http', 'server', 'snakecasename', 'snake', 'case', 'name']);
		assert.deepStrictEqual(searchTermsOf('how does it do this?'), []);
		assert.deepStrictEqual(searchTermsOf('retries retrying parsed'), ['retr', 'retry', 'pars']);
	});

	test('the best passage is the one with the most words of the query, with its lines', () => {
		const [best, ...others] = rankPassages(files, 'where is a failed model request sent again (retry)?');
		assert.strictEqual(best.path, '/p/src/modelRequestRetry.ts');
		assert.ok(best.startLine <= 41 && best.endLine >= 43, `lines ${best.startLine}-${best.endLine}`);
		assert.ok(best.text.includes('shouldRetryModelRequest'));
		assert.ok(best.text.split('\n').length <= 30);
		assert.deepStrictEqual(others.map(passage => passage.path), ['/p/src/theme.ts']);
		assert.ok(best.score > others[0].score);
	});

	test('a file gives two passages at most, which do not overlap, and six are returned at most', () => {
		const many = Array.from({ length: 10 }, (_, f) => ({ path: `/p/f${f}.ts`, content: Array.from({ length: 200 }, (_, i) => i % 20 === 0 ? `const widget${i} = makeWidget()` : `// ${i}`).join('\n') }));
		const passages = rankPassages(many, 'widget');
		assert.strictEqual(passages.length, 6);
		for (const { path } of passages) {
			const ofFile = passages.filter(passage => passage.path === path);
			assert.ok(ofFile.length <= 2);
			if (ofFile.length === 2) assert.ok(ofFile[0].endLine < ofFile[1].startLine || ofFile[1].endLine < ofFile[0].startLine);
		}
	});

	test('a file named after the word comes first, and a huge file is left out', () => {
		const same = 'const retry = 1';
		assert.strictEqual(rankPassages([{ path: '/p/a.ts', content: same }, { path: '/p/retry.ts', content: same }], 'retry')[0].path, '/p/retry.ts');
		assert.deepStrictEqual(rankPassages([{ path: '/p/big.js', content: `retry\n${'x'.repeat(MAX_SEARCH_FILE_CHARS)}` }], 'retry'), []);
	});

	test('a very long line is cut', () => {
		const [passage] = rankPassages([{ path: '/p/min.js', content: `retry${'x'.repeat(1000)}` }], 'retry');
		assert.ok(passage.text.length < 400 && passage.text.endsWith('…'));
	});

	test('tells the model the passages with their file and lines, or what to try when there is none', () => {
		const text = describePassages(rankPassages(files, 'retry model request'), 'retry model request');
		assert.ok(/^\/p\/src\/modelRequestRetry\.ts \(lines \d+-\d+\)\n```\n/.test(text));
		assert.ok(text.includes('read_file'));
		assert.ok(describePassages([], 'zebra').includes('search_for_files'));
		assert.ok(describePassages([], 'how does it').includes('no word to search by'));
	});
});
