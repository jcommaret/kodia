/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationError } from '../../../base/common/errors.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import type { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import type { ILogService } from '../../log/common/log.js';
import type { IByokLmBridgeConnection, IByokLmChatDelta, IByokLmChatRequest, IByokLmChatResult, IKodiaAutoApprove, IKodiaChatStreamEvent, IKodiaMcpTool, IKodiaMcpToolResult } from './agentHostByokLm.js';
import { AgentHostClientByokLmChannel, createAgentHostClientByokLmConnection } from './agentHostClientByokLmChannel.js';
import type { IKodiaAgentHostLmHandler } from './kodiaAgentHostLm.js';

/**
 * Node side of the Kodia reverse channel: the BYOK bridge's connection, plus the MCP tools of the Kodia window, what
 * its settings let the agent do without asking, the editor tools an editor window runs for it, and the model's text
 * as it is written.
 * The BYOK bridge's own connection has none of these calls, which only a Kodia window answers.
 */
export function createKodiaAgentHostLmConnection(channel: IChannel): IByokLmBridgeConnection {
	const connection = createAgentHostClientByokLmConnection(channel);

	// An older window has no `chatStream`, and an event it doesn't know is never answered: ask once, by a call, which an
	// older window rejects. The model requests then go as they did, and answer at the end.
	let streaming: Promise<boolean> | undefined;
	const canStream = () => streaming ??= (channel.call('chatStreaming') as Promise<boolean>).then(supported => supported === true, () => false);

	return {
		...connection,
		chatStream: async (request, onDelta, token) => {
			if (!await canStream()) {
				return connection.chat(request, token);
			}
			return streamChat(channel, request, onDelta, token);
		},
		listMcpTools: token => channel.call('mcpTools', undefined, token) as Promise<IKodiaMcpTool[]>,
		callMcpTool: (name, argsJson, token) => channel.call('callMcpTool', { name, argsJson }, token) as Promise<IKodiaMcpToolResult>,
		getAutoApprove: token => channel.call('autoApprove', undefined, token) as Promise<IKodiaAutoApprove>,
		listEditorTools: token => channel.call('editorTools', undefined, token) as Promise<string[]>,
		callEditorTool: (name, argsJson, token) => channel.call('callEditorTool', { name, argsJson }, token) as Promise<IKodiaMcpToolResult>,
	};
}

/**
 * A model request as a stream of events: the window sends the deltas as the model writes them, then the result. Like a
 * call, a cancelled request rejects at once, and the window is told to stop (it stops when the event is unsubscribed).
 */
function streamChat(channel: IChannel, request: IByokLmChatRequest, onDelta: (delta: IByokLmChatDelta) => void, token: CancellationToken | undefined): Promise<IByokLmChatResult> {
	if (token?.isCancellationRequested) {
		return Promise.reject(new CancellationError());
	}
	return new Promise<IByokLmChatResult>((resolve, reject) => {
		const store = new DisposableStore();
		store.add(channel.listen<IKodiaChatStreamEvent>('chatStream', request)(event => {
			if ('delta' in event) {
				onDelta(event.delta);
			} else {
				store.dispose();
				resolve(event.result);
			}
		}));
		if (token) {
			store.add(token.onCancellationRequested(() => {
				store.dispose();
				reject(new CancellationError());
			}));
		}
	});
}

/**
 * Window side: the BYOK bridge's channel, which serves the model requests, plus the MCP tools of the window's MCP
 * servers, the window's auto-approval settings and its editor tools.
 */
export class KodiaAgentHostLmChannel implements IServerChannel {

	private readonly _models: AgentHostClientByokLmChannel;

	constructor(
		private readonly _handler: IKodiaAgentHostLmHandler,
		logService: ILogService,
	) {
		this._models = new AgentHostClientByokLmChannel(_handler, logService);
	}

	listen<T>(ctx: unknown, event: string, arg?: unknown): Event<T> {
		if (event === 'chatStream') {
			return this._chatStreamEvent(arg as IByokLmChatRequest) as Event<T>;
		}
		return this._models.listen<T>(ctx, event);
	}

	/**
	 * A model request, as an event: it starts with the first subscriber, fires the deltas as the model writes them, then
	 * the result. When the subscriber goes (the agent stopped the turn) the request is cancelled.
	 */
	private _chatStreamEvent(request: IByokLmChatRequest): Event<IKodiaChatStreamEvent> {
		const cts = new CancellationTokenSource();
		const emitter = new Emitter<IKodiaChatStreamEvent>({
			onDidAddFirstListener: () => {
				this._handler.chatStream(request, delta => emitter.fire({ delta }), cts.token).then(
					result => emitter.fire({ result }),
					err => emitter.fire({ result: { output: [], error: err instanceof Error ? err.message : String(err) } }),
				);
			},
			onDidRemoveLastListener: () => {
				cts.dispose(true);
				emitter.dispose();
			},
		});
		return emitter.event;
	}

	async call<T>(ctx: unknown, command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T> {
		const token = cancellationToken ?? CancellationToken.None;
		switch (command) {
			case 'chatStreaming':
				return true as T;
			case 'mcpTools':
				return await this._handler.listMcpTools(token) as T;
			case 'autoApprove':
				return await this._handler.getAutoApprove(token) as T;
			case 'editorTools':
				return await this._handler.listEditorTools(token) as T;
			case 'callEditorTool': {
				const { name, argsJson } = arg as { name: string; argsJson: string };
				return await this._handler.callEditorTool(name, argsJson, token) as T;
			}
			case 'callMcpTool': {
				const { name, argsJson } = arg as { name: string; argsJson: string };
				return await this._handler.callMcpTool(name, argsJson, token) as T;
			}
		}
		return this._models.call<T>(ctx, command, arg, cancellationToken);
	}
}
