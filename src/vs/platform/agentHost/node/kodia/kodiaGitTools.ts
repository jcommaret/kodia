/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { promisify } from 'util';
import { jsonSchemaOfSharedTool, SharedTool } from '../../../kodia/common/toolCatalog.js';
import type { IByokLmFunctionTool } from '../../common/agentHostByokLm.js';

const execFileAsync = promisify(cp.execFile);

// Read-only git tools for the Kodia agent. Reading what changed is what an agent does most with git, and through
// `run_command` each of those reads asks the user's approval. These never change the repository, so they don't: git is run
// with the arguments listed here, without a shell, and with what a repository's own configuration could use to run a
// program turned off.

export const gitTools = {
	git_status: {
		name: 'git_status',
		description: 'Shows the current branch and the files that changed in the git repository: staged, not staged and untracked, one per line (`git status --short --branch`). Read-only.',
		params: {},
	},
	git_diff: {
		name: 'git_diff',
		description: 'Shows the changes of the git repository, line by line: the ones that are not staged yet by default. Read-only. A long diff is cut: ask for `stat_only` first, then for one file with `uri`.',
		params: {
			staged: { description: 'Optional. Show the staged changes (`git diff --cached`) instead of the ones that are not staged.', type: 'boolean' },
			base: { description: 'Optional. A branch, a tag or a commit to compare the working tree with, such as "main" or "HEAD~3". Used in place of `staged`.' },
			uri: { description: 'Optional. Only the changes of this file or folder.' },
			stat_only: { description: 'Optional. Only list the files and how many lines changed in each.', type: 'boolean' },
		},
	},
	git_log: {
		name: 'git_log',
		description: 'Lists the latest commits, newest first: the hash, the date, the author and the message. Read-only.',
		params: {
			max_count: { description: 'Optional. How many commits at most (up to 100). Default is 20.', type: 'integer' },
			ref: { description: 'Optional. A branch, a tag or a commit to start from. Default is the current commit.' },
			uri: { description: 'Optional. Only the commits that changed this file or folder.' },
			search: { description: 'Optional. Only the commits whose message contains this text.' },
		},
	},
	git_show: {
		name: 'git_show',
		description: 'Shows one commit: its message and what it changed, line by line. Read-only. A long diff is cut: ask for `stat_only` first, then for one file with `uri`.',
		params: {
			ref: { description: 'The commit, such as a hash, "HEAD" or "HEAD~2".', required: true },
			uri: { description: 'Optional. Only the changes of this file or folder.' },
			stat_only: { description: 'Optional. Only list the files and how many lines changed in each.', type: 'boolean' },
		},
	},
} as const satisfies { [name: string]: SharedTool };

export type GitToolName = keyof typeof gitTools;
export const gitToolNames = Object.keys(gitTools) as GitToolName[];

export function isGitToolName(name: string): name is GitToolName {
	return Object.hasOwn(gitTools, name);
}

/** The git tools in the bridge's wire shape. */
export const GIT_FUNCTION_TOOLS: IByokLmFunctionTool[] = gitToolNames.map(name => ({
	type: 'function',
	name,
	description: gitTools[name].description,
	parametersSchema: jsonSchemaOfSharedTool(gitTools[name]),
}));

export interface IGitToolContext {
	/** The repository, or a folder of it. */
	readonly root: string;
	/** A path of the model's, absolute. */
	readonly resolve: (p: unknown) => string;
	readonly signal: AbortSignal;
}

export interface IGitToolResult {
	readonly success: boolean;
	readonly output: string;
}

const GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_BUFFER_BYTES = 8 * 1024 * 1024;
// as the file tools: ~25k tokens, and each result stays in the history
const MAX_GIT_OUTPUT_CHARS = 100_000;
const DEFAULT_LOG_COUNT = 20;
const MAX_LOG_COUNT = 100;

const str = (s: unknown): string => typeof s === 'string' ? s.trim() : '';
// the model's flags and numbers reach the tools as text, which is how Kodia's window offers every parameter
const flag = (b: unknown): boolean => b === true || (typeof b === 'string' && b.trim().toLowerCase() === 'true');
const count = (n: unknown): number | undefined => {
	const value = typeof n === 'string' && /^\s*\d+\s*$/.test(n) ? Number(n) : n;
	return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
};

// A ref that begins with a dash would be read as an option (`--output=<file>` writes one), and one with a space or a
// control character is not a ref.
const isRef = (s: string) => s.length > 0 && !s.startsWith('-') && !/[\s\u0000-\u001f\u007f]/.test(s);

