/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Universal display metadata for all Kodia built-in tools.
 * Ensures every tool (146+) renders a clear, accurate activity card in the Chat UI
 * and never throws or disappears when proposing, running, succeeding, or failing.
 */

export type ToolCategory =
	| 'file'
	| 'edit'
	| 'search'
	| 'terminal'
	| 'git'
	| 'test'
	| 'debug'
	| 'browser'
	| 'agent'
	| 'plan'
	| 'memory'
	| 'web'
	| 'api'
	| 'notebook'
	| 'design'
	| 'mcp';

export interface ToolDisplayTitles {
	readonly done: string;
	readonly proposed: string;
	readonly running: string;
}

const EXPLICIT_TITLES: Readonly<Record<string, ToolDisplayTitles>> = {
	// Files & editing
	read_file: { done: 'Read file', proposed: 'Read file', running: 'Reading file' },
	ls_dir: { done: 'Inspected folder', proposed: 'Inspect folder', running: 'Inspecting folder' },
	get_dir_tree: { done: 'Inspected folder tree', proposed: 'Inspect folder tree', running: 'Inspecting folder tree' },
	create_file_or_folder: { done: 'Created', proposed: 'Create', running: 'Creating' },
	delete_file_or_folder: { done: 'Deleted', proposed: 'Delete', running: 'Deleting' },
	edit_file: { done: 'Edited file', proposed: 'Edit file', running: 'Editing file' },
	rewrite_file: { done: 'Rewrote file', proposed: 'Rewrite file', running: 'Rewriting file' },
	write_file: { done: 'Wrote file', proposed: 'Write file', running: 'Writing file' },
	read_lint_errors: { done: 'Read diagnostics', proposed: 'Read diagnostics', running: 'Reading diagnostics' },

	// Search & code intelligence
	search_pathnames_only: { done: 'Searched file names', proposed: 'Search file names', running: 'Searching file names' },
	search_for_files: { done: 'Searched files', proposed: 'Search files', running: 'Searching files' },
	search_in_file: { done: 'Searched in file', proposed: 'Search in file', running: 'Searching in file' },
	go_to_definition: { done: 'Went to definition', proposed: 'Go to definition', running: 'Going to definition' },
	find_references: { done: 'Found references', proposed: 'Find references', running: 'Finding references' },
	search_symbols: { done: 'Searched symbols', proposed: 'Search symbols', running: 'Searching symbols' },
	code_index: { done: 'Indexed codebase', proposed: 'Index codebase', running: 'Indexing codebase' },
	code_index_file: { done: 'Indexed file', proposed: 'Index file', running: 'Indexing file' },
	code_semantic_search: { done: 'Semantic code search', proposed: 'Semantic code search', running: 'Searching codebase' },
	code_keyword_search: { done: 'Keyword code search', proposed: 'Keyword code search', running: 'Searching code' },
	code_hybrid_search: { done: 'Hybrid code search', proposed: 'Hybrid code search', running: 'Searching code' },
	code_index_stats: { done: 'Checked index stats', proposed: 'Check index stats', running: 'Checking index stats' },
	code_index_clear: { done: 'Cleared code index', proposed: 'Clear code index', running: 'Clearing code index' },
	project_health_scan: { done: 'Scanned project health', proposed: 'Scan project health', running: 'Scanning project health' },
	architecture_map: { done: 'Mapped architecture', proposed: 'Map architecture', running: 'Mapping architecture' },

	// Terminal & dev lifecycle
	run_command: { done: 'Ran command', proposed: 'Run command', running: 'Running command' },
	run_persistent_command: { done: 'Ran terminal command', proposed: 'Run terminal command', running: 'Running terminal command' },
	open_persistent_terminal: { done: 'Opened terminal', proposed: 'Open terminal', running: 'Opening terminal' },
	kill_persistent_terminal: { done: 'Killed terminal', proposed: 'Kill terminal', running: 'Killing terminal' },
	list_terminals: { done: 'Listed terminals', proposed: 'List terminals', running: 'Listing terminals' },
	read_terminal: { done: 'Read terminal', proposed: 'Read terminal', running: 'Reading terminal' },
	send_command_to_terminal: { done: 'Sent to terminal', proposed: 'Send to terminal', running: 'Sending to terminal' },
	interrupt_terminal: { done: 'Interrupted terminal', proposed: 'Interrupt terminal', running: 'Interrupting terminal' },
	close_terminal: { done: 'Closed terminal', proposed: 'Close terminal', running: 'Closing terminal' },
	dev_server_start: { done: 'Started dev server', proposed: 'Start dev server', running: 'Starting dev server' },
	dev_server_stop: { done: 'Stopped dev server', proposed: 'Stop dev server', running: 'Stopping dev server' },
	dev_server_list: { done: 'Listed dev servers', proposed: 'List dev servers', running: 'Listing dev servers' },
	dev_server_status: { done: 'Checked dev server', proposed: 'Check dev server', running: 'Checking dev server' },
	dep_install: { done: 'Installed dependencies', proposed: 'Install dependencies', running: 'Installing dependencies' },
	db_migrate: { done: 'Ran DB migration', proposed: 'Run DB migration', running: 'Running DB migration' },
	lint_run: { done: 'Ran linter', proposed: 'Run linter', running: 'Running linter' },
	log_read: { done: 'Read log file', proposed: 'Read log file', running: 'Reading log file' },
	port_check: { done: 'Checked port', proposed: 'Check port', running: 'Checking port' },
	autonomous_dev_cycle: { done: 'Ran dev cycle', proposed: 'Run dev cycle', running: 'Running dev cycle' },

	// Planning & orchestration
	create_task_plan: { done: 'Created task plan', proposed: 'Create task plan', running: 'Creating task plan' },
	update_task_plan: { done: 'Updated task plan', proposed: 'Update task plan', running: 'Updating task plan' },
	get_task_plan: { done: 'Checked task plan', proposed: 'Check task plan', running: 'Checking task plan' },
	todo: { done: 'Updated checklist', proposed: 'Update checklist', running: 'Updating checklist' },
	subagent: { done: 'Subagent finished', proposed: 'Delegate to subagent', running: 'Running subagent' },

	// Memory & web
	read_project_memory: { done: 'Read project memory', proposed: 'Read project memory', running: 'Reading project memory' },
	write_project_memory: { done: 'Saved project memory', proposed: 'Save project memory', running: 'Saving project memory' },
	fetch_url: { done: 'Fetched URL', proposed: 'Fetch URL', running: 'Fetching URL' },
	web_search: { done: 'Searched web', proposed: 'Search web', running: 'Searching web' },

	// Git
	git_status: { done: 'Checked Git status', proposed: 'Check Git status', running: 'Checking Git status' },
	git_diff: { done: 'Inspected Git diff', proposed: 'Inspect Git diff', running: 'Inspecting Git diff' },
	git_log: { done: 'Read Git log', proposed: 'Read Git log', running: 'Reading Git log' },
	git_show: { done: 'Inspected commit', proposed: 'Inspect commit', running: 'Inspecting commit' },
	git_branch_list: { done: 'Listed branches', proposed: 'List branches', running: 'Listing branches' },
	git_branch_create: { done: 'Created branch', proposed: 'Create branch', running: 'Creating branch' },
	git_branch_switch: { done: 'Switched branch', proposed: 'Switch branch', running: 'Switching branch' },
	git_stage: { done: 'Staged files', proposed: 'Stage files', running: 'Staging files' },
	git_unstage: { done: 'Unstaged files', proposed: 'Unstage files', running: 'Unstaging files' },
	git_commit: { done: 'Created commit', proposed: 'Create commit', running: 'Creating commit' },
	git_commit_context: { done: 'Gathered commit context', proposed: 'Gather commit context', running: 'Gathering commit context' },
	git_pr_prepare: { done: 'Prepared PR summary', proposed: 'Prepare PR summary', running: 'Preparing PR summary' },
	git_fetch: { done: 'Fetched remote', proposed: 'Fetch remote', running: 'Fetching remote' },
	git_pull: { done: 'Pulled changes', proposed: 'Pull changes', running: 'Pulling changes' },
	git_push: { done: 'Pushed changes', proposed: 'Push changes', running: 'Pushing changes' },
	git_merge: { done: 'Merged branch', proposed: 'Merge branch', running: 'Merging branch' },
	git_rebase: { done: 'Rebased branch', proposed: 'Rebase branch', running: 'Rebasing branch' },
	git_cherry_pick: { done: 'Cherry-picked commit', proposed: 'Cherry-pick commit', running: 'Cherry-picking commit' },
	git_revert: { done: 'Reverted commit', proposed: 'Revert commit', running: 'Reverting commit' },
	git_reset: { done: 'Reset branch', proposed: 'Reset branch', running: 'Resetting branch' },
	git_continue: { done: 'Continued Git op', proposed: 'Continue Git op', running: 'Continuing Git op' },
	git_abort: { done: 'Aborted Git op', proposed: 'Abort Git op', running: 'Aborting Git op' },
	git_stash: { done: 'Stashed changes', proposed: 'Stash changes', running: 'Stashing changes' },
	git_stash_pop: { done: 'Popped stash', proposed: 'Pop stash', running: 'Popping stash' },
	git_tag_list: { done: 'Listed tags', proposed: 'List tags', running: 'Listing tags' },
	git_tag_create: { done: 'Created tag', proposed: 'Create tag', running: 'Creating tag' },
	git_remote_list: { done: 'Listed remotes', proposed: 'List remotes', running: 'Listing remotes' },
	git_worktree_list: { done: 'Listed worktrees', proposed: 'List worktrees', running: 'Listing worktrees' },
	git_worktree_add: { done: 'Added worktree', proposed: 'Add worktree', running: 'Adding worktree' },

	// Testing
	test_discover: { done: 'Discovered tests', proposed: 'Discover tests', running: 'Discovering tests' },
	test_list: { done: 'Listed tests', proposed: 'List tests', running: 'Listing tests' },
	test_run: { done: 'Ran tests', proposed: 'Run tests', running: 'Running tests' },
	test_run_targeted: { done: 'Ran targeted tests', proposed: 'Run targeted tests', running: 'Running targeted tests' },
	test_rerun_failed: { done: 'Reran failed tests', proposed: 'Rerun failed tests', running: 'Rerunning failed tests' },
	test_coverage: { done: 'Measured coverage', proposed: 'Measure coverage', running: 'Measuring coverage' },
	test_history: { done: 'Checked test history', proposed: 'Check test history', running: 'Checking test history' },
	test_check_flaky: { done: 'Checked flaky tests', proposed: 'Check flaky tests', running: 'Checking flaky tests' },
	test_debug: { done: 'Debugged test', proposed: 'Debug test', running: 'Debugging test' },
	test_cancel: { done: 'Cancelled tests', proposed: 'Cancel tests', running: 'Cancelling tests' },

	// Debugger
	debug_list_configurations: { done: 'Listed debug configs', proposed: 'List debug configs', running: 'Listing debug configs' },
	debug_list_sessions: { done: 'Listed debug sessions', proposed: 'List debug sessions', running: 'Listing debug sessions' },
	debug_get_session_status: { done: 'Checked debug status', proposed: 'Check debug status', running: 'Checking debug status' },
	debug_start_session: { done: 'Started debugger', proposed: 'Start debugger', running: 'Starting debugger' },
	debug_attach_session: { done: 'Attached debugger', proposed: 'Attach debugger', running: 'Attaching debugger' },
	debug_stop_session: { done: 'Stopped debugger', proposed: 'Stop debugger', running: 'Stopping debugger' },
	debug_restart_session: { done: 'Restarted debugger', proposed: 'Restart debugger', running: 'Restarting debugger' },
	debug_set_breakpoint: { done: 'Set breakpoint', proposed: 'Set breakpoint', running: 'Setting breakpoint' },
	debug_remove_breakpoint: { done: 'Removed breakpoint', proposed: 'Remove breakpoint', running: 'Removing breakpoint' },
	debug_set_breakpoint_enabled: { done: 'Toggled breakpoint', proposed: 'Toggle breakpoint', running: 'Toggling breakpoint' },
	debug_list_breakpoints: { done: 'Listed breakpoints', proposed: 'List breakpoints', running: 'Listing breakpoints' },
	debug_set_exception_breakpoints: { done: 'Set exception breaks', proposed: 'Set exception breaks', running: 'Setting exception breaks' },
	debug_continue: { done: 'Continued execution', proposed: 'Continue execution', running: 'Continuing execution' },
	debug_pause: { done: 'Paused execution', proposed: 'Pause execution', running: 'Pausing execution' },
	debug_step_over: { done: 'Stepped over', proposed: 'Step over', running: 'Stepping over' },
	debug_step_into: { done: 'Stepped into', proposed: 'Step into', running: 'Stepping into' },
	debug_step_out: { done: 'Stepped out', proposed: 'Step out', running: 'Stepping out' },
	debug_list_threads: { done: 'Listed threads', proposed: 'List threads', running: 'Listing threads' },
	debug_get_stack_trace: { done: 'Read stack trace', proposed: 'Read stack trace', running: 'Reading stack trace' },
	debug_get_scopes: { done: 'Read scopes', proposed: 'Read scopes', running: 'Reading scopes' },
	debug_get_variables: { done: 'Inspected variables', proposed: 'Inspect variables', running: 'Inspecting variables' },
	debug_evaluate_expression: { done: 'Evaluated expression', proposed: 'Evaluate expression', running: 'Evaluating expression' },
	debug_get_exception_info: { done: 'Read exception info', proposed: 'Read exception info', running: 'Reading exception info' },
	debug_get_console_output: { done: 'Read debug console', proposed: 'Read debug console', running: 'Reading debug console' },

	// Browser automation
	browser_launch: { done: 'Launched browser', proposed: 'Launch browser', running: 'Launching browser' },
	browser_close: { done: 'Closed browser', proposed: 'Close browser', running: 'Closing browser' },
	browser_shutdown: { done: 'Shut down browser', proposed: 'Shut down browser', running: 'Shutting down browser' },
	browser_list_sessions: { done: 'Listed browser sessions', proposed: 'List browser sessions', running: 'Listing browser sessions' },
	browser_new_tab: { done: 'Opened browser tab', proposed: 'Open browser tab', running: 'Opening browser tab' },
	browser_list_tabs: { done: 'Listed browser tabs', proposed: 'List browser tabs', running: 'Listing browser tabs' },
	browser_switch_tab: { done: 'Switched browser tab', proposed: 'Switch browser tab', running: 'Switching browser tab' },
	browser_close_tab: { done: 'Closed browser tab', proposed: 'Close browser tab', running: 'Closing browser tab' },
	browser_navigate: { done: 'Navigated browser', proposed: 'Navigate browser', running: 'Navigating browser' },
	browser_back: { done: 'Navigated back', proposed: 'Navigate back', running: 'Navigating back' },
	browser_forward: { done: 'Navigated forward', proposed: 'Navigate forward', running: 'Navigating forward' },
	browser_reload: { done: 'Reloaded page', proposed: 'Reload page', running: 'Reloading page' },
	browser_inspect_page: { done: 'Inspected page', proposed: 'Inspect page', running: 'Inspecting page' },
	browser_click_element: { done: 'Clicked element', proposed: 'Click element', running: 'Clicking element' },
	browser_fill_element: { done: 'Filled input', proposed: 'Fill input', running: 'Filling input' },
	browser_select_option: { done: 'Selected option', proposed: 'Select option', running: 'Selecting option' },
	browser_check_element: { done: 'Toggled checkbox', proposed: 'Toggle checkbox', running: 'Toggling checkbox' },
	browser_submit_form: { done: 'Submitted form', proposed: 'Submit form', running: 'Submitting form' },
	browser_wait_for_element: { done: 'Waited for element', proposed: 'Wait for element', running: 'Waiting for element' },
	browser_set_viewport: { done: 'Set viewport', proposed: 'Set viewport', running: 'Setting viewport' },
	browser_screenshot: { done: 'Captured screenshot', proposed: 'Capture screenshot', running: 'Capturing screenshot' },
	browser_console: { done: 'Read browser console', proposed: 'Read browser console', running: 'Reading browser console' },
	browser_network_failures: { done: 'Checked network errors', proposed: 'Check network errors', running: 'Checking network errors' },
	browser_download: { done: 'Downloaded file', proposed: 'Download file', running: 'Downloading file' },
	browser_list_downloads: { done: 'Listed downloads', proposed: 'List downloads', running: 'Listing downloads' },

	// API / Notebooks
	api_request: { done: 'Sent API request', proposed: 'Send API request', running: 'Sending API request' },
	read_notebook: { done: 'Read notebook', proposed: 'Read notebook', running: 'Reading notebook' },
	write_notebook: { done: 'Wrote notebook', proposed: 'Write notebook', running: 'Writing notebook' },
	edit_notebook: { done: 'Edited notebook', proposed: 'Edit notebook', running: 'Editing notebook' },
	execute_notebook_cell: { done: 'Ran notebook cell', proposed: 'Run notebook cell', running: 'Running notebook cell' },
	execute_notebook: { done: 'Ran notebook', proposed: 'Run notebook', running: 'Running notebook' },
	select_notebook_kernel: { done: 'Selected kernel', proposed: 'Select kernel', running: 'Selecting kernel' },
	list_notebook_kernels: { done: 'Listed kernels', proposed: 'List kernels', running: 'Listing kernels' },

	// Workspace Intelligence & Security
	workspace_diagnostics: { done: 'Read workspace problems', proposed: 'Read workspace problems', running: 'Reading workspace problems' },
	move_or_rename_file: { done: 'Moved / renamed file', proposed: 'Move / rename file', running: 'Moving / renaming file' },
	file_metadata: { done: 'Inspected file metadata', proposed: 'Inspect file metadata', running: 'Inspecting file metadata' },
	dependency_audit: { done: 'Audited dependencies', proposed: 'Audit dependencies', running: 'Auditing dependencies' },
	env_inspect: { done: 'Inspected environment', proposed: 'Inspect environment', running: 'Inspecting environment' },
	docker_status: { done: 'Checked Docker status', proposed: 'Check Docker status', running: 'Checking Docker status' },
	docker_logs: { done: 'Read Docker logs', proposed: 'Read Docker logs', running: 'Reading Docker logs' },
	db_inspect: { done: 'Inspected database schema', proposed: 'Inspect database schema', running: 'Inspecting database schema' },
	db_query: { done: 'Queried database', proposed: 'Query database', running: 'Querying database' },
	change_impact_analysis: { done: 'Analyzed change impact', proposed: 'Analyze change impact', running: 'Analyzing change impact' },
	knowledge_graph_query: { done: 'Queried knowledge graph', proposed: 'Query knowledge graph', running: 'Querying knowledge graph' },
	evaluate_quality_gates: { done: 'Evaluated quality gates', proposed: 'Evaluate quality gates', running: 'Evaluating quality gates' },
	record_verification_evidence: { done: 'Recorded verification proof', proposed: 'Record verification proof', running: 'Recording verification proof' },
	factory_manage_requirements: { done: 'Updated factory requirements', proposed: 'Update factory requirements', running: 'Updating factory requirements' },

	// Autonomous UI/UX Design Intelligence, Assets & Visual QA
	analyze_product_design_requirements: { done: 'Analyzed product requirements', proposed: 'Analyze product requirements', running: 'Analyzing product requirements' },
	generate_design_brief: { done: 'Created design brief', proposed: 'Create design brief', running: 'Creating design brief' },
	generate_visual_direction: { done: 'Selected visual direction', proposed: 'Select visual direction', running: 'Selecting visual direction' },
	generate_color_palette: { done: 'Generated color palette', proposed: 'Generate color palette', running: 'Generating color palette' },
	generate_design_tokens: { done: 'Created design tokens', proposed: 'Create design tokens', running: 'Creating design tokens' },
	generate_page_architecture: { done: 'Planned page architecture', proposed: 'Plan page architecture', running: 'Planning page architecture' },
	generate_responsive_layout: { done: 'Designed responsive layout', proposed: 'Design responsive layout', running: 'Designing responsive layout' },
	discover_visual_assets: { done: 'Discovered visual assets', proposed: 'Discover visual assets', running: 'Searching for imagery' },
	search_image_providers: { done: 'Searched image providers', proposed: 'Search image providers', running: 'Searching image providers' },
	download_visual_assets: { done: 'Downloaded visual assets', proposed: 'Download visual assets', running: 'Downloading visual assets' },
	optimize_visual_assets: { done: 'Optimized visual assets', proposed: 'Optimize visual assets', running: 'Optimizing visual assets' },
	discover_icon_library: { done: 'Selected icon system', proposed: 'Select icon system', running: 'Inspecting icon libraries' },
	recommend_typography: { done: 'Selected typography system', proposed: 'Select typography system', running: 'Selecting typography pairing' },
	recommend_ui_components: { done: 'Planned UI components', proposed: 'Plan UI components', running: 'Planning UI components' },
	generate_component_variants: { done: 'Generated component variants', proposed: 'Generate component variants', running: 'Generating component variants' },
	inspect_existing_design_system: { done: 'Inspected existing design system', proposed: 'Inspect existing design system', running: 'Inspecting existing design system' },
	audit_design_consistency: { done: 'Audited design consistency', proposed: 'Audit design consistency', running: 'Auditing design consistency' },
	inspect_responsive_layout: { done: 'Tested responsive layouts', proposed: 'Test responsive layouts', running: 'Testing responsive layouts' },
	capture_application_screenshots: { done: 'Captured preview screenshots', proposed: 'Capture preview screenshots', running: 'Rendering previews & capturing screenshots' },
	inspect_visual_quality: { done: 'Inspected visual quality', proposed: 'Inspect visual quality', running: 'Inspecting visual quality' },
	audit_accessibility: { done: 'Audited accessibility (WCAG)', proposed: 'Audit accessibility (WCAG)', running: 'Auditing accessibility' },
	audit_frontend_performance: { done: 'Audited frontend performance', proposed: 'Audit frontend performance', running: 'Auditing frontend performance' },
	critique_interface_design: { done: 'Critiqued interface design', proposed: 'Critique interface design', running: 'Performing design review' },
	repair_visual_defects: { done: 'Planned visual defect repairs', proposed: 'Plan visual defect repairs', running: 'Identifying visual defects' },
	compare_visual_revisions: { done: 'Compared visual revisions', proposed: 'Compare visual revisions', running: 'Comparing visual revisions' },
};

