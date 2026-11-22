/*---------------------------------------------------------------------------------------------
 *  Kodia: fetches Microsoft's js-debug standalone DAP server (the adapter behind VS Code's JavaScript debugging),
 *  pinned and checksummed, into .build/js-debug-dap. The Kodia debugger tests drive it through VS Code's real
 *  DebugSession. The product ships the same adapter as the built-in extension ms-vscode.js-debug (product.json).
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const VERSION = '1.140.1';
const SHA256 = 'c72fab31bcbfdce6ad1f42adfd28eff8d4681dd3b03b5e2e6f9e72e6f9927faf';
const URL = `https://github.com/microsoft/vscode-js-debug/releases/download/v${VERSION}/js-debug-dap-v${VERSION}.tar.gz`;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, '.build', 'js-debug-dap');
const marker = path.join(dest, 'js-debug', 'kodia-version.txt');

if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === VERSION) {
	console.log(`js-debug DAP server ${VERSION} is already in ${dest}`);
	process.exit(0);
}

const response = await fetch(URL);
if (!response.ok) { throw new Error(`Download failed: ${response.status} ${URL}`); }
const data = Buffer.from(await response.arrayBuffer());
const actual = createHash('sha256').update(data).digest('hex');
if (actual !== SHA256) { throw new Error(`Checksum mismatch for ${URL}: expected ${SHA256}, got ${actual}`); }

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
const archive = path.join(dest, `js-debug-dap-v${VERSION}.tar.gz`);
fs.writeFileSync(archive, data);
execFileSync('tar', ['-xzf', path.basename(archive)], { cwd: dest, stdio: 'inherit' }); // relative: GNU tar reads "C:" as a host
fs.rmSync(archive);
// the repository's package.json says "type": "module"; js-debug's bundle is CommonJS
fs.writeFileSync(path.join(dest, 'js-debug', 'package.json'), '{ "type": "commonjs" }\n');
fs.writeFileSync(marker, VERSION + '\n');
console.log(`js-debug DAP server ${VERSION} installed in ${dest}`);
