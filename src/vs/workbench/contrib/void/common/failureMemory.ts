/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Self-Improving Failure-Pattern Memory (Mandate §17 / §22).
 *
 * Deterministically tracks recurring tool/command failure signatures and records
 * proven recovery lessons so BYOK models stop repeating the same mistake across
 * turns and sessions.
 */

export interface FailureLesson {
	readonly signature: string;
	readonly toolName: string;
	readonly errorSample: string;
	readonly recoveryHint: string;
	readonly occurrences: number;
	readonly updatedAt: string;
}

/**
 * Normalize an error message into a stable, deduplicatable signature
 * (strips absolute paths, line numbers, timestamps, and temp IDs).
 */
export function normalizeFailureSignature(toolName: string, errorMessage: string): string {
	const cleaned = errorMessage
		.toLowerCase()
		.replace(/[a-z]:\\[^\s'"]+/gi, '<path>')
		.replace(/\/(?:[\w.-]+\/)+[\w.-]+/g, '<path>')
		.replace(/\bline\s+\d+\b/g, 'line <n>')
		.replace(/:\d+:\d+/g, ':<n>:<n>')
		.replace(/\b0x[0-9a-f]+\b/g, '<hex>')
		.replace(/\b\d{3,}\b/g, '<num>')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 140);
	return `${toolName}::${cleaned}`;
}

export class FailurePatternMemory {
	private readonly _lessons = new Map<string, FailureLesson>();
	private readonly _lastFailureByTool = new Map<string, { signature: string; errorSample: string }>();

	constructor(initial?: readonly FailureLesson[]) {
		if (initial) {
			for (const l of initial) {
				if (l?.signature) { this._lessons.set(l.signature, l); }
			}
		}
	}

	/**
	 * Record a tool failure and return any known recovery hint from prior solved occurrences.
	 */
	recordFailure(toolName: string, errorMessage: string): string | undefined {
		const signature = normalizeFailureSignature(toolName, errorMessage);
		this._lastFailureByTool.set(toolName, { signature, errorSample: errorMessage.slice(0, 200) });
		const existing = this._lessons.get(signature);
		if (existing) {
			this._lessons.set(signature, {
				...existing,
				occurrences: existing.occurrences + 1,
				updatedAt: new Date().toISOString(),
			});
			return existing.recoveryHint;
		}
		return undefined;
	}

	/**
	 * When a tool succeeds right after failing on the same tool, capture the working
	 * action summary as a reusable lesson for future sessions.
	 */
	recordRecovery(toolName: string, workingSummary: string): FailureLesson | undefined {
		const prev = this._lastFailureByTool.get(toolName);
		if (!prev || !workingSummary.trim()) { return undefined; }
		this._lastFailureByTool.delete(toolName);
		const existing = this._lessons.get(prev.signature);
		const lesson: FailureLesson = {
			signature: prev.signature,
			toolName,
			errorSample: prev.errorSample,
			recoveryHint: workingSummary.trim().slice(0, 240),
			occurrences: (existing?.occurrences ?? 0) + 1,
			updatedAt: new Date().toISOString(),
		};
		this._lessons.set(prev.signature, lesson);
		// Bound memory to 100 most recent lessons
		if (this._lessons.size > 100) {
			const oldestKey = this._lessons.keys().next().value;
			if (oldestKey) { this._lessons.delete(oldestKey); }
		}
		return lesson;
	}

	listLessons(): FailureLesson[] {
		return [...this._lessons.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	serialize(): string {
		return JSON.stringify(this.listLessons(), null, 2);
	}
}
