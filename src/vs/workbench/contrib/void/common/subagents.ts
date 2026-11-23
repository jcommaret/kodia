/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 6: subagents. A subagent is a child agent loop in its own thread. The parent's `subagent` tool call runs
 * it to completion and returns a report built from what the child actually did (its tool calls and their results),
 * not only from what it says. Several subagent calls in one reply run in parallel.
 *
 * This module holds the parts that need no services: agent types and their tools, the cross-agent file claims
 * that keep parallel agents from writing the same file, and the report.
 */

export type BuiltinSubagentType =
	| 'general'
	| 'explore'
	| 'review'
	| 'planner'
	| 'architect'
	| 'frontend'
	| 'backend'
	| 'database'
	| 'api'
	| 'security'
	| 'testing'
	| 'debugging'
	| 'git'
	| 'browser'
	| 'docs'
	| 'devops'
	| 'performance'
	| 'ui_ux'
	| 'refactor'
	// Kodia AI Engineering Engine specialist workforce
	| 'ai_architect'
	| 'ml_engineer'
	| 'llm_engineer'
	| 'rag_engineer'
	| 'agentic_engineer'
	| 'data_engineer'
	| 'cv_engineer'
	| 'speech_audio'
	| 'mlops'
	| 'ai_security'
	| 'ai_eval'
	| 'ai_research'
	| 'robotics_iot';

/** Either a built-in specialist role or a workspace/user custom agent name. */
export type SubagentType = BuiltinSubagentType | (string & {});

export interface SubagentProfile {
	readonly canChangeFiles: boolean;
	readonly description: string;
	readonly guidance: string;
	/** Optional explicit tool allowlist (in addition to read-only restriction). */
	readonly allowedTools?: readonly string[];
	/** Optional preferred model ("provider/model" or model name) when caller omits model. */
	readonly defaultModel?: string;
}

