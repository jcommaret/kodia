/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IDirectoryStrService } from '../directoryStrService.js';
import { StagingSelectionItem } from '../chatThreadServiceTypes.js';
import { os } from '../helpers/systemInfo.js';
import { RawToolParamsObj } from '../sendLLMMessageTypes.js';
import { approvalTypeOfBuiltinToolName, BuiltinToolCallParams, BuiltinToolName, BuiltinToolResultType, ToolName } from '../toolsServiceTypes.js';
import { ChatMode } from '../voidSettingsTypes.js';

// Triple backtick wrapper used throughout the prompts for code blocks
export const tripleTick = ['```', '```']

// Maximum limits for directory structure information
export const MAX_DIRSTR_CHARS_TOTAL_BEGINNING = 20_000
export const MAX_DIRSTR_CHARS_TOTAL_TOOL = 20_000

export const MAX_FILE_CHARS_PAGE = Infinity // No limit - read entire files
export const MAX_CHILDREN_URIs_PAGE = Infinity // No limit - return all search results

// terminal tool info
export const MAX_TERMINAL_CHARS = Infinity // No limit - return all terminal output
export const MAX_TERMINAL_INACTIVE_TIME = Infinity // seconds - no timeout
export const MAX_TERMINAL_BG_COMMAND_TIME = Infinity // no timeout

// project memory tool info
export const MAX_PROJECT_MEMORY_TOKENS = Infinity // No limit


// Maximum character limits for prefix and suffix context
export const MAX_PREFIX_SUFFIX_CHARS = Infinity // No limit


// --- summarizing a thread that outgrew the context window (ContextSummaryEntry) ---

export const summarizeThread_systemMessage = `\
You summarize a conversation between a user and an AI coding agent. The agent will continue the work from your summary alone: the messages you summarize will be gone.

Keep everything the agent needs to continue:
- what the user asked for, with their exact constraints and preferences;
- the decisions made, and why;
- the files read, created or changed (full paths), and what changed in them;
- the commands run and what they showed, the errors met and how they were fixed;
- what is done, and what remains to do.

Leave out pleasantries and details that no longer matter. Write short bullet points under short headings, at most about 600 words. State only what the conversation shows.`

export const summarizeThread_userMessage = (transcript: string) => `\
Summarize this conversation, following your instructions.

<conversation>
${transcript}
</conversation>`

// sent to the chat model in place of the summarized messages; latestRequest when the summary cut the current turn
export const summarizedThreadMessage = (summary: string, latestRequest: string | undefined) => [
	`(The earlier part of this conversation was summarized to fit the context window.)`,
	`SUMMARY OF THE EARLIER CONVERSATION:\n${summary}`,
	...latestRequest !== undefined ? [`THE USER'S CURRENT REQUEST, which you are working on:\n${latestRequest}`] : [],
].join('\n\n')


// The instruction files read from the root of each workspace folder: Kodia's own, then the ones
// other agents use, so a project set up for Codex, Claude Code, Cursor or Windsurf works as is
export const PROJECT_RULES_FILE_NAMES = ['.voidrules', 'AGENTS.md', 'CLAUDE.md', '.cursorrules', '.windsurfrules'] as const

// Labels each rules file with its path. A file with the same content as an earlier one (a symlink, a copy) is left out.
export const joinProjectRules = (files: { path: string, content: string }[]): string => {
	const seen = new Set<string>()
	const parts: string[] = []
	for (const { path, content } of files) {
		const trimmed = content.trim()
		if (!trimmed || seen.has(trimmed)) continue
		seen.add(trimmed)
		parts.push(`From ${path}:\n${trimmed}`)
	}
	return parts.join('\n\n')
}


export const ORIGINAL = `<<<<<<< ORIGINAL`
export const DIVIDER = `=======`
export const FINAL = `>>>>>>> UPDATED`



const searchReplaceBlockTemplate = `\
${ORIGINAL}
// ... original code goes here
${DIVIDER}
// ... final code goes here
${FINAL}

${ORIGINAL}
// ... original code goes here
${DIVIDER}
// ... final code goes here
${FINAL}`




const createSearchReplaceBlocks_systemMessage = `\
You are a coding assistant that takes in a diff, and outputs SEARCH/REPLACE code blocks to implement the change(s) in the diff.
The diff will be labeled \`DIFF\` and the original file will be labeled \`ORIGINAL_FILE\`.

Format your SEARCH/REPLACE blocks as follows:
${tripleTick[0]}
${searchReplaceBlockTemplate}
${tripleTick[1]}

1. Your SEARCH/REPLACE block(s) must implement the diff EXACTLY. Do NOT leave anything out.

2. You are allowed to output multiple SEARCH/REPLACE blocks to implement the change.

3. Assume any comments in the diff are PART OF THE CHANGE. Include them in the output.

4. Your output should consist ONLY of SEARCH/REPLACE blocks. Do NOT output any text or explanations before or after this.

5. The ORIGINAL code in each SEARCH/REPLACE block must EXACTLY match lines in the original file. Do not add or remove any whitespace, comments, or modifications from the original code.

6. Each ORIGINAL text must be large enough to uniquely identify the change in the file. However, bias towards writing as little as possible.

7. Each ORIGINAL text must be DISJOINT from all other ORIGINAL text.

## EXAMPLE 1
DIFF
${tripleTick[0]}
// ... existing code
let x = 6.5
// ... existing code
${tripleTick[1]}

ORIGINAL_FILE
${tripleTick[0]}
let w = 5
let x = 6
let y = 7
let z = 8
${tripleTick[1]}

ACCEPTED OUTPUT
${tripleTick[0]}
${ORIGINAL}
let x = 6
${DIVIDER}
let x = 6.5
${FINAL}
${tripleTick[1]}`


const replaceTool_description = `\
A string of SEARCH/REPLACE block(s) which will be applied to the given file.
Your SEARCH/REPLACE blocks string must be formatted as follows:
${searchReplaceBlockTemplate}

## Guidelines:

1. You may output multiple search replace blocks if needed.

2. The ORIGINAL code in each SEARCH/REPLACE block must EXACTLY match lines in the original file. Do not add or remove any whitespace or comments from the original code.

3. Each ORIGINAL text must be large enough to uniquely identify the change. However, bias towards writing as little as possible.

4. Each ORIGINAL text must be DISJOINT from all other ORIGINAL text.

5. This field is a STRING (not an array).`


// ======================================================== tools ========================================================


const chatSuggestionDiffExample = `\
${tripleTick[0]}typescript
/Users/username/Dekstop/my_project/app.ts
// ... existing code ...
// {{change 1}}
// ... existing code ...
// {{change 2}}
// ... existing code ...
// {{change 3}}
// ... existing code ...
${tripleTick[1]}`



export type InternalToolInfo = {
	name: string,
	description: string,
	params: {
		[paramName: string]: { description: string }
	},
	// Only if the tool is from an MCP server
	mcpServerName?: string,
}



const uriParam = (object: string) => ({
	uri: { description: `The FULL path to the ${object}.` }
})

const paginationParam = {
	page_number: { description: 'Optional. The page number of the result. Default is 1.' }
} as const



const terminalDescHelper = `You can use this tool to run any command: sed, grep, etc. Do not edit any files with this tool; use edit_file instead. When working with git and other tools that open an editor (e.g. git diff), you should pipe to cat to get all results and not get stuck in vim.`

const cwdHelper = 'Optional. The directory in which to run the command. Defaults to the first workspace folder.'

export type SnakeCase<S extends string> =
	// exact acronym URI
	S extends 'URI' ? 'uri'
	// suffix URI: e.g. 'rootURI' -> snakeCase('root') + '_uri'
	: S extends `${infer Prefix}URI` ? `${SnakeCase<Prefix>}_uri`
	// default: for each char, prefix '_' on uppercase letters
	: S extends `${infer C}${infer Rest}`
	? `${C extends Lowercase<C> ? C : `_${Lowercase<C>}`}${SnakeCase<Rest>}`
	: S;

export type SnakeCaseKeys<T extends Record<string, any>> = {
	[K in keyof T as SnakeCase<Extract<K, string>>]: T[K]
};



