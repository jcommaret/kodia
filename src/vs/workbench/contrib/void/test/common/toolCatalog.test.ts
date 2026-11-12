/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { editorToolNames, editorTools, isEditorToolName, jsonSchemaOfSharedTool, nextPageNote, SharedTool, sharedToolNames, sharedTools } from '../../../../../platform/kodia/common/toolCatalog.js';
import { availableTools, builtinTools } from '../../common/prompt/prompts.js';
import { approvalTypeOfBuiltinToolName, BuiltinToolName } from '../../common/toolsServiceTypes.js';

suite('Kodia - the tools the chat and the Agents window\'s agent share', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// the chat keeps its own text for read_file's start_line and run_command's description: the shared one can't name
	// the chat's editor tools or its timeout
	test('the chat tells a model what the catalog says, but for the two places it names its own tools', () => {
		for (const name of sharedToolNames) {
			const catalog: SharedTool = sharedTools[name];
			const chat = builtinTools[name as BuiltinToolName];
			assert.strictEqual(chat.name, name);
			assert.deepStrictEqual(Object.keys(chat.params), Object.keys(catalog.params), `${name}'s parameters`);
			if (name !== 'run_command') {
				assert.strictEqual(chat.description, catalog.description, `${name}'s description`);
			}
			for (const [paramName, param] of Object.entries(catalog.params)) {
				if (!(name === 'read_file' && paramName === 'start_line')) {
					assert.strictEqual((chat.params as { [paramName: string]: { description: string } })[paramName].description, param.description, `${name}.${paramName}`);
				}
			}
		}
		assert.match(builtinTools.read_file.params.start_line?.description ?? '', /go_to_definition, find_references, or a lint error/);
		assert.match(builtinTools.run_command.description, /times out after 8s of inactivity/);
		assert.doesNotMatch(sharedTools.read_file.params.start_line.description, /go_to_definition/, 'the agent has no language server');
		assert.doesNotMatch(sharedTools.run_command.description, /8s/, 'the agent\'s commands run longer');
	});

	test('every shared tool is one the chat offers a model, and needs the approval the chat asks for', () => {
		const offered = new Set((availableTools('agent', undefined) ?? []).map(tool => tool.name));
		for (const name of sharedToolNames) {
			const catalog: SharedTool = sharedTools[name];
			assert.ok(offered.has(name), `${name} is offered by the chat in Agent mode`);
			assert.strictEqual(approvalTypeOfBuiltinToolName[name as BuiltinToolName], catalog.approval, `${name}'s approval`);
		}
	});

	test('the chat\'s tools that need the editor are not shared', () => {
		for (const name of ['go_to_definition', 'find_references', 'search_symbols', 'read_lint_errors', 'run_persistent_command', 'open_persistent_terminal', 'kill_persistent_terminal', 'read_project_memory']) {
			assert.ok(!(sharedToolNames as string[]).includes(name), name);
		}
	});

	test('the chat tells a model what the catalog says of the editor tools, and offers them all', () => {
		assert.deepStrictEqual(editorToolNames, ['go_to_definition', 'find_references', 'search_symbols', 'read_lint_errors']);
		const offered = new Set((availableTools('agent', undefined) ?? []).map(tool => tool.name));
		for (const name of editorToolNames) {
			const catalog: SharedTool = editorTools[name];
			const chat = builtinTools[name];
			assert.strictEqual(chat.name, name);
			assert.strictEqual(chat.description, catalog.description, `${name}'s description`);
			assert.deepStrictEqual(Object.keys(chat.params), Object.keys(catalog.params), `${name}'s parameters`);
			for (const [paramName, param] of Object.entries(catalog.params)) {
				assert.strictEqual((chat.params as { [paramName: string]: { description: string } })[paramName].description, param.description, `${name}.${paramName}`);
			}
			assert.ok(offered.has(name), `${name} is offered by the chat in Agent mode`);
			assert.strictEqual(approvalTypeOfBuiltinToolName[name], undefined, `${name} only reads`);
			assert.ok(!(sharedToolNames as string[]).includes(name), `${name} is not one the agent runs itself`);
			assert.ok(isEditorToolName(name));
		}
		assert.ok(!isEditorToolName('read_file') && !isEditorToolName('toString') && !isEditorToolName('a1b2_search'));
	});

	test('the editor tools\' schema: every parameter is required, and a line is a number', () => {
		for (const name of editorToolNames) {
			const catalog: SharedTool = editorTools[name];
			const schema = jsonSchemaOfSharedTool(catalog);
			assert.deepStrictEqual(schema.required, Object.keys(catalog.params), name);
			assert.ok(Object.values(schema.properties).every(param => param.description.length > 0));
		}
		assert.deepStrictEqual(jsonSchemaOfSharedTool(editorTools.go_to_definition).properties.line.type, 'integer');
		assert.deepStrictEqual(jsonSchemaOfSharedTool(editorTools.find_references).required, ['uri', 'line', 'symbol']);
		assert.deepStrictEqual(jsonSchemaOfSharedTool(editorTools.search_symbols).required, ['query']);
	});

	test('a required parameter is a parameter, and a parameter is a string unless it is a number or a flag', () => {
		for (const name of sharedToolNames) {
			const catalog: SharedTool = sharedTools[name];
			const schema = jsonSchemaOfSharedTool(catalog);
			assert.deepStrictEqual(Object.keys(schema.properties), Object.keys(catalog.params));
			assert.ok(schema.required.every(param => param in schema.properties), name);
			assert.strictEqual(schema.additionalProperties, false);
			for (const param of Object.values(schema.properties)) {
				assert.ok(['string', 'integer', 'boolean'].includes(param.type), `${name}: ${param.type}`);
				assert.ok(param.description.length > 0);
			}
		}
		assert.deepStrictEqual(jsonSchemaOfSharedTool(sharedTools.edit_file).required, ['uri', 'search_replace_blocks']);
		assert.deepStrictEqual(jsonSchemaOfSharedTool(sharedTools.delete_file_or_folder).properties.is_recursive.type, 'boolean');
		assert.deepStrictEqual(jsonSchemaOfSharedTool(sharedTools.ls_dir).required, [], 'ls_dir takes no required parameter');
	});

	test('says when there is a next page', () => {
		assert.strictEqual(nextPageNote(true), '\n\n(more on next page...)');
		assert.strictEqual(nextPageNote(false), '');
	});
});
