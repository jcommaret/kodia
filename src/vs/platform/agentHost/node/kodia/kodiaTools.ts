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
import { applySearchReplaceBlocks } from '../../../kodia/common/searchReplaceBlocks.js';
import { EditorToolName, editorTools, isEditorToolName, jsonSchemaOfSharedTool, nextPageNote, SharedTool, SharedToolApproval, SharedToolName, sharedToolNames, sharedTools } from '../../../kodia/common/toolCatalog.js';
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
 * The local toolset the Kodia agent offers its models, in the bridge's wire shape: the tools of Kodia's chat that
 * don't need the editor, with the chat's names, parameters and descriptions (see `toolCatalog.ts`), so a skill, a rule
 * or a model's habit means the same in both. Not here: the language server's tools (go_to_definition, find_references,
 * search_symbols, read_lint_errors), which need an editor window: see {@link editorFunctionTools}. Nor persistent
 * terminals. The project memory is in the agent's instructions, as in the chat, so there is no read_project_memory.
 */
export const KODIA_TOOLS: IByokLmFunctionTool[] = sharedToolNames.map(name => ({
	type: 'function',
	name,
	description: sharedTools[name].description,
	parametersSchema: jsonSchemaOfSharedTool(sharedTools[name]),
}));

/**
 * The editor tools, as the bridge's wire shape, for the names an editor window says it can run (see
 * `listEditorTools`): the chat's names, parameters and descriptions, like {@link KODIA_TOOLS}.
 */
export function editorFunctionTools(names: readonly string[]): IByokLmFunctionTool[] {
	return names.filter(isEditorToolName).map(name => ({
		type: 'function',
		name,
		description: editorTools[name].description,
		parametersSchema: jsonSchemaOfSharedTool(editorTools[name]),
	}));
}

const DISPLAY_NAMES: Readonly<Record<SharedToolName | EditorToolName, string>> = {
	read_file: 'Read File',
	ls_dir: 'List Directory',
	get_dir_tree: 'Directory Tree',
	search_pathnames_only: 'Find Files by Name',
	search_for_files: 'Search Files',
	search_in_file: 'Search in File',
	create_file_or_folder: 'Create File or Folder',
	delete_file_or_folder: 'Delete File or Folder',
	edit_file: 'Edit File',
	rewrite_file: 'Rewrite File',
	run_command: 'Run Command',
	fetch_url: 'Fetch Web Page',
	write_project_memory: 'Save Project Memory',
	go_to_definition: 'Go to Definition',
	find_references: 'Find References',
	search_symbols: 'Search Symbols',
	read_lint_errors: 'Read Lint Errors',
};

function isSharedToolName(name: string): name is SharedToolName {
	return Object.hasOwn(sharedTools, name);
}

export function toolDisplayName(name: string): string {
	return isSharedToolName(name) || isEditorToolName(name) ? DISPLAY_NAMES[name] : name;
}

/**
 * The kind of approval a call needs, in Kodia's settings' words (`edits`, `terminal`, `web pages`), or none for a tool
 * that only reads. A fetched URL can carry data out of the workspace, so the user sees it first, as in the chat.
 */
export function approvalOfTool(name: string): SharedToolApproval | undefined {
	if (!isSharedToolName(name)) {
		return undefined;
	}
	const tool: SharedTool = sharedTools[name];
	return tool.approval;
}

/** Tools that change the workspace, run commands or reach the web: they go through the host's approval flow. */
export function needsApproval(name: string): boolean {
	return approvalOfTool(name) !== undefined;
}

function toolRoot(workingDirectory: URI | undefined): string {
	return workingDirectory?.fsPath ?? process.cwd();
}

// A path, relative to the project or absolute, or a file: URI, as the chat's tools take
function resolveToolPath(p: unknown, root: string): string {
	const s = typeof p === 'string' ? p.trim() : '';
	if (s.startsWith('file://')) {
		try {
			return URI.parse(s).fsPath;
		} catch {
			// not a URI after all: a path
		}
	}
	return path.isAbsolute(s) ? s : path.join(root, s);
}

