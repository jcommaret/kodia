/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Turns a web page into the markdown-ish text fetch_url gives the LLM: headings, lists, links and code blocks
// are kept, scripts, styles and navigation are dropped. Not a full HTML parser, just enough for docs and articles.

const namedEntities: Record<string, string> = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
	laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•',
}

export const decodeHTMLEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
	if (entity[0] === '#') {
		const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
		return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : match
	}
	return namedEntities[entity.toLowerCase()] ?? match
})

const stripTags = (s: string) => s.replace(/<[^>]*>/g, '')

const resolveURL = (href: string, baseURL: string | undefined) => {
	try { return new URL(href, baseURL).href }
	catch { return null }
}

export const htmlToText = (html: string, baseURL?: string): { title: string | null, text: string } => {
	const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
	const title = titleMatch ? decodeHTMLEntities(stripTags(titleMatch[1])).replace(/\s+/g, ' ').trim() || null : null

	let s = html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<(script|style|noscript|svg|template|iframe|head|title|nav|footer|button)\b[\s\S]*?<\/\1\s*>/gi, '')

	// the page's main content when it says where it is: <main>, <article>, or from the element with role="main" on
	const main = /<main\b[^>]*>([\s\S]*)<\/main\s*>/i.exec(s) ?? /<article\b[^>]*>([\s\S]*)<\/article\s*>/i.exec(s)
	const roleMain = /<[a-z][^>]*\srole\s*=\s*["']?main\b[^>]*>/i.exec(s)
	if (main) s = main[1]
	else if (roleMain) s = s.slice(roleMain.index + roleMain[0].length)

	// code blocks keep their whitespace: set them aside until the rest is collapsed
	const codeBlocks: string[] = []
	s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, inner: string) => {
		// just the <code> elements when there are some: a toolbar around them (language, copy button) isn't code
		const codes = [...inner.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi)].map(m => m[1])
		const body = codes.length > 0 ? codes.join('\n') : inner
		const code = decodeHTMLEntities(stripTags(body.replace(/<br\s*\/?>/gi, '\n'))).replace(/^\n+|\s+$/g, '')
		codeBlocks.push('```\n' + code + '\n```')
		return `\n\n\uE000${codeBlocks.length - 1}\uE000\n\n`
	})

	s = s
		.replace(/<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, dq: string | undefined, sq: string | undefined, uq: string | undefined, inner: string) => {
			const href = dq ?? sq ?? uq ?? ''
			const label = stripTags(inner).replace(/\s+/g, ' ').trim()
			const isAnchor = href.startsWith('#')
			if (isAnchor && /^[#¶§]$/.test(label)) return '' // a heading's permalink
			const url = isAnchor || href.startsWith('javascript:') ? null : resolveURL(decodeHTMLEntities(href), baseURL)
			return label && url ? `[${label}](${url})` : label
		})
		// after links, so a heading's permalink is already gone
		.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${stripTags(inner).trim()}\n\n`)
		.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_, inner: string) => '`' + stripTags(inner) + '`')
		.replace(/<li\b[^>]*>/gi, '\n- ')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/?(p|div|section|ul|ol|table|tr|blockquote|header|aside|dl|dt|dd|figure|hr)\b[^>]*>/gi, '\n\n')
		.replace(/<\/t[dh]\s*>/gi, ' | ')

	s = decodeHTMLEntities(stripTags(s))
		.split('\n').map(line => line.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.replace(/\uE000(\d+)\uE000/g, (_, i: string) => codeBlocks[Number(i)])
		.trim()

	return { title, text: s }
}
