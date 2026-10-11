/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// disable foreign import complaints
/* eslint-disable */
import Anthropic from '@anthropic-ai/sdk';
import { Ollama } from 'ollama';
import OpenAI, { ClientOptions, AzureOpenAI } from 'openai';
import { MistralCore } from '@mistralai/mistralai/core.js';
import { fimComplete } from '@mistralai/mistralai/funcs/fimComplete.js';
import { Tool as GeminiTool, FunctionDeclaration, GoogleGenAI, ThinkingConfig, Schema, Type } from '@google/genai';
import { GoogleAuth } from 'google-auth-library'
/* eslint-enable */

import { AnthropicLLMChatMessage, GeminiLLMChatMessage, LLMChatMessage, LLMFIMMessage, LLMUsage, ModelListParams, OllamaModelResponse, OnError, OnFinalMessage, OnText, RawToolCallObj, RawToolParamsObj } from '../../common/sendLLMMessageTypes.js';
import { ChatMode, displayInfoOfProviderName, ModelSelectionOptions, OverridesOfModel, ProviderName, SettingsOfProvider } from '../../common/voidSettingsTypes.js';
import { getSendableReasoningInfo, getModelCapabilities, getProviderCapabilities, defaultProviderSettings, getReservedOutputTokenSpace } from '../../common/modelCapabilities.js';
import { extractReasoningWrapper, extractXMLToolsWrapper } from './extractGrammar.js';
import { availableTools, InternalToolInfo } from '../../common/prompt/prompts.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { estimateTokens } from '../../common/tokenizer.js';

const getGoogleApiKey = async () => {
	// module‑level singleton
	const auth = new GoogleAuth({ scopes: `https://www.googleapis.com/auth/cloud-platform` });
	const key = await auth.getAccessToken()
	if (!key) throw new Error(`Google API failed to generate a key.`)
	return key
}




type InternalCommonMessageParams = {
	onText: OnText;
	onFinalMessage: OnFinalMessage;
	onError: OnError;
	providerName: ProviderName;
	settingsOfProvider: SettingsOfProvider;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;
	modelName: string;
	_setAborter: (aborter: () => void) => void;
}

type SendChatParams_Internal = InternalCommonMessageParams & {
	messages: LLMChatMessage[];
	separateSystemMessage: string | undefined;
	chatMode: ChatMode | null;
	mcpTools: InternalToolInfo[] | undefined;
}
type SendFIMParams_Internal = InternalCommonMessageParams & { messages: LLMFIMMessage; separateSystemMessage: string | undefined; }
export type ListParams_Internal<ModelResponse> = ModelListParams<ModelResponse>


const invalidApiKeyMessage = (providerName: ProviderName) => `Invalid ${displayInfoOfProviderName(providerName).title} API key.`

/**
 * `fm serve` lists "pcc" in /v1/models but 503s on it with "PCC inference is not available in this
 * context" when `fm serve` was spawned detached (setsid) from Kodia's own session — see the spawn
 * fix in appleFoundationModelsMainService.ts. If this still surfaces after that fix, it's a genuine
 * Apple-side condition (Apple Intelligence/PCC eligibility, quota, or transient PCC node
 * availability) rather than something Kodia's request shape controls, so explain instead of showing
 * the raw JSON error.
 */
const applePCCUnavailableMessage = () => `Kodia: Apple's Private Cloud Compute ("pcc" model) rejected this request. If this persists, check Apple Intelligence & Siri in System Settings, or use the "system" (fully on-device) model instead.`
const isApplePCCUnavailableError = (providerName: ProviderName, error: unknown): boolean =>
	providerName === 'appleFoundationModels'
	&& error instanceof OpenAI.APIError
	&& error.status === 503
	&& /PCC inference is not available/i.test(error.message ?? '')

/** The OpenAI SDK only reads JSON `error.message`; Mistral often returns FastAPI-shaped `detail`/`message`. Without this remap: "422 status code (no body)". */
const openAICompatibleErrorMessageFromParsedBody = (parsed: unknown, rawText: string, status: number): string => {
	if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
		const o = parsed as Record<string, unknown>
		const nested = typeof o.error === 'object' && o.error !== null ? (o.error as { message?: unknown }).message : undefined
		if (typeof nested === 'string') return nested
		if (typeof o.message === 'string') return o.message
		if (typeof o.detail === 'string') return o.detail
		if (Array.isArray(o.detail)) {
			return o.detail.map((item: unknown) => {
				if (item && typeof item === 'object' && typeof (item as { msg?: unknown }).msg === 'string') return (item as { msg: string }).msg
				try { return JSON.stringify(item) } catch { return String(item) }
			}).join('; ')
		}
	}
	const t = (rawText || '').trim()
	if (t.length) return t.length > 4000 ? t.slice(0, 3997) + '...' : t
	return `HTTP ${status}`
}

type OpenAIClientFetchArgs = Parameters<NonNullable<ClientOptions['fetch']>>

