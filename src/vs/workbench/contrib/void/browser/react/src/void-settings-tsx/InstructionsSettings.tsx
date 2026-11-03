/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useRef, useState } from 'react';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js'
import { VoidButtonBgDarken, VoidInputBox2, VoidSimpleInputBox, VoidSwitch } from '../util/inputs.js'
import { useAccessor, useSettingsState } from '../util/services.js'
import { X, RefreshCw, Loader2 } from 'lucide-react'
import { ChatMarkdownRender } from '../markdown/ChatMarkdownRender.js'
import { WarningBox } from './WarningBox.js'
import { PROJECT_MEMORY_FILE_PATH } from '../../../../common/projectMemoryService.js';
import { builtinInstructionsFrameworks, downloadInstructionsFramework, InstructionsFramework } from '../../../../common/instructionsFrameworks.js';
import { generateUuid } from '../../../../../../../base/common/uuid.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { CancellationToken } from '../../../../../../../base/common/cancellation.js';
import { PROJECT_RULES_FILE_NAMES } from '../../../../common/prompt/prompts.js';
import { SkillOfPrompt, skillsOfPrompt } from '../../../../common/agentSkills.js';
import { AddButton, AddRowButton, ConfirmButton, GlobalSettingSwitch, SettingGroup, SettingsSection } from './SettingsControls.js'

type RulesFile = { uri: URI, path: string, sentAs: 'sent' | 'empty' | { sameAs: string } }

// The rules files at the root of the workspace folders, as Kodia sends them (joinProjectRules):
// an empty file and a file with the same content as an earlier one (a symlink, a copy) aren't sent
const useProjectRulesFiles = () => {
	const accessor = useAccessor()
	const fileService = accessor.get('IFileService')
	const workspaceContextService = accessor.get('IWorkspaceContextService')
	const [files, setFiles] = useState<RulesFile[]>([])

	useEffect(() => {
		let isDisposed = false
		const candidates = () => {
			const folders = workspaceContextService.getWorkspace().folders
			return folders.flatMap(folder => PROJECT_RULES_FILE_NAMES.map(fileName => ({
				uri: URI.joinPath(folder.uri, fileName),
				path: folders.length > 1 ? `${folder.name}/${fileName}` : fileName,
			})))
		}
		const update = async () => {
			const found: RulesFile[] = []
			const pathOfContent = new Map<string, string>()
			for (const { uri, path } of candidates()) {
				const content = await fileService.readFile(uri).then(f => f.value.toString().trim(), () => undefined)
				if (content === undefined) continue
				const sameAs = pathOfContent.get(content)
				found.push({ uri, path, sentAs: !content ? 'empty' : sameAs ? { sameAs } : 'sent' })
				if (content && !sameAs) pathOfContent.set(content, path)
			}
			if (!isDisposed) setFiles(found)
		}
		update()
		const d1 = fileService.onDidFilesChange(e => { if (candidates().some(({ uri }) => e.affects(uri))) update() })
		const d2 = workspaceContextService.onDidChangeWorkspaceFolders(() => update())
		return () => { isDisposed = true; d1.dispose(); d2.dispose() }
	}, [fileService, workspaceContextService])

	return files
}

const RulesFiles = () => {
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const hasFolder = accessor.get('IWorkspaceContextService').getWorkspace().folders.length > 0
	const files = useProjectRulesFiles()

	if (files.length === 0) {
		return <div className='text-sm text-void-fg-3'>{hasFolder ? 'No rules file in this workspace.' : 'Open a folder: Kodia reads these files at its root.'}</div>
	}
	return <div className='flex flex-col gap-1'>
		{files.map(({ uri, path, sentAs }) => <div key={uri.toString()} className='flex items-center gap-3'>
			<button type='button' className='text-root text-void-fg-1 underline hover:brightness-125' onClick={() => commandService.executeCommand('vscode.open', uri)}>{path}</button>
			<span className='text-sm text-void-fg-3'>
				{sentAs === 'sent' ? 'Sent with every request' : sentAs === 'empty' ? 'Empty: not sent' : `Same content as ${sentAs.sameAs}: not sent twice`}
			</span>
		</div>)}
	</div>
}

