// Phone pass 2, from Matt's iPhone: a slight zoom on tapping a box, and the list jumping while he types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isIOS, noFocusZoom } from '../public/viewport.js';
import { debugWanted, jumpCause, moveKind } from '../public/debug-phone.js';

const pub = f => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const META = 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';

test('iPhone and iPad get no automatic zoom on a tapped box; Android and desktops keep the page meta as it is', () => {
  assert.ok(isIOS(IPHONE));
  assert.ok(isIOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5), 'an iPad asking for the desktop site');
  assert.ok(!isIOS(ANDROID, 'Linux armv8l', 5));
  assert.ok(!isIOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0), 'a Mac');
  assert.equal(noFocusZoom(META, true), `${META}, maximum-scale=1`);
  assert.equal(noFocusZoom(META, false), META, 'pinch-zoom stays on Android');
  assert.equal(noFocusZoom(`${META}, maximum-scale=1`, true), `${META}, maximum-scale=1`, 'added once');
  assert.doesNotMatch(/<meta name="viewport" content="([^"]+)"/.exec(pub('index.html'))[1], /maximum-scale|user-scalable/, 'the page itself never blocks zoom');
});

test('the phone check is off unless asked for, and remembered on the device', () => {
  assert.equal(debugWanted('', null), false);
  assert.equal(debugWanted('?debug=phone', null), true);
  assert.equal(debugWanted('', '1'), true, 'remembered');
  assert.equal(debugWanted('?debug=off', '1'), false);
  assert.equal(debugWanted('?project=crux&card=approval%3Ax', null), false);
});

test('a jump is told by what changed in that frame, biggest first', () => {
  const a = { vvTop: 0, vvH: 490, appTop: 0, scroll: 900, feedH: 300, boxH: 44, scrollY: 0, scale: 1 };
  assert.equal(jumpCause(a, { ...a, scroll: 878, boxH: 66 }), 'list scroll -22 · box height +22');
  assert.equal(jumpCause(a, { ...a, vvTop: 120, appTop: 120 }), 'view top +120 · app top +120');
  assert.equal(jumpCause(a, a), 'nothing measured changed');
  // The box gaining a line (the list follows by the same amount) and the keyboard are expected; the rest are jumps.
  assert.equal(moveKind(a, { ...a, scroll: 922, feedH: 278, boxH: 66 }, -22), 'line');
  assert.equal(moveKind(a, { ...a, vvH: 844, feedH: 654 }, 354), 'keyboard');
  assert.equal(moveKind(a, { ...a, scroll: 870 }, 30), 'jump');
});

test('the activity line is always one line, so the message box below it never moves', () => {
  const rule = /\.activity\{([^}]*)\}/.exec(pub('style.css'))[1];
  for (const bit of ['height:20px', 'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis']) assert.ok(rule.includes(bit), bit);
  assert.doesNotMatch(rule, /min-height/);
});

test('a scroll that reaches the end of the list never drags the page', () => {
  assert.match(/\.feed\{([^}]*)\}/.exec(pub('style.css'))[1], /overscroll-behavior:contain/);
});

test('the list is redrawn only when what it shows changed, and a box keeps the list still as it grows', () => {
  // Since decision 39 each column is a Conversation (conversation.js) with its own list and box.
  const conv = pub('conversation.js'), app = pub('app.js');
  assert.match(conv, /export function setFeed\(feed, html, where = ''\)/);
  assert.match(conv, /setFeed\(feed, this\.host\.feed\(this\.thread\)/, 'a column draws its list through setFeed');
  for (const src of [conv, app]) assert.doesNotMatch(src, /feed\.innerHTML = (?!html;)/, 'every redraw goes through setFeed');
  const grow = /export function growBox\(box, max\) \{([\s\S]*?)\n\}/.exec(conv)[1];
  assert.match(grow, /closest\('\.conv'\)/, 'the list of the box\'s own column');
  assert.match(grow, /const top = feed\.scrollTop/, 'remembers where the list was');
  assert.match(grow, /feed\.scrollTop = /, 'and puts it back after measuring');
  assert.match(conv, /autosize\(\) \{ growBox\(this\.input, 200\); \}/);
});
