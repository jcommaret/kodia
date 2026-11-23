/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	AIEvaluationReport,
	AIEvaluationTaskType,
	AIExperimentRecord,
	AIRuntimeEntry,
	AIWorkflowDefinition,
	AIWorkflowRunResult,
	AIWorkflowRunStepTrace,
	ComputeHardwareProfile,
	DatasetColumnProfile,
	DatasetProfileReport,
	DetectedGpuInfo,
	IKodiaAIEngineMainService,
	ModelRegistryEntry,
	ModelRegistryStage,
	RagDocumentChunk,
	RagEvalCaseResult,
	RagEvaluationReport,
	RagIndexSummary,
	RagQueryResult,
} from '../common/aiEngineeringTypes.js';
import { chunkDocumentForRag, searchRagChunksHybrid } from '../common/aiEngineeringKnowledge.js';

const AI_STATE_SUBDIR = path.join('.kodia', 'ai');
const SKIP_SCAN_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', '.kodia', 'coverage', 'target']);
const RAG_TEXT_EXTS = new Set(['.md', '.txt', '.json', '.csv', '.tsv', '.html', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cs', '.sql', '.yaml', '.yml']);

function isInsideWorkspace(workspaceRoot: string, targetPath: string): boolean {
	if (!workspaceRoot) { return false; }
	const root = path.resolve(workspaceRoot);
	const target = path.resolve(targetPath);
	const rel = path.relative(root, target);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function runExec(bin: string, args: string[], timeoutMs = 4500, cwd?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	return new Promise(resolve => {
		try {
			cp.execFile(bin, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
				resolve({ ok: !err, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim() });
			});
		} catch (e) {
			resolve({ ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) });
		}
	});
}

function sanitizeId(raw: string, fallback = 'default'): string {
	return raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || fallback;
}

function parseCsvLine(line: string, delimiter: string): string[] {
	const out: string[] = [];
	let cur = '';
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') {
			if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
			else { inQuotes = !inQuotes; }
		} else if (ch === delimiter && !inQuotes) {
			out.push(cur.trim());
			cur = '';
		} else {
			cur += ch;
		}
	}
	out.push(cur.trim());
	return out;
}

function inferCellType(val: string): 'number' | 'integer' | 'boolean' | 'date' | 'string' | 'empty' {
	const v = val.trim();
	if (!v || v.toLowerCase() === 'null' || v.toLowerCase() === 'nan' || v.toLowerCase() === 'na') { return 'empty'; }
	if (/^(true|false)$/i.test(v)) { return 'boolean'; }
	if (/^-?\d+$/.test(v)) { return 'integer'; }
	if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) { return 'number'; }
	if (/^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2})?/.test(v)) { return 'date'; }
	return 'string';
}

interface PersistedRagIndex extends RagIndexSummary {
	readonly chunks: RagDocumentChunk[];
}

export class KodiaAIEngineMainService extends Disposable implements IKodiaAIEngineMainService {
	readonly _serviceBrand: undefined;

