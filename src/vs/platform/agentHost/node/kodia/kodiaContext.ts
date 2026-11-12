/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import type { IByokLmContentPart, IByokLmInputItem, IByokLmMessageItem } from '../../common/agentHostByokLm.js';
import { CLEARED_TOOL_RESULT, KEEP_RECENT_STEPS, MIN_STEPS_TO_SUMMARIZE, SummarizableMessage, summarizedThreadMessage } from '../../../kodia/common/threadSummary.js';

// Keeping the Kodia agent's conversation within the model's context window, as Kodia's chat does: the results of old
// tool calls are cleared, then the older messages are summarized (see `threadSummary.ts`).
//
// The history is what the Agents window shows, and a restored session rebuilds its turns from it, so it is never
// changed. A `IKodiaCompaction` says what the model is sent in its place, and `modelHistory` applies it. All pure, so
// it can be tested; KodiaAgent asks the model for the summary.

/** What is left out of what the model is sent. Kept with the session. */
export interface IKodiaCompaction {
	/** The results of the tool calls before this index of the history are sent as a stub. */
	readonly clearedBefore: number;
	/** The history before `keepFromIdx` is sent as this summary. */
	readonly summary?: { readonly text: string; readonly keepFromIdx: number };
}

const CHARS_PER_TOKEN = 3;
// an image takes about this many tokens, whatever its size in characters
const IMAGE_CHARS = 3_000;

const isToolOutput = (item: IByokLmInputItem): item is Extract<IByokLmInputItem, { type: 'function_call_output' | 'custom_tool_call_output' }> =>
	item.type === 'function_call_output' || item.type === 'custom_tool_call_output';

// the text of a message: after the prompt of a user's message come its attachments, one a part
const textOfParts = (parts: readonly IByokLmContentPart[]) => parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n\n');

const sizeOfParts = (parts: readonly IByokLmContentPart[] | undefined) => (parts ?? []).reduce((chars, part) => chars + (part.type === 'text' ? part.text.length : IMAGE_CHARS), 0);

// the text of a message, if it is the user's or the model's
const textOfMessage = (item: IByokLmInputItem, role: IByokLmMessageItem['role']): string | undefined =>
	item.type === 'message' && item.role === role ? textOfParts(item.content) : undefined;

/**
 * About how many tokens `items` take, which is all that is known until a response says: a message, a call, a result and
 * a reasoning each count their characters, an image a fixed size.
 */
