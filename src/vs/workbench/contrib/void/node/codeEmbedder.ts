/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * An embedding model behind any OpenAI-style `/embeddings` endpoint (bring your own model). NVIDIA's API is one such
 * endpoint; asymmetric models there take `input_type` ("query" / "passage"). Batches, retries rate limits (Retry-After),
 * and reports failures as errors (never as vectors). The API key is read by the caller (main process), per request.
 */

import { ICodeEmbedder } from '../common/codeEmbeddings.js';

export type EmbedderOptions = {
	endpoint: string;
	model: string;
	/** a shorter vector, for models that support it (Matryoshka) */
	dimensions?: number;
	/** NVIDIA's asymmetric retrieval models: send input_type and truncate */
	nvidiaInputType?: boolean;
	getApiKey: () => Promise<string | undefined>;
	batchSize?: number;
	timeoutMs?: number;
	maxRetries?: number;
	fetchImpl?: typeof fetch;
};

/**
 * measured: nemotron-3.5-embed-1b answers 128 inputs of ~275 tokens in 5-10 s and honors `dimensions` (512 tested);
 * 1024 (half its native 2048) is the default: 4 KB per chunk. Embedding Kodia's own AI source (4365 chunks) took ~5 min.
 */
export const NVIDIA_EMBEDDINGS = { endpoint: 'https://integrate.api.nvidia.com/v1/embeddings', model: 'nvidia/nemotron-3.5-embed-1b', dimensions: 1024 } as const;

export class OpenAICompatibleEmbedder implements ICodeEmbedder {
	readonly id: string;
	constructor(private readonly o: EmbedderOptions) { this.id = `${o.model}@${o.dimensions ?? 'native'}`; }

	async embed(texts: string[], kind: 'query' | 'passage'): Promise<{ vectors: Float32Array[]; tokens?: number } | { error: string }> {
		const key = await this.o.getApiKey();
		if (!key) { return { error: `no API key is configured for the embedding model ${this.o.model}` }; }
		const batch = Math.max(1, this.o.batchSize ?? 64);
		const vectors: Float32Array[] = [];
		let tokens = 0;
		for (let i = 0; i < texts.length; i += batch) {
			const r = await this.post(key, texts.slice(i, i + batch), kind);
			if ('error' in r) { return r; }
			vectors.push(...r.vectors);
			tokens += r.tokens;
		}
		return { vectors, tokens };
	}

	private async post(key: string, input: string[], kind: 'query' | 'passage'): Promise<{ vectors: Float32Array[]; tokens: number } | { error: string }> {
		const body = JSON.stringify({
			model: this.o.model, input, encoding_format: 'float',
			...(this.o.dimensions ? { dimensions: this.o.dimensions } : {}),
			...(this.o.nvidiaInputType ? { input_type: kind, truncate: 'END' } : {}),
		});
		const doFetch = this.o.fetchImpl ?? fetch;
		for (let attempt = 0; ; attempt++) {
			let response: Response;
			try {
				response = await doFetch(this.o.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body, signal: AbortSignal.timeout(this.o.timeoutMs ?? 60_000) });
			} catch (e) {
				const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
				return { error: timedOut ? `the embedding model ${this.o.model} timed out` : `the embedding request failed: ${e instanceof Error ? e.message : String(e)}` };
			}
			if ((response.status === 429 || response.status >= 500) && attempt < (this.o.maxRetries ?? 3)) {
				const after = Number(response.headers.get('retry-after'));
				await new Promise(r => setTimeout(r, Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 1000 * 2 ** attempt));
				continue;
			}
			if (!response.ok) {
				const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
				return { error: `the embedding model ${this.o.model} answered HTTP ${response.status}${detail ? `: ${detail}` : ''}` };
			}
			let json: { data?: { index?: number; embedding?: number[] }[]; usage?: { total_tokens?: number } };
			try { json = await response.json(); } catch { return { error: 'the embedding response was not JSON' }; }
			const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
			if (data.length !== input.length || data.some(d => !Array.isArray(d.embedding) || d.embedding.length === 0)) {
				return { error: `the embedding model returned ${data.length} vectors for ${input.length} inputs` };
			}
			return { vectors: data.map(d => Float32Array.from(d.embedding!)), tokens: json.usage?.total_tokens ?? 0 };
		}
	}
}
