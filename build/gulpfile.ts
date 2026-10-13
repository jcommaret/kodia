/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { EventEmitter } from 'events';
EventEmitter.defaultMaxListeners = 100;

import glob from 'glob';
import { createRequire } from 'node:module';
import { monacoTypecheckTask /* , monacoTypecheckWatchTask */ } from './gulpfile.editor.ts';
import { compileExtensionMediaTask, compileExtensionsTask, watchExtensionsTask } from './gulpfile.extensions.ts';
import * as compilation from './lib/compilation.ts';
import * as task from './lib/gulp/task.ts';
import * as util from './lib/util.ts';
import { runEsbuildTranspile } from './lib/esbuild.ts';

// gulp 5 (vinyl-fs 4) decodes every file as UTF-8 by default, which destroys
// binary assets (.node addons, images, fonts) as they flow through packaging
// streams. Restore the gulp 4 behavior of reading raw buffers; call sites can
// still opt into an encoding explicitly.
const originalGulpSrc = gulp.src.bind(gulp);
gulp.src = ((globs: Parameters<typeof gulp.src>[0], opt?: Parameters<typeof gulp.src>[1]) =>
	originalGulpSrc(globs, { encoding: false, ...opt } as Parameters<typeof gulp.src>[1])) as typeof gulp.src;

// Extension point names
task.task(compilation.compileExtensionPointNamesTask);

const require = createRequire(import.meta.url);

// API proposal names
task.task(compilation.checkApiProposalNamesTask);
task.task(compilation.compileApiProposalNamesTask);
task.task(compilation.watchApiProposalNamesTask);

// Client Transpile
task.task(task.define('transpile-client-esbuild', task.series(
	compilation.copyCodiconsTask,
	task.define('esbuild-out-build', () => runEsbuildTranspile('out', false)),
)));

// Transpile only
const transpileClientTask = task.define('transpile-client', task.series(util.rimraf('out'), compilation.transpileTask('src', 'out')));
task.task(transpileClientTask);

// Fast compile for development time
const compileClientTask = task.define('compile-client', task.series(util.rimraf('out'), compilation.copyCodiconsTask, compilation.compileApiProposalNamesTask, compilation.compileExtensionPointNamesTask, compilation.compileTask('src', 'out')));
task.task(compileClientTask);

const watchClientTask = task.define('watch-client', task.parallel(compilation.watchTypeCheckTask('src'), compilation.watchApiProposalNamesTask, compilation.watchExtensionPointNamesTask, compilation.watchCodiconsTask));
task.task(watchClientTask);

// All
const _compileTask = task.define('compile', task.parallel(monacoTypecheckTask, compileClientTask, compileExtensionsTask, compileExtensionMediaTask));
task.task(_compileTask);

task.task(task.define('watch', task.parallel(/* monacoTypecheckWatchTask, */ watchClientTask, watchExtensionsTask)));

// Default
task.task('default', _compileTask);

process.on('unhandledRejection', (reason, p) => {
	console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
	process.exit(1);
});

// Load all the gulpfiles only if running tasks other than the editor tasks
glob.sync('gulpfile.*.ts', { cwd: import.meta.dirname })
	.forEach(f => {
		return require(`./${f}`);
	});
