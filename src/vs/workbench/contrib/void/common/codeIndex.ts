/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 7: the codebase index, without any I/O (the workspace side is node/codeIndexWorkspace.ts).
 *
 * What it is, precisely: a LEXICAL relevance index. Files are split into chunks along symbol boundaries (functions,
 * classes, methods, …; fixed windows for what is outside any symbol), identifiers are split into words
 * (`parseUserToken` → parse, user, token), a few common code abbreviations are expanded, and chunks are ranked with
 * BM25, weighting the symbol name and the file path above the body. It finds code by the words a person would use
 * for it, even when the query and the code spell them differently ("user auth" finds `authenticateUser`), but it
 * does not understand meaning the way an embedding model would.
 */

// ---------- tokenizing ----------

const STOP_WORDS = new Set([
	'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'and', 'or', 'not', 'is', 'are', 'be', 'it', 'its', 'as', 'with', 'from', 'that', 'this', 'which', 'what', 'where', 'how', 'when', 'who', 'does', 'do', 'there', 'here', 'into', 'about', 'code', 'file', 'files',
	'const', 'let', 'var', 'return', 'import', 'export', 'default', 'new', 'true', 'false', 'null', 'undefined', 'void', 'self', 'if', 'else', 'elif', 'then', 'end', 'fi',
]);

// both directions are indexed, so a query in either form matches code in either form
const ABBREVIATIONS: ReadonlyArray<readonly [string, string]> = [
	['auth', 'authentication'], ['auth', 'authenticate'], ['auth', 'authorization'], ['config', 'configuration'], ['cfg', 'config'], ['conf', 'config'],
	['db', 'database'], ['err', 'error'], ['msg', 'message'], ['req', 'request'], ['res', 'response'], ['resp', 'response'], ['ctx', 'context'],
	['env', 'environment'], ['repo', 'repository'], ['util', 'utility'], ['utils', 'utility'], ['init', 'initialize'], ['param', 'parameter'], ['params', 'parameter'],
	['arg', 'argument'], ['args', 'argument'], ['btn', 'button'], ['impl', 'implementation'], ['dir', 'directory'], ['tmp', 'temporary'], ['temp', 'temporary'],
	['num', 'number'], ['str', 'string'], ['fn', 'function'], ['func', 'function'], ['cb', 'callback'], ['val', 'value'], ['idx', 'index'], ['len', 'length'],
	['src', 'source'], ['dest', 'destination'], ['dst', 'destination'], ['max', 'maximum'], ['min', 'minimum'], ['prev', 'previous'], ['cur', 'current'], ['curr', 'current'],
	['async', 'asynchronous'], ['sync', 'synchronize'], ['pwd', 'password'], ['passwd', 'password'], ['usr', 'user'], ['admin', 'administrator'], ['nav', 'navigation'],
	['img', 'image'], ['doc', 'document'], ['docs', 'document'], ['spec', 'specification'], ['stmt', 'statement'], ['expr', 'expression'], ['attr', 'attribute'],
	['calc', 'calculate'], ['eval', 'evaluate'], ['exec', 'execute'], ['cmd', 'command'], ['proc', 'process'], ['mgr', 'manager'], ['svc', 'service'], ['ws', 'websocket'],
];
const EXPANSIONS = new Map<string, string[]>();
for (const [a, b] of ABBREVIATIONS) {
	EXPANSIONS.set(a, [...(EXPANSIONS.get(a) ?? []), b]);
	EXPANSIONS.set(b, [...(EXPANSIONS.get(b) ?? []), a]);
}

/** a light stemmer: plurals and common verb endings, so "parsing", "parsed" and "parses" meet "parse" */
export function stem(word: string): string {
	if (word.length <= 3) { return word; }
	if (word.endsWith('ies') && word.length > 4) { return word.slice(0, -3) + 'y'; }
	if (word.endsWith('ing') && word.length > 5) { return dropFinalE(word.slice(0, -3)); }
	if (word.endsWith('ed') && word.length > 4) { return dropFinalE(word.slice(0, -2)); }
	if (word.endsWith('es') && /(ss|x|ch|sh)es$/.test(word)) { return word.slice(0, -2); }
	if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is')) { return dropFinalE(word.slice(0, -1)); }
	return dropFinalE(word);
}
function dropFinalE(w: string): string { return w.length > 3 && w.endsWith('e') ? w.slice(0, -1) : w; }

