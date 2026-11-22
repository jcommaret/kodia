/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
	AlertTriangle,
	CheckCircle2,
	ExternalLink,
	GitBranch,
	Layers,
	Network,
	RefreshCw,
	Search,
	ShieldCheck,
	Sparkles,
	Trash2,
	Wrench,
	XCircle,
} from 'lucide-react';
import { URI } from '../../../../../../../base/common/uri.js';
import { useAccessor } from '../util/services.js';
import {
	analyzeProjectHealth,
	analyzeTechnicalDebt,
	ArchitectureMapReport,
	buildArchitectureMap,
	computeEngineeringQualityScore,
	EngineeringQualityScore,
	ProjectHealthReport,
	TechnicalDebtItem,
} from '../../../../common/projectHealth.js';
import {
	analyzeChangeImpact,
	buildProjectDigitalTwin,
	ChangeImpactReport,
	ProjectDigitalTwin,
	queryKnowledgeGraph,
} from '../../../../common/digitalTwin.js';
import {
	QualityGateEvaluation,
	VERIFICATION_LEVEL_LABELS,
	VerificationRecord,
} from '../../../../common/verificationLedger.js';
import { collectWorkspaceProjectFiles } from '../../../projectHealthScanner.js';
import { KodiaBadge, KodiaCard, KodiaEmptyState, KodiaPrimaryButton, KodiaSecondaryButton } from '../util/KodiaDesignSystem.js';

type IntelSubTab = 'overview' | 'twin' | 'proof' | 'debt';

