/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { KODIA_SKILLS_FOLDER, skillsOfPrompt } from '../../../../platform/kodia/common/projectInstructions.js';
import { PromptsConfig } from '../../chat/common/promptSyntax/config/config.js';

// the skills' types and prompt are shared with the Kodia agent of the Agents window
export { KODIA_SKILLS_FOLDER, skillsOfPrompt }
export type { SkillOfPrompt } from '../../../../platform/kodia/common/projectInstructions.js';

// Agent skills: folders with a SKILL.md (superpowers, BMAD, gstack, ...) whose frontmatter gives a name and a description.
// The chat lists only those, and the agent reads a skill's SKILL.md with read_file when a task matches it.
// Discovery is the chat contrib's (IPromptsService.findAgentSkills): it reads the folders of `chat.agentSkillsLocations`
// (.agents/skills, .claude/skills, ~/.claude/skills, ...), parses each frontmatter and watches the folders.

// Kodia's own folder, added to the default of `chat.agentSkillsLocations` (object defaults are merged)
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: { [PromptsConfig.SKILLS_LOCATION_KEY]: { [KODIA_SKILLS_FOLDER]: true } },
}])
