import { Disposable } from '../../../../base/common/lifecycle.js';
import { deepClone } from '../../../../base/common/objects.js';
import { findLast } from '../../../../base/common/arraysFind.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ChatMessage, StagingSelectionItem } from '../common/chatThreadServiceTypes.js';
import { getIsReasoningEnabledState, getReservedOutputTokenSpace, getModelCapabilities, anthropicModelFeatures } from '../common/modelCapabilities.js';
import { estimateTokens } from '../common/tokenizer.js';
import { reParsedToolXMLString, chat_systemMessage, chat_filesOverview, chat_workspaceContext } from '../common/prompt/prompts.js';
import { AnthropicDocumentBlock, AnthropicImageBlock, AnthropicLLMChatMessage, AnthropicReasoning, GeminiLLMChatMessage, LLMChatMessage, LLMFIMMessage, OpenAIFilePart, OpenAIImagePart, OpenAILLMChatMessage, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { ChatMode, FeatureName, ModelSelection, modelSelectionsEqual, ProviderName } from '../common/voidSettingsTypes.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { ITerminalToolService } from './terminalToolService.js';
import { IVoidModelService } from '../common/voidModelService.js';
import { URI } from '../../../../base/common/uri.js';
import { EndOfLinePreference } from '../../../../editor/common/model.js';
import { ToolName } from '../common/toolsServiceTypes.js';
import { IMCPService } from '../common/mcpService.js';
import { IProjectMemoryService, PROJECT_MEMORY_FILE_PATH } from '../common/projectMemoryService.js';

export const EMPTY_MESSAGE = '(empty message)'
const CLEARED_TOOL_RESULT = '(This result was cleared to fit the context window. Call the tool again if you need it.)'



// images and PDFs attached to a user message, sent as media blocks rather than text
type ChatMedia =
	| { kind: 'image'; mimeType: string; dataBase64: string }
	| { kind: 'pdf'; name: string; dataBase64: string; pageCount: number }

type SimpleLLMMessage = {
	role: 'tool';
	content: string;
	id: string;
	name: ToolName;
	rawParams: RawToolParamsObj;
} | {
	role: 'user';
	content: string;
	media?: ChatMedia[]; // only the kinds the model accepts (supportsVision, supportsPDF)
} | {
	role: 'assistant';
	content: string;
	anthropicReasoning: AnthropicReasoning[] | null;
}



const TRIM_TO_LEN = 120


// --- images and PDFs: each format puts them before the text, as providers recommend ---
type ImageFormat = 'anthropic' | 'openai' // Gemini converts from the Anthropic format

const anthropicMediaBlock = (media: ChatMedia): AnthropicImageBlock | AnthropicDocumentBlock => media.kind === 'pdf'
	? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: media.dataBase64 }, title: media.name }
	: { type: 'image', source: { type: 'base64', media_type: media.mimeType, data: media.dataBase64 } }
const openAIMediaPart = (media: ChatMedia): OpenAIImagePart | OpenAIFilePart => media.kind === 'pdf'
	? { type: 'file', file: { filename: media.name, file_data: `data:application/pdf;base64,${media.dataBase64}` } }
	: { type: 'image_url', image_url: { url: `data:${media.mimeType};base64,${media.dataBase64}` } }

const mediaPartsOf = (media: ChatMedia[] | undefined, format: ImageFormat): (AnthropicImageBlock | AnthropicDocumentBlock | OpenAIImagePart | OpenAIFilePart)[] =>
	(media ?? []).map(m => format === 'anthropic' ? anthropicMediaBlock(m) : openAIMediaPart(m))

// Rough input tokens of attached media, which the text estimate doesn't see: an image downscaled to ~1568px
// (chatImages.ts), and per PDF page its text plus a rendered image (Anthropic counts both).
const IMAGE_TOKENS = 1_600
const PDF_PAGE_TOKENS = 2_000
const mediaTokensOf = (media: ChatMedia[] | undefined) =>
	(media ?? []).reduce((sum, m) => sum + (m.kind === 'pdf' ? m.pageCount * PDF_PAGE_TOKENS : IMAGE_TOKENS), 0)




// convert messages as if about to send to openai
/*
reference - https://platform.openai.com/docs/guides/function-calling#function-calling-steps
openai MESSAGE (role=assistant):
"tool_calls":[{
	"type": "function",
	"id": "call_12345xyz",
	"function": {
	"name": "get_weather",
	"arguments": "{\"latitude\":48.8566,\"longitude\":2.3522}"
}]

openai RESPONSE (role=user):
{   "role": "tool",
	"tool_call_id": tool_call.id,
	"content": str(result)    }

also see
openai on prompting - https://platform.openai.com/docs/guides/reasoning#advice-on-prompting
openai on developer system message - https://cdn.openai.com/spec/model-spec-2024-05-08.html#follow-the-chain-of-command
*/


