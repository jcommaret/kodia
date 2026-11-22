/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Recognizes a provider's "your prompt is longer than my context window" error, across the common
 * OpenAI-compatible servers (OpenAI, vLLM, NVIDIA NIM, llama.cpp, Ollama, OpenRouter, Groq...), Anthropic and Gemini.
 * When the provider states its limit, it is returned so the agent can learn the model's real window.
 */

const OVERFLOW_PATTERNS: RegExp[] = [
	/context[_\s-]?length[_\s-]?exceeded/i,
	/maximum context length/i,
	/context (?:length|window) (?:is|of)\s+\d/i,
	/exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context (?:length|window|size)/i,
	/(?:prompt|input) is too long/i,
	/too many (?:input )?tokens/i,
	/input (?:token count|length).{0,40}exceeds/i,
	/request(?:ed)? (?:too many|\d[\d,]*) tokens.{0,60}(?:context|maximum|limit)/i,
	/exceed_context_size_error/i,
];

const LIMIT_PATTERNS: RegExp[] = [
	/maximum context length (?:is|of)\s+(\d[\d,]*)/i,
	/context (?:length|window|size) (?:is|of)\s+(\d[\d,]*)/i,
	/maximum (?:input )?(?:context|tokens?)\D{0,20}(\d[\d,]*)/i,
	/n_ctx[^\d]{0,10}(\d[\d,]*)/i,
	/(?:limit|maximum) of (\d[\d,]*) tokens/i,
];

export function isContextOverflowError(message: string | undefined | null): boolean {
	if (!message) { return false; }
	return OVERFLOW_PATTERNS.some(re => re.test(message));
}

/** The context window the provider says the model has, if the error states it (plausible values only). */
export function contextLimitFromError(message: string | undefined | null): number | undefined {
	if (!message) { return undefined; }
	for (const re of LIMIT_PATTERNS) {
		const m = re.exec(message);
		if (m) {
			const n = Number(m[1].replace(/,/g, ''));
			if (Number.isFinite(n) && n >= 512 && n <= 20_000_000) { return n; }
		}
	}
	return undefined;
}