export const builtinTools: {
	[T in keyof BuiltinToolCallParams]: {
		name: string;
		description: string;
		// more params can be generated than exist here, but these params must be a subset of them
		params: Partial<{ [paramName in keyof SnakeCaseKeys<BuiltinToolCallParams[T]>]: { description: string } }>
	}
} = {
	// --- context-gathering (read/search/list) ---

	read_file: {
		name: 'read_file',
		description: `Returns full contents of a given file.`,
		params: {
			...uriParam('file'),
			start_line: { description: 'Optional. Read from this line (1-based). For a large file, when you know the lines you need (from search_in_file, go_to_definition, find_references, or a lint error), read just that range instead of the whole file. Defaults to the beginning of the file.' },
			end_line: { description: 'Optional. Read up to this line (inclusive). Defaults to the end of the file.' },
			...paginationParam,
		},
	},

	ls_dir: {
		name: 'ls_dir',
		description: `Lists all files and folders in the given URI.`,
		params: {
			uri: { description: `Optional. The FULL path to the ${'folder'}. Leave this as empty or "" to search all folders.` },
			...paginationParam,
		},
	},

	get_dir_tree: {
		name: 'get_dir_tree',
		description: `This is a very effective way to learn about the user's codebase. Returns a tree diagram of all the files and folders in the given folder. `,
		params: {
			...uriParam('folder')
		}
	},

	// pathname_search: {
	// 	name: 'pathname_search',
	// 	description: `Returns all pathnames that match a given \`find\`-style query over the entire workspace. ONLY searches file names. ONLY searches the current workspace. You should use this when looking for a file with a specific name or path. ${paginationHelper.desc}`,

	search_pathnames_only: {
		name: 'search_pathnames_only',
		description: `Returns all pathnames that match a given query (searches ONLY file names). You should use this when looking for a file with a specific name or path.`,
		params: {
			query: { description: `Your query for the search.` },
			include_pattern: { description: 'Optional. Only fill this in if you need to limit your search because there were too many results.' },
			...paginationParam,
		},
	},



	search_for_files: {
		name: 'search_for_files',
		description: `Returns a list of file names whose content matches the given query. The query can be any substring or regex.`,
		params: {
			query: { description: `Your query for the search.` },
			search_in_folder: { description: 'Optional. Leave as blank by default. ONLY fill this in if your previous search with the same query was truncated. Searches descendants of this folder only.' },
			is_regex: { description: 'Optional. Default is false. Whether the query is a regex.' },
			...paginationParam,
		},
	},

	// add new search_in_file tool
	search_in_file: {
		name: 'search_in_file',
		description: `Returns an array of all the start line numbers where the content appears in the file.`,
		params: {
			...uriParam('file'),
			query: { description: 'The string or regex to search for in the file.' },
			is_regex: { description: 'Optional. Default is false. Whether the query is a regex.' }
		}
	},

	go_to_definition: {
		name: 'go_to_definition',
		description: `Finds where a symbol (function, class, method, type, variable...) is defined, using the language server. More precise than text search: it follows imports and ignores unrelated symbols with the same name. Returns each definition's path, line and first lines of code.`,
		params: {
			...uriParam('file where the symbol appears'),
			line: { description: 'The line number (1-based) where the symbol appears in that file.' },
			symbol: { description: 'The symbol exactly as written on that line, e.g. `getUser` (not `api.getUser`).' },
		}
	},

	find_references: {
		name: 'find_references',
		description: `Finds every place a symbol is used across the workspace, using the language server — e.g. all the callers of a function before changing its signature. Returns paths and lines.`,
		params: {
			...uriParam('file where the symbol appears'),
			line: { description: 'The line number (1-based) where the symbol appears in that file.' },
			symbol: { description: 'The symbol exactly as written on that line, e.g. `getUser` (not `api.getUser`).' },
		}
	},

	search_symbols: {
		name: 'search_symbols',
		description: `Searches the whole workspace for symbols (functions, classes, types, variables...) by name, using the language server. Use it to find where something is defined when you know its name but not its file.`,
		params: {
			query: { description: 'The symbol name, or part of it.' },
		}
	},

	read_lint_errors: {
		name: 'read_lint_errors',
		description: `Use this tool to view all the lint errors on a file.`,
		params: {
			...uriParam('file'),
		},
	},

	// not offered anymore (see toolsNotOfferedToModels): the memory is in every system prompt. Kept so older threads that used it still render.
	read_project_memory: {
		name: 'read_project_memory',
		description: `Returns durable notes you've previously saved about this project (architecture, conventions, past decisions, gotchas) via write_project_memory. Empty if nothing has been saved yet.`,
		params: {},
	},

	fetch_url: {
		name: 'fetch_url',
		description: `Fetches a web page and returns its text (as markdown: headings, lists, links and code blocks). Use it to read documentation, an API reference, a changelog or an issue, especially a URL the user gave you. Each URL needs the user's approval, so fetch only what you need, and never put workspace code, secrets or personal data in a URL.`,
		params: {
			url: { description: 'The full http(s) URL of the page.' },
			...paginationParam,
		},
	},

	web_search: {
		name: 'web_search',
		description: `Searches the web using the Brave Search API and returns a list of results with titles, URLs, and snippets. Use this when you need to find current information, documentation, or answers not in the codebase. Each search needs the user's approval.`,
		params: {
			query: { description: 'The search query.' },
			max_results: { description: 'Optional. Maximum number of results to return (1-20). Defaults to 10.' },
		},
	},

	// --- Browser automation ---
	// These tools let the agent drive a real Chromium browser. Ordinary browsing
	// (launch, navigate, inspect, read console) is read-like and auto-allowed in
	// agent/autonomous mode. Page interactions (click, fill, submit, download)
	// are consequential and respect the autonomy policy.

	browser_launch: {
		name: 'browser_launch',
		description: `Launches a real Chromium browser (visible by default) and returns a session_id. Use the session_id in all subsequent browser tools. The browser persists across tool calls within the same session.`,
		params: {
			headless: { description: 'Optional. Run the browser without a visible window (default false). Set true to run headless.' },
			viewport: { description: 'Optional. Initial viewport size as { width, height } in pixels (default 1280x800). Use this to test desktop, tablet, or mobile layouts.' },
		},
	},

	browser_close: {
		name: 'browser_close',
		description: `Closes a browser session and releases all its tabs and processes. Pass the session_id returned by browser_launch.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
		},
	},

	browser_list_sessions: {
		name: 'browser_list_sessions',
		description: `Lists all active browser sessions with their tab counts.`,
		params: {},
	},

	browser_new_tab: {
		name: 'browser_new_tab',
		description: `Opens a new tab in a browser session. Optionally navigates to a URL immediately. Returns a tab_id to use with other browser tools.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
			url: { description: 'Optional. A URL to navigate to in the new tab.' },
		},
	},

	browser_list_tabs: {
		name: 'browser_list_tabs',
		description: `Lists all open tabs in a browser session, with their URLs, titles, and loading state.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
		},
	},

	browser_switch_tab: {
		name: 'browser_switch_tab',
		description: `Switches the active tab in a browser session.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
			tab_id: { description: 'The tab ID to switch to.' },
		},
	},

	browser_close_tab: {
		name: 'browser_close_tab',
		description: `Closes a tab in a browser session.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
			tab_id: { description: 'The tab ID to close.' },
		},
	},

	browser_navigate: {
		name: 'browser_navigate',
		description: `Navigates a tab to a URL and waits for the page to load. Returns the resulting URL and title.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
			tab_id: { description: 'The tab ID to navigate.' },
			url: { description: 'The full URL to open.' },
		},
	},

	browser_back: {
		name: 'browser_back',
		description: `Goes back one page in a tab's history.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
			tab_id: { description: 'The tab ID.' },
		},
	},

	browser_forward: {
		name: 'browser_forward',
		description: `Goes forward one page in a tab's history.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
			tab_id: { description: 'The tab ID.' },
		},
	},

	browser_reload: {
		name: 'browser_reload',
		description: `Reloads the current page of a tab.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
			tab_id: { description: 'The tab ID.' },
		},
	},

	browser_inspect_page: {
		name: 'browser_inspect_page',
		description: `Inspects the current page of a tab: URL, title and HTTP status; layout problems measured on the rendered page (content wider than the viewport, controls covered by other elements or off-screen, clipped text); console errors and failed requests; visible text; interactive elements (buttons, links, inputs, selects, checkboxes, radios), each with a selector that matches exactly that element; and forms. Use the returned selectors with click_element, fill_element, etc. Use it after set_viewport to check a layout at that size.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
			tab_id: { description: 'The tab ID to inspect.' },
		},
	},

	browser_click_element: {
		name: 'browser_click_element',
		description: `Clicks an element on the page by its CSS selector (as returned by inspect_page). Waits for the element to be visible before clicking, and if the click navigates, waits for the new page to load and reports it.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
			tab_id: { description: 'The tab ID.' },
			selector: { description: 'A CSS selector for the element to click (e.g. a button or link selector from inspect_page).' },
		},
	},

	browser_fill_element: {
		name: 'browser_fill_element',
		description: `Fills an input or textarea element with text by its CSS selector. Waits for the element to be visible first.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
			tab_id: { description: 'The tab ID.' },
			selector: { description: 'A CSS selector for the input/textarea to fill.' },
			text: { description: 'The text to type into the field.' },
		},
	},

	browser_select_option: {
		name: 'browser_select_option',
		description: `Selects an option in a <select> dropdown by its value and CSS selector.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
			tab_id: { description: 'The tab ID.' },
			selector: { description: 'A CSS selector for the <select> element.' },
			value: { description: 'The value attribute of the option to select.' },
		},
	},

	browser_check_element: {
		name: 'browser_check_element',
		description: `Checks or unchecks a checkbox or radio button by its CSS selector.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
			tab_id: { description: 'The tab ID.' },
			selector: { description: 'A CSS selector for the checkbox or radio.' },
			checked: { description: 'true to check, false to uncheck.' },
		},
	},

	browser_submit_form: {
		name: 'browser_submit_form',
		description: `Submits a form by its CSS selector. Use after filling the form's fields.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
			tab_id: { description: 'The tab ID.' },
			selector: { description: 'A CSS selector for the <form> element.' },
		},
	},

	browser_wait_for_element: {
		name: 'browser_wait_for_element',
		description: `Waits for an element matching a CSS selector to become visible on the page. Useful after navigation or clicks that load new content.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
			tab_id: { description: 'The tab ID.' },
			selector: { description: 'A CSS selector to wait for.' },
			timeout_ms: { description: 'Optional. Max milliseconds to wait. Defaults to 30000.' },
		},
	},

	browser_set_viewport: {
		name: 'browser_set_viewport',
		description: `Resizes the browser tab's viewport to a specific width and height in pixels. Use this to test responsive designs at desktop, tablet, and mobile sizes live, then take screenshots to verify each layout.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
			tab_id: { description: 'The tab ID.' },
			width: { description: 'Viewport width in pixels (e.g. 375 for mobile, 768 for tablet, 1280 for desktop, 1920 for full HD).' },
			height: { description: 'Viewport height in pixels (e.g. 667 for mobile, 1024 for tablet, 800 for desktop).' },
		},
	},

	browser_screenshot: {
		name: 'browser_screenshot',
		description: `Captures a screenshot of a tab (viewport, full page, or a single element) and saves it as a PNG file, returning its path and size. You do not see the image: to check what the page shows, use browser_inspect_page.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
			tab_id: { description: 'The tab ID.' },
			type: { description: 'Optional. "viewport" (default), "fullpage", or "element".' },
			selector: { description: 'Optional. A CSS selector for a single element to screenshot (only used with type "element").' },
		},
	},

	browser_console: {
		name: 'browser_console',
		description: `Reads console messages and uncaught errors captured for a tab. Use it to inspect JavaScript errors, failed resource loads, and application logs.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
			tab_id: { description: 'The tab ID.' },
			level: { description: 'Optional. Filter by level: debug, info, warning, or error.' },
			limit: { description: 'Optional. Maximum number of messages to return (1-500).' },
		},
	},

	browser_network_failures: {
		name: 'browser_network_failures',
		description: `Returns failed network requests captured for a tab since its current page started loading: transport errors (e.g. ERR_CONNECTION_REFUSED) and HTTP error responses (404, 500, ...). Useful for detecting broken pages and missing resources.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
			tab_id: { description: 'The tab ID.' },
		},
	},

	browser_download: {
		name: 'browser_download',
		description: `Downloads a URL (absolute, or relative to the tab's page) with the browser session's cookies and saves it to disk, returning the download id, local path and size, or the HTTP error.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
			tab_id: { description: 'The tab ID.' },
			url: { description: 'The URL of the file to download.' },
		},
	},

	browser_list_downloads: {
		name: 'browser_list_downloads',
		description: `Lists downloads for a browser session with their status and local file paths.`,
		params: {
			session_id: { description: 'The browser session ID returned by browser_launch.' },
		},
	},

	browser_shutdown: {
		name: 'browser_shutdown',
		description: `Shuts down the browser automation service and closes all sessions. Use when finished browsing.`,
		params: {},
	},

	// --- Autonomous dev cycle tools ---
	// These tools let the agent build, test, and self-correct any application
	// automatically: install dependencies, run migrations, lint, run tests,
	// read logs, and orchestrate full build→test→fix→verify cycles.

	dep_install: {
		name: 'dep_install',
		description: `Installs project dependencies using npm, composer, pip, or other package managers. Runs in the project directory.`,
		params: {
			command: { description: 'The install command to run (e.g. "npm install", "composer install", "pip install -r requirements.txt").' },
			cwd: { description: 'Optional. Working directory to run the command in.' },
		},
	},

	db_migrate: {
		name: 'db_migrate',
		description: `Runs database migrations and seeders. Use this after creating migration files to set up the database schema.`,
		params: {
			command: { description: 'The migration command (e.g. "php artisan migrate --seed", "python manage.py migrate", "npx prisma migrate dev").' },
			cwd: { description: 'Optional. Working directory to run the command in.' },
		},
	},

	lint_run: {
		name: 'lint_run',
		description: `Runs static analysis / linting on the codebase (eslint, phpstan, flake8, tsc, etc.). Returns the number of errors found.`,
		params: {
			command: { description: 'The lint command (e.g. "npx eslint . --ext .js", "phpstan analyse", "flake8 .", "tsc --noEmit").' },
			cwd: { description: 'Optional. Working directory to run the command in.' },
		},
	},

	log_read: {
		name: 'log_read',
		description: `Reads the last N lines of a log file. Useful for diagnosing server errors, build failures, or runtime exceptions.`,
		params: {
			path: { description: 'The absolute path to the log file (e.g. "storage/logs/laravel.log", "npm-debug.log", "stderr.log").' },
			lines: { description: 'Optional. Number of lines to read from the end of the file. Defaults to all lines.' },
		},
	},

	autonomous_dev_cycle: {
		name: 'autonomous_dev_cycle',
		description: `Runs a full autonomous build→test→fix→verify cycle: scaffolds files, installs dependencies, runs migrations, lints, starts the server, runs tests, and self-corrects errors. Use this to build complete applications from a prompt with minimal human intervention.`,
		params: {
			project_type: { description: 'The type of project to build (e.g. "express", "laravel", "django", "fastapi", "go", "spring-boot").' },
			project_description: { description: 'Detailed description of what the application should do, including features, endpoints, and requirements.' },
			port: { description: 'Optional. The port the server should listen on (defaults to 3000).' },
			cwd: { description: 'Optional. Working directory for the project.' },
			max_cycles: { description: 'Optional. Maximum number of fix cycles to run (defaults to 5).' },
		},
	},

	// --- Dev server automation ---
	// These tools start, stop, and list local development servers (npm run dev,
	// php artisan serve, python manage.py runserver, flask run, etc.) so the
	// agent can test fullstack apps end-to-end. Servers run in persistent
	// terminals and survive across tool calls.

	dev_server_start: {
		name: 'dev_server_start',
		description: `Starts a local development server in a background terminal. Returns a name, terminal_id, and detected URL/port. The server keeps running until dev_server_stop is called.`,
		params: {
			command: { description: 'The shell command to start the server (e.g. "npm run dev", "php artisan serve", "python manage.py runserver", "flask run").' },
			cwd: { description: 'Optional. Working directory to run the command in.' },
			port: { description: 'Optional. The port the server is expected to listen on (used to construct the test URL).' },
			name: { description: 'Optional. A friendly name for the server (defaults to a timestamp-based name).' },
		},
	},

	dev_server_stop: {
		name: 'dev_server_stop',
		description: `Stops a running dev server. Pass either name or terminal_id.`,
		params: {
			name: { description: 'Optional. The friendly name of the server (as returned by dev_server_start).' },
			terminal_id: { description: 'Optional. The terminal ID of the server.' },
		},
	},

	dev_server_list: {
		name: 'dev_server_list',
		description: `Lists all active dev servers with their names, terminal IDs, commands, and running status.`,
		params: {},
	},

	dev_server_status: {
		name: 'dev_server_status',
		description: `Checks if a dev server is running. Pass either name or port.`,
		params: {
			name: { description: 'Optional. The friendly name of the server.' },
			port: { description: 'Optional. The port to check.' },
		},
	},

	// --- Direct API testing ---
	// These tools call backend APIs directly (outside the browser), so you can
	// test REST/GraphQL endpoints without going through the UI.

	api_request: {
		name: 'api_request',
		description: `Makes an HTTP request to a backend API endpoint and returns the status code, headers, and body. Supports cookies, OAuth2 Bearer tokens, and multipart file uploads. Use this to test APIs directly without going through the browser UI (like Postman).`,
		params: {
			url: { description: 'The full URL to request (e.g. http://localhost:3000/api/users).' },
			method: { description: 'Optional. HTTP method: GET, POST, PUT, DELETE, or PATCH. Defaults to GET.' },
			headers: { description: 'Optional. HTTP headers as a key-value object (e.g. {"Content-Type": "application/json", "Authorization": "Bearer <token>"}).' },
			body: { description: 'Optional. Request body string (for POST/PUT/PATCH).' },
			timeout_ms: { description: 'Optional. Request timeout in milliseconds.' },
			cookies: { description: 'Optional. Array of cookies to send with the request. Each has name, value, domain, path, expires, httpOnly, secure.' },
			use_cookie_jar: { description: 'Optional. If true, automatically store and send cookies from the cookie jar across requests.' },
			oauth2_tokens: { description: 'Optional. OAuth2 tokens to send as Bearer authorization. Has access_token, refresh_token, expires_in, token_type, scope.' },
			multipart_body: { description: 'Optional. Multipart form data for file uploads. Has fields (name/value pairs) and files (name, filename, content_type, content).' },
		},
	},

	port_check: {
		name: 'port_check',
		description: `Checks if a TCP port is in use on localhost. Useful to verify a dev server is listening before navigating to it.`,
		params: {
			port: { description: 'The port number to check.' },
		},
	},

	// --- Code Index & Semantic Search ---
	code_index: {
		name: 'code_index',
		description: `Rebuilds the code index of the workspace folders from scratch and reports what it contains. Searches build and update the index by themselves, so this is rarely needed.`,
		params: {},
	},

	code_index_file: {
		name: 'code_index_file',
		description: `Re-reads one file into the code index now. Rarely needed: every search first updates files that changed on disk.`,
		params: {
			uri: { description: 'The FULL path to the file.' },
		},
	},

	code_semantic_search: {
		name: 'code_semantic_search',
		description: `Finds the code relevant to a description, across the whole workspace: returns the best-matching functions, classes, methods and sections as path:start-end ranges with the lines that matched. Use it first when you do not know where something is implemented ("where are passwords hashed", "retry with backoff"). It ranks by words, splitting identifiers (authenticateUser → authenticate, user) and expanding common abbreviations (db, auth, config); it is not an embedding model, so use the words the code would likely use. Always up to date with the files on disk. Then read_file the ranges you need.`,
		params: {
			query: { description: 'What you are looking for, in words or identifiers (e.g. "parse config file", "UserRepository save").' },
			limit: { description: 'Optional. Maximum number of results (1-50). Defaults to 10.' },
		},
	},

	code_keyword_search: {
		name: 'code_keyword_search',
		description: `Finds every exact (case-insensitive) occurrence of a string in the workspace's indexed files, with file paths and line numbers. Use it for an identifier, error message or literal you already know.`,
		params: {
			query: { description: 'The exact text to find.' },
			limit: { description: 'Optional. Maximum number of occurrences (1-50). Defaults to 30.' },
		},
	},

	code_hybrid_search: {
		name: 'code_hybrid_search',
		description: `Same as code_semantic_search (kept for older conversations).`,
		params: {
			query: { description: 'What you are looking for.' },
			limit: { description: 'Optional. Maximum number of results (1-50). Defaults to 10.' },
		},
	},

	code_index_stats: {
		name: 'code_index_stats',
		description: `Reports what the code index contains: folders, files, chunks, what was skipped and why.`,
		params: {},
	},

	code_index_clear: {
		name: 'code_index_clear',
		description: `Empties the code index (the next search rebuilds it).`,
		params: {},
	},

	// Cookie management
	api_get_cookies: {
		name: 'api_get_cookies',
		description: `Returns all cookies currently stored in the cookie jar. Use this to inspect cookies captured from previous API responses.`,
		params: {},
	},

	api_set_cookies: {
		name: 'api_set_cookies',
		description: `Replaces all cookies in the jar with the given list. Useful for restoring a session or setting up authentication state.`,
		params: {
			cookies: { description: 'Array of cookie objects, each with name, value, domain, path, expires, httpOnly, secure.' },
		},
	},

	api_add_cookie: {
		name: 'api_add_cookie',
		description: `Adds a single cookie to the jar. If a cookie with the same name and domain already exists, it is replaced.`,
		params: {
			cookie: { description: 'Cookie object with name, value, domain, path, expires, httpOnly, secure.' },
		},
	},

	api_clear_cookies: {
		name: 'api_clear_cookies',
		description: `Removes all cookies from the jar. Useful for starting a fresh session.`,
		params: {},
	},

	// OAuth2
	oauth2_generate_auth_url: {
		name: 'oauth2_generate_auth_url',
		description: `Generates an OAuth2 authorization URL for the authorization code flow. The user visits this URL to grant access. Returns the URL, state, and PKCE code_verifier.`,
		params: {
			client_id: { description: 'OAuth2 client ID.' },
			client_secret: { description: 'OAuth2 client secret.' },
			authorization_url: { description: 'The OAuth2 authorization endpoint URL.' },
			token_url: { description: 'The OAuth2 token endpoint URL.' },
			redirect_uri: { description: 'The redirect URI registered with the OAuth provider.' },
			scope: { description: 'Optional. Space-separated list of scopes to request.' },
		},
	},

	oauth2_exchange_code: {
		name: 'oauth2_exchange_code',
		description: `Exchanges an authorization code for OAuth2 access and refresh tokens. Call this after the user has granted access and you have the code from the redirect.`,
		params: {
			client_id: { description: 'OAuth2 client ID.' },
			client_secret: { description: 'OAuth2 client secret.' },
			token_url: { description: 'The OAuth2 token endpoint URL.' },
			redirect_uri: { description: 'The same redirect URI used in authorization.' },
			code: { description: 'The authorization code from the redirect.' },
			code_verifier: { description: 'Optional. PKCE code verifier if PKCE was used.' },
		},
	},

	oauth2_refresh_token: {
		name: 'oauth2_refresh_token',
		description: `Refreshes an OAuth2 access token using a refresh token. Returns new access and refresh tokens.`,
		params: {
			client_id: { description: 'OAuth2 client ID.' },
			client_secret: { description: 'OAuth2 client secret.' },
			token_url: { description: 'The OAuth2 token endpoint URL.' },
			refresh_token: { description: 'The refresh token to exchange.' },
		},
	},

	// --- Debugger automation ---
	// These tools drive VS Code's real Debug Adapter Protocol (DAP) debugging
	// infrastructure. Inspection tools (list sessions, stack trace, variables,
	// exceptions) are read-like. Session control, breakpoint, execution control
	// and expression evaluation are consequential and respect the autonomy policy.

	debug_list_configurations: {
		name: 'debug_list_configurations',
		description: `Lists all available debug configurations (from launch.json and the global launch config). Returns each configuration's name, type and request (launch/attach).`,
		params: {},
	},

	debug_list_sessions: {
		name: 'debug_list_sessions',
		description: `Lists all active debug sessions with their IDs, names, types, and states (inactive, initializing, stopped, running).`,
		params: {},
	},

	debug_get_session_status: {
		name: 'debug_get_session_status',
		description: `Returns the status of a debug session: its state, configuration, and type. Pass the sessionId returned by debug_list_sessions or debug_start_session.`,
		params: {
			session_id: { description: 'The debug session ID.' },
		},
	},

	debug_start_session: {
		name: 'debug_start_session',
		description: `Starts a debug session using a named launch configuration. Returns the new sessionId.`,
		params: {
			configuration_name: { description: 'The name of the debug configuration to start.' },
			folder: { description: 'Optional. The workspace folder to launch in.' },
			no_debug: { description: 'Optional. Run without debugging (just start the program).' },
		},
	},

	debug_attach_session: {
		name: 'debug_attach_session',
		description: `Attaches to a running process using a named 'attach' debug configuration. Returns the new sessionId.`,
		params: {
			configuration_name: { description: 'The name of the attach debug configuration.' },
			folder: { description: 'Optional. The workspace folder.' },
		},
	},

	debug_stop_session: {
		name: 'debug_stop_session',
		description: `Stops a debug session. Pass the sessionId.`,
		params: {
			session_id: { description: 'The debug session ID.' },
			restart: { description: 'Optional. Whether the session will be restarted.' },
			suspend: { description: 'Optional. Whether to suspend the debuggee.' },
		},
	},

	debug_restart_session: {
		name: 'debug_restart_session',
		description: `Restarts a debug session. Pass the sessionId.`,
		params: {
			session_id: { description: 'The debug session ID.' },
		},
	},

	debug_set_breakpoint: {
		name: 'debug_set_breakpoint',
		description: `Sets a breakpoint in a source file at a given line (and optional column). Optionally scoped to a session. Returns the breakpoint id.`,
		params: {
			session_id: { description: 'Optional. The debug session ID to associate the breakpoint with.' },
			uri: { description: 'The full file URI or path to set the breakpoint in.' },
			line_number: { description: 'The 1-based line number.' },
			column: { description: 'Optional. The 1-based column number.' },
			condition: { description: 'Optional. An expression that must be true for the breakpoint to hit.' },
			hit_condition: { description: 'Optional. A hit count condition.' },
			log_message: { description: 'Optional. A message to log instead of breaking (logpoint).' },
		},
	},

	debug_remove_breakpoint: {
		name: 'debug_remove_breakpoint',
		description: `Removes a breakpoint by its id.`,
		params: {
			breakpoint_id: { description: 'The breakpoint id returned by debug_set_breakpoint or debug_list_breakpoints.' },
		},
	},

	debug_set_breakpoint_enabled: {
		name: 'debug_set_breakpoint_enabled',
		description: `Enables or disables a breakpoint by its id.`,
		params: {
			breakpoint_id: { description: 'The breakpoint id.' },
			enabled: { description: 'true to enable, false to disable.' },
		},
	},

	debug_list_breakpoints: {
		name: 'debug_list_breakpoints',
		description: `Lists all breakpoints with their ids, locations, verification status, and conditions.`,
		params: {},
	},

	debug_continue: {
		name: 'debug_continue',
		description: `Continues execution of a stopped thread. Pass the sessionId and threadId.`,
		params: {
			session_id: { description: 'The debug session ID.' },
			thread_id: { description: 'The thread id.' },
		},
	},

	debug_pause: {
		name: 'debug_pause',
		description: `Pauses a running thread. Pass the sessionId and threadId.`,
		params: {
			session_id: { description: 'The debug session ID.' },
			thread_id: { description: 'The thread id.' },
		},
	},

	debug_step_over: {
		name: 'debug_step_over',
		description: `Steps over the current line in a stopped thread. Pass the sessionId and threadId.`,
		params: {
			session_id: { description: 'The debug session ID.' },
			thread_id: { description: 'The thread id.' },
		},
	},

	debug_step_into: {
		name: 'debug_step_into',
		description: `Steps into the current call in a stopped thread. Pass the sessionId and threadId.`,
		params: {
			session_id: { description: 'The debug session ID.' },
			thread_id: { description: 'The thread id.' },
		},
	},

	debug_step_out: {
		name: 'debug_step_out',
		description: `Steps out of the current function in a stopped thread. Pass the sessionId and threadId.`,
		params: {
			session_id: { description: 'The debug session ID.' },
			thread_id: { description: 'The thread id.' },
		},
	},

	debug_list_threads: {
		name: 'debug_list_threads',
		description: `Lists all threads in a debug session with their ids, names, and stopped state.`,
		params: {
			session_id: { description: 'The debug session ID.' },
		},
	},

	debug_get_stack_trace: {
		name: 'debug_get_stack_trace',
		description: `Retrieves the call stack for a thread: frame ids, names, source locations, and line numbers.`,
		params: {
			session_id: { description: 'The debug session ID.' },
			thread_id: { description: 'The thread id.' },
			start_frame: { description: 'Optional. The index of the first frame to return (0-based).' },
			levels: { description: 'Optional. The number of frames to return.' },
		},
	},

	debug_get_scopes: {
		name: 'debug_get_scopes',
		description: `Retrieves the variable scopes (local, argument, global, ...) for a stack frame. Pass the sessionId and frameId (optionally threadId).`,
		params: {
			session_id: { description: 'The debug session ID.' },
			frame_id: { description: 'The stack frame id.' },
			thread_id: { description: 'Optional. The thread id. Defaults to the stopped thread.' },
		},
	},

	debug_get_variables: {
		name: 'debug_get_variables',
		description: `Retrieves the variables in a scope or object (identified by variablesReference). Supports pagination via start and count.`,
		params: {
			session_id: { description: 'The debug session ID.' },
			variables_reference: { description: 'The variables reference from a scope or variable.' },
			start: { description: 'Optional. The index of the first variable to return.' },
			count: { description: 'Optional. The number of variables to return.' },
		},
	},

	debug_evaluate_expression: {
		name: 'debug_evaluate_expression',
		description: `Evaluates an expression in the context of a stopped stack frame. Returns the result, type, and whether it has children.`,
		params: {
			session_id: { description: 'The debug session ID.' },
			expression: { description: 'The expression to evaluate.' },
			frame_id: { description: 'Optional. The stack frame id to evaluate in.' },
		},
	},

	debug_get_exception_info: {
		name: 'debug_get_exception_info',
		description: `Returns information about the exception that caused a thread to stop (message, type, break mode).`,
		params: {
			session_id: { description: 'The debug session ID.' },
			thread_id: { description: 'The thread id.' },
		},
	},

	debug_get_console_output: {
		name: 'debug_get_console_output',
		description: `Returns buffered debug console output (program stdout/stderr and debugger output) for a session.`,
		params: {
			session_id: { description: 'Optional. The debug session ID. Omits to return output from all sessions.' },
			limit: { description: 'Optional. Maximum number of output entries to return.' },
		},
	},

	// --- editing (create/delete) ---

	create_file_or_folder: {
		name: 'create_file_or_folder',
		description: `Create a file or folder at the given path. To create a folder, the path MUST end with a trailing slash.`,
		params: {
			...uriParam('file or folder'),
		},
	},

	delete_file_or_folder: {
		name: 'delete_file_or_folder',
		description: `Delete a file or folder at the given path.`,
		params: {
			...uriParam('file or folder'),
			is_recursive: { description: 'Optional. Return true to delete recursively.' }
		},
	},

	edit_file: {
		name: 'edit_file',
		description: `Edit the contents of a file. You must provide the file's URI as well as a SINGLE string of SEARCH/REPLACE block(s) that will be used to apply the edit.`,
		params: {
			...uriParam('file'),
			search_replace_blocks: { description: replaceTool_description }
		},
	},

	rewrite_file: {
		name: 'rewrite_file',
		description: `Edits a file, deleting all the old contents and replacing them with your new contents. Use this tool if you want to edit a file you just created.`,
		params: {
			...uriParam('file'),
			new_content: { description: `The new contents of the file. Must be a string.` }
		},
	},

	// write_file: alias for rewrite_file
	write_file: {
		name: 'write_file',
		description: `Write content to a file, deleting all the old contents and replacing them with your new contents. Use this tool if you want to edit a file you just created or overwrite an existing file.`,
		params: {
			...uriParam('file'),
			new_content: { description: `The new contents of the file. Must be a string.` }
		},
	},

	write_project_memory: {
		name: 'write_project_memory',
		description: `Saves durable notes about this project for future sessions, in the project memory (\`.kodia/memory.md\` in the repo, shown to you in PROJECT MEMORY at the start of every conversation). The memory is organized in "## " sections; this rewrites one whole section, so merge what's already there into the new content rather than repeating it. Save things worth knowing in every session: architecture, conventions, commands, decisions and their reasons, pitfalls. Keep it short and current: replace outdated notes, and delete a section by passing empty content. Never save secrets, credentials, or other sensitive information. ${Number.isFinite(MAX_PROJECT_MEMORY_TOKENS)
			? `The whole memory is capped at ~${MAX_PROJECT_MEMORY_TOKENS} tokens; a write that would exceed it is rejected, so condense other sections first.`
			: `Keep it compact: only part of a long memory fits in a small model's context (the rest is listed by section title, to be read from the file).`}`, // was: "capped at ~Infinity tokens"
		params: {
			section: { description: `The section title, e.g. "Architecture", "Conventions", "Commands", "Pitfalls". Reuse an existing title to rewrite that section.` },
			content: { description: `The full new text of the section (markdown, no "## " heading). Empty to delete the section.` },
		},
	},

	run_command: {
		name: 'run_command',
		description: `Runs a terminal command and waits for the result (times out after ${MAX_TERMINAL_INACTIVE_TIME}s of inactivity). ${terminalDescHelper}`,
		params: {
			command: { description: 'The terminal command to run.' },
			cwd: { description: cwdHelper },
		},
	},

	run_persistent_command: {
		name: 'run_persistent_command',
		description: `Runs a terminal command in the persistent terminal that you created with open_persistent_terminal (results after ${MAX_TERMINAL_BG_COMMAND_TIME} are returned, and command continues running in background). ${terminalDescHelper}`,
		params: {
			command: { description: 'The terminal command to run.' },
			persistent_terminal_id: { description: 'The ID of the terminal created using open_persistent_terminal.' },
		},
	},



	open_persistent_terminal: {
		name: 'open_persistent_terminal',
		description: `Use this tool when you want to run a terminal command indefinitely, like a dev server (eg \`npm run dev\`), a background listener, etc. Opens a new terminal in the user's environment which will not awaited for or killed.`,
		params: {
			cwd: { description: cwdHelper },
		}
	},


	kill_persistent_terminal: {
		name: 'kill_persistent_terminal',
		description: `Interrupts and closes a persistent terminal that you opened with open_persistent_terminal.`,
		params: { persistent_terminal_id: { description: `The ID of the persistent terminal.` } }
	},

	list_terminals: {
		name: 'list_terminals',
		description: `Lists all open terminal sessions (persistent and temporary) with their IDs, types, current working directories, process IDs, exit codes, and running status. Use this to see what terminals exist before sending commands to them.`,
		params: {},
	},

	read_terminal: {
		name: 'read_terminal',
		description: `Reads new output from a terminal since the last read. Returns incremental output so you can poll a running command without re-reading old output. Use this to monitor long-running commands like build processes or dev servers.`,
		params: {
			terminal_id: { description: 'The ID of the terminal to read from.' },
			offset: { description: 'Optional. Character offset to start reading from. Defaults to the last read position.' },
		},
	},

	send_command_to_terminal: {
		name: 'send_command_to_terminal',
		description: `Sends a command to an existing persistent terminal session (opened with open_persistent_terminal) without waiting for completion. Use this to run multiple commands in the same session (e.g. cd into a directory, then install deps, then run a dev server). The command is executed immediately; use read_terminal to poll for output. Note: terminals created by run_command are temporary and are disposed after the command finishes, so you cannot send additional commands to them. Use open_persistent_terminal for sessions you want to reuse.`,
		params: {
			terminal_id: { description: 'The ID of the persistent terminal to send the command to.' },
			command: { description: 'The terminal command to run.' },
		},
	},

	interrupt_terminal: {
		name: 'interrupt_terminal',
		description: `Sends Ctrl+C to a terminal to interrupt the currently running process. The terminal session itself remains open.`,
		params: { terminal_id: { description: 'The ID of the terminal to interrupt.' } }
	},

	close_terminal: {
		name: 'close_terminal',
		description: `Closes and disposes of a terminal session (persistent or temporary). Use this to clean up terminals you no longer need.`,
		params: { terminal_id: { description: 'The ID of the terminal to close.' } }
	},

	// Notebook operations (Jupyter)
	read_notebook: {
		name: 'read_notebook',
		description: `Read a Jupyter notebook (.ipynb) file. Returns all cells with their source, outputs, and execution counts. Optionally specify a cell range to read part of a large notebook.`,
		params: {
			...uriParam('notebook'),
			start_cell: { description: 'Optional. Start reading from this cell index (0-based).' },
			end_cell: { description: 'Optional. Read up to this cell index (exclusive).' },
		},
	},

	write_notebook: {
		name: 'write_notebook',
		description: `Create a new Jupyter notebook or completely replace an existing one. Provide an array of cells with their type (code/markdown), source, and optional metadata.`,
		params: {
			...uriParam('notebook'),
			cells: { description: 'Array of cells. Each cell has cell_type ("code" or "markdown"), source (string), and optional metadata/outputs.' },
		},
	},

	edit_notebook: {
		name: 'edit_notebook',
		description: `Edit an existing notebook by adding, removing, replacing, moving cells, or updating cell content/outputs. Provide an array of operations to apply in order.`,
		params: {
			...uriParam('notebook'),
			operations: { description: 'Array of operations: add_cell, remove_cell, replace_cell, move_cell, update_cell_source, update_cell_outputs, clear_cell_outputs. Each operation has a type and relevant parameters.' },
		},
	},

	execute_notebook_cell: {
		name: 'execute_notebook_cell',
		description: `Execute a specific code cell in a notebook using its kernel. Returns the cell outputs (stdout, stderr, display data, errors) and execution time. Optionally specify a kernel ID.`,
		params: {
			...uriParam('notebook'),
			cell_index: { description: 'The 0-based index of the cell to execute.' },
			kernel_id: { description: 'Optional. The kernel ID to use. If not specified, uses the notebook\'s current kernel.' },
		},
	},

	execute_notebook: {
		name: 'execute_notebook',
		description: `Execute all code cells in a notebook (or a subset) in order. Returns results for each cell with outputs and execution times. Optionally specify a kernel ID and specific cell indices.`,
		params: {
			...uriParam('notebook'),
			kernel_id: { description: 'Optional. The kernel ID to use.' },
			cell_indices: { description: 'Optional. Specific cell indices to execute (0-based). If omitted, executes all code cells.' },
		},
	},

	select_notebook_kernel: {
		name: 'select_notebook_kernel',
		description: `Select a kernel for a notebook. Use list_notebook_kernels first to see available kernels.`,
		params: {
			...uriParam('notebook'),
			kernel_id: { description: 'The kernel ID to select.' },
		},
	},

	list_notebook_kernels: {
		name: 'list_notebook_kernels',
		description: `List available Jupyter kernels for the workspace (or for a specific notebook if URI provided). Returns kernel IDs, names, descriptions, and supported languages.`,
		params: {
			uri: { description: 'Optional. The notebook URI to get kernels for. If omitted, lists all available kernels.' },
		},
	},

	// Task plan management (Stage 5A Day 2)
	create_task_plan: {
		name: 'create_task_plan',
		description: `Create a task plan for a development request. Use this when the user asks you to build, fix, or modify something substantial. Break the request into ordered tasks with dependencies.`,
		params: {
			title: { description: 'A short title for the overall task, e.g. "Build a todo app with React".' },
			description: { description: 'A brief description of what the overall task entails.' },
			tasks: { description: 'Array of initial tasks. Each task has a title, description, and optional dependencies (task IDs that must complete first).' },
		},
	},

	update_task_plan: {
		name: 'update_task_plan',
		description: `Update the status of a task in the current plan. Call this when you start working on a task (status: 'running'), when you finish it (status: 'completed'), or when you encounter an error (status: 'failed' with an error message).`,
		params: {
			task_id: { description: 'The ID of the task to update.' },
			status: { description: 'New status: "pending", "running", "completed", "failed", or "blocked".' },
			result: { description: 'Optional. A summary of what was accomplished, for completed tasks.' },
			error: { description: 'Optional. An error message, for failed tasks.' },
		},
	},

	get_task_plan: {
		name: 'get_task_plan',
		description: `Read the current task plan. Use this to see what tasks remain, what has been completed, and what the current task is.`,
		params: {},
	},

	// Git operations (Stage 2)
	git_status: {
		name: 'git_status',
		description: `Show the working tree status of the Git repository: current branch, staged/unstaged/untracked files, and merge state. Read-only.`,
		params: {},
	},
	git_diff: {
		name: 'git_diff',
		description: `Show the diff of changes in the Git repository. Without arguments, shows unstaged changes. Use ref to diff against a specific commit/branch. Use path to limit to a specific file. Set staged to true to show staged changes.`,
		params: {
			ref: { description: 'Optional. The commit or branch to diff against.' },
			path: { description: 'Optional. Limit diff to this file path.' },
			staged: { description: 'Optional. Show staged changes instead of unstaged.' },
		},
	},
	git_log: {
		name: 'git_log',
		description: `Show commit history. Use max_count to limit the number of commits. Use path to limit to a specific file.`,
		params: {
			max_count: { description: 'Optional. Maximum number of commits to show.' },
			path: { description: 'Optional. Limit log to this file path.' },
		},
	},
	git_branch_list: {
		name: 'git_branch_list',
		description: `List all local and remote branches with their tracking status.`,
		params: {},
	},
	git_branch_create: {
		name: 'git_branch_create',
		description: `Create a new branch. Optionally specify a start point (commit or branch).`,
		params: {
			branch_name: { description: 'The name of the new branch.' },
			start_point: { description: 'Optional. The commit or branch to start from.' },
		},
	},
	git_branch_switch: {
		name: 'git_branch_switch',
		description: `Switch to an existing branch.`,
		params: {
			branch_name: { description: 'The name of the branch to switch to.' },
		},
	},
	git_stage: {
		name: 'git_stage',
		description: `Stage files for commit (git add). Provide an array of file paths.`,
		params: {
			paths: { description: 'Array of file paths to stage.' },
		},
	},
	git_unstage: {
		name: 'git_unstage',
		description: `Unstage files (git reset HEAD). Provide an array of file paths.`,
		params: {
			paths: { description: 'Array of file paths to unstage.' },
		},
	},
	git_commit: {
		name: 'git_commit',
		description: `Commit staged changes with a message. Use amend to amend the previous commit.`,
		params: {
			message: { description: 'The commit message.' },
			amend: { description: 'Optional. Amend the previous commit instead of creating a new one.' },
		},
	},
	git_fetch: {
		name: 'git_fetch',
		description: `Fetch from a remote. Optionally specify which remote.`,
		params: {
			remote: { description: 'Optional. The remote name (e.g., origin).' },
		},
	},
	git_pull: {
		name: 'git_pull',
		description: `Pull from a remote. Optionally specify remote and branch.`,
		params: {
			remote: { description: 'Optional. The remote name.' },
			branch: { description: 'Optional. The branch to pull.' },
		},
	},
	git_push: {
		name: 'git_push',
		description: `Push to a remote. Optionally specify remote, branch, and force. Force push is a high-risk operation.`,
		params: {
			remote: { description: 'Optional. The remote name.' },
			branch: { description: 'Optional. The branch to push.' },
			force: { description: 'Optional. Force push (high risk - can overwrite remote history).' },
		},
	},
	git_merge: {
		name: 'git_merge',
		description: `Merge a branch into the current branch. May result in conflicts that need manual resolution.`,
		params: {
			branch: { description: 'The branch to merge into the current branch.' },
		},
	},
	git_stash: {
		name: 'git_stash',
		description: `Stash local changes. Optionally provide a message.`,
		params: {
			message: { description: 'Optional. A message for the stash.' },
		},
	},
	git_stash_pop: {
		name: 'git_stash_pop',
		description: `Pop the most recent stash, restoring stashed changes.`,
		params: {},
	},
	git_show: {
		name: 'git_show',
		description: `Show details of a specific commit, including its diff. Optionally limit to a specific file path.`,
		params: {
			commit: { description: 'The commit hash or reference.' },
			path: { description: 'Optional. Limit to this file path.' },
		},
	},
	git_revert: {
		name: 'git_revert',
		description: `Undo a commit by creating a new commit that reverses it (history is kept). If it conflicts, the revert stops: resolve the conflicted files, git_stage them, then git_continue (or git_abort).`,
		params: {
			commit: { description: 'The commit hash or reference to revert.' },
		},
	},
	git_cherry_pick: {
		name: 'git_cherry_pick',
		description: `Apply the changes of one commit from another branch onto the current branch as a new commit. On conflicts it stops: resolve, git_stage, then git_continue (or git_abort).`,
		params: {
			commit: { description: 'The commit hash or reference to apply.' },
		},
	},
	git_rebase: {
		name: 'git_rebase',
		description: `Rebase the current branch onto another branch or commit (non-interactive; rewrites this branch's commits). Refused by git when there are uncommitted changes. On conflicts it stops: resolve, git_stage, then git_continue (or git_abort).`,
		params: {
			onto: { description: 'The branch or commit to rebase onto, e.g. main.' },
		},
	},
	git_continue: {
		name: 'git_continue',
		description: `Continue the merge, revert, cherry-pick or rebase that stopped on conflicts, after the conflicted files were fixed and staged with git_stage.`,
		params: {},
	},
	git_abort: {
		name: 'git_abort',
		description: `Abort the merge, revert, cherry-pick or rebase in progress and return to the state before it started.`,
		params: {},
	},
	git_reset: {
		name: 'git_reset',
		description: `Move the current branch to another commit. mode "soft" keeps changes staged, "mixed" keeps them in the working tree, "hard" also resets the working tree and is refused when there are uncommitted changes. The result lists the commits the branch no longer contains and the previous HEAD, so it can be undone with git_reset to that hash.`,
		params: {
			ref: { description: 'The commit to move to, e.g. HEAD~1 or a hash.' },
			mode: { description: '"soft", "mixed" or "hard". Default "mixed".' },
		},
	},
	git_tag_list: {
		name: 'git_tag_list',
		description: `List tags (newest first) with the commit each points to.`,
		params: {},
	},
	git_tag_create: {
		name: 'git_tag_create',
		description: `Create a tag. With a message it is an annotated tag. Fails if the tag already exists.`,
		params: {
			name: { description: 'The tag name, e.g. v1.2.0.' },
			ref: { description: 'Optional. The commit to tag; default HEAD.' },
			message: { description: 'Optional. Message for an annotated tag.' },
		},
	},
	git_remote_list: {
		name: 'git_remote_list',
		description: `List the repository's remotes and their URLs (credentials in URLs are hidden).`,
		params: {},
	},
	git_worktree_list: {
		name: 'git_worktree_list',
		description: `List the repository's worktrees (separate checkouts) with their branch and HEAD.`,
		params: {},
	},
	git_worktree_add: {
		name: 'git_worktree_add',
		description: `Create a separate worktree (another checkout of this repository in its own folder) so work can happen on a branch without touching the current checkout.`,
		params: {
			path: { description: 'Folder for the new worktree (absolute, or relative to the repository root). It must not exist or must be empty.' },
			branch: { description: 'The branch to check out there.' },
			new_branch: { description: 'Optional. true to create the branch (from start_point, default HEAD). Default false: check out an existing branch.' },
			start_point: { description: 'Optional, with new_branch. The commit or branch the new branch starts from.' },
		},
	},
	git_commit_context: {
		name: 'git_commit_context',
		description: `Before git_commit: get exactly what is staged (files, line counts, the staged diff), what is NOT staged (so the message does not claim it), and this repository's message style from its recent commits (e.g. conventional "type(scope): subject", usual types and scopes, typical subject length). Write the commit message from this, describing only the staged change, then call git_commit.`,
		params: {
			max_diff_chars: { description: 'Optional. How much of the staged diff to include (default 12000, max 60000).' },
		},
	},
	git_pr_prepare: {
		name: 'git_pr_prepare',
		description: `Prepare a pull request description: the branch's commits and changed files versus the base branch, whether the branch is pushed, uncommitted work, files that would conflict when merged into the base (checked without touching the working tree), and the last test run in this session. Write the title and description from these facts only: mention tests only if a test run is reported. Kodia does not open the pull request itself.`,
		params: {
			base: { description: 'Optional. The branch the pull request targets (default: origin\'s default branch, else main or master).' },
		},
	},

	// Test discovery and execution (Stage 3)
	test_discover: {
		name: 'test_discover',
		description: `Discover available test frameworks and runners in the project. Returns a list of detected test frameworks with their configuration files.`,
		params: {},
	},
	test_list: {
		name: 'test_list',
		description: `List all test files and suites discovered in the project. Returns test file paths with test counts and associated frameworks.`,
		params: {},
	},
	test_run: {
		name: 'test_run',
		description: `Run tests. Optionally specify test files and/or test names to run a subset. Without arguments, runs all discovered tests.`,
		params: {
			test_files: { description: 'Optional. Absolute paths to test files to run.' },
			test_names: { description: 'Optional. Specific test names to run.' },
		},
	},
	test_run_targeted: {
		name: 'test_run_targeted',
		description: `Run tests related to specific changed files. Uses VS Code's test controller to find tests related to the given files.`,
		params: {
			changed_files: { description: 'Array of absolute file paths that were changed. Tests related to these files will be run.' },
		},
	},
	test_rerun_failed: {
		name: 'test_rerun_failed',
		description: `Re-run tests that failed in the most recent test run. If no previous run exists or no tests failed, returns an empty result.`,
		params: {},
	},
	test_coverage: {
		name: 'test_coverage',
		description: `Run tests with coverage and report line/branch coverage per file, with the uncovered line numbers. Use it after adding or changing code to see which lines no test exercises. Uses the framework's own coverage (node --test, Jest, Vitest; pytest needs pytest-cov, Vitest needs @vitest/coverage-v8, Mocha needs c8, Go uses -coverprofile). A missing plugin is reported, not hidden.`,
		params: {
			test_files: { description: 'Optional. Test files to run (default: all).' },
			test_names: { description: 'Optional. Test names to run.' },
			files: { description: 'Optional. Source files to report coverage for, e.g. the ones you changed (default: every file the report covers). A file no test loaded is reported as not covered.' },
		},
	},
	test_history: {
		name: 'test_history',
		description: `Show the recorded outcomes of this project's tests across runs (kept across restarts): per test, how often it passed and failed, whether it is failing now, and whether it is FLAKY — passed and failed on the exact same code (tracked by git). Every test run is recorded automatically; test results also flag regressions (passed last run, fail now).`,
		params: {
			test_name: { description: 'Optional. Show only tests whose name or file contains this text.' },
			only_problems: { description: 'Optional. "true" to show only flaky, failing or unstable tests.' },
			limit: { description: 'Optional. Maximum tests to show (default 30).' },
		},
	},
	test_check_flaky: {
		name: 'test_check_flaky',
		description: `Run the same tests several times in a row without changing code and report which ones are flaky (pass sometimes, fail sometimes) versus failing every time. Use it when a test fails and you suspect flakiness, before changing code. Name the tests or files: the whole suite repeated is slow.`,
		params: {
			test_files: { description: 'Optional. Test files to repeat.' },
			test_names: { description: 'Optional. Test names to repeat.' },
			attempts: { description: 'Optional. How many times to run them, 2–10 (default 3).' },
		},
	},
	test_cancel: {
		name: 'test_cancel',
		description: `Cancel a running test operation. Optionally specify a run ID; if not given, cancels the most recent run.`,
		params: {
			run_id: { description: 'Optional. The ID of the test run to cancel.' },
		},
	},
	// Todo list (task tracking within a turn - OpenCode parity). The agent tracks what it
	// plans to do, what it is doing now and what is done, so long multi-step work stays
	// organized instead of being lost across LLM calls.
	todo: {
		name: 'todo',
		description: `Manage a todo list for the current turn. Use it to break a multi-step request into concrete items, mark each item in_progress when you start it and completed when it's done. This is how you remember your plan across tool calls — always create or update the todo list before and during substantial work.`,
		params: {
			todos: { description: 'The full todo list. Each todo has an id (a short stable key like "setup", "implement", "tests"), content (a one-line description) and status ("pending", "in_progress" or "completed").' },
		},
	},
	// Subagent delegation (roadmap 6): runs a child agent loop in its own thread to completion and returns its report.
	subagent: {
		name: 'subagent',
		description: `Delegate a task to a subagent: a separate agent with its own conversation, which works until it is done and then returns a report (what it changed, its tool calls and errors, and its final answer). The subagent does not see this conversation, so the prompt must contain everything it needs. Several subagent calls in the same reply run IN PARALLEL — use that for independent pieces of work (e.g. one subagent per module). Parallel subagents must work on different files: a file one of them is changing is refused to the others. Subagents cannot start subagents. Check the report (read the files, run the tests) before relying on it.`,
		params: {
			agent: { description: 'The subagent type: "general" (can edit files and run commands), "explore" (read-only: searches and reads the code) or "review" (read-only: reviews code and reports problems).' },
			description: { description: 'A short 3-5 word label for the task, displayed to the user.' },
			prompt: { description: 'The full task for the subagent to perform. Include all context it needs.' },
			model: { description: 'Optional. A model set up in Kodia, as provider/model (e.g. a cheaper model for exploring). Default: the model you are using.' },
			session_i_d: { description: 'Optional. The session id from an earlier subagent report, to give that subagent a follow-up task (it keeps its conversation).' },
		},
	},

	// go_to_definition
	// go_to_usages

} satisfies { [T in keyof BuiltinToolResultType]: InternalToolInfo }




