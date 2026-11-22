/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { chunkFile, CodeIndex, queryTerms, stem, tokenize } from '../../common/codeIndex.js';

const TS = [
	/* 1 */ 'import { db } from "./db";',
	/* 2 */ '',
	/* 3 */ '/** Checks a password against its hash. */',
	/* 4 */ 'export async function verifyPassword(plain: string, hash: string): Promise<boolean> {',
	/* 5 */ '	if (!hash) { return false; }',
	/* 6 */ '	for (const c of plain) { }',
	/* 7 */ '	return compareHash(plain, hash);',
	/* 8 */ '}',
	/* 9 */ '',
	/* 10 */ 'export class UserRepository {',
	/* 11 */ '	constructor(private readonly conn: Connection) { }',
	/* 12 */ '	async findByEmail(email: string) {',
	/* 13 */ '		return this.conn.query("select * from users where email = ?", [email.toLowerCase()]);',
	/* 14 */ '	}',
	/* 15 */ '}',
	/* 16 */ '',
	/* 17 */ 'export const slugify = (title: string) => title.toLowerCase().replace(/\\s+/g, "-");',
].join('\n');

const PY = [
	'import os',
	'',
	'class RetryPolicy:',
	'    def __init__(self, attempts):',
	'        self.attempts = attempts',
	'',
	'    def next_delay(self, attempt):',
	'        return min(30, 2 ** attempt)',
	'',
	'def load_config(path):',
	'    with open(path) as f:',
	'        return f.read()',
].join('\n');

suite('Kodia - code index core (roadmap 7)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('tokenize splits identifiers into words, stems, drops stop words, and keeps the whole identifier', () => {
		assert.deepStrictEqual(tokenize('parseUserToken'), ['pars', 'user', 'token', '#parseusertoken']);
		assert.deepStrictEqual(tokenize('MAX_RETRY_COUNT'), ['max', 'retry', 'count', '#max_retry_count']);
		assert.deepStrictEqual(tokenize('HTTPServer'), ['http', 'server', '#httpserver']);
		assert.deepStrictEqual(tokenize('return the value of x'), ['valu']);
		assert.deepStrictEqual(['parsing', 'parsed', 'parses', 'parse', 'queries', 'classes', 'status'].map(stem), ['pars', 'pars', 'pars', 'pars', 'query', 'class', 'status']);
	});

	test('query terms expand common abbreviations, at a lower weight', () => {
		const t = queryTerms('db auth');
		assert.strictEqual(t.get('db'), 1);
		assert.strictEqual(t.get(stem('database')), 0.6);
		assert.strictEqual(t.get(stem('authenticate')), 0.6);
	});

	test('chunks follow symbols (functions, classes, methods, arrow functions) with their doc comments; control flow is not a symbol', () => {
		const chunks = chunkFile('src/auth.ts', TS).map(c => `${c.kind} ${c.name} ${c.startLine}-${c.endLine}`);
		assert.deepStrictEqual(chunks, [
			'block lines 1-1 1-1',
			'function verifyPassword 3-8',
			'class UserRepository 10-15', // a one-line `constructor(...) { }` stays part of its class
			'method findByEmail 12-14',
			'function slugify 17-17',
		]);
	});

	test('python chunks end where the indentation does; markdown chunks by heading; other files by window', () => {
		assert.deepStrictEqual(chunkFile('app/retry.py', PY).map(c => `${c.kind} ${c.name} ${c.startLine}-${c.endLine}`), [
			'block lines 1-1 1-1', 'class RetryPolicy 3-8', 'method __init__ 4-5', 'method next_delay 7-8', 'function load_config 10-12',
		]);
		assert.deepStrictEqual(chunkFile('README.md', '# Kodia\nintro\n## Install\nnpm i\n').map(c => `${c.kind} ${c.name} ${c.startLine}-${c.endLine}`), ['section Kodia 1-2', 'section Install 3-4']);
		const json = Array.from({ length: 90 }, (_, i) => `"k${i}": ${i},`).join('\n');
		assert.deepStrictEqual(chunkFile('data.json', json).map(c => `${c.startLine}-${c.endLine}`), ['1-40', '41-80', '81-90']);
	});

	test('search ranks the right symbol for a description that spells things differently, with the matching lines', () => {
		const idx = new CodeIndex();
		idx.setFile('/w/src/auth.ts', TS, 'src/auth.ts');
		idx.setFile('/w/app/retry.py', PY, 'app/retry.py');
		idx.setFile('/w/README.md', '# Users\nUsers sign in with an email.\n', 'README.md');

		const byEmail = idx.search('find users by email address', 3);
		assert.deepStrictEqual(byEmail.map(h => `${h.filePath}:${h.name}`)[0], '/w/src/auth.ts:findByEmail');
		assert.ok(byEmail[0].snippet.some(s => s.line === 12), JSON.stringify(byEmail[0].snippet));

		assert.strictEqual(idx.search('password verification', 1)[0].name, 'verifyPassword', 'verification ≈ verify by stemming');
		assert.strictEqual(idx.search('retry backoff delay', 1)[0].name, 'next_delay');
		assert.strictEqual(idx.search('read configuration file', 1)[0].name, 'load_config', 'configuration ≈ config');
		assert.strictEqual(idx.search('slugify', 1)[0].name, 'slugify');
		assert.deepStrictEqual(idx.search('kubernetes', 5), []);
	});

	test('results do not repeat a region: a class and its method are not both listed for the same match', () => {
		const idx = new CodeIndex();
		idx.setFile('/w/src/auth.ts', TS);
		const hits = idx.search('findByEmail email query', 5).filter(h => h.filePath === '/w/src/auth.ts');
		for (let i = 0; i < hits.length; i++) {
			for (let j = i + 1; j < hits.length; j++) {
				assert.ok(hits[i].endLine < hits[j].startLine || hits[j].endLine < hits[i].startLine, `overlap: ${hits[i].name} / ${hits[j].name}`);
			}
		}
	});

	test('the index is incremental: re-setting or removing a file changes only that file', () => {
		const idx = new CodeIndex();
		idx.setFile('/a.ts', 'export function alpha() { return 1 }');
		idx.setFile('/b.ts', 'export function beta() { return 2 }');
		assert.strictEqual(idx.search('alpha', 1)[0].filePath, '/a.ts');
		idx.setFile('/a.ts', 'export function gamma() { return 3 }');
		assert.deepStrictEqual(idx.search('alpha', 5), []);
		assert.strictEqual(idx.search('gamma', 1)[0].filePath, '/a.ts');
		idx.removeFile('/b.ts');
		assert.deepStrictEqual(idx.search('beta', 5), []);
		assert.deepStrictEqual([idx.fileCount, idx.chunkCount], [1, 1]);
		assert.deepStrictEqual(idx.findLiteral('RETURN 3'), [{ filePath: '/a.ts', line: 1, text: 'export function gamma() { return 3 }' }]);
	});
});
