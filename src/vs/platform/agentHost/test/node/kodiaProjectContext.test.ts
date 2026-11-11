/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FileService } from '../../../files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../log/common/log.js';
import { readProjectRules, readProjectSkills } from '../../node/kodia/kodiaProjectContext.js';

suite('Kodia agent project context', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const project = URI.file('/project');
	const userHome = URI.file('/home/me');
	let fileService: FileService;
	const write = (path: string, content: string) => fileService.writeFile(URI.file(path), VSBuffer.fromString(content));
	const skill = (name: string, description: string | undefined, extra = '') => `---\nname: ${name}\n${description ? `description: ${description}\n` : ''}${extra}---\nBody.`;

	setup(() => {
		fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
	});

	test('rules files are read in the chat\'s order, labeled, without copies', async () => {
		await write('/project/.windsurfrules', 'Windsurf rule.');
		await write('/project/CLAUDE.md', '  Same text.  ');
		await write('/project/AGENTS.md', 'Same text.');
		await write('/project/.voidrules', 'Kodia rule.');
		await write('/project/README.md', 'Not a rules file.');
		assert.strictEqual(
			await readProjectRules(project, fileService),
			'From .voidrules:\nKodia rule.\n\nFrom AGENTS.md:\nSame text.\n\nFrom .windsurfrules:\nWindsurf rule.',
		);
	});

	test('there are no rules without a project folder or rules file, and a rules file that is a folder is skipped', async () => {
		assert.strictEqual(await readProjectRules(undefined, fileService), '');
		assert.strictEqual(await readProjectRules(project, fileService), '');
		await write('/project/AGENTS.md/inner.md', 'A folder named like a rules file.');
		await write('/project/CLAUDE.md', 'Real rule.');
		assert.strictEqual(await readProjectRules(project, fileService), 'From CLAUDE.md:\nReal rule.');
	});

	test('a rules file longer than the limit is cut, and says so', async () => {
		await write('/project/AGENTS.md', 'x'.repeat(60_000));
		const rules = await readProjectRules(project, fileService);
		assert.ok(rules.startsWith(`From AGENTS.md:\n${'x'.repeat(50_000)}\n(This file is cut here: read AGENTS.md for the rest.)`), rules.slice(0, 80));
		assert.ok(rules.length < 50_200);
	});

	test('skills come from the project\'s folders, then the user\'s, each name once', async () => {
		await write('/project/.agents/skills/tdd/SKILL.md', skill('tdd', 'Agents copy.'));
		await write('/project/.claude/skills/tdd/SKILL.md', skill('tdd', 'Claude copy.'));
		await write('/project/.github/skills/lint/SKILL.md', skill('lint', 'Use when linting.'));
		await write('/project/.kodia/skills/plan/SKILL.md', skill('plan', 'Use when planning.'));
		await write('/home/me/.claude/skills/review/SKILL.md', skill('review', 'Use when reviewing.'));
		await write('/home/me/.agents/skills/tdd/SKILL.md', skill('tdd', 'The user\'s own.'));
		await write('/home/me/.copilot/skills/ship/SKILL.md', skill('ship', 'Use when shipping.'));

		const skills = await readProjectSkills(project, userHome, fileService);
		assert.deepStrictEqual(
			skills.map(({ name, description }) => [name, description]),
			[['tdd', 'Agents copy.'], ['lint', 'Use when linting.'], ['plan', 'Use when planning.'], ['ship', 'Use when shipping.'], ['review', 'Use when reviewing.']],
		);
		assert.deepStrictEqual(skills.find(s => s.name === 'tdd')?.path, '/project/.agents/skills/tdd/SKILL.md');
	});

	test('a skill with no description, or only for the user to run, is not offered to the model', async () => {
		await write('/project/.claude/skills/nodescription/SKILL.md', skill('nodescription', undefined));
		await write('/project/.claude/skills/manual/SKILL.md', skill('manual', 'Run it by hand.', 'disable-model-invocation: true\n'));
		await write('/project/.claude/skills/ok/SKILL.md', skill('ok', 'Use when needed.'));
		assert.deepStrictEqual((await readProjectSkills(project, userHome, fileService)).map(s => s.name), ['ok']);
	});

	test('a SKILL.md at the root of a skills folder is not a skill, and a project can have none', async () => {
		await write('/home/me/.claude/skills/SKILL.md', skill('stray', 'Not in a skill folder.'));
		assert.deepStrictEqual(await readProjectSkills(project, userHome, fileService), []);
		assert.deepStrictEqual(await readProjectSkills(undefined, userHome, fileService), []);
	});

	test('without a project folder, only the user\'s skills are found', async () => {
		await write('/home/me/.claude/skills/review/SKILL.md', skill('review', 'Use when reviewing.'));
		assert.deepStrictEqual((await readProjectSkills(undefined, userHome, fileService)).map(s => s.name), ['review']);
	});
});
