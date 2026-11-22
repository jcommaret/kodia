/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IChatThreadService } from './chatThreadService.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { VOID_VIEW_CONTAINER_ID } from './sidebarPane.js';
import { roundRangeToLines } from './sidebarActions.js';
import { localize2 } from '../../../../nls.js';
import { AutonomyMode } from '../common/autonomyPolicy.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';

export const KODIA_EDITOR_EXPLAIN_ACTION_ID = 'kodia.editor.explainSelection';
export const KODIA_EDITOR_FIX_DIAGNOSTICS_ACTION_ID = 'kodia.editor.fixDiagnostics';
export const KODIA_EDITOR_GENERATE_TESTS_ACTION_ID = 'kodia.editor.generateTests';
export const KODIA_EDITOR_REFACTOR_ACTION_ID = 'kodia.editor.refactorSelection';
export const KODIA_EDITOR_SECURITY_REVIEW_ACTION_ID = 'kodia.editor.reviewSecurity';
export const KODIA_EDITOR_PERFORMANCE_ACTION_ID = 'kodia.editor.analyzePerformance';
export const KODIA_EDITOR_DEPENDENCIES_ACTION_ID = 'kodia.editor.explainDependencies';
export const KODIA_CYCLE_AUTONOMY_ACTION_ID = 'kodia.workbench.cycleAutonomy';

const KODIA_EDITOR_SUBMENU_ID = new MenuId('kodia.editor.contextSubmenu');

MenuRegistry.appendMenuItem(MenuId.EditorContext, {
	submenu: KODIA_EDITOR_SUBMENU_ID,
	title: 'Kodia AI',
	group: '1_modification',
	order: 0,
	when: EditorContextKeys.editorTextFocus,
});

async function sendEditorSelectionToKodia(
	accessor: ServicesAccessor,
	buildPrompt: (ctx: {
		fileName: string;
		languageId: string;
		rangeLabel: string;
		diagnosticsSummary: string;
	}) => string,
	options?: { includeDiagnostics?: boolean; requireSelection?: boolean },
): Promise<void> {
	const editorService = accessor.get(ICodeEditorService);
	const viewsService = accessor.get(IViewsService);
	const chatThreadService = accessor.get(IChatThreadService);
	const markerService = accessor.get(IMarkerService);
	const notificationService = accessor.get(INotificationService);

	const editor = editorService.getActiveCodeEditor();
	const model = editor?.getModel();
	if (!editor || !model) {
		notificationService.info('Open a code file first to run Kodia AI editor actions.');
		return;
	}

	const selRange = roundRangeToLines(editor.getSelection(), { emptySelectionBehavior: 'null' });
	if (options?.requireSelection && !selRange) {
		notificationService.info('Select code in the editor first to run this Kodia AI action.');
		return;
	}

	let diagnosticsSummary = '';
	if (options?.includeDiagnostics) {
		const markers = markerService.read({ resource: model.uri })
			.filter(m => m.severity >= MarkerSeverity.Warning)
			.filter(m => !selRange || (m.endLineNumber >= selRange.startLineNumber && m.startLineNumber <= selRange.endLineNumber));
		if (markers.length > 0) {
			diagnosticsSummary = markers
				.slice(0, 15)
				.map(m => `- Line ${m.startLineNumber} [${m.severity === MarkerSeverity.Error ? 'ERROR' : 'WARN'}]: ${m.message}`)
				.join('\n');
		}
	}

	await viewsService.openViewContainer(VOID_VIEW_CONTAINER_ID);

	if (selRange) {
		chatThreadService.addNewStagingSelection({
			type: 'CodeSelection',
			uri: model.uri,
			language: model.getLanguageId(),
			range: [selRange.startLineNumber, selRange.endLineNumber],
			state: { wasAddedAsCurrentFile: false },
		});
	} else {
		chatThreadService.addNewStagingSelection({
			type: 'File',
			uri: model.uri,
			language: model.getLanguageId(),
			state: { wasAddedAsCurrentFile: false },
		});
	}

	const fileName = model.uri.path.split('/').pop() ?? model.uri.fsPath;
	const rangeLabel = selRange ? `${fileName}:${selRange.startLineNumber}-${selRange.endLineNumber}` : fileName;
	const userMessage = buildPrompt({
		fileName,
		languageId: model.getLanguageId(),
		rangeLabel,
		diagnosticsSummary,
	});

	const threadId = chatThreadService.state.currentThreadId;
	if (chatThreadService.streamState[threadId]?.isRunning) {
		chatThreadService.enqueueUserMessage(threadId, userMessage);
	} else {
		void chatThreadService.addUserMessageAndStreamResponse({ userMessage, threadId });
	}
	await chatThreadService.focusCurrentChat();
}

interface EditorAIActionSpec {
	id: string;
	title: string;
	menuTitle: string;
	order: number;
	includeDiagnostics?: boolean;
	prompt: (ctx: { fileName: string; languageId: string; rangeLabel: string; diagnosticsSummary: string }) => string;
}

