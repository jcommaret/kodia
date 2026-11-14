/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ProviderName, SettingName, displayInfoOfSettingName, providerNames, VoidStatefulModelInfo, customSettingNamesOfProvider, RefreshableProviderName, refreshableProviderNames, displayInfoOfProviderName, nonlocalProviderNames, ollamaProviderNames, mlxProviderNames, otherLocalProviderNames, isProviderNameDisabled, subTextMdOfProviderName } from '../../../../common/voidSettingsTypes.js'
import { os } from '../../../../common/helpers/systemInfo.js'
import { KODIA_REPO_URL } from '../../../../common/kodiaLinks.js'
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js'
import { VoidButtonBgDarken, VoidCustomDropdownBox, VoidSimpleInputBox, VoidSwitch } from '../util/inputs.js'
import { useAccessor, useRefreshModelListener, useRefreshModelState, useSettingsState } from '../util/services.js'
import { X, RefreshCw, Loader2, Check, Asterisk, Plus } from 'lucide-react'
import { ChatMarkdownRender } from '../markdown/ChatMarkdownRender.js'
import { WarningBox } from './WarningBox.js'
import { getModelCapabilities, StoredModelOverrides } from '../../../../common/modelCapabilities.js';
import { parseModelOverridesText, systemMessageOptions, toolFormatOptions } from '../../../../common/helpers/modelOverridesInput.js';
import { isFreeOpenRouterModel } from '../../../../common/openRouterModels.js';
import { AddButton, AddRowButton, AnimatedCheckmarkButton, GlobalSettingSwitch, SettingGroup, SettingsSection, SettingSwitch } from './SettingsControls.js'

const ButtonLeftTextRightOption = ({ text, leftButton }: { text: string, leftButton?: React.ReactNode }) => {

	return <div className='flex items-center text-void-fg-3 px-3 py-0.5 rounded-sm overflow-hidden gap-2'>
		{leftButton ? leftButton : null}
		<span>
			{text}
		</span>
	</div>
}

// models
const RefreshModelButton = ({ providerName }: { providerName: RefreshableProviderName }) => {

	const refreshModelState = useRefreshModelState()

	const accessor = useAccessor()
	const refreshModelService = accessor.get('IRefreshModelService')
	const metricsService = accessor.get('IMetricsService')

	const [justFinished, setJustFinished] = useState<null | 'finished' | 'error'>(null)

	useRefreshModelListener(
		useCallback((providerName2, refreshModelState) => {
			if (providerName2 !== providerName) return
			const { state } = refreshModelState[providerName]
			if (!(state === 'finished' || state === 'error')) return
			// now we know we just entered 'finished' state for this providerName
			setJustFinished(state)
			const tid = setTimeout(() => { setJustFinished(null) }, 2000)
			return () => clearTimeout(tid)
		}, [providerName])
	)

	const { state } = refreshModelState[providerName]

	const { title: providerTitle } = displayInfoOfProviderName(providerName)

	return <ButtonLeftTextRightOption

		leftButton={
			<button
				className='flex items-center'
				disabled={state === 'refreshing' || justFinished !== null}
				onClick={() => {
					refreshModelService.startRefreshingModels(providerName, { enableProviderOnSuccess: false, doNotFire: false })
					metricsService.capture('Click', { providerName, action: 'Refresh Models' })
				}}
			>
				{justFinished === 'finished' ? <Check className='stroke-green-500 size-3' />
					: justFinished === 'error' ? <X className='stroke-red-500 size-3' />
						: state === 'refreshing' ? <Loader2 className='size-3 animate-spin' />
							: <RefreshCw className='size-3' />}
			</button>
		}

		text={justFinished === 'finished' ? `${providerTitle} Models are up-to-date!`
			: justFinished === 'error' ? `${providerTitle} not found!`
				: `Manually refresh ${providerTitle} models.`}
	/>
}

const RefreshableModels = ({ providerNamesFilter }: { providerNamesFilter?: readonly ProviderName[] }) => {
	const settingsState = useSettingsState()
	const names = providerNamesFilter
		? providerNamesFilter.filter((p): p is RefreshableProviderName => (refreshableProviderNames as readonly string[]).includes(p))
		: refreshableProviderNames

	const buttons = names.map(providerName => {
		if (!settingsState.settingsOfProvider[providerName]._didFillInProviderSettings) return null
		return <RefreshModelButton key={providerName} providerName={providerName} />
	})

	return <>
		{buttons}
	</>

}

// ---------------- Model Settings Dialog ------------------

const toolFormatLabel = (format: (typeof toolFormatOptions)[number] | undefined) =>
	format === 'openai-style' ? 'Native (OpenAI format)'
		: format === 'anthropic-style' ? 'Native (Anthropic format)'
			: format === 'gemini-style' ? 'Native (Gemini format)'
				: 'None: tools are described in the prompt (XML)'

