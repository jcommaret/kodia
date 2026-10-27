/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { VoidStaticModelInfo } from './modelCapabilities.js';
import { DetectedModel } from './providerModels.js';

// OpenRouter's public list of models, no key needed: https://openrouter.ai/docs/api-reference/list-available-models
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

// the fields Kodia reads
export type OpenRouterModel = {
	id: string;
	context_length: number;
	architecture?: { input_modalities?: string[]; output_modalities?: string[] };
	pricing?: { [kind: string]: string | undefined };
	top_provider?: { max_completion_tokens?: number | null } | null;
	supported_parameters?: string[];
	expiration_date?: string | null;
	benchmarks?: { artificial_analysis?: { coding_index?: number | null } | null } | null;
};

const MIN_CONTEXT_WINDOW = 32_768; // the agent's system message and tools alone take several thousand tokens
const MIN_OUTPUT_TOKENS = 16_384; // enough to write a file
const EXPIRES_SOON_MS = 7 * 24 * 60 * 60 * 1000;

// every price is 0 (OpenRouter's routers have a price of -1: it depends on the model they pick)
const isFree = (model: OpenRouterModel) => {
	const prices = Object.values(model.pricing ?? {});
	return prices.length > 0 && prices.every(price => price === undefined || Number(price) === 0);
};

const capabilitiesOf = (model: OpenRouterModel): VoidStaticModelInfo => ({
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
	cost: { input: 0, output: 0 },
	downloadable: false,
});

// OpenRouter's free models that can run Kodia's agent: chat (text out, with or without images in), tool calling, room
// for the agent's context and for a file in the output, and not retired within a week. The best at code first, by
// Artificial Analysis' coding index, when OpenRouter has it.
export const freeCodingModelsOfOpenRouter = (models: OpenRouterModel[], now: number): (DetectedModel & { capabilities: VoidStaticModelInfo })[] => {
	const picked = models.filter(model => {
		if (model.id.startsWith('openrouter/')) return false; // OpenRouter's routers: what they can do depends on the model they pick
		if (!isFree(model)) return false;
		const { input_modalities = [], output_modalities = [] } = model.architecture ?? {};
		if (!input_modalities.includes('text') || output_modalities.length !== 1 || output_modalities[0] !== 'text') return false;
		if (!model.supported_parameters?.includes('tools')) return false;
		if (model.context_length < MIN_CONTEXT_WINDOW) return false;
		const maxOutputTokens = model.top_provider?.max_completion_tokens;
		if (maxOutputTokens && maxOutputTokens < MIN_OUTPUT_TOKENS) return false;
		if (model.expiration_date && Date.parse(model.expiration_date) - now < EXPIRES_SOON_MS) return false;
		return true;
	});
	const codingIndex = (model: OpenRouterModel) => model.benchmarks?.artificial_analysis?.coding_index ?? -1;
	picked.sort((a, b) => codingIndex(b) - codingIndex(a) || a.id.localeCompare(b.id));
	return picked.map(model => ({ modelName: model.id, capabilities: capabilitiesOf(model) }));
};