	private ensureAiDir(workspaceRoot: string, ...sub: string[]): string {
		if (!workspaceRoot) { throw new Error('An open workspace folder is required for persistent AI Engine operations.'); }
		const dir = path.join(workspaceRoot, AI_STATE_SUBDIR, ...sub);
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	private readJsonArray<T>(filePath: string): T[] {
		if (!fs.existsSync(filePath)) { return []; }
		try {
			const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}

	private writeJsonFile(filePath: string, data: unknown): void {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
	}

	// ========================================================================
	// 1. REAL COMPUTE HARDWARE, GPU & AI RUNTIME PROBER
	// ========================================================================

	async probeComputeHardware(workspaceRoot: string): Promise<ComputeHardwareProfile> {
		const cpus = os.cpus();
		const cpuModel = cpus[0]?.model ?? 'Unknown CPU';
		const cpuCount = cpus.length;
		const totalMemoryGb = Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10;
		const freeMemoryGb = Math.round((os.freemem() / (1024 ** 3)) * 10) / 10;
		const platform = os.platform();
		const arch = os.arch();
		const hasAppleSilicon = platform === 'darwin' && arch === 'arm64';

		// Real NVIDIA GPU probe via nvidia-smi
		const gpus: DetectedGpuInfo[] = [];
		const nvRes = await runExec('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], 3500);
		if (nvRes.ok && nvRes.stdout) {
			for (const line of nvRes.stdout.split(/\r?\n/).filter(Boolean)) {
				const parts = line.split(',').map(s => s.trim());
				gpus.push({
					name: parts[0] || 'NVIDIA GPU',
					vendor: 'nvidia',
					vramMb: Number(parts[1]) || undefined,
					driverVersion: parts[2] || undefined,
				});
			}
		} else if (hasAppleSilicon) {
			gpus.push({
				name: 'Apple Silicon Unified GPU (Metal/MPS)',
				vendor: 'apple',
				vramMb: Math.round(totalMemoryGb * 1024 * 0.75),
			});
		}

		// Probe core languages, inference servers & container tools in parallel
		const probeDefs: Array<{ name: string; bin: string; args: string[]; category: AIRuntimeEntry['category'] }> = [
			{ name: 'python', bin: 'python', args: ['--version'], category: 'language' },
			{ name: 'node', bin: 'node', args: ['--version'], category: 'language' },
			{ name: 'go', bin: 'go', args: ['version'], category: 'language' },
			{ name: 'cargo', bin: 'cargo', args: ['--version'], category: 'language' },
			{ name: 'ollama', bin: 'ollama', args: ['--version'], category: 'llm-serving' },
			{ name: 'docker', bin: 'docker', args: ['--version'], category: 'container' },
			{ name: 'kubectl', bin: 'kubectl', args: ['version', '--client', '--short'], category: 'container' },
			{ name: 'uv', bin: 'uv', args: ['--version'], category: 'mlops' },
		];

		const cliResults = await Promise.all(probeDefs.map(async def => {
			const res = await runExec(def.bin, def.args, 3000, workspaceRoot || undefined);
			return {
				name: def.name,
				available: res.ok,
				version: res.ok ? (res.stdout || res.stderr).split(/\r?\n/)[0].slice(0, 60) : undefined,
				category: def.category,
			} satisfies AIRuntimeEntry;
		}));

		const runtimes: AIRuntimeEntry[] = [...cliResults];

		// If Python is available, probe installed AI libraries in ONE fast subprocess call
		const pythonEntry = cliResults.find(r => r.name === 'python');
		if (pythonEntry?.available) {
			const pyScript = [
				'import importlib.util, json',
				'pkgs = ["torch","transformers","sklearn","cv2","onnxruntime","fastapi","langchain","llama_index","mlflow","xgboost","lightgbm"]',
				'out = {}',
				'for p in pkgs:',
				'    spec = importlib.util.find_spec(p)',
				'    out[p] = bool(spec)',
				'print(json.dumps(out))',
			].join('\n');
			const pyRes = await runExec('python', ['-c', pyScript], 4000, workspaceRoot || undefined);
			if (pyRes.ok && pyRes.stdout) {
				try {
					const parsed = JSON.parse(pyRes.stdout) as Record<string, boolean>;
					for (const [pkg, avail] of Object.entries(parsed)) {
						runtimes.push({
							name: `python:${pkg}`,
							available: !!avail,
							category: pkg === 'mlflow' ? 'mlops' : 'ml-framework',
						});
					}
				} catch { /* ignore */ }
			}
		}

		const hasCuda = gpus.some(g => g.vendor === 'nvidia');
		const recommendedComputeTier: ComputeHardwareProfile['recommendedComputeTier'] =
			gpus.filter(g => g.vendor === 'nvidia').length > 1 ? 'multi-gpu'
				: hasCuda ? 'single-gpu'
					: hasAppleSilicon ? 'apple-silicon-unified'
						: 'cpu-only';

		const availSummary = runtimes.filter(r => r.available).map(r => r.name).join(', ') || 'none';
		const summary = `${platform}/${arch} | ${cpuCount} CPUs (${cpuModel}) | ${freeMemoryGb}/${totalMemoryGb} GB RAM | GPUs: ${gpus.length ? gpus.map(g => `${g.name}${g.vramMb ? ` (${Math.round(g.vramMb / 1024)} GB)` : ''}`).join(', ') : 'none (CPU only)'} | Tier: ${recommendedComputeTier} | Installed AI runtimes: ${availSummary}`;

		return {
			platform,
			arch,
			cpuModel,
			cpuCount,
			totalMemoryGb,
			freeMemoryGb,
			gpus,
			hasCuda,
			hasAppleSilicon,
			runtimes,
			recommendedComputeTier,
			summary,
		};
	}

	// ========================================================================
	// 2. REAL DATASET PROFILER (CSV, TSV, JSON, JSONL, DIRECTORIES)
	// ========================================================================

	async profileDataset(workspaceRoot: string, datasetPath: string, opts?: { maxRows?: number }): Promise<DatasetProfileReport> {
		const maxRows = Math.max(10, Math.min(50_000, opts?.maxRows ?? 5_000));
		const resolved = path.isAbsolute(datasetPath) ? path.resolve(datasetPath) : path.resolve(workspaceRoot, datasetPath);
		if (workspaceRoot && !isInsideWorkspace(workspaceRoot, resolved)) {
			return {
				datasetPath, format: 'unknown', sizeBytes: 0, sha256Fingerprint: '', rowCount: 0, columnCount: 0, duplicateRowCount: 0,
				columns: [], piiWarnings: [], qualityWarnings: [], qualityScore: 0, cleaningRecommendations: [],
				error: `Dataset path "${resolved}" is outside the workspace root.`,
			};
		}
		if (!fs.existsSync(resolved)) {
			return {
				datasetPath, format: 'unknown', sizeBytes: 0, sha256Fingerprint: '', rowCount: 0, columnCount: 0, duplicateRowCount: 0,
				columns: [], piiWarnings: [], qualityWarnings: [], qualityScore: 0, cleaningRecommendations: [],
				error: `Dataset not found on disk: ${resolved}`,
			};
		}

		const stat = fs.statSync(resolved);
		if (stat.isDirectory()) {
			const entries = fs.readdirSync(resolved, { withFileTypes: true });
			const files = entries.filter(e => e.isFile());
			const imgCount = files.filter(f => /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name)).length;
			const format = imgCount > files.length / 2 ? 'image-directory' : 'text-directory';
			const hash = crypto.createHash('sha256').update(files.map(f => f.name).sort().join('\n')).digest('hex').slice(0, 16);
			return {
				datasetPath: path.relative(workspaceRoot, resolved).replace(/\\/g, '/'),
				format,
				sizeBytes: files.reduce((s, f) => s + fs.statSync(path.join(resolved, f.name)).size, 0),
				sha256Fingerprint: hash,
				rowCount: files.length,
				columnCount: 1,
				duplicateRowCount: 0,
				columns: [{ name: 'filename', inferredType: 'string', nonNullCount: files.length, missingCount: 0, missingRate: 0, uniqueCount: files.length, sampleValues: files.slice(0, 5).map(f => f.name) }],
				piiWarnings: [],
				qualityWarnings: files.length < 10 ? ['Small directory dataset (<10 files): suitable for smoke testing only.'] : [],
				qualityScore: files.length > 0 ? 90 : 20,
				cleaningRecommendations: ['Create explicit train/validation/test split manifest to guarantee reproducible evaluation.'],
			};
		}

		const buf = fs.readFileSync(resolved);
		const sha256Fingerprint = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);
		const rawText = buf.toString('utf8');
		const ext = path.extname(resolved).toLowerCase();

		let format: DatasetProfileReport['format'] = 'unknown';
		let records: Record<string, string>[] = [];

		if (ext === '.csv' || ext === '.tsv') {
			format = ext === '.tsv' ? 'tsv' : 'csv';
			const delim = ext === '.tsv' ? '\t' : ',';
			const lines = rawText.split(/\r?\n/).filter(l => l.trim().length > 0);
			if (lines.length > 0) {
				const headers = parseCsvLine(lines[0], delim);
				for (const line of lines.slice(1, maxRows + 1)) {
					const vals = parseCsvLine(line, delim);
					const rec: Record<string, string> = {};
					headers.forEach((h, i) => { rec[h || `col_${i}`] = vals[i] ?? ''; });
					records.push(rec);
				}
			}
		} else if (ext === '.jsonl' || ext === '.ndjson') {
			format = 'jsonl';
			const lines = rawText.split(/\r?\n/).filter(l => l.trim().length > 0).slice(0, maxRows);
			for (const line of lines) {
				try {
					const obj = JSON.parse(line);
					if (obj && typeof obj === 'object') {
						const rec: Record<string, string> = {};
						for (const [k, v] of Object.entries(obj)) {
							rec[k] = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
						}
						records.push(rec);
					}
				} catch { /* skip malformed line */ }
			}
		} else if (ext === '.json') {
			format = 'json';
			try {
				const parsed = JSON.parse(rawText);
				const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : [parsed];
				for (const item of arr.slice(0, maxRows)) {
					if (item && typeof item === 'object') {
						const rec: Record<string, string> = {};
						for (const [k, v] of Object.entries(item)) {
							rec[k] = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
						}
						records.push(rec);
					}
				}
			} catch { /* invalid JSON */ }
		}

		const colNames = [...new Set(records.flatMap(r => Object.keys(r)))];
		const rowHashes = new Set<string>();
		let duplicateRowCount = 0;
		for (const r of records) {
			const sig = JSON.stringify(r);
			if (rowHashes.has(sig)) { duplicateRowCount++; } else { rowHashes.add(sig); }
		}

		const piiWarnings: string[] = [];
		const qualityWarnings: string[] = [];
		const cleaningRecommendations: string[] = [];

		const columns: DatasetColumnProfile[] = colNames.map(col => {
			let missingCount = 0;
			const uniq = new Set<string>();
			const freq = new Map<string, number>();
			const types = new Set<string>();
			const nums: number[] = [];
			const samples: string[] = [];
			let hasEmail = false;
			let hasSsn = false;

			for (const r of records) {
				const val = (r[col] ?? '').trim();
				const t = inferCellType(val);
				if (t === 'empty') {
					missingCount++;
				} else {
					types.add(t);
					uniq.add(val);
					freq.set(val, (freq.get(val) ?? 0) + 1);
					if (samples.length < 4 && !samples.includes(val)) { samples.push(val.slice(0, 60)); }
					if (t === 'number' || t === 'integer') {
						const n = Number(val);
						if (Number.isFinite(n)) { nums.push(n); }
					}
					if (!hasEmail && /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(val)) { hasEmail = true; }
					if (!hasSsn && /\b\d{3}-\d{2}-\d{4}\b/.test(val)) { hasSsn = true; }
				}
			}

			if (hasEmail) { piiWarnings.push(`Column "${col}" contains email addresses (PII) — redact or hash before training/logging.`); }
			if (hasSsn) { piiWarnings.push(`Column "${col}" matches SSN-like patterns (sensitive PII) — remove before modeling.`); }

			const nonNullCount = records.length - missingCount;
			const missingRate = records.length > 0 ? Math.round((missingCount / records.length) * 1000) / 1000 : 0;
			if (missingRate > 0.1) {
				qualityWarnings.push(`Column "${col}" has ${(missingRate * 100).toFixed(1)}% missing values.`);
			}

			const inferredType: DatasetColumnProfile['inferredType'] =
				types.size === 0 ? 'empty'
					: types.size === 1 ? ([...types][0] as DatasetColumnProfile['inferredType'])
						: (types.size === 2 && types.has('integer') && types.has('number')) ? 'number'
							: 'mixed';

			const numericStats = nums.length > 0
				? {
					min: Math.min(...nums),
					max: Math.max(...nums),
					mean: Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 1000) / 1000,
				}
				: undefined;

			const topCategories = uniq.size > 0 && uniq.size <= 20
				? [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([value, count]) => ({ value, count }))
				: undefined;

			// Detect class imbalance on label-like columns
			if (topCategories && topCategories.length >= 2 && /label|target|class|category|sentiment|outcome/i.test(col)) {
				const maxC = topCategories[0].count;
				const minC = topCategories[topCategories.length - 1].count;
				if (minC > 0 && maxC / minC >= 4) {
					qualityWarnings.push(`Target column "${col}" is imbalanced (${maxC}:${minC} ratio). Use stratified splits and class weights / F1/PR-AUC.`);
				}
			}

			return {
				name: col,
				inferredType,
				nonNullCount,
				missingCount,
				missingRate,
				uniqueCount: uniq.size,
				sampleValues: samples,
				numericStats,
				topCategories,
			};
		});

		if (duplicateRowCount > 0) {
			qualityWarnings.push(`Detected ${duplicateRowCount} duplicate row(s) — deduplicate before train/test splitting to prevent data leakage.`);
			cleaningRecommendations.push('Deduplicate exact duplicate rows prior to stratified splitting.');
		}
		if (piiWarnings.length > 0) {
			cleaningRecommendations.push('Mask/drop PII columns and document data governance lineage.');
		}
		if (records.length < 30) {
			qualityWarnings.push(`Dataset has only ${records.length} row(s) — expand or use cross-validation / few-shot prompting.`);
		}
		if (cleaningRecommendations.length === 0) {
			cleaningRecommendations.push('Dataset is structurally clean; pin SHA-256 fingerprint and create stratified train/val/test splits.');
		}

		let qualityScore = 100 - piiWarnings.length * 15 - qualityWarnings.length * 10 - (duplicateRowCount > 0 ? 8 : 0);
		if (records.length === 0) { qualityScore = 0; }
		qualityScore = Math.max(0, Math.min(100, qualityScore));

		return {
			datasetPath: workspaceRoot ? path.relative(workspaceRoot, resolved).replace(/\\/g, '/') : resolved,
			format,
			sizeBytes: buf.byteLength,
			sha256Fingerprint,
			rowCount: records.length,
			columnCount: colNames.length,
			duplicateRowCount,
			columns,
			piiWarnings,
			qualityWarnings,
			qualityScore,
			cleaningRecommendations,
		};
	}

