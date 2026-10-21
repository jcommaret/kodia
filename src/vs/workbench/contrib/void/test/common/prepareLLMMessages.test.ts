/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { deepClone } from '../../../../../base/common/objects.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { prepareSimpleLLMMessages } from '../../common/prepareLLMMessages.js';
import { defaultOverridesOfModel, OptionsOfModelSelection } from '../../common/voidSettingsTypes.js';

suite('prepareLLMMessages', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const settings = () => ({
		overridesOfModel: deepClone(defaultOverridesOfModel),
		optionsOfModelSelection: { 'Chat': {}, 'Ctrl+K': {}, 'Autocomplete': {}, 'Apply': {}, 'SCM': {} } satisfies OptionsOfModelSelection,
	});

	test('puts the user\'s instructions, then the system message, in the system message', () => {
		const { messages, separateSystemMessage } = prepareSimpleLLMMessages({
			simpleMessages: [{ role: 'user', content: 'Fix the build' }],
			systemMessage: 'You are a coding agent.',
			aiInstructions: 'Answer in French.',
			modelSelection: { providerName: 'anthropic', modelName: 'claude-sonnet-4-5' },
			featureName: 'Chat',
			...settings(),
		});

		assert.strictEqual(separateSystemMessage, 'GUIDELINES AND MEMORY (from the user\'s settings, the project\'s rules files, and project memory):\nAnswer in French.\n\nYou are a coding agent.');
		assert.deepStrictEqual(messages, [{ role: 'user', content: 'Fix the build' }]);
	});

	test('converts a tool call and its result to Gemini\'s format', () => {
		const { messages, separateSystemMessage } = prepareSimpleLLMMessages({
			simpleMessages: [
				{ role: 'user', content: 'Read x.ts' },
				{ role: 'assistant', content: '', anthropicReasoning: null },
				{ role: 'tool', id: 'a', name: 'read_file', rawParams: { path: 'x.ts' }, content: 'contents' },
			],
			systemMessage: 'You are a coding agent.',
			aiInstructions: '',
			modelSelection: { providerName: 'gemini', modelName: 'gemini-2.5-flash' },
			featureName: 'Chat',
			...settings(),
		});

		assert.strictEqual(separateSystemMessage, 'You are a coding agent.');
		assert.deepStrictEqual(messages.map(m => m.role), ['user', 'model', 'user']);
	});
});
