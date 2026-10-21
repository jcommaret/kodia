/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh, isNative, OS } from '../../../../base/common/platform.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { addDisposableListener, append, clearNode, $, EventType, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { joinPath, resolvePath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { KeybindingLabel } from '../../../../base/browser/ui/keybindingLabel/keybindingLabel.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { defaultButtonStyles, defaultKeybindingLabelStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { editorForeground, registerColor, transparent } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IRecent, IRecentFolder, isRecentFolder, IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { ILabelService, Verbosity } from '../../../../platform/label/common/label.js';
import { ColorScheme } from '../../web.api.js';
import { OpenFileFolderAction, OpenFolderAction } from '../../actions/workspaceActions.js';
import { OpenRecentAction } from '../../actions/windowActions.js';
import { splitRecentLabel } from '../../../../base/common/labels.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';

/* eslint-disable */ // Kodia
import { VOID_CTRL_K_ACTION_ID, VOID_CTRL_L_ACTION_ID } from '../../../contrib/void/browser/actionIDs.js';
import { VIEWLET_ID as REMOTE_EXPLORER_VIEWLET_ID } from '../../../contrib/remote/browser/remoteExplorer.js';
/* eslint-enable */

// interface WatermarkEntry {
// 	readonly id: string;
// 	readonly text: string;
// 	readonly when?: {
// 		native?: ContextKeyExpression;
// 		web?: ContextKeyExpression;
// 	};
// }

// const showCommands: WatermarkEntry = { text: localize('watermark.showCommands', "Show All Commands"), id: 'workbench.action.showCommands' };
// const gotoFile: WatermarkEntry = { text: localize('watermark.quickAccess', "Go to File"), id: 'workbench.action.quickOpen' };
// const openFile: WatermarkEntry = { text: localize('watermark.openFile', "Open File"), id: 'workbench.action.files.openFile' };
// const openFolder: WatermarkEntry = { text: localize('watermark.openFolder', "Open Folder"), id: 'workbench.action.files.openFolder' };
// const openFileOrFolder: WatermarkEntry = { text: localize('watermark.openFileFolder', "Open File or Folder"), id: 'workbench.action.files.openFileFolder' };
// const openRecent: WatermarkEntry = { text: localize('watermark.openRecent', "Open Recent"), id: 'workbench.action.openRecent' };
// const newUntitledFile: WatermarkEntry = { text: localize('watermark.newUntitledFile', "New Untitled Text File"), id: 'workbench.action.files.newUntitledFile' };
// const findInFiles: WatermarkEntry = { text: localize('watermark.findInFiles', "Find in Files"), id: 'workbench.action.findInFiles' };
// const toggleTerminal: WatermarkEntry = { text: localize({ key: 'watermark.toggleTerminal', comment: ['toggle is a verb here'] }, "Toggle Terminal"), id: 'workbench.action.terminal.toggleTerminal', when: { web: ContextKeyExpr.equals('terminalProcessSupported', true) } };
// const startDebugging: WatermarkEntry = { text: localize('watermark.startDebugging', "Start Debugging"), id: 'workbench.action.debug.start', when: { web: ContextKeyExpr.equals('terminalProcessSupported', true) } };
// const openSettings: WatermarkEntry = { text: localize('watermark.openSettings', "Open Settings"), id: 'workbench.action.openSettings' };

// const showCopilot = ContextKeyExpr.or(ContextKeyExpr.equals('chatSetupHidden', false), ContextKeyExpr.equals('chatSetupInstalled', true));
// const openChat: WatermarkEntry = { text: localize('watermark.openChat', "Open Chat"), id: 'workbench.action.chat.open', when: { native: showCopilot, web: showCopilot } };
// const openCopilotEdits: WatermarkEntry = { text: localize('watermark.openCopilotEdits', "Open Copilot Edits"), id: 'workbench.action.chat.openEditSession', when: { native: showCopilot, web: showCopilot } };

// const emptyWindowEntries: WatermarkEntry[] = coalesce([
// 	showCommands,
// 	...(isMacintosh && !isWeb ? [openFileOrFolder] : [openFile, openFolder]),
// 	openRecent,
// 	isMacintosh && !isWeb ? newUntitledFile : undefined, // fill in one more on macOS to get to 5 entries
// 	openChat
// ]);

// const randomEmptyWindowEntries: WatermarkEntry[] = [
// 	/* Nothing yet */
// ];

// const workspaceEntries: WatermarkEntry[] = [
// 	showCommands,
// 	gotoFile,
// 	openChat
// ];

// const randomWorkspaceEntries: WatermarkEntry[] = [
// 	findInFiles,
// 	startDebugging,
// 	toggleTerminal,
// 	openSettings,
// 	openCopilotEdits
// ];


// Kodia: a recent folder on the welcome screen, with its branch when it is a git worktree
interface IWelcomeRecentFolder {
	readonly folder: IRecentFolder;
	readonly worktree: { readonly branch: string | undefined } | undefined;
}

export class EditorGroupWatermark extends Disposable {
	private readonly watermark: HTMLElement; // Kodia: gets .kodia-welcome in an empty window
	private readonly shortcuts: HTMLElement;
	private readonly transientDisposables = this._register(new DisposableStore());
	// private enabled: boolean = false;
	private workbenchState: WorkbenchState;
	private currentDisposables = new Set<IDisposable>();

	constructor(
		container: HTMLElement,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		// @IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IThemeService private readonly themeService: IThemeService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@ICommandService private readonly commandService: ICommandService,
		@IHostService private readonly hostService: IHostService,
		@ILabelService private readonly labelService: ILabelService,
		@IViewsService private readonly viewsService: IViewsService,
		@IFileService private readonly fileService: IFileService, // Kodia: tells git worktrees apart in the recent folders
	) {
		super();

		// Kodia: VS Code 1.141 wraps the watermark in .editor-group-watermark-wrapper, and every watermark rule in
		// editorgroupview.css (centering, logo size, hiding it once an editor opens) now targets that wrapper.
		const elements = h('.editor-group-watermark-wrapper', [
			h('.editor-group-watermark@watermark', [
				h('.letterpress@icon'),
				h('.shortcuts@shortcuts'),
			]),
		]);

		append(container, elements.root);
		this.watermark = elements.watermark;
		this.shortcuts = elements.shortcuts; // shortcuts div is modified on render()

		// void icon style
		const updateTheme = () => {
			const theme = this.themeService.getColorTheme().type
			const isDark = theme === ColorScheme.DARK || theme === ColorScheme.HIGH_CONTRAST_DARK
			elements.icon.style.maxWidth = '220px'
			elements.icon.style.opacity = '50%'
			elements.icon.style.filter = isDark ? '' : 'invert(1)' //brightness(.5)
		}
		updateTheme()
		this._register(
			this.themeService.onDidColorThemeChange(updateTheme)
		)

		this.registerListeners();

		this.workbenchState = contextService.getWorkbenchState();
		this.render();
	}

	private registerListeners(): void {
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('workbench.tips.enabled')) {
				this.render();
			}
		}));

		this._register(this.contextService.onDidChangeWorkbenchState(workbenchState => {
			if (this.workbenchState === workbenchState) {
				return;
			}

			this.workbenchState = workbenchState;
			this.render();
		}));

		// const allEntriesWhenClauses = [...noFolderEntries, ...folderEntries].filter(entry => entry.when !== undefined).map(entry => entry.when!);
		// const allKeys = new Set<string>();
		// allEntriesWhenClauses.forEach(when => when.keys().forEach(key => allKeys.add(key)));
		// this._register(this.contextKeyService.onDidChangeContext(e => {
		// 	if (e.affectsSome(allKeys)) {
		// 		this.render();
		// 	}
		// }));
	}



	private render(): void {

		this.clear();
		const voidIconBox = append(this.shortcuts, $('.watermark-box'));

		const update = async () => {

			// put async at top so don't need to wait (this prevents a jitter on load)
			const recentlyOpened = await this.workspacesService.getRecentlyOpened()
				.catch(() => ({ files: [], workspaces: [] })).then(w => w.workspaces);

			// Kodia - if the workbench is empty, show the welcome screen (its recent folders are resolved before clearing, like the list above)
			const isEmptyWorkbench = this.contextService.getWorkbenchState() === WorkbenchState.EMPTY;
			const recentFolders = isEmptyWorkbench ? await this.resolveRecentFolders(recentlyOpened) : [];

			clearNode(voidIconBox);

			this.currentDisposables.forEach(label => label.dispose());
			this.currentDisposables.clear();

			this.watermark.classList.toggle('kodia-welcome', isEmptyWorkbench);
			if (isEmptyWorkbench) {
				this.renderWelcome(voidIconBox, recentFolders);
			}
			else {

				// show them Kodia keybindings
				const keys = this.keybindingService.lookupKeybinding(VOID_CTRL_L_ACTION_ID);
				const dl = append(voidIconBox, $('dl'));
				const dt = append(dl, $('dt'));
				dt.textContent = 'Chat'
				const dd = append(dl, $('dd'));
				const label = new KeybindingLabel(dd, OS, { renderUnboundKeybindings: true, ...defaultKeybindingLabelStyles });
				if (keys)
					label.set(keys);
				this.currentDisposables.add(label);


				const keys2 = this.keybindingService.lookupKeybinding(VOID_CTRL_K_ACTION_ID);
				const dl2 = append(voidIconBox, $('dl'));
				const dt2 = append(dl2, $('dt'));
				dt2.textContent = 'Quick Edit'
				const dd2 = append(dl2, $('dd'));
				const label2 = new KeybindingLabel(dd2, OS, { renderUnboundKeybindings: true, ...defaultKeybindingLabelStyles });
				if (keys2)
					label2.set(keys2);
				this.currentDisposables.add(label2);

				// const keys3 = this.keybindingService.lookupKeybinding('workbench.action.openGlobalKeybindings');
				// const button3 = append(recentsBox, $('button'));
				// button3.textContent = `Kodia Settings`
				// button3.style.display = 'block'
				// button3.style.marginLeft = 'auto'
				// button3.style.marginRight = 'auto'
				// button3.classList.add('void-settings-watermark-button')

				// const label3 = new KeybindingLabel(button3, OS, { renderUnboundKeybindings: true, ...defaultKeybindingLabelStyles });
				// if (keys3)
				// 	label3.set(keys3);
				// button3.onclick = () => {
				// 	this.commandService.executeCommand(VOID_OPEN_SETTINGS_ACTION_ID)
				// }
				// this.currentDisposables.add(label3);

			}

		};

		update();
		this.transientDisposables.add(this.keybindingService.onDidUpdateKeybindings(update));
	}

	// Kodia: the empty window's welcome screen (Open Folder, Open SSH, then the most recent folders)
	private renderWelcome(container: HTMLElement, recentFolders: IWelcomeRecentFolder[]): void {
		const actions = append(container, $('.kodia-welcome-actions'));

		const openFolderButton = new Button(actions, { ...defaultButtonStyles, supportIcons: true });
		openFolderButton.label = `$(folder-opened) ${localize('kodia.watermark.openFolder', "Open Folder")}`;
		this.currentDisposables.add(openFolderButton);
		this.currentDisposables.add(openFolderButton.onDidClick(() => this.commandService.executeCommand(isMacintosh && isNative ? OpenFileFolderAction.ID : OpenFolderAction.ID)));

		const openSSHButton = new Button(actions, { ...defaultButtonStyles, secondary: true, supportIcons: true });
		openSSHButton.label = `$(remote-explorer) ${localize('kodia.watermark.openSSH', "Open SSH")}`;
		this.currentDisposables.add(openSSHButton);
		this.currentDisposables.add(openSSHButton.onDidClick(() => this.viewsService.openViewContainer(REMOTE_EXPLORER_VIEWLET_ID)));

		if (recentFolders.length === 0) {
			return;
		}

		const recent = append(container, $('.kodia-welcome-recent'));
		const header = append(recent, $('.kodia-welcome-recent-header'));
		const recentLabel = localize('kodia.watermark.recent', "Recent");
		append(header, $('h3.kodia-welcome-recent-title', undefined, recentLabel));
		const openRecentKeybinding = this.keybindingService.lookupKeybinding(OpenRecentAction.ID)?.getLabel();
		const more = append(header, $('button.kodia-welcome-recent-more', {
			type: 'button',
			title: openRecentKeybinding ? localize('kodia.watermark.openRecentKeybinding', "Open Recent ({0})", openRecentKeybinding) : localize('kodia.watermark.openRecent', "Open Recent"),
		}, localize('kodia.watermark.more', "More...")));
		this.currentDisposables.add(addDisposableListener(more, EventType.CLICK, () => this.commandService.executeCommand(OpenRecentAction.ID)));

		const list = append(recent, $('ul.kodia-welcome-recent-list', { 'aria-label': recentLabel }));
		for (const { folder, worktree } of recentFolders) {
			const fullPath = folder.label || this.labelService.getWorkspaceLabel(folder.folderUri, { verbose: Verbosity.LONG });
			const { name, parentPath } = splitRecentLabel(fullPath);

			// a branch icon for a git worktree, a remote icon for a remote folder, a folder icon otherwise
			const icon = worktree ? Codicon.gitBranch : folder.remoteAuthority ? Codicon.remote : Codicon.folder;
			const title = !worktree ? fullPath
				: worktree.branch ? localize('kodia.watermark.worktreeBranch', "{0}\nGit worktree on branch {1}", fullPath, worktree.branch)
					: localize('kodia.watermark.worktree', "{0}\nGit worktree", fullPath);

			// the name stays on one line; the parent path takes the room left and ends with an ellipsis (full path in the tooltip)
			const entry = append(append(list, $('li')), $('button.kodia-welcome-recent-entry', { type: 'button', title }));
			append(entry, renderIcon(icon)).classList.add('kodia-welcome-recent-icon');
			append(entry, $('span.kodia-welcome-recent-name', undefined, name));
			append(entry, $('span.kodia-welcome-recent-path', undefined, parentPath));

			this.currentDisposables.add(addDisposableListener(entry, EventType.CLICK, e => {
				this.hostService.openWindow([{ folderUri: folder.folderUri }], {
					forceNewWindow: e.ctrlKey || e.metaKey,
					remoteAuthority: folder.remoteAuthority || null // local window if remoteAuthority is not set or can not be deducted from the openable
				});
				e.preventDefault();
				e.stopPropagation();
			}));
		}
	}

	// Kodia: the 5 most recent folders, each with its branch when it is a git worktree
	private resolveRecentFolders(recents: readonly IRecent[]): Promise<IWelcomeRecentFolder[]> {
		const folders = recents.filter(isRecentFolder).slice(0, 5);
		return Promise.all(folders.map(async folder => ({ folder, worktree: await this.resolveWorktree(folder) })));
	}

	// Kodia: a git worktree has a `.git` file pointing into the main repository's `.git/worktrees/` (a submodule's points
	// into `.git/modules/`), and its branch is in that folder's HEAD. Anything unreadable (gone, remote...) is a plain folder.
	private async resolveWorktree(folder: IRecentFolder): Promise<{ readonly branch: string | undefined } | undefined> {
		try {
			const dotGit = joinPath(folder.folderUri, '.git');
			if (!(await this.fileService.stat(dotGit)).isFile) {
				return undefined;
			}
			const gitDir = /^gitdir:\s*(.+)$/m.exec((await this.fileService.readFile(dotGit)).value.toString())?.[1].trim();
			if (!gitDir || !/[\\/]worktrees[\\/][^\\/]+$/.test(gitDir)) {
				return undefined;
			}
			const head = (await this.fileService.readFile(joinPath(resolvePath(folder.folderUri, gitDir), 'HEAD')).catch(() => undefined))?.value.toString();
			return { branch: head && /^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1].trim() || undefined };
		} catch {
			return undefined;
		}
	}

	private clear(): void {
		clearNode(this.shortcuts);
		this.transientDisposables.clear();
	}

	override dispose(): void {
		super.dispose();
		this.clear();
		this.currentDisposables.forEach(label => label.dispose());
	}
}

