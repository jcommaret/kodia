/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { catalogModelsOfProvider, defaultModelsOfProvider, getModelCapabilities, getReservedOutputTokenSpace, getModelContextDiagnostics, LimitSource, ModelOverrides } from '../../common/modelCapabilities.js';
import { OverridesOfModel, ProviderName } from '../../common/voidSettingsTypes.js';

// Build a full OverridesOfModel with all providers initialized
function buildOverrides(providerName: ProviderName, modelName: string, overrides: Partial<ModelOverrides>): OverridesOfModel {
	const allProviders: ProviderName[] = [
		'anthropic', 'awsBedrock', 'deepseek', 'gemini', 'googleVertex', 'groq', 'liteLLM',
		'lmStudio', 'mlx', 'mistral', 'nvidia', 'ollama', 'openAI', 'openAICompatible',
		'openRouter', 'vLLM', 'xAI'
	];
	const result: Record<string, Record<string, Partial<ModelOverrides>>> = {};
	for (const p of allProviders) result[p] = {};
	result[providerName] = { [modelName]: overrides };
	return result as OverridesOfModel;
}

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

	test('a retired or deprecated model a user still has goes to the provider\'s replacement', () => {
		const cases: [ProviderName, string, string][] = [
			['anthropic', 'claude-3-7-sonnet-20250219', 'claude-sonnet-5-5'],
			['anthropic', 'claude-sonnet-4-5-20250929', 'claude-sonnet-5-5'],
			['openAI', 'gpt-5.4-nano', 'gpt-6-luna'],
			['gemini', 'gemini-2.5-pro', 'gemini-3.1-pro-preview'],
			['gemini', 'gemini-2.5-flash', 'gemini-3.6-flash'],
			['gemini', 'gemini-2.5-flash-lite', 'gemini-3.5-flash-lite'],
			['gemini', 'gemini-3.7-flash', 'gemini-3.8-flash'],
			['gemini', 'gemini-3.5-flash', 'gemini-3.6-flash'],
			['gemini', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'],
			['mistral', 'zai-glm-5-2', 'zai-glm-5-3'],
			['groq', 'qwen/qwen3.6-27b', 'qwen/qwen3.8-27b'],
			['groq', 'qwen/qwen3-32b', 'qwen/qwen3.8-27b'],
			['groq', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
			['groq', 'llama-3.1-8b-instant', 'openai/gpt-oss-20b'],
			['deepseek', 'deepseek-v4-flash', 'deepseek-flash'],
		];
		for (const [providerName, modelName, replacement] of cases) {
			const capabilities = getModelCapabilities(providerName, modelName, undefined);
			assert.strictEqual(capabilities.isUnrecognizedModel, false, `${providerName}/${modelName}`);
			// the request goes to the replacement, with its capabilities
			assert.strictEqual(capabilities.modelName, replacement, `${providerName}/${modelName}`);
			assert.strictEqual(capabilities.recognizedModelName, replacement, `${providerName}/${modelName}`);
		}
		// retired with no replacement: unrecognized, so Groq's error says the model is gone
		assert.strictEqual(getModelCapabilities('groq', 'groq/compound', undefined).isUnrecognizedModel, true);
	});

	test('each provider has one default model, from the catalog', () => {
		for (const [providerName, modelNames] of Object.entries(defaultModelsOfProvider) as [ProviderName, readonly string[]][]) {
			// NVIDIA intentionally lists all 8 verified catalogue models as defaults so they always appear
			const maxDefaults = providerName === 'nvidia' ? (catalogModelsOfProvider.nvidia as readonly string[]).length : 1;
			assert.ok(modelNames.length <= maxDefaults, `${providerName} has ${modelNames.length} default models`);
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
			// retired, served by deepseek-flash, which reads images
			['deepseek', 'deepseek-v4-flash-vision-exp', true],
			['deepseek', 'deepseek-v4-flash', true],
		];
		for (const [providerName, modelName, expected] of cases) {
			assert.strictEqual(!!getModelCapabilities(providerName, modelName, undefined).supportsVision, expected, `${providerName}/${modelName}`);
		}
	});

	test('NVIDIA: nemotron-3.5-super-vl keeps verified capabilities; unknown NVIDIA models are not given vision or a fake context limit', () => {
		const nemotron = getModelCapabilities('nvidia', 'nvidia/nemotron-3.5-super-vl-120b-a12b', undefined);
		assert.strictEqual(nemotron.isUnrecognizedModel, false, 'nemotron-3.5-super-vl is a recognized catalog model');
		assert.strictEqual(nemotron.contextWindow, 1_048_576, 'verified: up to 1M tokens (1,048,576)');
		assert.strictEqual(nemotron.reservedOutputTokenSpace, 32_768, 'verified: max_tokens maximum');
		assert.strictEqual(nemotron.supportsVision, true, 'verified: NVIDIA advertises image and video input');
		assert.strictEqual(nemotron.specialToolFormat, 'openai-style', 'verified: the API accepts a tools parameter');
		assert.strictEqual(nemotron.supportsSystemMessage, 'system-role', 'verified: the API accepts a system role');
		assert.ok(!!nemotron.reasoningCapabilities && nemotron.reasoningCapabilities.supportsReasoning, 'verified: configurable reasoning');
		assert.ok(!!nemotron.reasoningCapabilities && nemotron.reasoningCapabilities.canIOReasoning, 'verified: model outputs reasoning_content');

		// an NVIDIA-hosted model outside NVIDIA's catalog is matched to its family by name (the NVIDIA provider uses the
		// shared name fallback): Llama 3.1, never Llama 4's 10M window or its vision support
		const llama31 = getModelCapabilities('nvidia', 'meta/llama-3.1-8b-instruct', undefined);
		assert.strictEqual(llama31.supportsVision, false, 'vision is not inferred from the model name');
		assert.strictEqual(llama31.contextWindow, 32_000, 'a modest family value, not a fake huge limit');

		// a model with no recognizable family stays explicitly unknown, with the modest fallback
		const unknown = getModelCapabilities('nvidia', 'acme/totally-new-model-7b', undefined);
		assert.strictEqual(unknown.isUnrecognizedModel, true);
		assert.strictEqual(unknown.supportsVision, false);
		assert.strictEqual(unknown.contextWindowSource, 'fallback');
		assert.strictEqual(unknown.contextWindow, 32_000);
	});

	test('Llama family names: hosted and Ollama spellings match the right version; unversioned Llamas never get Llama 4 values', () => {
		// [model name, expected context window, expected vision]: Llama 3.x family = 32k text-only, Llama 4 = 10M multimodal
		const cases: [string, number, boolean][] = [
			['meta/llama-3.1-70b-instruct', 32_000, false],
			['llama3.1:8b', 32_000, false],
			['meta-llama/Llama-3.3-70B-Instruct', 32_000, false],
			['meta/llama-3.2-3b-instruct', 32_000, false],
			['llama3:8b', 32_000, false],
			['meta/llama-4-maverick-17b-128e-instruct', 10_000_000, true],
			['meta/llama-4-scout-17b-16e-instruct', 10_000_000, true],
			['llama2:13b', 32_000, false],
			['codellama:7b', 32_000, false],
		];
		for (const [name, contextWindow, vision] of cases) {
			const caps = getModelCapabilities('openAICompatible', name, undefined);
			assert.strictEqual(caps.contextWindow, contextWindow, `${name} context window`);
			assert.strictEqual(caps.supportsVision, vision, `${name} vision`);
		}
	});

	test('a per-model override wins over the detected capabilities', () => {
		const overrides = buildOverrides('ollama', 'mistral:7b', { supportsVision: true });
		assert.strictEqual(getModelCapabilities('ollama', 'mistral:7b', overrides).supportsVision, true);
	});

	test('reserves the model\'s output limit, unless reasoning sets its own', () => {
		const modelName = 'claude-opus-5-5';
		const { reservedOutputTokenSpace, reasoningCapabilities } = getModelCapabilities('anthropic', modelName, undefined);
		assert.ok(reasoningCapabilities, 'expected a reasoning model');
		// no reasoning-specific reserve: reasoning on or off keeps the model's limit (it used to drop to 8192)
		assert.strictEqual(getReservedOutputTokenSpace('anthropic', modelName, { isReasoningEnabled: true, overridesOfModel: undefined }), reservedOutputTokenSpace);

		const overrides = buildOverrides('anthropic', modelName, { reasoningCapabilities: { ...reasoningCapabilities, reasoningReservedOutputTokenSpace: 32_000 } });
		assert.strictEqual(getReservedOutputTokenSpace('anthropic', modelName, { isReasoningEnabled: true, overridesOfModel: overrides }), 32_000);
		assert.strictEqual(getReservedOutputTokenSpace('anthropic', modelName, { isReasoningEnabled: false, overridesOfModel: overrides }), reservedOutputTokenSpace);
	});
});

