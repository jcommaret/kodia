/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { FileChangeType, IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoidModelService } from '../common/voidModelService.js';
import { PROJECT_RULES_FILE_NAMES } from '../common/prompt/prompts.js';

class ConvertContribWorkbenchContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.void.convertcontrib'
	_serviceBrand: undefined;

	constructor(
		@IVoidModelService private readonly voidModelService: IVoidModelService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
	) {
		super()

		// load each rules file so convertToLLMMessageService can read it synchronously
		const rulesURIs = (folderURI: URI) => PROJECT_RULES_FILE_NAMES.map(fileName => URI.joinPath(folderURI, fileName))
		const initializeURI = async (folderURI: URI) => {
			for (const uri of rulesURIs(folderURI)) {
				if (await this.fileService.exists(uri)) this.voidModelService.initializeModel(uri)
			}
		}

		// call
		this._register(this.workspaceContext.onDidChangeWorkspaceFolders((e) => {
			[...e.changed, ...e.added].forEach(w => { initializeURI(w.uri) })
		}))
		this.workspaceContext.getWorkspace().folders.forEach(w => { initializeURI(w.uri) })

		// a rules file created after startup
		this._register(this.fileService.onDidFilesChange(e => {
			if (!e.gotAdded()) return
			for (const folder of this.workspaceContext.getWorkspace().folders) {
				for (const uri of rulesURIs(folder.uri)) {
					if (e.contains(uri, FileChangeType.ADDED)) this.voidModelService.initializeModel(uri)
				}
			}
		}))
	}
}


registerWorkbenchContribution2(ConvertContribWorkbenchContribution.ID, ConvertContribWorkbenchContribution, WorkbenchPhase.BlockRestore);
