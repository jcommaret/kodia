/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import * as path from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { rgDiskPath } from '../../../../base/node/ripgrep.js';
import { MAX_PROJECT_MEMORY_TOKENS, memoryTooLongMessage, memoryWithSection, PROJECT_MEMORY_FILE_HEADER, PROJECT_MEMORY_FILE_PATH } from '../../../kodia/common/projectMemory.js';
import { fetchWebPage } from '../../../kodia/node/webFetch.js';
import type { IByokLmFunctionTool } from '../../common/agentHostByokLm.js';

const execAsync = promisify(cp.exec);
const execFileAsync = promisify(cp.execFile);

/** Context passed to a local tool executor for one tool call. */
export interface IKodiaToolContext {
	readonly workingDirectory: URI | undefined;
	readonly signal: AbortSignal;
}

export interface IKodiaToolResult {
	readonly success: boolean;
	/** Text fed back to the model as the tool call's output. */
	readonly output: string;
	/** True when the tool wrote to the filesystem (drives edit tracking later). */
	readonly didWrite?: boolean;
	/** Absolute path the tool acted on, when applicable. */
	readonly path?: string;
}

/**
 * The local toolset the Kodia agent offers its models, in the bridge's wire
 * shape, OpenAI-JSON-Schema shaped. They mirror the tools of Kodia's chat
 * where the agent host can run them: no editor services here, so no symbol
 * navigation or lint errors.
 */
export const KODIA_TOOLS: IByokLmFunctionTool[] = [
	{
		type: 'function',
		name: 'read_file',
		description: 'Read a file (path relative to the workspace root, or absolute). A large file comes in parts: pass start_line and end_line to read a range of lines.',
		parametersSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path to read.' },
				start_line: { type: 'integer', description: 'First line to read, from 1. Defaults to the first line.' },
				end_line: { type: 'integer', description: 'Last line to read, included. Defaults to the last line.' },
			},
			required: ['path'],
			additionalProperties: false,
		},
	},
	{
		type: 'function',
		name: 'edit_file',
		description: 'Change part of a file: replace old_string with new_string. old_string must match the file exactly, whitespace included, and occur once: include enough surrounding lines to make it unique, or set replace_all to replace every occurrence. Prefer this to write_file for changing an existing file.',
		parametersSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path to edit.' },
				old_string: { type: 'string', description: 'The exact text to replace.' },
				new_string: { type: 'string', description: 'The text to put in its place; empty deletes old_string.' },
				replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string. Defaults to false.' },
			},
			required: ['path', 'old_string', 'new_string'],
			additionalProperties: false,
		},
	},
	{
		type: 'function',
		name: 'write_file',
		description: 'Create a file, or overwrite one with the given contents. Creates parent directories as needed. To change part of an existing file, use edit_file.',
		parametersSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path to write.' },
				content: { type: 'string', description: 'Full file contents.' },
			},
			required: ['path', 'content'],
			additionalProperties: false,
		},
	},
	{
		type: 'function',
		name: 'list_dir',
		description: 'List the entries of a directory. Directories are suffixed with "/".',
		parametersSchema: {
			type: 'object',
			properties: { path: { type: 'string', description: 'Directory path. Defaults to the workspace root.' } },
			required: [],
			additionalProperties: false,
		},
	},
	{
		type: 'function',
		name: 'find_files',
		description: 'Find files whose path matches a glob pattern, such as "*.ts", "package.json" or "src/**/test/*.js". Skips files that .gitignore ignores.',
		parametersSchema: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'Glob pattern. One without "/" matches file names at any depth.' },
				path: { type: 'string', description: 'Directory to search in. Defaults to the workspace root.' },
			},
			required: ['pattern'],
			additionalProperties: false,
		},
	},
	{
		type: 'function',
		name: 'search_files',
		description: 'Search the contents of files, like grep. Returns "path:line:text" for each matching line, and skips files that .gitignore ignores.',
		parametersSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'The text to search for.' },
				is_regex: { type: 'boolean', description: 'Read query as a regular expression (Rust syntax). Defaults to false: the exact text.' },
				path: { type: 'string', description: 'File or directory to search in. Defaults to the workspace root.' },
				include: { type: 'string', description: 'Only search files matching this glob, such as "*.ts".' },
			},
			required: ['query'],
			additionalProperties: false,
		},
	},
	{
		type: 'function',
		name: 'run_bash',
		description: 'Run a shell command in the workspace root and return its combined stdout/stderr.',
		parametersSchema: {
			type: 'object',
			properties: { command: { type: 'string', description: 'The shell command to run.' } },
			required: ['command'],
			additionalProperties: false,
		},
	},
	{
		type: 'function',
		name: 'fetch_url',
		description: 'Fetch a web page (http or https) and return its text: HTML is converted to text. A long page comes in parts: pass page to read the next one.',
		parametersSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'The page\'s URL.' },
				page: { type: 'integer', description: 'Which part of a long page to read, from 1. Defaults to 1.' },
			},
			required: ['url'],
			additionalProperties: false,
		},
	},
	{
		type: 'function',
		name: 'read_project_memory',
		description: `Read the project memory (${PROJECT_MEMORY_FILE_PATH} in the project): the notes kept about this project across sessions, in "## " sections. Read it at the start of a task.`,
		parametersSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
	},
	{
		type: 'function',
		name: 'write_project_memory',
		description: `Save durable notes about this project for future sessions, in the project memory (${PROJECT_MEMORY_FILE_PATH}). This rewrites one whole "## " section, so merge what is already there into the new content. Save what is worth knowing in every session: architecture, conventions, commands, decisions and their reasons, pitfalls. Keep it short and current: replace outdated notes, and delete a section with empty content. Never save secrets or credentials. The whole memory is capped at ~${MAX_PROJECT_MEMORY_TOKENS} tokens; a write that would exceed it is refused.`,
		parametersSchema: {
			type: 'object',
			properties: {
				section: { type: 'string', description: 'The section title, such as "Architecture", "Conventions", "Commands" or "Pitfalls". Reuse an existing title to rewrite that section.' },
				content: { type: 'string', description: 'The full new text of the section (markdown, no "## " heading). Empty to delete the section.' },
			},
			required: ['section', 'content'],
			additionalProperties: false,
		},
	},
];

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
	read_file: 'Read File',
	edit_file: 'Edit File',
	write_file: 'Write File',
	list_dir: 'List Directory',
	find_files: 'Find Files',
	search_files: 'Search Files',
	run_bash: 'Run Command',
	fetch_url: 'Fetch Web Page',
	read_project_memory: 'Read Project Memory',
	write_project_memory: 'Save Project Memory',
};

