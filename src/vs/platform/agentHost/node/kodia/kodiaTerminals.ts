/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../log/common/log.js';
import { isPersistentTerminalToolName, jsonSchemaOfSharedTool, MAX_TERMINAL_BG_COMMAND_TIME, PersistentTerminalToolName, persistentTerminalToolNames, persistentTerminalTools } from '../../../kodia/common/toolCatalog.js';
import type { IByokLmFunctionTool } from '../../common/agentHostByokLm.js';
import { ActionType, type ChatAction } from '../../common/state/sessionActions.js';
import { BackgroundWorkKind, TerminalClaimKind, type BackgroundShellWork, type TerminalSessionClaim } from '../../common/state/protocol/state.js';
import { parseRequiredSessionUriFromChatUri } from '../../common/state/sessionState.js';
import { IAgentHostTerminalManager } from '../agentHostTerminalManager.js';
import { executeShellCommand, prepareOutputForModel, shellTypeForExecutable, type IShellCommandResult, type ShellType } from '../shared/shellCommandExecution.js';
import { persistentTerminalIdOf, resolveToolPath, type IKodiaToolResult } from './kodiaTools.js';

/**
 * The terminals the Kodia agent opens for a dev server, a watcher, a listener: three tools, with the names, the
 * parameters and the descriptions of Kodia's chat (see `persistentTerminalTools` in `toolCatalog.ts`).
 */
export const PERSISTENT_TERMINAL_FUNCTION_TOOLS: IByokLmFunctionTool[] = persistentTerminalToolNames.map(name => ({
	type: 'function',
	name,
	description: persistentTerminalTools[name].description,
	parametersSchema: jsonSchemaOfSharedTool(persistentTerminalTools[name]),
}));

export { isPersistentTerminalToolName, persistentTerminalToolNames };

/** What a persistent terminal tool call knows of the turn that makes it. */
export interface IKodiaTerminalCall {
	readonly chat: URI;
	readonly turnId: string;
	readonly toolCallId: string;
	readonly workingDirectory: URI | undefined;
	readonly signal: AbortSignal;
}

export interface IKodiaTerminalsOptions {
	/** How long a command is waited for before its output so far is returned, and it keeps running. */
	readonly commandWaitMs?: number;
	/** How long a terminal is given to print the rest of a burst of output, when a call returns because it printed. */
	readonly settleMs?: number;
	/** How often the terminals that run a command are checked for having been closed by the user. */
	readonly workCheckMs?: number;
}

/** The background work of a chat that changed: a command was left running in one of its terminals, or ended. */
export interface IKodiaBackgroundWorkChange {
	readonly chat: URI;
	readonly action: Extract<ChatAction, { type: ActionType.ChatBackgroundWorkSet | ActionType.ChatBackgroundWorkRemoved }>;
}

/** One terminal the agent opened. */
interface IPersistentTerminal {
	/** What the model calls it: the smallest free number of its chat, as in Kodia's chat. */
	readonly id: string;
	readonly uri: string;
	readonly title: string;
	readonly shellType: ShellType;
	/** The chat that owns it. */
	readonly chat: URI;
	/** The turn that opened it. */
	readonly turnId: string;
	/** Listens to the terminal, for as long as it lives. */
	readonly listeners: DisposableStore;
	/** The command a call started that has not ended: the terminal can't run another. */
	running: string | undefined;
	/** When that command was typed, as the background work says. */
	startedAt: string | undefined;
	/** What the chat shows of that command once it is left running after its call returned, until it ends. */
	work: BackgroundShellWork | undefined;
	/** A command that ended after the call that started it had returned, until a call says so. */
	ended: { readonly command: string; readonly exitCode: number | undefined } | undefined;
	/** Set once the shell has exited. */
	exitCode: number | undefined;
	/** How much of the terminal's content the model has been given: what comes after is new. */
	readOffset: number;
	/** Whether the output of the command that last ended is followed by the mark zsh draws before its prompt. */
	endsWithZshMark: boolean;
}