/** OpenAI typings use node-fetch shapes in Node; Electron uses global fetch — bridge with explicit casts. */
const openAITolerantFetch = (async (url: OpenAIClientFetchArgs[0], init?: OpenAIClientFetchArgs[1]) => {
	const res = await globalThis.fetch(
		url as string | URL | Request,
		init as Parameters<typeof globalThis.fetch>[1],
	)
	if (res.ok)
		return res
	const rawText = await res.text().catch(() => '')
	let parsed: unknown
	try {
		parsed = rawText ? JSON.parse(rawText) : undefined
	} catch {
		parsed = undefined
	}
	const message = openAICompatibleErrorMessageFromParsedBody(parsed, rawText, res.status)
	return new Response(JSON.stringify({ error: { message } }), {
		status: res.status,
		statusText: res.statusText,
		headers: res.headers,
	})
}) as unknown as NonNullable<ClientOptions['fetch']>

// ------------ OPENAI-COMPATIBLE (HELPERS) ------------



const parseHeadersJSON = (s: string | undefined): Record<string, string | null | undefined> | undefined => {
	if (!s) return undefined
	try {
		return JSON.parse(s)
	} catch (e) {
		throw new Error(`Error parsing OpenAI-Compatible headers: ${s} is not a valid JSON.`)
	}
}

const newOpenAICompatibleSDK = async ({ settingsOfProvider, providerName }: { settingsOfProvider: SettingsOfProvider, providerName: ProviderName }) => {
	// Pick only the fields we actually set: typing this as the full ClientOptions would spread
	// every optional field (e.g. openai v6's nullable `apiKey`, the new `provider`) into the
	// AzureOpenAI construction below, which declares stricter `apiKey`/`provider` types.
	const commonPayloadOpts: Pick<ClientOptions, 'dangerouslyAllowBrowser' | 'fetch'> = {
		dangerouslyAllowBrowser: true,
		fetch: openAITolerantFetch,
	}
	if (providerName === 'openAI') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'ollama') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'vLLM') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'liteLLM') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'lmStudio') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'mlx') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'appleFoundationModels') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'openRouter') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({
			baseURL: 'https://openrouter.ai/api/v1',
			apiKey: thisConfig.apiKey,
			defaultHeaders: {
				'HTTP-Referer': 'https://voideditor.com', // Optional, for including your app on openrouter.ai rankings.
				'X-Title': 'Kodia', // Optional. Shows in rankings on openrouter.ai.
			},
			...commonPayloadOpts,
		})
	}
	else if (providerName === 'googleVertex') {
		// https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-vertex-using-openai-library
		const thisConfig = settingsOfProvider[providerName]
		const baseURL = `https://${thisConfig.region}-aiplatform.googleapis.com/v1/projects/${thisConfig.project}/locations/${thisConfig.region}/endpoints/${'openapi'}`
		const apiKey = await getGoogleApiKey()
		return new OpenAI({ baseURL: baseURL, apiKey: apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'microsoftAzure') {
		// https://learn.microsoft.com/en-us/rest/api/aifoundry/model-inference/get-chat-completions/get-chat-completions?view=rest-aifoundry-model-inference-2024-05-01-preview&tabs=HTTP
		//  https://github.com/openai/openai-node?tab=readme-ov-file#microsoft-azure-openai
		const thisConfig = settingsOfProvider[providerName]
		const endpoint = `https://${thisConfig.project}.openai.azure.com/`;
		const apiVersion = thisConfig.azureApiVersion ?? '2024-04-01-preview';
		const options = { endpoint, apiKey: thisConfig.apiKey, apiVersion };
		return new AzureOpenAI({ ...options, ...commonPayloadOpts });
	}
	else if (providerName === 'awsBedrock') {
		/**
		  * We treat Bedrock as *OpenAI-compatible only through a proxy*:
		  *   • LiteLLM default → http://localhost:4000/v1
		  *   • Bedrock-Access-Gateway → https://<api-id>.execute-api.<region>.amazonaws.com/openai/
		  *
		  * The native Bedrock runtime endpoint
		  *   https://bedrock-runtime.<region>.amazonaws.com
		  * is **NOT** OpenAI-compatible, so we do *not* fall back to it here.
		  */
		const { endpoint, apiKey } = settingsOfProvider.awsBedrock

		// ① use the user-supplied proxy if present
		// ② otherwise default to local LiteLLM
		let baseURL = endpoint || 'http://localhost:4000/v1'

		// Normalize: make sure we end with “/v1”
		if (!baseURL.endsWith('/v1'))
			baseURL = baseURL.replace(/\/+$/, '') + '/v1'

		return new OpenAI({ baseURL, apiKey, ...commonPayloadOpts })
	}


	else if (providerName === 'deepseek') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.deepseek.com/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'openAICompatible') {
		const thisConfig = settingsOfProvider[providerName]
		const headers = parseHeadersJSON(thisConfig.headersJSON)
		return new OpenAI({ baseURL: thisConfig.endpoint, apiKey: thisConfig.apiKey, defaultHeaders: headers, ...commonPayloadOpts })
	}
	else if (providerName === 'groq') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.groq.com/openai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'xAI') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.x.ai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'mistral') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.mistral.ai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}

	else throw new Error(`Kodia providerName was invalid: ${providerName}.`)
}


const _sendOpenAICompatibleFIM = async ({ messages: { prefix, suffix, stopTokens }, onFinalMessage, onError, settingsOfProvider, modelName: modelName_, _setAborter, providerName, overridesOfModel }: SendFIMParams_Internal) => {

	const {
		modelName,
		supportsFIM,
		additionalOpenAIPayload,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	if (!supportsFIM) {
		if (modelName === modelName_)
			onError({ message: `Model ${modelName} does not support FIM.`, fullError: null })
		else
			onError({ message: `Model ${modelName_} (${modelName}) does not support FIM.`, fullError: null })
		return
	}

	const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider })
	openai.completions
		.create({
			model: modelName,
			prompt: prefix,
			suffix: suffix,
			stop: stopTokens,
			max_tokens: 300,
			...additionalOpenAIPayload,
		})
		.then(async response => {
			const fullText = response.choices[0]?.text
			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null });
		})
		.catch(error => {
			if (error instanceof OpenAI.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: error }); }
			else { onError({ message: error + '', fullError: error }); }
		})
}


