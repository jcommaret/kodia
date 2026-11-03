/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { PromptsConfig } from '../../chat/common/promptSyntax/config/config.js';
import { IAgentSkill } from '../../chat/common/promptSyntax/service/promptsService.js';

// Agent skills: folders with a SKILL.md (superpowers, BMAD, gstack, ...) whose frontmatter gives a name and a description.
// The chat lists only those, and the agent reads a skill's SKILL.md with read_file when a task matches it.
// Discovery is the chat contrib's (IPromptsService.findAgentSkills): it reads the folders of `chat.agentSkillsLocations`
// (.agents/skills, .claude/skills, ~/.claude/skills, ...), parses each frontmatter and watches the folders.

export const KODIA_SKILLS_FOLDER = '.kodia/skills'

// Kodia's own folder, added to the default of `chat.agentSkillsLocations` (object defaults are merged)
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: { [PromptsConfig.SKILLS_LOCATION_KEY]: { [KODIA_SKILLS_FOLDER]: true } },
}])

export type SkillOfPrompt = { name: string, description: string, path: string }

// The skills the agent may load on its own: it matches a task with a skill's description, and a skill with
// `disable-model-invocation: true` is only for the user to run
export const skillsOfPrompt = (skills: readonly IAgentSkill[] | undefined): SkillOfPrompt[] => {
	const ans: SkillOfPrompt[] = []
	for (const skill of skills ?? []) {
		const description = skill.description?.trim()
		if (!description || skill.disableModelInvocation) continue
		ans.push({ name: skill.name, description, path: skill.uri.fsPath })
	}
	return ans
}
