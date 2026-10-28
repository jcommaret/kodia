/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import type { IProductConfiguration } from '../../../../../../../base/common/product.js';
import type { ILanguageModelChatMetadataAndIdentifier } from '../../../../common/languageModels.js';

/**
 * Kodia: the model picker's models are the ones set up in Kodia's settings. Kodia ships without
 * GitHub Copilot, so the picker never asks to sign in to Copilot, and always offers "Manage
 * Models...", which opens Kodia's settings (see the Agents window's handler for it).
 */
export function isKodiaProduct(product: Pick<IProductConfiguration, 'defaultChatAgent'>): boolean {
	return product.defaultChatAgent?.provider?.default?.id === 'void';
}

/**
 * Kodia: one of OpenRouter's free models, as the Kodia agent lists them (`openRouter/<model>:free`, see
 * kodiaAgent.ts). The flat picker lists them first, apart from the others, as Kodia's own model dropdown does.
 */
export function isKodiaFreeModel(model: ILanguageModelChatMetadataAndIdentifier): boolean {
	const { id } = model.metadata;
	return id.startsWith('openRouter/') && id.endsWith(':free');
}
