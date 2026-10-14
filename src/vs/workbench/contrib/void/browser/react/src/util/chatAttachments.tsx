import { useCallback } from 'react';
import { URI } from '../../../../../../../base/common/uri.js';
import { StagingSelectionItem } from '../../../../common/chatThreadServiceTypes.js';
import { getModelCapabilities } from '../../../../common/modelCapabilities.js';
import { base64OfBlob, chatImageOfFile, isChatImageFile } from './chatImages.js';
import { useAccessor } from './services.js';

// Anthropic and OpenAI take PDFs up to 32MB and 100 pages; staying well under the size keeps stored threads reasonable
const MAX_PDF_BYTES = 10 * 1024 * 1024
const MAX_PDF_PAGES = 100
// a text file goes into the message itself
const MAX_TEXT_FILE_BYTES = 256 * 1024

const isPdfFile = (file: File) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name)

// Counts the page objects ("/Type /Page", not "/Pages") of a PDF, for the context budget. Compressed
// object streams can hide them, so it's an estimate with a floor of one page.
const pdfPageCountOf = (bytes: Uint8Array) => {
	const text = new TextDecoder('latin1').decode(bytes)
	return Math.max(1, (text.match(/\/Type\s*\/Page(?![a-z])/gi) ?? []).length)
}

const chatPdfOfFile = async (file: File): Promise<StagingSelectionItem & { type: 'PDF' }> => {
	if (file.size > MAX_PDF_BYTES) throw new Error(`it's ${(file.size / 1024 / 1024).toFixed(1)} MB, over the ${MAX_PDF_BYTES / 1024 / 1024} MB limit for PDFs`)
	const pageCount = pdfPageCountOf(new Uint8Array(await file.arrayBuffer()))
	if (pageCount > MAX_PDF_PAGES) throw new Error(`it has ${pageCount} pages, and models read at most ${MAX_PDF_PAGES} pages per PDF. Split it, or attach the part you need`)
	return {
		type: 'PDF',
		id: crypto.randomUUID(),
		name: file.name || 'Document.pdf',
		dataBase64: await base64OfBlob(file),
		pageCount,
	}
}

const chatTextFileOf = async (file: File, languageIdOf: (name: string) => string): Promise<StagingSelectionItem & { type: 'TextFile' }> => {
	if (file.size > MAX_TEXT_FILE_BYTES) throw new Error(`it's ${Math.round(file.size / 1024)} KB, over the ${MAX_TEXT_FILE_BYTES / 1024} KB limit for text files`)
	const bytes = new Uint8Array(await file.arrayBuffer())
	if (bytes.subarray(0, 8192).includes(0)) throw new Error(`it isn't a text file, an image or a PDF`) // NUL bytes: binary
	return {
		type: 'TextFile',
		id: crypto.randomUUID(),
		name: file.name || 'Attached file',
		languageId: languageIdOf(file.name),
		text: new TextDecoder('utf-8').decode(bytes),
	}
}

// Attaches files to the chat message being written (paste, drop or the + button): images and PDFs as media
// for the models that read them, anything else as text. Returns whether there were files to handle.
export const useAttachChatFiles = () => {
	const accessor = useAccessor()
	const chatThreadService = accessor.get('IChatThreadService')
	const notificationService = accessor.get('INotificationService')
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const languageService = accessor.get('ILanguageService')

	return useCallback((files: File[]): boolean => {
		if (files.length === 0) return false

		const { modelSelectionOfFeature, overridesOfModel } = voidSettingsService.state
		const modelSelection = modelSelectionOfFeature['Chat']
		const capabilities = modelSelection ? getModelCapabilities(modelSelection.providerName, modelSelection.modelName, overridesOfModel) : undefined
		const modelName = modelSelection?.modelName ?? 'The selected model'

		const languageIdOf = (name: string) => languageService.guessLanguageIdByFilepathOrFirstLine(URI.file(name)) ?? ''
		const attach = (file: File, selection: Promise<StagingSelectionItem>) => selection
			.then(s => chatThreadService.addNewStagingSelection(s))
			.catch(e => notificationService.warn(`Could not attach ${file.name || 'the file'}: ${e instanceof Error ? e.message : e}`))

		let refusedImages = false, refusedPdfs = false
		for (const file of files) {
			if (isChatImageFile(file)) {
				if (capabilities?.supportsVision) attach(file, chatImageOfFile(file))
				else refusedImages = true
			}
			else if (isPdfFile(file)) {
				if (capabilities?.supportsPDF) attach(file, chatPdfOfFile(file))
				else refusedPdfs = true
			}
			else attach(file, chatTextFileOf(file, languageIdOf))
		}
		if (refusedImages) notificationService.warn(`${modelName} can't read images. Pick a model with vision (Claude, GPT, Gemini, Grok...), or enable "supportsVision" for it in the model settings.`)
		if (refusedPdfs) notificationService.warn(`${modelName} can't read PDFs. Pick a Claude, GPT or Gemini model, or enable "supportsPDF" for it in the model settings.`)
		return true
	}, [chatThreadService, notificationService, voidSettingsService, languageService])
}
