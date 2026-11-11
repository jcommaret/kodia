/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// SEARCH/REPLACE blocks, the format `edit_file` and Apply edit a file with: the format and its description for the
// model, the parser of a model's blocks (which may still be streaming in), and the edit itself. Pure text, so the editor
// (which applies the edit to a model, with a diff to review) and the Kodia agent of the Agents window (which writes the
// file) edit the same way.


// ---- the format ----

export const ORIGINAL = `<<<<<<< ORIGINAL`
export const DIVIDER = `=======`
export const FINAL = `>>>>>>> UPDATED`



export const searchReplaceBlockTemplate = `\
${ORIGINAL}
// ... original code goes here
${DIVIDER}
// ... final code goes here
${FINAL}

${ORIGINAL}
// ... original code goes here
${DIVIDER}
// ... final code goes here
${FINAL}`


export const replaceTool_description = `\
A string of SEARCH/REPLACE block(s) which will be applied to the given file.
Your SEARCH/REPLACE blocks string must be formatted as follows:
${searchReplaceBlockTemplate}

## Guidelines:

1. You may output multiple search replace blocks if needed.

2. The ORIGINAL code in each SEARCH/REPLACE block must EXACTLY match lines in the original file. Do not add or remove any whitespace or comments from the original code.

3. Each ORIGINAL text must be large enough to uniquely identify the change. However, bias towards writing as little as possible.

4. Each ORIGINAL text must be DISJOINT from all other ORIGINAL text.

5. This field is a STRING (not an array).`


// ---- the parser ----

export type ExtractedSearchReplaceBlock = {
	state: 'writingOriginal' | 'writingFinal' | 'done',
	orig: string,
	final: string,
}


// JS substring swaps indices, so "ab".substr(1,0) will NOT be '', it will be 'a'!
const voidSubstr = (str: string, start: number, end: number) => end < start ? '' : str.substring(start, end)

export const endsWithAnyPrefixOf = (str: string, anyPrefix: string) => {
	// for each prefix
	for (let i = anyPrefix.length; i >= 1; i--) { // i >= 1 because must not be empty string
		const prefix = anyPrefix.slice(0, i)
		if (str.endsWith(prefix)) return prefix
	}
	return null
}

// guarantees if you keep adding text, array length will strictly grow and state will progress without going back
export const extractSearchReplaceBlocks = (str: string) => {

	const ORIGINAL_ = ORIGINAL + `\n`
	const DIVIDER_ = '\n' + DIVIDER + `\n`
	// logic for FINAL_ is slightly more complicated - should be '\n' + FINAL, but that ignores if the final output is empty

	const blocks: ExtractedSearchReplaceBlock[] = []

	let i = 0 // search i and beyond (this is done by plain index, not by line number. much simpler this way)
	while (true) {
		let origStart = str.indexOf(ORIGINAL_, i)
		if (origStart === -1) { return blocks }
		origStart += ORIGINAL_.length
		i = origStart
		// wrote <<<< ORIGINAL\n

		let dividerStart = str.indexOf(DIVIDER_, i)
		if (dividerStart === -1) { // if didnt find DIVIDER_, either writing originalStr or DIVIDER_ right now
			const writingDIVIDERlen = endsWithAnyPrefixOf(str, DIVIDER_)?.length ?? 0
			blocks.push({
				orig: voidSubstr(str, origStart, str.length - writingDIVIDERlen),
				final: '',
				state: 'writingOriginal'
			})
			return blocks
		}
		const origStrDone = voidSubstr(str, origStart, dividerStart)
		dividerStart += DIVIDER_.length
		i = dividerStart
		// wrote \n=====\n

		const fullFINALStart = str.indexOf(FINAL, i)
		const fullFINALStart_ = str.indexOf('\n' + FINAL, i) // go with B if possible, else fallback to A, it's more permissive
		const matchedFullFINAL_ = fullFINALStart_ !== -1 && fullFINALStart === fullFINALStart_ + 1  // this logic is really important, otherwise we might look for FINAL_ at a much later part of the string

		let finalStart = matchedFullFINAL_ ? fullFINALStart_ : fullFINALStart
		if (finalStart === -1) { // if didnt find FINAL_, either writing finalStr or FINAL or FINAL_ right now
			const writingFINALlen = endsWithAnyPrefixOf(str, FINAL)?.length ?? 0
			const writingFINALlen_ = endsWithAnyPrefixOf(str, '\n' + FINAL)?.length ?? 0 // this gets priority
			const usingWritingFINALlen = Math.max(writingFINALlen, writingFINALlen_)
			blocks.push({
				orig: origStrDone,
				final: voidSubstr(str, dividerStart, str.length - usingWritingFINALlen),
				state: 'writingFinal'
			})
			return blocks
		}
		const usingFINAL = matchedFullFINAL_ ? '\n' + FINAL : FINAL
		const finalStrDone = voidSubstr(str, dividerStart, finalStart)
		finalStart += usingFINAL.length
		i = finalStart
		// wrote >>>>> FINAL

		blocks.push({
			orig: origStrDone,
			final: finalStrDone,
			state: 'done'
		})
	}
}


// ---- the edit: finding a block's ORIGINAL text in the file, and applying the blocks ----

const fence = '```'

const numLinesOfStr = (str: string) => str.split('\n').length

// Helper function to remove whitespace except newlines
const removeWhitespaceExceptNewlines = (str: string): string => {
	return str.replace(/[^\S\n]+/g, '')
}

