/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// What Kodia's chat and the Kodia agent of the Agents window do when a conversation outgrows the model's context
// window: first the results of old tool calls are cleared, then the model summarizes the older messages. The prompts,
// the stub, the transcript the model summarizes and the sizes are shared; which messages a summary replaces depends on
// each side's own message shape.

// sent in place of the result of an old tool call, once the conversation no longer fits the window
export const CLEARED_TOOL_RESULT = '(This result was cleared to fit the context window. Call the tool again if you need it.)'

// in one long agent turn, the latest steps (assistant messages and their tool results) stay as they are...
export const KEEP_RECENT_STEPS = 4
// ...and there must be this many older steps to summarize, so a turn isn't summarized again at every step
export const MIN_STEPS_TO_SUMMARIZE = 4

// the transcript takes up to half the window (~3 characters per token)
export const summaryTranscriptMaxChars = (contextWindow: number) => Math.max(8_000, Math.floor((contextWindow - 8_000) * 0.5 * 3))

const SUMMARY_NOTE = '(The earlier part of this conversation was summarized to fit the context window.)'
const SUMMARY_TITLE = 'SUMMARY OF THE EARLIER CONVERSATION:\n'

export const summarizeThread_systemMessage = `\
You summarize a conversation between a user and an AI coding agent. The agent will continue the work from your summary alone: the messages you summarize will be gone.

Keep everything the agent needs to continue:
- what the user asked for, with their exact constraints and preferences;
- the decisions made, and why;
- the files read, created or changed (full paths), and what changed in them;
- the commands run and what they showed, the errors met and how they were fixed;
- what is done, and what remains to do.

Leave out pleasantries and details that no longer matter. Write short bullet points under short headings, at most about 600 words. State only what the conversation shows.`

export const summarizeThread_userMessage = (transcript: string) => `\
Summarize this conversation, following your instructions.

<conversation>
${transcript}
</conversation>`

// sent to the chat model in place of the summarized messages; latestRequest when the summary cut the current turn
export const summarizedThreadMessage = (summary: string, latestRequest: string | undefined) => [
	SUMMARY_NOTE,
	`${SUMMARY_TITLE}${summary}`,
	...latestRequest !== undefined ? [`THE USER'S CURRENT REQUEST, which you are working on:\n${latestRequest}`] : [],
].join('\n\n')

// a message of a conversation, as far as a summary needs: Kodia's chat messages and the agent's both fit
export type SummarizableMessage = {
	readonly role: string,
	readonly content?: unknown,
	readonly displayContent?: unknown,
	readonly name?: unknown,
	readonly rawParams?: unknown,
}

const cap = (s: string, maxChars: number) => s.length <= maxChars ? s : `${s.slice(0, maxChars)}… (${s.length - maxChars} more characters)`

// the messages as plain text, at most maxChars: when too long, its middle is left out
export const transcriptForSummary = (messages: readonly SummarizableMessage[], { previousSummary, maxChars }: { previousSummary: string | undefined, maxChars: number }): string => {
	const parts: string[] = []
	if (previousSummary) parts.push(`SUMMARY OF THE CONVERSATION BEFORE THIS:\n${previousSummary}`)
	for (const m of messages) {
		if (m.role === 'user' && typeof m.content === 'string') parts.push(`USER:\n${cap(m.content, 6_000)}`)
		else if (m.role === 'assistant' && typeof m.displayContent === 'string' && m.displayContent.trim()) parts.push(`ASSISTANT:\n${cap(m.displayContent, 4_000)}`)
		else if (m.role === 'tool' && typeof m.content === 'string') parts.push(`TOOL CALL ${m.name}(${cap(JSON.stringify(m.rawParams ?? {}), 600)}):\n${cap(m.content, 1_500)}`)
	}

	const transcript = parts.join('\n\n')
	if (transcript.length <= maxChars) return transcript
	const head = Math.floor(maxChars / 4)
	return `${transcript.slice(0, head)}\n\n[... part of the conversation left out ...]\n\n${transcript.slice(transcript.length - (maxChars - head))}`
}
