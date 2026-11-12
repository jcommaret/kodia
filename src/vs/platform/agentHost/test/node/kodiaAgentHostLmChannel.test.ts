/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import type { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import type { IByokLmChatDelta, IByokLmChatRequest, IByokLmChatResult, IKodiaMcpTool } from '../../common/agentHostByokLm.js';
import type { IKodiaAgentHostLmHandler } from '../../common/kodiaAgentHostLm.js';
import { createKodiaAgentHostLmConnection, KodiaAgentHostLmChannel } from '../../common/kodiaAgentHostLmChannel.js';

suite('kodiaAgentHostLmChannel', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const search: IKodiaMcpTool = { name: 'x1y2_search', displayName: 'search', serverName: 'github', description: 'Search issues.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } };

	/** The window's handler: it records what it was asked, and the token it was given. */
	function handler() {
		const seen = { chat: [] as IByokLmChatRequest[], streams: [] as { request: IByokLmChatRequest; onDelta: (delta: IByokLmChatDelta) => void; token: CancellationToken; answer: (result: IByokLmChatResult) => void }[], calls: [] as { name: string; argsJson: string }[], editorCalls: [] as { name: string; argsJson: string }[], tokens: [] as CancellationToken[] };
		const handler: IKodiaAgentHostLmHandler = {
			_serviceBrand: undefined,
			chat: async request => { seen.chat.push(request); return { output: [] }; },
			// a request that waits for the test to answer it, after the deltas it sends
			chatStream: (request, onDelta, token) => new Promise<IByokLmChatResult>(answer => { seen.streams.push({ request, onDelta, token, answer }); }),
			listModels: async () => [],
			listMcpTools: async token => { seen.tokens.push(token); return [search]; },
			callMcpTool: async (name, argsJson, token) => { seen.calls.push({ name, argsJson }); seen.tokens.push(token); return { isError: false, output: `ran ${name}` }; },
			getAutoApprove: async token => { seen.tokens.push(token); return { edits: true, terminal: false }; },
			listEditorTools: async token => { seen.tokens.push(token); return ['go_to_definition', 'read_lint_errors']; },
			callEditorTool: async (name, argsJson, token) => { seen.editorCalls.push({ name, argsJson }); seen.tokens.push(token); return { isError: false, output: `ran ${name}` }; },
		};
		return { handler, seen };
	}

	/** The node-side connection wired straight to the window's channel, standing in for the IPC transport. */
	function bridge(h: IKodiaAgentHostLmHandler) {
		const server = new KodiaAgentHostLmChannel(h, new NullLogService());
		const channel: IChannel = {
			call<T>(command: string, arg?: unknown, token?: CancellationToken): Promise<T> {
				return server.call<T>(null, command, arg, token);
			},
			listen<T>(event: string, arg?: unknown): Event<T> {
				return (listener, thisArgs?, disposables?) => server.listen<T>(null, event, arg)(listener, thisArgs, disposables);
			},
		};
		return createKodiaAgentHostLmConnection(channel);
	}

	const request: IByokLmChatRequest = { vendor: 'gemini', modelId: 'gemini-3-pro', instructions: '', input: [] };
	const done: IByokLmChatResult = { output: [{ type: 'message', content: [{ type: 'text', text: 'Hello' }] }] };
	const tick = () => new Promise(resolve => setTimeout(resolve, 0));

	test('lists the window\'s MCP tools and runs one of them', async () => {
		const { handler: h, seen } = handler();
		const connection = bridge(h);

		assert.deepStrictEqual(await connection.listMcpTools!(), [search]);
		assert.deepStrictEqual(await connection.callMcpTool!('x1y2_search', '{"query":"bug"}'), { isError: false, output: 'ran x1y2_search' });
		assert.deepStrictEqual(seen.calls, [{ name: 'x1y2_search', argsJson: '{"query":"bug"}' }]);
	});

	test('asks the window what the user lets the agent do without asking', async () => {
		const { handler: h, seen } = handler();
		const connection = bridge(h);
		const cts = store.add(new CancellationTokenSource());

		assert.deepStrictEqual(await connection.getAutoApprove!(cts.token), { edits: true, terminal: false });
		assert.strictEqual(seen.tokens[0], cts.token);
	});

	test('asks the window which editor tools it can run, and has it run one', async () => {
		const { handler: h, seen } = handler();
		const connection = bridge(h);
		const cts = store.add(new CancellationTokenSource());

		assert.deepStrictEqual(await connection.listEditorTools!(cts.token), ['go_to_definition', 'read_lint_errors']);
		assert.deepStrictEqual(await connection.callEditorTool!('go_to_definition', '{"uri":"/a.ts","line":3,"symbol":"a"}', cts.token), { isError: false, output: 'ran go_to_definition' });
		assert.deepStrictEqual(seen.editorCalls, [{ name: 'go_to_definition', argsJson: '{"uri":"/a.ts","line":3,"symbol":"a"}' }]);
		assert.deepStrictEqual(seen.tokens, [cts.token, cts.token]);
	});

	test('gives the window\'s handler the caller\'s token, or none', async () => {
		const { handler: h, seen } = handler();
		const connection = bridge(h);
		const cts = store.add(new CancellationTokenSource());

		await connection.listMcpTools!();
		await connection.callMcpTool!('x1y2_search', '{}', cts.token);

		assert.strictEqual(seen.tokens[0], CancellationToken.None);
		assert.strictEqual(seen.tokens[1], cts.token);
	});

	test('still serves the model requests of the BYOK bridge', async () => {
		const { handler: h, seen } = handler();
		const connection = bridge(h);

		await connection.chat({ vendor: 'gemini', modelId: 'gemini-3-pro', instructions: '', input: [] });

		assert.strictEqual(seen.chat.length, 1);
		assert.strictEqual(seen.chat[0].vendor, 'gemini');
	});

	test('streams the text and the reasoning of a model request as the window writes them, then its result', async () => {
		const { handler: h, seen } = handler();
		const connection = bridge(h);
		const deltas: IByokLmChatDelta[] = [];

		const result = connection.chatStream!(request, delta => deltas.push(delta));
		while (seen.streams.length === 0) {
			await tick();
		}
		assert.deepStrictEqual(seen.streams[0].request, request);
		seen.streams[0].onDelta({ reasoning: 'Let me ' });
		seen.streams[0].onDelta({ reasoning: 'see.' });
		seen.streams[0].onDelta({ text: 'Hel' });
		assert.deepStrictEqual(deltas, [{ reasoning: 'Let me ' }, { reasoning: 'see.' }, { text: 'Hel' }], 'before the request ends');

		seen.streams[0].onDelta({ text: 'lo' });
		seen.streams[0].answer(done);
		assert.deepStrictEqual(await result, done);
		assert.deepStrictEqual(deltas.at(-1), { text: 'lo' });
		assert.strictEqual(seen.chat.length, 0, 'it is not a call of chat');
	});

	test('a request that fails in the window ends the stream with its error', async () => {
		const { handler: h } = handler();
		h.chatStream = async () => { throw new Error('boom'); };

		assert.deepStrictEqual(await bridge(h).chatStream!(request, () => { }), { output: [], error: 'boom' });
	});

	test('cancelling a streamed request rejects it at once and cancels the request in the window', async () => {
		const { handler: h, seen } = handler();
		const connection = bridge(h);
		const cts = store.add(new CancellationTokenSource());

		const result = connection.chatStream!(request, () => { }, cts.token);
		const rejected = assert.rejects(result, /Canceled/);
		while (seen.streams.length === 0) {
			await tick();
		}
		assert.strictEqual(seen.streams[0].token.isCancellationRequested, false);
		cts.cancel();

		await rejected;
		assert.strictEqual(seen.streams[0].token.isCancellationRequested, true);
	});

	test('a request cancelled before it starts never reaches the window', async () => {
		const { handler: h, seen } = handler();
		const connection = bridge(h);
		const cts = store.add(new CancellationTokenSource());
		cts.cancel();

		await assert.rejects(connection.chatStream!(request, () => { }, cts.token), /Canceled/);
		assert.strictEqual(seen.streams.length, 0);
	});

	test('a request is answered once, and what the window writes after is dropped', async () => {
		const { handler: h, seen } = handler();
		const deltas: IByokLmChatDelta[] = [];
		const result = bridge(h).chatStream!(request, delta => deltas.push(delta));
		while (seen.streams.length === 0) {
			await tick();
		}

		seen.streams[0].answer(done);
		await result;
		seen.streams[0].onDelta({ text: 'late' });

		assert.deepStrictEqual(deltas, []);
	});

	test('an older window, which has no stream, answers the request at the end, without deltas', async () => {
		const { handler: h, seen } = handler();
		const server = new KodiaAgentHostLmChannel(h, new NullLogService());
		const older: IChannel = {
			// the window of an older version: it doesn't know what it was not built with
			call<T>(command: string, arg?: unknown, token?: CancellationToken): Promise<T> {
				return command === 'chatStreaming' ? Promise.reject(new Error(`Unknown command '${command}'`)) : server.call<T>(null, command, arg, token);
			},
			listen<T>(event: string): Event<T> {
				if (event === 'models') {
					return Event.None;
				}
				throw new Error('an older window never answers an event it does not know');
			},
		};
		const deltas: IByokLmChatDelta[] = [];

		const connection = createKodiaAgentHostLmConnection(older);
		assert.deepStrictEqual(await connection.chatStream!(request, delta => deltas.push(delta)), { output: [] });
		await connection.chatStream!(request, delta => deltas.push(delta));

		assert.strictEqual(seen.chat.length, 2);
		assert.deepStrictEqual(deltas, []);
	});

	test('stops the request in the window when nobody listens to its stream any more', async () => {
		const { handler: h, seen } = handler();
		const server = new KodiaAgentHostLmChannel(h, new NullLogService());
		const events: unknown[] = [];

		const subscription = server.listen(null, 'chatStream', request)(e => events.push(e));
		await tick();
		seen.streams[0].onDelta({ text: 'Hel' });
		subscription.dispose();

		assert.strictEqual(seen.streams[0].token.isCancellationRequested, true);
		seen.streams[0].onDelta({ text: 'lo' });
		assert.deepStrictEqual(events, [{ delta: { text: 'Hel' } }]);
	});

	test('rejects an unknown command, and exposes only the models event', async () => {
		const server = new KodiaAgentHostLmChannel(handler().handler, new NullLogService());
		await assert.rejects(() => server.call(null, 'nope'), /Unknown command 'nope'/);
		assert.throws(() => server.listen(null, 'other'), /No event 'other'/);
	});
});
