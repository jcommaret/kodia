/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useState } from 'react';
import { Container, Cpu, Database, Play, RefreshCw, ShieldAlert, Terminal } from 'lucide-react';
import { useAccessor } from '../util/services.js';
import {
	DbInspectReport,
	DbQueryReport,
	DockerLogsReport,
	DockerStatusReport,
	EnvInspectReport,
} from '../../../../common/kodiaOpsTypes.js';
import { KodiaBadge, KodiaCard, KodiaEmptyState, KodiaPrimaryButton, KodiaSecondaryButton } from '../util/KodiaDesignSystem.js';

type OpsSubTab = 'env' | 'docker' | 'database';

export const OpsInspectorPanel = ({ onSendPrompt }: { onSendPrompt?: (prompt: string) => void }) => {
	const accessor = useAccessor();
	const opsService = accessor.get('IKodiaOpsMainService');
	const workspaceService = accessor.get('IWorkspaceContextService');
	const workspaceRoot = workspaceService.getWorkspace().folders[0]?.uri.fsPath ?? '';

	const [subTab, setSubTab] = useState<OpsSubTab>('env');

	// Environment state
	const [envLoading, setEnvLoading] = useState(false);
	const [envReport, setEnvReport] = useState<EnvInspectReport | null>(null);
	const [envError, setEnvError] = useState<string | null>(null);

	// Docker state
	const [dockerLoading, setDockerLoading] = useState(false);
	const [dockerReport, setDockerReport] = useState<DockerStatusReport | null>(null);
	const [selectedContainer, setSelectedContainer] = useState<string | null>(null);
	const [logsLoading, setLogsLoading] = useState(false);
	const [logsReport, setLogsReport] = useState<DockerLogsReport | null>(null);

	// Database state
	const [dbPathInput, setDbPathInput] = useState('');
	const [dbLoading, setDbLoading] = useState(false);
	const [dbReport, setDbReport] = useState<DbInspectReport | null>(null);
	const [sqlQuery, setSqlQuery] = useState('SELECT name, type FROM sqlite_master WHERE type=\'table\' ORDER BY name;');
	const [allowMutation, setAllowMutation] = useState(false);
	const [queryLoading, setQueryLoading] = useState(false);
	const [queryReport, setQueryReport] = useState<DbQueryReport | null>(null);

	const loadEnv = useCallback(async () => {
		if (!opsService) { setEnvError('KodiaOpsMainService is unavailable in this session.'); return; }
		setEnvLoading(true);
		setEnvError(null);
		try {
			const rep = await opsService.inspectEnvironment(workspaceRoot);
			setEnvReport(rep);
		} catch (e) {
			setEnvError(e instanceof Error ? e.message : String(e));
		} finally {
			setEnvLoading(false);
		}
	}, [opsService, workspaceRoot]);

	const loadDocker = useCallback(async () => {
		if (!opsService) { return; }
		setDockerLoading(true);
		try {
			const rep = await opsService.getDockerStatus(workspaceRoot);
			setDockerReport(rep);
		} catch (e) {
			setDockerReport({ available: false, reason: e instanceof Error ? e.message : String(e), containers: [], composeFiles: [] });
		} finally {
			setDockerLoading(false);
		}
	}, [opsService, workspaceRoot]);

	const loadContainerLogs = useCallback(async (container: string) => {
		if (!opsService) { return; }
		setSelectedContainer(container);
		setLogsLoading(true);
		try {
			const rep = await opsService.getDockerLogs(container, 80);
			setLogsReport(rep);
		} catch (e) {
			setLogsReport({ available: false, container, logs: '', error: e instanceof Error ? e.message : String(e) });
		} finally {
			setLogsLoading(false);
		}
	}, [opsService]);

	const loadDbSchema = useCallback(async () => {
		if (!opsService) { return; }
		setDbLoading(true);
		try {
			const rep = await opsService.inspectDatabase(workspaceRoot, dbPathInput.trim() || undefined);
			setDbReport(rep);
		} catch (e) {
			setDbReport({ engine: 'none', envHints: [], tables: [], error: e instanceof Error ? e.message : String(e) });
		} finally {
			setDbLoading(false);
		}
	}, [opsService, dbPathInput, workspaceRoot]);

	const runSqlQuery = useCallback(async () => {
		if (!opsService || !sqlQuery.trim()) { return; }
		setQueryLoading(true);
		try {
			const rep = await opsService.queryDatabase(workspaceRoot, sqlQuery, dbPathInput.trim() || dbReport?.databasePath, allowMutation);
			setQueryReport(rep);
		} catch (e) {
			setQueryReport({ databasePath: dbPathInput.trim() || '(auto)', readOnly: !allowMutation, columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 0, error: e instanceof Error ? e.message : String(e) });
		} finally {
			setQueryLoading(false);
		}
	}, [opsService, sqlQuery, dbPathInput, dbReport?.databasePath, allowMutation, workspaceRoot]);

	useEffect(() => {
		if (subTab === 'env' && !envReport && !envLoading) { void loadEnv(); }
		if (subTab === 'docker' && !dockerReport && !dockerLoading) { void loadDocker(); }
		if (subTab === 'database' && !dbReport && !dbLoading) { void loadDbSchema(); }
	}, [subTab, envReport, envLoading, dockerReport, dockerLoading, dbReport, dbLoading, loadEnv, loadDocker, loadDbSchema]);

	if (!opsService) {
		return (
			<div className='p-3'>
				<KodiaEmptyState
					icon={<Cpu size={22} />}
					title='Operations Console Unavailable'
					description='Restart Kodia to connect the Electron main-process Operations IPC channel.'
				/>
			</div>
		);
	}

	return (
		<div className='h-full flex flex-col overflow-hidden text-xs'>
			<div className='flex items-center justify-between gap-2 px-3 py-2 border-b border-void-border-2 bg-void-bg-1 flex-shrink-0'>
				<div className='flex items-center gap-1'>
					{([
						{ id: 'env', label: 'Environment', icon: <Cpu size={12} /> },
						{ id: 'docker', label: 'Docker', icon: <Container size={12} /> },
						{ id: 'database', label: 'Database', icon: <Database size={12} /> },
					] as const).map(item => (
						<button
							key={item.id}
							type='button'
							onClick={() => setSubTab(item.id)}
							className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${subTab === item.id
								? 'bg-void-bg-3 text-void-fg-1 border border-void-border-2'
								: 'text-void-fg-3 hover:text-void-fg-1 hover:bg-void-bg-2 border border-transparent'
								}`}
						>
							{item.icon}
							<span>{item.label}</span>
						</button>
					))}
				</div>
				<KodiaSecondaryButton
					className='!px-2 !py-1 !text-[11px]'
					onClick={() => {
						if (subTab === 'env') { void loadEnv(); }
						else if (subTab === 'docker') { void loadDocker(); }
						else { void loadDbSchema(); }
					}}
					disabled={envLoading || dockerLoading || dbLoading}
				>
					<RefreshCw size={11} className={(envLoading || dockerLoading || dbLoading) ? 'animate-spin' : ''} />
					<span>Refresh</span>
				</KodiaSecondaryButton>
			</div>

			<div className='flex-1 overflow-y-auto p-3 flex flex-col gap-3'>
				{subTab === 'env' && (
					<>
						{envError && (
							<div className='p-2.5 rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-300 text-[11px]'>{envError}</div>
						)}
						{envLoading && !envReport && (
							<div className='text-void-fg-3 text-[11px] py-4 text-center'>Probing local toolchains and workspace manifests…</div>
						)}
						{envReport && (
							<>
								<KodiaCard>
									<div className='flex items-center justify-between mb-2'>
										<span className='font-semibold text-void-fg-1'>Host Runtime</span>
										<KodiaBadge tone='accent'>{envReport.platform} · {envReport.arch}</KodiaBadge>
									</div>
									<div className='grid grid-cols-2 gap-1.5 text-[11px] text-void-fg-3'>
										<div>Node: <span className='text-void-fg-1 font-mono'>{envReport.nodeVersion}</span></div>
										<div>CPUs / RAM: <span className='text-void-fg-1'>{envReport.cpuCount}c / {(envReport.totalMemoryMb / 1024).toFixed(1)} GB</span></div>
										<div className='col-span-2 truncate'>Workspace: <span className='text-void-fg-1 font-mono'>{workspaceRoot || '(no folder)'}</span></div>
									</div>
								</KodiaCard>

								<KodiaCard>
									<div className='flex items-center justify-between mb-2'>
										<span className='font-semibold text-void-fg-1'>Detected Toolchains</span>
										<KodiaBadge tone='success'>
											{envReport.toolchains.filter(t => t.available).length}/{envReport.toolchains.length} installed
										</KodiaBadge>
									</div>
									<div className='flex flex-wrap gap-1.5'>
										{envReport.toolchains.map(t => (
											<div
												key={t.name}
												className={`px-2 py-1 rounded border text-[11px] flex items-center gap-1.5 ${t.available
													? 'bg-void-bg-1 border-void-border-2 text-void-fg-1'
													: 'bg-void-bg-2/40 border-void-border-3 text-void-fg-4 opacity-60'
													}`}
												title={t.version ?? 'Not installed'}
											>
												<span className={`w-1.5 h-1.5 rounded-full ${t.available ? 'bg-emerald-400' : 'bg-void-fg-4'}`} />
												<span className='font-medium'>{t.name}</span>
												{t.version && <span className='text-[10px] text-void-fg-3 font-mono max-w-[110px] truncate'>{t.version}</span>}
											</div>
										))}
									</div>
								</KodiaCard>

								{envReport.detectedManifests.length > 0 && (
									<KodiaCard>
										<div className='font-semibold text-void-fg-1 mb-1.5'>Project Manifests</div>
										<div className='flex flex-wrap gap-1.5'>
											{envReport.detectedManifests.map(m => (
												<KodiaBadge key={m} tone='neutral'>{m}</KodiaBadge>
											))}
										</div>
									</KodiaCard>
								)}

								{envReport.detectedEnvDatabases.length > 0 && (
									<KodiaCard>
										<div className='flex items-center justify-between mb-1.5'>
											<span className='font-semibold text-void-fg-1'>Database Config Hints</span>
											<KodiaBadge tone='success'>Credentials Redacted</KodiaBadge>
										</div>
										<div className='flex flex-col gap-1 font-mono text-[10px] text-void-fg-2'>
											{envReport.detectedEnvDatabases.map((hint, i) => (
												<div key={i} className='truncate bg-void-bg-1 px-2 py-1 rounded'>{hint}</div>
											))}
										</div>
									</KodiaCard>
								)}
							</>
						)}
					</>
				)}

				{subTab === 'docker' && (
					<>
						{dockerLoading && !dockerReport && (
							<div className='text-void-fg-3 text-[11px] py-4 text-center'>Querying Docker Engine…</div>
						)}
						{dockerReport && !dockerReport.available && (
							<KodiaEmptyState
								icon={<Container size={22} />}
								title='Docker Engine Unavailable'
								description={dockerReport.reason ?? 'Docker CLI or daemon is not running on this machine.'}
								action={<KodiaSecondaryButton onClick={() => void loadDocker()}>Retry</KodiaSecondaryButton>}
							/>
						)}
						{dockerReport?.available && (
							<>
								<div className='flex items-center justify-between'>
									<span className='text-[11px] text-void-fg-3'>
										{dockerReport.containers.length} container(s) detected
									</span>
									{dockerReport.version && <KodiaBadge tone='neutral'>{dockerReport.version}</KodiaBadge>}
								</div>
								{dockerReport.composeFiles.length > 0 && (
									<div className='flex flex-wrap gap-1'>
										{dockerReport.composeFiles.map(cf => <KodiaBadge key={cf} tone='accent'>{cf}</KodiaBadge>)}
									</div>
								)}
								{dockerReport.containers.length === 0 ? (
									<KodiaEmptyState
										icon={<Container size={20} />}
										title='No Containers Running'
										description='Start a container or Docker Compose stack to inspect its live state and logs here.'
									/>
								) : (
									<div className='flex flex-col gap-2'>
										{dockerReport.containers.map(c => (
											<KodiaCard key={c.id} className='!p-2.5 flex flex-col gap-1.5'>
												<div className='flex items-center justify-between gap-2'>
													<div className='min-w-0'>
														<div className='font-semibold text-void-fg-1 truncate'>{c.name}</div>
														<div className='text-[10px] text-void-fg-3 font-mono truncate'>{c.image}</div>
													</div>
													<KodiaBadge tone={c.state.toLowerCase().includes('running') ? 'success' : 'neutral'}>
														{c.state}
													</KodiaBadge>
												</div>
												<div className='flex items-center justify-between text-[10px] text-void-fg-3'>
													<span className='truncate'>{c.ports || c.status}</span>
													<button
														type='button'
														onClick={() => void loadContainerLogs(c.name)}
														className='text-blue-400 hover:underline flex items-center gap-1 cursor-pointer shrink-0'
													>
														<Terminal size={10} />
														<span>Logs</span>
													</button>
												</div>
											</KodiaCard>
										))}
									</div>
								)}

								{selectedContainer && (
									<KodiaCard className='!p-2.5 flex flex-col gap-1.5'>
										<div className='flex items-center justify-between'>
											<span className='font-semibold text-void-fg-1'>Logs: {selectedContainer}</span>
											{onSendPrompt && logsReport?.logs && (
												<button
													type='button'
													onClick={() => onSendPrompt(`Analyze these Docker logs from container "${selectedContainer}" and diagnose any errors:\n\n\`\`\`\n${logsReport.logs.slice(-3000)}\n\`\`\``)}
													className='text-[10px] text-blue-400 hover:underline cursor-pointer'
												>
													Ask Kodia to Diagnose
												</button>
											)}
										</div>
										{logsLoading ? (
											<div className='text-void-fg-3 text-[11px]'>Fetching tail logs…</div>
										) : logsReport?.error ? (
											<div className='text-rose-400 text-[11px]'>{logsReport.error}</div>
										) : (
											<pre className='max-h-48 overflow-auto bg-void-bg-1 p-2 rounded text-[10px] font-mono text-void-fg-2 whitespace-pre-wrap'>
												{logsReport?.logs || '(no log output)'}
											</pre>
										)}
									</KodiaCard>
								)}
							</>
						)}
					</>
				)}

				{subTab === 'database' && (
					<>
						<div className='flex items-center gap-1.5'>
							<input
								type='text'
								value={dbPathInput}
								onChange={e => setDbPathInput(e.target.value)}
								placeholder='Auto-discover workspace .sqlite / .db (or enter path)'
								className='flex-1 px-2.5 py-1.5 rounded-md bg-void-bg-1 border border-void-border-2 text-[11px] text-void-fg-1 placeholder:text-void-fg-3'
							/>
							<KodiaSecondaryButton onClick={() => void loadDbSchema()} disabled={dbLoading} className='!py-1.5 !text-[11px]'>
								Inspect
							</KodiaSecondaryButton>
						</div>

						{dbReport && dbReport.engine !== 'sqlite' && (
							<KodiaEmptyState
								icon={<Database size={20} />}
								title={dbReport.engine === 'detected-env' ? 'External DB Detected in .env' : 'No SQLite Database Loaded'}
								description={dbReport.error ?? (dbReport.envHints.length > 0
									? `Detected .env hints: ${dbReport.envHints.join(' · ')}. Enter a local SQLite path above to inspect tables directly.`
									: 'Enter a path to a local SQLite database file to browse tables and run read-only SQL queries.')}
							/>
						)}

						{dbReport?.engine === 'sqlite' && (
							<>
								<KodiaCard className='!p-2.5'>
									<div className='flex items-center justify-between mb-1.5'>
										<span className='font-semibold text-void-fg-1 truncate' title={dbReport.databasePath}>
											SQLite Schema ({dbReport.tables.length} tables)
										</span>
										<KodiaBadge tone='success'>Connected</KodiaBadge>
									</div>
									<div className='text-[10px] text-void-fg-3 font-mono truncate mb-2'>{dbReport.databasePath}</div>
									<div className='flex flex-col gap-1.5 max-h-44 overflow-y-auto'>
										{dbReport.tables.map(tbl => (
											<div
												key={tbl.name}
												onClick={() => setSqlQuery(`SELECT * FROM "${tbl.name}" LIMIT 25;`)}
												className='p-2 rounded bg-void-bg-1 border border-void-border-2 hover:border-void-border-1 cursor-pointer transition-colors'
											>
												<div className='flex items-center justify-between'>
													<span className='font-mono font-medium text-void-fg-1'>{tbl.name}</span>
													<span className='text-[10px] text-void-fg-3'>{tbl.rowCount ?? '?'} rows</span>
												</div>
												<div className='text-[10px] text-void-fg-3 truncate mt-0.5'>
													{tbl.columns.map(c => `${c.name}${c.primaryKey ? '*' : ''}:${c.type}`).join(', ')}
												</div>
											</div>
										))}
									</div>
								</KodiaCard>

								<KodiaCard className='!p-2.5 flex flex-col gap-2'>
									<div className='flex items-center justify-between'>
										<span className='font-semibold text-void-fg-1'>SQL Query Runner</span>
										<KodiaBadge tone={allowMutation ? 'warning' : 'success'}>
											{allowMutation ? 'Write Enabled' : 'Read-Only Guard'}
										</KodiaBadge>
									</div>
									<textarea
										rows={3}
										value={sqlQuery}
										onChange={e => setSqlQuery(e.target.value)}
										className='w-full p-2 rounded bg-void-bg-1 border border-void-border-2 font-mono text-[11px] text-void-fg-1 resize-y'
									/>
									<div className='flex items-center justify-between gap-2'>
										<label className='flex items-center gap-1.5 text-[10px] text-void-fg-3 cursor-pointer select-none'>
											<input
												type='checkbox'
												checked={allowMutation}
												onChange={e => setAllowMutation(e.target.checked)}
											/>
											<ShieldAlert size={11} className={allowMutation ? 'text-amber-400' : 'opacity-50'} />
											<span>Allow write SQL</span>
										</label>
										<KodiaPrimaryButton onClick={() => void runSqlQuery()} disabled={queryLoading} className='!py-1 !px-2.5 !text-[11px]'>
											<Play size={11} />
											<span>{queryLoading ? 'Running…' : 'Run Query'}</span>
										</KodiaPrimaryButton>
									</div>

									{queryReport?.error && (
										<div className='p-2 rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 text-[11px]'>
											{queryReport.error}
										</div>
									)}

									{queryReport && !queryReport.error && (
										<div className='flex flex-col gap-1'>
											<div className='text-[10px] text-void-fg-3'>
												{queryReport.rows.length > 0
													? `${queryReport.rowCount} row(s) in ${queryReport.durationMs}ms${queryReport.truncated ? ' (capped at 200)' : ''}`
													: `Statement succeeded in ${queryReport.durationMs}ms (${queryReport.rowCount} row(s) affected)`}
											</div>
											{queryReport.columns.length > 0 && (
												<div className='max-h-48 overflow-auto border border-void-border-2 rounded'>
													<table className='w-full text-left border-collapse text-[10px] font-mono'>
														<thead className='bg-void-bg-1 sticky top-0'>
															<tr>
																{queryReport.columns.map(col => (
																	<th key={col} className='px-2 py-1 border-b border-void-border-2 text-void-fg-2 font-semibold whitespace-nowrap'>
																		{col}
																	</th>
																))}
															</tr>
														</thead>
														<tbody>
															{queryReport.rows.slice(0, 50).map((row, idx) => (
																<tr key={idx} className='border-b border-void-border-3/60 hover:bg-void-bg-1/50'>
																	{queryReport.columns.map(col => (
																		<td key={col} className='px-2 py-1 text-void-fg-1 max-w-[160px] truncate'>
																			{row[col] === null || row[col] === undefined ? 'NULL' : String(row[col])}
																		</td>
																	))}
																</tr>
															))}
														</tbody>
													</table>
												</div>
											)}
										</div>
									)}
								</KodiaCard>
							</>
						)}
					</>
				)}
			</div>
		</div>
	);
};
