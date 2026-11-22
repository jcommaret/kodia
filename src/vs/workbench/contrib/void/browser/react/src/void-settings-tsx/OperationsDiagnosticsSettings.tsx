/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useState } from 'react';
import { Activity, CheckCircle2, Container, Cpu, FolderOpen, RefreshCw, ShieldCheck, Terminal } from 'lucide-react';
import { useAccessor } from '../util/services.js';
import { SettingsSection, SettingGroup } from './SettingsControls.js';
import { KodiaBadge, KodiaCard, KodiaSecondaryButton, KodiaStatTile } from '../util/KodiaDesignSystem.js';
import { DockerStatusReport, EnvInspectReport } from '../../../../common/kodiaOpsTypes.js';

export const OperationsDiagnosticsSection = () => {
	const accessor = useAccessor();
	const opsService = accessor.get('IKodiaOpsMainService');
	const observabilityService = accessor.get('IExecutionObservabilityService');
	const chatThreadService = accessor.get('IChatThreadService');
	const workspaceService = accessor.get('IWorkspaceContextService');
	const environmentService = accessor.get('IEnvironmentService');
	const nativeHostService = accessor.get('INativeHostService');
	const hooksService = accessor.get('IKodiaHooksMainService');

	const workspaceFolders = workspaceService.getWorkspace().folders.map(f => f.uri.fsPath);
	const workspaceRoot = workspaceFolders[0] ?? '';

	const [envReport, setEnvReport] = useState<EnvInspectReport | null>(null);
	const [dockerReport, setDockerReport] = useState<DockerStatusReport | null>(null);
	const [hookCount, setHookCount] = useState<number>(0);
	const [loading, setLoading] = useState(false);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			if (opsService) {
				const [env, docker] = await Promise.all([
					opsService.inspectEnvironment(workspaceRoot),
					opsService.getDockerStatus(workspaceRoot),
				]);
				setEnvReport(env);
				setDockerReport(docker);
			}
			if (hooksService) {
				const hooks = await hooksService.listConfiguredHooks(workspaceFolders);
				setHookCount(hooks.length);
			}
		} finally {
			setLoading(false);
		}
	}, [opsService, hooksService, workspaceRoot, workspaceFolders.join('|')]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const currentThreadId = chatThreadService.state.currentThreadId;
	const metrics = observabilityService.getMetrics(currentThreadId);
	const successRate = metrics.toolCalls > 0
		? `${Math.round(((metrics.toolCalls - metrics.toolFailures) / metrics.toolCalls) * 100)}%`
		: '—';

	return (
		<SettingsSection
			title='Operations, Security & Diagnostics'
			description='Inspect your live development runtimes, Docker & SQLite safety boundaries, execution observability, and Kodia system health.'
			badge={
				<KodiaSecondaryButton onClick={() => void refresh()} disabled={loading} className='!py-1 !text-[11px]'>
					<RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
					<span>Refresh Live Probes</span>
				</KodiaSecondaryButton>
			}
		>
			<SettingGroup title='Environment & runtimes' description='Live detection from KodiaOpsMainService (also available to agents via env_inspect, docker_status, db_inspect, and db_query).'>
				{!opsService ? (
					<div className='text-xs text-void-fg-3'>Restart Kodia to activate the main-process Operations IPC channel.</div>
				) : !envReport ? (
					<div className='text-xs text-void-fg-3'>Probing host environment…</div>
				) : (
					<div className='flex flex-col gap-3'>
						<div className='grid grid-cols-1 sm:grid-cols-3 gap-2.5'>
							<KodiaStatTile
								label='Host Platform'
								value={`${envReport.platform} (${envReport.arch})`}
								detail={`Node ${envReport.nodeVersion} · ${envReport.cpuCount} CPUs / ${(envReport.totalMemoryMb / 1024).toFixed(1)} GB`}
								icon={<Cpu size={14} />}
							/>
							<KodiaStatTile
								label='Installed Toolchains'
								value={`${envReport.toolchains.filter(t => t.available).length} / ${envReport.toolchains.length}`}
								detail={envReport.toolchains.filter(t => t.available).map(t => t.name).join(', ') || 'None'}
								icon={<Terminal size={14} />}
							/>
							<KodiaStatTile
								label='Docker Engine'
								value={dockerReport?.available ? `${dockerReport.containers.length} container(s)` : 'Not running'}
								detail={dockerReport?.available ? (dockerReport.version ?? 'Connected') : (dockerReport?.reason ?? 'Start Docker to enable')}
								icon={<Container size={14} />}
							/>
						</div>
					</div>
				)}
			</SettingGroup>

			<SettingGroup title='Security & safety posture' description='Built-in deterministic protections active regardless of which LLM provider you connect.'>
				<div className='grid grid-cols-1 sm:grid-cols-2 gap-2.5'>
					{[
						{ title: 'Secret Detection & Redaction', detail: 'Hardcoded keys & .env DATABASE_URL credentials are automatically redacted as [REDACTED_SECRET].' },
						{ title: 'Read-Only SQLite Guard', detail: 'db_query blocks INSERT/UPDATE/DELETE/DROP and stacked queries unless explicitly unlocked.' },
						{ title: 'Docker Injection Validation', detail: 'Container names are strictly regex-validated before invoking the Docker CLI.' },
						{ title: 'Lifecycle Hooks Guard', detail: `${hookCount} configured hook(s) active across PreToolUse / PostToolUse / Checkpoint events.` },
					].map(item => (
						<KodiaCard key={item.title} className='!p-3 flex items-start gap-2.5'>
							<CheckCircle2 size={15} className='text-emerald-400 shrink-0 mt-0.5' />
							<div>
								<div className='text-xs font-semibold text-void-fg-1'>{item.title}</div>
								<div className='text-[11px] text-void-fg-3 mt-0.5 leading-relaxed'>{item.detail}</div>
							</div>
						</KodiaCard>
					))}
				</div>
			</SettingGroup>

			<SettingGroup title='Execution diagnostics & telemetry' description='Live in-session metrics from Kodia’s structured execution observability service.'>
				<div className='grid grid-cols-1 sm:grid-cols-4 gap-2.5'>
					<KodiaStatTile label='Tool Calls' value={metrics.toolCalls} icon={<Activity size={14} />} />
					<KodiaStatTile label='Success Rate' value={successRate} icon={<ShieldCheck size={14} />} />
					<KodiaStatTile label='Failed Calls' value={metrics.toolFailures} />
					<KodiaStatTile label='Avg Latency' value={metrics.toolCalls > 0 ? `${Math.round(metrics.avgToolMs)} ms` : '—'} />
				</div>

				<div className='pt-1 flex flex-wrap gap-2'>
					<KodiaSecondaryButton onClick={() => void nativeHostService.showItemInFolder(environmentService.logsHome.fsPath)}>
						<FolderOpen size={13} />
						<span>Open Application Logs Folder</span>
					</KodiaSecondaryButton>
				</div>
			</SettingGroup>

			<SettingGroup title='About Kodia' description='Autonomous AI software engineering environment built on Electron & VS Code.'>
				<KodiaCard className='flex flex-col gap-2'>
					<div className='flex items-center justify-between flex-wrap gap-2'>
						<div className='text-sm font-semibold text-void-fg-1'>Kodia Autonomous Engineering Platform</div>
						<div className='flex items-center gap-1.5'>
							<KodiaBadge tone='accent'>157 Built-In Tools</KodiaBadge>
							<KodiaBadge tone='success'>19 Specialist Agents</KodiaBadge>
							<KodiaBadge tone='neutral'>BYOK Ready</KodiaBadge>
						</div>
					</div>
					<div className='text-xs text-void-fg-3 leading-relaxed'>
						Includes deterministic BYOK tool-argument auto-repair, self-improving failure-pattern memory, multi-agent orchestration, real Playwright browser automation, DAP debugging, Git worktrees, SQLite/Docker ops console, unified inline diffs with single-file revert, and standalone headless CLI.
					</div>
					<div className='text-[11px] font-mono bg-void-bg-1 px-2.5 py-1.5 rounded border border-void-border-2 text-void-fg-2'>
						CLI: node scripts/kodia-cli.mjs health | arch | run &quot;...&quot;
					</div>
				</KodiaCard>
			</SettingGroup>
		</SettingsSection>
	);
};