const prepareMessages_openai_tools = (messages: SimpleLLMMessage[]): AnthropicOrOpenAILLMMessage[] => {

	const newMessages: OpenAILLMChatMessage[] = [];

	// the assistant message of the current turn — every tool message that follows it (a turn can call
	// several tools at once) is one of its tool_calls
	let turnAssistant: (OpenAILLMChatMessage & { role: 'assistant' }) | undefined = undefined

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		if (currMsg.role !== 'tool') {
			// Omit anthropic-only fields: JSON.stringify would send them and strict APIs (e.g. Mistral) return 422 Extra inputs.
			if (currMsg.role === 'assistant') {
				turnAssistant = {
					role: 'assistant',
					content: currMsg.content,
				}
				newMessages.push(turnAssistant)
			} else {
				turnAssistant = undefined
				// built explicitly (not pushed as-is) so `media` doesn't leak into the payload
				newMessages.push({
					role: 'user',
					content: currMsg.media?.length ? [...currMsg.media.map(openAIMediaPart), { type: 'text', text: currMsg.content }] : currMsg.content,
				})
			}
			continue
		}

		// edit the turn's assistant message to have called the tool
		if (turnAssistant) {
			(turnAssistant.tool_calls ??= []).push({
				type: 'function',
				id: currMsg.id,
				function: {
					name: currMsg.name,
					arguments: JSON.stringify(currMsg.rawParams)
				}
			})
		}

		// add the tool
		newMessages.push({
			role: 'tool',
			tool_call_id: currMsg.id,
			content: currMsg.content,
		})
	}
	return newMessages

}



// convert messages as if about to send to anthropic
/*
https://docs.anthropic.com/en/docs/build-with-claude/tool-use#tool-use-examples
anthropic MESSAGE (role=assistant):
"content": [{
	"type": "text",
	"text": "<thinking>I need to call the get_weather function, and the user wants SF, which is likely San Francisco, CA.</thinking>"
}, {
	"type": "tool_use",
	"id": "toolu_01A09q90qw90lq917835lq9",
	"name": "get_weather",
	"input": { "location": "San Francisco, CA", "unit": "celsius" }
}]
anthropic RESPONSE (role=user):
"content": [{
	"type": "tool_result",
	"tool_use_id": "toolu_01A09q90qw90lq917835lq9",
	"content": "15 degrees"
}]


Converts:
assistant: ...content
tool: (id, name, params)
tool: (id2, name2, params2)   <- a turn can call several tools at once
->
assistant: ...content, call(name, id, params), call(name2, id2, params2)
user: result(id, content), result(id2, content2)   <- Anthropic requires all of a turn's results in one message
*/

type AnthropicOrOpenAILLMMessage = AnthropicLLMChatMessage | OpenAILLMChatMessage

type AnthropicToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; }

// The <workspace_context> block chatThreadService appends to user messages (chat_workspaceContext)
const splitWorkspaceContext = (content: string): { text: string, workspaceContext: string | null } => {
	const start = content.lastIndexOf('<workspace_context>\n')
	if (start === -1 || !content.endsWith('</workspace_context>')) return { text: content, workspaceContext: null }
	return { text: content.slice(0, start).trimEnd(), workspaceContext: content.slice(start) }
}

// sendWorkspaceContextAsSystem: send each user message's editor context as a `role: "system"` message right
// after it — the operator channel, which text typed into a user message can't imitate.
const prepareMessages_anthropic_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean, sendWorkspaceContextAsSystem: boolean): AnthropicOrOpenAILLMMessage[] => {
	const newMessages: AnthropicLLMChatMessage[] = []

	// the current turn: its assistant message, and the user message collecting its tool results
	let turn: { assistant: AnthropicLLMChatMessage & { role: 'assistant' }; results: AnthropicToolResultBlock[] | null } | null = null

	for (const currMsg of messages) {

		// add anthropic reasoning
		if (currMsg.role === 'assistant') {
			const assistant: AnthropicLLMChatMessage & { role: 'assistant' } = currMsg.anthropicReasoning && supportsAnthropicReasoning
				? {
					role: 'assistant',
					content: currMsg.content ? [...currMsg.anthropicReasoning, { type: 'text' as const, text: currMsg.content }] : currMsg.anthropicReasoning
				}
				: {
					role: 'assistant',
					content: currMsg.content,
					// strip away anthropicReasoning
				}
			newMessages.push(assistant)
			turn = { assistant, results: null }
			continue
		}

		if (currMsg.role === 'user') {
			const { text, workspaceContext } = sendWorkspaceContextAsSystem ? splitWorkspaceContext(currMsg.content) : { text: currMsg.content, workspaceContext: null }
			newMessages.push({
				role: 'user',
				content: currMsg.media?.length ? [...currMsg.media.map(anthropicMediaBlock), { type: 'text', text }] : text,
			})
			if (workspaceContext) newMessages.push({ role: 'system', content: workspaceContext })
			turn = null
			continue
		}

		if (currMsg.role === 'tool') {
			// make it so the assistant called the tool
			if (turn) {
				const { assistant } = turn
				if (typeof assistant.content === 'string') assistant.content = [{ type: 'text', text: assistant.content }]
				assistant.content.push({ type: 'tool_use', id: currMsg.id, name: currMsg.name, input: currMsg.rawParams })
			}

			// put the result in the turn's tool-results user message
			const result: AnthropicToolResultBlock = { type: 'tool_result', tool_use_id: currMsg.id, content: currMsg.content }
			if (turn?.results) {
				turn.results.push(result)
			}
			else {
				const results = [result]
				newMessages.push({ role: 'user', content: results })
				if (turn) turn.results = results
			}
			continue
		}

	}

	return newMessages
}


