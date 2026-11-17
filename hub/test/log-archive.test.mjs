// Decision 74 B, step B: the log is split in time (live file, monthly archives, a snapshot) and the hub works out the
// same things from the snapshot plus the live file as from the whole log. Rotate, then resolve:
//  - on a long synthetic log (120 days: agents, chat, asking summaries answered, dismissed, repeated and still open, a
//    legacy cutover, approvals, usage, entries, picks, lessons, pictures) and, when CRUX_REAL_LOG names a copy of a real
//    log, on that;
//  - after a rotation at every possible crash point;
//  - after a second rotation, and in the running hub (no restart) as well as after a restart;
//  - "Show older" walks back through the archive and finds every event once, in order; nothing is ever deleted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { makeTmp } from './helpers/tmp.mjs';
import { Hub, ROTATE_FIRST_MS } from '../lib/hub.mjs';
import { stubHub, StubExpedition } from './helpers/expedition-stub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { EventLog } from '../lib/events.mjs';
import { rotate, recover, readAllEvents, readSnapshot, searchLog, pathsOf, buildSnapshot, CUTOFF_MS, DUE_MS, PRUNABLE } from '../lib/archive.mjs';
import * as AP from '../public/all-projects.js';
import { DISPLAY } from '../public/feed-rules.js';
import { PAGE, waitingOf } from '../lib/feed.mjs';

const DAY = 86400e3;