class GitToolError extends Error { }

async function git(args: readonly string[], ctx: IGitToolContext): Promise<string> {
	try {
		const { stdout } = await execFileAsync('git', [
			'--no-pager',
			'--no-optional-locks', // reading must not take the index lock that the user's own git commands need
			'-c', 'core.fsmonitor=false', // a repository can name a program to run here
			'-c', 'core.quotePath=false', // a file named with accents is shown as it is written
			...args,
		], {
			cwd: ctx.root,
			signal: ctx.signal,
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: MAX_GIT_BUFFER_BYTES,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
		});
		return stdout;
	} catch (err) {
		const e = err as { stderr?: string; code?: number | string; killed?: boolean; message?: string; name?: string };
		if (e.name === 'AbortError') {
			throw err;
		}
		if (e.killed) {
			throw new GitToolError(`git did not finish within ${GIT_TIMEOUT_MS / 1000}s.`);
		}
		if (e.code === 'ENOENT') {
			throw new GitToolError('git is not installed, or is not on the PATH.');
		}
		if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
			throw new GitToolError('The output is too long. Narrow it down with `uri`, or use `stat_only`.');
		}
		throw new GitToolError(e.stderr?.trim() || e.message || 'git failed.');
	}
}

function cut(text: string, advice: string): string {
	return text.length > MAX_GIT_OUTPUT_CHARS ? `${text.slice(0, MAX_GIT_OUTPUT_CHARS)}\n\n(The output is cut here. ${advice})` : text;
}

const NARROW_DOWN = 'Ask for `stat_only`, then for one file with `uri`.';

/** The pathspec of `uri`, as git takes it after `--`: this machine's absolute path, which git reads from where it runs. */
const pathspec = (args: Record<string, unknown>, ctx: IGitToolContext): string[] => str(args.uri) ? ['--', ctx.resolve(args.uri)] : [];

export async function executeGitTool(name: GitToolName, args: Record<string, unknown>, ctx: IGitToolContext): Promise<IGitToolResult> {
	try {
		switch (name) {
			case 'git_status': {
				const output = (await git(['status', '--short', '--branch'], ctx)).trimEnd();
				return { success: true, output: cut(output, 'There are too many changed files to list them all.') };
			}
			case 'git_diff': {
				const base = str(args.base);
				if (base && !isRef(base)) {
					return { success: false, output: `"${base}" is not a branch, a tag or a commit.` };
				}
				const output = await git([
					'diff', '--no-color', '--no-ext-diff', '--no-textconv',
					...flag(args.stat_only) ? ['--stat'] : [],
					...base ? [base] : flag(args.staged) ? ['--cached'] : [],
					...pathspec(args, ctx),
				], ctx);
				return { success: true, output: output.trim() ? cut(output.trimEnd(), NARROW_DOWN) : base ? `No difference with ${base}.` : flag(args.staged) ? 'No staged changes.' : 'No changes that are not staged.' };
			}
			case 'git_log': {
				const ref = str(args.ref);
				if (ref && !isRef(ref)) {
					return { success: false, output: `"${ref}" is not a branch, a tag or a commit.` };
				}
				const search = str(args.search);
				const output = await git([
					'log', '--no-color', '--date=short', '--format=%h %ad %an: %s',
					`--max-count=${Math.min(count(args.max_count) ?? DEFAULT_LOG_COUNT, MAX_LOG_COUNT)}`,
					...search ? ['--fixed-strings', '--regexp-ignore-case', `--grep=${search}`] : [],
					...ref ? [ref] : [],
					...pathspec(args, ctx),
				], ctx);
				return { success: true, output: output.trim() ? cut(output.trimEnd(), 'Use `max_count` or `search` to narrow it down.') : 'No commits.' };
			}
			case 'git_show': {
				const ref = str(args.ref);
				if (!ref) {
					return { success: false, output: 'Missing "ref".' };
				}
				if (!isRef(ref)) {
					return { success: false, output: `"${ref}" is not a commit.` };
				}
				const output = await git([
					'show', '--no-color', '--no-ext-diff', '--no-textconv', '--format=commit %H%nAuthor: %an%nDate:   %ad%n%n%B', '--date=short',
					...flag(args.stat_only) ? ['--stat'] : [],
					ref,
					...pathspec(args, ctx),
				], ctx);
				return { success: true, output: cut(output.trimEnd(), NARROW_DOWN) };
			}
		}
	} catch (err) {
		if (err instanceof GitToolError) {
			return { success: false, output: err.message };
		}
		throw err;
	}
}
