/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../files/common/files.js';
import { readSkills } from '../../../agentPlugins/common/pluginParsers.js';
import { joinProjectRules, KODIA_SKILLS_FOLDER, PROJECT_RULES_FILE_NAMES, SkillOfPrompt, skillsOfPrompt } from '../../../kodia/common/projectInstructions.js';

// What the Kodia agent of the Agents window knows about its session's project beyond the model's tools: the
// project's rules files and agent skills, which Kodia's chat reads through the editor. The agent works on its
// session's folder, not on an editor window's workspace, so they are read from there, from disk.

// the folders of skills, as in the chat's `chat.agentSkillsLocations`: in the project, and in the user's home
const PROJECT_SKILL_FOLDERS = ['.agents/skills', '.github/skills', '.claude/skills', KODIA_SKILLS_FOLDER]
const USER_SKILL_FOLDERS = ['.agents/skills', '.copilot/skills', '.claude/skills', KODIA_SKILLS_FOLDER]

// sent with every request, as the chat's frameworks are: past this, a rules file is cut
const MAX_RULES_CHARS = 50_000

/**
 * The rules files (.voidrules, AGENTS.md, CLAUDE.md, ...) at the root of the project, labeled with their path,
 * in the chat's order. A file that can't be read is skipped, and a long one is cut.
 */
export async function readProjectRules(workingDirectory: URI | undefined, fileService: IFileService): Promise<string> {
	if (!workingDirectory) {
		return '';
	}
	const files: { path: string; content: string }[] = [];
	await Promise.all(PROJECT_RULES_FILE_NAMES.map(async (fileName, i) => {
		try {
			const content = (await fileService.readFile(URI.joinPath(workingDirectory, fileName))).value.toString();
			files[i] = { path: fileName, content: content.length > MAX_RULES_CHARS ? `${content.slice(0, MAX_RULES_CHARS)}\n(This file is cut here: read ${fileName} for the rest.)` : content };
		} catch {
			// no such file, or not readable
		}
	}));
	return joinProjectRules(files.filter(file => !!file));
}

/**
 * The skills the model may load on its own, from the project's skill folders then the user's: a skill found in
 * several folders (the folders are often symlinked to each other) is listed once, the project's first.
 */
export async function readProjectSkills(workingDirectory: URI | undefined, userHome: URI, fileService: IFileService): Promise<SkillOfPrompt[]> {
	const roots = [
		...(workingDirectory ? PROJECT_SKILL_FOLDERS.map(folder => URI.joinPath(workingDirectory, folder)) : []),
		...USER_SKILL_FOLDERS.map(folder => URI.joinPath(userHome, folder)),
	];
	const found = await Promise.all(roots.map(root => readSkills(root, [root], fileService, { childDirectoriesOnly: true }).catch(() => [])));
	const names = new Set<string>();
	return skillsOfPrompt(found.flat().filter(skill => {
		if (names.has(skill.name)) {
			return false;
		}
		names.add(skill.name);
		return true;
	}));
}
