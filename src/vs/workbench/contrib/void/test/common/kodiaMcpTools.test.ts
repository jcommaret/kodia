/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { coerceMcpArguments, mcpToolsOfServers } from '../../common/kodiaMcpTools.js';
import type { MCPServerOfName } from '../../common/mcpServiceTypes.js';

suite('Kodia - MCP tools of the Agents window agent', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('offers the tools of the servers that are on, with their unprefixed names to show', () => {
		const servers: MCPServerOfName = {
			github: { status: 'success', tools: [{ name: 'a1b2_search_issues', description: 'Search issues.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }, { name: 'a1b2_close' }] },
			sentry: { status: 'success', tools: [{ name: 'c3d4_list' }] },
			off: { status: 'offline', tools: [{ name: 'e5f6_ignored' }] },
			loading: { status: 'loading', tools: [] },
			broken: { status: 'error', error: 'spawn failed' },
		};
		assert.deepStrictEqual(mcpToolsOfServers(servers), [
			{ name: 'a1b2_search_issues', displayName: 'search_issues', serverName: 'github', description: 'Search issues.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
			{ name: 'a1b2_close', displayName: 'close', serverName: 'github' },
			{ name: 'c3d4_list', displayName: 'list', serverName: 'sentry' },
		]);
		assert.deepStrictEqual(mcpToolsOfServers({}), []);
	});

	test('a tool name with no prefix is shown as it is', () => {
		const [tool] = mcpToolsOfServers({ local: { status: 'success', tools: [{ name: 'ping' }] } });
		assert.strictEqual(tool.displayName, 'ping');
	});

	test('reads back the arguments the schema declares as something else than text', () => {
		const schema = {
			type: 'object',
			properties: {
				query: { type: 'string' },
				limit: { type: 'integer' },
				ratio: { type: 'number' },
				draft: { type: 'boolean' },
				labels: { type: 'array' },
				filter: { type: 'object' },
				cursor: { type: ['integer', 'null'] },
				mixed: { type: ['string', 'integer'] },
			},
		};
		assert.deepStrictEqual(
			coerceMcpArguments(schema, { query: '42', limit: '10', ratio: '0.5', draft: 'true', labels: '["a","b"]', filter: '{"state":"open"}', cursor: 'null', mixed: '7', extra: '3' }),
			{ query: '42', limit: 10, ratio: 0.5, draft: true, labels: ['a', 'b'], filter: { state: 'open' }, cursor: null, mixed: '7', extra: '3' },
			'a string stays a string, and so does what the schema doesn\'t describe',
		);
	});

	test('leaves a value that isn\'t what the schema declares for the server to refuse', () => {
		const schema = { properties: { limit: { type: 'integer' }, draft: { type: 'boolean' }, labels: { type: 'array' } } };
		const params = { limit: '1.5', draft: 'yes', labels: '{"a":1}' };
		assert.deepStrictEqual(coerceMcpArguments(schema, params), params);
		assert.deepStrictEqual(coerceMcpArguments(schema, { limit: 10, draft: false }), { limit: 10, draft: false }, 'a value that already has the type');
	});

	test('changes nothing when the tool has no schema, or no properties', () => {
		const params = { limit: '10' };
		assert.strictEqual(coerceMcpArguments(undefined, params), params);
		assert.strictEqual(coerceMcpArguments({ type: 'object' }, params), params);
	});
});
