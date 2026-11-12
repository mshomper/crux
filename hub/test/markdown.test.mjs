// Markdown in agents' chat messages (markdown.js): lists and tables right under a text line, nesting, alignment,
// bold and links inside them. The first text is the orchestrator's message from Matt's screenshot, word for word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { md, inline } from '../public/markdown.js';

const MATT = "I merged #28, pulled it into your folder, and restarted the hub. It's live on version 0.10.3, and your phone app should reload itself.\n\nCheck these on your iPhone:\n- the usage meters in their own row under the map strip\n- the glow staying inside the strip\n- the framed Back button\n- the area around the notch\n\nIf anything still looks crowded, send a screenshot.\n\nStill yours whenever you have time:\n- **Phone check:** it shows whether boxes still zoom or jump when you type.\n- **Merge #20:** the rolling decision records.\n- **Retire the finished workers:** usage-meters, permission-tune, map-core-2 and hub-polish-2. Tell me once you've reviewed their work.";

test("Matt's message: both lists render as lists, with bold inside the items", () => {
  const h = md(MATT);
  assert.ok(h.includes('<p>Check these on your iPhone:</p><ul><li>the usage meters in their own row under the map strip</li><li>the glow staying inside the strip</li><li>the framed Back button</li><li>the area around the notch</li></ul>'), h);
  assert.ok(h.includes('<p>If anything still looks crowded, send a screenshot.</p>'));
  assert.ok(h.includes('<p>Still yours whenever you have time:</p><ul><li><strong>Phone check:</strong> it shows whether boxes still zoom or jump when you type.</li><li><strong>Merge #20:</strong> the rolling decision records.</li>'));
  assert.ok(!/(^|>)- /.test(h), 'no literal hyphens left');
  assert.equal((h.match(/<li>/g) || []).length, 7);
});

test('a table right under a text line renders, with alignment, an empty header cell and a pipe inside a cell', () => {
  const h = md('Plans compared:\n| | Personal | Standard |\n|---|:---:|---:|\n| Price | Free | $8 a month |\n| Users | Up to 6 | a \\| b |\nAfter the table.');
  assert.ok(h.startsWith('<p>Plans compared:</p><div class="md-table-box"><table class="md-table">'), h);
  assert.ok(h.includes('<th></th><th style="text-align:center">Personal</th><th style="text-align:right">Standard</th>'));
  assert.ok(h.includes('<td>Price</td><td style="text-align:center">Free</td><td style="text-align:right">$8 a month</td>'));
  assert.ok(h.includes('<td style="text-align:right">a | b</td>'));
  assert.ok(h.endsWith('</table></div><p>After the table.</p>'), 'a text line after the table is its own paragraph');
});

test('the Tailscale table from an earlier orchestrator message', () => {
  const src = '## Tailscale plans\n\n| | Personal | Standard | Premium | Enterprise |\n|---|---|---|---|---|\n| Price | Free | $8 per user per month | $18 per user per month | Custom |\n| Users | Up to 6 | No limit | No limit | Custom |\n| Main extras | All the basics | Automatic user sync, MDM settings, device posture checks | Network logs, temporary access, regional routing | Custom subdomain |\n\nEverything the hub needs is in the free tier.';
  const h = md(src);
  assert.ok(h.startsWith('<p><strong>Tailscale plans</strong></p><div class="md-table-box">'));
  assert.equal((h.match(/<tr>/g) || []).length, 4);
  assert.equal((h.match(/<th>/g) || []).length, 5);
  assert.ok(h.endsWith('<p>Everything the hub needs is in the free tier.</p>'));
});

test('rows with too few or too many cells are fitted to the header; GFM tables without outer pipes', () => {
  const h = md('a | b\n--- | ---\n2 | 3 | 4\nplain text after');
  assert.ok(h.includes('<th>a</th><th>b</th>'), h);
  assert.ok(h.includes('<tr><td>2</td><td>3</td></tr>'), 'extra cell dropped');
  assert.ok(h.endsWith('</div><p>plain text after</p>'), 'a line with no pipe ends the table');
  const short = md('| a | b |\n|---|---|\n| 1 |');
  assert.ok(short.includes('<tr><td>1</td><td></td></tr>'), short);
});

test('numbered lists interrupt a paragraph only from 1; numbers mid-sentence stay text', () => {
  assert.equal(md('Steps:\n1. pull\n2. **test**\n3. push'), '<p>Steps:</p><ol><li>pull</li><li><strong>test</strong></li><li>push</li></ol>');
  assert.equal(md('We shipped it in\n2. then fixed it'), '<p>We shipped it in<br>2. then fixed it</p>');
  assert.equal(md('3. third\n4. fourth'), '<ol start="3"><li>third</li><li>fourth</li></ol>');
});

test('nested lists by indentation, and a list item that wraps onto the next line', () => {
  const h = md('Plan:\n- phone\n  - inputs at 16px\n  - keyboard\n    1. iPhone\n    2. Android\n- desktop\ncontinued line');
  assert.equal(h, '<p>Plan:</p><ul><li>phone<ul><li>inputs at 16px</li><li>keyboard<ol><li>iPhone</li><li>Android</li></ol></li></ul></li><li>desktop<br>continued line</li></ul>');
});

test('a blank line between items keeps one list; a paragraph after a blank line ends it', () => {
  assert.equal(md('- a\n\n- b\n\nAfter.'), '<ul><li>a</li><li>b</li></ul><p>After.</p>');
  assert.equal(md('* star\n+ plus'), '<ul><li>star</li><li>plus</li></ul>');
});

test('links: markdown links and bare https links; nothing else becomes a link', () => {
  assert.equal(inline('See [Tailscale pricing](https://tailscale.com/pricing).'), 'See <a href="https://tailscale.com/pricing" target="_blank" rel="noopener">Tailscale pricing</a>.');
  assert.equal(inline('PR: https://github.com/mshomper/crux/pull/26.'), 'PR: <a href="https://github.com/mshomper/crux/pull/26" target="_blank" rel="noopener">https://github.com/mshomper/crux/pull/26</a>.');
  assert.equal(inline('[bad](javascript:alert(1))'), '[bad](javascript:alert(1))');
  const li = md('- **PR #26:** https://github.com/mshomper/crux/pull/26');
  assert.ok(li.includes('<li><strong>PR #26:</strong> <a href="https://github.com/mshomper/crux/pull/26"'), li);
});

test('code stays code: no bold, links or lists inside it; everything is escaped', () => {
  assert.equal(inline('run `**not bold** https://x.y`'), 'run <code>**not bold** https://x.y</code>');
  assert.equal(md('```js\n- not a list\n<b>x</b>\n```'), '<pre><code>- not a list\n&lt;b&gt;x&lt;/b&gt;</code></pre>');
  assert.equal(md('<script>alert(1)</script> & "quotes"'), '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;</p>');
  assert.equal(inline('2 * 3 * 4 and a_b_c'), '2 * 3 * 4 and a_b_c', 'lone stars and underscores are left alone');
  assert.equal(inline('*soft* and **hard**'), '<em>soft</em> and <strong>hard</strong>');
});

test('quotes and rules', () => {
  assert.equal(md('> quoted\n> more\n\n---\n\nend'), '<blockquote><p>quoted<br>more</p></blockquote><hr><p>end</p>');
});