registerColor('editorWatermark.foreground', { dark: transparent(editorForeground, 0.6), light: transparent(editorForeground, 0.68), hcDark: editorForeground, hcLight: editorForeground }, localize('editorLineHighlight', 'Foreground color for the labels in the editor watermark.'));



// /*---------------------------------------------------------------------------------------------
//  *  Copyright (c) Microsoft Corporation. All rights reserved.
//  *  Licensed under the MIT License. See License.txt in the project root for license information.
//  *--------------------------------------------------------------------------------------------*/

// import { $, append, clearNode, h } from '../../../../base/browser/dom.js';
// import { KeybindingLabel } from '../../../../base/browser/ui/keybindingLabel/keybindingLabel.js';
// import { coalesce, shuffle } from '../../../../base/common/arrays.js';
// import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
// import { isMacintosh, isWeb, OS } from '../../../../base/common/platform.js';
// import { localize } from '../../../../nls.js';
// import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
// import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
// import { ContextKeyExpr, ContextKeyExpression, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
// import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
// import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../../../platform/storage/common/storage.js';
// import { defaultKeybindingLabelStyles } from '../../../../platform/theme/browser/defaultStyles.js';
// import { editorForeground, registerColor, transparent } from '../../../../platform/theme/common/colorRegistry.js';
// import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';

