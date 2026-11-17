// The page's handling of the live stream (decision 74 B, step A): the cursor (resync, drop, apply, resume address) and
// what it keeps of a thread's older conversation across a fresh state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { streamStep, afterStateRead, streamUrl } from '../public/stream-state.js';
import { keepHeld } from '../public/held.js';

const fresh = () => ({ seq: 0, seqSeen: 0, boot2: null });

test('a message applies and moves the cursor; one already in the state is dropped', () => {
  const s = { seq: 10, seqSeen: 10, boot2: 'b' };
  assert.equal(streamStep(s, 9, { type: 'message' }), 'drop');
  assert.equal(streamStep(s, 10, { type: 'message' }), 'drop');
  assert.equal(streamStep(s, 11, { type: 'message' }), 'apply');
  assert.equal(s.seq, 11);
});

test('a resync with an id below the cursor (a restarted hub counts from the start again) is not thrown away, and resets the cursor', () => {
  const s = { seq: 5000, seqSeen: 5000, boot2: 'old-boot' };
  assert.equal(streamStep(s, 3, { type: 'resync' }), 'resync');
  assert.deepEqual([s.seq, s.seqSeen], [0, 0]);
  // the new hub's own messages, with small ids, then apply while the state is on its way
  assert.equal(streamStep(s, 4, { type: 'message' }), 'apply');
});

test('after a state read the stream resumes from the state; if it had run ahead, say so', () => {
  const s = { seq: 40, seqSeen: 44, boot2: 'a' };
  assert.equal(afterStateRead(s, { boot: 'a', seq: 41 }), true);
  assert.deepEqual(s, { seq: 41, seqSeen: 41, boot2: 'a' });
  assert.equal(afterStateRead(s, { boot: 'a', seq: 41 }), false);
  assert.equal(streamUrl(s), '/api/stream?boot=a&last=41');
  assert.equal(streamUrl(fresh()), '/api/stream');
});

// ---------- what the page keeps of older conversation ----------
let n = 0;
const msg = (thread, i) => ({ id: `m${thread}${i}`, ts: new Date(1e12 + i * 1000).toISOString(), type: 'message', thread, from: 'you', text: `t${i}` });
const range = (thread, a, b) => Array.from({ length: b - a + 1 }, (_, k) => msg(thread, a + k));
const proj = (events, older = {}) => ({ name: 'p', agents: [], events, older });

test('older events the page holds come back when they join up with the new window', () => {
  const held = new Map();
  const before = [proj([...range('t', 1, 70), ...range('t', 71, 100)])];   // a window and a paged older part
  const after = [proj(range('t', 95, 130), { t: 94 })];                     // a new window overlapping the old one
  keepHeld(before, after, held);
  assert.deepEqual(after[0].events.map(e => e.text), Array.from({ length: 130 }, (_, i) => `t${i + 1}`));
  assert.equal(after[0].older.t, 0);
});

test('held events that no longer join up with the window are dropped: no gap that Show older could not fill', () => {
  const held = new Map();
  const before = [proj(range('t', 1, 100))];
  const after = [proj(range('t', 301, 330), { t: 300 })];   // the page was away: the window moved far past it
  keepHeld(before, after, held);
  assert.deepEqual(after[0].events.map(e => e.text)[0], 't301');
  assert.equal(after[0].events.length, 30);
  assert.equal(after[0].older.t, 300);
  assert.equal(held.get('p').size, 0, 'the stale ones are forgotten');
});

test('one thread that joins and one that does not are decided apart', () => {
  const held = new Map();
  const before = [proj([...range('a', 1, 50), ...range('b', 1, 50)])];
  const after = [proj([...range('a', 41, 60), ...range('b', 200, 220)], { a: 40, b: 199 })];
  keepHeld(before, after, held);
  assert.equal(after[0].events.filter(e => e.thread === 'a').length, 60);
  assert.equal(after[0].events.filter(e => e.thread === 'b').length, 21);
  assert.equal(after[0].older.a, 0);
  assert.equal(after[0].older.b, 199);
});