const systemMessageLabel = (option: (typeof systemMessageOptions)[number]) =>
	option === 'system-role' ? 'System role'
		: option === 'developer-role' ? 'Developer role'
			: option === 'separated' ? 'Separate field'
				: 'Not supported: sent as a user message'

const OverrideRow = ({ label, detail, isChanged, children }: { label: string, detail: string, isChanged: boolean, children: React.ReactNode }) => {
	return <div className='flex items-center justify-between gap-4 py-1.5'>
		<div className='min-w-0'>
			<div className='text-sm text-void-fg-1'>{label}{isChanged ? <span className='text-void-fg-3'> · changed</span> : null}</div>
			<div className='text-xs text-void-fg-3'>{detail}</div>
		</div>
		<div className='shrink-0'>{children}</div>
	</div>
}

const overrideInputClassName = 'w-56 py-1 px-2 rounded-sm border border-void-border-2 text-sm'
// VS Code styles bare inputs and selects itself: the theme's input colors have to be set on the element
const overrideInputStyle: React.CSSProperties = { background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)' }

// The form and the JSON box show the same overrides: the JSON text is the state, and the form reads and rewrites it.
const SimpleModelSettingsDialog = ({
	isOpen,
	onClose,
	modelInfo,
}: {
	isOpen: boolean;
	onClose: () => void;
	modelInfo: { modelName: string; providerName: ProviderName; type: 'autodetected' | 'custom' | 'default' } | null;
}) => {
	if (!isOpen || !modelInfo) return null;

	const { modelName, providerName, type } = modelInfo;
	const accessor = useAccessor()
	const settingsState = useSettingsState()
	const mouseDownInsideModal = useRef(false); // Ref to track mousedown origin
	const settingsStateService = accessor.get('IVoidSettingsService')

	// what Kodia does without overrides
	const defaults = getModelCapabilities(providerName, modelName, undefined);
	const { recognizedModelName, isUnrecognizedModel } = defaults
	const storedOverrides = settingsState.overridesOfModel?.[providerName]?.[modelName];
	const textOf = (overrides: StoredModelOverrides | undefined) => overrides && Object.keys(overrides).length ? JSON.stringify(overrides, null, 2) : ''

	const [jsonText, setJsonText] = useState<string>(() => textOf(storedOverrides));
	const [showJson, setShowJson] = useState(false);

	// reset when the dialog opens on another model
	useEffect(() => {
		if (!isOpen) return;
		setJsonText(textOf(settingsState.overridesOfModel?.[providerName]?.[modelName]));
	}, [isOpen, providerName, modelName]);

	const parsed = parseModelOverridesText(jsonText)
	const overrides: StoredModelOverrides = parsed.error === undefined ? parsed.overrides : {}
	const isFormDisabled = parsed.error !== undefined

	// a value equal to Kodia's default isn't stored, so the model keeps following the catalog for it
	const setOverride = <K extends keyof StoredModelOverrides>(key: K, value: StoredModelOverrides[K], defaultValue: unknown) => {
		const next: StoredModelOverrides = { ...overrides }
		if (value === undefined || value === (defaultValue ?? null) || value === defaultValue) delete next[key]
		else next[key] = value
		setJsonText(textOf(next))
	}

	const contextWindow = overrides.contextWindow ?? defaults.contextWindow
	const reservedOutput = overrides.reservedOutputTokenSpace ?? defaults.reservedOutputTokenSpace
	const toolFormat = 'specialToolFormat' in overrides ? overrides.specialToolFormat ?? null : defaults.specialToolFormat ?? null
	const systemMessage = overrides.supportsSystemMessage ?? defaults.supportsSystemMessage
	const supportsVision = overrides.supportsVision ?? !!defaults.supportsVision
	const supportsFIM = overrides.supportsFIM ?? defaults.supportsFIM

	const numberOf = (text: string) => { const n = Number(text); return text.trim() && Number.isInteger(n) && n > 0 ? n : undefined }

	const onSave = async () => {
		if (parsed.error !== undefined) return
		await settingsStateService.setOverridesOfModel(providerName, modelName, Object.keys(parsed.overrides).length ? parsed.overrides : undefined);
		onClose();
	};

	const sourcecodeOverridesLink = `${KODIA_REPO_URL}/blob/master/src/vs/workbench/contrib/void/common/modelCapabilities.ts`
	const numChanged = Object.keys(overrides).length

	return (
		<div // Backdrop
			className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999999]"
			onMouseDown={() => {
				mouseDownInsideModal.current = false;
			}}
			onMouseUp={() => {
				if (!mouseDownInsideModal.current) {
					onClose();
				}
				mouseDownInsideModal.current = false;
			}}
		>
			{/* MODAL */}
			<div
				className="bg-void-bg-1 rounded-md p-4 max-w-xl w-full shadow-xl overflow-y-auto max-h-[90vh]"
				onClick={(e) => e.stopPropagation()} // Keep stopping propagation for normal clicks inside
				onMouseDown={(e) => {
					mouseDownInsideModal.current = true;
					e.stopPropagation();
				}}
			>
				<div className="flex justify-between items-center mb-4">
					<h3 className="text-lg font-medium">
						Capabilities of {modelName} ({displayInfoOfProviderName(providerName).title})
					</h3>
					<button
						onClick={onClose}
						className="text-void-fg-3 hover:text-void-fg-1"
					>
						<X className="size-5" />
					</button>
				</div>

				{/* Display model recognition status */}
				<div className="text-sm text-void-fg-3 mb-4">
					{type === 'default' ? `${modelName} comes packaged with Kodia, so you shouldn't need to change these settings.`
						: isUnrecognizedModel
							? `Kodia doesn't know this model, so the values below are cautious guesses. Set the context window and the tool calling your server gives it.`
							: recognizedModelName === modelName
								? `Kodia knows ${modelName}.`
								: `Kodia treats ${modelName} as "${recognizedModelName}".`}
				</div>

				<div className={`mb-3 ${isFormDisabled ? 'opacity-50 pointer-events-none' : ''}`}>
					<OverrideRow label='Context window' detail='Tokens the model reads at once. Older messages are trimmed to fit.' isChanged={'contextWindow' in overrides}>
						<input
							type='number' min={1} step={1}
							className={overrideInputClassName} style={overrideInputStyle}
							value={contextWindow}
							onChange={e => setOverride('contextWindow', numberOf(e.target.value), defaults.contextWindow)}
						/>
					</OverrideRow>

					<OverrideRow label='Output limit' detail='Tokens kept free in the window for the reply.' isChanged={'reservedOutputTokenSpace' in overrides}>
						<input
							type='number' min={1} step={1}
							className={overrideInputClassName} style={overrideInputStyle}
							value={reservedOutput ?? ''}
							placeholder='4096'
							onChange={e => setOverride('reservedOutputTokenSpace', numberOf(e.target.value), defaults.reservedOutputTokenSpace)}
						/>
					</OverrideRow>

					<OverrideRow label='Tool calling' detail='How the agent gives its tools to the model.' isChanged={'specialToolFormat' in overrides}>
						<select
							className={overrideInputClassName} style={overrideInputStyle}
							value={toolFormat ?? ''}
							onChange={e => setOverride('specialToolFormat', (e.target.value || null) as StoredModelOverrides['specialToolFormat'], defaults.specialToolFormat ?? null)}
						>
							{toolFormatOptions.map(option => <option key={option ?? ''} value={option ?? ''}>{toolFormatLabel(option)}</option>)}
						</select>
					</OverrideRow>

					<OverrideRow label='System message' detail='How instructions are sent to the model.' isChanged={'supportsSystemMessage' in overrides}>
						<select
							className={overrideInputClassName} style={overrideInputStyle}
							value={systemMessage === false ? '' : systemMessage}
							onChange={e => setOverride('supportsSystemMessage', (e.target.value || false) as StoredModelOverrides['supportsSystemMessage'], defaults.supportsSystemMessage)}
						>
							{systemMessageOptions.map(option => <option key={option || ''} value={option || ''}>{systemMessageLabel(option)}</option>)}
						</select>
					</OverrideRow>

					<OverrideRow label='Images' detail='The model accepts images in messages.' isChanged={'supportsVision' in overrides}>
						<VoidSwitch size='xs' value={supportsVision} onChange={value => setOverride('supportsVision', value, !!defaults.supportsVision)} />
					</OverrideRow>

					<OverrideRow label='Fill-in-the-middle' detail='The model was made for autocomplete.' isChanged={'supportsFIM' in overrides}>
						<VoidSwitch size='xs' value={supportsFIM} onChange={value => setOverride('supportsFIM', value, defaults.supportsFIM)} />
					</OverrideRow>
				</div>

				{/* the same overrides as JSON, with the settings the form doesn't show (reasoning, extra payload...) */}
				<button className='text-sm text-void-fg-3 hover:text-void-fg-1 mb-2' onClick={() => setShowJson(!showJson)}>
					{showJson ? 'Hide' : 'Show'} as JSON (advanced)
				</button>
				{showJson && <>
					<div className="text-sm text-void-fg-3 mb-2">
						<ChatMarkdownRender string={`Only what you change is listed. See the [source code](${sourcecodeOverridesLink}) for every setting, such as \`reasoningCapabilities\`.`} chatMessageLocation={undefined} />
					</div>
					<textarea
						className='w-full min-h-[160px] p-2 rounded-sm border border-void-border-2 resize-none font-mono text-sm' style={overrideInputStyle}
						value={jsonText}
						placeholder={'{\n  "contextWindow": 32000\n}'}
						onChange={e => setJsonText(e.target.value)}
					/>
				</>}
				{parsed.error !== undefined && (
					<div className="text-red-500 mt-2 text-sm">{parsed.error}</div>
				)}

				<div className="flex justify-between items-center gap-2 mt-4">
					<VoidButtonBgDarken onClick={() => setJsonText('')} className={`px-3 py-1 ${numChanged === 0 && parsed.error === undefined ? 'opacity-50 pointer-events-none' : ''}`}>
						Reset to Kodia's defaults
					</VoidButtonBgDarken>
					<div className="flex gap-2">
						<VoidButtonBgDarken onClick={onClose} className="px-3 py-1">
							Cancel
						</VoidButtonBgDarken>
						<VoidButtonBgDarken
							onClick={onSave}
							className={`px-3 py-1 bg-[#0e70c0] text-white ${parsed.error !== undefined ? 'opacity-50 pointer-events-none' : ''}`}
						>
							Save
						</VoidButtonBgDarken>
					</div>
				</div>
			</div>
		</div>
	);
};

