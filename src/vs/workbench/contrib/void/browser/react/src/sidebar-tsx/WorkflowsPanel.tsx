/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useState } from 'react';
import { Clock, ExternalLink, Pause, Play, Plus, RefreshCw, Trash2, Workflow } from 'lucide-react';
import { URI } from '../../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../../base/common/buffer.js';
import { useAccessor } from '../util/services.js';
import { KodiaScheduledJob, KodiaWorkflowDefinition } from '../../../../common/kodiaWorkflows.js';
import { ChatMode } from '../../../../common/voidSettingsTypes.js';

export const WorkflowsPanel: React.FC<{ onOpenThread?: () => void }> = ({ onOpenThread }) => {
	const accessor = useAccessor();
	const workflowsService = accessor.get('IKodiaWorkflowsService');
	const chatThreadService = accessor.get('IChatThreadService');
	const workspaceContextService = accessor.get('IWorkspaceContextService');
	const fileService = accessor.get('IFileService');
	const commandService = accessor.get('ICommandService');
	const notificationService = accessor.get('INotificationService');

	const [workflows, setWorkflows] = useState<KodiaWorkflowDefinition[]>([]);
	const [jobs, setJobs] = useState<readonly KodiaScheduledJob[]>(() => workflowsService.getScheduledJobs());
	const [loading, setLoading] = useState(false);

	// New scheduled job form
	const [showAddJob, setShowAddJob] = useState(false);
	const [jobName, setJobName] = useState('');
	const [jobPrompt, setJobPrompt] = useState('');
	const [jobMode, setJobMode] = useState<ChatMode>('agent');
	const [jobInterval, setJobInterval] = useState('60');

	const refreshWorkflows = useCallback(async () => {
		setLoading(true);
		try {
			setWorkflows(await workflowsService.listWorkflows());
		} finally {
			setLoading(false);
		}
	}, [workflowsService]);

	useEffect(() => {
		void refreshWorkflows();
		const d = workflowsService.onDidChangeJobs(next => setJobs([...next]));
		return () => d.dispose();
	}, [workflowsService, refreshWorkflows]);

	const createSampleWorkflow = async () => {
		const folder = workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!folder) {
			notificationService.info('Open a workspace folder first to create .kodia/workflows/*.md.');
			return;
		}
		const target = URI.joinPath(folder, '.kodia', 'workflows', 'pre-release-audit.md');
		try {
			const exists = await fileService.exists(target);
			if (!exists) {
				const sample = [
					'---',
					'name: pre-release-audit',
					'description: Run health scan, diagnostics, dependency audit, and tests before release',
					'mode: agent',
					'interval-minutes: 1440',
					'---',
					'1. Run `project_health_scan` and `workspace_diagnostics` to check for secrets, security risks, or compiler errors.',
					'2. Run `dependency_audit` to flag unpinned or risky package specifiers.',
					'3. Run `test_discover` and execute the project test suite with `test_run`.',
					'4. Summarize all findings with exact file paths, pass/fail counts, and recommended fixes.',
				].join('\n') + '\n';
				await fileService.writeFile(target, VSBuffer.fromString(sample));
			}
			await commandService.executeCommand('vscode.open', target);
			await refreshWorkflows();
		} catch (err) {
			notificationService.error(`Could not create workflow: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	const handleRunWorkflow = async (wf: KodiaWorkflowDefinition) => {
		try {
			onOpenThread?.();
			await workflowsService.runWorkflowNow(wf);
		} catch (err) {
			notificationService.error(`Workflow failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	const handleAddJob = (e: React.FormEvent) => {
		e.preventDefault();
		if (!jobPrompt.trim()) { return; }
		workflowsService.addScheduledJob({
			name: jobName.trim() || 'Scheduled Engineering Task',
			prompt: jobPrompt.trim(),
			chatMode: jobMode,
			intervalMinutes: Math.max(1, Number(jobInterval) || 60),
			enabled: true,
		});
		setJobName('');
		setJobPrompt('');
		setJobInterval('60');
		setShowAddJob(false);
	};

	return (
		<div className="flex flex-col h-full overflow-y-auto p-3 gap-3 text-xs text-void-fg-1">
			{/* Reusable Workflows */}
			<div className="flex flex-col gap-2">
				<div className="flex items-center justify-between">
					<span className="font-semibold flex items-center gap-1.5">
						<Workflow size={13} />
						Reusable Workflows
					</span>
					<div className="flex items-center gap-1">
						<button
							type="button"
							onClick={createSampleWorkflow}
							className="flex items-center gap-1 px-2 py-0.5 rounded bg-void-bg-1 border border-void-border-2 hover:bg-void-bg-3 text-[10px]"
						>
							<Plus size={10} />
							New
						</button>
						<button
							type="button"
							onClick={refreshWorkflows}
							className="p-1 rounded bg-void-bg-1 border border-void-border-2 hover:bg-void-bg-3"
							title="Refresh workflows"
						>
							<RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
						</button>
					</div>
				</div>

				{workflows.length === 0 ? (
					<div className="text-[11px] text-void-fg-4 border border-dashed border-void-border-2 rounded p-2.5">
						No workflows found in <code>.kodia/workflows/</code> or <code>.windsurf/workflows/</code>. Click <strong>New</strong> to create a sample multi-step workflow.
					</div>
				) : (
					<div className="flex flex-col gap-1.5">
						{workflows.map(wf => (
							<div key={wf.sourcePath} className="border border-void-border-2 rounded bg-void-bg-1 p-2 flex flex-col gap-1">
								<div className="flex items-center justify-between gap-2">
									<div className="font-medium truncate">{wf.name}</div>
									<div className="flex items-center gap-1 shrink-0">
										<button
											type="button"
											onClick={() => commandService.executeCommand('vscode.open', URI.file(wf.sourcePath))}
											className="px-1.5 py-0.5 rounded bg-void-bg-2 border border-void-border-2 hover:bg-void-bg-3 text-[10px]"
										>
											Edit
										</button>
										<button
											type="button"
											onClick={() => handleRunWorkflow(wf)}
											className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#0e70c0] text-white hover:brightness-110 text-[10px]"
										>
											<Play size={10} />
											Run
										</button>
									</div>
								</div>
								<div className="text-[11px] text-void-fg-3">{wf.description}</div>
								<div className="text-[10px] text-void-fg-4">
									Mode: {wf.mode} · {wf.steps.length} step{wf.steps.length === 1 ? '' : 's'}
								</div>
							</div>
						))}
					</div>
				)}
			</div>

			{/* Scheduled Recurring Background Jobs */}
			<div className="flex flex-col gap-2 pt-2 border-t border-void-border-2">
				<div className="flex items-center justify-between">
					<span className="font-semibold flex items-center gap-1.5">
						<Clock size={13} />
						Scheduled Automations ({jobs.length})
					</span>
					<button
						type="button"
						onClick={() => setShowAddJob(v => !v)}
						className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#0e70c0] text-white hover:brightness-110 text-[10px]"
					>
						<Plus size={10} />
						Schedule Job
					</button>
				</div>

				{showAddJob && (
					<form onSubmit={handleAddJob} className="border border-void-border-2 rounded bg-void-bg-1 p-2.5 flex flex-col gap-2">
						<input
							type="text"
							value={jobName}
							onChange={e => setJobName(e.target.value)}
							placeholder="Job name (e.g. Hourly Health & Test Check)"
							className="px-2 py-1 rounded bg-void-bg-2 border border-void-border-2 text-void-fg-1 text-[11px] outline-none"
						/>
						<textarea
							value={jobPrompt}
							onChange={e => setJobPrompt(e.target.value)}
							placeholder="Prompt Kodia should execute on each run..."
							rows={3}
							className="px-2 py-1 rounded bg-void-bg-2 border border-void-border-2 text-void-fg-1 text-[11px] outline-none resize-y"
						/>
						<div className="flex items-center gap-2">
							<label className="flex items-center gap-1 text-[10px] text-void-fg-3">
								Every (min):
								<input
									type="number"
									min={1}
									max={43200}
									value={jobInterval}
									onChange={e => setJobInterval(e.target.value)}
									className="w-16 px-1.5 py-0.5 rounded bg-void-bg-2 border border-void-border-2 text-void-fg-1 text-[11px]"
								/>
							</label>
							<label className="flex items-center gap-1 text-[10px] text-void-fg-3">
								Mode:
								<select
									value={jobMode}
									onChange={e => setJobMode(e.target.value as ChatMode)}
									className="px-1.5 py-0.5 rounded bg-void-bg-2 border border-void-border-2 text-void-fg-1 text-[11px]"
								>
									<option value="agent">Agent</option>
									<option value="plan">Plan</option>
									<option value="debug">Debug</option>
									<option value="gather">Gather</option>
								</select>
							</label>
							<button
								type="submit"
								disabled={!jobPrompt.trim()}
								className="ml-auto px-2.5 py-1 rounded bg-[#0e70c0] text-white hover:brightness-110 disabled:opacity-50 text-[11px]"
							>
								Create
							</button>
						</div>
					</form>
				)}

				{jobs.length === 0 ? (
					<div className="text-[11px] text-void-fg-4 border border-dashed border-void-border-2 rounded p-2.5">
						No scheduled jobs yet. Schedule recurring health scans, test runs, or dependency audits that run automatically in background threads.
					</div>
				) : (
					<div className="flex flex-col gap-1.5">
						{jobs.map(job => (
							<div key={job.id} className="border border-void-border-2 rounded bg-void-bg-1 p-2 flex flex-col gap-1">
								<div className="flex items-center justify-between gap-2">
									<div className="flex items-center gap-1.5 min-w-0">
										<span className={`w-2 h-2 rounded-full shrink-0 ${job.lastStatus === 'running' ? 'bg-blue-400 animate-pulse' : job.enabled ? 'bg-green-500' : 'bg-void-fg-4'}`} />
										<span className="font-medium truncate">{job.name}</span>
									</div>
									<div className="flex items-center gap-1 shrink-0">
										<button
											type="button"
											disabled={job.lastStatus === 'running'}
											onClick={() => workflowsService.runJobNow(job.id)}
											className="px-1.5 py-0.5 rounded bg-void-bg-2 border border-void-border-2 hover:bg-void-bg-3 text-[10px] disabled:opacity-50"
											title="Run job now"
										>
											<Play size={10} />
										</button>
										<button
											type="button"
											onClick={() => workflowsService.toggleScheduledJob(job.id, !job.enabled)}
											className="px-1.5 py-0.5 rounded bg-void-bg-2 border border-void-border-2 hover:bg-void-bg-3 text-[10px]"
											title={job.enabled ? 'Pause schedule' : 'Enable schedule'}
										>
											{job.enabled ? <Pause size={10} /> : <Play size={10} />}
										</button>
										<button
											type="button"
											onClick={() => workflowsService.deleteScheduledJob(job.id)}
											className="px-1.5 py-0.5 rounded bg-void-bg-2 border border-void-border-2 hover:text-red-400 text-[10px]"
											title="Delete scheduled job"
										>
											<Trash2 size={10} />
										</button>
									</div>
								</div>
								<div className="text-[11px] text-void-fg-3 line-clamp-2">{job.prompt}</div>
								<div className="flex items-center justify-between text-[10px] text-void-fg-4">
									<span>Every {job.intervalMinutes}m · runs: {job.runCount} · {job.lastStatus ?? 'idle'}</span>
									{job.lastThreadId && (
										<button
											type="button"
											onClick={() => {
												chatThreadService.switchToThread(job.lastThreadId!);
												onOpenThread?.();
											}}
											className="flex items-center gap-0.5 text-blue-400 hover:underline"
										>
											Last run <ExternalLink size={9} />
										</button>
									)}
								</div>
								{job.lastError && <div className="text-[10px] text-red-400">{job.lastError}</div>}
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
};