suite('Kodia - model capabilities: source tracking and fallback behavior', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Nemotron has verified source for context window and output tokens', () => {
		const nemotron = getModelCapabilities('nvidia', 'nvidia/nemotron-3.5-super-vl-120b-a12b', undefined);
		assert.strictEqual(nemotron.contextWindowSource, 'verified');
		assert.strictEqual(nemotron.reservedOutputTokenSpaceSource, 'verified');
		assert.ok(nemotron.reasoningCapabilities);
		assert.strictEqual(nemotron.reasoningCapabilities!.reasoningReservedOutputTokenSpaceSource, 'verified');
	});

	test('Catalog models have catalog source by default', () => {
		const gpt6 = getModelCapabilities('openAI', 'gpt-6-astra', undefined);
		assert.strictEqual(gpt6.contextWindowSource, 'catalog');
		assert.strictEqual(gpt6.reservedOutputTokenSpaceSource, 'catalog');
	});

	test('Unknown models on local providers get generous fallback context window', () => {
		// Local providers (Ollama, vLLM, LM Studio, MLX) should get 32k context fallback
		const localProviders: ProviderName[] = ['ollama', 'vLLM', 'lmStudio', 'mlx'];
		for (const providerName of localProviders) {
			const unknown = getModelCapabilities(providerName, 'some-unknown-model', undefined);
			assert.strictEqual(unknown.isUnrecognizedModel, true);
			assert.strictEqual(unknown.contextWindow, 32_000, `${providerName} should get 32k fallback`);
			assert.strictEqual(unknown.reservedOutputTokenSpace, 8_192, `${providerName} should get 8k output fallback`);
			assert.strictEqual(unknown.contextWindowSource, 'fallback');
			assert.strictEqual(unknown.reservedOutputTokenSpaceSource, 'fallback');
		}
	});

	test('Unknown models on cloud providers get a modest 32k fallback with 4k output', () => {
		const cloudProviders: ProviderName[] = ['openAI', 'anthropic', 'gemini', 'groq', 'xAI', 'mistral', 'deepseek'];
		for (const providerName of cloudProviders) {
			const unknown = getModelCapabilities(providerName, 'some-unknown-model', undefined);
			assert.strictEqual(unknown.isUnrecognizedModel, true);
			assert.strictEqual(unknown.contextWindow, 32_000, `${providerName} should get 32k fallback`);
			assert.strictEqual(unknown.reservedOutputTokenSpace, 4_096, `${providerName} should get 4k output fallback`);
			assert.strictEqual(unknown.contextWindowSource, 'fallback');
			assert.strictEqual(unknown.reservedOutputTokenSpaceSource, 'fallback');
		}
	});

	test('User overrides can specify source as user-configured', () => {
		const overrides = {
			contextWindow: 100_000,
			contextWindowSource: 'user-configured',
			reservedOutputTokenSpace: 20_000,
			reservedOutputTokenSpaceSource: 'user-configured',
		} as const;
		const caps = getModelCapabilities('ollama', 'custom-model', buildOverrides('ollama', 'custom-model', overrides));
		assert.strictEqual(caps.contextWindow, 100_000);
		assert.strictEqual(caps.contextWindowSource, 'user-configured');
		assert.strictEqual(caps.reservedOutputTokenSpace, 20_000);
		assert.strictEqual(caps.reservedOutputTokenSpaceSource, 'user-configured');
	});

	test('Provider-api source is used for detected models', () => {
		// This would require setting up detectedModelOptions, which is tested elsewhere
		// Here we just verify the type is accepted
		const overrides = {
			contextWindow: 50_000,
			contextWindowSource: 'provider-api',
			reservedOutputTokenSpace: 10_000,
			reservedOutputTokenSpaceSource: 'provider-api',
		} as const;
		const caps = getModelCapabilities('ollama', 'detected-model', buildOverrides('ollama', 'detected-model', overrides));
		assert.strictEqual(caps.contextWindowSource, 'provider-api');
		assert.strictEqual(caps.reservedOutputTokenSpaceSource, 'provider-api');
	});

	test('Reasoning output token space source is tracked', () => {
		const nemotron = getModelCapabilities('nvidia', 'nvidia/nemotron-3.5-super-vl-120b-a12b', undefined);
		const nemotronReasoning = nemotron.reasoningCapabilities as { reasoningReservedOutputTokenSpaceSource: LimitSource };
		assert.ok(nemotronReasoning);
		assert.strictEqual(nemotronReasoning.reasoningReservedOutputTokenSpaceSource, 'verified');

		// Test override
		const overrides = {
			reasoningCapabilities: {
				...nemotron.reasoningCapabilities!,
				reasoningReservedOutputTokenSpace: 16_000,
				reasoningReservedOutputTokenSpaceSource: 'user-configured' as LimitSource,
			}
		};
		const caps = getModelCapabilities('nvidia', 'nvidia/nemotron-3.5-super-vl-120b-a12b', buildOverrides('nvidia', 'nvidia/nemotron-3.5-super-vl-120b-a12b', overrides as Partial<ModelOverrides>));
		const capsReasoning = caps.reasoningCapabilities as { reasoningReservedOutputTokenSpaceSource: LimitSource };
		assert.ok(capsReasoning);
		assert.strictEqual(capsReasoning.reasoningReservedOutputTokenSpaceSource, 'user-configured');
	});

	test('Fallback unknown models get vision detection but conservative limits', () => {
		// Vision models on local providers
		const llava = getModelCapabilities('ollama', 'llava:7b', undefined);
		assert.strictEqual(llava.supportsVision, true);
		assert.strictEqual(llava.contextWindow, 32_000);
		assert.strictEqual(llava.contextWindowSource, 'fallback');

		// Vision models on cloud providers
		const unknownVision = getModelCapabilities('openAI', 'some-vision-model', undefined);
		assert.strictEqual(unknownVision.supportsVision, true);
		assert.strictEqual(unknownVision.contextWindow, 32_000);
		assert.strictEqual(unknownVision.contextWindowSource, 'fallback');
	});
});

