/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Deterministic Project Health, Secret Leak, Static Security, & Architecture Analysis
 * (Mandate §3.2, §3.14, §14, §22).
 *
 * Pure analysis algorithms (zero Node I/O, runs in both browser and Node):
 *   - Secret & credential leak detection with mandatory redaction (secrets never leave verbatim)
 *   - Static security risk patterns (XSS, eval, command injection, TLS bypass, SQL concat)
 *   - Project stack / framework / test-runner detection
 *   - Import dependency graph, hub modules, orphan files, circular dependency detection, and Mermaid diagram
 */

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';
export type FindingKind = 'secret' | 'security' | 'debt';

export interface ProjectFinding {
	readonly kind: FindingKind;
	readonly severity: FindingSeverity;
	readonly rule: string;
	readonly message: string;
	readonly file: string;
	readonly line: number;
	readonly snippet: string;
}

export interface ProjectStackProfile {
	readonly languages: string[];
	readonly frameworks: string[];
	readonly packageManagers: string[];
	readonly testFrameworks: string[];
	readonly configFiles: string[];
}

export interface ProjectHealthReport {
	readonly scannedFiles: number;
	readonly totalLines: number;
	readonly skippedFiles: number;
	readonly stack: ProjectStackProfile;
	readonly findings: ProjectFinding[];
	readonly counts: { critical: number; high: number; medium: number; low: number; todoCount: number };
	readonly largestFiles: { file: string; lines: number }[];
}

export interface ArchitectureMapReport {
	readonly moduleCount: number;
	readonly edgeCount: number;
	readonly edges: { from: string; to: string }[];
	readonly cycles: string[][];
	readonly topHubs: { file: string; importedBy: number; imports: number }[];
	readonly orphans: string[];
	readonly mermaid: string;
}

export interface ScannedSourceFile {
	readonly relativePath: string;
	readonly content: string;
}