const toOpenAICompatibleTool = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo

	const paramsWithType: { [s: string]: { description: string; type: 'string' } } = {}
	for (const key in params) { paramsWithType[key] = { ...params[key], type: 'string' } }

	return {
		type: 'function',
		function: {
			name: name,
			// strict: true, // strict mode - https://platform.openai.com/docs/guides/function-calling?api-mode=chat
			description: description,
			parameters: {
				type: 'object',
				properties: paramsWithType,
				// required: Object.keys(params), // in strict mode, all params are required and additionalProperties is false
				// additionalProperties: false,
			},
		}
	} satisfies OpenAI.Chat.Completions.ChatCompletionTool
}

const openAITools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined) => {
	const allowedTools = availableTools(chatMode, mcpTools)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null

	const openAITools: OpenAI.Chat.Completions.ChatCompletionTool[] = []
	for (const t in allowedTools ?? {}) {
		openAITools.push(toOpenAICompatibleTool(allowedTools[t]))
	}
	return openAITools
}


// convert LLM tool call to our tool format
const rawToolCallObjOfParamsStr = (name: string, toolParamsStr: string, id: string): RawToolCallObj | null => {
	let input: unknown
	try { input = JSON.parse(toolParamsStr) }
	catch (e) { return null }

	if (input === null) return null
	if (typeof input !== 'object') return null

	const rawParams: RawToolParamsObj = input
	return { id, name, rawParams, doneParams: Object.keys(rawParams), isDone: true }
}


// a tool call whose name/id/params arrive in pieces while streaming
type StreamedToolCall = { name: string; id: string; paramsStr: string }

// the call currently being generated (the latest one), for display while streaming
const streamingToolCallOf = (calls: StreamedToolCall[]): RawToolCallObj | undefined => {
	for (let i = calls.length - 1; i >= 0; i -= 1) {
		const t = calls[i] // may be a hole if indexes arrive out of order
		if (t?.name) return { name: t.name, rawParams: {}, isDone: false, doneParams: [], id: t.id }
	}
	return undefined
}

// calls whose params aren't valid JSON are dropped, as before
const finalToolCallsOf = (calls: StreamedToolCall[]): RawToolCallObj[] =>
	calls.filter(t => !!t?.name)
		.map(t => rawToolCallObjOfParamsStr(t.name, t.paramsStr, t.id))
		.filter((t): t is RawToolCallObj => t !== null)

const rawToolCallObjOfAnthropicParams = (toolBlock: Anthropic.Messages.ToolUseBlock): RawToolCallObj | null => {
	const { id, name, input } = toolBlock

	if (input === null) return null
	if (typeof input !== 'object') return null

	const rawParams: RawToolParamsObj = input
	return { id, name, rawParams, doneParams: Object.keys(rawParams), isDone: true }
}


// ------------ OPENAI-COMPATIBLE ------------

// Most OpenAI-compatible providers return `delta.content` as a plain string. Some (notably Mistral's
// magistral reasoning models) instead return an array of content chunks, e.g.
//   [{ type: 'thinking', thinking: [{ type: 'text', text: '...' }] }, { type: 'text', text: '...' }]
// Concatenating that array directly coerces each object to "[object Object]" in the chat, so split it
// into plain text + reasoning here.
const parseOpenAICompatibleDeltaContent = (content: unknown): { text: string; reasoning: string } => {
	if (content == null) return { text: '', reasoning: '' }
	if (typeof content === 'string') return { text: content, reasoning: '' }
	if (!Array.isArray(content)) return { text: '', reasoning: '' }

	const chunkText = (chunk: unknown): string => {
		if (typeof chunk === 'string') return chunk
		if (chunk && typeof chunk === 'object' && typeof (chunk as { text?: unknown }).text === 'string') return (chunk as { text: string }).text
		return ''
	}

	let text = ''
	let reasoning = ''
	for (const chunk of content) {
		if (typeof chunk === 'string') { text += chunk; continue }
		if (!chunk || typeof chunk !== 'object') continue
		if ((chunk as { type?: unknown }).type === 'thinking') {
			const thinking = (chunk as { thinking?: unknown }).thinking
			if (typeof thinking === 'string') reasoning += thinking
			else if (Array.isArray(thinking)) for (const t of thinking) reasoning += chunkText(t)
		}
		else { // 'text' chunk (or any other chunk that carries a string `.text`)
			text += chunkText(chunk)
		}
	}
	return { text, reasoning }
}


