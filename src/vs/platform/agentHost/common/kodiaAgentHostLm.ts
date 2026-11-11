/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../../../base/common/cancellation.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { IAgentHostByokLmHandler, IKodiaAutoApprove, IKodiaMcpTool, IKodiaMcpToolResult } from './agentHostByokLm.js';

/**
 * Kodia: the Kodia agent runs, in the Agents Window, every model shown in
 * Kodia's model dropdown. The agent host cannot reach Kodia's providers itself
 * (their settings and keys live in the window), so it sends each model request
 * back to a Kodia window over this reverse channel, which reuses the BYOK
 * bridge's wire contract ({@link IAgentHostByokLmHandler}). The same window
 * holds the user's MCP servers, so the channel also carries their tools.
 */
export const KODIA_AGENT_HOST_LM_CHANNEL = 'kodiaAgentHostLm';

/**
 * Window-side handler serving the Kodia agent with Kodia's LLM service and MCP
 * servers. Registered in Kodia's editor windows and in the Agents Window, so the
 * agent runs with no editor window open.
 */
export interface IKodiaAgentHostLmHandler extends IAgentHostByokLmHandler {
	/** The tools of the MCP servers that are on. */
	listMcpTools(token: CancellationToken): Promise<IKodiaMcpTool[]>;
	/** Runs one MCP tool, by the name {@link listMcpTools} gave it. A failure is a result with `isError`, not a rejection. */
	callMcpTool(name: string, argsJson: string, token: CancellationToken): Promise<IKodiaMcpToolResult>;
	/** What the user lets run without asking, in Kodia's settings. */
	getAutoApprove(token: CancellationToken): Promise<IKodiaAutoApprove>;
}

export const IKodiaAgentHostLmHandler = createDecorator<IKodiaAgentHostLmHandler>('kodiaAgentHostLmHandler');

export const KODIA_AGENT_PROVIDER_ID = 'kodia';

/**
 * Protected resource the Kodia agent advertises with `required: false`, so the
 * Agents Window treats it as usable without signing in to GitHub. Nothing is
 * ever authenticated against it: Kodia's own settings hold the provider keys.
 */
export const KODIA_AGENT_RESOURCE = 'https://kodia.local/agent';
