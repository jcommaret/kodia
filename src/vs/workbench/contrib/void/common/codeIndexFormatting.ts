/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CodeSearchResponse, IndexRefresh, IndexStats, LiteralSearchResponse } from './codeIndexServiceTypes.js';

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function formatIndexStats(s: IndexStats): string {
	if (!s.lastIndexed) { return 'The code index is empty (it is built on the first search).'; }
	const skipped = Object.entries(s.skipped).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k === 'tooLarge' ? 'too large' : k === 'overLimit' ? 'over the index limit' : k}`);
	return `Code index: ${plural(s.totalFiles, 'file')}, ${plural(s.totalChunks, 'chunk')} from ${s.folders.join(', ')} (files listed with ${s.listedWith === 'git' ? 'git, so .gitignore applies' : s.listedWith}; built in ${s.durationMs} ms)${skipped.length ? `; skipped: ${skipped.join(', ')}` : ''}.`;
}

function freshness(r: IndexRefresh): string {
	if (r.initial) { return ` (The workspace was indexed for this search: ${plural(r.added, 'file')}.)`; }
	const parts = [r.changed ? `${r.changed} changed` : '', r.added ? `${r.added} new` : '', r.removed ? `${r.removed} removed` : ''].filter(Boolean);
	return parts.length ? ` Updated first: ${parts.join(', ')} file(s).` : '';
}

/** Hits as path:line ranges with the symbol and the lines that matched, ready to pass to read_file. */
export function formatCodeSearch(r: CodeSearchResponse & { query: string }): string {
	const by = r.ranking?.by ?? 'words';
	const meaning = by.includes('meaning');
	const how = [
		meaning ? `word matches fused with meaning matches from the embedding model ${r.ranking?.semantic?.model ?? ''}`.trim() : 'word-based relevance: identifiers are split into words; not an embedding/meaning search',
		by.includes('reranker') ? 'then re-ordered by NVIDIA\'s reranking model' : '',
		r.ranking?.note ?? '',
	].filter(Boolean).join('; ');
	const header = `Ranked code search for "${r.query}" over ${plural(r.stats.totalFiles, 'file')} (${how}).${freshness(r.refreshed)}`;
	if (r.hits.length === 0) { return `${header}\nNo matches. Try other words for the same thing, or code_keyword_search for an exact string.`; }
	const lines = [header];
	r.hits.forEach((h, i) => {
		const why = meaning && h.matchedTerms.length === 0 ? '  (found by meaning: shares no words with the query)' : `  (score ${h.score.toFixed(2)})`;
		lines.push(`\n${i + 1}. ${h.relativePath}:${h.startLine}-${h.endLine} [${h.kind}] ${h.name}${why}`);
		for (const s of h.snippet) { lines.push(`   ${s.line}: ${s.text}`); }
	});
	return lines.join('\n');
}

export function formatLiteralSearch(r: LiteralSearchResponse & { query: string }): string {
	const header = `Exact (case-insensitive) occurrences of "${r.query}" in ${plural(r.stats.totalFiles, 'indexed file')}.${freshness(r.refreshed)}`;
	if (r.matches.length === 0) { return `${header}\nNo occurrences.`; }
	return [header, ...r.matches.map(m => `${m.relativePath}:${m.line}: ${m.text}`)].join('\n');
}
