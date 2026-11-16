/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Code Index & Semantic Search Service.
 *
 * Runs in the Electron main process. Provides:
 *   - File-based code indexing (extract functions, classes, blocks from source)
 *   - TF-IDF + character n-gram embedding generation (no external API needed)
 *   - Cosine similarity for semantic search
 *   - Keyword search (exact match)
 *   - Hybrid search (combine semantic + keyword)
 *
 * All data is stored in-memory for speed. Can be extended to persist to SQLite.
 */

import { ICodeIndexService, CodeChunk, SearchResult, IndexStats } from '../common/codeIndexServiceTypes.js';
import * as fs from 'fs';
import * as path from 'path';
import { URI } from '../../../../base/common/uri.js';

const INDEX_CHUNK_LINES = 50; // lines per block chunk

export class KodiaCodeIndexMainService implements ICodeIndexService {
	readonly _serviceBrand: undefined;

	private chunks: Map<string, CodeChunk[]> = new Map(); // filePath -> chunks
	private allChunks: CodeChunk[] = []; // flat list for searching
	private indexStats: IndexStats = { totalFiles: 0, totalChunks: 0, lastIndexed: null };

	// ---------------------------------------------------------------------------
	// Embedding generation (TF-IDF + char n-gram, no external API)
	// ---------------------------------------------------------------------------

	private readonly ngramSize = 3;
	private documentFrequencies: Map<string, number> = new Map(); // ngram -> doc count
	private totalDocuments = 0;

	private charNgrams(text: string): string[] {
		const normalized = text.toLowerCase().replace(/\s+/g, ' ');
		const ngrams: string[] = [];
		for (let i = 0; i <= normalized.length - this.ngramSize; i++) {
			ngrams.push(normalized.slice(i, i + this.ngramSize));
		}
		return ngrams;
	}

	private termFrequency(text: string): Map<string, number> {
		const ngrams = this.charNgrams(text);
		const tf: Map<string, number> = new Map();
		for (const ng of ngrams) {
			tf.set(ng, (tf.get(ng) || 0) + 1);
		}
		return tf;
	}

	public async generateEmbedding(text: string): Promise<number[]> {
		const tf = this.termFrequency(text);
		const vocab = Array.from(this.documentFrequencies.keys());
		const vector: number[] = new Array(vocab.length).fill(0);

		const totalNgrams = Array.from(tf.values()).reduce((a, b) => a + b, 0) || 1;

		for (let i = 0; i < vocab.length; i++) {
			const ng = vocab[i];
			const tfVal = tf.get(ng) || 0;
			const df = this.documentFrequencies.get(ng) || 1;
			const idf = Math.log(this.totalDocuments / df) + 1;
			vector[i] = (tfVal / totalNgrams) * idf;
		}

		return vector;
	}

	public cosineSimilarity(a: number[], b: number[]): number {
		if (a.length !== b.length) return 0;
		let dot = 0;
		let normA = 0;
		let normB = 0;
		for (let i = 0; i < a.length; i++) {
			dot += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}
		if (normA === 0 || normB === 0) return 0;
		return dot / (Math.sqrt(normA) * Math.sqrt(normB));
	}

	private async rebuildEmbeddings(): Promise<void> {
		// Rebuild document frequencies from all chunks
		this.documentFrequencies.clear();
		this.totalDocuments = this.allChunks.length;

		for (const chunk of this.allChunks) {
			const seen = new Set<string>();
			for (const ng of this.charNgrams(chunk.content)) {
				if (!seen.has(ng)) {
					seen.add(ng);
					this.documentFrequencies.set(ng, (this.documentFrequencies.get(ng) || 0) + 1);
				}
			}
		}

		// Assign embeddings to all chunks
		for (const chunk of this.allChunks) {
			chunk.embedding = await this.generateEmbedding(chunk.content);
		}
	}

	// ---------------------------------------------------------------------------
	// Code parsing (extract chunks from source)
	// ---------------------------------------------------------------------------

