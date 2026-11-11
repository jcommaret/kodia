/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Fetching a web page as text, for Kodia's chat (fetch_url) and the Kodia agent of the Agents window.

import { htmlToText } from '../common/htmlToText.js';

const FETCH_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 5_000_000

export type WebPage = { url: string, title: string | null, text: string }

const isTextContentType = (contentType: string) =>
	contentType.startsWith('text/') || /\b(json|xml|javascript|yaml|toml)\b/.test(contentType)

// reads at most `maxBytes` of the body, so a huge download stops early
const readBody = async (res: Response, maxBytes: number) => {
	if (!res.body) return ''
	const reader = res.body.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	while (size < maxBytes) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(value)
		size += value.byteLength
	}
	reader.cancel().catch(() => { })
	return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes))
}

// an http(s) page's text: HTML is converted to text, other text types are kept as they are
export const fetchWebPage = async (url: string, signal?: AbortSignal): Promise<WebPage> => {
	let parsed: URL
	try { parsed = new URL(url) }
	catch { throw new Error(`"${url}" is not a valid URL.`) }
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`Only http and https URLs can be fetched, not ${parsed.protocol}`)

	const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
	const res = await fetch(parsed, {
		redirect: 'follow',
		signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		headers: {
			'User-Agent': 'Mozilla/5.0 (compatible; Kodia; +https://github.com/jcommaret/kodia)',
			'Accept': 'text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5',
		},
	}).catch((e: Error) => { throw new Error(e.name === 'TimeoutError' ? `Timed out after ${FETCH_TIMEOUT_MS / 1000}s.` : `Request failed: ${e.message}`) })

	if (!res.ok) throw new Error(`The server answered ${res.status} ${res.statusText}.`)

	const contentType = (res.headers.get('content-type') ?? 'text/html').toLowerCase()
	if (!isTextContentType(contentType)) throw new Error(`Can't read this page: its content type is ${contentType}, not text.`)

	const body = await readBody(res, MAX_RESPONSE_BYTES)
	if (contentType.includes('html')) {
		const { title, text } = htmlToText(body, res.url)
		return { url: res.url, title, text }
	}
	return { url: res.url, title: null, text: body }
}