// The skills the chat lists (the same filter: a description, and not only for the user to run), kept up to date
const useAgentSkills = () => {
	const promptsService = useAccessor().get('IPromptsService')
	const [skills, setSkills] = useState<SkillOfPrompt[] | 'off' | 'loading'>('loading')

	useEffect(() => {
		let isDisposed = false
		const update = () => promptsService.findAgentSkills(CancellationToken.None).then(
			found => { if (!isDisposed) setSkills(found === undefined ? 'off' : skillsOfPrompt(found)) },
			() => { if (!isDisposed) setSkills([]) },
		)
		update()
		const d = promptsService.onDidChangeSkills(() => update())
		return () => { isDisposed = true; d.dispose() }
	}, [promptsService])

	return skills
}

const Skills = () => {
	const commandService = useAccessor().get('ICommandService')
	const skills = useAgentSkills()
	const openFoldersSetting = () => commandService.executeCommand('workbench.action.openSettings', 'chat.agentSkillsLocations')

	return <>
		{skills === 'loading' ? <div className='text-sm text-void-fg-3'>Looking for skills...</div>
			: skills === 'off' ? <div className='text-sm text-void-fg-3'>Skills are turned off (the chat.useAgentSkills setting).</div>
				: skills.length === 0 ? <div className='text-sm text-void-fg-3'>No skill found.</div>
					: <div className='flex flex-col gap-2 max-h-[400px] overflow-y-auto pr-2'>
						{skills.map(({ name, description, path }) => <div key={path} className='border border-void-border-2 bg-void-bg-1 py-2 px-3 rounded-sm'>
							<div className='flex items-center justify-between gap-4'>
								<div className='text-root font-medium text-void-fg-1 truncate'>{name}</div>
								<button type='button' className='text-sm text-void-fg-3 hover:brightness-125 shrink-0' onClick={() => commandService.executeCommand('vscode.open', URI.file(path))}>Open</button>
							</div>
							<div className='text-sm text-void-fg-3 mt-1 line-clamp-2'>{description}</div>
							<div className='text-xs text-void-fg-4 mt-1 truncate select-text' title={path}>{path}</div>
						</div>)}
					</div>}
		<div>
			<VoidButtonBgDarken className='px-4 py-1' onClick={openFoldersSetting}>Choose Skill Folders</VoidButtonBgDarken>
		</div>
	</>
}

const AIInstructionsBox = () => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const voidSettingsState = useSettingsState()
	return <VoidInputBox2
		className='min-h-[81px] p-3 rounded-sm'
		initValue={voidSettingsState.globalSettings.aiInstructions}
		placeholder={`Do not change my indentation or delete my comments. When writing TS or JS, do not add ;'s. Write new code using Rust if possible. `}
		multiline
		onChangeText={(newText) => {
			voidSettingsService.setGlobalSetting('aiInstructions', newText)
		}}
	/>
}

