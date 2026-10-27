/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { catalogModelsOfProvider, defaultModelsOfProvider, getModelCapabilities, getReservedOutputTokenSpace, ModelOverrides } from '../../common/modelCapabilities.js';
import { defaultOverridesOfModel, OverridesOfModel, ProviderName } from '../../common/voidSettingsTypes.js';

// the default (empty) overrides, plus one model's
const overridesWith = (providerName: ProviderName, modelName: string, overrides: Partial<ModelOverrides>): OverridesOfModel =>
	({ ...defaultOverridesOfModel, [providerName]: { [modelName]: overrides } });

suite('Kodia - model capabilities', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recognizes dated, cased and suffixed names of known models', () => {
		const cases: [ProviderName, string, string][] = [
			['anthropic', 'claude-sonnet-5-5-20261001', 'claude-sonnet-5-5'],
			['anthropic', 'Claude-Sonnet-5-5', 'claude-sonnet-5-5'],
			// sonnet-5-5 must not be taken for sonnet-5, nor the other way around
			['anthropic', 'claude-sonnet-5', 'claude-sonnet-5'],
			['openAI', 'GPT-6.1-Sol', 'gpt-6.1-sol'],
			['openAI', 'gpt-6-sol', 'gpt-6-sol'],
			['mistral', 'mistral-large-4-0', 'mistral-large-4'],
			['mistral', 'Mistral-Large-4', 'mistral-large-4'],
		];
		for (const [providerName, modelName, expected] of cases) {
			assert.strictEqual(getModelCapabilities(providerName, modelName, undefined).recognizedModelName, expected, `${providerName}/${modelName}`);
		}
	});

	test('every catalog model is recognized, with consistent prices and media flags', () => {
		for (const [providerName, modelNames] of Object.entries(catalogModelsOfProvider) as [ProviderName, readonly string[]][]) {
			for (const modelName of modelNames) {
				const capabilities = getModelCapabilities(providerName, modelName, undefined);
				const label = `${providerName}/${modelName}`;
				assert.strictEqual(capabilities.isUnrecognizedModel, false, `${label} is a catalog model but isn't recognized`);
				if (capabilities.cost.cache_read !== undefined) {
					assert.ok(capabilities.cost.cache_read <= capabilities.cost.input, `${label}: cache reads cost more than input`);
				}
				// a model that reads PDFs reads images too: PDF pages are sent as images by the providers
				if (capabilities.supportsPDF) {
					assert.ok(capabilities.supportsVision, `${label}: supportsPDF without supportsVision`);
				}
			}
		}
	});

	test('each provider has one default model, from the catalog', () => {
		for (const [providerName, modelNames] of Object.entries(defaultModelsOfProvider) as [ProviderName, readonly string[]][]) {
			assert.ok(modelNames.length <= 1, `${providerName} has ${modelNames.length} default models`);
			for (const modelName of modelNames) {
				assert.ok((catalogModelsOfProvider[providerName] as readonly string[]).includes(modelName), `${providerName}/${modelName} isn't in the catalog`);
			}
		}
	});

	test('Mistral bills prompt-cache hits at 10% of the input price', () => {
		for (const modelName of catalogModelsOfProvider.mistral) {
			if (modelName.startsWith('zai-glm')) {
				continue; // GLM is priced by Z.ai
			}
			const { cost } = getModelCapabilities('mistral', modelName, undefined);
			assert.ok(cost.cache_read !== undefined, `mistral/${modelName} has no cache_read price`);
			// published prices are rounded to the cent (Large 4: $0.07 for an input of $0.68)
			assert.ok(Math.abs(cost.cache_read - cost.input / 10) <= 0.005, `mistral/${modelName}: cache_read should be about input / 10`);
		}
	});

	test('detects vision from the model name for models outside the catalog', () => {
		const cases: [ProviderName, string, boolean][] = [
			// vision models served by local servers
			['ollama', 'llava:13b', true],
			['ollama', 'qwen2.5vl:7b', true],
			['ollama', 'qwen3-vl:8b', true],
			['ollama', 'llama3.2-vision:11b', true],
			['ollama', 'gemma3:27b', true],
			['ollama', 'llama4:scout', true],
			['ollama', 'minicpm-v', true],
			['ollama', 'moondream', true],
			['ollama', 'mistral-small3.1', true],
			['lmStudio', 'google/gemma-3-12b', true],
			['vLLM', 'Qwen/Qwen2.5-VL-7B-Instruct', true],
			// text-only models of families that also have vision models
			['ollama', 'gemma3:1b', false],
			['ollama', 'gemma3:270m', false],
			['ollama', 'mistral:7b', false],
			['ollama', 'deepseek-r1:14b', false],
			['ollama', 'llama3.1:8b', false],
			['vLLM', 'meta-llama/Llama-3.3-70B-Instruct', false],
			['openAICompatible', 'some-random-model', false],
			// cloud names outside the catalog
			['openRouter', 'anthropic/claude-opus-9', true],
			['openRouter', 'google/gemini-4-pro', true],
			['openRouter', 'meta-llama/llama-3.3-70b-instruct', false],
			['deepseek', 'deepseek-v4-flash-vision-exp', true],
			['deepseek', 'deepseek-v4-flash', false],
		];
		for (const [providerName, modelName, expected] of cases) {
			assert.strictEqual(!!getModelCapabilities(providerName, modelName, undefined).supportsVision, expected, `${providerName}/${modelName}`);
		}
	});

	test('a per-model override wins over the detected capabilities', () => {
		const overrides = overridesWith('ollama', 'mistral:7b', { supportsVision: true });
		assert.strictEqual(getModelCapabilities('ollama', 'mistral:7b', overrides).supportsVision, true);
	});

	test('reserves the model\'s output limit, unless reasoning sets its own', () => {
		const modelName = 'claude-opus-5-5';
		const { reservedOutputTokenSpace, reasoningCapabilities } = getModelCapabilities('anthropic', modelName, undefined);
		assert.ok(reasoningCapabilities, 'expected a reasoning model');
		// no reasoning-specific reserve: reasoning on or off keeps the model's limit (it used to drop to 8192)
		assert.strictEqual(getReservedOutputTokenSpace('anthropic', modelName, { isReasoningEnabled: true, overridesOfModel: undefined }), reservedOutputTokenSpace);

		const overrides = overridesWith('anthropic', modelName, { reasoningCapabilities: { ...reasoningCapabilities, reasoningReservedOutputTokenSpace: 32_000 } });
		assert.strictEqual(getReservedOutputTokenSpace('anthropic', modelName, { isReasoningEnabled: true, overridesOfModel: overrides }), 32_000);
		assert.strictEqual(getReservedOutputTokenSpace('anthropic', modelName, { isReasoningEnabled: false, overridesOfModel: overrides }), reservedOutputTokenSpace);
	});
});
