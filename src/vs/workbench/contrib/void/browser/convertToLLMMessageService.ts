import { Disposable } from '../../../../base/common/lifecycle.js';
import { findLast } from '../../../../base/common/arraysFind.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ChatMessage, StagingSelectionItem } from '../common/chatThreadServiceTypes.js';
import { getIsReasoningEnabledState, getReservedOutputTokenSpace, getModelCapabilities, anthropicModelFeatures } from '../common/modelCapabilities.js';
import { chat_systemMessage, chat_filesOverview, chat_workspaceContext, joinProjectRules, PROJECT_RULES_FILE_NAMES, summarizedThreadMessage } from '../common/prompt/prompts.js';
import { LLMChatMessage, LLMFIMMessage } from '../common/sendLLMMessageTypes.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { ChatMode, FeatureName, ModelSelection, modelSelectionsEqual } from '../common/voidSettingsTypes.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { ITerminalToolService } from './terminalToolService.js';
import { IVoidModelService } from '../common/voidModelService.js';
import { URI } from '../../../../base/common/uri.js';
import { EndOfLinePreference } from '../../../../editor/common/model.js';
import { IMCPService } from '../common/mcpService.js';
import { IProjectMemoryService, PROJECT_MEMORY_FILE_PATH } from '../common/projectMemoryService.js';

import { ChatMedia, CLEARED_TOOL_RESULT, prepareMessages, prepareSimpleLLMMessages, SimpleLLMMessage } from '../common/prepareLLMMessages.js';


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

	// Read the rules files (.voidrules, AGENTS.md, ...) from the root of each workspace folder
	private _getProjectRulesFileContents(fileNames: readonly string[] = PROJECT_RULES_FILE_NAMES): string {
		try {
			const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
			const files: { path: string, content: string }[] = []
			for (const folder of workspaceFolders) {
				for (const fileName of fileNames) {
					const { model } = this.voidModelService.getModel(URI.joinPath(folder.uri, fileName))
					if (!model) continue
					const path = workspaceFolders.length > 1 ? `${folder.name}/${fileName}` : fileName
					files.push({ path, content: model.getValue(EndOfLinePreference.LF) })
				}
			}
			return joinProjectRules(files);
		}
		catch (e) {
			return ''
		}
	}

	// Notes saved by the agent itself (via write_project_memory) in previous sessions: .kodia/memory.md
	private _getProjectMemory(): string {
		return this.projectMemoryService.getMemory()
	}

	// The user's own instructions: from settings and the project's rules files
	private _getGuidelines(): string {
		const globalAIInstructions = this.voidSettingsService.state.globalSettings.aiInstructions;
		const rulesFileContent = this._getProjectRulesFileContents();
		return [globalAIInstructions, rulesFileContent].filter(s => !!s).join('\n\n')
	}

	// Get combined AI instructions from settings, the project's rules files, and saved project memory
	private _getCombinedAIInstructions(rulesFileNames?: readonly string[]): string {
		const globalAIInstructions = this.voidSettingsService.state.globalSettings.aiInstructions;
		const rulesFileContent = this._getProjectRulesFileContents(rulesFileNames);
		const projectMemory = this._getProjectMemory();

		const ans: string[] = []
		if (globalAIInstructions) ans.push(globalAIInstructions)
		if (projectMemory) ans.push(`PROJECT MEMORY (notes saved automatically in previous sessions via write_project_memory):\n${projectMemory}`)
		if (rulesFileContent) ans.push(rulesFileContent)
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
		if (guidelines) sections.push(`GUIDELINES (from the user's settings and the project's rules files):\n${guidelines}`)

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
		// messages before this index go as a summary (ContextSummaryEntry)
		const lastSummaryEntry = findLast(chatMessages, m => m.role === 'context_summary')
		const lastSummary = lastSummaryEntry?.role === 'context_summary' ? lastSummaryEntry : null

		for (let idx = lastSummary?.keepFromIdx ?? 0; idx < chatMessages.length; idx += 1) {
			const m = chatMessages[idx]
			// the summary leads: in the kept user message, or before the kept assistant message, along with the request it works on
			const summaryPrefix = lastSummary && idx === lastSummary.keepFromIdx ? lastSummary.summary : null
			if (summaryPrefix !== null && m.role !== 'user') {
				const latestRequest = findLast(chatMessages.slice(0, idx), m => m.role === 'user')
				simpleLLMMessages.push({ role: 'user', content: summarizedThreadMessage(summaryPrefix, latestRequest?.role === 'user' ? latestRequest.content : undefined) })
			}

			if (m.role === 'checkpoint') continue
			if (m.role === 'interrupted_streaming_tool') continue
			if (m.role === 'context_cleared') continue
			if (m.role === 'context_summary') continue
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
				const content = notes.length === 0 ? m.content : `${m.content}\n\n${notes.join('\n')}`
				simpleLLMMessages.push({
					role: m.role,
					content: summaryPrefix === null ? content : `${summarizedThreadMessage(summaryPrefix, undefined)}\n\n${content}`,
					media: media.length > 0 ? media : undefined,
				})
			}
		}
		return simpleLLMMessages
	}

	prepareLLMSimpleMessages: IConvertToLLMMessageService['prepareLLMSimpleMessages'] = ({ simpleMessages, systemMessage, modelSelection, featureName }) => {
		if (modelSelection === null) return { messages: [], separateSystemMessage: undefined }

		const { overridesOfModel, optionsOfModelSelection } = this.voidSettingsService.state
		return prepareSimpleLLMMessages({
			simpleMessages,
			systemMessage,
			aiInstructions: this._getCombinedAIInstructions(),
			modelSelection,
			featureName,
			overridesOfModel,
			optionsOfModelSelection,
		})
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
		// Get combined AI instructions with the provided aiInstructions as the base. Only Kodia's own rules file:
		// autocomplete sends them with every keystroke, and other agents' files (AGENTS.md, ...) are often long
		const combinedInstructions = this._getCombinedAIInstructions(['.voidrules']);

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