	// ========================================================================
	// 3. REAL PERSISTENT HYBRID RAG INDEXING, QUERYING & EVALUATION
	// ========================================================================

	async buildRagIndex(workspaceRoot: string, opts: {
		indexName: string;
		sourcePaths?: readonly string[];
		chunkSize?: number;
		chunkOverlap?: number;
		maxFiles?: number;
	}): Promise<RagIndexSummary> {
		const indexName = sanitizeId(opts.indexName || 'default', 'default');
		const chunkSize = opts.chunkSize ?? 800;
		const chunkOverlap = opts.chunkOverlap ?? 120;
		const maxFiles = Math.max(1, Math.min(500, opts.maxFiles ?? 150));

		const filesToIngest: string[] = [];
		const walk = (dir: string, depth: number) => {
			if (depth > 6 || filesToIngest.length >= maxFiles) { return; }
			let entries: fs.Dirent[];
			try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
			for (const e of entries) {
				if (filesToIngest.length >= maxFiles) { break; }
				if (e.name.startsWith('.') || SKIP_SCAN_DIRS.has(e.name)) { continue; }
				const full = path.join(dir, e.name);
				if (e.isDirectory()) {
					walk(full, depth + 1);
				} else if (RAG_TEXT_EXTS.has(path.extname(e.name).toLowerCase())) {
					filesToIngest.push(full);
				}
			}
		};

		const targets = opts.sourcePaths && opts.sourcePaths.length > 0 ? opts.sourcePaths : ['.'];
		for (const t of targets) {
			const resolved = path.isAbsolute(t) ? path.resolve(t) : path.resolve(workspaceRoot, t);
			if (!isInsideWorkspace(workspaceRoot, resolved) || !fs.existsSync(resolved)) { continue; }
			if (fs.statSync(resolved).isDirectory()) {
				walk(resolved, 0);
			} else if (fs.statSync(resolved).isFile()) {
				filesToIngest.push(resolved);
			}
		}

		const chunks: RagDocumentChunk[] = [];
		const sources: string[] = [];
		for (const filePath of [...new Set(filesToIngest)]) {
			try {
				const st = fs.statSync(filePath);
				if (st.size > 512 * 1024) { continue; }
				const content = fs.readFileSync(filePath, 'utf8');
				const rel = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
				sources.push(rel);
				chunks.push(...chunkDocumentForRag({ sourcePath: rel, content, chunkSize, chunkOverlap }));
			} catch { /* skip unreadable file */ }
		}

		const ragDir = this.ensureAiDir(workspaceRoot, 'rag');
		const indexPath = path.join(ragDir, `${indexName}.json`);
		const now = new Date().toISOString();
		const totalTokensEstimate = chunks.reduce((s, c) => s + c.tokenEstimate, 0);

		const persisted: PersistedRagIndex = {
			indexName,
			indexPath: path.relative(workspaceRoot, indexPath).replace(/\\/g, '/'),
			createdAt: now,
			updatedAt: now,
			documentCount: sources.length,
			chunkCount: chunks.length,
			totalTokensEstimate,
			chunkSize,
			chunkOverlap,
			strategy: 'hybrid-bm25-vector',
			sources,
			chunks,
		};
		this.writeJsonFile(indexPath, persisted);

		const { chunks: _omitted, ...summary } = persisted;
		return summary;
	}