export const builtinToolNames = Object.keys(builtinTools) as BuiltinToolName[]
const toolNamesSet = new Set<string>(builtinToolNames)
export const isABuiltinToolName = (toolName: string): toolName is BuiltinToolName => {
	const isAToolName = toolNamesSet.has(toolName)
	return isAToolName
}





// built-in tools kept for older threads, but no longer given to models
const toolsNotOfferedToModels: ReadonlySet<BuiltinToolName> = new Set(['read_project_memory', 'code_hybrid_search'])

// tools that change nothing but still need approval: Gather mode offers them too
const readOnlyToolsNeedingApproval: ReadonlySet<BuiltinToolName> = new Set(['fetch_url', 'web_search'])

// explicitTools: Kodia Agents Window — an agent that runs its own tools offers exactly those, instead of the chat mode's
export const availableTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, explicitTools?: InternalToolInfo[]) => {
	if (explicitTools) return explicitTools

	const offeredToolNames = (Object.keys(builtinTools) as BuiltinToolName[]).filter(toolName => !toolsNotOfferedToModels.has(toolName))
	const builtinToolNames: BuiltinToolName[] | undefined = chatMode === 'normal' ? undefined
		: chatMode === 'gather' ? offeredToolNames.filter(toolName => !(toolName in approvalTypeOfBuiltinToolName) || readOnlyToolsNeedingApproval.has(toolName))
			: chatMode === 'agent' ? offeredToolNames
				: undefined

	const effectiveBuiltinTools = builtinToolNames?.map(toolName => builtinTools[toolName]) ?? undefined
	const effectiveMCPTools = chatMode === 'agent' ? mcpTools : undefined

	const tools: InternalToolInfo[] | undefined = !(builtinToolNames || mcpTools) ? undefined
		: [
			...effectiveBuiltinTools ?? [],
			...effectiveMCPTools ?? [],
		]

	return tools
}

