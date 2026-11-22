/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Custom Slash Commands (Mandate Part 3M).
 *
 * Discovers project-defined (`.kodia/commands/*.md`, `.claude/commands/*.md`) and
 * user-defined slash command templates, parses YAML frontmatter (`description`,
 * `argument-hint`, `allowed-tools`), and expands `$ARGUMENTS` / `$1..$9` placeholders.
 */

export interface CustomSlashCommand {
	/** Command name without leading slash, e.g. "review-pr" or "db:migrate" */
	readonly name: string;
	readonly description: string;
	readonly argumentHint?: string;
	readonly allowedTools?: readonly string[];
	readonly template: string;
	readonly sourcePath: string;
	readonly scope: 'project' | 'user';
}

/**
 * Derive a command name from a relative markdown path inside a commands directory.
 * e.g. `review-pr.md` -> `review-pr`, `git/release.md` -> `git:release`.
 */
export function commandNameFromRelativePath(relativePath: string): string {
	return relativePath
		.replace(/\\/g, '/')
		.replace(/^\/+/, '')
		.replace(/\.md$/i, '')
		.split('/')
		.filter(Boolean)
		.join(':')
		.toLowerCase();
}

/**
 * Parse a markdown command template with optional YAML frontmatter.
 */
export function parseCustomCommandMarkdown(
	name: string,
	sourcePath: string,
	scope: 'project' | 'user',
	content: string,
): CustomSlashCommand | undefined {
	const trimmed = content.trim();
	if (!trimmed || !name) { return undefined; }

	let description = `Run /${name}`;
	let argumentHint: string | undefined;
	let allowedTools: string[] | undefined;
	let template = trimmed;

	const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(trimmed);
	if (fmMatch) {
		const fm = fmMatch[1];
		template = fmMatch[2].trim();
		for (const line of fm.split(/\r?\n/)) {
			const kv = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
			if (!kv) { continue; }
			const key = kv[1].toLowerCase();
			const val = kv[2].trim().replace(/^["']|["']$/g, '');
			if (key === 'description' && val) { description = val; }
			else if ((key === 'argument-hint' || key === 'argument_hint' || key === 'args') && val) { argumentHint = val; }
			else if ((key === 'allowed-tools' || key === 'allowed_tools' || key === 'tools') && val) {
				allowedTools = val.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
			}
		}
	}

	if (!template) { return undefined; }
	return {
		name,
		description,
		argumentHint,
		allowedTools,
		template,
		sourcePath,
		scope,
	};
}

/**
 * Split positional arguments respecting quoted strings.
 */
export function splitCommandArguments(rawArgs: string): string[] {
	const args: string[] = [];
	const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(rawArgs)) !== null) {
		args.push(m[1] ?? m[2] ?? m[3] ?? '');
	}
	return args;
}

/**
 * Expand a custom command template with raw user arguments.
 * Supports `$ARGUMENTS` and positional `$1`..`$9`. If the template contains no
 * placeholders and arguments were provided, appends them cleanly.
 */
export function expandCustomCommandPrompt(command: CustomSlashCommand, rawArgs: string): string {
	const trimmedArgs = rawArgs.trim();
	const positional = splitCommandArguments(trimmedArgs);
	let hadPlaceholder = false;

	let expanded = command.template.replace(/\$ARGUMENTS\b/g, () => {
		hadPlaceholder = true;
		return trimmedArgs;
	});

	expanded = expanded.replace(/\$([1-9])\b/g, (_match, idxStr) => {
		hadPlaceholder = true;
		const idx = Number(idxStr) - 1;
		return positional[idx] ?? '';
	});

	if (!hadPlaceholder && trimmedArgs) {
		expanded = `${expanded}\n\nArguments: ${trimmedArgs}`;
	}

	return expanded.trim();
}

/**
 * Parse a chat message starting with `/commandName optional args`.
 * Returns undefined if the input does not start with a valid slash command token.
 */
export function parseSlashCommandInvocation(input: string): { commandName: string; rawArgs: string } | undefined {
	const trimmed = input.trim();
	const m = /^\/([a-zA-Z0-9_:-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!m) { return undefined; }
	return {
		commandName: m[1].toLowerCase(),
		rawArgs: (m[2] ?? '').trim(),
	};
}
