/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Context for autocomplete from the other files the user has open ("neighboring tabs"): in each file,
// the lines that share the most identifiers with the code around the cursor.

export type NeighborFile = { path: string, text: string }
export type Snippet = { path: string, snippet: string, score: number }

const WINDOW_LINES = 20
const MAX_LINE_CHARS = 200 // cuts minified lines
const MIN_SCORE = 0.1

const identifiersOf = (code: string) => new Set(code.match(/[A-Za-z_$][\w$]+/g) ?? [])

// shared identifiers over all identifiers (Jaccard)
const similarity = (a: Set<string>, b: Set<string>) => {
	let shared = 0
	for (const id of a) if (b.has(id)) shared++
	const all = a.size + b.size - shared
	return all === 0 ? 0 : shared / all
}

export const similarSnippets = ({ code, files, maxSnippets, maxChars }: { code: string, files: NeighborFile[], maxSnippets: number, maxChars: number }): Snippet[] => {
	const target = identifiersOf(code)
	if (target.size === 0) return []

	const bestOfFiles: Snippet[] = []
	for (const file of files) {
		const lines = file.text.split('\n').map(l => l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) : l)
		let best: Snippet | null = null
		for (let start = 0; ; start += WINDOW_LINES / 2) {
			const snippet = lines.slice(start, start + WINDOW_LINES).join('\n')
			const score = similarity(identifiersOf(snippet), target)
			if (!best || score > best.score) best = { path: file.path, snippet: snippet.trim(), score }
			if (start + WINDOW_LINES >= lines.length) break
		}
		if (best && best.score >= MIN_SCORE && best.snippet) bestOfFiles.push(best)
	}

	const snippets: Snippet[] = []
	let chars = 0
	for (const s of bestOfFiles.sort((a, b) => b.score - a.score)) {
		if (snippets.length >= maxSnippets || chars + s.snippet.length > maxChars) break
		snippets.push(s)
		chars += s.snippet.length
	}
	return snippets
}

// the snippets as line comments of the file's language, to put before the prefix
export const snippetsAsComments = (snippets: Snippet[], lineComment: string, newline: string) => {
	if (snippets.length === 0) return ''
	return snippets.map(s => [
		`${lineComment} Path: ${s.path}`,
		...s.snippet.split('\n').map(line => `${lineComment} ${line}`),
	].join(newline)).join(newline + newline) + newline + newline
}
