/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	evaluateAutonomy, assessRisk,
} from '../../common/autonomyPolicy.js';

// ============================================================================
// Tests for Git autonomy policy
// ============================================================================

suite('Kodia - Git Autonomy Policy (Stage 2)', () => {

	suite('assessRisk - git tools', () => {
		test('git_status is low risk', () => {
			assert.strictEqual(assessRisk('git_status', {}), 'low');
		});
		test('git_diff is low risk', () => {
			assert.strictEqual(assessRisk('git_diff', {}), 'low');
		});
		test('git_log is low risk', () => {
			assert.strictEqual(assessRisk('git_log', {}), 'low');
		});
		test('git_branch_list is low risk', () => {
			assert.strictEqual(assessRisk('git_branch_list', {}), 'low');
		});
		test('git_show is low risk', () => {
			assert.strictEqual(assessRisk('git_show', {}), 'low');
		});

		test('git_branch_create is medium risk', () => {
			assert.strictEqual(assessRisk('git_branch_create', {}), 'medium');
		});
		test('git_branch_switch is medium risk', () => {
			assert.strictEqual(assessRisk('git_branch_switch', {}), 'medium');
		});
		test('git_stage is medium risk', () => {
			assert.strictEqual(assessRisk('git_stage', {}), 'medium');
		});
		test('git_unstage is medium risk', () => {
			assert.strictEqual(assessRisk('git_unstage', {}), 'medium');
		});
		test('git_commit is medium risk', () => {
			assert.strictEqual(assessRisk('git_commit', {}), 'medium');
		});
		test('git_stash is medium risk', () => {
			assert.strictEqual(assessRisk('git_stash', {}), 'medium');
		});
		test('git_stash_pop is medium risk', () => {
			assert.strictEqual(assessRisk('git_stash_pop', {}), 'medium');
		});

		test('git_fetch is medium risk', () => {
			assert.strictEqual(assessRisk('git_fetch', {}), 'medium');
		});
		test('git_pull is medium risk', () => {
			assert.strictEqual(assessRisk('git_pull', {}), 'medium');
		});
		test('git_merge is medium risk', () => {
			assert.strictEqual(assessRisk('git_merge', {}), 'medium');
		});
		test('history operations, tags, remotes and worktrees are classified (none falls through as unknown)', () => {
			for (const t of ['git_tag_list', 'git_remote_list', 'git_worktree_list']) { assert.strictEqual(assessRisk(t, {}), 'low', t); }
			for (const t of ['git_revert', 'git_cherry_pick', 'git_continue', 'git_abort', 'git_tag_create', 'git_worktree_add']) { assert.strictEqual(assessRisk(t, {}), 'medium', t); }
			assert.strictEqual(assessRisk('git_rebase', { onto: 'main' }), 'high');
			assert.strictEqual(assessRisk('git_reset', { mode: 'mixed' }), 'high');
			assert.strictEqual(assessRisk('git_reset', { mode: 'hard' }), 'critical');
		});

		test('git_push is high risk (non-force)', () => {
			assert.strictEqual(assessRisk('git_push', {}), 'high');
		});
		test('git_push with force=true is critical risk', () => {
			assert.strictEqual(assessRisk('git_push', { force: true }), 'critical');
		});
	});

	suite('evaluateAutonomy - git tools in Agent mode', () => {
		const autoApprove: Record<string, boolean> = {};

		test('git_status is allowed in Agent mode (low < high)', () => {
			const e = evaluateAutonomy({
				mode: 'agent', autoApprove, operationPolicy: {},
				toolName: 'git_status', params: {},
				isOutsideWorkspace: false,
			});
			assert.strictEqual(e.decision, 'allow');
			assert.strictEqual(e.risk, 'low');
		});

		test('git_diff is allowed in Agent mode', () => {
			const e = evaluateAutonomy({
				mode: 'agent', autoApprove, operationPolicy: {},
				toolName: 'git_diff', params: {},
				isOutsideWorkspace: false,
			});
			assert.strictEqual(e.decision, 'allow');
			assert.strictEqual(e.risk, 'low');
		});

		test('git_commit requires approval in Assist mode (medium >= medium)', () => {
			const e = evaluateAutonomy({
				mode: 'assist', autoApprove, operationPolicy: {},
				toolName: 'git_commit', params: { message: 'test' },
				isOutsideWorkspace: false,
			});
			assert.strictEqual(e.decision, 'requireApproval');
			assert.strictEqual(e.risk, 'medium');
		});

		test('git_commit is allowed in Agent mode (medium < high)', () => {
			const e = evaluateAutonomy({
				mode: 'agent', autoApprove, operationPolicy: {},
				toolName: 'git_commit', params: { message: 'test' },
				isOutsideWorkspace: false,
			});
			assert.strictEqual(e.decision, 'allow');
			assert.strictEqual(e.risk, 'medium');
		});

		test('git_push requires approval in Agent mode (high >= high)', () => {
			const e = evaluateAutonomy({
				mode: 'agent', autoApprove, operationPolicy: {},
				toolName: 'git_push', params: {},
				isOutsideWorkspace: false,
			});
			assert.strictEqual(e.decision, 'requireApproval');
			assert.strictEqual(e.risk, 'high');
		});

		test('git_push with force requires approval in all modes', () => {
			const e = evaluateAutonomy({
				mode: 'agent', autoApprove, operationPolicy: {},
				toolName: 'git_push', params: { force: true },
				isOutsideWorkspace: false,
			});
			assert.strictEqual(e.decision, 'requireApproval');
			assert.strictEqual(e.risk, 'critical');
		});

		test('git_push with force requires approval in Autonomous mode', () => {
			const e = evaluateAutonomy({
				mode: 'autonomous', autoApprove, operationPolicy: {},
				toolName: 'git_push', params: { force: true },
				isOutsideWorkspace: false,
			});
			assert.strictEqual(e.decision, 'requireApproval');
			assert.strictEqual(e.risk, 'critical');
		});

		test('git_push with autoApprove terminal is allowed in Agent mode', () => {
			const e = evaluateAutonomy({
				mode: 'agent', autoApprove: { git: true }, operationPolicy: {},
				toolName: 'git_push', params: {},
				isOutsideWorkspace: false,
			});
			assert.strictEqual(e.decision, 'allow');
			assert.strictEqual(e.risk, 'high');
		});

		test('git_push with force still requires approval even with autoApprove (critical safeguard)', () => {
			const e = evaluateAutonomy({
				mode: 'agent', autoApprove: { git: true }, operationPolicy: {},
				toolName: 'git_push', params: { force: true },
				isOutsideWorkspace: false,
			});
			assert.strictEqual(e.decision, 'requireApproval');
			assert.strictEqual(e.risk, 'critical');
		});

		test('git operations outside workspace are allowed in Agent mode (location is not a gate)', () => {
			const e = evaluateAutonomy({
				mode: 'agent', autoApprove, operationPolicy: {},
				toolName: 'git_commit', params: { message: 'test' },
				isOutsideWorkspace: true,
			});
			assert.strictEqual(e.decision, 'allow');
			assert.strictEqual(e.risk, 'medium');
		});
	});

	suite('evaluateAutonomy - git tools in Assist mode', () => {
		const autoApprove: Record<string, boolean> = {};

		test('git_status is allowed in Assist mode (low < medium)', () => {
			const e = evaluateAutonomy({
				mode: 'assist', autoApprove, operationPolicy: {},
				toolName: 'git_status', params: {},
				isOutsideWorkspace: false,
			});
			assert.strictEqual(e.decision, 'allow');
		});

		test('git_commit requires approval in Assist mode', () => {
			const e = evaluateAutonomy({
				mode: 'assist', autoApprove, operationPolicy: {},
				toolName: 'git_commit', params: { message: 'test' },
				isOutsideWorkspace: false,
			});
			assert.strictEqual(e.decision, 'requireApproval');
		});

		test('git_push requires approval in Assist mode', () => {
			const e = evaluateAutonomy({
				mode: 'assist', autoApprove, operationPolicy: {},
				toolName: 'git_push', params: {},
				isOutsideWorkspace: false,
			});
			assert.strictEqual(e.decision, 'requireApproval');
		});
	});

	suite('evaluateAutonomy - git tools in Autonomous mode', () => {
		const autoApprove: Record<string, boolean> = {};

		test('git_status is allowed in Autonomous mode', () => {
			const e = evaluateAutonomy({
				mode: 'autonomous', autoApprove, operationPolicy: {},
				toolName: 'git_status', params: {},
				isOutsideWorkspace: false,
			});
			assert.strictEqual(e.decision, 'allow');
		});

		test('git_commit is allowed in Autonomous mode (medium < high)', () => {
			const e = evaluateAutonomy({
				mode: 'autonomous', autoApprove, operationPolicy: {},
				toolName: 'git_commit', params: { message: 'test' },
				isOutsideWorkspace: false,
			});
			assert.strictEqual(e.decision, 'allow');
			assert.strictEqual(e.risk, 'medium');
		});

		test('git_push requires approval in Autonomous mode', () => {
			const e = evaluateAutonomy({
				mode: 'autonomous', autoApprove, operationPolicy: {},
				toolName: 'git_push', params: {},
				isOutsideWorkspace: false,
			});
			assert.strictEqual(e.decision, 'requireApproval');
		});
	});

	suite('Policy precedence - git explicit operation policy', () => {

		test('explicit block on git_push overrides autoApprove', () => {
			const e = evaluateAutonomy({
				mode: 'agent', autoApprove: { git: true }, operationPolicy: { 'git_push': 'block' },
				toolName: 'git_push', params: {},
				isOutsideWorkspace: false,
			});
			assert.strictEqual(e.decision, 'block');
		});

		test('explicit allow on git_commit permits in Assist mode', () => {
			const e = evaluateAutonomy({
				mode: 'assist', autoApprove: {}, operationPolicy: { 'git_commit': 'allow' },
				toolName: 'git_commit', params: { message: 'test' },
				isOutsideWorkspace: false,
			});
			assert.strictEqual(e.decision, 'allow');
		});

		test('explicit allow on git_push with force still requires approval (critical safeguard)', () => {
			const e = evaluateAutonomy({
				mode: 'agent', autoApprove: {}, operationPolicy: { 'git_push': 'allow' },
				toolName: 'git_push', params: { force: true },
				isOutsideWorkspace: false,
			});
			assert.strictEqual(e.decision, 'requireApproval');
			assert.strictEqual(e.risk, 'critical');
		});
	});

});