/** Words of a text: identifiers split at camelCase / snake_case / kebab-case, lowercased, stemmed, stop words dropped. */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*|\d{2,}/g)) {
		const ident = m[0];
		const parts = ident.split(/[_$]+/).flatMap(p => p.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)).filter(Boolean);
		for (const part of parts) {
			const w = part.toLowerCase();
			if (w.length < 2 || STOP_WORDS.has(w)) { continue; }
			out.push(stem(w));
		}
		// the whole identifier too, so an exact identifier query ranks its definition first
		if (parts.length > 1 && ident.length <= 60) { out.push(`#${ident.toLowerCase()}`); }
	}
	return out;
}

/** The query's words plus their expansions (each expansion counts less than the word itself). */
export function queryTerms(query: string): Map<string, number> {
	const terms = new Map<string, number>();
	const add = (t: string, w: number) => terms.set(t, Math.max(terms.get(t) ?? 0, w));
	for (const t of tokenize(query)) {
		add(t, 1);
		const base = t.startsWith('#') ? undefined : t;
		for (const raw of base ? EXPANSIONS.get(base) ?? [] : []) { add(stem(raw), 0.6); }
	}
	// expansions keyed by the unstemmed word ("utils" → utility)
	for (const m of query.toLowerCase().matchAll(/[a-z]+/g)) {
		for (const raw of EXPANSIONS.get(m[0]) ?? []) { add(stem(raw), 0.6); }
	}
	return terms;
}

// ---------- chunking ----------

export type ChunkKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'variable' | 'section' | 'block';
export type Chunk = { startLine: number; endLine: number; kind: ChunkKind; name: string };

const MAX_CHUNK_LINES = 150;
const WINDOW_LINES = 40;

type Lang = 'js' | 'python' | 'brace' | 'markdown' | 'other';
export function languageOf(filePath: string): Lang {
	const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
	if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte'].includes(ext)) { return 'js'; }
	if (['py', 'pyi'].includes(ext)) { return 'python'; }
	if (['go', 'rs', 'java', 'kt', 'kts', 'cs', 'php', 'c', 'h', 'cc', 'cpp', 'hpp', 'cxx', 'swift', 'scala', 'dart'].includes(ext)) { return 'brace'; }
	if (['md', 'mdx', 'markdown'].includes(ext)) { return 'markdown'; }
	return 'other';
}

const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'function', 'else', 'do', 'try', 'foreach', 'using', 'lock', 'synchronized', 'new', 'await', 'typeof', 'sizeof', 'elif', 'match']);

