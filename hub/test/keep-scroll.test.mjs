// A pop-up opening or closing leaves the thread where it was (Matt's phone click-test, 0.17.1): where the lists are is
// noted on every tap, and put back when a dialog opens or closes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { snapshot, restore, LISTS } from '../public/keep-scroll.js';

const list = (top, height = 3000, client = 800) => ({ scrollTop: top, scrollHeight: height, clientHeight: client, isConnected: true });
const doc = (lists, y = 0) => ({ querySelectorAll: sel => (assert.equal(sel, LISTS), lists), defaultView: { scrollY: y } });

test('a list sent to its top while a pop-up opens goes back to where it was', () => {
  const feed = list(1100), s = snapshot(doc([feed]));
  feed.scrollTop = 0;                        // what the iPhone did
  assert.equal(restore(s), 1);
  assert.equal(feed.scrollTop, 1100);
  assert.equal(restore(s), 0, 'nothing to do when it already is there');
});

test('a list at its end stays at its end, so a message that arrived meanwhile is followed', () => {
  const feed = list(2200), s = snapshot(doc([feed]));
  feed.scrollHeight = 3400; feed.scrollTop = 0;
  restore(s);
  assert.equal(feed.scrollTop, 2600);
});

test('a list no longer on the page is left alone; the page scroll comes back too', () => {
  const gone = list(500), s = snapshot(doc([gone], 40));
  gone.isConnected = false; gone.scrollTop = 0;
  let to = null;
  restore(s, { scrollY: 0, scrollTo: (x, y) => { to = y; } });
  assert.equal(gone.scrollTop, 0);
  assert.equal(to, 40);
});

test('the hub installs it, and it watches every dialog, not one by one', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /import \{ installKeepScroll \} from '\.\/keep-scroll\.js';\r?\ninstallKeepScroll\(\);/);
  const src = readFileSync(new URL('../public/keep-scroll.js', import.meta.url), 'utf8');
  assert.match(src, /attributeFilter: \['open'\], subtree: true/);
  assert.match(src, /for \(const t of \['pointerdown', 'click', 'keydown'\]\) doc\.addEventListener\(t, note, true\)/);
});