// Kodia's frameworks (downloaded when turned on), then the user's: downloaded from a link, or written here
const InstructionsFrameworks = () => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const requestService = accessor.get('IRequestService')
	const frameworks = useSettingsState().globalSettings.instructionsFrameworks

	const [downloadingId, setDownloadingId] = useState<string | null>(null)
	const [errorOfId, setErrorOfId] = useState<{ [id: string]: string | undefined }>({})
	const [editingId, setEditingId] = useState<string | null>(null)
	const [editorKey, setEditorKey] = useState(0) // remounts the text box when a download replaces the text

	const [isAddOpen, setIsAddOpen] = useState(false)
	const [newName, setNewName] = useState('')
	const [newURL, setNewURL] = useState('')
	const [addError, setAddError] = useState('')
	const [isAdding, setIsAdding] = useState(false)

	// from the latest settings, not this render's: they may have changed during a download
	const saveFramework = (framework: InstructionsFramework) => {
		const current = voidSettingsService.state.globalSettings.instructionsFrameworks
		const exists = current.some(f => f.id === framework.id)
		voidSettingsService.setGlobalSetting('instructionsFrameworks', exists ? current.map(f => f.id === framework.id ? framework : f) : [...current, framework])
	}
	const changeFramework = (id: string, change: Partial<InstructionsFramework>) => {
		const current = voidSettingsService.state.globalSettings.instructionsFrameworks
		voidSettingsService.setGlobalSetting('instructionsFrameworks', current.map(f => f.id === id ? { ...f, ...change } : f))
	}

	// (again) the framework's text; a new framework is turned on
	const download = async ({ id, name, sourceURL }: { id: string, name: string, sourceURL: string }) => {
		setDownloadingId(id)
		setErrorOfId(errors => ({ ...errors, [id]: undefined }))
		try {
			const content = await downloadInstructionsFramework(requestService, sourceURL)
			const isOn = voidSettingsService.state.globalSettings.instructionsFrameworks.find(f => f.id === id)?.isOn ?? true
			saveFramework({ id, name, sourceURL, content, isOn })
			setEditorKey(k => k + 1)
		}
		catch (e) {
			setErrorOfId(errors => ({ ...errors, [id]: e instanceof Error ? e.message : `${e}` }))
		}
		finally {
			setDownloadingId(null)
		}
	}

	const onAdd = async () => {
		const id = generateUuid()
		const name = newName.trim()
		const sourceURL = newURL.trim()
		setIsAdding(true)
		setAddError('')
		try {
			const content = sourceURL ? await downloadInstructionsFramework(requestService, sourceURL) : ''
			saveFramework({ id, name, sourceURL, content, isOn: true })
			if (!sourceURL) setEditingId(id) // to write it
			setIsAddOpen(false)
			setNewName('')
			setNewURL('')
		}
		catch (e) {
			setAddError(e instanceof Error ? e.message : `${e}`)
		}
		finally {
			setIsAdding(false)
		}
	}

	const rows = [
		...builtinInstructionsFrameworks.map(({ id, name, group, description, homepage, sourceURL }) =>
			({ id, name, group, description, homepage, sourceURL, isBuiltin: true, framework: frameworks.find(f => f.id === id) })),
		...frameworks.filter(f => !builtinInstructionsFrameworks.some(b => b.id === f.id)).map(f =>
			({ id: f.id, name: f.name, group: 'Added by you', description: f.sourceURL ? undefined : 'Written in Kodia.', homepage: f.sourceURL, sourceURL: f.sourceURL, isBuiltin: false, framework: f })),
	]

	return <div>
		{rows.map(({ id, name, group, description, homepage, sourceURL, isBuiltin, framework }, i) => {
			const isDownloading = downloadingId === id
			const error = errorOfId[id]
			return <React.Fragment key={id}>{group !== rows[i - 1]?.group && <div className='text-xs text-void-fg-3 uppercase tracking-wide mt-4 mb-1'>{group}</div>}<div className='border border-void-border-2 bg-void-bg-1 py-3 px-4 rounded-sm my-2 group'>
				<div className='flex items-center justify-between gap-4'>
					<div className='flex flex-col gap-1 min-w-0'>
						<div className='text-sm font-medium text-void-fg-1'>{name}</div>
						{description && <div className='text-xs text-void-fg-3'>{description}</div>}
						{homepage && <div className='text-xs text-void-fg-3 truncate select-text'>
							<ChatMarkdownRender string={`[${homepage.replace(/^https?:\/\//, '')}](${homepage})`} chatMessageLocation={undefined} />
						</div>}
					</div>

					<div className='flex items-center gap-3 shrink-0'>
						{framework && <button
							className='text-xs text-void-fg-3 hover:brightness-110'
							onClick={() => setEditingId(editingId === id ? null : id)}
						>
							{editingId === id ? 'Hide' : 'Edit'}
						</button>}
						{framework && sourceURL && <button
							disabled={isDownloading}
							onClick={() => download({ id, name, sourceURL })}
							data-tooltip-id='void-tooltip'
							data-tooltip-place='top'
							data-tooltip-content='Download it again (replaces your edits)'
						>
							{isDownloading ? <Loader2 className='size-3 animate-spin text-void-fg-3' /> : <RefreshCw className='size-3 text-void-fg-3' />}
						</button>}
						{!framework && isDownloading && <Loader2 className='size-3 animate-spin text-void-fg-3' />}
						<VoidSwitch
							size='xs'
							value={!!framework?.isOn}
							disabled={isDownloading}
							onChange={(isOn) => {
								// Kodia's frameworks are downloaded the first time they're turned on
								if (!framework) download({ id, name, sourceURL })
								else changeFramework(id, { isOn })
							}}
						/>
						{!isBuiltin && <button
							onClick={() => {
								const current = voidSettingsService.state.globalSettings.instructionsFrameworks
								voidSettingsService.setGlobalSetting('instructionsFrameworks', current.filter(f => f.id !== id))
							}}
							data-tooltip-id='void-tooltip'
							data-tooltip-place='top'
							data-tooltip-content='Delete'
							className='opacity-0 group-hover:opacity-100 transition-opacity'
						>
							<X size={12} className='text-void-fg-3' />
						</button>}
					</div>
				</div>

				{error && <WarningBox className='mt-2' text={error} />}

				{framework && editingId === id && <VoidInputBox2
					key={`${id}-${editorKey}`}
					className='min-h-[81px] max-h-[400px] p-3 rounded-sm mt-3'
					initValue={framework.content}
					placeholder='The instructions to give the AI.'
					multiline
					onChangeText={(content) => changeFramework(id, { content })}
				/>}
			</div></React.Fragment>
		})}

		{isAddOpen ? <div className='mt-4'>
			<form className='flex items-center gap-2' onSubmit={(e) => { e.preventDefault(); if (newName.trim() && !isAdding) onAdd() }}>
				<VoidSimpleInputBox
					value={newName}
					compact={true}
					onChangeValue={setNewName}
					placeholder='Name'
					className='max-w-40'
				/>
				<VoidSimpleInputBox
					value={newURL}
					compact={true}
					onChangeValue={setNewURL}
					placeholder='GitHub or raw file link (empty to write it)'
				/>
				<AddButton type='submit' disabled={!newName.trim() || isAdding} text={isAdding ? <Loader2 className='size-4 animate-spin' /> : 'Add'} />
				<button
					type='button'
					onClick={() => {
						setIsAddOpen(false)
						setAddError('')
						setNewName('')
						setNewURL('')
					}}
					className='text-void-fg-4'
				>
					<X className='size-4' />
				</button>
			</form>
			{addError && <WarningBox className='mt-2' text={addError} />}
		</div>
			: <div className='mt-4'>
				<AddRowButton text='Add a framework or instructions' onClick={() => setIsAddOpen(true)} />
			</div>}
	</div>
}

