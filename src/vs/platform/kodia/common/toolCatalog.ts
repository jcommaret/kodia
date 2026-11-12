/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { replaceTool_description } from './searchReplaceBlocks.js';

// The tools Kodia's chat and the Kodia agent of the Agents window both have, defined once: the name, the description
// and the parameters a model is told, with the types and required parameters the agent's schema declares and the kind
// of approval a call needs. How each side runs them is its own: the chat edits through the editor, with a diff to
// review, the agent writes to disk. `sharedTools` are the ones the agent runs itself. `editorTools`, below, need an
// editor window (its language server, its markers): the agent has them only while such a window is open, and asks it
// to run them. `persistentTerminalTools` are the terminals that outlive a command: the chat opens them in its window,
// the agent in the agent host's terminal manager.

export type SharedToolParam = {
	description: string,
	/** Default: a string. Kodia's chat is told every parameter as a string, see toolSchema.ts. */
	type?: 'integer' | 'boolean',
	required?: true,
}

/** The kinds of approval of Kodia's settings (`autoApprove`) that these tools need. */
export type SharedToolApproval = 'edits' | 'terminal' | 'web pages'

export type SharedTool = {
	name: string,
	description: string,
	params: { [paramName: string]: SharedToolParam },
	approval?: SharedToolApproval,
}

const terminalCommandHelp = `You can use this tool to run any command: sed, grep, etc. Do not edit any files with this tool; use edit_file instead. When working with git and other tools that open an editor (e.g. git diff), you should pipe to cat to get all results and not get stuck in vim.`

