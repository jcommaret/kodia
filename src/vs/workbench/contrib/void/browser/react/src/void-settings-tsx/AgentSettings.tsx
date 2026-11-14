/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useState } from 'react';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js'
import { VoidButtonBgDarken, VoidSwitch } from '../util/inputs.js'
import { useAccessor, useMCPServiceState, useSettingsState } from '../util/services.js'
import { WarningBox } from './WarningBox.js'
import { ToolApprovalType, toolApprovalTypes } from '../../../../common/toolsServiceTypes.js'
import { AutonomyMode, autonomyModes } from '../../../../common/autonomyPolicy.js'
import { TaskPlan, TaskStatus, getPlanProgress } from '../../../../common/autonomousTask.js'
import { MCPServer } from '../../../../common/mcpServiceTypes.js';
import { GlobalSettingSwitch, SettingGroup, SettingsSection, SettingSwitch } from './SettingsControls.js'

// whether the agent runs this kind of tool without asking, and a setter
const useAutoApprove = (approvalType: ToolApprovalType) => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const metricsService = accessor.get('IMetricsService')
	const value = useSettingsState().globalSettings.autoApprove[approvalType] ?? false

	const setValue = useCallback((newValue: boolean) => {
		voidSettingsService.setGlobalSetting('autoApprove', {
			...voidSettingsService.state.globalSettings.autoApprove,
			[approvalType]: newValue
		})
		metricsService.capture('Tool Auto-Accept Toggle', { enabled: newValue })
	}, [voidSettingsService, metricsService, approvalType])

	return [value, setValue] as const
}

// the switch next to a tool call in the chat
export const ToolApprovalTypeSwitch = ({ approvalType, size, desc }: { approvalType: ToolApprovalType, size: "xxs" | "xs" | "sm" | "sm+" | "md", desc: string }) => {
	const [value, setValue] = useAutoApprove(approvalType)
	return <>
		<VoidSwitch size={size} value={value} onChange={setValue} />
		<span className="text-void-fg-3 text-xs">{desc}</span>
	</>
}

const labelOfApprovalType: { [T in ToolApprovalType]: string } = {
	'edits': 'Edit files without asking',
	'terminal': 'Run terminal commands without asking',
	'planning': 'Plan tasks without asking',
	'web pages': 'Fetch web pages without asking',
	'MCP tools': 'Use MCP tools without asking',
	'git': 'Git operations without asking',
	'test': 'Test operations without asking',
}

const AutoApproveSwitch = ({ approvalType }: { approvalType: ToolApprovalType }) => {
	const [value, setValue] = useAutoApprove(approvalType)
	return <SettingSwitch value={value} onChange={setValue} label={labelOfApprovalType[approvalType]} />
}

// Autonomy mode selector: Assist / Agent (default) / Autonomous
const modeInfo: { [M in AutonomyMode]: { title: string, desc: string } } = {
	assist: { title: 'Assist', desc: 'Inspects files and asks before significant changes or terminal commands.' },
	agent: { title: 'Agent', desc: 'Broad filesystem and terminal access; asks only for consequential actions (default).' },
	autonomous: { title: 'Autonomous', desc: 'Long-running tasks with minimal interruptions; pauses only for high-impact actions.' },
};

const useAutonomyMode = () => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const value = useSettingsState().globalSettings.agentAutonomyMode
	const setValue = useCallback((newValue: AutonomyMode) => {
		voidSettingsService.setGlobalSetting('agentAutonomyMode', newValue)
	}, [voidSettingsService])
	return [value, setValue] as const
};

export const AutonomyModeSelector = () => {
	const [mode, setMode] = useAutonomyMode()
	return (
		<div className='flex flex-col gap-2'>
			{autonomyModes.map(m => {
				const info = modeInfo[m]
				const isActive = mode === m
				return (
					<button
						key={m}
						onClick={() => setMode(m)}
						className={`
							flex items-center gap-2 px-3 py-2 rounded-sm border text-sm
							${isActive
								? 'bg-[#0e70c0] text-white border-[#0e70c0]'
								: 'bg-void-bg-2 text-void-fg-1 border-void-border-2 hover:bg-void-bg-3 cursor-pointer'
							}
						`}
					>
						{isActive ? '●' : '○'}
						<div className='font-medium'>{info.title}</div>
						<span className='text-void-fg-3 text-xs'>{info.desc}</span>
					</button>
				)
			})}
			<div className='text-xs text-void-fg-4 mt-1'>
				Mode persists in settings. Changing it takes effect immediately across file, search and terminal tools.
			</div>
		</div>
	);
};

