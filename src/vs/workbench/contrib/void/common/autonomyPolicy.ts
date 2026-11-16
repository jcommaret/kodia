/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { ToolApprovalType, approvalTypeOfBuiltinToolName, type BuiltinToolName } from './toolsServiceTypes.js';
import { isDestructiveCommand } from './terminalSafety.js';

// Complete set of builtin tool names (keys of BuiltinToolCallParams / BuiltinToolResultType).
// Kept here to avoid importing from prompt/prompts.ts (which has a large dependency chain).
const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
	'read_file',
	'ls_dir',
	'get_dir_tree',
	'search_pathnames_only',
	'search_for_files',
	'search_in_file',
	'go_to_definition',
	'find_references',
	'search_symbols',
	'read_lint_errors',
	'read_project_memory',
	'fetch_url',
	'web_search',
	// Browser automation
	'browser_launch',
	'browser_close',
	'browser_list_sessions',
	'browser_new_tab',
	'browser_list_tabs',
	'browser_switch_tab',
	'browser_close_tab',
	'browser_navigate',
	'browser_back',
	'browser_forward',
	'browser_reload',
	'browser_inspect_page',
	'browser_click_element',
	'browser_fill_element',
	'browser_select_option',
	'browser_check_element',
	'browser_submit_form',
	'browser_wait_for_element',
	'browser_screenshot',
	'browser_console',
	'browser_network_failures',
	'browser_download',
	'browser_list_downloads',
	'browser_shutdown',
	// Debugger automation
	'debug_list_configurations',
	'debug_list_sessions',
	'debug_get_session_status',
	'debug_list_threads',
	'debug_start_session',
	'debug_attach_session',
	'debug_stop_session',
	'debug_restart_session',
	'debug_set_breakpoint',
	'debug_remove_breakpoint',
	'debug_set_breakpoint_enabled',
	'debug_list_breakpoints',
	'debug_continue',
	'debug_pause',
	'debug_step_over',
	'debug_step_into',
	'debug_step_out',
	'debug_get_stack_trace',
	'debug_get_scopes',
	'debug_get_variables',
	'debug_evaluate_expression',
	'debug_get_exception_info',
	'debug_get_console_output',
	'create_file_or_folder',
	'delete_file_or_folder',
	'rewrite_file',
	'edit_file',
	'write_project_memory',
	'run_command',
	'open_persistent_terminal',
	'run_persistent_command',
	'kill_persistent_terminal',
	// Terminal session management (Stage 5A Day 1)
	'list_terminals',
	'read_terminal',
	'send_command_to_terminal',
	'interrupt_terminal',
	'close_terminal',
	// Git operations (Stage 2)
	'git_status',
	'git_diff',
	'git_log',
	'git_branch_list',
	'git_branch_create',
	'git_branch_switch',
	'git_stage',
	'git_unstage',
	'git_commit',
	'git_fetch',
	'git_pull',
	'git_push',
	'git_merge',
	'git_stash',
	'git_stash_pop',
	'git_show',
	// Test discovery and execution (Stage 3)
	'test_discover',
	'test_list',
	'test_run',
	'test_run_targeted',
	'test_rerun_failed',
	'test_cancel',
]);

/**
 * The three configurable autonomy modes.
 *
 * - 'assist': The agent inspects files and understands projects. Asks before
 *   significant modifications or consequential terminal operations. Keeps the
 *   user involved in execution decisions.
 * - 'agent' (DEFAULT): Broad filesystem access across the computer. Reads,
 *   creates, edits, moves and deletes files. Executes terminal commands. Does
 *   not require approval simply because a path is outside the workspace. Avoids
 *   repetitive prompts for ordinary development work. Retains safeguards for
 *   genuinely consequential operations.
 * - 'autonomous': Long-running development tasks with minimal interruptions.
 *   Continues through multi-step tasks without confirmation for every operation.
 *   Pauses only for configured high-impact actions, missing credentials,
 *   unavailable resources or decisions that genuinely require the user.
 */
export type AutonomyMode = 'assist' | 'agent' | 'autonomous';
export const autonomyModes: AutonomyMode[] = ['assist', 'agent', 'autonomous'];

export const defaultAutonomyMode: AutonomyMode = 'agent';

export type OperationRisk = 'low' | 'medium' | 'high' | 'critical';

export type ApprovalDecision = 'allow' | 'requireApproval' | 'block';

export interface AutonomyEvaluation {
	decision: ApprovalDecision;
	risk: OperationRisk;
	reason: string;
}

// Per-operation approval policy override. Keys are either a BuiltinToolName or
// a ToolApprovalType. Values override the mode-derived decision for that
// operation. Used to make consequential actions understandable and configurable.
export type AutonomyOperationPolicy = {
	[operation: string]: 'allow' | 'requireApproval' | 'block';
};