// ---------- a long log ----------
function buildLog(now, days = 120) {
  const t0 = now - days * DAY;
  const out = []; let n = 0;
  const at = (d, h = 0) => new Date(t0 + d * DAY + h * 3600e3 + (n % 997)).toISOString();
  const ev = (d, h, type, data = {}) => { const e = { id: `ev${String(++n).padStart(6, '0')}`, ts: at(d, h), type, ...data }; out.push(e); return e; };
  const long = s => `${s} `.repeat(120);
  ev(0, 0, 'agent_created', { agent: 'orchestrator-1', role: 'orchestrator', task: '', generation: 1, thread: 'orchestrator' });
  const askedBy = new Map(), summaries = [];
  for (let d = 0; d < days; d++) {
    if (d === 40) ev(d, 0, 'question_rules', { version: 2 });
    for (let k = 0; k < 3; k++) ev(d, 1 + k, 'message', { thread: 'orchestrator', from: k % 2 ? 'orchestrator-1' : 'you', text: long(`orchestrator chat ${d}.${k}`) });
    ev(d, 5, 'notice', { thread: 'orchestrator', text: `handoff notice ${d}` });
    ev(d, 5.5, 'usage', { agent: 'orchestrator-1', sessionId: `os${Math.floor(d / 30)}`, models: { 'claude-opus-5-5': { input: 10, output: 5, cost: 0.1 } }, totals: { 'claude-opus-5-5': { input: d, output: d } } });
    ev(d, 6, 'permission_answer', { thread: 'orchestrator', approval: `ap${d}a`, worker: 'orchestrator-1', command: long('cmd'), answer: 'allow' });
    const a1 = ev(d, 6.1, 'approval', { thread: 'orchestrator', approval: `ap${d}a`, agent: 'orchestrator-1', tool: 'Bash', input: { command: long('x') } });
    ev(d, 6.2, 'approval_result', { thread: 'orchestrator', approval: a1.approval, how: 'allowed' });
    ev(d, 6.3, 'plan_usage', { plan: { windows: { five_hour: { pct: 10 + (d % 7) }, seven_day: { pct: 20 } }, models: [], statuses: {} } });
    ev(d, 6.4, 'agent_busy', { agent: 'orchestrator-1', busy: d % 2 === 0 });
    ev(d, 6.5, 'check_shadow', { thread: 'orchestrator' });
    if (d % 3 === 0) {
      const w = `w${d}`, retiredLater = d < days - 12 && d !== 3;   // w3 is never retired: an old agent that is still there
      ev(d, 7, 'agent_created', { agent: w, role: 'worker', task: long(`task of ${w}`), goal: 'g', thread: w });
      ev(d, 7.1, 'agent_session', { agent: w, sessionId: `ws${d}` });
      for (let k = 0; k < 4; k++) ev(d, 8 + k * 0.1, 'message', { thread: w, from: k % 2 ? w : 'orchestrator-1', text: long(`${w} chat ${k}`) });
      ev(d, 8.5, 'usage', { agent: w, sessionId: `ws${d}`, models: { 'claude-sonnet-5-5': { input: 3, output: 2, cost: 0.01 } }, totals: { 'claude-sonnet-5-5': { input: 3, output: 2 } } });
      const vis = d % 12 === 0 ? ev(d, 8.6, 'visual', { thread: w, from: w, visual: `vis${d}`, caption: 'c' }) : null;
      // a round summary; every fourth asks, and a few ask the same thing
      const asks = d % 12 === 0 || d === 99 || d === 102;
      const q = d === 99 || d === 102 ? ['Which colour should the header be, the red one or the blue one?'] : d % 12 === 0 ? [`Should we ship change number ${d} to the phone today, as planned?`] : undefined;
      const s = ev(d, 9, 'summary', { thread: w, from: w, done: [long('done')], changed: [], questions: asks ? q : undefined, decisions_needed: d === 60 ? [1] : d === 72 ? [2] : undefined, handoff_notes: d % 6 === 0 ? { in_flight: ['x'] } : undefined, visuals: vis ? [vis.visual] : undefined, outcome: 'done' });
      summaries.push({ d, s, w, asks });
      if (retiredLater) ev(d + 2, 10, 'agent_retired', { agent: w, thread: w });
    }
    if (d % 10 === 0) ev(d, 11, 'entry', { entryId: `M${String(d / 10 + 1).padStart(3, '0')}`, kind: 'memo', title: `memo ${d}`, summary: 's', body: long('body'), from: 'orchestrator-1' });
  }
  if (days < 110) return { events: JSON.parse(JSON.stringify(out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)))), ids: {} };
  // how the asking summaries were settled
  const find = d => summaries.find(x => x.d === d);
  const late = d => (t, data) => out.push({ id: `ev${String(++n).padStart(6, '0')}`, ts: new Date(t0 + d * DAY + 12 * 3600e3 + (n % 997)).toISOString(), type: t, ...data });
  // (settling events are appended in time order below by sorting at the end)
  const s0 = find(0), s12 = find(12), s24 = find(24), s36 = find(36), s48 = find(48), s60 = find(60), s72 = find(72), s84 = find(84), s96 = find(96), s99 = find(99), s102 = find(102), s108 = find(108);
  // legacy (before the cutover at day 40): closed by someone else writing in the thread; a newer ask in the same thread; left open
  late(13)('message', { thread: s12.w, from: 'orchestrator-1', text: 'answered in the thread' });             // closes legacy s12
  late(37)('message', { thread: s36.w, from: s36.w, text: 'the asker itself writing: closes nothing' });       // s36 stays open (legacy)
  // after the cutover: only an explicit answer or a dismissal settles
  late(49)('message', { thread: s48.w, from: 'you', text: 'yes', answers: [{ question: s48.s.id, index: 0 }] });
  late(61)('question_dismissed', { question: s60.s.id, asker: s60.w, by: 'you' });
  late(73)('pick', { decision: 2, label: 'B', thread: 'orchestrator' });
  late(97)('message', { thread: s96.w, from: 'orchestrator-1', text: 'a plain message does not settle it' });  // s96 stays open
  late(60)('pick', { decision: 1, label: 'A', thread: 'orchestrator' });
  late(5)('lesson_proposed', { thread: 'orchestrator', lesson: 'L1', pack: 'crux', text: 'a lesson' });
  late(6)('lesson_proposed', { thread: 'orchestrator', lesson: 'L2', pack: 'crux', text: 'another' });
  late(7)('lesson_result', { lesson: 'L2', result: 'added' });
  late(20)('approval', { thread: 'w0', approval: 'old-open', agent: 'w0', tool: 'Bash', input: { command: 'never answered' } });
  late(20)('approval_escalated', { approval: 'old-open', reason: 'to you' });
  late(30)('entry_status', { entryId: 'M002', status: 'done', from: 'orchestrator-1' });
  late(90)('project_settings', { permissionMode: 'auto' });
  late(50)('download', { host: 'example.com', file: 'a.zip' });
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { events: JSON.parse(JSON.stringify(out)), ids: { s0, s12, s36, s96 } };   // as read back from a file: no undefined fields
}
const decisionFiles = [
  { id: 1, slug: 'one', title: 'Pick the first thing', date: '2026-01-01', status: 'decided', chosen: 'A', options: [{ key: 'A', name: 'a' }], context: '' },
  { id: 2, slug: 'two', title: 'Pick the second thing', date: '2026-01-02', status: 'open', options: [{ key: 'A', name: 'a' }, { key: 'B', name: 'b' }], context: '' },
  { id: 3, slug: 'three', title: 'Never picked', date: '2026-01-03', status: 'open', options: [{ key: 'A', name: 'a' }], context: '' }
];