// The agent's notes on the open project (.kodia/memory.md), kept across sessions
const ProjectMemory = () => {
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const notificationService = accessor.get('INotificationService')
	const projectMemoryService = accessor.get('IProjectMemoryService')
	const workspaceName = accessor.get('IWorkspaceContextService').getWorkspace().folders[0]?.name

	const [projectMemory, setProjectMemory] = useState(() => projectMemoryService.getMemory())
	const projectMemoryDraftRef = useRef(projectMemory)
	const [boxKey, setBoxKey] = useState(0)
	useEffect(() => {
		// the file changed (agent, editor, git): show it, unless it's what this page just saved
		const d = projectMemoryService.onDidChange(() => {
			const memory = projectMemoryService.getMemory()
			if (memory === projectMemoryDraftRef.current) return
			projectMemoryDraftRef.current = memory
			setProjectMemory(memory)
			setBoxKey(k => k + 1) // remount the box with the new text
		})
		return () => d.dispose()
	}, [projectMemoryService])

	return <>
		<div className='text-void-fg-3 text-xs'>
			{`Showing the memory of the open project only: ${workspaceName ? `"${workspaceName}"` : 'this workspace'}. Open another project to see or change its memory.`}
		</div>
		<ErrorBoundary>
			<VoidInputBox2
				key={`project-memory-${boxKey}`}
				className='min-h-[81px] p-3 rounded-sm'
				initValue={projectMemory}
				placeholder='No project memory stored yet.'
				multiline
				onChangeText={(newText) => {
					projectMemoryDraftRef.current = newText
				}}
				onBlur={() => { // saved when leaving the box, not on every keystroke (it's a file)
					const draft = projectMemoryDraftRef.current
					if (draft === projectMemory) return
					setProjectMemory(draft)
					projectMemoryService.setMemory(draft).catch(e => notificationService.error(`Could not save the project memory: ${e}`))
				}}
			/>
		</ErrorBoundary>
		<div className='flex items-center gap-x-2'>
			{projectMemoryService.memoryFileURI() && <VoidButtonBgDarken
				className='px-4 py-1'
				onClick={() => commandService.executeCommand('vscode.open', projectMemoryService.memoryFileURI())}
			>
				Open {PROJECT_MEMORY_FILE_PATH}
			</VoidButtonBgDarken>}
			<ConfirmButton
				className='px-4 py-1'
				confirmText='Confirm Delete'
				onConfirm={() => {
					projectMemoryDraftRef.current = ''
					setProjectMemory('')
					setBoxKey(k => k + 1)
					projectMemoryService.setMemory('').catch(e => notificationService.error(`Could not delete the project memory: ${e}`))
				}}
			>
				Delete Project Memory
			</ConfirmButton>
		</div>
	</>
}