export const ModelDump = ({ filteredProviders }: { filteredProviders?: ProviderName[] }) => {
	const accessor = useAccessor()
	const settingsStateService = accessor.get('IVoidSettingsService')
	const settingsState = useSettingsState()

	// State to track which model's settings dialog is open
	const [openSettingsModel, setOpenSettingsModel] = useState<{
		modelName: string,
		providerName: ProviderName,
		type: 'autodetected' | 'custom' | 'default'
	} | null>(null);

	// States for add model functionality
	const [isAddModelOpen, setIsAddModelOpen] = useState(false);
	const [showCheckmark, setShowCheckmark] = useState(false);
	const [userChosenProviderName, setUserChosenProviderName] = useState<ProviderName | null>(null);
	const [modelName, setModelName] = useState<string>('');
	const [errorString, setErrorString] = useState('');

	// a dump of all the enabled providers' models
	const modelDump: (VoidStatefulModelInfo & { providerName: ProviderName, providerEnabled: boolean })[] = []

	// Use either filtered providers or all providers
	const providersToShow = filteredProviders || providerNames;

	for (let providerName of providersToShow) {
		const providerSettings = settingsState.settingsOfProvider[providerName]
		// if (!providerSettings.enabled) continue
		modelDump.push(...providerSettings.models.map(model => ({ ...model, providerName, providerEnabled: !!providerSettings._didFillInProviderSettings })))
	}

	// sort by hidden
	modelDump.sort((a, b) => {
		return Number(b.providerEnabled) - Number(a.providerEnabled)
	})

	// Add model handler
	const handleAddModel = () => {
		if (!userChosenProviderName) {
			setErrorString('Please select a provider.');
			return;
		}
		if (!modelName) {
			setErrorString('Please enter a model name.');
			return;
		}

		// Check if model already exists
		if (settingsState.settingsOfProvider[userChosenProviderName].models.find(m => m.modelName === modelName)) {
			setErrorString(`This model already exists.`);
			return;
		}

		settingsStateService.addModel(userChosenProviderName, modelName);
		setShowCheckmark(true);
		setTimeout(() => {
			setShowCheckmark(false);
			setIsAddModelOpen(false);
			setUserChosenProviderName(null);
			setModelName('');
		}, 1500);
		setErrorString('');
	};

	return <div className=''>
		{modelDump.map((m, i) => {
			const { isHidden, type, modelName, providerName, providerEnabled } = m

			const isNewProviderName = (i > 0 ? modelDump[i - 1] : undefined)?.providerName !== providerName

			const providerTitle = displayInfoOfProviderName(providerName).title

			const disabled = !providerEnabled
			const value = disabled ? false : !isHidden

			const tooltipName = (
				disabled ? `Add ${providerTitle} to enable`
					: value === true ? 'Show in Dropdown'
						: 'Hide from Dropdown'
			)


			const detailAboutModel = type === 'autodetected' ?
				<Asterisk size={14} className="inline-block align-text-top brightness-115 stroke-[2] text-[#0e70c0]" data-tooltip-id='void-tooltip' data-tooltip-place='right' data-tooltip-content={providerName === 'openRouter' ? (modelName.endsWith(':free') ? 'Among OpenRouter\'s best free models for code (checked daily)' : 'Among OpenRouter\'s most used (checked daily)') : (nonlocalProviderNames as readonly string[]).includes(providerName) ? `In ${providerTitle}'s model list (checked daily)` : 'Detected locally'} />
				: type === 'custom' ?
					<Asterisk size={14} className="inline-block align-text-top brightness-115 stroke-[2] text-[#0e70c0]" data-tooltip-id='void-tooltip' data-tooltip-place='right' data-tooltip-content='Custom model' />
					: undefined

			const hasOverrides = !!settingsState.overridesOfModel?.[providerName]?.[modelName]

			// Kodia: OpenRouter's free models under a "Free" heading, and a line between them and the others
			const previous = i > 0 ? modelDump[i - 1] : undefined
			const isFree = isFreeOpenRouterModel(providerName, modelName)
			const previousIsFree = !isNewProviderName && !!previous && isFreeOpenRouterModel(previous.providerName, previous.modelName)
			const freeHeading = isFree && !previousIsFree
				? <div className='flex items-center gap-4 pt-1 px-3'>
					<span className='w-full max-w-32'>{isNewProviderName ? providerTitle : ''}</span>
					<span className='text-xs text-void-fg-3'>Free</span>
				</div>
				: null
			const separator = previousIsFree && !isFree
				? <div className='my-1 mx-3 border-t border-void-border-2' />
				: null

			return <React.Fragment key={`${modelName}${providerName}`}>{freeHeading}{separator}<div
				className={`flex items-center justify-between gap-4 hover:bg-black/10 dark:hover:bg-gray-300/10 py-1 px-3 rounded-sm overflow-hidden cursor-default truncate group
				`}
			>
				{/* left part is width:full */}
				<div className={`flex flex-grow items-center gap-4`}>
					<span className='w-full max-w-32'>{isNewProviderName && !freeHeading ? providerTitle : ''}</span>
					<span className='w-fit max-w-[400px] truncate'>{modelName}</span>
				</div>

				{/* right part is anything that fits */}
				<div className="flex items-center gap-2 w-fit">

					{/* Advanced Settings button (gear). Hide entirely when provider/model disabled. */}
					{disabled ? null : (
						<div className="w-5 flex items-center justify-center">
							<button
								onClick={() => { setOpenSettingsModel({ modelName, providerName, type }) }}
								data-tooltip-id='void-tooltip'
								data-tooltip-place='right'
								data-tooltip-content='Advanced Settings'
								className={`${hasOverrides ? '' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}
							>
								<Plus size={12} className="text-void-fg-3 opacity-50" />
							</button>
						</div>
					)}

					{/* Blue star */}
					{detailAboutModel}


					{/* Switch */}
					<VoidSwitch
						value={value}
						onChange={() => { settingsStateService.toggleModelHidden(providerName, modelName); }}
						disabled={disabled}
						size='sm'

						data-tooltip-id='void-tooltip'
						data-tooltip-place='right'
						data-tooltip-content={tooltipName}
					/>

					{/* X button */}
					<div className={`w-5 flex items-center justify-center`}>
						{type === 'default' || type === 'autodetected' ? null : <button
							onClick={() => { settingsStateService.deleteModel(providerName, modelName); }}
							data-tooltip-id='void-tooltip'
							data-tooltip-place='right'
							data-tooltip-content='Delete'
							className={`${hasOverrides ? '' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}
						>
							<X size={12} className="text-void-fg-3 opacity-50" />
						</button>}
					</div>
				</div>
			</div></React.Fragment>
		})}

		{/* Add Model Section */}
		{showCheckmark ? (
			<div className="mt-4">
				<AnimatedCheckmarkButton text='Added' className="bg-[#0e70c0] text-white px-3 py-1 rounded-sm" />
			</div>
		) : isAddModelOpen ? (
			<div className="mt-4">
				{/* Enter adds the model: without onSubmit, it would submit the form as a page navigation */}
				<form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); handleAddModel() }}>

					{/* Provider dropdown */}
					<ErrorBoundary>
						<VoidCustomDropdownBox
							options={providersToShow}
							selectedOption={userChosenProviderName}
							onChangeOption={(pn) => setUserChosenProviderName(pn)}
							getOptionDisplayName={(pn) => pn ? displayInfoOfProviderName(pn).title : 'Provider Name'}
							getOptionDropdownName={(pn) => pn ? displayInfoOfProviderName(pn).title : 'Provider Name'}
							getOptionsEqual={(a, b) => a === b}
							className="max-w-32 mx-2 w-full resize-none bg-void-bg-1 text-void-fg-1 placeholder:text-void-fg-3 border border-void-border-2 focus:border-void-border-1 py-1 px-2 rounded"
							arrowTouchesText={false}
						/>
					</ErrorBoundary>

					{/* Model name input */}
					<ErrorBoundary>
						<VoidSimpleInputBox
							value={modelName}
							compact={true}
							onChangeValue={setModelName}
							placeholder='Model Name'
							className='max-w-32'
						/>
					</ErrorBoundary>

					{/* Add button */}
					<ErrorBoundary>
						<AddButton
							type='submit'
							disabled={!modelName || !userChosenProviderName}
						/>
					</ErrorBoundary>

					{/* X button to cancel */}
					<button
						type="button"
						onClick={() => {
							setIsAddModelOpen(false);
							setErrorString('');
							setModelName('');
							setUserChosenProviderName(null);
						}}
						className='text-void-fg-4'
					>
						<X className='size-4' />
					</button>
				</form>

				{errorString && (
					<div className='text-red-500 truncate whitespace-nowrap mt-1'>
						{errorString}
					</div>
				)}
			</div>
		) : (
			<div className='mt-4'>
				<AddRowButton text='Add a model' onClick={() => setIsAddModelOpen(true)} />
			</div>
		)}

		{/* Model Settings Dialog */}
		<SimpleModelSettingsDialog
			isOpen={openSettingsModel !== null}
			onClose={() => setOpenSettingsModel(null)}
			modelInfo={openSettingsModel}
		/>
	</div>
}

