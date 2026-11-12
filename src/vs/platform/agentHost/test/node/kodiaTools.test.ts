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
import { DIVIDER, FINAL, ORIGINAL } from '../../../kodia/common/searchReplaceBlocks.js';
import { editorToolNames } from '../../../kodia/common/toolCatalog.js';
import { approvalOfTool, describeKodiaToolCall, editorFunctionTools, editorToolArguments, executeKodiaTool, IKodiaToolContext, KODIA_TOOLS, needsApproval, toolDisplayName } from '../../node/kodia/kodiaTools.js';

const block = (orig: string, final: string) => `${ORIGINAL}\n${orig}\n${DIVIDER}\n${final}\n${FINAL}`;

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
	const exists = (path: string) => fs.promises.access(join(dir, path)).then(() => true, () => false);

	setup(async () => {
		dir = getRandomTestPath(os.tmpdir(), 'kodiaTools');
		await fs.promises.mkdir(dir, { recursive: true });
		ctx = { workingDirectory: URI.file(dir), signal: new AbortController().signal };
	});

	teardown(() => fs.promises.rm(dir, { recursive: true, force: true }));

	test('offers the chat\'s tools that don\'t need the editor, with the chat\'s names and typed parameters', () => {
		assert.deepStrictEqual(KODIA_TOOLS.map(t => t.name), ['read_file', 'ls_dir', 'get_dir_tree', 'search_pathnames_only', 'search_for_files', 'search_in_file', 'create_file_or_folder', 'delete_file_or_folder', 'edit_file', 'rewrite_file', 'run_command', 'fetch_url', 'write_project_memory']);
		const readFile = KODIA_TOOLS.find(t => t.name === 'read_file')!;
		assert.deepStrictEqual(Object.keys((readFile.parametersSchema as { properties: object }).properties), ['uri', 'start_line', 'end_line', 'page_number']);
		assert.deepStrictEqual((readFile.parametersSchema as { required: string[] }).required, ['uri']);
		assert.strictEqual((readFile.parametersSchema as { properties: { start_line: { type: string } } }).properties.start_line.type, 'integer');
		const search = KODIA_TOOLS.find(t => t.name === 'search_for_files')!.parametersSchema as { properties: { is_regex: { type: string } }, required: string[] };
		assert.strictEqual(search.properties.is_regex.type, 'boolean');
		assert.deepStrictEqual(search.required, ['query']);
	});

	test('every tool has a display name, and the ones that change things, run commands or reach the web need approval', () => {
		for (const tool of KODIA_TOOLS) {
			assert.notStrictEqual(toolDisplayName(tool.name), tool.name, tool.name);
		}
		const approvals = Object.fromEntries(KODIA_TOOLS.map(t => [t.name, approvalOfTool(t.name)]));
		assert.deepStrictEqual(approvals, {
			read_file: undefined, ls_dir: undefined, get_dir_tree: undefined, search_pathnames_only: undefined, search_for_files: undefined, search_in_file: undefined,
			create_file_or_folder: 'edits', delete_file_or_folder: 'edits', edit_file: 'edits', rewrite_file: 'edits', write_project_memory: 'edits',
			run_command: 'terminal', fetch_url: 'web pages',
		});
		assert.strictEqual(needsApproval('edit_file'), true);
		assert.strictEqual(needsApproval('read_file'), false);
		assert.strictEqual(needsApproval('an_mcp_tool'), false, 'the agent asks for an MCP tool by its own rule');
	});

	test('offers the editor tools an editor window names, with the chat\'s parameters, and none of them needs approval', () => {
		const tools = editorFunctionTools(['go_to_definition', 'not_a_tool', 'read_lint_errors']);
		assert.deepStrictEqual(tools.map(t => t.name), ['go_to_definition', 'read_lint_errors'], 'a name the agent does not know is not offered');
		assert.deepStrictEqual(editorFunctionTools([]), []);

		const definition = tools[0].parametersSchema as { properties: { [name: string]: { type: string } }, required: string[] };
		assert.deepStrictEqual(Object.keys(definition.properties), ['uri', 'line', 'symbol']);
		assert.deepStrictEqual(definition.required, ['uri', 'line', 'symbol']);
		assert.strictEqual(definition.properties.line.type, 'integer');
		assert.deepStrictEqual((tools[1].parametersSchema as { required: string[] }).required, ['uri']);

		for (const tool of editorFunctionTools(editorToolNames)) {
			assert.notStrictEqual(toolDisplayName(tool.name), tool.name, `${tool.name} has a display name`);
			assert.strictEqual(approvalOfTool(tool.name), undefined, `${tool.name} only reads`);
			assert.strictEqual(needsApproval(tool.name), false);
		}
		assert.deepStrictEqual(editorFunctionTools(editorToolNames).map(t => t.name), ['go_to_definition', 'find_references', 'search_symbols', 'read_lint_errors']);
	});

	test('describes an editor tool call, and makes the path in its arguments absolute for the window that runs it', () => {
		const wd = ctx.workingDirectory;
		const described = (name: string, args: object) => describeKodiaToolCall(name, JSON.stringify(args), wd).invocationMessage;
		assert.strictEqual(described('go_to_definition', { uri: 'src/a.ts', line: 12, symbol: 'a' }), 'Find the definition of "a" in src/a.ts:12');
		assert.strictEqual(described('find_references', { uri: 'src/a.ts', line: '3', symbol: 'a' }), 'Find the references to "a" in src/a.ts:3');
		assert.strictEqual(described('find_references', { uri: 'src/a.ts', symbol: 'a' }), 'Find the references to "a" in src/a.ts');
		assert.strictEqual(described('search_symbols', { query: 'getUser' }), 'Search the symbols for "getUser"');
		assert.strictEqual(described('read_lint_errors', { uri: 'src/a.ts' }), 'Read the lint errors of src/a.ts');

		const absolute = join(dir, 'src', 'a.ts');
		assert.strictEqual(editorToolArguments('{"uri":"src/a.ts","line":12,"symbol":"a"}', wd), JSON.stringify({ uri: absolute, line: 12, symbol: 'a' }), 'a relative path is from the agent\'s working directory, the other arguments stay');
		assert.strictEqual(editorToolArguments(JSON.stringify({ uri: absolute }), wd), JSON.stringify({ uri: absolute }));
		assert.strictEqual(editorToolArguments(JSON.stringify({ uri: URI.file(absolute).toString() }), wd), JSON.stringify({ uri: absolute }), 'a file: URI is a path');
		assert.strictEqual(editorToolArguments('{"query":"getUser"}', wd), '{"query":"getUser"}', 'no path, nothing to make absolute');
		assert.strictEqual(editorToolArguments('{"uri":"  "}', wd), '{"uri":"  "}');
		for (const notArguments of ['not json', '[1]', 'null', '"a.ts"']) {
			assert.strictEqual(editorToolArguments(notArguments, wd), notArguments, 'the window says they are invalid');
		}
	});

	test('read_file reads a file as the chat shows it, a range of its lines, or a page', async () => {
		await write('a.txt', 'one\ntwo\nthree\nfour\nfive');
		const target = join(dir, 'a.txt');
		assert.deepStrictEqual(await run('read_file', { uri: 'a.txt' }), { success: true, output: `${target}\n\`\`\`\none\ntwo\nthree\nfour\nfive\n\`\`\``, path: target });
		assert.strictEqual((await run('read_file', { uri: target, start_line: 2, end_line: 3 })).output, `${target}\n\`\`\`\ntwo\nthree\n\`\`\``);
		assert.strictEqual((await run('read_file', { uri: URI.file(target).toString(), start_line: 4 })).output, `${target}\n\`\`\`\nfour\nfive\n\`\`\``, 'a file: URI, and an open range');
		assert.strictEqual((await run('read_file', { uri: 'a.txt', start_line: 'abc', end_line: '0' })).output, `${target}\n\`\`\`\none\ntwo\nthree\nfour\nfive\n\`\`\``, 'what is no line is ignored');
		assert.match((await run('read_file', { uri: 'missing.txt' })).output, /ENOENT/);
		assert.strictEqual(describeKodiaToolCall('read_file', JSON.stringify({ uri: 'a.txt', start_line: 2, end_line: 3 }), ctx.workingDirectory).invocationMessage, 'Read a.txt, lines 2-3');
	});

	test('reads the numbers and flags the model sends as text, which is how the window offers every parameter', async () => {
		await write('a.txt', 'one\ntwo\nthree\nfour\nfive');
		assert.match((await run('read_file', { uri: 'a.txt', start_line: '2', end_line: ' 3 ' })).output, /\n```\ntwo\nthree\n```$/);

		await write('c.ts', 'function foo() {}\n');
		assert.strictEqual((await run('search_for_files', { query: 'fo+\\(', is_regex: 'true' })).output, join(dir, 'c.ts'));
		assert.strictEqual((await run('search_for_files', { query: 'fo+\\(', is_regex: 'false' })).output, '');

		await write('d/inner.txt', 'x');
		assert.strictEqual((await run('delete_file_or_folder', { uri: 'd', is_recursive: 'true' })).success, true);
		assert.strictEqual(await exists('d'), false);
	});

	test('read_file cuts a large file into pages, and says how to read on', async () => {
		const line = 'x'.repeat(60_000);
		await write('big.txt', `${line}\n${line}\n${line}`);
		const first = (await run('read_file', { uri: 'big.txt' })).output;
		assert.ok(first.endsWith('\n```\n\n(more on next page...)\nMore info because truncated: this file has 3 lines, or 180002 characters.'), first.slice(-120));
		assert.strictEqual(first.length < 100_300, true);
		const last = (await run('read_file', { uri: 'big.txt', page_number: 2 })).output;
		assert.ok(last.endsWith('x\n```'), 'the last page has nothing to say about a next one');
		assert.ok(!last.includes('next page'));
		assert.strictEqual((await run('read_file', { uri: 'big.txt', page_number: 3 })).output, `${join(dir, 'big.txt')}\n\`\`\`\n\n\`\`\``);
	});

	test('ls_dir lists a folder as the chat does, folders first, and pages a long one', async () => {
		await write('src/b.ts', '');
		await write('src/a.ts', '');
		await write('src/inner/c.ts', '');
		const target = join(dir, 'src');
		assert.strictEqual((await run('ls_dir', { uri: 'src' })).output, `${target}\n├── inner/\n├── a.ts\n└── b.ts\n`);
		assert.strictEqual((await run('ls_dir', { uri: '' })).output, `${dir}\n└── src/\n`, 'no folder is the project\'s');

		for (let i = 0; i < 502; i++) { await write(`many/f${String(i).padStart(3, '0')}`, ''); }
		const first = (await run('ls_dir', { uri: 'many' })).output;
		assert.ok(first.endsWith('├── f499\n└── (2 results remaining...)\n'), first.slice(-60));
		assert.strictEqual((await run('ls_dir', { uri: 'many', page_number: '2' })).output, '├── f500\n└── f501\n');
	});

	test('get_dir_tree draws a tree of the folder, without the folders nobody reads', async () => {
		await write('src/app.ts', '');
		await write('src/lib/util.ts', '');
		await write('node_modules/pkg/index.js', '');
		await write('.git/HEAD', '');
		await write('README.md', '');
		assert.strictEqual((await run('get_dir_tree', { uri: '.' })).output, `Directory of ${dir}:\n├── src/\n│   ├── lib/\n│   │   └── util.ts\n│   └── app.ts\n└── README.md\n`);
		assert.strictEqual((await run('get_dir_tree', { uri: 'README.md' })).success, false);
	});

	test('search_pathnames_only and search_for_files look through the project, hidden folders included', async () => {
		await write('src/app.ts', 'const value = 1;\nfunction foo() {}\n');
		await write('src/app.test.ts', 'value\n');
		await write('src/b.js', 'const value = 2; // -flag\n');
		await write('.github/ci.yml', 'value: 3\n');

		assert.strictEqual((await run('search_pathnames_only', { query: 'app' })).output, [join(dir, 'src/app.test.ts'), join(dir, 'src/app.ts')].join('\n'));
		assert.strictEqual((await run('search_pathnames_only', { query: 'CI' })).output, join(dir, '.github/ci.yml'), 'whatever the case');
		assert.strictEqual((await run('search_pathnames_only', { query: 'app', include_pattern: '*.test.ts' })).output, join(dir, 'src/app.test.ts'));
		assert.strictEqual((await run('search_pathnames_only', { query: 'nothing' })).output, '');

		assert.strictEqual((await run('search_for_files', { query: 'value = 1' })).output, join(dir, 'src/app.ts'));
		assert.strictEqual((await run('search_for_files', { query: 'fo+\\(', is_regex: true })).output, join(dir, 'src/app.ts'));
		assert.strictEqual((await run('search_for_files', { query: 'value', search_in_folder: '.github' })).output, join(dir, '.github/ci.yml'));
		assert.strictEqual((await run('search_for_files', { query: '-flag' })).output, join(dir, 'src/b.js'), 'a query that looks like an option');
		assert.strictEqual((await run('search_for_files', { query: 'nowhere' })).output, '');
		assert.strictEqual((await run('search_for_files', { query: '(', is_regex: true })).success, false, 'an invalid regex');
	});

	test('search_in_file gives the lines a text is on, as the chat does', async () => {
		await write('a.ts', 'let a = 1;\nlet b = 2;\nlet A = 3;\n');
		assert.strictEqual((await run('search_in_file', { uri: 'a.ts', query: 'let a' })).output, 'Line 1:\n```\nlet a = 1;\n```');
		assert.strictEqual((await run('search_in_file', { uri: 'a.ts', query: '= [23]', is_regex: true })).output, 'Line 2:\n```\nlet b = 2;\n```\n\nLine 3:\n```\nlet A = 3;\n```');
		assert.strictEqual((await run('search_in_file', { uri: 'a.ts', query: 'zzz' })).output, 'No matches.');
		await write('long.txt', 'hit\n'.repeat(150));
		const cut = (await run('search_in_file', { uri: 'long.txt', query: 'hit' })).output;
		assert.ok(cut.endsWith('(Showing 100 of 150 lines. Use a more specific query to narrow it down.)'), cut.slice(-100));
	});

	test('creates and deletes files and folders', async () => {
		assert.strictEqual((await run('create_file_or_folder', { uri: 'src/deep/new.ts' })).output, `URI ${join(dir, 'src/deep/new.ts')} successfully created.`);
		assert.strictEqual(await read('src/deep/new.ts'), '');
		assert.strictEqual((await run('create_file_or_folder', { uri: 'assets/img/' })).success, true);
		assert.strictEqual((await fs.promises.stat(join(dir, 'assets/img'))).isDirectory(), true);
		const again = await run('create_file_or_folder', { uri: 'src/deep/new.ts' });
		assert.strictEqual(again.success, false, 'a file that is there is not created again');
		assert.match(again.output, /EEXIST/);

		assert.strictEqual((await run('delete_file_or_folder', { uri: 'src/deep/new.ts' })).output, `URI ${join(dir, 'src/deep/new.ts')} successfully deleted.`);
		assert.strictEqual(await exists('src/deep/new.ts'), false);
		const notEmpty = await run('delete_file_or_folder', { uri: 'src' });
		assert.strictEqual(notEmpty.success, false, 'a folder needs is_recursive');
		assert.strictEqual(await exists('src/deep'), true);
		assert.strictEqual((await run('delete_file_or_folder', { uri: 'src', is_recursive: true })).success, true);
		assert.strictEqual(await exists('src'), false);
	});

	test('edit_file applies SEARCH/REPLACE blocks, as the chat does, and tells the model what is wrong with them', async () => {
		await write('a.ts', 'let a = 1;\nlet b = 1;\nlet c = 1;\n');
		const target = join(dir, 'a.ts');
		assert.deepStrictEqual(await run('edit_file', { uri: 'a.ts', search_replace_blocks: block('let a = 1;', 'let a = 2;') }), { success: true, output: `Change successfully made to ${target}.`, didWrite: true, path: target });
		assert.strictEqual(await read('a.ts'), 'let a = 2;\nlet b = 1;\nlet c = 1;\n');

		// several blocks in one call
		await run('edit_file', { uri: 'a.ts', search_replace_blocks: `${block('let c = 1;', 'let c = 3;')}\n${block('let b = 1;', 'let b = 2;')}` });
		assert.strictEqual(await read('a.ts'), 'let a = 2;\nlet b = 2;\nlet c = 3;\n');

		const missing = await run('edit_file', { uri: 'a.ts', search_replace_blocks: block('let z = 1;', 'x') });
		assert.strictEqual(missing.success, false);
		assert.match(missing.output, /there was no match for/);
		assert.strictEqual((await run('edit_file', { uri: 'a.ts', search_replace_blocks: 'just words' })).output, 'No Search/Replace blocks were received!');
		assert.strictEqual((await run('edit_file', { uri: 'missing.ts', search_replace_blocks: block('a', 'b') })).success, false);
		assert.strictEqual(await read('a.ts'), 'let a = 2;\nlet b = 2;\nlet c = 3;\n', 'a refused edit changes nothing');

		// the agent can't show a diff to review: an ORIGINAL that is on several lines is refused, not put on the first
		await write('dup.ts', 'x = 1;\nmid\nx = 1;\n');
		const ambiguous = await run('edit_file', { uri: 'dup.ts', search_replace_blocks: block('x = 1;', 'x = 2;') });
		assert.strictEqual(ambiguous.success, false);
		assert.match(ambiguous.output, /appears multiple times/);
		assert.strictEqual(await read('dup.ts'), 'x = 1;\nmid\nx = 1;\n');
		assert.strictEqual((await run('edit_file', { uri: 'dup.ts', search_replace_blocks: block('x = 1;\nmid', 'x = 2;\nmid') })).success, true, 'with enough context, it has one place');
	});

	test('edit_file keeps a file\'s CRLF line endings', async () => {
		await write('w.ts', 'one\r\ntwo\r\nthree\r\n');
		assert.strictEqual((await run('edit_file', { uri: 'w.ts', search_replace_blocks: block('one\ntwo', 'one\n$& 2') })).success, true);
		assert.strictEqual(await read('w.ts'), 'one\r\n$& 2\r\nthree\r\n');
	});

	test('rewrite_file replaces a file, or makes it with its folders', async () => {
		await write('a.txt', 'old');
		assert.strictEqual((await run('rewrite_file', { uri: 'a.txt', new_content: 'new' })).output, `Change successfully made to ${join(dir, 'a.txt')}.`);
		assert.strictEqual(await read('a.txt'), 'new');
		assert.strictEqual((await run('rewrite_file', { uri: 'deep/er/b.txt', new_content: 'made' })).success, true);
		assert.strictEqual(await read('deep/er/b.txt'), 'made');
		assert.strictEqual(describeKodiaToolCall('rewrite_file', JSON.stringify({ uri: 'a.txt' }), ctx.workingDirectory).path, join(dir, 'a.txt'));
	});

	test('run_command runs in the project or a folder of it, and ends with the exit code, as in the chat', async () => {
		await write('sub/marker.txt', '');
		assert.strictEqual((await run('run_command', { command: 'echo hi' })).output, 'hi\n(exit code 0)');
		assert.strictEqual((await run('run_command', { command: 'ls', cwd: 'sub' })).output, 'marker.txt\n(exit code 0)');
		const failed = await run('run_command', { command: 'echo oops >&2; exit 3' });
		assert.deepStrictEqual([failed.success, failed.output], [false, '[stderr]\noops\n(exit code 3)']);
		assert.strictEqual((await run('run_command', { command: '' })).success, false);
		const description = describeKodiaToolCall('run_command', JSON.stringify({ command: 'npm test' }), ctx.workingDirectory);
		assert.deepStrictEqual([description.invocationMessage, description.toolInput], ['npm test', 'npm test']);
	});

	test('fetch_url returns a page\'s text as the chat shows it, and only fetches http and https', async () => {
		const server = http.createServer((req, res) => {
			if (req.url === '/page') {
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
				res.end('<html><head><title>Kodia docs</title></head><body><p>Hello <b>world</b></p></body></html>');
			} else if (req.url === '/old') {
				res.writeHead(301, { location: '/page' });
				res.end();
			} else if (req.url === '/long') {
				res.writeHead(200, { 'content-type': 'text/plain' });
				res.end('x'.repeat(150_000));
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
			assert.match((await run('fetch_url', { url: `${base}/old` })).output, new RegExp(`^Kodia docs\\n${base}/page \\(redirected from ${base}/old\\)`));
			assert.match((await run('fetch_url', { url: `${base}/missing` })).output, /404/);

			const long = (await run('fetch_url', { url: `${base}/long` })).output;
			assert.ok(long.endsWith('\n\n(more on next page...)\nMore info because truncated: this page has 150000 characters.'), long.slice(-120));
			const second = (await run('fetch_url', { url: `${base}/long`, page_number: '2' })).output;
			assert.ok(!second.includes('next page') && second.length < 50_300, second.slice(-80));
		} finally {
			await new Promise(resolve => server.close(resolve));
		}
		const file = await run('fetch_url', { url: 'file:///etc/passwd' });
		assert.strictEqual(file.success, false);
		assert.match(file.output, /Only http and https/);
		assert.strictEqual(describeKodiaToolCall('fetch_url', JSON.stringify({ url: 'https://example.com' }), ctx.workingDirectory).toolInput, 'https://example.com');
	});

	test('write_project_memory keeps the notes in .kodia/memory.md, one section at a time', async () => {
		const first = await run('write_project_memory', { section: 'Commands', content: 'npm test' });
		assert.strictEqual(first.success, true);
		assert.match(first.output, /^Section "Commands" saved\. The project memory is now \d+ tokens\.$/);
		assert.strictEqual((await run('write_project_memory', { section: 'Pitfalls', content: 'Node 26 breaks mocha.' })).success, true);
		assert.strictEqual((await run('write_project_memory', { section: 'commands', content: 'npm run test-void' })).success, true, 'a section title matches whatever its case');
		const memory = await read('.kodia/memory.md');
		assert.ok(memory.startsWith('<!-- Notes Kodia\'s agent keeps'), memory);
		assert.ok(memory.endsWith('## Commands\nnpm run test-void\n\n## Pitfalls\nNode 26 breaks mocha.\n'), memory);

		assert.match((await run('write_project_memory', { section: 'Pitfalls', content: '' })).output, /^Section "Pitfalls" deleted\./, 'empty content deletes the section');
		assert.doesNotMatch(await read('.kodia/memory.md'), /Pitfalls/);

		const tooLong = await run('write_project_memory', { section: 'Everything', content: 'word '.repeat(2_000) });
		assert.strictEqual(tooLong.success, false);
		assert.match(tooLong.output, /over its ~2000-token limit/);
		assert.doesNotMatch(await read('.kodia/memory.md'), /Everything/, 'a refused write saves nothing');

		const near = await run('write_project_memory', { section: 'Architecture', content: 'a '.repeat(3_300) });
		assert.match(near.output, /That's close to the ~2000-token limit/);
		assert.strictEqual(describeKodiaToolCall('write_project_memory', JSON.stringify({ section: 'Commands' }), ctx.workingDirectory).path, join(dir, '.kodia', 'memory.md'));
	});

	test('an unknown tool, and arguments that aren\'t JSON, are reported', async () => {
		assert.deepStrictEqual(await run('read_project_memory', {}), { success: false, output: 'Unknown tool: read_project_memory' });
		assert.deepStrictEqual(await executeKodiaTool('read_file', '{not json', ctx), { success: false, output: 'Invalid JSON arguments for tool "read_file".' });
	});
});
