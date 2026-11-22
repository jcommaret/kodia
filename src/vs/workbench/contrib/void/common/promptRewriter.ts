/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Prompt rewriting ("Remodify Prompt") prompt builder and response parser.
 *
 * Ensures models strictly rewrite the user's draft prompt into a clearer, more
 * actionable prompt for Kodia's coding agent — never answering the prompt,
 * never executing/asking for project links, and stripping any preamble or
 * reasoning tags.
 */

export function buildRemodifyPromptRequest(draftPrompt: string, workspaceName?: string): {
	systemMessage: string;
	userMessage: string;
} {
	const workspaceContext = workspaceName
		? `The user is working inside an AI code editor with the project workspace "${workspaceName}" already open (the coding agent has full tools to inspect files, code, tests, git, and terminal).`
		: `The user is working inside an AI code editor with their project already open (the coding agent has full tools to inspect files, code, tests, git, and terminal).`;

	const systemMessage = [
		'You are a strict prompt editor inside Kodia (an AI software engineering IDE).',
		workspaceContext,
		'Your ONLY task is to rewrite the user draft inside <draft_prompt> into a clearer, well-structured, more effective prompt that the user will send to Kodia\'s coding agent.',
		'',
		'CRITICAL RULES:',
		'1. NEVER answer the draft prompt or perform the task it describes.',
		'2. NEVER ask the user for project names, links, files, attachments, or clarification — Kodia\'s coding agent can inspect the open workspace itself.',
		'3. Preserve the user\'s exact intent and perspective (first-person request from the user to the coding agent).',
		'4. Fix typos/grammar and make vague requests concrete and actionable (e.g., "what is this project anout" -> "Inspect this workspace and explain what this project is about, including its purpose, tech stack, key directories and entry points, and how to run or test it.").',
		'5. Output ONLY the rewritten prompt wrapped inside <rewritten_prompt>...</rewritten_prompt> tags, with zero extra commentary before or after.',
	].join('\n');

	const userMessage = [
		'Rewrite the following draft prompt without answering it or asking follow-up questions. Return ONLY <rewritten_prompt>...</rewritten_prompt>.',
		'',
		'<draft_prompt>',
		draftPrompt.trim(),
		'</draft_prompt>',
	].join('\n');

	return { systemMessage, userMessage };
}

/**
 * Extract the clean rewritten prompt text from a model response.
 * Strips `<think>` blocks, extracts `<rewritten_prompt>` tags when present,
 * strips preambles/surrounding quotes, and returns `null` if the model mistakenly
 * replied conversationally (e.g., asking for context instead of rewriting).
 */
export function extractRewrittenPrompt(rawOutput: string): { rewritten: string } | { error: string } {
	// Strip any <think>...</think> reasoning blocks
	let cleaned = rawOutput.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

	// Prefer explicit <rewritten_prompt>...</rewritten_prompt> block
	const tagMatch = /<rewritten_prompt>\s*([\s\S]*?)\s*<\/rewritten_prompt>/i.exec(cleaned);
	if (tagMatch && tagMatch[1].trim()) {
		cleaned = tagMatch[1].trim();
	} else {
		// Strip accidental fenced code block wrapper
		const fenceMatch = /^```(?:text|markdown|md)?\r?\n([\s\S]*?)\r?\n```$/i.exec(cleaned);
		if (fenceMatch && fenceMatch[1].trim()) {
			cleaned = fenceMatch[1].trim();
		}
		// Strip common preambles like "Here is the rewritten prompt:"
		cleaned = cleaned.replace(/^(?:here(?:'s| is) (?:the |your )?(?:rewritten|improved|remodified|revised) prompt:?\s*\r?\n+)/i, '').trim();
		// Strip accidental wrapping double quotes
		if (cleaned.length >= 2 && cleaned.startsWith('"') && cleaned.endsWith('"') && !cleaned.slice(1, -1).includes('"')) {
			cleaned = cleaned.slice(1, -1).trim();
		}
	}

	if (!cleaned) {
		return { error: 'Model returned an empty rewrite. Please try again.' };
	}

	// Detect conversational assistant replies where the model answered/refused instead of rewriting
	const looksLikeAssistantReply =
		/^(?:i['’]m not sure which project|i don['’]t have (?:access|context)|could you (?:share|provide) more details|there['’]s no context or attachment|please provide (?:more details|the project|your code)|i['’]d be happy to help once you)/i.test(cleaned);
	if (looksLikeAssistantReply) {
		return { error: 'The model tried to answer instead of rewriting your prompt. Try again or switch to a stronger model.' };
	}

	return { rewritten: cleaned };
}
