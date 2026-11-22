/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ArchitectureMapReport, ScannedSourceFile, buildArchitectureMap } from './projectHealth.js';

export type TwinNodeKind = 'module' | 'test' | 'api' | 'database' | 'config';

export interface DigitalTwinNode {
	readonly id: string; // normalized relative path
	readonly label: string;
	readonly kind: TwinNodeKind;
	readonly lines: number;
	readonly exportedSymbols: readonly string[];
	readonly apiEndpoints: readonly string[];
	readonly dbEntities: readonly string[];
	readonly imports: readonly string[];
	readonly importedBy: readonly string[];
	readonly relatedTests: readonly string[];
}

export interface ProjectDigitalTwin {
	readonly builtAt: string;
	readonly nodes: readonly DigitalTwinNode[];
	readonly nodeById: Readonly<Record<string, DigitalTwinNode>>;
	readonly totalSymbols: number;
	readonly totalApis: number;
	readonly totalDbEntities: number;
	readonly totalTests: number;
	readonly untestedModules: readonly string[];
	readonly architecture: ArchitectureMapReport;
}

export interface ChangeImpactReport {
	readonly target: string;
	readonly found: boolean;
	readonly riskLevel: 'low' | 'medium' | 'high' | 'critical';
	readonly directDependents: readonly string[];
	readonly transitiveDependents: readonly string[];
	readonly affectedTests: readonly string[];
	readonly affectedApiEndpoints: readonly string[];
	readonly affectedDbEntities: readonly string[];
	readonly summary: string;
}

function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isTestPath(p: string): boolean {
	return /(?:^|\/)(?:__tests__|tests?|spec)\/|(?:\.test|\.spec|_test)\.[a-z0-9]+$/i.test(p);
}

function isConfigPath(p: string): boolean {
	return /\.(?:json|ya?ml|toml|env|ini|conf|dockerfile)$|dockerfile$/i.test(p);
}

function extractExportedSymbols(content: string): string[] {
	const found = new Set<string>();
	const patterns = [
		/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
		/^\s*(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
		/\bpublic\s+(?:static\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/g,
		/\bfunc\s+([A-Z][A-Za-z0-9_]*)\s*\(/g,
	];
	for (const re of patterns) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(content)) !== null) {
			if (m[1]) { found.add(m[1]); }
			if (found.size >= 40) { break; }
		}
	}
	return [...found];
}

function extractApiEndpoints(content: string): string[] {
	const endpoints = new Set<string>();
	const patterns = [
		/\b(?:app|router|fastify|server|Route)\.(get|post|put|patch|delete|options|all)\s*\(\s*['"`]([^'"`\n]{1,120})['"`]/gi,
		/@(?:Get|Post|Put|Patch|Delete|RequestMapping)\s*\(\s*['"`]([^'"`\n]{1,120})['"`]/g,
		/@(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`\n]{1,120})['"`]/gi,
	];
	for (const re of patterns) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(content)) !== null) {
			const method = m[2] ? m[1].toUpperCase() : 'ROUTE';
			const route = m[2] ?? m[1];
			if (route) { endpoints.add(`${method} ${route}`); }
			if (endpoints.size >= 30) { break; }
		}
	}
	return [...endpoints];
}

