/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { useAccessor, useIsDark, useSettingsState } from '../util/services.js';
import { Check, ChevronRight } from 'lucide-react';
import { displayInfoOfProviderName, ProviderName, nonlocalProviderNames, isFeatureNameDisabled } from '../../../../common/voidSettingsTypes.js';
import { SettingsForProvider, ModelDump, LocalServer, localServers } from '../void-settings-tsx/ModelsSettings.js';
import { OneClickSwitchButton } from '../void-settings-tsx/GeneralSettings.js';
import { SettingGroup } from '../void-settings-tsx/SettingsControls.js';
import { VoidCustomDropdownBox } from '../util/inputs.js';
import { ColorScheme } from '../../../../../../../platform/theme/common/theme.js';
import { IWorkbenchColorTheme } from '../../../../../../../workbench/services/themes/common/workbenchThemeService.js';
import { FileAccess } from '../../../../../../../base/common/network.js';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js';
import { isLinux } from '../../../../../../../base/common/platform.js';

const OVERRIDE_VALUE = false

export const VoidOnboarding = () => {

	const voidSettingsState = useSettingsState()
	const isOnboardingComplete = voidSettingsState.globalSettings.isOnboardingComplete || OVERRIDE_VALUE

	const isDark = useIsDark()

	return (
		<div className={`@@void-scope ${isDark ? 'dark' : ''}`}>
			<div
				className={`
					bg-void-bg-3 fixed top-0 right-0 bottom-0 left-0 width-full z-[99999]
					transition-all duration-1000 ${isOnboardingComplete ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto'}
				`}
				style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
			>
				<ErrorBoundary>
					<VoidOnboardingContent />
				</ErrorBoundary>
			</div>
		</div>
	)
}

// Kodia's cube, the logo of the empty window's welcome screen
const cubeURL = FileAccess.asBrowserUri('vs/workbench/browser/parts/editor/media/void_cube_noshadow.png').toString(true)

const VoidIcon = () => {
	const themeService = useAccessor().get('IThemeService')
	const [isDark, setIsDark] = useState(true)

	useEffect(() => {
		const updateTheme = () => {
			const theme = themeService.getColorTheme().type
			setIsDark(theme === ColorScheme.DARK || theme === ColorScheme.HIGH_CONTRAST_DARK)
		}
		updateTheme()
		const d = themeService.onDidColorThemeChange(updateTheme)
		return () => d.dispose()
	}, [themeService])

	return <div
		className='w-[200px] max-w-full aspect-square'
		style={{ backgroundImage: `url('${cubeURL}')`, backgroundSize: 'contain', backgroundRepeat: 'no-repeat', backgroundPosition: 'center', opacity: 0.5, filter: isDark ? '' : 'invert(1)' }}
	/>
}

const FADE_DURATION_MS = 2000

const FadeIn = ({ children, className, delayMs = 0, durationMs, ...props }: { children: React.ReactNode, delayMs?: number, durationMs?: number, className?: string } & React.HTMLAttributes<HTMLDivElement>) => {

	const [opacity, setOpacity] = useState(0)

	const effectiveDurationMs = durationMs ?? FADE_DURATION_MS

	useEffect(() => {

		const timeout = setTimeout(() => {
			setOpacity(1)
		}, delayMs)

		return () => clearTimeout(timeout)
	}, [setOpacity, delayMs])


	return (
		<div className={className} style={{ opacity, transition: `opacity ${effectiveDurationMs}ms ease-in-out` }} {...props}>
			{children}
		</div>
	)
}

