// Phone pass: no zoom on tap, short one-line hints, and the hub kept above the keyboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fitViewport, KEYBOARD_SHARE } from '../public/viewport.js';
import { composerHint, replyHint, filterHint } from '../public/composer-keys.js';

const pub = f => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');

test('the viewport meta fits the screen and the notch, and never stops you zooming', () => {
  const meta = /<meta name="viewport" content="([^"]+)"/.exec(pub('index.html'))[1];
  for (const part of ['width=device-width', 'initial-scale=1', 'viewport-fit=cover']) assert.ok(meta.includes(part), part);
  assert.doesNotMatch(meta, /user-scalable\s*=\s*(no|0)|maximum-scale/, 'zoom stays allowed');
});

test('every box is 16px or more on phones and touch screens, so iPhone does not zoom in when one is tapped', () => {
  const css = pub('style.css');
  const block = /@media \(max-width:720px\),\(pointer:coarse\)\{([^}]*\})/.exec(css);
  assert.ok(block, 'a phone and touch block');
  assert.match(block[1], /:root :is\(input,textarea,select,\.qbox\)\{font-size:16px\}/);
  // :root :is(...) outranks every size the boxes set for themselves (one class and one element at most).
  for (const sel of ['.qbox{', '.board-filter input{', '.composer textarea{']) assert.ok(css.includes(sel), sel);
});

test('the page and the app root never scroll sideways', () => {
  const css = pub('style.css');
  assert.match(css, /html,body\{overflow:hidden;overflow:clip/);
  assert.match(css, /\.app\{[^}]*overflow:clip/);
  assert.doesNotMatch(css, /width:100vw/, 'no full-viewport widths, which overflow by the scrollbar');
});

test('on a phone the map strip steps aside while the keyboard is open, without changing size', () => {
  const css = pub('style.css');
  const phone = css.slice(css.lastIndexOf('@media (max-width:720px){'));
  const rule = /\.vv\.kb \.hud-slot\{([^}]*)\}/.exec(phone);
  assert.ok(rule, 'inside the phone block, only while the keyboard is open');
  assert.match(rule[1], /position:absolute/, 'out of the layout, so its row closes');
  assert.match(rule[1], /visibility:hidden/);
  assert.doesNotMatch(rule[1], /display:none|height:0/, 'keeps its size, so the map does not redraw');
});

test('phone hints are a word or two on one line; the long ones stay on wide screens', () => {
  for (const thread of ['needs', 'orchestrator', 'phone-polish-with-a-long-name']) {
    const h = composerHint({ thread, narrow: true, fine: false });
    assert.ok(h.length <= 12, `${thread}: "${h}"`);
    assert.doesNotMatch(h, /Alt|4A|all/);
  }
  assert.equal(composerHint({ thread: 'x', narrow: true, retired: true }), 'Retired');
  assert.match(composerHint({ thread: 'orchestrator', narrow: false, fine: true }), /"4A 7B".*Alt\+Enter/);
  assert.doesNotMatch(composerHint({ thread: 'orchestrator', narrow: false, fine: false }), /Alt\+Enter/, 'no keyboard hint on a touch screen');
  assert.equal(replyHint({ narrow: true, several: true }), 'Reply');
  assert.equal(replyHint({ narrow: false, several: true }), 'Answer this one');
  assert.equal(filterHint({ narrow: true }), 'Filter');
  assert.match(filterHint({ narrow: false }), /D0031/);
});

test('the hub is sized to what you can see, and follows Safari when it pans for the keyboard', () => {
  const a = fitViewport({ width: 390, height: 844, offsetTop: 0, scale: 1 });
  assert.deepEqual([a.height, a.top, a.keyboard, a.tallest], [844, 0, false, 844]);
  // A box is tapped: the keyboard takes about 40% of the screen and Safari pans down by 120.
  const b = fitViewport({ width: 390, height: 490, offsetTop: 120, scale: 1 }, a, true);
  assert.deepEqual([b.height, b.top, b.keyboard, b.tallest], [490, 120, true, 844]);
  // The same shrink without a focused box (the browser bar coming back) is not the keyboard.
  assert.equal(fitViewport({ width: 390, height: 490, offsetTop: 0, scale: 1 }, a, false).keyboard, false);
  // A small shrink with a box focused (a bar, not a keyboard) is not the keyboard either.
  assert.equal(fitViewport({ width: 390, height: 844 * KEYBOARD_SHARE + 5, offsetTop: 0, scale: 1 }, a, true).keyboard, false);
});

test('turning the phone starts a new tallest height; a pinch-zoom leaves the layout alone', () => {
  const portrait = fitViewport({ width: 390, height: 844, offsetTop: 0, scale: 1 });
  const landscape = fitViewport({ width: 844, height: 360, offsetTop: 0, scale: 1 }, portrait, true);
  assert.equal(landscape.tallest, 360);
  assert.equal(landscape.keyboard, false, 'landscape is short, not a keyboard');
  const zoomed = fitViewport({ width: 195, height: 422, offsetTop: 300, scale: 2 }, portrait, false);
  assert.equal(zoomed.zoomed, true);
  assert.equal(zoomed.height, 844, 'keeps the last layout');
  assert.equal(fitViewport(null, portrait).height, 844, 'no visual viewport: nothing changes');
});
