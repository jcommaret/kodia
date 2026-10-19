/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { IAgentHostByokLmHandler } from './agentHostByokLm.js';

/**
 * Kodia: the Kodia agent runs, in the Agents Window, every model shown in
 * Kodia's model dropdown. The agent host cannot reach Kodia's providers itself
 * (their settings and keys live in the window), so it sends each model request
 * back to a Kodia window over this reverse channel, which reuses the BYOK
 * bridge's wire contract ({@link IAgentHostByokLmHandler}).
 */
export const KODIA_AGENT_HOST_LM_CHANNEL = 'kodiaAgentHostLm';

/**
 * Window-side handler serving the Kodia agent with Kodia's LLM service.
 * Registered only in Kodia's IDE windows; other windows serve nothing.
 */
export const IKodiaAgentHostLmHandler = createDecorator<IAgentHostByokLmHandler>('kodiaAgentHostLmHandler');

export const KODIA_AGENT_PROVIDER_ID = 'kodia';

/**
 * Protected resource the Kodia agent advertises with `required: false`, so the
 * Agents Window treats it as usable without signing in to GitHub. Nothing is
 * ever authenticated against it: Kodia's own settings hold the provider keys.
 */
export const KODIA_AGENT_RESOURCE = 'https://kodia.local/agent';
