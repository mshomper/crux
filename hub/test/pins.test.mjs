// Pinned threads as split columns (decision 39 A, R008): the rules in pins.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { initial, normalize, fit, layout, open, pin, unpin, close, show, focus, replacedBy, isPinned, pinnedCount, prune, MAX_COLS, MIN_COL, RAIL_W } from '../public/pins.js';

test('prune drops columns for threads that are not in the project, and keeps the rest as they were', () => {
  const valid = new Set(['needs', 'orchestrator', 'a', 'b']);
  const s = { cols: [{ t: 'a', pinned: true }, { t: 'gone', pinned: true }, { t: 'b', pinned: false }], kb: 'gone', recent: ['gone', 'b', 'a'] };
  const t = prune(s, valid);
  assert.deepEqual(t.cols, [{ t: 'a', pinned: true }, { t: 'b', pinned: false }]);
  assert.equal(t.kb, 'b', 'the keyboard goes to the most recently used column left');
  assert.deepEqual(t.recent, ['b', 'a']);
  const ok = { cols: [{ t: 'a', pinned: true }], kb: 'a', recent: ['a'] };
  assert.equal(prune(ok, valid), ok, 'nothing to drop: the same state, so nothing is written');
  assert.deepEqual(prune({ cols: [{ t: 'x', pinned: true }], kb: 'x', recent: ['x'] }, valid, 'orchestrator'), initial('orchestrator'));
  assert.deepEqual(prune({ cols: [{ t: 'x', pinned: true }], kb: 'x', recent: ['x'] }, valid, 'other-project-thread'), initial('needs'), 'a fallback from another project is not used');
});

const ts = s => s.cols.map(c => c.t + (c.pinned ? '*' : ''));
const vis = (s, n) => layout(s, n).visible.map(c => c.t);
const fold = (s, n) => layout(s, n).folded.map(c => c.t);

test('nothing pinned: one column, and a click replaces it, exactly as the single conversation did', () => {
  let s = initial('orchestrator');
  assert.deepEqual(ts(s), ['orchestrator']);
  s = open(s, 'route-finder');
  assert.deepEqual(ts(s), ['route-finder']);
  assert.equal(s.kb, 'route-finder');
  s = open(s, 'needs');
  assert.deepEqual(ts(s), ['needs']);
  assert.deepEqual(s.recent, ['needs'], 'closed threads leave the recent list');
});

test('pinning the open thread keeps it; the next thread opens beside it, up to three columns', () => {
  let s = pin(initial('orchestrator'), 'orchestrator');
  assert.deepEqual(ts(s), ['orchestrator*']);
  s = open(s, 'route-finder');
  assert.deepEqual(ts(s), ['orchestrator*', 'route-finder'], 'every column was pinned: a new column');
  assert.equal(s.kb, 'route-finder', 'the keyboard goes to the thread you opened');
  s = open(s, 'elevation-chart');
  assert.deepEqual(ts(s), ['orchestrator*', 'elevation-chart'], 'a loose column is open: the click replaces it');
  s = pin(s, 'elevation-chart');
  s = open(s, 'offline-maps');
  assert.deepEqual(ts(s), ['orchestrator*', 'elevation-chart*', 'offline-maps'], 'third column');
});

test('at the limit of three pinned, a click replaces the column that has the keyboard', () => {
  let s = { cols: [{ t: 'a', pinned: true }, { t: 'b', pinned: true }, { t: 'c', pinned: true }], kb: 'b', recent: ['b', 'c', 'a'] };
  s = open(s, 'd');
  assert.deepEqual(ts(s), ['a*', 'd', 'c*'], 'd takes b\'s place, as a loose column; b is unpinned');
  assert.equal(s.kb, 'd');
  assert.deepEqual(s.recent, ['d', 'c', 'a']);
  s = open(s, 'e');
  assert.deepEqual(ts(s), ['a*', 'e', 'c*'], 'the next click replaces the loose column, so only one pin was given up');
});

test('a click on a thread that is already open just gives it the keyboard', () => {
  let s = { cols: [{ t: 'a', pinned: true }, { t: 'b', pinned: false }], kb: 'b', recent: ['b', 'a'] };
  s = open(s, 'a');
  assert.deepEqual(ts(s), ['a*', 'b']);
  assert.equal(s.kb, 'a');
  assert.deepEqual(s.recent, ['a', 'b']);
});

test('the pin on a row opens that thread beside the keyboard column, pinned; the keyboard stays put', () => {
  let s = { cols: [{ t: 'a', pinned: true }, { t: 'b', pinned: true }], kb: 'a', recent: ['a', 'b'] };
  s = pin(s, 'c');
  assert.deepEqual(ts(s), ['a*', 'c*', 'b*']);
  assert.equal(s.kb, 'a');
  assert.deepEqual(s.recent, ['a', 'c', 'b'], 'the new column is next in line to stay visible');
  // no room: the loose column makes way
  s = pin({ cols: [{ t: 'a', pinned: true }, { t: 'x', pinned: false }, { t: 'b', pinned: true }], kb: 'a', recent: ['a', 'x', 'b'] }, 'c');
  assert.deepEqual(ts(s), ['a*', 'c*', 'b*']);
  // three pinned: the keyboard column gives up its place and the keyboard moves to the new one
  s = pin({ cols: [{ t: 'a', pinned: true }, { t: 'b', pinned: true }, { t: 'c', pinned: true }], kb: 'b', recent: ['b', 'a', 'c'] }, 'd');
  assert.deepEqual(ts(s), ['a*', 'd*', 'c*']);
  assert.equal(s.kb, 'd');
  assert.equal(pinnedCount(s), MAX_COLS);
});

