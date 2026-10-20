/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getShownModelIds, isShownModel } from '../../common/agentShownModels.js';

suite('agentShownModels', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('getShownModelIds reads one agent\'s entry and ignores malformed ones', () => {
		assert.strictEqual(getShownModelIds(undefined, 'claude'), undefined);
		assert.strictEqual(getShownModelIds({ codex: ['gpt-5.5'] }, 'claude'), undefined, 'an agent without an entry is not filtered');
		assert.deepStrictEqual(getShownModelIds({ claude: [] }, 'claude'), [], 'an empty entry hides every model');
		assert.deepStrictEqual(getShownModelIds({ claude: ['claude-opus-4-7', 42] }, 'claude'), ['claude-opus-4-7']);
		assert.strictEqual(getShownModelIds({ claude: 'claude-opus-4-7' }, 'claude'), undefined);
	});

	test('isShownModel matches exactly, ignoring case and a release date', () => {
		const shown = ['claude-sonnet-4-5', 'gpt-4o', 'GPT-5.5'];
		assert.ok(isShownModel('claude-sonnet-4-5', shown));
		assert.ok(isShownModel('claude-sonnet-4-5-20250929', shown));
		assert.ok(isShownModel('gpt-4o-2024-08-06', shown));
		assert.ok(isShownModel('gpt-5.5', shown));
		assert.ok(!isShownModel('gpt-5.5-codex', shown));
		assert.ok(!isShownModel('claude-sonnet-4', shown));
		assert.ok(!isShownModel('claude-opus-4-7', []));
	});
});
