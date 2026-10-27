/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { canonicalModelNameForProvider } from './localSingleModelProviders.js';
import { defaultModelsOfProvider, VoidStaticModelInfo } from './modelCapabilities.js';
import { ProviderName } from './voidSettingsTypes.js';

// A model a provider's API lists, with the capabilities the API gives (none when it only gives names). Kodia adds the
// ones its catalog doesn't have to the provider's models, switched off.
export type DetectedModel = { modelName: string; capabilities?: Partial<VoidStaticModelInfo> };

// the providers whose model list Kodia reads with the user's API key (OpenRouter's is public, see openRouterFreeModels.ts)
export const listableProviderNames = ['anthropic', 'openAI', 'gemini', 'mistral', 'xAI', 'groq', 'deepseek'] as const satisfies ProviderName[];
export type ListableProviderName = typeof listableProviderNames[number];

// the fields Kodia reads, from each provider's API reference
type AnthropicModel = {
	id: string;
	lifecycle?: 'active' | 'deprecated' | 'retired';
	max_input_tokens?: number | null;
	max_tokens?: number | null;
	capabilities?: {
		image_input?: { supported?: boolean };
		pdf_input?: { supported?: boolean };
		thinking?: { supported?: boolean; types?: { adaptive?: { supported?: boolean }; disabled?: { supported?: boolean } } };
	} | null;
};
type OpenAIModel = { id: string };
type GeminiModel = { name: string; supportedGenerationMethods?: string[]; inputTokenLimit?: number; outputTokenLimit?: number; thinking?: boolean };
type MistralModel = {
	id: string;
	aliases?: string[];
	deprecation?: string | null;
	archived?: boolean;
	max_context_length?: number;
	capabilities?: { completion_chat?: boolean; completion_fim?: boolean; function_calling?: boolean; vision?: boolean };
};
// /v1/language-models, with /v1/models' context_length (the main process merges the two)
type XAIModel = { id: string; aliases?: string[]; input_modalities?: string[]; output_modalities?: string[]; context_length?: number | null };
type GroqModel = { id: string; active?: boolean; context_window?: number; max_completion_tokens?: number };
type DeepSeekModel = { id: string; context_window?: number; max_output_tokens?: number; input_modalities?: string[] };

// what isn't a chat model, by name: these lists mix in embeddings, images, audio, moderation...
const notChatModel: { [providerName in ListableProviderName]?: RegExp } = {
	// besides Kodia's chat completions, OpenAI has models only the Responses API serves (codex, -pro, deep research)
	openAI: /embedding|whisper|tts|transcribe|dall-e|image|realtime|audio|search|moderation|instruct|computer-use|deep-research|sora|codex|davinci|babbage|-pro\b/,
	// Gemma on the Gemini API has neither tools nor a system message
	gemini: /embedding|imagen|veo|tts|image|audio|live|aqa|gemma|robotics|learnlm|computer-use/,
	groq: /whisper|tts|orpheus|guard|safeguard/,
};

const positive = (n: number | null | undefined) => typeof n === 'number' && n > 0 ? n : undefined;

// drops the keys the API didn't give, so that what Kodia knows of the model from its name stays
const definedOnly = (capabilities: Partial<VoidStaticModelInfo>): Partial<VoidStaticModelInfo> | undefined => {
	const entries = Object.entries(capabilities).filter(([, v]) => v !== undefined);
	return entries.length ? Object.fromEntries(entries) as Partial<VoidStaticModelInfo> : undefined;
};

// a snapshot of another model: claude-x-20261001, gpt-x-2026-09-01, gemini-x-001, gpt-4-0613
const withoutSnapshotSuffix = (modelName: string) => modelName.replace(/-(\d{4}-\d{2}-\d{2}|\d{8}|\d{3,4})$/, '');

// in Kodia's catalog already: by name, as a snapshot of a catalog model, or as a legacy name Kodia maps to one
const isInCatalog = (providerName: ListableProviderName, modelName: string) => {
	const lower = modelName.toLowerCase();
	if (canonicalModelNameForProvider(providerName, modelName).toLowerCase() !== lower) return true;
	const catalog = new Set(defaultModelsOfProvider[providerName].map(m => m.toLowerCase()));
	return catalog.has(lower) || catalog.has(withoutSnapshotSuffix(lower));
};

const listOf = (response: unknown): unknown[] => Array.isArray(response) ? response : [];

