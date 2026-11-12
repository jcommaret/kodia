/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import type { IByokLmChatDelta } from '../../common/agentHostByokLm.js';
import { ActionType, type ChatAction } from '../../common/state/sessionActions.js';
import { ResponsePartKind } from '../../common/state/sessionState.js';

/** A part of the reply that is on screen: what has been published of it. */
interface IShownPart {
	readonly id: string;
	text: string;
}

/**
 * The reply of one model request, as the Agents window shows it while the model writes: a markdown part for the text
 * and a reasoning part for the reasoning, each created when the model first writes some and grown by what it writes
 * next, as the Copilot agent does. The request's result, once it is there, shows what the stream did not, so a model
 * that doesn't stream, or a window that can't, is shown as it always was: the whole reply at the end.
 */
export class KodiaReplyStream {

	private _text: IShownPart | undefined;
	private _reasoning: IShownPart | undefined;

	constructor(
		private readonly _turnId: string,
		private readonly _fire: (action: ChatAction) => void,
	) { }

	/** What the model has just written. */
	append({ text, reasoning }: IByokLmChatDelta): void {
		if (reasoning) {
			this._reasoning = this._showReasoning(this._reasoning, reasoning);
		}
		if (text) {
			this._text = this._showText(this._text, text);
		}
	}

	/**
	 * The text of the reply in the request's result: shown now if the stream has shown none of it, else its end is, when
	 * the stream stopped short of it. The text the stream showed stays as it is when the result isn't a continuation of
	 * it (a part only grows). Each part settles one item of the result: another item is a part of its own.
	 */
	completeText(text: string): void {
		const shown = this._text;
		this._text = undefined;
		if (!shown) {
			this._showText(undefined, text);
		} else if (text.length > shown.text.length && text.startsWith(shown.text)) {
			this._showText(shown, text.slice(shown.text.length));
		}
	}

	/** The reasoning in the request's result: see {@link completeText}. */
	completeReasoning(reasoning: string): void {
		const shown = this._reasoning;
		this._reasoning = undefined;
		if (!shown) {
			this._showReasoning(undefined, reasoning);
		} else if (reasoning.length > shown.text.length && reasoning.startsWith(shown.text)) {
			this._showReasoning(shown, reasoning.slice(shown.text.length));
		}
	}

	private _showText(shown: IShownPart | undefined, content: string): IShownPart {
		if (!shown) {
			const id = generateUuid();
			this._fire({ type: ActionType.ChatResponsePart, turnId: this._turnId, part: { kind: ResponsePartKind.Markdown, id, content } });
			return { id, text: content };
		}
		this._fire({ type: ActionType.ChatDelta, turnId: this._turnId, partId: shown.id, content });
		shown.text += content;
		return shown;
	}

	private _showReasoning(shown: IShownPart | undefined, content: string): IShownPart {
		if (!shown) {
			const id = generateUuid();
			this._fire({ type: ActionType.ChatResponsePart, turnId: this._turnId, part: { kind: ResponsePartKind.Reasoning, id, content } });
			return { id, text: content };
		}
		this._fire({ type: ActionType.ChatReasoning, turnId: this._turnId, partId: shown.id, content });
		shown.text += content;
		return shown;
	}
}