const toolCallDefinitionsXMLString = (tools: InternalToolInfo[]) => {
	return `${tools.map((t, i) => {
		const params = Object.keys(t.params).map(paramName => `<${paramName}>${t.params[paramName].description}</${paramName}>`).join('\n')
		return `\
    ${i + 1}. ${t.name}
    Description: ${t.description}
    Format:
    <${t.name}>${!params ? '' : `\n${params}`}
    </${t.name}>`
	}).join('\n\n')}`
}

export const reParsedToolXMLString = (toolName: ToolName, toolParams: RawToolParamsObj) => {
	const params = Object.keys(toolParams).map(paramName => `<${paramName}>${toolParams[paramName]}</${paramName}>`).join('\n')
	return `\
    <${toolName}>${!params ? '' : `\n${params}`}
    </${toolName}>`
		.replace('\t', '  ')
}

/* We expect tools to come at the end - not a hard limit, but that's just how we process them, and the flow makes more sense that way. */
// - You are allowed to call multiple tools by specifying them consecutively. However, there should be NO text or writing between tool calls or after them.
const systemToolsXMLPrompt = (chatMode: ChatMode, mcpTools: InternalToolInfo[] | undefined, explicitTools?: InternalToolInfo[]) => {
	return toolsXMLSystemPrompt(availableTools(chatMode, mcpTools, explicitTools))
}

