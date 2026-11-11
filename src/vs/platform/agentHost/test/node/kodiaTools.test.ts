/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getRandomTestPath } from '../../../../base/test/node/testUtils.js';
import { describeKodiaToolCall, executeKodiaTool, IKodiaToolContext, KODIA_TOOLS, needsApproval, toolDisplayName } from '../../node/kodia/kodiaTools.js';

suite('Kodia agent tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	let ctx: IKodiaToolContext;
	const run = (name: string, args: object) => executeKodiaTool(name, JSON.stringify(args), ctx);
	const write = async (path: string, content: string) => {
		await fs.promises.mkdir(join(dir, path, '..'), { recursive: true });
		await fs.promises.writeFile(join(dir, path), content);
	};
	const read = (path: string) => fs.promises.readFile(join(dir, path), 'utf8');

	setup(async () => {
		dir = getRandomTestPath(os.tmpdir(), 'kodiaTools');
		await fs.promises.mkdir(dir, { recursive: true });
		ctx = { workingDirectory: URI.file(dir), signal: new AbortController().signal };
	});

	teardown(() => fs.promises.rm(dir, { recursive: true, force: true }));

	test('every tool has a display name, and only the ones that change things, run commands or reach the web need approval', () => {
		for (const tool of KODIA_TOOLS) {
			assert.notStrictEqual(toolDisplayName(tool.name), tool.name, tool.name);
		}
		assert.deepStrictEqual(KODIA_TOOLS.map(t => t.name).filter(needsApproval), ['edit_file', 'write_file', 'run_bash', 'fetch_url', 'write_project_memory']);
	});

	test('read_file reads a whole file, or a range of its lines', async () => {
		await write('a.txt', 'one\ntwo\nthree\nfour\nfive');
		assert.deepStrictEqual(await run('read_file', { path: 'a.txt' }), { success: true, output: 'one\ntwo\nthree\nfour\nfive', path: join(dir, 'a.txt') });
		assert.strictEqual((await run('read_file', { path: 'a.txt', start_line: 2, end_line: 3 })).output, 'Lines 2-3 of 5.\ntwo\nthree');
		assert.strictEqual((await run('read_file', { path: 'a.txt', start_line: 4, end_line: 99 })).output, 'Lines 4-5 of 5.\nfour\nfive');
		assert.strictEqual(describeKodiaToolCall('read_file', JSON.stringify({ path: 'a.txt', start_line: 2, end_line: 3 }), ctx.workingDirectory).invocationMessage, 'Read a.txt, lines 2-3');
	});

	test('reads the numbers and flags the model sends as text, which is how the window offers every parameter', async () => {
		await write('a.txt', 'one\ntwo\nthree\nfour\nfive');
		assert.strictEqual((await run('read_file', { path: 'a.txt', start_line: '2', end_line: ' 3 ' })).output, 'Lines 2-3 of 5.\ntwo\nthree');
		for (const notALine of ['abc', '0', '-1', '1.5', '']) {
			assert.strictEqual((await run('read_file', { path: 'a.txt', start_line: notALine })).output, 'one\ntwo\nthree\nfour\nfive', `"${notALine}" is no line`);
		}

		await write('b.ts', 'let a = 1;\nlet b = 1;\n');
		assert.strictEqual((await run('edit_file', { path: 'b.ts', old_string: '= ', new_string: '=', replace_all: 'true' })).success, true);
		assert.strictEqual(await read('b.ts'), 'let a =1;\nlet b =1;\n');
		assert.match((await run('edit_file', { path: 'b.ts', old_string: '=1', new_string: '=2', replace_all: 'false' })).output, /occurs 2 times/);

		await write('c.ts', 'function foo() {}\n');
		assert.strictEqual((await run('search_files', { query: 'fo+\\(', is_regex: 'true' })).output, 'c.ts:1:function foo() {}');
		assert.strictEqual((await run('search_files', { query: 'fo+\\(', is_regex: 'false' })).output, 'No matches.');
	});

	test('read_file cuts a large file, and says where to read on', async () => {
		const line = 'x'.repeat(60_000);
		await write('big.txt', `${line}\n${line}\n${line}`);
		const first = (await run('read_file', { path: 'big.txt' })).output;
		assert.ok(first.startsWith('Lines 1-1 of 3. The file is cut here: read on with start_line 2.\n'), first.slice(0, 80));
		await write('min.js', 'y'.repeat(150_000));
		const minified = (await run('read_file', { path: 'min.js' })).output;
		assert.ok(minified.startsWith('Lines 1-1 of 1. Line 1 is cut at 100000 characters.\n'), minified.slice(0, 80));
		assert.ok(minified.length < 100_100);
	});

	test('edit_file replaces one exact occurrence, and refuses a missing or ambiguous one', async () => {
		await write('a.ts', 'let a = 1;\nlet b = 1;\n');
		assert.deepStrictEqual(await run('edit_file', { path: 'a.ts', old_string: 'let a = 1;', new_string: 'let a = 2;' }), { success: true, output: `Edited ${join(dir, 'a.ts')}: 1 replacement.`, didWrite: true, path: join(dir, 'a.ts') });
		assert.strictEqual(await read('a.ts'), 'let a = 2;\nlet b = 1;\n');

		const missing = await run('edit_file', { path: 'a.ts', old_string: 'let c', new_string: '' });
		assert.strictEqual(missing.success, false);
		assert.match(missing.output, /isn't in .*a\.ts/);

		const ambiguous = await run('edit_file', { path: 'a.ts', old_string: '= ', new_string: '=' });
		assert.strictEqual(ambiguous.success, false);
		assert.match(ambiguous.output, /occurs 2 times/);
		assert.strictEqual(await read('a.ts'), 'let a = 2;\nlet b = 1;\n', 'a refused edit changes nothing');

		assert.strictEqual((await run('edit_file', { path: 'a.ts', old_string: '= ', new_string: '=', replace_all: true })).output, `Edited ${join(dir, 'a.ts')}: 2 replacements.`);
		assert.strictEqual(await read('a.ts'), 'let a =2;\nlet b =1;\n');

		assert.strictEqual((await run('edit_file', { path: 'a.ts', old_string: '', new_string: 'x' })).success, false);
	});

	test('edit_file keeps a file\'s CRLF line endings, and new_string as it is', async () => {
		await write('w.ts', 'one\r\ntwo\r\nthree\r\n');
		assert.strictEqual((await run('edit_file', { path: 'w.ts', old_string: 'one\ntwo', new_string: 'one\n$& 2' })).success, true);
		assert.strictEqual(await read('w.ts'), 'one\r\n$& 2\r\nthree\r\n');
	});

	test('find_files and search_files look through the project, hidden folders included', async () => {
		await write('src/a.ts', 'const value = 1;\nfunction foo() {}\n');
		await write('src/b.js', 'const value = 2; // -flag\n');
		await write('.github/ci.yml', 'value: 3\n');

		assert.strictEqual((await run('find_files', { pattern: '*.ts' })).output, 'src/a.ts');
		assert.strictEqual((await run('find_files', { pattern: '*.yml' })).output, '.github/ci.yml');
		assert.strictEqual((await run('find_files', { pattern: '*.md' })).output, 'No files found.');

		assert.strictEqual((await run('search_files', { query: 'value = 1' })).output, 'src/a.ts:1:const value = 1;');
		assert.strictEqual((await run('search_files', { query: 'fo+\\(', is_regex: true })).output, 'src/a.ts:2:function foo() {}');
		assert.strictEqual((await run('search_files', { query: 'value', include: '*.js' })).output, 'src/b.js:1:const value = 2; // -flag');
		assert.strictEqual((await run('search_files', { query: '-flag' })).output, 'src/b.js:1:const value = 2; // -flag', 'a query that looks like an option');
		assert.strictEqual((await run('search_files', { query: 'value', path: 'src' })).output.split('\n').length, 2);
		assert.strictEqual((await run('search_files', { query: 'nowhere' })).output, 'No matches.');
		assert.strictEqual((await run('search_files', { query: '(', is_regex: true })).success, false, 'an invalid regex');
	});

	test('fetch_url returns a page\'s text, and only fetches http and https', async () => {
		const server = http.createServer((req, res) => {
			if (req.url === '/page') {
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
				res.end('<html><head><title>Kodia docs</title></head><body><p>Hello <b>world</b></p></body></html>');
			} else {
				res.writeHead(404);
				res.end();
			}
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		try {
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const page = await run('fetch_url', { url: `${base}/page` });
			assert.strictEqual(page.success, true);
			assert.ok(page.output.startsWith(`Kodia docs\n${base}/page\n\n`), page.output);
			assert.match(page.output, /Hello world/);
			assert.match((await run('fetch_url', { url: `${base}/missing` })).output, /404/);
		} finally {
			await new Promise(resolve => server.close(resolve));
		}
		const file = await run('fetch_url', { url: 'file:///etc/passwd' });
		assert.strictEqual(file.success, false);
		assert.match(file.output, /Only http and https/);
		assert.strictEqual(describeKodiaToolCall('fetch_url', JSON.stringify({ url: 'https://example.com' }), ctx.workingDirectory).toolInput, 'https://example.com');
	});

	test('the project memory is kept in .kodia/memory.md, one section at a time', async () => {
		assert.strictEqual((await run('read_project_memory', {})).output, 'This project has no memory yet.');

		assert.strictEqual((await run('write_project_memory', { section: 'Commands', content: 'npm test' })).success, true);
		assert.strictEqual((await run('write_project_memory', { section: 'Pitfalls', content: 'Node 26 breaks mocha.' })).success, true);
		assert.strictEqual((await run('write_project_memory', { section: 'commands', content: 'npm run test-void' })).success, true, 'a section title matches whatever its case');
		const memory = await read('.kodia/memory.md');
		assert.ok(memory.startsWith('<!-- Notes Kodia\'s agent keeps'), memory);
		assert.ok(memory.endsWith('## Commands\nnpm run test-void\n\n## Pitfalls\nNode 26 breaks mocha.\n'), memory);
		assert.match((await run('read_project_memory', {})).output, /## Commands\nnpm run test-void/);

		assert.strictEqual((await run('write_project_memory', { section: 'Pitfalls', content: '' })).success, true, 'empty content deletes the section');
		assert.doesNotMatch(await read('.kodia/memory.md'), /Pitfalls/);

		const tooLong = await run('write_project_memory', { section: 'Everything', content: 'word '.repeat(2_000) });
		assert.strictEqual(tooLong.success, false);
		assert.match(tooLong.output, /over its ~2000-token limit/);
		assert.doesNotMatch(await read('.kodia/memory.md'), /Everything/, 'a refused write saves nothing');

		assert.strictEqual(describeKodiaToolCall('write_project_memory', JSON.stringify({ section: 'Commands' }), ctx.workingDirectory).path, join(dir, '.kodia', 'memory.md'));
	});
});