const prepareMessages_XML_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean, imageFormat: ImageFormat): AnthropicOrOpenAILLMMessage[] => {

	const llmChatMessages: AnthropicOrOpenAILLMMessage[] = [];
	for (let i = 0; i < messages.length; i += 1) {

		const c = messages[i]

		if (c.role === 'assistant') {
			// if called tools (messages after it), re-add their XML to the message
			// alternatively, could just hold onto the original output, but this way requires less piping raw strings everywhere
			let content: AnthropicOrOpenAILLMMessage['content'] = c.content
			for (let j = i + 1; j < messages.length; j += 1) {
				const next = messages[j]
				if (next.role !== 'tool') break
				content = `${content}\n\n${reParsedToolXMLString(next.name, next.rawParams)}`
			}

			// anthropic reasoning
			if (c.anthropicReasoning && supportsAnthropicReasoning) {
				content = content ? [...c.anthropicReasoning, { type: 'text' as const, text: content }] : c.anthropicReasoning
			}
			llmChatMessages.push({
				role: 'assistant',
				content
			})
		}
		// add user or tool to the previous user message
		else if (c.role === 'user' || c.role === 'tool') {
			const text = c.role === 'tool' ? `<${c.name}_result>\n${c.content}\n</${c.name}_result>` : c.content
			const imageParts = c.role === 'user' ? mediaPartsOf(c.media, imageFormat) : []

			const prev = llmChatMessages[llmChatMessages.length - 1]
			if (prev?.role !== 'user') {
				llmChatMessages.push({
					role: 'user',
					content: imageParts.length ? [...imageParts, { type: 'text', text }] : text
				} as AnthropicOrOpenAILLMMessage)
			}
			else if (typeof prev.content === 'string' && imageParts.length === 0) {
				prev.content += '\n\n' + text
			}
			else { // media on either side: merge as blocks
				const prevBlocks = typeof prev.content === 'string' ? [{ type: 'text' as const, text: prev.content }] : prev.content
				prev.content = [...prevBlocks, ...imageParts, { type: 'text', text }] as typeof prev.content
			}
		}
	}
	return llmChatMessages
}


// --- CHAT ---

