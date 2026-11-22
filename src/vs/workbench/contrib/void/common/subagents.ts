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

export type SubagentType = 'general' | 'explore' | 'review';

export const SUBAGENT_TYPES: { readonly [T in SubagentType]: { readonly canChangeFiles: boolean; readonly description: string } } = {
	general: { canChangeFiles: true, description: 'can read, edit and create files and run commands' },
	explore: { canChangeFiles: false, description: 'read-only: searches and reads the codebase and reports' },
	review: { canChangeFiles: false, description: 'read-only: reviews code or changes and reports problems' },
};

// common names models use for the same roles
const SUBAGENT_TYPE_ALIASES: Readonly<Record<string, SubagentType>> = {
	general: 'general', 'general-purpose': 'general', build: 'general', code: 'general', coder: 'general', implement: 'general', test: 'general', tests: 'general', fix: 'general',
	explore: 'explore', research: 'explore', search: 'explore', investigate: 'explore',
	review: 'review', reviewer: 'review', 'code-review': 'review',
};

/** The subagent type a model asked for, or an error listing the valid ones. */
export function resolveSubagentType(requested: string): { type: SubagentType } | { error: string } {
	const t = SUBAGENT_TYPE_ALIASES[requested.trim().toLowerCase()];
	if (t) { return { type: t }; }
	const valid = (Object.keys(SUBAGENT_TYPES) as SubagentType[]).map(k => `"${k}" (${SUBAGENT_TYPES[k].description})`).join(', ');
	return { error: `Unknown subagent type "${requested}". Use one of: ${valid}.` };
}

/** Subagents cannot start subagents: one level of delegation keeps cost and coordination bounded. */
export const SUBAGENT_TOOL_NAME = 'subagent';
export const MAX_PARALLEL_SUBAGENTS = 4;
export const SUBAGENT_TIMEOUT_MS = 30 * 60_000;

/**
 * The tools a subagent of this type is offered and allowed to run.
 * @param allTools every tool the parent's mode offers
 * @param needsApproval whether a builtin tool changes something (has an approval type) — read-only agents get none of those
 */
export function subagentToolNames(type: SubagentType, allTools: readonly string[], needsApproval: (toolName: string) => boolean): string[] {
	return allTools.filter(name => name !== SUBAGENT_TOOL_NAME && (SUBAGENT_TYPES[type].canChangeFiles || !needsApproval(name)));
}

/** Told to the subagent in its system prompt: its reply is a report to another agent, not a chat with the user. */
export function subagentRoleText(type: SubagentType, description: string): string {
	return [
		`YOU ARE A SUBAGENT ("${description}", type ${type}: ${SUBAGENT_TYPES[type].description}).`,
		'Another agent gave you the task in the user message below; it does not see your tool calls, only your final reply. The user is not watching this conversation, so do not ask questions: decide, and say what you assumed.',
		SUBAGENT_TYPES[type].canChangeFiles
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
