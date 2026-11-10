/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Compares Kodia's model catalog (src/vs/workbench/contrib/void/common/modelCapabilities.ts) with what the
// providers publish, so retired models, context windows and prices that drifted show up without a manual review:
// - OpenRouter's public model list (no key): Kodia's catalog OpenRouter models must exist there, with the context
//   window of the largest serving provider and prices within the serving providers' range; native catalog models that OpenRouter also serves are compared for information;
// - Mistral's model list, when MISTRAL_API_KEY is set: the catalog Mistral models must exist and not be deprecated.
//
// Usage: node scripts/void/checkModelCatalog.mts
// Prints a Markdown report (also to $GITHUB_STEP_SUMMARY) and exits 1 when something needs a look, 2 when the
// check could not run. In CI, reportModelCatalog.sh turns both into an issue.

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

type Cost = { input: number; output: number; cache_read?: number };
type Capabilities = { contextWindow: number; cost: Cost; isUnrecognizedModel: boolean };
type Catalog = {
	catalogModelsOfProvider: Record<string, readonly string[]>;
	getModelCapabilities: (providerName: string, modelName: string, overrides: undefined) => Capabilities;
};

const root = path.join(import.meta.dirname, '..', '..');
const TOLERANCE = 0.02; // relative difference ignored on prices and context windows

// the catalog is TypeScript importing `.js` paths, so bundle it rather than import it directly
async function loadCatalog(): Promise<Catalog> {
	const result = await esbuild.build({
		entryPoints: [path.join(root, 'src/vs/workbench/contrib/void/common/modelCapabilities.ts')],
		bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
	});
	return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

type OpenRouterModel = { id: string; context_length: number; pricing: { prompt: string; completion: string; input_cache_read?: string } };

async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
	const response = await fetch(url, { headers });
	if (!response.ok) {
		throw new Error(`${url}: HTTP ${response.status}`);
	}
	return response.json() as Promise<T>;
}

const differs = (a: number, b: number) => Math.abs(a - b) > TOLERANCE * Math.max(Math.abs(a), Math.abs(b), 1e-9);
const perMillion = (perToken: string | undefined) => perToken === undefined ? undefined : Number(perToken) * 1e6;
const money = (n: number | undefined) => n === undefined ? '—' : `$${n !== 0 && Math.abs(n) < 0.01 ? Number(n.toPrecision(2)) : n.toFixed(3)}`;

// Kodia's native catalog names → candidate OpenRouter ids (claude-sonnet-5-5 → anthropic/claude-sonnet-5.5)
const openRouterPrefixOf: Record<string, string> = { anthropic: 'anthropic', openAI: 'openai', gemini: 'google', xAI: 'x-ai', deepseek: 'deepseek', mistral: 'mistralai' };
const openRouterCandidates = (providerName: string, modelName: string) => {
	const prefix = openRouterPrefixOf[providerName];
	if (!prefix) {
		return [];
	}
	const dotted = modelName.replace(/(\d)-(\d)/g, '$1.$2');
	return [...new Set([modelName, dotted, `${modelName}-0`])].map(name => `${prefix}/${name}`);
};

function compare(label: string, ours: Capabilities, theirs: OpenRouterModel): string[] {
	const problems: string[] = [];
	if (differs(ours.contextWindow, theirs.context_length)) {
		problems.push(`${label}: context window ${ours.contextWindow.toLocaleString('en')} in Kodia, ${theirs.context_length.toLocaleString('en')} on OpenRouter`);
	}
	const prices: [string, number | undefined, number | undefined][] = [
		['input', ours.cost.input, perMillion(theirs.pricing.prompt)],
		['output', ours.cost.output, perMillion(theirs.pricing.completion)],
		['cache read', ours.cost.cache_read, perMillion(theirs.pricing.input_cache_read)],
	];
	for (const [name, kodia, openRouter] of prices) {
		if (kodia !== undefined && openRouter !== undefined && differs(kodia, openRouter)) {
			problems.push(`${label}: ${name} price ${money(kodia)} in Kodia, ${money(openRouter)} on OpenRouter (per million tokens)`);
		}
	}
	return problems;
}

// OpenRouter's model-level price is that of the provider it lists first, which changes from one day to the next.
// A Kodia OpenRouter model is therefore checked against every serving provider: a price is flagged only when it
// falls outside the range of their prices, and the context window is compared with the largest one.
type OpenRouterEndpoint = { provider_name: string; context_length: number; pricing: OpenRouterModel['pricing'] };