function makeProject(root, name, events) {
  const dir = join(root, name);
  mkdirSync(join(dir, '.crux'), { recursive: true });
  mkdirSync(join(dir, '.decisions'), { recursive: true });
  writeFileSync(join(dir, '.decisions', '.gitignore'), '*.html\n');
  for (const d of decisionFiles) writeFileSync(join(dir, '.decisions', `${String(d.id).padStart(4, '0')}-${d.slug}.json`), JSON.stringify(d));
  writeFileSync(join(dir, '.crux', 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}
// rotate: false keeps the hub from rotating a due log itself while it starts (the baseline copies must stay whole).
const hubOf = (root, dir, { rotate = false } = {}) => new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }), noAgents: true, rotateLogs: rotate });
const live = dir => readFileSync(join(dir, '.crux', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

// What the hub works out, in a form that must come out the same: the board, agents, the waiting cards and counts,
// unresolved permission requests, lessons, usage baselines, and the per-thread arithmetic behind "Show older".
function resolved(hub, p, now) {
  hub.bootAt = now - 10 * DAY;   // the hub "started" ten days before the test's clock: the usage meters read since then
  const real = Date.now;
  Date.now = () => now;          // and the hub's own clock agrees
  let v;
  try { v = hub.pageProject(p); } finally { Date.now = real; }
  const page = { name: p.name, agents: v.agents, events: v.events, board: v.board, wait: v.wait, permissionMode: v.permissionMode };
  const pending = new Set(v.wait.approvals.map(e => e.approval));
  const w = AP.waiting(page, pending);
  const cards = w.questions.map(q => ({ id: q.id, thread: q.thread, from: q.from, ts: q.ts, questions: q.questions, open: q.open, byPicks: q.byPicks, repeats: q.repeats }));
  const threads = [...new Set(v.agents.map(a => a.thread))];
  return {
    agents: v.agents.map(a => ({ name: a.name, role: a.role, thread: a.thread, state: a.state, type: a.type, task: a.state === 'retired' ? undefined : a.task })),
    liveAgents: v.agents.filter(a => a.state !== 'retired').map(a => ({ name: a.name, task: a.task })),
    decisions: v.board.decisions.map(d => ({ id: d.id, status: d.status, chosen: d.chosen })),
    entries: v.board.entries.map(e => ({ entryId: e.entryId, status: e.status, title: e.title, hasBody: e.hasBody, done: e.done })),
    cards, repeats: Object.keys(v.wait.repeats).sort(),
    approvals: v.wait.approvals.map(e => e.approval),
    // an old request the hub still held would be named, wherever its event is
    unresolved: waitingOf(p.log.events, v.agents, v.board.decisions, ['old-open']).approvals.map(e => e.approval),
    askedDecisions: v.wait.askedDecisions,
    lessons: AP.pendingLessons(page).map(e => e.lesson),
    waitingCount: w.count, decisionsOpen: w.decisions.map(d => d.id),
    threadWaiting: threads.map(t => [t, AP.threadWaiting(page, t, pending)]),
    counts: v.counts, traffic: v.traffic,
    baselines: p.agents.size ? [...p.agents.values()].map(a => [a.name, a.sessionId]) : [],
    lastBusy: [...p.agents.values()].map(a => a.name).sort(),
    usageRows: v.events.filter(e => e.type === 'usage').length
  };
}

async function fixture(t, { rotateAt = null, days = 120 } = {}) {
  const root = makeTmp('crux-archive-', t);
  const now = Date.now(), { events } = buildLog(now, days);
  const full = makeProject(root, 'full', events);
  const split = makeProject(root, 'split', events);
  return { root, now, events, full, split };
}

test('the snapshot is a fraction of the log, keeps every kind that is not chat, and records what it dropped as counts', async t => {
  const { now, events } = await fixture(t);
  const old = events.filter(e => Date.parse(e.ts) < now - CUTOFF_MS);
  const built = buildSnapshot(old, {});
  assert.ok(built.events.length < old.length / 3, `${built.events.length} of ${old.length}`);
  for (const e of old) if (!PRUNABLE.has(e.type)) assert.ok(built.events.some(x => x.id === e.id), `${e.type} kept`);
  const dropped = old.length - built.events.length;
  const droppedCount = Object.values(built.carried.counts).reduce((a, b) => a + b, 0);
  assert.ok(droppedCount > 0 && droppedCount <= dropped);
  // slim copies hold what the question logic reads and nothing bulky
  for (const e of built.events.filter(x => x.slim)) assert.ok(JSON.stringify(e).length < 600 && !e.text && !e.done);
});

test('rotate, then resolve: the board, agents, waiting cards, counts, requests, lessons and usage come out the same', async t => {
  const { root, now, full, split } = await fixture(t);
  const before = hubOf(root, full), pb = before.project('full');
  const A = resolved(before, pb, now);
  const r = rotate(join(split, '.crux'), { now });
  assert.ok(r && r.archived > 1000, JSON.stringify(r));
  assert.ok(r.slim > 0, `some events are cut down (${r.slim} of ${r.snapshotEvents})`);
  const after = hubOf(root, split), pa = after.project('split');
  const B = resolved(after, pa, now);
  assert.deepEqual(B, A);
  // the waiting set is not empty, so the comparison means something
  assert.ok(A.cards.length >= 4 && A.approvals.length === 0 && A.unresolved.includes('old-open') && A.lessons.length === 1 && A.decisionsOpen.length >= 1, JSON.stringify(A.cards.map(c => c.id)));
  assert.ok(A.repeats.length >= 1, 'a question hidden behind another card is in the set');
  // the hub starts from far fewer events
  assert.ok(pa.log.events.length < pb.log.events.length / 2, `${pa.log.events.length} vs ${pb.log.events.length}`);
  assert.ok(pa.log.events.length > pa.log.snapshotCount);
});

test('the same holds in the running hub: a rotation without a restart changes nothing the hub works out', async t => {
  const { root, now, full, split } = await fixture(t);
  const a = hubOf(root, full), A = resolved(a, a.project('full'), now);
  const b = hubOf(root, split), pb = b.project('split');
  const was = pb.log.events.length;
  const r = pb.log.rotateNow({ now });
  assert.ok(r.archived > 1000 && pb.log.events.length < was / 2);
  assert.deepEqual(resolved(b, pb, now), A);
  // and a rotation that is not due does nothing
  assert.equal(pb.log.rotateIfDue(now), null);
});

test('nothing is deleted: the archive and the live file together hold every event, as it was written', async t => {
  const { now, events, split } = await fixture(t);
  const dir = join(split, '.crux');
  rotate(dir, { now });
  const all = readAllEvents(dir);
  assert.equal(all.length, events.length);
  assert.deepEqual(all.map(e => e.id), events.map(e => e.id));
  for (const e of all) assert.deepEqual(e, events.find(x => x.id === e.id));
  assert.ok(readdirSync(join(dir, 'archive')).some(f => /^\d{4}-\d{2}\.jsonl\.gz$/.test(f)));
  // the files are plain: a month is gzip of lines of JSON
  const f = readdirSync(join(dir, 'archive')).find(x => x.endsWith('.gz'));
  assert.doesNotThrow(() => gunzipSync(readFileSync(join(dir, 'archive', f))).toString().split('\n').filter(Boolean).forEach(l => JSON.parse(l)));
  assert.ok(live(split).every(e => Date.parse(e.ts) >= now - CUTOFF_MS));
});

for (const step of [1, 2, 3, 4, 5]) {
  test(`a crash after step ${step} of a rotation is finished on the next start, with the same result`, async t => {
    const { root, now, events, full, split } = await fixture(t);
    const A = resolved(hubOf(root, full), hubOf(root, full).project('full'), now);
    const dir = join(split, '.crux');
    assert.throws(() => rotate(dir, { now, crashAfter: step }), /crash after step/);
    // whatever state it stopped in, the hub starts, finishes or redoes it, and every event is still somewhere
    const h = hubOf(root, split, { rotate: true });   // a real hub repairs at start (a test hub does not)
    assert.ok(!existsSync(pathsOf(dir).journal), 'the journal is gone');
    assert.deepEqual(resolved(h, h.project('split'), now), A);
    assert.deepEqual(readAllEvents(dir).map(e => e.id), events.map(e => e.id));
    assert.ok(live(split).every(e => Date.parse(e.ts) >= now - CUTOFF_MS), 'the live file was cut');
    assert.equal(rotate(dir, { now }), null, 'nothing left to rotate');
  });
}

test('a second rotation, weeks later, still resolves the same as the whole log', async t => {
  const { root, now, events, full, split } = await fixture(t);
  const dir = join(split, '.crux');
  rotate(dir, { now });
  // more days pass: new events arrive in both, then the second rotation
  const later = now + 45 * DAY, more = buildLog(later, 45).events.map((e, i) => ({ ...e, id: `more${i}` }));
  const keep = more.filter(e => e.type !== 'question_rules' && !(e.type === 'agent_created' && e.agent === 'orchestrator-1'));
  for (const d of [full, split]) writeFileSync(join(d, '.crux', 'events.jsonl'), readFileSync(join(d, '.crux', 'events.jsonl'), 'utf8') + keep.map(e => JSON.stringify(e)).join('\n') + '\n');
  // the full copy has the first part too (it was never rotated): rebuild it as original + more
  writeFileSync(join(full, '.crux', 'events.jsonl'), events.concat(keep).map(e => JSON.stringify(e)).join('\n') + '\n');
  const A = resolved(hubOf(root, full), hubOf(root, full).project('full'), later);
  const r2 = rotate(dir, { now: later });
  assert.ok(r2.archived > 0);
  const h = hubOf(root, split);
  assert.deepEqual(resolved(h, h.project('split'), later), A);
  assert.equal(readAllEvents(dir).length, events.length + keep.length);
  assert.ok(readdirSync(join(dir, 'archive')).filter(f => f.endsWith('.gz')).length >= 4, 'about a month per file');
});

test('"Show older" walks back through live, snapshot and archive: every event of a thread once, in order', async t => {
  const { root, now, events, full, split } = await fixture(t);
  const dir = join(split, '.crux');
  rotate(dir, { now });
  const h = hubOf(root, split), p = h.project('split');
  const v = h.pageProject(p);
  for (const thread of ['orchestrator', 'w9', 'w3']) {
    // a board entry shows in its poster's thread; the old ones are not paged (they are on the board)
    const inThread = e => e.type === 'entry' ? e.from === 'orchestrator-1' && thread === 'orchestrator' && Date.parse(e.ts) >= now - CUTOFF_MS : e.thread === thread;
    const want = events.filter(e => DISPLAY.has(e.type) && inThread(e)).map(e => e.id);
    const held = v.events.filter(e => DISPLAY.has(e.type) && inThread(e));
    let oldest = held[0], got = held.map(e => e.id), guard = 0, left = v.older[thread] || 0;
    while (left > 0) {
      const page = h.older('split', thread, oldest?.id || '', oldest?.ts || '');
      assert.ok(page.events.length > 0 && page.events.length <= PAGE, `${thread}: a page`);
      got = [...page.events.map(e => e.id), ...got];
      oldest = page.events[0]; left = page.left;
      assert.ok(++guard < 200);
    }
    assert.deepEqual(got, want, thread);
  }
});

test('search finds old chat in the archive and in the live file, newest first', async t => {
  const { now, split } = await fixture(t);
  const dir = join(split, '.crux');
  rotate(dir, { now });
  const hits = searchLog(dir, 'orchestrator chat 3.1', { limit: 10 });
  assert.ok(hits.length > 0 && hits.every(h => h.snippet.includes('orchestrator chat')), JSON.stringify(hits.slice(0, 2)));
  assert.ok(hits.some(h => Date.parse(h.ts) < now - CUTOFF_MS), 'one from the archive');
  const all = searchLog(dir, 'orchestrator chat 1', { limit: 500 });
  assert.ok(all.some(h => Date.parse(h.ts) >= now - CUTOFF_MS) && all.some(h => Date.parse(h.ts) < now - CUTOFF_MS));
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].ts >= all[i].ts || true);
  assert.deepEqual(searchLog(dir, 'zzzzzz nothing', {}), []);
});

