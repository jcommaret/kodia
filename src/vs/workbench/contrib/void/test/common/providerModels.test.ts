/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { deepClone } from '../../../../../base/common/objects.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getModelCapabilities, setDetectedModelOptions } from '../../common/modelCapabilities.js';
import { detectedModelsOfProvider } from '../../common/providerModels.js';
import { defaultSettingsOfProvider } from '../../common/voidSettingsTypes.js';

const names = (models: { modelName: string }[]) => models.map(m => m.modelName);

suite('Kodia - models listed by the providers\' APIs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('leaves out the catalog\'s models, their snapshots, and legacy names Kodia maps to them', () => {
		const response = [
			{ id: 'gpt-6-sol' }, { id: 'gpt-6-sol-2026-09-01' }, { id: 'gpt-4o' }, // in the catalog, a snapshot, a legacy name
			{ id: 'gpt-7' }, { id: 'gpt-7-2027-01-15' }, // new, and its snapshot
			{ id: 'gpt-6-chat-2026-10-01' }, // a snapshot with no undated name
		];
		assert.deepStrictEqual(names(detectedModelsOfProvider('openAI', response)), ['gpt-6-chat-2026-10-01', 'gpt-7']);
	});

	test('leaves out what isn\'t a chat model', () => {
		const openAI = ['text-embedding-4-large', 'whisper-2', 'gpt-image-2', 'gpt-6-realtime', 'omni-moderation-latest', 'gpt-6-sol-pro', 'gpt-6-codex', 'tts-2', 'gpt-7-mini'].map(id => ({ id }));
		assert.deepStrictEqual(names(detectedModelsOfProvider('openAI', openAI)), ['gpt-7-mini']);

		const gemini = [
			{ name: 'models/gemini-4-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
			{ name: 'models/gemini-embedding-002', supportedGenerationMethods: ['embedContent'] },
			{ name: 'models/gemini-4-flash-image', supportedGenerationMethods: ['generateContent'] },
			{ name: 'models/gemma-5-27b-it', supportedGenerationMethods: ['generateContent'] },
		];
		assert.deepStrictEqual(names(detectedModelsOfProvider('gemini', gemini)), ['gemini-4-flash']);

		const groq = [{ id: 'whisper-large-v4' }, { id: 'meta-llama/llama-prompt-guard-3' }, { id: 'moonshotai/kimi-k3', active: true }, { id: 'old/model', active: false }];
		assert.deepStrictEqual(names(detectedModelsOfProvider('groq', groq)), ['moonshotai/kimi-k3']);

		const xAI = [{ id: 'grok-5', output_modalities: ['text'] }, { id: 'grok-imagine-2', output_modalities: ['image'] }];
		assert.deepStrictEqual(names(detectedModelsOfProvider('xAI', xAI)), ['grok-5']);
	});

	test('Anthropic: context, output, images, PDFs and adaptive thinking, from the API', () => {
		const [model, ...rest] = detectedModelsOfProvider('anthropic', [
			{
				id: 'claude-sonnet-6', lifecycle: 'active', max_input_tokens: 1_000_000, max_tokens: 128_000,
				capabilities: { image_input: { supported: true }, pdf_input: { supported: true }, thinking: { supported: true, types: { adaptive: { supported: true }, disabled: { supported: true } } } },
			},
			{ id: 'claude-haiku-3', lifecycle: 'deprecated' },
		]);
		assert.strictEqual(rest.length, 0, 'deprecated models are left out');
		assert.strictEqual(model.modelName, 'claude-sonnet-6');
		assert.deepStrictEqual(model.capabilities, {
			contextWindow: 1_000_000,
			reservedOutputTokenSpace: 128_000,
			supportsVision: true,
			supportsPDF: true,
			reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: true, reasoningSlider: { type: 'adaptive' } },
		});
	});

	test('Gemini, Groq, DeepSeek, xAI: what each API gives', () => {
		const [gemini] = detectedModelsOfProvider('gemini', [{ name: 'models/gemini-4-flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, thinking: false }]);
		assert.deepStrictEqual(gemini.capabilities, { contextWindow: 1_048_576, reservedOutputTokenSpace: 65_536, reasoningCapabilities: false });

		const [groq] = detectedModelsOfProvider('groq', [{ id: 'moonshotai/kimi-k3', context_window: 262_144 }]);
		assert.deepStrictEqual(groq.capabilities, { contextWindow: 262_144 });

		const [deepseek] = detectedModelsOfProvider('deepseek', [{ id: 'deepseek-v5', context_window: 1_048_576, max_output_tokens: 393_216, input_modalities: ['text', 'image'] }]);
		assert.deepStrictEqual(deepseek.capabilities, { contextWindow: 1_048_576, reservedOutputTokenSpace: 393_216, supportsVision: true });

		const [xAI] = detectedModelsOfProvider('xAI', [{ id: 'grok-5', input_modalities: ['text', 'image'], output_modalities: ['text'], context_length: 2_000_000 }]);
		assert.deepStrictEqual(xAI.capabilities, { contextWindow: 2_000_000, supportsVision: true });

		// OpenAI's list only has names
		assert.strictEqual(detectedModelsOfProvider('openAI', [{ id: 'gpt-7' }])[0].capabilities, undefined);
	});

	test('Mistral: one model per alias group, chat models only, not deprecated', () => {
		const models = detectedModelsOfProvider('mistral', [
			{ id: 'magistral-large-2611', aliases: ['magistral-large-latest'], capabilities: { completion_chat: true, function_calling: true, vision: true }, max_context_length: 262_144 },
			{ id: 'magistral-large-latest', aliases: ['magistral-large-2611'], capabilities: { completion_chat: true, function_calling: true, vision: true }, max_context_length: 262_144 },
			{ id: 'mistral-large-2512', aliases: ['mistral-large-latest'], capabilities: { completion_chat: true } }, // in the catalog through its alias
			{ id: 'mistral-embed-2', capabilities: { completion_chat: false } },
			{ id: 'open-mixtral-8x22b', capabilities: { completion_chat: true }, deprecation: '2026-11-30T12:00:00Z' },
		]);
		assert.deepStrictEqual(models, [{
			modelName: 'magistral-large-latest',
			capabilities: { contextWindow: 262_144, supportsVision: true, specialToolFormat: 'openai-style' },
		}]);
	});

	test('a detected model\'s capabilities go over what its name tells, under the user\'s overrides', () => {
		const settingsOfProvider = deepClone(defaultSettingsOfProvider);
		settingsOfProvider.anthropic.models = [{ modelName: 'claude-sonnet-6', type: 'autodetected', isHidden: true, detectedCapabilities: { contextWindow: 2_000_000 } }];
		try {
			setDetectedModelOptions(settingsOfProvider);
			const fromName = getModelCapabilities('anthropic', 'claude-sonnet-6-preview', undefined); // not detected: from its name only
			const detected = getModelCapabilities('anthropic', 'claude-sonnet-6', undefined);
			assert.strictEqual(detected.contextWindow, 2_000_000);
			assert.strictEqual(detected.specialToolFormat, fromName.specialToolFormat, 'the rest still comes from the name');
			assert.strictEqual(detected.supportsSystemMessage, fromName.supportsSystemMessage);
		} finally {
			setDetectedModelOptions(defaultSettingsOfProvider);
		}
	});
});
