/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';

// ---------------------------------------------------------------------------
// Debugger Activity Types
//
// Tracks the lifecycle of debugger tool calls so the chat UI can show live
// activity (proposed → awaiting approval → running → completed/failed/cancelled)
// with session association, duration, and structured results.
// ---------------------------------------------------------------------------

export type DebuggerActivityStatus = 'proposed' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'cancelled';

export type DebuggerActivityType =
	| 'list_configurations'
	| 'list_sessions'
	| 'get_session_status'
	| 'start_session'
	| 'attach_session'
	| 'stop_session'
	| 'restart_session'
	| 'set_breakpoint'
	| 'remove_breakpoint'
	| 'set_breakpoint_enabled'
	| 'list_breakpoints'
	| 'continue'
	| 'pause'
	| 'step_over'
	| 'step_into'
	| 'step_out'
	| 'list_threads'
	| 'get_stack_trace'
	| 'get_scopes'
	| 'get_variables'
	| 'evaluate_expression'
	| 'get_exception_info'
	| 'get_console_output';

export interface DebuggerActivity {
	id: string;
	type: DebuggerActivityType;
	status: DebuggerActivityStatus;
	title: string;
	description: string;
	sessionId?: string;
	sessionName?: string;
	startTime: number;
	endTime?: number;
	duration?: number;
	details?: any;        // structured result data (safe to display)
	error?: string;       // error message if failed
	sourceLocation?: { uri: string; line: number; column?: number };
}

export interface DebuggerActivityEvent {
	type: 'started' | 'updated' | 'completed' | 'failed' | 'cancelled';
	activity: DebuggerActivity;
}

export interface IDebuggerActivityService {
	readonly _serviceBrand: undefined;

	// Start tracking a new debugger activity.
	startActivity(opts: {
		type: DebuggerActivityType;
		title: string;
		description: string;
		sessionId?: string;
		sessionName?: string;
		sourceLocation?: { uri: string; line: number; column?: number };
	}): string; // returns activity id

	// Update an existing activity's status and/or details.
	updateActivity(activityId: string, opts: {
		status?: DebuggerActivityStatus;
		details?: any;
		error?: string;
	}): void;

	// Complete an activity successfully.
	completeActivity(activityId: string, opts: { details?: any }): void;

	// Fail an activity.
	failActivity(activityId: string, error: string): void;

	// Cancel an activity.
	cancelActivity(activityId: string): void;

	// Get all activities (most recent first).
	getActivities(): DebuggerActivity[];

	// Get activities for a specific session.
	getActivitiesForSession(sessionId: string): DebuggerActivity[];

	// Clear all activities.
	clearActivities(): void;

	// Event emitted when any activity changes.
	readonly onDidChangeDebuggerActivity: Event<DebuggerActivityEvent>;
}

export const IDebuggerActivityService = createDecorator<IDebuggerActivityService>('kodiaDebuggerActivityService');
