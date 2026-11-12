/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { IKodiaMcpToolResult } from '../../../../platform/agentHost/common/agentHostByokLm.js';
import type { EditorToolName } from '../../../../platform/kodia/common/toolCatalog.js';
import type { RawToolParamsObj } from './sendLLMMessageTypes.js';

// Which window can run the editor tools (the language server's, the lint errors) for the Kodia agent of the Agents
// Window. Every Kodia window answers the agent, but only an editor window has the tools: the Agents Window loads just
// this small service, which then has none to offer, and an editor window's tools service provides them.

/** Runs an editor tool the way the chat does, in this window. */
export interface IKodiaEditorTools {
	/** A failure is a result with `isError`, not a rejection. */
	call(name: EditorToolName, params: RawToolParamsObj): Promise<IKodiaMcpToolResult>;
}

export interface IKodiaEditorToolsService {
	readonly _serviceBrand: undefined;
	/** The editor tools of this window; undefined in the Agents Window, which has no editor. */
	readonly tools: IKodiaEditorTools | undefined;
	/** The editor window's tools service says it can run them. */
	provide(tools: IKodiaEditorTools): IDisposable;
}

export const IKodiaEditorToolsService = createDecorator<IKodiaEditorToolsService>('kodiaEditorToolsService');

export class KodiaEditorToolsService implements IKodiaEditorToolsService {
	declare readonly _serviceBrand: undefined;

	tools: IKodiaEditorTools | undefined;

	provide(tools: IKodiaEditorTools): IDisposable {
		this.tools = tools;
		return toDisposable(() => {
			if (this.tools === tools) {
				this.tools = undefined;
			}
		});
	}
}

registerSingleton(IKodiaEditorToolsService, KodiaEditorToolsService, InstantiationType.Delayed);

/**
 * The arguments a model sent, as the chat's tools take them: every value a string, a number or a flag written out. The
 * agent's schema gives a line number as an integer, which the chat's tools read from a string. Undefined if `argsJson`
 * is not a JSON object.
 */
export function editorToolParams(argsJson: string): RawToolParamsObj | undefined {
	let parsed: unknown;
	try {
		parsed = argsJson ? JSON.parse(argsJson) : {};
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return undefined;
	}
	const params: { [paramName: string]: string } = {};
	for (const [name, value] of Object.entries(parsed)) {
		if (typeof value === 'string') {
			params[name] = value;
		} else if (typeof value === 'number' || typeof value === 'boolean') {
			params[name] = String(value);
		}
	}
	return params;
}