export function estimateHistoryTokens(items: readonly IByokLmInputItem[]): number {
	let chars = 0;
	for (const item of items) {
		switch (item.type) {
			case 'message': chars += sizeOfParts(item.content); break;
			case 'reasoning': chars += item.summary.join('').length; break;
			case 'function_call': chars += item.name.length + item.argumentsJson.length; break;
			case 'function_call_output': chars += item.output.length + sizeOfParts(item.content); break;
			case 'custom_tool_call': chars += item.name.length + item.input.length; break;
			case 'custom_tool_call_output': chars += item.output.length + sizeOfParts(item.content); break;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** The tokens `chars` characters take, about. */
export const tokensOfChars = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

/** The index of the latest message of the user, or -1. */
export function latestUserIdx(history: readonly IByokLmInputItem[]): number {
	for (let i = history.length - 1; i >= 0; i--) {
		if (textOfMessage(history[i], 'user') !== undefined) {
			return i;
		}
	}
	return -1;
}

/**
 * What the model is sent: the history, but for what the compaction leaves out. The results of old tool calls are a
 * stub, and what a summary covers is the summary, a message of the user that says so, which carries the user's request
 * if the summary cut the current turn, so the work goes on.
 */
export function modelHistory(history: IByokLmInputItem[], compaction: IKodiaCompaction | undefined): IByokLmInputItem[] {
	if (!compaction || (compaction.clearedBefore <= 0 && !compaction.summary)) {
		return history;
	}
	const summary = compaction.summary && compaction.summary.keepFromIdx > 0 && compaction.summary.keepFromIdx <= history.length ? compaction.summary : undefined;
	const from = summary?.keepFromIdx ?? 0;
	const items: IByokLmInputItem[] = [];
	for (let i = from; i < history.length; i++) {
		const item = history[i];
		items.push(i < compaction.clearedBefore && isToolOutput(item) && item.output !== CLEARED_TOOL_RESULT ? { type: item.type, callId: item.callId, output: CLEARED_TOOL_RESULT } : item);
	}
	if (!summary) {
		return items;
	}
	const userIdx = latestUserIdx(history);
	const latestRequest = userIdx !== -1 && userIdx < summary.keepFromIdx ? textOfMessage(history[userIdx], 'user') : undefined;
	return [{ type: 'message', role: 'user', content: [{ type: 'text', text: summarizedThreadMessage(summary.text, latestRequest) }] }, ...items];
}

/** What a model that can't see images is told in place of one, in a message of the user. */
export const IMAGE_NOT_SEEN_NOTE = '(An image was attached here, but this model cannot see images.)';

/**
 * What a model that can't see images is sent: the history, but for the images of the user's messages, which are the
 * note that one was attached. The history keeps them, for a model that can see them.
 */
export function withoutImages(history: IByokLmInputItem[]): IByokLmInputItem[] {
	const hasImage = (item: IByokLmInputItem) => item.type === 'message' && item.content.some(part => part.type === 'image');
	if (!history.some(hasImage)) {
		return history;
	}
	return history.map(item => item.type === 'message' && hasImage(item)
		? { ...item, content: item.content.map((part): IByokLmContentPart => part.type === 'image' ? { type: 'text', text: IMAGE_NOT_SEEN_NOTE } : part) }
		: item);
}

/**
 * The compaction that also clears the results of the tool calls made before the latest message of the user, and how
 * many characters that frees; undefined if there was nothing more to clear.
 */
export function clearOldToolResults(history: readonly IByokLmInputItem[], compaction: IKodiaCompaction | undefined): { readonly compaction: IKodiaCompaction; readonly clearedChars: number } | undefined {
	const userIdx = latestUserIdx(history);
	const alreadyCleared = compaction?.clearedBefore ?? 0;
	if (userIdx <= alreadyCleared) {
		return undefined;
	}
	let clearedChars = 0;
	// what a summary covers isn't sent anyway
	for (let i = Math.max(alreadyCleared, compaction?.summary?.keepFromIdx ?? 0); i < userIdx; i++) {
		const item = history[i];
		if (isToolOutput(item) && item.output !== CLEARED_TOOL_RESULT) {
			clearedChars += Math.max(0, item.output.length + sizeOfParts(item.content) - CLEARED_TOOL_RESULT.length);
		}
	}
	return clearedChars > 0 ? { compaction: { ...compaction, clearedBefore: userIdx }, clearedChars } : undefined;
}

// where each step starts after `from`: a model response, then the results of its calls (never cut between them)
function stepStarts(history: readonly IByokLmInputItem[], from: number): number[] {
	const starts: number[] = [];
	for (let i = from; i < history.length; i++) {
		if (!isToolOutput(history[i]) && (i === from || isToolOutput(history[i - 1]))) {
			starts.push(i);
		}
	}
	return starts;
}

/**
 * The index the summary keeps the history from, or undefined if there is nothing new to summarize: the turns before
 * the latest message of the user, or, in one long turn, its steps but the latest few. `summarizedBefore` is the
 * `keepFromIdx` of the latest summary (0 if none): what is before it is in that summary already.
 */
export function chooseKeepIdx(history: readonly IByokLmInputItem[], summarizedBefore: number): number | undefined {
	const userIdx = latestUserIdx(history);
	if (userIdx === -1) {
		return undefined;
	}
	if (userIdx > summarizedBefore) {
		return userIdx;
	}
	const steps = stepStarts(history, Math.max(userIdx + 1, summarizedBefore));
	return steps.length < KEEP_RECENT_STEPS + MIN_STEPS_TO_SUMMARIZE ? undefined : steps[steps.length - KEEP_RECENT_STEPS];
}

/** The messages of the history from `from` to `to`, for the model that summarizes them: a call and its result are one. */
export function transcriptMessages(history: readonly IByokLmInputItem[], from: number, to: number): SummarizableMessage[] {
	const calls = new Map<string, { readonly name: string; readonly args: string }>();
	const messages: SummarizableMessage[] = [];
	for (const item of history.slice(from, to)) {
		const userText = textOfMessage(item, 'user');
		const modelText = textOfMessage(item, 'assistant');
		if (userText !== undefined) {
			messages.push({ role: 'user', content: userText });
		} else if (modelText !== undefined) {
			messages.push({ role: 'assistant', displayContent: modelText });
		} else if (item.type === 'function_call') {
			calls.set(item.callId, { name: item.name, args: item.argumentsJson });
		} else if (item.type === 'function_call_output') {
			const call = calls.get(item.callId);
			if (call) {
				let rawParams: unknown;
				try { rawParams = JSON.parse(call.args); } catch { rawParams = {}; }
				messages.push({ role: 'tool', name: call.name, rawParams, content: item.output });
			}
		}
	}
	return messages;
}