// interface WatermarkEntry {
// 	readonly id: string;
// 	readonly text: string;
// 	readonly when?: {
// 		native?: ContextKeyExpression;
// 		web?: ContextKeyExpression;
// 	};
// }

// const showCommands: WatermarkEntry = { text: localize('watermark.showCommands', "Show All Commands"), id: 'workbench.action.showCommands' };
// const gotoFile: WatermarkEntry = { text: localize('watermark.quickAccess', "Go to File"), id: 'workbench.action.quickOpen' };
// const openFile: WatermarkEntry = { text: localize('watermark.openFile', "Open File"), id: 'workbench.action.files.openFile' };
// const openFolder: WatermarkEntry = { text: localize('watermark.openFolder', "Open Folder"), id: 'workbench.action.files.openFolder' };
// const openFileOrFolder: WatermarkEntry = { text: localize('watermark.openFileFolder', "Open File or Folder"), id: 'workbench.action.files.openFileFolder' };
// const openRecent: WatermarkEntry = { text: localize('watermark.openRecent', "Open Recent"), id: 'workbench.action.openRecent' };
// const newUntitledFile: WatermarkEntry = { text: localize('watermark.newUntitledFile', "New Untitled Text File"), id: 'workbench.action.files.newUntitledFile' };
// const findInFiles: WatermarkEntry = { text: localize('watermark.findInFiles', "Find in Files"), id: 'workbench.action.findInFiles' };
// const toggleTerminal: WatermarkEntry = { text: localize({ key: 'watermark.toggleTerminal', comment: ['toggle is a verb here'] }, "Toggle Terminal"), id: 'workbench.action.terminal.toggleTerminal', when: { web: ContextKeyExpr.equals('terminalProcessSupported', true) } };
// const startDebugging: WatermarkEntry = { text: localize('watermark.startDebugging', "Start Debugging"), id: 'workbench.action.debug.start', when: { web: ContextKeyExpr.equals('terminalProcessSupported', true) } };
// const openSettings: WatermarkEntry = { text: localize('watermark.openSettings', "Open Settings"), id: 'workbench.action.openSettings' };

