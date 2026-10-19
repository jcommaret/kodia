/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { decodeHTMLEntities, htmlToText } from '../../common/helpers/htmlToText.js';

suite('Kodia - web pages as text (fetch_url)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const page = `<!doctype html>
<html>
<head><title>Install &amp; setup — Docs</title><style>body { color: red }</style><script>alert(1)</script></head>
<body>
	<nav><a href="/">Home</a><a href="/blog">Blog</a></nav>
	<main>
		<h1>Install</h1>
		<p>Run   the <code>install</code>
		command, then read <a href="/docs/config">the config page</a>.</p>
		<ul><li>macOS</li><li>Linux &lt;3</li></ul>
		<pre><code class="language-sh">npm install
  --save  kodia &amp;&amp; echo ok</code></pre>
		<!-- a comment -->
	</main>
	<footer>© 2026</footer>
</body>
</html>`;

	test('keeps the title and the main content, as markdown', () => {
		const { title, text } = htmlToText(page, 'https://example.com/docs/install');
		assert.strictEqual(title, 'Install & setup — Docs');
		assert.strictEqual(text, [
			'# Install',
			'',
			'Run the `install`',
			'command, then read [the config page](https://example.com/docs/config).',
			'',
			'- macOS',
			'- Linux <3',
			'',
			'```',
			'npm install',
			'  --save  kodia && echo ok',
			'```',
		].join('\n'));
	});

	test('drops scripts, styles, navigation and footers', () => {
		const { text } = htmlToText(page);
		for (const noise of ['alert', 'color: red', 'Blog', '2026', 'a comment']) {
			assert.ok(!text.includes(noise), `"${noise}" should be gone`);
		}
	});

	test('reads the whole body when there is no main element', () => {
		const { title, text } = htmlToText('<body><div>One</div><div>Two</div></body>');
		assert.strictEqual(title, null);
		assert.strictEqual(text, 'One\n\nTwo');
	});

	test('reads minified pages: no head, unquoted attributes, role=main', () => {
		const minified = '<!doctype html><title>fs | Node.js</title><body><a href=#apicontent>Skip to content</a><div role=navigation id=column2><ul><li><a href=assert.html>Assertion testing</a></ul></div><div role=main id=apicontent><h2>fs.readFile</h2><p>See <a href=path.html>path</a>.</div></body>';
		const { title, text } = htmlToText(minified, 'https://nodejs.org/api/fs.html');
		assert.strictEqual(title, 'fs | Node.js');
		assert.strictEqual(text, '## fs.readFile\n\nSee [path](https://nodejs.org/api/path.html).');
	});

	test('keeps link text but not links to anchors, nor headings\' permalinks', () => {
		assert.strictEqual(htmlToText('<p><a href="#usage">Usage</a></p>').text, 'Usage');
		assert.strictEqual(htmlToText('<h2>Usage<a href="#usage">#</a></h2>').text, '## Usage');
	});

	test('a code block is just its code, without the toolbar around it', () => {
		const html = '<pre><code class="language-js">let a = 1</code><div class="toolbar"><span>javascript</span><button>copy</button></div></pre>';
		assert.strictEqual(htmlToText(html).text, '```\nlet a = 1\n```');
	});

	test('decodes named and numeric entities', () => {
		assert.strictEqual(decodeHTMLEntities('&lt;a&gt; &#39;x&#x27; &nbsp;&unknown;'), '<a> \'x\'  &unknown;');
	});
});
