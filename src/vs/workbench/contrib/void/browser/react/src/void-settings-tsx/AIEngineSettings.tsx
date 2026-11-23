/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React from 'react';
import { Brain, ShieldCheck } from 'lucide-react';
import { useAccessor, useSettingsState } from '../util/services.js';
import { SettingGroup, SettingsSection, SettingSwitch } from './SettingsControls.js';
import { KodiaBadge } from '../util/KodiaDesignSystem.js';
import {
	AIEngineComputePreference,
	AIEngineSettings,
	DEFAULT_AI_ENGINE_SETTINGS,
} from '../../../../common/aiEngineeringTypes.js';

export const AIEngineSettingsSection = ({ onRecordChange }: { onRecordChange?: (label: string) => void }) => {
	const accessor = useAccessor();
	const voidSettingsService = accessor.get('IVoidSettingsService');
	const settingsState = useSettingsState();

	const current: AIEngineSettings = {
		...DEFAULT_AI_ENGINE_SETTINGS,
		...(settingsState.globalSettings.aiEngine ?? {}),
	};

	const update = <K extends keyof AIEngineSettings>(key: K, value: AIEngineSettings[K], label: string) => {
		voidSettingsService.setGlobalSetting('aiEngine', { ...current, [key]: value });
		onRecordChange?.(`AI Engine: ${label}`);
	};

	return (
		<SettingsSection
			title='Universal AI Engineering Engine & Orchestration'
			description='Configure Kodia’s Unified Two-Engine Orchestrator, local/cloud compute preferences, hybrid RAG defaults, AI security & governance safeguards, and future capability discovery.'
			badge={<KodiaBadge tone='accent'><Brain size={11} /> 20 AI Tools · 13 Specialists</KodiaBadge>}
		>
			<SettingGroup title='Two-Engine Unified Orchestrator' description='Coordinates Kodia’s Universal Software Engineering Engine and AI Engineering Engine without injecting AI into ordinary non-AI software.'>
				<SettingSwitch
					value={current.enableUnifiedOrchestrator}
					onChange={v => update('enableUnifiedOrchestrator', v, `Unified orchestrator ${v ? 'on' : 'off'}`)}
					label='Enable Unified Two-Engine Orchestrator'
					description='Automatically routes requests to Universal Software Engine, AI Engineering Engine, or coordinated Dual-Engine delivery.'
				/>
				<SettingSwitch
					value={current.autoDetectAIRequirements}
					onChange={v => update('autoDetectAIRequirements', v, `Auto AI detection ${v ? 'on' : 'off'}`)}
					label='Automatic AI discipline & stack detection'
					description='Recognizes ML, DL, LLM, RAG, Vision, Speech, Agentic, Automation, and IoT/Robotics requirements automatically.'
				/>
				<label className='flex flex-col gap-1 max-w-sm pt-1'>
					<span className='text-xs font-medium text-void-fg-1'>Compute & inference preference</span>
					<select
						value={current.computePreference}
						onChange={e => update('computePreference', e.target.value as AIEngineComputePreference, `Compute: ${e.target.value}`)}
						className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1'
					>
						<option value='auto'>Auto-select based on real hardware probe (Recommended)</option>
						<option value='local-first'>Local-first (Ollama / vLLM / MLX / ONNX)</option>
						<option value='hybrid'>Hybrid (Local fast/RAG + Cloud flagship fallback)</option>
						<option value='cloud-first'>Cloud-first (Hosted BYOK providers)</option>
					</select>
				</label>
			</SettingGroup>

			<SettingGroup title='RAG & knowledge indexing defaults' description='Controls Kodia’s hybrid BM25 + semantic vector RAG indexing and retrieval tools.'>
				<div className='grid grid-cols-1 sm:grid-cols-3 gap-3'>
					<label className='flex flex-col gap-1'>
						<span className='text-xs font-medium text-void-fg-1'>Chunk size (chars)</span>
						<input
							type='number'
							min={200}
							max={4000}
							value={current.defaultRagChunkSize}
							onChange={e => update('defaultRagChunkSize', Math.max(200, Number(e.target.value) || 800), 'Chunk size updated')}
							className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1'
						/>
					</label>
					<label className='flex flex-col gap-1'>
						<span className='text-xs font-medium text-void-fg-1'>Chunk overlap (chars)</span>
						<input
							type='number'
							min={0}
							max={1000}
							value={current.defaultRagChunkOverlap}
							onChange={e => update('defaultRagChunkOverlap', Math.max(0, Number(e.target.value) || 120), 'Chunk overlap updated')}
							className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1'
						/>
					</label>
					<label className='flex flex-col gap-1'>
						<span className='text-xs font-medium text-void-fg-1'>Default Top-K retrieval</span>
						<input
							type='number'
							min={1}
							max={20}
							value={current.defaultRagTopK}
							onChange={e => update('defaultRagTopK', Math.max(1, Math.min(20, Number(e.target.value) || 5)), 'Top-K updated')}
							className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1'
						/>
					</label>
				</div>
			</SettingGroup>

			<SettingGroup title='AI security, governance & budget guardrails' description='Enforces prompt-injection safety, privacy, human oversight on high-impact decisions, and spending authorization.'>
				<SettingSwitch
					value={current.enforcePromptInjectionGuards}
					onChange={v => update('enforcePromptInjectionGuards', v, `Prompt injection guards ${v ? 'on' : 'off'}`)}
					label='Prompt injection & unsafe deserialization scanning'
					description='Flags untrusted system-prompt interpolation, pickle/torch.load without weights_only=True, and eval() on model outputs.'
				/>
				<SettingSwitch
					value={current.enforcePiiRedaction}
					onChange={v => update('enforcePiiRedaction', v, `PII redaction ${v ? 'on' : 'off'}`)}
					label='Dataset PII & secret leakage detection'
					description='Automatically flags emails, SSNs, and API keys during dataset profiling and security audits.'
				/>
				<SettingSwitch
					value={current.requireHumanApprovalForHighImpact}
					onChange={v => update('requireHumanApprovalForHighImpact', v, `High-impact HITL ${v ? 'on' : 'off'}`)}
					label='Require human-in-the-loop approval for high-impact AI actions'
					description='Pauses AI workflows at approval gates for production deployments, financial actions, deletions, or regulated domains.'
				/>
				<SettingSwitch
					value={current.requireApprovalForPaidCompute}
					onChange={v => update('requireApprovalForPaidCompute', v, `Paid compute approval ${v ? 'on' : 'off'}`)}
					label='Require explicit authorization before paid cloud GPU/API provisioning'
					description='Prevents autonomous jobs from provisioning billable external compute without explicit user approval.'
				/>
				<label className='flex flex-col gap-1 max-w-xs pt-1'>
					<span className='text-xs font-medium text-void-fg-1 flex items-center gap-1.5'>
						<ShieldCheck size={13} /> Monthly AI spend advisory limit (USD)
					</span>
					<input
						type='number'
						min={0}
						value={current.monthlyBudgetLimitUsd}
						onChange={e => update('monthlyBudgetLimitUsd', Math.max(0, Number(e.target.value) || 0), 'Budget limit updated')}
						className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1'
					/>
				</label>
				<SettingSwitch
					value={current.enableFutureCapabilityDiscovery}
					onChange={v => update('enableFutureCapabilityDiscovery', v, `Future capability discovery ${v ? 'on' : 'off'}`)}
					label='Enable Future Capability Discovery Catalogue'
					description='Allows querying and evaluating emerging AI frameworks, protocols, and model families in isolated environments.'
				/>
			</SettingGroup>
		</SettingsSection>
	);
};
