/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export interface DiffLine {
	readonly kind: 'context' | 'add' | 'del';
	readonly oldLine?: number;
	readonly newLine?: number;
	readonly text: string;
}

export interface FileUnifiedDiff {
	readonly added: number;
	readonly removed: number;
	readonly lines: DiffLine[];
	readonly truncated: boolean;
}

/**
 * Compute a compact unified diff between two text snapshots with bounded context lines,
 * suitable for inline visual change review in Kodia's Changes & Checkpoints panel.
 */
export function computeUnifiedDiff(beforeText: string, afterText: string, contextLines = 2, maxOutputLines = 200): FileUnifiedDiff {
	if (beforeText === afterText) {
		return { added: 0, removed: 0, lines: [], truncated: false };
	}

	const a = beforeText === '' ? [] : beforeText.split(/\r?\n/);
	const b = afterText === '' ? [] : afterText.split(/\r?\n/);

	// Bound DP table for huge files to stay O(1) snappy in the renderer
	const MAX_LCS_LINES = 800;
	if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
		const preview: DiffLine[] = [];
		const minLen = Math.min(a.length, b.length, maxOutputLines);
		let added = 0;
		let removed = 0;
		for (let i = 0; i < minLen; i++) {
			if (a[i] !== b[i]) {
				removed++;
				added++;
				if (preview.length < maxOutputLines) {
					preview.push({ kind: 'del', oldLine: i + 1, text: a[i] });
					preview.push({ kind: 'add', newLine: i + 1, text: b[i] });
				}
			}
		}
		if (b.length > a.length) { added += b.length - a.length; }
		if (a.length > b.length) { removed += a.length - b.length; }
		return { added, removed, lines: preview.slice(0, maxOutputLines), truncated: true };
	}

	const m = a.length;
	const n = b.length;
	const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	const rawOps: DiffLine[] = [];
	let i = 0;
	let j = 0;
	let added = 0;
	let removed = 0;
	while (i < m && j < n) {
		if (a[i] === b[j]) {
			rawOps.push({ kind: 'context', oldLine: i + 1, newLine: j + 1, text: a[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			rawOps.push({ kind: 'del', oldLine: i + 1, text: a[i] });
			removed++;
			i++;
		} else {
			rawOps.push({ kind: 'add', newLine: j + 1, text: b[j] });
			added++;
			j++;
		}
	}
	while (i < m) {
		rawOps.push({ kind: 'del', oldLine: i + 1, text: a[i] });
		removed++;
		i++;
	}
	while (j < n) {
		rawOps.push({ kind: 'add', newLine: j + 1, text: b[j] });
		added++;
		j++;
	}

	// Keep only changed lines plus `contextLines` surrounding each change
	const keep = new Uint8Array(rawOps.length);
	for (let idx = 0; idx < rawOps.length; idx++) {
		if (rawOps[idx].kind !== 'context') {
			const lo = Math.max(0, idx - contextLines);
			const hi = Math.min(rawOps.length - 1, idx + contextLines);
			for (let k = lo; k <= hi; k++) { keep[k] = 1; }
		}
	}

	const out: DiffLine[] = [];
	let truncated = false;
	for (let idx = 0; idx < rawOps.length; idx++) {
		if (!keep[idx]) { continue; }
		if (out.length >= maxOutputLines) {
			truncated = true;
			break;
		}
		out.push(rawOps[idx]);
	}

	return { added, removed, lines: out, truncated };
}
