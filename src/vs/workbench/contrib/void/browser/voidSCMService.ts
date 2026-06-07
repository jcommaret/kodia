/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js'
import { ThemeIcon } from '../../../../base/common/themables.js'
import { localize2 } from '../../../../nls.js'
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js'
import { ContextKeyExpr, IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js'
import { ISCMService, ISCMViewService } from '../../scm/common/scm.js'
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js'
import { IVoidSCMService } from '../common/voidSCMTypes.js'
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js'
import { IVoidSettingsService } from '../common/voidSettingsService.js'
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js'
import { ILLMMessageService } from '../common/sendLLMMessageService.js'
import { ModelSelection, OverridesOfModel, ModelSelectionOptions } from '../common/voidSettingsTypes.js'
import { gitCommitMessage_systemMessage, gitCommitMessage_userMessage } from '../common/prompt/prompts.js'
import { LLMChatMessage } from '../common/sendLLMMessageTypes.js'
import { generateUuid } from '../../../../base/common/uuid.js'
import { ThrottledDelayer } from '../../../../base/common/async.js'
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js'
import { Disposable } from '../../../../base/common/lifecycle.js'
import { INotificationService } from '../../../../platform/notification/common/notification.js'

interface ModelOptions {
	modelSelection: ModelSelection | null
	modelSelectionOptions?: ModelSelectionOptions
	overridesOfModel: OverridesOfModel
}

export interface IGenerateCommitMessageService {
	readonly _serviceBrand: undefined
	generateCommitMessage(providerRootUri?: URI): Promise<void>
	abort(): void
}

export const IGenerateCommitMessageService = createDecorator<IGenerateCommitMessageService>('voidGenerateCommitMessageService');

const loadingContextKey = 'voidSCMGenerateCommitMessageLoading'

class GenerateCommitMessageService extends Disposable implements IGenerateCommitMessageService {
	readonly _serviceBrand: undefined;
	private readonly execute = new ThrottledDelayer(300)
	private llmRequestId: string | null = null
	private currentRequestId: string | null = null
	private voidSCM: IVoidSCMService
	private loadingContextKey: IContextKey<boolean>

	constructor(
		@ISCMService private readonly scmService: ISCMService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IConvertToLLMMessageService private readonly convertToLLMMessageService: IConvertToLLMMessageService,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@INotificationService private readonly notificationService: INotificationService
	) {
		super()
		this.loadingContextKey = this.contextKeyService.createKey(loadingContextKey, false)
		this.voidSCM = ProxyChannel.toService<IVoidSCMService>(mainProcessService.getChannel('void-channel-scm'))
	}

	override dispose() {
		this.execute.dispose()
		super.dispose()
	}

	async generateCommitMessage(providerRootUri?: URI) {
		this.loadingContextKey.set(true)
		this.execute.trigger(async () => {
			const requestId = generateUuid()
			this.currentRequestId = requestId


			try {
				const { path, repo } = this.gitRepoInfo(providerRootUri)
				const [stat, sampledDiffs, branch, log] = await Promise.all([
					this.voidSCM.gitStat(path),
					this.voidSCM.gitSampledDiffs(path),
					this.voidSCM.gitBranch(path),
					this.voidSCM.gitLog(path)
				])

				if (!this.isCurrentRequest(requestId)) { throw new CancellationError() }

				const modelSelection = this.voidSettingsService.state.modelSelectionOfFeature['SCM']
					?? this.voidSettingsService.state.modelSelectionOfFeature['Chat']
					?? null
				const featureName = this.voidSettingsService.state.modelSelectionOfFeature['SCM'] ? 'SCM' as const : 'Chat' as const
				const modelSelectionOptions = modelSelection ? this.voidSettingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName] : undefined
				const overridesOfModel = this.voidSettingsService.state.overridesOfModel

				const modelOptions: ModelOptions = { modelSelection, modelSelectionOptions, overridesOfModel }

				const prompt = gitCommitMessage_userMessage(stat, sampledDiffs, branch, log)

				const simpleMessages = [{ role: 'user', content: prompt } as const]
				const { messages, separateSystemMessage } = this.convertToLLMMessageService.prepareLLMSimpleMessages({
					simpleMessages,
					systemMessage: gitCommitMessage_systemMessage,
					modelSelection: modelOptions.modelSelection,
					featureName: 'SCM',
				})

				const commitMessage = await this.sendLLMMessage(messages, separateSystemMessage!, modelOptions)

				if (!this.isCurrentRequest(requestId)) { throw new CancellationError() }

				if (!commitMessage) {
					throw new Error('Empty commit message from model')
				}

				repo.input.setValue(commitMessage, false)
			} catch (error) {
				this.onError(error)
			} finally {
				if (this.isCurrentRequest(requestId)) {
					this.loadingContextKey.set(false)
				}
			}
		})
	}

	abort() {
		if (this.llmRequestId) {
			this.llmMessageService.abort(this.llmRequestId)
		}
		this.execute.cancel()
		this.loadingContextKey.set(false)
		this.currentRequestId = null
	}

	private gitRepoInfo(providerRootUri?: URI) {
		if (providerRootUri) {
			const repo = this.scmService.getRepository(providerRootUri)
			if (repo?.provider.providerId === 'git' && repo.provider.rootUri?.fsPath) {
				return { path: repo.provider.rootUri.fsPath, repo }
			}
		}

		const active = this.scmViewService.activeRepository.get()?.repository
			?? this.scmViewService.focusedRepository
		if (active?.provider.providerId === 'git' && active.provider.rootUri?.fsPath) {
			return { path: active.provider.rootUri.fsPath, repo: active }
		}

		const repo = Array.from(this.scmService.repositories).find(
			r => r.provider.providerId === 'git' && r.provider.rootUri?.fsPath
		)
		if (!repo) { throw new Error('No git repository found') }
		return { path: repo.provider.rootUri!.fsPath, repo }
	}

	/** LLM Functions */

	private sendLLMMessage(messages: LLMChatMessage[], separateSystemMessage: string, modelOptions: ModelOptions): Promise<string> {
		return new Promise((resolve, reject) => {

			this.llmRequestId = this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages,
				separateSystemMessage,
				chatMode: null,
				modelSelection: modelOptions.modelSelection,
				modelSelectionOptions: modelOptions.modelSelectionOptions,
				overridesOfModel: modelOptions.overridesOfModel,
				onText: () => { },
				onFinalMessage: (params: { fullText: string }) => {
					const match = params.fullText.match(/<output>([\s\S]*?)<\/output>/i)
					const commitMessage = match ? match[1].trim() : params.fullText.trim()
					resolve(commitMessage)
				},
				onError: (error) => {
					console.error(error)
					reject(error)
				},
				onAbort: () => {
					reject(new CancellationError())
				},
				logging: { loggingName: 'VoidSCM - Commit Message' },
			})
		})
	}


	/** Request Helpers */

	private isCurrentRequest(requestId: string) {
		return requestId === this.currentRequestId
	}


	/** UI Functions */

	private onError(error: unknown) {
		if (!isCancellationError(error)) {
			console.error(error)
			this.notificationService.error(localize2('voidFailedToGenerateCommitMessage', 'Failed to generate commit message.').value)
		}
	}
}