suite('Kodia - model capabilities: output-token validation and clamping', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Nemotron retains its verified 1,048,576-token context and 32,768-token output reservation', () => {
		const nemotron = getModelCapabilities('nvidia', 'nvidia/nemotron-3.5-super-vl-120b-a12b', undefined);
		assert.strictEqual(nemotron.isUnrecognizedModel, false);
		assert.strictEqual(nemotron.contextWindow, 1_048_576);
		assert.strictEqual(nemotron.contextWindowSource, 'verified');
		assert.strictEqual(nemotron.reservedOutputTokenSpace, 32_768);
		assert.strictEqual(nemotron.reservedOutputTokenSpaceSource, 'verified');
		assert.strictEqual(nemotron.supportsVision, true);
		assert.strictEqual(nemotron.specialToolFormat, 'openai-style');
		assert.strictEqual(nemotron.supportsSystemMessage, 'system-role');
	});

	test('Models with smaller verified context windows are not increased', () => {
		// claude-haiku-4-5 has a verified 200k context — must not be bumped to 1M
		const haiku = getModelCapabilities('anthropic', 'claude-haiku-4-5', undefined);
		assert.strictEqual(haiku.contextWindow, 200_000);
		assert.ok(haiku.contextWindow < 1_000_000, 'haiku context must not be increased to 1M');

		// codestral-latest has a verified 128k context
		const codestral = getModelCapabilities('mistral', 'codestral-latest', undefined);
		assert.strictEqual(codestral.contextWindow, 128_000);
		assert.strictEqual(codestral.contextWindowSource, 'catalog');

		// gpt-5.4-mini has a verified 400k context — not 1M
		const mini = getModelCapabilities('openAI', 'gpt-5.4-mini', undefined);
		assert.strictEqual(mini.contextWindow, 400_000);
		assert.strictEqual(mini.contextWindowSource, 'catalog');
	});

	test('User override with output tokens exceeding context is clamped to the context window', () => {
		// Use a truly unknown model name (doesn't match any family)
		const overrides = buildOverrides('ollama', 'my-private-model', {
			contextWindow: 8_192,
			reservedOutputTokenSpace: 32_768, // exceeds 8k context
		});
		const caps = getModelCapabilities('ollama', 'my-private-model', overrides);
		assert.strictEqual(caps.contextWindow, 8_192);
		// output is clamped to context window
		assert.strictEqual(caps.reservedOutputTokenSpace, 8_192);
	});

	test('User override with output tokens within context is preserved', () => {
		const overrides = buildOverrides('ollama', 'my-private-model', {
			contextWindow: 32_000,
			reservedOutputTokenSpace: 8_192,
		});
		const caps = getModelCapabilities('ollama', 'my-private-model', overrides);
		assert.strictEqual(caps.contextWindow, 32_000);
		assert.strictEqual(caps.reservedOutputTokenSpace, 8_192);
	});

	test('Invalid context window override is dropped, keeping the model\'s own value', () => {
		const overrides = buildOverrides('ollama', 'my-private-model', {
			contextWindow: -1,
			reservedOutputTokenSpace: 8_192,
		});
		const caps = getModelCapabilities('ollama', 'my-private-model', overrides);
		// unknown local model starts at 32000; invalid override is dropped
		assert.strictEqual(caps.contextWindow, 32_000);
		assert.strictEqual(caps.reservedOutputTokenSpace, 8_192);
	});

	test('Non-numeric context window override is dropped', () => {
		const overrides = buildOverrides('ollama', 'my-private-model', {
			contextWindow: 'not-a-number' as any,
			reservedOutputTokenSpace: 8_192,
		});
		const caps = getModelCapabilities('ollama', 'my-private-model', overrides);
		assert.strictEqual(caps.contextWindow, 32_000); // model's own context
		assert.strictEqual(caps.reservedOutputTokenSpace, 8_192);
	});

	test('Null reserved output tokens is preserved', () => {
		const overrides = buildOverrides('xAI', 'grok-4.7', {
			reservedOutputTokenSpace: null,
		});
		const caps = getModelCapabilities('xAI', 'grok-4.7', overrides);
		assert.strictEqual(caps.reservedOutputTokenSpace, null);
	});
});

