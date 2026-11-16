// The Expedition watchdog (phase 3): the clock, both spend measures, the 90% note, the stop sequence, the interrupt fallback
// timer and the restart rebuild, all with a fake clock and fake agents (nothing starts). The invariant test for the
// watchdog's stops is in expedition-invariant.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { recordAgents, stubHub, StubExpedition, MODEL } from './helpers/expedition-stub.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { ExpeditionWatchdog, messageCost, priceFor, PRICE_PER_MTOK_ESTIMATE, THINKING_ALLOWANCE_TOKENS_ESTIMATE, RESERVE_AT, STOP_WAIT_MS } from '../lib/expedition-watchdog.mjs';
import { Expedition } from '../lib/expedition.mjs';
import { howItRan } from '../lib/expedition-report.mjs';

const realSend = Agent.prototype.send;
const sent = recordAgents();
const HOUR = 3600 * 1000;
const WINDOW = '2026-11-20T00:00:00Z', NEXT_WINDOW = '2026-11-27T00:00:00Z';

// Timers the test fires by hand: the stop's 60 s fallback is one of them.
function fakeTimers() {
  const t = { list: [], intervals: [] };
  t.setTimeout = (fn, ms) => { const h = { fn, ms, on: true }; t.list.push(h); return h; };
  t.clearTimeout = h => { if (h) h.on = false; };
  t.setInterval = (fn, ms) => { t.intervals.push({ fn, ms }); return { unref() { } }; };
  t.clearInterval = () => { };
  t.fire = ms => { for (const h of t.list.filter(x => x.on && x.ms === ms)) { h.on = false; h.fn(); } };
  t.pending = ms => t.list.some(x => x.on && x.ms === ms);
  return t;
}

// An expedition with the Lead and some members, the gate closed (so it is running). The clock starts at the start event's time.
function setup({ envelope = { hours: 6, dollars: 10, percent: 7 }, planStart = null, roles = ['builder', 'verifier'], gate = true } = {}) {
  const clock = { t: Date.now() }, timers = fakeTimers();
  const env = stubHub({ level: 'auto', watch: { now: () => clock.t, timers } });
  const se = new StubExpedition(env);
  const { ex } = se;
  ex.write('BRIEF.md', '# Which is faster?\n');
  ex.write('test/CHECKLIST.md', '1. A table exists.\n');
  ex.start({ envelope, planStart });
  const lead = se.startRole('lead', env.orch.name);
  if (gate) ex.gate({ verdict: 'approve' });
  for (const r of roles) se.startRole(r, lead.name);
  const t0 = Date.parse(ex.state().started.ts);
  clock.t = t0;
  sent.length = 0;
  for (const a of [lead, ...roles.map(r => se.agents[r])]) a.state = 'idle';   // the stub's send marks them working; a test that wants a turn in progress calls interruptible()
  return { ...env, se, ex, lead, clock, timers, t0, wd: env.hub.expeditionWatch, id: se.id, members: roles.map(r => se.agents[r]) };
}
// Fake agents that can be interrupted: each is in a turn; its interrupt ends the turn a tick later (answer) or never.
function interruptible(agents, { answer = true } = {}) {
  const calls = [];
  for (const a of agents) {
    a.state = 'working';
    a.q = { interrupt: async () => { calls.push(a.name); if (answer) setImmediate(() => a.setState('idle')); return { still_queued: [] }; }, stopTask: async () => { } };
  }
  return calls;
}
const stoppedOf = (S) => S.ex.state().stopped;
const toLead = (S, prefix) => sent.filter(([name, t]) => name === S.lead.name && t.startsWith(prefix));
// One assistant message as the SDK streams it.
const assistant = (id, usage, extra = {}) => ({ type: 'assistant', message: { id, model: MODEL.opus, content: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } }, parent_tool_use_id: null, ...extra });
const exact = (model, u) => { const p = priceFor(model); return ((u.input || 0) * p.input + (u.output || 0) * p.output + (u.cacheRead || 0) * p.cacheRead + (u.cacheWrite || 0) * p.cacheWrite) / 1e6; };
// A restart: a second hub on the same folders (agents asleep, state rebuilt from the log), with its own clock.
function restart(S, watch = {}) {
  const hub = new Hub({ projects: [S.dir], memory: new Memory(join(S.root, 'home')), agentHome: join(S.root, 'agents-home'), noAgents: true, settings: new HubSettings({ file: null, initial: {} }), expeditionWatch: { now: () => S.clock.t, timers: S.timers, ...watch } });
  const p = hub.project('proj');
  return { hub, p, wd: hub.expeditionWatch, lead: p.agents.get(S.lead.name), members: S.members.map(m => p.agents.get(m.name)) };
}

// The 7-day meter as the hub holds it (percent 0 to 100), read at asOfMs (default: just after the launch, so it is fresh).
const plan = (S, pct, resetsAt = WINDOW, asOfMs = S.t0 + 1000) => {
  S.hub.usage.plan = { windows: { five_hour: null, seven_day: { key: 'seven_day', label: '7-day', pct, resetsAt } }, models: [], statuses: {}, asOf: new Date(asOfMs).toISOString() };
  S.hub.usage.available = true;
};
const meterRise = S => S.wd.trackOf(S.p, S.id).risen;

// ---------- time ----------
test('time: below the limit nothing happens; at 100% the stop is logged with its totals, then members are interrupted, retired, and the Lead has its final message', async () => {
  const S = setup();
  S.se.usage('lead', { cost: 0.4 });
  const calls = interruptible([S.lead, ...S.members]);
  S.clock.t = S.t0 + 5 * HOUR;
  assert.deepEqual(S.wd.check(S.clock.t), [], '5 of 6 hours: inside the envelope, before the reserve');
  S.clock.t = S.t0 + 6 * HOUR + 1000;
  const did = S.wd.check(S.clock.t);
  assert.deepEqual(did.map(d => [d.did, d.reason]), [['stop', 'time']]);
  const stopped = stoppedOf(S);
  assert.equal(stopped.reason, 'time');
  assert.equal(stopped.totals.activeMs, 6 * HOUR + 1000);
  assert.equal(stopped.totals.costUSD, 0.4, 'the report totals: measured from usage events');
  assert.match(stopped.totals.detail, /^6 h of 6 h$/);
  assert.equal(S.ex.state().phase, 'stopped');
  await S.wd.settled();
  assert.deepEqual(calls.sort(), [S.lead.name, ...S.members.map(m => m.name)].sort(), 'every expedition agent in a turn was interrupted, the Lead too');
  assert.deepEqual(S.members.map(m => m.state), ['retired', 'retired'], 'all but the Lead retired');
  assert.notEqual(S.lead.state, 'retired');
  const finals = toLead(S, '[From the hub] The expedition has stopped');
  assert.equal(finals.length, 1, 'the Lead gets exactly one final message');
  assert.match(finals[0][1], /time limit is used/);
  assert.match(finals[0][1], /state in the report that the claims were not checked/);
  assert.doesNotMatch(finals[0][1], /Verifier/, 'after a hub stop no Verifier is offered');
  assert.equal(S.ex.state().finalNote.kind, 'final');
  // A further check does nothing more.
  assert.deepEqual(S.wd.check(S.clock.t + HOUR), []);
  assert.equal(toLead(S, '[From the hub] The expedition has stopped').length, 1);
  assert.equal(S.p.log.ofType('expedition_stopped').length, 1);
});

