/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';

// The project's own instructions (rules files, agent skills), shared by Kodia's chat and the Kodia agent of the
// Agents window: the chat reads them through the editor's services, the agent host from disk.

export const KODIA_SKILLS_FOLDER = '.kodia/skills'


// The instruction files read from the root of each workspace folder: Kodia's own, then the ones
// other agents use, so a project set up for Codex, Claude Code, Cursor or Windsurf works as is
export const PROJECT_RULES_FILE_NAMES = ['.voidrules', 'AGENTS.md', 'CLAUDE.md', '.cursorrules', '.windsurfrules'] as const

// Labels each rules file with its path. A file with the same content as an earlier one (a symlink, a copy) is left out.
export const joinProjectRules = (files: { path: string, content: string }[]): string => {
	const seen = new Set<string>()
	const parts: string[] = []
	for (const { path, content } of files) {
		const trimmed = content.trim()
		if (!trimmed || seen.has(trimmed)) continue
		seen.add(trimmed)
		parts.push(`From ${path}:\n${trimmed}`)
	}
	return parts.join('\n\n')
}


export type SkillOfPrompt = { name: string, description: string, path: string }

// What a skill's discovery gives: the chat's IAgentSkill, or a skill read from disk by the agent host
type DiscoveredSkill = { readonly uri: URI, readonly name: string, readonly description?: string, readonly disableModelInvocation?: boolean }

// The skills the agent may load on its own: it matches a task with a skill's description, and a skill with
// `disable-model-invocation: true` is only for the user to run
export const skillsOfPrompt = (skills: readonly DiscoveredSkill[] | undefined): SkillOfPrompt[] => {
	const ans: SkillOfPrompt[] = []
	for (const skill of skills ?? []) {
		const description = skill.description?.trim()
		if (!description || skill.disableModelInvocation) continue
		ans.push({ name: skill.name, description, path: skill.uri.fsPath })
	}
	return ans
}

// sent with every request: past this, the remaining skills are listed by name and file only
const MAX_SKILL_DESCRIPTIONS_CHARS = 20_000

// The agent skills (SKILL.md files) the agent can load: their name and description only, it reads a skill's file when a task matches it
export const skillsPrompt = (skills: readonly SkillOfPrompt[]) => {
	let descriptionsChars = 0
	const entries = skills.map(({ name, description, path }) => {
		descriptionsChars += description.length
		return descriptionsChars <= MAX_SKILL_DESCRIPTIONS_CHARS
			? `<skill>\n<name>${name}</name>\n<description>${description}</description>\n<file>${path}</file>\n</skill>`
			: `<skill>\n<name>${name}</name>\n<file>${path}</file>\n</skill>`
	})
	return `SKILLS (instructions for specific kinds of tasks, from SKILL.md files in the workspace and the user's home):
When the user's request matches a skill's description, read the skill's file with read_file before you start the task, and follow it. \
A skill can refer to other files in its folder, by paths relative to that folder: read them when the skill tells you to.
<skills>
${entries.join('\n')}
</skills>`
}
