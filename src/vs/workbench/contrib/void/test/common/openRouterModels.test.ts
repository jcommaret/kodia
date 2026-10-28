/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { deepClone } from '../../../../../base/common/objects.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getModelCapabilities, setDetectedModelOptions } from '../../common/modelCapabilities.js';
import { freeCodingModelsOfOpenRouter, mostUsedModelsOfOpenRouter, OpenRouterModel, stillListedModelsOfOpenRouter } from '../../common/openRouterModels.js';
import { defaultOverridesOfModel, defaultSettingsOfProvider } from '../../common/voidSettingsTypes.js';

const now = Date.parse('2026-10-27T12:00:00Z');

// a free chat model with tool calling, which the other cases change one thing of
const model = (id: string, changes: Partial<OpenRouterModel> = {}): OpenRouterModel => ({
	id,
	context_length: 262_144,
	architecture: { input_modalities: ['text'], output_modalities: ['text'] },
	pricing: { prompt: '0', completion: '0' },
	top_provider: { max_completion_tokens: 32_768 },
	supported_parameters: ['max_tokens', 'tools', 'tool_choice'],
	...changes,
});

suite('Kodia - OpenRouter\'s free models', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the free chat and vision models with tool calling', () => {
		const models = [
			model('a/chat:free'),
			model('a/vision:free', { architecture: { input_modalities: ['text', 'image', 'video'], output_modalities: ['text'] } }),
			model('a/paid', { pricing: { prompt: '0.0000002', completion: '0.000001' } }),
			model('a/music', { architecture: { input_modalities: ['text', 'image'], output_modalities: ['text', 'audio'] } }),
			model('a/no-tools:free', { supported_parameters: ['max_tokens', 'reasoning'] }),
			model('a/small-output:free', { top_provider: { max_completion_tokens: 8_192 } }),
			model('a/small-context:free', { context_length: 16_384 }),
			model('a/leaving:free', { expiration_date: '2026-10-31' }),
			model('openrouter/free'),
			model('openrouter/auto', { pricing: { prompt: '-1', completion: '-1' } }),
		];
		assert.deepStrictEqual(freeCodingModelsOfOpenRouter(models, now).map(m => m.modelName), ['a/chat:free', 'a/vision:free']);
	});

	test('a model retired later than in a week stays', () => {
		assert.strictEqual(freeCodingModelsOfOpenRouter([model('a/later:free', { expiration_date: '2026-12-31' })], now).length, 1);
	});

	test('the best at code come first', () => {
		const coding = (id: string, coding_index: number | null) => model(id, { benchmarks: { artificial_analysis: { coding_index } } });
		const models = [model('a/unrated:free'), coding('a/weak:free', 20), coding('a/strong:free', 50), coding('a/unknown:free', null)];
		assert.deepStrictEqual(freeCodingModelsOfOpenRouter(models, now).map(m => m.modelName), ['a/strong:free', 'a/weak:free', 'a/unknown:free', 'a/unrated:free']);
	});

	test('takes the capabilities from OpenRouter', () => {
		const [{ capabilities }] = freeCodingModelsOfOpenRouter([model('a/vision:free', {
			context_length: 1_000_000,
			architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
			top_provider: { max_completion_tokens: 131_072 },
			supported_parameters: ['tools', 'reasoning'],
		})], now);
		assert.strictEqual(capabilities.contextWindow, 1_000_000);
		assert.strictEqual(capabilities.reservedOutputTokenSpace, 131_072);
		assert.strictEqual(capabilities.supportsVision, true);
		assert.strictEqual(capabilities.specialToolFormat, 'openai-style');
		assert.strictEqual(capabilities.supportsSystemMessage, 'system-role');
		assert.deepStrictEqual(capabilities.cost, { input: 0, output: 0 });
		assert.ok(capabilities.reasoningCapabilities && capabilities.reasoningCapabilities.supportsReasoning);

		const [textOnly] = freeCodingModelsOfOpenRouter([model('a/chat:free')], now);
		assert.strictEqual(textOnly.capabilities.supportsVision, false);
		assert.strictEqual(textOnly.capabilities.reasoningCapabilities, false);
	});

	test('a detected model gets its capabilities from the settings, under the user\'s overrides', () => {
		const [detected] = freeCodingModelsOfOpenRouter([model('a/vision:free', {
			context_length: 1_000_000,
			architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
		})], now);
		const settingsOfProvider = deepClone(defaultSettingsOfProvider);
		settingsOfProvider.openRouter.models = [{ modelName: detected.modelName, type: 'autodetected', isHidden: true, detectedCapabilities: detected.capabilities }];
		try {
			setDetectedModelOptions(settingsOfProvider);
			const capabilities = getModelCapabilities('openRouter', 'a/vision:free', undefined);
			assert.strictEqual(capabilities.contextWindow, 1_000_000);
			assert.strictEqual(capabilities.supportsVision, true);
			assert.strictEqual(capabilities.isUnrecognizedModel, false);

			const overridesOfModel = { ...defaultOverridesOfModel, openRouter: { 'a/vision:free': { contextWindow: 500_000 } } };
			assert.strictEqual(getModelCapabilities('openRouter', 'a/vision:free', overridesOfModel).contextWindow, 500_000);
			// only for the provider it was detected on
			assert.notStrictEqual(getModelCapabilities('openAICompatible', 'a/vision:free', undefined).contextWindow, 1_000_000);
		} finally {
			setDetectedModelOptions(defaultSettingsOfProvider);
		}
		assert.notStrictEqual(getModelCapabilities('openRouter', 'a/vision:free', undefined).contextWindow, 1_000_000);
	});
});

suite('Kodia - OpenRouter\'s most used models', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const paid = (id: string, changes: Partial<OpenRouterModel> = {}) => model(id, { pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' }, ...changes });

	test('the five most used that can run the agent, in order, without the free ones and the default model', () => {
		const byUsage = [
			paid('deepseek/deepseek-v5-flash-1101'), paid('deepseek/deepseek-v5-flash'), // a snapshot counts for its model
			paid('x-ai/grok-4.7'), // Kodia's default OpenRouter model
			paid('a/image-maker', { architecture: { input_modalities: ['text'], output_modalities: ['image'] } }),
			paid('a/no-tools', { supported_parameters: ['max_tokens'] }),
			paid('a/one'), model('a/two:free'), paid('a/three'), paid('a/four'), paid('a/five'),
		];
		assert.deepStrictEqual(mostUsedModelsOfOpenRouter(byUsage, now, 5).map(m => m.modelName), ['deepseek/deepseek-v5-flash', 'a/one', 'a/three', 'a/four', 'a/five']);
	});

	test('their prices come from OpenRouter, per million tokens', () => {
		const [{ capabilities }] = mostUsedModelsOfOpenRouter([paid('a/one')], now, 5);
		assert.deepStrictEqual(capabilities.cost, { input: 3, output: 15, cache_read: 0.3 });
	});

	test('a selected model stays while OpenRouter lists it and it can run the agent', () => {
		const models = [paid('a/still'), paid('a/no-tools-now', { supported_parameters: [] })];
		assert.deepStrictEqual(stillListedModelsOfOpenRouter(models, now, ['a/still', 'a/no-tools-now', 'a/gone']).map(m => m.modelName), ['a/still']);
	});
});