test('an idle agent is not interrupted (an interrupt on it gives no result), and the sequence does not wait on it', async () => {
  const S = setup();
  const calls = interruptible([S.lead]);   // the members are asleep: no query, not in a turn
  for (const m of S.members) m.state = 'idle';
  S.wd.stopNow(S.p, S.id, 'Matt');
  await S.wd.settled();
  assert.deepEqual(calls, [S.lead.name]);
  assert.deepEqual(S.members.map(m => m.state), ['retired', 'retired']);
  assert.equal(toLead(S, '[From the hub] The expedition has stopped').length, 1);
  assert.match(toLead(S, '[From the hub]')[0][1], /the user pressed Stop/);
});

// ---------- Pause freezes the clock only ----------
test('Pause freezes the clock and nothing else: paused time is not counted, and spend still counts while paused', () => {
  const S = setup();
  const iso = ms => new Date(ms).toISOString();
  S.p.log.append('project_settings', { paused: true, by: 'you', thread: 'orchestrator', ts: iso(S.t0 + 1 * HOUR) });
  S.p.log.append('project_settings', { paused: false, by: 'you', thread: 'orchestrator', ts: iso(S.t0 + 3 * HOUR) });
  S.clock.t = S.t0 + 7 * HOUR;   // 7 h of wall clock, 2 h of it paused: 5 h counted
  assert.deepEqual(S.wd.check(S.clock.t), [], '5 h is inside 6 h and under the 90% mark (5.4 h)');
  const t = S.wd.trackOf(S.p, S.id);
  assert.equal(t.activeMs(S.clock.t), 5 * HOUR);
  S.clock.t = S.t0 + 8.5 * HOUR;   // 6.5 h counted
  assert.equal(S.wd.check(S.clock.t)[0].did, 'stop');
  assert.equal(stoppedOf(S).totals.pausedMs, 2 * HOUR);
});

test('a project paused right now holds the clock; a pause that began before the start is held from the start', () => {
  const S = setup();
  S.p.log.append('project_settings', { paused: true, by: 'you', thread: 'orchestrator', ts: new Date(S.t0 + HOUR).toISOString() });
  S.clock.t = S.t0 + 100 * HOUR;
  assert.deepEqual(S.wd.check(S.clock.t), [], 'paused for good: the clock stands still at 1 h');
  assert.equal(S.wd.trackOf(S.p, S.id).activeMs(S.clock.t), HOUR);
  // A second expedition started while paused: the clock does not run from its start.
  const H = stubHub({ level: 'auto' });
  H.p.log.append('project_settings', { paused: true, by: 'you', thread: 'orchestrator' });
  const se = new StubExpedition(H); se.ex.write('BRIEF.md', 'x'); se.ex.write('test/CHECKLIST.md', '1.'); se.ex.start({ envelope: { hours: 1 } });
  const wd = H.hub.expeditionWatch, t0 = Date.parse(se.ex.state().started.ts);
  assert.deepEqual(wd.check(t0 + 50 * HOUR), []);
  assert.equal(wd.trackOf(H.p, se.id).activeMs(t0 + 50 * HOUR), 0);
});

test('spend keeps counting while paused: a counted message trips the budget stop although the clock is frozen', () => {
  const S = setup({ envelope: { hours: 6, dollars: 1 } });
  S.p.log.append('project_settings', { paused: true, by: 'you', thread: 'orchestrator', ts: new Date(S.t0).toISOString() });
  interruptible([S.lead, ...S.members]);
  S.lead.onMessage(assistant('m1', { input_tokens: 10, output_tokens: 50000 }), null);   // 50k output on Opus is far over $1
  assert.equal(stoppedOf(S)?.reason, 'budget');
});

// ---------- spend measure 1 ----------
test('spend 1: the usage events\' figures count against the dollar cap; 90% sends the note once, 100% stops (budget)', async () => {
  const S = setup({ envelope: { hours: 6, dollars: 10 } });
  interruptible([S.lead, ...S.members]);
  S.se.usage('lead', { cost: 4 }); S.se.usage('builder', { cost: 4 });
  assert.deepEqual(S.wd.check(S.t0 + 1000), [], '$8 of $10');
  S.se.usage('verifier', { cost: 1.2 });
  assert.deepEqual(S.wd.check(S.t0 + 2000).map(d => d.did), ['note'], '$9.20 of $10 is past 90%');
  assert.deepEqual(S.wd.check(S.t0 + 3000), [], 'the note is not sent again');
  S.se.usage('builder', { cost: 1 });
  assert.deepEqual(S.wd.check(S.t0 + 4000).map(d => [d.did, d.reason, d.measure]), [['stop', 'budget', 'spend']]);
  await S.wd.settled();
  assert.match(stoppedOf(S).totals.detail, /\$10\.2\d of \$10\.00/);
  assert.equal(toLead(S, '[From the hub] 90%').length, 1);
});

test('no dollar cap set: spend never stops it, time and the plan meter still do', () => {
  const S = setup({ envelope: { hours: 6, dollars: null } });
  S.se.usage('lead', { cost: 500 });
  assert.deepEqual(S.wd.check(S.t0 + 1000), []);
});

// ---------- the 90% note ----------
test('the 90% note: logged once as expedition_note, sent to the Lead once, and a restart does not send it again', () => {
  const S = setup();
  S.clock.t = S.t0 + 5.5 * HOUR;
  assert.equal(RESERVE_AT, 0.9);
  assert.deepEqual(S.wd.check(S.clock.t).map(d => [d.did, d.measure]), [['note', 'time']]);
  const msgs = toLead(S, '[From the hub] 90%');
  assert.equal(msgs.length, 1);
  assert.match(msgs[0][1], /time is used \(5\.5 h of 6 h\)/);
  assert.match(msgs[0][1], /Stop building now/);
  assert.match(msgs[0][1], /Check the claims/);
  const notes = S.p.log.ofType('expedition_note').filter(e => e.expedition === S.id && e.kind === 'reserve');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].measure, 'time');
  assert.equal(S.p.log.events.filter(e => e.thread === 'orchestrator' && /90%/.test(e.text || '')).length, 0, 'nothing about it in the orchestrator\'s thread');
  S.wd.check(S.t0 + 5.6 * HOUR);
  assert.equal(toLead(S, '[From the hub] 90%').length, 1, 'a second check: no second note');
  // Restart in the middle of the reserve window: the new hub reads the note from the log.
  S.clock.t = S.t0 + 5.7 * HOUR;
  const R = restart(S);
  assert.deepEqual(R.wd.check(S.clock.t), []);
  assert.equal(toLead(S, '[From the hub] 90%').length, 1, 'the restart does not send the note again');
  assert.equal(R.p.log.ofType('expedition_note').filter(e => e.kind === 'reserve').length, 1);
});

