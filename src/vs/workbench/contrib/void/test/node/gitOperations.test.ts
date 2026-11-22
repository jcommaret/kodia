/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 2 / acceptance scenario 6 (Git safety) against REAL repositories: the agent's GitOperations running through
 * KodiaGitMainService (the main-process runner production uses: execFile, no shell) on fresh temp repos.
 */

import assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitRunRequest, validateGitRunRequest } from '../../common/gitService.js';
import { GitOperations } from '../../common/gitOperations.js';
import { KodiaGitMainService } from '../../electron-main/kodiaGitMainService.js';

const gitRaw = (cwd: string, ...args: string[]) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

suite('Kodia - git operations on real repositories (scenario 6)', function () {
	this.timeout(60_000);

	let tmp: string;
	let repo: string;
	const calls: GitRunRequest[] = [];
	const main = new KodiaGitMainService();
	const ops = new GitOperations(req => { calls.push(req); return main.run(req); });
	const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
	const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');

	setup(() => {
		calls.length = 0;
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-git-')));
		repo = path.join(tmp, 'repo');
		fs.mkdirSync(repo);
		gitRaw(repo, 'init', '-q', '-b', 'main');
		gitRaw(repo, 'config', 'user.name', 'Kodia Test');
		gitRaw(repo, 'config', 'user.email', 'kodia@example.invalid');
		gitRaw(repo, 'config', 'commit.gpgsign', 'false');
		gitRaw(repo, 'config', 'core.autocrlf', 'false'); // independent of the developer's global line-ending setting
		write('README.md', 'line one\nline two\n');
		write('user.txt', 'user v1\n');
		gitRaw(repo, 'add', '.');
		gitRaw(repo, 'commit', '-q', '-m', 'initial');
	});
	teardown(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

	test('repository root, and null outside a repository', async () => {
		assert.strictEqual(path.resolve((await ops.repositoryRoot(path.join(repo)))!).toLowerCase(), path.resolve(repo).toLowerCase());
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-nogit-'));
		try { assert.strictEqual(await ops.repositoryRoot(outside), null); } finally { fs.rmSync(outside, { recursive: true, force: true }); }
	});

	test('status reports staged, unstaged, untracked, renames and the branch from the real repository', async () => {
		write('README.md', 'line one\nline TWO\n');
		write('new file.txt', 'hello\n');
		gitRaw(repo, 'mv', 'user.txt', 'renamed user.txt');
		const s = await ops.status(repo);
		assert.strictEqual(s.branch, 'main');
		assert.deepStrictEqual(s.unstaged.map(f => `${f.status}:${f.uri}`), ['modified:README.md']);
		assert.deepStrictEqual(s.staged.map(f => `${f.status}:${f.uri}`), ['renamed:renamed user.txt']);
		assert.deepStrictEqual(s.untracked.map(f => f.uri), ['new file.txt']);
		assert.strictEqual(s.mergeInProgress, false);
	});

	test('diff returns real hunks (not placeholders), staged and unstaged separately', async () => {
		write('README.md', 'line one\nline TWO\nline three\n');
		const unstaged = await ops.diff(repo);
		assert.strictEqual(unstaged.files.length, 1);
		const f = unstaged.files[0];
		assert.deepStrictEqual([f.uri, f.status, f.insertions, f.deletions], ['README.md', 'modified', 2, 1]);
		assert.match(f.hunks[0].header, /^@@ -1,2 \+1,3 @@/);
		assert.ok(f.hunks[0].body.includes('-line two') && f.hunks[0].body.includes('+line TWO') && f.hunks[0].body.includes('+line three'), f.hunks[0].body);
		assert.strictEqual((await ops.diff(repo, { staged: true })).files.length, 0, 'nothing staged yet');
		gitRaw(repo, 'add', 'README.md');
		assert.strictEqual((await ops.diff(repo, { staged: true })).files[0].uri, 'README.md');
		write('added.txt', 'x\n'); gitRaw(repo, 'add', 'added.txt');
		assert.strictEqual((await ops.diff(repo, { staged: true })).files.find(x => x.uri === 'added.txt')?.status, 'added');
	});

	test('SAFETY: agent branch + commit never touches the user\'s unrelated uncommitted work', async () => {
		write('user.txt', 'user v2 — unsaved work in progress\n'); // the user's own, uncommitted
		const userBefore = read('user.txt');

		await ops.createBranch(repo, 'feature/agent-work');
		await ops.switchBranch(repo, 'feature/agent-work');
		write('src/agent.ts', 'export const x = 1;\n');
		await ops.stage(repo, ['src/agent.ts']);
		const message = 'Add agent file: "quoted", $HOME, `whoami`; echo pwned > pwned.txt & del user.txt';
		const { commitHash } = await ops.commit(repo, message);

		// the message is stored verbatim and none of it ran
		assert.strictEqual(gitRaw(repo, 'log', '-1', '--format=%B').trim(), message);
		assert.strictEqual(fs.existsSync(path.join(repo, 'pwned.txt')), false, 'no shell interpreted the message');
		assert.strictEqual(commitHash, gitRaw(repo, 'rev-parse', 'HEAD').trim());
		// only the agent's file is in the commit
		assert.deepStrictEqual(gitRaw(repo, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['src/agent.ts']);
		// the user's change is still there, unstaged, byte for byte
		assert.strictEqual(read('user.txt'), userBefore);
		const s = await ops.status(repo);
		assert.deepStrictEqual(s.unstaged.map(f => f.uri), ['user.txt']);
		assert.strictEqual(s.branch, 'feature/agent-work');
		const { branches, current } = await ops.branches(repo);
		assert.strictEqual(current, 'feature/agent-work');
		assert.deepStrictEqual(branches.filter(b => !b.isRemote).map(b => b.name).sort(), ['feature/agent-work', 'main']);
	});

	test('SAFETY: switching away when it would overwrite uncommitted work is refused, and the work is kept', async () => {
		await ops.createBranch(repo, 'other');
		await ops.switchBranch(repo, 'other');
		write('README.md', 'changed on other\n'); gitRaw(repo, 'commit', '-qam', 'other change');
		await ops.switchBranch(repo, 'main');
		write('README.md', 'my uncommitted edit\n');
		await assert.rejects(ops.switchBranch(repo, 'other'), /git switch failed \(exit code \d+\):.*(overwritten|Please commit)/s);
		assert.strictEqual(read('README.md'), 'my uncommitted edit\n');
		assert.strictEqual((await ops.status(repo)).branch, 'main');
	});

	test('failures are errors with git\'s own message, never reported as success', async () => {
		await assert.rejects(ops.commit(repo, 'nothing staged'), /git commit failed \(exit code 1\):.*nothing/s);
		await assert.rejects(ops.switchBranch(repo, 'does-not-exist'), /git switch failed/);
		await assert.rejects(ops.createBranch(repo, 'main'), /git branch failed.*already exists/s);
		await assert.rejects(ops.createBranch(repo, 'bad..name'), /check-ref-format failed/);
		await assert.rejects(ops.stage(repo, ['missing-file.txt']), /git add failed/);
		await assert.rejects(ops.commit(repo, '   '), /commit message is required/);
	});

	test('option and refspec injection is refused before git runs', async () => {
		const before = calls.length;
		await assert.rejects(ops.createBranch(repo, '--help'), /must not .* start with "-"/);
		await assert.rejects(ops.switchBranch(repo, '-f'), /must not .* start with "-"/);
		await assert.rejects(ops.push(repo, 'origin', ':main'), /refspecs/);
		await assert.rejects(ops.push(repo, 'origin', '+main'), /refspecs/);
		await assert.rejects(ops.diff(repo, { ref: '--output=/tmp/x' }), /must not .* start with "-"/);
		assert.strictEqual(calls.length, before, 'git was never invoked');
	});

	test('merge conflicts are reported (merge in progress + conflicted files), not hidden', async () => {
		await ops.createBranch(repo, 'theirs');
		await ops.switchBranch(repo, 'theirs');
		write('README.md', 'theirs\n'); gitRaw(repo, 'commit', '-qam', 'theirs');
		await ops.switchBranch(repo, 'main');
		write('README.md', 'ours\n'); gitRaw(repo, 'commit', '-qam', 'ours');
		const r = await ops.merge(repo, 'theirs');
		assert.strictEqual(r.mergeInProgress, true);
		assert.deepStrictEqual(r.conflicted, ['README.md']);
		const s = await ops.status(repo);
		assert.strictEqual(s.mergeInProgress, true);
		assert.deepStrictEqual(s.conflicted.map(c => c.uri), ['README.md']);
	});

	test('a clean merge is not reported as in progress', async () => {
		await ops.createBranch(repo, 'side');
		await ops.switchBranch(repo, 'side');
		write('side.txt', 's\n'); await ops.stage(repo, ['side.txt']); await ops.commit(repo, 'side');
		await ops.switchBranch(repo, 'main');
		const r = await ops.merge(repo, 'side');
		assert.strictEqual(r.mergeInProgress, false);
		assert.deepStrictEqual(r.conflicted, []);
	});

	test('stash and pop round-trip, including untracked files', async () => {
		write('README.md', 'wip\n'); write('scratch.txt', 'untracked wip\n');
		await ops.stash(repo, 'agent: park work');
		assert.strictEqual(read('README.md'), 'line one\nline two\n');
		assert.strictEqual(fs.existsSync(path.join(repo, 'scratch.txt')), false);
		await ops.stashPop(repo);
		assert.strictEqual(read('README.md'), 'wip\n');
		assert.strictEqual(read('scratch.txt'), 'untracked wip\n');
	});

	test('log, show and paths with spaces', async () => {
		write('dir with space/a b.txt', 'x\n');
		await ops.stage(repo, ['dir with space/a b.txt']);
		await ops.commit(repo, 'Add a file\n\nWith a body.');
		const { commits } = await ops.log(repo, { maxCount: 5 });
		assert.deepStrictEqual(commits.map(c => c.message), ['Add a file', 'initial']);
		assert.strictEqual(commits[0].parents[0], commits[1].hash);
		assert.match(commits[0].authorDate, /^\d{4}-\d\d-\d\dT/);
		const shown = await ops.show(repo, commits[0].hash);
		assert.strictEqual(shown.commit, commits[0].hash);
		assert.strictEqual(shown.message, 'Add a file\n\nWith a body.');
		assert.ok(shown.diff.includes('+x'));
		assert.deepStrictEqual((await ops.log(repo, { path: 'README.md' })).commits.map(c => c.message), ['initial']);
	});

	test('unstage keeps the working tree, also before the first commit', async () => {
		write('README.md', 'staged edit\n'); await ops.stage(repo, ['README.md']);
		await ops.unstage(repo, ['README.md']);
		assert.strictEqual((await ops.diff(repo, { staged: true })).files.length, 0);
		assert.strictEqual(read('README.md'), 'staged edit\n');
		const fresh = path.join(tmp, 'fresh'); fs.mkdirSync(fresh); gitRaw(fresh, 'init', '-q');
		fs.writeFileSync(path.join(fresh, 'a.txt'), 'a\n');
		await ops.stage(fresh, ['a.txt']);
		await ops.unstage(fresh, ['a.txt']);
		assert.deepStrictEqual((await ops.status(fresh)).untracked.map(f => f.uri), ['a.txt']);
		assert.deepStrictEqual((await ops.log(fresh)).commits, [], 'no commits yet is not an error');
	});

	test('push and fetch against a real (bare) remote; force push uses --force-with-lease', async () => {
		const remote = path.join(tmp, 'remote.git');
		gitRaw(tmp, 'init', '-q', '--bare', remote);
		gitRaw(repo, 'remote', 'add', 'origin', remote);
		await ops.push(repo, 'origin', 'main');
		assert.strictEqual(gitRaw(remote, 'rev-parse', 'main').trim(), gitRaw(repo, 'rev-parse', 'HEAD').trim());
		await ops.fetch(repo, 'origin');
		const { branches } = await ops.branches(repo);
		assert.ok(branches.some(b => b.isRemote && b.name === 'origin/main'));

		calls.length = 0;
		gitRaw(repo, 'commit', '-q', '--amend', '-m', 'rewritten');
		await ops.push(repo, 'origin', 'main', true);
		assert.ok(calls.some(c => c.args.includes('--force-with-lease')) && !calls.some(c => c.args.includes('--force')), 'never a blind --force');
		assert.strictEqual(gitRaw(remote, 'log', '-1', '--format=%s', 'main').trim(), 'rewritten');
	});

	test('main-process request validation (IPC boundary)', () => {
		assert.throws(() => validateGitRunRequest({ cwd: 'relative/dir', args: ['status'] }), /absolute/);
		assert.throws(() => validateGitRunRequest({ cwd: repo, args: ['config', 'core.sshCommand', 'calc'] }), /not an allowed git subcommand/);
		assert.throws(() => validateGitRunRequest({ cwd: repo, args: ['-c', 'core.sshCommand=calc', 'fetch'] }), /-c core\.sshCommand=calc is not allowed/);
		assert.throws(() => validateGitRunRequest({ cwd: repo, args: ['status', 'a\0b'] }), /non-empty strings/);
		assert.throws(() => validateGitRunRequest({ cwd: repo, args: [] }), /non-empty strings/);
		assert.deepStrictEqual(validateGitRunRequest({ cwd: repo, args: ['-c', 'core.quotepath=false', 'status'] }).args, ['-c', 'core.quotepath=false', 'status']);
		// action-level limits for the newer subcommands
		assert.throws(() => validateGitRunRequest({ cwd: repo, args: ['remote', 'add', 'x', 'https://example.invalid'] }), /not allowed/);
		assert.throws(() => validateGitRunRequest({ cwd: repo, args: ['worktree', 'remove', 'x'] }), /not allowed/);
		assert.throws(() => validateGitRunRequest({ cwd: repo, args: ['rebase', '-i', 'main'] }), /interactive rebase/);
		assert.throws(() => validateGitRunRequest({ cwd: repo, args: ['rebase', '--exec=calc', 'main'] }), /interactive rebase/);
		assert.doesNotThrow(() => validateGitRunRequest({ cwd: repo, args: ['worktree', 'list', '--porcelain'] }));
	});

	// ---- history operations, tags, remotes, worktrees (roadmap 2, part K) ----

	const conflictingBranch = () => {
		gitRaw(repo, 'switch', '-q', '-c', 'theirs');
		write('README.md', 'theirs\n'); gitRaw(repo, 'commit', '-qam', 'theirs change');
		const theirs = gitRaw(repo, 'rev-parse', 'HEAD').trim();
		gitRaw(repo, 'switch', '-q', 'main');
		write('README.md', 'ours\n'); gitRaw(repo, 'commit', '-qam', 'ours change');
		return theirs;
	};

	test('revert creates an undo commit; the file is back on disk', async () => {
		write('README.md', 'broken\n'); gitRaw(repo, 'commit', '-qam', 'break it');
		const r = await ops.revert(repo, 'HEAD');
		assert.strictEqual(r.inProgress, null);
		assert.strictEqual(read('README.md'), 'line one\nline two\n');
		assert.match(gitRaw(repo, 'log', '-1', '--format=%s'), /Revert "break it"/);
		assert.strictEqual(r.head, gitRaw(repo, 'rev-parse', 'HEAD').trim());
	});

	test('cherry-pick conflict is reported, then continue after resolving finishes it', async () => {
		const theirs = conflictingBranch();
		const r = await ops.cherryPick(repo, theirs);
		assert.strictEqual(r.inProgress, 'cherry-pick');
		assert.deepStrictEqual(r.conflicted, ['README.md']);
		assert.strictEqual((await ops.status(repo)).operationInProgress, 'cherry-pick');
		await assert.rejects(ops.continueOperation(repo), /still have conflicts/);
		write('README.md', 'resolved\n'); await ops.stage(repo, ['README.md']);
		const c = await ops.continueOperation(repo);
		assert.strictEqual(c.operation, 'cherry-pick');
		assert.strictEqual(c.inProgress, null);
		assert.strictEqual((await ops.status(repo)).operationInProgress, null);
		assert.strictEqual(gitRaw(repo, 'log', '-1', '--format=%s').trim(), 'theirs change');
		assert.strictEqual(read('README.md'), 'resolved\n');
	});

	test('rebase conflict is reported, and abort restores the branch exactly', async () => {
		conflictingBranch();
		const before = gitRaw(repo, 'rev-parse', 'HEAD').trim();
		const r = await ops.rebase(repo, 'theirs');
		assert.strictEqual(r.inProgress, 'rebase');
		assert.deepStrictEqual(r.conflicted, ['README.md']);
		const a = await ops.abortOperation(repo);
		assert.strictEqual(a.operation, 'rebase');
		assert.strictEqual(gitRaw(repo, 'rev-parse', 'HEAD').trim(), before);
		assert.strictEqual(read('README.md'), 'ours\n');
		assert.strictEqual((await ops.status(repo)).operationInProgress, null);
		await assert.rejects(ops.abortOperation(repo), /No merge, revert, cherry-pick or rebase is in progress/);
	});

	test('a clean rebase moves the branch on top of the other branch', async () => {
		gitRaw(repo, 'switch', '-q', '-c', 'feature');
		write('feature.txt', 'f\n'); gitRaw(repo, 'add', '.'); gitRaw(repo, 'commit', '-qm', 'feature');
		gitRaw(repo, 'switch', '-q', 'main');
		write('main.txt', 'm\n'); gitRaw(repo, 'add', '.'); gitRaw(repo, 'commit', '-qm', 'main moves');
		gitRaw(repo, 'switch', '-q', 'feature');
		const r = await ops.rebase(repo, 'main');
		assert.strictEqual(r.inProgress, null);
		assert.deepStrictEqual(gitRaw(repo, 'log', '--format=%s', '-3').trim().split('\n'), ['feature', 'main moves', 'initial']);
	});

	test('SAFETY: hard reset is refused while uncommitted work exists, and the work is kept', async () => {
		write('README.md', 'commit 2\n'); gitRaw(repo, 'commit', '-qam', 'second');
		write('user.txt', 'user draft, never committed\n');
		await assert.rejects(ops.reset(repo, 'HEAD~1', 'hard'), /Refusing a hard reset: .*user\.txt/);
		assert.strictEqual(read('user.txt'), 'user draft, never committed\n');
		assert.strictEqual(gitRaw(repo, 'log', '-1', '--format=%s').trim(), 'second');
	});

	test('reset reports the commits left behind and can be undone with the previous HEAD', async () => {
		write('README.md', 'commit 2\n'); gitRaw(repo, 'commit', '-qam', 'second');
		const r = await ops.reset(repo, 'HEAD~1', 'mixed');
		assert.strictEqual(r.detachedCommits.length, 1);
		assert.match(r.detachedCommits[0], /second$/);
		assert.strictEqual(read('README.md'), 'commit 2\n', 'mixed keeps the changes in the working tree');
		assert.deepStrictEqual((await ops.status(repo)).unstaged.map(f => f.uri), ['README.md']);
		await ops.reset(repo, r.previousHead, 'soft'); // undo
		assert.strictEqual(gitRaw(repo, 'log', '-1', '--format=%s').trim(), 'second');
		await assert.rejects(ops.reset(repo, '--hard', 'soft'), /must not be empty or start with "-"/);
		await assert.rejects(ops.reset(repo, 'HEAD', 'nuke' as any), /Invalid reset mode/);
	});

	test('reset is refused while a merge is in progress (abort instead)', async () => {
		conflictingBranch();
		await ops.merge(repo, 'theirs');
		await assert.rejects(ops.reset(repo, 'HEAD', 'mixed'), /merge is in progress/);
		assert.strictEqual((await ops.abortOperation(repo)).operation, 'merge');
	});

	test('tags: lightweight and annotated, listed with their commit; duplicates refused', async () => {
		const head = gitRaw(repo, 'rev-parse', 'HEAD').trim();
		assert.deepStrictEqual((await ops.createTag(repo, 'v1.0.0')), { name: 'v1.0.0', commit: head });
		await ops.createTag(repo, 'v1.0.1', 'HEAD', 'Release 1.0.1');
		const { tags } = await ops.tags(repo);
		const byName = Object.fromEntries(tags.map(t => [t.name, t]));
		assert.strictEqual(byName['v1.0.0'].annotated, false);
		assert.strictEqual(byName['v1.0.1'].annotated, true);
		assert.strictEqual(byName['v1.0.1'].commit, head, 'annotated tags report the commit, not the tag object');
		assert.strictEqual(byName['v1.0.1'].subject, 'Release 1.0.1');
		await assert.rejects(ops.createTag(repo, 'v1.0.0'), /already exists/);
		await assert.rejects(ops.createTag(repo, 'bad..name'), /failed/);
	});

	test('remotes are listed with credentials redacted', async () => {
		gitRaw(repo, 'remote', 'add', 'origin', 'https://someone:s3cr3t-token@example.invalid/repo.git');
		const { remotes } = await ops.remotes(repo);
		assert.deepStrictEqual(remotes, [{ name: 'origin', fetchUrl: 'https://***@example.invalid/repo.git', pushUrl: 'https://***@example.invalid/repo.git' }]);
		assert.ok(!JSON.stringify(remotes).includes('s3cr3t'));
	});

	test('worktree add creates a real separate checkout; the main checkout and its uncommitted work are untouched', async () => {
		write('user.txt', 'user draft\n');
		const wtPath = path.join(tmp, 'wt-feature');
		const r = await ops.addWorktree(repo, wtPath, 'feature-x', true);
		assert.strictEqual(r.branch, 'feature-x');
		assert.strictEqual(fs.readFileSync(path.join(wtPath, 'README.md'), 'utf8'), 'line one\nline two\n');
		fs.writeFileSync(path.join(wtPath, 'only-in-worktree.txt'), 'x');
		assert.ok(!fs.existsSync(path.join(repo, 'only-in-worktree.txt')));
		assert.strictEqual(read('user.txt'), 'user draft\n');
		assert.strictEqual((await ops.status(repo)).branch, 'main');
		const { worktrees } = await ops.worktrees(repo);
		assert.strictEqual(worktrees.length, 2);
		assert.strictEqual(worktrees[0].isMain, true);
		assert.strictEqual(worktrees[1].branch, 'feature-x');
		await assert.rejects(ops.addWorktree(repo, path.join(tmp, 'wt-2'), 'main', false), /failed/); // already checked out
	});

	// ------------------------------------------------------------------ commit messages and pull requests

	const commit = (message: string) => { gitRaw(repo, 'add', '-A'); gitRaw(repo, 'commit', '-q', '-m', message); };

	test('commit context: exactly what is staged (with counts, renames, binaries), what is not, and the repository style', async () => {
		await assert.rejects(ops.commitContext(repo), /Nothing is staged/);
		write('a.txt', 'a\n'); commit('feat(core): add a');
		write('b.txt', 'b\n'); commit('fix(core): handle b');
		write('c.txt', 'c\n'); commit('feat(ui): add c');
		write('README.md', 'line one\nline 2\nline three\n');
		gitRaw(repo, 'mv', 'a.txt', 'alpha.txt');
		fs.writeFileSync(path.join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 255, 0]));
		gitRaw(repo, 'add', 'README.md', 'logo.bin');
		write('user.txt', 'user v2 (not staged)\n');
		write('scratch.txt', 'untracked\n');
		const c = await ops.commitContext(repo);
		assert.deepStrictEqual(c.staged.map(f => [f.status, f.path, f.oldPath, f.added, f.deleted]).sort(), [
			['added', 'logo.bin', undefined, null, null],
			['modified', 'README.md', undefined, 2, 1],
			['renamed', 'alpha.txt', 'a.txt', 0, 0],
		]);
		assert.deepStrictEqual(c.notStaged, { unstaged: ['user.txt'], untracked: ['scratch.txt'] });
		assert.ok(c.convention.conventional);
		assert.deepStrictEqual(c.convention.types, ['feat', 'fix']);
		assert.deepStrictEqual(c.convention.scopes, ['core', 'ui']);
		assert.deepStrictEqual(c.recentSubjects.slice(0, 3), ['feat(ui): add c', 'fix(core): handle b', 'feat(core): add a']);
		assert.match(c.stagedDiff, /\+line three/);
		assert.strictEqual(c.diffTruncated, false);
		assert.ok((await ops.commitContext(repo, { maxDiffChars: 1000 })).stagedDiff.length <= 1000);
	});

	test('pull request context: commits, files, ahead/behind, push state, uncommitted work and a REAL conflict with the base', async () => {
		gitRaw(repo, 'switch', '-q', '-c', 'feature');
		write('README.md', 'line one\nline two (feature)\n'); commit('Change line two on the feature');
		write('src/new.js', 'export const x = 1;\n'); commit('Add new.js');
		gitRaw(repo, 'switch', '-q', 'main');
		write('README.md', 'line one\nline two (main)\n'); commit('Change line two on main');
		gitRaw(repo, 'switch', '-q', 'feature');
		write('user.txt', 'user edit in progress\n');

		const pr = await ops.prContext(repo);
		assert.strictEqual(pr.base, 'main', 'no origin: the local main');
		assert.deepStrictEqual([pr.branch, pr.ahead, pr.behind, pr.upstream, pr.unpushed], ['feature', 2, 1, null, null]);
		assert.deepStrictEqual(pr.commits.map(c => c.subject), ['Change line two on the feature', 'Add new.js']);
		assert.deepStrictEqual(pr.files.map(f => [f.status, f.path, f.added, f.deleted]), [['modified', 'README.md', 1, 1], ['added', 'src/new.js', 1, 0]]);
		assert.deepStrictEqual(pr.totals, { files: 2, added: 2, deleted: 1 });
		assert.deepStrictEqual(pr.conflictsWithBase, ['README.md'], 'git merge-tree found the real conflict');
		assert.deepStrictEqual(pr.uncommitted, { staged: 0, unstaged: 1, untracked: 0 });
		assert.strictEqual(read('README.md'), 'line one\nline two (feature)\n', 'the conflict check did not touch the working tree');
		assert.strictEqual(gitRaw(repo, 'status', '--porcelain'), ' M user.txt\n', 'nor the index');

		// push it to a real (bare) remote, merge the base in (resolving the conflict), then check the push state
		const remote = path.join(tmp, 'origin.git');
		gitRaw(tmp, 'init', '-q', '--bare', remote);
		gitRaw(repo, 'remote', 'add', 'origin', remote);
		gitRaw(repo, 'push', '-q', 'origin', 'main');
		gitRaw(repo, 'push', '-q', '-u', 'origin', 'feature');
		gitRaw(repo, 'checkout', '-q', 'user.txt');
		gitRaw(repo, 'merge', '-q', 'main', '-X', 'ours', '-m', 'Merge main');
		const pushed = await ops.prContext(repo, 'origin/main');
		assert.deepStrictEqual([pushed.base, pushed.upstream, pushed.unpushed, pushed.behind], ['origin/main', 'origin/feature', 2, 0]);
		assert.deepStrictEqual(pushed.conflictsWithBase, []);
		assert.deepStrictEqual(pushed.commits.map(c => c.subject), ['Change line two on the feature', 'Add new.js'], 'merge commits are not listed as changes');
	});

	test('pull request context refuses what is not a pull request', async () => {
		await assert.rejects(ops.prContext(repo), /Could not tell which branch/, 'on main with no other base');
		gitRaw(repo, 'switch', '-q', '-c', 'empty');
		await assert.rejects(ops.prContext(repo), /no commits that "main" does not already have/);
		await assert.rejects(ops.prContext(repo, 'nope'), /not a branch or commit/);
		await assert.rejects(ops.prContext(repo, '--output=x'), /must not be empty or start with "-"/);
		gitRaw(repo, 'switch', '-q', '--detach', 'HEAD');
		await assert.rejects(ops.prContext(repo), /detached/);
		assert.doesNotThrow(() => validateGitRunRequest({ cwd: repo, args: ['merge-tree', '--write-tree', 'main', 'HEAD'] }));
		assert.throws(() => validateGitRunRequest({ cwd: repo, args: ['symbolic-ref', 'HEAD', 'refs/heads/x'] }), /not an allowed git subcommand/);
	});
});