// providers

// Whether a provider can be used: a cloud provider once its fields are filled in, a local server while it answers
// Kodia's polling. A poll first sets 'refreshing': the last answer stays shown meanwhile.
const ProviderStatus = ({ providerName }: { providerName: ProviderName }) => {
	const settingsState = useSettingsState()
	const refreshModelState = useRefreshModelState()
	const lastAnswerRef = useRef<'finished' | 'error' | null>(null)
	const providerSettings = settingsState.settingsOfProvider[providerName]

	let isOk: boolean
	let label: string
	if ((refreshableProviderNames as readonly ProviderName[]).includes(providerName)) {
		const { state } = refreshModelState[providerName as RefreshableProviderName]
		if (state === 'finished' || state === 'error') lastAnswerRef.current = state
		const answer = state === 'refreshing' ? lastAnswerRef.current : state
		const modelCount = providerSettings.models.filter(m => m.type === 'autodetected').length
		isOk = answer === 'finished'
		label = answer === 'finished' ? `Running · ${modelCount} model${modelCount === 1 ? '' : 's'}`
			: answer === 'error' ? 'Not running'
				: answer === 'init' ? 'Not checked'
					: 'Checking...'
	}
	else {
		const needsAPIKey = customSettingNamesOfProvider(providerName).includes('apiKey')
		isOk = !!providerSettings._didFillInProviderSettings
		label = isOk ? 'Set up'
			: needsAPIKey && !(providerSettings as { apiKey?: string }).apiKey ? 'API key missing'
				: 'Not set up'
	}

	return <span className='inline-flex items-center gap-1.5 text-sm text-void-fg-3 shrink-0'>
		<span className={`size-1.5 rounded-full ${isOk ? 'bg-green-500' : 'bg-void-fg-4'}`} />
		{label}
	</span>
}

