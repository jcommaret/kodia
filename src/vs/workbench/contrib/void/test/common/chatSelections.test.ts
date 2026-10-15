/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { StagingSelectionItem } from '../../common/chatThreadServiceTypes.js';
import { IDirectoryStrService } from '../../common/directoryStrService.js';
import { chat_userMessageContent } from '../../common/prompt/prompts.js';

suite('Kodia - chat attachments in the user message', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// attachments carry their own content, so the message is built without touching the workspace
	const services = {
		directoryStrService: {} as IDirectoryStrService,
		fileService: {} as IFileService,
	};

	const textFile: StagingSelectionItem = { type: 'TextFile', id: 't', name: 'notes.md', languageId: 'markdown', text: '# Title\nBody' };
	const image: StagingSelectionItem = { type: 'Image', id: 'i', name: 'shot.png', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' };
	const pdf: StagingSelectionItem = { type: 'PDF', id: 'p', name: 'spec.pdf', dataBase64: 'JVBERi0xLjQK', pageCount: 3 };

	test('an attached text file goes into the message, fenced with its language', async () => {
		const content = await chat_userMessageContent('Summarize', [textFile], services);
		assert.ok(content.startsWith('Summarize'));
		assert.ok(content.includes('notes.md (attached file):\n```markdown\n# Title\nBody\n```'), content);
	});

	test('images and PDFs stay out of the text: they are sent as media blocks', async () => {
		const content = await chat_userMessageContent('Describe', [image, pdf], services);
		assert.strictEqual(content, 'Describe');
	});
});
