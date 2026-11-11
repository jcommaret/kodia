/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import type { Event } from '../../../base/common/event.js';
import type { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import type { ILogService } from '../../log/common/log.js';
import type { IByokLmBridgeConnection, IKodiaMcpTool, IKodiaMcpToolResult } from './agentHostByokLm.js';
import { AgentHostClientByokLmChannel, createAgentHostClientByokLmConnection } from './agentHostClientByokLmChannel.js';
import type { IKodiaAgentHostLmHandler } from './kodiaAgentHostLm.js';

/**
 * Node side of the Kodia reverse channel: the BYOK bridge's connection, plus the MCP tools of the Kodia window.
 * The BYOK bridge's own connection has no MCP calls, which only a Kodia window answers.
 */
export function createKodiaAgentHostLmConnection(channel: IChannel): IByokLmBridgeConnection {
	return {
		...createAgentHostClientByokLmConnection(channel),
		listMcpTools: token => channel.call('mcpTools', undefined, token) as Promise<IKodiaMcpTool[]>,
		callMcpTool: (name, argsJson, token) => channel.call('callMcpTool', { name, argsJson }, token) as Promise<IKodiaMcpToolResult>,
	};
}

/**
 * Window side: the BYOK bridge's channel, which serves the model requests, plus the MCP tools of the window's MCP
 * servers.
 */
export class KodiaAgentHostLmChannel implements IServerChannel {

	private readonly _models: AgentHostClientByokLmChannel;

	constructor(
		private readonly _handler: IKodiaAgentHostLmHandler,
		logService: ILogService,
	) {
		this._models = new AgentHostClientByokLmChannel(_handler, logService);
	}

	listen<T>(ctx: unknown, event: string): Event<T> {
		return this._models.listen<T>(ctx, event);
	}

	async call<T>(ctx: unknown, command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T> {
		const token = cancellationToken ?? CancellationToken.None;
		switch (command) {
			case 'mcpTools':
				return await this._handler.listMcpTools(token) as T;
			case 'callMcpTool': {
				const { name, argsJson } = arg as { name: string; argsJson: string };
				return await this._handler.callMcpTool(name, argsJson, token) as T;
			}
		}
		return this._models.call<T>(ctx, command, arg, cancellationToken);
	}
}