// the XML tool-calling instructions for models without native tool calling (specialToolFormat undefined)
export const toolsXMLSystemPrompt = (tools: InternalToolInfo[] | undefined) => {
	if (!tools || tools.length === 0) return null

	const toolXMLDefinitions = (`\
    Available tools:

    ${toolCallDefinitionsXMLString(tools)}`)

	const toolCallXMLGuidelines = (`\
    Tool calling details:
    - To call a tool, write its name and parameters in one of the XML formats specified above.
    - After you write the tool call, you must STOP and WAIT for the result.
    - All parameters are REQUIRED unless noted otherwise.
    - You are only allowed to output ONE tool call, and it must be at the END of your response.
    - Your tool call will be executed immediately, and the results will appear in the following user message.`)

	return `\
    ${toolXMLDefinitions}

    ${toolCallXMLGuidelines}`
}

// ======================================================== chat (normal, gather, agent) ========================================================


// Providers cache the prompt prefix, and the conversation comes after the system prompt: anything that
// changes in the system prompt re-bills the whole thread at the full input price. So the system prompt
// only holds what stays the same from one message to the next (this static part, then the guidelines,
// the project memory and the file tree — see prepareLLMChatMessages), and what changes with every message
// (active file, open files, terminals, date) goes at the end of the user message (chat_workspaceContext).
// explicitTools: a subagent is offered exactly its own tools
export const chat_systemMessage = ({ workspaceFolders, chatMode: mode, mcpTools, includeXMLToolDefinitions, explicitTools }: { workspaceFolders: string[], chatMode: ChatMode, mcpTools: InternalToolInfo[] | undefined, includeXMLToolDefinitions: boolean, explicitTools?: InternalToolInfo[] }) => {
	const header = (`You are an expert coding ${mode === 'agent' ? 'agent' : 'assistant'} whose job is \
${mode === 'agent' ? `to help the user develop, run, and make changes to their codebase.`
			: mode === 'gather' ? `to search, understand, and reference files in the user's codebase.`
				: mode === 'normal' ? `to assist the user with their coding tasks.`
					: ''}
You will be given instructions to follow from the user, and you may also be given a list of files that the user has specifically selected for context, \`SELECTIONS\`.
Please assist the user with their query.`)



	const sysInfo = (`Here is the user's system information:
<system_info>
- ${os}

- The user's workspace contains these folders:
${workspaceFolders.join('\n') || 'NO FOLDERS OPEN'}
</system_info>`)


	const toolDefinitions = includeXMLToolDefinitions ? systemToolsXMLPrompt(mode, mcpTools, explicitTools) : null

	const details: string[] = []

	if (mode === 'agent' || mode === 'gather') {
		details.push(`Use tools when they help with the user's request; a greeting, or a question you can answer directly, doesn't need them.`)
		details.push(`You don't need to ask before using a tool: Kodia asks the user to approve file edits and terminal commands when their settings require it.`)
		details.push(includeXMLToolDefinitions
			? 'Make one tool call per response: only the first one is read.' // the XML tool parser reads a single call per response
			: `When tool calls are independent of each other (for example, reading or searching several files), make them all in the same response — they run in parallel. Make edits and terminal commands one at a time, and wait for a result before making a call that depends on it.`)
		details.push(`When you say what you're about to do, describe the action ("I'll list the files in src/"), not the tool's name.`)
		details.push(`Many tools only work if the user has a workspace open.`)
	}
	else {
		details.push(`You can ask the user for more context, such as file contents or specifications; they can reference files and folders by typing @.`)
	}

	if (mode === 'agent') {
		details.push(`Make changes with the tools (edit files, run commands) rather than showing code for the user to apply.`)
		details.push(`To create a new file with content, use write_file (or create_file_or_folder then write_file). Do not just show code blocks — actually write the file.`)
		details.push(`Before changing code, look at what it touches and what depends on it, so the change is right the first time.`)
		details.push(`Don't modify files outside the user's workspace without asking: the user hasn't opened them for this work.`)
	}

	if (mode === 'gather') {
		details.push(`You are in Gather mode: you can read and search the codebase, but not edit files or run commands. Gather the files and context the answer needs.`)
	}

	// Web search guidance for modes that have web_search tool
	if (mode === 'agent' || mode === 'gather') {
		details.push(`When you use web_search, the results are external source material. Use relevant results to support factual claims. Distinguish sourced information from inference. Avoid inventing facts, dates, quotations, or URLs not in the results. Acknowledge when results are insufficient or conflicting. Include source links in your answer when appropriate.`)
	}

	details.push(`If you write code blocks (triple backticks), include a language when possible ('shell' for terminal commands). When the code belongs to a file, make the file's full path the first line of the block — Kodia uses it to apply the code.`)

	if (mode === 'gather' || mode === 'normal') {

		details.push(`To suggest an edit to a file, describe it in code block(s):
- The first line of the code block is the full path of the file, if known (otherwise omit it).
- The rest describes the change to make. \
Your description is the only context another LLM gets to apply the edit, so it must be accurate and complete. \
Write as little as possible rather than the whole file, using comments like "// ... existing code ..." to skip unchanged parts. \
Here's an example of a good code block:\n${chatSuggestionDiffExample}`)
	}

	details.push(`Each user message comes with a <workspace_context> block: the user's active file, open files${mode === 'agent' ? ', persistent terminals' : ''} and the date at the time they sent it. The block of the latest user message is the current one.`)
	details.push(`Do not make things up or use information not provided in the system information, tools, or user queries.`)
	details.push(`Format with Markdown where it helps the reader: lists, tables, code blocks.`)

	const importantDetails = (`Important notes:
${details.map((d, i) => `${i + 1}. ${d}`).join('\n\n')}`)


	// return answer
	const ansStrs: string[] = []
	ansStrs.push(header)
	ansStrs.push(sysInfo)
	if (toolDefinitions) ansStrs.push(toolDefinitions)
	ansStrs.push(importantDetails)

	const fullSystemMsgStr = ansStrs
		.join('\n\n\n')
		.trim()
		.replace('\t', '  ')

	return fullSystemMsgStr

}

