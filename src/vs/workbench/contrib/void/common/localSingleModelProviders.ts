/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { defaultModelsOfProvider } from './modelCapabilities.js';
import { ProviderName, VoidStatefulModelInfo } from './voidSettingsTypes.js';

/** One loaded model per endpoint (mlx_lm.server). */
export const singleAutodetectedLocalProviders = ['mlx'] as const satisfies ProviderName[]

export type SingleAutodetectedLocalProvider = typeof singleAutodetectedLocalProviders[number]

/** Map legacy / alias API ids to one canonical name per provider (avoids duplicate list entries). */
export const canonicalModelNameForProvider = (providerName: ProviderName, modelName: string): string => {
	const lower = modelName.toLowerCase()

	if (providerName === 'anthropic') {
		if (lower === 'claude-sonnet-4-5-20250929') return 'claude-sonnet-4-5'
		if (lower === 'claude-3-7-sonnet-20250219') return 'claude-3-7-sonnet-latest'
		if (lower === 'claude-sonnet-4-20250514') return 'claude-sonnet-4-6'
		if (lower === 'claude-opus-4-20250514') return 'claude-opus-4-6'
	}

	if (providerName === 'openAI') {
		if (lower === 'gpt-4o-mini') return 'gpt-4.1-mini'
		if (lower === 'gpt-4o') return 'gpt-4.1'
		if (lower === 'o1-mini') return 'o4-mini'
		if (lower === 'o1') return 'o3'
		if (lower === 'o3-mini') return 'o4-mini'
	}

	if (providerName === 'xAI') {
		if (lower.startsWith('grok-2') || lower.startsWith('grok-3')) return 'grok-4.7'
	}

	if (providerName === 'mistral') {
		if (lower === 'magistral-small-latest') return 'mistral-small-latest'
		if (lower === 'devstral-small-latest') return 'devstral-latest'
		if (lower === 'glm-5.3' || lower === 'glm-5-3' || lower === 'glm-5.3-latest') return 'zai-glm-5-3'
		if (lower === 'glm-5.2' || lower === 'glm-5-2' || lower === 'glm-5.2-latest') return 'zai-glm-5-2'
	}

	return modelName
}

const modelTypePriority: Record<VoidStatefulModelInfo['type'], number> = {
	autodetected: 3,
	default: 2,
	custom: 1,
}

/** Collapse duplicate model names (aliases, default+custom overlap, etc.). */
export const dedupeProviderModels = (providerName: ProviderName, models: VoidStatefulModelInfo[]): VoidStatefulModelInfo[] => {
	const defaultNames = new Set<string>(defaultModelsOfProvider[providerName] ?? [])
	const groups = new Map<string, VoidStatefulModelInfo[]>()

	for (const model of models) {
		const canonical = canonicalModelNameForProvider(providerName, model.modelName)
		const normalized = canonical === model.modelName ? model : { ...model, modelName: canonical }
		const key = canonical.toLowerCase()
		const group = groups.get(key) ?? []
		group.push(normalized)
		groups.set(key, group)
	}

	const deduped: VoidStatefulModelInfo[] = []
	for (const group of groups.values()) {
		const best = group.reduce((keep, candidate) => {
			const keepPriority = modelTypePriority[keep.type]
			const candidatePriority = modelTypePriority[candidate.type]
			if (candidatePriority > keepPriority) return candidate
			if (keepPriority > candidatePriority) return keep
			const keepInDefaults = defaultNames.has(keep.modelName) ? 1 : 0
			const candidateInDefaults = defaultNames.has(candidate.modelName) ? 1 : 0
			return candidateInDefaults > keepInDefaults ? candidate : keep
		})
		deduped.push({
			...best,
			modelName: best.modelName,
			isHidden: group.every(m => m.isHidden),
		})
	}

	return deduped
}

export const normalizeAutodetectedModelNamesForProvider = (providerName: ProviderName, modelNames: string[]): string[] => {
	if (providerName === 'mlx') {
		const unique = [...new Set(modelNames.map(n => canonicalModelNameForProvider(providerName, n)))]
		return unique.length > 0 ? [unique[0]] : []
	}
	return modelNames.map(n => canonicalModelNameForProvider(providerName, n))
}

export const consolidateSingleAutodetectedProviderModels = (
	providerName: SingleAutodetectedLocalProvider,
	mergedModels: VoidStatefulModelInfo[],
): VoidStatefulModelInfo[] => {
	const customModels = mergedModels.filter(m => m.type === 'custom')
	const autodetected = mergedModels.find(m => m.type === 'autodetected')
	if (!autodetected) {
		return customModels
	}
	const primary: VoidStatefulModelInfo = { ...autodetected, type: 'autodetected' }
	return dedupeProviderModels(providerName, [
		primary,
		...customModels.filter(m => canonicalModelNameForProvider(providerName, m.modelName).toLowerCase() !== primary.modelName.toLowerCase()),
	])
}
