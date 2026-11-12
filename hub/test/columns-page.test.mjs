// Pinned threads as split columns (decision 39 A, R008): how the page is put together around pins.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pub = f => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const HTML = pub('index.html'), APP = pub('app.js'), CSS = pub('columns.css'), CONV = pub('conversation.js'), COLS = pub('columns.js');

test('one conversation is a template that can exist several times: no ids inside it', () => {
  const tpl = /<template id="conv-tpl">([\s\S]*?)<\/template>/.exec(HTML)?.[1];
  assert.ok(tpl, 'the conversation template is in the page');
  assert.doesNotMatch(tpl, /\sid="/, 'ids would repeat in every column');
  for (const part of ['main-head', 'c-title', 'c-sub', 'c-pin', 'c-retire', 'feed', 'activity', 'composer', 'quick', 'tray', 'c-input']) assert.match(tpl, new RegExp(`class="[^"]*\\b${part}\\b`), part);
  assert.doesNotMatch(tpl, /data-thread=/, 'a column must not carry the page-wide "open this thread" mark');
  assert.match(CONV, /dataset\.col = thread/);
  // the window's own buttons exist once and move to the right-most header
  for (const id of ['phone-alerts', 'open-board', 'all-projects']) assert.equal(HTML.split(`id="${id}"`).length, 2, id);
  assert.match(COLS, /last\.acts\.append\(this\.winActs\)/);
});

test('a thread row holds two sibling buttons, the row and its pin, never one inside the other', () => {
  const fn = /function threadButton\([\s\S]*?\n\}/.exec(APP)[0];
  assert.match(fn, /<div class="thread-row/);
  assert.match(fn, /<\/button><button type="button" class="row-pin" data-row-pin=/, 'the pin follows the row button, as a sibling');
  assert.match(fn, /aria-label="\$\{esc\(tip\)\}" title="\$\{esc\(tip\)\}"/, 'a hover label and a name for screen readers');
  assert.match(CSS, /\.thread-row:is\(:hover,:focus-within,\.pinned\) \.row-pin\{display:grid\}/, 'shown on hover and on keyboard focus');
});

test('the phone keeps one thread at a time: no pins, no rail', () => {
  const phone = CSS.slice(CSS.indexOf('@media (max-width:720px)'));
  assert.match(phone, /\.cols \.c-pin,\.cols \.c-close,\.thread-row:is\(:hover,:focus-within,\.pinned\) \.row-pin\{display:none\}/);
  assert.match(COLS, /const shown = phone \? 1 : P\.fit\(width, n\)/);
  assert.match(COLS, /const railOn = !phone && shown < n/);
});

test('the column count comes from the measured width of the conversation area, not the screen', () => {
  assert.match(COLS, /this\.area\.clientWidth/);
  assert.match(COLS, /new ResizeObserver\(/);
  assert.doesNotMatch(COLS, /innerWidth|screen\.width/);
  assert.match(CSS, /container:conv \/ inline-size/);
  assert.match(CSS, /@container conv \(max-width:900px\)/, 'buttons become icons');
  assert.match(CSS, /@container conv \(max-width:640px\)\{[^}]*task-line\{display:none\}/, 'the task line drops out rather than wrap');
});

test('with one column the hub looks as before: column-only marks hang off .cols.multi', () => {
  for (const rule of CSS.replace(/\/\*[\s\S]*?\*\//g, '').split('}')) {
    if (/\.kb\b/.test(rule.slice(0, rule.indexOf('{')))) assert.match(rule, /\.cols\.multi/, rule.trim().slice(0, 70));
  }
  assert.match(CONV, /const n = o\.multi \? h\.waiting : 0/, 'the red count only beside other columns');
});

test('phone alerts treat the keyboard column as the one you are looking at', () => {
  assert.match(APP, /view: \(\) => \(\{ project: S\.current, thread: cols\.kb \}\)/);
});

test('a notification card already on screen is used where it is; the lock-on goes to one copy only', () => {
  const fn = /function openCard\([\s\S]*?\n\}/.exec(APP)[0];
  assert.match(fn, /\['needs', ev\?\.thread\]/, 'Needs you first, then the card\'s own thread');
  assert.match(fn, /cols\.visible\(t\)\)\.find\(c => c\?\.findCard\(card\)\)/);
  assert.doesNotMatch(fn, /document\.querySelectorAll\('\[data-card\]'\)/, 'not the first copy anywhere on the page');
});