test('the note is not sent when nobody can hear it, and is sent at the next check once a Lead exists', () => {
  const S = setup();
  S.hub.finishRetire(S.p, S.lead);
  S.clock.t = S.t0 + 5.5 * HOUR;
  assert.deepEqual(S.wd.check(S.clock.t), []);
  assert.equal(S.p.log.ofType('expedition_note').length, 0, 'not logged either: nothing was sent');
});

test('no handoff once the 90% note has gone; before it, the threshold handoff applies', () => {
  const S = setup();
  S.lead.contextPct = 99;
  S.hub.onIdle(S.p, S.lead);
  assert.equal(S.lead.state, 'retired', 'before 90%: handed on (no session yet, so retired at once)');
  const T = setup();
  T.clock.t = T.t0 + 5.5 * HOUR; T.wd.check(T.clock.t);
  T.lead.contextPct = 99;
  T.hub.onIdle(T.p, T.lead);
  assert.notEqual(T.lead.state, 'retired', 'after the note: the Lead finishes its write-up');
});

// ---------- spend measure 2 ----------
test('spend 2: the 7-day meter rising 7 points since the first fresh reading stops it (budget); 90% of that is the note', async () => {
  const S = setup({ planStart: null });   // nothing was known at launch: measure 2 waits for the first fresh reading, it is not off
  interruptible([S.lead, ...S.members]);
  assert.deepEqual(S.wd.check(S.t0 + 500), [], 'no reading yet');
  plan(S, 20);
  assert.deepEqual(S.wd.check(S.t0 + 1000), [], 'the first fresh reading is the baseline, not a rise');
  const base = S.p.log.ofType('expedition_note').find(e => e.kind === 'meter');
  assert.deepEqual([base.pct, base.resetsAt, base.expedition], [20, WINDOW, S.id], 'logged, so a restart counts from the same place');
  plan(S, 24.5);
  assert.deepEqual(S.wd.check(S.t0 + 2000), [], '4.5 points');
  plan(S, 26.5);
  assert.deepEqual(S.wd.check(S.t0 + 3000).map(d => [d.did, d.measure]), [['note', 'meter']], '6.5 of 7 points: past 90%');
  assert.match(toLead(S, '[From the hub] 90%')[0][1], /7-day plan meter/);
  plan(S, 27);
  assert.deepEqual(S.wd.check(S.t0 + 4000).map(d => [d.did, d.reason, d.measure]), [['stop', 'budget', 'meter']]);
  await S.wd.settled();
  assert.equal(stoppedOf(S).totals.meterRisePoints, 7);
  assert.match(stoppedOf(S).totals.detail, /up 7\.0 of 7 points/);
  assert.equal(S.p.log.ofType('expedition_note').filter(e => e.kind === 'meter').length, 1, 'one baseline note only');
  assert.equal(S.ex.state().reserveNote.kind, 'reserve', 'the meter note is not the 90% note');
});

test('spend 2 counts the rise above the window\'s baseline, not step by step: a meter that dips and recovers does not count the recovery again', () => {
  const S = setup({ planStart: null });
  plan(S, 10);
  S.wd.check(S.t0 + 1000);   // baseline 10
  const readings = [13, 12.6, 13, 12.6, 13, 12.6, 13];
  for (const [i, r] of readings.entries()) { plan(S, r); S.wd.check(S.t0 + 2000 + i); }
  assert.equal(meterRise(S), 3, 'the known answer: 13 - 10, not 4.2');
  assert.deepEqual(S.wd.check(S.t0 + 9000), [], '3 of 7 points: nothing');
  plan(S, 12.6); S.wd.check(S.t0 + 9500);
  assert.ok(Math.abs(meterRise(S) - 2.6) < 1e-9, 'the rise follows the current reading: a dip lowers it');
});

test('spend 2: a rate_limit event (utilization a fraction of 1) and the usage call (0 to 100) land on the same scale', () => {
  const S = setup({ planStart: null });
  plan(S, 10);
  S.wd.check(S.t0 + 1000);   // baseline 10 (the usage call's scale)
  S.hub.usage.rateLimit({ rateLimitType: 'seven_day', status: 'allowed', unifiedWindows: { seven_day: { status: 'allowed', utilization: 0.13, resetsAt: Date.parse(WINDOW) / 1000 } } }, S.p);   // 13 percent
  assert.equal(S.hub.usage.plan.windows.seven_day.pct, 13);
  S.wd.check(S.t0 + 2000);
  assert.equal(meterRise(S), 3, '0.13 is 13 percent: a rise of 3, not 0.13 and not 12.87');
});

test('spend 2 is re-based when the window resets: the old window\'s rise is banked and the new one starts from its first reading', () => {
  const S = setup({ planStart: null });
  plan(S, 90, WINDOW);
  S.wd.check(S.t0 + 1000);
  plan(S, 94, WINDOW);
  S.wd.check(S.t0 + 2000);
  assert.equal(meterRise(S), 4);
  plan(S, 2, NEXT_WINDOW);   // the window reset: the meter starts again from zero, and the first reading of the new window is its baseline
  S.wd.check(S.t0 + 3000);
  assert.equal(meterRise(S), 4, 'banked: 4 from the old window, nothing yet from the new one');
  plan(S, 4.5, NEXT_WINDOW);
  assert.equal(S.wd.check(S.t0 + 4000)[0].did, 'note', '4 + 2.5 = 6.5 of 7');
  plan(S, 4.5, '2026-11-27T00:00:09Z');   // the same window read again, a few seconds off: not a reset
  S.wd.check(S.t0 + 5000);
  assert.equal(meterRise(S), 6.5, 'a few seconds\' difference in the reset time is the same window');
  plan(S, 5.2, NEXT_WINDOW);
  assert.equal(S.wd.check(S.t0 + 6000)[0].did, 'stop', '4 + 3.2 = 7.2 is over 7');
  assert.equal(stoppedOf(S)?.reason, 'budget');
});