export const SUBAGENT_TYPES: { readonly [T in BuiltinSubagentType]: SubagentProfile } = {
	general: {
		canChangeFiles: true,
		description: 'can read, edit and create files and run commands',
		guidance: 'Implement the requested work end-to-end, verify changes with real builds/tests, and report concrete paths and results.',
	},
	explore: {
		canChangeFiles: false,
		description: 'read-only: searches and reads the codebase and reports',
		guidance: 'Locate relevant files, symbols, call paths, and dependencies. Cite exact file paths and line numbers.',
	},
	review: {
		canChangeFiles: false,
		description: 'read-only: reviews code or changes and reports problems',
		guidance: 'Audit diffs and source files for correctness bugs, security vulnerabilities, race conditions, missing edge cases, and regressions. Cite file:line and severity.',
	},
	planner: {
		canChangeFiles: false,
		description: 'read-only: inspects the project and produces structured implementation plans and task breakdowns',
		guidance: 'Inspect workspace architecture and dependencies first, then produce a concrete step-by-step plan with task dependencies, parallelizable workstreams, risks, and testable acceptance criteria.',
	},
	architect: {
		canChangeFiles: false,
		description: 'read-only: analyzes system architecture, boundaries, schemas, and technical trade-offs',
		guidance: 'Evaluate module boundaries, data flows, IPC/API contracts, scalability, and maintainability. Propose clean, idiomatic designs aligned with existing conventions.',
	},
	frontend: {
		canChangeFiles: true,
		description: 'specialist in autonomous UI/UX design systems, visual craft, components, imagery, accessibility, and responsive layouts',
		guidance: 'Use Kodia Design Intelligence tools (inspect_existing_design_system, analyze_product_design_requirements, generate_design_tokens, recommend_typography, discover_icon_library, discover_visual_assets/download_visual_assets) before building. Deliver art-directed, token-driven, mobile-to-desktop responsive UI with real connected functionality, vector icons (never emojis), verified imagery, and browser visual QA verification.',
	},
	backend: {
		canChangeFiles: true,
		description: 'specialist in server architecture, services, business logic, auth, and integrations',
		guidance: 'Implement robust, type-safe backend logic with proper validation, error handling, and security checks. Verify with automated tests.',
	},
	database: {
		canChangeFiles: true,
		description: 'specialist in schemas, migrations, queries, indexing, and data integrity',
		guidance: 'Design safe schemas and reversible migrations, prevent SQL injection and N+1 queries, and verify migrations/queries against real state where available.',
	},
	api: {
		canChangeFiles: true,
		description: 'specialist in REST/GraphQL/RPC contracts, request validation, status codes, and API testing',
		guidance: 'Implement and verify endpoint contracts, input validation, error payloads, authentication headers, and integration tests.',
	},
	security: {
		canChangeFiles: false,
		description: 'read-only: audits authentication, authorization, injection vectors, secrets, and dependency risks',
		guidance: 'Inspect code for OWASP/CWE issues, command/SQL/XSS injection, secret leaks, privilege boundaries, and unsafe defaults. Report concrete evidence and exact remediation steps.',
	},
	testing: {
		canChangeFiles: true,
		description: 'specialist in unit, integration, and e2e tests, coverage, regression checks, and flaky-test triage',
		guidance: 'Write thorough, non-brittle tests that exercise real execution paths (never fake assertions), run the test runner, and report exact pass/fail output.',
	},
	debugging: {
		canChangeFiles: true,
		description: 'specialist in root-cause investigation using logs, stack traces, debugger sessions, and minimal fixes',
		guidance: 'Reproduce the failure first, inspect runtime state via debugger or targeted runs, fix the root cause (not symptoms), and verify the fix with a regression test.',
	},
	git: {
		canChangeFiles: true,
		description: 'specialist in safe Git workflows, diffs, branches, conflict inspection, commit context, and PR prep',
		guidance: 'Never overwrite unrelated user work or run destructive resets. Inspect status/diff carefully and report exact branch/commit state.',
	},
	browser: {
		canChangeFiles: true,
		description: 'specialist in Playwright browser visual QA, responsive viewport testing, WCAG accessibility, performance, and UI defect repair',
		guidance: 'Launch or attach to the local app, run capture_application_screenshots, inspect_responsive_layout, inspect_visual_quality, audit_accessibility, audit_frontend_performance, and critique_interface_design, repair defects via repair_visual_defects, reload, and verify with compare_visual_revisions.',
	},
	docs: {
		canChangeFiles: true,
		description: 'specialist in READMEs, architecture docs, API references, setup guides, and technical decision records',
		guidance: 'Verify every command, path, and symbol against the actual codebase before documenting it. Keep docs concise, accurate, and grounded in reality.',
	},
	devops: {
		canChangeFiles: true,
		description: 'specialist in build pipelines, Docker/CI/CD configs, environment setup, and deployment readiness',
		guidance: 'Configure reproducible builds, CI checks, and deployment manifests safely without exposing secrets. Validate syntax and build steps.',
	},
	performance: {
		canChangeFiles: true,
		description: 'specialist in profiling, algorithmic complexity, memory leaks, bundle size, and latency optimization',
		guidance: 'Measure or trace bottlenecks before optimizing, avoid premature complexity, and verify correctness plus measurable improvement.',
	},
	ui_ux: {
		canChangeFiles: true,
		description: 'specialist in creative direction, visual hierarchy, color & contrast systems, typography, responsive craft, and interface critique',
		guidance: 'Operate like a world-class product designer and creative director. Use generate_design_brief, generate_visual_direction, generate_color_palette, audit_design_consistency, critique_interface_design, and repair_visual_defects to elevate visual craft, accessibility, imagery, and interaction polish without breaking real user workflows.',
	},
	refactor: {
		canChangeFiles: true,
		description: 'specialist in safe structural refactoring, deduplication, typing improvements, and preserving behavior',
		guidance: 'Keep behavior identical while improving modularity and clarity. Run typechecks and existing tests to prove zero regressions.',
	},
	ai_architect: {
		canChangeFiles: false,
		description: 'read-only: AI system architect designing model-agnostic AI/data/RAG/agent/serving architectures and trade-offs',
		guidance: 'Use ai_orchestrate_project, ai_design_architecture, ai_probe_compute_hardware, and ai_estimate_performance_cost. Compare alternatives with latency, cost, and risk trade-offs; never force AI into ordinary non-AI software.',
	},
	ml_engineer: {
		canChangeFiles: true,
		description: 'specialist in classical ML, deep learning, PyTorch/scikit-learn/XGBoost, training pipelines, quantization, and ONNX',
		guidance: 'Profile datasets first (ai_profile_dataset), probe hardware (ai_probe_compute_hardware), select optimal training strategy (ai_recommend_training_strategy), log experiments (ai_experiment_manage), and register verified artifacts (ai_model_registry).',
	},
	llm_engineer: {
		canChangeFiles: true,
		description: 'specialist in LLMs, SLMs, structured outputs, prompt/context engineering, function calling, routing, and model serving',
		guidance: 'Build model-agnostic BYOK/local integrations with streaming, structured output validation, caching, retries, and quantitative evaluations (ai_evaluate_system).',
	},
	rag_engineer: {
		canChangeFiles: true,
		description: 'specialist in hybrid BM25+vector RAG, document ingestion, chunking, reranking, grounded citations, and retrieval evals',
		guidance: 'Use ai_rag_build_index, ai_rag_query, and ai_rag_evaluate. Enforce source provenance, tenant access filtering, and automated Recall@K / MRR / Groundedness evaluation.',
	},
	agentic_engineer: {
		canChangeFiles: true,
		description: 'specialist in autonomous agents, multi-agent orchestration, typed tool registries, durable checkpoints, and workflows',
		guidance: 'Design bounded, observable, checkpointed agent runtimes and workflows (ai_create_workflow, ai_run_workflow) with explicit permission guards, retries, and recovery.',
	},
	data_engineer: {
		canChangeFiles: true,
		description: 'specialist in AI data pipelines, dataset profiling, cleaning, validation, lineage, PII redaction, and feature engineering',
		guidance: 'Run ai_profile_dataset to verify schemas, missing rates, duplicates, class balance, and PII before building reproducible, leakage-free data pipelines.',
	},
	cv_engineer: {
		canChangeFiles: true,
		description: 'specialist in computer vision (classification, detection, segmentation, OCR, video analysis, OpenCV/PyTorch/ONNX)',
		guidance: 'Build verifiable vision preprocessing, inference, evaluation (mAP/IoU/CER), and visualization pipelines with real test fixtures.',
	},
	speech_audio: {
		canChangeFiles: true,
		description: 'specialist in ASR, TTS, voice assistants, audio classification, diarization, and real-time multimodal audio pipelines',
		guidance: 'Design low-latency streaming audio/speech pipelines with clear WER/RTF benchmarks and graceful fallbacks when microphones or audio runtimes are absent.',
	},
	mlops: {
		canChangeFiles: true,
		description: 'specialist in MLOps/LLMOps, model registries, experiment tracking, serving containers, monitoring, drift, and cost control',
		guidance: 'Maintain reproducible artifacts in ai_model_registry and ai_experiment_manage, containerize inference cleanly, and document health checks, rollbacks, and cost limits.',
	},
	ai_security: {
		canChangeFiles: false,
		description: 'read-only: audits prompt injection, secret leaks, unsafe model deserialization, output validation, PII, and AI governance',
		guidance: 'Run ai_audit_security and inspect prompt boundaries, tool permissions, pickle/torch.load safety, tenant isolation, and high-impact domain oversight requirements.',
	},
	ai_eval: {
		canChangeFiles: true,
		description: 'specialist in quantitative AI evaluation harnesses (F1/MAE/RAG Recall@K/Groundedness/Agent completion) and regression gates',
		guidance: 'Build deterministic golden evaluation datasets and run ai_evaluate_system and ai_rag_evaluate. Never claim model quality without measured scores.',
	},
	ai_research: {
		canChangeFiles: false,
		description: 'read-only: AI research scientist comparing methods, designing controlled ablations, and evaluating emerging capabilities',
		guidance: 'Use ai_research_analyze and ai_discover_capabilities. Clearly separate established literature, measured experiment outcomes, and unverified hypotheses.',
	},
	robotics_iot: {
		canChangeFiles: true,
		description: 'specialist in Edge AI, TinyML, IoT sensor fusion, predictive maintenance, MQTT/OPC-UA, Jetson/ESP32/RPi, and robotics simulation',
		guidance: 'Optimize for edge latency/memory (ONNX/INT8) and verify strictly against available simulators/emulators — never claim physical hardware verification without real hardware.',
	},
};