// const showCopilot = ContextKeyExpr.or(ContextKeyExpr.equals('chatSetupHidden', false), ContextKeyExpr.equals('chatSetupInstalled', true));
// const openChat: WatermarkEntry = { text: localize('watermark.openChat', "Open Chat"), id: 'workbench.action.chat.open', when: { native: showCopilot, web: showCopilot } };

// const emptyWindowEntries: WatermarkEntry[] = coalesce([
// 	showCommands,
// 	...(isMacintosh && !isWeb ? [openFileOrFolder] : [openFile, openFolder]),
// 	openRecent,
// 	isMacintosh && !isWeb ? newUntitledFile : undefined, // fill in one more on macOS to get to 5 entries
// 	openChat
// ]);

// const randomEmptyWindowEntries: WatermarkEntry[] = [
// 	/* Nothing yet */
// ];

// const workspaceEntries: WatermarkEntry[] = [
// 	showCommands,
// 	gotoFile,
// 	openChat
// ];

// const randomWorkspaceEntries: WatermarkEntry[] = [
// 	findInFiles,
// 	startDebugging,
// 	toggleTerminal,
// 	openSettings,
// ];

// export class EditorGroupWatermark extends Disposable {

// 	private static readonly CACHED_WHEN = 'editorGroupWatermark.whenConditions';