export const sharedTools = {
	read_file: {
		name: 'read_file',
		description: 'Returns full contents of a given file.',
		params: {
			uri: { description: 'The FULL path to the file.', required: true },
			start_line: { description: 'Optional. Read from this line (1-based). For a large file, when you know the lines you need, read just that range instead of the whole file. Defaults to the beginning of the file.', type: 'integer' },
			end_line: { description: 'Optional. Read up to this line (inclusive). Defaults to the end of the file.', type: 'integer' },
			page_number: { description: 'Optional. The page number of the result. Default is 1.', type: 'integer' },
		},
	},
	ls_dir: {
		name: 'ls_dir',
		description: 'Lists all files and folders in the given URI.',
		params: {
			uri: { description: 'Optional. The FULL path to the folder. Leave this as empty or "" to search all folders.' },
			page_number: { description: 'Optional. The page number of the result. Default is 1.', type: 'integer' },
		},
	},
	get_dir_tree: {
		name: 'get_dir_tree',
		description: `This is a very effective way to learn about the user's codebase. Returns a tree diagram of all the files and folders in the given folder. `,
		params: {
			uri: { description: 'The FULL path to the folder.', required: true },
		},
	},
	search_pathnames_only: {
		name: 'search_pathnames_only',
		description: 'Returns all pathnames that match a given query (searches ONLY file names). You should use this when looking for a file with a specific name or path.',
		params: {
			query: { description: 'Your query for the search.', required: true },
			include_pattern: { description: 'Optional. Only fill this in if you need to limit your search because there were too many results.' },
			page_number: { description: 'Optional. The page number of the result. Default is 1.', type: 'integer' },
		},
	},
	search_for_files: {
		name: 'search_for_files',
		description: 'Returns a list of file names whose content matches the given query. The query can be any substring or regex.',
		params: {
			query: { description: 'Your query for the search.', required: true },
			search_in_folder: { description: 'Optional. Leave as blank by default. ONLY fill this in if your previous search with the same query was truncated. Searches descendants of this folder only.' },
			is_regex: { description: 'Optional. Default is false. Whether the query is a regex.', type: 'boolean' },
			page_number: { description: 'Optional. The page number of the result. Default is 1.', type: 'integer' },
		},
	},
	search_in_file: {
		name: 'search_in_file',
		description: 'Returns an array of all the start line numbers where the content appears in the file.',
		params: {
			uri: { description: 'The FULL path to the file.', required: true },
			query: { description: 'The string or regex to search for in the file.', required: true },
			is_regex: { description: 'Optional. Default is false. Whether the query is a regex.', type: 'boolean' },
		},
	},
	create_file_or_folder: {
		name: 'create_file_or_folder',
		description: 'Create a file or folder at the given path. To create a folder, the path MUST end with a trailing slash.',
		params: {
			uri: { description: 'The FULL path to the file or folder.', required: true },
		},
		approval: 'edits',
	},
	delete_file_or_folder: {
		name: 'delete_file_or_folder',
		description: 'Delete a file or folder at the given path.',
		params: {
			uri: { description: 'The FULL path to the file or folder.', required: true },
			is_recursive: { description: 'Optional. Return true to delete recursively.', type: 'boolean' },
		},
		approval: 'edits',
	},
	edit_file: {
		name: 'edit_file',
		description: `Edit the contents of a file. You must provide the file's URI as well as a SINGLE string of SEARCH/REPLACE block(s) that will be used to apply the edit.`,
		params: {
			uri: { description: 'The FULL path to the file.', required: true },
			search_replace_blocks: { description: replaceTool_description, required: true },
		},
		approval: 'edits',
	},
	rewrite_file: {
		name: 'rewrite_file',
		description: 'Edits a file, deleting all the old contents and replacing them with your new contents. Use this tool if you want to edit a file you just created.',
		params: {
			uri: { description: 'The FULL path to the file.', required: true },
			new_content: { description: 'The new contents of the file. Must be a string.', required: true },
		},
		approval: 'edits',
	},
	run_command: {
		name: 'run_command',
		description: `Runs a terminal command and waits for the result, which ends with the command's exit code. It is stopped if it takes too long. ${terminalCommandHelp}`,
		params: {
			command: { description: 'The terminal command to run.', required: true },
			cwd: { description: 'Optional. The directory in which to run the command. Defaults to the first workspace folder.' },
		},
		approval: 'terminal',
	},
	fetch_url: {
		name: 'fetch_url',
		description: `Fetches a web page and returns its text (as markdown: headings, lists, links and code blocks). Use it to read documentation, an API reference, a changelog or an issue, especially a URL the user gave you. Each URL needs the user's approval, so fetch only what you need, and never put workspace code, secrets or personal data in a URL.`,
		params: {
			url: { description: 'The full http(s) URL of the page.', required: true },
			page_number: { description: 'Optional. The page number of the result. Default is 1.', type: 'integer' },
		},
		approval: 'web pages',
	},
	write_project_memory: {
		name: 'write_project_memory',
		description: `Saves durable notes about this project for future sessions, in the project memory (\`.kodia/memory.md\` in the repo, shown to you in PROJECT MEMORY at the start of every conversation). The memory is organized in "## " sections; this rewrites one whole section, so merge what's already there into the new content rather than repeating it. Save things worth knowing in every session: architecture, conventions, commands, decisions and their reasons, pitfalls. Keep it short and current: replace outdated notes, and delete a section by passing empty content. Never save secrets, credentials, or other sensitive information. The whole memory is capped at ~2000 tokens; a write that would exceed it is rejected, so condense other sections first.`,
		params: {
			section: { description: 'The section title, e.g. "Architecture", "Conventions", "Commands", "Pitfalls". Reuse an existing title to rewrite that section.', required: true },
			content: { description: 'The full new text of the section (markdown, no "## " heading). Empty to delete the section.', required: true },
		},
		approval: 'edits',
	},
} as const satisfies { [name: string]: SharedTool }

export type SharedToolName = keyof typeof sharedTools

export const sharedToolNames = Object.keys(sharedTools) as SharedToolName[]

/** Seconds a command of a persistent terminal is waited for: its output so far is returned then, and it keeps running. */
export const MAX_TERMINAL_BG_COMMAND_TIME = 5

/**
 * The terminals that outlive a command: a dev server, a watcher, a background listener. Open one, run commands in it,
 * kill it. All three need the approval of a terminal command. The chat runs them in a terminal of its window; the
 * agent of the Agents window in a terminal of the agent host, which the window shows under the session.
 */
