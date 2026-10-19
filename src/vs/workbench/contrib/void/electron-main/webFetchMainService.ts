/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { htmlToText } from '../common/helpers/htmlToText.js';
import { IKodiaWebFetchService, WebFetchResult } from '../common/webFetchTypes.js';

const FETCH_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 5_000_000

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

export class KodiaWebFetchMainService implements IKodiaWebFetchService {
	readonly _serviceBrand: undefined

	async fetchURL(url: string): Promise<WebFetchResult> {
		let parsed: URL
		try { parsed = new URL(url) }
		catch { throw new Error(`"${url}" is not a valid URL.`) }
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`Only http and https URLs can be fetched, not ${parsed.protocol}`)

		const res = await fetch(parsed, {
			redirect: 'follow',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
}