// convertToLLMMessageService (browser side) trims message *content* against contextWindow, but it
// has no visibility into the tool-call schemas assembled here in the main process. That's invisible
// slack on any normal-sized context window, but on tiny local models (e.g. Apple's on-device
// Foundation Model, ~4k tokens total) the tool schemas alone can be a third of the whole budget —
// so a request that looks correctly trimmed still overflows the real session limit. Only kicks in
// below SMALL_CONTEXT_WINDOW_THRESHOLD so normal cloud providers pay no extra tokenization cost.
const SMALL_CONTEXT_WINDOW_THRESHOLD = 16_000
const _messageContentText = (content: unknown): string => {
	if (typeof content === 'string') return content
	if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string') ? (c as { text: string }).text : '').join('')
	return ''
}
const _trimMessagesForToolBudget = (
	messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
	tools: unknown,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] => {
	if (contextWindow > SMALL_CONTEXT_WINDOW_THRESHOLD || !tools) return messages

	const toolTokens = estimateTokens(JSON.stringify(tools))
	const outputSpace = Math.max(contextWindow * 1 / 2, reservedOutputTokenSpace ?? 4_096)
	const budget = Math.max(contextWindow - outputSpace - toolTokens, 1_250)

	const msgs = messages.map(m => ({ ...m }))
	let overflow = msgs.reduce((sum, m) => sum + estimateTokens(_messageContentText(m.content)), 0) - budget

	let guard = 0
	while (overflow > 0 && guard < 100) {
		guard += 1
		// trim the single largest message, keeping the first and last messages intact (usually the
		// system/task-setup message and the most recent turn — the ones most worth preserving)
		let largestIdx = -1
		let largestTokens = -1
		for (let i = 1; i < msgs.length - 1; i += 1) {
			if (typeof msgs[i].content !== 'string') continue // don't touch multimodal content
			const t = estimateTokens(msgs[i].content as string)
			if (t > largestTokens) { largestTokens = t; largestIdx = i }
		}
		if (largestIdx === -1 || largestTokens <= 0) break

		const m = msgs[largestIdx]
		const content = m.content as string
		const charsPerToken = content.length / largestTokens
		const charsToRemove = Math.ceil(Math.min(overflow, largestTokens) * charsPerToken)
		const targetLen = Math.max(content.length - charsToRemove - 3, 0)
		m.content = content.slice(0, targetLen).trim() + '...'
		overflow -= largestTokens - estimateTokens(m.content as string)
	}
	return msgs
}

// Providers known to accept `stream_options.include_usage`. Others (local servers, Azure's default
// API version) may reject the unknown param; we still read `usage` from them if they send it anyway.
const providersWithStreamUsageOption: ReadonlySet<ProviderName> = new Set<ProviderName>(['openAI', 'openRouter', 'xAI', 'deepseek'])

// OpenAI-compatible `prompt_tokens` includes cached tokens (DeepSeek reports them as `prompt_cache_hit_tokens`).
const openAICompatibleUsage = (usage: unknown): LLMUsage | undefined => {
	if (!usage || typeof usage !== 'object') return undefined
	const u = usage as {
		prompt_tokens?: number; completion_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number } | null;
		prompt_cache_hit_tokens?: number;
	}
	if (typeof u.prompt_tokens !== 'number') return undefined
	const cacheRead = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0
	return { input: u.prompt_tokens - cacheRead, output: u.completion_tokens ?? 0, cacheRead }
}

const _sendOpenAICompatibleChat = async ({ messages, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, modelName: modelName_, _setAborter, providerName, chatMode, separateSystemMessage, overridesOfModel, mcpTools }: SendChatParams_Internal) => {
	const {
		modelName,
		specialToolFormat,
		reasoningCapabilities,
		additionalOpenAIPayload,
		contextWindow,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	const { canIOReasoning, openSourceThinkTags } = reasoningCapabilities || {}
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here

	const reasoningAndExtraPayload = {
		...providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo),
		...additionalOpenAIPayload
	}

	// tools
	const potentialTools = openAITools(chatMode, mcpTools)
	const nativeToolsObj = potentialTools && specialToolFormat === 'openai-style' ?
		{ tools: potentialTools } as const
		: {}

	const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName_, { isReasoningEnabled: !!reasoningInfo?.isReasoningEnabled, overridesOfModel })
	const preparedMessages = nativeToolsObj.tools
		? _trimMessagesForToolBudget(messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[], nativeToolsObj.tools, contextWindow, reservedOutputTokenSpace)
		: messages as any

	// instance
	const openai: OpenAI = await newOpenAICompatibleSDK({ providerName, settingsOfProvider })
	if (providerName === 'microsoftAzure') {
		// Required to select the model
		(openai as AzureOpenAI).deploymentName = modelName;
	}
	const options: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: modelName,
		messages: preparedMessages,
		stream: true,
		...(providersWithStreamUsageOption.has(providerName) ? { stream_options: { include_usage: true } } : {}),
		...nativeToolsObj,
		...reasoningAndExtraPayload,
		// max_completion_tokens: maxTokens,
	}

	// open source models - manually parse think tokens
	const { needsManualParse: needsManualReasoningParse, nameOfFieldInDelta: nameOfReasoningFieldInDelta } = providerReasoningIOSettings?.output ?? {}
	const manuallyParseReasoning = needsManualReasoningParse && canIOReasoning && openSourceThinkTags
	if (manuallyParseReasoning) {
		const { newOnText, newOnFinalMessage } = extractReasoningWrapper(onText, onFinalMessage, openSourceThinkTags)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	let fullReasoningSoFar = ''
	let fullTextSoFar = ''

	// one entry per parallel tool call; deltas name the call they extend by `index`
	const streamedToolCalls: StreamedToolCall[] = []

	let usage: LLMUsage | undefined

	openai.chat.completions
		.create(options)
		.then(async response => {
			_setAborter(() => response.controller.abort())
			// when receive text
			for await (const chunk of response) {
				// usually only on the last chunk (Groq nests it under x_groq)
				usage = openAICompatibleUsage(chunk.usage ?? (chunk as { x_groq?: { usage?: unknown } }).x_groq?.usage) ?? usage

				// message (delta.content is usually a string, but Mistral magistral returns an array of content chunks)
				const { text: newText, reasoning: newReasoningFromContent } = parseOpenAICompatibleDeltaContent(chunk.choices[0]?.delta?.content)
				fullTextSoFar += newText
				fullReasoningSoFar += newReasoningFromContent

				// tool calls
				const toolDeltas = chunk.choices[0]?.delta?.tool_calls ?? []
				for (let j = 0; j < toolDeltas.length; j += 1) {
					const tool = toolDeltas[j]
					const t = streamedToolCalls[tool.index ?? j] ??= { name: '', id: '', paramsStr: '' } // some servers omit index
					t.name += tool.function?.name ?? ''
					t.paramsStr += tool.function?.arguments ?? ''
					t.id += tool.id ?? ''
				}


				// reasoning
				let newReasoning = ''
				if (nameOfReasoningFieldInDelta) {
					// @ts-ignore
					newReasoning = (chunk.choices[0]?.delta?.[nameOfReasoningFieldInDelta] || '') + ''
					fullReasoningSoFar += newReasoning
				}

				// call onText
				onText({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					toolCall: streamingToolCallOf(streamedToolCalls),
				})

			}
			// on final
			const toolCalls = finalToolCallsOf(streamedToolCalls)
			if (!fullTextSoFar && !fullReasoningSoFar && toolCalls.length === 0) {
				onError({ message: 'Kodia: Response from model was empty.', fullError: null })
			}
			else {
				onFinalMessage({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, anthropicReasoning: null, toolCalls, usage });
			}
		})
		// when error/fail - this catches errors of both .create() and .then(for await)
		.catch(error => {
			if (error instanceof OpenAI.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: error }); }
			else if (isApplePCCUnavailableError(providerName, error)) { onError({ message: applePCCUnavailableMessage(), fullError: error }); }
			else { onError({ message: error + '', fullError: error }); }
		})
}



