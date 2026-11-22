/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Terminal command safety utilities.
 *
 * Detects potentially destructive commands and operations to elevate their
 * autonomy risk classification. Provides safe command construction helpers
 * to prevent argument injection issues.
 */

import { isWindows } from '../../../../base/common/platform.js';
import { quotePowerShellArg } from './terminalUtils.js';

/**
 * Commands that are destructive/irreversible and should be classified as
 * high or critical risk regardless of autonomy mode.
 *
 * These patterns match the command name (first token) of the command string.
 */
export const DESTRUCTIVE_COMMANDS: ReadonlySet<string> = new Set([
	// File deletion - recursive (POSIX, cmd, and PowerShell's Remove-Item with its aliases)
	'rm', 'rmdir', 'rd', 'del', 'erase', 'deltree', 'remove-item', 'ri',
	// Filesystem formatting
	'format', 'mkfs', 'mkfs.ext4', 'mkfs.ntfs', 'mkfs.fat',
	// Disk imaging/overwriting
	'dd', 'shred', 'wipe', 'scrub',
]);

/**
 * Destructive command patterns that match anywhere in the command string.
 * These catch cases like `sudo mkfs.ext4 /dev/sdb1`, etc. where the destructive
 * command is not the first token. First-token-based commands (rm, del, format,
 * etc.) are handled directly in isDestructiveCommand().
 */
export const DESTRUCTIVE_PATTERNS: ReadonlyArray<RegExp> = [
	// mkfs.*
	/\bmkfs\./,
	// dd with of= (output file - could overwrite)
	/\bdd\s.*\bof=/,
	// recursive deletes from inside another program (node -e, python -c, PowerShell .NET calls, npx rimraf)
	/\brimraf\b/,
	/\bshutil\.rmtree\b/,
	/\[(?:System\.)?IO\.Directory\]::Delete\s*\(/i,
	/\b(?:rmSync|rmdirSync|rm|rmdir)\s*\([^)]*recursive\s*:\s*true/,
];

const DELETE_COMMANDS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'deltree', 'remove-item', 'ri']);
const ALWAYS_DESTRUCTIVE = new Set(['format', 'mkfs', 'mkfs.ext4', 'mkfs.ntfs', 'mkfs.fat', 'dd', 'shred', 'wipe', 'scrub', 'diskpart']);

/**
 * Splits a command line into the commands it runs: on ; && || | & and newlines outside quotes. `piped` marks a
 * command that receives another one's output (`Get-ChildItem -Recurse | Remove-Item` deletes whatever comes in).
 */
function splitCommands(line: string): { text: string; piped: boolean }[] {
	const out: { text: string; piped: boolean }[] = [];
	let cur = '', quote: string | undefined, piped = false;
	const push = (nextPiped: boolean) => { if (cur.trim()) { out.push({ text: cur.trim(), piped }); } cur = ''; piped = nextPiped; };
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote) { if (ch === quote) { quote = undefined; } cur += ch; continue; }
		if (ch === '"' || ch === '\'') { quote = ch; cur += ch; continue; }
		if (ch === ';' || ch === '\n' || ch === '\r') { push(false); continue; }
		if (ch === '|') { if (line[i + 1] === '|') { i++; push(false); } else { push(true); } continue; }
		if (ch === '&') { if (line[i + 1] === '&') { i++; } push(false); continue; } // also PowerShell's & call operator
		cur += ch;
	}
	push(false);
	return out;
}

