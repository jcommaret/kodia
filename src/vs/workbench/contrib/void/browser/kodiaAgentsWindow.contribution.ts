/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// What the Agents Window loads of Kodia, so that it works with no editor window open: Kodia's
// settings and LLM service, which run the Kodia agent's model requests, and what the agent host
// reads from Kodia's settings (the Mistral key, the models shown in Kodia's dropdown).
// Editor windows load all of Kodia (void.contribution.ts).

import '../common/voidSettingsService.js'
import '../common/metricsService.js'
import '../common/mlxService.js'
import '../common/sendLLMMessageService.js'
import './kodiaAgentHostLmHandler.js'
import './mistralAgentHostKeyBridge.js'
import './agentHostShownModelsBridge.js'