type OpenAIModel = {
	id: string;
	created: number;
	object: 'model';
	owned_by: string;
}
const _openaiCompatibleList = async ({ onSuccess: onSuccess_, onError: onError_, settingsOfProvider, providerName }: ListParams_Internal<OpenAIModel>) => {
	const onSuccess = ({ models }: { models: OpenAIModel[] }) => {
		onSuccess_({ models })
	}
	const onError = ({ error }: { error: string }) => {
		onError_({ error })
	}
	try {
		const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider })
		openai.models.list()
			.then(async (response) => {
				const models: OpenAIModel[] = []
				models.push(...response.data)
				while (response.hasNextPage()) {
					models.push(...(await response.getNextPage()).data)
				}
				onSuccess({ models })
			})
			.catch((error) => {
				onError({ error: error + '' })
			})
	}
	catch (error) {
		onError({ error: error + '' })
	}
}




// ------------ ANTHROPIC (HELPERS) ------------
const toAnthropicTool = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo
	const paramsWithType: { [s: string]: { description: string; type: 'string' } } = {}
	for (const key in params) { paramsWithType[key] = { ...params[key], type: 'string' } }
	return {
		name: name,
		description: description,
		input_schema: {
			type: 'object',
			properties: paramsWithType,
			// required: Object.keys(params),
		},
	} satisfies Anthropic.Messages.Tool
}

// Prompt caching: unlike OpenAI, DeepSeek and Gemini, Anthropic only caches up to explicit
// `cache_control` breakpoints. The agent loop resends the whole thread on every tool call, so we mark
// the end of the tools, the system prompt and the latest message — each request then reads the
// previous request's prefix from cache. The API silently ignores breakpoints below the model's
// minimum cacheable length, so short chats need no special-casing. (4 breakpoints max; we use 3.)
const anthropicCacheControl = { type: 'ephemeral' } as const

const anthropicTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined) => {
	const allowedTools = availableTools(chatMode, mcpTools)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null

	const anthropicTools: Anthropic.Messages.Tool[] = []
	for (const t in allowedTools ?? {}) {
		anthropicTools.push(toAnthropicTool(allowedTools[t]))
	}
	// tools render before the system prompt, so they stay cached even when the system prompt changes (e.g. open files)
	anthropicTools[anthropicTools.length - 1] = { ...anthropicTools[anthropicTools.length - 1], cache_control: anthropicCacheControl }
	return anthropicTools
}

const anthropicSystemWithCacheControl = (system: string | undefined): Anthropic.Messages.TextBlockParam[] | undefined => {
	if (!system) return undefined
	return [{ type: 'text', text: system, cache_control: anthropicCacheControl }]
}

// thinking blocks can't carry cache_control, and the API rejects it on empty text
const _canCarryCacheControl = (block: { type: string; text?: string }) =>
	block.type === 'text' ? !!block.text : (block.type === 'tool_result' || block.type === 'tool_use' || block.type === 'image')