suite('Kodia - model capabilities: context diagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('getModelContextDiagnostics returns verified status for Nemotron', () => {
		const d = getModelContextDiagnostics('nvidia', 'nvidia/nemotron-3.5-super-vl-120b-a12b', undefined);
		assert.strictEqual(d.modelName, 'nvidia/nemotron-3.5-super-vl-120b-a12b');
		assert.strictEqual(d.providerName, 'nvidia');
		assert.strictEqual(d.configuredContextWindow, 1_048_576);
		assert.strictEqual(d.configuredContextWindowSource, 'verified');
		assert.strictEqual(d.effectiveContextWindow, 1_048_576);
		assert.strictEqual(d.reservedOutputTokens, 32_768);
		assert.strictEqual(d.reservedOutputTokenSource, 'verified');
		assert.strictEqual(d.usableInputTokens, 1_048_576 - 32_768);
		assert.strictEqual(d.isVerified, true);
		assert.strictEqual(d.isFallback, false);
		assert.strictEqual(d.isUnrecognizedModel, false);
	});

	test('getModelContextDiagnostics reports fallback for unknown models', () => {
		const d = getModelContextDiagnostics('openAI', 'some-unknown-model', undefined);
		assert.strictEqual(d.isUnrecognizedModel, true);
		assert.strictEqual(d.isFallback, true);
		assert.strictEqual(d.isVerified, false);
		assert.strictEqual(d.configuredContextWindow, 32_000);
		assert.strictEqual(d.configuredContextWindowSource, 'fallback');
		assert.strictEqual(d.usableInputTokens, 32_000 - 4_096);
	});

	test('getModelContextDiagnostics reports local provider fallback generously', () => {
		const d = getModelContextDiagnostics('ollama', 'some-unknown-local-model', undefined);
		assert.strictEqual(d.isUnrecognizedModel, true);
		assert.strictEqual(d.isFallback, true);
		assert.strictEqual(d.configuredContextWindow, 32_000);
		assert.strictEqual(d.configuredContextWindowSource, 'fallback');
	});

	test('getModelContextDiagnostics reports user overrides', () => {
		const overrides = buildOverrides('ollama', 'some-unknown-model', {
			contextWindow: 16_384,
			contextWindowSource: 'user-configured',
			reservedOutputTokenSpace: 4_096,
			reservedOutputTokenSpaceSource: 'user-configured',
		});
		const d = getModelContextDiagnostics('ollama', 'some-unknown-model', overrides);
		assert.strictEqual(d.isOverridden, true);
		assert.strictEqual(d.configuredContextWindow, 16_384);
		assert.strictEqual(d.configuredContextWindowSource, 'user-configured');
		assert.strictEqual(d.effectiveContextWindow, 16_384);
		assert.strictEqual(d.usableInputTokens, 16_384 - 4_096);
	});
});