test('spend 2 waits for a FRESH reading: one taken before the launch is no baseline; under an API key it never starts, and the other limits still apply', () => {
  const S = setup({ planStart: { sevenDayPct: 50, resetsAt: WINDOW } });   // the launch saw a reading, but it can be minutes old
  plan(S, 50, WINDOW, S.t0 - 60000);
  assert.deepEqual(S.wd.check(S.t0 + 1000), []);
  assert.equal(S.wd.trackOf(S.p, S.id).meter.baseline, null, 'a stale reading is not the baseline');
  plan(S, 51, WINDOW, S.t0 + 2000);
  S.wd.check(S.t0 + 3000);
  assert.equal(S.wd.trackOf(S.p, S.id).meter.baseline, 51, 'the first fresh reading is');
  assert.equal(S.wd.planStart().sevenDayPct, 51, 'a plan that loads gives a record for the next launch');
  // An API key: the meters hide.
  const T = setup({ planStart: null });
  T.hub.usage.plan = null; T.hub.usage.available = false;
  assert.equal(T.wd.planStart(), null);
  assert.deepEqual(T.wd.check(T.t0 + 1000), []);
  assert.equal(T.wd.trackOf(T.p, T.id).meter.baseline, null);
  T.clock.t = T.t0 + 7 * HOUR;
  assert.equal(T.wd.check(T.clock.t)[0].did, 'stop', 'time still stops it');
  // The meters vanish mid-run: nothing new is read, and what was counted stands.
  const U = setup({ planStart: null });
  plan(U, 10); U.wd.check(U.t0 + 1000); plan(U, 12, WINDOW); U.wd.check(U.t0 + 2000);
  U.hub.usage.plan = null; U.hub.usage.available = false;
  assert.deepEqual(U.wd.check(U.t0 + 3000), []);
  assert.equal(meterRise(U), 2);
});

test('launchExpedition records the 7-day reading it will count from (null under an API key)', () => {
  const H = stubHub({ level: 'auto' });
  H.hub.usage.plan = { windows: { seven_day: { key: 'seven_day', pct: 12.5, resetsAt: WINDOW } }, models: [] }; H.hub.usage.available = true;
  const a = H.hub.launchExpedition(H.p, { brief: 'Which is faster?', question: 'which is faster' });
  assert.deepEqual(new Expedition(H.p, a.id).state().started.planStart, { sevenDayPct: 12.5, resetsAt: WINDOW });
  const I = stubHub({ level: 'auto' });
  I.hub.usage.plan = null; I.hub.usage.available = false;
  const b = I.hub.launchExpedition(I.p, { brief: 'Which is faster?', question: 'which is faster' });
  assert.equal(new Expedition(I.p, b.id).state().started.planStart, null);
});

// ---------- per-message counting ----------
test('per-message counting: once per id (repeated frames, a larger later frame), a subagent frame counts, and the result replaces the estimate', () => {
  const S = setup({ envelope: { hours: 6, dollars: 1000 } });
  const t = S.wd.trackOf(S.p, S.id);
  const usage = { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 20000, cache_creation_input_tokens: 3000 };
  const base = messageCost(MODEL.opus, { input: 5, output: 100, cacheRead: 20000, cacheWrite: 3000 }, S.lead.effort || 'medium');
  S.lead.onMessage(assistant('m1', usage), null);
  S.lead.onMessage(assistant('m1', usage), null);   // the same message's text frame: same usage, not counted again
  assert.ok(Math.abs(t.inflightUSD() - base) < 1e-9, 'one message, counted once');
  S.lead.onMessage(assistant('m1', { ...usage, output_tokens: 400 }), null);   // a later frame shows more output: the figure rises, never doubles
  assert.ok(Math.abs(t.inflightUSD() - messageCost(MODEL.opus, { input: 5, output: 400, cacheRead: 20000, cacheWrite: 3000 }, S.lead.effort || 'medium')) < 1e-9);
  S.lead.onMessage(assistant('m1', { ...usage, output_tokens: 50 }), null);   // a smaller one never lowers it
  const afterMax = t.inflightUSD();
  assert.ok(afterMax > base);
  // A gatherer's frame inside the Lead's stream (parent_tool_use_id and agent_id set) is counted, priced as Haiku, at the gatherer's effort.
  S.lead.onMessage(assistant('g1', { input_tokens: 4, output_tokens: 30, cache_read_input_tokens: 2986, cache_creation_input_tokens: 837 }, { parent_tool_use_id: 'toolu_1', agent_id: 'task-1', message: { id: 'g1', model: MODEL.haiku, usage: { input_tokens: 4, output_tokens: 30, cache_read_input_tokens: 2986, cache_creation_input_tokens: 837 }, content: [] } }), null);
  assert.ok(Math.abs(t.inflightUSD() - afterMax - messageCost(MODEL.haiku, { input: 4, output: 30, cacheRead: 2986, cacheWrite: 837 }, 'low')) < 1e-9);
  assert.ok(t.frameAgents.has('task-1'));
  // The builder's own messages are counted under the builder.
  S.se.agents.builder.onMessage(assistant('b1', { input_tokens: 1, output_tokens: 10 }, { message: { id: 'b1', model: MODEL.sonnet, usage: { input_tokens: 1, output_tokens: 10 }, content: [] } }), null);
  assert.equal(t.inflight.size, 2);
  // The Lead's result arrives with a figure LOWER than the estimate: the result wins. Only the Lead's messages are replaced.
  const estimate = t.spendUSD();
  S.se.usage('lead', { cost: 0.01 });
  S.lead.onMessage({ type: 'result', subtype: 'success', is_error: false, modelUsage: {} }, { getContextUsage: async () => ({ percentage: 5 }) });   // no figure of its own here: usage was logged above
  const lowered = t.spendUSD();
  assert.ok(lowered < estimate);
  assert.ok(Math.abs(t.settledUSD - 0.01) < 1e-9, 'the logged result is what counts');
  assert.equal(t.inflight.has(S.lead.name), false);
  assert.equal(t.inflight.has(S.se.agents.builder.name), true, "the builder's estimate stands until its own result");
  // A late repeat of a message the result already covers is not counted again.
  S.lead.onMessage(assistant('m1', usage), null);
  assert.equal(t.inflight.has(S.lead.name), false);
  // A result with a figure HIGHER than the estimate also wins (the estimate is only ever a stand-in).
  S.lead.onMessage(assistant('m2', { input_tokens: 1 }), null);
  S.se.usage('lead', { cost: 3 });
  S.lead.onMessage({ type: 'result', subtype: 'success', is_error: false, modelUsage: {} }, { getContextUsage: async () => ({ percentage: 5 }) });
  assert.ok(Math.abs(t.settledUSD - 3.01) < 1e-9);
});

