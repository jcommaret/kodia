/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { canonicalModelNameForProvider, contextWindowOfListedModel, contextWindowsOfListedModels, normalizeAutodetectedModelNamesForProvider } from '../../common/localSingleModelProviders.js';
import { getModelCapabilities, setDetectedModelOptions } from '../../common/modelCapabilities.js';
import { defaultOverridesOfModel, defaultSettingsOfProvider } from '../../common/voidSettingsTypes.js';

suite('Kodia - autodetected model names', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('MLX lists every model of the server, once, in the server\'s order', () => {
		assert.deepStrictEqual(normalizeAutodetectedModelNamesForProvider('mlx', ['mlx-community/Qwen3-8B', 'mlx-community/Qwen2.5-Coder-1.5B-Instruct-4bit', 'mlx-community/Qwen3-8B', 'other']), ['mlx-community/Qwen3-8B', 'mlx-community/Qwen2.5-Coder-1.5B-Instruct-4bit', 'other']);
		assert.deepStrictEqual(normalizeAutodetectedModelNamesForProvider('mlx', []), []);
	});

	test('maps dated Anthropic ids to the catalog name, so one model is listed once', () => {
		assert.strictEqual(canonicalModelNameForProvider('anthropic', 'claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
		assert.strictEqual(canonicalModelNameForProvider('anthropic', 'claude-sonnet-5-5'), 'claude-sonnet-5-5');
	});

	test('a Gemini preview keeps its name', () => {
		assert.strictEqual(canonicalModelNameForProvider('gemini', 'gemini-3.1-pro-preview'), 'gemini-3.1-pro-preview');
	});

	suite('the context window a local server gives a model', () => {
		teardown(() => setDetectedModelOptions(defaultSettingsOfProvider));

		test('is the one the model is loaded with, over the one it could take', () => {
			assert.strictEqual(contextWindowOfListedModel({ id: 'a', loaded_context_length: 32_768, max_context_length: 131_072 }), 32_768, 'LM Studio, a loaded model');
			assert.strictEqual(contextWindowOfListedModel({ id: 'a', max_context_length: 131_072 }), 131_072, 'LM Studio, a model not loaded yet');
			assert.strictEqual(contextWindowOfListedModel({ id: 'a', max_model_len: 16_384 }), 16_384, 'vLLM');
			assert.strictEqual(contextWindowOfListedModel({ id: 'a', context_length: 8_192.5 }), 8_192);
		});

		test('is unknown when the server does not say, or says nonsense', () => {
			for (const model of [{ id: 'a' }, { id: 'a', context_length: 0 }, { id: 'a', context_length: '32000' }, { id: 'a', max_model_len: null }, null, 'a']) {
				assert.strictEqual(contextWindowOfListedModel(model), undefined, JSON.stringify(model));
			}
		});

		test('is kept by model name, for the models that have one', () => {
			assert.deepStrictEqual(
				contextWindowsOfListedModels('lmStudio', [{ id: 'qwen-coder', loaded_context_length: 32_768 }, { id: 'no-window' }, { context_length: 1_000 }]),
				{ 'qwen-coder': { contextWindow: 32_768 } });
		});

		test('replaces the 4096 tokens Kodia assumes of an LM Studio model, and leaves the rest of what it knows', () => {
			const withModels = (models: { modelName: string; detectedCapabilities?: { contextWindow: number } }[]) =>
				setDetectedModelOptions({ ...defaultSettingsOfProvider, lmStudio: { ...defaultSettingsOfProvider.lmStudio, models: models.map(model => ({ ...model, type: 'autodetected' as const, isHidden: false })) } });

			assert.strictEqual(getModelCapabilities('lmStudio', 'devstral', undefined).contextWindow, 4_096);

			withModels([{ modelName: 'devstral', detectedCapabilities: { contextWindow: 32_768 } }, { modelName: 'my-own-finetune', detectedCapabilities: { contextWindow: 16_000 } }]);
			const known = getModelCapabilities('lmStudio', 'devstral', undefined);
			assert.strictEqual(known.contextWindow, 32_768);
			assert.strictEqual(known.specialToolFormat, 'openai-style');
			assert.strictEqual(known.isUnrecognizedModel, false);

			const unknown = getModelCapabilities('lmStudio', 'my-own-finetune', undefined);
			assert.strictEqual(unknown.contextWindow, 16_000);
			assert.strictEqual(unknown.isUnrecognizedModel, true, 'a context window is not enough to know a model');

			const overridden = getModelCapabilities('lmStudio', 'devstral', { ...defaultOverridesOfModel, lmStudio: { devstral: { contextWindow: 8_000 } } });
			assert.strictEqual(overridden.contextWindow, 8_000, 'what the user sets wins');
		});
	});
});
