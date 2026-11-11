/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { IKodiaMcpTool } from '../../../../platform/agentHost/common/agentHostByokLm.js';
import { MCPServerOfName, removeMCPToolNamePrefix } from './mcpServiceTypes.js';

// The MCP servers' tools, as the Kodia agent of the Agents Window sees them

// The tools of the servers that are on. A server that is off, loading or in error has none to offer.
// Kodia has already prefixed each tool's name, so it is unique across servers.
export const mcpToolsOfServers = (servers: MCPServerOfName): IKodiaMcpTool[] => {
	const ans: IKodiaMcpTool[] = []
	for (const [serverName, server] of Object.entries(servers)) {
		if (server.status !== 'success') continue
		for (const tool of server.tools ?? []) {
			ans.push({
				name: tool.name,
				displayName: removeMCPToolNamePrefix(tool.name) || tool.name,
				serverName,
				...tool.description ? { description: tool.description } : {},
				...tool.inputSchema ? { inputSchema: tool.inputSchema } : {},
			})
		}
	}
	return ans
}

const isOfType = (type: string, value: unknown): boolean => {
	switch (type) {
		case 'integer': return Number.isInteger(value)
		case 'number': return typeof value === 'number' && Number.isFinite(value)
		case 'boolean': return typeof value === 'boolean'
		case 'array': return Array.isArray(value)
		case 'object': return !!value && typeof value === 'object' && !Array.isArray(value)
		case 'null': return value === null
		default: return false
	}
}

// Kodia offers every tool parameter to the model as a string, so a number, a boolean or a list reaches the MCP server
// as text, which servers that check their arguments refuse. A value the tool's schema declares as something else is
// read back as such; a value that isn't one is left as it is, for the server to refuse.
export const coerceMcpArguments = (inputSchema: object | undefined, params: Record<string, unknown>): Record<string, unknown> => {
	const properties = (inputSchema as { properties?: Record<string, { type?: unknown }> } | undefined)?.properties
	if (!properties) return params
	const ans = { ...params }
	for (const [name, value] of Object.entries(params)) {
		if (typeof value !== 'string') continue
		const type = properties[name]?.type
		const types = Array.isArray(type) ? type.filter((t): t is string => typeof t === 'string') : typeof type === 'string' ? [type] : []
		if (types.length === 0 || types.includes('string')) continue
		let parsed: unknown
		try { parsed = JSON.parse(value) }
		catch { continue }
		if (types.some(t => isOfType(t, parsed))) ans[name] = parsed
	}
	return ans
}
