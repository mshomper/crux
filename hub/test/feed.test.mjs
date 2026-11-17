// Decision 74 B, step A (load less): what the page is sent, what the hub works out for it, and the small updates.
//  - each thread sends its newest conversation events; "Show older" pages back from there without gaps;
//  - what waits on you, the unread and traffic counts are the same from the hub as the page's old logic gave over the whole log;
//  - a patch moves a page's copy of a project to the hub's current one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageEvents, olderPage, waitingOf, agentsFor, partsOf, diffParts, KEEP, WINDOW, SUMMARIES, PAGE, RECENT_MS } from '../lib/feed.mjs';
import { waiting } from '../public/all-projects.js';
import { applyViewPatch } from '../public/patch.js';
import { QUESTION_RULES } from '../public/questions.js';

let n = 0;
const T0 = Date.parse('2026-11-10T00:00:00Z');
const ev = (type, data = {}) => ({ id: `e${++n}`, ts: new Date(T0 + n * 1000).toISOString(), type, ...data });
const agents = [{ name: 'w1', role: 'worker', thread: 'w1', state: 'working' }, { name: 'orch', role: 'orchestrator', thread: 'orchestrator', state: 'working' }];
const at = l => Date.parse(l.at(-1).ts);

function busyLog() {
  const out = [];
  for (let i = 0; i < 200; i++) out.push(ev('message', { thread: 'orchestrator', from: i % 2 ? 'you' : 'orch', text: `hello ${i}` }));
  for (let i = 0; i < 10; i++) out.push(ev('summary', { thread: 'w1', from: 'w1', done: ['x'], questions: i === 9 ? ['Which colour for the header, red or blue?'] : undefined }));
  for (let i = 0; i < 30; i++) out.push(ev('message', { thread: 'w1', from: 'w1', text: `w ${i}` }));
  out.push(ev('plan_usage'), ev('agent_busy', { agent: 'w1' }), ev('check_shadow'), ev('pick', { thread: 'orchestrator', decision: 1, label: 'A' }));
  return out;
}

test('a thread sends its newest events, at most WINDOW, and the cut is one line', () => {
  const log = busyLog(), { events, older } = pageEvents(log, agents, at(log));
  const orch = events.filter(e => e.thread === 'orchestrator' && e.type === 'message');
  assert.equal(orch.length, WINDOW);
  assert.equal(orch.at(-1).text, 'hello 199');
  assert.equal(older.orchestrator, 200 - WINDOW);
  // the sent ones are the newest, in order, with no gap
  assert.deepEqual(orch.map(e => e.text), Array.from({ length: WINDOW }, (_, i) => `hello ${200 - WINDOW + i}`));
});

test('a thread sends at most SUMMARIES summaries beyond its newest few events', () => {
  const log = busyLog(), { events } = pageEvents(log, agents, at(log));
  const sum = events.filter(e => e.type === 'summary');
  // w1's newest 30 messages come first (past KEEP, inside WINDOW): summaries older than that stop at the cap
  assert.ok(sum.length <= SUMMARIES, `${sum.length} summaries`);
});

test('a thread idle for days still sends its newest few', () => {
  const log = busyLog(), later = at(log) + 10 * RECENT_MS;
  const { events } = pageEvents(log, agents, later);
  assert.equal(events.filter(e => e.thread === 'orchestrator' && e.type === 'message').length, KEEP);
});

test('telemetry the page never reads is not sent, other kinds always are, usage only since the cut', () => {
  const log = [...busyLog(), ev('usage', { agent: 'w1', models: {}, sessionId: 'x' })];
  const old = ev('usage', { agent: 'w1', models: {} }); old.ts = new Date(at(log) - 10 * 86400e3).toISOString();
  log.unshift(old);
  const { events } = pageEvents(log, agents, at(log), at(log) - 86400e3);
  assert.ok(!events.some(e => ['plan_usage', 'agent_busy', 'check_shadow'].includes(e.type)));
  assert.ok(events.some(e => e.type === 'pick'));
  const usage = events.filter(e => e.type === 'usage');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].sessionId, undefined);
});

test('Show older pages back from the oldest one the page holds, with no gap and no repeat, until none are left', () => {
  const log = busyLog(), now = at(log);
  const sent = pageEvents(log, agents, now).events.filter(e => e.type === 'message' && e.thread === 'orchestrator');
  let before = sent[0].id, got = [], guard = 0;
  for (;;) {
    const page = olderPage(log, agents, 'orchestrator', before, now);
    got = [...page.events, ...got];
    if (!page.events.length || !page.left) break;
    before = page.events[0].id;
    assert.ok(++guard < 10);
  }
  const all = [...got, ...sent].map(e => e.text);
  assert.deepEqual(all, Array.from({ length: 200 }, (_, i) => `hello ${i}`));
});

