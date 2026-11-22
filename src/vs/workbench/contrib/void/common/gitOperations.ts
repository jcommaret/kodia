/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * The agent's git operations, built on a GitRunner (argv-based, no shell; see KodiaGitMainService).
 *
 * - Reads come from git's machine-readable formats (status --porcelain=v2 -z, for-each-ref, log -z, real patches),
 *   so they reflect the repository on disk right now.
 * - Any non-zero exit is an error carrying git's own message: an operation is never reported as done when git
 *   refused it.
 * - Names that could be read as options (leading "-") are rejected; paths always follow "--".
 * - Force push uses --force-with-lease (it refuses to overwrite remote work the agent has not seen).
 */

import { GitChangedFile, GitCommitContext, GitCommitConvention, GitPrContext, GitBranchInfo, GitCommitLogEntry, GitDiffHunk, GitDiffResult, GitFileDiff, GitFileStatus, GitOperationInProgress, GitRemoteInfo, GitRepositoryStatus, GitRunner, GitRunResult, GitTagInfo, GitWorktreeInfo } from './gitService.js';

/** Result of an operation that can stop part-way on conflicts (revert, cherry-pick, rebase, continue). */
export type GitStepResult = { result: string; inProgress: GitOperationInProgress | null; conflicted: string[]; head: string | null };

export type GitResetMode = 'soft' | 'mixed' | 'hard';

/** Checked in this order: a stopped rebase can also leave CHERRY_PICK_HEAD behind. */
const IN_PROGRESS_REFS: readonly [string, GitOperationInProgress][] = [['REBASE_HEAD', 'rebase'], ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']];

const MAX_HUNK_BODY = 4_000;
const MAX_DIFF_BODY = 60_000;

export class GitCommandError extends Error {
	constructor(readonly args: string[], readonly result: GitRunResult) {
		const detail = (result.stderr.trim() || result.stdout.trim() || '(no output)').slice(0, 2_000);
		const how = result.timedOut ? 'timed out' : result.exitCode === null ? 'could not run' : `exit code ${result.exitCode}`;
		super(`git ${args.filter(a => a !== '-c' && !/^[a-z.]+=/.test(a))[0] ?? ''} failed (${how}): ${detail}`);
	}
}

function assertNotOption(kind: string, value: string): void {
	if (!value || value.startsWith('-')) { throw new Error(`Invalid ${kind} "${value}": it must not be empty or start with "-".`); }
}

/** For push/pull: a plain remote or branch name. Refspecs are refused — ":main" deletes the remote branch and
 * "+main" force-pushes, which would bypass --force-with-lease. */
function assertPlainName(kind: string, value: string): void {
	assertNotOption(kind, value);
	if (value.startsWith('+') || value.includes(':')) { throw new Error(`Invalid ${kind} "${value}": refspecs (":", leading "+") are not allowed; give a plain name.`); }
}

/** Credentials embedded in a remote URL (https://user:token@host/...) never reach the model. */
export function redactUrl(url: string): string {
	return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/\s]+@/i, '$1***@');
}

const statusOfCode =(c: string): GitFileStatus['status'] => ({
	M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type-change', U: 'conflicted',
} as Record<string, GitFileStatus['status']>)[c] ?? 'modified';

const CONVENTIONAL = /^([a-z]+)(?:\(([^)]+)\))?!?: \S/;

/** Reads the repository's commit-message style from its recent subjects (no guessing when there is no history). */
export function commitConvention(subjects: string[]): GitCommitConvention {
	const matches = subjects.map(s => CONVENTIONAL.exec(s)).filter((m): m is RegExpExecArray => !!m);
	const ranked = (values: string[]) => [...values.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]).map(([v]) => v);
	return {
		conventional: subjects.length > 0 && matches.length / subjects.length >= 0.5,
		types: ranked(matches.map(m => m[1])).slice(0, 8),
		scopes: ranked(matches.map(m => m[2]).filter((s): s is string => !!s)).slice(0, 8),
		averageSubjectLength: subjects.length ? Math.round(subjects.reduce((a, s) => a + s.length, 0) / subjects.length) : null,
	};
}

