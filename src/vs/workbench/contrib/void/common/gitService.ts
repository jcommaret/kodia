/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IGitRepository } from '../../git/common/gitService.js';

/**
 * Result of checking whether a directory is a Git repository.
 */
export type GitRepoDetection = {
	isGitRepository: boolean;
	rootUri: URI | null;
};

/**
 * Status of a single file in the working tree or index.
 */
export type GitFileStatus = {
	uri: string;
	status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-change' | 'untracked' | 'ignored' | 'conflicted';
	staged: boolean;
};

/**
 * Full repository status.
 */
export type GitRepositoryStatus = {
	rootUri: string;
	branch: string | null;
	upstream: string | null;
	ahead: number | null;
	behind: number | null;
	staged: GitFileStatus[];
	unstaged: GitFileStatus[];
	untracked: GitFileStatus[];
	conflicted: GitFileStatus[];
	mergeInProgress: boolean;
	/** A multi-step operation stopped part-way (usually on conflicts); null when none. */
	operationInProgress: GitOperationInProgress | null;
};

/** Operations that can stop part-way and be continued (by committing) or aborted with git_abort. */
export type GitOperationInProgress = 'merge' | 'revert' | 'cherry-pick' | 'rebase';

export type GitTagInfo = { name: string; commit: string; annotated: boolean; subject: string };
export type GitRemoteInfo = { name: string; fetchUrl: string | null; pushUrl: string | null };
export type GitWorktreeInfo = { path: string; head: string | null; branch: string | null; isMain: boolean; locked: boolean; prunable: boolean };

/**
 * A single diff hunk.
 */
export type GitDiffHunk = {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	header: string;
	body: string;
};

/**
 * A diff for a single file.
 */
export type GitFileDiff = {
	uri: string;
	oldUri: string | null;
	newUri: string | null;
	status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-change' | 'conflicted';
	insertions: number;
	deletions: number;
	hunks: GitDiffHunk[];
	isBinary: boolean;
};

/**
 * Full diff result.
 */
export type GitDiffResult = {
	files: GitFileDiff[];
	totalInsertions: number;
	totalDeletions: number;
};

/**
 * A commit log entry.
 */
export type GitCommitLogEntry = {
	hash: string;
	shortHash: string;
	message: string;
	authorName: string;
	authorEmail: string;
	authorDate: string;
	committerName: string;
	committerEmail: string;
	committerDate: string;
	parents: string[];
};

/**
 * A branch reference.
 */
export type GitBranchInfo = {
	name: string;
	isCurrent: boolean;
	isRemote: boolean;
	upstream: string | null;
	ahead: number | null;
	behind: number | null;
	isProtected: boolean;
};

/**
 * A stash entry.
 */
export type GitStashEntry = {
	index: number;
	message: string;
};

// ---------------------------------------------------------------------------
// Running git safely (main process): argv only, no shell
// ---------------------------------------------------------------------------

export type GitRunRequest = { cwd: string; args: string[]; timeoutMs?: number };
export type GitRunResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };
export type GitRunner = (request: GitRunRequest) => Promise<GitRunResult>;

/** The git subcommands the agent may run (also enforced in the main process). */
export const GIT_ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set([
	'rev-parse', 'status', 'diff', 'log', 'show', 'for-each-ref', 'check-ref-format',
	'branch', 'switch', 'add', 'restore', 'rm', 'commit', 'fetch', 'pull', 'push', 'merge', 'stash',
	'revert', 'cherry-pick', 'rebase', 'reset', 'tag', 'remote', 'worktree',
]);

/** Subcommands whose first argument selects an action: only these actions are allowed (no remote add/set-url, no
 * worktree remove/prune). */
const GIT_ALLOWED_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
	remote: new Set(['-v']),
	worktree: new Set(['list', 'add']),
};

const GIT_ALLOWED_CONFIG: ReadonlySet<string> = new Set(['core.quotepath=false', 'color.ui=false']);

/** Validates a request that crossed the IPC boundary; throws on anything unexpected. */
export function validateGitRunRequest(request: unknown): GitRunRequest {
	const r = request as Partial<GitRunRequest> | null;
	if (!r || typeof r !== 'object') { throw new Error('Invalid git request.'); }
	if (typeof r.cwd !== 'string' || !(/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(r.cwd))) { throw new Error('Invalid git request: cwd must be an absolute path.'); }
	if (!Array.isArray(r.args) || r.args.length === 0 || !r.args.every(a => typeof a === 'string' && !a.includes('\0'))) { throw new Error('Invalid git request: args must be non-empty strings.'); }
	// leading global options are limited to the `-c` settings Kodia itself adds: an arbitrary -c (e.g. core.sshCommand,
	// core.pager, alias.*) would let a caller run any program
	let i = 0;
	while (r.args[i] === '-c') {
		if (!GIT_ALLOWED_CONFIG.has(r.args[i + 1] ?? '')) { throw new Error(`Invalid git request: -c ${r.args[i + 1]} is not allowed.`); }
		i += 2;
	}
	const sub = r.args[i];
	if (!sub || !GIT_ALLOWED_SUBCOMMANDS.has(sub)) { throw new Error(`Invalid git request: "${sub}" is not an allowed git subcommand.`); }
	const actions = GIT_ALLOWED_ACTIONS[sub];
	if (actions && !actions.has(r.args[i + 1] ?? '')) { throw new Error(`Invalid git request: "git ${sub} ${r.args[i + 1] ?? ''}" is not allowed.`); }
	// interactive rebase runs an editor-driven todo list (and --exec runs commands): never for the agent
	if (sub === 'rebase' && r.args.slice(i + 1).some(a => a === '-i' || a.startsWith('--interactive') || a.startsWith('--exec') || a === '-x' || a.startsWith('-x'))) { throw new Error('Invalid git request: interactive rebase and --exec are not allowed.'); }
	const timeoutMs = typeof r.timeoutMs === 'number' && r.timeoutMs > 0 ? Math.min(r.timeoutMs, 10 * 60_000) : undefined;
	return { cwd: r.cwd, args: [...r.args], timeoutMs };
}

export interface IKodiaGitMainService {
	readonly _serviceBrand: undefined;
	run(request: GitRunRequest): Promise<GitRunResult>;
}
export const IKodiaGitMainService = createDecorator<IKodiaGitMainService>('kodiaGitMainService');
export const KODIA_GIT_CHANNEL = 'void-channel-git';

/**
 * Service interface for Git operations.
 *
 * Read-only operations (status, diff, branches, log) use VS Code's Git API.
 * Write operations (commit, push, pull, branch, stash, etc.) use the terminal
 * tool service since VS Code's IGitRepository interface does not expose those
 * operations directly.
 */
export const IGitServiceVoid = createDecorator<IGitServiceVoid>('GitServiceVoid');

export interface IGitServiceVoid {
	readonly _serviceBrand: undefined;

	// Repository detection
	detectRepository(uri: URI): Promise<GitRepoDetection>;
	getRepository(uri: URI): Promise<IGitRepository | undefined>;

	// Read-only operations
	getRepositoryStatus(repo: IGitRepository): Promise<GitRepositoryStatus>;
	getRepositoryDiff(repo: IGitRepository, options?: { ref?: string | null; path?: string | null; staged?: boolean }): Promise<GitDiffResult>;
	getRepositoryBranches(repo: IGitRepository): Promise<GitBranchInfo[]>;
	getRepositoryLog(repo: IGitRepository, maxCount?: number, path?: string | null): Promise<{ commits: GitCommitLogEntry[]; total: number }>;
	hasUncommittedChanges(repo: IGitRepository): Promise<boolean>;
}
