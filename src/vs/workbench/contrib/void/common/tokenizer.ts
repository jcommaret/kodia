/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { importAMDNodeModule } from '../../../../amdX.js';

// Supported BPE encodings shipped in the installed `gpt-tokenizer` package.
// Only encodings with a corresponding UMD build under `dist/` are listed here.
export type TokenizerEncoding = 'o200k_base' | 'cl100k_base';

export type TokenizerAccuracy = 'exact' | 'approximate';

export type TokenizerSelectionReason = 'exact-model' | 'family-hint' | 'fallback';

export interface TokenizerSelection {
	encoding: TokenizerEncoding;
	reason: TokenizerSelectionReason;
	accuracy: TokenizerAccuracy;
	countTokens: (text: string) => number;
}

const FALLBACK_CHARS_PER_TOKEN = 4;

// Map from encoding name to the AMD module path inside the `gpt-tokenizer` package (relative to the package: was
// 'gpt-tokenizer/dist/…', which importAMDNodeModule resolved to node_modules/gpt-tokenizer/gpt-tokenizer/dist/… —
// a file that does not exist, so every count silently fell back to the chars/4 estimate in the app).
const encodingModulePath: Record<TokenizerEncoding, string> = {
	o200k_base: 'dist/o200k_base.js',
	cl100k_base: 'dist/cl100k_base.js',
};

/** whether the real BPE tokenizer for an encoding has loaded (false: counts are the chars/4 estimate) */
export const isTokenizerLoaded = (encoding: TokenizerEncoding = 'o200k_base'): boolean => !!loadedEncodings.get(encoding)?.countTokens;
/** resolves once the encoding has loaded, or rejects with why it could not */
export const whenTokenizerLoaded = (encoding: TokenizerEncoding = 'o200k_base'): Promise<void> => { loadEncoding(encoding); return loadPromises.get(encoding)!; };
const loadPromises = new Map<TokenizerEncoding, Promise<void>>();

// In-flight / loaded tokenizer modules keyed by encoding.
// `importAMDNodeModule` already caches by module path, but we keep our own cache
// so we can track load state per encoding and avoid re-issuing loads.
const loadedEncodings = new Map<TokenizerEncoding, { countTokens: (text: string) => number } | undefined>();

function loadEncoding(encoding: TokenizerEncoding): void {
	if (loadedEncodings.has(encoding)) return;
	loadedEncodings.set(encoding, undefined);
	const p = importAMDNodeModule<{ countTokens: (text: string) => number }>(
		'gpt-tokenizer',
		encodingModulePath[encoding]
	).then(mod => {
		if (!mod || typeof mod.countTokens !== 'function') { throw new Error(`gpt-tokenizer ${encoding} has no countTokens`); }
		loadedEncodings.set(encoding, { countTokens: mod.countTokens });
	});
	loadPromises.set(encoding, p);
	p.catch(() => {
		// keep using the fallback estimate (whenTokenizerLoaded reports why)
		loadedEncodings.set(encoding, undefined);
	});
}

// Pre-load o200k_base at import time so the common path has a real tokenizer
// available quickly. Falls back to chars/4 until the module finishes loading.
loadEncoding('o200k_base');

// Generic backward-compatible estimate. Uses o200k_base when loaded, otherwise
// the flat chars-per-token fallback. Callers without model context should use this.
export const estimateTokens = (text: string): number => {
	if (!text) return 0;
	const o200k = loadedEncodings.get('o200k_base');
	if (o200k?.countTokens) return o200k.countTokens(text);
	return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
};

// Resolve a model-aware tokenizer for the given provider and model.
// Returns a synchronous countTokens function plus selection metadata.
// Never throws: unknown models and missing tokenizers degrade to the chars/4 fallback.
export const getTokenizer = (
	providerName: string,
	modelName: string,
	hints?: { tokenizerEncoding?: TokenizerEncoding }
): TokenizerSelection => {
	const lowerModel = modelName.toLowerCase();

	// 1. Exact model hint from catalog metadata.
	if (hints?.tokenizerEncoding) {
		const encoding = hints.tokenizerEncoding;
		loadEncoding(encoding);
		return {
			encoding,
			reason: 'exact-model',
			accuracy: 'exact',
			countTokens: (text: string) => {
				const enc = loadedEncodings.get(encoding);
				if (enc?.countTokens) return enc.countTokens(text);
				return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
			},
		};
	}

	// 2. Family hints for known OpenAI model families.
	if (providerName === 'openAI' || providerName === 'openAICompatible' || providerName === 'openRouter' || providerName === 'groq') {
		// Modern OpenAI models (GPT-5, GPT-6, o1, o3, gpt-oss, etc.) use o200k_base.
		if (/^(gpt-5|gpt-6|o1|o3|gpt-oss|gpt-4o|chatgpt)/.test(lowerModel)) {
			const encoding = 'o200k_base';
			loadEncoding(encoding);
			return {
				encoding,
				reason: 'family-hint',
				accuracy: 'approximate',
				countTokens: (text: string) => {
					const enc = loadedEncodings.get(encoding);
					if (enc?.countTokens) return enc.countTokens(text);
					return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
				},
			};
		}
		// Legacy OpenAI models (GPT-3.5, GPT-4) use cl100k_base.
		if (/^(gpt-3\.5|gpt-4)/.test(lowerModel)) {
			const encoding = 'cl100k_base';
			loadEncoding(encoding);
			return {
				encoding,
				reason: 'family-hint',
				accuracy: 'approximate',
				countTokens: (text: string) => {
					const enc = loadedEncodings.get(encoding);
					if (enc?.countTokens) return enc.countTokens(text);
					return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
				},
			};
		}
	}

	// 3. Safe fallback: prefer o200k_base if already loaded, otherwise chars/4.
	// Mark as approximate — we make no claims about tokenizer compatibility.
	loadEncoding('o200k_base');
	return {
		encoding: 'o200k_base',
		reason: 'fallback',
		accuracy: 'approximate',
		countTokens: (text: string) => {
			const enc = loadedEncodings.get('o200k_base');
			if (enc?.countTokens) return enc.countTokens(text);
			return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
		},
	};
}