const anthropicMessagesWithCacheControl = (messages: AnthropicLLMChatMessage[]): Anthropic.Messages.MessageParam[] => {
	const out = messages.slice() as Anthropic.Messages.MessageParam[]
	const lastIdx = out.length - 1
	if (lastIdx < 0) return out
	const last = out[lastIdx]

	if (typeof last.content === 'string') {
		if (last.content) out[lastIdx] = { ...last, content: [{ type: 'text', text: last.content, cache_control: anthropicCacheControl }] }
		return out
	}

	const blocks = last.content.slice()
	for (let i = blocks.length - 1; i >= 0; i -= 1) {
		if (_canCarryCacheControl(blocks[i] as { type: string; text?: string })) {
			blocks[i] = { ...blocks[i], cache_control: anthropicCacheControl } as Anthropic.Messages.ContentBlockParam
			break
		}
	}
	out[lastIdx] = { ...last, content: blocks }
	return out
}

// Anthropic's `input_tokens` already excludes cached tokens, so the fields map 1:1.
const anthropicUsage = (usage: Anthropic.Messages.Usage): LLMUsage => ({
	input: usage.input_tokens,
	output: usage.output_tokens,
	cacheRead: usage.cache_read_input_tokens ?? undefined,
	cacheWrite: usage.cache_creation_input_tokens ?? undefined,
})



// ------------ ANTHROPIC ------------
const sendAnthropicChat = async ({ messages, providerName, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName: modelName_, _setAborter, separateSystemMessage, chatMode, mcpTools }: SendChatParams_Internal) => {
	const {
		modelName,
		specialToolFormat,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	const thisConfig = settingsOfProvider.anthropic
	const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here
	const includeInPayload = providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo) || {}

	// anthropic-specific - max tokens
	const maxTokens = getReservedOutputTokenSpace(providerName, modelName_, { isReasoningEnabled: !!reasoningInfo?.isReasoningEnabled, overridesOfModel })

	// tools
	const potentialTools = anthropicTools(chatMode, mcpTools)
	const nativeToolsObj = potentialTools && specialToolFormat === 'anthropic-style' ?
		{ tools: potentialTools, tool_choice: { type: 'auto' } } as const
		: {}


	// instance
	const anthropic = new Anthropic({
		apiKey: thisConfig.apiKey,
		dangerouslyAllowBrowser: true
	});

	const stream = anthropic.messages.stream({
		system: anthropicSystemWithCacheControl(separateSystemMessage),
		messages: anthropicMessagesWithCacheControl(messages as AnthropicLLMChatMessage[]),
		model: modelName,
		max_tokens: maxTokens ?? 4_096, // anthropic requires this
		...includeInPayload,
		...nativeToolsObj,

	})

	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// when receive text
	let fullText = ''
	let fullReasoning = ''

	let fullToolName = ''
	let fullToolParams = ''


	const runOnText = () => {
		onText({
			fullText,
			fullReasoning,
			toolCall: !fullToolName ? undefined : { name: fullToolName, rawParams: {}, isDone: false, doneParams: [], id: 'dummy' },
		})
	}
	// there are no events for tool_use, it comes in at the end
	stream.on('streamEvent', e => {
		// start block
		if (e.type === 'content_block_start') {
			if (e.content_block.type === 'text') {
				if (fullText) fullText += '\n\n' // starting a 2nd text block
				fullText += e.content_block.text
				runOnText()
			}
			else if (e.content_block.type === 'thinking') {
				if (fullReasoning) fullReasoning += '\n\n' // starting a 2nd reasoning block
				fullReasoning += e.content_block.thinking
				runOnText()
			}
			else if (e.content_block.type === 'redacted_thinking') {
				console.log('delta', e.content_block.type)
				if (fullReasoning) fullReasoning += '\n\n' // starting a 2nd reasoning block
				fullReasoning += '[redacted_thinking]'
				runOnText()
			}
			else if (e.content_block.type === 'tool_use') {
				// anthropic gives us the tool name in the start block; a turn can hold several tool_use blocks, show the latest
				fullToolName = e.content_block.name ?? ''
				fullToolParams = ''
				runOnText()
			}
		}

		// delta
		else if (e.type === 'content_block_delta') {
			if (e.delta.type === 'text_delta') {
				fullText += e.delta.text
				runOnText()
			}
			else if (e.delta.type === 'thinking_delta') {
				fullReasoning += e.delta.thinking
				runOnText()
			}
			else if (e.delta.type === 'input_json_delta') { // tool use
				fullToolParams += e.delta.partial_json ?? '' // anthropic gives us the partial delta (string) here - https://docs.anthropic.com/en/api/messages-streaming
				runOnText()
			}
		}
	})

	// on done - (or when error/fail) - this is called AFTER last streamEvent
	stream.on('finalMessage', (response) => {
		const anthropicReasoning = response.content.filter(c => c.type === 'thinking' || c.type === 'redacted_thinking')
		const toolCalls = response.content
			.filter(c => c.type === 'tool_use')
			.map(rawToolCallObjOfAnthropicParams)
			.filter((t): t is RawToolCallObj => t !== null)

		onFinalMessage({ fullText, fullReasoning, anthropicReasoning, toolCalls, usage: anthropicUsage(response.usage) })
	})
	// on error
	stream.on('error', (error) => {
		if (error instanceof Anthropic.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: error }) }
		else { onError({ message: error + '', fullError: error }) }
	})
	_setAborter(() => stream.controller.abort())
}