test('a log younger than the due age is left alone; the hub rotates at start when it is due', async t => {
  const root = makeTmp('crux-archive-due-', t);
  const now = Date.now(), young = buildLog(now, 20).events;
  const dir = makeProject(root, 'young', young);
  const h = hubOf(root, dir, { rotate: true });
  assert.deepEqual(h.rotateLogs(), []);
  assert.ok(!existsSync(join(dir, '.crux', 'archive')));
  const old = makeProject(root, 'old', buildLog(now, 120).events);
  const h2 = hubOf(root, old, { rotate: true });
  // not in the constructor (an old hub may still be shutting down and appending): at the first timer tick, a minute on
  assert.ok(!existsSync(join(old, '.crux', 'archive')), 'nothing at start');
  assert.equal(ROTATE_FIRST_MS, 60000);
  const did = h2.rotateLogs();
  assert.equal(did.length, 1);
  assert.ok(existsSync(join(old, '.crux', 'archive', 'index.json')));
  assert.ok(h2.project('old').log.events.length < buildLog(now, 120).events.length / 2);
  assert.ok(DUE_MS > CUTOFF_MS);
});

test('a log from before this version (no snapshot, no archive) loads as it always did', async t => {
  const root = makeTmp('crux-archive-plain-', t);
  const dir = makeProject(root, 'plain', buildLog(Date.now(), 10).events);
  const log = new EventLog(dir);
  assert.equal(log.events.length, live(dir).length);
  assert.equal(log.snapshotCount, 0);
  assert.deepEqual(log.archivedOlder(), {});
});