const ProviderSetting =({ providerName, settingName, subTextMd }: { providerName: ProviderName, settingName: SettingName, subTextMd: React.ReactNode }) => {

	const { title: settingTitle, placeholder, isPasswordField } = displayInfoOfSettingName(providerName, settingName)

	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const settingsState = useSettingsState()

	const settingValue = settingsState.settingsOfProvider[providerName][settingName] as string // this should always be a string in this component
	if (typeof settingValue !== 'string') {
		console.log('Error: Provider setting had a non-string value.')
		return
	}

	// Create a stable callback reference using useCallback with proper dependencies
	const handleChangeValue = useCallback((newVal: string) => {
		voidSettingsService.setSettingOfProvider(providerName, settingName, newVal)
	}, [voidSettingsService, providerName, settingName]);

	return <ErrorBoundary>
		<div className='my-1'>
			<VoidSimpleInputBox
				value={settingValue}
				onChangeValue={handleChangeValue}
				placeholder={`${settingTitle} (${placeholder})`}
				passwordBlur={isPasswordField}
				compact={true}
			/>
			{!subTextMd ? null : <div className='py-1 px-3 opacity-50 text-sm'>
				{subTextMd}
			</div>}
		</div>
	</ErrorBoundary>
}



export const SettingsForProvider = ({ providerName, showProviderTitle, showProviderSuggestions }: { providerName: ProviderName, showProviderTitle: boolean, showProviderSuggestions: boolean }) => {
	const voidSettingsState = useSettingsState()

	const needsModel = isProviderNameDisabled(providerName, voidSettingsState) === 'addModel'

	// const accessor = useAccessor()
	// const voidSettingsService = accessor.get('IVoidSettingsService')

	// const { enabled } = voidSettingsState.settingsOfProvider[providerName]
	const settingNames = customSettingNamesOfProvider(providerName)

	const { title: providerTitle } = displayInfoOfProviderName(providerName)

	return <div>

		<div className='flex items-center w-full gap-4'>
			{showProviderTitle && <h4 className='text-root font-medium truncate'>{providerTitle}</h4>}
			{showProviderTitle && <ProviderStatus providerName={providerName} />}

			{/* enable provider switch */}
			{/* <VoidSwitch
				value={!!enabled}
				onChange={
					useCallback(() => {
						const enabledRef = voidSettingsService.state.settingsOfProvider[providerName].enabled
						voidSettingsService.setSettingOfProvider(providerName, 'enabled', !enabledRef)
					}, [voidSettingsService, providerName])}
				size='sm+'
			/> */}
		</div>

		<div className='px-0'>
			{/* settings besides models (e.g. api key) */}
			{settingNames.map((settingName, i) => {

				return <ProviderSetting
					key={settingName}
					providerName={providerName}
					settingName={settingName}
					subTextMd={i !== settingNames.length - 1 ? null
						: <ChatMarkdownRender string={subTextMdOfProviderName(providerName)} chatMessageLocation={undefined} />}
				/>
			})}

			{showProviderSuggestions && needsModel ?
				providerName === 'ollama' ?
					<WarningBox className="pl-2 mb-4" text={`Please install an Ollama model. We'll auto-detect it.`} />
					: (providerName === 'mlx' || providerName === 'lmStudio' || providerName === 'vLLM') ?
						<WarningBox className="pl-2 mb-4" text={`Start your local server — Kodia will auto-detect models at the endpoint.`} />
						: <WarningBox className="pl-2 mb-4" text={`Please add a model for ${providerTitle} (Models section).`} />
				: null}
		</div>
	</div >
}


