/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import type { ModelSelection } from '../../common/state/protocol/state.js';

/**
 * One live Mistral agent session. Holds the binding between the workbench
 * session URI and the server-side Mistral `conversation_id`, plus the per-turn
 * abort handle.
 *
 * Created by {@link import('./mistralAgent.js').MistralAgent} when a provisional
 * session materializes (first `sendMessage`). The turn loop that drives the
 * conversation lives in Phase 4; in Phase 3 this is a lightweight state holder
 * so the lifecycle (create / materialize / dispose / list) is correct first.
 */
export class MistralAgentSession extends Disposable {

	/**
	 * Mistral server-side conversation id. `undefined` until the first turn
	 * opens the conversation via `conversations.startStream` (Phase 4); from
	 * then on it is reused by `appendStream` and persisted for restoration.
	 */
	conversationId: string | undefined;

	/** Current model selection; updated by `changeModel` (Phase 6). */
	model: ModelSelection | undefined;

	/** Aborts the in-flight turn stream. Used by `abortSession` (Phase 6). */
	private _abortController = new AbortController();

	constructor(
		readonly sessionId: string,
		readonly sessionUri: URI,
		readonly workingDirectory: URI | undefined,
		model: ModelSelection | undefined,
		readonly createdAt: number = Date.now(),
	) {
		super();
		this.model = model;
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
