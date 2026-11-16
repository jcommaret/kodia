import { URI } from '../../../../base/common/uri.js'
import { RawMCPToolCall } from './mcpServiceTypes.js';
import { builtinTools } from './prompt/prompts.js';
import { RawToolParamsObj } from './sendLLMMessageTypes.js';
import { SearchResult } from './webSearchTypes.js';
import { TerminalInfo } from '../browser/terminalToolService.js';
import { DebugConfiguration, DebugSessionInfo, DebugThread, DebugScope, DebugVariable, DebugBreakpoint, DebugStackTrace, DebugEvaluateResult, DebugExceptionInfo, ConsoleOutputEntry } from './debugServiceTypes.js';
import { TaskPlan, TaskStatus } from './autonomousTask.js';
import { GitRepositoryStatus, GitDiffResult, GitCommitLogEntry, GitBranchInfo } from './gitService.js';
import { TestFramework, TestFileInfo, TestRunResultData } from './testServiceTypes.js';



export type TerminalResolveReason = { type: 'timeout' } | { type: 'done', exitCode: number }

export type LintErrorItem = { code: string, message: string, startLineNumber: number, endLineNumber: number }

// a place in the code, with the text there (the LLM can pass uri + line straight back to other tools)
export type CodeLocation = { uri: URI, line: number, snippet: string }

export type WorkspaceSymbolEntry = { name: string, kind: string, containerName: string | undefined, uri: URI, line: number | undefined }

