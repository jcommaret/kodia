/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Small-context models: Kodia offers ~130 tools, ~13k tokens of definitions (as XML in the system prompt, or as
 * native tool schemas — the same order either way). On a 16k-token model that is most of the window before the
 * conversation starts, and the prompt gets trimmed. When the full set takes more than TOOLS_SHARE_OF_CONTEXT of the
 * window, a prioritized subset that fits is offered instead, and the model is told which tool groups were left out.
 */

import { InternalToolInfo } from './prompt/prompts.js';

export const TOOLS_SHARE_OF_CONTEXT = 0.5;

// What a coding agent needs most, most important first. Tools not listed come after, in their usual order.
const TOOL_PRIORITY: readonly string[] = [
	// read, find, change files
	'read_file', 'edit_file', 'write_file', 'create_file_or_folder', 'ls_dir', 'search_for_files', 'search_pathnames_only', 'search_in_file',
	'code_semantic_search', 'code_keyword_search', 'rewrite_file', 'delete_file_or_folder', 'get_dir_tree', 'read_lint_errors',
	// run things
	'run_command', 'open_persistent_terminal', 'run_persistent_command', 'kill_persistent_terminal',
	// understand code
	'go_to_definition', 'find_references', 'search_symbols',
	// plan, remember, verify
	'todo', 'write_project_memory', 'test_discover', 'test_run', 'test_rerun_failed',
	// git basics
	'git_status', 'git_diff', 'git_log', 'git_branch_create', 'git_branch_switch', 'git_stage', 'git_commit', 'git_continue', 'git_abort',
	// delegate, look things up
	'subagent', 'fetch_url', 'web_search',
	// browser basics
	'browser_launch', 'browser_new_tab', 'browser_navigate', 'browser_inspect_page', 'browser_click_element', 'browser_fill_element', 'browser_reload', 'browser_console', 'browser_close',
];

export type ToolBudgetResult = { tools: InternalToolInfo[]; omitted: string[]; usedTokens: number; fullTokens: number };

export function toolDefinitionTokens(tool: InternalToolInfo, countTokens: (s: string) => number): number {
	return countTokens(JSON.stringify({ name: tool.name, description: tool.description, params: tool.params }));
}

/**
 * The tools to offer a model with this context window: undefined when the full set fits (nothing changes), else a
 * prioritized subset within TOOLS_SHARE_OF_CONTEXT of the window and the names of the tools left out.
 */
export function toolsWithinBudget(tools: InternalToolInfo[], contextWindow: number, countTokens: (s: string) => number): ToolBudgetResult | undefined {
	const cost = new Map(tools.map(t => [t.name, toolDefinitionTokens(t, countTokens)]));
	const fullTokens = [...cost.values()].reduce((a, b) => a + b, 0);
	const budget = Math.floor(contextWindow * TOOLS_SHARE_OF_CONTEXT);
	if (fullTokens <= budget) return undefined;

	const rank = (name: string) => { const i = TOOL_PRIORITY.indexOf(name); return i === -1 ? TOOL_PRIORITY.length : i; };
	const ordered = tools.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t.name) - rank(b.t.name) || a.i - b.i).map(x => x.t);
	const kept: InternalToolInfo[] = [];
	const omitted: string[] = [];
	let used = 0;
	for (const t of ordered) {
		const c = cost.get(t.name)!;
		if (used + c <= budget) { kept.push(t); used += c; }
		else omitted.push(t.name);
	}
	// keep the usual order in what is offered
	const order = new Map(tools.map((t, i) => [t.name, i]));
	kept.sort((a, b) => order.get(a.name)! - order.get(b.name)!);
	return { tools: kept, omitted, usedTokens: used, fullTokens };
}

/** "browser_* (12), debug_* (20), ..." — what the model is told it does not have, compactly */
export function describeOmittedTools(omitted: string[]): string {
	const groups = new Map<string, number>();
	for (const name of omitted) {
		const g = name.includes('_') ? `${name.split('_')[0]}_*` : name;
		groups.set(g, (groups.get(g) ?? 0) + 1);
	}
	const list = [...groups].sort((a, b) => b[1] - a[1]).map(([g, n]) => n > 1 ? `${g} (${n})` : g).join(', ');
	return `To fit this model's context window, only the tools listed here are available in this conversation; ${omitted.length} others are not (${list}). A model with a larger context window gets all of them.`;
}