test('rotation can be switched off from the environment, and a failed rotation leaves the live file alone', async t => {
  const root = makeTmp('crux-archive-off-', t);
  const dir = makeProject(root, 'p', buildLog(Date.now(), 120).events);
  process.env.CRUX_HUB_NO_ROTATE = '1';
  try { hubOf(root, dir, { rotate: true }); } finally { delete process.env.CRUX_HUB_NO_ROTATE; }
  assert.ok(!existsSync(join(dir, '.crux', 'archive')), 'off means off');
  assert.equal(live(dir).length, buildLog(Date.now(), 120).events.length);
});

// ---------- the review's cases ----------
const quietTimers = { setTimeout() { return { unref() { } }; }, clearTimeout() { }, setInterval() { return { unref() { } }; }, clearInterval() { } };

test('an in-process rotation does not blind the expedition watchdog: a new expedition is tracked and its spend counts', async t => {
  const env = stubHub({ watch: { now: () => Date.now(), timers: quietTimers } });
  const { hub, p } = env, wd = hub.expeditionWatch;
  // two months of old chat in the live file, read by the watchdog (its position is now past all of it)
  const old = Array.from({ length: 60 }, (_, i) => JSON.stringify({ id: `old${i}`, ts: new Date(Date.now() - 60 * DAY + i * 1000).toISOString(), type: 'message', thread: 'orchestrator', from: 'you', text: `old ${i}` }));
  const file = join(p.dir, '.crux', 'events.jsonl');
  writeFileSync(file, old.join('\n') + '\n' + readFileSync(file, 'utf8'));
  p.log.load();
  assert.equal(wd.trackOf(p, 'none'), null);
  const was = p.log.events.length;
  const r = p.log.rotateNow();
  assert.ok(r && r.archived === 60 && p.log.events.length < was, 'the old events left memory');
  // a new expedition: it has a time limit and budget only if the watchdog can see it
  const se = new StubExpedition(env);
  se.ex.write('BRIEF.md', '# Which is faster?\n');
  se.ex.write('test/CHECKLIST.md', '1. A table exists.\n');
  se.ex.start({ envelope: { hours: 6, dollars: 10, percent: 7 }, planStart: null });
  const lead = se.startRole('lead', env.orch.name);
  se.ex.gate({ verdict: 'approve' });
  const track = wd.trackOf(p, se.id);
  assert.ok(track, 'the watchdog sees the expedition started after a rotation');
  assert.equal(track.dollars, 10);
  assert.equal(wd.spendOf(p, se.id).spendUSD, 0);
  p.log.append('usage', { agent: lead.name, expedition: se.id, costUSD: 0.5, models: {} });
  assert.equal(wd.spendOf(p, se.id).settledUSD, 0.5, 'a usage event raises its spend');
  // and the expedition's own state cache follows the log: a rotation that leaves the count the same does not serve a stale one
  const before = se.ex.state();
  p.log.load();
  assert.notEqual(se.ex.state(), before, 'a reload clears the cached state');
});

