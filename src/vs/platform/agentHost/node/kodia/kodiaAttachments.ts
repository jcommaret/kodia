/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64, encodeBase64, type VSBuffer } from '../../../../base/common/buffer.js';
import { getMediaMime } from '../../../../base/common/mime.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../files/common/files.js';
import type { ByokLmImageMimeType, IByokLmContentPart } from '../../common/agentHostByokLm.js';
import { isHostSnapshotAttachment, readHostSnapshotAttachmentMeta } from '../../common/meta/agentSnapshotAttachmentMeta.js';
import { readAttachmentDetail } from '../../common/meta/attachmentMeta.js';
import { MessageAttachmentKind, type MessageAttachment, type MessageEmbeddedResourceAttachment, type MessageResourceAttachment, type TextRange } from '../../common/state/sessionState.js';
import { MAX_PAGE_CHARS } from './kodiaTools.js';

// What the user adds to a message of the Agents window with "Add Context..." (files, folders, selections, images, pasted
// text) as the Kodia agent hands it to the model: text parts after the prompt, and the images as media. The files are
// read here, when the message is sent, so the model has what the user saw then; the model reads on with read_file.

/** The most characters of one attachment the model is sent: as many as a page of read_file. */
export const MAX_ATTACHMENT_CHARS = MAX_PAGE_CHARS;

// a file that is bigger is not read at all: it is no text the user means to send whole
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// the limit of the strictest provider (Anthropic)
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// a folder's listing is cut after this many entries, as ls_dir pages
const MAX_FOLDER_ENTRIES = 500;
// what is looked at to tell a binary file from a text one
const BINARY_SNIFF_BYTES = 8_000;

// the image types every provider of Kodia's models accepts (see chatImageMimeTypes)
const IMAGE_MIME_TYPES: readonly ByokLmImageMimeType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export interface IKodiaAttachmentOptions {
	readonly fileService: IFileService;
	/** Whether the model accepts images; if not, the model is only told an image was attached. */
	readonly supportsVision: boolean;
}

export interface IResolvedAttachments {
	/** What follows the prompt in the user's message: a text part an attachment, and an image part an image. */
	readonly parts: IByokLmContentPart[];
	/** The attachments as the Agents window shows them again after a restart: without the data of an embedded one. */
	readonly stored: MessageAttachment[];
}

const textPart = (text: string): IByokLmContentPart => ({ type: 'text', text });

/**
 * The attachments of a message as the model is sent them. Each is a text part with a header (its path, and the lines of a
 * selection) and its content, cut where read_file would page; an image is an image part when the model accepts them. An
 * attachment that can't be read, or that this agent can't use, still tells the model so: none is dropped silently.
 */
export async function resolveAttachments(attachments: readonly MessageAttachment[] | undefined, options: IKodiaAttachmentOptions): Promise<IResolvedAttachments> {
	if (!attachments?.length) {
		return { parts: [], stored: [] };
	}
	const parts = await Promise.all(attachments.map(async attachment => {
		try {
			return await resolveAttachment(attachment, options);
		} catch (err) {
			return [textPart(`The user attached ${describe(attachment)}, but it could not be read: ${err instanceof Error ? err.message : String(err)}`)];
		}
	}));
	return { parts: parts.flat(), stored: attachments.map(toStoredAttachment) };
}

/** The attachment without its data: an embedded one is in the history already, as text or as an image. */
function toStoredAttachment(attachment: MessageAttachment): MessageAttachment {
	if (attachment.type !== MessageAttachmentKind.EmbeddedResource) {
		return attachment;
	}
	return {
		type: MessageAttachmentKind.Simple,
		label: attachment.label,
		...attachment.displayKind !== undefined ? { displayKind: attachment.displayKind } : {},
		...attachment.range !== undefined ? { range: attachment.range } : {},
		...attachment._meta !== undefined ? { _meta: attachment._meta } : {},
	};
}

async function resolveAttachment(attachment: MessageAttachment, options: IKodiaAttachmentOptions): Promise<IByokLmContentPart[]> {
	switch (attachment.type) {
		case MessageAttachmentKind.Simple:
			// a command or a skill has none: only what the producer says the model should see is sent
			return attachment.modelRepresentation ? [textPart(blockOf(`Attached context "${attachment.label}":`, attachment.modelRepresentation, cutNote(attachment.modelRepresentation.length)))] : [];
		case MessageAttachmentKind.EmbeddedResource:
			return resolveEmbedded(attachment, options);
		case MessageAttachmentKind.Resource:
			return resolveResource(attachment, options);
		default:
			// review comments, another chat: nothing the agent can read
			return [textPart(`The user attached ${describe(attachment)}, which this agent cannot read.`)];
	}
}