export const ProjectHealthPanel = ({ onSendPrompt }: { onSendPrompt?: (prompt: string) => void }) => {
	const accessor = useAccessor();
	const fileService = accessor.get('IFileService');
	const workspaceService = accessor.get('IWorkspaceContextService');
	const commandService = accessor.get('ICommandService');
	const ledgerService = accessor.get('IVerificationLedgerService');

	const workspaceRootUri = workspaceService.getWorkspace().folders[0]?.uri;

	const [subTab, setSubTab] = useState<IntelSubTab>('overview');
	const [scanning, setScanning] = useState(false);
	const [scanError, setScanError] = useState<string | null>(null);
	const [health, setHealth] = useState<ProjectHealthReport | null>(null);
	const [arch, setArch] = useState<ArchitectureMapReport | null>(null);
	const [quality, setQuality] = useState<EngineeringQualityScore | null>(null);
	const [twin, setTwin] = useState<ProjectDigitalTwin | null>(null);
	const [debtItems, setDebtItems] = useState<TechnicalDebtItem[]>([]);

	// Digital Twin interactive explorer state
	const [graphQuery, setGraphQuery] = useState('');
	const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
	const [impactReport, setImpactReport] = useState<ChangeImpactReport | null>(null);

	// Verification Ledger & Quality Gates state
	const [records, setRecords] = useState<readonly VerificationRecord[]>(() => ledgerService.getRecords());
	const [lastGateEval, setLastGateEval] = useState<QualityGateEvaluation | null>(() => ledgerService.getLastGateEvaluation());
	const [runningGates, setRunningGates] = useState(false);

	useEffect(() => {
		const sync = () => {
			setRecords([...ledgerService.getRecords()]);
			setLastGateEval(ledgerService.getLastGateEvaluation());
		};
		sync();
		const d = ledgerService.onDidChange(sync);
		return () => d.dispose();
	}, [ledgerService]);

	const openWorkspaceFile = useCallback((relativePath: string) => {
		if (!workspaceRootUri) { return; }
		const clean = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
		const targetUri = URI.joinPath(workspaceRootUri, ...clean.split('/'));
		void commandService.executeCommand('vscode.open', targetUri);
	}, [workspaceRootUri, commandService]);

	const runScan = useCallback(async () => {
		setScanning(true);
		setScanError(null);
		try {
			const files = await collectWorkspaceProjectFiles(fileService, workspaceService, {});
			const nextHealth = analyzeProjectHealth(files);
			const nextArch = buildArchitectureMap(files);
			const nextQuality = computeEngineeringQualityScore(nextHealth, nextArch);
			const nextTwin = buildProjectDigitalTwin(files);
			const nextDebt = analyzeTechnicalDebt(nextHealth, nextArch);
			setHealth(nextHealth);
			setArch(nextArch);
			setQuality(nextQuality);
			setTwin(nextTwin);
			setDebtItems(nextDebt);
			if (nextArch.topHubs.length > 0) {
				const topHub = nextArch.topHubs[0].file;
				setSelectedTarget(topHub);
				setImpactReport(analyzeChangeImpact(nextTwin, topHub));
			}
		} catch (e) {
			setScanError(e instanceof Error ? e.message : String(e));
		} finally {
			setScanning(false);
		}
	}, [fileService, workspaceService]);

	const runGatesNow = useCallback(async () => {
		setRunningGates(true);
		try {
			const { evaluation } = await ledgerService.runWorkspaceQualityGates();
			setLastGateEval(evaluation);
		} finally {
			setRunningGates(false);
		}
	}, [ledgerService]);

	const graphMatches = useMemo(() => {
		if (!twin) { return []; }
		return queryKnowledgeGraph(twin, graphQuery, 24);
	}, [twin, graphQuery]);

	const handleSelectTwinNode = useCallback((nodeId: string) => {
		setSelectedTarget(nodeId);
		if (twin) {
			setImpactReport(analyzeChangeImpact(twin, nodeId));
		}
	}, [twin]);

	const gradeColor = (g: EngineeringQualityScore['grade']) =>
		g === 'A+' || g === 'A' ? 'text-emerald-400' : g === 'B' ? 'text-sky-400' : g === 'C' ? 'text-amber-400' : 'text-rose-400';

	// Interactive SVG hub map (lightweight, zero canvas overhead)
	const svgHubs = useMemo(() => {
		if (!twin) { return []; }
		return [...twin.nodes]
			.sort((a, b) => (b.importedBy.length + b.imports.length) - (a.importedBy.length + a.imports.length))
			.slice(0, 8);
	}, [twin]);

	return (
		<div className='h-full flex flex-col overflow-hidden text-xs'>
			{/* Top Header & Sub-Tabs */}
			<div className='flex flex-col gap-1.5 px-3 py-2 border-b border-void-border-2 bg-void-bg-1 flex-shrink-0'>
				<div className='flex items-center justify-between gap-2'>
					<span className='font-semibold text-void-fg-1 flex items-center gap-1.5'>
						<ShieldCheck size={13} />
						<span>Engineering Intelligence</span>
					</span>
					<KodiaPrimaryButton
						onClick={() => void runScan()}
						disabled={scanning}
						className='!px-2.5 !py-1 !text-[11px]'
					>
						<RefreshCw size={11} className={scanning ? 'animate-spin' : ''} />
						<span>{scanning ? 'Scanning…' : health ? 'Rescan' : 'Scan Workspace'}</span>
					</KodiaPrimaryButton>
				</div>

				<div className='flex items-center gap-1 overflow-x-auto'>
					{([
						{ id: 'overview', label: 'Health & Score', icon: <ShieldCheck size={11} /> },
						{ id: 'twin', label: 'Digital Twin', icon: <Network size={11} /> },
						{ id: 'proof', label: 'Proof & Gates', icon: <CheckCircle2 size={11} />, badge: records.length > 0 ? String(records.length) : undefined },
						{ id: 'debt', label: 'Tech Debt', icon: <Wrench size={11} />, badge: debtItems.length > 0 ? String(debtItems.length) : undefined },
					] as const).map(tab => (
						<button
							key={tab.id}
							type='button'
							onClick={() => setSubTab(tab.id)}
							className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] whitespace-nowrap transition-colors cursor-pointer ${subTab === tab.id
								? 'bg-void-bg-3 text-void-fg-1 font-medium border border-void-border-2'
								: 'text-void-fg-3 hover:text-void-fg-1 hover:bg-void-bg-2 border border-transparent'
								}`}
						>
							{tab.icon}
							<span>{tab.label}</span>
							{'badge' in tab && tab.badge && (
								<span className='text-[9px] px-1 rounded-full bg-void-bg-2 text-void-fg-3 border border-void-border-2'>{tab.badge}</span>
							)}
						</button>
					))}
				</div>
			</div>

			{/* Scrollable Body */}
			<div className='flex-1 overflow-y-auto p-3 flex flex-col gap-3'>
				{scanError && (
					<div className='p-2.5 rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-300 text-[11px]'>{scanError}</div>
				)}

				{subTab !== 'proof' && !health && !scanning && (
					<KodiaEmptyState
						icon={<Layers size={22} />}
						title='Run Workspace Intelligence Scan'
						description='Analyzes live codebase health, secret exposure, Engineering Quality Score, Project Digital Twin, change-impact blast radius, and prioritized technical debt.'
						action={
							<KodiaPrimaryButton onClick={() => void runScan()}>
								<Sparkles size={12} />
								<span>Scan Workspace Now</span>
							</KodiaPrimaryButton>
						}
					/>
				)}

				{/* SUBTAB 1: OVERVIEW & QUALITY SCORE */}
				{subTab === 'overview' && health && quality && (
					<>
						<KodiaCard className='flex flex-col gap-2.5'>
							<div className='flex items-center justify-between gap-2'>
								<div>
									<div className='text-[11px] text-void-fg-3'>Engineering Quality Score</div>
									<div className='flex items-baseline gap-2 mt-0.5'>
										<span className={`text-2xl font-bold ${gradeColor(quality.grade)}`}>{quality.grade}</span>
										<span className='text-sm font-semibold text-void-fg-1'>{quality.score}/100</span>
									</div>
								</div>
								<div className='text-right text-[10px] text-void-fg-3'>
									<div>{health.scannedFiles} files scanned</div>
									<div>{health.totalLines.toLocaleString()} lines</div>
								</div>
							</div>
							<div className='grid grid-cols-3 gap-2'>
								{[
									{ label: 'Security', val: quality.securityScore },
									{ label: 'Architecture', val: quality.architectureScore },
									{ label: 'Maintainability', val: quality.maintainabilityScore },
								].map(m => (
									<div key={m.label} className='p-2 rounded bg-void-bg-1 border border-void-border-2'>
										<div className='text-[10px] text-void-fg-3'>{m.label}</div>
										<div className='text-xs font-semibold text-void-fg-1 mt-0.5'>{m.val}/100</div>
									</div>
								))}
							</div>
							<div className='text-[11px] text-void-fg-3'>{quality.summary}</div>
						</KodiaCard>

						<KodiaCard className='flex flex-col gap-2'>
							<div className='font-semibold text-void-fg-1'>Detected Stack</div>
							<div className='flex flex-wrap gap-1'>
								{health.stack.languages.map(l => <KodiaBadge key={`lang-${l}`} tone='accent'>{l}</KodiaBadge>)}
								{health.stack.frameworks.map(f => <KodiaBadge key={`fw-${f}`} tone='success'>{f}</KodiaBadge>)}
								{health.stack.testFrameworks.map(t => <KodiaBadge key={`tf-${t}`} tone='neutral'>{t}</KodiaBadge>)}
							</div>
						</KodiaCard>

						<KodiaCard className='flex flex-col gap-2'>
							<div className='flex items-center justify-between'>
								<span className='font-semibold text-void-fg-1'>Security & Code Findings</span>
								<div className='flex items-center gap-1'>
									{health.counts.critical > 0 && <KodiaBadge tone='danger'>{health.counts.critical} crit</KodiaBadge>}
									{health.counts.high > 0 && <KodiaBadge tone='warning'>{health.counts.high} high</KodiaBadge>}
									<KodiaBadge tone='neutral'>{health.findings.length} total</KodiaBadge>
								</div>
							</div>
							{health.findings.length === 0 ? (
								<div className='text-[11px] text-emerald-400 flex items-center gap-1.5'>
									<CheckCircle2 size={13} />
									<span>No hardcoded secrets or static security issues detected.</span>
								</div>
							) : (
								<div className='flex flex-col gap-1.5 max-h-64 overflow-y-auto'>
									{health.findings.slice(0, 20).map((f, idx) => (
										<div key={`${f.file}-${f.line}-${idx}`} className='p-2 rounded bg-void-bg-1 border border-void-border-2 flex flex-col gap-1'>
											<div className='flex items-center justify-between gap-2'>
												<button
													type='button'
													onClick={() => openWorkspaceFile(f.file)}
													className='text-[11px] font-mono text-blue-400 hover:underline truncate text-left flex items-center gap-1 cursor-pointer'
													title={`Open ${f.file}`}
												>
													<span>{f.file}:{f.line}</span>
													<ExternalLink size={10} />
												</button>
												<KodiaBadge tone={f.severity === 'critical' ? 'danger' : f.severity === 'high' ? 'warning' : 'neutral'}>
													{f.severity}
												</KodiaBadge>
											</div>
											<div className='text-[11px] text-void-fg-2'>{f.message}</div>
											{onSendPrompt && (
												<button
													type='button'
													onClick={() => onSendPrompt(`Fix the ${f.severity} finding (${f.rule}) at ${f.file}:${f.line}: ${f.message}. Verify the fix.`)}
													className='text-[10px] text-blue-400 hover:underline w-fit cursor-pointer'
												>
													Fix with Kodia →
												</button>
											)}
										</div>
									))}
								</div>
							)}
						</KodiaCard>
					</>
				)}

				{/* SUBTAB 2: PROJECT DIGITAL TWIN & BLAST RADIUS */}
				{subTab === 'twin' && twin && (
					<>
						<div className='grid grid-cols-2 sm:grid-cols-4 gap-2'>
							<KodiaCard className='!p-2.5'>
								<div className='text-[10px] text-void-fg-3'>Modules</div>
								<div className='text-sm font-semibold text-void-fg-1'>{twin.nodes.length}</div>
							</KodiaCard>
							<KodiaCard className='!p-2.5'>
								<div className='text-[10px] text-void-fg-3'>Symbols</div>
								<div className='text-sm font-semibold text-void-fg-1'>{twin.totalSymbols}</div>
							</KodiaCard>
							<KodiaCard className='!p-2.5'>
								<div className='text-[10px] text-void-fg-3'>APIs / DBs</div>
								<div className='text-sm font-semibold text-void-fg-1'>{twin.totalApis} / {twin.totalDbEntities}</div>
							</KodiaCard>
							<KodiaCard className='!p-2.5'>
								<div className='text-[10px] text-void-fg-3'>Untested</div>
								<div className='text-sm font-semibold text-amber-400'>{twin.untestedModules.length}</div>
							</KodiaCard>
						</div>

						{/* Interactive SVG Hub Architecture Map */}
						{svgHubs.length > 0 && (
							<KodiaCard className='!p-2.5'>
								<div className='flex items-center justify-between mb-1.5'>
									<span className='font-semibold text-void-fg-1 flex items-center gap-1'>
										<GitBranch size={12} />
										<span>Interactive Core Hub Graph (click a node)</span>
									</span>
									{arch && <KodiaBadge tone={arch.cycles.length > 0 ? 'warning' : 'success'}>{arch.cycles.length} cycles</KodiaBadge>}
								</div>
								<svg viewBox='0 0 360 150' className='w-full h-36 rounded bg-void-bg-1 border border-void-border-2'>
									{svgHubs.map((node, i) => {
										const angle = (i / svgHubs.length) * Math.PI * 2 - Math.PI / 2;
										const cx = 180 + Math.cos(angle) * 120;
										const cy = 75 + Math.sin(angle) * 52;
										return node.imports.map(imp => {
											const targetIdx = svgHubs.findIndex(h => h.id === imp);
											if (targetIdx < 0 || targetIdx === i) { return null; }
											const tAngle = (targetIdx / svgHubs.length) * Math.PI * 2 - Math.PI / 2;
											const tx = 180 + Math.cos(tAngle) * 120;
											const ty = 75 + Math.sin(tAngle) * 52;
											return (
												<line
													key={`${node.id}->${imp}`}
													x1={cx} y1={cy} x2={tx} y2={ty}
													stroke='var(--void-border-1)'
													strokeOpacity={0.55}
													strokeWidth={1.2}
												/>
											);
										});
									})}
									{svgHubs.map((node, i) => {
										const angle = (i / svgHubs.length) * Math.PI * 2 - Math.PI / 2;
										const cx = 180 + Math.cos(angle) * 120;
										const cy = 75 + Math.sin(angle) * 52;
										const selected = selectedTarget === node.id;
										return (
											<g
												key={node.id}
												onClick={() => handleSelectTwinNode(node.id)}
												style={{ cursor: 'pointer' }}
											>
												<circle
													cx={cx}
													cy={cy}
													r={selected ? 11 : 8}
													fill={selected ? 'var(--kodia-accent)' : 'var(--void-bg-3)'}
													stroke='var(--kodia-accent)'
													strokeWidth={selected ? 2 : 1.2}
												/>
												<text
													x={cx}
													y={cy + 20}
													textAnchor='middle'
													fill='var(--void-fg-2)'
													fontSize='8'
													fontFamily='monospace'
												>
													{node.label.slice(0, 14)}
												</text>
											</g>
										);
									})}
								</svg>
							</KodiaCard>
						)}

						{/* Selected Node Change-Impact Blast Radius */}
						{impactReport && impactReport.found && (
							<KodiaCard className='!p-3 flex flex-col gap-2'>
								<div className='flex items-center justify-between gap-2'>
									<button
										type='button'
										onClick={() => openWorkspaceFile(impactReport.target)}
										className='font-mono text-[11px] font-semibold text-blue-400 hover:underline truncate flex items-center gap-1 cursor-pointer'
									>
										<span>Impact: {impactReport.target}</span>
										<ExternalLink size={10} />
									</button>
									<KodiaBadge tone={impactReport.riskLevel === 'critical' || impactReport.riskLevel === 'high' ? 'danger' : impactReport.riskLevel === 'medium' ? 'warning' : 'success'}>
										{impactReport.riskLevel.toUpperCase()} RISK
									</KodiaBadge>
								</div>
								<div className='text-[11px] text-void-fg-3'>
									Direct dependents: <strong className='text-void-fg-1'>{impactReport.directDependents.length}</strong> · Transitive blast radius: <strong className='text-void-fg-1'>{impactReport.transitiveDependents.length}</strong> · Related tests: <strong className='text-void-fg-1'>{impactReport.affectedTests.length}</strong>
								</div>
								{impactReport.directDependents.length > 0 && (
									<div className='flex flex-wrap gap-1'>
										{impactReport.directDependents.slice(0, 8).map(dep => (
											<button
												key={dep}
												type='button'
												onClick={() => openWorkspaceFile(dep)}
												className='px-1.5 py-0.5 rounded bg-void-bg-1 border border-void-border-2 text-[10px] font-mono text-void-fg-2 hover:text-void-fg-1 cursor-pointer'
											>
												{dep}
											</button>
										))}
									</div>
								)}
								{onSendPrompt && (
									<div className='flex flex-wrap gap-2 pt-1'>
										<KodiaSecondaryButton
											className='!py-1 !px-2 !text-[10px]'
											onClick={() => onSendPrompt(`Analyze the change impact and dependency coupling of ${impactReport.target} (blast radius: ${impactReport.transitiveDependents.length} modules) and recommend safe refactoring or missing tests.`)}
										>
											Analyze Impact in Chat
										</KodiaSecondaryButton>
									</div>
								)}
							</KodiaCard>
						)}

						{/* Searchable Knowledge Graph Node List */}
						<div className='flex flex-col gap-1.5'>
							<div className='relative'>
								<Search size={12} className='absolute left-2.5 top-1/2 -translate-y-1/2 text-void-fg-3 pointer-events-none' />
								<input
									type='text'
									value={graphQuery}
									onChange={e => setGraphQuery(e.target.value)}
									placeholder='Search modules, symbols, API routes, DB tables…'
									className='w-full pl-7 pr-2.5 py-1.5 rounded-md bg-void-bg-1 border border-void-border-2 text-[11px] text-void-fg-1 placeholder:text-void-fg-3'
								/>
							</div>
							<div className='flex flex-col gap-1 max-h-56 overflow-y-auto'>
								{graphMatches.map(node => (
									<div
										key={node.id}
										onClick={() => handleSelectTwinNode(node.id)}
										className={`p-2 rounded border flex items-center justify-between gap-2 cursor-pointer transition-colors ${selectedTarget === node.id
											? 'bg-void-bg-3 border-[var(--kodia-accent)]'
											: 'bg-void-bg-1 border-void-border-2 hover:border-void-border-1'
											}`}
									>
										<div className='min-w-0'>
											<div className='font-mono text-[11px] text-void-fg-1 truncate'>{node.id}</div>
											<div className='text-[10px] text-void-fg-3 truncate'>
												{node.exportedSymbols.length} exports · in:{node.importedBy.length} · out:{node.imports.length} · tests:{node.relatedTests.length}
											</div>
										</div>
										<button
											type='button'
											onClick={e => { e.stopPropagation(); openWorkspaceFile(node.id); }}
											className='p-1 rounded text-void-fg-3 hover:text-void-fg-1 hover:bg-void-bg-2 cursor-pointer shrink-0'
											title='Open file in editor'
										>
											<ExternalLink size={11} />
										</button>
									</div>
								))}
							</div>
						</div>
					</>
				)}

				{/* SUBTAB 3: PROOF-CARRYING CODE & AUTONOMOUS QUALITY GATES */}
				{subTab === 'proof' && (
					<>
						<KodiaCard className='flex flex-col gap-2.5'>
							<div className='flex items-center justify-between gap-2'>
								<div>
									<div className='font-semibold text-void-fg-1'>Autonomous Quality Gates</div>
									<div className='text-[10px] text-void-fg-3'>Live security, compiler diagnostics, architecture & score checks</div>
								</div>
								<KodiaPrimaryButton
									onClick={() => void runGatesNow()}
									disabled={runningGates}
									className='!px-2.5 !py-1 !text-[11px]'
								>
									<RefreshCw size={11} className={runningGates ? 'animate-spin' : ''} />
									<span>{runningGates ? 'Checking…' : 'Run Gates Now'}</span>
								</KodiaPrimaryButton>
							</div>

							{lastGateEval && (
								<div className='flex flex-col gap-1.5'>
									<div className='flex items-center justify-between text-[11px]'>
										<KodiaBadge tone={lastGateEval.passed ? 'success' : 'danger'}>
											{lastGateEval.passed ? 'ALL GATES PASSED' : 'GATES FAILED'}
										</KodiaBadge>
										<span className='text-[10px] text-void-fg-3'>{new Date(lastGateEval.evaluatedAt).toLocaleTimeString()}</span>
									</div>
									{lastGateEval.gates.map(g => (
										<div key={g.id} className='flex items-center justify-between px-2 py-1.5 rounded bg-void-bg-1 border border-void-border-2 text-[11px]'>
											<span className='flex items-center gap-1.5 text-void-fg-1'>
												{g.passed ? <CheckCircle2 size={12} className='text-emerald-400' /> : <XCircle size={12} className='text-rose-400' />}
												<span>{g.label}</span>
											</span>
											<span className='font-mono text-[10px] text-void-fg-3'>{g.actual} ({g.threshold})</span>
										</div>
									))}
								</div>
							)}
						</KodiaCard>

						<div className='flex items-center justify-between'>
							<span className='font-semibold text-void-fg-1'>Verification Ledger ({records.length})</span>
							{records.length > 0 && (
								<button
									type='button'
									onClick={() => ledgerService.clearRecords()}
									className='text-[10px] text-void-fg-3 hover:text-rose-400 flex items-center gap-1 cursor-pointer'
								>
									<Trash2 size={10} />
									<span>Clear</span>
								</button>
							)}
						</div>

						{records.length === 0 ? (
							<KodiaEmptyState
								icon={<CheckCircle2 size={20} />}
								title='No Verification Records Yet'
								description='Click "Run Gates Now" above or let Kodia agents record proof via record_verification_evidence and evaluate_quality_gates.'
							/>
						) : (
							<div className='flex flex-col gap-2'>
								{records.map(rec => (
									<KodiaCard key={rec.id} className='!p-2.5 flex flex-col gap-1.5'>
										<div className='flex items-center justify-between gap-2'>
											<span className='font-semibold text-void-fg-1 truncate'>{rec.taskTitle}</span>
											<KodiaBadge tone={rec.passed ? 'success' : 'danger'}>
												{rec.passed ? 'VERIFIED' : 'FAILED'}
											</KodiaBadge>
										</div>
										<div className='flex items-center justify-between text-[10px] text-void-fg-3'>
											<span>Level: <strong className='text-void-fg-2'>{VERIFICATION_LEVEL_LABELS[rec.highestLevel]}</strong></span>
											<span>{new Date(rec.createdAt).toLocaleString()}</span>
										</div>
										<div className='text-[11px] text-void-fg-2'>{rec.summary}</div>
										<div className='flex flex-col gap-1 pt-1 border-t border-void-border-3'>
											{rec.checks.map((c, idx) => (
												<div key={idx} className='text-[10px] flex items-start gap-1.5 text-void-fg-3'>
													{c.passed ? <CheckCircle2 size={11} className='text-emerald-400 shrink-0 mt-0.5' /> : <AlertTriangle size={11} className='text-rose-400 shrink-0 mt-0.5' />}
													<span><strong className='text-void-fg-2'>{c.name}:</strong> {c.detail}</span>
												</div>
											))}
										</div>
									</KodiaCard>
								))}
							</div>
						)}
					</>
				)}

				{/* SUBTAB 4: TECHNICAL DEBT ELIMINATION */}
				{subTab === 'debt' && health && (
					<>
						{debtItems.length === 0 ? (
							<KodiaEmptyState
								icon={<CheckCircle2 size={20} />}
								title='Low Technical Debt'
								description='No high-priority security hotspots, oversized modules, or circular dependency cycles were flagged.'
							/>
						) : (
							<div className='flex flex-col gap-2'>
								{debtItems.map((item: TechnicalDebtItem) => (
									<KodiaCard key={item.id} className='!p-2.5 flex flex-col gap-1.5'>
										<div className='flex items-center justify-between gap-2'>
											<span className='font-semibold text-void-fg-1 truncate'>{item.title}</span>
											<div className='flex items-center gap-1 shrink-0'>
												<KodiaBadge tone={item.severity === 'high' ? 'danger' : item.severity === 'medium' ? 'warning' : 'neutral'}>
													{item.severity}
												</KodiaBadge>
												<KodiaBadge tone='neutral'>{item.effort}</KodiaBadge>
											</div>
										</div>
										<div className='text-[11px] text-void-fg-3 break-words'>{item.detail}</div>
										<div className='flex items-center gap-2 pt-1'>
											{item.file && (
												<KodiaSecondaryButton className='!py-0.5 !px-2 !text-[10px]' onClick={() => openWorkspaceFile(item.file!)}>
													<ExternalLink size={10} />
													<span>Open File</span>
												</KodiaSecondaryButton>
											)}
											{onSendPrompt && (
												<KodiaPrimaryButton className='!py-0.5 !px-2 !text-[10px]' onClick={() => onSendPrompt(item.suggestedPrompt)}>
													<Sparkles size={10} />
													<span>Fix with Kodia</span>
												</KodiaPrimaryButton>
											)}
										</div>
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