export function toolDisplayName(name: string): string {
	return DISPLAY_NAMES[name] ?? name;
}

/**
 * Tools that change the workspace, run commands or reach the web: they go
 * through the host's approval flow, as in Kodia's chat. A fetched URL can
 * carry data out of the workspace, so the user sees it first.
 */
export function needsApproval(name: string): boolean {
	return name === 'write_file' || name === 'edit_file' || name === 'run_bash' || name === 'write_project_memory' || name === 'fetch_url';
}

function toolRoot(workingDirectory: URI | undefined): string {
	return workingDirectory?.fsPath ?? process.cwd();
}

function resolveToolPath(p: unknown, root: string): string {
	const s = typeof p === 'string' ? p : '';
	return path.isAbsolute(s) ? s : path.join(root, s);
}

// Kodia's window offers every tool parameter to the model as a string, whatever the schema above says: a line number
// reaches these tools as "2" and a flag as "true". Both forms are read.
function toPositiveInt(n: unknown): number | undefined {
	const value = typeof n === 'string' && /^\s*\d+\s*$/.test(n) ? Number(n) : n;
	return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function toBool(b: unknown): boolean {
	return b === true || (typeof b === 'string' && b.trim().toLowerCase() === 'true');
}

/** What the host shows, and checks against its approval rules, before a tool call runs. */
export interface IKodiaToolCallDescription {
	readonly invocationMessage: string;
	/** The bare command for `run_bash` and the URL for `fetch_url`, so the host's rules apply to them; the JSON arguments otherwise. */
	readonly toolInput: string;
	/** Absolute path a file tool acts on. */
	readonly path?: string;
}

export function describeKodiaToolCall(name: string, argsJson: string, workingDirectory: URI | undefined): IKodiaToolCallDescription {
	let args: Record<string, unknown> = {};
	try {
		args = argsJson ? JSON.parse(argsJson) : {};
	} catch {
		// Described as-is; executeKodiaTool reports the invalid arguments.
	}
	const root = toolRoot(workingDirectory);
	const shown = (target: string) => path.relative(root, target) || '.';
	const inFolder = typeof args.path === 'string' && args.path ? ` in ${shown(resolveToolPath(args.path, root))}` : '';
	switch (name) {
		case 'run_bash': {
			const command = typeof args.command === 'string' ? args.command : '';
			return { invocationMessage: command || toolDisplayName(name), toolInput: command || argsJson };
		}
		case 'fetch_url': {
			const url = typeof args.url === 'string' ? args.url : '';
			return { invocationMessage: url ? `Fetch ${url}` : toolDisplayName(name), toolInput: url || argsJson };
		}
		case 'read_file': {
			const target = resolveToolPath(args.path, root);
			const start = toPositiveInt(args.start_line);
			const end = toPositiveInt(args.end_line);
			const lines = start || end ? `, lines ${start ?? 1}-${end ?? 'end'}` : '';
			return { invocationMessage: `Read ${shown(target)}${lines}`, toolInput: argsJson, path: target };
		}
		case 'edit_file':
		case 'write_file':
		case 'list_dir': {
			const target = resolveToolPath(args.path ?? (name === 'list_dir' ? '.' : ''), root);
			const verb = name === 'edit_file' ? 'Edit' : name === 'write_file' ? 'Write' : 'List';
			return { invocationMessage: `${verb} ${shown(target)}`, toolInput: argsJson, path: target };
		}
		case 'find_files':
			return { invocationMessage: `Find ${typeof args.pattern === 'string' ? args.pattern : 'files'}${inFolder}`, toolInput: argsJson };
		case 'search_files':
			return { invocationMessage: `Search for "${typeof args.query === 'string' ? args.query : ''}"${inFolder}`, toolInput: argsJson };
		case 'read_project_memory':
		case 'write_project_memory': {
			const target = path.join(root, PROJECT_MEMORY_FILE_PATH);
			const section = typeof args.section === 'string' && args.section ? `: ${args.section}` : '';
			return { invocationMessage: name === 'read_project_memory' ? 'Read project memory' : `Save project memory${section}`, toolInput: argsJson, path: target };
		}
		default:
			return { invocationMessage: toolDisplayName(name), toolInput: argsJson };
	}
}

const MAX_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
// as in Kodia's chat: ~25k tokens, and each result stays in the history
const MAX_READ_CHARS = 100_000;
const MAX_SEARCH_LINES = 200;
const MAX_FOUND_FILES = 500;

// The lines start_line..end_line of a file, cut to MAX_READ_CHARS: what the model reads, and where to go on from.
function readLines(content: string, startLine: number | undefined, endLine: number | undefined): string {
	const lines = content.split('\n');
	const start = Math.min(startLine ?? 1, lines.length);
	const end = Math.max(start, Math.min(endLine ?? lines.length, lines.length));
	if (start === 1 && end === lines.length && content.length <= MAX_READ_CHARS) {
		return content;
	}
	let shownEnd = start - 1;
	let size = 0;
	while (shownEnd < end && (shownEnd === start - 1 || size + lines[shownEnd].length + 1 <= MAX_READ_CHARS)) {
		size += lines[shownEnd].length + 1;
		shownEnd++;
	}
	let text = lines.slice(start - 1, shownEnd).join('\n');
	// a single line longer than the limit, as in a minified file
	const cutLine = text.length > MAX_READ_CHARS ? ` Line ${start} is cut at ${MAX_READ_CHARS} characters.` : '';
	text = text.slice(0, MAX_READ_CHARS);
	const next = shownEnd < end ? ` The file is cut here: read on with start_line ${shownEnd + 1}.` : '';
	return `Lines ${start}-${shownEnd} of ${lines.length}.${cutLine}${next}\n${text}`;
}

// The file with old_string replaced. With CRLF line endings, a model's "\n" in old_string and new_string means "\r\n".
function editedContent(content: string, oldString: string, newString: string, replaceAll: boolean, target: string): { content: string, count: number } | string {
	let [from, to] = [oldString, newString];
	if (!content.includes(from) && content.includes('\r\n')) {
		[from, to] = [from.replace(/\r?\n/g, '\r\n'), to.replace(/\r?\n/g, '\r\n')];
	}
	const count = content.split(from).length - 1;
	if (count === 0) {
		return `"old_string" isn't in ${target}. Read the file again and copy the text exactly, whitespace included.`;
	}
	if (count > 1 && !replaceAll) {
		return `"old_string" occurs ${count} times in ${target}: include more surrounding lines to make it unique, or set replace_all.`;
	}
	return replaceAll
		? { content: content.split(from).join(to), count }
		: { content: content.replace(from, () => to), count: 1 };
}

// ripgrep's output, cut to `maxLines`. It exits with 1 when nothing matches, and with 2 when a file couldn't be read,
// even if others matched: those results are kept.
async function runRipgrep(args: string[], root: string, signal: AbortSignal, maxLines: number, noun: string): Promise<IKodiaToolResult> {
	const resultOf = (stdout: string, note = '') => {
		// searching "." prints "./src/a.ts": the model gets "src/a.ts", as from list_dir
		const lines = stdout.split('\n').filter(line => !!line).map(line => line.replace(/^\.[\\/]/, ''));
		const more = lines.length > maxLines ? `\n(${lines.length - maxLines} more ${noun} not shown: narrow the search.)` : '';
		return { success: true, output: lines.slice(0, maxLines).join('\n') + more + note };
	};
	try {
		const { stdout } = await execFileAsync(await rgDiskPath(), args, { cwd: root, signal, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * MAX_OUTPUT_BYTES });
		return resultOf(stdout);
	} catch (err) {
		const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
		if (e.code === 1) {
			return { success: true, output: `No ${noun}.` };
		}
		if (e.code === 2 && e.stdout?.trim()) {
			return resultOf(e.stdout, `\n(Some files couldn't be searched: ${e.stderr?.trim().split('\n')[0] ?? 'unknown error'})`);
		}
		return { success: false, output: (e.stderr || e.message || String(err)).trim() };
	}
}

// ripgrep's path argument, always given: without one, ripgrep reads its standard input, which isn't a terminal here
function searchPathArgs(p: unknown, root: string): string[] {
	const target = resolveToolPath(typeof p === 'string' && p ? p : '.', root);
	return [path.relative(root, target) || '.'];
}

// hidden files (.github/…) are searched too, the .git folder isn't
const RIPGREP_HIDDEN_ARGS = ['--hidden', '--glob', '!.git'];

/** Execute a client tool locally and return text to feed back to the model. */
export async function executeKodiaTool(name: string, argsJson: string, ctx: IKodiaToolContext): Promise<IKodiaToolResult> {
	let args: Record<string, unknown>;
	try {
		args = argsJson ? JSON.parse(argsJson) : {};
	} catch {
		return { success: false, output: `Invalid JSON arguments for tool "${name}".` };
	}

	const root = toolRoot(ctx.workingDirectory);
	const resolve = (p: unknown): string => resolveToolPath(p, root);

	try {
		switch (name) {
			case 'read_file': {
				const target = resolve(args.path);
				const content = await fs.promises.readFile(target, 'utf8');
				return { success: true, output: readLines(content, toPositiveInt(args.start_line), toPositiveInt(args.end_line)), path: target };
			}
			case 'edit_file': {
				const target = resolve(args.path);
				const oldString = typeof args.old_string === 'string' ? args.old_string : '';
				if (!oldString) {
					return { success: false, output: 'Missing "old_string". To create a file or replace all of it, use write_file.' };
				}
				const content = await fs.promises.readFile(target, 'utf8');
				const edited = editedContent(content, oldString, typeof args.new_string === 'string' ? args.new_string : '', toBool(args.replace_all), target);
				if (typeof edited === 'string') {
					return { success: false, output: edited, path: target };
				}
				await fs.promises.writeFile(target, edited.content, 'utf8');
				return { success: true, output: `Edited ${target}: ${edited.count} replacement${edited.count === 1 ? '' : 's'}.`, didWrite: true, path: target };
			}
			case 'write_file': {
				const target = resolve(args.path);
				await fs.promises.mkdir(path.dirname(target), { recursive: true });
				await fs.promises.writeFile(target, typeof args.content === 'string' ? args.content : '', 'utf8');
				return { success: true, output: `Wrote ${target}`, didWrite: true, path: target };
			}
			case 'list_dir': {
				const target = resolve(args.path ?? '.');
				const entries = await fs.promises.readdir(target, { withFileTypes: true });
				const listing = entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).sort().join('\n');
				return { success: true, output: listing || '(empty)', path: target };
			}
			case 'find_files': {
				const pattern = typeof args.pattern === 'string' ? args.pattern : '';
				if (!pattern) {
					return { success: false, output: 'Missing "pattern".' };
				}
				return runRipgrep(['--files', '--sort', 'path', ...RIPGREP_HIDDEN_ARGS, '--glob', pattern, ...searchPathArgs(args.path, root)], root, ctx.signal, MAX_FOUND_FILES, 'files found');
			}
			case 'search_files': {
				const query = typeof args.query === 'string' ? args.query : '';
				if (!query) {
					return { success: false, output: 'Missing "query".' };
				}
				const include = typeof args.include === 'string' && args.include ? ['--glob', args.include] : [];
				return runRipgrep([
					'--line-number', '--no-heading', '--color', 'never', '--max-columns', '300', '--max-columns-preview',
					...(toBool(args.is_regex) ? [] : ['--fixed-strings']), ...RIPGREP_HIDDEN_ARGS, ...include,
					'--regexp', query, ...searchPathArgs(args.path, root),
				], root, ctx.signal, MAX_SEARCH_LINES, 'matches');
			}
			case 'run_bash': {
				const command = typeof args.command === 'string' ? args.command : '';
				if (!command) {
					return { success: false, output: 'Missing "command".' };
				}
				const { stdout, stderr } = await execAsync(command, { cwd: root, signal: ctx.signal, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES });
				const out = `${stdout ?? ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim();
				return { success: true, output: out || '(no output)' };
			}
			case 'fetch_url': {
				const page = await fetchWebPage(typeof args.url === 'string' ? args.url : '', ctx.signal);
				const pageCount = Math.max(1, Math.ceil(page.text.length / MAX_READ_CHARS));
				const pageNumber = Math.min(toPositiveInt(args.page) ?? 1, pageCount);
				const text = page.text.slice(MAX_READ_CHARS * (pageNumber - 1), MAX_READ_CHARS * pageNumber);
				const parts = pageCount > 1 ? ` (part ${pageNumber} of ${pageCount}${pageNumber < pageCount ? `: read on with page ${pageNumber + 1}` : ''})` : '';
				return { success: true, output: `${page.title ? `${page.title}\n` : ''}${page.url}${parts}\n\n${text || '(empty page)'}` };
			}
			case 'read_project_memory': {
				const target = path.join(root, PROJECT_MEMORY_FILE_PATH);
				const memory = await fs.promises.readFile(target, 'utf8').catch((e: NodeJS.ErrnoException) => e.code === 'ENOENT' ? '' : Promise.reject(e));
				return { success: true, output: memory.trim() || 'This project has no memory yet.', path: target };
			}
			case 'write_project_memory': {
				const section = typeof args.section === 'string' ? args.section.trim() : '';
				if (!section) {
					return { success: false, output: 'Missing "section".' };
				}
				const target = path.join(root, PROJECT_MEMORY_FILE_PATH);
				const current = await fs.promises.readFile(target, 'utf8').catch((e: NodeJS.ErrnoException) => e.code === 'ENOENT' ? PROJECT_MEMORY_FILE_HEADER : Promise.reject(e));
				const memory = memoryWithSection(current, section, typeof args.content === 'string' ? args.content : '');
				// the agent host has no tokenizer: about 4 characters a token
				const tokenCount = Math.ceil(memory.length / 4);
				if (tokenCount > MAX_PROJECT_MEMORY_TOKENS) {
					return { success: false, output: memoryTooLongMessage(tokenCount), path: target };
				}
				await fs.promises.mkdir(path.dirname(target), { recursive: true });
				await fs.promises.writeFile(target, memory, 'utf8');
				return { success: true, output: `Saved the "${section}" section of the project memory (~${tokenCount} of ~${MAX_PROJECT_MEMORY_TOKENS} tokens).`, didWrite: true, path: target };
			}
			default:
				return { success: false, output: `Unknown tool: ${name}` };
		}
	} catch (err) {
		// `child_process.exec` rejects with stdout/stderr attached for non-zero exits.
		const e = err as { stdout?: string; stderr?: string; message?: string };
		const detail = (e.stdout || e.stderr) ? `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() : (e.message ?? String(err));
		return { success: false, output: detail };
	}
}