test('estimates err high: Opus rates are the logged ones, Haiku is priced as Sonnet, an unknown model as the dearest, and thinking adds output', () => {
  assert.deepEqual(PRICE_PER_MTOK_ESTIMATE.opus, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 });
  assert.deepEqual(PRICE_PER_MTOK_ESTIMATE.haiku, PRICE_PER_MTOK_ESTIMATE.sonnet);
  assert.deepEqual(priceFor('claude-some-new-model'), PRICE_PER_MTOK_ESTIMATE.fable);
  assert.ok(PRICE_PER_MTOK_ESTIMATE.fable.output > PRICE_PER_MTOK_ESTIMATE.opus.output);
  const u = { input: 1000, output: 500, cacheRead: 100000, cacheWrite: 2000 };
  assert.ok(messageCost(MODEL.opus, u, 'high') > exact(MODEL.opus, u), 'the allowance for unseen thinking is on top');
  assert.ok(Math.abs(messageCost(MODEL.opus, u, 'high') - exact(MODEL.opus, u) - THINKING_ALLOWANCE_TOKENS_ESTIMATE.high * 20 / 1e6) < 1e-12);
  assert.ok(messageCost(MODEL.opus, u, 'xhigh') > messageCost(MODEL.opus, u, 'low'));
  assert.ok(messageCost(MODEL.opus, u, undefined) > exact(MODEL.opus, u), 'an unknown effort still gets an allowance');
  // The spike's Sonnet subagent (M046): its tokens as the frames showed them, against the $0.0108 the result then reported.
  assert.ok(messageCost(MODEL.sonnet, { input: 4, output: 33, cacheRead: 2986, cacheWrite: 3823 }, 'low') > 0.0108);
});

test('a counted message past the dollar cap stops the expedition at once, without waiting for the 30 s timer or a result', async () => {
  const S = setup({ envelope: { hours: 6, dollars: 0.5 } });
  interruptible([S.lead, ...S.members]);
  S.lead.onMessage(assistant('big', { input_tokens: 100, output_tokens: 30000, cache_read_input_tokens: 100000 }), null);
  assert.equal(stoppedOf(S)?.reason, 'budget');
  await S.wd.settled();
  assert.deepEqual(S.members.map(m => m.state), ['retired', 'retired']);
  // After the stop the spend is still counted (the Lead's final turn goes in the report), with no limit left to check: no second stop.
  const t = S.wd.trackOf(S.p, S.id);
  const before = S.wd.spendOf(S.p, S.id).spendUSD;
  S.lead.onMessage(assistant('later', { input_tokens: 5, output_tokens: 3000 }), null);
  assert.equal(t.inflight.get(S.lead.name).has('later'), true);
  assert.ok(S.wd.spendOf(S.p, S.id).spendUSD > before);
  assert.equal(S.p.log.ofType('expedition_stopped').length, 1);
  // And its result replaces the estimate as before.
  S.se.usage('lead', { cost: 0.2 });
  S.lead.onMessage({ type: 'result', subtype: 'success', is_error: false, modelUsage: {} }, { getContextUsage: async () => ({ percentage: 5 }) });
  assert.equal(t.inflight.has(S.lead.name), false);
  assert.ok(Math.abs(S.wd.spendOf(S.p, S.id).settledUSD - 0.2) < 1e-9);
});

test('a gatherer whose own frames never reach the stream is estimated from task_progress (a priced-high lower bound), until it ends', () => {
  const S = setup({ envelope: { hours: 6, dollars: 1000 } });
  S.lead.onTask({ type: 'system', subtype: 'task_started', task_id: 'g9', subagent_type: 'expedition-gatherer', task_type: 'local_agent' });
  S.lead.onTask({ type: 'system', subtype: 'task_progress', task_id: 'g9', usage: { total_tokens: 4000, tool_uses: 2 } });
  const t = S.wd.trackOf(S.p, S.id);
  const fb = S.wd.fallbackUSD(t);
  assert.ok(Math.abs(fb - 3 * 4000 * PRICE_PER_MTOK_ESTIMATE.haiku.input / 1e6) < 1e-12);
  // Once its own frames arrive, task_progress is no longer used for it.
  S.lead.onMessage(assistant('gf', { input_tokens: 1 }, { parent_tool_use_id: 'x', agent_id: 'g9', message: { id: 'gf', model: MODEL.haiku, usage: { input_tokens: 1 }, content: [] } }), null);
  assert.equal(S.wd.fallbackUSD(t), 0);
});

// ---------- the interrupt fallback timer ----------
test('the interrupt fallback: an agent that never answers is closed after 60 seconds, and the sequence goes on', async () => {
  const S = setup();
  const calls = interruptible([S.lead, ...S.members], { answer: false });
  S.wd.stopNow(S.p, S.id, 'time');
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 3, 'all three asked to stop');
  assert.ok(S.timers.pending(STOP_WAIT_MS), 'the 60 s fallback timer is set');
  assert.equal(STOP_WAIT_MS, 60000);
  assert.deepEqual(S.members.map(m => m.state), ['working', 'working'], 'still waiting for their results');
  assert.equal(toLead(S, '[From the hub] The expedition has stopped').length, 0, 'the Lead has not been told yet');
  S.timers.fire(STOP_WAIT_MS);
  await S.wd.settled();
  const closedNotices = S.p.log.ofType('notice').filter(e => /did not stop within 60 seconds, so the hub closed it/.test(e.text));
  assert.equal(closedNotices.length, 3, 'the three that never answered were closed, each said in its own thread');
  assert.deepEqual(S.members.map(m => m.state), ['retired', 'retired']);
  assert.equal(toLead(S, '[From the hub] The expedition has stopped').length, 1);
});

test('when every result comes in time the fallback timer is cleared and nothing is closed', async () => {
  const S = setup();
  interruptible([S.lead, ...S.members]);
  S.wd.stopNow(S.p, S.id, 'Matt');
  await S.wd.settled();
  assert.equal(S.timers.pending(STOP_WAIT_MS), false);
});

// ---------- restart ----------
test('restart in the middle of the stop sequence: the sequence is carried on once, and the final message is never sent twice', async () => {
  const S = setup();
  // The stop was logged but the hub went down before anyone was retired or told.
  S.ex.stop({ reason: 'budget', totals: { detail: '$10.20 of $10.00' } });
  assert.equal(S.members.every(m => m.state !== 'retired'), true);
  const R = restart(S);   // the new hub's watchdog starts: it finds the stop with no final note
  await R.wd.settled();
  assert.deepEqual(R.members.map(m => m.state), ['retired', 'retired']);
  const finals = () => sent.filter(([n, t]) => n === S.lead.name && t.startsWith('[From the hub] The expedition has stopped'));
  assert.equal(finals().length, 1);
  assert.match(finals()[0][1], /the budget is used \(\$10\.20 of \$10\.00\)/);
  // A second restart, and later checks: nothing more is sent, nothing logged twice.
  const R2 = restart(S);
  await R2.wd.settled();
  R2.wd.check(S.clock.t + HOUR);
  assert.equal(finals().length, 1);
  assert.equal(R2.p.log.ofType('expedition_note').filter(e => e.kind === 'final').length, 1);
  assert.equal(R2.p.log.ofType('expedition_stopped').length, 1, 'the stop is never issued twice');
});