// Kodia's window offers every tool parameter to the model as a string, whatever the schema says: a line number reaches
// these tools as "2" and a flag as "true". Both forms are read.
function toPositiveInt(n: unknown): number | undefined {
	const value = typeof n === 'string' && /^\s*\d+\s*$/.test(n) ? Number(n) : n;
	return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function toBool(b: unknown): boolean {
	return b === true || (typeof b === 'string' && b.trim().toLowerCase() === 'true');
}

function toStr(s: unknown): string {
	return typeof s === 'string' ? s : '';
}

/** What the host shows, and checks against its approval rules, before a tool call runs. */
export interface IKodiaToolCallDescription {
	readonly invocationMessage: string;
	/** The bare command for `run_command` and the URL for `fetch_url`, so the host's rules apply to them; the JSON arguments otherwise. */
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
	switch (name) {
		case 'run_command': {
			const command = toStr(args.command);
			return { invocationMessage: command || toolDisplayName(name), toolInput: command || argsJson };
		}
		case 'fetch_url': {
			const url = toStr(args.url);
			return { invocationMessage: url ? `Fetch ${url}` : toolDisplayName(name), toolInput: url || argsJson };
		}
		case 'write_project_memory': {
			const section = toStr(args.section) ? `: ${toStr(args.section)}` : '';
			return { invocationMessage: `Save project memory${section}`, toolInput: argsJson, path: path.join(root, PROJECT_MEMORY_FILE_PATH) };
		}
		case 'search_pathnames_only':
			return { invocationMessage: `Find files named "${toStr(args.query)}"`, toolInput: argsJson };
		case 'search_for_files': {
			const inFolder = toStr(args.search_in_folder) ? ` in ${shown(resolveToolPath(args.search_in_folder, root))}` : '';
			return { invocationMessage: `Search for "${toStr(args.query)}"${inFolder}`, toolInput: argsJson };
		}
		case 'read_file':
		case 'ls_dir':
		case 'get_dir_tree':
		case 'search_in_file':
		case 'create_file_or_folder':
		case 'delete_file_or_folder':
		case 'edit_file':
		case 'rewrite_file': {
			const target = resolveToolPath(args.uri, root);
			const start = toPositiveInt(args.start_line);
			const end = toPositiveInt(args.end_line);
			const lines = name === 'read_file' && (start || end) ? `, lines ${start ?? 1}-${end ?? 'end'}` : '';
			const verb = { read_file: 'Read', ls_dir: 'List', get_dir_tree: 'Show the tree of', search_in_file: 'Search in', create_file_or_folder: 'Create', delete_file_or_folder: 'Delete', edit_file: 'Edit', rewrite_file: 'Rewrite' }[name];
			return { invocationMessage: `${verb} ${shown(target)}${lines}`, toolInput: argsJson, path: target };
		}
		case 'go_to_definition':
		case 'find_references': {
			const verb = name === 'go_to_definition' ? 'Find the definition of' : 'Find the references to';
			const line = toPositiveInt(args.line);
			return { invocationMessage: `${verb} "${toStr(args.symbol)}" in ${shown(resolveToolPath(args.uri, root))}${line ? `:${line}` : ''}`, toolInput: argsJson };
		}
		case 'search_symbols':
			return { invocationMessage: `Search the symbols for "${toStr(args.query)}"`, toolInput: argsJson };
		case 'read_lint_errors':
			return { invocationMessage: `Read the lint errors of ${shown(resolveToolPath(args.uri, root))}`, toolInput: argsJson };
		default:
			return { invocationMessage: toolDisplayName(name), toolInput: argsJson };
	}
}

/**
 * The arguments of an editor tool call with its path made absolute. The editor window that runs the tool has no idea
 * of the agent's working directory, and the model gives a path relative to it as readily as an absolute one. Arguments
 * that are not a JSON object are left as they are: the window says they are invalid.
 */
export function editorToolArguments(argsJson: string, workingDirectory: URI | undefined): string {
	let args: unknown;
	try {
		args = argsJson ? JSON.parse(argsJson) : {};
	} catch {
		return argsJson;
	}
	if (!args || typeof args !== 'object' || Array.isArray(args)) {
		return argsJson;
	}
	const record = args as Record<string, unknown>;
	return typeof record.uri === 'string' && record.uri.trim() ? JSON.stringify({ ...record, uri: resolveToolPath(record.uri, toolRoot(workingDirectory)) }) : argsJson;
}

const MAX_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
// as in Kodia's chat: ~25k tokens a page of a file or a web page, and each result stays in the history
const MAX_PAGE_CHARS = 100_000;
const MAX_CHILDREN_PAGE = 500;
const MAX_TREE_CHARS = 20_000;
const MAX_SEARCH_LINES = 100;

// The page of a list: its items, and how many come after it
function pageOf<T>(items: readonly T[], pageNumber: number | undefined, pageSize: number): { readonly items: readonly T[]; readonly remaining: number } {
	const from = pageSize * ((pageNumber ?? 1) - 1);
	return { items: items.slice(from, from + pageSize), remaining: Math.max(0, items.length - from - pageSize) };
}

// the folders Kodia's chat leaves out of a directory tree
function isExcludedFolder(name: string): boolean {
	return name.startsWith('.') || /\b(out|build)\b/.test(name) || ['node_modules', 'dist', 'bin', 'coverage', '__pycache__', 'env', 'venv', 'tmp', 'temp', 'artifacts', 'target', 'obj', 'vendor', 'logs', 'cache', 'resource', 'resources'].includes(name);
}

// A folder's listing in the chat's form: a header, one line a child, and how many more there are
function listing(folder: string, entries: readonly fs.Dirent[], pageNumber: number | undefined): string {
	const sorted = [...entries].sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
	const { items, remaining } = pageOf(sorted, pageNumber, MAX_CHILDREN_PAGE);
	let output = (pageNumber ?? 1) > 1 ? '' : `${folder}\n`;
	items.forEach((entry, i) => {
		const isLast = i === items.length - 1 && remaining === 0;
		output += `${isLast ? '└── ' : '├── '}${entry.name}${entry.isDirectory() ? '/' : ''}${entry.isSymbolicLink() ? ' (symbolic link)' : ''}\n`;
	});
	return remaining > 0 ? `${output}└── (${remaining} results remaining...)\n` : output;
}

// A tree of a folder, deep as the budget of characters allows: it is cut when it doesn't fit
async function directoryTree(root: string): Promise<string> {
	for (const [maxDepth, maxItems] of [[3, 100], [2, 40], [1, 20]]) {
		let text = '';
		let cut = false;
		const walk = async (folder: string, prefix: string, depth: number): Promise<void> => {
			const entries = (await fs.promises.readdir(folder, { withFileTypes: true }).catch(() => []))
				.filter(entry => !(entry.isDirectory() && isExcludedFolder(entry.name)))
				.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
			const shownEntries = entries.slice(0, maxItems);
			for (const [i, entry] of shownEntries.entries()) {
				const isLast = i === shownEntries.length - 1 && entries.length <= maxItems;
				const line = `${prefix}${isLast ? '└── ' : '├── '}${entry.name}${entry.isDirectory() ? '/' : ''}\n`;
				if (text.length + line.length > MAX_TREE_CHARS) {
					cut = true;
					return;
				}
				text += line;
				if (entry.isDirectory() && depth < maxDepth) {
					await walk(path.join(folder, entry.name), `${prefix}${isLast ? '    ' : '│   '}`, depth + 1);
					if (cut) {
						return;
					}
				}
			}
			if (entries.length > maxItems) {
				cut = true;
			}
		};
		await walk(root, '', 1);
		if (!cut || maxDepth === 1) {
			return `Directory of ${root}:\n${text}${cut ? '\n...Result was truncated...' : ''}`;
		}
	}
	return '';
}

// ripgrep's output lines; it exits with 1 when nothing matches, and with 2 when a file couldn't be read, even if others
// matched: those results are kept.
async function ripgrepLines(args: string[], root: string, signal: AbortSignal): Promise<string[]> {
	const lines = (stdout: string) => stdout.split('\n').filter(line => !!line).map(line => line.replace(/^\.[\\/]/, ''));
	try {
		const { stdout } = await execFileAsync(await rgDiskPath(), args, { cwd: root, signal, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * MAX_OUTPUT_BYTES });
		return lines(stdout);
	} catch (err) {
		const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
		if (e.code === 1) {
			return [];
		}
		if (e.code === 2 && e.stdout?.trim()) {
			return lines(e.stdout);
		}
		throw new Error((e.stderr || e.message || String(err)).trim());
	}
}

// hidden files (.github/...) are searched too, the .git folder isn't
const RIPGREP_HIDDEN_ARGS = ['--hidden', '--glob', '!.git'];

// ripgrep's path argument, always given: without one, ripgrep reads its standard input, which isn't a terminal here
function searchPathArgs(p: unknown, root: string): string[] {
	const target = resolveToolPath(typeof p === 'string' && p ? p : '.', root);
	return [path.relative(root, target) || '.'];
}

// A file's text with "\n" line endings, and the line ending to write it back with
async function readTextFile(target: string): Promise<{ readonly text: string; readonly eol: '\n' | '\r\n' }> {
	const content = await fs.promises.readFile(target, 'utf8');
	return content.includes('\r\n') ? { text: content.replace(/\r\n/g, '\n'), eol: '\r\n' } : { text: content, eol: '\n' };
}

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
				const target = resolve(args.uri);
				const content = await fs.promises.readFile(target, 'utf8');
				const lines = content.split('\n');
				const start = toPositiveInt(args.start_line);
				const end = toPositiveInt(args.end_line);
				const selected = start || end ? lines.slice((start ?? 1) - 1, end ?? lines.length).join('\n') : content;
				const pageNumber = toPositiveInt(args.page_number) ?? 1;
				const hasNextPage = selected.length > MAX_PAGE_CHARS * pageNumber;
				const page = selected.slice(MAX_PAGE_CHARS * (pageNumber - 1), MAX_PAGE_CHARS * pageNumber);
				const more = hasNextPage ? `\nMore info because truncated: this file has ${lines.length} lines, or ${content.length} characters.` : '';
				return { success: true, output: `${target}\n\`\`\`\n${page}\n\`\`\`${nextPageNote(hasNextPage)}${more}`, path: target };
			}
			case 'ls_dir': {
				const target = resolve(args.uri);
				const entries = await fs.promises.readdir(target, { withFileTypes: true });
				return { success: true, output: listing(target, entries, toPositiveInt(args.page_number)), path: target };
			}
			case 'get_dir_tree': {
				const target = resolve(args.uri);
				if (!(await fs.promises.stat(target)).isDirectory()) {
					return { success: false, output: `${target} is not a folder.`, path: target };
				}
				return { success: true, output: await directoryTree(target), path: target };
			}
			case 'search_pathnames_only': {
				const query = toStr(args.query).trim().toLowerCase();
				if (!query) {
					return { success: false, output: 'Missing "query".' };
				}
				const include = toStr(args.include_pattern) ? ['--glob', toStr(args.include_pattern)] : [];
				const files = await ripgrepLines(['--files', '--sort', 'path', ...RIPGREP_HIDDEN_ARGS, ...include], root, ctx.signal);
				const { items, remaining } = pageOf(files.filter(file => file.toLowerCase().includes(query)), toPositiveInt(args.page_number), MAX_CHILDREN_PAGE);
				return { success: true, output: items.map(file => path.join(root, file)).join('\n') + nextPageNote(remaining > 0) };
			}
			case 'search_for_files': {
				const query = toStr(args.query);
				if (!query) {
					return { success: false, output: 'Missing "query".' };
				}
				const files = await ripgrepLines(['--files-with-matches', '--sort', 'path', ...toBool(args.is_regex) ? [] : ['--fixed-strings'], ...RIPGREP_HIDDEN_ARGS, '--regexp', query, ...searchPathArgs(args.search_in_folder, root)], root, ctx.signal);
				const { items, remaining } = pageOf(files, toPositiveInt(args.page_number), MAX_CHILDREN_PAGE);
				return { success: true, output: items.map(file => path.join(root, file)).join('\n') + nextPageNote(remaining > 0) };
			}
			case 'search_in_file': {
				const target = resolve(args.uri);
				const query = toStr(args.query);
				if (!query) {
					return { success: false, output: 'Missing "query".', path: target };
				}
				const regex = toBool(args.is_regex) ? new RegExp(query) : undefined;
				const matches: string[] = [];
				let total = 0;
				(await fs.promises.readFile(target, 'utf8')).split('\n').forEach((line, i) => {
					if (regex ? regex.test(line) : line.includes(query)) {
						total++;
						if (matches.length < MAX_SEARCH_LINES) {
							matches.push(`Line ${i + 1}:\n\`\`\`\n${line.replace(/\r$/, '')}\n\`\`\``);
						}
					}
				});
				const cut = total > matches.length ? `\n\n(Showing ${matches.length} of ${total} lines. Use a more specific query to narrow it down.)` : '';
				return { success: true, output: (matches.join('\n\n') || 'No matches.') + cut, path: target };
			}
			case 'create_file_or_folder': {
				const target = resolve(args.uri);
				if (/[\\/]\s*$/.test(toStr(args.uri))) {
					await fs.promises.mkdir(target, { recursive: true });
				} else {
					await fs.promises.mkdir(path.dirname(target), { recursive: true });
					await fs.promises.writeFile(target, '', { flag: 'wx' });
				}
				return { success: true, output: `URI ${target} successfully created.`, didWrite: true, path: target };
			}
			case 'delete_file_or_folder': {
				const target = resolve(args.uri);
				await fs.promises.rm(target, { recursive: toBool(args.is_recursive) });
				return { success: true, output: `URI ${target} successfully deleted.`, didWrite: true, path: target };
			}
			case 'edit_file': {
				const target = resolve(args.uri);
				const { text, eol } = await readTextFile(target);
				// an ORIGINAL that is on several lines is an error: the agent can't show a diff to review
				const edited = applySearchReplaceBlocks(text, toStr(args.search_replace_blocks), { requireUnique: true });
				await fs.promises.writeFile(target, eol === '\r\n' ? edited.replace(/\n/g, '\r\n') : edited, 'utf8');
				return { success: true, output: `Change successfully made to ${target}.`, didWrite: true, path: target };
			}
			case 'rewrite_file': {
				const target = resolve(args.uri);
				await fs.promises.mkdir(path.dirname(target), { recursive: true });
				await fs.promises.writeFile(target, toStr(args.new_content), 'utf8');
				return { success: true, output: `Change successfully made to ${target}.`, didWrite: true, path: target };
			}
			case 'run_command': {
				const command = toStr(args.command);
				if (!command) {
					return { success: false, output: 'Missing "command".' };
				}
				const cwd = toStr(args.cwd) ? resolve(args.cwd) : root;
				try {
					const { stdout, stderr } = await execAsync(command, { cwd, signal: ctx.signal, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES });
					return { success: true, output: `${`${stdout ?? ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim()}\n(exit code 0)` };
				} catch (err) {
					// `child_process.exec` rejects with the output and the exit code attached for a command that fails.
					const e = err as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; message?: string };
					if (e.killed) {
						return { success: false, output: `${`${e.stdout ?? ''}${e.stderr ? `\n[stderr]\n${e.stderr}` : ''}`.trim()}\nThe command was stopped after ${COMMAND_TIMEOUT_MS / 1000}s and did not finish.` };
					}
					if (typeof e.code === 'number') {
						return { success: false, output: `${`${e.stdout ?? ''}${e.stderr ? `\n[stderr]\n${e.stderr}` : ''}`.trim()}\n(exit code ${e.code})` };
					}
					throw err;
				}
			}
			case 'fetch_url': {
				const url = toStr(args.url);
				const page = await fetchWebPage(url, ctx.signal);
				const pageNumber = toPositiveInt(args.page_number) ?? 1;
				const text = page.text.slice(MAX_PAGE_CHARS * (pageNumber - 1), MAX_PAGE_CHARS * pageNumber);
				const hasNextPage = page.text.length > MAX_PAGE_CHARS * pageNumber;
				const header = `${page.title ? `${page.title}\n` : ''}${page.url}${page.url !== url ? ` (redirected from ${url})` : ''}`;
				const content = text || (pageNumber > 1 ? '(No content on this page.)' : '(The page has no text. It may need JavaScript to render.)');
				const more = hasNextPage ? `${nextPageNote(true)}\nMore info because truncated: this page has ${page.text.length} characters.` : '';
				return { success: true, output: `${header}\n\n${content}${more}` };
			}
			case 'write_project_memory': {
				const section = toStr(args.section).trim();
				if (!section) {
					return { success: false, output: 'Missing "section".' };
				}
				const target = path.join(root, PROJECT_MEMORY_FILE_PATH);
				const current = await fs.promises.readFile(target, 'utf8').catch((e: NodeJS.ErrnoException) => e.code === 'ENOENT' ? PROJECT_MEMORY_FILE_HEADER : Promise.reject(e));
				const content = toStr(args.content);
				const memory = memoryWithSection(current, section, content);
				// the agent host has no tokenizer: about 4 characters a token
				const tokenCount = Math.ceil(memory.length / 4);
				if (tokenCount > MAX_PROJECT_MEMORY_TOKENS) {
					return { success: false, output: memoryTooLongMessage(tokenCount), path: target };
				}
				await fs.promises.mkdir(path.dirname(target), { recursive: true });
				await fs.promises.writeFile(target, memory, 'utf8');
				const nearLimit = tokenCount > MAX_PROJECT_MEMORY_TOKENS * 0.8 ? ` That's close to the ~${MAX_PROJECT_MEMORY_TOKENS}-token limit: condense or delete outdated sections soon.` : '';
				return { success: true, output: `${content.trim() ? `Section "${section}" saved` : `Section "${section}" deleted`}. The project memory is now ${tokenCount} tokens.${nearLimit}`, didWrite: true, path: target };
			}
			default:
				return { success: false, output: `Unknown tool: ${name}` };
		}
	} catch (err) {
		return { success: false, output: err instanceof Error ? err.message : String(err) };
	}
}
