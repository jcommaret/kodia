/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	commandNameFromRelativePath,
	CustomSlashCommand,
	expandCustomCommandPrompt,
	parseCustomCommandMarkdown,
	parseSlashCommandInvocation,
} from '../common/customCommands.js';

const PROJECT_COMMAND_DIRS = ['.kodia/commands', '.claude/commands'] as const;

export const ICustomCommandsService = createDecorator<ICustomCommandsService>('kodiaCustomCommandsService');

export interface ICustomCommandsService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeCommands: Event<void>;

	/** Discover and return all available custom slash commands in the workspace. */
	listCommands(): Promise<readonly CustomSlashCommand[]>;
	/** If `input` starts with a known `/command`, return the expanded prompt and matched command. */
	tryExpandSlashCommand(input: string): Promise<{ command: CustomSlashCommand; expandedPrompt: string; rawArgs: string } | undefined>;
}

export class CustomCommandsService extends Disposable implements ICustomCommandsService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeCommands = this._register(new Emitter<void>());
	readonly onDidChangeCommands: Event<void> = this._onDidChangeCommands.event;

	private _cache: CustomSlashCommand[] | undefined;
	private _cacheAt = 0;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._register(this._workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this._cache = undefined;
			this._onDidChangeCommands.fire();
		}));
	}

	async listCommands(): Promise<readonly CustomSlashCommand[]> {
		const now = Date.now();
		if (this._cache && now - this._cacheAt < 2_000) {
			return this._cache;
		}

		const byName = new Map<string, CustomSlashCommand>();
		const folders = this._workspaceContextService.getWorkspace().folders;

		for (const folder of folders) {
			for (const relDir of PROJECT_COMMAND_DIRS) {
				const dirUri = URI.joinPath(folder.uri, relDir);
				await this._scanDirectory(dirUri, '', 'project', byName);
			}
		}

		this._cache = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
		this._cacheAt = now;
		return this._cache;
	}

	private async _scanDirectory(
		dirUri: URI,
		prefix: string,
		scope: 'project' | 'user',
		out: Map<string, CustomSlashCommand>,
		depth = 0,
	): Promise<void> {
		if (depth > 3) { return; }
		let stat;
		try {
			stat = await this._fileService.resolve(dirUri);
		} catch {
			return;
		}
		if (!stat.isDirectory || !stat.children) { return; }

		for (const child of stat.children) {
			const rel = prefix ? `${prefix}/${child.name}` : child.name;
			if (child.isDirectory) {
				await this._scanDirectory(child.resource, rel, scope, out, depth + 1);
			} else if (child.name.toLowerCase().endsWith('.md')) {
				try {
					const content = (await this._fileService.readFile(child.resource)).value.toString();
					const name = commandNameFromRelativePath(rel);
					const cmd = parseCustomCommandMarkdown(name, child.resource.fsPath, scope, content);
					if (cmd && !out.has(cmd.name)) {
						out.set(cmd.name, cmd);
					}
				} catch {
					// Skip unreadable file
				}
			}
		}
	}

	async tryExpandSlashCommand(input: string): Promise<{ command: CustomSlashCommand; expandedPrompt: string; rawArgs: string } | undefined> {
		const inv = parseSlashCommandInvocation(input);
		if (!inv) { return undefined; }
		const commands = await this.listCommands();
		const match = commands.find(c => c.name === inv.commandName);
		if (!match) { return undefined; }
		return {
			command: match,
			expandedPrompt: expandCustomCommandPrompt(match, inv.rawArgs),
			rawArgs: inv.rawArgs,
		};
	}
}

registerSingleton(ICustomCommandsService, CustomCommandsService, InstantiationType.Delayed);