function humanizeToolName(toolName: string): string {
	return toolName
		.replace(/[_-]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^\w/, c => c.toUpperCase());
}

export function getToolDisplayTitles(toolName: string): ToolDisplayTitles {
	const explicit = EXPLICIT_TITLES[toolName];
	if (explicit) { return explicit; }
	const label = humanizeToolName(toolName);
	return {
		done: label,
		proposed: label,
		running: `Running ${label.toLowerCase()}`,
	};
}

export function getToolCategory(toolName: string): ToolCategory {
	if (
		toolName.includes('design_')
		|| toolName.includes('visual_')
		|| toolName.includes('color_palette')
		|| toolName.includes('page_architecture')
		|| toolName.includes('responsive_layout')
		|| toolName.includes('image_providers')
		|| toolName.includes('icon_library')
		|| toolName.includes('typography')
		|| toolName.includes('ui_components')
		|| toolName.includes('component_variants')
		|| toolName === 'capture_application_screenshots'
		|| toolName === 'audit_accessibility'
		|| toolName === 'audit_frontend_performance'
		|| toolName === 'critique_interface_design'
		|| toolName === 'repair_visual_defects'
	) { return 'design'; }
	if (toolName.startsWith('git_')) { return 'git'; }
	if (toolName.startsWith('test_')) { return 'test'; }
	if (toolName.startsWith('debug_')) { return 'debug'; }
	if (toolName.startsWith('browser_')) { return 'browser'; }
	if (toolName.startsWith('code_') || toolName.startsWith('search_') || toolName === 'go_to_definition' || toolName === 'find_references') { return 'search'; }
	if (toolName === 'subagent') { return 'agent'; }
	if (toolName.includes('task_plan') || toolName === 'todo') { return 'plan'; }
	if (toolName.includes('project_memory')) { return 'memory'; }
	if (toolName === 'fetch_url' || toolName === 'web_search') { return 'web'; }
	if (toolName.startsWith('api_') || toolName.startsWith('oauth2_')) { return 'api'; }
	if (toolName.includes('notebook')) { return 'notebook'; }
	if (toolName === 'edit_file' || toolName === 'rewrite_file' || toolName === 'write_file' || toolName === 'create_file_or_folder' || toolName === 'delete_file_or_folder' || toolName === 'move_or_rename_file') { return 'edit'; }
	if (toolName === 'read_file' || toolName === 'ls_dir' || toolName === 'get_dir_tree' || toolName === 'read_lint_errors' || toolName === 'workspace_diagnostics' || toolName === 'file_metadata' || toolName === 'log_read') { return 'file'; }
	if (toolName === 'project_health_scan' || toolName === 'architecture_map' || toolName === 'dependency_audit') { return 'search'; }
	if (toolName.includes('terminal') || toolName.includes('command') || toolName.startsWith('dev_server_') || toolName.startsWith('docker_') || toolName.startsWith('db_') || toolName === 'env_inspect' || toolName === 'dep_install' || toolName === 'lint_run' || toolName === 'port_check' || toolName === 'autonomous_dev_cycle') { return 'terminal'; }
	return 'mcp';
}

