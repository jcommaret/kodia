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
import vfs from 'vinyl-fs';

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
	// Kodia runs gulp 5, whose vinyl-fs 4 src() breaks the build where gulp 4 (upstream) does not:
	// - it decodes every file as UTF-8 by default, destroying binary assets (.node addons, images, fonts);
	// - its streamx-based readables cannot be merged with event-stream's es.merge();
	// - it resolves relative symlinks against the working directory instead of the link's folder
	//   (ENOENT on foundry-local-sdk's libonnxruntime.dylib -> libonnxruntime.1.dylib when packaging).
	// Read sources with vinyl-fs 3, the implementation behind gulp 4's src().
	src: vfs.src,
	dest: g.dest
};