const anthropicModels = (models: AnthropicModel[]): DetectedModel[] => models
	.filter(m => !m.lifecycle || m.lifecycle === 'active')
	.map(m => {
		const thinking = m.capabilities?.thinking;
		return {
			modelName: m.id,
			capabilities: definedOnly({
				contextWindow: positive(m.max_input_tokens),
				reservedOutputTokenSpace: positive(m.max_tokens),
				supportsVision: m.capabilities?.image_input?.supported,
				supportsPDF: m.capabilities?.pdf_input?.supported,
				// the budget-based thinking of older models is left to what Kodia knows from the name
				reasoningCapabilities: thinking?.supported === false ? false
					: thinking?.types?.adaptive?.supported ? { supportsReasoning: true, canTurnOffReasoning: thinking.types.disabled?.supported !== false, canIOReasoning: true, reasoningSlider: { type: 'adaptive' } }
						: undefined,
			}),
		};
	});

const geminiModels = (models: GeminiModel[]): DetectedModel[] => models
	.filter(m => m.supportedGenerationMethods?.includes('generateContent'))
	.map(m => ({
		modelName: m.name.replace(/^models\//, ''),
		capabilities: definedOnly({
			contextWindow: positive(m.inputTokenLimit),
			reservedOutputTokenSpace: positive(m.outputTokenLimit),
			reasoningCapabilities: m.thinking === false ? false : undefined,
		}),
	}));

const mistralModels = (models: MistralModel[]): DetectedModel[] => {
	// each alias is listed as a model of its own: keep one per model, its -latest name if it has one
	const sorted = [...models].sort((a, b) => Number(b.id.endsWith('-latest')) - Number(a.id.endsWith('-latest')));
	const seen = new Set<string>();
	const detected: DetectedModel[] = [];
	for (const m of sorted) {
		const names = [m.id, ...(m.aliases ?? [])];
		if (names.some(n => seen.has(n))) continue;
		names.forEach(n => seen.add(n));
		if (m.capabilities?.completion_chat === false || m.deprecation || m.archived) continue;
		if (names.some(n => isInCatalog('mistral', n))) continue;
		detected.push({
			modelName: m.id,
			capabilities: definedOnly({
				contextWindow: positive(m.max_context_length),
				supportsVision: m.capabilities?.vision,
				supportsFIM: m.capabilities?.completion_fim,
				specialToolFormat: m.capabilities?.function_calling ? 'openai-style' : undefined,
			}),
		});
	}
	return detected;
};

const xAIModels = (models: XAIModel[]): DetectedModel[] => models
	.filter(m => !m.output_modalities || (m.output_modalities.length === 1 && m.output_modalities[0] === 'text'))
	.filter(m => !(m.aliases ?? []).some(alias => isInCatalog('xAI', alias)))
	.map(m => ({
		modelName: m.id,
		capabilities: definedOnly({
			contextWindow: positive(m.context_length),
			supportsVision: m.input_modalities ? m.input_modalities.includes('image') : undefined,
		}),
	}));

const groqModels = (models: GroqModel[]): DetectedModel[] => models
	.filter(m => m.active !== false)
	.map(m => ({
		modelName: m.id,
		capabilities: definedOnly({
			contextWindow: positive(m.context_window),
			reservedOutputTokenSpace: positive(m.max_completion_tokens),
		}),
	}));

const deepseekModels = (models: DeepSeekModel[]): DetectedModel[] => models.map(m => ({
	modelName: m.id,
	capabilities: definedOnly({
		contextWindow: positive(m.context_window),
		reservedOutputTokenSpace: positive(m.max_output_tokens),
		supportsVision: m.input_modalities ? m.input_modalities.includes('image') : undefined,
	}),
}));

// The chat models a provider's API lists that Kodia's catalog doesn't have, from the list the main process fetched
// (listProviderModels). Snapshots of a model that is listed too are left out.
export const detectedModelsOfProvider = (providerName: ListableProviderName, response: unknown): DetectedModel[] => {
	const models = listOf(response).filter((m): m is { id?: unknown; name?: unknown } => typeof m === 'object' && m !== null);
	const withName = models.filter(m => typeof (providerName === 'gemini' ? m.name : m.id) === 'string');
	const detected =
		providerName === 'anthropic' ? anthropicModels(withName as AnthropicModel[])
			: providerName === 'openAI' ? (withName as OpenAIModel[]).map(m => ({ modelName: m.id }))
				: providerName === 'gemini' ? geminiModels(withName as GeminiModel[])
					: providerName === 'mistral' ? mistralModels(withName as MistralModel[])
						: providerName === 'xAI' ? xAIModels(withName as XAIModel[])
							: providerName === 'groq' ? groqModels(withName as GroqModel[])
								: deepseekModels(withName as DeepSeekModel[]);

	const notChat = notChatModel[providerName];
	const kept = detected.filter(m => !notChat?.test(m.modelName.toLowerCase()) && !isInCatalog(providerName, m.modelName));
	const names = new Set(kept.map(m => m.modelName));
	return kept
		.filter(m => withoutSnapshotSuffix(m.modelName) === m.modelName || !names.has(withoutSnapshotSuffix(m.modelName)))
		.sort((a, b) => a.modelName.localeCompare(b.modelName));
};
