/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ChatMode, ModelSelection } from './voidSettingsTypes.js';

export const MODEL_ROUTING_ROLES = [
	'planning',
	'coding',
	'debugging',
	'explore',
	'review',
	'security',
	'testing',
	'docs',
] as const;

export type ModelRoutingRole = (typeof MODEL_ROUTING_ROLES)[number];

export const MODEL_ROUTING_ROLE_LABELS: Readonly<Record<ModelRoutingRole, { label: string; description: string }>> = {
	planning: { label: 'Planning & Architecture', description: 'Plan mode, planner & architect subagents' },
	coding: { label: 'Implementation & Refactoring', description: 'General, frontend, backend, database, api, refactor subagents' },
	debugging: { label: 'Debugging', description: 'Debug mode and debugging subagents' },
	explore: { label: 'Fast Exploration', description: 'Explore subagents (fast/cheap model works well)' },
	review: { label: 'Code Review', description: 'Review & performance subagents' },
	security: { label: 'Security Audit', description: 'Security specialist subagents' },
	testing: { label: 'Testing & Browser QA', description: 'Testing & browser specialist subagents' },
	docs: { label: 'Documentation', description: 'Docs specialist subagents' },
};

export function modelSelectionKey(sel: ModelSelection): string {
	return `${sel.providerName}::${sel.modelName}`;
}

/**
 * Map a chat mode or specialist agent role to its routing bucket.
 */
export function routingRoleForContext(opts: { chatMode?: ChatMode; subagentRole?: string }): ModelRoutingRole | undefined {
	const role = opts.subagentRole?.toLowerCase();
	if (role) {
		if (role === 'explore') { return 'explore'; }
		if (role === 'planner' || role === 'architect' || role === 'ai_architect' || role === 'ai_research') { return 'planning'; }
		if (role === 'security' || role === 'ai_security') { return 'security'; }
		if (role === 'debugging') { return 'debugging'; }
		if (role === 'review' || role === 'performance') { return 'review'; }
		if (role === 'testing' || role === 'browser' || role === 'ai_eval') { return 'testing'; }
		if (role === 'docs') { return 'docs'; }
		return 'coding';
	}
	if (opts.chatMode === 'plan') { return 'planning'; }
	if (opts.chatMode === 'debug') { return 'debugging'; }
	return undefined;
}

/**
 * Resolve the effective model selection taking optional role-based routing into account.
 * Explicit per-call overrides (e.g. a subagent specifying `model`) take precedence.
 */
export function resolveRoutedModelSelection(opts: {
	primary: ModelSelection | null;
	routingMap?: Readonly<Record<string, ModelSelection | null | undefined>>;
	chatMode?: ChatMode;
	subagentRole?: string;
	explicitOverride?: ModelSelection | null;
}): { selection: ModelSelection | null; routedRole?: ModelRoutingRole } {
	if (opts.explicitOverride) {
		return { selection: opts.explicitOverride };
	}
	const bucket = routingRoleForContext({ chatMode: opts.chatMode, subagentRole: opts.subagentRole });
	if (bucket && opts.routingMap) {
		const routed = opts.routingMap[bucket];
		if (routed && routed.providerName && routed.modelName) {
			return { selection: routed, routedRole: bucket };
		}
	}
	return { selection: opts.primary };
}

/**
 * Determine whether an LLM provider failure should trigger automatic fallback to the
 * next configured fallback model. Auth errors, rate limits, 5xx outages, timeouts, and
 * network failures qualify; context-length errors are handled by compaction first.
 */
export function isFallbackEligibleError(message: string, status?: number | null): boolean {
	if (typeof status === 'number') {
		if (status === 429 || status === 408 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529) {
			return true;
		}
		if (status === 401 || status === 403 || status === 404) {
			return true;
		}
	}
	const m = message.toLowerCase();
	return (
		/\b429\b|rate.?limit|too many requests|quota exceeded/.test(m)
		|| /\b50[0234]\b|\b529\b|overloaded|service unavailable|bad gateway|internal server error/.test(m)
		|| /sent no output for|timed?\s*out|etimedout|econnrefused|econnreset|enotfound|fetch failed|network error|socket hang up/.test(m)
		|| /model not found|does not exist|unauthorized|invalid api key/.test(m)
	);
}

/**
 * Pick the next untried fallback model from the user's ordered fallback list.
 */
export function selectNextFallbackModel(
	triedKeys: ReadonlySet<string>,
	fallbacks: readonly ModelSelection[] | undefined,
): ModelSelection | undefined {
	if (!fallbacks || fallbacks.length === 0) {
		return undefined;
	}
	for (const candidate of fallbacks) {
		if (!candidate || !candidate.providerName || !candidate.modelName) { continue; }
		const key = modelSelectionKey(candidate);
		if (!triedKeys.has(key)) {
			return candidate;
		}
	}
	return undefined;
}
