/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { RawToolParamsObj } from './sendLLMMessageTypes.js';

export interface ToolParamRepairResult {
	readonly repairedParams: RawToolParamsObj;
	readonly repairs: string[];
}

const URI_TOOLS = new Set([
	'read_file', 'write_file', 'rewrite_file', 'edit_file', 'create_file_or_folder',
	'delete_file_or_folder', 'ls_dir', 'get_dir_tree', 'search_in_file', 'read_lint_errors',
	'go_to_definition', 'find_references', 'file_metadata',
	'read_notebook', 'write_notebook', 'edit_notebook', 'execute_notebook', 'execute_notebook_cell', 'select_notebook_kernel',
]);

const COMMAND_TOOLS = new Set([
	'run_command', 'run_persistent_command', 'dev_server_start', 'dep_install', 'db_migrate', 'lint_run',
]);

const QUERY_TOOLS = new Set([
	'search_for_files', 'search_in_file', 'search_pathnames_only', 'search_symbols',
	'code_search', 'code_search_literal', 'web_search',
]);

const CONTENT_TOOLS = new Set(['write_file', 'rewrite_file']);

function isAbsolutePathOrUri(value: string): boolean {
	if (value.includes('://')) { return true; }
	if (value.startsWith('/') || value.startsWith('\\')) { return true; }
	if (/^[a-zA-Z]:[\\/]/.test(value)) { return true; }
	return false;
}

function joinWorkspacePath(workspaceRoot: string, rel: string): string {
	const cleaned = rel.replace(/^\.[\\/]/, '');
	const sep = workspaceRoot.includes('\\') ? '\\' : '/';
	const base = workspaceRoot.replace(/[\\/]+$/, '');
	return `${base}${sep}${cleaned.replace(/[\\/]/g, sep)}`;
}

function pickFirstString(obj: Record<string, unknown>, keys: readonly string[]): { key: string; value: string } | undefined {
	for (const k of keys) {
		const v = obj[k];
		if (typeof v === 'string' && v.length > 0) {
			return { key: k, value: v };
		}
	}
	return undefined;
}

/**
 * Deterministically repair common LLM tool-argument mistakes before parameter validation.
 *
 * Designed specifically to make BYOK / open-weight models (NVIDIA, Llama, Qwen, DeepSeek,
 * Mistral, etc.) execute tools cleanly on the first attempt without wasting turns on
 * avoidable parameter-name or relative-path validation errors.
 */
