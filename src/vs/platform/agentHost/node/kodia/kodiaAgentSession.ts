/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import type { IAgentSessionProjectInfo } from '../../common/agent.js';
import type { IByokLmInputItem } from '../../common/agentHostByokLm.js';
import type { MessageAttachment, ModelSelection } from '../../common/state/protocol/state.js';
import type { IKodiaCompaction } from './kodiaContext.js';

/**
 * The opaque backing Agent Host persists for each Kodia chat
 * (`IAgentCreateChatResult.providerData`) and hands back to `materializeChat`
 * on restore. Kodia's providers keep no conversation server-side, so the whole
 * history lives here.
 */
interface IKodiaChatBacking {
	readonly history: IByokLmInputItem[];
	/** The id of each user turn in {@link history}, in order, so a restored chat keeps them. */
	readonly turnIds: string[];
	/** What the user attached to the message of a turn, by turn id, so a restored chat shows it. Absent from a chat saved before attachments. */
	readonly attachments?: { readonly [turnId: string]: MessageAttachment[] };
	readonly model?: ModelSelection;
	readonly workingDirectory?: string;
	/** What the model is not sent, once the history outgrew its context window (see kodiaContext.ts). */
	readonly compaction?: IKodiaCompaction;
	readonly createdAt: number;
	readonly modifiedAt?: number;
}

// the attachments of the turns read back from storage: anything else is none
function readAttachments(value: unknown): { [turnId: string]: MessageAttachment[] } {
	const attachments: { [turnId: string]: MessageAttachment[] } = {};
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		for (const [turnId, turnAttachments] of Object.entries(value)) {
			if (Array.isArray(turnAttachments) && turnAttachments.length > 0) {
				attachments[turnId] = turnAttachments;
			}
		}
	}
	return attachments;
}

// a compaction read back from storage: anything else is no compaction
function isCompaction(value: unknown): value is IKodiaCompaction {
	const compaction = value as IKodiaCompaction | undefined;
	return typeof compaction?.clearedBefore === 'number'
		&& (compaction.summary === undefined || (typeof compaction.summary.text === 'string' && typeof compaction.summary.keepFromIdx === 'number'));
}

export function projectForWorkingDirectory(workingDirectory: URI | undefined): IAgentSessionProjectInfo | undefined {
	return workingDirectory ? { uri: workingDirectory, displayName: basename(workingDirectory) } : undefined;
}

/** One Kodia chat: its history, the model it runs on, and the per-turn abort handle. */
export class KodiaAgentSession extends Disposable {

	history: IByokLmInputItem[];

	turnIds: string[];

	/** What the user attached to the message of a turn, by turn id: what the model was sent of it is in the history. */
	attachments: { [turnId: string]: MessageAttachment[] };

	model: ModelSelection | undefined;

	/** Process root for the local tools; replaced by the host's resolved directory on each send. */
	workingDirectory: URI | undefined;

	project: IAgentSessionProjectInfo | undefined;

	/**
	 * `false` while the chat is provisional: created by the host but never sent
	 * to. The first send materializes it, which lets the host publish the session.
	 */
	materialized: boolean;

	modifiedAt: number;

	/** What the model is sent in place of the old part of the history. Kept with the session. */
	compaction: IKodiaCompaction | undefined;

	/**
	 * About how many tokens what the model is sent takes: what the last response said it took, and the messages added
	 * since. Not kept with the session: it is unknown after a restart, until a response says.
	 */
	contextTokens: number | undefined;

	/** The history's length when a summary was last tried, so one that failed isn't tried again at every round. */
	summaryTriedAtLength: number | undefined;

	private _abortController = new AbortController();

	constructor(
		readonly chat: URI,
		init: {
			readonly history?: IByokLmInputItem[];
			readonly turnIds?: string[];
			readonly attachments?: { [turnId: string]: MessageAttachment[] };
			readonly model?: ModelSelection;
			readonly workingDirectory?: URI;
			readonly compaction?: IKodiaCompaction;
			readonly project?: IAgentSessionProjectInfo;
			readonly materialized: boolean;
			readonly modifiedAt?: number;
		},
		readonly createdAt: number = Date.now(),
	) {
		super();
		this.history = init.history ?? [];
		this.turnIds = init.turnIds ?? [];
		this.attachments = init.attachments ?? {};
		this.model = init.model;
		this.workingDirectory = init.workingDirectory;
		this.project = init.project ?? projectForWorkingDirectory(init.workingDirectory);
		this.materialized = init.materialized;
		this.modifiedAt = init.modifiedAt ?? createdAt;
		this.compaction = init.compaction;
		this.contextTokens = undefined;
		this.summaryTriedAtLength = undefined;
	}

	/** Restore a chat from the backing Agent Host persisted. Returns `undefined` for a corrupt blob. */
	static fromProviderData(chat: URI, providerData: string): KodiaAgentSession | undefined {
		let backing: IKodiaChatBacking;
		try {
			backing = JSON.parse(providerData);
		} catch {
			return undefined;
		}
		if (typeof backing?.createdAt !== 'number' || !Array.isArray(backing.history)) {
			return undefined;
		}
		return new KodiaAgentSession(chat, {
			history: backing.history,
			turnIds: Array.isArray(backing.turnIds) ? backing.turnIds : [],
			attachments: readAttachments(backing.attachments),
			model: backing.model,
			workingDirectory: backing.workingDirectory ? URI.parse(backing.workingDirectory) : undefined,
			compaction: isCompaction(backing.compaction) ? backing.compaction : undefined,
			// Only a materialized chat is ever persisted, so a restored one is too.
			materialized: true,
			modifiedAt: backing.modifiedAt,
		}, backing.createdAt);
	}

	toProviderData(): string {
		const backing: IKodiaChatBacking = {
			history: this.history,
			turnIds: this.turnIds,
			...(Object.keys(this.attachments).length > 0 ? { attachments: this.attachments } : {}),
			...(this.model ? { model: this.model } : {}),
			...(this.workingDirectory ? { workingDirectory: this.workingDirectory.toString() } : {}),
			...(this.compaction ? { compaction: this.compaction } : {}),
			createdAt: this.createdAt,
			modifiedAt: this.modifiedAt,
		};
		return JSON.stringify(backing);
	}

	get abortSignal(): AbortSignal {
		return this._abortController.signal;
	}

	/** Abort the current turn and arm a fresh controller for the next one. */
	abortTurn(): void {
		this._abortController.abort();
		this._abortController = new AbortController();
	}

	override dispose(): void {
		this._abortController.abort();
		super.dispose();
	}
}