// Task plan display
const TaskPlanDisplay = () => {
	const accessor = useAccessor()
	const chatThreadService = accessor.get('IChatThreadService')
	const taskPlanService = accessor.get('TaskPlanService')
	const [taskPlan, setTaskPlan] = useState<TaskPlan | null>(null)

	useEffect(() => {
		// Initial load
		const thread = chatThreadService.getCurrentThread()
		if (thread) {
			setTaskPlan(thread.taskPlan ?? null)
		}

		// Subscribe to plan changes
		const disposable = taskPlanService.onDidChangePlan(({ threadId, plan }) => {
			const currentThread = chatThreadService.getCurrentThread()
			if (currentThread && currentThread.id === threadId) {
				setTaskPlan(plan)
			}
		})

		return () => disposable.dispose()
	}, [chatThreadService, taskPlanService])

	if (!taskPlan) return null

	const statusColors: { [key in TaskPlan['overallStatus']]: string } = {
		pending: 'text-void-fg-3',
		'in_progress': 'text-[#0e70c0]',
		completed: 'text-green-500',
		failed: 'text-red-500',
	}

	const statusIcons: { [key in TaskStatus]: string } = {
		pending: '○',
		running: '●',
		completed: '✓',
		failed: '✗',
		blocked: '!',
	}

	const { completed, total, percent } = getPlanProgress(taskPlan)

	return (
		<div className="border border-void-border-2 bg-void-bg-1 py-3 px-4 rounded-sm my-2">
			<div className="flex items-center justify-between mb-2">
				<h3 className={`text-sm font-medium text-void-fg-1 ${statusColors[taskPlan.overallStatus]}`}>
					{taskPlan.title}
				</h3>
				<span className="text-xs text-void-fg-3">{percent}% ({completed}/{total})</span>
			</div>
			<div className="text-xs text-void-fg-3 mb-2">{taskPlan.description}</div>
			<div className="space-y-1">
				{taskPlan.tasks.map(t => {
					const icon = statusIcons[t.status]
					const color = t.status === 'completed' ? 'text-green-500' : t.status === 'failed' ? 'text-red-500' : t.status === 'running' ? 'text-[#0e70c0]' : t.status === 'blocked' ? 'text-orange-500' : 'text-void-fg-3'
					return (
						<div key={t.id} className="flex items-start gap-2">
							<span className={`text-xs ${color} mt-0.5`}>{icon}</span>
							<div className="text-xs text-void-fg-2">
								<div className="font-medium">{t.title}</div>
								<div className="text-void-fg-3">{t.description}</div>
								{t.error && <div className="text-xs text-red-500 mt-0.5">{t.error}</div>}
							</div>
						</div>
					)
				})}
			</div>
		</div>
	)
}