const SECRET_RULES: readonly { rule: string; severity: FindingSeverity; message: string; pattern: RegExp }[] = [
	{ rule: 'private-key', severity: 'critical', message: 'Embedded private key header detected', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
	{ rule: 'aws-access-key', severity: 'critical', message: 'Hardcoded AWS Access Key ID detected', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
	{ rule: 'github-token', severity: 'critical', message: 'Hardcoded GitHub personal/OAuth access token detected', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/ },
	{ rule: 'openai-key', severity: 'critical', message: 'Hardcoded OpenAI-style API key detected', pattern: /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{24,}\b/ },
	{ rule: 'nvidia-key', severity: 'critical', message: 'Hardcoded NVIDIA API key detected', pattern: /\bnvapi-[A-Za-z0-9_-]{24,}\b/ },
	{ rule: 'anthropic-key', severity: 'critical', message: 'Hardcoded Anthropic API key detected', pattern: /\bsk-ant-[A-Za-z0-9_-]{24,}\b/ },
	{ rule: 'generic-secret-assignment', severity: 'high', message: 'Potential hardcoded secret or password literal', pattern: /\b(?:api_?key|secret_?key|access_?token|private_?key|db_?password|auth_?token)\s*[:=]\s*["'](?!(?:your|example|test|dummy|changeme|placeholder|xxx|\*|<|\$\{))[^"'\s]{12,}["']/i },
];

const SECURITY_RULES: readonly { rule: string; severity: FindingSeverity; message: string; pattern: RegExp; extensions?: ReadonlySet<string> }[] = [
	{ rule: 'eval-usage', severity: 'high', message: 'Dynamic eval() execution can allow arbitrary code injection', pattern: /\beval\s*\(/, extensions: new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.php']) },
	{ rule: 'new-function', severity: 'medium', message: 'new Function() compiles runtime strings as code', pattern: /\bnew\s+Function\s*\(/, extensions: new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']) },
	{ rule: 'inner-html', severity: 'medium', message: 'Direct innerHTML assignment risks XSS if input is untrusted', pattern: /\.innerHTML\s*=(?!=)/, extensions: new Set(['.js', '.jsx', '.ts', '.tsx']) },
	{ rule: 'dangerous-react-html', severity: 'medium', message: 'dangerouslySetInnerHTML requires strict sanitization', pattern: /\bdangerouslySetInnerHTML\b/, extensions: new Set(['.jsx', '.tsx', '.js', '.ts']) },
	{ rule: 'tls-disabled', severity: 'high', message: 'TLS certificate verification disabled (rejectUnauthorized: false)', pattern: /rejectUnauthorized\s*:\s*false\b/ },
	{ rule: 'shell-exec-interpolation', severity: 'high', message: 'Shell command execution with template interpolation risks command injection', pattern: /\b(?:exec|execSync)\s*\(\s*`[^`]*\$\{/, extensions: new Set(['.js', '.ts', '.mjs', '.cjs']) },
	{ rule: 'python-shell-true', severity: 'high', message: 'subprocess call with shell=True risks command injection', pattern: /\bsubprocess\.(?:run|Popen|call|check_output)\([^)]*shell\s*=\s*True/, extensions: new Set(['.py']) },
	{ rule: 'sql-string-concat', severity: 'high', message: 'Possible SQL query built with interpolation/concatenation', pattern: /\b(?:SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+[a-zA-Z_][a-zA-Z0-9_]*\s+SET|DELETE\s+FROM)\b[^;\n]*(?:\$\{|\+\s*[a-zA-Z_$])/i, extensions: new Set(['.js', '.ts', '.py', '.php', '.java', '.go']) },
];

const EXT_TO_LANG: Readonly<Record<string, string>> = {
	'.ts': 'TypeScript', '.tsx': 'TypeScript',
	'.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
	'.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.cs': 'C#',
	'.php': 'PHP', '.rb': 'Ruby', '.cpp': 'C++', '.c': 'C', '.sql': 'SQL',
	'.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS',
};

function getExt(filePath: string): string {
	const m = /(\.[a-zA-Z0-9]+)$/.exec(filePath);
	return m ? m[1].toLowerCase() : '';
}

function redactSecretSnippet(line: string, pattern: RegExp): string {
	const clean = line.trim().slice(0, 140);
	return clean.replace(pattern, '[REDACTED_SECRET]');
}

function isTestOrFixtureFile(relPath: string): boolean {
	const p = relPath.replace(/\\/g, '/').toLowerCase();
	return /(?:^|\/)(?:test|tests|__tests__|spec|fixtures|mocks)\//.test(p) || /\.(?:test|spec)\.[a-z0-9]+$/.test(p);
}

/**
 * Analyze a list of workspace files to produce a deterministic health & security report.
 */
export function analyzeProjectHealth(files: readonly ScannedSourceFile[], skippedFiles = 0): ProjectHealthReport {
	const languages = new Set<string>();
	const frameworks = new Set<string>();
	const packageManagers = new Set<string>();
	const testFrameworks = new Set<string>();
	const configFiles: string[] = [];
	const findings: ProjectFinding[] = [];
	const fileLineCounts: { file: string; lines: number }[] = [];
	let totalLines = 0;
	let todoCount = 0;

	for (const f of files) {
		const norm = f.relativePath.replace(/\\/g, '/');
		const base = norm.split('/').pop() ?? norm;
		const ext = getExt(norm);

		if (EXT_TO_LANG[ext]) { languages.add(EXT_TO_LANG[ext]); }

		// Package managers & config detection
		if (base === 'package-lock.json') { packageManagers.add('npm'); }
		else if (base === 'pnpm-lock.yaml') { packageManagers.add('pnpm'); }
		else if (base === 'yarn.lock') { packageManagers.add('yarn'); }
		else if (base === 'Cargo.toml') { packageManagers.add('cargo'); testFrameworks.add('cargo test'); configFiles.push(norm); }
		else if (base === 'go.mod') { packageManagers.add('go modules'); testFrameworks.add('go test'); configFiles.push(norm); }
		else if (base === 'pyproject.toml' || base === 'requirements.txt') { packageManagers.add('pip/python'); configFiles.push(norm); }
		else if (base === 'composer.json') { packageManagers.add('composer'); configFiles.push(norm); }
		else if (base === 'Dockerfile' || base === 'docker-compose.yml' || base === 'docker-compose.yaml') { frameworks.add('Docker'); configFiles.push(norm); }
		else if (base === 'tsconfig.json' || base === 'vite.config.ts' || base === 'next.config.js' || base === 'next.config.mjs' || base === 'jest.config.js' || base === 'vitest.config.ts' || base === 'pytest.ini') {
			configFiles.push(norm);
		}

		// Inspect package.json dependencies for frameworks & test runners
		if (base === 'package.json') {
			configFiles.push(norm);
			try {
				const pkg = JSON.parse(f.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
				const deps: Record<string, string> = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
				const hasDep = (name: string) => Object.prototype.hasOwnProperty.call(deps, name);
				if (hasDep('react')) { frameworks.add('React'); }
				if (hasDep('next')) { frameworks.add('Next.js'); }
				if (hasDep('vue')) { frameworks.add('Vue'); }
				if (hasDep('svelte')) { frameworks.add('Svelte'); }
				if (hasDep('express')) { frameworks.add('Express'); }
				if (hasDep('fastify')) { frameworks.add('Fastify'); }
				if (hasDep('electron')) { frameworks.add('Electron'); }
				if (hasDep('tailwindcss')) { frameworks.add('Tailwind CSS'); }
				if (hasDep('prisma') || hasDep('@prisma/client')) { frameworks.add('Prisma'); }
				if (hasDep('playwright') || hasDep('playwright-core') || hasDep('@playwright/test')) { frameworks.add('Playwright'); }
				if (hasDep('jest')) { testFrameworks.add('Jest'); }
				if (hasDep('vitest')) { testFrameworks.add('Vitest'); }
				if (hasDep('mocha')) { testFrameworks.add('Mocha'); }
				if (pkg.scripts?.test?.includes('node --test')) { testFrameworks.add('node:test'); }
			} catch { /* ignore malformed package.json */ }
		}

		if (base === 'pytest.ini' || (base === 'pyproject.toml' && f.content.includes('pytest'))) {
			testFrameworks.add('pytest');
		}

		const lines = f.content.split(/\r?\n/);
		totalLines += lines.length;
		fileLineCounts.push({ file: norm, lines: lines.length });

		const inTest = isTestOrFixtureFile(norm);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (/\b(?:TODO|FIXME|HACK|XXX)\b/.test(line)) { todoCount++; }

			// Skip scanning test fixtures for synthetic secrets/security examples
			if (inTest) { continue; }

			if (findings.length < 200) {
				for (const r of SECRET_RULES) {
					if (r.pattern.test(line)) {
						findings.push({
							kind: 'secret',
							severity: r.severity,
							rule: r.rule,
							message: r.message,
							file: norm,
							line: i + 1,
							snippet: redactSecretSnippet(line, r.pattern),
						});
						break;
					}
				}
				for (const r of SECURITY_RULES) {
					if (r.extensions && !r.extensions.has(ext)) { continue; }
					if (r.pattern.test(line)) {
						findings.push({
							kind: 'security',
							severity: r.severity,
							rule: r.rule,
							message: r.message,
							file: norm,
							line: i + 1,
							snippet: line.trim().slice(0, 120),
						});
					}
				}
			}
		}
	}

	const severityRank: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
	findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);

	const counts = { critical: 0, high: 0, medium: 0, low: 0, todoCount };
	for (const f of findings) { counts[f.severity]++; }

	const largestFiles = fileLineCounts.sort((a, b) => b.lines - a.lines).slice(0, 8);

	return {
		scannedFiles: files.length,
		totalLines,
		skippedFiles,
		stack: {
			languages: [...languages].sort(),
			frameworks: [...frameworks].sort(),
			packageManagers: [...packageManagers].sort(),
			testFrameworks: [...testFrameworks].sort(),
			configFiles: configFiles.slice(0, 20),
		},
		findings,
		counts,
		largestFiles,
	};
}

/**
 * Resolve a relative JS/TS/Python import specifier against the known workspace file set.
 */
function resolveLocalImport(fromFile: string, specifier: string, fileSet: ReadonlySet<string>): string | undefined {
	if (!specifier.startsWith('.')) { return undefined; }
	const fromParts = fromFile.replace(/\\/g, '/').split('/');
	fromParts.pop();
	for (const seg of specifier.split('/')) {
		if (!seg || seg === '.') { continue; }
		if (seg === '..') { fromParts.pop(); }
		else { fromParts.push(seg); }
	}
	const base = fromParts.join('/');
	const stripped = base.replace(/\.(?:js|mjs|cjs|jsx)$/, '');
	const candidates = [
		base,
		`${stripped}.ts`,
		`${stripped}.tsx`,
		`${stripped}.js`,
		`${stripped}.jsx`,
		`${stripped}.mjs`,
		`${stripped}.py`,
		`${stripped}/index.ts`,
		`${stripped}/index.tsx`,
		`${stripped}/index.js`,
	];
	for (const c of candidates) {
		if (fileSet.has(c)) { return c; }
	}
	return undefined;
}

/**
 * Build a deterministic internal module dependency graph, detect circular dependencies,
 * identify hub modules and orphan modules, and produce a compact Mermaid graph.
 */
export function buildArchitectureMap(files: readonly ScannedSourceFile[]): ArchitectureMapReport {
	const codeExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);
	const codeFiles = files
		.map(f => ({ relativePath: f.relativePath.replace(/\\/g, '/'), content: f.content }))
		.filter(f => codeExts.has(getExt(f.relativePath)));

	const fileSet = new Set(codeFiles.map(f => f.relativePath));
	const edges = new Map<string, Set<string>>();
	const inDegree = new Map<string, number>();

	for (const f of codeFiles) {
		edges.set(f.relativePath, new Set());
		inDegree.set(f.relativePath, 0);
	}

	const importRe = /(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+[\s\S]*?\s+from\s+|require\s*\(\s*)["']([^"']+)["']/g;
	let edgeCount = 0;

	for (const f of codeFiles) {
		const targets = edges.get(f.relativePath)!;
		let m: RegExpExecArray | null;
		importRe.lastIndex = 0;
		while ((m = importRe.exec(f.content)) !== null) {
			const resolved = resolveLocalImport(f.relativePath, m[1], fileSet);
			if (resolved && resolved !== f.relativePath && !targets.has(resolved)) {
				targets.add(resolved);
				inDegree.set(resolved, (inDegree.get(resolved) ?? 0) + 1);
				edgeCount++;
			}
		}
	}

	// Cycle detection (DFS, bounded to first 20 unique cycles)
	const cycles: string[][] = [];
	const seenCycleKeys = new Set<string>();
	const state = new Map<string, 0 | 1 | 2>(); // 0=unvisited, 1=visiting, 2=done
	const stack: string[] = [];

	const dfs = (node: string) => {
		if (cycles.length >= 20) { return; }
		state.set(node, 1);
		stack.push(node);
		for (const next of edges.get(node) ?? []) {
			const st = state.get(next) ?? 0;
			if (st === 1) {
				const idx = stack.indexOf(next);
				if (idx !== -1) {
					const cycle = [...stack.slice(idx), next];
					const key = [...cycle.slice(0, -1)].sort().join('|');
					if (!seenCycleKeys.has(key)) {
						seenCycleKeys.add(key);
						cycles.push(cycle);
					}
				}
			} else if (st === 0) {
				dfs(next);
			}
		}
		stack.pop();
		state.set(node, 2);
	};

	for (const node of edges.keys()) {
		if ((state.get(node) ?? 0) === 0) { dfs(node); }
	}

	const topHubs = [...edges.keys()]
		.map(file => ({ file, importedBy: inDegree.get(file) ?? 0, imports: edges.get(file)?.size ?? 0 }))
		.filter(h => h.importedBy > 0 || h.imports > 0)
		.sort((a, b) => b.importedBy - a.importedBy || b.imports - a.imports || a.file.localeCompare(b.file))
		.slice(0, 12);

	const orphans = [...edges.keys()]
		.filter(file => (inDegree.get(file) ?? 0) === 0 && (edges.get(file)?.size ?? 0) === 0 && !isTestOrFixtureFile(file))
		.slice(0, 20);

	// Compact Mermaid graph of top hub modules and their direct edges (max 25 edges for readability)
	const mermaidLines = ['flowchart LR'];
	const hubSet = new Set(topHubs.slice(0, 10).map(h => h.file));
	const idOf = new Map<string, string>();
	const getId = (f: string) => {
		let id = idOf.get(f);
		if (!id) {
			id = `m${idOf.size}`;
			idOf.set(f, id);
		}
		return id;
	};
	let shownEdges = 0;
	for (const src of hubSet) {
		for (const dst of edges.get(src) ?? []) {
			if (shownEdges >= 25) { break; }
			if (hubSet.has(dst)) {
				const sLabel = src.split('/').slice(-2).join('/');
				const dLabel = dst.split('/').slice(-2).join('/');
				mermaidLines.push(`  ${getId(src)}["${sLabel}"] --> ${getId(dst)}["${dLabel}"]`);
				shownEdges++;
			}
		}
	}
	if (shownEdges === 0) {
		mermaidLines.push('  empty["No internal module edges detected"]');
	}

	const edgeList: { from: string; to: string }[] = [];
	for (const [from, targets] of edges.entries()) {
		for (const to of targets) {
			edgeList.push({ from, to });
		}
	}

	return {
		moduleCount: codeFiles.length,
		edgeCount,
		edges: edgeList,
		cycles,
		topHubs,
		orphans,
		mermaid: mermaidLines.join('\n'),
	};
}

export function formatProjectHealthForLLM(report: ProjectHealthReport): string {
	const lines: string[] = [
		`Project Health Report (${report.scannedFiles} files, ${report.totalLines.toLocaleString()} lines${report.skippedFiles ? `, ${report.skippedFiles} skipped` : ''})`,
		`Languages: ${report.stack.languages.join(', ') || 'none detected'}`,
		`Frameworks: ${report.stack.frameworks.join(', ') || 'none detected'}`,
		`Package Managers: ${report.stack.packageManagers.join(', ') || 'none detected'}`,
		`Test Frameworks: ${report.stack.testFrameworks.join(', ') || 'none detected'}`,
		`Findings: ${report.counts.critical} critical, ${report.counts.high} high, ${report.counts.medium} medium, ${report.counts.low} low | TODO/FIXME markers: ${report.counts.todoCount}`,
	];
	if (report.findings.length > 0) {
		lines.push('', 'Top Findings (secrets redacted):');
		for (const f of report.findings.slice(0, 25)) {
			lines.push(`- [${f.severity.toUpperCase()}][${f.kind}:${f.rule}] ${f.file}:${f.line} — ${f.message}`);
			lines.push(`    ${f.snippet}`);
		}
		if (report.findings.length > 25) {
			lines.push(`... and ${report.findings.length - 25} more findings.`);
		}
	}
	if (report.largestFiles.length > 0) {
		lines.push('', 'Largest Files:', ...report.largestFiles.slice(0, 5).map(f => `- ${f.file} (${f.lines} lines)`));
	}
	return lines.join('\n');
}

export interface EngineeringQualityScore {
	readonly score: number;
	readonly grade: 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';
	readonly securityScore: number;
	readonly architectureScore: number;
	readonly maintainabilityScore: number;
	readonly summary: string;
}

/**
 * Compute a deterministic 0–100 Engineering Quality Score across security, architecture,
 * and maintainability from real scan metrics (Mandate §17 / §22).
 */
export function computeEngineeringQualityScore(health: ProjectHealthReport, arch?: ArchitectureMapReport): EngineeringQualityScore {
	const securityScore = Math.max(0, Math.min(100,
		100 - health.counts.critical * 25 - health.counts.high * 10 - health.counts.medium * 3
	));
	const cyclePenalty = arch ? arch.cycles.length * 15 : 0;
	const orphanRatio = arch && arch.moduleCount > 0 ? arch.orphans.length / arch.moduleCount : 0;
	const architectureScore = Math.max(0, Math.min(100,
		Math.round(100 - cyclePenalty - Math.min(25, orphanRatio * 35))
	));
	const oversizedFiles = health.largestFiles.filter(f => f.lines > 800).length;
	const debtPenalty = Math.min(30, Math.round(health.counts.todoCount / 5));
	const maintainabilityScore = Math.max(0, Math.min(100,
		100 - oversizedFiles * 8 - debtPenalty
	));
	const score = Math.round(securityScore * 0.45 + architectureScore * 0.30 + maintainabilityScore * 0.25);
	const grade: EngineeringQualityScore['grade'] =
		score >= 95 ? 'A+' : score >= 88 ? 'A' : score >= 78 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : 'F';

	const summary = score >= 88
		? 'Healthy codebase with strong security and clean module structure.'
		: score >= 70
			? 'Solid baseline with actionable security, cycle, or maintainability findings.'
			: 'Needs attention: address critical/high security findings or circular dependencies before release.';

	return { score, grade, securityScore, architectureScore, maintainabilityScore, summary };
}

export function formatArchitectureMapForLLM(map: ArchitectureMapReport): string {
	const lines: string[] = [
		`Architecture Dependency Map (${map.moduleCount} code modules, ${map.edgeCount} internal import edges)`,
		`Circular dependencies: ${map.cycles.length}`,
	];
	if (map.cycles.length > 0) {
		lines.push('', 'Cycles:');
		for (const c of map.cycles.slice(0, 10)) {
			lines.push(`- ${c.join(' → ')}`);
		}
	}
	if (map.topHubs.length > 0) {
		lines.push('', 'Core Hub Modules (most imported):');
		for (const h of map.topHubs.slice(0, 10)) {
			lines.push(`- ${h.file} (imported by ${h.importedBy}, imports ${h.imports})`);
		}
	}
	if (map.orphans.length > 0) {
		lines.push('', `Standalone/Orphan Files (${map.orphans.length}): ${map.orphans.slice(0, 10).join(', ')}`);
	}
	return lines.join('\n');
}

export interface TechnicalDebtItem {
	readonly id: string;
	readonly category: 'oversized-module' | 'circular-dependency' | 'security-hotspot' | 'todo-hotspot';
	readonly severity: 'high' | 'medium' | 'low';
	readonly title: string;
	readonly detail: string;
	readonly file?: string;
	readonly effort: 'small' | 'medium' | 'large';
	readonly suggestedPrompt: string;
}

export function analyzeTechnicalDebt(
	health: ProjectHealthReport,
	arch?: ArchitectureMapReport,
): TechnicalDebtItem[] {
	const items: TechnicalDebtItem[] = [];
	let idx = 0;

	for (const f of health.findings) {
		if (f.severity === 'critical' || f.severity === 'high') {
			items.push({
				id: `debt-${++idx}`,
				category: 'security-hotspot',
				severity: 'high',
				title: `Security finding (${f.rule}) in ${f.file}`,
				detail: `Line ${f.line}: ${f.message}`,
				file: f.file,
				effort: 'small',
				suggestedPrompt: `Fix the ${f.severity} security finding (${f.rule}) at ${f.file}:${f.line} (${f.message}) and add a regression test.`,
			});
		}
		if (items.length >= 8) { break; }
	}

	if (arch) {
		for (const cycle of arch.cycles.slice(0, 5)) {
			items.push({
				id: `debt-${++idx}`,
				category: 'circular-dependency',
				severity: 'medium',
				title: `Circular dependency (${cycle.length - 1} modules)`,
				detail: cycle.join(' → '),
				file: cycle[0],
				effort: 'medium',
				suggestedPrompt: `Break the circular import cycle: ${cycle.join(' -> ')} by extracting shared types/interfaces into a neutral module, then verify the build and tests pass.`,
			});
		}
	}

	for (const big of health.largestFiles) {
		if (big.lines >= 700) {
			items.push({
				id: `debt-${++idx}`,
				category: 'oversized-module',
				severity: big.lines >= 1500 ? 'high' : 'medium',
				title: `Oversized file: ${big.file} (${big.lines} lines)`,
				detail: 'Large files increase coupling and slow down comprehension and testing.',
				file: big.file,
				effort: big.lines >= 1500 ? 'large' : 'medium',
				suggestedPrompt: `Analyze ${big.file} (${big.lines} lines) and propose a safe modular split without breaking callers, then verify all tests pass.`,
			});
		}
	}

	if (health.counts.todoCount >= 10) {
		items.push({
			id: `debt-${++idx}`,
			category: 'todo-hotspot',
			severity: 'low',
			title: `${health.counts.todoCount} unresolved TODO/FIXME markers`,
			detail: 'Review deferred work markers for hidden bugs or stale comments.',
			effort: 'small',
			suggestedPrompt: `Audit the TODO/FIXME markers across this workspace, prioritize any real bugs or incomplete error handling, and fix the highest-priority items.`,
		});
	}

	return items.slice(0, 25);
}
