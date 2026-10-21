/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mock } from '../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { INativeHostService } from '../../../platform/native/common/native.js';
import { IOpenedMainWindow, IOpenEmptyWindowOptions, IOpenWindowOptions, IWindowOpenable, isFolderToOpen } from '../../../platform/window/common/window.js';
import { constObservable } from '../../../base/common/observable.js';
import { URI } from '../../../base/common/uri.js';
import { getChatSessionToOpenInEditor, KodiaManageModelsContribution, openKodiaSettingsInIDE, openSessionInVSCode, returnToVSCodeEditor, shouldShowReturnToVSCodeEditor, switchToIDE } from '../../electron-browser/actions/vscodeActions.js';
import { IKodiaWindowsService } from '../../../platform/windows/common/kodiaWindows.js';
import { IActiveSession } from '../../services/sessions/common/sessionsManagement.js';
import { IChat } from '../../services/sessions/common/session.js';
import { ISessionsProvidersService } from '../../services/sessions/browser/sessionsProvidersService.js';
import { IRemoteAgentHostService } from '../../../platform/agentHost/common/remoteAgentHostService.js';
import { Codicon } from '../../../base/common/codicons.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';

suite('VS Code Actions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('shows return action only when there is no other main window', () => {
		const currentWindow = createWindow(1);
		const otherWindow = createWindow(2);

		assert.deepStrictEqual({
			onlyAgentsWindow: shouldShowReturnToVSCodeEditor([currentWindow], currentWindow.id),
			agentsWindowNotListed: shouldShowReturnToVSCodeEditor([], currentWindow.id),
			otherWindowOpen: shouldShowReturnToVSCodeEditor([currentWindow, otherWindow], currentWindow.id),
			onlyOtherWindowListed: shouldShowReturnToVSCodeEditor([otherWindow], currentWindow.id),
		}, {
			onlyAgentsWindow: true,
			agentsWindowNotListed: true,
			otherWindowOpen: false,
			onlyOtherWindowListed: false,
		});
	});

	test('opens an editor window before closing the Agents window', async () => {
		const calls: string[] = [];
		const nativeHostService = new class extends mock<INativeHostService>() {
			override async openWindow(): Promise<void> {
				calls.push('open');
			}
			override async closeWindow(options?: { targetWindowId?: number }): Promise<void> {
				calls.push(`close:${options?.targetWindowId}`);
			}
		}();

		await returnToVSCodeEditor(nativeHostService, 7);

		assert.deepStrictEqual(calls, ['open', 'close:7']);
	});

	test('only transfers materialized sessions to the editor window', () => {
		const provisional = createSession('provisional', false);
		const materialized = createSession('materialized', true);

		assert.deepStrictEqual({
			provisional: getChatSessionToOpenInEditor(provisional)?.toString(),
			materialized: getChatSessionToOpenInEditor(materialized)?.toString(),
			missing: getChatSessionToOpenInEditor(undefined),
		}, {
			provisional: undefined,
			materialized: 'test:/materialized',
			missing: undefined,
		});
	});

	test('opens every active chat workspace folder in one editor window', async () => {
		const calls: { folders?: string[]; forceNewWindow?: boolean; chatSessionToOpen?: string }[] = [];
		const nativeHostService = new class extends mock<INativeHostService>() {
			override async openWindow(toOpen?: IOpenEmptyWindowOptions | IWindowOpenable[], options?: IOpenWindowOptions): Promise<void> {
				calls.push({
					folders: Array.isArray(toOpen) ? toOpen.filter(isFolderToOpen).map(openable => openable.folderUri.toString()) : undefined,
					forceNewWindow: options?.forceNewWindow,
					chatSessionToOpen: options?.chatSessionToOpen?.toString(),
				});
			}
		}();
		const session = createSession('multi-folder', true, [URI.file('/repo-b'), URI.file('/repo-c')]);

		await openSessionInVSCode(
			nativeHostService,
			session,
			new class extends mock<ISessionsProvidersService>() { }(),
			new class extends mock<IRemoteAgentHostService>() { }(),
		);

		assert.deepStrictEqual(calls, [{
			folders: ['file:///repo-b', 'file:///repo-c'],
			forceNewWindow: true,
			chatSessionToOpen: 'test:/multi-folder',
		}]);
	});

	test('opens an empty editor window when the active chat has no workspace', async () => {
		const calls: { empty: boolean }[] = [];
		const nativeHostService = new class extends mock<INativeHostService>() {
			override async openWindow(toOpen?: IOpenEmptyWindowOptions | IWindowOpenable[]): Promise<void> {
				calls.push({ empty: !Array.isArray(toOpen) });
			}
		}();

		await openSessionInVSCode(
			nativeHostService,
			createSession('no-workspace', true),
			new class extends mock<ISessionsProvidersService>() { }(),
			new class extends mock<IRemoteAgentHostService>() { }(),
		);

		assert.deepStrictEqual(calls, [{ empty: true }]);
	});

	suite('switchToIDE', () => {
		const agentsWindowId = 1;
		const session = createSession('switch', true, [URI.file('/repo')]);

		async function switchWith(windows: IOpenedMainWindow[]): Promise<string[]> {
			const calls: string[] = [];
			const nativeHostService = new class extends mock<INativeHostService>() {
				override async getWindows(): Promise<IOpenedMainWindow[]> {
					return windows;
				}
				override async focusWindow(options?: { targetWindowId?: number }): Promise<void> {
					calls.push(`focus:${options?.targetWindowId}`);
				}
				override async openWindow(toOpen?: IOpenEmptyWindowOptions | IWindowOpenable[]): Promise<void> {
					calls.push(`open:${Array.isArray(toOpen) ? toOpen.filter(isFolderToOpen).map(openable => openable.folderUri.toString()).join(',') : 'empty'}`);
				}
			}();
			await switchToIDE(
				nativeHostService,
				agentsWindowId,
				session,
				new class extends mock<ISessionsProvidersService>() { }(),
				new class extends mock<IRemoteAgentHostService>() { }(),
			);
			return calls;
		}

		test('focuses the editor window showing the session folder', async () => {
			const calls = await switchWith([createWindow(agentsWindowId), createWindow(2, URI.file('/other')), createWindow(3, URI.file('/repo'))]);
			assert.deepStrictEqual(calls, ['focus:3']);
		});

		test('focuses another editor window when none shows the session folder', async () => {
			const calls = await switchWith([createWindow(agentsWindowId), createWindow(2, URI.file('/other')), createWindow(3)]);
			assert.deepStrictEqual(calls, ['focus:2']);
		});

		test('opens the session folder when the Agents window is the only window', async () => {
			const calls = await switchWith([createWindow(agentsWindowId)]);
			assert.deepStrictEqual(calls, ['open:file:///repo']);
		});
	});

	suite('openKodiaSettingsInIDE', () => {
		const agentsWindowId = 1;
		const session = createSession('settings', true, [URI.file('/repo')]);

		// windowsAfterOpen: what getWindows returns once the Agents window has opened a window
		async function openSettingsWith(windows: IOpenedMainWindow[], windowsAfterOpen?: IOpenedMainWindow[]): Promise<string[]> {
			const calls: string[] = [];
			let opened = false;
			const nativeHostService = new class extends mock<INativeHostService>() {
				override async getWindows(): Promise<IOpenedMainWindow[]> {
					return opened && windowsAfterOpen ? windowsAfterOpen : windows;
				}
				override async focusWindow(options?: { targetWindowId?: number }): Promise<void> {
					calls.push(`focus:${options?.targetWindowId}`);
				}
				override async openWindow(): Promise<void> {
					opened = true;
					calls.push('open');
				}
			}();
			const kodiaWindowsService = new class extends mock<IKodiaWindowsService>() {
				override async openSettingsInWindow(windowId: number): Promise<void> {
					calls.push(`settings:${windowId}`);
				}
			}();
			await openKodiaSettingsInIDE(
				nativeHostService,
				kodiaWindowsService,
				agentsWindowId,
				session,
				new class extends mock<ISessionsProvidersService>() { }(),
				new class extends mock<IRemoteAgentHostService>() { }(),
			);
			return calls;
		}

		test('opens the settings in the editor window Switch to IDE focuses', async () => {
			const calls = await openSettingsWith([createWindow(agentsWindowId), createWindow(2, URI.file('/other')), createWindow(3, URI.file('/repo'))]);
			assert.deepStrictEqual(calls, ['focus:3', 'settings:3']);
		});

		test('opens the settings in the window it opens when the Agents window is the only window', async () => {
			const calls = await openSettingsWith([createWindow(agentsWindowId)], [createWindow(agentsWindowId), createWindow(4, URI.file('/repo'))]);
			assert.deepStrictEqual(calls, ['open', 'settings:4']);
		});

		test('does nothing when the opened window cannot be found', async () => {
			const calls = await openSettingsWith([createWindow(agentsWindowId)], [createWindow(agentsWindowId)]);
			assert.deepStrictEqual(calls, ['open']);
		});
	});

	suite('KodiaManageModelsContribution', () => {
		const manageModelsId = 'workbench.action.chat.manage';

		// The chat's own "Manage Language Models" action
		function registerChatAction(): ReturnType<typeof registerAction2> {
			return registerAction2(class extends Action2 {
				constructor() {
					super({ id: manageModelsId, title: 'Manage Language Models' });
				}
				run(): string {
					return 'chat';
				}
			});
		}

		// Runs the command with an accessor that fails on the first service asked for: the chat's action asks for none
		function runCommand(): string {
			const accessor: ServicesAccessor = { get: () => { throw new Error('kodia'); } };
			try {
				return String(CommandsRegistry.getCommand(manageModelsId)!.handler(accessor));
			} catch (e) {
				return (e as Error).message;
			}
		}

		test('lets the chat register its action, then handles the command', () => {
			const store = new DisposableStore();
			store.add(new KodiaManageModelsContribution());
			store.add(registerChatAction());
			assert.strictEqual(runCommand(), 'kodia');
			store.dispose();
		});

		test('handles the command when the chat registered its action first', () => {
			const store = new DisposableStore();
			store.add(registerChatAction());
			store.add(new KodiaManageModelsContribution());
			assert.strictEqual(runCommand(), 'kodia');
			store.dispose();
		});
	});
});

function createWindow(id: number, folderUri?: URI): IOpenedMainWindow {
	return {
		id,
		title: `Window ${id}`,
		dirty: false,
		workspace: folderUri ? { id: `folder-${id}`, uri: folderUri } : undefined,
	};
}

function createSession(id: string, isCreated: boolean, folders?: URI[]): IActiveSession {
	const workspace = constObservable(folders ? {
		uri: URI.from({ scheme: 'test', path: `/${id}/workspace` }),
		label: id,
		icon: Codicon.folder,
		folders: folders.map((folder, index) => ({
			root: folder,
			workingDirectory: folder,
			name: `Repository ${index + 1}`,
			description: undefined,
		})),
		requiresWorkspaceTrust: false,
		isVirtualWorkspace: false,
	} : undefined);
	const activeChat = new class extends mock<IChat>() {
		override readonly workspace = workspace;
	}();
	return new class extends mock<IActiveSession>() {
		override readonly resource = URI.from({ scheme: 'test', path: `/${id}` });
		override readonly providerId = 'test';
		override readonly isCreated = constObservable(isCreated);
		override readonly activeChat = constObservable(activeChat);
	}();
}
