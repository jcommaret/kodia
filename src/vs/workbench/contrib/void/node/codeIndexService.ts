/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * The codebase index service. The app hosts it in the Electron main process (electron-main/codeIndexMainService.ts,
 * channel 'void-channel-code-index'). The renderer passes its workspace folders with each call; the index itself
 * is node/codeIndexWorkspace.ts over common/codeIndex.ts (words) and node/codeSemanticIndex.ts (meaning).
 * The word index is kept in memory and rebuilt on first use after a restart; the vectors are cached on disk.
 */

import { fuseRankings, ICodeEmbedder } from '../common/codeEmbeddings.js';
import { CodeSearchRanking, CodeSearchResponse, fuseWithReranker, ICodeIndexService, ICodeReranker, IndexStats, LiteralSearchResponse, SearchHit } from '../common/codeIndexServiceTypes.js';
import { CodeSemanticIndex } from './codeSemanticIndex.js';
import { WorkspaceCodeIndex } from './codeIndexWorkspace.js';

// how many of the best word matches a reranker re-orders (one request)
const RERANK_CANDIDATES = 30;
// candidates each side contributes to the fusion of words and meaning
const FUSION_CANDIDATES = 50;
/** how long a search waits for embedding to catch up before using what is embedded so far */
export const SEARCH_EMBED_WAIT_MS = 20_000;

const MAX_LIMIT = 50;
const clampLimit = (limit: number | undefined, fallback: number) => Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(limit) ? Math.floor(limit!) : fallback));

export type SemanticOptions = { embedder: ICodeEmbedder; cacheDir?: string; waitMs?: number };

export class KodiaCodeIndexService implements ICodeIndexService {
	readonly _serviceBrand: undefined;

	private readonly workspace: WorkspaceCodeIndex;
	private readonly semantic: CodeSemanticIndex | undefined;
	private readonly embedWaitMs: number;
	constructor(listTtlMs?: number, private readonly reranker?: ICodeReranker, semantic?: SemanticOptions) {
		this.workspace = new WorkspaceCodeIndex(listTtlMs);
		this.semantic = semantic ? new CodeSemanticIndex(this.workspace, semantic.embedder, semantic.cacheDir) : undefined;
		this.embedWaitMs = semantic?.waitMs ?? SEARCH_EMBED_WAIT_MS;
	}

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
		this.semantic?.clear();
	}

	async getStats(): Promise<IndexStats> {
		return this.workspace.getStats();
	}

	/** embed everything not embedded yet (bounded), and wait for it: e.g. before an evaluation */
	async embedAll(folders: string[], waitMs = 30 * 60_000) {
		if (!this.semantic) { throw new Error('no embedding model is configured'); }
		this.workspace.refresh(folders);
		await this.semantic.ensure(waitMs);
		return this.semantic.coverage();
	}

	async search(folders: string[], query: string, limit?: number, opts?: { rerank?: boolean; semantic?: boolean }): Promise<CodeSearchResponse> {
		if (!folders?.length) { throw new Error('No workspace folder is open, so there is nothing to search.'); }
		const n = clampLimit(limit, 10);
		const wantsMore = (opts?.rerank && this.reranker) || (opts?.semantic && this.semantic);
		const words = this.workspace.search(folders, query, wantsMore ? Math.max(n, FUSION_CANDIDATES) : n);
		let hits: SearchHit[] = words.hits;
		const notes: string[] = [];
		let byMeaning = false;
		let semanticCoverage: CodeSearchRanking['semantic'];

		if (opts?.semantic) {
			if (!this.semantic) { notes.push('no embedding model is available'); }
			else {
				await this.semantic.ensure(this.embedWaitMs);
				const near = await this.semantic.nearest(query, FUSION_CANDIDATES);
				const cov = this.semantic.coverage();
				if ('error' in near) { notes.push(`meaning search unavailable: ${near.error}`); }
				else if (cov.embedded === 0) { notes.push(`meaning search unavailable: nothing is embedded yet${cov.lastError ? ` (${cov.lastError})` : cov.running ? ' (embedding runs in the background; later searches will use it)' : ''}`); }
				else {
					byMeaning = true;
					semanticCoverage = { model: cov.model, embedded: cov.embedded, total: cov.total };
					if (cov.embedded < cov.total) {
						const pending = cov.total - cov.embedded - cov.refused;
						notes.push(`meaning search covered ${cov.embedded} of ${cov.total} code chunks${cov.refused ? ` (${cov.refused} refused by the embedding provider's content screening: found by words only)` : ''}${pending > 0 ? (cov.capped ? '; the embedding limit for one workspace was reached' : cov.running ? '; embedding continues in the background' : '') : ''}${cov.lastError ? `; embedding stopped: ${cov.lastError}` : ''}`);
					}
					const id = (h: { filePath: string; startLine: number }) => `${h.filePath}\n${h.startLine}`;
					const byId = new Map<string, SearchHit>(hits.map(h => [id(h), h]));
					for (const s of near.hits) {
						if (!byId.has(id(s.chunk))) { byId.set(id(s.chunk), { ...this.workspace.index.hitFor(s.chunk, s.score), relativePath: this.workspace.displayPath(s.chunk.filePath) }); }
					}
					const order = fuseRankings([{ ids: hits.map(id), weight: 1 }, { ids: near.hits.map(s => id(s.chunk)), weight: 1 }]);
					// one hit per region, as for words alone
					hits = [];
					for (const key of order) {
						const h = byId.get(key)!;
						if (hits.some(x => x.filePath === h.filePath && x.startLine <= h.endLine && h.startLine <= x.endLine)) { continue; }
						hits.push(h);
					}
				}
			}
		}

		const by = (reranked: boolean): CodeSearchRanking['by'] => `words${byMeaning ? '+meaning' : ''}${reranked ? '+reranker' : ''}` as CodeSearchRanking['by'];
		const done = (h: SearchHit[], reranked: boolean): CodeSearchResponse => ({
			...words, hits: h.slice(0, n),
			ranking: { by: by(reranked), note: notes.length ? notes.join('; ') : undefined, ...(semanticCoverage ? { semantic: semanticCoverage } : {}) },
		});

		if (!opts?.rerank) { return done(hits, false); }
		if (!this.reranker) { notes.push('no reranker is available'); return done(hits, false); }
		// the best candidates, re-ordered by a reranking model; any failure keeps the order and says why
		const candidates = hits.slice(0, Math.max(n, RERANK_CANDIDATES));
		if (candidates.length <= 1) { return done(hits, false); }
		const texts = candidates.map(h => `${h.relativePath} — ${h.kind} ${h.name}\n${this.workspace.index.chunkText(h)}`);
		const ranked = await this.reranker.rerankTexts(query, texts);
		if ('error' in ranked) { notes.push(`re-ranking unavailable: ${ranked.error}`); return done(hits, false); }
		const unscored = ranked.scores.filter(s => s === null).length;
		if (unscored) { notes.push(`${unscored} of ${texts.length} candidates could not be scored by the reranker and kept their word rank`); }
		return done(fuseWithReranker(ranked.scores).map(i => candidates[i]), true);
	}

	async findLiteral(folders: string[], text: string, limit?: number): Promise<LiteralSearchResponse> {
		if (!folders?.length) { throw new Error('No workspace folder is open, so there is nothing to search.'); }
		return this.workspace.findLiteral(folders, text, clampLimit(limit, 30));
	}
}
