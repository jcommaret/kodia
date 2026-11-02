/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { IUserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfile.js';
import { TestContextService, TestUserDataProfileService, TestWorkspaceTrustManagementService } from '../../../../test/common/workbenchTestServices.js';
import { PromptsConfig } from '../../../chat/common/promptSyntax/config/config.js';
import { PromptFileParser } from '../../../chat/common/promptSyntax/promptFileParser.js';
import { IAgentSkill, PromptsStorage } from '../../../chat/common/promptSyntax/service/promptsService.js';
import { PromptFilesLocator } from '../../../chat/common/promptSyntax/utils/promptFilesLocator.js';
import { KODIA_SKILLS_FOLDER, skillsOfPrompt } from '../../common/agentSkills.js';
import { chat_skills } from '../../common/prompt/prompts.js';

const headerOf = (content: string) => new PromptFileParser().parse(URI.file('/skills/a-skill/SKILL.md'), content).header

const skill = (name: string, description: string | undefined, rest?: Partial<IAgentSkill>): IAgentSkill => ({
	uri: URI.file(`/repo/.claude/skills/${name}/SKILL.md`), storage: PromptsStorage.local, name, description, disableModelInvocation: false, userInvocable: true, ...rest,
})

suite('Kodia - agent skills', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	suite('SKILL.md frontmatter', () => {
		test('reads the name and a quoted description (superpowers, BMAD)', () => {
			const header = headerOf('---\nname: brainstorming\ndescription: "You MUST use this before any creative work: features, components, behavior changes."\n---\n\n# Brainstorming\n')
			assert.strictEqual(header?.name, 'brainstorming')
			assert.strictEqual(header?.description, 'You MUST use this before any creative work: features, components, behavior changes.')

			const singleQuoted = headerOf(`---\nname: bmad-create-prd\ndescription: 'Create a PRD from scratch. Use when the user says "lets create a product requirements document"'\n---\n`)
			assert.strictEqual(singleQuoted?.description, 'Create a PRD from scratch. Use when the user says "lets create a product requirements document"')
		})

		test('reads an unquoted description (mattpocock/skills, agent-skills)', () => {
			const header = headerOf('---\nname: tdd\ndescription: Test-driven development with a red-green-refactor loop. Use when the user wants to build features test-first.\n---\nBody')
			assert.strictEqual(header?.name, 'tdd')
			assert.strictEqual(header?.description, 'Test-driven development with a red-green-refactor loop. Use when the user wants to build features test-first.')
		})

		test('reads a multi-line description next to other keys (gstack)', () => {
			const header = headerOf('---\nname: ship\nversion: 1.0.0\ndescription: |\n  Ship workflow: merge main, run tests, open a PR.\n  Use when asked to ship or deploy.\nallowed-tools:\n  - Bash\n  - Read\n---\n# Ship\n')
			assert.strictEqual(header?.name, 'ship')
			assert.strictEqual(header?.description?.trim(), 'Ship workflow: merge main, run tests, open a PR.\nUse when asked to ship or deploy.')
		})

		test('reads disable-model-invocation, and nothing without a frontmatter', () => {
			assert.strictEqual(headerOf('---\nname: deploy\ndescription: Deploy the app\ndisable-model-invocation: true\n---\n')?.disableModelInvocation, true)
			assert.strictEqual(headerOf('# Just a title\n\nSome text.'), undefined)
		})
	})

	suite('discovery', () => {
		const workspaceFolder = URI.file('/repo')
		const userHome = URI.file('/home/user')

		let fileService: IFileService
		let locator: PromptFilesLocator

		const writeFiles = async (paths: string[]) => {
			for (const path of paths) await fileService.writeFile(URI.file(path), VSBuffer.fromString(`---\nname: x\ndescription: y\n---\n`))
		}

		setup(() => {
			const instantiationService = disposables.add(new TestInstantiationService())
			instantiationService.stub(ILogService, new NullLogService())

			fileService = disposables.add(new FileService(new NullLogService()))
			disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())))
			instantiationService.stub(IFileService, fileService)

			// the default of `chat.agentSkillsLocations` with Kodia's folder, as the configuration registry merges it
			const configurationService = new TestConfigurationService()
			const skillsLocations = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationDefaultsOverrides().get(PromptsConfig.SKILLS_LOCATION_KEY)?.value
			configurationService.setUserConfiguration(PromptsConfig.SKILLS_LOCATION_KEY, skillsLocations)
			instantiationService.stub(IConfigurationService, configurationService)

			instantiationService.stub(IWorkspaceContextService, new TestContextService(testWorkspace(workspaceFolder)))
			instantiationService.stub(IWorkbenchEnvironmentService, {})
			instantiationService.stub(ISearchService, {})
			instantiationService.stub(IUserDataProfileService, new TestUserDataProfileService())
			instantiationService.stub(IPathService, { userHome: () => Promise.resolve(userHome) } as unknown as IPathService)
			instantiationService.stub(IWorkspaceTrustManagementService, disposables.add(new TestWorkspaceTrustManagementService()))

			locator = instantiationService.createInstance(PromptFilesLocator)
		})

		test('Kodia adds .kodia/skills to the default skill folders', () => {
			const skillsLocations = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationDefaultsOverrides().get(PromptsConfig.SKILLS_LOCATION_KEY)?.value as Record<string, boolean> | undefined
			assert.strictEqual(skillsLocations?.[KODIA_SKILLS_FOLDER], true)
		})

		test('finds the skills of the workspace and of the user\'s home, one per folder with a SKILL.md', async () => {
			await writeFiles([
				'/repo/.kodia/skills/kodia-skill/SKILL.md',
				'/repo/.claude/skills/claude-skill/SKILL.md',
				'/repo/.agents/skills/agents-skill/SKILL.md',
				'/home/user/.claude/skills/user-claude-skill/SKILL.md',
				'/home/user/.agents/skills/user-agents-skill/SKILL.md',
				// not skills: no SKILL.md in the folder, a file outside a skill folder, a folder that isn't a skill folder
				'/repo/.claude/skills/notes/README.md',
				'/repo/.claude/skills/SKILL.md',
				'/repo/skills/other-skill/SKILL.md',
			])

			const found = (await locator.findAgentSkills(CancellationToken.None)).map(s => `${s.storage} ${s.uri.path}`).sort()
			assert.deepStrictEqual(found, [
				'local /repo/.agents/skills/agents-skill/SKILL.md',
				'local /repo/.claude/skills/claude-skill/SKILL.md',
				'local /repo/.kodia/skills/kodia-skill/SKILL.md',
				'user /home/user/.agents/skills/user-agents-skill/SKILL.md',
				'user /home/user/.claude/skills/user-claude-skill/SKILL.md',
			])
		})

		test('finds nothing without skill folders', async () => {
			await writeFiles(['/repo/README.md'])
			assert.deepStrictEqual(await locator.findAgentSkills(CancellationToken.None), [])
		})
	})

	suite('system prompt', () => {
		test('lists the skills the agent may load, with their file', () => {
			assert.deepStrictEqual(skillsOfPrompt([
				skill('tdd', ' Use when writing tests first. '),
				skill('no-description', undefined),
				skill('deploy', 'Deploy the app', { disableModelInvocation: true }),
			]), [{ name: 'tdd', description: 'Use when writing tests first.', path: URI.file('/repo/.claude/skills/tdd/SKILL.md').fsPath }])
			assert.deepStrictEqual(skillsOfPrompt(undefined), [])
		})

		test('gives each skill\'s name, description and file, and tells the agent to read it with read_file', () => {
			const prompt = chat_skills([{ name: 'tdd', description: 'Use when writing tests first.', path: '/repo/.claude/skills/tdd/SKILL.md' }])
			assert.ok(prompt.includes('<skill>\n<name>tdd</name>\n<description>Use when writing tests first.</description>\n<file>/repo/.claude/skills/tdd/SKILL.md</file>\n</skill>'))
			assert.ok(prompt.includes('read_file'))
		})

		test('past the descriptions budget, lists the remaining skills by name and file only', () => {
			const longDescription = 'x'.repeat(15_000)
			const prompt = chat_skills([
				{ name: 'first', description: longDescription, path: '/s/first/SKILL.md' },
				{ name: 'second', description: longDescription, path: '/s/second/SKILL.md' },
				{ name: 'third', description: 'short', path: '/s/third/SKILL.md' },
			])
			assert.ok(prompt.includes(`<name>first</name>\n<description>${longDescription}</description>`))
			assert.ok(prompt.includes('<skill>\n<name>second</name>\n<file>/s/second/SKILL.md</file>\n</skill>'))
			assert.ok(prompt.includes('<skill>\n<name>third</name>\n<file>/s/third/SKILL.md</file>\n</skill>'))
		})
	})
})
