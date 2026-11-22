/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from '../../../../base/common/path.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	DbColumnInfo,
	DbInspectReport,
	DbQueryReport,
	DbTableInfo,
	DockerContainerInfo,
	DockerLogsReport,
	DockerStatusReport,
	EnvInspectReport,
	EnvToolchainEntry,
	IKodiaOpsMainService,
	isReadOnlySqlQuery,
	isValidDockerContainerName,
} from '../common/kodiaOpsTypes.js';

const MAX_SQL_ROWS = 200;

function runExecFile(bin: string, args: string[], timeoutMs = 4000, cwd?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	return new Promise(resolve => {
		try {
			cp.execFile(bin, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
				resolve({
					ok: !err,
					stdout: String(stdout ?? '').trim(),
					stderr: String(stderr ?? (err?.message ?? '')).trim(),
				});
			});
		} catch (e) {
			resolve({ ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) });
		}
	});
}

function discoverSqliteFiles(workspaceRoot: string): string[] {
	const candidates = [
		path.join(workspaceRoot, 'database', 'database.sqlite'),
		path.join(workspaceRoot, 'prisma', 'dev.db'),
		path.join(workspaceRoot, 'db.sqlite3'),
		path.join(workspaceRoot, 'app.db'),
		path.join(workspaceRoot, 'data.db'),
	];
	const found: string[] = [];
	for (const c of candidates) {
		if (fs.existsSync(c) && fs.statSync(c).isFile()) {
			found.push(c);
		}
	}
	if (found.length === 0) {
		try {
			for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
				if (entry.isFile() && /\.(?:sqlite|sqlite3|db)$/i.test(entry.name)) {
					found.push(path.join(workspaceRoot, entry.name));
				}
			}
		} catch { /* ignore unreadable dir */ }
	}
	return found;
}

