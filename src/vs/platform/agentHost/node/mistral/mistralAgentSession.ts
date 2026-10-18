/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import type { IAgentSessionProjectInfo } from '../../common/agent.js';
import type { ModelSelection } from '../../common/state/protocol/state.js';

/**
 * The opaque backing Agent Host persists for each Mistral chat
 * (`IAgentCreateChatResult.providerData`) and hands back to
 * `materializeChat` on restore. Everything a cold chat needs to continue its
 * server-side Mistral conversation lives here, so the agent keeps no database
 * of its own.
 */
interface IMistralChatBacking {
	readonly conversationId?: string;
	/** Model the Mistral conversation was started with (the API fixes it per conversation). */
	readonly conversationModel?: string;
	readonly model?: ModelSelection;
	readonly workingDirectory?: string;
	readonly createdAt: number;
	readonly modifiedAt?: number;
}

export function projectForWorkingDirectory(workingDirectory: URI | undefined): IAgentSessionProjectInfo | undefined {
	return workingDirectory ? { uri: workingDirectory, displayName: basename(workingDirectory) } : undefined;
}

/**
 * One Mistral chat. Holds the binding between the Agent Host chat URI and the
 * server-side Mistral `conversation_id`, plus the per-turn abort handle.
 */
export class MistralAgentSession extends Disposable {

	/**
	 * Mistral server-side conversation id. `undefined` until the first turn
	 * opens the conversation; from then on turns append to it.
	 */
	conversationId: string | undefined;

	/** Model {@link conversationId} was started with. */
	conversationModel: string | undefined;

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
			readonly model?: ModelSelection;
			readonly workingDirectory?: URI;
			readonly project?: IAgentSessionProjectInfo;
			readonly conversationId?: string;
			readonly conversationModel?: string;
			readonly materialized: boolean;
			readonly modifiedAt?: number;
		},
		readonly createdAt: number = Date.now(),
	) {
		super();
		this.model = init.model;
		this.workingDirectory = init.workingDirectory;
		this.project = init.project ?? projectForWorkingDirectory(init.workingDirectory);
		this.conversationId = init.conversationId;
		this.conversationModel = init.conversationModel;
		this.materialized = init.materialized;
		this.modifiedAt = init.modifiedAt ?? createdAt;
	}

	/** Restore a chat from the backing Agent Host persisted. Returns `undefined` for a corrupt blob. */
	static fromProviderData(chat: URI, providerData: string): MistralAgentSession | undefined {
		let backing: IMistralChatBacking;
		try {
			backing = JSON.parse(providerData);
		} catch {
			return undefined;
		}
		if (typeof backing?.createdAt !== 'number') {
			return undefined;
		}
		return new MistralAgentSession(chat, {
			model: backing.model,
			workingDirectory: backing.workingDirectory ? URI.parse(backing.workingDirectory) : undefined,
			conversationId: backing.conversationId,
			conversationModel: backing.conversationModel,
			// Only a materialized chat is ever persisted, so a restored one is too.
			materialized: true,
			modifiedAt: backing.modifiedAt,
		}, backing.createdAt);
	}

	toProviderData(): string {
		const backing: IMistralChatBacking = {
			...(this.conversationId ? { conversationId: this.conversationId } : {}),
			...(this.conversationModel ? { conversationModel: this.conversationModel } : {}),
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
