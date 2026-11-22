/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 7: keeps a CodeIndex (common/codeIndex.ts) in step with the workspace folders on disk.
 *
 * - Which files: `git ls-files --cached --others --exclude-standard` when the folder is in a git repository (so
 *   .gitignore is respected), otherwise a walk that skips the usual dependency/build/VCS folders. Text files only,
 *   lock files and minified files skipped, size- and count-limited.
 * - Freshness: before every search, indexed files are re-checked (mtime + size) and changed or deleted ones are
 *   updated; the file list itself is re-read when it is older than listTtlMs (2s), so new files appear too. A search
 *   never answers from a stale copy of a file the agent just edited.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CodeIndex } from '../common/codeIndex.js';
import { CodeSearchResponse, IndexRefresh, IndexSkips, IndexStats as WorkspaceIndexStats, LiteralSearchResponse } from '../common/codeIndexServiceTypes.js';

export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_FILES = 25_000;
export const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
// re-listing is cheap (git ls-files), so a file the agent just created is searchable almost at once
const DEFAULT_LIST_TTL_MS = 2_000;

const SKIPPED_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'out', 'out-build', 'dist', 'build', '.next', '.nuxt', 'target', 'coverage', '__pycache__', '.venv', 'venv', '.tox', '.gradle', '.idea', '.vscode-test', 'bower_components', '.cache', '.parcel-cache', '.turbo', 'vendor']);
const TEXT_EXTENSIONS = new Set([
	'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'py', 'pyi', 'go', 'rs', 'java', 'kt', 'kts', 'cs', 'php', 'rb', 'c', 'h', 'cc', 'cpp', 'hpp', 'cxx', 'swift', 'scala', 'dart', 'lua', 'r', 'jl', 'ex', 'exs', 'erl', 'hs', 'clj', 'ml', 'fs',
	'html', 'htm', 'css', 'scss', 'sass', 'less', 'md', 'mdx', 'markdown', 'txt', 'rst', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'xml', 'sql', 'graphql', 'gql', 'proto', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd', 'dockerfile', 'tf', 'hcl', 'gradle', 'cmake', 'blade', 'twig', 'erb', 'ejs', 'hbs', 'env.example',
]);
const SKIPPED_NAMES = /(^|[\\/])(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum)$|\.min\.(js|css)$|\.map$|\.d\.ts\.map$/i;
const EXTENSIONLESS_TEXT = new Set(['dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile', 'readme', 'license']);

export function isIndexableName(relPath: string): boolean {
	if (SKIPPED_NAMES.test(relPath)) { return false; }
	const base = path.basename(relPath).toLowerCase();
	if (EXTENSIONLESS_TEXT.has(base)) { return true; }
	const dot = base.lastIndexOf('.');
	return dot > 0 && TEXT_EXTENSIONS.has(base.slice(dot + 1));
}

/** files to index under a folder (absolute paths), via git when possible */
export function listWorkspaceFiles(folder: string): { files: string[]; via: 'git' | 'walk' } {
	try {
		const out = cp.execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
			cwd: folder, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		});
		const rel = out.split('\0').filter(Boolean);
		// a path in the index may be deleted on disk, or be a submodule directory
		return { files: rel.filter(isIndexableName).map(r => path.join(folder, r)), via: 'git' };
	} catch {
		const files: string[] = [];
		const walk = (dir: string) => {
			let entries: fs.Dirent[];
			try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
			for (const e of entries) {
				if (files.length >= MAX_FILES * 2) { return; }
				const full = path.join(dir, e.name);
				if (e.isDirectory()) { if (!SKIPPED_DIRS.has(e.name) && !e.name.startsWith('.')) { walk(full); } }
				else if (e.isFile() && isIndexableName(e.name)) { files.push(full); }
			}
		};
		walk(folder);
		return { files, via: 'walk' };
	}
}

function looksBinary(buf: Buffer): boolean {
	const n = Math.min(buf.length, 8000);
	for (let i = 0; i < n; i++) { if (buf[i] === 0) { return true; } }
	return false;
}

export class WorkspaceCodeIndex {
	readonly index = new CodeIndex();
	constructor(private readonly listTtlMs = DEFAULT_LIST_TTL_MS) { }
	private folders: string[] = [];
	private readonly signatureOf = new Map<string, string>(); // file → "mtimeMs:size"
	private listedAt = 0;
	private bytes = 0;
	private stats: WorkspaceIndexStats = { folders: [], totalFiles: 0, totalChunks: 0, lastIndexed: null, durationMs: 0, listedWith: 'none', skipped: { tooLarge: 0, binary: 0, overLimit: 0, unreadable: 0 } };

	private static sameFolders(a: string[], b: string[]): boolean {
		const norm = (x: string[]) => x.map(f => path.resolve(f).toLowerCase()).sort().join('|');
		return norm(a) === norm(b);
	}

	getStats(): WorkspaceIndexStats { return { ...this.stats, totalFiles: this.index.fileCount, totalChunks: this.index.chunkCount, skipped: { ...this.stats.skipped } }; }