function compareToEndpoints(label: string, ours: Capabilities, theirs: OpenRouterModel, endpoints: OpenRouterEndpoint[]): string[] {
	const problems: string[] = [];
	const largestContext = Math.max(theirs.context_length, ...endpoints.map(e => e.context_length));
	if (differs(ours.contextWindow, largestContext)) {
		problems.push(`${label}: context window ${ours.contextWindow.toLocaleString('en')} in Kodia, ${largestContext.toLocaleString('en')} at the largest OpenRouter provider`);
	}
	const prices: [string, number | undefined, (p: OpenRouterModel['pricing']) => string | undefined][] = [
		['input', ours.cost.input, p => p.prompt],
		['output', ours.cost.output, p => p.completion],
		['cache read', ours.cost.cache_read, p => p.input_cache_read],
	];
	for (const [name, kodia, priceOf] of prices) {
		const range = endpoints.map(e => perMillion(priceOf(e.pricing))).filter((n): n is number => n !== undefined);
		if (kodia === undefined || range.length === 0) {
			continue;
		}
		const [min, max] = [Math.min(...range), Math.max(...range)];
		const inRange = (kodia >= min && kodia <= max) || !differs(kodia, min) || !differs(kodia, max);
		if (!inRange) {
			problems.push(`${label}: ${name} price ${money(kodia)} in Kodia, outside the ${money(min)}–${money(max)} range of its ${endpoints.length} OpenRouter providers (per million tokens)`);
		}
	}
	return problems;
}

async function main() {
	const catalog = await loadCatalog();
	const needsLook: string[] = [];
	const info: string[] = [];

	const openRouter = new Map((await fetchJson<{ data: OpenRouterModel[] }>('https://openrouter.ai/api/v1/models')).data.map(m => [m.id, m]));

	for (const [providerName, modelNames] of Object.entries(catalog.catalogModelsOfProvider)) {
		for (const modelName of modelNames) {
			const ours = catalog.getModelCapabilities(providerName, modelName, undefined);
			if (providerName === 'openRouter') {
				const theirs = openRouter.get(modelName);
				if (!theirs) {
					needsLook.push(`openRouter/${modelName}: no longer listed on OpenRouter (retired or renamed)`);
				} else {
					const endpoints = (await fetchJson<{ data: { endpoints: OpenRouterEndpoint[] } }>(`https://openrouter.ai/api/v1/models/${modelName}/endpoints`)).data.endpoints;
					needsLook.push(...(endpoints.length > 0
						? compareToEndpoints(`openRouter/${modelName}`, ours, theirs, endpoints)
						: compare(`openRouter/${modelName}`, ours, theirs)));
				}
				continue;
			}
			const theirs = openRouterCandidates(providerName, modelName).map(id => openRouter.get(id)).find(m => !!m);
			if (theirs) {
				info.push(...compare(`${providerName}/${modelName} (as ${theirs.id})`, ours, theirs));
			}
		}
	}

	const mistralKey = process.env['MISTRAL_API_KEY'];
	if (mistralKey) {
		type MistralModel = { id: string; aliases?: string[]; deprecation?: string | null };
		const models = (await fetchJson<{ data: MistralModel[] }>('https://api.mistral.ai/v1/models', { Authorization: `Bearer ${mistralKey}` })).data;
		for (const modelName of catalog.catalogModelsOfProvider.mistral ?? []) {
			const model = models.find(m => m.id === modelName || m.aliases?.includes(modelName));
			if (!model) {
				needsLook.push(`mistral/${modelName}: not in Mistral's model list`);
			} else if (model.deprecation) {
				needsLook.push(`mistral/${modelName}: deprecated by Mistral, retirement on ${model.deprecation}`);
			}
		}
	} else {
		info.push('Mistral not checked: set MISTRAL_API_KEY to check existence and deprecations.');
	}

	const report = [
		'## Model catalog check',
		'',
		needsLook.length === 0 ? 'Nothing needs a look.' : `### Needs a look (${needsLook.length})\n\n${needsLook.map(l => `- ${l}`).join('\n')}`,
		'',
		info.length === 0 ? '' : `### For information (${info.length})\n\nNative prices can legitimately differ from OpenRouter's (promotions, provider routing).\n\n${info.map(l => `- ${l}`).join('\n')}`,
		'',
	].join('\n');

	console.log(report);
	const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
	if (summaryFile) {
		fs.appendFileSync(summaryFile, report);
	}
	process.exitCode = needsLook.length > 0 ? 1 : 0;
}

main().catch(error => {
	console.error(error);
	process.exitCode = 2;
});
