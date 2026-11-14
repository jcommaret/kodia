/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseModelOverrides, parseModelOverridesText } from '../../common/helpers/modelOverridesInput.js';
import { defaultModelsOfProvider, getModelCapabilities } from '../../common/modelCapabilities.js';
import { defaultOverridesOfModel } from '../../common/voidSettingsTypes.js';

suite('Kodia - the capabilities a user sets for a model', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the settings that are well formed', () => {
		const overrides = { contextWindow: 32_000, reservedOutputTokenSpace: 8_000, supportsSystemMessage: 'system-role', specialToolFormat: 'openai-style', supportsVision: true, reasoningCapabilities: false };
		assert.deepStrictEqual(parseModelOverrides(overrides), { overrides });
	});

	test('reads empty text, and empty values, as "keep Kodia\'s defaults"', () => {
		assert.deepStrictEqual(parseModelOverridesText('  '), { overrides: {} });
		assert.deepStrictEqual(parseModelOverridesText('{ "contextWindow": null, "supportsFIM": "" }'), { overrides: {} });
	});

	test('says what is wrong instead of saving it', () => {
		const errorOf = (input: unknown) => { const result = parseModelOverrides(input); return result.error ?? ''; };
		assert.ok(errorOf({ contextWindow: '32000' }).includes('"contextWindow"'));
		assert.ok(errorOf({ contextWindow: -1 }).includes('"contextWindow"'));
		assert.ok(errorOf({ reservedOutputTokenSpace: 1.5 }).includes('"reservedOutputTokenSpace"'));
		assert.ok(errorOf({ specialToolFormat: 'openai' }).includes('"openai-style"'));
		assert.ok(errorOf({ supportsSystemMessage: true }).includes('"supportsSystemMessage"'));
		assert.ok(errorOf({ supportsVision: 'yes' }).includes('"supportsVision"'));
		assert.ok(errorOf({ reasoningCapabilities: { supportsReasoning: true } }).includes('canTurnOffReasoning'));
		assert.ok(errorOf({ contextwindow: 32_000 }).includes('"contextwindow"'), 'a misspelled key is reported');
		assert.ok(errorOf([1]).includes('JSON object'));
		assert.ok((parseModelOverridesText('{ contextWindow: 1 }').error ?? '').includes('valid JSON'));
	});

	test('a tool format of null turns native tool calling off', () => {
		const parsed = parseModelOverridesText('{ "specialToolFormat": null }');
		assert.deepStrictEqual(parsed, { overrides: { specialToolFormat: null } });

		const modelName = defaultModelsOfProvider.openAI.find(name => getModelCapabilities('openAI', name, undefined).specialToolFormat === 'openai-style');
		assert.ok(modelName, 'an OpenAI model of the catalog calls tools natively');
		const overridesOfModel = { ...defaultOverridesOfModel, openAI: { [modelName]: { specialToolFormat: null } } };
		const capabilities = getModelCapabilities('openAI', modelName, overridesOfModel);
		assert.strictEqual(capabilities.specialToolFormat, undefined);
		assert.strictEqual(capabilities.contextWindow, getModelCapabilities('openAI', modelName, undefined).contextWindow);
	});

	test('an unknown model takes the context window and the tool format the user gives it', () => {
		const overridesOfModel = { ...defaultOverridesOfModel, lmStudio: { 'my-own-finetune': { contextWindow: 64_000, specialToolFormat: 'openai-style' as const } } };
		const capabilities = getModelCapabilities('lmStudio', 'my-own-finetune', overridesOfModel);
		assert.strictEqual(capabilities.contextWindow, 64_000);
		assert.strictEqual(capabilities.specialToolFormat, 'openai-style');
	});
});