/**
 * Classifies the intrinsic risk of a builtin tool call, independent of where
 * the target path lives. Workspace location is deliberately NOT a risk factor:
 * access outside the workspace must not, by itself, require approval.
 *
 * Risk is elevated for destructive operations (recursive deletes) regardless of
 * mode, since those are irreversible and genuinely consequential.
 */
export function assessRisk(toolName: string, params: unknown): OperationRisk {
	switch (toolName) {
		// Reads and inspections - never consequential.
		case 'read_file':
		case 'ls_dir':
		case 'get_dir_tree':
		case 'search_pathnames_only':
		case 'search_for_files':
		case 'search_in_file':
		case 'go_to_definition':
		case 'find_references':
		case 'read_lint_errors':
		case 'read_project_memory':
		case 'web_search':
		case 'fetch_url':
			return 'low';

		// Ordinary development writes and terminal use.
		case 'create_file_or_folder':
		case 'rewrite_file':
		case 'write_file':
		case 'edit_file':
		case 'write_project_memory':
		case 'run_command':
		case 'run_persistent_command':
		case 'open_persistent_terminal':
		case 'kill_persistent_terminal':
		case 'send_command_to_terminal':
		case 'interrupt_terminal':
		case 'close_terminal': {
			// Terminal commands that are destructive (rm -rf, format, etc.)
			// are elevated to critical risk regardless of mode.
			const p = params as { command?: string } | undefined;
			if (p && p.command && typeof p.command === 'string') {
				if (isDestructiveCommand(p.command)) {
					return 'critical';
				}
			}
			return 'medium';
		}

		// Read-only terminal inspection - never consequential.
		case 'list_terminals':
		case 'read_terminal':
			return 'low';

		// Task planning - read-only planning, no file/system changes.
		case 'create_task_plan':
		case 'update_task_plan':
		case 'get_task_plan':
		case 'todo':
		case 'subagent':
			return 'low';

		// Git read-only operations - inspection only.
		case 'git_status':
		case 'git_diff':
		case 'git_log':
		case 'git_branch_list':
		case 'git_show':
			return 'low';

		// Git operations that modify the local repository.
		case 'git_branch_create':
		case 'git_branch_switch':
		case 'git_stage':
		case 'git_unstage':
		case 'git_commit':
		case 'git_stash':
		case 'git_stash_pop':
			return 'medium';

		// Git operations that interact with remotes or can be destructive.
		case 'git_fetch':
		case 'git_pull':
			return 'medium';

		case 'git_push': {
			const p = params as { force?: boolean } | undefined;
			if (p && p.force) return 'critical';
			return 'high';
		}

		case 'git_merge':
			// Merging can create conflicts; classify as medium (user should review)
			return 'medium';

		// Test operations - read-only
		case 'test_discover':
		case 'test_list':
		case 'test_cancel':
			return 'low';

		// Test operations - execute code (may have side effects via test setup/teardown)
		case 'test_run':
		case 'test_run_targeted':
		case 'test_rerun_failed':
			return 'medium';

		// Destructive / irreversible.
		case 'delete_file_or_folder': {
			const p = params as { isRecursive?: boolean } | undefined;
			if (p && p.isRecursive) {
				return 'critical';
			}
			return 'high';
		}

		// Browser automation - reads and inspections are low risk.
		case 'browser_launch':
		case 'browser_close':
		case 'browser_list_sessions':
		case 'browser_new_tab':
		case 'browser_list_tabs':
		case 'browser_switch_tab':
		case 'browser_close_tab':
		case 'browser_back':
		case 'browser_forward':
		case 'browser_reload':
		case 'browser_inspect_page':
		case 'browser_wait_for_element':
		case 'browser_set_viewport':
		case 'browser_screenshot':
		case 'browser_console':
		case 'browser_network_failures':
		case 'browser_list_downloads':
		case 'browser_shutdown':
			return 'low';

		// Debugger automation - inspection is low risk.
		case 'debug_list_configurations':
		case 'debug_list_sessions':
		case 'debug_get_session_status':
		case 'debug_list_threads':
		case 'debug_get_stack_trace':
		case 'debug_get_scopes':
		case 'debug_get_variables':
		case 'debug_list_breakpoints':
		case 'debug_get_exception_info':
		case 'debug_get_console_output':
			return 'low';

		// Debugger automation - session control, breakpoints, execution control,
		// and expression evaluation change the target's state or run code.
		case 'debug_start_session':
		case 'debug_attach_session':
		case 'debug_stop_session':
		case 'debug_restart_session':
		case 'debug_set_breakpoint':
		case 'debug_remove_breakpoint':
		case 'debug_set_breakpoint_enabled':
		case 'debug_continue':
		case 'debug_pause':
		case 'debug_step_over':
		case 'debug_step_into':
		case 'debug_step_out':
		case 'debug_evaluate_expression':
			return 'medium';

		// Browser interactions that change page state or trigger navigation/downloads.
		case 'browser_navigate':
		case 'browser_click_element':
		case 'browser_fill_element':
		case 'browser_select_option':
		case 'browser_check_element':
		case 'browser_submit_form':
		case 'browser_download':
			return 'medium';
	}
	return 'medium';
}

