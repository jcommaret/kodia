/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IProductConfiguration } from '../../../../../base/common/product.js';
import { isKodiaFreeModel, isKodiaProduct } from '../../../chat/browser/widget/input/modelPicker/kodiaModelPicker.js';
import type { ILanguageModelChatMetadataAndIdentifier } from '../../../chat/common/languageModels.js';

const productWithChatAgent = (id: string | undefined) => ({ defaultChatAgent: id === undefined ? undefined : { provider: { default: { id, name: id } } } }) as unknown as Pick<IProductConfiguration, 'defaultChatAgent'>;

suite('Kodia - model picker without Copilot', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recognizes Kodia, whose models come from its own settings', () => {
		assert.strictEqual(isKodiaProduct(productWithChatAgent('void')), true);
	});

	test('leaves other products, and a product without a chat agent, to Copilot', () => {
		assert.strictEqual(isKodiaProduct(productWithChatAgent('github')), false);
		assert.strictEqual(isKodiaProduct(productWithChatAgent(undefined)), false);
	});

	test('OpenRouter\'s free models, as the Kodia agent lists them', () => {
		const model = (id: string) => ({ identifier: `agent-host-kodia:${id}`, metadata: { id } }) as unknown as ILanguageModelChatMetadataAndIdentifier;
		assert.strictEqual(isKodiaFreeModel(model('openRouter/thinkingmachines/inkling:free')), true);
		assert.strictEqual(isKodiaFreeModel(model('openRouter/anthropic/claude-opus-5.5')), false);
		assert.strictEqual(isKodiaFreeModel(model('groq/some-model:free')), false, 'only OpenRouter has free models');
	});
});
