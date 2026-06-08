/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import type { FunctionTool } from '@mistralai/mistralai/models/components/index.js';
import { URI } from '../../../../base/common/uri.js';

const execAsync = promisify(cp.exec);

/** Context passed to a local tool executor for one tool call. */
export interface IMistralToolContext {
	readonly workingDirectory: URI | undefined;
	readonly signal: AbortSignal;
}

export interface IMistralToolResult {
	readonly success: boolean;
	/** Text fed back to the model as the `function.result`. */
	readonly output: string;
	/** True when the tool wrote to the filesystem (drives edit tracking later). */
	readonly didWrite?: boolean;
	/** Absolute path the tool acted on, when applicable. */
	readonly path?: string;
}

/**
 * The local toolset advertised to Mistral as client `function` tools. Kept
 * focused and OpenAI-JSON-Schema shaped (the Conversations API forwards these
 * verbatim). Richer tools (grep/glob/multi-file edit) can be added later; the
 * model can already shell out via `run_bash`.
 */
export const MISTRAL_TOOLS: (FunctionTool & { type: 'function' })[] = [
	{
		type: 'function',
		function: {
			name: 'read_file',
			description: 'Read the full contents of a file at the given path (relative to the workspace root, or absolute).',
			parameters: {
				type: 'object',
				properties: { path: { type: 'string', description: 'File path to read.' } },
				required: ['path'],
				additionalProperties: false,
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'write_file',
			description: 'Create or overwrite a file with the given contents. Creates parent directories as needed.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'File path to write.' },
					content: { type: 'string', description: 'Full file contents.' },
				},
				required: ['path', 'content'],
				additionalProperties: false,
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'list_dir',
			description: 'List the entries of a directory. Directories are suffixed with "/".',
			parameters: {
				type: 'object',
				properties: { path: { type: 'string', description: 'Directory path. Defaults to the workspace root.' } },
				required: [],
				additionalProperties: false,
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'run_bash',
			description: 'Run a shell command in the workspace root and return its combined stdout/stderr.',
			parameters: {
				type: 'object',
				properties: { command: { type: 'string', description: 'The shell command to run.' } },
				required: ['command'],
				additionalProperties: false,
			},
		},
	},
];

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
	read_file: 'Read File',
	write_file: 'Write File',
	list_dir: 'List Directory',
	run_bash: 'Run Command',
};

export function toolDisplayName(name: string): string {
	return DISPLAY_NAMES[name] ?? name;
}

/** Tools that change the workspace or run commands — they should be gated by approval. */
export function isMutatingTool(name: string): boolean {
	return name === 'write_file' || name === 'run_bash';
}

const MAX_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;

/** Execute a client tool locally and return text to feed back to the model. */
export async function executeMistralTool(name: string, argsJson: string, ctx: IMistralToolContext): Promise<IMistralToolResult> {
	let args: Record<string, unknown>;
	try {
		args = argsJson ? JSON.parse(argsJson) : {};
	} catch {
		return { success: false, output: `Invalid JSON arguments for tool "${name}".` };
	}

	const root = ctx.workingDirectory?.fsPath ?? process.cwd();
	const resolve = (p: unknown): string => {
		const s = typeof p === 'string' ? p : '';
		return path.isAbsolute(s) ? s : path.join(root, s);
	};

	try {
		switch (name) {
			case 'read_file': {
				const target = resolve(args.path);
				const content = await fs.promises.readFile(target, 'utf8');
				return { success: true, output: content, path: target };
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
			case 'run_bash': {
				const command = typeof args.command === 'string' ? args.command : '';
				if (!command) {
					return { success: false, output: 'Missing "command".' };
				}
				const { stdout, stderr } = await execAsync(command, { cwd: root, signal: ctx.signal, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES });
				const out = `${stdout ?? ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim();
				return { success: true, output: out || '(no output)' };
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