// common names models use for the same roles
const SUBAGENT_TYPE_ALIASES: Readonly<Record<string, BuiltinSubagentType>> = {
	general: 'general', 'general-purpose': 'general', build: 'general', code: 'general', coder: 'general', implement: 'general', test: 'general', tests: 'general', fix: 'general',
	explore: 'explore', research: 'explore', search: 'explore', investigate: 'explore',
	review: 'review', reviewer: 'review', 'code-review': 'review',
	planner: 'planner', plan: 'planner', planning: 'planner',
	architect: 'architect', architecture: 'architect',
	frontend: 'frontend', 'front-end': 'frontend', ui: 'frontend',
	backend: 'backend', 'back-end': 'backend', server: 'backend',
	database: 'database', db: 'database', sql: 'database',
	api: 'api',
	security: 'security', sec: 'security', audit: 'security',
	testing: 'testing', qa: 'testing', 'test-specialist': 'testing',
	debugging: 'debugging', debug: 'debugging', debugger: 'debugging',
	git: 'git', vcs: 'git', scm: 'git',
	browser: 'browser', playwright: 'browser', e2e: 'browser',
	docs: 'docs', documentation: 'docs', doc: 'docs',
	devops: 'devops', deploy: 'devops', deployment: 'devops', ci: 'devops',
	performance: 'performance', perf: 'performance', optimize: 'performance',
	ui_ux: 'ui_ux', 'ui-ux': 'ui_ux', ux: 'ui_ux', design: 'ui_ux',
	refactor: 'refactor', refactoring: 'refactor',
};

