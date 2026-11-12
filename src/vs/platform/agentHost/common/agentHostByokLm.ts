/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * Serializable bridge contract between the node agent host (where the
 * {@link IByokLmProxyService} OpenAI-compatible proxy runs) and the renderer
 * (which owns the extension-provided BYOK language models via the LM API).
 *
 * These shapes are deliberately wire-friendly (plain JSON, no `VSBuffer`,
 * `URI`, or `workbench/contrib/chat` types) so they survive both the local
 * utility-process IPC channel and the remote JSON-RPC transport without a
 * translation step. The node side converts OpenAI Responses wire payloads
 * to/from these; the renderer side converts these to/from the VS Code
 * LM API (`ILanguageModelsService`).
 */

export interface IByokLmTextPart {
	readonly type: 'text';
	readonly text: string;
}

export type ByokLmImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/bmp';

export interface IByokLmImagePart {
	readonly type: 'image';
	readonly mimeType: ByokLmImageMimeType;
	readonly data: string;
}

export type IByokLmContentPart = IByokLmTextPart | IByokLmImagePart;

export interface IByokLmMessageItem {
	readonly type: 'message';
	readonly role: 'system' | 'developer' | 'user' | 'assistant';
	readonly content: IByokLmContentPart[];
}

export interface IByokLmReasoningItem {
	readonly type: 'reasoning';
	readonly id?: string;
	readonly summary: string[];
	readonly encryptedContent?: string;
	readonly metadata?: Record<string, unknown>;
}

export interface IByokLmFunctionCallItem {
	readonly type: 'function_call';
	readonly callId: string;
	readonly name: string;
	readonly argumentsJson: string;
}

export interface IByokLmFunctionCallOutputItem {
	readonly type: 'function_call_output';
	readonly callId: string;
	/** Text of the tool result. */
	readonly output: string;
	/**
	 * The tool result's ordered text and image parts, set only when it carries
	 * images (e.g. the `view` tool reading an image file). Supersedes
	 * {@link output}; `output` stays populated so a renderer that predates this
	 * field still receives the text result.
	 */
	readonly content?: IByokLmContentPart[];
}

export interface IByokLmCustomToolCallItem {
	readonly type: 'custom_tool_call';
	readonly callId: string;
	readonly name: string;
	readonly input: string;
}

export interface IByokLmCustomToolCallOutputItem {
	readonly type: 'custom_tool_call_output';
	readonly callId: string;
	/** Text of the tool result. */
	readonly output: string;
	/** Ordered text and image parts; see {@link IByokLmFunctionCallOutputItem.content}. */
	readonly content?: IByokLmContentPart[];
}

export type IByokLmInputItem =
	IByokLmMessageItem |
	IByokLmReasoningItem |
	IByokLmFunctionCallItem |
	IByokLmFunctionCallOutputItem |
	IByokLmCustomToolCallItem |
	IByokLmCustomToolCallOutputItem;

export interface IByokLmFunctionTool {
	readonly type: 'function';
	readonly name: string;
	readonly description?: string;
	readonly parametersSchema?: object;
}

export interface IByokLmCustomTool {
	readonly type: 'custom';
	readonly name: string;
	readonly description?: string;
}

export type IByokLmTool = IByokLmFunctionTool | IByokLmCustomTool;

export interface IByokLmChatRequest {
	readonly vendor: string;
	readonly modelId: string;
	readonly instructions?: string;
	readonly input: IByokLmInputItem[];
	readonly tools?: IByokLmTool[];
	readonly previousResponseId?: string;
	readonly reasoningEffort?: string;
	readonly modelOptions?: Record<string, unknown>;
}

export interface IByokLmOutputMessageItem {
	readonly type: 'message';
	readonly content: IByokLmTextPart[];
}

export type IByokLmOutputItem =
	IByokLmOutputMessageItem |
	IByokLmReasoningItem |
	IByokLmFunctionCallItem |
	IByokLmCustomToolCallItem;