test('restart rebuilds the clock, the spend, the pause and the meter from the log', () => {
  const S = setup({ envelope: { hours: 6, dollars: 10, percent: 7 }, planStart: null });
  plan(S, 50); S.wd.check(S.t0 + 500);   // the baseline note
  S.p.log.append('project_settings', { paused: true, by: 'you', thread: 'orchestrator', ts: new Date(S.t0 + HOUR).toISOString() });
  S.p.log.append('project_settings', { paused: false, by: 'you', thread: 'orchestrator', ts: new Date(S.t0 + 2 * HOUR).toISOString() });
  S.se.usage('lead', { cost: 2.5 }); S.se.usage('builder', { cost: 1 });
  S.p.log.append('plan_usage', { plan: { windows: { seven_day: { key: 'seven_day', pct: 52, resetsAt: WINDOW } }, models: [] } });
  const R = restart(S);
  S.clock.t = S.t0 + 4 * HOUR;
  const t = R.wd.trackOf(R.p, S.id);
  assert.equal(t.activeMs(S.clock.t), 3 * HOUR);
  assert.ok(Math.abs(t.settledUSD - 3.5) < 1e-9);
  assert.equal(t.meter.baseline, 50, 'the baseline comes from the log, not from the first reading the new hub sees');
  assert.equal(t.risen, 2);
  assert.equal(t.reserve, null);
});

test('a restart does not lose the pause that was on when the hub went down', () => {
  const S = setup();
  S.p.log.append('project_settings', { paused: true, by: 'you', thread: 'orchestrator', ts: new Date(S.t0 + HOUR).toISOString() });
  const R = restart(S);
  S.clock.t = S.t0 + 20 * HOUR;
  assert.deepEqual(R.wd.check(S.clock.t), []);
});

// ---------- the Lead's own stops ----------
test('passed and no-progress stops come from the Lead\'s tools and retire no one: the watchdog sees the stop logged and does nothing', async () => {
  for (const reason of ['passed', 'no-progress']) {
    const S = setup();
    S.ex.loop({ number: 1, passing: 1, progress: true });
    S.ex.stop({ reason, totals: {} });
    S.clock.t = S.t0 + 7 * HOUR;   // well past the time limit: it would stop for time if the stop were not already on record
    assert.deepEqual(S.wd.check(S.clock.t), [], reason);
    await S.wd.settled();
    assert.equal(S.p.log.ofType('expedition_stopped').length, 1, 'no second stop');
    assert.deepEqual(S.members.map(m => m.state).filter(s => s === 'retired'), [], 'no one retired');
    assert.equal(toLead(S, '[From the hub]').length, 0);
    assert.equal(S.ex.state().finalNote, null);
  }
});

test('no-progress backstop: two loops with no progress and no stop on record is stopped (no-progress) and retires no one; a stop already on record is left alone', async () => {
  const S = setup();
  S.ex.loop({ number: 1, passing: 2, progress: true });
  S.ex.loop({ number: 2, passing: 2, progress: false });
  assert.deepEqual(S.wd.check(S.t0 + 1000), [], 'one loop without progress is not enough');
  S.ex.loop({ number: 3, passing: 1, progress: false });
  assert.deepEqual(S.wd.check(S.t0 + 2000).map(d => d.did), ['no-progress']);
  assert.equal(stoppedOf(S).reason, 'no-progress');
  await S.wd.settled();
  assert.deepEqual(S.members.map(m => m.state).filter(s => s === 'retired'), []);
  assert.equal(toLead(S, '[From the hub]').length, 0);
  // The tool's own path (expedition_loop_result) logs the stop itself: the backstop then does nothing.
  const T = setup();
  T.ex.loop({ number: 1, passing: 2, progress: false });
  T.ex.loop({ number: 2, passing: 2, progress: false });
  T.ex.stop({ reason: 'no-progress', totals: {} });
  assert.deepEqual(T.wd.check(T.t0 + 1000), []);
  assert.equal(T.p.log.ofType('expedition_stopped').length, 1);
});

// ---------- who is told, who is stopped ----------
test('the final message goes to the newest Lead (a successor), not the one handing over', async () => {
  const S = setup();
  S.lead.retiring = 'overlap';   // handing over: it answers its successor's questions and then retires
  const succ = S.hub.startWorker(S.p, 'exp-lead-2', 'Carry on.', 'hub', 'Lead', { type: 'expedition-lead', expedition: S.id, expeditionRole: 'lead' });
  succ.state = 'idle';
  sent.length = 0;
  S.wd.stopNow(S.p, S.id, 'Matt');
  await S.wd.settled();
  assert.equal(sent.filter(([n, t]) => n === succ.name && t.startsWith('[From the hub] The expedition has stopped')).length, 1);
  assert.equal(sent.filter(([n, t]) => n === S.lead.name && t.startsWith('[From the hub] The expedition has stopped')).length, 0);
  assert.notEqual(succ.state, 'retired');
  assert.notEqual(S.lead.state, 'retired', 'a Lead is never retired by the stop, either holder');
});

test('the stop sequence touches only this expedition: another expedition\'s agents and plain workers are left alone', async () => {
  const S = setup();
  const plain = S.hub.startWorker(S.p, 'plain', 'Build it', S.orch.name, 'Build it');
  const calls = interruptible([S.lead, ...S.members, plain]);
  const other = new Expedition(S.p, '20261116-other');
  // An agent of some other expedition (it would be its Lead's, not ours).
  const stray = S.hub.startWorker(S.p, 'stray', 'Other', 'hub', 'Other', { type: 'expedition-builder', expedition: other.id, expeditionRole: 'builder' });
  stray.state = 'working'; stray.q = { interrupt: async () => { calls.push(stray.name); } };
  S.wd.stopNow(S.p, S.id, 'Matt');
  await S.wd.settled();
  assert.equal(calls.includes('plain'), false);
  assert.equal(calls.includes('stray'), false);
  assert.notEqual(plain.state, 'retired');
  assert.notEqual(stray.state, 'retired');
});