	private parseFile(filePath: string, content: string): CodeChunk[] {
		const chunks: CodeChunk[] = [];
		const lines = content.split('\n');

		// 1. Whole file chunk
		chunks.push({
			uri: filePath,
			filePath,
			startLine: 1,
			endLine: lines.length,
			kind: 'file',
			name: path.basename(filePath),
			content,
		});

		// 2. Extract functions (JS/TS/Python/etc.)
		const funcRegex = /(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(\w+)\s*[:=]\s*(?:async\s*)?\([^)]*\)\s*=>|(\w+)\s*\([^)]*\)\s*\{)/g;
		let match;
		while ((match = funcRegex.exec(content)) !== null) {
			const name = match[1] || match[2] || match[3] || 'anonymous';
			const startLine = content.slice(0, match.index).split('\n').length;
			// Find closing brace roughly
			let endLine = startLine;
			let braceDepth = 0;
			let foundOpen = false;
			for (let i = startLine - 1; i < lines.length; i++) {
				const line = lines[i];
				for (const ch of line) {
					if (ch === '{') { foundOpen = true; braceDepth++; }
					if (ch === '}') { braceDepth--; if (foundOpen && braceDepth === 0) { endLine = i + 1; break; } }
				}
				if (foundOpen && braceDepth === 0) break;
			}
			const funcContent = lines.slice(startLine - 1, endLine).join('\n');
			chunks.push({
				uri: filePath,
				filePath,
				startLine,
				endLine,
				kind: 'function',
				name,
				content: funcContent,
			});
		}

		// 3. Extract classes
		const classRegex = /(?:export\s+)?class\s+(\w+)/g;
		while ((match = classRegex.exec(content)) !== null) {
			const name = match[1];
			const startLine = content.slice(0, match.index).split('\n').length;
			let endLine = startLine;
			let braceDepth = 0;
			let foundOpen = false;
			for (let i = startLine - 1; i < lines.length; i++) {
				const line = lines[i];
				for (const ch of line) {
					if (ch === '{') { foundOpen = true; braceDepth++; }
					if (ch === '}') { braceDepth--; if (foundOpen && braceDepth === 0) { endLine = i + 1; break; } }
				}
				if (foundOpen && braceDepth === 0) break;
			}
			const classContent = lines.slice(startLine - 1, endLine).join('\n');
			chunks.push({
				uri: filePath,
				filePath,
				startLine,
				endLine,
				kind: 'class',
				name,
				content: classContent,
			});
		}

		// 4. Block chunks (every 50 lines for context)
		for (let i = 0; i < lines.length; i += INDEX_CHUNK_LINES) {
			const blockContent = lines.slice(i, i + INDEX_CHUNK_LINES).join('\n');
			if (blockContent.trim()) {
				chunks.push({
					uri: filePath,
					filePath,
					startLine: i + 1,
					endLine: Math.min(i + INDEX_CHUNK_LINES, lines.length),
					kind: 'block',
					name: `lines ${i + 1}-${Math.min(i + INDEX_CHUNK_LINES, lines.length)}`,
					content: blockContent,
				});
			}
		}