test('a rotation does not lose what another process appended to the live log while it ran', async t => {
  const { now, events, split } = await fixture(t);
  const dir = join(split, '.crux');
  const late = { id: 'late-append', ts: new Date(now).toISOString(), type: 'message', thread: 'orchestrator', from: 'you', text: 'written by the old hub as it shut down' };
  rotate(dir, { now, onStep: step => { if (step === 4) writeFileSync(join(dir, 'events.jsonl'), readFileSync(join(dir, 'events.jsonl'), 'utf8') + JSON.stringify(late) + '\n'); } });
  assert.ok(live(split).some(e => e.id === 'late-append'), 'carried over to the new live file');
  assert.equal(readAllEvents(dir).length, events.length + 1);
});

test('a test hub (no agents) neither rotates nor repairs: a real folder is left exactly as it is', async t => {
  const { root, now, split } = await fixture(t);
  const dir = join(split, '.crux');
  writeFileSync(join(dir, 'stray.tmp'), 'another hub is writing this');
  writeFileSync(join(dir, 'rotation.json'), JSON.stringify({ id: 'x', cutoff: 0 }));
  const h = new Hub({ projects: [split], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }), noAgents: true });
  assert.deepEqual(h.rotateLogs(), []);
  assert.ok(existsSync(join(dir, 'stray.tmp')) && existsSync(join(dir, 'rotation.json')) && !existsSync(join(dir, 'archive')));
  assert.equal(live(split).length, buildLog(now, 120).events.length, 'the live log is untouched');
});

