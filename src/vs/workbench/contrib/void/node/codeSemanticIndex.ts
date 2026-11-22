/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 7: the meaning side of the code index. Every chunk of the lexical index (node/codeIndexWorkspace.ts) gets a
 * vector from an embedding model, keyed by a hash of the embedded text: only new or changed code is ever sent again.
 * Embedding runs as one background job; a search waits for it up to a budget, then uses what is embedded so far and
 * says how much that is. Vectors are cached on disk per model, so a restart re-embeds nothing that is unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';
import { contentKey, embeddingText, EmbeddingStore, ICodeEmbedder } from '../common/codeEmbeddings.js';
import { IndexedChunk } from '../common/codeIndex.js';
import { WorkspaceCodeIndex } from './codeIndexWorkspace.js';

/** at most this many chunks are embedded per workspace (symbols first); the rest is found by words only */
export const MAX_EMBEDDED_CHUNKS = 30_000;
const BATCH = 64;
const SAVE_EVERY_BATCHES = 8;
/** after a failure (no key, HTTP 401, ...) the job is not retried for this long, so searches do not hammer the API */
const ERROR_BACKOFF_MS = 60_000;

type Entry = { chunk: IndexedChunk; key: string; text: string };
export type SemanticCoverage = { model: string; embedded: number; /** refused by the provider (content screening) */ refused: number; total: number; capped: boolean; running: boolean; tokensUsed: number; lastError?: string };

export class CodeSemanticIndex {
	private store: EmbeddingStore | undefined;
	private readonly entriesOfFile = new Map<string, { sig: string; entries: Entry[] }>();
	private job: Promise<void> | undefined;
	private lastError: { message: string; at: number } | undefined;
	private tokensUsed = 0;
	/** chunks the provider refused to embed (content key → reason); found by words only */
	private readonly rejected = new Map<string, string>();

	constructor(private readonly workspace: WorkspaceCodeIndex, readonly embedder: ICodeEmbedder, private readonly cacheDir?: string) { }

	private cacheFile(): string | undefined {
		return this.cacheDir ? path.join(this.cacheDir, `${this.embedder.id.replace(/[^\w.@-]+/g, '_')}.bin`) : undefined;
	}

	private getStore(): EmbeddingStore {
		if (!this.store) {
			const file = this.cacheFile();
			let loaded: EmbeddingStore | undefined;
			if (file && fs.existsSync(file)) { try { loaded = EmbeddingStore.deserialize(fs.readFileSync(file), this.embedder.id); } catch { loaded = undefined; } }
			this.store = loaded ?? new EmbeddingStore(this.embedder.id);
		}
		return this.store;
	}

	private save(): void {
		const file = this.cacheFile();
		if (!file || !this.store) { return; }
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(`${file}.tmp`, this.store.serialize());
			fs.renameSync(`${file}.tmp`, file); // never a half-written cache
		} catch { /* the cache is an optimization: a failed save costs a re-embed later, nothing else */ }
	}

	/** the chunks indexed now, with the key of the text that represents each (cached per file version) */
	entries(): Entry[] {
		const index = this.workspace.index;
		const files = new Set(index.files());
		for (const f of [...this.entriesOfFile.keys()]) { if (!files.has(f)) { this.entriesOfFile.delete(f); } }
		const out: Entry[] = [];
		for (const f of files) {
			const sig = this.workspace.signature(f) ?? '';
			let cached = this.entriesOfFile.get(f);
			if (!cached || cached.sig !== sig) {
				const rel = this.workspace.displayPath(f);
				cached = {
					sig, entries: index.chunksOf(f).map(chunk => {
						const text = embeddingText(rel, chunk.kind, chunk.name, index.chunkText(chunk));
						return { chunk, key: contentKey(text), text };
					}),
				};
				this.entriesOfFile.set(f, cached);
			}
			out.push(...cached.entries);
		}
		return out;
	}

	coverage(entries = this.entries()): SemanticCoverage {
		const store = this.getStore();
		const embedded = entries.filter(e => store.has(e.key)).length;
		const refused = entries.filter(e => this.rejected.has(e.key)).length;
		return {
			model: this.embedder.id, embedded, refused, total: entries.length, capped: embedded >= MAX_EMBEDDED_CHUNKS && embedded + refused < entries.length,
			running: !!this.job, tokensUsed: this.tokensUsed, lastError: this.lastError?.message,
		};
	}

	/** start (or join) the embedding job; resolves when it ends or after `waitMs`, whichever is first */
	async ensure(waitMs: number): Promise<void> {
		if (!this.job && !(this.lastError && Date.now() - this.lastError.at < ERROR_BACKOFF_MS)) {
			this.job = this.run().finally(() => { this.job = undefined; });
		}
		if (!this.job) { return; }
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([this.job, new Promise<void>(r => { timer = setTimeout(r, waitMs); })]);
		clearTimeout(timer);
	}

	private async run(): Promise<void> {
		const store = this.getStore();
		const entries = this.entries();
		const already = entries.filter(e => store.has(e.key)).length;
		const seen = new Set<string>();
		const missing = entries.filter(e => !store.has(e.key) && !this.rejected.has(e.key) && !seen.has(e.key) && seen.add(e.key))
			.sort((a, b) => Number(a.chunk.kind === 'block') - Number(b.chunk.kind === 'block')) // definitions first
			.slice(0, Math.max(0, MAX_EMBEDDED_CHUNKS - already));
		this.lastError = undefined;
		let batches = 0;
		// a batch the provider refuses because of some of its texts (NVIDIA: HTTP 422 content screening) is split until
		// the refused texts are isolated; those are skipped (and remembered), the rest is embedded. Measured: one
		// screened chunk of Kodia's own source stopped all embedding before this.
		const embedPart = async (part: Entry[]): Promise<string | undefined> => {
			if (part.length === 0) { return undefined; }
			const r = await this.embedder.embed(part.map(e => e.text), 'passage');
			if (!('error' in r)) {
				part.forEach((e, j) => store.set(e.key, r.vectors[j]));
				this.tokensUsed += r.tokens ?? 0;
				return undefined;
			}
			if (!/HTTP (400|413|422)\b/.test(r.error)) { return r.error; } // key, quota, network: stop the job
			if (part.length === 1) { this.rejected.set(part[0].key, r.error); return undefined; }
			const half = Math.ceil(part.length / 2);
			return await embedPart(part.slice(0, half)) ?? await embedPart(part.slice(half));
		};
		for (let i = 0; i < missing.length; i += BATCH) {
			const error = await embedPart(missing.slice(i, i + BATCH).filter(e => !this.rejected.has(e.key)));
			if (error) { this.lastError = { message: error, at: Date.now() }; break; }
			if (++batches % SAVE_EVERY_BATCHES === 0) { this.save(); }
		}
		// not pruned to this workspace: the cache is per model and shared by projects; the store caps itself, oldest first
		if (batches > 0) { this.save(); }
	}

	/** the chunks closest in meaning to the query, among those embedded */
	async nearest(query: string, k: number): Promise<{ hits: { chunk: IndexedChunk; score: number }[] } | { error: string }> {
		const q = await this.embedder.embed([query], 'query');
		if ('error' in q) { return q; }
		const entries = this.entries();
		return { hits: this.getStore().nearest(q.vectors[0], entries.map(e => ({ key: e.key, item: e.chunk })), k).map(h => ({ chunk: h.item, score: h.score })) };
	}

	clear(): void { this.entriesOfFile.clear(); }
}