// ------------ MISTRAL ------------
// https://docs.mistral.ai/api/#tag/fim
const sendMistralFIM = ({ messages, onFinalMessage, onError, settingsOfProvider, overridesOfModel, modelName: modelName_, _setAborter, providerName }: SendFIMParams_Internal) => {
	const { modelName, supportsFIM } = getModelCapabilities(providerName, modelName_, overridesOfModel)
	if (!supportsFIM) {
		if (modelName === modelName_)
			onError({ message: `Model ${modelName} does not support FIM.`, fullError: null })
		else
			onError({ message: `Model ${modelName_} (${modelName}) does not support FIM.`, fullError: null })
		return
	}

	const mistral = new MistralCore({ apiKey: settingsOfProvider.mistral.apiKey })
	fimComplete(mistral,
		{
			model: modelName,
			prompt: messages.prefix,
			suffix: messages.suffix,
			stream: false,
			maxTokens: 300,
			stop: messages.stopTokens,
		})
		.then(async response => {

			// unfortunately, _setAborter() does not exist
			let content = response?.ok ? response.value.choices?.[0]?.message?.content ?? '' : '';
			const fullText = typeof content === 'string' ? content
				: content.map(chunk => (chunk.type === 'text' ? chunk.text : '')).join('')

			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null });
		})
		.catch(error => {
			onError({ message: error + '', fullError: error });
		})
}


// ------------ OLLAMA ------------
const newOllamaSDK = ({ endpoint }: { endpoint: string }) => {
	// if endpoint is empty, normally ollama will send to 11434, but we want it to fail - the user should type it in
	if (!endpoint) throw new Error(`Ollama Endpoint was empty (please enter ${defaultProviderSettings.ollama.endpoint} in Kodia if you want the default url).`)
	const ollama = new Ollama({ host: endpoint })
	return ollama
}

const ollamaList = async ({ onSuccess: onSuccess_, onError: onError_, settingsOfProvider }: ListParams_Internal<OllamaModelResponse>) => {
	const onSuccess = ({ models }: { models: OllamaModelResponse[] }) => {
		onSuccess_({ models })
	}
	const onError = ({ error }: { error: string }) => {
		onError_({ error })
	}
	try {
		const thisConfig = settingsOfProvider.ollama
		const ollama = newOllamaSDK({ endpoint: thisConfig.endpoint })
		ollama.list()
			.then((response) => {
				const { models } = response
				onSuccess({ models })
			})
			.catch((error) => {
				onError({ error: error + '' })
			})
	}
	catch (error) {
		onError({ error: error + '' })
	}
}

const sendOllamaFIM = ({ messages, onFinalMessage, onError, settingsOfProvider, modelName, _setAborter }: SendFIMParams_Internal) => {
	const thisConfig = settingsOfProvider.ollama
	const ollama = newOllamaSDK({ endpoint: thisConfig.endpoint })

	let fullText = ''
	ollama.generate({
		model: modelName,
		prompt: messages.prefix,
		suffix: messages.suffix,
		options: {
			stop: messages.stopTokens,
			num_predict: 300, // max tokens
			// repeat_penalty: 1,
		},
		raw: true,
		stream: true, // stream is not necessary but lets us expose the
	})
		.then(async stream => {
			_setAborter(() => stream.abort())
			for await (const chunk of stream) {
				const newText = chunk.response
				fullText += newText
			}
			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null })
		})
		// when error/fail
		.catch((error) => {
			onError({ message: error + '', fullError: error })
		})
}

// ---------------- GEMINI NATIVE IMPLEMENTATION ----------------

const toGeminiFunctionDecl = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo
	return {
		name,
		description,
		parameters: {
			type: Type.OBJECT,
			properties: Object.entries(params).reduce((acc, [key, value]) => {
				acc[key] = {
					type: Type.STRING,
					description: value.description
				};
				return acc;
			}, {} as Record<string, Schema>)
		}
	} satisfies FunctionDeclaration
}

const geminiTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined): GeminiTool[] | null => {
	const allowedTools = availableTools(chatMode, mcpTools)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null
	const functionDecls: FunctionDeclaration[] = []
	for (const t in allowedTools ?? {}) {
		functionDecls.push(toGeminiFunctionDecl(allowedTools[t]))
	}
	const tools: GeminiTool = { functionDeclarations: functionDecls, }
	return [tools]
}