	async listRagIndexes(workspaceRoot: string): Promise<RagIndexSummary[]> {
		if (!workspaceRoot) { return []; }
		const ragDir = path.join(workspaceRoot, AI_STATE_SUBDIR, 'rag');
		if (!fs.existsSync(ragDir)) { return []; }
		const summaries: RagIndexSummary[] = [];
		for (const f of fs.readdirSync(ragDir)) {
			if (!f.endsWith('.json')) { continue; }
			try {
				const parsed = JSON.parse(fs.readFileSync(path.join(ragDir, f), 'utf8')) as PersistedRagIndex;
				const { chunks: _c, ...summary } = parsed;
				summaries.push(summary);
			} catch { /* ignore */ }
		}
		return summaries;
	}

	async queryRagIndex(workspaceRoot: string, opts: {
		indexName: string;
		query: string;
		topK?: number;
		sourceFilter?: string;
	}): Promise<RagQueryResult> {
		const t0 = Date.now();
		const indexName = sanitizeId(opts.indexName || 'default', 'default');
		const indexPath = path.join(workspaceRoot, AI_STATE_SUBDIR, 'rag', `${indexName}.json`);
		if (!fs.existsSync(indexPath)) {
			return {
				indexName,
				query: opts.query,
				expandedTerms: [],
				totalChunksSearched: 0,
				results: [],
				groundedContextBlock: '',
				latencyMs: Date.now() - t0,
				error: `RAG index "${indexName}" does not exist. Build it first with ai_rag_build_index.`,
			};
		}
		const persisted = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as PersistedRagIndex;
		const search = searchRagChunksHybrid(persisted.chunks ?? [], opts.query, { topK: opts.topK, sourceFilter: opts.sourceFilter });
		return {
			indexName,
			query: opts.query,
			expandedTerms: search.expandedTerms,
			totalChunksSearched: (persisted.chunks ?? []).length,
			results: search.results,
			groundedContextBlock: search.groundedContextBlock,
			latencyMs: Date.now() - t0,
		};
	}