const EDITOR_AI_ACTIONS: readonly EditorAIActionSpec[] = [
	{
		id: KODIA_EDITOR_EXPLAIN_ACTION_ID,
		title: 'Kodia AI: Explain Code',
		menuTitle: 'Explain Code',
		order: 1,
		prompt: ({ rangeLabel }) => `Explain what the code in ${rangeLabel} does, including its inputs, outputs, side effects, and edge cases.`,
	},
	{
		id: KODIA_EDITOR_FIX_DIAGNOSTICS_ACTION_ID,
		title: 'Kodia AI: Fix Errors & Diagnostics',
		menuTitle: 'Fix Errors & Diagnostics',
		order: 2,
		includeDiagnostics: true,
		prompt: ({ rangeLabel, diagnosticsSummary }) => diagnosticsSummary
			? `Fix the following compiler/linter diagnostics in ${rangeLabel} and verify the fix:\n${diagnosticsSummary}`
			: `Inspect ${rangeLabel} for bugs, type errors, or runtime edge cases, fix any real issues found, and verify the fix.`,
	},
	{
		id: KODIA_EDITOR_GENERATE_TESTS_ACTION_ID,
		title: 'Kodia AI: Generate Tests',
		menuTitle: 'Generate Tests',
		order: 3,
		prompt: ({ rangeLabel }) => `Write thorough unit tests covering normal behavior and edge cases for ${rangeLabel}, matching this repository's existing test framework and conventions, then run the tests to verify they pass.`,
	},
	{
		id: KODIA_EDITOR_REFACTOR_ACTION_ID,
		title: 'Kodia AI: Refactor Selection',
		menuTitle: 'Refactor Selection',
		order: 4,
		prompt: ({ rangeLabel }) => `Refactor ${rangeLabel} to improve readability, type safety, and maintainability without changing external behavior. Verify all callers and diagnostics remain clean.`,
	},
	{
		id: KODIA_EDITOR_SECURITY_REVIEW_ACTION_ID,
		title: 'Kodia AI: Review Security',
		menuTitle: 'Review Security',
		order: 5,
		prompt: ({ rangeLabel }) => `Perform a security review of ${rangeLabel}: check for injection risks, auth/authz flaws, secret exposure, unsafe deserialization, path traversal, or SSRF. Report concrete findings with fixes.`,
	},
	{
		id: KODIA_EDITOR_PERFORMANCE_ACTION_ID,
		title: 'Kodia AI: Analyze Performance',
		menuTitle: 'Analyze Performance',
		order: 6,
		prompt: ({ rangeLabel }) => `Analyze ${rangeLabel} for performance bottlenecks (algorithmic complexity, unnecessary allocations/re-renders, N+1 I/O, blocking calls) and propose targeted optimizations.`,
	},
	{
		id: KODIA_EDITOR_DEPENDENCIES_ACTION_ID,
		title: 'Kodia AI: Explain Dependencies & Change Impact',
		menuTitle: 'Explain Dependencies & Impact',
		order: 7,
		prompt: ({ rangeLabel }) => `Trace the callers, callees, and module dependencies of ${rangeLabel} and summarize the blast radius / change impact if this code is modified.`,
	},
];

for (const spec of EDITOR_AI_ACTIONS) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: spec.id,
				title: { value: spec.title, original: spec.title },
				f1: true,
				menu: [{
					id: KODIA_EDITOR_SUBMENU_ID,
					group: 'navigation',
					order: spec.order,
					when: EditorContextKeys.editorTextFocus,
				}],
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			await sendEditorSelectionToKodia(accessor, spec.prompt, { includeDiagnostics: spec.includeDiagnostics });
		}
	});
}

const AUTONOMY_CYCLE_ORDER: readonly AutonomyMode[] = ['assist', 'agent', 'autonomous'];

registerAction2(class KodiaCycleAutonomyAction extends Action2 {
	constructor() {
		super({
			id: KODIA_CYCLE_AUTONOMY_ACTION_ID,
			title: localize2('kodiaCycleAutonomy', 'Kodia: Cycle Autonomy Mode (Assist / Agent / Auto)'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const voidSettingsService = accessor.get(IVoidSettingsService);
		const notificationService = accessor.get(INotificationService);
		const current = voidSettingsService.state.globalSettings.agentAutonomyMode ?? 'agent';
		const nextIdx = (AUTONOMY_CYCLE_ORDER.indexOf(current) + 1) % AUTONOMY_CYCLE_ORDER.length;
		const next = AUTONOMY_CYCLE_ORDER[nextIdx];
		voidSettingsService.setGlobalSetting('agentAutonomyMode', next);
		const label = next === 'autonomous' ? 'Autonomous (Full Autopilot)' : next === 'agent' ? 'Agent (Balanced)' : 'Assist (Manual Review)';
		notificationService.info(`Kodia Autonomy Mode switched to ${label}`);
	}
});
