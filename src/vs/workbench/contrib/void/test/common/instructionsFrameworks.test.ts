/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { builtinInstructionsFrameworks, joinUserInstructions, rawURLsOfFrameworkSource } from '../../common/instructionsFrameworks.js';

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
});
