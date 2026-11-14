/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The ranking behind the `search_codebase` tool of Kodia's chat and of the Kodia agent: from a question or a few
// keywords, the passages of the project that say the most about it. It ranks by the words of the query (BM25 over
// passages of a file), with no index and no embedding model, so it works at once on any project and with any model.
// Each side finds the files that hold the words (`searchTermsOf`) its own way, then gives them here to be ranked.

/** A file to rank passages of. */
export type SearchableFile = { readonly path: string, readonly content: string }

/** A passage of a file: its lines (1-based, inclusive) and their text. */
export type RankedPassage = { readonly path: string, readonly startLine: number, readonly endLine: number, readonly text: string, readonly score: number }

/** How many files a side reads to rank: the ones with the most lines holding a word of the query. */
export const MAX_SEARCH_CANDIDATE_FILES = 40
/** A file larger than this is not read: generated code, data. */
export const MAX_SEARCH_FILE_CHARS = 400_000

const MAX_PASSAGES = 6
const MAX_PASSAGES_PER_FILE = 2
const PASSAGE_LINES = 30
const PASSAGE_STEP = 15
const CONTEXT_LINES = 2
const MAX_LINE_CHARS = 300
const MAX_TERMS = 12

// words of a question that say nothing of the code it is about
const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'as', 'and', 'or', 'not', 'is', 'are', 'be', 'was', 'it', 'its', 'this', 'that', 'these', 'those', 'which', 'what', 'where', 'when', 'who', 'how', 'why', 'do', 'does', 'did', 'done', 'can', 'could', 'should', 'would', 'will', 'i', 'we', 'you', 'me', 'my', 'our', 'find', 'show', 'get', 'gets', 'use', 'used', 'uses', 'using', 'code', 'there', 'here', 'into', 'about', 'all', 'any', 'some', 'has', 'have', 'had', 'if', 'then', 'so', 'than', 'each', 'every'])

// "retries" and "retrying" are found by "retr" and "retry": a word is searched by its stem, as a substring
const stemOf = (word: string): string => {
	if (word.length > 5 && word.endsWith('ies')) return word.slice(0, -3)
	if (word.length > 6 && word.endsWith('ing')) return word.slice(0, -3)
	if (word.length > 5 && word.endsWith('ed')) return word.slice(0, -2)
	if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2)
	if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
	return word
}

/**
 * The words to look for, lowercased: the words of the query without the ones every question has, an identifier both
 * whole (`retrypolicy`) and by its parts (`retry`, `policy`). Empty when the query has no word to search by.
 */
export const searchTermsOf = (query: string): string[] => {
	const terms: string[] = []
	const add = (term: string) => { if (term.length >= 2 && !terms.includes(term)) terms.push(term) }
	for (const word of query.split(/[^A-Za-z0-9_$]+/).filter(Boolean)) {
		const parts = word.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[\s_$]+/).filter(Boolean).map(part => part.toLowerCase())
		const meaningful = parts.filter(part => !STOP_WORDS.has(part))
		// an identifier of several words is also searched whole: it is the best match there is
		if (parts.length > 1) add(parts.join(''))
		for (const part of meaningful) add(stemOf(part))
	}
	return terms.slice(0, MAX_TERMS)
}

const countOf = (text: string, term: string): number => {
	let count = 0
	for (let idx = text.indexOf(term); idx !== -1; idx = text.indexOf(term, idx + term.length)) count++
	return count
}

/**
 * The passages of `files` that say the most about `query`, best first. A passage is the lines around the words found,
 * at most {@link PASSAGE_LINES}; a file gives two at most, so the answer shows several places of the project.
 */
export const rankPassages = (files: readonly SearchableFile[], query: string): RankedPassage[] => {
	const terms = searchTermsOf(query)
	if (terms.length === 0) return []

	type Window = { file: SearchableFile, lines: string[], start: number, end: number, counts: number[] }
	const windows: Window[] = []
	for (const file of files) {
		if (file.content.length > MAX_SEARCH_FILE_CHARS) continue
		const lines = file.content.split('\n')
		const lowerLines = lines.map(line => line.toLowerCase())
		for (let start = 0; start < lines.length; start += PASSAGE_STEP) {
			const end = Math.min(lines.length, start + PASSAGE_LINES)
			const text = lowerLines.slice(start, end).join('\n')
			const counts = terms.map(term => countOf(text, term))
			if (counts.some(count => count > 0)) windows.push({ file, lines, start, end, counts })
			if (end === lines.length) break
		}
	}
	if (windows.length === 0) return []

	// a word that few passages have tells more than one that is everywhere
	const idf = terms.map((_, t) => {
		const withTerm = windows.filter(window => window.counts[t] > 0).length
		return Math.log(1 + (windows.length - withTerm + 0.5) / (withTerm + 0.5))
	})
	const scored = windows.map(window => {
		const lowerPath = window.file.path.toLowerCase()
		let score = 0
		let matched = 0
		terms.forEach((term, t) => {
			const count = window.counts[t]
			if (count > 0) {
				matched++
				score += idf[t] * (count * 2.2) / (count + 1.2)
			}
			// the file is named after the word: most likely the place
			if (lowerPath.includes(term)) score += idf[t] * 0.5
		})
		// a passage with all the words of the query beats one that repeats a single word
		const coverage = matched / terms.length
		return { window, score: score * (0.5 + coverage) }
	}).sort((a, b) => b.score - a.score || a.window.file.path.localeCompare(b.window.file.path) || a.window.start - b.window.start)

	const passages: RankedPassage[] = []
	const taken: { path: string, start: number, end: number }[] = []
	for (const { window, score } of scored) {
		if (passages.length >= MAX_PASSAGES) break
		const { file, lines } = window
		const inFile = taken.filter(t => t.path === file.path)
		if (inFile.length >= MAX_PASSAGES_PER_FILE) continue
		// the lines from the first word found to the last, with a little around them
		let first = window.end, last = window.start - 1
		for (let i = window.start; i < window.end; i++) {
			const line = lines[i].toLowerCase()
			if (terms.some(term => line.includes(term))) {
				first = Math.min(first, i)
				last = Math.max(last, i)
			}
		}
		const start = Math.max(0, first - CONTEXT_LINES)
		const end = Math.min(lines.length, last + 1 + CONTEXT_LINES)
		if (inFile.some(t => start < t.end && t.start < end)) continue
		taken.push({ path: file.path, start, end })
		const text = lines.slice(start, end).map(line => { const l = line.replace(/\r$/, ''); return l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l }).join('\n')
		passages.push({ path: file.path, startLine: start + 1, endLine: end, text, score })
	}
	return passages
}

/** What the model is told of a search: each passage with its file and lines, or how to search otherwise. */
export const describePassages = (passages: readonly Omit<RankedPassage, 'score'>[], query: string): string => {
	if (searchTermsOf(query).length === 0) return 'The query has no word to search by. Give the names or the words the code would use.'
	if (passages.length === 0) return `Nothing in the project matches "${query}". Try other words (the ones the code would use), or search_for_files with an exact string.`
	return passages.map(passage => `${passage.path} (lines ${passage.startLine}-${passage.endLine})\n\`\`\`\n${passage.text}\n\`\`\``).join('\n\n')
		+ '\n\nThese are the passages that match the query best, not every match: read a file with read_file for the rest of it.'
}