type Def = { re: RegExp; kind: ChunkKind; nameGroup: number };
const JS_DEFS: Def[] = [
	{ re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class', nameGroup: 1 },
	{ re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface', nameGroup: 1 },
	{ re: /^\s*(?:export\s+)?(?:declare\s+)?(?:type|enum|const\s+enum)\s+([A-Za-z_$][\w$]*)\s*[=<{]/, kind: 'type', nameGroup: 1 },
	{ re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function', nameGroup: 1 },
	{ re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, kind: 'function', nameGroup: 1 },
	{ re: /^\s+(?:(?:public|private|protected|static|readonly|async|override|get|set|abstract)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)?\s*(?::\s*[^={]+)?\{\s*$/, kind: 'method', nameGroup: 1 },
	{ re: /^\s+(?:(?:public|private|protected|static|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?\([^)]*\)\s*(?::[^=]+)?=>/, kind: 'method', nameGroup: 1 },
];
const BRACE_DEFS: Def[] = [
	{ re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function', nameGroup: 1 }, // rust
	{ re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function', nameGroup: 1 }, // go
	{ re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial|data|open|export)\s+)*(?:class|struct|interface|enum|trait|impl|record|object)\s+([A-Za-z_]\w*)/, kind: 'class', nameGroup: 1 },
	{ re: /^\s*(?:(?:public|private|protected|static|final|abstract|function)\s+)*function\s+&?([A-Za-z_]\w*)\s*\(/, kind: 'function', nameGroup: 1 }, // php
	{ re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|async|synchronized|inline|extern|const|unsafe)\s+)*[A-Za-z_][\w<>,\[\]\s*&:.?]*\s+([A-Za-z_]\w*)\s*\([^;]*$/, kind: 'method', nameGroup: 1 }, // java/c#/c/c++
];

function stripStringsAndComments(line: string): string {
	return line.replace(/\/\/.*$/, '').replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
}

/** last line of the brace block that opens at or soon after `start` (0-based); `start` itself when there is none */
function braceBlockEnd(lines: string[], start: number): number {
	let depth = 0, opened = false;
	for (let i = start; i < lines.length; i++) {
		for (const ch of stripStringsAndComments(lines[i])) {
			if (ch === '{') { depth++; opened = true; }
			else if (ch === '}') { depth--; if (opened && depth <= 0) { return i; } }
		}
		if (!opened && i - start >= 3) { return start; } // a one-line declaration (arrow fn, prototype, abstract method)
		if (!opened && /;\s*$/.test(lines[i])) { return i; }
	}
	return opened ? lines.length - 1 : start;
}

function indentOf(line: string): number { return line.length - line.trimStart().length; }

// a top-level constant/variable (not an import): ends before the next top-level statement
const TOP_LEVEL_VARIABLE = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?!require\(|import\(|await\s+import\()/;
const PY_TOP_LEVEL_CONSTANT = /^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/;
function topLevelStatementEnd(lines: string[], start: number): number {
	let end = start;
	for (let i = start + 1; i < lines.length && i - start < MAX_CHUNK_LINES; i++) {
		const l = lines[i];
		if (!l.trim()) { continue; }
		if (indentOf(l) === 0 && !/^[)\]}.+\-*/`'"?:|&,]/.test(l)) { break; }
		end = i;
	}
	return end;
}

function pythonBlockEnd(lines: string[], start: number): number {
	const base = indentOf(lines[start]);
	let end = start;
	for (let i = start + 1; i < lines.length; i++) {
		if (!lines[i].trim()) { continue; }
		if (indentOf(lines[i]) <= base) { break; }
		end = i;
	}
	return end;
}

/**
 * Chunks of a file (1-based inclusive line ranges). Every non-blank line belongs to at least one chunk: symbols get
 * their own chunks (nested ones too: a method is found by itself, not only inside its class), and the lines outside
 * any top-level symbol are grouped in windows. Long symbols are split.
 */
export function chunkFile(filePath: string, content: string): Chunk[] {
	const lines = content.split(/\r?\n/);
	const lang = languageOf(filePath);
	const symbols: Chunk[] = [];

	if (lang === 'markdown') {
		const heads: { line: number; name: string }[] = [];
		lines.forEach((l, i) => { const m = /^(#{1,4})\s+(.+)/.exec(l); if (m) { heads.push({ line: i, name: m[2].trim() }); } });
		heads.forEach((h, k) => {
			let end = k + 1 < heads.length ? heads[k + 1].line : lines.length; // 1-based: the line before the next heading
			while (end > h.line + 1 && !lines[end - 1].trim()) { end--; }
			symbols.push({ startLine: h.line + 1, endLine: end, kind: 'section', name: h.name });
		});
	} else if (lang === 'python') {
		lines.forEach((l, i) => {
			const m = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)|^\s*class\s+([A-Za-z_]\w*)/.exec(l);
			if (!m) { return; }
			symbols.push({ startLine: i + 1, endLine: pythonBlockEnd(lines, i) + 1, kind: m[2] ? 'class' : indentOf(l) > 0 ? 'method' : 'function', name: m[1] ?? m[2] });
		});
		lines.forEach((l, i) => {
			const m = PY_TOP_LEVEL_CONSTANT.exec(l);
			if (m) { symbols.push({ startLine: i + 1, endLine: topLevelStatementEnd(lines, i) + 1, kind: 'variable', name: m[1] }); }
		});
	} else if (lang === 'js' || lang === 'brace') {
		const defs = lang === 'js' ? JS_DEFS : [...BRACE_DEFS, ...JS_DEFS.slice(0, 2)];
		lines.forEach((l, i) => {
			if (/^\s*(\/\/|\*|\/\*|#)/.test(l)) { return; }
			let found = false;
			for (const d of defs) {
				const m = d.re.exec(l);
				if (!m) { continue; }
				found = true;
				const name = m[d.nameGroup];
				if (!name || CONTROL_WORDS.has(name)) { break; }
				symbols.push({ startLine: i + 1, endLine: braceBlockEnd(lines, i) + 1, kind: d.kind, name });
				break;
			}
			const v = !found && lang === 'js' ? TOP_LEVEL_VARIABLE.exec(l) : null;
			if (v) { symbols.push({ startLine: i + 1, endLine: topLevelStatementEnd(lines, i) + 1, kind: 'variable', name: v[1] }); }
		});
	}

	// leading comments / decorators belong to their symbol
	for (const s of symbols) {
		let i = s.startLine - 2;
		while (i >= 0 && /^\s*(\/\/|\/\*|\*|#(?!\s*(include|define))|@\w|"""|''')/.test(lines[i]) && s.startLine - 1 - i < 15) { i--; }
		s.startLine = i + 2;
	}

	// lines outside every top-level symbol: windows
	const covered = new Array<boolean>(lines.length).fill(false);
	for (const s of symbols) { for (let i = s.startLine - 1; i < s.endLine; i++) { covered[i] = true; } }
	const rest: Chunk[] = [];
	let i = 0;
	while (i < lines.length) {
		if (covered[i] || !lines[i].trim()) { i++; continue; }
		const start = i;
		let end = i;
		while (i < lines.length && !covered[i] && i - start < WINDOW_LINES) { if (lines[i].trim()) { end = i; } i++; }
		rest.push({ startLine: start + 1, endLine: end + 1, kind: 'block', name: `lines ${start + 1}-${end + 1}` });
	}

	// split long chunks
	const out: Chunk[] = [];
	for (const c of [...symbols, ...rest]) {
		if (c.endLine - c.startLine + 1 <= MAX_CHUNK_LINES) { out.push(c); continue; }
		for (let s = c.startLine, part = 1; s <= c.endLine; s += MAX_CHUNK_LINES, part++) {
			out.push({ ...c, startLine: s, endLine: Math.min(c.endLine, s + MAX_CHUNK_LINES - 1), name: `${c.name} (part ${part})` });
		}
	}
	return out.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
}

// ---------- the index ----------

export type IndexedChunk = Chunk & { filePath: string };
export type CodeSearchHit = IndexedChunk & { score: number; matchedTerms: string[]; snippet: { line: number; text: string }[] };

// prior: lines outside every symbol in a file that HAS symbols are mostly imports/exports/wiring that mention names
// defined elsewhere, so they rank below the definitions themselves
type Doc = { chunk: IndexedChunk; length: number; tf: Map<string, number>; prior: number };
const LOOSE_LINES_PRIOR = 0.5;

const BM25_K1 = 1.2, BM25_B = 0.75;
const NAME_WEIGHT = 3, PATH_WEIGHT = 1.5;

/** BM25 over chunks, updated file by file (adding or removing a file never rebuilds the rest). */
export class CodeIndex {
	private readonly docs = new Map<number, Doc>();
	private readonly docsOfFile = new Map<string, number[]>();
	private readonly linesOfFile = new Map<string, string[]>();
	private readonly postings = new Map<string, Set<number>>();
	private nextDocId = 0;
	private totalLength = 0;

	get fileCount(): number { return this.docsOfFile.size; }
	get chunkCount(): number { return this.docs.size; }
	hasFile(filePath: string): boolean { return this.docsOfFile.has(filePath); }
	files(): string[] { return [...this.docsOfFile.keys()]; }

	/** (re)index one file; `displayPath` is what scores the path words (e.g. the workspace-relative path) */
	setFile(filePath: string, content: string, displayPath = filePath): void {
		this.removeFile(filePath);
		const lines = content.split(/\r?\n/);
		this.linesOfFile.set(filePath, lines);
		const pathTokens = tokenize(displayPath.replace(/\.[^./\\]+$/, ''));
		const ids: number[] = [];
		const chunks = chunkFile(filePath, content);
		const hasSymbols = chunks.some(c => c.kind !== 'block');
		for (const c of chunks) {
			const tf = new Map<string, number>();
			const add = (t: string, w: number) => tf.set(t, (tf.get(t) ?? 0) + w);
			for (const t of tokenize(lines.slice(c.startLine - 1, c.endLine).join('\n'))) { add(t, 1); }
			if (c.kind !== 'block') { for (const t of tokenize(c.name)) { add(t, NAME_WEIGHT); } add(`#${c.name.toLowerCase()}`, NAME_WEIGHT); }
			for (const t of pathTokens) { add(t, PATH_WEIGHT); }
			const length = [...tf.values()].reduce((a, b) => a + b, 0);
			const id = this.nextDocId++;
			this.docs.set(id, { chunk: { ...c, filePath }, length, tf, prior: c.kind === 'block' && hasSymbols ? LOOSE_LINES_PRIOR : 1 });
			this.totalLength += length;
			for (const t of tf.keys()) { let s = this.postings.get(t); if (!s) { s = new Set(); this.postings.set(t, s); } s.add(id); }
			ids.push(id);
		}
		this.docsOfFile.set(filePath, ids);
	}

	removeFile(filePath: string): void {
		for (const id of this.docsOfFile.get(filePath) ?? []) {
			const d = this.docs.get(id)!;
			this.totalLength -= d.length;
			for (const t of d.tf.keys()) { const s = this.postings.get(t); s?.delete(id); if (s && s.size === 0) { this.postings.delete(t); } }
			this.docs.delete(id);
		}
		this.docsOfFile.delete(filePath);
		this.linesOfFile.delete(filePath);
	}

	clear(): void {
		this.docs.clear(); this.docsOfFile.clear(); this.linesOfFile.clear(); this.postings.clear(); this.totalLength = 0;
	}

	search(query: string, limit = 10): CodeSearchHit[] {
		const terms = queryTerms(query);
		const n = this.docs.size;
		if (n === 0 || terms.size === 0) { return []; }
		const avgLen = this.totalLength / n;
		const scores = new Map<number, { score: number; matched: Set<string> }>();
		for (const [term, weight] of terms) {
			const posting = this.postings.get(term);
			if (!posting) { continue; }
			const idf = Math.log(1 + (n - posting.size + 0.5) / (posting.size + 0.5));
			for (const id of posting) {
				const d = this.docs.get(id)!;
				const f = d.tf.get(term)!;
				const s = weight * idf * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * d.length / avgLen));
				const e = scores.get(id) ?? { score: 0, matched: new Set<string>() };
				e.score += s;
				e.matched.add(term);
				scores.set(id, e);
			}
		}
		// chunks that contain more of the query's distinct words first: coverage multiplies the score
		const mainTerms = [...terms].filter(([, w]) => w === 1).length || 1;
		const ranked = [...scores].map(([id, e]) => {
			const coverage = [...e.matched].filter(t => terms.get(t) === 1).length / mainTerms;
			return { id, score: e.score * (0.5 + coverage) * this.docs.get(id)!.prior, matched: e.matched };
		}).sort((a, b) => b.score - a.score);

		// one hit per region: a chunk that overlaps a better-ranked chunk of the same file is left out
		const hits: CodeSearchHit[] = [];
		for (const r of ranked) {
			if (hits.length >= limit) { break; }
			const c = this.docs.get(r.id)!.chunk;
			if (hits.some(h => h.filePath === c.filePath && h.startLine <= c.endLine && c.startLine <= h.endLine)) { continue; }
			hits.push({ ...c, score: r.score, matchedTerms: [...r.matched], snippet: this.snippet(c, r.matched) });
		}
		return hits;
	}

	/** the chunk's first line, then up to 3 lines with the most matched words */
	private snippet(c: IndexedChunk, matched: Set<string>, maxLines = 3): { line: number; text: string }[] {
		const lines = this.linesOfFile.get(c.filePath) ?? [];
		const scored: { line: number; hits: number }[] = [];
		for (let i = c.startLine; i <= c.endLine; i++) {
			const toks = new Set(tokenize(lines[i - 1] ?? ''));
			const hits = [...matched].filter(t => toks.has(t)).length;
			if (hits > 0) { scored.push({ line: i, hits }); }
		}
		const best = scored.sort((a, b) => b.hits - a.hits || a.line - b.line).slice(0, maxLines).map(s => s.line);
		const first = c.kind === 'block' ? [] : [c.startLine + this.leadingCommentLines(lines, c)];
		return [...new Set([...first, ...best])].sort((a, b) => a - b).map(line => ({ line, text: (lines[line - 1] ?? '').trim().slice(0, 200) }));
	}

	private leadingCommentLines(lines: string[], c: Chunk): number {
		let k = 0;
		while (c.startLine - 1 + k < c.endLine - 1 && /^\s*(\/\/|\/\*|\*|#|@\w|"""|''')/.test(lines[c.startLine - 1 + k])) { k++; }
		return k;
	}

	/** the text of a chunk (capped), e.g. to show it to a reranking model */
	chunkText(chunk: IndexedChunk, maxChars = 2000): string {
		const lines = this.linesOfFile.get(chunk.filePath) ?? [];
		return lines.slice(chunk.startLine - 1, chunk.endLine).join('\n').slice(0, maxChars);
	}

	/** literal (case-insensitive) occurrences, by file and line */
	findLiteral(text: string, limit = 50): { filePath: string; line: number; text: string }[] {
		const needle = text.toLowerCase();
		if (!needle) { return []; }
		const out: { filePath: string; line: number; text: string }[] = [];
		for (const [filePath, lines] of this.linesOfFile) {
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].toLowerCase().includes(needle)) {
					out.push({ filePath, line: i + 1, text: lines[i].trim().slice(0, 200) });
					if (out.length >= limit) { return out; }
				}
			}
		}
		return out;
	}
}
