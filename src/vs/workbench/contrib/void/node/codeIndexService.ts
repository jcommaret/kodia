/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * The codebase index service. The app hosts it in the Electron main process (electron-main/codeIndexMainService.ts,
 * channel 'void-channel-code-index'). The renderer passes its workspace folders with each call; the index itself
 * is node/codeIndexWorkspace.ts over common/codeIndex.ts. Kept in memory: rebuilt on first use after a restart.
 */

import { CodeSearchResponse, fuseWithReranker, ICodeIndexService, ICodeReranker, IndexStats, LiteralSearchResponse } from '../common/codeIndexServiceTypes.js';

// how many of the best word matches a reranker re-orders (one request)
const RERANK_CANDIDATES = 30;
import { WorkspaceCodeIndex } from './codeIndexWorkspace.js';

const MAX_LIMIT = 50;
const clampLimit = (limit: number | undefined, fallback: number) => Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(limit) ? Math.floor(limit!) : fallback));

export class KodiaCodeIndexService implements ICodeIndexService {
	readonly _serviceBrand: undefined;

	private readonly workspace: WorkspaceCodeIndex;
	constructor(listTtlMs?: number, private readonly reranker?: ICodeReranker) { this.workspace = new WorkspaceCodeIndex(listTtlMs); }

	async indexWorkspace(folders: string[]): Promise<IndexStats> {
		if (!folders?.length) { throw new Error('No workspace folder is open, so there is nothing to index.'); }
		return this.workspace.indexFolders(folders);
	}

	async indexFile(filePath: string): Promise<boolean> {
		return this.workspace.indexOne(filePath);
	}

	async removeFile(filePath: string): Promise<void> {
		this.workspace.forget(filePath);
	}

	async clearIndex(): Promise<void> {
		this.workspace.clear();
	}

	async getStats(): Promise<IndexStats> {
		return this.workspace.getStats();
	}

	async search(folders: string[], query: string, limit?: number, opts?: { rerank?: boolean }): Promise<CodeSearchResponse> {
		if (!folders?.length) { throw new Error('No workspace folder is open, so there is nothing to search.'); }
		const n = clampLimit(limit, 10);
		if (!opts?.rerank || !this.reranker) {
			return { ...this.workspace.search(folders, query, n), ranking: { by: 'words', note: opts?.rerank ? 'no reranker is available' : undefined } };
		}
		// the best word matches, re-ordered by meaning; any failure keeps the word order and says why
		const r = this.workspace.search(folders, query, Math.max(n, RERANK_CANDIDATES));
		if (r.hits.length <= 1) { return { ...r, hits: r.hits.slice(0, n), ranking: { by: 'words' } }; }
		const texts = r.hits.map(h => `${h.relativePath} — ${h.kind} ${h.name}\n${this.workspace.index.chunkText(h)}`);
		const ranked = await this.reranker.rerankTexts(query, texts);
		if ('error' in ranked) { return { ...r, hits: r.hits.slice(0, n), ranking: { by: 'words', note: `re-ranking unavailable: ${ranked.error}` } }; }
		const unscored = ranked.scores.filter(s => s === null).length;
		return {
			...r, hits: fuseWithReranker(ranked.scores).map(i => r.hits[i]).slice(0, n),
			ranking: { by: 'words+reranker', note: unscored ? `${unscored} of ${texts.length} candidates could not be scored by the reranker and kept their word rank` : undefined },
		};
	}

	async findLiteral(folders: string[], text: string, limit?: number): Promise<LiteralSearchResponse> {
		if (!folders?.length) { throw new Error('No workspace folder is open, so there is nothing to search.'); }
		return this.workspace.findLiteral(folders, text, clampLimit(limit, 30));
	}
}
