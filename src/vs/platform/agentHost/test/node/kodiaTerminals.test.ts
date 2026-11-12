/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentSession } from '../../common/agent.js';
import { TerminalClaimKind } from '../../common/state/protocol/state.js';
import { buildDefaultChatUri, parseRequiredSessionUriFromChatUri } from '../../common/state/sessionState.js';
import { IKodiaTerminalCall, KodiaTerminals, PERSISTENT_TERMINAL_FUNCTION_TOOLS } from '../../node/kodia/kodiaTerminals.js';
import { FakeTerminal, FakeTerminalManager } from './kodiaFakeTerminalManager.js';

suite('KodiaTerminals', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const workingDirectory = URI.file(os.tmpdir());
	const chat = URI.parse(buildDefaultChatUri(AgentSession.uri('kodia', 'session-1')));
	const otherChat = URI.parse(buildDefaultChatUri(AgentSession.uri('kodia', 'session-2')));

	// a command is waited for 30 ms instead of 5 s
	function create() {
		const manager = store.add(new FakeTerminalManager());
		const terminals = store.add(new KodiaTerminals(manager, new NullLogService(), { commandWaitMs: 30, settleMs: 10 }));
		return { manager, terminals };
	}

	const callOf = (overrides?: Partial<IKodiaTerminalCall>): IKodiaTerminalCall => ({ chat, turnId: 'turn-1', toolCallId: 'call-1', workingDirectory, signal: new AbortController().signal, ...overrides });

	const open = (terminals: KodiaTerminals, args: object = {}, call = callOf()) => terminals.execute('open_persistent_terminal', JSON.stringify(args), call);
	const run = (terminals: KodiaTerminals, command: string, id: string | number = '1', call = callOf()) => terminals.execute('run_persistent_command', JSON.stringify({ command, persistent_terminal_id: id }), call);
	const kill = (terminals: KodiaTerminals, id: string | number = '1', call = callOf()) => terminals.execute('kill_persistent_terminal', JSON.stringify({ persistent_terminal_id: id }), call);

	/** A dev server: it prints that it is ready, and goes on. Other commands succeed at once. */
	function withDevServer(manager: FakeTerminalManager) {
		manager.shell = (terminal, command) => {
			terminal.start(command);
			if (command === 'npm run dev') {
				terminal.print('ready on :3000\r\n');
			} else if (command === 'echo hi') {
				terminal.print('hi\r\n');
				terminal.finish(0);
			} else if (command === 'false') {
				terminal.finish(1);
			} else {
				terminal.finish(0);
			}
		};
	}

	const terminalOf = (manager: FakeTerminalManager, index = 0): FakeTerminal => manager.created[index];

	suite('the tools', () => {

		test('are the chat\'s, with its names, and every parameter the model needs is required', () => {
			assert.deepStrictEqual(PERSISTENT_TERMINAL_FUNCTION_TOOLS.map(t => t.name), ['open_persistent_terminal', 'run_persistent_command', 'kill_persistent_terminal']);
			assert.deepStrictEqual(PERSISTENT_TERMINAL_FUNCTION_TOOLS.map(t => (t.parametersSchema as { required: string[] }).required), [[], ['command', 'persistent_terminal_id'], ['persistent_terminal_id']]);
		});

		test('say it when the arguments are not JSON', async () => {
			const { terminals } = create();
			assert.deepStrictEqual(await terminals.execute('run_persistent_command', '{"command":', callOf()), { success: false, output: 'Invalid JSON arguments for tool "run_persistent_command".' });
		});
	});

	suite('open_persistent_terminal', () => {

		test('opens a terminal of the session, in the project, and gives its number', async () => {
			const { manager, terminals } = create();

			const result = await open(terminals);

			assert.strictEqual(result.success, true);
			assert.strictEqual(result.output, 'Successfully created persistent terminal. persistentTerminalId="1"');
			const terminal = terminalOf(manager);
			assert.strictEqual(result.pastTenseMessage, 'Opened persistent terminal 1');
			assert.strictEqual(result.terminal, undefined, 'opening one is no command: the window shows it with the commands that run in it');
			// the session claims it, so the Agents window shows it under the session
			assert.deepStrictEqual(terminal.params.claim, { kind: TerminalClaimKind.Session, session: parseRequiredSessionUriFromChatUri(chat), chat: chat.toString(), turnId: 'turn-1', toolCallId: 'call-1' });
			assert.strictEqual(terminal.params.cwd, workingDirectory.fsPath);
			assert.strictEqual(terminal.params.name, 'Kodia Agent');
			assert.deepStrictEqual(terminal.options, { shell: '/bin/bash', preventShellHistory: true, nonInteractive: true });
		});

		test('numbers the terminals of a chat from 1, and reuses the smallest number that is free', async () => {
			const { manager, terminals } = create();

			assert.strictEqual((await open(terminals)).output, 'Successfully created persistent terminal. persistentTerminalId="1"');
			const second = await open(terminals);
			assert.strictEqual(second.output, 'Successfully created persistent terminal. persistentTerminalId="2"');
			assert.strictEqual(manager.created[1].params.name, 'Kodia Agent (2)');
			assert.strictEqual((await open(terminals, {}, callOf({ chat: otherChat }))).output, 'Successfully created persistent terminal. persistentTerminalId="1"', 'another chat has its own numbers');
			await kill(terminals, '1');
			assert.strictEqual((await open(terminals)).output, 'Successfully created persistent terminal. persistentTerminalId="1"');
			assert.strictEqual(new Set(manager.created.map(t => t.uri)).size, 4, 'each has a terminal of its own');
		});

		test('starts in the folder it is given, relative to the project', async () => {
			const dir = fs.mkdtempSync(join(os.tmpdir(), 'kodia-terminals-'));
			try {
				fs.mkdirSync(join(dir, 'web'));
				const { manager, terminals } = create();

				const result = await open(terminals, { cwd: 'web' }, callOf({ workingDirectory: URI.file(dir) }));

				assert.strictEqual(result.success, true);
				assert.strictEqual(terminalOf(manager).params.cwd, join(dir, 'web'));
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('says when the folder is not one, and opens nothing', async () => {
			const { manager, terminals } = create();

			const result = await open(terminals, { cwd: join(os.tmpdir(), 'kodia-terminals-missing') });

			assert.strictEqual(result.success, false);
			assert.match(result.output, /kodia-terminals-missing is not a folder\.$/);
			assert.deepStrictEqual(manager.created, []);
		});

		test('tells the model why a terminal could not start', async () => {
			const { manager, terminals } = create();
			manager.createTerminal = async () => { throw new Error('spawn /bin/bash ENOENT'); };

			assert.deepStrictEqual(await open(terminals), { success: false, output: 'spawn /bin/bash ENOENT' });
		});
	});

	suite('run_persistent_command', () => {

		test('returns the output of a command that ends within the wait, and its exit code', async () => {
			const { manager, terminals } = create();
			withDevServer(manager);
			await open(terminals);

			const result = await run(terminals, 'echo hi');

			assert.deepStrictEqual({ success: result.success, output: result.output }, { success: true, output: 'hi\n(exit code 0)' });
			assert.deepStrictEqual(terminalOf(manager).typed, ['echo hi']);
			// the window shows the terminal with the command, and what it printed when the terminal is gone
			assert.deepStrictEqual(result.terminal, { resource: terminalOf(manager).uri, title: 'Kodia Agent', exitCode: 0, preview: 'hi' });
		});

		test('is not a success when the command fails, and says it when there was no output', async () => {
			const { manager, terminals } = create();
			withDevServer(manager);
			await open(terminals);

			assert.deepStrictEqual(await run(terminals, 'false').then(r => ({ success: r.success, output: r.output })), { success: false, output: '(no output)\n(exit code 1)' });
		});

		test('takes the number of the terminal as a number too', async () => {
			const { manager, terminals } = create();
			withDevServer(manager);
			await open(terminals);

			assert.strictEqual((await run(terminals, 'echo hi', 1)).output, 'hi\n(exit code 0)');
		});

		test('leaves a command that outlasts the wait running, and returns its output so far without the line that was typed', async () => {
			const { manager, terminals } = create();
			withDevServer(manager);
			await open(terminals);

			const result = await run(terminals, 'npm run dev');

			assert.strictEqual(result.success, true);
			assert.ok(result.output.startsWith('ready on :3000\n'), result.output);
			assert.ok(!result.output.includes('npm run dev\r'), 'the echo of the line is not output');
			assert.match(result.output, /The command is running in terminal "1"\. The given output is what it printed in the first \d+ seconds\. Call run_persistent_command with an empty command to read what it prints next, or kill_persistent_terminal to stop it\.$/);
			assert.deepStrictEqual(manager.disposed, [], 'the terminal is left alone');
			assert.deepStrictEqual(result.terminal, { resource: terminalOf(manager).uri, title: 'Kodia Agent', preview: 'ready on :3000' });
		});

		test('returns what the command printed, not what the terminal echoed of the line, which it redraws when the line is long', async () => {
			const { manager, terminals } = create();
			manager.shell = (terminal, command) => {
				terminal.start(command, `${command}\r\n${command.slice(0, 20)}`);
				terminal.print('started\r\nserver ready\r\n');
			};
			await open(terminals);

			const result = await run(terminals, 'npm run dev -- --host 0.0.0.0 --port 3000');

			assert.ok(result.output.startsWith('started\nserver ready\nThe command is running'), result.output);
		});

		test('reads what a command that runs printed since the last call, with an empty command', async () => {
			const { manager, terminals } = create();
			withDevServer(manager);
			await open(terminals);
			await run(terminals, 'npm run dev');
			terminalOf(manager).print('GET / 200\r\nGET /about 200\r\n');

			const read = await run(terminals, '');

			assert.strictEqual(read.success, true);
			assert.strictEqual(read.pastTenseMessage, 'Read the output of terminal 1');
			assert.strictEqual(read.terminal, undefined, 'a read is no command: it has no terminal pill of its own');
			assert.ok(read.output.startsWith('GET / 200\nGET /about 200\n'), read.output);
			assert.match(read.output, /`npm run dev` is still running in terminal "1"\./);
			assert.ok(!read.output.includes('ready on'), 'what the model read is not read twice');
			assert.ok((await run(terminals, '')).output.startsWith('(no new output)\n'), 'and when nothing came, there is nothing new');
		});

		test('waits for the output when there is none yet, and for the burst to end', async () => {
			const { manager, terminals } = create();
			withDevServer(manager);
			await open(terminals);
			await run(terminals, 'npm run dev');
			const terminal = terminalOf(manager);

			const read = run(terminals, '');
			terminal.print('compiling...\r\n');
			terminal.print('compiled in 12ms\r\n');
			const result = await read;

			assert.ok(result.output.startsWith('compiling...\ncompiled in 12ms\n'), result.output);
		});

		test('says how the command ended when it ends while a call waits', async () => {
			const { manager, terminals } = create();
			withDevServer(manager);
			await open(terminals);
			await run(terminals, 'npm run dev');
			const terminal = terminalOf(manager);

			const read = run(terminals, '');
			terminal.print('Error: port in use\r\n');
			terminal.finish(2);
			const result = await read;

			assert.strictEqual(result.success, false);
			assert.ok(result.output.startsWith('Error: port in use'), result.output);
			assert.ok(result.output.endsWith('(exit code 2)'), result.output);
			// the terminal is free again
			assert.strictEqual((await run(terminals, 'echo hi')).output, 'hi\n(exit code 0)');
		});

		test('does not run another command in a terminal where one runs: it would be typed into the process', async () => {
			const { manager, terminals } = create();
			withDevServer(manager);
			await open(terminals);
			await run(terminals, 'npm run dev');

			const refused = await run(terminals, 'curl localhost:3000');

			assert.strictEqual(refused.success, false);
			assert.match(refused.output, /Terminal "1" is still running `npm run dev`, so it can't run another command\. Call run_persistent_command with an empty command to read what it prints, kill_persistent_terminal to stop it, or open_persistent_terminal for a terminal of its own\.$/);
			assert.strictEqual(refused.terminal, undefined, 'nothing ran: no terminal pill for it');
			assert.deepStrictEqual(terminalOf(manager).typed, ['npm run dev'], 'nothing was typed');

			// another terminal runs it
			await open(terminals);
			assert.strictEqual((await run(terminals, 'echo hi', '2')).output, 'hi\n(exit code 0)');
		});

		test('tells a command that ended on its own, with what it printed, before the next command runs', async () => {
			const { manager, terminals } = create();
			withDevServer(manager);
			await open(terminals);
			await run(terminals, 'npm run dev');
			const terminal = terminalOf(manager);
			terminal.print('shutting down\r\n');
			terminal.finish(0);

			const result = await run(terminals, 'echo hi');

			assert.ok(result.output.startsWith('shutting down'), result.output);
			assert.match(result.output, /`npm run dev` ended \(exit code 0\)\.\n\nhi\n\(exit code 0\)$/);
			assert.strictEqual(result.success, true);
		});

		test('says that nothing runs, when nothing does', async () => {
			const { manager, terminals } = create();
			withDevServer(manager);
			await open(terminals);

			assert.deepStrictEqual((await run(terminals, '')).output, 'Nothing is running in this terminal.', 'what the shell printed on starting is not the model\'s');
			await run(terminals, 'echo hi');
			assert.deepStrictEqual((await run(terminals, '   ')).output, 'Nothing is running in this terminal.');
		});

		test('says which terminals are open when the number is not one', async () => {
			const { manager, terminals } = create();
			withDevServer(manager);
			assert.deepStrictEqual(await run(terminals, 'echo hi', '1'), { success: false, output: 'Terminal with ID 1 does not exist. No terminal is open. Open one with open_persistent_terminal.' });

			await open(terminals);
			await open(terminals);
			const result = await run(terminals, 'echo hi', '7');
			assert.deepStrictEqual({ success: result.success, output: result.output }, { success: false, output: 'Terminal with ID 7 does not exist. The terminals that are open: 1, 2. Open one with open_persistent_terminal.' });
			assert.deepStrictEqual(manager.created.map(t => t.typed), [[], []]);

			assert.strictEqual((await run(terminals, 'echo hi', '1', callOf({ chat: otherChat }))).success, false, 'the terminals are those of the chat');
		});

		test('says when the shell exits, and forgets the terminal', async () => {
			const { manager, terminals } = create();
			manager.shell = (terminal, command) => {
				terminal.start(command);
				terminal.print('logout\r\n');
				terminal.exit(130);
			};
			await open(terminals);

			const result = await run(terminals, 'exit');

			assert.strictEqual(result.success, false);
			assert.match(result.output, /logout\nThe shell of terminal "1" exited with code 130\. Open another terminal with open_persistent_terminal\.$/);
			assert.deepStrictEqual(manager.disposed, [terminalOf(manager).uri]);
			assert.match((await run(terminals, 'echo hi')).output, /^Terminal with ID 1 does not exist\./);
		});

		test('forgets a terminal the host no longer has', async () => {
			const { manager, terminals } = create();
			withDevServer(manager);
			await open(terminals);
			manager.terminals.clear();

			assert.match((await run(terminals, 'echo hi')).output, /^Terminal with ID 1 does not exist\. No terminal is open\./);
		});

		test('stops waiting when the user stops the turn', async () => {
			const { manager, terminals } = create();
			withDevServer(manager);
			await open(terminals);
			const abort = new AbortController();
			setTimeout(() => abort.abort(), 5);

			const result = await terminals.execute('run_persistent_command', JSON.stringify({ command: 'npm run dev', persistent_terminal_id: '1' }), callOf({ signal: abort.signal }));

			assert.deepStrictEqual({ success: result.success, output: result.output }, { success: false, output: 'The turn was stopped.' });
			assert.deepStrictEqual(manager.disposed, [], 'what to do with the terminal is the turn\'s to say');
			// the wait that was left ends by itself: the command goes on in the terminal
			await new Promise(resolve => setTimeout(resolve, 60));
		});

		test('does not tell that a command is still running when nothing could say when it ends', async () => {
			// without shell integration the terminal can't tell when a command ends: it is not held back for good
			const { manager, terminals } = create();
			manager.commandDetectionSupported = false;
			manager.shell = (terminal, command) => {
				const sentinel = /^echo "(<<<COPILOT_SENTINEL_\w+_EXIT_)\$\?>>>"$/.exec(command);
				if (sentinel) {
					if (terminal.typed.some(typed => typed === 'echo hi')) {
						terminal.print(`${sentinel[1]}0>>>\r\n`);
					}
					return;
				}
				terminal.print(`${command}\r\n`);
				if (command === 'echo hi') {
					terminal.print('hi\r\n');
				} else if (command === 'npm run dev') {
					terminal.print('ready on :3000\r\n');
				}
			};
			await open(terminals);

			const started = await run(terminals, 'npm run dev');
			assert.ok(started.output.includes('ready on :3000'), started.output);

			const next = await run(terminals, 'echo hi');
			assert.strictEqual(next.success, true);
			assert.ok(next.output.endsWith('(exit code 0)'), next.output);
		});
	});

	suite('kill_persistent_terminal', () => {

		test('interrupts the command that runs and closes the terminal, and says what it printed that the model has not read', async () => {
			const { manager, terminals } = create();
			withDevServer(manager);
			await open(terminals);
			await run(terminals, 'npm run dev');
			terminalOf(manager).print('Error: EADDRINUSE\r\n');

			const result = await kill(terminals);

			assert.deepStrictEqual(result, { success: true, output: 'Successfully closed terminal "1".\nWhat it printed since you last read it:\nError: EADDRINUSE', pastTenseMessage: 'Closed terminal 1' });
			assert.deepStrictEqual(terminalOf(manager).written, ['\x03'], 'Ctrl+C');
			assert.deepStrictEqual(manager.disposed, [terminalOf(manager).uri]);
			assert.match((await run(terminals, 'echo hi')).output, /^Terminal with ID 1 does not exist\./);
		});

		test('closes an idle terminal without interrupting anything', async () => {
			const { manager, terminals } = create();
			await open(terminals);

			assert.deepStrictEqual(await kill(terminals, 1), { success: true, output: 'Successfully closed terminal "1".', pastTenseMessage: 'Closed terminal 1' });
			assert.deepStrictEqual(terminalOf(manager).written, []);
			assert.deepStrictEqual(manager.disposed, [terminalOf(manager).uri]);
		});

		test('says when there is no such terminal', async () => {
			const { manager, terminals } = create();
			await open(terminals);

			assert.deepStrictEqual(await kill(terminals, '4'), { success: false, output: 'Kill Terminal: Terminal with ID 4 did not exist. The terminals that are open: 1.' });
			assert.deepStrictEqual(await kill(terminals, '1', callOf({ chat: otherChat })), { success: false, output: 'Kill Terminal: Terminal with ID 1 did not exist. No terminal is open.' });
			assert.deepStrictEqual(manager.disposed, [], 'a terminal of another chat is not closed');
		});
	});

	suite('shutting down', () => {

		async function openThree(terminals: KodiaTerminals) {
			await open(terminals, {}, callOf({ turnId: 'turn-1' }));
			await open(terminals, {}, callOf({ turnId: 'turn-1' }));
			await open(terminals, {}, callOf({ turnId: 'turn-2' }));
			await open(terminals, {}, callOf({ chat: otherChat, turnId: 'turn-2' }));
		}

		test('a chat shuts down its terminals, and no other chat\'s', async () => {
			const { manager, terminals } = create();
			await openThree(terminals);

			terminals.shutdownChat(chat);

			assert.deepStrictEqual(manager.disposed.sort(), manager.created.slice(0, 3).map(t => t.uri).sort());
			assert.ok(manager.terminals.has(terminalOf(manager, 3).uri));
			assert.strictEqual((await run(terminals, 'echo hi', '1')).success, false);
			assert.strictEqual((await run(terminals, 'echo hi', '1', callOf({ chat: otherChat }))).success, true);
		});

		test('a turn shuts down the terminals it opened', async () => {
			const { manager, terminals } = create();
			await openThree(terminals);

			terminals.shutdownChat(chat, 'turn-2');

			assert.deepStrictEqual(manager.disposed, [terminalOf(manager, 2).uri]);
			assert.strictEqual((await run(terminals, 'echo hi', '1')).success, true);
			assert.strictEqual((await run(terminals, 'echo hi', '3')).success, false);
		});

		test('shutting down kills the processes of the terminals', async () => {
			const { manager, terminals } = create();
			withDevServer(manager);
			await open(terminals);
			await run(terminals, 'npm run dev');

			terminals.shutdownChat(chat);

			assert.deepStrictEqual(manager.disposed, [terminalOf(manager).uri]);
			assert.strictEqual(manager.terminals.size, 0);
		});

		test('stopping the host shuts down every terminal', async () => {
			const { manager, terminals } = create();
			await openThree(terminals);

			terminals.dispose();

			assert.deepStrictEqual(manager.disposed.sort(), manager.created.map(t => t.uri).sort());
			assert.strictEqual(manager.terminals.size, 0);
		});
	});
});
