/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Shared by the LIVE tests: an ILLMMessageService that calls Kodia's real main-process sendLLMMessage (what the IPC
 * channel would do), recording each request (no secrets), and reading the key from the git-ignored repo-root .env.
 */

import * as fs from 'fs';
import * as path from 'path';
import { sendLLMMessage } from '../../electron-main/llmMessage/sendLLMMessage.js';
import { SettingsOfProvider } from '../../common/voidSettingsTypes.js';

export function readDotEnv(): Record<string, string> {
	const file = path.join(process.cwd(), '.env'); // scripts\test.bat runs from the repo root
	if (!fs.existsSync(file)) { return {}; }
	const out: Record<string, string> = {};
	for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
		const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
		if (m) { out[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
	}
	return out;
}

export type LiveRequestRecord = { idx: number; loggingName: string; startedAt: number; durationMs?: number; outcome?: 'final' | 'error' | 'aborted'; nToolCalls?: number; toolNames?: string[]; finishReason?: string | null; error?: string };

export class LiveLLMService {
	readonly records: LiveRequestRecord[] = [];
	private readonly abortRefs = new Map<string, { current: (() => void) | null }>();
	private readonly onAbortOf = new Map<string, () => void>();
	private n = 0;
	constructor(private readonly settingsOfProvider: SettingsOfProvider) { }

	sendLLMMessage = (params: any) => {
		const { onText, onFinalMessage, onError, onAbort, ...rest } = params;
		const requestId = `live-${this.n++}`;
		const abortRef = { current: null as (() => void) | null };
		this.abortRefs.set(requestId, abortRef);
		this.onAbortOf.set(requestId, onAbort);
		const rec: LiveRequestRecord = { idx: this.records.length, loggingName: params.logging?.loggingName ?? '', startedAt: Date.now() };
		this.records.push(rec);
		void sendLLMMessage({
			...rest,
			settingsOfProvider: this.settingsOfProvider,
			mcpTools: [],
			abortRef,
			onText,
			onFinalMessage: (p: any) => {
				rec.durationMs = Date.now() - rec.startedAt; rec.outcome = 'final'; rec.finishReason = p.finishReason ?? null;
				rec.nToolCalls = p.toolCalls?.length ?? 0; rec.toolNames = p.toolCalls?.map((c: any) => c.name);
				onFinalMessage(p);
			},
			onError: (e: any) => { rec.durationMs = Date.now() - rec.startedAt; rec.outcome = 'error'; rec.error = String(e?.message).slice(0, 500); onError(e); },
		} as any, { capture: () => { } } as any);
		return requestId;
	};
	abort = (requestId: string) => {
		const rec = this.records[Number(requestId.split('-')[1])];
		if (rec && !rec.outcome) { rec.outcome = 'aborted'; }
		this.onAbortOf.get(requestId)?.();
		this.abortRefs.get(requestId)?.current?.();
	};
}