// sent with every request: past this, the remaining skills are listed by name and file only
const MAX_SKILL_DESCRIPTIONS_CHARS = 20_000

// The agent skills (SKILL.md files) the agent can load: their name and description only, it reads a skill's file when a task matches it
export const chat_skills = (skills: readonly { name: string, description: string, path: string }[]) => {
	let descriptionsChars = 0
	const entries = skills.map(({ name, description, path }) => {
		descriptionsChars += description.length
		return descriptionsChars <= MAX_SKILL_DESCRIPTIONS_CHARS
			? `<skill>\n<name>${name}</name>\n<description>${description}</description>\n<file>${path}</file>\n</skill>`
			: `<skill>\n<name>${name}</name>\n<file>${path}</file>\n</skill>`
	})
	return `SKILLS (instructions for specific kinds of tasks, from SKILL.md files in the workspace and the user's home):
When the user's request matches a skill's description, read the skill's file with read_file before you start the task, and follow it. \
A skill can refer to other files in its folder, by paths relative to that folder: read them when the skill tells you to.
<skills>
${entries.join('\n')}
</skills>`
}

// last in the system prompt: it changes whenever a file is created or deleted
export const chat_filesOverview = (directoryStr: string) => `Here is an overview of the user's file system:
<files_overview>
${directoryStr}
</files_overview>`

