/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Single entry-point for all gulp-related modules used in `./build`.
// All files under `./build` must import gulp and any `gulp-*` plugin from
// this facade rather than from the underlying packages directly. This is
// enforced by the `local/code-no-direct-gulp-import` ESLint rule.
// This allows us to keep track of the gulp plugins we actually use.

/* eslint-disable local/code-no-direct-gulp-import */

import filter_ from 'gulp-filter';
import rename_ from 'gulp-rename';
import replace_ from 'gulp-replace';
import plumber_ from 'gulp-plumber';
import sourcemaps_ from 'gulp-sourcemaps';
import flatmap_ from 'gulp-flatmap';
import gunzip_ from 'gulp-gunzip';
import gzip_ from 'gulp-gzip';
import jsonEditor_ from 'gulp-json-editor';
import mergeJson_ from 'gulp-merge-json';
import azureStorage_ from 'gulp-azure-storage';
import bom_ from 'gulp-bom';
import buffer_ from 'gulp-buffer';
import vinylZip_ from '@vscode/gulp-vinyl-zip';
import sort_ from 'gulp-sort';
import g from 'gulp';
import es from 'event-stream';

export const filter = filter_;
export type { FileFunction } from 'gulp-filter';
export const rename = rename_;
export const replace = replace_;
export const plumber = plumber_;
export const sourcemaps = sourcemaps_;
export const flatmap = flatmap_;
export const gunzip = gunzip_;
export const gzip = gzip_;
export const jsonEditor = jsonEditor_;
export const mergeJson = mergeJson_;
export const azureStorage = azureStorage_;
export const bom = bom_;
export const buffer = buffer_;
export const vinylZip = vinylZip_;
export const sort = sort_;

export const gulp = {
	// Import task, sequence and parallel from "../lib/task"!
	// Kodia runs gulp 5 (vinyl-fs 4), which differs from gulp 4 in two ways the build relies on:
	// - it decodes every file as UTF-8 by default, destroying binary assets (.node addons, images,
	//   fonts) as they flow through packaging streams, so src() reads raw buffers unless the call
	//   site picks an encoding;
	// - its streamx-based readables unconditionally call dest.end() when piped, and the bare merge
	//   streams of event-stream have no end() method, so a classic through stream after src() keeps
	//   every source mergeable with es.merge().
	src: ((globs: Parameters<typeof g.src>[0], opt?: Parameters<typeof g.src>[1]) =>
		g.src(globs, { encoding: false, ...opt } as Parameters<typeof g.src>[1]).pipe(es.through())) as unknown as typeof g.src,
	dest: g.dest
};
