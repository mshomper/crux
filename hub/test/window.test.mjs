// Phone speed (0.25.10): the page gets recent events in full and older ones as stubs, and nothing it works out changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { windowed as windowedAt, olderPage as olderPageAt, WINDOW, PAGE, KEEP, RECENT_MS } from '../lib/window.mjs';
import { openQuestions } from '../public/questions.js';

let n = 0;
const ev = (type, data) => ({ id: `e${++n}`, ts: new Date(1e12 + n * 1000).toISOString(), type, ...data });

const at = l => Date.parse(l.at(-1).ts);
const windowed = l => windowedAt(l, at(l));
const olderPage = (l, t, b) => olderPageAt(l, t, b, at(l));

function log() {
  const out = [];
  out.push(ev('summary', { thread: 'w1', from: 'w1', questions: ['Which colour?'], done: ['x'.repeat(500)] }));
  for (let i = 0; i < 400; i++) out.push(ev('message', { thread: 'orchestrator', from: i % 2 ? 'you' : 'orch', text: 'hello '.repeat(40) }));
  out.push(ev('message', { thread: 'w1', from: 'you', text: 'no', answers: [{ question: out[0].id, index: 0 }] }));
  out.push(ev('plan_usage', { used: 3 }), ev('agent_busy', { agent: 'a' }), ev('check_shadow', {}));
  for (let i = 0; i < 10; i++) out.push(ev('message', { thread: 'orchestrator', from: 'you', text: 'recent' }));
  return out;
}

test('old messages become small stubs, newest per thread stay full', () => {
  const full = log(), w = windowed(full);
  const orch = w.events.filter(e => e.thread === 'orchestrator');
  assert.equal(orch.length, 410);
  assert.equal(orch.filter(e => e.old).length, 410 - WINDOW);
  assert.ok(orch.filter(e => !e.old).every(e => e.text));
  assert.ok(orch.filter(e => e.old).every(e => e.text === undefined && e.from && e.thread));
  assert.equal(w.older.orchestrator, 410 - WINDOW);
  assert.ok(JSON.stringify(w.events).length < JSON.stringify(full).length * 0.7);
});

test('a thread idle for days still keeps its newest few in full', () => {
  const full = log(), later = at(full) + 10 * RECENT_MS;
  const orch = windowedAt(full, later).events.filter(e => e.thread === 'orchestrator');
  assert.equal(orch.filter(e => !e.old).length, KEEP);
});

test('telemetry the page never reads is not sent', () => {
  const w = windowed(log());
  assert.ok(!w.events.some(e => ['plan_usage', 'agent_busy', 'check_shadow'].includes(e.type)));
});

test('what is waiting on you is the same with the windowed feed', () => {
  const full = log();
  const open = openQuestions(full, {}).map(c => c.id);
  assert.deepEqual(openQuestions(windowed(full).events, {}).map(c => c.id), open);
  // And with the answer removed from the log, the question is still open in both.
  const noAnswer = full.filter(e => !e.answers);
  assert.equal(openQuestions(noAnswer, {}).length, 1);
  assert.equal(openQuestions(windowed(noAnswer).events, {}).length, 1);
});

test('an unresolved permission request stays in full however old', () => {
  const full = [ev('approval', { thread: 'orchestrator', approval: 'a1', input: { command: 'x' } }), ...log()];
  const w = windowed(full);
  assert.ok(!w.events[0].old && w.events[0].input);
  const done = [ev('approval', { thread: 'orchestrator', approval: 'a2', input: { command: 'y' } }), ev('approval_result', { thread: 'orchestrator', approval: 'a2' }), ...log()];
  assert.ok(windowed(done).events[0].old);
});

test('Show older hands back full events a page at a time, ending at the given stub', () => {
  const full = log();
  const stubs = windowed(full).events.filter(e => e.thread === 'orchestrator' && e.old);
  const first = olderPage(full, 'orchestrator', stubs.at(-1).id);
  assert.equal(first.events.length, PAGE);
  assert.ok(first.events.every(e => e.text) && first.events.at(-1).id === stubs.at(-1).id);
  const next = olderPage(full, 'orchestrator', first.events[0].id.replace(/^/, ''));
  assert.equal(next.events.at(-1).id, first.events[0].id);
});
