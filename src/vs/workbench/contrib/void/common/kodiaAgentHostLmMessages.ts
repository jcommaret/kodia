/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { IByokLmChatResult, IByokLmInputItem, IByokLmOutputItem, IByokLmReasoningItem, IByokLmTool } from '../../../../platform/agentHost/common/agentHostByokLm.js';
import { InternalToolInfo } from './prompt/prompts.js';
import type { ChatMedia } from './prepareLLMMessages.js';
import { AnthropicReasoning, LLMUsage, OnFinalMessage, RawToolParamsObj } from './sendLLMMessageTypes.js';
import { ToolName } from './toolsServiceTypes.js';

/**
 * Kodia: conversions between the Kodia agent's wire shapes (the BYOK bridge's
 * Responses-like items, see `kodiaAgentHostLm.ts`) and Kodia's LLM service.
 */

/** Kodia's simple messages (`IConvertToLLMMessageService.prepareLLMSimpleMessages`): a user's message carries the images attached to it. */
export type KodiaAgentSimpleMessage =
	| { role: 'user'; content: string; media?: ChatMedia[] }
	| { role: 'assistant'; content: string; anthropicReasoning: AnthropicReasoning[] | null }
	| { role: 'tool'; content: string; id: string; name: ToolName; rawParams: RawToolParamsObj };

/** Where a reasoning item keeps the Anthropic thinking blocks, which must be sent back during a tool loop. */
const ANTHROPIC_REASONING_KEY = 'anthropicReasoning';

export function toInternalTool(tool: IByokLmTool): InternalToolInfo[] {
	if (tool.type !== 'function') {
		return [];
	}
	// The parameters' descriptions are what a model without native tool calling is told (XML tools); the schema is what
	// the other models get: the types and the required parameters the tool declares, see toolSchema.ts.
	const properties = (tool.parametersSchema as { properties?: Record<string, { description?: string }> } | undefined)?.properties ?? {};
	const params: InternalToolInfo['params'] = {};
	for (const [name, property] of Object.entries(properties)) {
		params[name] = { description: property.description ?? '' };
	}
	return [{ name: tool.name, description: tool.description ?? '', params, ...tool.parametersSchema ? { inputSchema: tool.parametersSchema } : {} }];
}

function parseArguments(argumentsJson: string): RawToolParamsObj {
	try {
		const parsed = JSON.parse(argumentsJson);
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

function anthropicReasoningOf(item: IByokLmReasoningItem): AnthropicReasoning[] | null {
	const reasoning = item.metadata?.[ANTHROPIC_REASONING_KEY];
	return Array.isArray(reasoning) && reasoning.length ? reasoning as AnthropicReasoning[] : null;
}

/**
 * The agent's history as Kodia's simple messages. A model response is a run of
 * items (reasoning, text, tool calls) and Kodia pairs each tool call with its
 * result, right after the assistant message that made it.
 */
export function toSimpleMessages(input: readonly IByokLmInputItem[]): KodiaAgentSimpleMessage[] {
	const outputs = new Map<string, string>();
	for (const item of input) {
		if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
			outputs.set(item.callId, item.output);
		}
	}
	const messages: KodiaAgentSimpleMessage[] = [];
	let reasoning: AnthropicReasoning[] | null = null;
	// Whether the latest item belongs to the model response being read, so a tool call joins its assistant message.
	let inResponse = false;
	for (const item of input) {
		switch (item.type) {
			case 'message': {
				if (item.role === 'assistant') {
					messages.push({ role: 'assistant', content: item.content.map(part => part.type === 'text' ? part.text : '').join(''), anthropicReasoning: reasoning });
					reasoning = null;
					inResponse = true;
				} else if (item.role === 'user') {
					// the prompt, then each of the attachments the agent put after it, as a text part
					const text = item.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n\n');
					const media = item.content.flatMap((part): ChatMedia[] => part.type === 'image' ? [{ kind: 'image', mimeType: part.mimeType, dataBase64: part.data }] : []);
					messages.push({ role: 'user', content: text, ...media.length ? { media } : {} });
					inResponse = false;
				}
				break;
			}
			case 'reasoning':
				reasoning = anthropicReasoningOf(item);
				inResponse = true;
				break;
			case 'function_call': {
				const output = outputs.get(item.callId);
				if (output === undefined) {
					break; // a call without a result can't be sent back
				}
				if (!inResponse || reasoning) {
					messages.push({ role: 'assistant', content: '', anthropicReasoning: reasoning });
					reasoning = null;
				}
				messages.push({ role: 'tool', id: item.callId, name: item.name, rawParams: parseArguments(item.argumentsJson), content: output });
				inResponse = true;
				break;
			}
			case 'function_call_output':
			case 'custom_tool_call_output':
				inResponse = false;
				break;
		}
	}
	return messages;
}

export function toOutput({ fullText, fullReasoning, toolCalls, anthropicReasoning }: Parameters<OnFinalMessage>[0]): IByokLmOutputItem[] {
	const output: IByokLmOutputItem[] = [];
	if (fullReasoning || anthropicReasoning?.length) {
		output.push({
			type: 'reasoning',
			summary: fullReasoning ? [fullReasoning] : [],
			...(anthropicReasoning?.length ? { metadata: { [ANTHROPIC_REASONING_KEY]: anthropicReasoning } } : {}),
		});
	}
	if (fullText) {
		output.push({ type: 'message', content: [{ type: 'text', text: fullText }] });
	}
	for (const call of toolCalls ?? []) {
		output.push({ type: 'function_call', callId: call.id, name: call.name, argumentsJson: JSON.stringify(call.rawParams) });
	}
	return output;
}

export function toUsage(usage: LLMUsage | undefined): IByokLmChatResult['usage'] {
	return usage ? { inputTokens: usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0), outputTokens: usage.output } : undefined;
}

/**
 * What `full`, the whole text so far, adds to `sent`, the part already reported: the delta of a model that streams
 * its text. Nothing when `full` has not grown, or is not a continuation of `sent` (the window's parsers of think tags
 * and XML tool calls hold back what they can't place yet, and a delta only appends).
 */
export function appendedText(sent: string, full: string): string {
	return full.length > sent.length && full.startsWith(sent) ? full.slice(sent.length) : '';
}
