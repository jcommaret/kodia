/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { CodeSearchHit } from './codeIndex.js';

export const ICodeIndexService = createDecorator<ICodeIndexService>('CodeIndexService');

export type IndexSkips = { tooLarge: number; binary: number; overLimit: number; unreadable: number };

export type IndexStats = {
	folders: string[];
	totalFiles: number;
	totalChunks: number;
	lastIndexed: number | null;
	durationMs: number;
	listedWith: 'git' | 'walk' | 'mixed' | 'none';
	skipped: IndexSkips;
};

/** what a search had to update first so its answer matches the disk */
export type IndexRefresh = { added: number; changed: number; removed: number; /** the folders were indexed from scratch first */ initial?: boolean };

export type SearchHit = CodeSearchHit & { relativePath: string };

/** how the hits were ordered; a reranker that could not be used says why */
export type CodeSearchRanking = {
	by: 'words' | 'words+reranker' | 'words+meaning' | 'words+meaning+reranker';
	note?: string;
	/** how much of the code the meaning search could see (embedding runs in the background) */
	semantic?: { model: string; embedded: number; total: number };
};
export type CodeSearchResponse = { hits: SearchHit[]; refreshed: IndexRefresh; stats: IndexStats; ranking?: CodeSearchRanking };

/**
 * A model that scores texts by relevance to a query (main process: NvidiaRerankerMainService). scores[i] is null for a
 * text it could not score (e.g. rejected by the provider's content screening).
 */
export interface ICodeReranker {
	rerankTexts(query: string, texts: string[]): Promise<{ scores: (number | null)[] } | { error: string }>;
}

/**
 * Reciprocal-rank fusion of the word ranking (0..n-1, the input order) and the reranker's scores, the reranker
 * weighted RERANK_WEIGHT times (it is the stronger signal; measured on Kodia's own source, see the record). A text
 * the reranker could not score counts with its word rank on both sides, so it stays where words put it.
 * Returns indices, best first.
 */
export const RERANK_WEIGHT = 2;
export function fuseWithReranker(scores: (number | null)[], k = 60, rerankWeight = RERANK_WEIGHT): number[] {
	const scored = scores.map((s, i) => ({ s, i })).filter(x => x.s !== null).sort((a, b) => b.s! - a.s!);
	const rerankRank = new Map(scored.map((x, r) => [x.i, r]));
	return scores.map((_, i) => ({ i, f: 1 / (k + i) + rerankWeight / (k + (rerankRank.get(i) ?? i)) })).sort((a, b) => b.f - a.f || a.i - b.i).map(x => x.i);
}
export type LiteralSearchResponse = { matches: { filePath: string; relativePath: string; line: number; text: string }[]; refreshed: IndexRefresh; stats: IndexStats };

/**
 * The codebase index (main process, channel 'void-channel-code-index'). `folders` are the workspace folders'
 * file-system paths: the index follows them, indexing on first use and re-checking files before every search.
 */
export interface ICodeIndexService {
	readonly _serviceBrand: undefined;

	indexWorkspace(folders: string[]): Promise<IndexStats>;
	/** re-read one file now (e.g. right after writing it); false when it is not indexable */
	indexFile(filePath: string): Promise<boolean>;
	removeFile(filePath: string): Promise<void>;
	clearIndex(): Promise<void>;
	getStats(): Promise<IndexStats>;

	/**
	 * Relevance-ranked search (lexical BM25 over symbol chunks; see common/codeIndex.ts). With `rerank`, the best word
	 * matches are re-ordered by a reranking model when one is available; with `semantic`, chunks close in meaning (an
	 * embedding model) are fused in, so code described in other words is found too. The caller decides both: they send
	 * code to the provider.
	 */
	search(folders: string[], query: string, limit?: number, opts?: { rerank?: boolean; semantic?: boolean }): Promise<CodeSearchResponse>;
	/** literal, case-insensitive text occurrences with line numbers */
	findLiteral(folders: string[], text: string, limit?: number): Promise<LiteralSearchResponse>;
}
