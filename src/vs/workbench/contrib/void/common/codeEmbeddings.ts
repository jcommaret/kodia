/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 7: meaning-based retrieval for the code index, without I/O. Chunks (common/codeIndex.ts) are embedded by an
 * embedding model; vectors are keyed by a hash of exactly the text that was embedded, so an unchanged chunk is never
 * embedded again (across edits elsewhere, restarts, and re-indexing), and a changed one gets a new vector.
 */

import { StringSHA1 } from '../../../../base/common/hash.js';

/** An embedding model (any OpenAI-style /embeddings endpoint). `kind` lets asymmetric models embed queries differently. */
export interface ICodeEmbedder {
	/** identifies the vector space: vectors from different models or sizes are never mixed */
	readonly id: string;
	embed(texts: string[], kind: 'query' | 'passage'): Promise<{ vectors: Float32Array[]; tokens?: number } | { error: string }>;
}

/** What is embedded for a chunk: where it is and what it is, then its code (capped). */
export function embeddingText(relativePath: string, kind: string, name: string, code: string, maxChars = 2000): string {
	return `${relativePath.replace(/\\/g, '/')} — ${kind} ${name}\n${code}`.slice(0, maxChars);
}

export function contentKey(text: string): string {
	const h = new StringSHA1();
	h.update(text);
	return h.digest();
}

function normalize(v: Float32Array): Float32Array {
	let n = 0;
	for (let i = 0; i < v.length; i++) { n += v[i] * v[i]; }
	n = Math.sqrt(n) || 1;
	const out = new Float32Array(v.length);
	for (let i = 0; i < v.length; i++) { out[i] = v[i] / n; }
	return out;
}

export const MAX_STORED_VECTORS = 200_000;

/** Unit vectors by content key, for one embedding model. Serializes to a compact binary form. */
export class EmbeddingStore {
	private readonly vectors = new Map<string, Float32Array>();
	constructor(readonly modelId: string, private dims = 0) { }

	get size(): number { return this.vectors.size; }
	get dimensions(): number { return this.dims; }
	has(key: string): boolean { return this.vectors.has(key); }
	get(key: string): Float32Array | undefined { return this.vectors.get(key); }

	set(key: string, vector: Float32Array): void {
		if (this.dims === 0) { this.dims = vector.length; }
		if (vector.length !== this.dims) { throw new Error(`embedding size changed from ${this.dims} to ${vector.length}`); }
		this.vectors.delete(key); // re-inserted last: the map's order is the recency order used when trimming
		this.vectors.set(key, normalize(vector));
		if (this.vectors.size > MAX_STORED_VECTORS) { this.vectors.delete(this.vectors.keys().next().value!); }
	}

	/** keep only these keys (the chunks that exist now) */
	retain(keys: Set<string>): number {
		let removed = 0;
		for (const k of [...this.vectors.keys()]) { if (!keys.has(k)) { this.vectors.delete(k); removed++; } }
		return removed;
	}

	/** cosine similarity of the query to each candidate that has a vector; best first */
	nearest<T>(query: Float32Array, candidates: { key: string; item: T }[], k: number): { item: T; score: number }[] {
		const q = normalize(query);
		const scored: { item: T; score: number }[] = [];
		for (const c of candidates) {
			const v = this.vectors.get(c.key);
			if (!v || v.length !== q.length) { continue; }
			let dot = 0;
			for (let i = 0; i < v.length; i++) { dot += v[i] * q[i]; }
			scored.push({ item: c.item, score: dot });
		}
		return scored.sort((a, b) => b.score - a.score).slice(0, k);
	}

	/** [u32 header length][header JSON: model, dims, keys][float32 vectors, in key order] */
	serialize(): Uint8Array {
		const keys = [...this.vectors.keys()];
		const header = new TextEncoder().encode(JSON.stringify({ v: 1, model: this.modelId, dims: this.dims, keys }));
		const out = new Uint8Array(4 + header.length + keys.length * this.dims * 4);
		new DataView(out.buffer).setUint32(0, header.length, true);
		out.set(header, 4);
		let offset = 4 + header.length; // DataView: the floats need not be 4-byte aligned

		const view = new DataView(out.buffer);
		for (const k of keys) {
			const v = this.vectors.get(k)!;
			for (let i = 0; i < v.length; i++) { view.setFloat32(offset, v[i], true); offset += 4; }
		}
		return out;
	}

	/** undefined when the data is not a store of this model (another model, damaged, other format) */
	static deserialize(data: Uint8Array, modelId: string): EmbeddingStore | undefined {
		try {
			const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
			const headerLength = view.getUint32(0, true);
			const header = JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + headerLength))) as { v: number; model: string; dims: number; keys: string[] };
			if (header.v !== 1 || header.model !== modelId || !Array.isArray(header.keys)) { return undefined; }
			if (data.byteLength !== 4 + headerLength + header.keys.length * header.dims * 4) { return undefined; }
			const store = new EmbeddingStore(modelId, header.dims);
			let offset = 4 + headerLength;
			for (const k of header.keys) {
				const v = new Float32Array(header.dims);
				for (let i = 0; i < header.dims; i++) { v[i] = view.getFloat32(offset, true); offset += 4; }
				store.vectors.set(k, v); // stored normalized already
			}
			return store;
		} catch {
			return undefined;
		}
	}
}

/**
 * Reciprocal-rank fusion of several rankings (lists of ids, best first), each with a weight. An id missing from a
 * ranking gets nothing from it. Ties keep the order of the first ranking. Returns ids, best first.
 */
export function fuseRankings<T>(rankings: { ids: T[]; weight: number }[], k = 60): T[] {
	const score = new Map<T, number>();
	const firstSeen = new Map<T, number>();
	let seen = 0;
	for (const { ids, weight } of rankings) {
		ids.forEach((id, rank) => {
			score.set(id, (score.get(id) ?? 0) + weight / (k + rank));
			if (!firstSeen.has(id)) { firstSeen.set(id, seen++); }
		});
	}
	return [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)! || firstSeen.get(a)! - firstSeen.get(b)!);
}