export class GitOperations {
	constructor(private readonly runner: GitRunner) { }

	/** Run git; throw a GitCommandError on a non-zero exit. */
	async git(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
		const fullArgs = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args];
		const result = await this.runner({ cwd, args: fullArgs, timeoutMs });
		if (result.exitCode !== 0) { throw new GitCommandError(fullArgs, result); }
		return result.stdout;
	}

	private async tryGit(cwd: string, args: string[]): Promise<GitRunResult> {
		return this.runner({ cwd, args: ['-c', 'core.quotepath=false', ...args] });
	}

	/** The repository root containing `dir`, or null if it is not inside a git repository. */
	async repositoryRoot(dir: string): Promise<string | null> {
		const r = await this.tryGit(dir, ['rev-parse', '--show-toplevel']);
		return r.exitCode === 0 ? r.stdout.trim().replace(/\//g, dir.includes('\\') ? '\\' : '/') : null;
	}

	private async hasHead(root: string): Promise<boolean> {
		return (await this.tryGit(root, ['rev-parse', '-q', '--verify', 'HEAD'])).exitCode === 0;
	}

	async status(root: string): Promise<GitRepositoryStatus> {
		const out = await this.git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
		const status: GitRepositoryStatus = { rootUri: root, branch: null, upstream: null, ahead: null, behind: null, staged: [], unstaged: [], untracked: [], conflicted: [], mergeInProgress: false, operationInProgress: null };
		const records = out.split('\0');
		for (let i = 0; i < records.length; i++) {
			const rec = records[i];
			if (!rec) { continue; }
			if (rec.startsWith('# branch.head ')) { const h = rec.slice(14); status.branch = h === '(detached)' ? null : h; }
			else if (rec.startsWith('# branch.upstream ')) { status.upstream = rec.slice(18); }
			else if (rec.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(rec); if (m) { status.ahead = +m[1]; status.behind = +m[2]; } }
			else if (rec.startsWith('1 ') || rec.startsWith('2 ')) {
				// 1 XY sub mH mI mW hH hI path   |   2 XY sub mH mI mW hH hI Xscore path \0 origPath
				const parts = rec.split(' ');
				const xy = parts[1];
				const path = parts.slice(rec.startsWith('1 ') ? 8 : 9).join(' ');
				if (rec.startsWith('2 ')) { i++; } // skip the original path record
				if (xy[0] !== '.') { status.staged.push({ uri: path, status: statusOfCode(xy[0]), staged: true }); }
				if (xy[1] !== '.') { status.unstaged.push({ uri: path, status: statusOfCode(xy[1]), staged: false }); }
			}
			else if (rec.startsWith('u ')) { status.conflicted.push({ uri: rec.split(' ').slice(10).join(' '), status: 'conflicted', staged: false }); }
			else if (rec.startsWith('? ')) { status.untracked.push({ uri: rec.slice(2), status: 'untracked', staged: false }); }
		}
		status.operationInProgress = await this.operationInProgress(root);
		status.mergeInProgress = status.operationInProgress === 'merge';
		return status;
	}

	private async operationInProgress(root: string): Promise<GitOperationInProgress | null> {
		for (const [ref, op] of IN_PROGRESS_REFS) {
			if ((await this.tryGit(root, ['rev-parse', '-q', '--verify', ref])).exitCode === 0) { return op; }
		}
		return null;
	}

	async diff(root: string, opts: { ref?: string | null; path?: string | null; staged?: boolean } = {}): Promise<GitDiffResult> {
		const args = ['diff', '--no-ext-diff', '-M', '--unified=3'];
		if (opts.staged) { args.push('--cached'); }
		if (opts.ref) { assertNotOption('ref', opts.ref); args.push(opts.ref); }
		args.push('--');
		if (opts.path) { args.push(opts.path); }
		return parsePatch(await this.git(root, args));
	}

	async branches(root: string): Promise<{ branches: GitBranchInfo[]; current: string | null }> {
		const out = await this.git(root, ['for-each-ref', '--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)', 'refs/heads', 'refs/remotes']);
		const branches: GitBranchInfo[] = [];
		for (const line of out.split('\n')) {
			if (!line) { continue; }
			const [ref, name, head, upstream, track] = line.split('\0');
			if (ref.endsWith('/HEAD')) { continue; } // refs/remotes/origin/HEAD symref
			const isRemote = ref.startsWith('refs/remotes/');
			branches.push({
				name, isCurrent: head === '*', isRemote,
				upstream: upstream || null,
				ahead: upstream ? +(/ahead (\d+)/.exec(track)?.[1] ?? 0) : null,
				behind: upstream ? +(/behind (\d+)/.exec(track)?.[1] ?? 0) : null,
				isProtected: false,
			});
		}
		return { branches, current: branches.find(b => b.isCurrent)?.name ?? null };
	}

	async log(root: string, opts: { maxCount?: number | null; path?: string | null } = {}): Promise<{ commits: GitCommitLogEntry[]; total: number }> {
		if (!(await this.hasHead(root))) { return { commits: [], total: 0 }; }
		const max = Math.max(1, Math.min(opts.maxCount ?? 20, 200));
		const args = ['log', '-z', `-n${max}`, '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%P%x1f%s', '--'];
		if (opts.path) { args.push(opts.path); }
		const commits = (await this.git(root, args)).split('\0').filter(Boolean).map(rec => {
			const [hash, authorName, authorEmail, authorDate, committerName, committerEmail, committerDate, parents, message] = rec.replace(/^\n/, '').split('\x1f');
			return { hash, shortHash: hash.slice(0, 7), message, authorName, authorEmail, authorDate, committerName, committerEmail, committerDate, parents: parents ? parents.split(' ') : [] };
		});
		return { commits, total: commits.length };
	}

	async show(root: string, commit: string, path?: string | null): Promise<{ commit: string; message: string; diff: string }> {
		assertNotOption('commit', commit);
		const args = ['show', '--no-ext-diff', '--format=%H%x1f%B%x1e', commit, '--'];
		if (path) { args.push(path); }
		const out = await this.git(root, args);
		const sep = out.indexOf('\x1e');
		const [hash, message] = out.slice(0, sep).split('\x1f');
		return { commit: hash.trim(), message: (message ?? '').trim(), diff: out.slice(sep + 1).replace(/^\n+/, '').slice(0, MAX_DIFF_BODY) };
	}

	async createBranch(root: string, name: string, startPoint?: string | null): Promise<{ branchName: string }> {
		assertNotOption('branch name', name);
		await this.git(root, ['check-ref-format', '--branch', name]);
		if (startPoint) { assertNotOption('start point', startPoint); }
		await this.git(root, startPoint ? ['branch', name, startPoint] : ['branch', name]);
		return { branchName: name };
	}

	/** Refuses (git's own check) when uncommitted changes would be overwritten: never discards work. */
	async switchBranch(root: string, name: string): Promise<{ branchName: string }> {
		assertNotOption('branch name', name);
		await this.git(root, ['switch', name]);
		return { branchName: name };
	}

	async stage(root: string, paths: string[]): Promise<{ staged: string[] }> {
		if (paths.length === 0) { throw new Error('No paths given to stage.'); }
		await this.git(root, ['add', '--', ...paths]);
		return { staged: paths };
	}

	async unstage(root: string, paths: string[]): Promise<{ unstaged: string[] }> {
		if (paths.length === 0) { throw new Error('No paths given to unstage.'); }
		// keeps the working-tree changes; before the first commit there is no HEAD to restore from
		await this.git(root, (await this.hasHead(root)) ? ['restore', '--staged', '--', ...paths] : ['rm', '--cached', '-q', '-r', '--', ...paths]);
		return { unstaged: paths };
	}

	async commit(root: string, message: string, amend?: boolean): Promise<{ commitHash: string; message: string }> {
		if (!message.trim()) { throw new Error('A commit message is required.'); }
		await this.git(root, amend ? ['commit', '--amend', '-m', message] : ['commit', '-m', message]);
		return { commitHash: (await this.git(root, ['rev-parse', 'HEAD'])).trim(), message };
	}

	async fetch(root: string, remote?: string | null): Promise<{ result: string }> {
		if (remote) { assertPlainName('remote', remote); }
		return { result: await this.outputOf(root, remote ? ['fetch', remote] : ['fetch']) };
	}

	async pull(root: string, remote?: string | null, branch?: string | null): Promise<{ result: string }> {
		const args = ['pull', '--no-edit'];
		for (const [kind, v] of [['remote', remote], ['branch', branch]] as const) { if (v) { assertPlainName(kind, v); args.push(v); } }
		return { result: await this.outputOf(root, args) };
	}

	async push(root: string, remote?: string | null, branch?: string | null, force?: boolean): Promise<{ result: string }> {
		const args = ['push'];
		if (force) { args.push('--force-with-lease'); } // never a blind --force
		for (const [kind, v] of [['remote', remote], ['branch', branch]] as const) { if (v) { assertPlainName(kind, v); args.push(v); } }
		return { result: await this.outputOf(root, args) };
	}

	/** A conflicting merge is reported (not thrown): the repository is left mid-merge for the agent to resolve. */
	async merge(root: string, branch: string): Promise<{ result: string; mergeInProgress: boolean; conflicted: string[] }> {
		assertNotOption('branch', branch);
		const r = await this.runner({ cwd: root, args: ['-c', 'core.quotepath=false', 'merge', '--no-edit', branch] });
		const st = await this.status(root);
		if (r.exitCode !== 0 && !st.mergeInProgress) { throw new GitCommandError(['merge'], r); }
		return { result: `${r.stdout}${r.stderr}`.trim(), mergeInProgress: st.mergeInProgress, conflicted: st.conflicted.map(c => c.uri) };
	}

	async stash(root: string, message?: string | null): Promise<{ result: string }> {
		return { result: await this.outputOf(root, message ? ['stash', 'push', '--include-untracked', '-m', message] : ['stash', 'push', '--include-untracked']) };
	}

	async stashPop(root: string): Promise<{ result: string }> {
		return { result: await this.outputOf(root, ['stash', 'pop']) };
	}

	/** Undo a commit with a new commit. Conflicts are reported (revert in progress), not thrown. */
	async revert(root: string, commit: string): Promise<GitStepResult> {
		assertNotOption('commit', commit);
		return this.step(root, 'revert', ['revert', '--no-edit', commit]);
	}

	/** Apply a commit from elsewhere onto the current branch. Conflicts are reported (cherry-pick in progress). */
	async cherryPick(root: string, commit: string): Promise<GitStepResult> {
		assertNotOption('commit', commit);
		return this.step(root, 'cherry-pick', ['cherry-pick', commit]);
	}

	/** Non-interactive rebase of the current branch onto `onto`. git itself refuses with uncommitted changes (no
	 * autostash: the user's work is never moved). Conflicts are reported (rebase in progress). */
	async rebase(root: string, onto: string): Promise<GitStepResult> {
		assertNotOption('upstream', onto);
		return this.step(root, 'rebase', ['rebase', onto]);
	}

	/** Continue the stopped merge/revert/cherry-pick/rebase after its conflicts were resolved and staged. */
	async continueOperation(root: string): Promise<GitStepResult & { operation: GitOperationInProgress }> {
		const op = await this.operationInProgress(root);
		if (!op) { throw new Error('No merge, revert, cherry-pick or rebase is in progress.'); }
		const st = await this.status(root);
		if (st.conflicted.length) { throw new Error(`${st.conflicted.length} file(s) still have conflicts: ${st.conflicted.map(c => c.uri).join(', ')}. Resolve them and stage them (git_stage) first.`); }
		return { operation: op, ...(await this.step(root, op, [op, '--continue'])) };
	}

	/** Abort the stopped merge/revert/cherry-pick/rebase: back to the state before it started. */
	async abortOperation(root: string): Promise<{ operation: GitOperationInProgress; head: string | null }> {
		const op = await this.operationInProgress(root);
		if (!op) { throw new Error('No merge, revert, cherry-pick or rebase is in progress.'); }
		await this.git(root, [op, '--abort']);
		return { operation: op, head: await this.head(root) };
	}

	/**
	 * Move the current branch to `ref`. Safeguards:
	 * - refused while a merge/revert/cherry-pick/rebase is in progress (use abort);
	 * - `hard` is refused when tracked files have uncommitted changes: it would destroy work no commit holds;
	 * - the commits the branch stops pointing at are listed, with the previous HEAD, so the reset can be undone.
	 */
	async reset(root: string, ref: string, mode: GitResetMode): Promise<{ mode: GitResetMode; previousHead: string; newHead: string; detachedCommits: string[] }> {
		assertNotOption('ref', ref);
		if (mode !== 'soft' && mode !== 'mixed' && mode !== 'hard') { throw new Error(`Invalid reset mode "${mode}": use soft, mixed or hard.`); }
		const st = await this.status(root);
		if (st.operationInProgress) { throw new Error(`A ${st.operationInProgress} is in progress: abort it (git_abort) instead of resetting.`); }
		if (mode === 'hard' && (st.staged.length || st.unstaged.length)) {
			const files = [...new Set([...st.staged, ...st.unstaged].map(f => f.uri))];
			throw new Error(`Refusing a hard reset: it would discard uncommitted changes to ${files.length} file(s) (${files.slice(0, 10).join(', ')}). Commit or stash them first, or use mode "mixed" (keeps the changes in the working tree).`);
		}
		const previousHead = (await this.git(root, ['rev-parse', 'HEAD'])).trim();
		const target = (await this.git(root, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
		const detachedCommits = (await this.git(root, ['log', '--format=%h %s', `${target}..${previousHead}`])).split('\n').filter(Boolean);
		await this.git(root, ['reset', `--${mode}`, target]);
		return { mode, previousHead, newHead: target, detachedCommits };
	}

	async tags(root: string): Promise<{ tags: GitTagInfo[] }> {
		const out = await this.git(root, ['for-each-ref', '--sort=-creatordate', '--format=%(refname:short)%00%(objecttype)%00%(*objectname)%00%(objectname)%00%(contents:subject)', 'refs/tags']);
		const tags = out.split('\n').filter(Boolean).map(line => {
			const [name, type, peeled, object, subject] = line.split('\0');
			return { name, commit: type === 'tag' ? peeled : object, annotated: type === 'tag', subject: subject ?? '' };
		});
		return { tags };
	}

	/** Annotated when a message is given. git refuses an existing tag name (no -f). */
	async createTag(root: string, name: string, ref?: string | null, message?: string | null): Promise<{ name: string; commit: string }> {
		assertNotOption('tag name', name);
		await this.git(root, ['check-ref-format', `refs/tags/${name}`]);
		if (ref) { assertNotOption('ref', ref); }
		const args = message?.trim() ? ['tag', '-a', '-m', message, name] : ['tag', name];
		if (ref) { args.push(ref); }
		await this.git(root, args);
		return { name, commit: (await this.git(root, ['rev-parse', `refs/tags/${name}^{commit}`])).trim() };
	}

	async remotes(root: string): Promise<{ remotes: GitRemoteInfo[] }> {
		const byName = new Map<string, GitRemoteInfo>();
		for (const line of (await this.git(root, ['remote', '-v'])).split('\n')) {
			const m = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line.trim());
			if (!m) { continue; }
			const r = byName.get(m[1]) ?? { name: m[1], fetchUrl: null, pushUrl: null };
			if (m[3] === 'fetch') { r.fetchUrl = redactUrl(m[2]); } else { r.pushUrl = redactUrl(m[2]); }
			byName.set(m[1], r);
		}
		return { remotes: [...byName.values()] };
	}

	async worktrees(root: string): Promise<{ worktrees: GitWorktreeInfo[] }> {
		const worktrees: GitWorktreeInfo[] = [];
		for (const block of (await this.git(root, ['worktree', 'list', '--porcelain'])).split(/\r?\n\r?\n/)) {
			const lines = block.split(/\r?\n/).filter(Boolean);
			const wt = lines.find(l => l.startsWith('worktree '));
			if (!wt) { continue; }
			const value = (key: string) => lines.find(l => l === key || l.startsWith(`${key} `))?.slice(key.length + 1) ?? null;
			worktrees.push({
				path: wt.slice(9), head: value('HEAD'), branch: value('branch')?.replace(/^refs\/heads\//, '') ?? null,
				isMain: worktrees.length === 0, locked: lines.some(l => l.startsWith('locked')), prunable: lines.some(l => l.startsWith('prunable')),
			});
		}
		return { worktrees };
	}

	/** A separate working tree (for parallel work that must not touch this checkout). With `newBranch` a branch is
	 * created from `startPoint` (default HEAD); otherwise an existing branch is checked out there (git refuses one
	 * that is already checked out elsewhere). */
	async addWorktree(root: string, worktreePath: string, branch: string, newBranch: boolean, startPoint?: string | null): Promise<{ path: string; branch: string; head: string }> {
		assertNotOption('path', worktreePath);
		assertNotOption('branch', branch);
		await this.git(root, ['check-ref-format', '--branch', branch]);
		if (startPoint) { assertNotOption('start point', startPoint); }
		const args = newBranch ? ['worktree', 'add', '-b', branch, worktreePath] : ['worktree', 'add', worktreePath, branch];
		if (newBranch && startPoint) { args.push(startPoint); }
		await this.git(root, args);
		const added = (await this.worktrees(root)).worktrees.find(w => w.branch === branch);
		if (!added) { throw new Error(`git reported success but no worktree for branch "${branch}" is listed.`); }
		return { path: added.path, branch, head: added.head ?? '' };
	}

	// ---------------------------------------------------------------- commit messages and pull requests

	/** Exactly what is staged (the commit's content), what is not, and how this repository writes messages. */
	async commitContext(root: string, opts: { maxDiffChars?: number } = {}): Promise<GitCommitContext> {
		const status = await this.status(root);
		if (status.staged.length === 0) {
			throw new Error(`Nothing is staged, so there is no commit to describe.${status.unstaged.length + status.untracked.length ? ` ${status.unstaged.length} modified and ${status.untracked.length} untracked file(s) are not staged: git_stage the ones the commit should contain.` : ''}`);
		}
		const hasHead = await this.hasHead(root);
		const staged = await this.changedFiles(root, ['--cached']);
		const max = Math.max(1000, Math.min(opts.maxDiffChars ?? 12_000, 60_000));
		const diff = await this.git(root, ['diff', '--cached', '--no-ext-diff', '-M', '--unified=2']);
		const recentSubjects = hasHead ? (await this.git(root, ['log', '-n20', '--no-merges', '--format=%s'])).split('\n').map(s => s.trim()).filter(Boolean) : [];
		return {
			branch: status.branch,
			staged,
			stagedDiff: diff.length > max ? diff.slice(0, max) : diff,
			diffTruncated: diff.length > max,
			notStaged: { unstaged: status.unstaged.map(f => f.uri), untracked: status.untracked.map(f => f.uri) },
			recentSubjects,
			convention: commitConvention(recentSubjects),
		};
	}

	/** A pull request's facts: commits and files versus the base, push state, uncommitted work, conflicts with the base. */
	async prContext(root: string, base?: string | null): Promise<GitPrContext> {
		const status = await this.status(root);
		if (!status.branch) { throw new Error('HEAD is detached: switch to the branch the pull request is for.'); }
		if (base) { assertNotOption('base', base); }
		const resolvedBase = base || await this.defaultBase(root, status.branch);
		if ((await this.tryGit(root, ['rev-parse', '-q', '--verify', `${resolvedBase}^{commit}`])).exitCode !== 0) { throw new Error(`The base "${resolvedBase}" is not a branch or commit in this repository.`); }
		const mergeBase = (await this.git(root, ['merge-base', resolvedBase, 'HEAD']).catch(() => { throw new Error(`"${status.branch}" and "${resolvedBase}" share no history.`); })).trim();
		const [behind, ahead] = (await this.git(root, ['rev-list', '--left-right', '--count', `${resolvedBase}...HEAD`])).trim().split(/\s+/).map(Number);
		if (ahead === 0) { throw new Error(`"${status.branch}" has no commits that "${resolvedBase}" does not already have: there is nothing for a pull request.`); }
		const commits = (await this.git(root, ['log', '-z', '--no-merges', '--reverse', '--format=%H%x1f%s%x1f%b', `${resolvedBase}..HEAD`])).split('\0').filter(Boolean).map(rec => {
			const [hash, subject, body] = rec.replace(/^\n/, '').split('\x1f');
			return { hash, subject, body: (body ?? '').trim() };
		});
		const files = await this.changedFiles(root, [`${mergeBase}`, 'HEAD']);
		const merge = await this.tryGit(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', resolvedBase, 'HEAD']);
		const conflictsWithBase = merge.exitCode === 0 ? [] : merge.exitCode === 1 ? merge.stdout.split('\n').slice(1).map(s => s.trim()).filter(Boolean) : null;
		const unpushed = status.upstream ? Number((await this.git(root, ['rev-list', '--count', `${status.upstream}..HEAD`])).trim()) : null;
		return {
			branch: status.branch, base: resolvedBase, mergeBase, commits, files,
			totals: { files: files.length, added: files.reduce((a, f) => a + (f.added ?? 0), 0), deleted: files.reduce((a, f) => a + (f.deleted ?? 0), 0) },
			ahead, behind, upstream: status.upstream, unpushed,
			uncommitted: { staged: status.staged.length, unstaged: status.unstaged.length, untracked: status.untracked.length },
			conflictsWithBase,
		};
	}

	/** The remote's default branch when known (origin/HEAD), else main/master, never the current branch. */
	private async defaultBase(root: string, current: string): Promise<string> {
		const originHead = await this.tryGit(root, ['rev-parse', '--abbrev-ref', 'origin/HEAD']);
		const candidates = [originHead.exitCode === 0 ? originHead.stdout.trim() : '', 'main', 'master', 'origin/main', 'origin/master'].filter(Boolean);
		for (const c of candidates) {
			if (c === current || c === `origin/${current}`) { continue; }
			if ((await this.tryGit(root, ['rev-parse', '-q', '--verify', `${c}^{commit}`])).exitCode === 0) { return c; }
		}
		throw new Error(`Could not tell which branch the pull request targets (no origin/HEAD, main or master other than "${current}"). Pass base.`);
	}

	/** `git diff --name-status` joined with `--numstat` for the same range. */
	private async changedFiles(root: string, range: string[]): Promise<GitChangedFile[]> {
		const nameStatus = (await this.git(root, ['diff', '--no-ext-diff', '-M', '--name-status', '-z', ...range])).split('\0');
		const files: GitChangedFile[] = [];
		for (let i = 0; i < nameStatus.length;) {
			const code = nameStatus[i++];
			if (!code) { continue; }
			if (code[0] === 'R' || code[0] === 'C') { const oldPath = nameStatus[i++], path = nameStatus[i++]; files.push({ path, oldPath, status: statusOfCode(code[0]), added: null, deleted: null }); }
			else { files.push({ path: nameStatus[i++], status: statusOfCode(code[0]), added: null, deleted: null }); }
		}
		// numstat -z: "added\tdeleted\tpath\0", or for a rename "added\tdeleted\t\0old\0new\0"
		const num = (await this.git(root, ['diff', '--no-ext-diff', '-M', '--numstat', '-z', ...range])).split('\0');
		for (let i = 0; i < num.length;) {
			const rec = num[i++];
			if (!rec) { continue; }
			const [a, d, p] = rec.split('\t');
			let path = p;
			if (!path) { i++; path = num[i++]; } // rename: skip the old path, take the new one
			const f = files.find(x => x.path === path);
			if (f) { f.added = a === '-' ? null : Number(a); f.deleted = d === '-' ? null : Number(d); }
		}
		return files;
	}

	private async head(root: string): Promise<string | null> {
		const r = await this.tryGit(root, ['rev-parse', '-q', '--verify', 'HEAD']);
		return r.exitCode === 0 ? r.stdout.trim() : null;
	}

	/** Runs an operation that may stop part-way: a stop on conflicts is a result, any other failure an error. */
	private async step(root: string, op: GitOperationInProgress, args: string[]): Promise<GitStepResult> {
		const fullArgs = ['-c', 'core.quotepath=false', ...args];
		const r = await this.runner({ cwd: root, args: fullArgs });
		const st = await this.status(root);
		if (r.exitCode !== 0 && st.operationInProgress !== op) { throw new GitCommandError(fullArgs, r); }
		return { result: `${r.stdout}${r.stderr}`.trim() || '(done)', inProgress: st.operationInProgress, conflicted: st.conflicted.map(c => c.uri), head: await this.head(root) };
	}

	private async outputOf(root: string, args: string[]): Promise<string> {
		const fullArgs = ['-c', 'core.quotepath=false', ...args];
		const r = await this.runner({ cwd: root, args: fullArgs });
		if (r.exitCode !== 0) { throw new GitCommandError(fullArgs, r); }
		return `${r.stdout}${r.stderr}`.trim() || '(done)'; // git reports progress for fetch/push/pull on stderr
	}
}

/** Parses a unified patch (git diff) into per-file diffs with real hunks. */
export function parsePatch(patch: string): GitDiffResult {
	const files: GitFileDiff[] = [];
	let budget = MAX_DIFF_BODY;
	for (const chunk of patch.split(/^diff --git /m).slice(1)) {
		const lines = chunk.split('\n');
		const header = /^a\/(.*) b\/(.*)$/.exec(lines[0]);
		let oldPath: string | null = header ? header[1] : null;
		let newPath: string | null = header ? header[2] : null;
		let status: GitFileDiff['status'] = 'modified';
		let isBinary = false;
		const hunks: GitDiffHunk[] = [];
		let insertions = 0, deletions = 0;
		let current: GitDiffHunk | null = null;
		for (const line of lines.slice(1)) {
			if (current) {
				if (line.startsWith('@@')) { current = null; }
				else if (/^[ +\-\\]/.test(line)) {
					if (line.startsWith('+')) { insertions++; } else if (line.startsWith('-')) { deletions++; }
					if (current.body.length < MAX_HUNK_BODY && budget > 0) { current.body += line + '\n'; budget -= line.length + 1; }
					continue;
				} else { current = null; }
			}
			const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
			if (h) {
				current = { oldStart: +h[1], oldLines: h[2] === undefined ? 1 : +h[2], newStart: +h[3], newLines: h[4] === undefined ? 1 : +h[4], header: line, body: '' };
				hunks.push(current);
			}
			else if (line.startsWith('new file mode')) { status = 'added'; oldPath = null; }
			else if (line.startsWith('deleted file mode')) { status = 'deleted'; newPath = null; }
			else if (line.startsWith('rename from ')) { status = 'renamed'; oldPath = line.slice(12); }
			else if (line.startsWith('rename to ')) { newPath = line.slice(10); }
			else if (line.startsWith('copy from ')) { status = 'copied'; oldPath = line.slice(10); }
			else if (line.startsWith('copy to ')) { newPath = line.slice(8); }
			else if (line.startsWith('Binary files ')) { isBinary = true; }
			else if (line.startsWith('--- ') && line !== '--- /dev/null') { oldPath = line.slice(6); }
			else if (line.startsWith('+++ ') && line !== '+++ /dev/null') { newPath = line.slice(6); }
		}
		for (const hunk of hunks) { hunk.body = hunk.body.replace(/\n$/, ''); }
		files.push({ uri: newPath ?? oldPath ?? '', oldUri: oldPath, newUri: newPath, status, insertions, deletions, hunks, isBinary });
	}
	return { files, totalInsertions: files.reduce((s, f) => s + f.insertions, 0), totalDeletions: files.reduce((s, f) => s + f.deletions, 0) };
}