// 	private readonly cachedWhen: { [when: string]: boolean };

// 	private readonly shortcuts: HTMLElement;
// 	private readonly transientDisposables = this._register(new DisposableStore());
// 	private readonly keybindingLabels = this._register(new DisposableStore());

// 	private enabled = false;
// 	private workbenchState: WorkbenchState;

// 	constructor(
// 		container: HTMLElement,
// 		@IKeybindingService private readonly keybindingService: IKeybindingService,
// 		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
// 		@IContextKeyService private readonly contextKeyService: IContextKeyService,
// 		@IConfigurationService private readonly configurationService: IConfigurationService,
// 		@IStorageService private readonly storageService: IStorageService
// 	) {
// 		super();

// 		this.cachedWhen = this.storageService.getObject(EditorGroupWatermark.CACHED_WHEN, StorageScope.PROFILE, Object.create(null));
// 		this.workbenchState = this.contextService.getWorkbenchState();

// 		const elements = h('.editor-group-watermark', [
// 			h('.letterpress'),
// 			h('.shortcuts@shortcuts'),
// 		]);

// 		append(container, elements.root);
// 		this.shortcuts = elements.shortcuts;

// 		this.registerListeners();

// 		this.render();
// 	}

// 	private registerListeners(): void {
// 		this._register(this.configurationService.onDidChangeConfiguration(e => {
// 			if (e.affectsConfiguration('workbench.tips.enabled') && this.enabled !== this.configurationService.getValue<boolean>('workbench.tips.enabled')) {
// 				this.render();
// 			}
// 		}));

