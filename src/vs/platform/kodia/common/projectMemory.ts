/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The project memory's file format, shared by Kodia's chat and the Kodia agent of the Agents window.

// In the repo, so people can read, edit, version and share it; the agent keeps it in "## Section"s.
export const PROJECT_MEMORY_FILE_PATH = '.kodia/memory.md'

export const PROJECT_MEMORY_FILE_HEADER = `<!-- Notes Kodia's agent keeps about this project across sessions (write_project_memory rewrites one "## " section at a time). Edit freely. -->`

// the whole memory is sent with every request
export const MAX_PROJECT_MEMORY_TOKENS = 2_000

type MemorySection = { title: string, body: string }

// text before the first "## " heading is kept as-is
export const parseMemorySections = (memory: string): { preamble: string, sections: MemorySection[] } => {
	const parts = memory.split(/^## /m)
	const preamble = parts.shift()!.trim()
	const sections = parts.map(part => {
		const newline = part.indexOf('\n')
		return newline === -1
			? { title: part.trim(), body: '' }
			: { title: part.slice(0, newline).trim(), body: part.slice(newline + 1).trim() }
	})
	return { preamble, sections }
}

const renderMemorySections = ({ preamble, sections }: { preamble: string, sections: MemorySection[] }) =>
	[preamble, ...sections.map(s => s.body ? `## ${s.title}\n${s.body}` : `## ${s.title}`)].filter(s => !!s).join('\n\n') + '\n'

// Replaces the section's body (or adds the section); empty content removes it. Section titles match case-insensitively.
export const memoryWithSection = (memory: string, title: string, content: string) => {
	const parsed = parseMemorySections(memory)
	const idx = parsed.sections.findIndex(s => s.title.toLowerCase() === title.toLowerCase())
	if (!content.trim()) {
		if (idx !== -1) parsed.sections.splice(idx, 1)
	}
	else if (idx !== -1) parsed.sections[idx] = { title: parsed.sections[idx].title, body: content.trim() }
	else parsed.sections.push({ title, body: content.trim() })
	return renderMemorySections(parsed)
}

export const memoryTooLongMessage = (tokenCount: number) =>
	`The project memory would be ${tokenCount} tokens, over its ~${MAX_PROJECT_MEMORY_TOKENS}-token limit, so nothing was saved. Condense it first: rewrite the longest sections more briefly, merge overlapping ones, or delete outdated ones (empty content). Then save again.`