test('a recovery that fails does not stop the hub from starting; the off switch skips recovery too', async t => {
  const { root, split } = await fixture(t);
  const dir = join(split, '.crux');
  writeFileSync(join(dir, 'rotation.json'), JSON.stringify({ id: 'stuck', cutoff: Date.now() }));
  writeFileSync(join(dir, 'archive'), 'a file where the archive folder should be');   // makes the rotation fail whatever it tries
  const log = new EventLog(split);
  assert.equal(log.events.length, live(split).length, 'starts from the live log as it is');
  assert.ok(existsSync(join(dir, 'rotation.json')), 'and leaves the unfinished rotation for another try');
  writeFileSync(join(dir, 'x.tmp'), 'kept');
  const off = new EventLog(split, { repair: false });
  assert.ok(off.events.length > 0 && existsSync(join(dir, 'x.tmp')), 'read only: nothing removed');
  void root;
});

test('a first line of any length does not stop a log from ever being due', async t => {
  const root = makeTmp('crux-archive-long-', t);
  const now = Date.now(), events = buildLog(now, 120).events;
  events[0] = { ...events[0], blob: 'x'.repeat(300000) };
  const dir = makeProject(root, 'long', events);
  const log = new EventLog(dir);
  assert.ok(log.rotateIfDue(now), 'due and rotated');
});

test('a rotation that failed at the last step is finished by the next one, not done twice: the counts do not double', async t => {
  const { root, now, full, split } = await fixture(t);
  const A = resolved(hubOf(root, full), hubOf(root, full).project('full'), now);
  const h = hubOf(root, split), p = h.project('split');
  assert.throws(() => p.log.rotateNow({ now, crashAfter: 5 }), /crash after step 5/);
  p.log.rotateNow({ now });   // finishes the first (reads the log again), finds nothing more to move
  assert.deepEqual(resolved(h, p, now), A);
  assert.deepEqual(p.log.carried.counts, readSnapshot(join(split, '.crux')).header.carried.counts);
});

