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
import type { IByokLmChatRequest, IKodiaMcpTool } from '../../common/agentHostByokLm.js';
import type { IKodiaAgentHostLmHandler } from '../../common/kodiaAgentHostLm.js';
import { createKodiaAgentHostLmConnection, KodiaAgentHostLmChannel } from '../../common/kodiaAgentHostLmChannel.js';

suite('kodiaAgentHostLmChannel', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const search: IKodiaMcpTool = { name: 'x1y2_search', displayName: 'search', serverName: 'github', description: 'Search issues.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } };

	/** The window's handler: it records what it was asked, and the token it was given. */
	function handler() {
		const seen = { chat: [] as IByokLmChatRequest[], calls: [] as { name: string; argsJson: string }[], editorCalls: [] as { name: string; argsJson: string }[], tokens: [] as CancellationToken[] };
		const handler: IKodiaAgentHostLmHandler = {
			_serviceBrand: undefined,
			chat: async request => { seen.chat.push(request); return { output: [] }; },
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
			listen<T>(event: string): Event<T> {
				return (listener, thisArgs?, disposables?) => server.listen<T>(null, event)(listener, thisArgs, disposables);
			},
		};
		return createKodiaAgentHostLmConnection(channel);
	}

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

	test('rejects an unknown command, and exposes only the models event', async () => {
		const server = new KodiaAgentHostLmChannel(handler().handler, new NullLogService());
		await assert.rejects(() => server.call(null, 'nope'), /Unknown command 'nope'/);
		assert.throws(() => server.listen(null, 'other'), /No event 'other'/);
	});
});