test('unpin closes the column; the last column only stops being pinned', () => {
  let s = { cols: [{ t: 'a', pinned: true }, { t: 'b', pinned: true }], kb: 'a', recent: ['a', 'b'] };
  s = unpin(s, 'a');
  assert.deepEqual(ts(s), ['b*']);
  assert.equal(s.kb, 'b', 'the keyboard goes to the most recently used column left');
  s = unpin(s, 'b');
  assert.deepEqual(ts(s), ['b']);
  assert.equal(isPinned(s, 'b'), false);
  assert.equal(unpin(s, 'b'), s, 'nothing to unpin');
});

test('close takes a loose column away; the last column never closes', () => {
  let s = { cols: [{ t: 'a', pinned: true }, { t: 'b', pinned: false }], kb: 'b', recent: ['b', 'a'] };
  s = close(s, 'b');
  assert.deepEqual(ts(s), ['a*']);
  assert.equal(s.kb, 'a');
  assert.equal(close(s, 'a'), s);
});

test('how many columns fit the measured width (520 px each; the rail takes 56 px when some fold)', () => {
  assert.equal(MIN_COL, 520);
  assert.equal(RAIL_W, 56);
  // the conversation area: window minus the 268 px sidebar, minus 360 px when the board is open
  const area = (w, board) => w - 268 - (board ? 360 : 0);
  assert.equal(fit(area(3170, false), 3), 3, 'wide screen: three');
  assert.equal(fit(area(3170, true), 3), 3, 'wide screen with the board: still three');
  assert.equal(fit(area(1920, true), 3), 2, '1920 with the board: two, one folds');
  assert.equal(fit(area(1440, false), 3), 2, 'laptop: two, one folds');
  assert.equal(fit(area(1440, true), 3), 1, 'laptop with the board: one, two fold');
  assert.equal(fit(area(1440, true), 2), 1);
  assert.equal(fit(400, 3), 1, 'never fewer than one');
  assert.equal(fit(5000, 1), 1, 'never more than are open');
  assert.equal(fit(5000, 7), 3, 'never more than three');
  assert.equal(fit(1040, 2), 2, 'exactly two at 520');
  assert.equal(fit(1039, 2), 1);
  // a wider sidebar takes width away the same way
  assert.equal(fit(1920 - 600, 3), 2);
});

test('fold order: the keyboard column always stays, then the most recently used; the least recently used folds first', () => {
  const s = { cols: [{ t: 'a', pinned: true }, { t: 'b', pinned: true }, { t: 'c', pinned: true }], kb: 'c', recent: ['c', 'a', 'b'] };
  assert.deepEqual(vis(s, 3), ['a', 'b', 'c']);
  assert.deepEqual(vis(s, 2), ['a', 'c'], 'left-to-right order is kept');
  assert.deepEqual(fold(s, 2), ['b']);
  assert.deepEqual(vis(s, 1), ['c']);
  assert.deepEqual(fold(s, 1), ['a', 'b']);
  // the keyboard stays even when it is not first in the recent list
  assert.deepEqual(vis({ ...s, kb: 'b' }, 1), ['b']);
});

test('a rail click shows the folded thread in place of the least recently used visible column, with the keyboard', () => {
  const s = { cols: [{ t: 'a', pinned: true }, { t: 'b', pinned: true }, { t: 'c', pinned: true }], kb: 'c', recent: ['c', 'a', 'b'] };
  assert.equal(replacedBy(s, 2), 'a');
  const t = show(s, 'b', 2);
  assert.deepEqual(ts(t), ['b*', 'a*', 'c*'], 'b takes a\'s position');
  assert.deepEqual(vis(t, 2), ['b', 'c']);
  assert.deepEqual(fold(t, 2), ['a']);
  assert.equal(t.kb, 'b');
  // one fits: the folded one replaces the keyboard column
  const one = show(s, 'a', 1);
  assert.deepEqual(vis(one, 1), ['a']);
  assert.equal(one.kb, 'a');
  // a click in the list on a folded thread does the same
  assert.deepEqual(open(s, 'b', 2), t);
  // already visible: just the keyboard
  assert.deepEqual(show(s, 'a', 2), focus(s, 'a'));
});

test('a new column at a narrow width shows with the keyboard; the older ones fold', () => {
  let s = pin(initial('orchestrator'), 'orchestrator');
  s = open(s, 'route-finder', 1);
  assert.deepEqual(vis(s, 1), ['route-finder']);
  assert.deepEqual(fold(s, 1), ['orchestrator']);
});

test('stored states are checked when read back', () => {
  assert.deepEqual(normalize(null, 'orchestrator'), initial('orchestrator'));
  assert.deepEqual(normalize({ cols: [] }, 'needs'), initial('needs'));
  const s = normalize({ cols: [{ t: 'a' }, { t: 'a', pinned: true }, { t: 'b' }, { t: 'c', pinned: true }, { t: 'd', pinned: true }, { t: '' }, 5], kb: 'zz', recent: ['b', 'q'] });
  assert.deepEqual(ts(s), ['a', 'b*', 'c*'], 'no duplicates, at most three, only one loose');
  assert.equal(s.kb, 'a', 'a keyboard thread that is not open falls back to the first column');
  assert.deepEqual(s.recent, ['a', 'b', 'c'], 'every open thread is in the recent list, keyboard first');
});
