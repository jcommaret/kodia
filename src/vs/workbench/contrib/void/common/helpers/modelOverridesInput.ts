/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { modelOverrideKeys, StoredModelOverrides } from '../modelCapabilities.js';

// What the user types to change a model's capabilities (Settings > Models > a model's gear): checked here before it
// is saved, so a typo can't reach the requests sent to the model.

export const systemMessageOptions = ['system-role', 'developer-role', 'separated', false] as const
export const toolFormatOptions = ['openai-style', 'anthropic-style', 'gemini-style', null] as const

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const isTokenCount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isInteger(value) && value > 0

const oneOf = (options: readonly unknown[]) => options.map(option => JSON.stringify(option)).join(', ')

/** What is wrong with the value given for `key`, or null when it can be used. */
const problemOf = (key: (typeof modelOverrideKeys)[number], value: unknown): string | null => {
	switch (key) {
		case 'contextWindow':
			return isTokenCount(value) ? null : 'must be a whole number of tokens above 0'
		case 'reservedOutputTokenSpace':
			return isTokenCount(value) ? null : 'must be a whole number of tokens above 0'
		case 'supportsSystemMessage':
			return (systemMessageOptions as readonly unknown[]).includes(value) ? null : `must be one of ${oneOf(systemMessageOptions)}`
		case 'specialToolFormat':
			return (toolFormatOptions as readonly unknown[]).includes(value) ? null : `must be one of ${oneOf(toolFormatOptions)}`
		case 'supportsFIM':
		case 'supportsVision':
		case 'supportsPDF':
		case 'supportsPredictedOutputs':
			return typeof value === 'boolean' ? null : 'must be true or false'
		case 'reasoningCapabilities':
			if (value === false) return null
			if (!isPlainObject(value) || value.supportsReasoning !== true) return 'must be false, or an object with "supportsReasoning": true'
			if (typeof value.canTurnOffReasoning !== 'boolean' || typeof value.canIOReasoning !== 'boolean') return 'needs "canTurnOffReasoning" and "canIOReasoning" (true or false)'
			return null
		case 'additionalOpenAIPayload':
			return isPlainObject(value) ? null : 'must be an object'
	}
}

/**
 * The overrides in `input` (parsed JSON), or what is wrong with it. A key Kodia doesn't know is an error rather than
 * dropped in silence: it is most often a misspelled one.
 */
export const parseModelOverrides = (input: unknown): { overrides: StoredModelOverrides, error?: undefined } | { error: string } => {
	if (!isPlainObject(input)) return { error: 'The overrides must be a JSON object, like { "contextWindow": 32000 }.' }

	const overrides: Record<string, unknown> = {}
	for (const key of Object.keys(input)) {
		if (!(modelOverrideKeys as readonly string[]).includes(key)) {
			return { error: `"${key}" isn't a setting Kodia knows. The settings are: ${modelOverrideKeys.join(', ')}.` }
		}
		const value = input[key]
		// an empty value means "keep Kodia's default", but for the tool format, where null means "none"
		if (value === '' || value === undefined || (value === null && key !== 'specialToolFormat')) continue
		const problem = problemOf(key as (typeof modelOverrideKeys)[number], value)
		if (problem) return { error: `"${key}" ${problem}.` }
		overrides[key] = value
	}
	return { overrides: overrides as StoredModelOverrides }
}

/** `text` as overrides, or what is wrong with it. */
export const parseModelOverridesText = (text: string): ReturnType<typeof parseModelOverrides> => {
	if (!text.trim()) return { overrides: {} }
	let parsed: unknown
	try { parsed = JSON.parse(text) }
	catch { return { error: 'This is not valid JSON.' } }
	return parseModelOverrides(parsed)
}