test('stopNow is the user\'s Stop: reason Matt, once; the hub refuses to stop for passed or no-progress (those are the Lead\'s)', async () => {
  const S = setup();
  assert.throws(() => S.hub.stopExpedition(S.p, S.id, 'passed'), /Lead's to log/);
  assert.equal(S.hub.stopExpedition(S.p, S.id).reason, 'Matt');
  assert.equal(S.hub.stopExpedition(S.p, S.id).did, 'already');
  await S.wd.settled();
  assert.equal(S.p.log.ofType('expedition_stopped').length, 1);
  assert.equal(stoppedOf(S).reason, 'Matt');
  assert.throws(() => S.wd.stopNow(S.p, '20261116-nothing'), /No expedition/);
});

test('a hub that is shutting down does not run limits or stops (its agents were closed, not finished)', () => {
  const S = setup();
  S.hub.stopping = true;
  S.clock.t = S.t0 + 10 * HOUR;
  assert.deepEqual(S.wd.check(S.clock.t), []);
  assert.equal(stoppedOf(S), null);
});

test('with no expeditions the watchdog finds nothing and a plain agent\'s messages are never counted', () => {
  const H = stubHub({ level: 'auto' });
  assert.deepEqual(H.hub.expeditionWatch.check(Date.now() + 1000 * HOUR), []);
  const w = H.hub.startWorker(H.p, 'plain', 'x', H.orch.name, 'x');
  w.onMessage(assistant('p1', { input_tokens: 100000 }), null);
  assert.equal([...H.hub.expeditionWatch.watches.values()].every(x => x.tracks.size === 0), true);
});

// ---------- the interrupt on the agent ----------
test('Agent.interrupt: only a turn in progress is interrupted; its error result is the hub\'s doing (no notice, no error flag); a new message clears it', async () => {
  const S = setup();
  const a = S.members[0];
  let n = 0;
  a.q = { interrupt: async () => { n++; return { still_queued: [] }; } };
  a.state = 'idle';
  assert.equal(await a.interrupt(), false);
  assert.equal(n, 0, 'idle: no interrupt sent (it would give no result)');
  a.state = 'working';
  assert.equal(await a.interrupt(), true);
  assert.equal(n, 1);
  assert.equal(a.interrupted, true);
  const before = S.p.log.ofType('notice').length;
  await a.onMessage({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', modelUsage: {} }, { getContextUsage: async () => ({ percentage: 5 }) });
  assert.equal(S.p.log.ofType('notice').filter(e => /stopped: error during execution/.test(e.text)).length, 0, 'no "stopped" notice for the hub\'s own interrupt');
  assert.equal(a.lastTurn.error, false);
  assert.equal(a.interrupted, false);
  assert.equal(S.p.log.ofType('notice').length, before);
  // The same error result with no interrupt behind it is still reported.
  await a.onMessage({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', modelUsage: {} }, { getContextUsage: async () => ({ percentage: 5 }) });
  assert.equal(S.p.log.ofType('notice').filter(e => /stopped: error during execution/.test(e.text)).length, 1);
  // An interrupt that threw is not remembered.
  a.state = 'working'; a.q = { interrupt: async () => { throw new Error('gone'); } };
  assert.equal(await a.interrupt(), false);
  assert.equal(a.interrupted, false);
  // The flag is cleared only when the result comes in, never by a message sent in between (the result may still be on its way).
  a.q = { interrupt: async () => ({}) }; a.state = 'working';
  await a.interrupt();
  assert.equal(a.interrupted, true);
  realSend.call(a, 'carry on');   // the real send (recordAgents replaced the one on the prototype)
  assert.equal(a.interrupted, true, 'a send does not clear it');
  await a.onMessage({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', modelUsage: {} }, { getContextUsage: async () => ({ percentage: 5 }) });
  assert.equal(a.interrupted, false, 'the result clears it');
  assert.equal(a.lastTurn.error, false);
});

test('Agent.stopTasks stops the subagent tasks the hub counted that are still open', async () => {
  const S = setup();
  const stopped = [];
  S.lead.q = { stopTask: async id => { stopped.push(id); } };
  S.lead.onTask({ type: 'system', subtype: 'task_started', task_id: 't1', subagent_type: 'expedition-gatherer', task_type: 'local_agent' });
  S.lead.onTask({ type: 'system', subtype: 'task_started', task_id: 't2', subagent_type: 'expedition-gatherer', task_type: 'local_agent' });
  S.lead.onTask({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'stopped' });
  assert.equal(await S.lead.stopTasks(), 1);
  assert.deepEqual(stopped, ['t2']);
});

// ---------- review round 1 ----------
test('M2: after a hub stop no Verifier is offered or allowed, and the Lead\'s Agent tool is refused; after passed or no-progress a Verifier may still start', async () => {
  const verifier = { type: 'expedition-verifier', goal: 'Check the report', task: 'Check the numbers and claims in REPORT.md.' };
  for (const reason of ['time', 'budget', 'Matt']) {
    const S = setup();
    S.wd.stopNow(S.p, S.id, reason);
    await S.wd.settled();
    assert.throws(() => S.hub.leadStart(S.p, S.lead, verifier), new RegExp(`stopped by the hub \\(${reason}\\).*claims were not checked`), reason);
    const why = S.hub.expeditionToolBlock(S.p, S.lead, 'Agent');
    assert.match(why, new RegExp(`stopped by the hub \\(${reason}\\)`));
    assert.equal(S.hub.expeditionToolBlock(S.p, S.lead, 'Task') !== null, true);
    assert.equal(S.hub.expeditionToolBlock(S.p, S.lead, 'Bash'), null, 'only the Agent tool');
    assert.equal(S.hub.expeditionToolBlock(S.p, S.se.agents.builder, 'Agent'), null, 'only the Lead');
    // The PreToolUse hook the Lead runs with denies it, and leaves a gatherer's own calls and every other tool alone.
    const hook = S.lead.options().hooks.PreToolUse[0].hooks[0];
    const out = await hook({ tool_name: 'Agent', tool_use_id: 'tu1' });
    assert.deepEqual([out.hookSpecificOutput.hookEventName, out.hookSpecificOutput.permissionDecision], ['PreToolUse', 'deny']);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /no gatherer can be started now/);
    assert.deepEqual(await hook({ tool_name: 'Bash', tool_use_id: 'tu2' }), {});
    assert.deepEqual(await hook({ tool_name: 'Agent', tool_use_id: 'tu3', agent_id: 'g1', agent_type: 'expedition-gatherer' }), {});
  }
  for (const reason of ['passed', 'no-progress']) {
    const S = setup();
    S.ex.loop({ number: 1, passing: 1, progress: true });
    S.ex.stop({ reason, totals: {} });
    assert.ok(S.hub.leadStart(S.p, S.lead, verifier), `a Verifier may start after ${reason}`);
    assert.equal(S.hub.expeditionToolBlock(S.p, S.lead, 'Agent'), null, 'and the Agent tool is not refused');
  }
  // Before any stop the hook allows the Agent tool.
  const T = setup();
  assert.deepEqual(await T.lead.options().hooks.PreToolUse[0].hooks[0]({ tool_name: 'Agent', tool_use_id: 'x' }), {});
});

test('M3: no handoff once the expedition has stopped, whatever the reason, so the final turn cannot land on a Lead that is handing over', () => {
  for (const reason of ['passed', 'time']) {
    const S = setup();
    S.ex.loop({ number: 1, passing: 1, progress: true });
    S.ex.stop({ reason, totals: {} });
    S.lead.contextPct = 99;
    S.hub.onIdle(S.p, S.lead);
    assert.notEqual(S.lead.state, 'retired', reason);
    assert.equal(S.p.log.ofType('notice').filter(e => /handing/.test(e.text)).length, 0);
  }
});

test('M3: a Lead that is writing its handoff when the stop comes is waited for, and the final message goes to whoever holds the role afterwards', async () => {
  const S = setup();
  S.lead.retiring = 'writing';
  S.wd.stopNow(S.p, S.id, 'Matt');
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.equal(S.ex.state().finalNote, null, 'the final message is held back while the Lead is still writing its handoff');
  assert.equal(sent.filter(([, t]) => t.startsWith('[From the hub] The expedition has stopped')).length, 0);
  // The handoff is written: the successor exists, the predecessor answers it during the overlap.
  S.lead.retiring = 'overlap';
  const succ = S.hub.startWorker(S.p, 'exp-lead-2', 'Carry on.', 'hub', 'Lead', { type: 'expedition-lead', expedition: S.id, expeditionRole: 'lead' });
  succ.state = 'idle';
  await S.wd.settled();
  const finals = sent.filter(([, t]) => t.startsWith('[From the hub] The expedition has stopped'));
  assert.deepEqual(finals.map(([n]) => n), [succ.name], 'once, and to the successor');
  assert.equal(S.ex.state().finalNote.lead, succ.name);
});

test('M3: if the handoff never finishes, the 60 s fallback sends the final message to the Lead that is there', async () => {
  const S = setup();
  S.lead.retiring = 'writing';
  S.wd.stopNow(S.p, S.id, 'time');
  await new Promise(r => setImmediate(r));
  assert.ok(S.timers.pending(STOP_WAIT_MS));
  S.timers.fire(STOP_WAIT_MS);
  await S.wd.settled();
  assert.deepEqual(sent.filter(([, t]) => t.startsWith('[From the hub] The expedition has stopped')).map(([n]) => n), [S.lead.name]);
});

test('L7: a live hub makes its first watchdog check only after resumeAll, never from the constructor; a failing check is logged, not thrown', async () => {
  const order = [];
  const resume = Hub.prototype.resumeAll, check = ExpeditionWatchdog.prototype.safeCheck;
  Hub.prototype.resumeAll = function (...a) { order.push('resume'); return resume.apply(this, a); };
  ExpeditionWatchdog.prototype.safeCheck = function (...a) { order.push('check'); return check.apply(this, a); };
  try {
    const S = setup();
    order.length = 0;
    const hub = new Hub({ projects: [S.dir], memory: new Memory(join(S.root, 'home')), agentHome: join(S.root, 'agents-home'), noAgents: false, settings: new HubSettings({ file: null, initial: {} }) });
    assert.deepEqual(order, [], 'the constructor itself checks nothing');
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(order, ['resume', 'check'], 'resumeAll first, then the first check');
    hub.expeditionWatch.stop();
  } finally { Hub.prototype.resumeAll = resume; ExpeditionWatchdog.prototype.safeCheck = check; }
  // A check that throws is swallowed (and logged) so the hub carries on.
  const T = setup();
  T.wd.check = () => { throw new Error('boom'); };
  const warn = console.warn; let warned = '';
  console.warn = (...a) => { warned += a.join(' '); };
  try { assert.deepEqual(T.wd.safeCheck(), []); T.wd.start({ firstCheck: true }); } finally { console.warn = warn; }
  assert.match(warned, /Expedition watchdog: boom/);
});

test('a backgrounded gatherer that outlives the Lead\'s turn keeps its estimate across the Lead\'s result, until a result after it ended', () => {
  const S = setup({ envelope: { hours: 6, dollars: 1000 } });
  const t = S.wd.trackOf(S.p, S.id);
  const result = () => S.lead.onMessage({ type: 'result', subtype: 'success', is_error: false, modelUsage: {} }, { getContextUsage: async () => ({ percentage: 5 }) });
  S.lead.onTask({ type: 'system', subtype: 'task_started', task_id: 'g7', subagent_type: 'expedition-gatherer', task_type: 'local_agent' });
  S.lead.onMessage(assistant('lead1', { input_tokens: 5, output_tokens: 20 }), null);
  S.lead.onMessage(assistant('gat1', { input_tokens: 4, output_tokens: 30, cache_read_input_tokens: 2986, cache_creation_input_tokens: 837 }, { parent_tool_use_id: 'tu', agent_id: 'g7', message: { id: 'gat1', model: MODEL.haiku, usage: { input_tokens: 4, output_tokens: 30, cache_read_input_tokens: 2986, cache_creation_input_tokens: 837 }, content: [] } }), null);
  const gatherer = messageCost(MODEL.haiku, { input: 4, output: 30, cacheRead: 2986, cacheWrite: 837 }, 'low');
  // The Lead's turn ends while g7 is still running: the result's figure replaces the Lead's own estimate, not the gatherer's.
  S.se.usage('lead', { cost: 0.01 });
  result();
  assert.equal(t.inflight.get(S.lead.name).size, 1);
  assert.ok(t.inflight.get(S.lead.name).has('gat1'));
  assert.ok(Math.abs(S.wd.spendOf(S.p, S.id).spendUSD - (0.01 + gatherer)) < 1e-9, 'the result plus the running gatherer\'s estimate');
  // The gatherer ends, but no result has come since: the estimate stands (a result before it ended may not hold its spend).
  S.lead.onTask({ type: 'system', subtype: 'task_notification', task_id: 'g7', status: 'completed', usage: { total_tokens: 3867 } });
  assert.equal(t.inflight.get(S.lead.name).size, 1);
  // The first result after it ended covers it: the estimate goes.
  S.se.usage('lead', { cost: 0.02 });
  result();
  assert.equal(t.inflight.has(S.lead.name), false);
  assert.ok(Math.abs(S.wd.spendOf(S.p, S.id).spendUSD - 0.03) < 1e-9);
  // A late repeat of the gatherer's frame is not counted again.
  S.lead.onMessage(assistant('gat1', { input_tokens: 4 }, { parent_tool_use_id: 'tu', agent_id: 'g7' }), null);
  assert.equal(t.inflight.has(S.lead.name), false);
});

// ---------- the whole story ----------
test('the report\'s measured totals and the watchdog\'s estimate are both on the stop, and the report figure is only from results', async () => {
  const S = setup({ envelope: { hours: 6, dollars: 10 } });
  S.se.usage('lead', { cost: 1.25 });
  S.lead.onMessage(assistant('e1', { input_tokens: 10, output_tokens: 10 }), null);
  S.wd.stopNow(S.p, S.id, 'Matt', S.t0 + 3 * HOUR);
  await S.wd.settled();
  const totals = stoppedOf(S).totals;
  assert.equal(totals.costUSD, howItRan(S.p.log.events, S.id).totals.costUSD);
  assert.ok(totals.spendUSD > 1.25, 'results plus the estimate for the message since');
  assert.equal(totals.activeMs, 3 * HOUR);
});