const prepareOpenAIOrAnthropicMessages = ({
	messages: messages_,
	systemMessage,
	aiInstructions,
	supportsSystemMessage,
	specialToolFormat,
	supportsAnthropicReasoning,
	contextWindow,
	reservedOutputTokenSpace,
	imageFormat,
	sendWorkspaceContextAsSystem,
	tokenRatio,
}: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
	imageFormat: ImageFormat, // only used by XML tool calling, whose messages can go to any provider
	sendWorkspaceContextAsSystem: boolean,
	tokenRatio: number, // real tokens per estimated token, for this model (see recordInputTokens)
}): { messages: AnthropicOrOpenAILLMMessage[], separateSystemMessage: string | undefined, estimatedInputTokens: number, wasOverBudget: boolean } => {

	// the model's real output limit; capped at half the window so small local models keep room for input
	reservedOutputTokenSpace = Math.min(
		contextWindow / 2,
		reservedOutputTokenSpace ?? 4_096 // defaults to 4096
	)
	let messages: (SimpleLLMMessage | { role: 'system', content: string })[] = deepClone(messages_)

	// ================ system message ================
	// A COMPLETE HACK: last message is system message for context purposes

	const sysMsgParts: string[] = []
	if (aiInstructions) sysMsgParts.push(`GUIDELINES AND MEMORY (from the user's settings, .voidrules file, and project memory):\n${aiInstructions}`)
	if (systemMessage) sysMsgParts.push(systemMessage)
	const combinedSystemMessage = sysMsgParts.join('\n\n')

	messages.unshift({ role: 'system', content: combinedSystemMessage })

	// ================ trim ================
	messages = messages.map(m => ({ ...m, content: m.role !== 'tool' ? m.content.trim() : m.content }))

	type MesType = (typeof messages)[0]

	// ================ fit into context ================

	// the higher the weight, the higher the desire to truncate - TRIM HIGHEST WEIGHT MESSAGES
	const alreadyTrimmedIdxes = new Set<number>()
	const weight = (message: MesType, messages: MesType[], idx: number) => {
		const base = estimateTokens(message.content)

		let multiplier: number
		multiplier = 1 + (messages.length - 1 - idx) / messages.length // slow rampdown from 2 to 1 as index increases
		if (message.role === 'user') {
			multiplier *= 1
		}
		else if (message.role === 'system') {
			multiplier *= .01 // very low weight
		}
		else {
			multiplier *= 10 // llm tokens are far less valuable than user tokens
		}

		// any already modified message should not be trimmed again
		if (alreadyTrimmedIdxes.has(idx)) {
			multiplier = 0
		}
		// 1st and last messages should be very low weight
		if (idx <= 1 || idx >= messages.length - 1 - 3) {
			multiplier *= .05
		}
		return base * multiplier
	}

	const _findLargestByWeight = (messages_: MesType[]) => {
		let largestIndex = -1
		let largestWeight = -Infinity
		for (let i = 0; i < messages.length; i += 1) {
			const m = messages[i]
			const w = weight(m, messages_, i)
			if (w > largestWeight) {
				largestWeight = w
				largestIndex = i
			}
		}
		return largestIndex
	}

	let totalTokens = 0
	for (const m of messages) { totalTokens += estimateTokens(m.content) + (m.role === 'user' ? mediaTokensOf(m.media) : 0) }
	// in estimated tokens: the budget is in real tokens, and estimates run below them (other tokenizer, tool schemas)
	const tokensNeedToTrim = totalTokens - Math.max(
		(contextWindow - reservedOutputTokenSpace) / tokenRatio, // can be 0, in which case tokensNeedToTrim=everything, bad
		1_250 // ensure we don't trim below this floor (just a random small value)
	)
	// the caller can clear old tool results (once) instead of the lossy trimming below
	const wasOverBudget = tokensNeedToTrim > 0
	const estimatedInputTokens = totalTokens


	// <----------------------------------------->
	// 0                      |    |             |
	//                        |    contextWindow |
	//                     contextWindow - maxOut|putTokens
	//                                    totalTokens
	let remainingTokensToTrim = tokensNeedToTrim
	let i = 0

	while (remainingTokensToTrim > 0) {
		i += 1
		if (i > 100) break

		const trimIdx = _findLargestByWeight(messages)
		const m = messages[trimIdx]
		const msgTokens = estimateTokens(m.content)

		// if can finish here, do
		const fullyTrimmedContent = m.content.length > TRIM_TO_LEN
			? m.content.substring(0, TRIM_TO_LEN - '...'.length) + '...'
			: m.content
		const numTokensWillTrim = msgTokens - estimateTokens(fullyTrimmedContent)
		if (numTokensWillTrim > remainingTokensToTrim) {
			// don't need to trim this message all the way down — cut a proportional number of
			// characters based on this message's own token density (code is denser than prose)
			const charsPerToken = msgTokens > 0 ? m.content.length / msgTokens : 1
			const charsToRemove = Math.ceil(remainingTokensToTrim * charsPerToken)
			const targetLen = Math.max(m.content.length - charsToRemove - '...'.length, 0)
			m.content = m.content.slice(0, targetLen).trim() + '...'
			break
		}

		remainingTokensToTrim -= numTokensWillTrim
		m.content = fullyTrimmedContent
		alreadyTrimmedIdxes.add(trimIdx)
	}

	// ================ system message hack ================
	const newSysMsg = messages.shift()!.content


	// ================ tools and anthropicReasoning ================
	// SYSTEM MESSAGE HACK: we shifted (removed) the system message role, so now SimpleLLMMessage[] is valid

	let llmChatMessages: AnthropicOrOpenAILLMMessage[] = []
	if (!specialToolFormat) { // XML tool behavior
		llmChatMessages = prepareMessages_XML_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning, imageFormat)
	}
	else if (specialToolFormat === 'anthropic-style') {
		llmChatMessages = prepareMessages_anthropic_tools(messages as SimpleLLMMessage[], supportsAnthropicReasoning, sendWorkspaceContextAsSystem)
	}
	else if (specialToolFormat === 'openai-style') {
		llmChatMessages = prepareMessages_openai_tools(messages as SimpleLLMMessage[])
	}
	const llmMessages = llmChatMessages


	// ================ system message add as first llmMessage ================

	let separateSystemMessageStr: string | undefined = undefined

	// if supports system message
	if (supportsSystemMessage) {
		if (supportsSystemMessage === 'separated')
			separateSystemMessageStr = newSysMsg
		else if (supportsSystemMessage === 'system-role')
			llmMessages.unshift({ role: 'system', content: newSysMsg }) // add new first message
		else if (supportsSystemMessage === 'developer-role')
			llmMessages.unshift({ role: 'developer', content: newSysMsg }) // add new first message
	}
	// if does not support system message
	else {
		const sysMsgPrefix = `<SYSTEM_MESSAGE>\n${newSysMsg}\n</SYSTEM_MESSAGE>\n`
		const firstContent = llmMessages[0].content
		const newFirstMessage = {
			role: 'user',
			// the first message's content is blocks when it carries media
			content: typeof firstContent === 'string' ? `${sysMsgPrefix}${firstContent}` : [{ type: 'text', text: sysMsgPrefix }, ...firstContent]
		} as AnthropicOrOpenAILLMMessage
		llmMessages.splice(0, 1) // delete first message
		llmMessages.unshift(newFirstMessage) // add new first message
	}


	// ================ no empty message ================
	for (let i = 0; i < llmMessages.length; i += 1) {
		const currMsg: AnthropicOrOpenAILLMMessage = llmMessages[i]
		const nextMsg: AnthropicOrOpenAILLMMessage | undefined = llmMessages[i + 1]

		if (currMsg.role === 'tool') continue

		// if content is a string, replace string with empty msg
		if (typeof currMsg.content === 'string') {
			currMsg.content = currMsg.content || EMPTY_MESSAGE
		}
		else {
			// allowed to be empty if has a tool in it or following it
			if (currMsg.content.find(c => c.type === 'tool_result' || c.type === 'tool_use')) {
				currMsg.content = currMsg.content.filter(c => !(c.type === 'text' && !c.text)) as any
				continue
			}
			if (nextMsg?.role === 'tool') continue

			// replace any empty text entries with empty msg, and make sure there's at least 1 entry
			for (const c of currMsg.content) {
				if (c.type === 'text') c.text = c.text || EMPTY_MESSAGE
			}
			if (currMsg.content.length === 0) currMsg.content = [{ type: 'text', text: EMPTY_MESSAGE }]
		}
	}

	return {
		messages: llmMessages,
		separateSystemMessage: separateSystemMessageStr,
		estimatedInputTokens,
		wasOverBudget,
	} as const
}