// MCP Server component
const MCPServerComponent = ({ name, server }: { name: string, server: MCPServer }) => {
	const accessor = useAccessor();
	const mcpService = accessor.get('IMCPService');

	const voidSettings = useSettingsState()
	const isOn = voidSettings.mcpUserStateOfName[name]?.isOn

	const removeUniquePrefix = (name: string) => name.split('_').slice(1).join('_')

	return (
		<div className="border border-void-border-2 bg-void-bg-1 py-3 px-4 rounded-sm my-2">
			<div className="flex items-center justify-between">
				{/* Left side - status and name */}
				<div className="flex items-center gap-2">
					{/* Status indicator */}
					<div className={`w-2 h-2 rounded-full
						${server.status === 'success' ? 'bg-green-500'
							: server.status === 'error' ? 'bg-red-500'
								: server.status === 'loading' ? 'bg-yellow-500'
									: server.status === 'offline' ? 'bg-void-fg-3'
										: ''}
					`}></div>

					{/* Server name */}
					<div className="text-sm font-medium text-void-fg-1">{name}</div>
				</div>

				{/* Right side - power toggle switch */}
				<VoidSwitch
					value={isOn ?? false}
					size='xs'
					disabled={server.status === 'error'}
					onChange={() => mcpService.toggleServerIsOn(name, !isOn)}
				/>
			</div>

			{/* Tools section */}
			{isOn && (
				<div className="mt-3">
					<div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
						{(server.tools ?? []).length > 0 ? (
							(server.tools ?? []).map((tool: { name: string; description?: string }) => (
								<span
									key={tool.name}
									className="px-2 py-0.5 bg-void-bg-2 text-void-fg-3 rounded-sm text-xs"

									data-tooltip-id='void-tooltip'
									data-tooltip-content={tool.description || ''}
									data-tooltip-class-name='void-max-w-[300px]'
								>
									{removeUniquePrefix(tool.name)}
								</span>
							))
						) : (
							<span className="text-xs text-void-fg-3">No tools available</span>
						)}
					</div>
				</div>
			)}

			{/* Command badge */}
			{isOn && server.command && (
				<div className="mt-3">
					<div className="text-xs text-void-fg-3 mb-1">Command:</div>
					<div className="px-2 py-1 bg-void-bg-2 text-xs font-mono overflow-x-auto whitespace-nowrap text-void-fg-2 rounded-sm">
						{server.command}
					</div>
				</div>
			)}

			{/* Error message if present */}
			{server.error && (
				<div className="mt-3">
					<WarningBox text={server.error} />
				</div>
			)}
		</div>
	);
};

// Main component that renders the list of servers
const MCPServersList = () => {
	const mcpServiceState = useMCPServiceState()

	let content: React.ReactNode
	if (mcpServiceState.error) {
		content = <div className="text-void-fg-3 text-sm mt-2">
			{mcpServiceState.error}
		</div>
	}
	else {
		const entries = Object.entries(mcpServiceState.mcpServerOfName)
		if (entries.length === 0) {
			content = <div className="text-void-fg-3 text-sm mt-2">
				No servers found
			</div>
		}
		else {
			content = entries.map(([name, server]) => (
				<MCPServerComponent key={name} name={name} server={server} />
			))
		}
	}

	return <div className="my-2">{content}</div>
};

export const AgentSection = () => {
	const mcpService = useAccessor().get('IMCPService')
	return <SettingsSection title='Agent' description={`What the agent can do on its own in Agent mode, and the tools it has.`}>
		<SettingGroup title='Autonomy mode' description='How independently the agent may act. Agent is the default for new installations.'>
			<ErrorBoundary>
				<AutonomyModeSelector />
			</ErrorBoundary>
		</SettingGroup>
		<SettingGroup title='Task Plan' description='Current task plan for autonomous development.'>
			<ErrorBoundary>
				<TaskPlanDisplay />
			</ErrorBoundary>
		</SettingGroup>
		<SettingGroup title='Approvals' description='Kodia asks you before the agent does these. Turn one on to let the agent do it without asking.'>
			<ErrorBoundary>
				{[...toolApprovalTypes].map(approvalType => <AutoApproveSwitch key={approvalType} approvalType={approvalType} />)}
			</ErrorBoundary>
		</SettingGroup>

		<SettingGroup title='Changes'>
			<GlobalSettingSwitch
				settingName='autoAcceptLLMChanges'
				label={`Accept the agent's changes as soon as they're made`}
				description='When off, you review each change in the editor and accept or reject it.'
			/>
			<GlobalSettingSwitch
				settingName='includeToolLintErrors'
				label='Show the agent the lint errors after each edit, so it can fix them'
			/>
		</SettingGroup>

		<SettingGroup title='MCP servers' description='Model Context Protocol servers give the agent more tools.'>
			<div>
				<VoidButtonBgDarken className='px-4 py-1 w-full max-w-48' onClick={async () => { await mcpService.revealMCPConfigFile() }}>
					Add MCP Server
				</VoidButtonBgDarken>
			</div>
			<ErrorBoundary>
				<MCPServersList />
			</ErrorBoundary>
		</SettingGroup>
	</SettingsSection>
}
