/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { findLastIdx } from '../../../../../base/common/arraysFind.js';
import { ChatMessage } from '../chatThreadServiceTypes.js';

// Which messages a summary replaces, and the transcript the model summarizes (see ContextSummaryEntry).

// in one long agent turn, the latest steps (assistant messages and their tool results) stay as they are...
const KEEP_RECENT_STEPS = 4
// ...and there must be this many older steps to summarize, so a turn isn't summarized again at every step
const MIN_STEPS_TO_SUMMARIZE = 4

// The index the summary keeps messages from, or null if there is nothing new to summarize. summarizedBefore is
// the keepFromIdx of the latest summary (0 if none): the messages before it are already in that summary.
export const chooseSummaryKeepIdx = (messages: ChatMessage[], summarizedBefore: number): number | null => {
	const latestUserIdx = findLastIdx(messages, m => m.role === 'user')
	if (latestUserIdx === -1) return null

	// the turns before the latest user message
	if (latestUserIdx > summarizedBefore && messages.slice(summarizedBefore, latestUserIdx).some(m => m.role === 'user' || m.role === 'assistant')) {
		return latestUserIdx
	}

	// one long agent turn: its older steps
	const steps: number[] = []
	for (let i = Math.max(latestUserIdx + 1, summarizedBefore); i < messages.length; i += 1) {
		if (messages[i].role === 'assistant') steps.push(i)
	}
	if (steps.length < KEEP_RECENT_STEPS + MIN_STEPS_TO_SUMMARIZE) return null
	return steps[steps.length - KEEP_RECENT_STEPS]
}


const cap = (s: string, maxChars: number) => s.length <= maxChars ? s : `${s.slice(0, maxChars)}… (${s.length - maxChars} more characters)`

// the messages as plain text, at most maxChars: when too long, its middle is left out
export const transcriptForSummary = (messages: ChatMessage[], { previousSummary, maxChars }: { previousSummary: string | undefined, maxChars: number }): string => {
	const parts: string[] = []
	if (previousSummary) parts.push(`SUMMARY OF THE CONVERSATION BEFORE THIS:\n${previousSummary}`)
	for (const m of messages) {
		if (m.role === 'user') parts.push(`USER:\n${cap(m.content, 6_000)}`)
		else if (m.role === 'assistant' && m.displayContent.trim()) parts.push(`ASSISTANT:\n${cap(m.displayContent, 4_000)}`)
		else if (m.role === 'tool') parts.push(`TOOL CALL ${m.name}(${cap(JSON.stringify(m.rawParams ?? {}), 600)}):\n${cap(m.content, 1_500)}`)
	}

	const transcript = parts.join('\n\n')
	if (transcript.length <= maxChars) return transcript
	const head = Math.floor(maxChars / 4)
	return `${transcript.slice(0, head)}\n\n[... part of the conversation left out ...]\n\n${transcript.slice(transcript.length - (maxChars - head))}`
}
