/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

// Kodia: until Kodia had its own identifiers, its data folders had Void's names (~/.void-editor for the extensions
// and argv.json, ~/.void-editor-shared for the shared storage). The first time a new name is missing, the old folder
// is copied to it, so extensions and settings carry over. A copy, not a move: Void itself may still use the old one.

import * as path from 'node:path';
import type * as nodeFs from 'node:fs';

export type LegacyDataFolder = { from: string; to: string };

// fsImpl: Electron's main process passes original-fs, so .asar files inside extensions are copied as files
export function copyLegacyDataFolders(fsImpl: typeof nodeFs, homeDir: string, folders: readonly LegacyDataFolder[]): void {
	for (const { from, to } of folders) {
		if (!from || !to || from === to) {
			continue;
		}
		const source = path.join(homeDir, from);
		const target = path.join(homeDir, to);
		try {
			if (fsImpl.existsSync(target) || !fsImpl.existsSync(source)) {
				continue;
			}
			// into a temporary folder first: a copy cut short is redone on the next launch
			const partial = `${target}.copying`;
			fsImpl.rmSync(partial, { recursive: true, force: true });
			// cloned on APFS and Btrfs, so even a large extensions folder copies quickly
			fsImpl.cpSync(source, partial, { recursive: true, verbatimSymlinks: true, mode: fsImpl.constants.COPYFILE_FICLONE });
			fsImpl.renameSync(partial, target);
		} catch (error) {
			console.error(`Unable to copy ${source} to ${target}: ${error}`);
		}
	}
}