export const persistentTerminalTools = {
	open_persistent_terminal: {
		name: 'open_persistent_terminal',
		description: `Use this tool when you want to run a terminal command indefinitely, like a dev server (eg \`npm run dev\`), a background listener, etc. Opens a new terminal in the user's environment which will not awaited for or killed.`,
		params: {
			cwd: { description: 'Optional. The directory in which to run the command. Defaults to the first workspace folder.' },
		},
		approval: 'terminal',
	},
	run_persistent_command: {
		name: 'run_persistent_command',
		description: `Runs a terminal command in the persistent terminal that you created with open_persistent_terminal (results after ${MAX_TERMINAL_BG_COMMAND_TIME} seconds are returned, and command continues running in background). ${terminalCommandHelp}`,
		params: {
			command: { description: 'The terminal command to run.', required: true },
			persistent_terminal_id: { description: 'The ID of the terminal created using open_persistent_terminal.', required: true },
		},
		approval: 'terminal',
	},
	kill_persistent_terminal: {
		name: 'kill_persistent_terminal',
		description: `Interrupts and closes a persistent terminal that you opened with open_persistent_terminal.`,
		params: {
			persistent_terminal_id: { description: 'The ID of the persistent terminal.', required: true },
		},
		approval: 'terminal',
	},
} as const satisfies { [name: string]: SharedTool }

export type PersistentTerminalToolName = keyof typeof persistentTerminalTools

export const persistentTerminalToolNames = Object.keys(persistentTerminalTools) as PersistentTerminalToolName[]

export const isPersistentTerminalToolName = (name: string): name is PersistentTerminalToolName => Object.hasOwn(persistentTerminalTools, name)

const symbolParams = {
	uri: { description: 'The FULL path to the file where the symbol appears.', required: true },
	line: { description: 'The line number (1-based) where the symbol appears in that file.', type: 'integer', required: true },
	symbol: { description: 'The symbol exactly as written on that line, e.g. `getUser` (not `api.getUser`).', required: true },
} as const satisfies { [paramName: string]: SharedToolParam }

/**
 * The tools of Kodia's chat that need an editor window: its language servers and its diagnostics. All read-only, so a
 * call needs no approval. The chat runs them in its own window; the agent of the Agents window asks an editor window.
 */
export const editorTools = {
	go_to_definition: {
		name: 'go_to_definition',
		description: `Finds where a symbol (function, class, method, type, variable...) is defined, using the language server. More precise than text search: it follows imports and ignores unrelated symbols with the same name. Returns each definition's path, line and first lines of code.`,
		params: symbolParams,
	},
	find_references: {
		name: 'find_references',
		description: `Finds every place a symbol is used across the workspace, using the language server — e.g. all the callers of a function before changing its signature. Returns paths and lines.`,
		params: symbolParams,
	},
	search_symbols: {
		name: 'search_symbols',
		description: `Searches the whole workspace for symbols (functions, classes, types, variables...) by name, using the language server. Use it to find where something is defined when you know its name but not its file.`,
		params: {
			query: { description: 'The symbol name, or part of it.', required: true },
		},
	},
	read_lint_errors: {
		name: 'read_lint_errors',
		description: `Use this tool to view all the lint errors on a file.`,
		params: {
			uri: { description: 'The FULL path to the file.', required: true },
		},
	},
} as const satisfies { [name: string]: SharedTool }

export type EditorToolName = keyof typeof editorTools

export const editorToolNames = Object.keys(editorTools) as EditorToolName[]

export const isEditorToolName = (name: string): name is EditorToolName => Object.hasOwn(editorTools, name)

export const nextPageNote = (hasNextPage: boolean) => hasNextPage ? '\n\n(more on next page...)' : ''

/** The JSON Schema of a shared tool's arguments, as the agent offers it to a model. */
export const jsonSchemaOfSharedTool = (tool: SharedTool) => {
	const properties: { [paramName: string]: { type: string, description: string } } = {}
	const required: string[] = []
	for (const [name, param] of Object.entries(tool.params)) {
		properties[name] = { type: param.type ?? 'string', description: param.description }
		if (param.required) required.push(name)
	}
	return { type: 'object' as const, properties, required, additionalProperties: false }
}
