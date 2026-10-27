/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { defaultModelsOfProvider, VoidStaticModelInfo } from './modelCapabilities.js';
import { DetectedModel, withoutSnapshotSuffix } from './providerModels.js';

// OpenRouter's public list of models, no key needed, the most used last week first (tokens processed):
// https://openrouter.ai/docs/api/api-reference/models/get-models
export const OPENROUTER_MODELS_BY_USAGE_URL = 'https://openrouter.ai/api/v1/models?sort=top-weekly';

// the fields Kodia reads
export type OpenRouterModel = {
	id: string;
	context_length: number;
	architecture?: { input_modalities?: string[]; output_modalities?: string[] };
	pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string; [kind: string]: string | undefined };
	top_provider?: { max_completion_tokens?: number | null } | null;
	supported_parameters?: string[];
	expiration_date?: string | null;
	benchmarks?: { artificial_analysis?: { coding_index?: number | null } | null } | null;
};

type DetectedOpenRouterModel = DetectedModel & { capabilities: VoidStaticModelInfo };

const MIN_CONTEXT_WINDOW = 32_768; // the agent's system message and tools alone take several thousand tokens
const MIN_OUTPUT_TOKENS = 16_384; // enough to write a file
const EXPIRES_SOON_MS = 7 * 24 * 60 * 60 * 1000;

// every price is 0 (OpenRouter's routers have a price of -1: it depends on the model they pick)
const isFree = (model: OpenRouterModel) => {
	const prices = Object.values(model.pricing ?? {});
	return prices.length > 0 && prices.every(price => price === undefined || Number(price) === 0);
};

// OpenRouter's prices are per token, Kodia's per million tokens
const perMillion = (price: string | undefined) => price === undefined || Number.isNaN(Number(price)) ? undefined : Number(price) * 1_000_000;

const capabilitiesOf = (model: OpenRouterModel): VoidStaticModelInfo => {
	const cacheRead = perMillion(model.pricing?.input_cache_read);
	const cacheWrite = perMillion(model.pricing?.input_cache_write);
	return {
		contextWindow: model.context_length,
		reservedOutputTokenSpace: model.top_provider?.max_completion_tokens ?? null,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		supportsFIM: false,
		supportsVision: !!model.architecture?.input_modalities?.includes('image'),
		// OpenRouter doesn't say whether reasoning can be turned off: the model decides how much to think
		reasoningCapabilities: model.supported_parameters?.includes('reasoning')
			? { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: true, reasoningSlider: { type: 'adaptive' } }
			: false,
		cost: {
			input: perMillion(model.pricing?.prompt) ?? 0,
			output: perMillion(model.pricing?.completion) ?? 0,
			...cacheRead !== undefined ? { cache_read: cacheRead } : {},
			...cacheWrite !== undefined ? { cache_write: cacheWrite } : {},
		},
		downloadable: false,
	};
};

// a model that can run Kodia's agent: chat (text out, with or without images in), tool calling, room for the agent's
// context and for a file in the output, and not retired within a week
const canRunAgent = (model: OpenRouterModel, now: number) => {
	if (model.id.startsWith('openrouter/')) return false; // OpenRouter's routers: what they can do depends on the model they pick
	const { input_modalities = [], output_modalities = [] } = model.architecture ?? {};
	if (!input_modalities.includes('text') || output_modalities.length !== 1 || output_modalities[0] !== 'text') return false;
	if (!model.supported_parameters?.includes('tools')) return false;
	if (model.context_length < MIN_CONTEXT_WINDOW) return false;
	const maxOutputTokens = model.top_provider?.max_completion_tokens;
	if (maxOutputTokens && maxOutputTokens < MIN_OUTPUT_TOKENS) return false;
	if (model.expiration_date && Date.parse(model.expiration_date) - now < EXPIRES_SOON_MS) return false;
	return true;
};

// OpenRouter's free models that can run the agent. The best at code first, by Artificial Analysis' coding index, when
// OpenRouter has it.
export const freeCodingModelsOfOpenRouter = (models: OpenRouterModel[], now: number): DetectedOpenRouterModel[] => {
	const picked = models.filter(model => isFree(model) && canRunAgent(model, now));
	const codingIndex = (model: OpenRouterModel) => model.benchmarks?.artificial_analysis?.coding_index ?? -1;
	picked.sort((a, b) => codingIndex(b) - codingIndex(a) || a.id.localeCompare(b.id));
	return picked.map(model => ({ modelName: model.id, capabilities: capabilitiesOf(model) }));
};

// The models OpenRouter's users used most last week that can run the agent, free or not, besides Kodia's default
// OpenRouter model. `modelsByUsage` is OpenRouter's list sorted by usage (OPENROUTER_MODELS_BY_USAGE_URL). A snapshot
// counts for its model when OpenRouter lists that too (deepseek-v4.1-flash-1017 is deepseek-v4.1-flash).
export const mostUsedModelsOfOpenRouter = (modelsByUsage: OpenRouterModel[], now: number, count: number): DetectedOpenRouterModel[] => {
	const modelOfId = new Map(modelsByUsage.map(model => [model.id, model]));
	const picked = new Map<string, DetectedOpenRouterModel>();
	for (const model of modelsByUsage) {
		if (picked.size >= count) break;
		const named = modelOfId.get(withoutSnapshotSuffix(model.id)) ?? model;
		if (picked.has(named.id) || (defaultModelsOfProvider.openRouter as readonly string[]).includes(named.id) || !canRunAgent(named, now)) continue;
		picked.set(named.id, { modelName: named.id, capabilities: capabilitiesOf(named) });
	}
	return [...picked.values()];
};

// The models of `modelNames` OpenRouter still lists that can still run the agent, with their capabilities today: the
// most used models a user switched on stay after they leave the top
export const stillListedModelsOfOpenRouter = (models: OpenRouterModel[], now: number, modelNames: readonly string[]): DetectedOpenRouterModel[] => {
	const modelOfId = new Map(models.map(model => [model.id, model]));
	return modelNames.flatMap(modelName => {
		const model = modelOfId.get(modelName);
		return model && canRunAgent(model, now) ? [{ modelName, capabilities: capabilitiesOf(model) }] : [];
	});
};