// #region Embedded resources: pasted text, an unsaved editor, an image, when the host could not keep a copy of them on disk

async function resolveEmbedded(attachment: MessageEmbeddedResourceAttachment, options: IKodiaAttachmentOptions): Promise<IByokLmContentPart[]> {
	const contentType = attachment.contentType.toLowerCase().split(';', 1)[0].trim();
	if (contentType.startsWith('image/')) {
		return imageParts(attachment.label, contentType, options, () => ({ data: attachment.data, bytes: Math.floor(attachment.data.length / 4 * 3) }));
	}
	if (isTextualContentType(contentType)) {
		const content = decodeBase64(attachment.data).toString();
		const range = attachment.selection && !isEmptyRange(attachment.selection.range) ? attachment.selection.range : undefined;
		return [textPart(blockOf(range ? `Attached selection "${attachment.label}"${linesOf(range)}:` : `Attached "${attachment.label}":`, content, cutNote(content.length)))];
	}
	return [textPart(`The user attached "${attachment.label}" (${attachment.contentType}), which this agent cannot read.`)];
}

// text/* and the structured text of application/*, which can be shown to the model: anything else is binary
function isTextualContentType(contentType: string): boolean {
	return contentType.startsWith('text/')
		|| ['application/json', 'application/xml', 'application/javascript', 'application/typescript'].includes(contentType)
		|| contentType.endsWith('+json') || contentType.endsWith('+xml');
}

// #endregion

// #region Resources: files and folders, and a selection of a file

async function resolveResource(attachment: MessageResourceAttachment, options: IKodiaAttachmentOptions): Promise<IByokLmContentPart[]> {
	const uri = URI.parse(attachment.uri);
	const path = pathOf(uri);
	// a copy the host made of what the client had (a pasted text, an image, a file of another machine): the model must not edit it
	const snapshot = isHostSnapshotAttachment(attachment) ? ` (a read-only copy of "${attachment.label}": do not edit it)` : '';

	if (attachment.displayKind === 'directory') {
		return [textPart(await folderListing(uri, path, options.fileService))];
	}

	const contentType = attachment.contentType ?? readHostSnapshotAttachmentMeta(attachment)?.contentType ?? getMediaMime(uri.path);
	if (attachment.displayKind === 'image' || contentType?.startsWith('image/')) {
		return imageParts(attachment.label, contentType, options, async () => {
			const file = await readFile(uri, MAX_IMAGE_BYTES, options.fileService);
			return { data: encodeBase64(file), bytes: file.byteLength };
		}, path);
	}

	// the lines the user selected: as the editor had them when the user attached them, else as the file has them
	const range = attachment.selection && !isEmptyRange(attachment.selection.range) ? attachment.selection.range : undefined;
	const detail = readAttachmentDetail(attachment);
	const selected = range && detail?.type === 'selection' && detail.text !== undefined ? detail.text : undefined;
	if (selected !== undefined && range) {
		return [textPart(blockOf(`Attached selection of ${path}${linesOf(range)}${snapshot}:`, selected, cutNote(selected.length)))];
	}

	const file = await readFile(uri, MAX_FILE_BYTES, options.fileService);
	if (isBinary(file)) {
		return [textPart(`The user attached the file ${path}${snapshot}, which is binary: it is not shown.`)];
	}
	const content = file.toString();
	if (range) {
		const text = textInRange(content, range);
		return [textPart(blockOf(`Attached selection of ${path}${linesOf(range)}${snapshot}:`, text, cutNote(text.length)))];
	}
	return [textPart(blockOf(`Attached file: ${path}${snapshot}`, content, cutNote(content.length, true)))];
}

async function folderListing(uri: URI, path: string, fileService: IFileService): Promise<string> {
	const stat = await fileService.resolve(uri);
	if (!stat.isDirectory) {
		throw new Error(`${path} is not a folder.`);
	}
	// folders first, then by name, as ls_dir lists them
	const entries = [...stat.children ?? []].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
	const lines = entries.slice(0, MAX_FOLDER_ENTRIES).map(entry => `${entry.name}${entry.isDirectory ? '/' : ''}`);
	if (entries.length > MAX_FOLDER_ENTRIES) {
		lines.push(`(${entries.length - MAX_FOLDER_ENTRIES} more entries: list the folder with ls_dir, page_number 2)`);
	}
	return blockOf(`Attached folder: ${path}`, lines.length ? lines.join('\n') : '(empty)');
}