type GeminiUserPart = (GeminiLLMChatMessage & { role: 'user' })['parts'][0]
type GeminiModelPart = (GeminiLLMChatMessage & { role: 'model' })['parts'][0]
const prepareGeminiMessages = (messages: AnthropicLLMChatMessage[]) => {
	// functionResponse needs the tool's name; a turn can hold several tool calls, so look it up by id
	const toolNameOfId = new Map<string, ToolName>()
	const messages2: GeminiLLMChatMessage[] = messages.map((m): GeminiLLMChatMessage | null => {
		if (m.role === 'assistant') {
			if (typeof m.content === 'string') {
				return { role: 'model', parts: [{ text: m.content }] }
			}
			else {
				const parts: GeminiModelPart[] = m.content.map((c): GeminiModelPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_use') {
						toolNameOfId.set(c.id, c.name)
						return { functionCall: { id: c.id, name: c.name, args: c.input } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'model', parts, }
			}
		}
		else if (m.role === 'user') {
			if (typeof m.content === 'string') {
				return { role: 'user', parts: [{ text: m.content }] } satisfies GeminiLLMChatMessage
			}
			else {
				const parts: GeminiUserPart[] = m.content.map((c): GeminiUserPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_result') {
						const toolName = toolNameOfId.get(c.tool_use_id)
						if (!toolName) return null
						return { functionResponse: { id: c.tool_use_id, name: toolName, response: { output: c.content } } }
					}
					else if (c.type === 'image' || c.type === 'document') {
						return { inlineData: { mimeType: c.source.media_type, data: c.source.data } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'user', parts, }
			}

		}
		else return null
	}).filter(m => !!m)

	return messages2
}


const prepareMessages = (params: {
	messages: SimpleLLMMessage[],
	systemMessage: string,
	aiInstructions: string,
	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated',
	specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined,
	supportsAnthropicReasoning: boolean,
	contextWindow: number,
	reservedOutputTokenSpace: number | null | undefined,
	providerName: ProviderName,
	sendWorkspaceContextAsSystem?: boolean,
	tokenRatio?: number,
}): { messages: LLMChatMessage[], separateSystemMessage: string | undefined, estimatedInputTokens: number, wasOverBudget: boolean } => {

	const specialFormat = params.specialToolFormat // this is just for ts stupidness

	// if need to convert to gemini style of messaes, do that (treat as anthropic style, then convert to gemini style)
	if (params.providerName === 'gemini' || specialFormat === 'gemini-style') {
		const res = prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat === 'gemini-style' ? 'anthropic-style' : undefined, imageFormat: 'anthropic', sendWorkspaceContextAsSystem: false, tokenRatio: params.tokenRatio ?? 1 })
		const messages = res.messages as AnthropicLLMChatMessage[]
		const messages2 = prepareGeminiMessages(messages)
		return { messages: messages2, separateSystemMessage: res.separateSystemMessage, estimatedInputTokens: res.estimatedInputTokens, wasOverBudget: res.wasOverBudget }
	}

	// with XML tools, the messages still go to the provider's own API, which sets the image format
	const imageFormat: ImageFormat = params.providerName === 'anthropic' ? 'anthropic' : 'openai'
	return prepareOpenAIOrAnthropicMessages({ ...params, specialToolFormat: specialFormat, imageFormat, sendWorkspaceContextAsSystem: !!params.sendWorkspaceContextAsSystem, tokenRatio: params.tokenRatio ?? 1 })
}




