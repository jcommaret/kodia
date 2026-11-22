/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Git for the agent (roadmap 2), in the renderer.
 *
 * All git work runs in the main process (KodiaGitMainService: execFile with an argument vector, no shell) over the
 * 'void-channel-git' IPC channel (IKodiaGitMainService is registered as a main-process remote service in
 * electron-browser/kodiaGitService.ts); this service only finds the workspace repository and exposes GitOperations.
 *
 * Replaces an implementation that (a) could never be constructed by DI — its constructor parameters had no service
 * decorators, so every dependency was undefined in the app; (b) built shell command strings without quoting
 * (multi-word commit messages broke; `;` in a message ran a second command); (c) ignored exit codes and reported
 * every write as successful; (d) returned fabricated diff hunks and guessed file statuses.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IKodiaGitMainService } from '../common/gitService.js';
import { GitOperations } from '../common/gitOperations.js';

export const IGitToolService = createDecorator<IGitToolService>('GitToolService');

export interface IGitToolService {
	readonly _serviceBrand: undefined;
	/** The git operations the agent's git_* tools use. */
	readonly ops: GitOperations;
	/** Root of the repository containing the first workspace folder; throws a clear error if there is none. */
	workspaceRepositoryRoot(): Promise<string>;
}

export class GitToolService extends Disposable implements IGitToolService {
	readonly _serviceBrand: undefined;
	readonly ops: GitOperations;

	constructor(
		@IKodiaGitMainService git: IKodiaGitMainService, // the main-process runner (electron-browser/kodiaGitService.ts)
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this.ops = new GitOperations(request => git.run(request));
	}

	async workspaceRepositoryRoot(): Promise<string> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { throw new Error('No workspace folder is open.'); }
		const root = await this.ops.repositoryRoot(folders[0].uri.fsPath);
		if (!root) { throw new Error(`The workspace folder ${folders[0].uri.fsPath} is not inside a Git repository.`); }
		return root;
	}
}

registerSingleton(IGitToolService, GitToolService, InstantiationType.Delayed);