export interface CustomSubagentDefinition extends SubagentProfile {
	readonly name: string;
	readonly sourcePath: string;
}

/**
 * Parse a custom agent markdown file (.kodia/agents/<name>.md or .claude/agents/<name>.md)
 * with optional YAML frontmatter:
 *   name, description, readOnly / canChangeFiles, tools (comma list or YAML array), model.
 */
export function parseCustomAgentMarkdown(sourcePath: string, content: string): CustomSubagentDefinition | undefined {
	const trimmed = content.trim();
	if (!trimmed) { return undefined; }

	const baseName = sourcePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/i, '') ?? '';
	let name = baseName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
	let description = `custom agent from ${baseName}`;
	let canChangeFiles = true;
	let allowedTools: string[] | undefined;
	let defaultModel: string | undefined;
	let body = trimmed;

	const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(trimmed);
	if (fmMatch) {
		const fm = fmMatch[1];
		body = fmMatch[2].trim();
		const lines = fm.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			const kv = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i].trim());
			if (!kv) { continue; }
			const key = kv[1].toLowerCase();
			const val = kv[2].trim().replace(/^["']|["']$/g, '');
			if (key === 'name' && val) { name = val.toLowerCase().replace(/[^a-z0-9_-]/g, '-'); }
			else if (key === 'description' && val) { description = val; }
			else if (key === 'model' && val) { defaultModel = val; }
			else if (key === 'readonly' || key === 'read_only' || key === 'read-only') { canChangeFiles = val.toLowerCase() !== 'true'; }
			else if (key === 'canchangefiles' || key === 'can_change_files') { canChangeFiles = val.toLowerCase() !== 'false'; }
			else if (key === 'tools' || key === 'allowed-tools' || key === 'allowed_tools') {
				if (val) {
					allowedTools = val.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
				} else {
					const items: string[] = [];
					while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
						i++;
						items.push(lines[i].replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''));
					}
					if (items.length) { allowedTools = items; }
				}
			}
		}
	}

	if (!name) { return undefined; }
	return {
		name,
		sourcePath,
		description,
		canChangeFiles,
		guidance: body || description,
		...(allowedTools?.length ? { allowedTools } : {}),
		...(defaultModel ? { defaultModel } : {}),
	};
}