function readEnvDatabaseHints(workspaceRoot: string): string[] {
	const hints: string[] = [];
	for (const envName of ['.env', '.env.example']) {
		const envPath = path.join(workspaceRoot, envName);
		if (!fs.existsSync(envPath)) { continue; }
		try {
			const content = fs.readFileSync(envPath, 'utf8');
			for (const line of content.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith('#')) { continue; }
				const m = /^(DB_CONNECTION|DB_HOST|DB_PORT|DB_DATABASE|DATABASE_URL)\s*=\s*(.+)$/.exec(trimmed);
				if (!m) { continue; }
				const key = m[1];
				let val = m[2].trim().replace(/^['"]|['"]$/g, '');
				if (key === 'DATABASE_URL') {
					// Redact credentials in connection strings like postgres://user:pass@host/db
					val = val.replace(/:\/\/[^/@]+@/, '://[REDACTED]@');
				}
				hints.push(`${envName}:${key}=${val}`);
			}
		} catch { /* ignore */ }
	}
	return hints;
}

interface SqliteDatabaseHandle {
	all(sql: string, cb: (err: Error | null, rows: Record<string, unknown>[]) => void): void;
	run(sql: string, cb: (this: { changes?: number }, err: Error | null) => void): void;
	close(cb: (err: Error | null) => void): void;
}

interface SqliteModule {
	OPEN_READONLY: number;
	OPEN_READWRITE: number;
	OPEN_CREATE: number;
	Database: new (filename: string, mode: number, cb: (err: Error | null) => void) => SqliteDatabaseHandle;
	default?: SqliteModule;
}

async function openSqliteDb(dbPath: string, readOnly: boolean): Promise<{
	all(sql: string): Promise<Record<string, unknown>[]>;
	run(sql: string): Promise<{ changes: number }>;
	close(): Promise<void>;
}> {
	const sqlite3Mod = await import('@vscode/sqlite3') as unknown as SqliteModule;
	const sqlite3 = sqlite3Mod.default ?? sqlite3Mod;
	const mode = readOnly ? sqlite3.OPEN_READONLY : (sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
	const db = await new Promise<SqliteDatabaseHandle>((resolve, reject) => {
		const inst = new sqlite3.Database(dbPath, mode, (err: Error | null) => {
			if (err) { reject(err); }
			else { resolve(inst); }
		});
	});
	return {
		all: (sql: string) => new Promise((resolve, reject) => {
			db.all(sql, (err: Error | null, rows: Record<string, unknown>[]) => {
				if (err) { reject(err); }
				else { resolve(rows ?? []); }
			});
		}),
		run: (sql: string) => new Promise((resolve, reject) => {
			db.run(sql, function (this: { changes?: number }, err: Error | null) {
				if (err) { reject(err); }
				else { resolve({ changes: this?.changes ?? 0 }); }
			});
		}),
		close: () => new Promise(resolve => {
			db.close(() => resolve());
		}),
	};
}

export class KodiaOpsMainService extends Disposable implements IKodiaOpsMainService {
	readonly _serviceBrand: undefined;

	async inspectEnvironment(workspaceRoot: string): Promise<EnvInspectReport> {
		const probes: readonly { name: string; bin: string; args: string[] }[] = [
			{ name: 'git', bin: 'git', args: ['--version'] },
			{ name: 'node', bin: 'node', args: ['-v'] },
			{ name: 'npm', bin: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['-v'] },
			{ name: 'pnpm', bin: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args: ['-v'] },
			{ name: 'python', bin: process.platform === 'win32' ? 'python' : 'python3', args: ['--version'] },
			{ name: 'php', bin: 'php', args: ['-v'] },
			{ name: 'composer', bin: 'composer', args: ['--version'] },
			{ name: 'go', bin: 'go', args: ['version'] },
			{ name: 'cargo', bin: 'cargo', args: ['--version'] },
			{ name: 'docker', bin: 'docker', args: ['--version'] },
		];

		const toolchains: EnvToolchainEntry[] = await Promise.all(
			probes.map(async p => {
				const res = await runExecFile(p.bin, p.args, 3000);
				if (!res.ok) { return { name: p.name, available: false }; }
				const firstLine = (res.stdout || res.stderr).split(/\r?\n/)[0]?.trim() ?? '';
				return { name: p.name, available: true, version: firstLine.slice(0, 80) };
			})
		);

		const manifestCandidates = [
			'package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock',
			'composer.json', 'artisan', 'pyproject.toml', 'requirements.txt',
			'Cargo.toml', 'go.mod', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml',
		];
		const detectedManifests = workspaceRoot && fs.existsSync(workspaceRoot)
			? manifestCandidates.filter(m => fs.existsSync(path.join(workspaceRoot, m)))
			: [];

		const detectedEnvDatabases = workspaceRoot && fs.existsSync(workspaceRoot)
			? readEnvDatabaseHints(workspaceRoot)
			: [];

		return {
			platform: process.platform,
			arch: process.arch,
			nodeVersion: process.version,
			cpuCount: os.cpus().length,
			totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
			freeMemoryMb: Math.round(os.freemem() / (1024 * 1024)),
			toolchains,
			detectedManifests,
			detectedEnvDatabases,
		};
	}

	async getDockerStatus(workspaceRoot: string): Promise<DockerStatusReport> {
		const composeFiles = workspaceRoot && fs.existsSync(workspaceRoot)
			? ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].filter(f => fs.existsSync(path.join(workspaceRoot, f)))
			: [];

		const ver = await runExecFile('docker', ['--version'], 3000);
		if (!ver.ok) {
			return { available: false, reason: 'Docker CLI is not installed or not in PATH.', containers: [], composeFiles };
		}

		const ps = await runExecFile('docker', ['ps', '-a', '--format', '{{json .}}'], 5000, workspaceRoot || undefined);
		if (!ps.ok) {
			return {
				available: false,
				version: ver.stdout.split(/\r?\n/)[0],
				reason: ps.stderr || 'Docker daemon is not running.',
				containers: [],
				composeFiles,
			};
		}

		const containers: DockerContainerInfo[] = [];
		for (const line of ps.stdout.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) { continue; }
			try {
				const c = JSON.parse(trimmed) as Record<string, string>;
				containers.push({
					id: c.ID ?? '',
					name: c.Names ?? '',
					image: c.Image ?? '',
					state: c.State ?? '',
					status: c.Status ?? '',
					ports: c.Ports ?? '',
				});
			} catch { /* skip malformed line */ }
		}

		return {
			available: true,
			version: ver.stdout.split(/\r?\n/)[0],
			containers,
			composeFiles,
		};
	}

	async getDockerLogs(container: string, tail = 100): Promise<DockerLogsReport> {
		const cleanName = container.trim();
		if (!isValidDockerContainerName(cleanName)) {
			return { available: false, container: cleanName, logs: '', error: `Invalid container name or ID: "${cleanName}".` };
		}
		const safeTail = Math.max(1, Math.min(Math.round(tail || 100), 1000));
		const res = await runExecFile('docker', ['logs', '--tail', String(safeTail), cleanName], 8000);
		if (!res.ok) {
			return { available: false, container: cleanName, logs: '', error: res.stderr || 'Failed to read Docker container logs.' };
		}
		const combined = [res.stdout, res.stderr].filter(Boolean).join('\n');
		return { available: true, container: cleanName, logs: combined.slice(-32_000) };
	}

	async inspectDatabase(workspaceRoot: string, dbPath?: string): Promise<DbInspectReport> {
		const envHints = workspaceRoot && fs.existsSync(workspaceRoot) ? readEnvDatabaseHints(workspaceRoot) : [];
		let resolvedPath: string | undefined;
		if (dbPath && dbPath.trim()) {
			resolvedPath = path.isAbsolute(dbPath.trim()) ? dbPath.trim() : path.join(workspaceRoot, dbPath.trim());
		} else if (workspaceRoot) {
			resolvedPath = discoverSqliteFiles(workspaceRoot)[0];
		}

		if (!resolvedPath || !fs.existsSync(resolvedPath)) {
			return {
				engine: envHints.length > 0 ? 'detected-env' : 'none',
				envHints,
				tables: [],
			};
		}

		let db;
		try {
			db = await openSqliteDb(resolvedPath, true);
			const tableRows = await db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
			const tables: DbTableInfo[] = [];
			for (const tr of tableRows.slice(0, 60)) {
				const tableName = String(tr.name ?? '');
				if (!tableName) { continue; }
				const safeIdent = `"${tableName.replace(/"/g, '""')}"`;
				const pragmaCols = await db.all(`PRAGMA table_info(${safeIdent})`);
				const columns: DbColumnInfo[] = pragmaCols.map(c => ({
					name: String(c.name ?? ''),
					type: String(c.type ?? ''),
					notNull: Boolean(c.notnull),
					primaryKey: Boolean(c.pk),
				}));
				let rowCount: number | null = null;
				try {
					const cnt = await db.all(`SELECT COUNT(*) AS c FROM ${safeIdent}`);
					rowCount = Number(cnt[0]?.c ?? 0);
				} catch { /* ignore */ }
				tables.push({ name: tableName, rowCount, columns });
			}
			return { engine: 'sqlite', databasePath: resolvedPath, envHints, tables };
		} catch (err) {
			return {
				engine: 'sqlite',
				databasePath: resolvedPath,
				envHints,
				tables: [],
				error: err instanceof Error ? err.message : String(err),
			};
		} finally {
			await db?.close();
		}
	}

	async queryDatabase(workspaceRoot: string, sql: string, dbPath?: string, allowWrite = false): Promise<DbQueryReport> {
		const startedAt = Date.now();
		let resolvedPath: string | undefined;
		if (dbPath && dbPath.trim()) {
			resolvedPath = path.isAbsolute(dbPath.trim()) ? dbPath.trim() : path.join(workspaceRoot, dbPath.trim());
		} else if (workspaceRoot) {
			resolvedPath = discoverSqliteFiles(workspaceRoot)[0];
		}

		if (!resolvedPath || !fs.existsSync(resolvedPath)) {
			return {
				databasePath: resolvedPath ?? '',
				readOnly: !allowWrite,
				columns: [],
				rows: [],
				rowCount: 0,
				truncated: false,
				durationMs: Date.now() - startedAt,
				error: 'No SQLite database file found. Pass db_path explicitly or ensure a .sqlite/.db file exists.',
			};
		}

		const readOnly = isReadOnlySqlQuery(sql);
		if (!readOnly && !allowWrite) {
			return {
				databasePath: resolvedPath,
				readOnly: true,
				columns: [],
				rows: [],
				rowCount: 0,
				truncated: false,
				durationMs: Date.now() - startedAt,
				error: 'Refused non-read-only SQL query while allow_write is false. Only SELECT/EXPLAIN/read-PRAGMA queries are allowed by default.',
			};
		}

		let db;
		try {
			db = await openSqliteDb(resolvedPath, !allowWrite);
			if (readOnly) {
				const allRows = await db.all(sql);
				const truncated = allRows.length > MAX_SQL_ROWS;
				const rows = truncated ? allRows.slice(0, MAX_SQL_ROWS) : allRows;
				const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
				return {
					databasePath: resolvedPath,
					readOnly: true,
					columns,
					rows,
					rowCount: allRows.length,
					truncated,
					durationMs: Date.now() - startedAt,
				};
			} else {
				const res = await db.run(sql);
				return {
					databasePath: resolvedPath,
					readOnly: false,
					columns: ['changes'],
					rows: [{ changes: res.changes }],
					rowCount: res.changes,
					truncated: false,
					durationMs: Date.now() - startedAt,
				};
			}
		} catch (err) {
			return {
				databasePath: resolvedPath,
				readOnly: !allowWrite,
				columns: [],
				rows: [],
				rowCount: 0,
				truncated: false,
				durationMs: Date.now() - startedAt,
				error: err instanceof Error ? err.message : String(err),
			};
		} finally {
			await db?.close();
		}
	}
}