	clear(): void {
		this.index.clear(); this.signatureOf.clear(); this.folders = []; this.listedAt = 0; this.bytes = 0;
		this.stats = { folders: [], totalFiles: 0, totalChunks: 0, lastIndexed: null, durationMs: 0, listedWith: 'none', skipped: { tooLarge: 0, binary: 0, overLimit: 0, unreadable: 0 } };
	}

	/** index these folders from scratch */
	indexFolders(folders: string[]): WorkspaceIndexStats {
		const started = Date.now();
		this.clear();
		this.folders = folders.map(f => path.resolve(f));
		const skipped: IndexSkips = { tooLarge: 0, binary: 0, overLimit: 0, unreadable: 0 };
		const vias = new Set<'git' | 'walk'>();
		for (const folder of this.folders) {
			const { files, via } = listWorkspaceFiles(folder);
			vias.add(via);
			for (const file of files) { this.indexOne(file, skipped); }
		}
		this.listedAt = Date.now();
		this.stats = { folders: [...this.folders], totalFiles: this.index.fileCount, totalChunks: this.index.chunkCount, lastIndexed: Date.now(), durationMs: Date.now() - started, listedWith: vias.size > 1 ? 'mixed' : ([...vias][0] ?? 'none'), skipped };
		return this.getStats();
	}

	/** index (or re-index) one file; false when it was skipped */
	indexOne(file: string, skipped: IndexSkips = this.stats.skipped): boolean {
		let st: fs.Stats;
		try { st = fs.statSync(file); } catch { skipped.unreadable++; return false; }
		if (!st.isFile()) { return false; }
		if (st.size > MAX_FILE_BYTES) { skipped.tooLarge++; this.forget(file); return false; }
		const previous = this.signatureOf.has(file) ? this.bytesOf(file) : 0;
		if (!this.index.hasFile(file) && (this.index.fileCount >= MAX_FILES || this.bytes + st.size > MAX_TOTAL_BYTES)) { skipped.overLimit++; return false; }
		let buf: Buffer;
		try { buf = fs.readFileSync(file); } catch { skipped.unreadable++; return false; }
		if (looksBinary(buf)) { skipped.binary++; this.forget(file); return false; }
		this.index.setFile(file, buf.toString('utf8'), this.displayPath(file));
		this.bytes += st.size - previous;
		this.signatureOf.set(file, `${st.mtimeMs}:${st.size}`);
		return true;
	}

	private bytesOf(file: string): number { return Number(this.signatureOf.get(file)?.split(':')[1] ?? 0); }

	forget(file: string): void {
		if (!this.signatureOf.has(file)) { return; }
		this.bytes -= this.bytesOf(file);
		this.signatureOf.delete(file);
		this.index.removeFile(file);
	}

	displayPath(file: string): string {
		const folder = this.folders.find(f => file.toLowerCase().startsWith(f.toLowerCase() + path.sep) || file.toLowerCase() === f.toLowerCase());
		return folder ? path.relative(folder, file) : file;
	}

	/** bring the index up to date with the disk: changed/deleted files always, new files when the list is old */
	refresh(folders: string[], opts: { relist?: boolean } = {}): IndexRefresh {
		if (!WorkspaceCodeIndex.sameFolders(folders, this.folders)) {
			const before = this.index.fileCount;
			this.indexFolders(folders);
			return { added: this.index.fileCount, changed: 0, removed: before, initial: true };
		}
		const r: IndexRefresh = { added: 0, changed: 0, removed: 0 };
		for (const [file, sig] of [...this.signatureOf]) {
			let st: fs.Stats | undefined;
			try { st = fs.statSync(file); } catch { st = undefined; }
			if (!st) { this.forget(file); r.removed++; continue; }
			if (`${st.mtimeMs}:${st.size}` !== sig) { if (this.indexOne(file)) { r.changed++; } else { r.removed++; } }
		}
		if (opts.relist || Date.now() - this.listedAt >= this.listTtlMs) {
			const listed = new Set<string>();
			for (const folder of this.folders) { for (const f of listWorkspaceFiles(folder).files) { listed.add(f); } }
			for (const f of listed) { if (!this.signatureOf.has(f) && this.indexOne(f)) { r.added++; } }
			for (const f of [...this.signatureOf.keys()]) { if (!listed.has(f)) { this.forget(f); r.removed++; } } // e.g. newly git-ignored
			this.listedAt = Date.now();
		}
		if (r.added || r.changed || r.removed) { this.stats.lastIndexed = Date.now(); }
		return r;
	}

	search(folders: string[], query: string, limit: number): CodeSearchResponse {
		const refreshed = this.refresh(folders);
		const hits = this.index.search(query, limit).map(h => ({ ...h, relativePath: this.displayPath(h.filePath) }));
		return { hits, refreshed, stats: this.getStats() };
	}

	findLiteral(folders: string[], text: string, limit: number): LiteralSearchResponse {
		const refreshed = this.refresh(folders);
		const matches = this.index.findLiteral(text, limit).map(m => ({ ...m, relativePath: this.displayPath(m.filePath) }));
		return { matches, refreshed, stats: this.getStats() };
	}
}
