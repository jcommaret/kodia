/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import type { CreateTerminalParams } from '../../common/state/protocol/commands.js';
import { TerminalClaimKind, TerminalLifecycleStatus, type TerminalClaim, type TerminalContentPart, type TerminalInfo, type TerminalState } from '../../common/state/protocol/state.js';
import type { IAgentHostTerminalManager, ICommandFinishedEvent, ISendTextOptions } from '../../node/agentHostTerminalManager.js';

/**
 * A terminal of {@link FakeTerminalManager}: a shell that prints what the test tells it to. A command is typed with
 * `sendText`, echoed like a real terminal does, and answered by the manager's `shell`.
 */
export class FakeTerminal extends Disposable {
	/** As the host keeps it: what is printed outside of a command, and the commands with their output. */
	readonly parts: TerminalContentPart[] = [];
	readonly typed: string[] = [];
	readonly written: string[] = [];
	exited = false;
	private _commandCounter = 0;

	readonly onDidData = this._register(new Emitter<string>());
	readonly onDidExit = this._register(new Emitter<number>());
	readonly onDidChangeClaim = this._register(new Emitter<TerminalClaim>());
	readonly onDidFinishCommand = this._register(new Emitter<ICommandFinishedEvent>());

	constructor(readonly uri: string, readonly params: CreateTerminalParams, readonly options: { shell?: string; preventShellHistory?: boolean; nonInteractive?: boolean } | undefined) {
		super();
	}

	get content(): string {
		return this.parts.map(part => part.type === 'command' ? part.output : part.value).join('');
	}

	private get _activeCommand() {
		const last = this.parts.at(-1);
		return last?.type === 'command' && !last.isComplete ? last : undefined;
	}

	/** What the terminal prints, outside of a command or in the one that runs. */
	print(text: string): void {
		const command = this._activeCommand;
		if (command) {
			command.output += text;
		} else if (this.parts.at(-1)?.type === 'unclassified') {
			(this.parts.at(-1) as { value: string }).value += text;
		} else {
			this.parts.push({ type: 'unclassified', value: text });
		}
		this.onDidData.fire(text);
	}

	/** A command starts: the shell echoes the line (`echo` is what it prints, when the terminal redraws it), and what the command prints goes after it. */
	start(command: string, echo = command): void {
		this.print(`${echo}\r\n`);
		this.parts.push({ type: 'command', commandId: `cmd-${++this._commandCounter}`, commandLine: command, output: '', timestamp: Date.now(), isComplete: false });
	}

	/** The command that runs ends, and the shell prints its prompt. */
	finish(exitCode: number | undefined): void {
		const command = this._activeCommand;
		if (command) {
			command.isComplete = true;
			command.exitCode = exitCode;
			this.onDidFinishCommand.fire({ commandId: command.commandId, exitCode, command: command.commandLine, output: command.output });
		}
		this.print('$ ');
	}

	/** The shell exits. */
	exit(exitCode: number): void {
		this.exited = true;
		this.onDidExit.fire(exitCode);
	}
}

/**
 * A fake of the agent host's terminal manager: its terminals are {@link FakeTerminal}s, each with its own events, so a
 * test can have several of them run commands. `shell` answers what is typed in a terminal; by default a command prints
 * nothing and succeeds at once.
 */
export class FakeTerminalManager extends Disposable implements IAgentHostTerminalManager {
	declare readonly _serviceBrand: undefined;

	readonly terminals = new Map<string, FakeTerminal>();
	readonly created: FakeTerminal[] = [];
	readonly disposed: string[] = [];
	defaultShell = '/bin/bash';
	commandDetectionSupported = true;
	/** Whether the host says what each command printed (as it does with shell integration), or only the content as a whole. */
	shellIntegrationState = true;
	/** Answers a command typed in a terminal (without the space that keeps it out of the shell's history). */
	shell: (terminal: FakeTerminal, command: string) => void = (terminal, command) => {
		terminal.start(command);
		terminal.finish(0);
	};

	async createTerminal(params: CreateTerminalParams, options?: { shell?: string; preventShellHistory?: boolean; nonInteractive?: boolean }): Promise<void> {
		const terminal = this._register(new FakeTerminal(params.channel, params, options));
		this.terminals.set(params.channel, terminal);
		this.created.push(terminal);
		// a shell starts with its prompt
		terminal.print('$ ');
	}

	writeInput(uri: string, data: string): void { this.terminals.get(uri)?.written.push(data); }

	async sendText(uri: string, data: string, _options: ISendTextOptions): Promise<void> {
		const terminal = this.terminals.get(uri);
		if (terminal) {
			const command = data.trim();
			terminal.typed.push(command);
			this.shell(terminal, command);
		}
	}

	onData(uri: string, cb: (data: string) => void): IDisposable { return this._listen(uri, terminal => terminal.onDidData.event(cb)); }
	onExit(uri: string, cb: (exitCode: number) => void): IDisposable { return this._listen(uri, terminal => terminal.onDidExit.event(cb)); }
	onClaimChanged(uri: string, cb: (claim: TerminalClaim) => void): IDisposable { return this._listen(uri, terminal => terminal.onDidChangeClaim.event(cb)); }
	onCommandFinished(uri: string, cb: (event: ICommandFinishedEvent) => void): IDisposable { return this._listen(uri, terminal => terminal.onDidFinishCommand.event(cb)); }
	createAltBufferPromise(): Promise<void> { return new Promise<void>(() => { }); }
	getContent(uri: string): string | undefined { return this.terminals.get(uri)?.content; }
	getClaim(uri: string): TerminalClaim | undefined { return this.terminals.get(uri)?.params.claim; }
	hasTerminal(uri: string): boolean { return this.terminals.has(uri); }
	supportsCommandDetection(): boolean { return this.commandDetectionSupported; }
	disposeTerminal(uri: string): void {
		this.disposed.push(uri);
		this.terminals.get(uri)?.dispose();
		this.terminals.delete(uri);
	}
	getTerminalInfos(): TerminalInfo[] { return []; }
	getTerminalState(uri: string): TerminalState | undefined {
		const terminal = this.terminals.get(uri);
		return this.shellIntegrationState && terminal ? { title: 'Fake', content: terminal.parts, lifecycle: { status: TerminalLifecycleStatus.Running }, claim: terminal.params.claim ?? { kind: TerminalClaimKind.Client, clientId: '' }, isPty: true } : undefined;
	}
	async getDefaultShell(): Promise<string> { return this.defaultShell; }
	createOutputTerminal(): void { }
	appendOutputTerminalData(): void { }
	resetOutputTerminal(): void { }
	replaceOutputTerminalData(): void { }
	finalizeOutputTerminal(): void { }

	private _listen(uri: string, subscribe: (terminal: FakeTerminal) => IDisposable): IDisposable {
		const terminal = this.terminals.get(uri);
		return terminal ? subscribe(terminal) : { dispose() { } };
	}
}