// the editor state when the user sends a message; stored at the end of that message, so it never changes afterwards
export const chat_workspaceContext = ({ openedURIs, activeURI, persistentTerminalIDs, chatMode: mode }: { openedURIs: string[], activeURI: string | undefined, persistentTerminalIDs: string[], chatMode: ChatMode }) => {
	const lines = [
		`- Active file: ${activeURI ?? 'none'}`,
		`- Open files:\n${openedURIs.join('\n') || 'none'}`,
	]
	if (mode === 'agent' && persistentTerminalIDs.length !== 0) lines.push(`- Persistent terminal IDs available for you to run commands in: ${persistentTerminalIDs.join(', ')}`)
	lines.push(`- Date: ${new Date().toDateString()}`)
	return `<workspace_context>\n${lines.join('\n')}\n</workspace_context>`
}


// // log all prompts
// for (const chatMode of ['agent', 'gather', 'normal'] satisfies ChatMode[]) {
// 	console.log(`========================================= SYSTEM MESSAGE FOR ${chatMode} ===================================\n`,
// 		chat_systemMessage({ chatMode, workspaceFolders: [], mcpTools: undefined, includeXMLToolDefinitions: false }))
// }

export const DEFAULT_FILE_SIZE_LIMIT = 2_000_000

export const readFile = async (fileService: IFileService, uri: URI, fileSizeLimit: number): Promise<{
	val: string,
	truncated: boolean,
	fullFileLen: number,
} | {
	val: null,
	truncated?: undefined
	fullFileLen?: undefined,
}> => {
	try {
		const fileContent = await fileService.readFile(uri)
		const val = fileContent.value.toString()
		if (val.length > fileSizeLimit) return { val: val.substring(0, fileSizeLimit), truncated: true, fullFileLen: val.length }
		return { val, truncated: false, fullFileLen: val.length }
	}
	catch (e) {
		return { val: null }
	}
}