export interface IByokLmChatResult {
	readonly output: IByokLmOutputItem[];
	readonly responseId?: string;
	readonly usage?: {
		readonly inputTokens?: number;
		readonly outputTokens?: number;
		readonly reasoningTokens?: number;
	};
	readonly error?: string;
}

/**
 * Metadata for a renderer BYOK model, enumerated over the bridge so the node
 * agent host can advertise it to the SDK runtime without any host-side config.
 */
export interface IByokLmModelInfo {
	/** Provider/vendor name (the LM API vendor that registered the model). */
	readonly vendor: string;
	/** Provider-local model id. */
	readonly id: string;
	/** Display name, when the provider supplies one. */
	readonly name?: string;
	/**
	 * The identifier the model is registered under in the renderer's LM service —
	 * i.e. `toModelIdentifier(vendor, group, id)` in `extHostLanguageModels`
	 * (`<vendor>/<group>/<id>` when the user configured a provider group in
	 * `chatLanguageModels.json`, else `<vendor>/<id>`).
	 */
	readonly modelIdentifier?: string;
	/** Maximum context window tokens (prompt + output), when known. */
	readonly maxContextWindowTokens?: number;
	/** Independent maximum input tokens, when known. */
	readonly maxPromptTokens?: number;
	/** Independent maximum output tokens, when known. */
	readonly maxOutputTokens?: number;
	/** Whether the model accepts image inputs, when known. */
	readonly supportsVision?: boolean;
	/** Reasoning effort values advertised by the renderer model, when known. */
	readonly supportedReasoningEfforts?: readonly string[];
	/** Default reasoning effort advertised by the renderer model, when known. */
	readonly defaultReasoningEffort?: string;
}

/**
 * Returns the provider-local selection id used by the agent host. Configured
 * provider groups remain part of the id so models with the same vendor and
 * provider-local id do not collide.
 */
export function getByokLmSelectionModelId(model: IByokLmModelInfo): string {
	const vendorPrefix = `${model.vendor}/`;
	return model.modelIdentifier?.startsWith(vendorPrefix)
		? model.modelIdentifier.slice(vendorPrefix.length)
		: model.id;
}

/** Returns the provider-qualified model id advertised by the agent host. */
export function getByokLmAgentModelId(model: IByokLmModelInfo): string {
	return `${model.vendor}/${getByokLmSelectionModelId(model)}`;
}

/** Resolves BYOK enablement and trace context from synchronized root configuration. */
export function resolveByokLmEnablement(rootConfigValue: boolean | undefined): { readonly enabled: boolean; readonly trace: string } {
	const enabled = rootConfigValue === true;
	return {
		enabled,
		trace: `enabled: ${enabled} (root config: ${rootConfigValue ?? 'unset'})`,
	};
}

export const IAgentHostByokLmHandler = createDecorator<IAgentHostByokLmHandler>('agentHostByokLmHandler');

/**
 * Renderer-side handler that services {@link IByokLmChatRequest}s by calling
 * the VS Code Language Model API. Implemented in the workbench (where
 * `ILanguageModelsService` lives) and reached from the node agent host over
 * the reverse bridge.
 */
export interface IAgentHostByokLmHandler {
	readonly _serviceBrand: undefined;

	/**
	 * Fires when the renderer's set of BYOK models changes, so the node agent
	 * host can re-enumerate them for the model picker. Optional: test fakes may
	 * omit it.
	 */
	readonly onDidChangeModels?: Event<void>;

	/**
	 * Run a BYOK Responses request against the extension-registered model that
	 * matches `request.vendor` + `request.modelId`. Rejects (or resolves with
	 * {@link IByokLmChatResult.error}) when no such model is available.
	 */
	chat(request: IByokLmChatRequest, token: CancellationToken): Promise<IByokLmChatResult>;

	/**
	 * Enumerate the renderer's BYOK models (vendor `isBYOK`, excluding
	 * session-scoped agent-host copies) so the node agent host can synthesize
	 * provider/model config for the SDK runtime.
	 */
	listModels(token: CancellationToken): Promise<IByokLmModelInfo[]>;
}