suite('Kodia - model capabilities: local model configuration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Local model context can be configured via overrides without source changes', () => {
		// A user can set a custom context window for a local model through overrides
		const overrides = buildOverrides('lmStudio', 'my-custom-model', {
			contextWindow: 131_072,
			contextWindowSource: 'user-configured',
			reservedOutputTokenSpace: 8_192,
			reservedOutputTokenSpaceSource: 'user-configured',
		});
		const caps = getModelCapabilities('lmStudio', 'my-custom-model', overrides);
		assert.strictEqual(caps.isUnrecognizedModel, true);
		assert.strictEqual(caps.contextWindow, 131_072);
		assert.strictEqual(caps.contextWindowSource, 'user-configured');
		assert.strictEqual(caps.reservedOutputTokenSpace, 8_192);
		assert.strictEqual(caps.reservedOutputTokenSpaceSource, 'user-configured');
	});

	test('Local model output override exceeding context is clamped', () => {
		// Use a truly unknown model name (doesn't match any family)
		const overrides = buildOverrides('vLLM', 'my-private-model', {
			contextWindow: 8_192,
			reservedOutputTokenSpace: 65_536, // way above context
		});
		const caps = getModelCapabilities('vLLM', 'my-private-model', overrides);
		assert.strictEqual(caps.contextWindow, 8_192);
		assert.strictEqual(caps.reservedOutputTokenSpace, 8_192); // clamped to context
	});

	test('Unknown models remain explicitly unknown, not given misleading metadata', () => {
		const unknown = getModelCapabilities('openAICompatible', 'totally-unknown-model-xyz', undefined);
		assert.strictEqual(unknown.isUnrecognizedModel, true);
		assert.strictEqual(unknown.contextWindow, 32_000);
		assert.strictEqual(unknown.contextWindowSource, 'fallback');
		assert.strictEqual(unknown.reservedOutputTokenSpaceSource, 'fallback');
		// a modest guess (marked 'fallback'), never a huge advertised context
		assert.ok(unknown.contextWindow <= 32_000, 'unknown model should not get a large context window');
		assert.ok(unknown.contextWindow - (unknown.reservedOutputTokenSpace ?? 0) > 16_000, 'the fallback must leave real room for input');
	});
});

