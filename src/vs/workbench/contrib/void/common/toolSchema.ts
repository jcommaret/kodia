/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { InternalToolInfo } from './prompt/prompts.js';

// The parameters of a tool, as the providers are told them. A tool that has a JSON Schema (an MCP server's tool, a tool
// of the Agents window's agent) keeps the types and the required parameters it declares; one that has only parameter
// descriptions (Kodia's own chat tools) has every parameter as a string, none required.
//
// A schema is reduced to what every provider accepts: Gemini takes only a subset of JSON Schema, OpenAI-compatible
// servers differ in what they check. What can't be said in that subset (`$ref`, `allOf`, an object with no declared
// properties, ...) becomes a string, as it was before schemas were passed through.

export type ToolParamType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'

export type ToolParamSchema = {
	type: ToolParamType,
	description?: string,
	enum?: string[],
	items?: ToolParamSchema,
	properties?: { [paramName: string]: ToolParamSchema },
	required?: string[],
}

export type ToolSchema = {
	properties: { [paramName: string]: ToolParamSchema },
	required: string[],
}

const PARAM_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])

// how deep a schema of objects and arrays is followed: past it, a value is a string
const MAX_DEPTH = 4

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

// The type a schema declares, if it declares one that can be offered: the first of a list of types that isn't "null",
// else the one its shape implies, else the first branch of a union that has one.
const declaredType = (schema: Record<string, unknown>): ToolParamType | undefined => {
	const types = Array.isArray(schema.type) ? schema.type : [schema.type]
	for (const type of types) {
		if (typeof type === 'string' && PARAM_TYPES.has(type)) return type as ToolParamType
	}
	if (isRecord(schema.properties)) return 'object'
	if (schema.items !== undefined) return 'array'
	if (Array.isArray(schema.enum)) return 'string'
	for (const branch of [...Array.isArray(schema.anyOf) ? schema.anyOf : [], ...Array.isArray(schema.oneOf) ? schema.oneOf : []]) {
		const type = isRecord(branch) ? declaredType(branch) : undefined
		if (type) return type
	}
	return undefined
}

const paramSchemaOf = (schema: unknown, depth: number): ToolParamSchema => {
	if (!isRecord(schema)) return { type: 'string' }
	const type = declaredType(schema) ?? 'string'
	const ans: ToolParamSchema = { type }
	if (typeof schema.description === 'string' && schema.description) ans.description = schema.description
	if (type === 'string' && Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every(value => typeof value === 'string')) {
		ans.enum = schema.enum
	}
	if (type === 'array') {
		ans.items = depth < MAX_DEPTH ? paramSchemaOf(schema.items, depth + 1) : { type: 'string' }
	}
	if (type === 'object' && depth < MAX_DEPTH && isRecord(schema.properties)) {
		const { properties, required } = propertiesOf(schema, depth + 1)
		if (Object.keys(properties).length > 0) {
			ans.properties = properties
			if (required.length > 0) ans.required = required
		}
	}
	return ans
}

const propertiesOf = (schema: Record<string, unknown>, depth: number): ToolSchema => {
	const properties: ToolSchema['properties'] = {}
	if (isRecord(schema.properties)) {
		for (const [name, property] of Object.entries(schema.properties)) properties[name] = paramSchemaOf(property, depth)
	}
	const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === 'string' && name in properties) : []
	return { properties, required }
}

export const toolSchemaOf = ({ params, inputSchema }: Pick<InternalToolInfo, 'params' | 'inputSchema'>): ToolSchema => {
	if (isRecord(inputSchema) && (inputSchema.properties === undefined || isRecord(inputSchema.properties))) {
		return propertiesOf(inputSchema, 1)
	}
	const properties: ToolSchema['properties'] = {}
	for (const [name, { description }] of Object.entries(params)) properties[name] = { type: 'string', description }
	return { properties, required: [] }
}


// ---- the providers' shapes ----

const jsonSchemaOfParam = (param: ToolParamSchema): Record<string, unknown> => ({
	type: param.type,
	...param.description ? { description: param.description } : {},
	...param.enum ? { enum: param.enum } : {},
	...param.items ? { items: jsonSchemaOfParam(param.items) } : {},
	...param.properties ? { properties: jsonSchemaOfProperties(param.properties), ...param.required ? { required: param.required } : {} } : {},
})

const jsonSchemaOfProperties = (properties: ToolSchema['properties']) => {
	const ans: Record<string, Record<string, unknown>> = {}
	for (const [name, param] of Object.entries(properties)) ans[name] = jsonSchemaOfParam(param)
	return ans
}

// OpenAI and the servers that speak its API (chat completions `parameters`), and Anthropic (`input_schema`)
export const jsonSchemaOfTool = (tool: Pick<InternalToolInfo, 'params' | 'inputSchema'>) => {
	const { properties, required } = toolSchemaOf(tool)
	return { type: 'object' as const, properties: jsonSchemaOfProperties(properties), ...required.length ? { required } : {} }
}

// Gemini's Schema, with its own enum of types (`Type` of @google/genai). It has no object without properties.
type GeminiTypes<T> = { STRING: T, NUMBER: T, INTEGER: T, BOOLEAN: T, ARRAY: T, OBJECT: T }
type GeminiSchema<T> = { type: T, description?: string, enum?: string[], items?: GeminiSchema<T>, properties?: { [paramName: string]: GeminiSchema<T> }, required?: string[] }

const geminiSchemaOfParam = <T>(param: ToolParamSchema, Type: GeminiTypes<T>): GeminiSchema<T> => {
	if (param.type === 'object' && !param.properties) return { type: Type.STRING, ...param.description ? { description: param.description } : {} }
	return {
		type: Type[param.type.toUpperCase() as keyof GeminiTypes<T>],
		...param.description ? { description: param.description } : {},
		...param.enum ? { enum: param.enum } : {},
		...param.items ? { items: geminiSchemaOfParam(param.items, Type) } : {},
		...param.properties ? { properties: geminiPropertiesOf(param.properties, Type), ...param.required ? { required: param.required } : {} } : {},
	}
}

const geminiPropertiesOf = <T>(properties: ToolSchema['properties'], Type: GeminiTypes<T>) => {
	const ans: Record<string, GeminiSchema<T>> = {}
	for (const [name, param] of Object.entries(properties)) ans[name] = geminiSchemaOfParam(param, Type)
	return ans
}

export const geminiParametersOfTool = <T>(tool: Pick<InternalToolInfo, 'params' | 'inputSchema'>, Type: GeminiTypes<T>): GeminiSchema<T> => {
	const { properties, required } = toolSchemaOf(tool)
	return { type: Type.OBJECT, properties: geminiPropertiesOf(properties, Type), ...required.length ? { required } : {} }
}