// Before each prompt zsh draws its end-of-line mark (PROMPT_SP): a "%" in reverse video, then blanks and a carriage return
// that hide it on a screen. It comes before shell integration says the command is finished, so it ends the output of
// the command: as a line of its own, or after the last line when that has no newline. That it is drawn this way is what
// tells it from a "%" the command printed ("100%", or a line that is a "%"), which is left as it is.
const ZSH_END_OF_LINE_MARK = /\x1b\[7m%(?:\x1b\[[\d;]*m)* +\r \r/;

function withoutZshEndOfLineMark(output: string): string {
	return output.replace(/%$/, '').trimEnd();
}

const READ_OR_KILL = 'Call run_persistent_command with an empty command to read what it prints next, or kill_persistent_terminal to stop it.';

const toStr = (value: unknown): string => typeof value === 'string' ? value : '';

function titleOfId(id: string): string {
	return id === '1' ? 'Kodia Agent' : `Kodia Agent (${id})`;
}

// the smallest free number, as in Kodia's chat: 1 <= id <= n + 1
function freeId(terminals: ReadonlyMap<string, unknown> | undefined): string {
	for (let i = 1; ; i++) {
		if (!terminals?.has(String(i))) {
			return String(i);
		}
	}
}

// What a terminal printed, as the model reads it: without the escape codes, and a line ends with "\n"
function tidy(text: string): string {
	return prepareOutputForModel(text).replace(/\r\n/g, '\n');
}

// The terminal echoes the line it was typed: it is not part of what the command printed
function withoutEcho(output: string, command: string): string {
	const [first, ...rest] = output.split('\n');
	const firstCommandLine = command.split('\n')[0].trim();
	return firstCommandLine && first.trim() === firstCommandLine ? rest.join('\n').trim() : output;
}

function exitCodeNote(exitCode: number | undefined): string {
	return `(exit code ${exitCode ?? 0})`;
}

/** Waits for a promise, or until the turn is stopped: then `undefined`. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	if (signal.aborted) {
		return Promise.resolve(undefined);
	}
	return new Promise<T | undefined>((resolve, reject) => {
		const onAbort = () => resolve(undefined);
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			value => { signal.removeEventListener('abort', onAbort); resolve(value); },
			err => { signal.removeEventListener('abort', onAbort); reject(err); });
	});
}

/**
 * The persistent terminals of the Kodia agent's chats, backed by the agent host's terminals: a PTY the Agents window
 * shows under the session (the terminal is claimed by it), which outlives a command. A command is waited for a few
 * seconds (as in Kodia's chat) and then left running; what it prints later is returned by the next call on its terminal
 * with an empty command. A command that is left running is shown by the chat as background work (a shell), until it
 * ends or its terminal goes. A terminal lives until the agent kills it, or its chat is deleted, or the host stops. The
 * turn that is stopped by the user takes with it the terminals it opened.
 */
export class KodiaTerminals extends Disposable {

	/** The terminals of each chat, by the number the model calls them. */
	private readonly _chats = new Map<string, Map<string, IPersistentTerminal>>();

	private readonly _onDidChangeBackgroundWork = this._register(new Emitter<IKodiaBackgroundWorkChange>());
	/**
	 * A command a terminal left running after its tool call returned is background work of its chat (a shell, with its
	 * terminal), until it ends, or its terminal is killed, closed or shut down.
	 */
	readonly onDidChangeBackgroundWork: Event<IKodiaBackgroundWorkChange> = this._onDidChangeBackgroundWork.event;

	private readonly _commandWaitMs: number;
	private readonly _settleMs: number;
	/**
	 * Nothing tells when the user closes a terminal (the terminal manager says when a shell exits, not when its terminal
	 * is disposed): while a command is left running, the terminals are looked at from time to time.
	 */
	private readonly _workCheck: RunOnceScheduler;

	constructor(
		private readonly _terminalManager: IAgentHostTerminalManager,
		private readonly _logService: ILogService,
		options?: IKodiaTerminalsOptions,
	) {
		super();
		this._commandWaitMs = options?.commandWaitMs ?? MAX_TERMINAL_BG_COMMAND_TIME * 1000;
		this._settleMs = options?.settleMs ?? 250;
		this._workCheck = this._register(new RunOnceScheduler(() => this._checkBackgroundWork(), options?.workCheckMs ?? 2000));
		this._register(toDisposable(() => {
			for (const chat of [...this._chats.keys()]) {
				this.shutdownChat(URI.parse(chat));
			}
		}));
	}

	/**
	 * Run one of the persistent terminal tools. A failure is a result the model reads, not an exception.
	 */
	async execute(name: PersistentTerminalToolName, argsJson: string, call: IKodiaTerminalCall): Promise<IKodiaToolResult> {
		let args: Record<string, unknown>;
		try {
			const parsed: unknown = argsJson ? JSON.parse(argsJson) : {};
			args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
		} catch {
			return { success: false, output: `Invalid JSON arguments for tool "${name}".` };
		}
		try {
			switch (name) {
				case 'open_persistent_terminal':
					return await this._open(args, call);
				case 'run_persistent_command':
					return await this._run(args, call);
				case 'kill_persistent_terminal':
					return this._kill(args, call);
			}
		} catch (err) {
			return { success: false, output: err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * Shut down the terminals of a chat: all of them, or those a turn opened (the turn the user stopped). Their
	 * processes are killed.
	 */
	shutdownChat(chat: URI, turnId?: string): void {
		for (const terminal of [...this._chats.get(chat.toString())?.values() ?? []]) {
			if (turnId === undefined || terminal.turnId === turnId) {
				this._close(chat, terminal);
			}
		}
	}

	/** Whether a command is left running in a terminal of the chat: it can't be released while it shows as background work. */
	hasBackgroundWork(chat: URI): boolean {
		return [...this._chats.get(chat.toString())?.values() ?? []].some(terminal => terminal.work !== undefined);
	}

	// #region open

	private async _open(args: Record<string, unknown>, call: IKodiaTerminalCall): Promise<IKodiaToolResult> {
		const requestedCwd = toStr(args.cwd).trim();
		const cwd = requestedCwd ? resolveToolPath(requestedCwd, call.workingDirectory?.fsPath ?? process.cwd()) : call.workingDirectory?.fsPath;
		// the terminal manager starts in the user's home when it can't use the directory: say so instead
		if (requestedCwd && !(await fs.promises.stat(cwd!).then(stat => stat.isDirectory(), () => false))) {
			return { success: false, output: `${cwd} is not a folder.` };
		}

		const terminals = this._chats.get(call.chat.toString());
		const id = freeId(terminals);
		const executable = await this._terminalManager.getDefaultShell();
		const shellType = shellTypeForExecutable(executable);
		const uri = `agenthost-terminal://kodia/${generateUuid()}`;
		const title = titleOfId(id);
		// The session claims the terminal, so the Agents window shows it under the session
		const claim: TerminalSessionClaim = {
			kind: TerminalClaimKind.Session,
			session: parseRequiredSessionUriFromChatUri(call.chat),
			chat: call.chat.toString(),
			turnId: call.turnId,
			toolCallId: call.toolCallId,
		};
		await this._terminalManager.createTerminal({ channel: uri, claim, name: title, cwd }, { shell: executable, preventShellHistory: true, nonInteractive: true });

		const terminal: IPersistentTerminal = {
			id, uri, title, shellType, chat: call.chat, turnId: call.turnId,
			listeners: new DisposableStore(),
			running: undefined,
			startedAt: undefined,
			work: undefined,
			ended: undefined,
			exitCode: undefined,
			// what the shell printed on starting up is not the model's
			readOffset: this._terminalManager.getContent(uri)?.length ?? 0,
			endsWithZshMark: false,
		};
		terminal.listeners.add(this._terminalManager.onCommandFinished(uri, event => {
			// said before the call that waits for the command is told of its end: the output it is given has no escape codes
			terminal.endsWithZshMark = ZSH_END_OF_LINE_MARK.test(event.output);
			if (terminal.running !== undefined) {
				terminal.ended = { command: terminal.running, exitCode: event.exitCode };
				this._clearRunning(terminal);
			}
		}));
		terminal.listeners.add(this._terminalManager.onExit(uri, exitCode => {
			terminal.exitCode = exitCode;
			this._clearRunning(terminal);
		}));
		if (!terminals) {
			this._chats.set(call.chat.toString(), new Map([[id, terminal]]));
		} else {
			terminals.set(id, terminal);
		}
		this._logService.info(`[Kodia] Persistent terminal ${id} opened for ${call.chat.toString()} (${shellType}, ${uri})`);
		return { success: true, output: `Successfully created persistent terminal. persistentTerminalId="${id}"`, pastTenseMessage: `Opened persistent terminal ${id}` };
	}

	// #endregion

	// #region run

	private async _run(args: Record<string, unknown>, call: IKodiaTerminalCall): Promise<IKodiaToolResult> {
		const id = persistentTerminalIdOf(args.persistent_terminal_id);
		const command = toStr(args.command);
		const terminal = this._chats.get(call.chat.toString())?.get(id);
		if (!terminal || !this._terminalManager.hasTerminal(terminal.uri)) {
			if (terminal) {
				this._close(call.chat, terminal);
			}
			return { success: false, output: this._missing(call.chat, id) };
		}
		if (terminal.exitCode !== undefined) {
			return this._shellExited(call.chat, terminal, this._unread(terminal));
		}

		if (terminal.running !== undefined) {
			if (command.trim()) {
				// typed into the process that runs, it would not be run: the model must choose
				return { success: false, output: `Terminal "${id}" is still running \`${terminal.running}\`, so it can't run another command. Call run_persistent_command with an empty command to read what it prints, kill_persistent_terminal to stop it, or open_persistent_terminal for a terminal of its own.` };
			}
			// reading: what it printed since the last call, waiting a while for something if there is nothing
			let output = this._unread(terminal);
			if (!output) {
				await untilAborted(this._waitForActivity(terminal, call.signal), call.signal);
				output = this._unread(terminal);
			}
			return this._report(call.chat, terminal, output);
		}

		// A command that ended since the last call: its end is said first, with what it printed after the last call
		const ended = terminal.ended;
		terminal.ended = undefined;
		const unread = this._unread(terminal);
		const endedNote = ended ? `${ended.command ? `\`${ended.command}\`` : 'The command'} ended ${exitCodeNote(ended.exitCode)}.` : '';
		const before = [ended ? unread : '', endedNote].filter(Boolean).join('\n');
		if (!command.trim()) {
			return { success: true, output: [unread, endedNote].filter(Boolean).join('\n') || 'Nothing is running in this terminal.', pastTenseMessage: `Read the output of terminal ${id}` };
		}

		const result = await this._runCommand(call.chat, terminal, command, call);
		return { ...result, output: before ? `${before}\n\n${result.output}` : result.output };
	}

	private async _runCommand(chat: URI, terminal: IPersistentTerminal, command: string, call: IKodiaTerminalCall): Promise<IKodiaToolResult> {
		const startOffset = this._terminalManager.getContent(terminal.uri)?.length ?? 0;
		// What the terminal printed since the command was typed, without the line that was typed: shell integration says
		// where the output of the command starts, after the line the shell echoed (and redrew, when it is a long one).
		const printedSince = () => {
			const running = this._runningCommandOutput(terminal);
			if (running !== undefined) {
				return tidy(running);
			}
			const content = this._terminalManager.getContent(terminal.uri) ?? '';
			return withoutEcho(tidy(content.slice(Math.min(startOffset, content.length))), command);
		};
		terminal.running = command;
		terminal.startedAt = new Date().toISOString();
		terminal.ended = undefined;
		const target = { terminalUri: terminal.uri, shellType: terminal.shellType };
		let result: IShellCommandResult | undefined;
		try {
			result = await untilAborted(executeShellCommand(target, command, this._commandWaitMs, this._terminalManager, this._logService), call.signal);
		} catch (err) {
			this._clearRunning(terminal);
			throw err;
		}
		if (!result) {
			// the turn was stopped: the command is left where it is. The terminals the turn opened are shut down with it:
			// of the others, this one goes on in the background.
			if (terminal.turnId !== call.turnId) {
				this._leftRunning(terminal);
			}
			return { success: false, output: 'The turn was stopped.' };
		}

		switch (result.status) {
			case 'completed': {
				this._clearRunning(terminal);
				terminal.ended = undefined;
				this._markRead(terminal);
				const exitCode = result.exitCode ?? 0;
				const printed = result.output.replace(/\r\n/g, '\n');
				const output = withoutEcho(terminal.endsWithZshMark ? withoutZshEndOfLineMark(printed) : printed, command);
				return { success: exitCode === 0, output: `${output || '(no output)'}\n${exitCodeNote(exitCode)}`, terminal: { resource: terminal.uri, title: terminal.title, exitCode, preview: output } };
			}
			case 'shellExited': {
				this._clearRunning(terminal);
				terminal.exitCode ??= result.exitCode;
				return this._shellExited(chat, terminal, printedSince());
			}
			case 'altBuffer': {
				this._markRead(terminal);
				this._leftRunning(terminal);
				return { success: false, output: `The command opened the alternate buffer and is still running in the terminal: it likely launched an interactive terminal UI. Use kill_persistent_terminal to stop it.` };
			}
			case 'timeout':
			case 'background': {
				// without shell integration nothing says when it ends: the next command is let through
				if (!this._terminalManager.supportsCommandDetection(terminal.uri)) {
					this._clearRunning(terminal);
				}
				const output = printedSince();
				this._markRead(terminal);
				this._leftRunning(terminal);
				return {
					success: true,
					output: `${output || '(no output)'}\nThe command is running in terminal "${terminal.id}". The given output is what it printed in the first ${Math.round(this._commandWaitMs / 1000)} seconds. ${READ_OR_KILL}`,
					terminal: { resource: terminal.uri, title: terminal.title, preview: output },
				};
			}
		}
	}

	// #endregion

	// #region kill

	private _kill(args: Record<string, unknown>, call: IKodiaTerminalCall): IKodiaToolResult {
		const id = persistentTerminalIdOf(args.persistent_terminal_id);
		const terminal = this._chats.get(call.chat.toString())?.get(id);
		if (!terminal) {
			return { success: false, output: `Kill Terminal: Terminal with ID ${id} did not exist.${this._known(call.chat)}` };
		}
		// what it printed since the model last looked, and then the process is interrupted: Ctrl+C, and the shell closed
		const output = terminal.exitCode === undefined ? this._unread(terminal) : '';
		if (terminal.running !== undefined) {
			this._terminalManager.writeInput(terminal.uri, '\x03');
		}
		this._close(call.chat, terminal);
		return { success: true, output: `Successfully closed terminal "${id}".${output ? `\nWhat it printed since you last read it:\n${output}` : ''}`, pastTenseMessage: `Closed terminal ${id}` };
	}

	// #endregion

	// #region helpers

	// What a read says of the command of a terminal: its output, and that it runs, or how it ended
	private _report(chat: URI, terminal: IPersistentTerminal, output: string): IKodiaToolResult {
		const pastTenseMessage = `Read the output of terminal ${terminal.id}`;
		if (terminal.exitCode !== undefined) {
			return this._shellExited(chat, terminal, output);
		}
		if (terminal.running === undefined) {
			// it ended while the call waited
			const ended = terminal.ended;
			terminal.ended = undefined;
			return { success: (ended?.exitCode ?? 0) === 0, output: `${output || '(no output)'}\n${exitCodeNote(ended?.exitCode)}`, pastTenseMessage };
		}
		return { success: true, output: `${output || '(no new output)'}\n\`${terminal.running}\` is still running in terminal "${terminal.id}". ${READ_OR_KILL}`, pastTenseMessage };
	}

	private _shellExited(chat: URI, terminal: IPersistentTerminal, output: string): IKodiaToolResult {
		const exitCode = terminal.exitCode;
		this._close(chat, terminal);
		return { success: false, output: `${output ? `${output}\n` : ''}The shell of terminal "${terminal.id}" exited with code ${exitCode ?? 'unknown'}. Open another terminal with open_persistent_terminal.` };
	}

	private _missing(chat: URI, id: string): string {
		return `Terminal with ID ${id} does not exist.${this._known(chat)} Open one with open_persistent_terminal.`;
	}

	private _known(chat: URI): string {
		const ids = [...this._chats.get(chat.toString())?.keys() ?? []];
		return ids.length ? ` The terminals that are open: ${ids.join(', ')}.` : ' No terminal is open.';
	}

	/** What the terminal printed since the model was last given its output, with the escape codes removed. */
	private _unread(terminal: IPersistentTerminal): string {
		const content = this._terminalManager.getContent(terminal.uri) ?? '';
		// the manager keeps the last 80k characters: when it cut the start, it is all that is left
		const from = content.length < terminal.readOffset ? 0 : terminal.readOffset;
		terminal.readOffset = content.length;
		return tidy(content.slice(from));
	}

	/** What the command that runs in the terminal has printed, when shell integration tells where it started. */
	private _runningCommandOutput(terminal: IPersistentTerminal): string | undefined {
		const last = this._terminalManager.getTerminalState(terminal.uri)?.content.at(-1);
		return last?.type === 'command' && !last.isComplete ? last.output : undefined;
	}

	private _markRead(terminal: IPersistentTerminal): void {
		terminal.readOffset = this._terminalManager.getContent(terminal.uri)?.length ?? 0;
	}

	/**
	 * Resolves when the command that runs in the terminal ends or the shell exits, or when it prints something (a
	 * moment after, for the rest of the burst), or after the time a command is waited for.
	 */
	private _waitForActivity(terminal: IPersistentTerminal, signal: AbortSignal): Promise<void> {
		return new Promise<void>(resolve => {
			const store = new DisposableStore();
			const done = () => { store.dispose(); resolve(); };
			store.add(this._terminalManager.onCommandFinished(terminal.uri, done));
			store.add(this._terminalManager.onExit(terminal.uri, done));
			let settling = false;
			store.add(this._terminalManager.onData(terminal.uri, () => {
				if (!settling) {
					settling = true;
					const settle = setTimeout(done, this._settleMs);
					store.add(toDisposable(() => clearTimeout(settle)));
				}
			}));
			const timer = setTimeout(done, this._commandWaitMs);
			store.add(toDisposable(() => clearTimeout(timer)));
			signal.addEventListener('abort', done, { once: true });
			store.add(toDisposable(() => signal.removeEventListener('abort', done)));
		});
	}

	/** The command that ran in the terminal has ended, or is not tracked any more: it is not background work either. */
	private _clearRunning(terminal: IPersistentTerminal): void {
		terminal.running = undefined;
		terminal.startedAt = undefined;
		this._retractBackgroundWork(terminal);
	}

	/**
	 * The command of a call that returned goes on in its terminal: the chat shows it as background work. A command that
	 * ends within the wait is none, and neither is one the terminal can't tell the end of (without shell integration).
	 */
	private _leftRunning(terminal: IPersistentTerminal): void {
		if (terminal.running === undefined || terminal.work) {
			return;
		}
		const work: BackgroundShellWork = {
			kind: BackgroundWorkKind.Shell,
			id: `shell:${terminal.id}`,
			label: terminal.running,
			command: terminal.running,
			startedAt: terminal.startedAt ?? new Date().toISOString(),
			terminal: terminal.uri,
		};
		terminal.work = work;
		this._onDidChangeBackgroundWork.fire({ chat: terminal.chat, action: { type: ActionType.ChatBackgroundWorkSet, work } });
		this._scheduleWorkCheck();
	}

	private _retractBackgroundWork(terminal: IPersistentTerminal): void {
		const work = terminal.work;
		if (work) {
			terminal.work = undefined;
			this._onDidChangeBackgroundWork.fire({ chat: terminal.chat, action: { type: ActionType.ChatBackgroundWorkRemoved, id: work.id } });
		}
	}

	private _scheduleWorkCheck(): void {
		if (!this._workCheck.isScheduled() && [...this._chats.values()].some(terminals => [...terminals.values()].some(terminal => terminal.work))) {
			this._workCheck.schedule();
		}
	}

	/** A terminal the user closed is gone without a word: its command does not run any more. */
	private _checkBackgroundWork(): void {
		for (const terminals of [...this._chats.values()]) {
			for (const terminal of [...terminals.values()]) {
				if (terminal.work && !this._terminalManager.hasTerminal(terminal.uri)) {
					this._close(terminal.chat, terminal);
				}
			}
		}
		this._scheduleWorkCheck();
	}

	private _close(chat: URI, terminal: IPersistentTerminal): void {
		this._retractBackgroundWork(terminal);
		terminal.listeners.dispose();
		const terminals = this._chats.get(chat.toString());
		terminals?.delete(terminal.id);
		if (terminals?.size === 0) {
			this._chats.delete(chat.toString());
		}
		this._terminalManager.disposeTerminal(terminal.uri);
		this._logService.info(`[Kodia] Persistent terminal ${terminal.id} closed (${terminal.uri})`);
	}

	// #endregion
}
