/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { builtinInstructionsFrameworks, instructionsFrameworkContentForKodia, joinUserInstructions, rawURLsOfFrameworkSource } from '../../common/instructionsFrameworks.js';

suite('Kodia - instructions frameworks', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('adds the frameworks that are on after the user\'s instructions', () => {
		assert.strictEqual(
			joinUserInstructions('Answer in French.', [
				{ id: 'karpathy', name: 'Karpathy guidelines', sourceURL: 'https://example.com/CLAUDE.md', content: '# Think before coding\n', isOn: true },
				{ id: 'aidd', name: 'AI-Driven Dev', sourceURL: 'https://example.com/AGENTS.md', content: 'Be critical.', isOn: false },
				{ id: 'mine', name: 'Mine', sourceURL: '', content: '  ', isOn: true },
			]),
			'Answer in French.\n\nFrom Karpathy guidelines:\n# Think before coding',
		);
		assert.strictEqual(joinUserInstructions('', [{ id: 'mine', name: 'Mine', sourceURL: '', content: 'Use tabs.', isOn: true }]), 'From Mine:\nUse tabs.');
		assert.strictEqual(joinUserInstructions('', []), '');
	});

	test('downloads a GitHub file page\'s raw file, and a repository\'s AGENTS.md or CLAUDE.md', () => {
		assert.deepStrictEqual(
			rawURLsOfFrameworkSource('https://github.com/ai-driven-dev/framework/blob/main/plugins/aidd-context/AGENTS.md'),
			['https://raw.githubusercontent.com/ai-driven-dev/framework/main/plugins/aidd-context/AGENTS.md'],
		);
		assert.deepStrictEqual(
			rawURLsOfFrameworkSource('https://github.com/multica-ai/andrej-karpathy-skills.git'),
			['https://raw.githubusercontent.com/multica-ai/andrej-karpathy-skills/HEAD/AGENTS.md', 'https://raw.githubusercontent.com/multica-ai/andrej-karpathy-skills/HEAD/CLAUDE.md'],
		);
		assert.deepStrictEqual(rawURLsOfFrameworkSource('https://example.com/rules.md'), ['https://example.com/rules.md']);
	});

	test('Kodia\'s frameworks each have their own id and a raw file to download', () => {
		const ids = builtinInstructionsFrameworks.map(f => f.id);
		assert.strictEqual(new Set(ids).size, ids.length);
		for (const { sourceURL } of builtinInstructionsFrameworks) {
			assert.deepStrictEqual(rawURLsOfFrameworkSource(sourceURL), [sourceURL]);
			assert.ok(sourceURL.startsWith('https://raw.githubusercontent.com/'), sourceURL);
		}
	});

	test('refuses what isn\'t a file or a repository', () => {
		assert.throws(() => rawURLsOfFrameworkSource('https://github.com/ai-driven-dev'));
		assert.throws(() => rawURLsOfFrameworkSource('not a link'));
		assert.throws(() => rawURLsOfFrameworkSource('file:///etc/passwd'));
	});

	test('keeps AIDD\'s guidelines Kodia can follow: no aidd_docs/ memory, subagents, batched calls or compaction', () => {
		const aidd = [
			'# AGENTS.md',
			'',
			'## Behavior',
			'',
			'- Stay critical.',
			'- Docs are in `aidd_docs/` too.',
			'- **If the user is frustrated, address the cause first; offer compaction if that doesn\'t help.**',
			'',
			'## Memory Management',
			'',
			'Project docs and memory live in `aidd_docs/`.',
			'',
			'<!-- aidd_project_memory:start -->',
			'<!-- aidd_project_memory:end -->',
			'',
			'### Loading',
			'- Load `aidd_docs/memory/internal/*` when relevant.',
			'',
			'## Action',
			'',
			'- Keep changes minimal.',
			'- **Batch independent operations when it saves time.**',
			'- **Fan out genuinely independent subtasks when it costs less.**',
			'',
		].join('\n');
		const adapted = '## Behavior\n\n- Stay critical.\n- **If the user is frustrated, address the cause first.**\n\n## Action\n\n- Keep changes minimal.';
		assert.strictEqual(instructionsFrameworkContentForKodia('aidd', aidd), adapted);
		// the section is the last one, as in AIDD's file
		assert.strictEqual(instructionsFrameworkContentForKodia('aidd', '## Behavior\n- Stay critical.\n\n## Memory Management\nIn `aidd_docs/`.\n'), '## Behavior\n- Stay critical.');
		// once adapted, and stored, it stays as it is
		assert.strictEqual(instructionsFrameworkContentForKodia('aidd', adapted), adapted);
		// other frameworks, the user's included, are kept as downloaded
		assert.strictEqual(instructionsFrameworkContentForKodia('karpathy', aidd), aidd);
		assert.strictEqual(instructionsFrameworkContentForKodia('6f1c0d8e-0000-4000-8000-000000000000', aidd), aidd);
	});
});
