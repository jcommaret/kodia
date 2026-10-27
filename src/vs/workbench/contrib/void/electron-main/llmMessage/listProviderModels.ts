/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ListableProviderName } from '../../common/providerModels.js';

const TIMEOUT_MS = 20_000;
const MAX_PAGES = 10;

// the fields of the responses Kodia reads here; providerModels.ts reads the models
type ListResponse = { data?: unknown; models?: unknown; has_more?: unknown; last_id?: unknown; nextPageToken?: unknown };
type Model = { id?: unknown; context_length?: unknown };

const getJson = async (url: string, headers: Record<string, string>): Promise<ListResponse> => {
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!response.ok) {
		throw new Error(`${new URL(url).host}: HTTP ${response.status}`);
	}
	const json: unknown = await response.json();
	// Mistral's list may be a bare array
	return Array.isArray(json) ? { data: json } : json as ListResponse;
};

const arrayOf = (value: unknown): Model[] => Array.isArray(value) ? value : [];
const bearer = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}` });

// Kodia: a provider's list of models, fetched with the user's key, as its API returns it (providerModels.ts keeps the
// chat models Kodia's catalog doesn't have). Throws when the provider can't be reached or refuses the key.
export const listProviderModels = async (providerName: ListableProviderName, apiKey: string): Promise<unknown[]> => {
	switch (providerName) {
		case 'anthropic': {
			// https://platform.claude.com/docs/en/api/models/list
			const models: Model[] = [];
			let afterId: string | undefined;
			for (let page = 0; page < MAX_PAGES; page++) {
				const response = await getJson(`https://api.anthropic.com/v1/models?limit=1000${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ''}`, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' });
				models.push(...arrayOf(response.data));
				if (!response.has_more || typeof response.last_id !== 'string') break;
				afterId = response.last_id;
			}
			return models;
		}
		case 'gemini': {
			// https://ai.google.dev/api/models
			const models: Model[] = [];
			let pageToken: string | undefined;
			for (let page = 0; page < MAX_PAGES; page++) {
				const response = await getJson(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { 'x-goog-api-key': apiKey });
				models.push(...arrayOf(response.models));
				if (typeof response.nextPageToken !== 'string' || !response.nextPageToken) break;
				pageToken = response.nextPageToken;
			}
			return models;
		}
		case 'openAI':
			return arrayOf((await getJson('https://api.openai.com/v1/models', bearer(apiKey))).data);
		case 'mistral': // https://docs.mistral.ai/api/endpoint/models
			return arrayOf((await getJson('https://api.mistral.ai/v1/models', bearer(apiKey))).data);
		case 'groq': // https://console.groq.com/docs/api-reference#models-list
			return arrayOf((await getJson('https://api.groq.com/openai/v1/models', bearer(apiKey))).data);
		case 'deepseek': // https://api-docs.deepseek.com/api/list-models
			return arrayOf((await getJson('https://api.deepseek.com/models', bearer(apiKey))).data);
		case 'xAI': {
			// https://docs.x.ai/developers/rest-api-reference/inference/models: /v1/language-models has the modalities,
			// /v1/models the context length
			const [languageModels, models] = await Promise.all([
				getJson('https://api.x.ai/v1/language-models', bearer(apiKey)).then(response => arrayOf(response.models), () => undefined),
				getJson('https://api.x.ai/v1/models', bearer(apiKey)).then(response => arrayOf(response.data)),
			]);
			const contextLengthOf = new Map(models.map(m => [m.id, m.context_length]));
			return (languageModels ?? models).map(m => ({ ...m, context_length: contextLengthOf.get(m.id) ?? m.context_length }));
		}
	}
};
