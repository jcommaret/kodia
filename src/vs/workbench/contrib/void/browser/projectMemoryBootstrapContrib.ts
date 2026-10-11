/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IProjectMemoryService, PROJECT_MEMORY_FILE_PATH } from '../common/projectMemoryService.js';
import { PROJECT_MEMORY_BOOTSTRAP_ATTEMPTED_KEY } from '../common/storageKeys.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { isFeatureNameDisabled } from '../common/voidSettingsTypes.js';
import { IChatThreadService } from './chatThreadService.js';
import { VOID_OPEN_SIDEBAR_ACTION_ID } from './sidebarPane.js';

const BOOTSTRAP_PROMPT = `This project has no project memory yet. Briefly explore this codebase (purpose, structure, tech stack, how to build and test it, conventions worth following) and save what future sessions should know with write_project_memory, one section at a time (for example "Overview", "Architecture", "Commands", "Conventions"). Keep it concise. Don't make any other changes and don't ask any questions.`

// The first time a workspace without project memory is opened, offers to have the agent write it — in a
// thread of its own, since it reads the codebase and costs tokens.
class ProjectMemoryBootstrapContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.void.projectMemoryBootstrap'

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IChatThreadService private readonly chatThreadService: IChatThreadService,
		@IProjectMemoryService private readonly projectMemoryService: IProjectMemoryService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super()

		this._register(this.workspaceContext.onDidChangeWorkspaceFolders(() => this._maybeBootstrap()))
		this._maybeBootstrap()
	}

	private async _maybeBootstrap() {
		if (this.workspaceContext.getWorkspace().folders.length === 0) return
		if (this.storageService.getBoolean(PROJECT_MEMORY_BOOTSTRAP_ATTEMPTED_KEY, StorageScope.WORKSPACE, false)) return

		await this.projectMemoryService.whenReady
		if (this.projectMemoryService.getMemory().trim()) return // already has memory (e.g. committed by a teammate)

		await this.voidSettingsService.waitForInitState

		const settingsState = this.voidSettingsService.state
		if (!settingsState.globalSettings.isOnboardingComplete) return
		if (settingsState.globalSettings.chatMode !== 'agent') return // needs tool-calling to write memory
		if (isFeatureNameDisabled('Chat', settingsState)) return // no usable model configured yet

		// re-check after the await, and mark as attempted before asking so we ask once per workspace
		if (this.storageService.getBoolean(PROJECT_MEMORY_BOOTSTRAP_ATTEMPTED_KEY, StorageScope.WORKSPACE, false)) return
		this.storageService.store(PROJECT_MEMORY_BOOTSTRAP_ATTEMPTED_KEY, true, StorageScope.WORKSPACE, StorageTarget.MACHINE)

		this.notificationService.prompt(
			Severity.Info,
			`Kodia's agent can explore this project and write notes for future sessions in ${PROJECT_MEMORY_FILE_PATH}. It reads part of the codebase, which uses tokens.`,
			[
				{ label: 'Explore the project', run: () => this._bootstrap() },
				{ label: 'Not now', run: () => { } },
			],
		)
	}

	private _bootstrap() {
		this.chatThreadService.openNewThread()
		const thread = this.chatThreadService.getCurrentThread()
		this.commandService.executeCommand(VOID_OPEN_SIDEBAR_ACTION_ID)
		this.chatThreadService.addUserMessageAndStreamResponse({ userMessage: BOOTSTRAP_PROMPT, threadId: thread.id })
	}
}

registerWorkbenchContribution2(ProjectMemoryBootstrapContribution.ID, ProjectMemoryBootstrapContribution, WorkbenchPhase.AfterRestored);