const unquote = (s: string) => /^(['"]).*\1$/s.test(s) ? s.slice(1, -1) : s;

/** A recursive flag: -r/-R and clusters like -rf, --recursive, cmd's /s, PowerShell -Recurse and its prefixes. */
function isRecursiveFlag(token: string): boolean {
	const t = token.toLowerCase();
	if (t === '--recursive' || t === '/s') { return true; }
	if (/^-[a-z]{3,}$/.test(t) && '-recurse'.startsWith(t)) { return true; } // -rec, -recurse (not -Force: no prefix)
	// a short-flag cluster with r (-r, -rf, -fR) that is not a PowerShell -Force prefix
	return /^-[a-z]{1,3}$/.test(t) && t.includes('r') && !'-force'.startsWith(t);
}

/** One command, after the wrappers that run another command (sudo, cmd /c, powershell -Command). */
function isDestructiveSingle(text: string, piped: boolean): boolean {
	const s = text.trim();
	// wrappers: judge what they run
	const wrapper = /^(?:sudo|doas|nohup|exec|time)\s+(.+)$/is.exec(s)
		?? /^cmd(?:\.exe)?\s+\/[ck]\s+(.+)$/is.exec(s)
		?? /^(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*?-(?:c|command)\s+(.+)$/is.exec(s);
	if (wrapper) { return isDestructiveCommand(unquote(wrapper[1].trim())); }

	const tokens = s.split(/\s+/);
	const first = tokens[0].toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '');
	const args = tokens.slice(1);

	if (ALWAYS_DESTRUCTIVE.has(first)) { return true; }
	if (DELETE_COMMANDS.has(first)) {
		if (args.some(isRecursiveFlag)) { return true; }
		// everything in a folder: rm *, del /q *.*, Remove-Item .\*
		if (args.some(a => /^(?:\.?[\\/])?\*(?:\.\*)?$/.test(unquote(a)) || /[\\/]\*(?:\.\*)?$/.test(unquote(a)))) { return true; }
		// Remove-Item (and aliases) fed by a pipeline deletes every item it receives
		if (piped) { return true; }
		return false;
	}
	if (first === 'git') {
		const sub = args.find(a => !a.startsWith('-'))?.toLowerCase();
		if (sub === 'clean' && args.some(a => /^-[a-z]*f/i.test(a) || a === '--force')) { return true; } // deletes untracked files
		if (sub === 'reset' && args.includes('--hard')) { return true; } // discards uncommitted work
		if (sub === 'push' && args.some(a => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || /^\+/.test(a))) { return true; }
	}
	return false;
}

/**
 * Checks if a command string contains a potentially destructive operation.
 * Returns true if the command should be treated as high/critical risk.
 *
 * Every command of a command line is checked (`cd x; Remove-Item -Recurse -Force .` was judged by `cd` alone),
 * through wrappers (sudo, cmd /c, powershell -Command):
 * - a recursive delete (rm -r, rd /s, del /s, Remove-Item -Recurse, with or without force), deleting everything in a
 *   folder (`*`, `*.*`), or Remove-Item fed by a pipeline → destructive. Before, only rm/del/rd with BOTH recursive and
 *   force counted, PowerShell's Remove-Item (the Windows default terminal) was not known at all, and an agent emptied
 *   a user's project folder (8917 files) with `Remove-Item -Recurse -Force` without asking.
 * - a single-file delete (rm file.txt, del file.txt) → not destructive
 * - format/mkfs/dd/shred/wipe/scrub/diskpart, git clean -f, git reset --hard, git push --force → destructive
 */
export function isDestructiveCommand(command: string): boolean {
	if (!command || typeof command !== 'string') return false;

	const trimmed = command.trim();
	if (trimmed.length === 0) return false;

	for (const pattern of DESTRUCTIVE_PATTERNS) {
		if (pattern.test(trimmed)) return true;
	}
	return splitCommands(trimmed).some(c => isDestructiveSingle(c.text, c.piped));
}

/**
 * Classifies the risk of a terminal command based on its content.
 * Returns 'critical' for destructive commands, 'medium' otherwise.
 * This is used to augment the base assessRisk for terminal tools.
 */
export function classifyCommandRisk(command: string): 'critical' | 'medium' {
	if (isDestructiveCommand(command)) return 'critical';
	return 'medium';
}

/**
 * Checks if a command string looks like it could be an argument injection
 * attempt - e.g., command substitution, backticks, $(...), ${...}, ;, |, &
 * used to chain commands unexpectedly.
 */
export function hasInjectionRisk(command: string): boolean {
	if (!command || typeof command !== 'string') return false;

	// Check for command substitution patterns that could be injection
	// $(...), ${...}, backticks
	if (/\$\([^)]*\)/.test(command)) return true;
	if (/\$\{[^}]*\}/.test(command)) return true;
	if (/`[^`]*`/.test(command)) return true;

	// Check for command chaining that wasn't explicitly requested
	// ; , | , & outside of quotes
	const unquoted = removeQuotedSections(command);
	if (/[;|&]/.test(unquoted)) return true;

	return false;
}

/**
 * Removes double-quoted and single-quoted sections from a string
 * so we can check for injection patterns outside of quotes.
 */
function removeQuotedSections(str: string): string {
	return str.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
}

/**
 * Safely constructs a command string for execution, quoting arguments
 * appropriately for the target shell.
 *
 * On Windows (PowerShell), uses quotePowerShellArg for each argument.
 * On POSIX shells, uses single-quote escaping.
 */
export function buildSafeCommand(command: string, args: string[]): string {
	if (isWindows) {
		// PowerShell: quote each argument individually
		const quotedArgs = args.map(a => quotePowerShellArg(a));
		return `${command} ${quotedArgs.join(' ')}`.trimEnd();
	} else {
		// POSIX shell: single-quote each argument, escaping embedded single quotes
		const quotedArgs = args.map(a => quotePosixArg(a));
		return `${command} ${quotedArgs.join(' ')}`.trimEnd();
	}
}

/**
 * Quotes a single argument for POSIX shell execution.
 * Wraps in single quotes, escaping any embedded single quotes.
 */
function quotePosixArg(arg: string): string {
	if (arg === '') return "''";
	// If the argument contains no characters that need quoting, pass through
	if (/^[A-Za-z0-9_./-]+$/.test(arg)) return arg;
	// Single-quote, replacing any embedded single quotes with '\''
	const escaped = arg.replace(/'/g, "'\\''");
	return `'${escaped}'`;
}

/**
 * Validates a command string for safety before execution.
 * Returns an array of warning messages, or an empty array if safe.
 */
export function validateCommandSafety(command: string): string[] {
	const warnings: string[] = [];

	if (!command || typeof command !== 'string') {
		warnings.push('Command is empty or not a string');
		return warnings;
	}

	const trimmed = command.trim();
	if (trimmed.length === 0) {
		warnings.push('Command is empty');
		return warnings;
	}

	if (isDestructiveCommand(trimmed)) {
		warnings.push('Command contains potentially destructive operation');
	}

	if (hasInjectionRisk(trimmed)) {
		warnings.push('Command contains potential argument injection patterns');
	}

	return warnings;
}
