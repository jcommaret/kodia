/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { promisify } from 'util';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getRandomTestPath } from '../../../../base/test/node/testUtils.js';
import { approvalOfTool, describeKodiaToolCall, executeKodiaTool, IKodiaToolContext, toolDisplayName } from '../../node/kodia/kodiaTools.js';
import { GIT_FUNCTION_TOOLS, gitToolNames } from '../../node/kodia/kodiaGitTools.js';

const execFileAsync = promisify(cp.execFile);

suite('Kodia agent git tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	let ctx: IKodiaToolContext;
	const run = (name: string, args: object = {}) => executeKodiaTool(name, JSON.stringify(args), ctx);
	// the user's own git configuration (a signing key, a hook path) has no say in a test
	const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com' };
	const git = (...args: string[]) => execFileAsync('git', args, { cwd: dir, env: gitEnv });
	const write = (name: string, content: string) => fs.promises.writeFile(join(dir, name), content);

	setup(async () => {
		dir = getRandomTestPath(os.tmpdir(), 'kodiaGitTools');
		await fs.promises.mkdir(dir, { recursive: true });
		ctx = { workingDirectory: URI.file(dir), signal: new AbortController().signal };
		await git('init', '--quiet');
		await git('symbolic-ref', 'HEAD', 'refs/heads/main');
		await write('a.txt', 'one\n');
		await write('b.txt', 'bee\n');
		await git('add', '.');
		await git('commit', '--quiet', '-m', 'first');
		await write('a.txt', 'one\ntwo\n');
		await git('commit', '--quiet', '-am', 'second: two');
		// then: a.txt changed, c.txt staged, d.txt not tracked
		await write('a.txt', 'one\ntwo\nthree\n');
		await write('c.txt', 'sea\n');
		await git('add', 'c.txt');
		await write('d.txt', 'dee\n');
	});

	teardown(() => fs.promises.rm(dir, { recursive: true, force: true }));

	test('offers the git tools with typed parameters, and none of them needs approval', () => {
		assert.deepStrictEqual(GIT_FUNCTION_TOOLS.map(t => t.name), ['git_status', 'git_diff', 'git_log', 'git_show']);
		const schema = (name: string) => GIT_FUNCTION_TOOLS.find(t => t.name === name)!.parametersSchema as { properties: { [p: string]: { type: string } }, required: string[] };
		assert.deepStrictEqual(Object.keys(schema('git_status').properties), []);
		assert.strictEqual(schema('git_diff').properties.staged.type, 'boolean');
		assert.strictEqual(schema('git_log').properties.max_count.type, 'integer');
		assert.deepStrictEqual(schema('git_show').required, ['ref']);
		for (const name of gitToolNames) {
			assert.strictEqual(approvalOfTool(name), undefined, name);
			assert.notStrictEqual(toolDisplayName(name), name, name);
		}
	});

	test('describes a git tool call', () => {
		const root = URI.file(dir);
		const describe = (name: string, args: object) => describeKodiaToolCall(name, JSON.stringify(args), root).invocationMessage;
		assert.strictEqual(describe('git_status', {}), 'Check the git status');
		assert.strictEqual(describe('git_diff', {}), 'Show the changes');
		assert.strictEqual(describe('git_diff', { staged: true, uri: 'a.txt' }), 'Show the staged changes of a.txt');
		assert.strictEqual(describe('git_diff', { base: 'main', stat_only: true }), 'Show the files of the changes since main');
		assert.strictEqual(describe('git_log', { ref: 'main', search: 'fix' }), 'Show the git log from main mentioning "fix"');
		assert.strictEqual(describe('git_show', { ref: 'HEAD~1', uri: 'a.txt' }), 'Show the commit HEAD~1 in a.txt');
	});

	test('git_status gives the branch, and the files that changed, staged or not', async () => {
		const { success, output } = await run('git_status');
		assert.strictEqual(success, true);
		assert.deepStrictEqual(output.split('\n').sort(), ['## main', ' M a.txt', '?? d.txt', 'A  c.txt'].sort());
	});

	test('git_diff shows what is not staged, what is, or what differs from a commit', async () => {
		const unstaged = (await run('git_diff')).output;
		assert.ok(unstaged.includes('+three'), unstaged);
		assert.ok(!unstaged.includes('c.txt'), unstaged);

		const staged = (await run('git_diff', { staged: true })).output;
		assert.ok(staged.includes('+++ b/c.txt') && staged.includes('+sea'), staged);
		assert.ok(!staged.includes('a.txt'), staged);

		const sinceFirst = (await run('git_diff', { base: 'HEAD~1' })).output;
		assert.ok(sinceFirst.includes('+two') && sinceFirst.includes('+three') && sinceFirst.includes('c.txt'), sinceFirst);
	});

	test('git_diff can list the files only, or look at one file, and says when there is nothing', async () => {
		const stat = (await run('git_diff', { base: 'HEAD', stat_only: true })).output;
		assert.ok(/a\.txt \| 1 \+/.test(stat) && /c\.txt \| 1 \+/.test(stat) && !stat.includes('+three'), stat);

		const one = (await run('git_diff', { base: 'HEAD', uri: 'c.txt' })).output;
		assert.ok(one.includes('c.txt') && !one.includes('a.txt'), one);
		// the model may give an absolute path
		assert.ok((await run('git_diff', { base: 'HEAD', uri: join(dir, 'c.txt') })).output.includes('+sea'));

		await git('add', '-A');
		await git('commit', '--quiet', '-m', 'third');
		assert.deepStrictEqual(await run('git_diff'), { success: true, output: 'No changes that are not staged.' });
		assert.deepStrictEqual(await run('git_diff', { staged: true }), { success: true, output: 'No staged changes.' });
		assert.deepStrictEqual(await run('git_diff', { base: 'HEAD' }), { success: true, output: 'No difference with HEAD.' });
	});

	test('reads the flags and numbers that the window sends as text', async () => {
		assert.ok((await run('git_diff', { staged: 'true' })).output.includes('+sea'));
		assert.strictEqual((await run('git_log', { max_count: '1' })).output.split('\n').length, 1);
	});

	test('git_log lists the commits newest first, as many as asked, for a file, or with a word in the message', async () => {
		const all = (await run('git_log')).output.split('\n');
		assert.strictEqual(all.length, 2);
		assert.match(all[0], /^[0-9a-f]{7,} \d{4}-\d{2}-\d{2} Ada: second: two$/);
		assert.match(all[1], /^[0-9a-f]{7,} \d{4}-\d{2}-\d{2} Ada: first$/);

		assert.strictEqual((await run('git_log', { max_count: 1 })).output.split('\n').length, 1);
		assert.match((await run('git_log', { search: 'TWO' })).output, /Ada: second: two$/);
		assert.match((await run('git_log', { uri: 'b.txt' })).output, /Ada: first$/);
		assert.strictEqual((await run('git_log', { uri: 'b.txt' })).output.split('\n').length, 1);
		assert.match((await run('git_log', { ref: 'HEAD~1' })).output, /Ada: first$/);
		assert.deepStrictEqual(await run('git_log', { search: 'nothing like this' }), { success: true, output: 'No commits.' });
	});

	test('git_show gives a commit\'s message and its changes, or its files only', async () => {
		const show = (await run('git_show', { ref: 'HEAD' })).output;
		assert.ok(/^commit [0-9a-f]{40}\nAuthor: Ada\nDate: {3}\d{4}-\d{2}-\d{2}\n\nsecond: two/.test(show), show);
		assert.ok(show.includes('+two'), show);

		const stat = (await run('git_show', { ref: 'HEAD~1', stat_only: true })).output;
		assert.ok(stat.includes('a.txt') && stat.includes('b.txt') && !stat.includes('+one'), stat);

		assert.deepStrictEqual(await run('git_show', {}), { success: false, output: 'Missing "ref".' });
	});

	test('says what git says when it can\'t answer', async () => {
		const unknown = await run('git_show', { ref: 'no-such-commit' });
		assert.strictEqual(unknown.success, false);
		assert.ok(/unknown revision|bad revision|ambiguous argument/i.test(unknown.output), unknown.output);

		const elsewhere = await executeKodiaTool('git_status', '{}', { ...ctx, workingDirectory: URI.file(os.tmpdir()) });
		assert.strictEqual(elsewhere.success, false);
		assert.ok(/not a git repository/i.test(elsewhere.output), elsewhere.output);
	});

	test('does not take a ref for an option, which could write a file', async () => {
		for (const [name, args] of [['git_diff', { base: `--output=${join(dir, 'out.txt')}` }], ['git_log', { ref: `--output=${join(dir, 'out.txt')}` }], ['git_show', { ref: `--output=${join(dir, 'out.txt')}` }], ['git_show', { ref: 'HEAD HEAD' }]] as const) {
			const result = await run(name, args);
			assert.strictEqual(result.success, false, name);
		}
		assert.strictEqual(await fs.promises.access(join(dir, 'out.txt')).then(() => true, () => false), false);
	});

	test('does not run what the repository\'s configuration names to run', async function () {
		if (process.platform === 'win32') {
			return this.skip();
		}
		const marker = join(dir, 'fsmonitor-ran');
		await git('config', 'core.fsmonitor', `touch ${marker} #`);

		// git does run it, unless it is told not to: without that, this test shows nothing
		await git('status', '--short').catch(() => undefined);
		if (!await fs.promises.access(marker).then(() => true, () => false)) {
			return this.skip();
		}
		await fs.promises.rm(marker);

		assert.strictEqual((await run('git_status')).success, true);
		assert.strictEqual(await fs.promises.access(marker).then(() => true, () => false), false);
	});

	test('cuts a diff that is too long, and says how to narrow it down', async () => {
		await write('big.txt', 'x'.repeat(60) + '\n');
		await git('add', 'big.txt');
		await git('commit', '--quiet', '-m', 'big');
		await write('big.txt', Array.from({ length: 4000 }, (_, i) => `line ${i} ${'y'.repeat(40)}`).join('\n') + '\n');
		const { success, output } = await run('git_diff', { uri: 'big.txt' });
		assert.strictEqual(success, true);
		assert.ok(output.length < 101_000 && output.includes('(The output is cut here.'), output.slice(-200));
		assert.ok(output.includes('stat_only'));
	});
});