class GenerateCommitMessageAction extends Action2 {
	constructor() {
		super({
			id: 'void.generateCommitMessageAction',
			title: localize2('voidCommitMessagePrompt', 'Kodia: Generate Commit Message'),
			icon: ThemeIcon.fromId('sparkle'),
			tooltip: localize2('voidCommitMessagePromptTooltip', 'Kodia: Generate Commit Message'),
			f1: true,
			menu: [{
				id: MenuId.SCMInputBox,
				when: ContextKeyExpr.and(ContextKeyExpr.equals('scmProvider', 'git'), ContextKeyExpr.equals(loadingContextKey, false)),
				group: 'inline'
			}]
		})
	}

	async run(accessor: ServicesAccessor, providerRootUri?: URI): Promise<void> {
		const generateCommitMessageService = accessor.get(IGenerateCommitMessageService)
		await generateCommitMessageService.generateCommitMessage(providerRootUri)
	}
}

class LoadingGenerateCommitMessageAction extends Action2 {
	constructor() {
		super({
			id: 'void.loadingGenerateCommitMessageAction',
			title: localize2('voidCommitMessagePromptCancel', 'Kodia: Cancel Commit Message Generation'),
			icon: ThemeIcon.fromId('stop-circle'),
			tooltip: localize2('voidCommitMessagePromptCancelTooltip', 'Kodia: Cancel Commit Message Generation'),
			f1: false, //Having a cancel command in the command palette is more confusing than useful.
			menu: [{
				id: MenuId.SCMInputBox,
				when: ContextKeyExpr.and(ContextKeyExpr.equals('scmProvider', 'git'), ContextKeyExpr.equals(loadingContextKey, true)),
				group: 'inline'
			}]
		})
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const generateCommitMessageService = accessor.get(IGenerateCommitMessageService)
		generateCommitMessageService.abort()
	}
}

registerAction2(GenerateCommitMessageAction)
registerAction2(LoadingGenerateCommitMessageAction)
registerSingleton(IGenerateCommitMessageService, GenerateCommitMessageService, InstantiationType.Delayed)