// Implementation for Gemini using Google's native API
const sendGeminiChat = async ({
	messages,
	separateSystemMessage,
	onText,
	onFinalMessage,
	onError,
	settingsOfProvider,
	overridesOfModel,
	modelName: modelName_,
	_setAborter,
	providerName,
	modelSelectionOptions,
	chatMode,
	mcpTools,
}: SendChatParams_Internal) => {

	if (providerName !== 'gemini') throw new Error(`Sending Gemini chat, but provider was ${providerName}`)

	const thisConfig = settingsOfProvider[providerName]

	const {
		modelName,
		specialToolFormat,
		// reasoningCapabilities,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	// const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	// const { canIOReasoning, openSourceThinkTags, } = reasoningCapabilities || {}
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here
	// const includeInPayload = providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo) || {}

	const thinkingConfig: ThinkingConfig | undefined = !reasoningInfo?.isReasoningEnabled ? undefined
		: reasoningInfo.type === 'budget_slider_value' ?
			{ thinkingBudget: reasoningInfo.reasoningBudget }
			: reasoningInfo.type === 'effort_slider_value' ?
				{ thinkingLevel: reasoningInfo.reasoningEffort.toUpperCase() } as ThinkingConfig
				: undefined

	// tools
	const potentialTools = geminiTools(chatMode, mcpTools)
	const toolConfig = potentialTools && specialToolFormat === 'gemini-style' ?
		potentialTools
		: undefined

	// instance
	const genAI = new GoogleGenAI({ apiKey: thisConfig.apiKey });


	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// when receive text
	let fullReasoningSoFar = ''
	let fullTextSoFar = ''

	// Gemini sends each function call whole, once, in the chunk where it completes
	const streamedToolCalls: StreamedToolCall[] = []

	let usage: LLMUsage | undefined


	genAI.models.generateContentStream({
		model: modelName,
		config: {
			systemInstruction: separateSystemMessage,
			thinkingConfig: thinkingConfig,
			tools: toolConfig,
		},
		contents: messages as GeminiLLMChatMessage[],
	})
		.then(async (stream) => {
			_setAborter(() => { stream.return(fullTextSoFar); });

			// Process the stream
			for await (const chunk of stream) {
				// message
				const newText = chunk.text ?? ''
				fullTextSoFar += newText

				// usage — cumulative, so the last chunk has the totals. promptTokenCount includes cached tokens.
				const m = chunk.usageMetadata
				if (m?.promptTokenCount !== undefined) {
					const cacheRead = m.cachedContentTokenCount ?? 0
					usage = { input: m.promptTokenCount - cacheRead, output: (m.candidatesTokenCount ?? 0) + (m.thoughtsTokenCount ?? 0), cacheRead }
				}

				// tool calls
				for (const functionCall of chunk.functionCalls ?? []) {
					streamedToolCalls.push({
						name: functionCall.name ?? '',
						paramsStr: JSON.stringify(functionCall.args ?? {}),
						id: functionCall.id || generateUuid(), // ids are often empty, but other providers expect one
					})
				}

				// (do not handle reasoning yet)

				// call onText
				onText({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					toolCall: streamingToolCallOf(streamedToolCalls),
				})
			}

			// on final
			const toolCalls = finalToolCallsOf(streamedToolCalls)
			if (!fullTextSoFar && !fullReasoningSoFar && toolCalls.length === 0) {
				onError({ message: 'Kodia: Response from model was empty.', fullError: null })
			} else {
				onFinalMessage({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, anthropicReasoning: null, toolCalls, usage });
			}
		})
		.catch(error => {
			const message = error?.message
			if (typeof message === 'string') {

				if (error.message?.includes('API key')) {
					onError({ message: invalidApiKeyMessage(providerName), fullError: error });
				}
				else if (error?.message?.includes('429')) {
					onError({ message: 'Rate limit reached. ' + error, fullError: error });
				}
				else
					onError({ message: error + '', fullError: error });
			}
			else {
				onError({ message: error + '', fullError: error });
			}
		})
};



type CallFnOfProvider = {
	[providerName in ProviderName]: {
		sendChat: (params: SendChatParams_Internal) => Promise<void>;
		sendFIM: ((params: SendFIMParams_Internal) => void) | null;
		list: ((params: ListParams_Internal<any>) => void) | null;
	}
}

export const sendLLMMessageToProviderImplementation = {
	anthropic: {
		sendChat: sendAnthropicChat,
		sendFIM: null,
		list: null,
	},
	openAI: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	xAI: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	gemini: {
		sendChat: (params) => sendGeminiChat(params),
		sendFIM: null,
		list: null,
	},
	mistral: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => sendMistralFIM(params),
		list: null,
	},
	ollama: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: sendOllamaFIM,
		list: ollamaList,
	},
	openAICompatible: {
		sendChat: (params) => _sendOpenAICompatibleChat(params), // using openai's SDK is not ideal (your implementation might not do tools, reasoning, FIM etc correctly), talk to us for a custom integration
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	openRouter: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	vLLM: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: (params) => _openaiCompatibleList(params),
	},
	deepseek: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	groq: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},

	lmStudio: {
		// lmStudio has no suffix parameter in /completions, so sendFIM might not work
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: (params) => _openaiCompatibleList(params),
	},
	mlx: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: (params) => _openaiCompatibleList(params),
	},
	appleFoundationModels: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: (params) => _openaiCompatibleList(params),
	},
	liteLLM: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	googleVertex: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	microsoftAzure: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	awsBedrock: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},

} satisfies CallFnOfProvider




/*
FIM info (this may be useful in the future with vLLM, but in most cases the only way to use FIM is if the provider explicitly supports it):

qwen2.5-coder https://ollama.com/library/qwen2.5-coder/blobs/e94a8ecb9327
<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>

codestral https://ollama.com/library/codestral/blobs/51707752a87c
[SUFFIX]{{ .Suffix }}[PREFIX] {{ .Prompt }}

deepseek-coder-v2 https://ollama.com/library/deepseek-coder-v2/blobs/22091531faf0
<｜fim▁begin｜>{{ .Prompt }}<｜fim▁hole｜>{{ .Suffix }}<｜fim▁end｜>

starcoder2 https://ollama.com/library/starcoder2/blobs/3b190e68fefe
<file_sep>
<fim_prefix>
{{ .Prompt }}<fim_suffix>{{ .Suffix }}<fim_middle>
<|end_of_text|>

codegemma https://ollama.com/library/codegemma:2b/blobs/48d9a8140749
<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>

*/