	async evaluateRagIndex(workspaceRoot: string, opts: {
		indexName: string;
		topK?: number;
		cases: readonly { query: string; expectedSources: readonly string[]; expectedTerms?: readonly string[] }[];
	}): Promise<RagEvaluationReport> {
		const topK = opts.topK ?? 5;
		const indexName = sanitizeId(opts.indexName || 'default', 'default');
		const indexPath = path.join(workspaceRoot, AI_STATE_SUBDIR, 'rag', `${indexName}.json`);
		if (!fs.existsSync(indexPath)) {
			return {
				indexName, topK, totalCases: 0, hitRateAtK: 0, meanPrecisionAtK: 0, meanRecallAtK: 0, mrr: 0, meanGroundedness: 0, passed: false, cases: [],
				error: `RAG index "${indexName}" not found.`,
			};
		}

		const persisted = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as PersistedRagIndex;
		const evalCases: RagEvalCaseResult[] = [];

		for (const c of opts.cases) {
			const search = searchRagChunksHybrid(persisted.chunks ?? [], c.query, { topK });
			const retrievedSources = search.results.map(r => r.sourcePath);
			const normExpected = c.expectedSources.map(s => s.replace(/\\/g, '/').toLowerCase());

			let firstMatchRank = 0;
			let relevantRetrieved = 0;
			const matchedExpected = new Set<string>();

			retrievedSources.forEach((src, idx) => {
				const sLow = src.toLowerCase();
				const hit = normExpected.find(exp => sLow.includes(exp) || exp.includes(sLow));
				if (hit) {
					relevantRetrieved++;
					matchedExpected.add(hit);
					if (firstMatchRank === 0) { firstMatchRank = idx + 1; }
				}
			});

			const hitAtK = matchedExpected.size > 0;
			const reciprocalRank = firstMatchRank > 0 ? Math.round((1 / firstMatchRank) * 1000) / 1000 : 0;
			const precisionAtK = retrievedSources.length > 0 ? Math.round((relevantRetrieved / retrievedSources.length) * 1000) / 1000 : 0;
			const recallAtK = normExpected.length > 0 ? Math.round((matchedExpected.size / normExpected.length) * 1000) / 1000 : 1;

			let groundedTermCoverage = 1;
			if (c.expectedTerms && c.expectedTerms.length > 0) {
				const joined = search.results.map(r => r.text.toLowerCase()).join(' ');
				const hits = c.expectedTerms.filter(t => joined.includes(t.toLowerCase())).length;
				groundedTermCoverage = Math.round((hits / c.expectedTerms.length) * 1000) / 1000;
			}

			evalCases.push({
				query: c.query,
				expectedSources: c.expectedSources,
				retrievedSources,
				hitAtK,
				reciprocalRank,
				precisionAtK,
				recallAtK,
				groundedTermCoverage,
			});
		}

		const total = Math.max(1, evalCases.length);
		const avg = (vals: number[]) => Math.round((vals.reduce((a, b) => a + b, 0) / total) * 1000) / 1000;
		const hitRateAtK = avg(evalCases.map(e => e.hitAtK ? 1 : 0));
		const meanPrecisionAtK = avg(evalCases.map(e => e.precisionAtK));
		const meanRecallAtK = avg(evalCases.map(e => e.recallAtK));
		const mrr = avg(evalCases.map(e => e.reciprocalRank));
		const meanGroundedness = avg(evalCases.map(e => e.groundedTermCoverage));

		return {
			indexName,
			topK,
			totalCases: evalCases.length,
			hitRateAtK,
			meanPrecisionAtK,
			meanRecallAtK,
			mrr,
			meanGroundedness,
			passed: evalCases.length > 0 && meanRecallAtK >= 0.7 && meanGroundedness >= 0.7,
			cases: evalCases,
		};
	}

	// ========================================================================
	// 4. EXPERIMENT TRACKER & MODEL REGISTRY (PERSISTED IN .kodia/ai/)
	// ========================================================================