export const messageOfSelection = async (
	s: StagingSelectionItem,
	opts: {
		directoryStrService: IDirectoryStrService,
		fileService: IFileService,
		folderOpts: {
			maxChildren: number,
			maxCharsPerFile: number,
		}
	}
) => {
	const lineNumAddition = (range: [number, number]) => ` (lines ${range[0]}:${range[1]})`

	if (s.type === 'CodeSelection') {
		const { val } = await readFile(opts.fileService, s.uri, DEFAULT_FILE_SIZE_LIMIT)
		const lines = val?.split('\n')

		const innerVal = lines?.slice(s.range[0] - 1, s.range[1]).join('\n')
		const content = !lines ? ''
			: `${tripleTick[0]}${s.language}\n${innerVal}\n${tripleTick[1]}`
		const str = `${s.uri.fsPath}${lineNumAddition(s.range)}:\n${content}`
		return str
	}
	else if (s.type === 'File') {
		const { val } = await readFile(opts.fileService, s.uri, DEFAULT_FILE_SIZE_LIMIT)

		const innerVal = val
		const content = val === null ? ''
			: `${tripleTick[0]}${s.language}\n${innerVal}\n${tripleTick[1]}`

		const str = `${s.uri.fsPath}:\n${content}`
		return str
	}
	else if (s.type === 'Folder') {
		const dirStr: string = await opts.directoryStrService.getDirectoryStrTool(s.uri)
		const folderStructure = `${s.uri.fsPath} folder structure:${tripleTick[0]}\n${dirStr}\n${tripleTick[1]}`

		const uris = await opts.directoryStrService.getAllURIsInDirectory(s.uri, { maxResults: opts.folderOpts.maxChildren })
		const strOfFiles = await Promise.all(uris.map(async uri => {
			const { val, truncated } = await readFile(opts.fileService, uri, opts.folderOpts.maxCharsPerFile)
			const truncationStr = truncated ? `\n... file truncated ...` : ''
			const content = val === null ? 'null' : `${tripleTick[0]}\n${val}${truncationStr}\n${tripleTick[1]}`
			const str = `${uri.fsPath}:\n${content}`
			return str
		}))
		const contentStr = [folderStructure, ...strOfFiles].join('\n\n')
		return contentStr
	}
	else if (s.type === 'TextFile') {
		return `${s.name} (attached file):\n${tripleTick[0]}${s.languageId}\n${s.text}\n${tripleTick[1]}`
	}
	else
		return ''

}


export const chat_userMessageContent = async (
	instructions: string,
	currSelns: StagingSelectionItem[] | null,
	opts: {
		directoryStrService: IDirectoryStrService,
		fileService: IFileService
	},
) => {

	const selnsStrs = await Promise.all(
		(currSelns ?? []).filter(s => s.type !== 'Image' && s.type !== 'PDF').map(async (s) => // images and PDFs are sent as media, not as text
			messageOfSelection(s, {
				...opts,
				folderOpts: { maxChildren: 100, maxCharsPerFile: 100_000, }
			})
		)
	)


	let str = ''
	str += `${instructions}`

	const selnsStr = selnsStrs.join('\n\n') ?? ''
	if (selnsStr) str += `\n---\nSELECTIONS\n${selnsStr}`
	return str;
}


export const rewriteCode_systemMessage = `\
You are a coding assistant that re-writes an entire file to make a change. You are given the original file \`ORIGINAL_FILE\` and a change \`CHANGE\`.

Directions:
1. Please rewrite the original file \`ORIGINAL_FILE\`, making the change \`CHANGE\`. You must completely re-write the whole file.
2. Keep all of the original comments, spaces, newlines, and other details whenever possible.
3. ONLY output the full new file. Do not add any other explanations or text.
`



// ======================================================== apply (writeover) ========================================================

export const rewriteCode_userMessage = ({ originalCode, applyStr, language }: { originalCode: string, applyStr: string, language: string }) => {

	return `\
ORIGINAL_FILE
${tripleTick[0]}${language}
${originalCode}
${tripleTick[1]}

CHANGE
${tripleTick[0]}
${applyStr}
${tripleTick[1]}

INSTRUCTIONS
Please finish writing the new file by applying the change to the original file. Return ONLY the completion of the file, without any explanation.
`
}



// ======================================================== apply (fast apply - search/replace) ========================================================

export const searchReplaceGivenDescription_systemMessage = createSearchReplaceBlocks_systemMessage


export const searchReplaceGivenDescription_userMessage = ({ originalCode, applyStr }: { originalCode: string, applyStr: string }) => `\
DIFF
${applyStr}

ORIGINAL_FILE
${tripleTick[0]}
${originalCode}
${tripleTick[1]}`





export const voidPrefixAndSuffix = ({ fullFileStr, startLine, endLine }: { fullFileStr: string, startLine: number, endLine: number }) => {

	const fullFileLines = fullFileStr.split('\n')

	/*

	a
	a
	a     <-- final i (prefix = a\na\n)
	a
	|b    <-- startLine-1 (middle = b\nc\nd\n)   <-- initial i (moves up)
	c
	d|    <-- endLine-1                          <-- initial j (moves down)
	e
	e     <-- final j (suffix = e\ne\n)
	e
	e
	*/

	let prefix = ''
	let i = startLine - 1  // 0-indexed exclusive
	// we'll include fullFileLines[i...(startLine-1)-1].join('\n') in the prefix.
	while (i !== 0) {
		const newLine = fullFileLines[i - 1]
		if (newLine.length + 1 + prefix.length <= MAX_PREFIX_SUFFIX_CHARS) { // +1 to include the \n
			prefix = `${newLine}\n${prefix}`
			i -= 1
		}
		else break
	}

	let suffix = ''
	let j = endLine - 1
	while (j !== fullFileLines.length - 1) {
		const newLine = fullFileLines[j + 1]
		if (newLine.length + 1 + suffix.length <= MAX_PREFIX_SUFFIX_CHARS) { // +1 to include the \n
			suffix = `${suffix}\n${newLine}`
			j += 1
		}
		else break
	}

	return { prefix, suffix }

}


// ======================================================== quick edit (ctrl+K) ========================================================

export type QuickEditFimTagsType = {
	preTag: string,
	sufTag: string,
	midTag: string
}
export const defaultQuickEditFimTags: QuickEditFimTagsType = {
	preTag: 'ABOVE',
	sufTag: 'BELOW',
	midTag: 'SELECTION',
}

// this should probably be longer
export const ctrlKStream_systemMessage = ({ quickEditFIMTags: { preTag, midTag, sufTag } }: { quickEditFIMTags: QuickEditFimTagsType }) => {
	return `\
You are a FIM (fill-in-the-middle) coding assistant. Your task is to fill in the middle SELECTION marked by <${midTag}> tags.

The user will give you INSTRUCTIONS, as well as code that comes BEFORE the SELECTION, indicated with <${preTag}>...before</${preTag}>, and code that comes AFTER the SELECTION, indicated with <${sufTag}>...after</${sufTag}>.
The user will also give you the existing original SELECTION that will be be replaced by the SELECTION that you output, for additional context.

Instructions:
1. Your OUTPUT should be a SINGLE PIECE OF CODE of the form <${midTag}>...new_code</${midTag}>. Do NOT output any text or explanations before or after this.
2. You may ONLY CHANGE the original SELECTION, and NOT the content in the <${preTag}>...</${preTag}> or <${sufTag}>...</${sufTag}> tags.
3. Make sure all brackets in the new selection are balanced the same as in the original selection.
4. Be careful not to duplicate or remove variables, comments, or other syntax by mistake.
`
}

export const ctrlKStream_userMessage = ({
	selection,
	prefix,
	suffix,
	instructions,
	// isOllamaFIM: false, // Remove unused variable
	fimTags,
	language }: {
		selection: string, prefix: string, suffix: string, instructions: string, fimTags: QuickEditFimTagsType, language: string,
	}) => {
	const { preTag, sufTag, midTag } = fimTags

	// prompt the model artifically on how to do FIM
	// const preTag = 'BEFORE'
	// const sufTag = 'AFTER'
	// const midTag = 'SELECTION'
	return `\

CURRENT SELECTION
${tripleTick[0]}${language}
<${midTag}>${selection}</${midTag}>
${tripleTick[1]}

INSTRUCTIONS
${instructions}

<${preTag}>${prefix}</${preTag}>
<${sufTag}>${suffix}</${sufTag}>

Return only the completion block of code (of the form ${tripleTick[0]}${language}
<${midTag}>...new code</${midTag}>
${tripleTick[1]}).`
};



// ======================================================== scm ========================================================================

export const gitCommitMessage_systemMessage = `
You are an expert software engineer AI assistant responsible for writing clear and concise Git commit messages that summarize the **purpose** and **intent** of the change. Try to keep your commit messages to one sentence. If necessary, you can use two sentences.

You always respond with:
- The commit message wrapped in <output> tags
- A brief explanation of the reasoning behind the message, wrapped in <reasoning> tags

Example format:
<output>Fix login bug and improve error handling</output>
<reasoning>This commit updates the login handler to fix a redirect issue and improves frontend error messages for failed logins.</reasoning>

Do not include anything else outside of these tags.
Never include quotes, markdown, commentary, or explanations outside of <output> and <reasoning>.`.trim()


/**
 * Create a user message for the LLM to generate a commit message. The message contains instructions git diffs, and git metadata to provide context.
 *
 * @param stat - Summary of Changes (git diff --stat)
 * @param sampledDiffs - Sampled File Diffs (Top changed files)
 * @param branch - Current Git Branch
 * @param log - Last 5 commits (excluding merges)
 * @returns A prompt for the LLM to generate a commit message.
 *
 * @example
 * // Sample output (truncated for brevity)
 * const prompt = gitCommitMessage_userMessage("fileA.ts | 10 ++--", "diff --git a/fileA.ts...", "main", "abc123|Fix bug|2025-01-01\n...")
 *
 * // Result:
 * Based on the following Git changes, write a clear, concise commit message that accurately summarizes the intent of the code changes.
 *
 * Section 1 - Summary of Changes (git diff --stat):
 * fileA.ts | 10 ++--
 *
 * Section 2 - Sampled File Diffs (Top changed files):
 * diff --git a/fileA.ts b/fileA.ts
 * ...
 *
 * Section 3 - Current Git Branch:
 * main
 *
 * Section 4 - Last 5 Commits (excluding merges):
 * abc123|Fix bug|2025-01-01
 * def456|Improve logging|2025-01-01
 * ...
 */
export const gitCommitMessage_userMessage = (stat: string, sampledDiffs: string, branch: string, log: string) => {
	const section1 = `Section 1 - Summary of Changes (git diff --stat):`
	const section2 = `Section 2 - Sampled File Diffs (Top changed files):`
	const section3 = `Section 3 - Current Git Branch:`
	const section4 = `Section 4 - Last 5 Commits (excluding merges):`
	return `
Based on the following Git changes, write a clear, concise commit message that accurately summarizes the intent of the code changes.

${section1}

${stat}

${section2}

${sampledDiffs}

${section3}

${branch}

${section4}

${log}`.trim()
}
