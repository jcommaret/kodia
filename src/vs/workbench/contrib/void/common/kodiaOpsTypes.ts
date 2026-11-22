/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const KODIA_OPS_CHANNEL = 'void-channel-ops';

export interface EnvToolchainEntry {
	readonly name: string;
	readonly available: boolean;
	readonly version?: string;
}

export interface EnvInspectReport {
	readonly platform: string;
	readonly arch: string;
	readonly nodeVersion: string;
	readonly cpuCount: number;
	readonly totalMemoryMb: number;
	readonly freeMemoryMb: number;
	readonly toolchains: EnvToolchainEntry[];
	readonly detectedManifests: string[];
	readonly detectedEnvDatabases: string[];
}

export interface DockerContainerInfo {
	readonly id: string;
	readonly name: string;
	readonly image: string;
	readonly state: string;
	readonly status: string;
	readonly ports: string;
}

export interface DockerStatusReport {
	readonly available: boolean;
	readonly version?: string;
	readonly reason?: string;
	readonly containers: DockerContainerInfo[];
	readonly composeFiles: string[];
}

export interface DockerLogsReport {
	readonly available: boolean;
	readonly container: string;
	readonly logs: string;
	readonly error?: string;
}

export interface DbColumnInfo {
	readonly name: string;
	readonly type: string;
	readonly notNull: boolean;
	readonly primaryKey: boolean;
}

export interface DbTableInfo {
	readonly name: string;
	readonly rowCount: number | null;
	readonly columns: DbColumnInfo[];
}

export interface DbInspectReport {
	readonly engine: 'sqlite' | 'detected-env' | 'none';
	readonly databasePath?: string;
	readonly envHints: string[];
	readonly tables: DbTableInfo[];
	readonly error?: string;
}

export interface DbQueryReport {
	readonly databasePath: string;
	readonly readOnly: boolean;
	readonly columns: string[];
	readonly rows: Record<string, unknown>[];
	readonly rowCount: number;
	readonly truncated: boolean;
	readonly durationMs: number;
	readonly error?: string;
}

export const IKodiaOpsMainService = createDecorator<IKodiaOpsMainService>('kodiaOpsMainService');

export interface IKodiaOpsMainService {
	readonly _serviceBrand: undefined;
	inspectEnvironment(workspaceRoot: string): Promise<EnvInspectReport>;
	getDockerStatus(workspaceRoot: string): Promise<DockerStatusReport>;
	getDockerLogs(container: string, tail?: number): Promise<DockerLogsReport>;
	inspectDatabase(workspaceRoot: string, dbPath?: string): Promise<DbInspectReport>;
	queryDatabase(workspaceRoot: string, sql: string, dbPath?: string, allowWrite?: boolean): Promise<DbQueryReport>;
}

/**
 * Strictly validate a Docker container name or ID to prevent CLI option/shell injection.
 */
export function isValidDockerContainerName(name: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name.trim());
}

/**
 * Determine whether a SQL statement is strictly read-only (SELECT, WITH...SELECT, PRAGMA read, EXPLAIN).
 * Rejects stacked multi-statements and any mutating DDL/DML keywords.
 */
export function isReadOnlySqlQuery(sql: string): boolean {
	// Strip line and block comments before inspecting statements
	const stripped = sql
		.replace(/--[^\r\n]*/g, ' ')
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.trim()
		.replace(/;+\s*$/, '');
	if (!stripped) { return false; }
	// Reject stacked statements (any remaining semicolon outside quotes)
	const withoutStrings = stripped.replace(/'(?:''|[^'])*'/g, '\'\'').replace(/"(?:""|[^"])*"/g, '""');
	if (withoutStrings.includes(';')) { return false; }

	const upper = withoutStrings.trim().toUpperCase();
	if (/^(?:SELECT|EXPLAIN)\b/.test(upper)) {
		return !/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|ATTACH|DETACH|VACUUM|REINDEX)\b/.test(upper);
	}
	if (/^WITH\b/.test(upper)) {
		return !/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|ATTACH|DETACH)\b/.test(upper);
	}
	if (/^PRAGMA\b/.test(upper)) {
		// Disallow PRAGMA assignments like PRAGMA writable_schema = ON
		return !upper.includes('=');
	}
	return false;
}

export function formatEnvInspectForLLM(r: EnvInspectReport): string {
	const available = r.toolchains.filter(t => t.available).map(t => `${t.name}${t.version ? ` (${t.version})` : ''}`);
	const missing = r.toolchains.filter(t => !t.available).map(t => t.name);
	return [
		`Environment: ${r.platform}/${r.arch} | Node ${r.nodeVersion} | ${r.cpuCount} CPUs | ${r.freeMemoryMb}/${r.totalMemoryMb} MB RAM free`,
		`Available toolchains: ${available.join(', ') || 'none'}`,
		`Not installed: ${missing.join(', ') || 'none'}`,
		`Workspace manifests: ${r.detectedManifests.join(', ') || 'none'}`,
		...(r.detectedEnvDatabases.length ? [`Database config hints (.env, secrets redacted): ${r.detectedEnvDatabases.join(', ')}`] : []),
	].join('\n');
}

export function formatDockerStatusForLLM(r: DockerStatusReport): string {
	const lines: string[] = [
		r.available
			? `Docker available (${r.version ?? 'installed'}) — ${r.containers.length} container(s)`
			: `Docker unavailable: ${r.reason ?? 'docker daemon not running or not installed'}`,
	];
	if (r.composeFiles.length) {
		lines.push(`Compose files: ${r.composeFiles.join(', ')}`);
	}
	for (const c of r.containers.slice(0, 25)) {
		lines.push(`- ${c.name} (${c.id.slice(0, 12)}) [${c.state}] image=${c.image} status="${c.status}"${c.ports ? ` ports=${c.ports}` : ''}`);
	}
	return lines.join('\n');
}

export function formatDbInspectForLLM(r: DbInspectReport): string {
	if (r.error) {
		return `Database inspection error: ${r.error}`;
	}
	const lines: string[] = [
		`Database Engine: ${r.engine}${r.databasePath ? ` (${r.databasePath})` : ''}`,
	];
	if (r.envHints.length) {
		lines.push(`Env hints (credentials redacted): ${r.envHints.join(', ')}`);
	}
	if (r.tables.length === 0) {
		lines.push('No SQLite tables inspected.');
	} else {
		lines.push(`Tables (${r.tables.length}):`);
		for (const t of r.tables) {
			const cols = t.columns.map(c => `${c.name}:${c.type || 'ANY'}${c.primaryKey ? '[PK]' : ''}${c.notNull ? '!' : ''}`).join(', ');
			lines.push(`- ${t.name}${t.rowCount !== null ? ` (${t.rowCount} rows)` : ''}: ${cols}`);
		}
	}
	return lines.join('\n');
}

export function formatDbQueryForLLM(r: DbQueryReport): string {
	if (r.error) {
		return `Database query error: ${r.error}`;
	}
	const lines: string[] = [
		`SQLite Query (${r.databasePath}) — ${r.rowCount} row(s) in ${r.durationMs}ms${r.truncated ? ' (truncated)' : ''}`,
	];
	if (r.columns.length > 0) {
		lines.push(`Columns: ${r.columns.join(' | ')}`);
	}
	for (const row of r.rows.slice(0, 50)) {
		lines.push(JSON.stringify(row));
	}
	return lines.join('\n');
}
