/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const APPLE_FOUNDATION_MODELS_DEFAULT_ENDPOINT = 'http://127.0.0.1:9999';
export const APPLE_FOUNDATION_MODELS_DEFAULT_PORT = 9999;

/** https://github.com/scouzi1966/maclocal-api — OpenAI-compatible `afm` server for Apple Foundation Models (macOS <= 26) */
export const MACLOCAL_API_REPO_URL = 'https://github.com/scouzi1966/maclocal-api';
export const AFM_DEFAULT_MODEL_ID = 'foundation';
export const AFM_HOMEBREW_TAP = 'scouzi1966/afm';
export const AFM_HOMEBREW_FORMULA = 'scouzi1966/afm/afm';
export const AFM_PIP_PACKAGE = 'macafm';

/** macOS 27+ ships a first-party `fm` CLI (Chat Completions API server) at this path; no install needed */
export const FM_CLI_PATH = '/usr/bin/fm';
/** first macOS marketing version that ships the native `fm` CLI instead of requiring the third-party `afm` tool */
export const FM_CLI_MIN_MACOS_VERSION = 27;
/** distinct default port so a leftover/manually-started `afm` process never gets mistaken for `fm serve` (or vice versa) */
export const FM_CLI_DEFAULT_PORT = 9998;
/** `fm` refuses to run (exit 69) until an admin accepts Apple's terms once for the whole machine, with this command */
export const FM_LICENSE_COMMAND = 'sudo fm license';

/** model ids Kodia will actually try to chat-complete against for this provider; excludes embedding-only ids like `apple-nl-contextual-en` that `afm`/`fm` also list in /v1/models */
export const APPLE_FOUNDATION_MODELS_CHAT_MODEL_IDS = ['foundation', 'system', 'pcc'] as const;

export type AppleFoundationModelsEnsureAction =
	| 'already-running'
	| 'started'
	| 'installed-and-started';

export type AppleFoundationModelsEnsureFailureReason =
	| 'not-mac'
	| 'disabled'
	| 'brew-missing'
	| 'install-failed'
	| 'afm-missing'
	| 'fm-missing'
	| 'fm-license-required'
	| 'fm-crashed'
	| 'server-timeout';

export type AppleFoundationModelsEnsureResult =
	| { ok: true; endpoint: string; action: AppleFoundationModelsEnsureAction; log: string[] }
	| { ok: false; reason: AppleFoundationModelsEnsureFailureReason; log: string[]; errorMessage?: string };

export interface IAppleFoundationModelsMainService {
	readonly _serviceBrand: undefined;
	ensureReady(options: { installIfMissing: boolean; startServer: boolean; port?: number }): Promise<AppleFoundationModelsEnsureResult>;
	stopServerIfSpawnedByVoid(): Promise<void>;
}

export const IAppleFoundationModelsMainService = createDecorator<IAppleFoundationModelsMainService>('appleFoundationModelsMainService');
