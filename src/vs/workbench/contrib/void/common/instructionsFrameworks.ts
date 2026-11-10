/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { asTextOrError, IRequestService } from '../../../../platform/request/common/request.js';

// A set of guidelines (a CLAUDE.md, an AGENTS.md, ...) added to the AI's instructions while it's on.
// Kodia keeps the text it downloaded: the instructions don't change until the user updates the framework.
export type InstructionsFramework = {
	id: string;
	name: string;
	sourceURL: string; // where `content` is downloaded from, '' for instructions the user wrote in Kodia
	content: string;
	isOn: boolean;
}

type BuiltinInstructionsFramework = { id: string, name: string, group: string, description: string, homepage: string, sourceURL: string, adaptForKodia?: (content: string) => string }

// AIDD's AGENTS.md says the project's memory lives in aidd_docs/, which its Claude Code plugins create and fill in
// between aidd_project_memory markers. Kodia has neither and keeps its own project memory (.kodia/memory.md), so the
// "Memory Management" section goes, with any other line about aidd_docs/ or the markers.
const withoutAIDDMemory = (content: string): string => {
	const lines = content.split('\n')
	const start = lines.findIndex(line => /^##\s+Memory Management\s*$/.test(line))
	const end = start === -1 ? -1 : lines.findIndex((line, i) => i > start && /^#{1,2}\s/.test(line))
	const kept = start === -1 ? lines : [...lines.slice(0, start), ...(end === -1 ? [] : lines.slice(end))]
	return kept.filter(line => !/aidd_docs\/|aidd_project_memory/.test(line)).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// The rules agent-rules-books condensed from a software book: its mini version, a few thousand characters
const bookFramework = (id: string, name: string, description: string): BuiltinInstructionsFramework => ({
	id,
	name,
	group: 'Software books (agent-rules-books)',
	description,
	homepage: `https://github.com/ciembor/agent-rules-books/tree/main/${id}`,
	sourceURL: `https://raw.githubusercontent.com/ciembor/agent-rules-books/main/${id}/${id}.mini.md`,
})

// The frameworks Kodia offers. Their text is downloaded from their repository when the user turns one on.
export const builtinInstructionsFrameworks: readonly BuiltinInstructionsFramework[] = [
	{
		id: 'karpathy',
		name: 'Karpathy guidelines',
		group: 'Agent behavior',
		description: 'Think before coding, simplicity first, surgical changes, goal-driven execution: against the common LLM coding mistakes Andrej Karpathy observed.',
		homepage: 'https://github.com/multica-ai/andrej-karpathy-skills',
		sourceURL: 'https://raw.githubusercontent.com/multica-ai/andrej-karpathy-skills/main/CLAUDE.md',
	},
	{
		id: 'aidd',
		name: 'AI-Driven Dev',
		group: 'Agent behavior',
		description: 'The AGENTS.md of the AI-Driven Dev framework: critical and anti-sycophantic, concise, evidence over assertion, minimal changes. Without its memory section, which needs AIDD\'s plugins: Kodia keeps its own project memory.',
		homepage: 'https://github.com/ai-driven-dev/framework',
		sourceURL: 'https://raw.githubusercontent.com/ai-driven-dev/framework/main/plugins/aidd-context/skills/02-project-memory/assets/templates/AGENTS.md',
		adaptForKodia: withoutAIDDMemory,
	},
	{
		id: 'superclaude',
		name: 'SuperClaude principles',
		group: 'Agent behavior',
		description: 'The engineering principles of the SuperClaude framework: evidence over assumptions, SOLID, KISS, YAGNI, trade-off and risk analysis.',
		homepage: 'https://github.com/SuperClaude-Org/SuperClaude_Framework',
		sourceURL: 'https://raw.githubusercontent.com/SuperClaude-Org/SuperClaude_Framework/master/src/superclaude/core/PRINCIPLES.md',
	},
	bookFramework('clean-code', 'Clean Code', 'Robert C. Martin: readable code, precise names, small functions, no hidden side effects.'),
	bookFramework('clean-architecture', 'Clean Architecture', 'Robert C. Martin: business rules independent of frameworks, databases and delivery, dependencies pointing inward.'),
	bookFramework('a-philosophy-of-software-design', 'A Philosophy of Software Design', 'John Ousterhout: deep modules, information hiding, less cognitive load.'),
	bookFramework('the-pragmatic-programmer', 'The Pragmatic Programmer', 'Andrew Hunt and David Thomas: own the outcome, no duplicated knowledge, fast feedback, code easy to change.'),
	bookFramework('refactoring', 'Refactoring', 'Martin Fowler: behavior-preserving changes in small, tested steps, no hidden rewrites.'),
	bookFramework('working-effectively-with-legacy-code', 'Working Effectively with Legacy Code', 'Michael Feathers: get code under test before changing it, through seams and broken dependencies.'),
	bookFramework('domain-driven-design', 'Domain-Driven Design', 'Eric Evans: a model and a language shared with the domain, inside explicit bounded contexts.'),
	bookFramework('release-it', 'Release It!', 'Michael T. Nygard: production readiness, with timeouts, limits, isolation, recovery and diagnosis.'),
]

// The text Kodia keeps for a framework: a built-in one may need adapting to Kodia
export const instructionsFrameworkContentForKodia = (id: string, content: string): string =>
	builtinInstructionsFrameworks.find(f => f.id === id)?.adaptForKodia?.(content) ?? content

// sent with every request
const MAX_FRAMEWORK_LENGTH = 50_000

// The raw files to download for a URL the user pasted: a GitHub file page gives its raw file, a GitHub repository its AGENTS.md or CLAUDE.md
export const rawURLsOfFrameworkSource = (url: string): string[] => {
	const { protocol, hostname, pathname } = URL.canParse(url) ? new URL(url) : { protocol: '', hostname: '', pathname: '' }
	if (protocol !== 'https:' && protocol !== 'http:') throw new Error('Enter a web link (https://...).')
	if (hostname !== 'github.com' && hostname !== 'www.github.com') return [url]

	const [owner, repo, kind, ref, ...path] = pathname.split('/').filter(s => !!s)
	if (owner && repo && !kind) {
		return ['AGENTS.md', 'CLAUDE.md'].map(fileName => `https://raw.githubusercontent.com/${owner}/${repo.replace(/\.git$/, '')}/HEAD/${fileName}`)
	}
	if (owner && repo && kind === 'blob' && ref && path.length > 0) {
		return [`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path.join('/')}`]
	}
	throw new Error('Enter the link of a GitHub repository or of a file in one (.../blob/...).')
}

export const downloadInstructionsFramework = async (requestService: IRequestService, url: string): Promise<string> => {
	const rawURLs = rawURLsOfFrameworkSource(url)
	let error: unknown = undefined
	for (const rawURL of rawURLs) {
		try {
			const context = await requestService.request({ type: 'GET', url: rawURL, callSite: 'kodia.instructionsFramework' }, CancellationToken.None)
			if (context.res.statusCode === 404) {
				throw new Error(rawURLs.length > 1 ? `This repository has no ${rawURLs.map(u => u.split('/').pop()).join(' or ')}: enter the link of the file to use.` : `Nothing at ${rawURL}.`)
			}
			const text = (await asTextOrError(context))?.trim() ?? ''
			if (!text) throw new Error(`${rawURL} is empty.`)
			if (/^<(!doctype html|html)/i.test(text)) throw new Error(`${rawURL} is a web page, not a text file: use the link of the raw file.`)
			if (text.length > MAX_FRAMEWORK_LENGTH) throw new Error(`${rawURL} is too long to send with every request (${text.length} characters, ${MAX_FRAMEWORK_LENGTH} at most).`)
			return text
		}
		catch (e) {
			error = e
		}
	}
	throw error
}

// The instructions from the user's settings: their own text, then the frameworks they turned on
export const joinUserInstructions = (aiInstructions: string, frameworks: readonly InstructionsFramework[]): string => {
	const parts: string[] = []
	if (aiInstructions) parts.push(aiInstructions)
	for (const { name, content, isOn } of frameworks) {
		if (isOn && content.trim()) parts.push(`From ${name}:\n${content.trim()}`)
	}
	return parts.join('\n\n')
}
