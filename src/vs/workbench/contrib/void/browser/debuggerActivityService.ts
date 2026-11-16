/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IDebuggerActivityService, DebuggerActivity, DebuggerActivityStatus, DebuggerActivityType, DebuggerActivityEvent } from '../common/debuggerActivityServiceTypes.js';

export class KodiaDebuggerActivityService implements IDebuggerActivityService {
	readonly _serviceBrand: undefined;

	private readonly activities = new Map<string, DebuggerActivity>();
	private readonly _onDidChange = new Emitter<DebuggerActivityEvent>();
	readonly onDidChangeDebuggerActivity: Event<DebuggerActivityEvent> = this._onDidChange.event;

	startActivity(opts: {
		type: DebuggerActivityType;
		title: string;
		description: string;
		sessionId?: string;
		sessionName?: string;
		sourceLocation?: { uri: string; line: number; column?: number };
	}): string {
		const id = `dbg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		const activity: DebuggerActivity = {
			id,
			type: opts.type,
			status: 'proposed',
			title: opts.title,
			description: opts.description,
			sessionId: opts.sessionId,
			sessionName: opts.sessionName,
			startTime: Date.now(),
			sourceLocation: opts.sourceLocation,
		};
		this.activities.set(id, activity);
		this._onDidChange.fire({ type: 'started', activity });
		return id;
	}

	updateActivity(activityId: string, opts: {
		status?: DebuggerActivityStatus;
		details?: any;
		error?: string;
	}): void {
		const activity = this.activities.get(activityId);
		if (!activity) return;

		if (opts.status !== undefined) activity.status = opts.status;
		if (opts.details !== undefined) activity.details = opts.details;
		if (opts.error !== undefined) activity.error = opts.error;
		if (opts.status === 'running' && !activity.endTime) {
			// already started
		}
		this.activities.set(activityId, activity);
		this._onDidChange.fire({ type: 'updated', activity });
	}

	completeActivity(activityId: string, opts: { details?: any }): void {
		const activity = this.activities.get(activityId);
		if (!activity) return;
		activity.status = 'completed';
		activity.endTime = Date.now();
		activity.duration = activity.endTime - activity.startTime;
		if (opts.details !== undefined) activity.details = opts.details;
		this.activities.set(activityId, activity);
		this._onDidChange.fire({ type: 'completed', activity });
	}

	failActivity(activityId: string, error: string): void {
		const activity = this.activities.get(activityId);
		if (!activity) return;
		activity.status = 'failed';
		activity.endTime = Date.now();
		activity.duration = activity.endTime - activity.startTime;
		activity.error = error;
		this.activities.set(activityId, activity);
		this._onDidChange.fire({ type: 'failed', activity });
	}

	cancelActivity(activityId: string): void {
		const activity = this.activities.get(activityId);
		if (!activity) return;
		activity.status = 'cancelled';
		activity.endTime = Date.now();
		activity.duration = activity.endTime - activity.startTime;
		this.activities.set(activityId, activity);
		this._onDidChange.fire({ type: 'cancelled', activity });
	}

	getActivities(): DebuggerActivity[] {
		return [...this.activities.values()].sort((a, b) => b.startTime - a.startTime);
	}

	getActivitiesForSession(sessionId: string): DebuggerActivity[] {
		return this.getActivities().filter(a => a.sessionId === sessionId);
	}

	clearActivities(): void {
		this.activities.clear();
	}
}

registerSingleton(IDebuggerActivityService, KodiaDebuggerActivityService, InstantiationType.Delayed);