const AutoDetectLocalModelsToggle = () => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const metricsService = accessor.get('IMetricsService')
	const enabled = useSettingsState().globalSettings.autoRefreshModels

	return <SettingSwitch
		value={enabled}
		onChange={(newVal) => {
			voidSettingsService.setGlobalSetting('autoRefreshModels', newVal)
			metricsService.capture('Click', { action: 'Autorefresh Toggle', settingName: 'autoRefreshModels', enabled: newVal })
		}}
		label={`Detect local servers and their models (${refreshableProviderNames.map(providerName => displayInfoOfProviderName(providerName).title).join(', ')})`}
	/>
}

const AutoSetupMlxToggle = () => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const metricsService = accessor.get('IMetricsService')
	const enabled = useSettingsState().globalSettings.autoSetupMlx

	return <SettingSwitch
		value={enabled}
		onChange={(newVal) => {
			voidSettingsService.setGlobalSetting('autoSetupMlx', newVal)
			metricsService.capture('Click', { action: 'MLX Auto-Setup Toggle', settingName: 'autoSetupMlx', enabled: newVal })
		}}
		label='Set up MLX for me: install mlx-lm if needed, start mlx_lm.server, and detect its model'
	/>
}

export const OllamaSetupInstructions = ({ sayWeAutoDetect }: { sayWeAutoDetect?: boolean }) => {
	return <div className='prose-p:my-0 prose-ol:list-decimal prose-p:py-0 prose-ol:my-0 prose-ol:py-0 prose-span:my-0 prose-span:py-0 text-void-fg-3 text-sm list-decimal select-text'>
		<div className=''><ChatMarkdownRender string={`Ollama Setup Instructions`} chatMessageLocation={undefined} /></div>
		<div className=' pl-6'><ChatMarkdownRender string={`1. Download [Ollama](https://ollama.com/download).`} chatMessageLocation={undefined} /></div>
		<div className=' pl-6'><ChatMarkdownRender string={`2. Open your terminal.`} chatMessageLocation={undefined} /></div>
		<div
			className='pl-6 flex items-center w-fit'
			data-tooltip-id='void-tooltip-ollama-settings'
		>
			<ChatMarkdownRender string={`3. Run \`ollama pull your_model\` to install a model.`} chatMessageLocation={undefined} />
		</div>
		{sayWeAutoDetect && <div className=' pl-6'><ChatMarkdownRender string={`Kodia automatically detects locally running models and enables them.`} chatMessageLocation={undefined} /></div>}
	</div>
}