/** The subagent type a model asked for, or an error listing the valid ones. */
export function resolveSubagentType(
	requested: string,
	customAgents?: ReadonlyMap<string, CustomSubagentDefinition>,
): { type: SubagentType; profile: SubagentProfile } | { error: string } {
	const key = requested.trim().toLowerCase();
	const custom = customAgents?.get(key);
	if (custom) { return { type: custom.name, profile: custom }; }
	const builtin = SUBAGENT_TYPE_ALIASES[key];
	if (builtin) { return { type: builtin, profile: SUBAGENT_TYPES[builtin] }; }
	const validBuiltin = (Object.keys(SUBAGENT_TYPES) as BuiltinSubagentType[]).map(k => `"${k}" (${SUBAGENT_TYPES[k].description})`).join(', ');
	const validCustom = customAgents && customAgents.size > 0
		? `; custom agents: ${[...customAgents.keys()].map(k => `"${k}"`).join(', ')}`
		: '';
	return { error: `Unknown subagent type "${requested}". Use one of: ${validBuiltin}${validCustom}.` };
}

/** Subagents cannot start subagents: one level of delegation keeps cost and coordination bounded. */
export const SUBAGENT_TOOL_NAME = 'subagent';
export const MAX_PARALLEL_SUBAGENTS = 4;
export const SUBAGENT_TIMEOUT_MS = 30 * 60_000;

/**
 * The tools a subagent of this type is offered and allowed to run.
 * @param type built-in or custom subagent type
 * @param allTools every tool the parent's mode offers
 * @param needsApproval whether a builtin tool changes something (has an approval type) — read-only agents get none of those
 * @param profile optional resolved profile (for custom agents with explicit tool allowlists)
 */
export function subagentToolNames(
	type: SubagentType,
	allTools: readonly string[],
	needsApproval: (toolName: string) => boolean,
	profile?: SubagentProfile,
): string[] {
	const resolvedProfile = profile ?? (type in SUBAGENT_TYPES ? SUBAGENT_TYPES[type as BuiltinSubagentType] : SUBAGENT_TYPES.general);
	const allowSet = resolvedProfile.allowedTools?.length ? new Set(resolvedProfile.allowedTools) : undefined;
	return allTools.filter(name =>
		name !== SUBAGENT_TOOL_NAME
		&& (resolvedProfile.canChangeFiles || !needsApproval(name))
		&& (!allowSet || allowSet.has(name))
	);
}

/** Told to the subagent in its system prompt: its reply is a report to another agent, not a chat with the user. */
export function subagentRoleText(type: SubagentType, description: string, profile?: SubagentProfile): string {
	const p = profile ?? (type in SUBAGENT_TYPES ? SUBAGENT_TYPES[type as BuiltinSubagentType] : SUBAGENT_TYPES.general);
	return [
		`YOU ARE A SUBAGENT ("${description}", type ${type}: ${p.description}).`,
		`SPECIALIST GUIDANCE: ${p.guidance}`,
		'Another agent gave you the task in the user message below; it does not see your tool calls, only your final reply. The user is not watching this conversation, so do not ask questions: decide, and say what you assumed.',
		p.canChangeFiles
			? 'Do the task completely, check your work (read back what you changed, run the relevant tests or build), then finish.'
			: 'You cannot change files or run commands. Investigate with your tools, then finish.',
		'Your final reply is your report: what you did or found, with file paths and line numbers, what you verified and how, and anything left undone or uncertain. Other subagents may be working in parallel; if a file is refused to you because one of them is changing it, leave it and mention it in your report.',
	].join('\n');
}

// ---------- file claims ----------

/**
 * While subagents run in parallel, the first one to change a file owns it until it finishes; a sibling's change to
 * that file is refused (it would overwrite or interleave with the owner's work). Parents are not checked: a parent
 * is blocked inside its subagent call while its children run.
 */
export class SubagentFileClaims {
	private readonly ownerOfPath = new Map<string, string>();

	private static key(fsPath: string): string { return fsPath.replace(/\\/g, '/').toLowerCase(); }

