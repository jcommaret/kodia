/*
 * Commit message guidelines — checked on every `git commit` by the commit-msg hook.
 *
 * Wired through husky (devDependency): `npm install` installs the git hooks, which run the
 * package.json script `commitmsg`. If commits aren't being checked, run `npm run reinstall-git-hooks`.
 * To commit anyway (e.g. a work-in-progress commit on a private branch): `git commit --no-verify`.
 *
 *   Add parallel tool calls to the agent loop          <- subject
 *                                                      <- blank line
 *   Every provider kept only the first tool call of    <- body: what changed and *why*,
 *   a turn, so reading N files took N round-trips.        wrapped at ~72 characters
 *
 *   Co-Authored-By: Name <email>                       <- trailers, if any
 *
 * Subject
 *   - Imperative mood, like a command: "Add", "Fix", "Remove" — not "Added", "Fixes", "Adding".
 *     In French, the infinitive: "Ajouter", "Corriger" — not "Ajouté", "Corrigé".
 *   - Starts with a capital letter. No "fix:" / "chore:" prefixes.
 *   - Says what the commit does: "Fix crash when the API key is empty", not "Fix" or "Update".
 *   - 72 characters or less (100 at most — longer subjects are rejected).
 *
 * Body (optional for small changes)
 *   - Separated from the subject by a blank line.
 *   - Explains why the change is needed and what it changes in behavior; the diff shows how.
 *   - Lines of ~72 characters, except URLs, code and trailers.
 *
 * English or French are both fine. Merge, revert, fixup! and squash! commits are not checked.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MAX_SUBJECT = 100
const RECOMMENDED_SUBJECT = 72
const MAX_BODY_LINE = 100

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

// subjects that say nothing about the change
const placeholderSubject = /^(wip|fix|fixes|fixed|update|updates|updated|change|changes|misc|tmp|temp|test|tests|stuff|\.+)[.!]?$/i

// messages git or GitHub generate, or that will be rewritten anyway
const skippedSubject = /^(Merge |Revert |fixup! |squash! |amend! )/

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

	const subject = lines[0] ?? ''
	if (!subject) return { errors: ['The commit message is empty.'], warnings }
	if (skippedSubject.test(subject)) return { errors, warnings }

	const firstWord = subject.split(/\s+/)[0]

	if (placeholderSubject.test(subject)) {
		errors.push(`"${subject}" doesn't say what changed. Describe the change, e.g. "Fix crash when the API key is empty".`)
	}
	if (/^\p{Ll}/u.test(subject)) {
		errors.push(`Start the subject with a capital letter (no "fix:"-style prefix): "${subject}".`)
	}
	if (nonImperativeWords.has(firstWord.toLowerCase())) {
		errors.push(`Use the imperative mood: "${firstWord}" -> e.g. "Add", "Fix", "Update" (French: "Ajouter", "Corriger").`)
	}
	if (subject.length > MAX_SUBJECT) {
		errors.push(`The subject is ${subject.length} characters; keep it under ${RECOMMENDED_SUBJECT} (${MAX_SUBJECT} at most) and move details to the body.`)
	}
	else if (subject.length > RECOMMENDED_SUBJECT) {
		warnings.push(`The subject is ${subject.length} characters; ${RECOMMENDED_SUBJECT} or less reads best in git log and on GitHub.`)
	}

	if (lines.length > 1 && lines[1] !== '') {
		errors.push('Leave a blank line between the subject and the body.')
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
if (isEntryPoint && messageFile) {
	const { errors, warnings } = checkCommitMessage(readFileSync(messageFile, 'utf8'))

	for (const w of warnings) console.warn(`commit-msg: warning: ${w}`)
	if (errors.length > 0) {
		console.error('\ncommit-msg: the commit message needs changes:')
		for (const e of errors) console.error(`  - ${e}`)
		console.error('\nGuidelines: .husky/commit-msg.mjs. To commit anyway: git commit --no-verify\n')
		process.exit(1)
	}
}