test('Show older with an id that is not in the thread says to read the state again', () => {
  const log = busyLog();
  assert.equal(olderPage(log, agents, 'orchestrator', 'nope', at(log)).stale, true);
});

test('long-retired agents go as bare names, recent ones with their task cut', () => {
  const now = at(busyLog());
  const views = [{ name: 'a', state: 'retired', thread: 'a', role: 'worker', task: 'x'.repeat(1000) }, { name: 'b', state: 'retired', thread: 'b', role: 'worker', task: 'y'.repeat(1000) }, { name: 'c', state: 'working', thread: 'c', role: 'worker', task: 'z'.repeat(1000) }];
  const events = [{ type: 'agent_retired', agent: 'a', ts: new Date(now - 30 * 86400e3).toISOString() }, { type: 'agent_retired', agent: 'b', ts: new Date(now - 86400e3).toISOString() }];
  const out = agentsFor(views, events, now);
  assert.equal(out[0].task, undefined);
  assert.equal(out[1].task.length, 400);
  assert.equal(out[2].task.length, 1000);
});

// ---------- what waits on you: the hub's answer is the page's old answer ----------
function waitingLog() {
  const l = [ev('question_rules', { version: 2 })];
  const s1 = ev('summary', { thread: 'w1', from: 'w1', questions: ['Should we ship the header change today?', 'Which colour for the header, red or blue?'] });
  const s2 = ev('summary', { thread: 'w2', from: 'w2', questions: ['Which colour for the header, red or blue?'], decisions_needed: [3] });
  const s3 = ev('summary', { thread: 'w3', from: 'w3', questions: ['Do you want the long version of the report?'] });
  l.push(s1, s2, s3);
  l.push(ev('message', { thread: 'w1', from: 'you', text: 'yes', answers: [{ question: s1.id, index: 0 }] }));
  l.push(ev('question_dismissed', { question: s3.id, asker: 'w3', by: 'you' }));
  l.push(ev('approval', { thread: 'w1', approval: 'a1', agent: 'w1', tool: 'Bash', input: { command: 'x' } }), ev('approval_result', { thread: 'w1', approval: 'a1' }));
  l.push(ev('approval', { thread: 'w2', approval: 'a2', agent: 'w2', tool: 'Bash', input: { command: 'y' } }));
  l.push(ev('lesson_proposed', { thread: 'w1', lesson: 'l1', text: 't' }));
  for (let i = 0; i < 100; i++) l.push(ev('message', { thread: 'w1', from: 'w1', text: `m${i}` }));
  return l;
}
const decisions = [{ id: 3, title: 'Pick the header colour', status: 'open', options: [] }, { id: 4, title: 'Other', status: 'decided', options: [] }];
const wagents = [{ name: 'w1', thread: 'w1', state: 'working' }, { name: 'w2', thread: 'w2', state: 'working' }, { name: 'w3', thread: 'w3', state: 'working' }];

test('the hub works out the same waiting cards and counts as the page did from the whole log', () => {
  const log = waitingLog();
  const w = waitingOf(log, wagents, decisions);
  const pending = new Set(['a2']);
  const old = { name: 'p', events: log, agents: wagents, board: { decisions }, permissionMode: 'ask' };
  const fromHub = { ...old, events: pageEvents(log, wagents, at(log)).events, wait: { questions: w.questions, repeats: w.repeats, approvals: w.approvals, askedDecisions: w.askedDecisions } };
  const brief = x => ({ approvals: x.approvals.map(e => e.approval), questions: x.questions.map(q => ({ id: q.id, open: q.open, byPicks: q.byPicks, repeats: q.repeats })), lessons: x.lessons.map(e => e.lesson), decisions: x.decisions.map(d => d.id), count: x.count });
  const a = brief(waiting(old, pending)), b = brief(waiting(fromHub, pending));
  assert.deepEqual(b, a);
  assert.ok(a.questions.length > 0 && a.approvals.length === 1 && a.lessons.length === 1);
});

test('counts: unread over the whole log, traffic for a thread\'s own events', () => {
  const log = waitingLog();
  log.push(ev('permission_answer', { thread: 'w1' }), ev('entry', { from: 'w1', entryId: 'M1' }));
  const w = waitingOf(log, wagents, decisions);
  const unread = log.filter(e => (e.type === 'entry' ? 'w1' : e.thread) === 'w1' && e.type !== 'permission_answer').length;
  assert.equal(w.counts.w1, unread);
  assert.equal(w.traffic.w1, log.filter(e => e.thread === 'w1' && ['message', 'summary', 'approval', 'entry'].includes(e.type)).length);
});