export const MlxSetupInstructions = () => {
	return <div className='prose-p:my-0 prose-ol:list-decimal prose-p:py-0 prose-ol:my-0 prose-ol:py-0 text-void-fg-3 text-sm list-decimal select-text mb-4'>
		<div><ChatMarkdownRender string={`MLX (one model loaded at a time)`} chatMessageLocation={undefined} /></div>
		<div className='pl-6'><ChatMarkdownRender string={`1. Kodia can run \`pip install mlx-lm\` and start \`mlx_lm.server\` for you (toggle in Settings → Models), with the newest mlx-lm of your Mac. Default model: \`mlx-community/Qwen2.5-Coder-1.5B-Instruct-4bit\` on port 8080.`} chatMessageLocation={undefined} /></div>
		<div className='pl-6'><ChatMarkdownRender string={`2. Kodia lists the models of the server, which are those of your Hugging Face cache. The server loads the one you pick, and swaps it for another when you pick another: the first request of a model waits for it to load.`} chatMessageLocation={undefined} /></div>
		<div className='pl-6'><ChatMarkdownRender string={`3. A model that is too big for your memory, or too new for your mlx-lm, fails with the server's error: update with \`python3 -m pip install --upgrade mlx-lm\`.`} chatMessageLocation={undefined} /></div>
		<div className='pl-6'><ChatMarkdownRender string={`4. **Second model in parallel**: run another server on a different port (e.g. \`mlx_lm.server --model … --port 8081\`), then at the bottom of the model list use **Add Model** → **OpenAI-Compatible** with \`http://127.0.0.1:8081/v1\`.`} chatMessageLocation={undefined} /></div>
	</div>
}

