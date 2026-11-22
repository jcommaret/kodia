/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { statSync } from 'fs';
import { GitRunRequest, GitRunResult, IKodiaGitMainService, validateGitRunRequest } from '../common/gitService.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Runs git for the agent in the main process: `execFile` with an argument vector — no shell, so commit messages,
 * paths and branch names can never be interpreted as shell syntax. Exact exit codes, separate stdout/stderr.
 * Requests are re-validated here because they cross the IPC boundary from the renderer.
 */
export class KodiaGitMainService implements IKodiaGitMainService {
	readonly _serviceBrand: undefined;

	async run(request: GitRunRequest): Promise<GitRunResult> {
		const { cwd, args, timeoutMs } = validateGitRunRequest(request);
		let isDir = false;
		try { isDir = statSync(cwd).isDirectory(); } catch { /* reported below */ }
		if (!isDir) { throw new Error(`Invalid git request: ${cwd} is not a directory.`); }

		return new Promise<GitRunResult>(resolve => {
			execFile('git', args, {
				cwd,
				encoding: 'utf8',
				maxBuffer: MAX_BUFFER,
				timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS,
				windowsHide: true,
				env: {
					...process.env,
					GIT_TERMINAL_PROMPT: '0', // never wait for a credential prompt nobody can answer
					GIT_EDITOR: 'true', // never open an editor (merge messages etc.)
					GIT_PAGER: 'cat',
					LC_ALL: 'C', // stable, parseable English messages
				},
			}, (error, stdout, stderr) => {
				const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
				const timedOut = !!err?.killed;
				if (err && err.code === 'ENOENT') {
					resolve({ exitCode: null, stdout: '', stderr: 'git was not found on PATH. Install Git to use the git tools.', timedOut: false });
					return;
				}
				resolve({ exitCode: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: String(stdout), stderr: String(stderr), timedOut });
			});
		});
	}
}
