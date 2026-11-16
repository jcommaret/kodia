/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';

export const ICodeIndexService = createDecorator<ICodeIndexService>('CodeIndexService');

export type CodeChunk = {
	uri: string;
	filePath: string;
	startLine: number;
	endLine: number;
	kind: 'function' | 'class' | 'method' | 'interface' | 'variable' | 'import' | 'block' | 'file';
	name: string;
	content: string;
	embedding?: number[];
};

export type SearchResult = {
	uri: string;
	filePath: string;
	startLine: number;
	endLine: number;
	kind: string;
	name: string;
	content: string;
	score: number;
};

export type IndexStats = {
	totalFiles: number;
	totalChunks: number;
	lastIndexed: number | null;
};

export interface ICodeIndexService {
	readonly _serviceBrand: undefined;

	// --- Indexing ---
	indexFile(uri: URI, content: string): Promise<void>;
	indexFiles(uris: URI[]): Promise<void>;
	indexWorkspace(): Promise<IndexStats>;
	removeFile(uri: URI): Promise<void>;
	clearIndex(): Promise<void>;
	getStats(): Promise<IndexStats>;

	// --- Search ---
	semanticSearch(query: string, limit?: number): Promise<SearchResult[]>;
	keywordSearch(query: string, limit?: number): Promise<SearchResult[]>;
	hybridSearch(query: string, limit?: number): Promise<SearchResult[]>;

	// --- Embeddings ---
	generateEmbedding(text: string): Promise<number[]>;
	cosineSimilarity(a: number[], b: number[]): number;
}