type LocalServerInfo = { id: string, title: string, description: string, instructions?: React.ReactNode, autoSetup?: React.ReactNode, providerNames: readonly ProviderName[] }

// The servers Kodia detects on the user's computer, in the settings and the onboarding (MLX runs on macOS only)
export const localServers: readonly LocalServerInfo[] = [
	{
		id: 'ollama',
		title: 'Ollama',
		description: 'Runs open models on your computer.',
		instructions: <OllamaSetupInstructions sayWeAutoDetect={true} />,
		providerNames: ollamaProviderNames,
	},
	...(os === 'mac' ? [{
		id: 'mlx',
		title: 'MLX',
		description: `Apple's framework for running models on Apple silicon, served by mlx_lm.server.`,
		autoSetup: <AutoSetupMlxToggle />,
		instructions: <MlxSetupInstructions />,
		providerNames: mlxProviderNames,
	}] : []),
	{
		id: 'other',
		title: 'vLLM and LM Studio',
		description: 'OpenAI-compatible servers running on your computer.',
		providerNames: otherLocalProviderNames,
	},
]

// A server on the user's computer: how to set it up, its endpoint, and a refresh of its models
export const LocalServer = ({ server: { title, description, instructions, autoSetup, providerNames } }: { server: LocalServerInfo }) => {
	return <div className='flex flex-col gap-2'>
		<div className='flex items-center gap-4'>
			<h4 className='text-root font-medium'>{title}</h4>
			{providerNames.length === 1 && <ProviderStatus providerName={providerNames[0]} />}
		</div>
		<div className='text-sm text-void-fg-3'>{description}</div>
		{autoSetup}
		{instructions}
		<RefreshableModels providerNamesFilter={providerNames} />
		{providerNames.map(providerName =>
			<SettingsForProvider key={providerName} providerName={providerName} showProviderTitle={providerNames.length > 1} showProviderSuggestions={true} />
		)}
	</div>
}

export const ModelsSection = () => {
	return <SettingsSection title='Models' description='The models Kodia can use, from a provider with an API key or from a server running on your computer.'>
		<SettingGroup title='Available models' description={`The models that are on appear in Kodia's model menus. A model can't be turned on until its provider is set up below.`}>
			<ModelDump />
			<AutoDetectLocalModelsToggle />
		</SettingGroup>

		<SettingGroup title='Cloud providers' description={`Add a provider's API key to use its models.`}>
			{nonlocalProviderNames.map(providerName => <div key={providerName}>
				<SettingsForProvider providerName={providerName} showProviderTitle={true} showProviderSuggestions={true} />
				{providerName === 'anthropic' && <div className='mt-2 mb-2'>
					<GlobalSettingSwitch
						settingName='oneHourPromptCache'
						label={`Keep Claude's prompt cache for 1 hour`}
						description={`Claude keeps a thread cached for 5 minutes: a reply after that pays the full input price again. With 1 hour, writing the cache costs 2× the input price instead of 1.25×, which pays off from 3 requests.`}
					/>
				</div>}
			</div>)}
		</SettingGroup>

		<SettingGroup title='Local servers' description='Models running on your computer: free, and your code stays on your machine.'>
			{localServers.map(server => <LocalServer key={server.id} server={server} />)}
		</SettingGroup>
	</SettingsSection>
}