async function readFile(uri: URI, maxBytes: number, fileService: IFileService): Promise<VSBuffer> {
	try {
		return (await fileService.readFile(uri, { limits: { size: maxBytes } })).value;
	} catch (err) {
		if (err instanceof Error && toFileOperationResult(err) === FileOperationResult.FILE_TOO_LARGE) {
			throw new Error(`it is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
		}
		throw err;
	}
}

// a NUL byte in the first bytes: no text file has one
function isBinary(file: VSBuffer): boolean {
	return file.buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

// #endregion

// #region Images

/**
 * An image as the model is sent it: a label and the image itself, if the model can see it. Otherwise (or if it can't be
 * sent) the model is told one was attached. `load` is only called when the image is to be sent.
 */
async function imageParts(label: string, contentType: string | undefined, options: IKodiaAttachmentOptions, load: () => { data: string; bytes: number } | Promise<{ data: string; bytes: number }>, path?: string): Promise<IByokLmContentPart[]> {
	const name = path ? `"${label}" (${path})` : `"${label}"`;
	if (!options.supportsVision) {
		return [textPart(`The user attached the image ${name}, but the model cannot see images, so you cannot see it. If the request depends on it, tell the user.`)];
	}
	const mimeType = (contentType === 'image/jpg' ? 'image/jpeg' : contentType) as ByokLmImageMimeType | undefined;
	if (!mimeType || !IMAGE_MIME_TYPES.includes(mimeType)) {
		return [textPart(`The user attached the image ${name}, which is ${contentType ?? 'of an unknown type'}: only PNG, JPEG, WebP and GIF images can be sent to the model, so you cannot see it.`)];
	}
	const { data, bytes } = await load();
	if (bytes > MAX_IMAGE_BYTES) {
		return [textPart(`The user attached the image ${name}, which is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB: it is not sent, so you cannot see it.`)];
	}
	return [textPart(`Attached image: ${label}`), { type: 'image', mimeType, data }];
}

// #endregion

// #region Text

// the content of an attachment, fenced as read_file shows a file: a header, then the content, then what is left out
function blockOf(header: string, content: string, note = ''): string {
	// the last line break of the content is the one before the fence
	const shown = content.slice(0, MAX_ATTACHMENT_CHARS).replace(/\r?\n$/, '');
	return `${header}\n\`\`\`\n${shown}\n\`\`\`${note}`;
}

function cutNote(length: number, isFile = false): string {
	if (length <= MAX_ATTACHMENT_CHARS) {
		return '';
	}
	return isFile
		? `\n(This file is cut here: the first ${MAX_ATTACHMENT_CHARS} of its ${length} characters are shown. read_file with page_number 2 gives the rest.)`
		: `\n(Cut here: the first ${MAX_ATTACHMENT_CHARS} of ${length} characters are shown.)`;
}

function isEmptyRange(range: TextRange): boolean {
	return range.start.line === range.end.line && range.start.character === range.end.character;
}

// The lines of a range, one-based as the editor numbers them. A range that ends at the start of a line doesn't include it.
function linesOf(range: TextRange): string {
	const endLine = range.end.character === 0 && range.end.line > range.start.line ? range.end.line - 1 : range.end.line;
	return range.start.line === endLine ? ` (line ${range.start.line + 1})` : ` (lines ${range.start.line + 1}-${endLine + 1})`;
}

function textInRange(text: string, range: TextRange): string {
	const lines = text.split(/\r?\n/);
	const picked = lines.slice(range.start.line, range.end.line + 1);
	if (picked.length === 0) {
		return '';
	}
	const last = picked.length - 1;
	picked[last] = picked[last].slice(0, range.end.line - range.start.line === last ? range.end.character : undefined);
	picked[0] = picked[0].slice(range.start.character);
	return picked.join('\n');
}

const pathOf = (uri: URI) => uri.scheme === 'file' ? uri.fsPath : uri.toString();

// what an attachment is, for a note about it
function describe(attachment: MessageAttachment): string {
	switch (attachment.type) {
		case MessageAttachmentKind.Resource: return `${attachment.displayKind === 'directory' ? 'the folder' : 'the file'} "${attachment.label}" (${pathOf(URI.parse(attachment.uri))})`;
		case MessageAttachmentKind.Annotations: return `review comments ("${attachment.label}")`;
		case MessageAttachmentKind.Chat: return `another chat ("${attachment.label}")`;
		default: return `"${attachment.label}"`;
	}
}

// #endregion