test('an old unresolved permission request is named by the hub even when the page was not sent it', () => {
  const log = [ev('approval', { thread: 'w2', approval: 'old1', agent: 'w2', tool: 'Bash', input: { command: 'z' } }), ...waitingLog()];
  for (let i = 0; i < 200; i++) log.push(ev('message', { thread: 'w2', from: 'w2', text: `m${i}` }));
  const sent = pageEvents(log, wagents, at(log)).events;
  assert.ok(!sent.some(e => e.approval === 'old1'), 'it is outside w2\'s window');
  const w = waitingOf(log, wagents, decisions);
  assert.ok(w.approvals.some(e => e.approval === 'old1'));
  const page = { name: 'p', events: sent, agents: wagents, board: { decisions }, wait: { questions: w.questions, repeats: w.repeats, approvals: w.approvals, askedDecisions: w.askedDecisions } };
  assert.ok(waiting(page, new Set(['old1', 'a2'])).approvals.some(e => e.approval === 'old1'));
});

// ---------- small updates ----------
const viewOf = (extra = {}) => ({
  name: 'p', agents: [{ name: 'a', state: 'working', thread: 'a' }, { name: 'b', state: 'asleep', thread: 'b' }],
  board: { decisions: [{ id: 1, status: 'open' }, { id: 2, status: 'decided' }], entries: [{ entryId: 'M1', title: 't' }] },
  wait: { questions: [], repeats: {}, approvals: [], askedDecisions: {} }, permissionMode: 'ask', pendingApprovals: [], ...extra
});

test('no change: no patch; a change: only the part that changed', () => {
  const v = viewOf(), prev = new Map([...partsOf(v)].map(([k, x]) => [k, JSON.stringify(x ?? null)]));
  assert.equal(diffParts(prev, viewOf()), null);
  const next = viewOf({ permissionMode: 'trusted' });
  next.agents[0] = { ...next.agents[0], state: 'asleep' };
  const d = diffParts(prev, next);
  assert.deepEqual(Object.keys(d.patch.set).sort(), ['a:a', 'k:permissionMode']);
  assert.ok(JSON.stringify(d.patch).length < 400);
});

test('patches applied in order bring a page copy to the hub view (add, change, remove, reorder)', () => {
  let view = viewOf(), prev = new Map([...partsOf(view)].map(([k, x]) => [k, JSON.stringify(x ?? null)]));
  const page = JSON.parse(JSON.stringify(view));
  const steps = [
    v => { v.agents.push({ name: 'c', state: 'working', thread: 'c' }); },
    v => { v.board.decisions[0] = { id: 1, status: 'decided', chosen: 'A' }; v.board.entries.push({ entryId: 'M2', title: 'u' }); },
    v => { v.agents = v.agents.filter(a => a.name !== 'b'); v.agents.unshift({ name: 'z', state: 'working', thread: 'z' }); },
    v => { v.wait = { ...v.wait, questions: [{ id: 'q1', open: [{ i: 0, text: 'x' }] }] }; v.pendingApprovals = ['p1']; },
    v => { v.board.decisions = v.board.decisions.filter(d => d.id !== 2); v.board.entries = []; delete v.pendingApprovals; }
  ];
  for (const step of steps) {
    view = JSON.parse(JSON.stringify(view)); step(view);
    const d = diffParts(prev, view);
    assert.ok(d);
    prev = d.next;
    applyViewPatch(page, JSON.parse(JSON.stringify(d.patch)));   // as it comes over the stream
    assert.deepEqual(page, view);
  }
});

test('a patch applied to a page that already has a newer state still lands on the newer values', () => {
  const view = viewOf(), prev = new Map([...partsOf(view)].map(([k, x]) => [k, JSON.stringify(x ?? null)]));
  const next = viewOf({ permissionMode: 'trusted' });
  const d = diffParts(prev, next);
  const page = JSON.parse(JSON.stringify(next));   // read after the change
  applyViewPatch(page, d.patch);
  applyViewPatch(page, d.patch);   // twice is the same as once
  assert.deepEqual(page, next);
});

test('PAGE is a sensible page size and the usual rules are what the brief says', () => {
  assert.ok(PAGE >= 100 && KEEP >= 5 && SUMMARIES >= 3 && SUMMARIES <= 5);
});