export function summarizeToolParams(toolName: string, params: Record<string, unknown> | undefined): { desc1: string; desc1Info?: string } {
	if (!params || typeof params !== 'object') { return { desc1: '' }; }

	const str = (key: string): string | undefined => {
		const v = params[key];
		if (typeof v === 'string' && v.trim()) { return v.trim(); }
		return undefined;
	};

	const uriPath = (): string | undefined => {
		const u = params.uri as { fsPath?: string; path?: string } | string | undefined;
		if (!u) { return undefined; }
		if (typeof u === 'string') { return u; }
		return u.fsPath || u.path;
	};

	const base = (p: string) => p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p;

	if (toolName === 'subagent') {
		const agent = str('agent') ?? 'general';
		const desc = str('description') ?? '';
		return { desc1: desc ? `[${agent}] ${desc}` : `[${agent}]`, desc1Info: str('model') };
	}
	if (toolName === 'create_task_plan') {
		const title = str('title') ?? '';
		const count = Array.isArray(params.tasks) ? params.tasks.length : 0;
		return { desc1: title ? `${title} (${count} tasks)` : `${count} tasks` };
	}
	if (toolName === 'update_task_plan') {
		const id = str('taskId') ?? str('task_id') ?? '';
		const status = str('status') ?? '';
		return { desc1: [id, status].filter(Boolean).join(' → ') };
	}
	if (toolName === 'todo') {
		const count = Array.isArray(params.todos) ? params.todos.length : 0;
		return { desc1: `${count} item${count === 1 ? '' : 's'}` };
	}
	if (toolName === 'web_search' || toolName === 'code_semantic_search' || toolName === 'code_keyword_search' || toolName === 'code_hybrid_search') {
		const q = str('query');
		return { desc1: q ? `"${q}"` : '' };
	}
	if (toolName === 'browser_navigate' || toolName === 'browser_new_tab' || toolName === 'browser_download') {
		const url = str('url');
		return { desc1: url ?? '' };
	}
	if (toolName.startsWith('browser_') && str('selector')) {
		return { desc1: str('selector')! };
	}
	if (toolName === 'debug_set_breakpoint' || toolName === 'debug_remove_breakpoint') {
		const file = str('file') ?? str('path') ?? uriPath();
		const line = typeof params.line === 'number' ? `:${params.line}` : '';
		return { desc1: file ? `${base(file)}${line}` : (str('breakpointId') ?? ''), desc1Info: file };
	}
	if (toolName === 'debug_evaluate_expression') {
		return { desc1: str('expression') ?? '' };
	}
	if (toolName === 'debug_start_session' || toolName === 'debug_attach_session') {
		const cfg = params.configuration as { name?: string; type?: string } | undefined;
		return { desc1: str('configurationName') ?? str('name') ?? cfg?.name ?? cfg?.type ?? '' };
	}
	if (toolName.startsWith('git_')) {
		const target = str('message') ?? str('branchName') ?? str('branch') ?? str('name') ?? str('ref') ?? str('path') ?? str('commit');
		if (target) { return { desc1: target.length > 60 ? `${target.slice(0, 57)}...` : target }; }
		if (Array.isArray(params.paths) && params.paths.length > 0) {
			return { desc1: `${params.paths.length} path${params.paths.length === 1 ? '' : 's'}` };
		}
		return { desc1: '' };
	}
	if (toolName.startsWith('test_')) {
		const files = Array.isArray(params.files) ? params.files : Array.isArray(params.testFiles) ? params.testFiles : undefined;
		const names = Array.isArray(params.testNames) ? params.testNames : undefined;
		if (names?.length) { return { desc1: names.slice(0, 2).join(', ') }; }
		if (files?.length) { return { desc1: files.slice(0, 2).map(f => base(String(f))).join(', ') }; }
		return { desc1: str('testName') ?? str('file') ?? '' };
	}

	const p = uriPath() ?? str('path') ?? str('command') ?? str('url') ?? str('query') ?? str('name') ?? str('title') ?? str('expression') ?? '';
	if (!p) { return { desc1: '' }; }
	if (uriPath() || str('path')) {
		return { desc1: base(p), desc1Info: p };
	}
	return { desc1: p.length > 60 ? `${p.slice(0, 57)}...` : p };
}
