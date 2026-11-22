/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Next-Edit Prediction & Tab-to-Jump engine (Mandate §2.1 / §2.2).
 *
 * Combines:
 *   1. Instant deterministic edit-target detection (detects renamed identifiers or
 *      repeated occurrences across the active document after an edit so Tab-to-Jump
 *      works instantaneously even offline / zero latency).
 *   2. Compact LLM next-edit request builder & structured response parser for deeper
 *      multi-line predictions with ANY BYOK model.
 */

export interface RecentEditRecord {
	readonly uri: string;
	readonly lineNumber: number;
	readonly beforeLine: string;
	readonly afterLine: string;
	readonly timestamp: number;
}

export interface NextEditTarget {
	readonly lineNumber: number;
	readonly reason: string;
	readonly originalLine: string;
	readonly suggestedLine: string;
}

function extractIdentifiers(line: string): string[] {
	return [...new Set((line.match(/\b[A-Za-z_$][A-Za-z0-9_$]{2,}\b/g) ?? []))];
}

/**
 * Deterministically find likely next-edit jump targets in `lines` given the user's
 * most recent edit (e.g. a renamed identifier that still appears elsewhere in the file).
 */
export function findDeterministicNextEditTargets(
	lines: readonly string[],
	lastEdit: RecentEditRecord,
	maxTargets = 5,
): NextEditTarget[] {
	const beforeIds = extractIdentifiers(lastEdit.beforeLine);
	const afterIds = extractIdentifiers(lastEdit.afterLine);

	const removedIds = beforeIds.filter(id => !afterIds.includes(id));
	const addedIds = afterIds.filter(id => !beforeIds.includes(id));

	// Classic rename pattern: exactly one identifier replaced by one new identifier on the edited line
	if (removedIds.length === 1 && addedIds.length === 1) {
		const oldId = removedIds[0];
		const newId = addedIds[0];
		const wordRe = new RegExp(`\\b${oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
		const targets: NextEditTarget[] = [];

		// Search outward from lastEdit.lineNumber so nearest jump comes first
		const indices = lines.map((_, idx) => idx + 1)
			.filter(ln => ln !== lastEdit.lineNumber)
			.sort((a, b) => Math.abs(a - lastEdit.lineNumber) - Math.abs(b - lastEdit.lineNumber));

		for (const ln of indices) {
			const text = lines[ln - 1];
			if (wordRe.test(text)) {
				wordRe.lastIndex = 0;
				targets.push({
					lineNumber: ln,
					reason: `Update "${oldId}" → "${newId}"`,
					originalLine: text,
					suggestedLine: text.replace(wordRe, newId),
				});
				if (targets.length >= maxTargets) { break; }
			}
		}
		return targets;
	}

	return [];
}

export function buildNextEditPredictionRequest(opts: {
	filePath: string;
	languageId: string;
	cursorLine: number;
	windowStartLine: number;
	windowContent: string;
	recentEdits: readonly RecentEditRecord[];
}): { systemMessage: string; userMessage: string } {
	const systemMessage = [
		'You are Kodia Next-Edit Predictor. Given a developer\'s recent edits and the surrounding code window, predict the single most likely next edit location and replacement.',
		'Return ONLY valid JSON with shape: {"line": <1-based line number>, "reason": "<short reason>", "original": "<exact current line>", "replacement": "<updated line>"} or {"none": true} if no follow-up edit is needed.',
	].join('\n');

	const editsStr = opts.recentEdits.slice(-5).map(e =>
		`- Line ${e.lineNumber}: "${e.beforeLine.trim()}" -> "${e.afterLine.trim()}"`
	).join('\n');

	const userMessage = [
		`File: ${opts.filePath} (${opts.languageId})`,
		`Cursor line: ${opts.cursorLine}`,
		`Recent edits:\n${editsStr || '(none)'}`,
		`Code starting at line ${opts.windowStartLine}:`,
		'```',
		opts.windowContent,
		'```',
	].join('\n\n');

	return { systemMessage, userMessage };
}

export function parseNextEditPredictionResponse(raw: string): NextEditTarget | null {
	const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
	const jsonMatch = /\{[\s\S]*\}/.exec(cleaned);
	if (!jsonMatch) { return null; }
	try {
		const parsed = JSON.parse(jsonMatch[0]) as { none?: boolean; line?: number; reason?: string; original?: string; replacement?: string };
		if (parsed.none) { return null; }
		if (typeof parsed.line !== 'number' || !Number.isInteger(parsed.line) || parsed.line < 1) { return null; }
		if (typeof parsed.original !== 'string' || typeof parsed.replacement !== 'string' || parsed.original === parsed.replacement) { return null; }
		return {
			lineNumber: parsed.line,
			reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : 'Predicted next edit',
			originalLine: parsed.original,
			suggestedLine: parsed.replacement,
		};
	} catch {
		return null;
	}
}
