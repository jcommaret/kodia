/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { getModelCapabilities } from './modelCapabilities.js';
import { RawToolCallObj, RawToolParamsObj } from './sendLLMMessageTypes.js';
import { ToolName, ToolParamName } from './toolsServiceTypes.js';
import { ModelSelection, OverridesOfModel } from './voidSettingsTypes.js';

// Kodia asks a model for a tool call as XML tags. Small local models often write it as a JSON object instead, in a
// code block or on its own: {"name": "read_file", "arguments": {"uri": "src/a.ts"}}. It is read as the call it is,
// when the name is one of the tools offered. Only the last such object counts, and it is taken out of the text.

export interface IJsonToolCallOfText {
	/** The text without the object. */
	readonly text: string;
	readonly call: RawToolCallObj;
}

// a fenced block, with or without its language
const FENCED_BLOCK = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/g;
// how many objects, from the last `{` back, are tried at the end of the text
const MAX_TRAILING_OBJECTS = 20;

/** A value of the arguments as the tools take them: a string, as the chat's own parameters are. */
function asParamString(value: unknown): string | undefined {
	if (value === null || value === undefined) {
		return undefined;
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	return JSON.stringify(value);
}

function parseObject(json: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(json);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

/** The call an object describes, when its name is one of the tools offered; undefined otherwise. */
function callOf(object: Record<string, unknown>, toolNames: ReadonlySet<string>, id: string): RawToolCallObj | undefined {
	const name = object.name;
	if (typeof name !== 'string' || !toolNames.has(name)) {
		return undefined;
	}
	let args: unknown = object.arguments ?? object.parameters ?? {};
	if (typeof args === 'string') {
		args = parseObject(args) ?? undefined;
	}
	if (!args || typeof args !== 'object' || Array.isArray(args)) {
		return undefined;
	}
	const rawParams: Record<string, string> = {};
	for (const [param, value] of Object.entries(args as Record<string, unknown>)) {
		const text = asParamString(value);
		if (text !== undefined) {
			rawParams[param] = text;
		}
	}
	return {
		name: name as ToolName,
		rawParams: rawParams as RawToolParamsObj,
		doneParams: Object.keys(rawParams) as ToolParamName<ToolName>[],
		id,
		isDone: true,
	};
}

/**
 * The overrides of a request for the Agents window, where a local MLX model with no tool format of its own is offered the
 * tools natively, as the other models are: it then writes its calls as JSON, which the reply is read for (see the reader
 * below). Any other model, or one that has a format, keeps its overrides.
 */
export function withNativeToolsForMlx(modelSelection: ModelSelection, overrides: OverridesOfModel): OverridesOfModel {
	if (modelSelection.providerName !== 'mlx' || getModelCapabilities('mlx', modelSelection.modelName, overrides).specialToolFormat) {
		return overrides;
	}
	const mlxOverrides: OverridesOfModel['mlx'] = overrides.mlx ?? {};
	return {
		...overrides,
		mlx: {
			...mlxOverrides,
			[modelSelection.modelName]: { ...mlxOverrides[modelSelection.modelName], specialToolFormat: 'openai-style' as const },
		},
	};
}

/**
 * The tool call a model wrote as JSON in `text`, with the text left once the object is taken out; undefined when there
 * is none. `toolNames` are the tools offered: an object that names another tool, or none, is text.
 */
export function jsonToolCallOfText(text: string, toolNames: ReadonlySet<string>, id: string): IJsonToolCallOfText | undefined {
	// the candidates, last first: the answer usually ends with the call
	const candidates: { start: number; end: number; json: string }[] = [];
	for (const match of text.matchAll(FENCED_BLOCK)) {
		candidates.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, json: match[1] });
	}
	// an object at the end of the text, alone or after a sentence: each `{` from the last one back is a start to try
	const trimmed = text.trimEnd();
	if (trimmed.endsWith('}')) {
		let from = trimmed.lastIndexOf('{');
		for (let tried = 0; from !== -1 && tried < MAX_TRAILING_OBJECTS; tried++) {
			candidates.push({ start: from, end: trimmed.length, json: trimmed.slice(from) });
			from = trimmed.lastIndexOf('{', from - 1);
		}
	}
	for (const { start, end, json } of candidates.reverse()) {
		const object = parseObject(json.trim());
		const call = object && callOf(object, toolNames, id);
		if (call) {
			return { text: (text.slice(0, start) + text.slice(end)).trim(), call };
		}
	}
	return undefined;
}