/**
 * Node-side connection to a single renderer's {@link IAgentHostByokLmHandler}.
 * Mirrors `IRemoteFilesystemConnection` for the reverse FS bridge. The renderer
 * pushes its models over {@link onDidChangeModels}; `chat` stays a round-trip.
 */
export interface IByokLmBridgeConnection {
	/** Kodia: `token` cancels the request in the renderer (the Kodia agent aborts turns). */
	chat(request: IByokLmChatRequest, token?: CancellationToken): Promise<IByokLmChatResult>;
	/** Emits the renderer's current BYOK model snapshot on subscribe and on every change. */
	readonly onDidChangeModels: Event<IByokLmModelInfo[]>;
	/** Kodia: the MCP tools the Kodia window offers the Kodia agent, when it does (see `KodiaAgentHostLmChannel`). */
	listMcpTools?(token?: CancellationToken): Promise<IKodiaMcpTool[]>;
	/** Kodia: runs one of those MCP tools in the Kodia window, which holds the MCP servers. `token` cancels the wait. */
	callMcpTool?(name: string, argsJson: string, token?: CancellationToken): Promise<IKodiaMcpToolResult>;
	/** Kodia: the kinds of tool call the user lets run without asking, in Kodia's settings, when the window offers them. */
	getAutoApprove?(token?: CancellationToken): Promise<IKodiaAutoApprove>;
	/**
	 * Kodia: the names of the editor tools (the language server's, the lint errors; see `editorTools` in `toolCatalog.ts`)
	 * this window can run for the Kodia agent. An editor window can; the Agents Window has no editor, so it says none.
	 */
	listEditorTools?(token?: CancellationToken): Promise<string[]>;
	/** Kodia: runs one of those editor tools in that window. `token` cancels the wait. */
	callEditorTool?(name: string, argsJson: string, token?: CancellationToken): Promise<IKodiaMcpToolResult>;
	/**
	 * Kodia: like {@link chat}, and `onDelta` is called with the text and the reasoning as the model writes them, before
	 * the result that holds them all. Absent when the window can't stream (an older one): `chat` answers at the end then.
	 */
	chatStream?(request: IByokLmChatRequest, onDelta: (delta: IByokLmChatDelta) => void, token?: CancellationToken): Promise<IByokLmChatResult>;
}

/**
 * Kodia: what a model has written since the last delta of the same request: text of its reply and/or of its
 * reasoning, to append to what came before. The result of the request holds the whole of both.
 */
export interface IByokLmChatDelta {
	readonly text?: string;
	readonly reasoning?: string;
}

/**
 * Kodia: what the window's `chatStream` event carries (see `KodiaAgentHostLmChannel`): the deltas of a request, then
 * its result, which ends the stream.
 */
export type IKodiaChatStreamEvent =
	| { readonly delta: IByokLmChatDelta }
	| { readonly result: IByokLmChatResult };

/**
 * Kodia: which kinds of tool call the user has switched on for automatic approval in Kodia's settings (the chat's
 * "Auto-approve" toggles). A kind that is missing or false is asked about.
 */
export interface IKodiaAutoApprove {
	readonly edits?: boolean;
	readonly terminal?: boolean;
	readonly 'web pages'?: boolean;
	readonly 'MCP tools'?: boolean;
}

/**
 * Kodia: an MCP tool the Kodia window offers the Kodia agent of the Agents Window. The window runs the MCP
 * servers, so the agent host lists and calls their tools through the window. Kodia prefixes MCP tool names so
 * they are unique across servers and never clash with the agent's own tools: `name` is what the model calls,
 * `displayName` what the user reads.
 */
export interface IKodiaMcpTool {
	readonly name: string;
	readonly displayName: string;
	readonly serverName: string;
	readonly description?: string;
	/** The JSON Schema of the tool's arguments. */
	readonly inputSchema?: object;
}

/** What a Kodia window answers for a tool it ran for the Kodia agent: an MCP tool or an editor tool. */
export interface IKodiaMcpToolResult {
	readonly isError: boolean;
	/** Text fed back to the model. */
	readonly output: string;
}
