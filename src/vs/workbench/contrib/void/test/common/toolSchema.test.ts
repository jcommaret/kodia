/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { geminiParametersOfTool, jsonSchemaOfTool, toolSchemaOf } from '../../common/toolSchema.js';

suite('Kodia - tool schemas', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// stands in for @google/genai's `Type`
	const GeminiType = { STRING: 'STRING', NUMBER: 'NUMBER', INTEGER: 'INTEGER', BOOLEAN: 'BOOLEAN', ARRAY: 'ARRAY', OBJECT: 'OBJECT' } as const;

	const editFile = {
		params: { path: { description: 'File path.' }, old_string: { description: 'Text to replace.' }, replace_all: { description: 'Every occurrence.' } },
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path.' },
				old_string: { type: 'string', description: 'Text to replace.' },
				replace_all: { type: 'boolean', description: 'Every occurrence.' },
			},
			required: ['path', 'old_string'],
			additionalProperties: false,
		},
	};

	test('without a schema, every parameter is a string and none is required, as before schemas were passed through', () => {
		const tool = { params: { uri: { description: 'The file.' }, line: { description: '' } } };
		assert.deepStrictEqual(jsonSchemaOfTool(tool), {
			type: 'object',
			properties: { uri: { type: 'string', description: 'The file.' }, line: { type: 'string' } },
		});
		assert.deepStrictEqual(jsonSchemaOfTool({ params: {} }), { type: 'object', properties: {} });
	});

	test('with a schema, the types and the required parameters it declares are kept', () => {
		assert.deepStrictEqual(jsonSchemaOfTool(editFile), {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path.' },
				old_string: { type: 'string', description: 'Text to replace.' },
				replace_all: { type: 'boolean', description: 'Every occurrence.' },
			},
			required: ['path', 'old_string'],
		});
	});

	test('numbers, lists, enums and objects are kept, down to a depth', () => {
		const schema = toolSchemaOf({
			params: {},
			inputSchema: {
				type: 'object',
				properties: {
					limit: { type: 'integer', minimum: 1 },
					ratio: { type: 'number' },
					labels: { type: 'array', items: { type: 'string' } },
					state: { type: 'string', enum: ['open', 'closed'] },
					filter: { type: 'object', properties: { author: { type: 'string' }, tags: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name', 'absent'] } } }, required: ['author'] },
				},
			},
		});
		assert.deepStrictEqual(schema, {
			properties: {
				limit: { type: 'integer' },
				ratio: { type: 'number' },
				labels: { type: 'array', items: { type: 'string' } },
				state: { type: 'string', enum: ['open', 'closed'] },
				filter: {
					type: 'object',
					properties: {
						author: { type: 'string' },
						tags: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
					},
					required: ['author'],
				},
			},
			required: [],
		});

		let deep: Record<string, unknown> = { type: 'integer' };
		for (let i = 0; i < 6; i++) { deep = { type: 'object', properties: { next: deep } }; }
		const cut = JSON.stringify(toolSchemaOf({ params: {}, inputSchema: { type: 'object', properties: { deep } } }));
		assert.ok(!cut.includes('integer'), 'past the depth, a value is a string');
	});

	test('what can\'t be said is a string: a reference, a combination, a type of its own, an object with no properties', () => {
		const { properties } = toolSchemaOf({
			params: {},
			inputSchema: {
				type: 'object',
				properties: {
					ref: { $ref: '#/$defs/Thing', description: 'A thing.' },
					all: { allOf: [{ type: 'object' }, { required: ['x'] }] },
					weird: { type: 'datetime' },
					notAnObject: 'string',
					any: { description: 'Anything.' },
					mixedEnum: { type: 'string', enum: ['a', 1] },
				},
			},
		});
		assert.deepStrictEqual(properties.ref, { type: 'string', description: 'A thing.' });
		assert.deepStrictEqual(properties.all, { type: 'string' });
		assert.deepStrictEqual(properties.weird, { type: 'string' });
		assert.deepStrictEqual(properties.notAnObject, { type: 'string' });
		assert.deepStrictEqual(properties.any, { type: 'string', description: 'Anything.' });
		assert.deepStrictEqual(properties.mixedEnum, { type: 'string' });
	});

	test('a list of types takes the first one that isn\'t null, and a union its first branch that has a type', () => {
		const { properties } = toolSchemaOf({
			params: {},
			inputSchema: {
				type: 'object',
				properties: {
					cursor: { type: ['null', 'integer'] },
					id: { anyOf: [{ type: 'null' }, { type: 'number' }, { type: 'string' }] },
					choice: { oneOf: [{ enum: ['a', 'b'] }, { type: 'integer' }] },
					shaped: { properties: { a: { type: 'string' } } },
					listed: { items: { type: 'integer' } },
				},
			},
		});
		assert.deepStrictEqual(Object.fromEntries(Object.entries(properties).map(([name, p]) => [name, p.type])), { cursor: 'integer', id: 'number', choice: 'string', shaped: 'object', listed: 'array' });
		assert.deepStrictEqual(properties.listed.items, { type: 'integer' });
	});

	test('a schema that isn\'t one of an object falls back on the parameters\' descriptions', () => {
		const params = { q: { description: 'Query.' } };
		for (const inputSchema of [{ type: 'object', properties: 'nope' }, 'nope', 3, null, [1], undefined]) {
			assert.deepStrictEqual(toolSchemaOf({ params, inputSchema: inputSchema as object | undefined }), { properties: { q: { type: 'string', description: 'Query.' } }, required: [] });
		}
		// an object schema with no properties is a tool with no parameter
		assert.deepStrictEqual(toolSchemaOf({ params, inputSchema: { type: 'object' } }), { properties: {}, required: [] });
	});

	test('Gemini gets its own types, and no object without properties', () => {
		assert.deepStrictEqual(geminiParametersOfTool(editFile, GeminiType), {
			type: 'OBJECT',
			properties: {
				path: { type: 'STRING', description: 'File path.' },
				old_string: { type: 'STRING', description: 'Text to replace.' },
				replace_all: { type: 'BOOLEAN', description: 'Every occurrence.' },
			},
			required: ['path', 'old_string'],
		});
		assert.deepStrictEqual(geminiParametersOfTool({
			params: {},
			inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } }, free: { type: 'object', description: 'Any object.' }, nested: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } } },
		}, GeminiType), {
			type: 'OBJECT',
			properties: {
				ids: { type: 'ARRAY', items: { type: 'INTEGER' } },
				free: { type: 'STRING', description: 'Any object.' },
				nested: { type: 'OBJECT', properties: { n: { type: 'NUMBER' } }, required: ['n'] },
			},
		});
		assert.deepStrictEqual(geminiParametersOfTool({ params: { a: { description: 'A.' } } }, GeminiType), { type: 'OBJECT', properties: { a: { type: 'STRING', description: 'A.' } } });
	});
});