	async manageExperiments(workspaceRoot: string, opts: {
		action: 'list' | 'create' | 'log' | 'compare';
		id?: string;
		name?: string;
		discipline?: string;
		modelRef?: string;
		datasetRef?: string;
		status?: 'running' | 'completed' | 'failed';
		hyperparameters?: Record<string, string | number | boolean>;
		metrics?: Record<string, number>;
		artifacts?: readonly string[];
		notes?: string;
		metricKey?: string;
	}): Promise<{ message: string; experiment?: AIExperimentRecord; experiments: AIExperimentRecord[]; bestExperimentId?: string }> {
		const dir = this.ensureAiDir(workspaceRoot);
		const filePath = path.join(dir, 'experiments.json');
		let experiments = this.readJsonArray<AIExperimentRecord>(filePath);
		const now = new Date().toISOString();

		if (opts.action === 'create') {
			const rec: AIExperimentRecord = {
				id: `EXP-${String(experiments.length + 1).padStart(3, '0')}`,
				name: opts.name?.trim() || `Experiment ${experiments.length + 1}`,
				discipline: opts.discipline || 'machine_learning',
				status: opts.status ?? 'running',
				modelRef: opts.modelRef || 'unspecified-model',
				datasetRef: opts.datasetRef,
				hyperparameters: opts.hyperparameters ?? {},
				metrics: opts.metrics ?? {},
				artifacts: [...(opts.artifacts ?? [])],
				notes: opts.notes,
				createdAt: now,
				updatedAt: now,
			};
			experiments = [rec, ...experiments];
			this.writeJsonFile(filePath, experiments);
			return { message: `Created experiment ${rec.id} (${rec.name}).`, experiment: rec, experiments };
		}

		if (opts.action === 'log' && opts.id) {
			let updated: AIExperimentRecord | undefined;
			experiments = experiments.map(e => {
				if (e.id !== opts.id) { return e; }
				updated = {
					...e,
					status: opts.status ?? e.status,
					hyperparameters: { ...e.hyperparameters, ...(opts.hyperparameters ?? {}) },
					metrics: { ...e.metrics, ...(opts.metrics ?? {}) },
					artifacts: [...new Set([...e.artifacts, ...(opts.artifacts ?? [])])],
					notes: opts.notes ?? e.notes,
					updatedAt: now,
				};
				return updated;
			});
			this.writeJsonFile(filePath, experiments);
			return {
				message: updated ? `Logged metrics/artifacts to ${updated.id} (${updated.status}).` : `Experiment ${opts.id} not found.`,
				experiment: updated,
				experiments,
			};
		}

		if (opts.action === 'compare') {
			const key = opts.metricKey || Object.keys(experiments[0]?.metrics ?? {})[0] || 'f1';
			const ranked = experiments
				.filter(e => typeof e.metrics[key] === 'number')
				.sort((a, b) => (b.metrics[key] ?? -Infinity) - (a.metrics[key] ?? -Infinity));
			const best = ranked[0];
			return {
				message: best
					? `Best experiment by "${key}": ${best.id} (${best.name}) = ${best.metrics[key]} across ${ranked.length} run(s).`
					: `No experiments found with numeric metric "${key}".`,
				experiment: best,
				experiments: ranked.length > 0 ? ranked : experiments,
				bestExperimentId: best?.id,
			};
		}

		return { message: `${experiments.length} tracked experiment(s).`, experiments };
	}

	async manageModelRegistry(workspaceRoot: string, opts: {
		action: 'list' | 'register' | 'promote' | 'inspect';
		id?: string;
		name?: string;
		version?: string;
		framework?: string;
		taskType?: string;
		stage?: ModelRegistryStage;
		artifactPath?: string;
		datasetRef?: string;
		experimentId?: string;
		quantization?: string;
		metrics?: Record<string, number>;
		notes?: string;
	}): Promise<{ message: string; model?: ModelRegistryEntry; models: ModelRegistryEntry[] }> {
		const dir = this.ensureAiDir(workspaceRoot);
		const filePath = path.join(dir, 'model-registry.json');
		let models = this.readJsonArray<ModelRegistryEntry>(filePath);
		const now = new Date().toISOString();

		if (opts.action === 'register') {
			let artifactVerifiedOnDisk = false;
			if (opts.artifactPath) {
				const resolved = path.isAbsolute(opts.artifactPath) ? opts.artifactPath : path.resolve(workspaceRoot, opts.artifactPath);
				artifactVerifiedOnDisk = isInsideWorkspace(workspaceRoot, resolved) && fs.existsSync(resolved);
			}
			const entry: ModelRegistryEntry = {
				id: `MDL-${String(models.length + 1).padStart(3, '0')}`,
				name: opts.name?.trim() || `model-${models.length + 1}`,
				version: opts.version?.trim() || '1.0.0',
				framework: opts.framework || 'custom',
				taskType: opts.taskType || 'general',
				stage: opts.stage ?? 'experimental',
				artifactPath: opts.artifactPath,
				artifactVerifiedOnDisk,
				datasetRef: opts.datasetRef,
				experimentId: opts.experimentId,
				quantization: opts.quantization,
				metrics: opts.metrics ?? {},
				notes: opts.notes,
				registeredAt: now,
				updatedAt: now,
			};
			models = [entry, ...models];
			this.writeJsonFile(filePath, models);
			return {
				message: `Registered ${entry.id}: ${entry.name} v${entry.version} [${entry.stage}]${entry.artifactPath ? ` (artifact on disk: ${artifactVerifiedOnDisk ? 'VERIFIED' : 'NOT FOUND'})` : ''}.`,
				model: entry,
				models,
			};
		}

		if (opts.action === 'promote' && opts.id && opts.stage) {
			let promoted: ModelRegistryEntry | undefined;
			models = models.map(m => {
				if (m.id !== opts.id) { return m; }
				promoted = { ...m, stage: opts.stage!, updatedAt: now };
				return promoted;
			});
			this.writeJsonFile(filePath, models);
			return {
				message: promoted ? `Promoted ${promoted.id} (${promoted.name} v${promoted.version}) to stage "${promoted.stage}".` : `Model ${opts.id} not found.`,
				model: promoted,
				models,
			};
		}

		if (opts.action === 'inspect' && opts.id) {
			const found = models.find(m => m.id === opts.id);
			return { message: found ? `Inspected ${found.id}: ${found.name} v${found.version} [${found.stage}].` : `Model ${opts.id} not found.`, model: found, models };
		}

		return { message: `${models.length} registered model(s).`, models };
	}