		return chunks;
	}

	// ---------------------------------------------------------------------------
	// Indexing
	// ---------------------------------------------------------------------------

	async indexFile(uri: URI, content: string): Promise<void> {
		const filePath = uri.fsPath;
		// Remove old chunks for this file
		this.chunks.delete(filePath);
		this.allChunks = this.allChunks.filter(c => c.filePath !== filePath);

		const chunks = this.parseFile(filePath, content);
		this.chunks.set(filePath, chunks);
		this.allChunks.push(...chunks);

		await this.rebuildEmbeddings();

		this.indexStats = {
			totalFiles: this.chunks.size,
			totalChunks: this.allChunks.length,
			lastIndexed: Date.now(),
		};
	}

	async indexFiles(uris: URI[]): Promise<void> {
		for (const uri of uris) {
			try {
				const content = fs.readFileSync(uri.fsPath, 'utf8');
				await this.indexFile(uri, content);
			} catch {
				// skip unreadable files
			}
		}
	}

	async indexWorkspace(): Promise<IndexStats> {
		this.chunks.clear();
		this.allChunks = [];
		this.documentFrequencies.clear();
		this.totalDocuments = 0;

		// Walk workspace folders - use a reasonable default
		const workspaceRoots = [process.cwd()];
		const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs', '.cpp', '.c', '.h', '.cs', '.php', '.rb', '.html', '.css', '.json', '.md'];

		for (const root of workspaceRoots) {
			await this.walkDirectory(root, extensions);
		}

		await this.rebuildEmbeddings();

		this.indexStats = {
			totalFiles: this.chunks.size,
			totalChunks: this.allChunks.length,
			lastIndexed: Date.now(),
		};

		return { ...this.indexStats };
	}

	private async walkDirectory(dir: string, extensions: string[]): Promise<void> {
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'out' && entry.name !== 'build' && entry.name !== '.git') {
						await this.walkDirectory(fullPath, extensions);
					}
				} else if (entry.isFile()) {
					const ext = path.extname(entry.name);
					if (extensions.includes(ext)) {
						try {
							const content = fs.readFileSync(fullPath, 'utf8');
							await this.indexFile(URI.file(fullPath), content);
						} catch {
							// skip
						}
					}
				}
			}
		} catch {
			// skip unreadable directories
		}
	}

	async removeFile(uri: URI): Promise<void> {
		const filePath = uri.fsPath;
		this.chunks.delete(filePath);
		this.allChunks = this.allChunks.filter(c => c.filePath !== filePath);
		await this.rebuildEmbeddings();
		this.indexStats = {
			totalFiles: this.chunks.size,
			totalChunks: this.allChunks.length,
			lastIndexed: Date.now(),
		};
	}

	async clearIndex(): Promise<void> {
		this.chunks.clear();
		this.allChunks = [];
		this.documentFrequencies.clear();
		this.totalDocuments = 0;
		this.indexStats = { totalFiles: 0, totalChunks: 0, lastIndexed: null };
	}

	async getStats(): Promise<IndexStats> {
		return { ...this.indexStats };
	}

	// ---------------------------------------------------------------------------
	// Search
	// ---------------------------------------------------------------------------

	async semanticSearch(query: string, limit: number = 10): Promise<SearchResult[]> {
		if (this.allChunks.length === 0) return [];

		const queryEmbedding = await this.generateEmbedding(query);

		const scored: Array<SearchResult & { score: number }> = [];
		for (const chunk of this.allChunks) {
			if (!chunk.embedding) continue;
			const score = this.cosineSimilarity(queryEmbedding, chunk.embedding);
			if (score > 0.1) {
				scored.push({
					uri: chunk.uri,
					filePath: chunk.filePath,
					startLine: chunk.startLine,
					endLine: chunk.endLine,
					kind: chunk.kind,
					name: chunk.name,
					content: chunk.content,
					score,
				});
			}
		}

		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit);
	}

	async keywordSearch(query: string, limit: number = 10): Promise<SearchResult[]> {
		if (this.allChunks.length === 0) return [];

		const q = query.toLowerCase();
		const scored: Array<SearchResult & { score: number }> = [];

		for (const chunk of this.allChunks) {
			const content = chunk.content.toLowerCase();
			const name = chunk.name.toLowerCase();
			let score = 0;

			// Exact match in name
			if (name.includes(q)) score += 10;
			// Exact match in content
			if (content.includes(q)) score += 5;
			// Word match
			const words = q.split(/\s+/).filter(w => w.length > 0);
			for (const w of words) {
				if (content.includes(w)) score += 1;
				if (name.includes(w)) score += 2;
			}

			if (score > 0) {
				scored.push({
					uri: chunk.uri,
					filePath: chunk.filePath,
					startLine: chunk.startLine,
					endLine: chunk.endLine,
					kind: chunk.kind,
					name: chunk.name,
					content: chunk.content,
					score,
				});
			}
		}

		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit);
	}

	async hybridSearch(query: string, limit: number = 10): Promise<SearchResult[]> {
		const semantic = await this.semanticSearch(query, limit * 2);
		const keyword = await this.keywordSearch(query, limit * 2);

		// Combine and deduplicate by filePath + startLine
		const seen = new Set<string>();
		const combined: SearchResult[] = [];

		for (const r of [...semantic, ...keyword]) {
			const key = `${r.filePath}:${r.startLine}`;
			if (!seen.has(key)) {
				seen.add(key);
				combined.push(r);
			}
		}

		return combined.slice(0, limit);
	}
}