// Partial of IFileStat
export type ShallowDirectoryItem = {
	uri: URI;
	name: string;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

// Browser element discovered on a page, safe to pass back to interaction tools.
export type BrowserElement = {
	selector: string;
	type: 'button' | 'link' | 'input' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'menu' | 'other';
	label: string;
	value?: string;
	placeholder?: string;
	disabled: boolean;
	readonly: boolean;
	checked?: boolean;
	options?: string[];
	bbox?: { x: number; y: number; width: number; height: number };
};


export const approvalTypeOfBuiltinToolName: Partial<{ [T in BuiltinToolName]?: 'edits' | 'terminal' | 'web pages' | 'MCP tools' | 'planning' | 'git' | 'test' | 'browser' | 'debug' }> = {
	'create_file_or_folder': 'edits',
	'delete_file_or_folder': 'edits',
	'rewrite_file': 'edits',
	'write_file': 'edits',
	'edit_file': 'edits',
	'write_project_memory': 'edits',
	'run_command': 'terminal',
	'run_persistent_command': 'terminal',
	'open_persistent_terminal': 'terminal',
	'kill_persistent_terminal': 'terminal',
	'send_command_to_terminal': 'terminal',
	'interrupt_terminal': 'terminal',
	'close_terminal': 'terminal',
	// task planning - read-only planning, no file/system changes
	'create_task_plan': 'planning',
	'update_task_plan': 'planning',
	'get_task_plan': 'planning',
	// git operations - read-only
	'git_status': 'git',
	'git_diff': 'git',
	'git_log': 'git',
	'git_branch_list': 'git',
	'git_show': 'git',
	// git operations - local modifications
	'git_branch_create': 'git',
	'git_branch_switch': 'git',
	'git_stage': 'git',
	'git_unstage': 'git',
	'git_commit': 'git',
	'git_stash': 'git',
	'git_stash_pop': 'git',
	// git operations - network/destructive
	'git_fetch': 'git',
	'git_pull': 'git',
	'git_push': 'git',
	'git_merge': 'git',
	// test operations - read-only
	'test_discover': 'test',
	'test_list': 'test',
	'test_run': 'test',
	'test_run_targeted': 'test',
	'test_rerun_failed': 'test',
	'test_cancel': 'test',
	// a fetched URL can carry data out of the workspace, so the user sees it first
	'fetch_url': 'web pages',
	'web_search': 'web pages',
	// Browser automation - reads are low risk, writes/interactions are medium
	'browser_launch': 'browser',
	'browser_close': 'browser',
	'browser_list_sessions': 'browser',
	'browser_new_tab': 'browser',
	'browser_list_tabs': 'browser',
	'browser_switch_tab': 'browser',
	'browser_close_tab': 'browser',
	'browser_navigate': 'browser',
	'browser_back': 'browser',
	'browser_forward': 'browser',
	'browser_reload': 'browser',
	'browser_inspect_page': 'browser',
	'browser_click_element': 'browser',
	'browser_fill_element': 'browser',
	'browser_select_option': 'browser',
	'browser_check_element': 'browser',
	'browser_submit_form': 'browser',
	'browser_wait_for_element': 'browser',
	'browser_set_viewport': 'browser',
	'browser_screenshot': 'browser',
	'browser_console': 'browser',
	'browser_network_failures': 'browser',
	'browser_download': 'browser',
	'browser_list_downloads': 'browser',
	'browser_shutdown': 'browser',
	// Dev server automation - starting/stopping local dev servers
	'dev_server_start': 'terminal',
	'dev_server_stop': 'terminal',
	'dev_server_list': 'terminal',
	'dev_server_status': 'terminal',
	// Direct API testing - calling backend APIs outside the browser
	'api_request': 'web pages',
	'port_check': 'terminal',
	// Debugger automation - inspection is low risk; session/breakpoint/execution
	// control and expression evaluation are medium risk.
	'debug_list_configurations': 'debug',
	'debug_list_sessions': 'debug',
	'debug_get_session_status': 'debug',
	'debug_list_threads': 'debug',
	'debug_get_stack_trace': 'debug',
	'debug_get_scopes': 'debug',
	'debug_get_variables': 'debug',
	'debug_list_breakpoints': 'debug',
	'debug_get_exception_info': 'debug',
	'debug_get_console_output': 'debug',
	'debug_start_session': 'debug',
	'debug_attach_session': 'debug',
	'debug_stop_session': 'debug',
	'debug_restart_session': 'debug',
	'debug_set_breakpoint': 'debug',
	'debug_remove_breakpoint': 'debug',
	'debug_set_breakpoint_enabled': 'debug',
	'debug_continue': 'debug',
	'debug_pause': 'debug',
	'debug_step_over': 'debug',
	'debug_step_into': 'debug',
	'debug_step_out': 'debug',
	'debug_evaluate_expression': 'debug',
	// notebook operations
	'read_notebook': 'edits',
	'write_notebook': 'edits',
	'edit_notebook': 'edits',
	'execute_notebook_cell': 'terminal',
	'execute_notebook': 'terminal',
	'select_notebook_kernel': 'edits',
}


export type ToolApprovalType = NonNullable<(typeof approvalTypeOfBuiltinToolName)[keyof typeof approvalTypeOfBuiltinToolName]> | 'planning';


export const toolApprovalTypes = new Set<ToolApprovalType>([
	...Object.values(approvalTypeOfBuiltinToolName),
	'MCP tools',
	'planning',
])




// PARAMS OF TOOL CALL
export type BuiltinToolCallParams = {
	'read_file': { uri: URI, startLine: number | null, endLine: number | null, pageNumber: number },
	'ls_dir': { uri: URI, pageNumber: number },
	'get_dir_tree': { uri: URI },
	'search_pathnames_only': { query: string, includePattern: string | null, pageNumber: number },
	'search_for_files': { query: string, isRegex: boolean, searchInFolder: URI | null, pageNumber: number },
	'search_in_file': { uri: URI, query: string, isRegex: boolean },
	'go_to_definition': { uri: URI, line: number, symbol: string },
	'find_references': { uri: URI, line: number, symbol: string },
	'search_symbols': { query: string },
	'read_lint_errors': { uri: URI },
	'read_project_memory': {},
	'fetch_url': { url: string, pageNumber: number },
	'web_search': { query: string, maxResults?: number },
	// Browser automation
	'browser_launch': { headless?: boolean, viewport?: { width: number; height: number } },
	'browser_close': { sessionId: string },
	'browser_list_sessions': {},
	'browser_new_tab': { sessionId: string, url?: string },
	'browser_list_tabs': { sessionId: string },
	'browser_switch_tab': { sessionId: string, tabId: string },
	'browser_close_tab': { sessionId: string, tabId: string },
	'browser_navigate': { sessionId: string, tabId: string, url: string },
	'browser_back': { sessionId: string, tabId: string },
	'browser_forward': { sessionId: string, tabId: string },
	'browser_reload': { sessionId: string, tabId: string },
	'browser_inspect_page': { sessionId: string, tabId: string },
	'browser_click_element': { sessionId: string, tabId: string, selector: string },
	'browser_fill_element': { sessionId: string, tabId: string, selector: string, text: string },
	'browser_select_option': { sessionId: string, tabId: string, selector: string, value: string },
	'browser_check_element': { sessionId: string, tabId: string, selector: string, checked: boolean },
	'browser_submit_form': { sessionId: string, tabId: string, selector: string },
	'browser_wait_for_element': { sessionId: string, tabId: string, selector: string, timeoutMs?: number },
	'browser_set_viewport': { sessionId: string, tabId: string, width: number, height: number },
	'browser_screenshot': { sessionId: string, tabId: string, type?: 'viewport' | 'fullpage' | 'element', selector?: string },
	'browser_console': { sessionId: string, tabId: string, level?: 'debug' | 'info' | 'warning' | 'error', limit?: number },
	'browser_network_failures': { sessionId: string, tabId: string },
	'browser_download': { sessionId: string, tabId: string, url: string },
	'browser_list_downloads': { sessionId: string },
	'browser_shutdown': {},
	// Dev server automation
	'dev_server_start': { command: string, cwd?: string | null, port?: number, name?: string },
	'dev_server_stop': { name?: string, terminal_id?: string },
	'dev_server_list': {},
	'dev_server_status': { name?: string, port?: number },
	// Direct API testing
	'api_request': { url: string, method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', headers?: Record<string, string>, body?: string, timeout_ms?: number },
	'port_check': { port: number },
	// Debugger automation
	'debug_list_configurations': {},
	'debug_list_sessions': {},
	'debug_get_session_status': { sessionId: string },
	'debug_list_threads': { sessionId: string },
	'debug_start_session': { configurationName: string, folder?: string, noDebug?: boolean },
	'debug_attach_session': { configurationName: string, folder?: string },
	'debug_stop_session': { sessionId: string, restart?: boolean, suspend?: boolean },
	'debug_restart_session': { sessionId: string },
	'debug_set_breakpoint': { sessionId?: string, uri: string, lineNumber: number, column?: number, condition?: string, hitCondition?: string, logMessage?: string },
	'debug_remove_breakpoint': { breakpointId: string },
	'debug_set_breakpoint_enabled': { breakpointId: string, enabled: boolean },
	'debug_list_breakpoints': {},
	'debug_continue': { sessionId: string, threadId: number },
	'debug_pause': { sessionId: string, threadId: number },
	'debug_step_over': { sessionId: string, threadId: number },
	'debug_step_into': { sessionId: string, threadId: number },
	'debug_step_out': { sessionId: string, threadId: number },
	'debug_get_stack_trace': { sessionId: string, threadId: number, startFrame?: number, levels?: number },
	'debug_get_scopes': { sessionId: string, frameId: number, threadId?: number },
	'debug_get_variables': { sessionId: string, variablesReference: number, start?: number, count?: number },
	'debug_evaluate_expression': { sessionId: string, expression: string, frameId?: number },
	'debug_get_exception_info': { sessionId: string, threadId: number },
	'debug_get_console_output': { sessionId?: string, limit?: number },
	// ---
	'rewrite_file': { uri: URI, newContent: string },
		// write_file: alias for rewrite_file
		'write_file': { uri: URI, newContent: string },
		'write_project_memory': { section: string, content: string },
	'edit_file': { uri: URI, searchReplaceBlocks: string },
	'create_file_or_folder': { uri: URI, isFolder: boolean },
	'delete_file_or_folder': { uri: URI, isRecursive: boolean, isFolder: boolean },
	// ---
	'run_command': { command: string; cwd: string | null, terminalId: string },
	'open_persistent_terminal': { cwd: string | null },
	'run_persistent_command': { command: string; persistentTerminalId: string },
	'kill_persistent_terminal': { persistentTerminalId: string },
	// Terminal session management (Stage 5A Day 1)
	'list_terminals': {},
	'read_terminal': { terminalId: string, offset?: number },
	'send_command_to_terminal': { terminalId: string, command: string },
	'interrupt_terminal': { terminalId: string },
	'close_terminal': { terminalId: string },
	// Task plan management (Stage 5A Day 2)
	'create_task_plan': { title: string, description: string, tasks: { title: string, description: string, dependencies: string[] }[] },
	'update_task_plan': { taskId: string, status: TaskStatus, result?: string | null, error?: string | null },
	'get_task_plan': {},
	// Test discovery and execution (Stage 3)
	'test_discover': {},
	'test_list': {},
	'test_run': { test_files?: string[], test_names?: string[] },
	'test_run_targeted': { changed_files: string[] },
	'test_rerun_failed': {},
	'test_cancel': { run_id?: string },
	// Todo list (task tracking within a turn - OpenCode parity)
	'todo': { todos: { id: string, content: string, status: 'pending' | 'in_progress' | 'completed' }[] },
	// Subagent delegation (OpenCode parity - roadmap Stage 6)
	'subagent': { agent: string, description: string, prompt: string, model?: string, sessionID?: string },
	// Notebook operations
	'read_notebook': { uri: URI, start_cell?: number, end_cell?: number },
	'write_notebook': { uri: URI, cells: NotebookCellData[] },
	'edit_notebook': { uri: URI, operations: NotebookEditOperation[] },
	'execute_notebook_cell': { uri: URI, cell_index: number, kernel_id?: string },
	'execute_notebook': { uri: URI, kernel_id?: string, cell_indices?: number[] },
	'select_notebook_kernel': { uri: URI, kernel_id: string },
	'list_notebook_kernels': { uri?: URI },
	// Git operations (Stage 2)
	'git_status': {},
	'git_diff': { ref: string | null, path: string | null, staged: boolean | null },
	'git_log': { max_count: number | null, path: string | null },
	'git_branch_list': {},
	'git_branch_create': { branch_name: string, start_point: string | null },
	'git_branch_switch': { branch_name: string },
	'git_stage': { paths: string[] },
	'git_unstage': { paths: string[] },
	'git_commit': { message: string, amend: boolean | null },
	'git_fetch': { remote: string | null },
	'git_pull': { remote: string | null, branch: string | null },
	'git_push': { remote: string | null, branch: string | null, force: boolean | null },
	'git_merge': { branch: string },
	'git_stash': { message: string | null },
	'git_stash_pop': {},
	'git_show': { commit: string, path: string | null },
}

// RESULT OF TOOL CALL
export type BuiltinToolResultType = {
	'read_file': { fileContents: string, totalFileLen: number, totalNumLines: number, hasNextPage: boolean },
	'ls_dir': { children: ShallowDirectoryItem[] | null, hasNextPage: boolean, hasPrevPage: boolean, itemsRemaining: number },
	'get_dir_tree': { str: string, },
	'search_pathnames_only': { uris: URI[], hasNextPage: boolean },
	'search_for_files': { uris: URI[], hasNextPage: boolean },
	'search_in_file': { lines: number[]; },
	// hasLanguageServer: false when no language server answers this request for the file / workspace
	'go_to_definition': { locations: CodeLocation[], hasLanguageServer: boolean },
	'find_references': { locations: CodeLocation[], totalCount: number, hasLanguageServer: boolean },
	'search_symbols': { symbols: WorkspaceSymbolEntry[], totalCount: number, hasLanguageServer: boolean },
	'read_lint_errors': { lintErrors: LintErrorItem[] | null },
	'read_project_memory': { content: string },
	// url: where redirects ended
	'fetch_url': { url: string, title: string | null, content: string, totalLen: number, hasNextPage: boolean },
	'web_search': { results: SearchResult[] },
	// Browser automation results
	'browser_launch': { sessionId: string, engine: string, headless: boolean, version: string },
	'browser_close': {},
	'browser_list_sessions': { sessions: Array<{ sessionId: string, engine: string, headless: boolean, tabCount: number, createdAt: number }> },
	'browser_new_tab': { tabId: string, url: string, title: string },
	'browser_list_tabs': { tabs: Array<{ tabId: string, url: string, title: string, isActive: boolean, loading: boolean, loadError?: string }> },
	'browser_switch_tab': { tabId: string, url: string, title: string },
	'browser_close_tab': {},
	'browser_navigate': { tabId: string, url: string, title: string },
	'browser_back': { tabId: string, url: string, title: string },
	'browser_forward': { tabId: string, url: string, title: string },
	'browser_reload': { tabId: string, url: string, title: string },
	'browser_inspect_page': { url: string, title: string, text: string, elements: BrowserElement[], forms: Array<{ selector: string, action?: string, method?: string }>, consoleErrors: number, networkFailures: number },
	'browser_click_element': {},
	'browser_fill_element': {},
	'browser_select_option': {},
	'browser_check_element': {},
	'browser_submit_form': { tabId: string, url: string, title: string },
	'browser_wait_for_element': { found: boolean },
	'browser_set_viewport': { width: number, height: number },
	'browser_screenshot': { dataUrl: string, width: number, height: number, type: 'viewport' | 'fullpage' | 'element' },
	'browser_console': { messages: Array<{ id: string, timestampMs: number, level: 'debug' | 'info' | 'warning' | 'error', text: string }>, truncated: boolean, dropped: number },
	'browser_network_failures': { failures: Array<{ id: string, timestampMs: number, url: string, type: string, errorText: string }> },
	'browser_download': { downloadId: string, url: string, suggestedFilename: string, status: 'in_progress' | 'completed' | 'failed' | 'cancelled', path?: string, failureText?: string },
	'browser_list_downloads': { downloads: Array<{ downloadId: string, url: string, suggestedFilename: string, status: 'in_progress' | 'completed' | 'failed' | 'cancelled', path?: string, failureText?: string }> },
	'browser_shutdown': {},
	// Dev server automation results
	'dev_server_start': { name: string, terminal_id: string, command: string, cwd: string, port?: number, url?: string, pid: number },
	'dev_server_stop': { name: string, stopped: boolean },
	'dev_server_list': { servers: Array<{ name: string, terminal_id: string, command: string, cwd: string, port?: number, url?: string, running: boolean }> },
	'dev_server_status': { name: string, running: boolean, port?: number, url?: string, terminal_id?: string },
	// Direct API testing results
	'api_request': { ok: boolean, status: number, status_text: string, headers: Record<string, string>, body: string, body_type: 'json' | 'text' | 'other', url: string, method: string, elapsed_ms: number },
	'port_check': { port: number, in_use: boolean, process?: string },
	// Debugger automation results
	'debug_list_configurations': { configurations: DebugConfiguration[] },
	'debug_list_sessions': { sessions: DebugSessionInfo[] },
	'debug_get_session_status': DebugSessionInfo,
	'debug_list_threads': { threads: DebugThread[] },
	'debug_start_session': DebugSessionInfo,
	'debug_attach_session': DebugSessionInfo,
	'debug_stop_session': {},
	'debug_restart_session': {},
	'debug_set_breakpoint': DebugBreakpoint,
	'debug_remove_breakpoint': {},
	'debug_set_breakpoint_enabled': {},
	'debug_list_breakpoints': { breakpoints: DebugBreakpoint[] },
	'debug_continue': {},
	'debug_pause': {},
	'debug_step_over': {},
	'debug_step_into': {},
	'debug_step_out': {},
	'debug_get_stack_trace': DebugStackTrace,
	'debug_get_scopes': { scopes: DebugScope[] },
	'debug_get_variables': { variables: DebugVariable[] },
	'debug_evaluate_expression': DebugEvaluateResult,
	'debug_get_exception_info': DebugExceptionInfo,
	'debug_get_console_output': { output: ConsoleOutputEntry[] },
	// ---
	'rewrite_file': { lintErrors: LintErrorItem[] | null },
		// write_file: alias for rewrite_file
		'write_file': { lintErrors: LintErrorItem[] | null },
		'edit_file': { lintErrors: LintErrorItem[] | null },
	'write_project_memory': { content: string, tokenCount: number },
	'create_file_or_folder': {},
	'delete_file_or_folder': {},
	// ---
	'run_command': { result: string; resolveReason: TerminalResolveReason; },
	'run_persistent_command': { result: string; resolveReason: TerminalResolveReason; },
	'open_persistent_terminal': { persistentTerminalId: string },
	'kill_persistent_terminal': {},
	// Terminal session management (Stage 5A Day 1)
	'list_terminals': { terminals: TerminalInfo[] },
	'read_terminal': { output: string, isAtEnd: boolean, totalChars: number },
	'send_command_to_terminal': { result: string },
	'interrupt_terminal': {},
	'close_terminal': {},
	// Task plan management (Stage 5A Day 2)
	'create_task_plan': { plan: TaskPlan },
	'update_task_plan': { plan: TaskPlan },
	'get_task_plan': { plan: TaskPlan | null },
	// Git operations (Stage 2)
	'git_status': { status: GitRepositoryStatus },
	'git_diff': { diff: GitDiffResult },
	'git_log': { commits: GitCommitLogEntry[], total: number },
	'git_branch_list': { branches: GitBranchInfo[], current: string | null },
	'git_branch_create': { branch_name: string },
	'git_branch_switch': { branch_name: string },
	'git_stage': { staged: string[] },
	'git_unstage': { unstaged: string[] },
	'git_commit': { commit_hash: string, message: string },
	'git_fetch': { result: string },
	'git_pull': { result: string },
	'git_push': { result: string },
	'git_merge': { result: string, merge_in_progress: boolean },
	'git_stash': { result: string },
	'git_stash_pop': { result: string },
	'git_show': { commit: string, message: string, diff: string },
	// Test discovery and execution (Stage 3)
	'test_discover': { frameworks: TestFramework[] },
	'test_list': { testFiles: TestFileInfo[] },
	'test_run': { results: TestRunResultData },
	'test_run_targeted': { results: TestRunResultData },
	'test_rerun_failed': { results: TestRunResultData },
	'test_cancel': { cancelled: boolean },
		// Todo list (task tracking within a turn - OpenCode parity)
		'todo': { done: number, inProgress: number, pending: number, todos: { id: string, content: string, status: string }[] },
		// Subagent delegation (OpenCode parity - roadmap Stage 6)
		'subagent': { sessionID: string, status: string, output: string },
	// Notebook operations
	'read_notebook': { cells: NotebookCellOutput[] },
	'write_notebook': { uri: URI },
	'edit_notebook': { uri: URI, applied: number },
	'execute_notebook_cell': { cell_index: number, outputs: NotebookCellOutput[], execution_time: number, success: boolean, error?: string },
	'execute_notebook': { results: NotebookExecutionResult[] },
	'select_notebook_kernel': { kernel_id: string },
	'list_notebook_kernels': { kernels: NotebookKernelInfo[] },
}


export type ToolCallParams<T extends BuiltinToolName | (string & {})> = T extends BuiltinToolName ? BuiltinToolCallParams[T] : RawToolParamsObj
export type ToolResult<T extends BuiltinToolName | (string & {})> = T extends BuiltinToolName ? BuiltinToolResultType[T] : RawMCPToolCall

export type BuiltinToolName = keyof BuiltinToolResultType

type BuiltinToolParamNameOfTool<T extends BuiltinToolName> = keyof (typeof builtinTools)[T]['params']


export type ToolName = BuiltinToolName | (string & {})
export type ToolParamName<T extends ToolName> = T extends BuiltinToolName ? BuiltinToolParamNameOfTool<T> : string


// Notebook types
export interface NotebookCellData {
	cell_type: 'code' | 'markdown';
	source: string;
	metadata?: Record<string, any>;
	outputs?: NotebookCellOutput[];
	execution_count?: number | null;
}

export interface NotebookCellOutput {
	output_type: 'stream' | 'execute_result' | 'display_data' | 'error';
	name?: string; // stream name: 'stdout' | 'stderr'
	text?: string | string[];
	data?: Record<string, any>; // for display_data
	ename?: string; // error name
	evalue?: string; // error value
	traceback?: string[]; // error traceback
	execution_count?: number | null;
}

export type NotebookEditOperation =
	| { type: 'add_cell'; index: number; cell: NotebookCellData }
	| { type: 'remove_cell'; index: number }
	| { type: 'replace_cell'; index: number; cell: NotebookCellData }
	| { type: 'move_cell'; from_index: number; to_index: number }
	| { type: 'update_cell_source'; index: number; source: string }
	| { type: 'update_cell_outputs'; index: number; outputs: NotebookCellOutput[] }
	| { type: 'clear_cell_outputs'; index: number };

export interface NotebookExecutionResult {
	cell_index: number;
	outputs: NotebookCellOutput[];
	execution_time: number;
	success: boolean;
	error?: string;
}

export interface NotebookKernelInfo {
	id: string;
	name: string;
	description?: string;
	supported_languages: string[];
	is_preferred?: boolean;
}