export const InstructionsSection = () => {
	return <SettingsSection title='Instructions & Context' description='What Kodia tells the AI besides your messages: your instructions, the guidelines you turned on, and what the agent remembers about the project.'>
		<SettingGroup title='Instructions' description='Your instructions, sent with every request.'>
			<ErrorBoundary>
				<AIInstructionsBox />
			</ErrorBoundary>
		</SettingGroup>

		<SettingGroup title='Rules files' description={<ChatMarkdownRender inPTag={true} string={`The project's instructions: Kodia reads \`.voidrules\`, \`AGENTS.md\`, \`CLAUDE.md\`, \`.cursorrules\` and \`.windsurfrules\` at the root of your workspace, and sends them with every request.`} chatMessageLocation={undefined} />}>
			<ErrorBoundary>
				<RulesFiles />
			</ErrorBoundary>
		</SettingGroup>

		<SettingGroup title='Frameworks' description={`Ready-made guidelines added to your instructions while they're on. Kodia downloads a framework when you turn it on or add it, then keeps its text: edit it, or download it again to update it.`}>
			<ErrorBoundary>
				<InstructionsFrameworks />
			</ErrorBoundary>
		</SettingGroup>

		<SettingGroup title='Skills' description={<ChatMarkdownRender inPTag={true} string={`Instructions for specific tasks, each in a folder with a \`SKILL.md\` (in \`.kodia/skills\`, \`.claude/skills\` or \`.agents/skills\` of your workspace, or \`~/.claude/skills\`, \`~/.agents/skills\`). In Agent and Gather modes, the chat gets each skill's name and description, and the agent reads a skill when a task matches it.`} chatMessageLocation={undefined} />}>
			<ErrorBoundary>
				<Skills />
			</ErrorBoundary>
		</SettingGroup>

		<SettingGroup title='Project memory' description={`Notes the agent keeps across sessions (with write_project_memory), in ${PROJECT_MEMORY_FILE_PATH} in the project: commit it to share it with your team, or add it to .gitignore.`}>
			<ProjectMemory />
		</SettingGroup>

		<SettingGroup title='Advanced'>
			<GlobalSettingSwitch
				settingName='disableSystemMessage'
				label='Send only my instructions as the system message'
				description={`When on, the system message holds only your instructions, the frameworks you turned on, the project's rules files and its memory: Kodia's own instructions, the overview of your files and the list of skills are left out.`}
			/>
		</SettingGroup>
	</SettingsSection>
}
