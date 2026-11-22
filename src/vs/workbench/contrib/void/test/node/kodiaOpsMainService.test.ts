/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { KodiaOpsMainService } from '../../electron-main/kodiaOpsMainService.js';

suite('Kodia - KodiaOpsMainService (Real Env, SQLite Database, & Docker Safety)', function () {
	this.timeout(20_000);
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;

	setup(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-ops-')));
	});

	teardown(() => {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});

	test('inspectEnvironment detects real Node/Git toolchains, manifests, and redacts DATABASE_URL credentials', async () => {
		fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'ops-test' }));
		fs.writeFileSync(path.join(dir, '.env'), 'DB_CONNECTION=pgsql\nDATABASE_URL=postgres://admin:supersecretpw@db.internal:5432/prod\n');

		const svc = store.add(new KodiaOpsMainService());
		const report = await svc.inspectEnvironment(dir);

		assert.strictEqual(report.platform, process.platform);
		assert.ok(report.toolchains.some(t => t.name === 'node' && t.available));
		assert.ok(report.detectedManifests.includes('package.json'));
		assert.ok(report.detectedEnvDatabases.some(h => h.includes('DB_CONNECTION=pgsql')));
		const joined = report.detectedEnvDatabases.join('\n');
		assert.ok(!joined.includes('supersecretpw'), 'database password must NEVER leak in env inspection');
		assert.ok(joined.includes('[REDACTED]'));
	});

	test('inspectDatabase and queryDatabase work on a real SQLite DB and block writes by default', async () => {
		const dbDir = path.join(dir, 'database');
		fs.mkdirSync(dbDir, { recursive: true });
		const dbPath = path.join(dbDir, 'database.sqlite');

		// Create a real SQLite database with @vscode/sqlite3
		const sqlite3Mod: any = await import('@vscode/sqlite3');
		const sqlite3 = sqlite3Mod.default ?? sqlite3Mod;
		await new Promise<void>((resolve, reject) => {
			const db = new sqlite3.Database(dbPath, (err: Error | null) => {
				if (err) { reject(err); return; }
				db.serialize(() => {
					db.run('CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
					db.run(`INSERT INTO projects (name) VALUES ('Alpha'), ('Beta')`, (insErr: Error | null) => {
						db.close(() => insErr ? reject(insErr) : resolve());
					});
				});
			});
		});

		const svc = store.add(new KodiaOpsMainService());
		const schema = await svc.inspectDatabase(dir);
		assert.strictEqual(schema.engine, 'sqlite');
		assert.strictEqual(schema.tables.length, 1);
		assert.strictEqual(schema.tables[0].name, 'projects');
		assert.strictEqual(schema.tables[0].rowCount, 2);
		assert.ok(schema.tables[0].columns.some(c => c.name === 'id' && c.primaryKey));

		// Read-only SELECT succeeds
		const sel = await svc.queryDatabase(dir, 'SELECT id, name FROM projects ORDER BY id');
		assert.strictEqual(sel.error, undefined);
		assert.strictEqual(sel.rowCount, 2);
		assert.strictEqual(sel.rows[0].name, 'Alpha');

		// Mutating DELETE refused when allowWrite is false
		const blocked = await svc.queryDatabase(dir, 'DELETE FROM projects');
		assert.match(blocked.error ?? '', /Refused non-read-only SQL/i);

		// Explicit allowWrite = true executes INSERT
		const ins = await svc.queryDatabase(dir, `INSERT INTO projects (name) VALUES ('Gamma')`, undefined, true);
		assert.strictEqual(ins.error, undefined);
		const after = await svc.queryDatabase(dir, 'SELECT COUNT(*) AS c FROM projects');
		assert.strictEqual(after.rows[0].c, 3);
	});

	test('getDockerLogs rejects invalid container names / injection attempts before invoking docker', async () => {
		const svc = store.add(new KodiaOpsMainService());
		const bad = await svc.getDockerLogs('--privileged; rm -rf /');
		assert.strictEqual(bad.available, false);
		assert.match(bad.error ?? '', /Invalid container name/i);
	});
});
