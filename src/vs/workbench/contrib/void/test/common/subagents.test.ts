/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { availableTools } from '../../common/prompt/prompts.js';
import { approvalTypeOfBuiltinToolName } from '../../common/toolsServiceTypes.js';
import { formatSubagentReport, resolveSubagentType, SubagentFileClaims, subagentToolNames, summarizeSubagentRun } from '../../common/subagents.js';
import { FILE_CHANGING_TOOLS } from '../../common/completionCheck.js';

suite('Kodia - subagent policy (roadmap 6)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('types: known names and common aliases resolve; anything else is an error naming the valid types', () => {
		assert.deepStrictEqual(['general', 'build', 'Test', 'explore', 'research', 'review', 'code-review'].map(t => (resolveSubagentType(t) as { type: string }).type),
			['general', 'general', 'general', 'explore', 'explore', 'review', 'review']);
		const bad = resolveSubagentType('wizard') as { error: string };
		assert.match(bad.error, /Unknown subagent type "wizard".*"general".*"explore".*"review"/);
	});

	test('tools: read-only types get no tool that changes anything; no type can start subagents', () => {
		const offered = availableTools('agent', undefined)!.map(t => t.name);
		const needsApproval = (n: string) => n in approvalTypeOfBuiltinToolName;
		const general = subagentToolNames('general', offered, needsApproval);
		const explore = subagentToolNames('explore', offered, needsApproval);
		assert.ok(offered.includes('subagent'));
		assert.ok(!general.includes('subagent') && !explore.includes('subagent'));
		assert.deepStrictEqual(general.length, offered.length - 1);
		for (const t of ['edit_file', 'write_file', 'delete_file_or_folder', 'run_command', 'git_commit', 'browser_click_element']) {
			assert.ok(general.includes(t), `general has ${t}`);
			assert.ok(!explore.includes(t), `explore lacks ${t}`);
		}
		for (const t of ['read_file', 'ls_dir', 'search_for_files']) { assert.ok(explore.includes(t), `explore has ${t}`); }
		assert.deepStrictEqual(subagentToolNames('explore', ['read_file', 'some_mcp_tool'], n => n !== 'read_file'), ['read_file'], 'an unknown (MCP) tool counts as changing things');
	});

	test('file claims: first owner keeps a file until released; paths compare case- and separator-insensitively', () => {
		const c = new SubagentFileClaims();
		assert.strictEqual(c.claim('C:\\w\\src\\a.js', 'A'), undefined);
		assert.strictEqual(c.claim('c:/w/SRC/a.js', 'A'), undefined, 'the owner may change it again');
		assert.strictEqual(c.claim('C:/w/src/a.js', 'B'), 'A');
		assert.strictEqual(c.claim('C:/w/src/b.js', 'B'), undefined);
		c.releaseAll('A');
		assert.strictEqual(c.claim('C:/w/src/a.js', 'B'), undefined);
		assert.deepStrictEqual(c.ownedBy('B').length, 2);
	});

	test('report: facts from the tool calls, the child\'s reply labelled as its own, a follow-up hint when not finished', () => {
		const summary = summarizeSubagentRun([
			{ name: 'read_file', type: 'success', target: 'src/a.js' },
			{ name: 'edit_file', type: 'success', target: 'src/a.js' },
			{ name: 'edit_file', type: 'success', target: 'src/a.js' },
			{ name: 'write_file', type: 'tool_error', target: 'src/b.js', error: 'refused' },
			{ name: 'run_command', type: 'rejected' },
		], FILE_CHANGING_TOOLS);
		assert.deepStrictEqual(summary.filesChanged, ['src/a.js'], 'a read is not a change; a failed write is not a change');
		assert.deepStrictEqual(summary.toolCalls, { total: 5, failed: 2, byName: { read_file: 1, edit_file: 2, write_file: 1, run_command: 1 } });
		const text = formatSubagentReport({ sessionID: 's1', agent: 'general', description: 'fix a', status: 'awaiting_approval', output: 'All done!', ...summary, awaitingApprovalOf: 'run_command — npm test', durationMs: 1500 });
		assert.match(text, /^Subagent "fix a" \(general, session s1\) PAUSED — waiting for the user to approve/);
		assert.match(text, /Waiting on: run_command — npm test/);
		assert.match(text, /Files changed: src\/a\.js/);
		assert.match(text, /write_file \(src\/b\.js\) → tool_error: refused/);
		assert.match(text, /own report \(not verified by Kodia\):\nAll done!/);
		assert.match(text, /session_i_d="s1"/);
		assert.doesNotMatch(formatSubagentReport({ sessionID: 's2', agent: 'explore', description: 'x', status: 'completed', output: '', filesChanged: [], toolCalls: { total: 0, failed: 0, byName: {} }, problems: [], durationMs: 0 }), /session_i_d/);
	});
});
