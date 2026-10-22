/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import type { IAgentSessionProjectInfo } from '../../common/agent.js';
import type { IByokLmInputItem } from '../../common/agentHostByokLm.js';
import type { ModelSelection } from '../../common/state/protocol/state.js';

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
	readonly model?: ModelSelection;
	readonly workingDirectory?: string;
	readonly createdAt: number;
	readonly modifiedAt?: number;
}

export function projectForWorkingDirectory(workingDirectory: URI | undefined): IAgentSessionProjectInfo | undefined {
	return workingDirectory ? { uri: workingDirectory, displayName: basename(workingDirectory) } : undefined;
}

/** One Kodia chat: its history, the model it runs on, and the per-turn abort handle. */
export class KodiaAgentSession extends Disposable {

	history: IByokLmInputItem[];

	turnIds: string[];

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

	private _abortController = new AbortController();

	constructor(
		readonly chat: URI,
		init: {
			readonly history?: IByokLmInputItem[];
			readonly turnIds?: string[];
			readonly model?: ModelSelection;
			readonly workingDirectory?: URI;
			readonly project?: IAgentSessionProjectInfo;
			readonly materialized: boolean;
			readonly modifiedAt?: number;
		},
		readonly createdAt: number = Date.now(),
	) {
		super();
		this.history = init.history ?? [];
		this.turnIds = init.turnIds ?? [];
		this.model = init.model;
		this.workingDirectory = init.workingDirectory;
		this.project = init.project ?? projectForWorkingDirectory(init.workingDirectory);
		this.materialized = init.materialized;
		this.modifiedAt = init.modifiedAt ?? createdAt;
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
			model: backing.model,
			workingDirectory: backing.workingDirectory ? URI.parse(backing.workingDirectory) : undefined,
			// Only a materialized chat is ever persisted, so a restored one is too.
			materialized: true,
			modifiedAt: backing.modifiedAt,
		}, backing.createdAt);
	}

	toProviderData(): string {
		const backing: IKodiaChatBacking = {
			history: this.history,
			turnIds: this.turnIds,
			...(this.model ? { model: this.model } : {}),
			...(this.workingDirectory ? { workingDirectory: this.workingDirectory.toString() } : {}),
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