export interface IConvertToLLMMessageService {
	readonly _serviceBrand: undefined;
	prepareLLMSimpleMessages: (opts: { simpleMessages: SimpleLLMMessage[], systemMessage: string, modelSelection: ModelSelection | null, featureName: FeatureName }) => { messages: LLMChatMessage[], separateSystemMessage: string | undefined }
	// turnId: the same for every request of one agent turn, which then reuses one system prompt (see _chatSystemMessage)
	// wasOverBudget: the history didn't fit and older messages were truncated (clear old tool results and prepare again)
	prepareLLMChatMessages: (opts: { chatMessages: ChatMessage[], chatMode: ChatMode, modelSelection: ModelSelection | null, turnId?: string }) => Promise<{ messages: LLMChatMessage[], separateSystemMessage: string | undefined, estimatedInputTokens: number, wasOverBudget: boolean }>
	// calibrates token estimates for this model with the input tokens the provider reported for that request
	recordInputTokens(modelSelection: ModelSelection, estimatedInputTokens: number, actualInputTokens: number): void
	// the editor state to append to a chat message when the user sends it ('' if the system message is disabled)
	getWorkspaceContext(chatMode: ChatMode): string
	prepareFIMMessage(opts: { messages: LLMFIMMessage, }): { prefix: string, suffix: string, stopTokens: string[] }
}

export const IConvertToLLMMessageService = createDecorator<IConvertToLLMMessageService>('ConvertToLLMMessageService');


class ConvertToLLMMessageService extends Disposable implements IConvertToLLMMessageService {
	_serviceBrand: undefined;

	constructor(
		@IModelService private readonly modelService: IModelService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IVoidModelService private readonly voidModelService: IVoidModelService,
		@IMCPService private readonly mcpService: IMCPService,
		@IProjectMemoryService private readonly projectMemoryService: IProjectMemoryService,
	) {
		super()
	}

	// Read .voidrules files from workspace folders
	private _getVoidRulesFileContents(): string {
		try {
			const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
			let voidRules = '';
			for (const folder of workspaceFolders) {
				const uri = URI.joinPath(folder.uri, '.voidrules')
				const { model } = this.voidModelService.getModel(uri)
				if (!model) continue
				voidRules += model.getValue(EndOfLinePreference.LF) + '\n\n';
			}
			return voidRules.trim();
		}
		catch (e) {
			return ''
		}
	}

	// Notes saved by the agent itself (via write_project_memory) in previous sessions: .kodia/memory.md
	private _getProjectMemory(): string {
		return this.projectMemoryService.getMemory()
	}

	// The user's own instructions: from settings and .voidrules files
	private _getGuidelines(): string {
		const globalAIInstructions = this.voidSettingsService.state.globalSettings.aiInstructions;
		const voidRulesFileContent = this._getVoidRulesFileContents();
		return [globalAIInstructions, voidRulesFileContent].filter(s => !!s).join('\n\n')
	}

	// Get combined AI instructions from settings, .voidrules files, and saved project memory
	private _getCombinedAIInstructions(): string {
		const globalAIInstructions = this.voidSettingsService.state.globalSettings.aiInstructions;
		const voidRulesFileContent = this._getVoidRulesFileContents();
		const projectMemory = this._getProjectMemory();

		const ans: string[] = []
		if (globalAIInstructions) ans.push(globalAIInstructions)
		if (projectMemory) ans.push(`PROJECT MEMORY (notes saved automatically in previous sessions via write_project_memory):\n${projectMemory}`)
		if (voidRulesFileContent) ans.push(voidRulesFileContent)
		return ans.join('\n\n')
	}


	// The chat system prompt, from the most stable part to the most changing one, so that a provider's
	// prompt cache keeps the longest possible prefix:
	//   static instructions -> the user's guidelines -> project memory (the agent writes it) -> file tree (changes when files are created)
	private _generateChatSystemMessage = async (chatMode: ChatMode, specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined, disableSystemMessage: boolean) => {
		const sections: string[] = []

		if (!disableSystemMessage) {
			const workspaceFolders = this.workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath)
			const includeXMLToolDefinitions = !specialToolFormat
			const mcpTools = this.mcpService.getMCPTools()
			sections.push(chat_systemMessage({ workspaceFolders, chatMode, mcpTools, includeXMLToolDefinitions }))
		}

		const guidelines = this._getGuidelines()
		if (guidelines) sections.push(`GUIDELINES (from the user's settings and .voidrules file):\n${guidelines}`)

		await this.projectMemoryService.whenReady
		const projectMemory = this._getProjectMemory()
		if (projectMemory) sections.push(`PROJECT MEMORY (${PROJECT_MEMORY_FILE_PATH}: notes kept across sessions; rewrite a section with write_project_memory when something here is outdated or worth adding):\n${projectMemory}`)

