/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Deterministic guard against a common failure of weaker tool-calling models: the reply *announces*
 * actions ("I'll create the files now...") but contains no tool call, so nothing is executed and the turn
 * ends looking successful.
 *
 * This only inspects the final reply text; it never decides that work was done. The agent loop uses it to
 * send one corrective message so the model either calls the tools or states plainly that it is finished.
 */

const ACTION_VERBS = [
	'create', 'write', 'add', 'update', 'edit', 'modify', 'change', 'implement', 'make', 'set up', 'setup',
	'install', 'run', 'execute', 'build', 'generate', 'fix', 'delete', 'remove', 'rename', 'move', 'refactor',
	'scaffold', 'initialize', 'initialise', 'configure', 'start', 'launch', 'test', 'apply', 'replace', 'insert',
].map(v => {
	// match inflections too ("create" -> creates/creating/created): drop a final "e", allow a word suffix
	const [head, ...rest] = v.split(' ');
	const stem = head.length > 3 && head.endsWith('e') ? head.slice(0, -1) : head;
	return [stem + '\\w*', ...rest].join('\\s+');
}).join('|');

// First-person, future/imminent intent followed (closely) by an action verb.
const INTENT = new RegExp(
	String.raw`\b(?:i\s+will|i'll|i\s+am\s+going\s+to|i'm\s+going\s+to|let\s+me|let's|now\s+i\s+(?:will|'ll)|next,?\s+i\s+(?:will|'ll)|i\s+(?:will|'ll)\s+now|i\s+shall)\s+(?:now\s+|then\s+|go\s+ahead\s+and\s+|start\s+by\s+|first\s+)?(?:${ACTION_VERBS})`,
	'i'
);

// The model is handing the decision back to the user: not a missed tool call.
const ASKS_USER = /\b(?:would\s+you\s+like|do\s+you\s+want|shall\s+i|should\s+i|let\s+me\s+know|want\s+me\s+to|if\s+you(?:'d|\s+would)\s+like|please\s+confirm|once\s+you\s+confirm|before\s+i\s+proceed)\b/i;

/** Only the end of the reply matters: an early "I'll create X" followed by a summary of results is fine. */
const TAIL_CHARS = 600;

export function looksLikeUnfulfilledAction(replyText: string): boolean {
	const text = replyText.trim();
	if (!text) { return false; }
	const tail = text.slice(-TAIL_CHARS);
	if (ASKS_USER.test(tail)) { return false; }
	if (/\?\s*$/.test(tail)) { return false; }
	return INTENT.test(tail);
}

export const UNFULFILLED_ACTION_NUDGE = `Kodia: your last reply described actions but did not call any tool, so nothing was executed — no files were created or changed and no commands ran. If you intend to do that work, call the appropriate tools now. If you are finished, or you need something from the user, say so explicitly instead.`;