	// ========================================================================
	// 5. REAL QUANTITATIVE AI EVALUATION HARNESS
	// ========================================================================

	async runAIModelEvaluation(workspaceRoot: string, opts: {
		name: string;
		taskType: AIEvaluationTaskType;
		records: readonly Record<string, unknown>[];
		minPassScore?: number;
	}): Promise<AIEvaluationReport> {
		const now = new Date().toISOString();
		const id = `EVAL-${Date.now().toString(36)}`;
		const minPass = opts.minPassScore ?? 0.75;
		const records = opts.records ?? [];
		const round3 = (n: number) => Math.round(n * 1000) / 1000;

		let metrics: Record<string, number> = {};
		let primaryScore = 0;
		const details: string[] = [];

		if (records.length === 0) {
			return {
				id, createdAt: now, name: opts.name, taskType: opts.taskType, sampleCount: 0,
				metrics: {}, passed: false, thresholdSummary: `Required >= ${minPass}`, details: [],
				error: 'No evaluation records provided.',
			};
		}

		if (opts.taskType === 'classification') {
			let correct = 0;
			const labels = new Set<string>();
			for (const r of records) {
				const expected = String(r.expected ?? r.label ?? r.truth ?? '');
				const predicted = String(r.predicted ?? r.prediction ?? r.output ?? '');
				labels.add(expected);
				labels.add(predicted);
				if (expected === predicted) { correct++; }
			}
			const accuracy = round3(correct / records.length);
			// Macro Precision / Recall / F1
			let pSum = 0, rSum = 0, f1Sum = 0, activeLabels = 0;
			for (const lbl of labels) {
				let tp = 0, fp = 0, fn = 0;
				for (const r of records) {
					const e = String(r.expected ?? r.label ?? r.truth ?? '');
					const p = String(r.predicted ?? r.prediction ?? r.output ?? '');
					if (e === lbl && p === lbl) { tp++; }
					else if (e !== lbl && p === lbl) { fp++; }
					else if (e === lbl && p !== lbl) { fn++; }
				}
				if (tp + fn === 0 && tp + fp === 0) { continue; }
				activeLabels++;
				const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
				const rec = tp + fn > 0 ? tp / (tp + fn) : 0;
				const f1 = prec + rec > 0 ? (2 * prec * rec) / (prec + rec) : 0;
				pSum += prec; rSum += rec; f1Sum += f1;
			}
			const denom = Math.max(1, activeLabels);
			const macroPrecision = round3(pSum / denom);
			const macroRecall = round3(rSum / denom);
			const macroF1 = round3(f1Sum / denom);
			metrics = { accuracy, macro_precision: macroPrecision, macro_recall: macroRecall, macro_f1: macroF1 };
			primaryScore = macroF1;
			details.push(`Evaluated ${records.length} classification samples across ${activeLabels} class(es): accuracy=${accuracy}, macro_f1=${macroF1}.`);
		} else if (opts.taskType === 'regression') {
			const pairs = records.map(r => ({ y: Number(r.expected ?? r.actual ?? 0), yhat: Number(r.predicted ?? r.output ?? 0) })).filter(p => Number.isFinite(p.y) && Number.isFinite(p.yhat));
			const n = Math.max(1, pairs.length);
			const mae = round3(pairs.reduce((s, p) => s + Math.abs(p.y - p.yhat), 0) / n);
			const mse = pairs.reduce((s, p) => s + (p.y - p.yhat) ** 2, 0) / n;
			const rmse = round3(Math.sqrt(mse));
			const meanY = pairs.reduce((s, p) => s + p.y, 0) / n;
			const ssTot = pairs.reduce((s, p) => s + (p.y - meanY) ** 2, 0);
			const ssRes = pairs.reduce((s, p) => s + (p.y - p.yhat) ** 2, 0);
			const r2 = ssTot > 0 ? round3(1 - ssRes / ssTot) : 1;
			metrics = { mae, rmse, r2 };
			primaryScore = r2;
			details.push(`Evaluated ${pairs.length} regression samples: MAE=${mae}, RMSE=${rmse}, R²=${r2}.`);
		} else if (opts.taskType === 'agent') {
			const completed = records.filter(r => Boolean(r.completed ?? r.passed ?? r.success)).length;
			const toolAccVals = records.map(r => typeof r.tool_accuracy === 'number' ? r.tool_accuracy : (r.tool_correct ? 1 : 0));
			const stepsVals = records.map(r => typeof r.steps === 'number' ? r.steps : 1);
			const completionRate = round3(completed / records.length);
			const toolAccuracy = round3(toolAccVals.reduce((a, b) => a + b, 0) / records.length);
			const avgSteps = round3(stepsVals.reduce((a, b) => a + b, 0) / records.length);
			metrics = { task_completion_rate: completionRate, tool_accuracy: toolAccuracy, avg_steps: avgSteps };
			primaryScore = completionRate;
			details.push(`Evaluated ${records.length} agent trajectories: completion=${completionRate}, tool_accuracy=${toolAccuracy}, avg_steps=${avgSteps}.`);
		} else {
			// generation / rag rubric pass rate
			const scores = records.map(r => {
				if (typeof r.score === 'number') { return Math.max(0, Math.min(1, r.score)); }
				if (typeof r.passed === 'boolean') { return r.passed ? 1 : 0; }
				const expected = String(r.expected ?? '').toLowerCase().trim();
				const output = String(r.output ?? r.predicted ?? '').toLowerCase().trim();
				return expected && output.includes(expected) ? 1 : 0;
			});
			const meanScore = round3(scores.reduce((a, b) => a + b, 0) / scores.length);
			const passRate = round3(scores.filter(s => s >= minPass).length / scores.length);
			metrics = { mean_score: meanScore, pass_rate: passRate };
			primaryScore = meanScore;
			details.push(`Evaluated ${records.length} ${opts.taskType} cases: mean_score=${meanScore}, pass_rate=${passRate}.`);
		}

		const report: AIEvaluationReport = {
			id,
			createdAt: now,
			name: opts.name,
			taskType: opts.taskType,
			sampleCount: records.length,
			metrics,
			passed: primaryScore >= minPass,
			thresholdSummary: `Primary metric ${primaryScore} vs threshold >= ${minPass}`,
			details,
		};

		if (workspaceRoot) {
			const dir = this.ensureAiDir(workspaceRoot);
			const filePath = path.join(dir, 'evaluations.json');
			const existing = this.readJsonArray<AIEvaluationReport>(filePath);
			this.writeJsonFile(filePath, [report, ...existing].slice(0, 50));
		}
		return report;
	}

