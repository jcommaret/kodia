/*
 * Commit message guidelines — Conventional Commits 1.0.0 (https://www.conventionalcommits.org/en/v1.0.0/),
 * checked on every `git commit` by the commit-msg hook.
 *
 * Wired through husky (devDependency): `npm install` installs the git hooks, which run the
 * package.json script `commitmsg`. If commits aren't being checked, run `npm run reinstall-git-hooks`.
 * To commit anyway (e.g. a work-in-progress commit on a private branch): `git commit --no-verify`.
 *
 *   feat(agent): run a turn's read-only tool calls in parallel     <- header: type(scope): description
 *                                                                  <- blank line
 *   Every provider kept only the first tool call of a turn, so     <- body: what changed and *why*,
 *   reading N files took N round-trips.                               wrapped at ~72 characters
 *                                                                  <- blank line
 *   BREAKING CHANGE: OnFinalMessage returns toolCalls[]            <- footers (git trailers), if any
 *   Co-Authored-By: Name <email>
 *
 * Header
 *   - type: what kind of change it is —
 *       feat      a new feature                     fix       a bug fix
 *       perf      a performance improvement         refactor  a change that neither fixes a bug nor adds a feature
 *       docs      documentation only                style     formatting, no change in behavior
 *       test      adding or fixing tests            build     build system, dependencies, packaging
 *       ci        CI configuration and scripts      chore     anything else that doesn't touch src or tests
 *       revert    reverts a previous commit
 *   - scope (optional): the area of the codebase, in parentheses — e.g. feat(mistral):, fix(chat):
 *   - `!` before the colon marks a breaking change: feat(api)!: ...
 *   - description: right after ": ", in the imperative mood ("add", not "added"/"adds"; French: "ajouter",
 *     not "ajouté"), lowercase unless it starts with a name, no period at the end.
 *   - The whole header: 72 characters or less (100 at most — longer headers are rejected).
 *
 * Body (optional for small changes)
 *   - Separated from the header by a blank line.
 *   - Explains why the change is needed and what it changes in behavior; the diff shows how.
 *
 * Footers (optional)
 *   - After a blank line, in git trailer format: `Token: value` (tokens use - instead of spaces).
 *   - A breaking change is announced with `!` in the header and/or a `BREAKING CHANGE: ...` footer
 *     (uppercase; BREAKING-CHANGE is the same).
 *
 * English or French are both fine. Merge, revert ("Revert ..."), fixup! and squash! commits are not checked,
 * nor are commits made in CI.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MAX_HEADER = 100
const RECOMMENDED_HEADER = 72
const MAX_BODY_LINE = 100

// the types of @commitlint/config-conventional
export const commitTypes = ['feat', 'fix', 'perf', 'refactor', 'docs', 'style', 'test', 'build', 'ci', 'chore', 'revert']

// type, optional (scope), optional !, then ": " and the description
const headerPattern = /^(?<type>[A-Za-z]+)(?:\((?<scope>[^()]*)\))?(?<breaking>!)?: (?<description>.*)$/

// first words that aren't in the imperative mood
const nonImperativeWords = new Set([
	'added', 'adding', 'adds', 'fixed', 'fixing', 'fixes', 'updated', 'updating', 'updates',
	'removed', 'removing', 'removes', 'changed', 'changing', 'changes', 'refactored', 'refactoring', 'refactors',
	'implemented', 'implementing', 'implements', 'improved', 'improving', 'improves',
	'created', 'creating', 'creates', 'deleted', 'deleting', 'deletes', 'moved', 'moving', 'moves',
	'renamed', 'renaming', 'renames', 'cleaned', 'cleaning', 'bumped', 'bumping',
	'ajouté', 'ajoutée', 'ajoutés', 'corrigé', 'corrigée', 'modifié', 'modifiée', 'supprimé', 'supprimée',
	'amélioré', 'améliorée', 'remplacé', 'créé', 'créée', 'déplacé', 'renommé', 'simplifié', 'refactorisé', 'nettoyé', 'mis',
])

// descriptions that say nothing about the change
const placeholderDescription = /^(wip|fix|fixes|fixed|update|updates|updated|change|changes|misc|tmp|temp|test|tests|stuff|\.+)[.!]?$/i

// messages git or GitHub generate, or that will be rewritten anyway
const skippedHeader = /^(Merge |Revert "|fixup! |squash! |amend! )/

// Keep what git would keep: the editor template's comment lines and everything below the
// `git commit -v` scissors line are removed after this hook runs.
const messageLines = (raw) => {
	const lines = raw.split(/\r?\n/)
	const scissors = lines.findIndex(l => /^# -+ >8 -+$/.test(l))
	return (scissors === -1 ? lines : lines.slice(0, scissors))
		.filter(l => !l.startsWith('#'))
		.map(l => l.trimEnd())
}

export const checkCommitMessage = (raw) => {
	const errors = []
	const warnings = []

	const lines = messageLines(raw)
	while (lines.length && lines[0] === '') lines.shift()
	while (lines.length && lines[lines.length - 1] === '') lines.pop()

	const header = lines[0] ?? ''
	if (!header) return { errors: ['The commit message is empty.'], warnings }
	if (skippedHeader.test(header)) return { errors, warnings }

	const match = headerPattern.exec(header)
	if (!match) {
		errors.push(`The header must be "type(scope): description", e.g. "fix(chat): keep images when switching models" — got "${header}".`)
	}
	else {
		const { type, scope, description } = match.groups
		const firstWord = description.split(/\s+/)[0]

		if (!commitTypes.includes(type.toLowerCase())) {
			errors.push(`"${type}" is not a commit type. Use one of: ${commitTypes.join(', ')}.`)
		}
		else if (type !== type.toLowerCase()) {
			warnings.push(`Write the type in lowercase: "${type.toLowerCase()}".`)
		}
		if (scope !== undefined && !scope.trim()) {
			errors.push('The scope is empty: remove the parentheses or name the area, e.g. "feat(chat): ...".')
		}
		if (!description.trim() || /^\s/.test(description)) {
			errors.push('Write the description right after ": " (one space).')
		}
		else {
			if (placeholderDescription.test(description)) {
				errors.push(`"${description}" doesn't say what changed. Describe the change, e.g. "fix(auth): handle an empty API key".`)
			}
			if (nonImperativeWords.has(firstWord.toLowerCase())) {
				errors.push(`Use the imperative mood: "${firstWord}" -> e.g. "add", "fix", "update" (French: "ajouter", "corriger").`)
			}
			if (description.endsWith('.')) {
				errors.push('Remove the period at the end of the description.')
			}
			if (/^\p{Lu}\p{Ll}/u.test(description)) {
				warnings.push(`Start the description in lowercase unless it begins with a name: "${firstWord}".`)
			}
		}
	}

	if (header.length > MAX_HEADER) {
		errors.push(`The header is ${header.length} characters; keep it under ${RECOMMENDED_HEADER} (${MAX_HEADER} at most) and move details to the body.`)
	}
	else if (header.length > RECOMMENDED_HEADER) {
		warnings.push(`The header is ${header.length} characters; ${RECOMMENDED_HEADER} or less reads best in git log and on GitHub.`)
	}

	if (lines.length > 1 && lines[1] !== '') {
		errors.push('Leave a blank line between the header and the body.')
	}

	// the spec requires the BREAKING CHANGE footer token in uppercase
	const lowercaseBreaking = lines.slice(1).find(l => /^breaking[ -]change:/i.test(l) && !/^BREAKING[ -]CHANGE:/.test(l))
	if (lowercaseBreaking) {
		errors.push(`Write the breaking change footer in uppercase: "BREAKING CHANGE: ..." (got "${lowercaseBreaking.slice(0, 40)}").`)
	}

	const longBodyLines = lines.slice(2).filter(l => l.length > MAX_BODY_LINE && !l.includes('://') && !/^\s/.test(l))
	if (longBodyLines.length > 0) {
		warnings.push(`${longBodyLines.length} body line${longBodyLines.length === 1 ? ' is' : 's are'} over ${MAX_BODY_LINE} characters; wrap the body at ~72.`)
	}

	return { errors, warnings }
}

// run as the hook (not when imported): husky 0.13 passes the message file in GIT_PARAMS, a plain git hook as the first argument
const isEntryPoint = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
const messageFile = process.argv[2] ?? process.env.GIT_PARAMS
if (isEntryPoint && messageFile && !process.env.CI) { // CI scripts write their own messages
	const { errors, warnings } = checkCommitMessage(readFileSync(messageFile, 'utf8'))

	for (const w of warnings) console.warn(`commit-msg: warning: ${w}`)
	if (errors.length > 0) {
		console.error('\ncommit-msg: the commit message needs changes (Conventional Commits, https://www.conventionalcommits.org):')
		for (const e of errors) console.error(`  - ${e}`)
		console.error('\nGuidelines: .husky/commit-msg.mjs. To commit anyway: git commit --no-verify\n')
		process.exit(1)
	}
}