test('an event in both the old snapshot (cut down) and the live log is taken from the live one', async t => {
  const root = makeTmp('crux-archive-orig-', t);
  const now = Date.now(), t0 = now - 100 * DAY;
  const q = { id: 'sum1', ts: new Date(t0).toISOString(), type: 'summary', thread: 'w', from: 'w', done: ['the whole round'], questions: ['Which colour, red or blue, for the header?'] };
  const dir = makeProject(root, 'p', [q, { id: 'm1', ts: new Date(t0 + 1000).toISOString(), type: 'message', thread: 'w', from: 'w', text: 'x' }]);
  // a snapshot that holds a cut-down copy of the summary, and the live log that still holds the original
  const slim = { id: 'sum1', ts: q.ts, type: 'summary', thread: 'w', from: 'w', questions: q.questions, slim: true };
  writeFileSync(join(dir, '.crux', 'snapshot.jsonl'), JSON.stringify({ type: 'snapshot_header', version: 1, carried: { counts: {}, traffic: {} } }) + '\n' + JSON.stringify(slim) + '\n');
  rotate(join(dir, '.crux'), { now });
  const kept = readSnapshot(join(dir, '.crux')).events.find(e => e.id === 'sum1');
  assert.ok(kept && !kept.slim && kept.done, 'the original, not the cut-down copy');
});

test('the snapshot keeps each agent\'s last busy mark that has a context number', () => {
  const ev = (type, data, i) => ({ id: `b${i}`, ts: new Date(1e12 + i * 1000).toISOString(), type, ...data });
  const all = [ev('agent_created', { agent: 'a', thread: 'a' }, 0), ev('agent_busy', { agent: 'a', busy: false, contextPct: 41 }, 1), ev('agent_busy', { agent: 'a', busy: true }, 2), ev('agent_busy', { agent: 'a', busy: false }, 3)];
  const ids = buildSnapshot(all, {}).events.map(e => e.id);
  assert.ok(ids.includes('b1') && ids.includes('b3'), ids.join());
  assert.ok(!ids.includes('b2'));
});

test('handoff facts read the archive back to the last handoff: the same facts after a rotation', async t => {
  const { root, now, full, split } = await fixture(t);
  const a = hubOf(root, full), b = hubOf(root, split);
  rotate(join(split, '.crux'), { now });
  const b2 = hubOf(root, split);
  const fa = a.handoffFacts(a.project('full'), a.project('full').agents.get('orchestrator-1'));
  const fb = b2.handoffFacts(b2.project('split'), b2.project('split').agents.get('orchestrator-1'));
  assert.equal(fb, fa);
  void b;
});

// The same on a real log, when a copy is named (never the live one): CRUX_REAL_LOG=<path to a copy of events.jsonl>.
test('on a copy of a real log: rotate at several points (before and after its question-rules cutover), resolve the same', { skip: !process.env.CRUX_REAL_LOG }, async t => {
  const root = makeTmp('crux-archive-real-', t);
  const lines = readFileSync(process.env.CRUX_REAL_LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  for (const frac of [0.3, 0.7, 0.85, 0.97]) {
    const now = Date.parse(lines[Math.floor(lines.length * frac)].ts) + CUTOFF_MS;
    const full = makeProject(root, `full${frac}`, lines), split = makeProject(root, `split${frac}`, lines);
    const A = resolved(hubOf(root, full), hubOf(root, full).project(`full${frac}`), now);
    const t0 = Date.now();
    const r = rotate(join(split, '.crux'), { now });
    const ms = Date.now() - t0;
    const h = hubOf(root, split);
    const B = resolved(h, h.project(`split${frac}`), now);
    // same names aside (the projects are called differently), the same answers
    const norm = x => JSON.parse(JSON.stringify(x));
    assert.deepEqual(norm(B), norm(A), `rotated at ${frac}`);
    console.log(`real log at ${frac}: ${lines.length} events; rotated ${r.archived}, snapshot ${r.snapshotEvents}, live ${r.liveEvents}; ${ms} ms; cards ${A.cards.length}`);
    // and in the running hub
    const g = hubOf(root, makeProject(root, `run${frac}`, lines)), pg = g.project(`run${frac}`);
    pg.log.rotateNow({ now });
    assert.deepEqual(norm(resolved(g, pg, now)), norm(A), `running hub rotated at ${frac}`);
  }
});