suite('Kodia - model capabilities: model switching and backward compatibility', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Switching models selects the correct configuration', () => {
		const nemotron = getModelCapabilities('nvidia', 'nvidia/nemotron-3.5-super-vl-120b-a12b', undefined);
		assert.strictEqual(nemotron.contextWindow, 1_048_576);

		const haiku = getModelCapabilities('anthropic', 'claude-haiku-4-5', undefined);
		assert.strictEqual(haiku.contextWindow, 200_000);

		// unknown model on a local provider gets the generous local fallback
		const small = getModelCapabilities('ollama', 'some-unknown-model', undefined);
		assert.strictEqual(small.contextWindow, 32_000); // local fallback
		assert.strictEqual(small.contextWindowSource, 'fallback');
	});

	test('Exact model identifiers take priority over similar names', () => {
		// sonnet-5-5 must not be confused with sonnet-5
		const s55 = getModelCapabilities('anthropic', 'claude-sonnet-5-5', undefined);
		const s5 = getModelCapabilities('anthropic', 'claude-sonnet-5', undefined);
		assert.strictEqual(s55.recognizedModelName, 'claude-sonnet-5-5');
		assert.strictEqual(s5.recognizedModelName, 'claude-sonnet-5');
		assert.strictEqual(s55.contextWindow, s5.contextWindow); // both 1M in this catalog
	});

	test('Provider-specific model matching: same model name on different providers', () => {
		// qwen/qwen3.8-27b exists on both groq and openRouter with different contexts
		const groqQwen = getModelCapabilities('groq', 'qwen/qwen3.8-27b', undefined);
		const routerQwen = getModelCapabilities('openRouter', 'qwen/qwen3.8-27b', undefined);
		assert.strictEqual(groqQwen.contextWindow, 131_042);
		assert.strictEqual(routerQwen.contextWindow, 1_000_000);
	});

	test('OpenRouter model IDs are handled correctly', () => {
		const caps = getModelCapabilities('openRouter', 'x-ai/grok-4.7', undefined);
		assert.strictEqual(caps.isUnrecognizedModel, false);
		assert.strictEqual(caps.contextWindow, 500_000);
	});

	test('Backward compatibility: no overrides behaves as before', () => {
		// getModelCapabilities with undefined overrides returns the same as before
		const caps = getModelCapabilities('nvidia', 'nvidia/nemotron-3.5-super-vl-120b-a12b', undefined);
		assert.strictEqual(caps.contextWindow, 1_048_576);
		assert.strictEqual(caps.reservedOutputTokenSpace, 32_768);
		assert.strictEqual(caps.isUnrecognizedModel, false);
	});

	test('Missing metadata is handled gracefully', () => {
		// A model with no catalog entry and no fallback info
		const caps = getModelCapabilities('openAICompatible', 'brand-new-unknown-model', undefined);
		assert.strictEqual(caps.isUnrecognizedModel, true);
		assert.strictEqual(caps.contextWindow, 32_000);
		assert.strictEqual(caps.reservedOutputTokenSpace, 4_096);
		assert.strictEqual(caps.contextWindowSource, 'fallback');
		assert.strictEqual(caps.reservedOutputTokenSpaceSource, 'fallback');
	});
});
