/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
	Activity,
	Brain,
	Compass,
	Cpu,
	Database,
	FlaskConical,
	Play,
	RefreshCw,
	Rocket,
	Search,
	ShieldCheck,
} from 'lucide-react';
import { useAccessor } from '../util/services.js';
import { KodiaBadge, KodiaCard, KodiaEmptyState, KodiaPrimaryButton, KodiaSecondaryButton } from '../util/KodiaDesignSystem.js';
import { ProjectAIEngineState } from '../../../aiEngineeringService.js';
import {
	discoverAICapabilities,
	routeEngineeringRequest,
} from '../../../../common/aiEngineeringKnowledge.js';
import { ModelRegistryStage, RagQueryResult } from '../../../../common/aiEngineeringTypes.js';

type AITab = 'factory' | 'hardware' | 'rag' | 'registry' | 'security' | 'future';

export const AIEngineControlCenter = ({
	onOpenChat,
	onSendPrompt,
}: {
	onOpenChat?: () => void;
	onSendPrompt?: (prompt: string) => void;
}) => {
	const accessor = useAccessor();
	const aiService = accessor.get('IAIEngineeringService');
	const aiMain = accessor.get('IKodiaAIEngineMainService');
	const workspaceService = accessor.get('IWorkspaceContextService');
	const workspaceRoot = workspaceService.getWorkspace().folders[0]?.uri.fsPath ?? '';

	const [tab, setTab] = useState<AITab>('factory');
	const [state, setState] = useState<ProjectAIEngineState>(aiService.state);

	// Factory input
	const [objective, setObjective] = useState('');
	const liveRouting = useMemo(() => (objective.trim().length >= 8 ? routeEngineeringRequest(objective) : null), [objective]);

	// Hardware probe
	const [probingHw, setProbingHw] = useState(false);

	// RAG & Dataset controls
	const [ragIndexName, setRagIndexName] = useState('workspace-docs');
	const [ragQueryText, setRagQueryText] = useState('');
	const [ragBusy, setRagBusy] = useState(false);
	const [ragResult, setRagResult] = useState<RagQueryResult | null>(null);
	const [datasetPath, setDatasetPath] = useState('');
	const [datasetBusy, setDatasetBusy] = useState(false);

	// Future capability search
	const [capQuery, setCapQuery] = useState('');
	const capabilities = useMemo(() => discoverAICapabilities(capQuery), [capQuery]);

	useEffect(() => {
		setState(aiService.state);
		const d = aiService.onDidChange(() => setState({ ...aiService.state }));
		return () => d.dispose();
	}, [aiService]);

	const refreshPersistentStores = useCallback(async () => {
		if (!aiMain || !workspaceRoot) { return; }
		try {
			const [rags, exps, mdls, evals, wfs] = await Promise.all([
				aiMain.listRagIndexes(workspaceRoot),
				aiMain.manageExperiments(workspaceRoot, { action: 'list' }),
				aiMain.manageModelRegistry(workspaceRoot, { action: 'list' }),
				aiMain.listEvaluations(workspaceRoot),
				aiMain.listWorkflows(workspaceRoot),
			]);
			aiService.recordRagIndexes(rags);
			aiService.recordExperiments(exps.experiments);
			aiService.recordModels(mdls.models);
			aiService.recordEvaluations(evals);
			aiService.recordWorkflows(wfs);
		} catch { /* workspace may be empty */ }
	}, [aiMain, aiService, workspaceRoot]);

	useEffect(() => {
		void refreshPersistentStores();
	}, [refreshPersistentStores]);

	const handleProbeHardware = async () => {
		if (!aiMain) { return; }
		setProbingHw(true);
		try {
			const hw = await aiMain.probeComputeHardware(workspaceRoot);
			aiService.recordHardware(hw);
		} finally {
			setProbingHw(false);
		}
	};

	const handleBuildRag = async () => {
		if (!aiMain || !workspaceRoot) { return; }
		setRagBusy(true);
		try {
			await aiMain.buildRagIndex(workspaceRoot, { indexName: ragIndexName.trim() || 'workspace-docs' });
			const all = await aiMain.listRagIndexes(workspaceRoot);
			aiService.recordRagIndexes(all);
		} finally {
			setRagBusy(false);
		}
	};

	const handleQueryRag = async () => {
		if (!aiMain || !workspaceRoot || !ragQueryText.trim()) { return; }
		setRagBusy(true);
		try {
			const res = await aiMain.queryRagIndex(workspaceRoot, {
				indexName: ragIndexName.trim() || 'workspace-docs',
				query: ragQueryText.trim(),
				topK: 5,
			});
			setRagResult(res);
		} finally {
			setRagBusy(false);
		}
	};

	const handleProfileDataset = async () => {
		if (!aiMain || !workspaceRoot || !datasetPath.trim()) { return; }
		setDatasetBusy(true);
		try {
			const rep = await aiMain.profileDataset(workspaceRoot, datasetPath.trim());
			aiService.recordDatasetProfile(rep);
		} finally {
			setDatasetBusy(false);
		}
	};

	const handlePromoteModel = async (id: string, stage: ModelRegistryStage) => {
		if (!aiMain || !workspaceRoot) { return; }
		const res = await aiMain.manageModelRegistry(workspaceRoot, { action: 'promote', id, stage });
		aiService.recordModels(res.models);
	};

	const handleLaunchFactory = async () => {
		if (!objective.trim()) { return; }
		await aiService.launchOneCommandFactory(objective.trim(), prompt => {
			if (onSendPrompt) {
				onSendPrompt(prompt);
				return;
			}
			const chatThreadService = accessor.get('IChatThreadService');
			const threadId = chatThreadService.state.currentThreadId;
			if (chatThreadService.streamState[threadId]?.isRunning) {
				chatThreadService.enqueueUserMessage(threadId, prompt);
			} else {
				void chatThreadService.addUserMessageAndStreamResponse({ userMessage: prompt, threadId });
			}
		});
		onOpenChat?.();
	};

	return (
		<div className='w-full h-full flex flex-col overflow-hidden bg-void-bg-2 text-void-fg-1'>
			{/* Header */}
			<div className='px-3 py-2.5 border-b border-void-border-2 bg-void-bg-1/70 flex items-center justify-between gap-2 shrink-0'>
				<div className='min-w-0'>
					<div className='flex items-center gap-1.5'>
						<Brain size={14} style={{ color: 'var(--kodia-accent)' }} />
						<h2 className='text-xs font-semibold tracking-tight truncate'>AI Engineering Engine</h2>
					</div>
					<p className='text-[10px] text-void-fg-3 truncate mt-0.5'>
						Two Engines · Unified Orchestrator · RAG · Models · Evals
					</p>
				</div>
				<KodiaSecondaryButton onClick={() => void refreshPersistentStores()} className='!px-2 !py-1 !text-[10px]'>
					<RefreshCw size={11} />
					<span>Sync</span>
				</KodiaSecondaryButton>
			</div>

			{/* Sub-tabs */}
			<div className='px-2 py-1.5 border-b border-void-border-2 flex items-center gap-1 overflow-x-auto shrink-0'>
				{[
					{ id: 'factory' as const, label: 'Factory', icon: <Rocket size={11} /> },
					{ id: 'hardware' as const, label: 'Compute', icon: <Cpu size={11} /> },
					{ id: 'rag' as const, label: `RAG & Data (${state.ragIndexes.length})`, icon: <Database size={11} /> },
					{ id: 'registry' as const, label: `Models (${state.models.length})`, icon: <FlaskConical size={11} /> },
					{ id: 'security' as const, label: 'Evals & Sec', icon: <ShieldCheck size={11} /> },
					{ id: 'future' as const, label: 'Future', icon: <Compass size={11} /> },
				].map(t => (
					<button
						key={t.id}
						type='button'
						onClick={() => setTab(t.id)}
						className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] whitespace-nowrap cursor-pointer transition-colors ${tab === t.id ? 'bg-void-bg-3 text-void-fg-1 font-medium border border-void-border-2' : 'text-void-fg-3 hover:text-void-fg-1'}`}
					>
						{t.icon}
						<span>{t.label}</span>
					</button>
				))}
			</div>

			{/* Body */}
			<div className='flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3'>
				{tab === 'factory' && (
					<>
						<KodiaCard className='!p-3 flex flex-col gap-2'>
							<div className='flex items-center justify-between gap-2'>
								<span className='text-xs font-semibold'>One-Command AI Product Factory</span>
								<KodiaBadge tone='accent'>Dual-Engine</KodiaBadge>
							</div>
							<p className='text-[11px] text-void-fg-3 leading-relaxed'>
								Describe any software product or AI system. Kodia automatically routes between Universal Software Engine, AI Engineering Engine, or Dual-Engine Unified orchestration without forcing AI into non-AI apps.
							</p>
							<textarea
								rows={3}
								value={objective}
								onChange={e => setObjective(e.target.value)}
								placeholder='e.g. Build a production-ready customer support platform with React frontend, FastAPI backend, hybrid RAG over company docs, human escalation, evaluations, and Docker deployment…'
								className='w-full px-2.5 py-2 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1 placeholder:text-void-fg-3'
							/>
							{liveRouting && (
								<div className='p-2 rounded bg-void-bg-1 border border-void-border-2 flex flex-col gap-1'>
									<div className='flex items-center justify-between gap-2'>
										<span className='text-[10px] font-semibold uppercase tracking-wider text-void-fg-3'>Live Orchestrator Routing</span>
										<KodiaBadge tone={liveRouting.requiresAI ? 'accent' : 'success'}>
											{liveRouting.engineMode}
										</KodiaBadge>
									</div>
									<div className='text-[11px] text-void-fg-2'>{liveRouting.rationale}</div>
									<div className='text-[10px] text-void-fg-3'>
										Languages: {liveRouting.recommendedLanguages.join(', ')} · Specialists: {liveRouting.recommendedSpecialists.slice(0, 6).join(', ')}
									</div>
								</div>
							)}
							<div className='flex items-center gap-2'>
								<KodiaPrimaryButton onClick={() => void handleLaunchFactory()} disabled={!objective.trim()} className='!text-[11px] !py-1.5'>
									<Rocket size={12} />
									<span>Launch Autonomous Build</span>
								</KodiaPrimaryButton>
							</div>
						</KodiaCard>

						{state.latestFactoryBlueprint && (
							<KodiaCard className='!p-3 flex flex-col gap-2'>
								<div className='flex items-center justify-between gap-2'>
									<span className='text-xs font-semibold truncate'>Active Blueprint ({state.latestFactoryBlueprint.id})</span>
									<KodiaBadge>{state.latestFactoryBlueprint.routing.engineMode}</KodiaBadge>
								</div>
								<div className='text-[11px] text-void-fg-2'>{state.latestFactoryBlueprint.objective}</div>
								<div className='flex flex-col gap-1 pt-1'>
									{state.latestFactoryBlueprint.phases.map(p => (
										<div key={p.phaseNumber} className='text-[10px] px-2 py-1 rounded bg-void-bg-1 border border-void-border-2 flex items-center justify-between gap-2'>
											<span className='font-medium text-void-fg-1'>{p.phaseNumber}. {p.name}</span>
											<span className='text-void-fg-3'>{p.ownerEngine}</span>
										</div>
									))}
								</div>
							</KodiaCard>
						)}
					</>
				)}

				{tab === 'hardware' && (
					<>
						<div className='flex items-center justify-between gap-2'>
							<span className='text-xs font-semibold'>Host Compute, GPUs & AI Runtimes</span>
							<KodiaPrimaryButton onClick={() => void handleProbeHardware()} disabled={probingHw || !aiMain} className='!text-[11px] !py-1 !px-2.5'>
								<Cpu size={12} />
								<span>{probingHw ? 'Probing…' : 'Probe Hardware'}</span>
							</KodiaPrimaryButton>
						</div>
						{state.latestHardware ? (
							<KodiaCard className='!p-3 flex flex-col gap-2'>
								<div className='flex items-center justify-between'>
									<span className='text-xs font-semibold'>{state.latestHardware.platform}/{state.latestHardware.arch}</span>
									<KodiaBadge tone='accent'>{state.latestHardware.recommendedComputeTier}</KodiaBadge>
								</div>
								<div className='text-[11px] text-void-fg-2'>
									{state.latestHardware.cpuCount} CPUs ({state.latestHardware.cpuModel}) · {state.latestHardware.freeMemoryGb}/{state.latestHardware.totalMemoryGb} GB RAM free
								</div>
								<div className='text-[11px] text-void-fg-2'>
									GPUs: {state.latestHardware.gpus.length > 0 ? state.latestHardware.gpus.map(g => `${g.name}${g.vramMb ? ` (${Math.round(g.vramMb / 1024)} GB)` : ''}`).join(', ') : 'CPU-only (no CUDA/MPS detected)'}
								</div>
								<div className='flex flex-wrap gap-1 pt-1'>
									{state.latestHardware.runtimes.filter(r => r.available).map(r => (
										<span key={r.name} className='text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'>
											{r.name}
										</span>
									))}
								</div>
							</KodiaCard>
						) : (
							<KodiaEmptyState
								icon={<Cpu size={18} />}
								title='Hardware Not Probed Yet'
								description='Click "Probe Hardware" to inspect real CPUs, NVIDIA/Apple GPUs, Docker, Ollama, and installed Python AI libraries.'
							/>
						)}
					</>
				)}

				{tab === 'rag' && (
					<>
						<KodiaCard className='!p-3 flex flex-col gap-2'>
							<span className='text-xs font-semibold'>Hybrid BM25 + Vector RAG Console</span>
							<div className='flex items-center gap-1.5'>
								<input
									value={ragIndexName}
									onChange={e => setRagIndexName(e.target.value)}
									placeholder='Index name (e.g. workspace-docs)'
									className='flex-1 px-2 py-1 text-xs rounded bg-void-bg-1 border border-void-border-2 text-void-fg-1'
								/>
								<KodiaPrimaryButton onClick={() => void handleBuildRag()} disabled={ragBusy || !aiMain || !workspaceRoot} className='!text-[11px] !py-1'>
									<span>{ragBusy ? 'Indexing…' : 'Build Index'}</span>
								</KodiaPrimaryButton>
							</div>
							<div className='flex items-center gap-1.5'>
								<input
									value={ragQueryText}
									onChange={e => setRagQueryText(e.target.value)}
									onKeyDown={e => { if (e.key === 'Enter') { void handleQueryRag(); } }}
									placeholder='Query grounded workspace knowledge…'
									className='flex-1 px-2 py-1 text-xs rounded bg-void-bg-1 border border-void-border-2 text-void-fg-1'
								/>
								<KodiaSecondaryButton onClick={() => void handleQueryRag()} disabled={ragBusy || !ragQueryText.trim()} className='!text-[11px] !py-1'>
									<Search size={11} />
									<span>Query</span>
								</KodiaSecondaryButton>
							</div>
							{state.ragIndexes.length > 0 && (
								<div className='flex flex-wrap gap-1 pt-1'>
									{state.ragIndexes.map(ix => (
										<button
											key={ix.indexName}
											type='button'
											onClick={() => setRagIndexName(ix.indexName)}
											className='text-[10px] px-2 py-0.5 rounded bg-void-bg-1 border border-void-border-2 text-void-fg-2 cursor-pointer'
										>
											{ix.indexName} ({ix.documentCount} docs · {ix.chunkCount} chunks)
										</button>
									))}
								</div>
							)}
							{ragResult && (
								<div className='flex flex-col gap-1.5 pt-1'>
									{ragResult.error ? (
										<div className='text-[11px] text-amber-400'>{ragResult.error}</div>
									) : ragResult.results.length === 0 ? (
										<div className='text-[11px] text-void-fg-3'>No matching chunks found.</div>
									) : ragResult.results.map(r => (
										<div key={r.chunkId} className='p-2 rounded bg-void-bg-1 border border-void-border-2 flex flex-col gap-1'>
											<div className='flex items-center justify-between text-[10px]'>
												<span className='font-mono text-void-fg-1 truncate'>{r.citation}</span>
												<span className='text-emerald-400 font-mono'>{r.hybridScore}</span>
											</div>
											<p className='text-[10px] text-void-fg-3 line-clamp-3 whitespace-pre-wrap'>{r.text}</p>
										</div>
									))}
								</div>
							)}
						</KodiaCard>

						<KodiaCard className='!p-3 flex flex-col gap-2'>
							<span className='text-xs font-semibold'>Real Dataset Profiler (CSV / TSV / JSON / JSONL)</span>
							<div className='flex items-center gap-1.5'>
								<input
									value={datasetPath}
									onChange={e => setDatasetPath(e.target.value)}
									placeholder='e.g. data/train.csv'
									className='flex-1 px-2 py-1 text-xs rounded bg-void-bg-1 border border-void-border-2 text-void-fg-1'
								/>
								<KodiaSecondaryButton onClick={() => void handleProfileDataset()} disabled={datasetBusy || !datasetPath.trim()} className='!text-[11px] !py-1'>
									<span>{datasetBusy ? 'Profiling…' : 'Profile'}</span>
								</KodiaSecondaryButton>
							</div>
							{state.latestDatasetProfile && (
								<div className='p-2 rounded bg-void-bg-1 border border-void-border-2 text-[11px] flex flex-col gap-1'>
									{state.latestDatasetProfile.error ? (
										<span className='text-amber-400'>{state.latestDatasetProfile.error}</span>
									) : (
										<>
											<div className='flex items-center justify-between'>
												<span className='font-medium'>{state.latestDatasetProfile.datasetPath}</span>
												<KodiaBadge tone={state.latestDatasetProfile.qualityScore >= 80 ? 'success' : 'warning'}>
													Score {state.latestDatasetProfile.qualityScore}/100
												</KodiaBadge>
											</div>
											<div className='text-[10px] text-void-fg-3'>
												{state.latestDatasetProfile.rowCount} rows · {state.latestDatasetProfile.columnCount} cols · {state.latestDatasetProfile.duplicateRowCount} dupes · SHA {state.latestDatasetProfile.sha256Fingerprint.slice(0, 12)}
											</div>
										</>
									)}
								</div>
							)}
						</KodiaCard>
					</>
				)}

				{tab === 'registry' && (
					<>
						<div className='text-[10px] font-semibold uppercase tracking-wider text-void-fg-3'>
							Model Registry ({state.models.length})
						</div>
						{state.models.length === 0 ? (
							<KodiaEmptyState
								icon={<FlaskConical size={18} />}
								title='No Registered Models Yet'
								description='Models registered via ai_model_registry appear here with disk artifact verification, lineage, and stage promotion.'
							/>
						) : state.models.map(m => (
							<KodiaCard key={m.id} className='!p-2.5 flex flex-col gap-1.5'>
								<div className='flex items-center justify-between gap-2'>
									<span className='text-xs font-semibold'>{m.id} · {m.name} v{m.version}</span>
									<KodiaBadge tone={m.stage === 'production' ? 'success' : 'accent'}>{m.stage}</KodiaBadge>
								</div>
								<div className='text-[10px] text-void-fg-3'>
									{m.framework} · {m.taskType}{m.artifactPath ? ` · artifact ${m.artifactVerifiedOnDisk ? 'verified' : 'missing'}` : ''}
								</div>
								<div className='flex items-center gap-1.5 pt-0.5'>
									{(['staging', 'production'] as const).map(st => (
										<button
											key={st}
											type='button'
											onClick={() => void handlePromoteModel(m.id, st)}
											disabled={m.stage === st}
											className='text-[10px] px-2 py-0.5 rounded bg-void-bg-1 border border-void-border-2 text-void-fg-2 hover:text-void-fg-1 disabled:opacity-40 cursor-pointer'
										>
											Promote → {st}
										</button>
									))}
								</div>
							</KodiaCard>
						))}

						<div className='text-[10px] font-semibold uppercase tracking-wider text-void-fg-3 pt-1'>
							Tracked Experiments ({state.experiments.length})
						</div>
						{state.experiments.slice(0, 8).map(e => (
							<KodiaCard key={e.id} className='!p-2.5 flex flex-col gap-1'>
								<div className='flex items-center justify-between'>
									<span className='text-xs font-medium'>{e.id} · {e.name}</span>
									<KodiaBadge>{e.status}</KodiaBadge>
								</div>
								<div className='text-[10px] font-mono text-void-fg-3'>{e.modelRef} · {JSON.stringify(e.metrics)}</div>
							</KodiaCard>
						))}
					</>
				)}

				{tab === 'security' && (
					<>
						<div className='flex flex-wrap gap-1.5'>
							<KodiaPrimaryButton
								onClick={() => onSendPrompt?.('Run ai_audit_security and ai_check_provider_capabilities across this workspace, then report concrete remediations.')}
								className='!text-[11px] !py-1 !px-2.5'
							>
								<ShieldCheck size={12} />
								<span>Run AI Security Audit</span>
							</KodiaPrimaryButton>
						</div>
						{state.latestSecurityAudit && (
							<KodiaCard className='!p-3 flex flex-col gap-1.5'>
								<div className='flex items-center justify-between'>
									<span className='text-xs font-semibold'>AI Security & Governance</span>
									<KodiaBadge tone={state.latestSecurityAudit.score >= 85 ? 'success' : 'warning'}>
										{state.latestSecurityAudit.score}/100
									</KodiaBadge>
								</div>
								<p className='text-[11px] text-void-fg-3'>{state.latestSecurityAudit.summary}</p>
							</KodiaCard>
						)}
						<div className='text-[10px] font-semibold uppercase tracking-wider text-void-fg-3'>
							Quantitative Evaluations ({state.evaluations.length})
						</div>
						{state.evaluations.length === 0 ? (
							<KodiaEmptyState
								icon={<Activity size={18} />}
								title='No AI Evaluations Recorded'
								description='Run ai_evaluate_system or ai_rag_evaluate to capture quantitative F1, MAE/R², Recall@K, MRR, and Agent Task Completion scorecards.'
							/>
						) : state.evaluations.slice(0, 10).map(ev => (
							<KodiaCard key={ev.id} className='!p-2.5 flex flex-col gap-1'>
								<div className='flex items-center justify-between'>
									<span className='text-xs font-medium'>{ev.name} ({ev.taskType})</span>
									<KodiaBadge tone={ev.passed ? 'success' : 'warning'}>{ev.passed ? 'PASSED' : 'FAILED'}</KodiaBadge>
								</div>
								<div className='text-[10px] font-mono text-void-fg-3'>{JSON.stringify(ev.metrics)}</div>
							</KodiaCard>
						))}
					</>
				)}

				{tab === 'future' && (
					<>
						<input
							value={capQuery}
							onChange={e => setCapQuery(e.target.value)}
							placeholder='Search AI capabilities (RAG, ONNX, MCP, Mamba, World Models…)…'
							className='w-full px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1 placeholder:text-void-fg-3'
						/>
						<div className='flex flex-col gap-2'>
							{capabilities.map(c => (
								<KodiaCard key={c.id} className='!p-2.5 flex flex-col gap-1'>
									<div className='flex items-center justify-between gap-2'>
										<span className='text-xs font-semibold'>{c.name}</span>
										<KodiaBadge tone={c.integrationStatus === 'built-in' ? 'success' : c.maturity === 'emerging' ? 'accent' : 'neutral'}>
											{c.maturity} · {c.integrationStatus}
										</KodiaBadge>
									</div>
									<p className='text-[11px] text-void-fg-2 leading-relaxed'>{c.summary}</p>
									<p className='text-[10px] text-void-fg-3'>Security: {c.securityImplications}</p>
								</KodiaCard>
							))}
						</div>
						{state.workflows.length > 0 && (
							<div className='flex flex-col gap-1.5 pt-2'>
								<div className='text-[10px] font-semibold uppercase tracking-wider text-void-fg-3'>
									Saved AI Workflows ({state.workflows.length})
								</div>
								{state.workflows.map(wf => (
									<KodiaCard key={wf.id} className='!p-2.5 flex items-center justify-between gap-2'>
										<div className='min-w-0'>
											<div className='text-xs font-medium truncate'>{wf.name}</div>
											<div className='text-[10px] text-void-fg-3'>{wf.trigger} · {wf.steps.length} steps</div>
										</div>
										<KodiaSecondaryButton
											onClick={() => onSendPrompt?.(`Run ai_run_workflow for workflow_id="${wf.id}" and report step traces.`)}
											className='!text-[10px] !py-1 !px-2'
										>
											<Play size={10} />
											<span>Run</span>
										</KodiaSecondaryButton>
									</KodiaCard>
								))}
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
};
