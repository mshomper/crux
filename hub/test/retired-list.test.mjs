// The Retired section of the thread list (retired-list.js): which retired workers are recent, the counts, Show older.
import test from 'node:test';
import assert from 'node:assert/strict';
import { retiredView, retiredTimes, RETIRED_RECENT_DAYS } from '../public/retired-list.js';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = ms => new Date(ms).toISOString();
const w = (name, state = 'retired') => ({ name, thread: name, role: 'worker', state });
const retired = (agent, daysAgo) => ({ type: 'agent_retired', agent, thread: agent, ts: iso(NOW - daysAgo * DAY) });

const workers = [w('live', 'idle'), w('new'), w('mid'), w('old'), w('ancient')];
const events = [retired('ancient', 30), retired('old', 3.5), retired('mid', 2.9), retired('new', 0.1)];
const names = list => list.map(a => a.name);

test('the cut-off is one named constant of 3 days', () => assert.equal(RETIRED_RECENT_DAYS, 3));

test('recent and older split at the cut-off, newest retirement first; live workers never appear', () => {
  const v = retiredView(workers, events, { now: NOW });
  assert.deepEqual(names(v.recent), ['new', 'mid']);
  assert.deepEqual(names(v.older), ['old', 'ancient']);
  assert.deepEqual(names(v.shown), ['new', 'mid'], 'older ones hidden by default');
  assert.equal(v.count, 2, 'Retired (N) counts the recent ones');
  assert.equal(v.olderCount, 2, 'Show older (M)');
  assert.equal(v.any, true);
});

test('Show older brings the older ones back after the recent ones; the count on the fold row stays the same', () => {
  const v = retiredView(workers, events, { now: NOW, showOlder: true });
  assert.deepEqual(names(v.shown), ['new', 'mid', 'old', 'ancient']);
  assert.equal(v.count, 2);
});

test('exactly 3 days ago is still recent; a moment more is older', () => {
  const ws = [w('edge'), w('past')];
  const v = retiredView(ws, [retired('edge', 3), { ...retired('past', 3), ts: iso(NOW - 3 * DAY - 1) }], { now: NOW });
  assert.deepEqual(names(v.recent), ['edge']);
  assert.deepEqual(names(v.older), ['past']);
});

test('a retired worker with no retirement time in the log counts as older, not lost', () => {
  const v = retiredView([w('orphan'), w('new')], [retired('new', 1)], { now: NOW });
  assert.deepEqual(names(v.recent), ['new']);
  assert.deepEqual(names(v.older), ['orphan']);
});

test('the open thread is kept: an old one shows even with older hidden, and the section is told to open', () => {
  const v = retiredView(workers, events, { now: NOW, current: 'ancient' });
  assert.deepEqual(names(v.shown), ['new', 'mid', 'ancient']);
  assert.equal(v.holdsCurrent, true);
  assert.equal(v.count, 2, 'the kept one does not change N');
  assert.equal(retiredView(workers, events, { now: NOW, current: 'mid' }).holdsCurrent, true);
  assert.equal(retiredView(workers, events, { now: NOW, current: 'live' }).holdsCurrent, false, 'a live worker is not in the section');
  assert.equal(retiredView(workers, events, { now: NOW, current: 'needs' }).holdsCurrent, false);
});

test('no retired workers: nothing to show', () => {
  const v = retiredView([w('a', 'idle')], [], { now: NOW });
  assert.equal(v.any, false);
  assert.equal(v.count, 0);
  assert.equal(v.olderCount, 0);
});

test('a later retirement event wins (the time it last retired)', () => {
  const at = retiredTimes([retired('x', 10), retired('x', 1), { type: 'message', agent: 'x', ts: iso(NOW) }]);
  assert.equal(at.get('x'), NOW - 1 * DAY);
  assert.equal(at.size, 1);
});
