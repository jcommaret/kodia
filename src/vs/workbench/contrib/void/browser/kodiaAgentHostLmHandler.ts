/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import type { IAgentHostByokLmHandler, IByokLmChatRequest, IByokLmChatResult, IByokLmModelInfo } from '../../../../platform/agentHost/common/agentHostByokLm.js';
import { IKodiaAgentHostLmHandler } from '../../../../platform/agentHost/common/kodiaAgentHostLm.js';
import { toInternalTool, toOutput, toSimpleMessages, toUsage } from '../common/kodiaAgentHostLmMessages.js';
import { getModelCapabilities } from '../common/modelCapabilities.js';
import { toolsXMLSystemPrompt } from '../common/prompt/prompts.js';
import { IMlxService } from '../common/mlxService.js';
import { prepareSimpleLLMMessages } from '../common/prepareLLMMessages.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { displayInfoOfProviderName, ModelSelection, ProviderName, providerNames } from '../common/voidSettingsTypes.js';

/**
 * Serves the Kodia agent of the Agents Window with Kodia's own LLM service, so
 * it can run every model shown in Kodia's model dropdown, whatever its
 * provider. See {@link IKodiaAgentHostLmHandler}. Editor windows and the
 * Agents Window both register it (see `kodiaAgentsWindow.contribution.ts`).
 */
class KodiaAgentHostLmHandler extends Disposable implements IAgentHostByokLmHandler {
	declare readonly _serviceBrand: undefined;

	readonly onDidChangeModels: Event<void>;

	constructor(
		@IVoidSettingsService private readonly _voidSettingsService: IVoidSettingsService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IMlxService private readonly _mlxService: IMlxService,
	) {
		super();
		this.onDidChangeModels = this._voidSettingsService.onDidChangeState;
	}

	async listModels(): Promise<IByokLmModelInfo[]> {
		await this._voidSettingsService.waitForInitState;
		// `_modelOptions` is every model switched on for a provider that is set up
		// ("Show in Dropdown" in Kodia settings): Gemini, MLX, OpenRouter, and the rest.
		const { _modelOptions, overridesOfModel } = this._voidSettingsService.state;
		return _modelOptions.map(({ name, selection: { providerName, modelName } }) => {
			const { contextWindow, supportsVision } = getModelCapabilities(providerName, modelName, overridesOfModel);
			const providerTitle = displayInfoOfProviderName(providerName).title;
			const label = name.includes(providerTitle) ? name : `${providerTitle} · ${name}`;
			return { vendor: providerName, id: modelName, name: label, maxContextWindowTokens: contextWindow, supportsVision: !!supportsVision };
		});
	}

	async chat(request: IByokLmChatRequest, token: CancellationToken): Promise<IByokLmChatResult> {
		if (!(providerNames as readonly string[]).includes(request.vendor)) {
			return { output: [], error: `Unknown Kodia provider: ${request.vendor}` };
		}
		const modelSelection: ModelSelection = { providerName: request.vendor as ProviderName, modelName: request.modelId };
		// An editor window starts Kodia's MLX server; the Agents Window may be the only window open.
		if (modelSelection.providerName === 'mlx' && this._voidSettingsService.state.globalSettings.autoSetupMlx) {
			await this._mlxService.ensureReady({ installIfMissing: false, startServer: true }).catch(() => undefined);
		}
		const { overridesOfModel, optionsOfModelSelection, globalSettings } = this._voidSettingsService.state;
		const tools = request.tools?.flatMap(toInternalTool) ?? [];
		// Models without native tool calling are taught the XML format in the system message.
		const { specialToolFormat } = getModelCapabilities(modelSelection.providerName, modelSelection.modelName, overridesOfModel);
		const systemMessage = [request.instructions, specialToolFormat ? null : toolsXMLSystemPrompt(tools)].filter(Boolean).join('\n\n');
		const { messages, separateSystemMessage } = prepareSimpleLLMMessages({
			simpleMessages: toSimpleMessages(request.input),
			systemMessage,
			// The agent works on its session's folder, not on an editor window's workspace, whose rules and memory don't apply.
			aiInstructions: globalSettings.aiInstructions,
			modelSelection,
			featureName: 'Chat',
			overridesOfModel,
			optionsOfModelSelection,
		});

		return new Promise<IByokLmChatResult>(resolve => {
			let requestId: string | null = null;
			const cancellation = token.onCancellationRequested(() => {
				if (requestId) {
					this._llmMessageService.abort(requestId);
				}
			});
			const settle = (result: IByokLmChatResult) => {
				cancellation.dispose();
				resolve(result);
			};
			requestId = this._llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages,
				separateSystemMessage,
				// Agent mode, with exactly the agent's own tools (it runs them itself).
				chatMode: 'agent',
				tools,
				modelSelection,
				modelSelectionOptions: optionsOfModelSelection.Chat[modelSelection.providerName]?.[modelSelection.modelName],
				overridesOfModel,
				logging: { loggingName: 'Agents Window' },
				onText: () => { },
				onFinalMessage: final => settle({ output: toOutput(final), usage: toUsage(final.usage) }),
				onError: ({ message }) => settle({ output: [], error: message }),
				onAbort: () => settle({ output: [], error: 'Cancelled' }),
			});
		});
	}
}

registerSingleton(IKodiaAgentHostLmHandler, KodiaAgentHostLmHandler, InstantiationType.Delayed);