function extractDbEntities(content: string): string[] {
	const entities = new Set<string>();
	const patterns = [
		/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"'\[]?([A-Za-z_][A-Za-z0-9_]*)/gi,
		/^\s*model\s+([A-Z][A-Za-z0-9_]*)\s*\{/gm,
		/protected\s+\$table\s*=\s*['"]([A-Za-z0-9_]+)['"]/g,
		/@Entity\s*\(\s*['"`]([A-Za-z0-9_]+)['"`]\s*\)/g,
	];
	for (const re of patterns) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(content)) !== null) {
			if (m[1]) { entities.add(m[1]); }
			if (entities.size >= 25) { break; }
		}
	}
	return [...entities];
}

export function buildProjectDigitalTwin(files: readonly ScannedSourceFile[]): ProjectDigitalTwin {
	const architecture = buildArchitectureMap(files);
	const importsByFile = new Map<string, Set<string>>();
	const importedByFile = new Map<string, Set<string>>();

	for (const edge of architecture.edges) {
		if (!importsByFile.has(edge.from)) { importsByFile.set(edge.from, new Set()); }
		importsByFile.get(edge.from)!.add(edge.to);
		if (!importedByFile.has(edge.to)) { importedByFile.set(edge.to, new Set()); }
		importedByFile.get(edge.to)!.add(edge.from);
	}

	const normalizedFiles = files.map(f => ({ ...f, rel: normalizePath(f.relativePath) }));
	const testPaths = normalizedFiles.filter(f => isTestPath(f.rel)).map(f => f.rel);

	const nodes: DigitalTwinNode[] = [];
	const nodeById: Record<string, DigitalTwinNode> = {};
	let totalSymbols = 0;
	let totalApis = 0;
	let totalDbEntities = 0;
	let totalTests = 0;
	const untestedModules: string[] = [];

	for (const f of normalizedFiles) {
		const isTest = isTestPath(f.rel);
		const exportedSymbols = extractExportedSymbols(f.content);
		const apiEndpoints = extractApiEndpoints(f.content);
		const dbEntities = extractDbEntities(f.content);
		const imports = [...(importsByFile.get(f.rel) ?? [])];
		const importedBy = [...(importedByFile.get(f.rel) ?? [])];

		const baseStem = (f.rel.split('/').pop() ?? f.rel).replace(/\.[^.]+$/, '').toLowerCase();
		const relatedTests = isTest
			? []
			: [...new Set([
				...importedBy.filter(p => isTestPath(p)),
				...testPaths.filter(tp => tp.toLowerCase().includes(baseStem) && baseStem.length >= 3),
			])];

		let kind: TwinNodeKind = 'module';
		if (isTest) { kind = 'test'; totalTests++; }
		else if (apiEndpoints.length > 0) { kind = 'api'; }
		else if (dbEntities.length > 0) { kind = 'database'; }
		else if (isConfigPath(f.rel)) { kind = 'config'; }

		totalSymbols += exportedSymbols.length;
		totalApis += apiEndpoints.length;
		totalDbEntities += dbEntities.length;

		if (!isTest && kind !== 'config' && exportedSymbols.length > 0 && relatedTests.length === 0) {
			untestedModules.push(f.rel);
		}

		const node: DigitalTwinNode = {
			id: f.rel,
			label: f.rel.split('/').pop() ?? f.rel,
			kind,
			lines: f.content.split(/\r?\n/).length,
			exportedSymbols,
			apiEndpoints,
			dbEntities,
			imports,
			importedBy,
			relatedTests,
		};
		nodes.push(node);
		nodeById[node.id] = node;
	}

	return {
		builtAt: new Date().toISOString(),
		nodes,
		nodeById,
		totalSymbols,
		totalApis,
		totalDbEntities,
		totalTests,
		untestedModules: untestedModules.slice(0, 60),
		architecture,
	};
}

export function analyzeChangeImpact(twin: ProjectDigitalTwin, targetPath: string): ChangeImpactReport {
	const norm = normalizePath(targetPath);
	const exact = twin.nodeById[norm]
		?? twin.nodes.find(n => n.id.endsWith(`/${norm}`) || n.label.toLowerCase() === norm.toLowerCase());

	if (!exact) {
		return {
			target: targetPath,
			found: false,
			riskLevel: 'low',
			directDependents: [],
			transitiveDependents: [],
			affectedTests: [],
			affectedApiEndpoints: [],
			affectedDbEntities: [],
			summary: `Module "${targetPath}" was not found in the Project Digital Twin.`,
		};
	}

	const directDependents = [...exact.importedBy];
	const visited = new Set<string>([exact.id]);
	const queue = [...directDependents];
	const transitive: string[] = [];

	while (queue.length > 0) {
		const cur = queue.shift()!;
		if (visited.has(cur)) { continue; }
		visited.add(cur);
		transitive.push(cur);
		const node = twin.nodeById[cur];
		if (node) {
			for (const dep of node.importedBy) {
				if (!visited.has(dep)) {
					queue.push(dep);
				}
			}
		}
	}

	const affectedSet = new Set<string>([exact.id, ...transitive]);
	const affectedTests = new Set<string>(exact.relatedTests);
	const affectedApis = new Set<string>(exact.apiEndpoints);
	const affectedDbs = new Set<string>(exact.dbEntities);

	for (const id of affectedSet) {
		const node = twin.nodeById[id];
		if (!node) { continue; }
		if (node.kind === 'test') { affectedTests.add(node.id); }
		for (const t of node.relatedTests) { affectedTests.add(t); }
		for (const a of node.apiEndpoints) { affectedApis.add(a); }
		for (const d of node.dbEntities) { affectedDbs.add(d); }
	}

	const blastSize = transitive.length;
	let riskLevel: ChangeImpactReport['riskLevel'] = 'low';
	if (blastSize >= 15 || affectedDbs.size > 0 && blastSize >= 5) { riskLevel = 'critical'; }
	else if (blastSize >= 6 || affectedApis.size > 0) { riskLevel = 'high'; }
	else if (blastSize >= 2) { riskLevel = 'medium'; }

	const summary = [
		`Change Impact for ${exact.id} [Risk: ${riskLevel.toUpperCase()}]`,
		`Direct dependents: ${directDependents.length} | Total blast radius: ${blastSize} module(s)`,
		`Affected tests: ${affectedTests.size} | Affected API routes: ${affectedApis.size} | DB entities: ${affectedDbs.size}`,
	].join('\n');

	return {
		target: exact.id,
		found: true,
		riskLevel,
		directDependents,
		transitiveDependents: transitive,
		affectedTests: [...affectedTests],
		affectedApiEndpoints: [...affectedApis],
		affectedDbEntities: [...affectedDbs],
		summary,
	};
}

export function queryKnowledgeGraph(twin: ProjectDigitalTwin, query: string, limit = 20): DigitalTwinNode[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return twin.nodes.slice(0, limit);
	}
	const scored: { node: DigitalTwinNode; score: number }[] = [];
	for (const node of twin.nodes) {
		const haystack = [
			node.id,
			node.kind,
			...node.exportedSymbols,
			...node.apiEndpoints,
			...node.dbEntities,
		].join(' ').toLowerCase();
		if (!words.every(w => haystack.includes(w))) { continue; }
		let score = 1;
		if (node.label.toLowerCase().includes(words[0])) { score += 4; }
		if (node.exportedSymbols.some(s => s.toLowerCase().includes(words[0]))) { score += 3; }
		if (node.apiEndpoints.length > 0) { score += 2; }
		score += Math.min(5, node.importedBy.length);
		scored.push({ node, score });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map(s => s.node);
}

export function formatChangeImpactForLLM(report: ChangeImpactReport): string {
	if (!report.found) { return report.summary; }
	const lines = [report.summary];
	if (report.directDependents.length > 0) {
		lines.push('', 'Direct Dependents:', ...report.directDependents.slice(0, 20).map(d => `- ${d}`));
	}
	if (report.affectedTests.length > 0) {
		lines.push('', 'Recommended Tests to Run:', ...report.affectedTests.slice(0, 15).map(t => `- ${t}`));
	}
	if (report.affectedApiEndpoints.length > 0) {
		lines.push('', 'Affected API Routes:', ...report.affectedApiEndpoints.slice(0, 15).map(a => `- ${a}`));
	}
	if (report.affectedDbEntities.length > 0) {
		lines.push('', 'Affected DB Entities:', ...report.affectedDbEntities.slice(0, 15).map(d => `- ${d}`));
	}
	return lines.join('\n');
}
