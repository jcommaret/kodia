import { ChatImageMimeType, chatImageMimeTypes, StagingSelectionItem } from '../../../../common/chatThreadServiceTypes.js';

export type ChatImageSelection = StagingSelectionItem & { type: 'Image' }

// Anthropic recommends a long edge of at most 1568px: larger images are downscaled server-side anyway,
// and cost more tokens. Downscaling here also keeps stored threads small.
const MAX_IMAGE_EDGE = 1568
// Anthropic's per-image limit is 5MB of base64, i.e. ~3.75MB of image bytes (OpenAI and Gemini allow more)
const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024

export const isChatImageFile = (file: File) => (chatImageMimeTypes as readonly string[]).includes(file.type)

const base64OfBlob = (blob: Blob) => new Promise<string>((resolve, reject) => {
	const reader = new FileReader()
	reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '') // strip the "data:...;base64," prefix
	reader.onerror = () => reject(reader.error)
	reader.readAsDataURL(blob)
})

const encodeCanvas = (canvas: HTMLCanvasElement, mimeType: 'image/png' | 'image/jpeg') => new Promise<Blob>((resolve, reject) => {
	canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not encode the image.')), mimeType, 0.85)
})

// A pasted or dropped image, ready to attach to a chat message.
export const chatImageOfFile = async (file: File): Promise<ChatImageSelection> => {
	let mimeType = file.type as ChatImageMimeType
	let blob: Blob = file

	const bitmap = await createImageBitmap(file)
	try {
		const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
		if (scale < 1 || file.size > MAX_IMAGE_BYTES) {
			const canvas = document.createElement('canvas')
			canvas.width = Math.max(1, Math.round(bitmap.width * scale))
			canvas.height = Math.max(1, Math.round(bitmap.height * scale))
			canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

			// keep PNG for screenshots (sharp text), unless it is still too big
			mimeType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
			blob = await encodeCanvas(canvas, mimeType)
			if (blob.size > MAX_IMAGE_BYTES) {
				mimeType = 'image/jpeg'
				blob = await encodeCanvas(canvas, mimeType)
			}
		}
	}
	finally {
		bitmap.close()
	}

	return {
		type: 'Image',
		id: crypto.randomUUID(),
		name: file.name || 'Pasted image',
		mimeType,
		dataBase64: await base64OfBlob(blob),
	}
}

export const dataURLOfChatImage = (image: ChatImageSelection) => `data:${image.mimeType};base64,${image.dataBase64}`