export function repairToolParams(
	toolName: string,
	rawParams: RawToolParamsObj,
	workspaceRoot?: string,
): ToolParamRepairResult {
	if (!rawParams || typeof rawParams !== 'object') {
		return { repairedParams: rawParams, repairs: [] };
	}

	const next: Record<string, unknown> = { ...(rawParams as Record<string, unknown>) };
	const repairs: string[] = [];

	// 1. URI / path alias remapping
	if (URI_TOOLS.has(toolName) && (next.uri === undefined || next.uri === null || next.uri === '')) {
		const found = pickFirstString(next, ['file_path', 'path', 'filepath', 'file', 'filename', 'target_file', 'dir', 'directory', 'folder', 'folder_path']);
		if (found) {
			next.uri = found.value;
			repairs.push(`${found.key}→uri`);
		}
	}

	// 2. move_or_rename_file aliases
	if (toolName === 'move_or_rename_file') {
		if (!next.source_uri) {
			const src = pickFirstString(next, ['source', 'from', 'src', 'old_path', 'old_uri', 'source_path']);
			if (src) { next.source_uri = src.value; repairs.push(`${src.key}→source_uri`); }
		}
		if (!next.target_uri) {
			const dst = pickFirstString(next, ['target', 'to', 'dst', 'dest', 'destination', 'new_path', 'new_uri', 'target_path']);
			if (dst) { next.target_uri = dst.value; repairs.push(`${dst.key}→target_uri`); }
		}
	}

	// 3. write_file / rewrite_file content alias remapping
	if (CONTENT_TOOLS.has(toolName) && next.new_content === undefined) {
		for (const alias of ['content', 'text', 'code', 'file_content', 'body', 'newContent']) {
			if (typeof next[alias] === 'string') {
				next.new_content = next[alias];
				repairs.push(`${alias}→new_content`);
				break;
			}
		}
	}

	// 4. edit_file: synthesize search_replace_blocks when model emits old_string/new_string
	if (toolName === 'edit_file' && !next.search_replace_blocks) {
		const oldVal = typeof next.old_string === 'string' ? next.old_string
			: typeof next.old_text === 'string' ? next.old_text
				: typeof next.search === 'string' ? next.search
					: typeof next.original === 'string' ? next.original
						: undefined;
		const newVal = typeof next.new_string === 'string' ? next.new_string
			: typeof next.new_text === 'string' ? next.new_text
				: typeof next.replace === 'string' ? next.replace
					: typeof next.updated === 'string' ? next.updated
						: undefined;
		if (oldVal !== undefined && newVal !== undefined) {
			next.search_replace_blocks = `<<<<<<< ORIGINAL\n${oldVal}\n=======\n${newVal}\n>>>>>>> UPDATED`;
			repairs.push('old_string/new_string→search_replace_blocks');
		}
	}

	// 5. Command tool alias remapping
	if (COMMAND_TOOLS.has(toolName) && !next.command) {
		const found = pickFirstString(next, ['cmd', 'shell_command', 'script']);
		if (found) {
			next.command = found.value;
			repairs.push(`${found.key}→command`);
		}
	}

	// 6. Query tool alias remapping
	if (QUERY_TOOLS.has(toolName) && !next.query) {
		const found = pickFirstString(next, ['pattern', 'search_query', 'q', 'text', 'regex', 'term']);
		if (found) {
			next.query = found.value;
			repairs.push(`${found.key}→query`);
		}
	}

	// 7. read_file line range aliases
	if (toolName === 'read_file') {
		if (next.start_line === undefined && next.startLine !== undefined) { next.start_line = next.startLine; repairs.push('startLine→start_line'); }
		if (next.start_line === undefined && next.line_start !== undefined) { next.start_line = next.line_start; repairs.push('line_start→start_line'); }
		if (next.end_line === undefined && next.endLine !== undefined) { next.end_line = next.endLine; repairs.push('endLine→end_line'); }
		if (next.end_line === undefined && next.line_end !== undefined) { next.end_line = next.line_end; repairs.push('line_end→end_line'); }
	}

	// 8. subagent role aliases
	if (toolName === 'subagent') {
		if (!next.agent) {
			const found = pickFirstString(next, ['role', 'type', 'subagent_type', 'specialist']);
			if (found) { next.agent = found.value; repairs.push(`${found.key}→agent`); }
		}
		if (!next.prompt) {
			const found = pickFirstString(next, ['task', 'instruction', 'instructions', 'message']);
			if (found) { next.prompt = found.value; repairs.push(`${found.key}→prompt`); }
		}
		if (!next.description && typeof next.prompt === 'string') {
			next.description = next.prompt.trim().slice(0, 60);
			repairs.push('synthesized description');
		}
	}

	// 9. Resolve workspace-relative paths for URI parameters when workspace root is known
	if (workspaceRoot) {
		for (const uriKey of ['uri', 'source_uri', 'target_uri'] as const) {
			const raw = next[uriKey];
			if (typeof raw === 'string' && raw.trim() && !isAbsolutePathOrUri(raw.trim())) {
				next[uriKey] = joinWorkspacePath(workspaceRoot, raw.trim());
				repairs.push(`resolved relative ${uriKey}`);
			}
		}
	}

	return {
		repairedParams: next as RawToolParamsObj,
		repairs,
	};
}