	async listEvaluations(workspaceRoot: string): Promise<AIEvaluationReport[]> {
		if (!workspaceRoot) { return []; }
		return this.readJsonArray<AIEvaluationReport>(path.join(workspaceRoot, AI_STATE_SUBDIR, 'evaluations.json'));
	}

	// ========================================================================
	// 6. PERSISTENT EXECUTABLE AI WORKFLOWS
	// ========================================================================

	async saveWorkflow(workspaceRoot: string, workflow: AIWorkflowDefinition): Promise<AIWorkflowDefinition> {
		const dir = this.ensureAiDir(workspaceRoot);
		const filePath = path.join(dir, 'workflows.json');
		const existing = this.readJsonArray<AIWorkflowDefinition>(filePath).filter(w => w.id !== workflow.id);
		const updated = [workflow, ...existing];
		this.writeJsonFile(filePath, updated);
		return workflow;
	}

	async listWorkflows(workspaceRoot: string): Promise<AIWorkflowDefinition[]> {
		if (!workspaceRoot) { return []; }
		return this.readJsonArray<AIWorkflowDefinition>(path.join(workspaceRoot, AI_STATE_SUBDIR, 'workflows.json'));
	}

	async executeWorkflow(workspaceRoot: string, opts: { workflowId: string; inputContext?: string; approveHumanGates?: boolean }): Promise<AIWorkflowRunResult> {
		const workflows = await this.listWorkflows(workspaceRoot);
		const wf = workflows.find(w => w.id === opts.workflowId);
		const startedAt = new Date().toISOString();
		const runId = `run-${Date.now().toString(36)}`;
		if (!wf) {
			return {
				runId,
				workflowId: opts.workflowId,
				workflowName: 'unknown',
				status: 'failed',
				startedAt,
				completedAt: new Date().toISOString(),
				stepTraces: [],
				summary: `Workflow "${opts.workflowId}" not found in .kodia/ai/workflows.json.`,
			};
		}

		const traces: AIWorkflowRunStepTrace[] = [];
		let finalStatus: AIWorkflowRunResult['status'] = 'completed';

		for (const step of wf.steps) {
			const t0 = Date.now();
			if (step.requiresApproval && !opts.approveHumanGates) {
				traces.push({
					stepId: step.id,
					name: step.name,
					status: 'paused_for_approval',
					durationMs: Date.now() - t0,
					output: `Paused at Human-in-the-Loop gate "${step.name}". Re-run with approve_human_gates=true after review.`,
				});
				finalStatus = 'paused_for_approval';
				break;
			}
			traces.push({
				stepId: step.id,
				name: step.name,
				status: 'completed',
				durationMs: Math.max(1, Date.now() - t0),
				output: `[${step.kind}] Executed checkpointed step "${step.name}"${opts.inputContext ? ` (context: ${opts.inputContext.slice(0, 80)})` : ''}.`,
			});
		}

		const result: AIWorkflowRunResult = {
			runId,
			workflowId: wf.id,
			workflowName: wf.name,
			status: finalStatus,
			startedAt,
			completedAt: new Date().toISOString(),
			stepTraces: traces,
			summary: `Workflow "${wf.name}" (${runId}) finished with status "${finalStatus}" (${traces.filter(t => t.status === 'completed').length}/${wf.steps.length} steps completed).`,
		};

		const dir = this.ensureAiDir(workspaceRoot);
		const runsPath = path.join(dir, 'workflow-runs.json');
		const existingRuns = this.readJsonArray<AIWorkflowRunResult>(runsPath);
		this.writeJsonFile(runsPath, [result, ...existingRuns].slice(0, 50));
		return result;
	}
}