const PrimaryActionButton = ({ children, className, ...props }: { children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
	return (
		<button
			type='button'
			className={`
				flex items-center justify-center gap-1 px-4 py-2
				text-white dark:text-black bg-black/90 dark:bg-white/90
				rounded-lg group transition-all duration-300 ease-in-out
				disabled:opacity-40 disabled:cursor-not-allowed
				${className ?? ''}
			`}
			{...props}
		>
			{children}
			<ChevronRight className='transition-all duration-300 ease-in-out transform group-hover:translate-x-1 group-active:translate-x-1' />
		</button>
	)
}

const TextButton = ({ children, ...props }: { children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
	return <button type='button' className='px-4 py-2 rounded text-void-fg-3 hover:brightness-125 transition-all' {...props}>{children}</button>
}

// Buttons to pick one option among a few, with a check on the ones already set up
const Choices = <T extends string>({ options, selected, onSelect, labelOf, isDone }: { options: readonly T[], selected: T, onSelect: (option: T) => void, labelOf: (option: T) => string, isDone?: (option: T) => boolean }) => {
	return <div className='flex flex-wrap gap-2'>
		{options.map(option => <button
			key={option}
			type='button'
			onClick={() => onSelect(option)}
			className={`flex items-center gap-1 py-1 px-3 rounded-md text-root transition-all duration-200 ${option === selected
				? 'bg-[#0e70c0]/80 text-white'
				: 'bg-void-bg-2 hover:bg-void-bg-2/80 text-void-fg-1'}`}
		>
			{isDone?.(option) && <Check className='size-3' />}
			{labelOf(option)}
		</button>)}
	</div>
}


// Onboarding: a welcome page, then each setup step in the same layout

const steps = ['model', 'import'] as const
type StepName = typeof steps[number]

// A setup step: where it is in the onboarding, what it's for, then its content, and the buttons always at the bottom
const OnboardingStep = ({ stepName, title, description, children, footerLeft, footerRight }: { stepName: StepName, title: string, description: string, children: React.ReactNode, footerLeft: React.ReactNode, footerRight: React.ReactNode }) => {
	return <div className='flex flex-col w-full max-w-[720px] h-[85vh] mx-auto px-6'>
		<header className='pt-10 pb-6'>
			<div className='text-sm text-void-fg-3 uppercase tracking-wide'>{`Step ${steps.indexOf(stepName) + 1} of ${steps.length}`}</div>
			<h1 className='text-4xl font-light mt-2'>{title}</h1>
			<div className='text-root text-void-fg-3 mt-2'>{description}</div>
		</header>
		<div className='flex-1 overflow-y-auto pr-2 flex flex-col gap-8'>
			{children}
		</div>
		<footer className='flex items-center justify-between gap-4 pt-6 pb-8'>
			<div>{footerLeft}</div>
			<div className='flex items-center gap-2'>{footerRight}</div>
		</footer>
	</div>
}

// The model the chat uses, or what to do to get one
const ChatModelStatus = () => {
	const settingsState = useSettingsState()
	const selection = settingsState.modelSelectionOfFeature['Chat']
	if (isFeatureNameDisabled('Chat', settingsState) || !selection) {
		return <div className='text-root text-void-fg-3'>No model yet: add a provider&apos;s API key, or start a server on your computer.</div>
	}
	return <div className='flex items-center gap-2 text-root text-void-fg-2'>
		<Check className='size-4 text-emerald-500 shrink-0' />
		<span>Chat model: <span className='text-void-fg-1'>{selection.modelName}</span> ({displayInfoOfProviderName(selection.providerName).title}). Kodia&apos;s other features use a model too: change any of them later in Settings, under Features.</span>
	</div>
}

type ModelSource = 'cloud' | 'local'

// A provider with an API key, or a server on the user's computer, as in Settings › Models
const ChooseModel = () => {
	const settingsState = useSettingsState()
	const chatProviderName = settingsState.modelSelectionOfFeature['Chat']?.providerName

	// start where the chat model comes from, if there's one already (a local server Kodia detected...)
	const chatLocalServer = localServers.find(s => chatProviderName && s.providerNames.includes(chatProviderName))
	const [source, setSource] = useState<ModelSource>(chatLocalServer ? 'local' : 'cloud')
	const [cloudProviderName, setCloudProviderName] = useState<ProviderName>(!chatLocalServer && chatProviderName ? chatProviderName : 'anthropic')
	const [localServerId, setLocalServerId] = useState(chatLocalServer?.id ?? localServers[0].id)

	// a provider with its API key in; a server once Kodia found one of its models (its endpoint is filled in from the start)
	const isSetUp = (providerName: ProviderName) => !!settingsState.settingsOfProvider[providerName]._didFillInProviderSettings
	const isRunning = (providerName: ProviderName) => settingsState.settingsOfProvider[providerName].models.length > 0
	const localServer = localServers.find(s => s.id === localServerId) ?? localServers[0]

	return <>
		<ChatModelStatus />

		<Choices<ModelSource>
			options={['cloud', 'local']}
			selected={source}
			onSelect={setSource}
			labelOf={s => s === 'cloud' ? 'A provider (API key)' : 'A server on your computer'}
		/>

		{source === 'cloud' ? <>
			<SettingGroup title='Provider'>
				<Choices
					options={nonlocalProviderNames}
					selected={cloudProviderName}
					onSelect={setCloudProviderName}
					labelOf={p => displayInfoOfProviderName(p).title}
					isDone={isSetUp}
				/>
				<SettingsForProvider providerName={cloudProviderName} showProviderTitle={false} showProviderSuggestions={true} />
			</SettingGroup>
			<SettingGroup title='Models' description={`The models that are on appear in Kodia's model menus.`}>
				<ModelDump filteredProviders={[cloudProviderName]} />
			</SettingGroup>
		</> : <>
			<SettingGroup title='Server'>
				<Choices
					options={localServers.map(s => s.id)}
					selected={localServer.id}
					onSelect={setLocalServerId}
					labelOf={id => localServers.find(s => s.id === id)?.title ?? id}
					isDone={id => !!localServers.find(s => s.id === id)?.providerNames.some(isRunning)}
				/>
				<LocalServer server={localServer} />
			</SettingGroup>
			<SettingGroup title='Models' description='Kodia detects the models of a running server. You can also add one by its name.'>
				<ModelDump filteredProviders={[...localServer.providerNames]} />
			</SettingGroup>
		</>}
	</>
}

const ThemeDropdown = () => {
	const themeService = useAccessor().get('IWorkbenchThemeService')
	const [themes, setThemes] = useState<IWorkbenchColorTheme[]>([])
	const [currentId, setCurrentId] = useState(() => themeService.getColorTheme().id)

	useEffect(() => {
		themeService.getColorThemes().then(setThemes)
		const d = themeService.onDidColorThemeChange(theme => setCurrentId(theme.id))
		return () => d.dispose()
	}, [themeService])

	const current = themes.find(t => t.id === currentId)
	if (!current) return null

	return <VoidCustomDropdownBox
		className='text-root text-void-fg-2 bg-void-bg-1 border border-void-border-1 rounded py-1 px-2 w-fit'
		options={themes}
		selectedOption={current}
		onChangeOption={(theme) => { themeService.setColorTheme(theme, 'auto') }}
		getOptionDisplayName={(theme) => theme.label}
		getOptionDropdownName={(theme) => theme.label}
		getOptionsEqual={(a, b) => a.id === b.id}
	/>
}

const ImportSetup = () => {
	return <>
		<SettingGroup title='Transfer from another editor' description='Copy your editor settings into Kodia.'>
			<div className='flex flex-col gap-2 max-w-xs'>
				<OneClickSwitchButton className='w-full px-4 py-2' fromEditor="VS Code" />
				<OneClickSwitchButton className='w-full px-4 py-2' fromEditor="Cursor" />
				<OneClickSwitchButton className='w-full px-4 py-2' fromEditor="Windsurf" />
			</div>
		</SettingGroup>
		<SettingGroup title='Theme'>
			<ErrorBoundary>
				<ThemeDropdown />
			</ErrorBoundary>
		</SettingGroup>
	</>
}

const VoidOnboardingContent = () => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const voidMetricsService = accessor.get('IMetricsService')
	const voidSettingsState = useSettingsState()

	// the welcome page, then each step
	const [stepName, setStepName] = useState<StepName | 'welcome'>('welcome')

	// back to the welcome page when the user shows the onboarding again
	useEffect(() => {
		if (!voidSettingsState.globalSettings.isOnboardingComplete) {
			setStepName('welcome')
		}
	}, [voidSettingsState.globalSettings.isOnboardingComplete])

	const finish = ({ skipped }: { skipped: boolean }) => {
		voidSettingsService.setGlobalSetting('isOnboardingComplete', true)
		voidMetricsService.capture('Completed Onboarding', { skipped, chatProviderName: voidSettingsState.modelSelectionOfFeature['Chat']?.providerName ?? null })
	}
	const setUpLater = <TextButton onClick={() => finish({ skipped: true })}>Set up later</TextButton>
	const hasChatModel = !isFeatureNameDisabled('Chat', voidSettingsState)

	let content: React.ReactNode
	if (stepName === 'welcome') {
		content = <div className='flex flex-col items-center gap-8 px-6'>
			<FadeIn className='flex flex-col items-center gap-8'>
				<div className='text-5xl font-light text-center'>Welcome to Kodia</div>
				{!isLinux && <VoidIcon />}
				<div className='text-root text-void-fg-3 text-center'>Set up an AI model and bring your editor settings: it takes a minute.</div>
			</FadeIn>
			<FadeIn delayMs={1000} className='flex flex-col items-center gap-2'>
				<PrimaryActionButton onClick={() => setStepName('model')}>Get Started</PrimaryActionButton>
				{setUpLater}
			</FadeIn>
		</div>
	}
	else if (stepName === 'model') {
		content = <OnboardingStep
			stepName='model'
			title='Choose a model'
			description={`Kodia's AI features need a model: from a provider, with your API key, or from a server running on your computer.`}
			footerLeft={setUpLater}
			footerRight={<>
				{!hasChatModel && <span className='text-sm text-void-fg-3'>Add a model to continue</span>}
				<TextButton onClick={() => setStepName('welcome')}>Back</TextButton>
				<PrimaryActionButton disabled={!hasChatModel} onClick={() => setStepName('import')}>Next</PrimaryActionButton>
			</>}
		>
			<ChooseModel />
		</OnboardingStep>
	}
	else {
		content = <OnboardingStep
			stepName='import'
			title='Import your setup'
			description='Bring your settings from another editor, and pick a theme. You can change all of this later in the settings.'
			footerLeft={null}
			footerRight={<>
				<TextButton onClick={() => setStepName('model')}>Back</TextButton>
				<PrimaryActionButton onClick={() => finish({ skipped: false })}>Enter Kodia</PrimaryActionButton>
			</>}
		>
			<ImportSetup />
		</OnboardingStep>
	}

	return <div key={stepName} className="w-full h-full text-left flex flex-col items-center justify-center">
		<ErrorBoundary>
			{content}
		</ErrorBoundary>
	</div>
}
