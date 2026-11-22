/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';
import {
	CheckCircle2,
	Factory,
	FileText,
	ListChecks,
	Play,
	Plus,
	Rocket,
	Scale,
	Sparkles,
	Trash2,
} from 'lucide-react';
import { useAccessor } from '../util/services.js';
import {
	ArchitectureDecisionRecord,
	AutopilotObjective,
	computeRequirementCoverage,
	FACTORY_PROJECT_PROFILES,
	FactoryProjectProfileId,
	ProjectRequirement,
	RequirementStatus,
} from '../../../../common/softwareFactory.js';
import { KodiaBadge, KodiaCard, KodiaEmptyState, KodiaPrimaryButton, KodiaSecondaryButton } from '../util/KodiaDesignSystem.js';

type FactorySubTab = 'build' | 'requirements' | 'autopilot' | 'council';

const STATUS_CYCLE: readonly RequirementStatus[] = ['unstarted', 'in_progress', 'implemented', 'verified'];

export const FactoryPanel = ({ onOpenChat }: { onOpenChat?: () => void }) => {
	const accessor = useAccessor();
	const factoryService = accessor.get('ISoftwareFactoryService');
	const chatThreadService = accessor.get('IChatThreadService');

	const [subTab, setSubTab] = useState<FactorySubTab>('build');

	// Reactive state from ISoftwareFactoryService
	const [requirements, setRequirements] = useState<readonly ProjectRequirement[]>(() => factoryService.getRequirements());
	const [objectives, setObjectives] = useState<readonly AutopilotObjective[]>(() => factoryService.getAutopilotObjectives());
	const [decisions, setDecisions] = useState<readonly ArchitectureDecisionRecord[]>(() => factoryService.getDecisions());

	useEffect(() => {
		const sync = () => {
			setRequirements([...factoryService.getRequirements()]);
			setObjectives([...factoryService.getAutopilotObjectives()]);
			setDecisions([...factoryService.getDecisions()]);
		};
		sync();
		const d = factoryService.onDidChange(sync);
		return () => d.dispose();
	}, [factoryService]);

	// Idea -> App form state
	const [idea, setIdea] = useState('');
	const [profileId, setProfileId] = useState<FactoryProjectProfileId>('web-app');

	// New requirement form
	const [reqTitle, setReqTitle] = useState('');
	const [reqDesc, setReqDesc] = useState('');
	const [reqPriority, setReqPriority] = useState<'high' | 'medium' | 'low'>('high');

	// New autopilot objective form
	const [autoTitle, setAutoTitle] = useState('');
	const [autoInstruction, setAutoInstruction] = useState('');

	// Council & ADR form
	const [councilQuestion, setCouncilQuestion] = useState('');
	const [adrTitle, setAdrTitle] = useState('');
	const [adrDecision, setAdrDecision] = useState('');
	const [adrContext, setAdrContext] = useState('');

	const coverage = computeRequirementCoverage(requirements);

	const sendPrompt = (prompt: string) => {
		const tid = chatThreadService.state.currentThreadId;
		onOpenChat?.();
		if (chatThreadService.streamState[tid]?.isRunning) {
			chatThreadService.enqueueUserMessage(tid, prompt);
		} else {
			void chatThreadService.addUserMessageAndStreamResponse({ userMessage: prompt, threadId: tid });
		}
	};

	const handleLaunchFactory = async () => {
		if (!idea.trim()) { return; }
		await factoryService.launchFactoryBuild(idea, profileId);
		setIdea('');
		onOpenChat?.();
	};

	const handleAddRequirement = () => {
		if (!reqTitle.trim()) { return; }
		factoryService.addRequirement({ title: reqTitle, description: reqDesc || reqTitle, priority: reqPriority });
		setReqTitle('');
		setReqDesc('');
	};

	const handleCycleReqStatus = (req: ProjectRequirement) => {
		const next = STATUS_CYCLE[(STATUS_CYCLE.indexOf(req.status) + 1) % STATUS_CYCLE.length];
		factoryService.updateRequirement(req.id, { status: next });
	};

	const handleAddAutopilot = () => {
		if (!autoTitle.trim() || !autoInstruction.trim()) { return; }
		factoryService.addAutopilotObjective({ title: autoTitle, instruction: autoInstruction });
		setAutoTitle('');
		setAutoInstruction('');
	};

	const handleLaunchCouncil = async () => {
		if (!councilQuestion.trim()) { return; }
		await factoryService.launchModelCouncil(councilQuestion);
		setCouncilQuestion('');
		onOpenChat?.();
	};

	const handleAddAdr = () => {
		if (!adrTitle.trim() || !adrDecision.trim()) { return; }
		factoryService.addDecision({ title: adrTitle, context: adrContext || 'Recorded via Kodia Command Center', decision: adrDecision });
		setAdrTitle('');
		setAdrDecision('');
		setAdrContext('');
	};

	return (
		<div className='h-full flex flex-col overflow-hidden text-xs'>
			{/* Header & Sub-Tabs */}
			<div className='flex flex-col gap-1.5 px-3 py-2 border-b border-void-border-2 bg-void-bg-1 flex-shrink-0'>
				<div className='flex items-center justify-between'>
					<span className='font-semibold text-void-fg-1 flex items-center gap-1.5'>
						<Factory size={13} />
						<span>Autonomous Software Factory</span>
					</span>
					<KodiaBadge tone='accent'>{coverage.percentVerified}% Verified</KodiaBadge>
				</div>

				<div className='flex items-center gap-1 overflow-x-auto'>
					{([
						{ id: 'build', label: 'Idea → App', icon: <Rocket size={11} /> },
						{ id: 'requirements', label: 'Requirements', icon: <ListChecks size={11} />, badge: requirements.length ? String(requirements.length) : undefined },
						{ id: 'autopilot', label: 'Autopilot', icon: <Sparkles size={11} />, badge: objectives.filter(o => o.enabled).length ? String(objectives.filter(o => o.enabled).length) : undefined },
						{ id: 'council', label: 'Council & ADRs', icon: <Scale size={11} />, badge: decisions.length ? String(decisions.length) : undefined },
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

			<div className='flex-1 overflow-y-auto p-3 flex flex-col gap-3'>
				{/* SUBTAB 1: IDEA -> APP SOFTWARE FACTORY */}
				{subTab === 'build' && (
					<>
						<KodiaCard className='flex flex-col gap-2.5'>
							<div className='font-semibold text-void-fg-1'>Describe Your System or Feature</div>
							<textarea
								rows={4}
								value={idea}
								onChange={e => setIdea(e.target.value)}
								placeholder='Example: Build an appointment booking SaaS with customer portal, staff schedule, REST API, SQLite persistence, and automated E2E tests…'
								className='w-full p-2.5 rounded-md bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1 placeholder:text-void-fg-3 resize-y'
							/>

							<div className='text-[11px] font-medium text-void-fg-2'>Project Generation Profile</div>
							<div className='grid grid-cols-1 sm:grid-cols-2 gap-1.5'>
								{FACTORY_PROJECT_PROFILES.map(p => {
									const active = profileId === p.id;
									return (
										<button
											key={p.id}
											type='button'
											onClick={() => setProfileId(p.id)}
											style={active ? { borderColor: 'var(--kodia-accent)' } : undefined}
											className={`text-left p-2 rounded-md border transition-colors cursor-pointer ${active
												? 'bg-void-bg-3 text-void-fg-1'
												: 'bg-void-bg-1 border-void-border-2 text-void-fg-2 hover:border-void-border-1'
												}`}
										>
											<div className='text-[11px] font-semibold'>{p.label}</div>
											<div className='text-[10px] text-void-fg-3 mt-0.5 line-clamp-2'>{p.summary}</div>
										</button>
									);
								})}
							</div>

							<KodiaPrimaryButton
								onClick={() => void handleLaunchFactory()}
								disabled={!idea.trim()}
								className='w-full !py-2'
							>
								<Rocket size={13} />
								<span>Launch Autonomous Software Factory Build</span>
							</KodiaPrimaryButton>
						</KodiaCard>
					</>
				)}

				{/* SUBTAB 2: REQUIREMENTS TRACEABILITY */}
				{subTab === 'requirements' && (
					<>
						<KodiaCard className='flex flex-col gap-2'>
							<div className='flex items-center justify-between text-[11px]'>
								<span className='font-semibold text-void-fg-1'>Requirements Coverage</span>
								<span className='text-void-fg-3'>{coverage.verified}/{coverage.total} verified ({coverage.percentVerified}%)</span>
							</div>
							<div className='h-1.5 w-full rounded-full bg-void-bg-1 overflow-hidden'>
								<div
									style={{ width: `${coverage.percentVerified}%`, backgroundColor: 'var(--kodia-accent)' }}
									className='h-full transition-all'
								/>
							</div>
							<div className='flex flex-col gap-1.5 pt-1'>
								<input
									type='text'
									value={reqTitle}
									onChange={e => setReqTitle(e.target.value)}
									placeholder='Requirement title (e.g. Role-based admin access)'
									className='w-full px-2.5 py-1.5 rounded bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1'
								/>
								<div className='flex items-center gap-1.5'>
									<input
										type='text'
										value={reqDesc}
										onChange={e => setReqDesc(e.target.value)}
										placeholder='Acceptance criteria / details'
										className='flex-1 px-2.5 py-1.5 rounded bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1'
									/>
									<select
										value={reqPriority}
										onChange={e => setReqPriority(e.target.value as 'high' | 'medium' | 'low')}
										className='px-2 py-1.5 rounded bg-void-bg-1 border border-void-border-2 text-[11px] text-void-fg-1'
									>
										<option value='high'>High</option>
										<option value='medium'>Med</option>
										<option value='low'>Low</option>
									</select>
									<KodiaPrimaryButton onClick={handleAddRequirement} disabled={!reqTitle.trim()} className='!py-1.5 !px-2.5'>
										<Plus size={12} />
										<span>Add</span>
									</KodiaPrimaryButton>
								</div>
							</div>
						</KodiaCard>

						{requirements.length === 0 ? (
							<KodiaEmptyState
								icon={<ListChecks size={20} />}
								title='No Tracked Requirements Yet'
								description='Add requirements above or launch a Software Factory build to track implementation and verification coverage.'
							/>
						) : (
							<div className='flex flex-col gap-2'>
								{requirements.map(req => (
									<KodiaCard key={req.id} className='!p-2.5 flex flex-col gap-1.5'>
										<div className='flex items-center justify-between gap-2'>
											<div className='flex items-center gap-1.5 min-w-0'>
												<span className='font-mono text-[10px] text-void-fg-3'>{req.id}</span>
												<span className='font-semibold text-void-fg-1 truncate'>{req.title}</span>
											</div>
											<div className='flex items-center gap-1 shrink-0'>
												<button
													type='button'
													onClick={() => handleCycleReqStatus(req)}
													title='Click to advance verification status'
													className='cursor-pointer'
												>
													<KodiaBadge tone={req.status === 'verified' ? 'success' : req.status === 'implemented' ? 'accent' : req.status === 'in_progress' ? 'warning' : 'neutral'}>
														{req.status}
													</KodiaBadge>
												</button>
												<button
													type='button'
													onClick={() => factoryService.removeRequirement(req.id)}
													className='p-1 text-void-fg-3 hover:text-rose-400 cursor-pointer'
													title='Delete requirement'
												>
													<Trash2 size={11} />
												</button>
											</div>
										</div>
										{req.description && <div className='text-[11px] text-void-fg-3'>{req.description}</div>}
										<div className='flex items-center gap-1.5 pt-1'>
											<KodiaSecondaryButton
												className='!py-0.5 !px-2 !text-[10px]'
												onClick={() => sendPrompt(`Implement requirement ${req.id} (${req.title}): ${req.description}. Update status via factory_manage_requirements and record verification evidence when done.`)}
											>
												<Play size={10} />
												<span>Implement</span>
											</KodiaSecondaryButton>
											<KodiaSecondaryButton
												className='!py-0.5 !px-2 !text-[10px]'
												onClick={() => sendPrompt(`Write and run automated tests verifying requirement ${req.id} (${req.title}): ${req.description}. Record proof via record_verification_evidence.`)}
											>
												<CheckCircle2 size={10} />
												<span>Verify with Tests</span>
											</KodiaSecondaryButton>
										</div>
									</KodiaCard>
								))}
							</div>
						)}
					</>
				)}

				{/* SUBTAB 3: PROJECT AUTOPILOT OBJECTIVES */}
				{subTab === 'autopilot' && (
					<>
						<KodiaCard className='flex flex-col gap-2'>
							<div className='font-semibold text-void-fg-1'>Add Persistent Project Autopilot Objective</div>
							<input
								type='text'
								value={autoTitle}
								onChange={e => setAutoTitle(e.target.value)}
								placeholder='Objective title (e.g. Harden API security & test coverage)'
								className='w-full px-2.5 py-1.5 rounded bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1'
							/>
							<textarea
								rows={2}
								value={autoInstruction}
								onChange={e => setAutoInstruction(e.target.value)}
								placeholder='Standing engineering instructions executed when this autopilot cycle runs…'
								className='w-full px-2.5 py-1.5 rounded bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1 resize-y'
							/>
							<KodiaPrimaryButton onClick={handleAddAutopilot} disabled={!autoTitle.trim() || !autoInstruction.trim()} className='w-fit'>
								<Plus size={12} />
								<span>Save Objective</span>
							</KodiaPrimaryButton>
						</KodiaCard>

						{objectives.length === 0 ? (
							<KodiaEmptyState
								icon={<Sparkles size={20} />}
								title='No Autopilot Objectives Defined'
								description='Define long-term project improvement goals (reliability, security, performance, debt cleanup) and execute autonomous cycles on demand.'
							/>
						) : (
							<div className='flex flex-col gap-2'>
								{objectives.map(obj => (
									<KodiaCard key={obj.id} className='!p-2.5 flex flex-col gap-1.5'>
										<div className='flex items-center justify-between gap-2'>
											<span className='font-semibold text-void-fg-1 truncate'>{obj.title}</span>
											<div className='flex items-center gap-1.5 shrink-0'>
												<button
													type='button'
													onClick={() => factoryService.toggleAutopilotObjective(obj.id, !obj.enabled)}
													className='cursor-pointer'
												>
													<KodiaBadge tone={obj.enabled ? 'success' : 'neutral'}>{obj.enabled ? 'Active' : 'Paused'}</KodiaBadge>
												</button>
												<button
													type='button'
													onClick={() => factoryService.removeAutopilotObjective(obj.id)}
													className='p-1 text-void-fg-3 hover:text-rose-400 cursor-pointer'
													title='Remove objective'
												>
													<Trash2 size={11} />
												</button>
											</div>
										</div>
										<div className='text-[11px] text-void-fg-3'>{obj.instruction}</div>
										<div className='flex items-center justify-between pt-1'>
											<span className='text-[10px] text-void-fg-3'>
												Runs: {obj.runCount}{obj.lastRunAt ? ` · Last: ${new Date(obj.lastRunAt).toLocaleTimeString()}` : ''}
											</span>
											<KodiaPrimaryButton
												className='!py-0.5 !px-2 !text-[10px]'
												disabled={!obj.enabled}
												onClick={() => { void factoryService.runAutopilotObjectiveNow(obj.id); onOpenChat?.(); }}
											>
												<Play size={10} />
												<span>Run Cycle Now</span>
											</KodiaPrimaryButton>
										</div>
									</KodiaCard>
								))}
							</div>
						)}
					</>
				)}

				{/* SUBTAB 4: MULTI-AGENT ARCHITECTURE COUNCIL & ADRs */}
				{subTab === 'council' && (
					<>
						<KodiaCard className='flex flex-col gap-2'>
							<div className='font-semibold text-void-fg-1 flex items-center gap-1.5'>
								<Scale size={13} />
								<span>Multi-Agent Architecture Council</span>
							</div>
							<div className='text-[11px] text-void-fg-3'>
								Spawns competing Architect, Security, and Performance proposals to debate trade-offs before changing code.
							</div>
							<textarea
								rows={2}
								value={councilQuestion}
								onChange={e => setCouncilQuestion(e.target.value)}
								placeholder='Example: Should we move session auth from cookies to JWT or opaque DB tokens for our API?'
								className='w-full px-2.5 py-1.5 rounded bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1 resize-y'
							/>
							<KodiaPrimaryButton onClick={() => void handleLaunchCouncil()} disabled={!councilQuestion.trim()} className='w-fit'>
								<Scale size={12} />
								<span>Run Multi-Solution Debate</span>
							</KodiaPrimaryButton>
						</KodiaCard>

						<KodiaCard className='flex flex-col gap-2'>
							<div className='font-semibold text-void-fg-1 flex items-center gap-1.5'>
								<FileText size={13} />
								<span>Record Architecture Decision (ADR)</span>
							</div>
							<input
								type='text'
								value={adrTitle}
								onChange={e => setAdrTitle(e.target.value)}
								placeholder='Decision title (e.g. Use SQLite WAL mode for local persistence)'
								className='w-full px-2.5 py-1.5 rounded bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1'
							/>
							<input
								type='text'
								value={adrContext}
								onChange={e => setAdrContext(e.target.value)}
								placeholder='Context / problem being solved'
								className='w-full px-2.5 py-1.5 rounded bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1'
							/>
							<input
								type='text'
								value={adrDecision}
								onChange={e => setAdrDecision(e.target.value)}
								placeholder='Chosen decision & rationale'
								className='w-full px-2.5 py-1.5 rounded bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1'
							/>
							<KodiaSecondaryButton onClick={handleAddAdr} disabled={!adrTitle.trim() || !adrDecision.trim()} className='w-fit'>
								<Plus size={12} />
								<span>Save ADR</span>
							</KodiaSecondaryButton>
						</KodiaCard>

						{decisions.length > 0 && (
							<div className='flex flex-col gap-2'>
								{decisions.map(adr => (
									<KodiaCard key={adr.id} className='!p-2.5 flex flex-col gap-1'>
										<div className='flex items-center justify-between gap-2'>
											<div className='flex items-center gap-1.5 min-w-0'>
												<span className='font-mono text-[10px] text-void-fg-3'>{adr.id}</span>
												<span className='font-semibold text-void-fg-1 truncate'>{adr.title}</span>
											</div>
											<div className='flex items-center gap-1 shrink-0'>
												<KodiaBadge tone='success'>{adr.status}</KodiaBadge>
												<button
													type='button'
													onClick={() => factoryService.removeDecision(adr.id)}
													className='p-1 text-void-fg-3 hover:text-rose-400 cursor-pointer'
													title='Delete ADR'
												>
													<Trash2 size={11} />
												</button>
											</div>
										</div>
										<div className='text-[11px] text-void-fg-2'>{adr.decision}</div>
										<div className='text-[10px] text-void-fg-3'>{adr.context}</div>
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