		if (!disableSystemMessage) {
			const directoryStr = await this.directoryStrService.getAllDirectoriesStr({
				cutOffMessage: chatMode === 'agent' || chatMode === 'gather' ?
					`...Directories string cut off, use tools to read more...`
					: `...Directories string cut off, ask user for more if necessary...`
			})
			sections.push(chat_filesOverview(directoryStr))
		}

		return sections.join('\n\n\n')
	}

	// One system prompt per agent turn. The agent changes the file tree (creating files) and the project
	// memory while it works; rebuilding the system prompt for each request of the turn would then miss the
	// cache for the whole thread. The model already knows what it just changed, and tools read the rest.
	private _systemMessageOfTurn: { key: string, systemMessage: string } | undefined = undefined
	private async _chatSystemMessage(turnId: string | undefined, chatMode: ChatMode, specialToolFormat: 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined, disableSystemMessage: boolean) {
		const key = `${turnId}|${chatMode}|${specialToolFormat}|${disableSystemMessage}`
		if (turnId && this._systemMessageOfTurn?.key === key) return this._systemMessageOfTurn.systemMessage

		const systemMessage = await this._generateChatSystemMessage(chatMode, specialToolFormat, disableSystemMessage)
		if (turnId) this._systemMessageOfTurn = { key, systemMessage }
		return systemMessage
	}

	getWorkspaceContext: IConvertToLLMMessageService['getWorkspaceContext'] = (chatMode) => {
		if (this.voidSettingsService.state.globalSettings.disableSystemMessage) return ''

		const openedURIs = this.modelService.getModels().filter(m => m.isAttachedToEditor()).map(m => m.uri.fsPath)
		const activeURI = this.editorService.activeEditor?.resource?.fsPath
		const persistentTerminalIDs = this.terminalToolService.listPersistentTerminalIds()
		return chat_workspaceContext({ openedURIs, activeURI, persistentTerminalIDs, chatMode })
	}




	// --- LLM Chat messages ---

	private _chatMessagesToSimpleMessages(chatMessages: ChatMessage[], modelSelection: ModelSelection, { supportsVision, supportsPDF }: { supportsVision: boolean, supportsPDF: boolean }): SimpleLLMMessage[] {
		const simpleLLMMessages: SimpleLLMMessage[] = []

		// tool results before this index were cleared to fit the context window (ContextClearedEntry)
		const lastClearing = findLast(chatMessages, m => m.role === 'context_cleared')
		const clearedBeforeIdx = lastClearing?.role === 'context_cleared' ? lastClearing.keepFromIdx : 0

		for (let idx = 0; idx < chatMessages.length; idx += 1) {
			const m = chatMessages[idx]
			if (m.role === 'checkpoint') continue
			if (m.role === 'interrupted_streaming_tool') continue
			if (m.role === 'context_cleared') continue
			if (m.role === 'assistant') {
				// thinking signatures are only valid for the model that produced them — after a model
				// switch, resending them gets a 400, so keep just the text. (No modelSelection = stored
				// before it was tracked: keep the old behavior.)
				const producedByOtherModel = !!m.modelSelection && !modelSelectionsEqual(m.modelSelection, modelSelection)
				simpleLLMMessages.push({
					role: m.role,
					content: m.displayContent,
					anthropicReasoning: producedByOtherModel ? null : m.anthropicReasoning,
				})
			}
			else if (m.role === 'tool') {
				simpleLLMMessages.push({
					role: m.role,
					content: idx < clearedBeforeIdx ? CLEARED_TOOL_RESULT : m.content,
					name: m.name,
					id: m.id,
					rawParams: m.rawParams,
				})
			}
			else if (m.role === 'user') {
				const selections = m.selections ?? []
				const images = selections.filter((s): s is StagingSelectionItem & { type: 'Image' } => s.type === 'Image')
				const pdfs = selections.filter((s): s is StagingSelectionItem & { type: 'PDF' } => s.type === 'PDF')
				// for a model that can't read them (e.g. after switching models), leave them out but say so
				const notes: string[] = []
				if (!supportsVision && images.length > 0) notes.push(`(${images.length} attached image${images.length === 1 ? ' was' : 's were'} left out: the current model doesn't accept images.)`)
				if (!supportsPDF && pdfs.length > 0) notes.push(`(${pdfs.length} attached PDF${pdfs.length === 1 ? ' was' : 's were'} left out: the current model doesn't read PDFs.)`)
				const media: ChatMedia[] = [
					...(supportsVision ? images.map((i): ChatMedia => ({ kind: 'image', mimeType: i.mimeType, dataBase64: i.dataBase64 })) : []),
					...(supportsPDF ? pdfs.map((p): ChatMedia => ({ kind: 'pdf', name: p.name, dataBase64: p.dataBase64, pageCount: p.pageCount })) : []),
				]
				simpleLLMMessages.push({
					role: m.role,
					content: notes.length === 0 ? m.content : `${m.content}\n\n${notes.join('\n')}`,
					media: media.length > 0 ? media : undefined,
				})
			}
		}
		return simpleLLMMessages
	}

	prepareLLMSimpleMessages: IConvertToLLMMessageService['prepareLLMSimpleMessages'] = ({ simpleMessages, systemMessage, modelSelection, featureName }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel } = this.voidSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const modelSelectionOptions = this.voidSettingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName]

		// Get combined AI instructions
		const aiInstructions = this._getCombinedAIInstructions();

		const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })

		const { messages, separateSystemMessage } = prepareMessages({
			messages: simpleMessages,
			systemMessage,
			aiInstructions,
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
		})
		return { messages, separateSystemMessage };
	}
	// Real tokens per estimated token, per model. Estimates use one tokenizer for every model (o200k), and don't
	// count tool schemas; the providers' usage reports give the real input size.
	private readonly _tokenRatioOf = new Map<string, number>()
	private _tokenRatio(modelSelection: ModelSelection) {
		// until the first response calibrates it: Claude's tokenizer produces up to ~1.35x more tokens than o200k
		const fallback = modelSelection.providerName === 'anthropic' ? 1.3 : 1.15
		return this._tokenRatioOf.get(`${modelSelection.providerName}:${modelSelection.modelName}`) ?? fallback
	}
	recordInputTokens: IConvertToLLMMessageService['recordInputTokens'] = (modelSelection, estimatedInputTokens, actualInputTokens) => {
		if (estimatedInputTokens < 500 || actualInputTokens <= 0) return // too small to be meaningful
		const ratio = Math.min(Math.max(actualInputTokens / estimatedInputTokens, 0.5), 3)
		const key = `${modelSelection.providerName}:${modelSelection.modelName}`
		const previous = this._tokenRatioOf.get(key)
		this._tokenRatioOf.set(key, previous === undefined ? ratio : previous * 0.7 + ratio * 0.3)
	}

	prepareLLMChatMessages: IConvertToLLMMessageService['prepareLLMChatMessages'] = async ({ chatMessages, chatMode, modelSelection, turnId }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined, estimatedInputTokens: 0, wasOverBudget: false }

		const { overridesOfModel } = this.voidSettingsService.state

		const { providerName, modelName } = modelSelection
		const {
			specialToolFormat,
			contextWindow,
			supportsSystemMessage,
			supportsVision,
			supportsPDF,
			recognizedModelName,
		} = getModelCapabilities(providerName, modelName, overridesOfModel)

		const { disableSystemMessage } = this.voidSettingsService.state.globalSettings;
		// includes the guidelines and project memory, in cache-friendly order
		const systemMessage = await this._chatSystemMessage(turnId, chatMode, specialToolFormat, !!disableSystemMessage)

		const modelSelectionOptions = this.voidSettingsService.state.optionsOfModelSelection['Chat'][modelSelection.providerName]?.[modelSelection.modelName]

		const isReasoningEnabled = getIsReasoningEnabledState('Chat', providerName, modelName, modelSelectionOptions, overridesOfModel)
		const reservedOutputTokenSpace = getReservedOutputTokenSpace(providerName, modelName, { isReasoningEnabled, overridesOfModel })
		const llmMessages = this._chatMessagesToSimpleMessages(chatMessages, modelSelection, { supportsVision: !!supportsVision, supportsPDF: !!supportsPDF })

		return prepareMessages({
			messages: llmMessages,
			systemMessage,
			aiInstructions: '', // already in systemMessage
			supportsSystemMessage,
			specialToolFormat,
			supportsAnthropicReasoning: providerName === 'anthropic',
			contextWindow,
			reservedOutputTokenSpace,
			providerName,
			sendWorkspaceContextAsSystem: providerName === 'anthropic' && !!recognizedModelName && anthropicModelFeatures.midConversationSystemMessages.has(recognizedModelName),
			tokenRatio: this._tokenRatio(modelSelection),
		})
	}


	// --- FIM ---

	prepareFIMMessage: IConvertToLLMMessageService['prepareFIMMessage'] = ({ messages }) => {
		// Get combined AI instructions with the provided aiInstructions as the base
		const combinedInstructions = this._getCombinedAIInstructions();

		let prefix = `\
${!combinedInstructions ? '' : `\
// Instructions:
// Do not output an explanation. Try to avoid outputting comments. Only output the middle code.
${combinedInstructions.split('\n').map(line => `//${line}`).join('\n')}`}

${messages.prefix}`

		const suffix = messages.suffix
		const stopTokens = messages.stopTokens
		return { prefix, suffix, stopTokens }
	}


}


registerSingleton(IConvertToLLMMessageService, ConvertToLLMMessageService, InstantiationType.Eager);








/*
Gemini has this, but they're openai-compat so we don't need to implement this
gemini request:
{   "role": "assistant",
	"content": null,
	"function_call": {
		"name": "get_weather",
		"arguments": {
			"latitude": 48.8566,
			"longitude": 2.3522
		}
	}
}

gemini response:
{   "role": "assistant",
	"function_response": {
		"name": "get_weather",
			"response": {
			"temperature": "15°C",
				"condition": "Cloudy"
		}
	}
}
*/



