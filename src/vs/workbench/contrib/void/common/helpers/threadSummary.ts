/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { findLastIdx } from '../../../../../base/common/arraysFind.js';
import { KEEP_RECENT_STEPS, MIN_STEPS_TO_SUMMARIZE } from '../../../../../platform/kodia/common/threadSummary.js';
import { ChatMessage } from '../chatThreadServiceTypes.js';

// the transcript the model summarizes is shared with the Kodia agent of the Agents window
export { transcriptForSummary } from '../../../../../platform/kodia/common/threadSummary.js';

// Which messages a summary replaces, and the transcript the model summarizes (see ContextSummaryEntry).

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