// finds block.orig in fileContents and return its range in file
// startingAtLine is 1-indexed and inclusive
// returns 1-indexed lines
export const findTextInCode = (text: string, fileContents: string, canFallbackToRemoveWhitespace: boolean, opts: { startingAtLine?: number, returnType: 'lines' }) => {

	const returnAns = (fileContents: string, idx: number) => {
		const startLine = numLinesOfStr(fileContents.substring(0, idx + 1))
		const numLines = numLinesOfStr(text)
		const endLine = startLine + numLines - 1

		return [startLine, endLine] as const
	}

	const startingAtLineIdx = (fileContents: string) => opts?.startingAtLine !== undefined ?
		fileContents.split('\n').slice(0, opts.startingAtLine).join('\n').length // num characters in all lines before startingAtLine
		: 0

	// idx = starting index in fileContents
	let idx = fileContents.indexOf(text, startingAtLineIdx(fileContents))

	// if idx was found
	if (idx !== -1) {
		return returnAns(fileContents, idx)
	}

	if (!canFallbackToRemoveWhitespace)
		return 'Not found' as const

	// try to find it ignoring all whitespace this time
	text = removeWhitespaceExceptNewlines(text)
	fileContents = removeWhitespaceExceptNewlines(fileContents)
	idx = fileContents.indexOf(text, startingAtLineIdx(fileContents));

	if (idx === -1) return 'Not found' as const
	const lastIdx = fileContents.lastIndexOf(text)
	if (lastIdx !== idx) return 'Not unique' as const

	return returnAns(fileContents, idx)
}


export type SearchReplaceProblem = 'Not found' | 'Not unique' | 'Has overlap'

/**
 * Generates a human-readable error message for an invalid ORIGINAL search block.
 */
export const searchReplaceErrorMessage = (
	str: SearchReplaceProblem,
	blockOrig: string,
): string => {
	const problematicCode = `${fence}\n${JSON.stringify(blockOrig)}\n${fence}`

	// use a switch for better readability / exhaustiveness check
	let descStr: string
	switch (str) {
		case 'Not found':
			descStr = `The edit was not applied. The text in ORIGINAL must EXACTLY match lines of code in the file, but there was no match for:\n${problematicCode}. Ensure you have the latest version of the file, and ensure the ORIGINAL code matches a code excerpt exactly.`
			break
		case 'Not unique':
			descStr = `The edit was not applied. The text in ORIGINAL must be unique in the file being edited, but the following ORIGINAL code appears multiple times in the file:\n${problematicCode}. Ensure you have the latest version of the file, and ensure the ORIGINAL code is unique.`
			break
		case 'Has overlap':
			descStr = `The edit was not applied. The text in the ORIGINAL blocks must not overlap, but the following ORIGINAL code had overlap with another ORIGINAL string:\n${problematicCode}. Ensure you have the latest version of the file, and ensure the ORIGINAL code blocks do not overlap.`
			break
		default:
			descStr = ''
	}
	return descStr
}


/**
 * The file's contents (with "\n" line endings) once the SEARCH/REPLACE blocks of `blocksStr` are applied: each block
 * replaces the whole lines its ORIGINAL text is found on. Throws, with a message for the model, if there is no block,
 * or a block's ORIGINAL isn't found, overlaps another one, or (with `requireUnique`) isn't the only match: the
 * editor keeps the first match, the Kodia agent refuses an edit it can't place with certainty.
 */
export const applySearchReplaceBlocks = (fileContents: string, blocksStr: string, opts?: { requireUnique?: boolean }): string => {
	const blocks = extractSearchReplaceBlocks(blocksStr)
	if (blocks.length === 0) throw new Error(`No Search/Replace blocks were received!`)

	const modelStr = fileContents
	// .split('\n').map(l => '\t' + l).join('\n') // for testing purposes only, remember to remove this
	const modelStrLines = modelStr.split('\n')



	const replacements: { origStart: number; origEnd: number; block: ExtractedSearchReplaceBlock }[] = []
	for (const b of blocks) {
		const res = findTextInCode(b.orig, modelStr, true, { returnType: 'lines' })
		if (typeof res === 'string')
			throw new Error(searchReplaceErrorMessage(res, b.orig))
		if (opts?.requireUnique && b.orig !== '' && modelStr.indexOf(b.orig) !== modelStr.lastIndexOf(b.orig))
			throw new Error(searchReplaceErrorMessage('Not unique', b.orig))
		let [startLine, endLine] = res
		startLine -= 1 // 0-index
		endLine -= 1

		// including newline before start
		const origStart = (startLine !== 0 ?
			modelStrLines.slice(0, startLine).join('\n') + '\n'
			: '').length

		// including endline at end
		const origEnd = modelStrLines.slice(0, endLine + 1).join('\n').length - 1

		replacements.push({ origStart, origEnd, block: b });
	}
	// sort in increasing order
	replacements.sort((a, b) => a.origStart - b.origStart)

	// ensure no overlap
	for (let i = 1; i < replacements.length; i++) {
		if (replacements[i].origStart <= replacements[i - 1].origEnd) {
			throw new Error(searchReplaceErrorMessage('Has overlap', replacements[i]?.block?.orig))
		}
	}

	// apply each replacement from right to left (so indexes don't shift)
	let newCode: string = modelStr
	for (let i = replacements.length - 1; i >= 0; i--) {
		const { origStart, origEnd, block } = replacements[i]
		newCode = newCode.slice(0, origStart) + block.final + newCode.slice(origEnd + 1, Infinity)
	}

	return newCode
}
