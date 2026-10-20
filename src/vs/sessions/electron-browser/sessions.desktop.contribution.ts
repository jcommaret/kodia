/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerAction2 } from '../../platform/actions/common/actions.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../workbench/common/contributions.js';
import { KodiaManageModelsContribution, OpenSessionInVSCodeAction, OpenInVSCodeWidgetContribution, OpenVSCodeWindowAction, ReturnToVSCodeEditorAction, ShouldShowReturnToVSCodeEditorAction } from './actions/vscodeActions.js';
import { registerMainProcessRemoteService } from '../../platform/ipc/electron-browser/services.js';
import { IKodiaWindowsService, KODIA_WINDOWS_CHANNEL } from '../../platform/windows/common/kodiaWindows.js';

// Actions
(function registerActions(): void {
	registerAction2(OpenSessionInVSCodeAction);
	registerAction2(OpenVSCodeWindowAction);
	registerAction2(ReturnToVSCodeEditorAction);
	registerAction2(ShouldShowReturnToVSCodeEditorAction);
})();

(function registerWorkbenchContributions(): void {
	registerWorkbenchContribution2(OpenInVSCodeWidgetContribution.ID, OpenInVSCodeWidgetContribution, WorkbenchPhase.BlockRestore);
	// Kodia: "Manage Models..." opens Kodia's settings in an editor window
	registerWorkbenchContribution2(KodiaManageModelsContribution.ID, KodiaManageModelsContribution, WorkbenchPhase.BlockRestore);
})();

// Kodia: opens Kodia's settings in an editor window (see KodiaManageModelsContribution)
registerMainProcessRemoteService(IKodiaWindowsService, KODIA_WINDOWS_CHANNEL);