/**
 * The maximum risk level that each mode allows without requiring approval.
 * Operations at or above this level require approval (unless auto-approved or
 * overridden by the per-operation policy).
 *
 * - assist: medium and above require approval (edits/terminal need asking).
 * - agent:  high and above require approval (ordinary dev is auto-allowed).
 * - autonomous: high and above require approval (minimal interruptions).
 */
export function riskThresholdForApproval(mode: AutonomyMode): OperationRisk {
	switch (mode) {
		case 'assist': return 'medium';
		case 'agent': return 'high';
		case 'autonomous': return 'high';
	}
}

const riskOrder: OperationRisk[] = ['low', 'medium', 'high', 'critical'];
function riskAtLeast(risk: OperationRisk, threshold: OperationRisk): boolean {
	return riskOrder.indexOf(risk) >= riskOrder.indexOf(threshold);
}

/**
 * Centralized autonomy decision. This is the single place that decides whether
 * a tool call may proceed, requires approval, or is blocked. It is consulted by
 * every tool execution path (filesystem, search, terminal, persistent terminal).
 *
 * @param mode The configured autonomy mode.
 * @param autoApprove The persisted per-approval-type auto-approve flags.
 * @param operationPolicy Per-operation allow/requireApproval/block overrides.
 * @param toolName The tool being called.
 * @param params The validated tool parameters.
 * @param isOutsideWorkspace Whether the target path is outside the open workspace
 *   (used only for the reason string, never to gate access by itself).
 * @returns An AutonomyEvaluation with the decision, risk and reason.
 */
export function evaluateAutonomy({
	mode,
	autoApprove,
	operationPolicy,
	toolName,
	params,
	isOutsideWorkspace,
}: {
	mode: AutonomyMode;
	autoApprove: Partial<Record<ToolApprovalType, boolean>>;
	operationPolicy: AutonomyOperationPolicy;
	toolName: string;
	params: unknown;
	isOutsideWorkspace: boolean;
}): AutonomyEvaluation {

	const risk = assessRisk(toolName, params);
	const isBuiltin = BUILTIN_TOOL_NAMES.has(toolName);
	const approvalType = isBuiltin
		? approvalTypeOfBuiltinToolName[toolName as BuiltinToolName]
		: 'MCP tools';

	// 1. Explicit per-operation policy override takes precedence.
	//    Explicit `allow` does not bypass critical safeguards unless
	//    auto-approved as well (both together indicate explicit user intent).
	const override = operationPolicy[toolName] ?? (approvalType ? operationPolicy[approvalType] : undefined);
	if (override) {
		if (override === 'allow' && risk === 'critical') {
			if (approvalType && autoApprove[approvalType as ToolApprovalType]) {
				return {
					decision: 'allow',
					risk,
					reason: `Per-operation autonomy policy: allow (auto-approved).`,
				};
			}
			// Explicit allow alone does not bypass critical safeguards — fall through
		} else {
			const decision: ApprovalDecision = override;
			return {
				decision,
				risk,
				reason: `Per-operation autonomy policy: ${override}.`,
			};
		}
	}

	// 2. Mode-derived threshold.
	const threshold = riskThresholdForApproval(mode);
	const needsApproval = riskAtLeast(risk, threshold);

	if (!needsApproval) {
		return {
			decision: 'allow',
			risk,
			reason: `Risk '${risk}' is below the ${mode} mode approval threshold ('${threshold}').`,
		};
	}

	// 3. Above the threshold: require approval unless this approval type is auto-approved.
	//    Auto-approve alone does not bypass critical safeguards.
	if (approvalType && autoApprove[approvalType as ToolApprovalType]) {
		if (risk !== 'critical') {
			return {
				decision: 'allow',
				risk,
				reason: `Approval type '${approvalType}' is auto-approved.`,
			};
		}
		// Critical risk + auto-approved alone → requireApproval below
	}

	return {
		decision: 'requireApproval',
		risk,
		reason: `Risk '${risk}' meets or exceeds the ${mode} mode approval threshold ('${threshold}') and '${approvalType ?? 'unknown'}' is not auto-approved.` +
			(isOutsideWorkspace ? ' Target is outside the workspace.' : ''),
	};
}

/**
 * Helper: determine whether a file URI is outside the open workspace folders.
 * Lexical check only; does not resolve symlinks/junctions. Used solely to
 * annotate the approval reason, never to deny access.
 */
export function isPathOutsideWorkspace(uri: URI | null | undefined, workspaceFolders: { uri: URI }[]): boolean {
	if (!uri || uri.scheme !== 'file') return false;
	return !workspaceFolders.some(folder =>
		extUriBiasedIgnorePathCase.isEqualOrParent(uri, folder.uri)
	);
}