// 		this._register(this.contextService.onDidChangeWorkbenchState(workbenchState => {
// 			if (this.workbenchState !== workbenchState) {
// 				this.workbenchState = workbenchState;
// 				this.render();
// 			}
// 		}));

// 		this._register(this.storageService.onWillSaveState(e => {
// 			if (e.reason === WillSaveStateReason.SHUTDOWN) {
// 				const entries = [...emptyWindowEntries, ...randomEmptyWindowEntries, ...workspaceEntries, ...randomWorkspaceEntries];
// 				for (const entry of entries) {
// 					const when = isWeb ? entry.when?.web : entry.when?.native;
// 					if (when) {
// 						this.cachedWhen[entry.id] = this.contextKeyService.contextMatchesRules(when);
// 					}
// 				}

// 				this.storageService.store(EditorGroupWatermark.CACHED_WHEN, JSON.stringify(this.cachedWhen), StorageScope.PROFILE, StorageTarget.MACHINE);
// 			}
// 		}));
// 	}

// 	private render(): void {
// 		this.enabled = this.configurationService.getValue<boolean>('workbench.tips.enabled');

// 		clearNode(this.shortcuts);
// 		this.transientDisposables.clear();

// 		if (!this.enabled) {
// 			return;
// 		}

// 		const fixedEntries = this.filterEntries(this.workbenchState !== WorkbenchState.EMPTY ? workspaceEntries : emptyWindowEntries, false /* not shuffled */);
// 		const randomEntries = this.filterEntries(this.workbenchState !== WorkbenchState.EMPTY ? randomWorkspaceEntries : randomEmptyWindowEntries, true /* shuffled */).slice(0, Math.max(0, 5 - fixedEntries.length));
// 		const entries = [...fixedEntries, ...randomEntries];

// 		const box = append(this.shortcuts, $('.watermark-box'));

// 		const update = () => {
// 			clearNode(box);
// 			this.keybindingLabels.clear();

// 			for (const entry of entries) {
// 				const keys = this.keybindingService.lookupKeybinding(entry.id);
// 				if (!keys) {
// 					continue;
// 				}

// 				const dl = append(box, $('dl'));
// 				const dt = append(dl, $('dt'));
// 				dt.textContent = entry.text;

// 				const dd = append(dl, $('dd'));

// 				const label = this.keybindingLabels.add(new KeybindingLabel(dd, OS, { renderUnboundKeybindings: true, ...defaultKeybindingLabelStyles }));
// 				label.set(keys);
// 			}
// 		};

// 		update();
// 		this.transientDisposables.add(this.keybindingService.onDidUpdateKeybindings(update));
// 	}

// 	private filterEntries(entries: WatermarkEntry[], shuffleEntries: boolean): WatermarkEntry[] {
// 		const filteredEntries = entries
// 			.filter(entry => (isWeb && !entry.when?.web) || (!isWeb && !entry.when?.native) || this.cachedWhen[entry.id])
// 			.filter(entry => !!CommandsRegistry.getCommand(entry.id))
// 			.filter(entry => !!this.keybindingService.lookupKeybinding(entry.id));

// 		if (shuffleEntries) {
// 			shuffle(filteredEntries);
// 		}

// 		return filteredEntries;
// 	}
// }

// registerColor('editorWatermark.foreground', { dark: transparent(editorForeground, 0.6), light: transparent(editorForeground, 0.68), hcDark: editorForeground, hcLight: editorForeground }, localize('editorLineHighlight', 'Foreground color for the labels in the editor watermark.'));