	/** undefined when `owner` may change the file (it now owns it), otherwise the owner that holds it. */
	claim(fsPath: string, owner: string): string | undefined {
		const key = SubagentFileClaims.key(fsPath);
		const current = this.ownerOfPath.get(key);
		if (current !== undefined && current !== owner) { return current; }
		this.ownerOfPath.set(key, owner);
		return undefined;
	}

	releaseAll(owner: string): void {
		for (const [path, o] of this.ownerOfPath) { if (o === owner) { this.ownerOfPath.delete(path); } }
	}

	ownedBy(owner: string): string[] {
		return [...this.ownerOfPath].filter(([, o]) => o === owner).map(([p]) => p);
	}
}

// ---------- report ----------

export type SubagentStatus = 'completed' | 'awaiting_approval' | 'stopped' | 'failed' | 'timed_out';

export type SubagentToolCallFact = { name: string; type: string; target?: string; error?: string };

export type SubagentReport = {
	sessionID: string;
	agent: SubagentType;
	description: string;
	status: SubagentStatus;
	/** the child's last reply (its own account) */
	output: string;
	/** files the child successfully changed (workspace-relative), from its tool results */
	filesChanged: string[];
	toolCalls: { total: number; failed: number; byName: Record<string, number> };
	/** failed tool calls, and the error that stopped the child, verbatim */
	problems: string[];
	/** the tool waiting for the user's approval, when awaiting_approval */
	awaitingApprovalOf?: string;
	durationMs: number;
};

export function summarizeSubagentRun(facts: SubagentToolCallFact[], fileChangingTools: ReadonlySet<string>): Pick<SubagentReport, 'filesChanged' | 'toolCalls' | 'problems'> {
	const byName: Record<string, number> = {};
	const filesChanged: string[] = [];
	const problems: string[] = [];
	let failed = 0;
	for (const f of facts) {
		byName[f.name] = (byName[f.name] ?? 0) + 1;
		if (f.type === 'success') {
			if (fileChangingTools.has(f.name) && f.target && !filesChanged.includes(f.target)) { filesChanged.push(f.target); }
		} else {
			failed += 1;
			problems.push(`${f.name}${f.target ? ` (${f.target})` : ''} → ${f.type}${f.error ? `: ${f.error.slice(0, 300)}` : ''}`);
		}
	}
	return { filesChanged, toolCalls: { total: facts.length, failed, byName }, problems };
}

const STATUS_LINE: { readonly [S in SubagentStatus]: string } = {
	completed: 'finished',
	awaiting_approval: 'PAUSED — waiting for the user to approve a tool call in its thread',
	stopped: 'STOPPED before finishing (step limit or no progress)',
	failed: 'FAILED',
	timed_out: 'TIMED OUT and was stopped',
};

/** What the parent model reads. Facts first; the child's own account is labelled as such. */
export function formatSubagentReport(r: SubagentReport): string {
	const lines: string[] = [];
	lines.push(`Subagent "${r.description}" (${r.agent}, session ${r.sessionID}) ${STATUS_LINE[r.status]} after ${Math.round(r.durationMs / 1000)}s.`);
	if (r.awaitingApprovalOf) { lines.push(`Waiting on: ${r.awaitingApprovalOf}`); }
	const calls = Object.entries(r.toolCalls.byName).map(([n, c]) => `${n}×${c}`).join(', ');
	lines.push(`Tool calls: ${r.toolCalls.total}${r.toolCalls.failed ? ` (${r.toolCalls.failed} failed)` : ''}${calls ? ` — ${calls}` : ''}`);
	lines.push(`Files changed: ${r.filesChanged.length ? r.filesChanged.join(', ') : 'none'}`);
	if (r.problems.length) { lines.push(`Problems:\n${r.problems.map(p => `  - ${p}`).join('\n')}`); }
	lines.push(`\nThe subagent's own report (not verified by Kodia):\n${r.output.trim() || '(it gave no final reply)'}`);
	if (r.status !== 'completed') {
		lines.push(`\nTo continue this subagent, call subagent again with session_i_d="${r.sessionID}" and a follow-up prompt.`);
	}
	return lines.join('\n');
}
