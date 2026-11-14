// Decision 36: usage accounting and the plan meters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { UsageLedger, baselineFor } from '../lib/usage.mjs';
import { totalsOf, diffTotals, aggregate, normalizePlan, readRateLimit, applyRateLimit, planChanged, meterTone, meterList, fmtTokens, fmtCost, fmtLeft } from '../public/usage.js';

// An SDK modelUsage entry (running totals).
const mu = (input, output, cost, extra = {}) => ({ inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: cost, contextWindow: 1e6, maxOutputTokens: 128000, ...extra });
const sumOf = events => events.reduce((s, e) => s + e.costUSD, 0);

// What the usage call really returned on Matt's Max plan (2026-11-11), cut down to the fields the hub reads.
const REAL_USAGE = {
  subscription_type: 'max', rate_limits_available: true,
  rate_limits: {
    five_hour: null,
    seven_day: { utilization: 53, resets_at: '2026-11-13T02:59:59.632032+00:00' },
    seven_day_opus: null, seven_day_sonnet: null,
    extra_usage: { is_enabled: true, monthly_limit: 25000, used_credits: 6282, utilization: 25.128, currency: 'USD' },
    model_scoped: [{ display_name: 'Fable', utilization: 20, resets_at: '2026-11-13T02:59:59.632190+00:00' }]
  }
};
const REAL_EVENT = { status: 'allowed', resetsAt: 1794538800, rateLimitType: 'seven_day', overageStatus: 'allowed', isUsingOverage: false, unifiedWindows: { seven_day: { utilization: 0.53, resetsAt: 1794538800, status: 'allowed' } } };

// ---------- delta accounting ----------
test('a result logs what it added, not the running total, so nothing is counted twice', () => {
  const ledger = new UsageLedger();
  const results = [{ 'claude-opus-5-5': mu(100, 10, 0.5) }, { 'claude-opus-5-5': mu(250, 30, 1.2) }, { 'claude-opus-5-5': mu(250, 30, 1.2) }, { 'claude-opus-5-5': mu(900, 70, 3.0) }];
  const out = results.map(r => ledger.record(r, { fresh: true }));
  assert.deepEqual(out.map(r => r.costUSD.toFixed(2)), ['0.50', '0.70', '0.00', '1.80']);
  assert.equal(sumOf(out).toFixed(6), '3.000000', 'the deltas add up to the last running total');
  assert.equal(out.reduce((s, r) => s + (r.delta['claude-opus-5-5']?.output || 0), 0), 70);
  assert.deepEqual(out[2].delta, {}, 'a result that added nothing logs no models');
  // The old way (adding total_cost_usd per result) would have said 0.5 + 1.2 + 1.2 + 3.0 = 5.9
  assert.notEqual(results.reduce((s, r) => s + r['claude-opus-5-5'].costUSD, 0).toFixed(1), '3.0');
});

test('per-model deltas: a second model that appears mid-run starts from zero', () => {
  const ledger = new UsageLedger();
  ledger.record({ opus: mu(100, 10, 0.5) }, { fresh: true });
  const r = ledger.record({ opus: mu(100, 10, 0.5), haiku: mu(40, 4, 0.01) }, { fresh: true });
  assert.deepEqual(Object.keys(r.delta), ['haiku']);
  assert.equal(r.delta.haiku.input, 40);
});

test('a resumed session: the first result is measured against what the log last saw, not counted whole', () => {
  const before = totalsOf({ opus: mu(1000, 100, 5) });
  const ledger = new UsageLedger();
  const r = ledger.record({ opus: mu(1200, 130, 5.6) }, { baseline: before });
  assert.equal(r.costUSD.toFixed(2), '0.60');
  assert.equal(r.delta.opus.input, 200);
  // with nothing logged for it, the first result only sets the starting line
  const l2 = new UsageLedger();
  const first = l2.record({ opus: mu(1200, 130, 5.6) });
  assert.deepEqual(first.delta, {});
  assert.equal(first.baseline, true);
  assert.equal(l2.record({ opus: mu(1300, 140, 5.9) }).costUSD.toFixed(2), '0.30');
});

test('totals that go down (a /clear, or a session that did not carry its totals) count as new', () => {
  const ledger = new UsageLedger();
  ledger.record({ opus: mu(1000, 100, 5) }, { fresh: true });
  const r = ledger.record({ opus: mu(50, 5, 0.2) }, { fresh: true });
  assert.equal(r.reset, true);
  assert.equal(r.costUSD.toFixed(2), '0.20');
  assert.equal(diffTotals({}, {}).reset, false);
});

test('cache tokens are counted apart from input and output', () => {
  const cur = totalsOf({ opus: mu(10, 5, 0.1, { cacheReadInputTokens: 900, cacheCreationInputTokens: 300 }) });
  assert.deepEqual(cur.opus, { input: 10, output: 5, cacheRead: 900, cacheCreation: 300, cost: 0.1 });
});

// ---------- the event, through a real hub ----------
Agent.prototype.start = function () { this.beginRun(); this.q = { close() { } }; this.inbox = { push() { } }; };
function hubWith(...names) {
  const root = makeTmp('crux-usage-');
  const dirs = names.map(n => { const d = join(root, n); mkdirSync(join(d, '.crux'), { recursive: true }); return d; });
  const hub = new Hub({ projects: dirs, memory: new Memory(join(root, 'home')), noAgents: true });
  return { hub, root };
}

test('a usage event per result: agent, project, per-model deltas, the cost and the totals to resume from', () => {
  const { hub } = hubWith('proj');
  const p = hub.project('proj');
  const w = hub.createAgent(p, { name: 'w1', role: 'worker' });
  w.start();
  w.sessionId = 's-1';   // the session's init message names it after the query starts
  w.logUsage({ modelUsage: { 'claude-opus-5-5': mu(100, 10, 0.5), 'claude-haiku-5-5': mu(20, 2, 0.01) } });
  w.logUsage({ modelUsage: { 'claude-opus-5-5': mu(100, 10, 0.5), 'claude-haiku-5-5': mu(20, 2, 0.01) } });   // nothing new
  w.logUsage({ modelUsage: { 'claude-opus-5-5': mu(160, 25, 0.9), 'claude-haiku-5-5': mu(20, 2, 0.01) } });
  const evs = p.log.ofType('usage');
  assert.equal(evs.length, 2, 'a result that added nothing is not logged');
  const [a, b] = evs;
  assert.equal(a.agent, 'w1'); assert.equal(a.project, 'proj'); assert.equal(a.sessionId, 's-1');
  assert.deepEqual(Object.keys(a.models).sort(), ['claude-haiku-5-5', 'claude-opus-5-5']);
  assert.deepEqual(a.models['claude-opus-5-5'], { cost: 0.5, input: 100, output: 10, cacheRead: 0, cacheCreation: 0 });
  assert.equal(a.costUSD.toFixed(2), '0.51');
  assert.deepEqual(Object.keys(b.models), ['claude-opus-5-5'], 'only the model that grew');
  assert.equal(b.models['claude-opus-5-5'].output, 15);
  assert.equal(b.totals['claude-opus-5-5'].output, 25, 'the running totals ride along, to measure a resumed session against');
  assert.equal(b.thread, undefined, 'no thread, so it never shows as an unread message');
  assert.equal(w.cost.toFixed(2), '0.91', 'agent.cost is the sum of the deltas');
  // a restart: a new Agent object for the same session picks up from the log
  const w2 = new Agent(hub, p, { name: 'w1', role: 'worker', sessionId: 's-1' });
  w2.start();
  w2.logUsage({ modelUsage: { 'claude-opus-5-5': mu(200, 30, 1.1), 'claude-haiku-5-5': mu(20, 2, 0.01) } });
  const last = p.log.ofType('usage').at(-1);
  assert.equal(last.models['claude-opus-5-5'].output, 5, 'measured against the last event of that session');
  assert.equal(baselineFor(p.log, 'w1', 's-1')['claude-opus-5-5'].output, 30);
  assert.equal(baselineFor(p.log, 'w1', null), null);
});

test('a resumed agent with no usage in the log logs a zero baseline, so its old turns are not counted as new', () => {
  const { hub } = hubWith('proj');
  const p = hub.project('proj');
  const w = new Agent(hub, p, { name: 'old', role: 'worker', sessionId: 'older-session' });
  w.start();
  w.logUsage({ modelUsage: { 'claude-opus-5-5': mu(5000, 400, 9) } });
  const [e] = p.log.ofType('usage');
  assert.equal(e.baseline, true);
  assert.equal(e.costUSD, 0);
  w.logUsage({ modelUsage: { 'claude-opus-5-5': mu(5100, 420, 9.2) } });
  assert.equal(p.log.ofType('usage').at(-1).costUSD.toFixed(2), '0.20');
});

test('totals by model and by agent, today and since the hub started', () => {
  const day = '2026-11-11T10:00:00.000Z', old = '2026-11-10T10:00:00.000Z';
  const ev = (ts, agent, models) => ({ project: 'p', ev: { type: 'usage', ts, agent, models } });
  const d = (cost, input = 0, output = 0) => ({ cost, input, output, cacheRead: 0, cacheCreation: 0 });
  const rows = [ev(old, 'a', { 'claude-opus-5-5': d(5, 100, 10) }), ev(day, 'a', { 'claude-opus-5-5': d(1, 10, 1), 'claude-fable-5-2': d(3, 30, 3) }), ev(day, 'b', { 'claude-sonnet-5-5': d(2, 20, 2) })];
  const today = aggregate(rows, { since: Date.parse('2026-11-11T00:00:00Z') });
  assert.equal(today.total.cost, 6);
  assert.deepEqual(today.models.map(m => m.id), ['claude-fable-5-2', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.deepEqual(today.agents.map(a => [a.agent, a.cost]), [['a', 4], ['b', 2]]);
  assert.equal(today.agents[0].model, 'claude-fable-5-2', 'an agent is shown with the model it spent most on');
  assert.equal(today.fable.share.toFixed(3), '0.500');
  assert.equal(aggregate(rows, { since: 0 }).total.cost, 11);
});

// ---------- plan windows ----------
test('the real usage answer: Fable is in model_scoped, an idle 5-hour window shows as idle', () => {
  const plan = normalizePlan(REAL_USAGE, '2026-11-11T20:00:00Z');
  assert.equal(plan.windows.five_hour, null);
  assert.equal(plan.windows.seven_day.pct, 53);
  assert.deepEqual(plan.models.map(m => [m.label, m.key, m.pct]), [['Fable', 'fable', 20]]);
  assert.equal(plan.extra.pct, 25.1);
  assert.equal(plan.subscription, 'max');
  const list = meterList(plan);
  assert.deepEqual(list.map(m => [m.key, m.idle]), [['five_hour', true], ['seven_day', false], ['fable', false]]);
});

test('no plan limits (an API key, or nothing usable): no plan, so the meters hide', () => {
  assert.equal(normalizePlan(null), null);
  assert.equal(normalizePlan({ rate_limits_available: false, rate_limits: null }), null);
  assert.equal(normalizePlan({ rate_limits_available: true, rate_limits: { five_hour: null, seven_day: null } }), null);
  assert.deepEqual(meterList(null), []);
});

test('a streamed rate_limit_event: status per window, and utilization as a fraction of 1', () => {
  const read = readRateLimit(REAL_EVENT);
  assert.equal(read.statuses.seven_day, 'allowed');
  assert.equal(read.windows.seven_day.pct, 53);
  assert.equal(read.windows.seven_day.resetsAt, new Date(1794538800 * 1000).toISOString(), 'seconds since 1970 become a time');
  const plan = normalizePlan(REAL_USAGE, 'a');
  const next = applyRateLimit(plan, readRateLimit({ status: 'allowed_warning', rateLimitType: 'seven_day', unifiedWindows: { seven_day: { utilization: 0.81, resetsAt: 1794538800, status: 'allowed_warning' } } }));
  assert.equal(next.windows.seven_day.pct, 81);
  assert.equal(meterList(next).find(m => m.key === 'seven_day').tone, 'amber');
  assert.equal(plan.windows.seven_day.pct, 53, 'the old snapshot is not changed');
  assert.equal(readRateLimit(null), null);
});

// ---------- colours (decision 31) ----------
test('amber at allowed_warning or 80 percent and up, red only when rejected', () => {
  assert.equal(meterTone(0), 'ok');
  assert.equal(meterTone(79.9), 'ok');
  assert.equal(meterTone(80), 'amber');
  assert.equal(meterTone(99), 'amber');
  assert.equal(meterTone(100), 'amber', 'full, but not yet refused: still a warning');
  assert.equal(meterTone(10, 'allowed_warning'), 'amber');
  assert.equal(meterTone(10, 'rejected'), 'red');
  assert.equal(meterTone(95, 'rejected'), 'red');
  assert.equal(meterTone(50, 'allowed'), 'ok');
  const plan = normalizePlan(REAL_USAGE, 'a');
  plan.statuses = { seven_day: 'rejected' };
  const tones = Object.fromEntries(meterList(plan).map(m => [m.key, m.tone]));
  assert.deepEqual(tones, { five_hour: 'ok', seven_day: 'red', fable: 'ok' });
});

test('a snapshot is worth logging only when it changes meaningfully', () => {
  const a = normalizePlan(REAL_USAGE, 'a');
  const b = JSON.parse(JSON.stringify(a));
  assert.equal(planChanged(a, b), false);
  b.windows.seven_day.pct = 54.2;
  assert.equal(planChanged(a, b), false, 'under two points');
  b.windows.seven_day.pct = 56;
  assert.equal(planChanged(a, b), true);
  const c = JSON.parse(JSON.stringify(a)); c.statuses = { seven_day: 'allowed_warning' };
  assert.equal(planChanged(a, c), true, 'a status change');
  const d = JSON.parse(JSON.stringify(a)); d.windows.seven_day.resetsAt = '2026-11-20T00:00:00Z';
  assert.equal(planChanged(a, d), true, 'a new window');
  const e = JSON.parse(JSON.stringify(a)); e.windows.five_hour = { key: 'five_hour', label: '5-hour', pct: 3, resetsAt: 'x' };
  assert.equal(planChanged(a, e), true, 'a window appears');
  assert.equal(planChanged(null, a), true);
  assert.equal(planChanged(null, null), false);
});

test('words: tokens, cost and time left', () => {
  assert.deepEqual([fmtTokens(0), fmtTokens(845), fmtTokens(1234), fmtTokens(48000), fmtTokens(1_200_000), fmtTokens(15_300_000)], ['0', '845', '1.2k', '48k', '1.2M', '15M']);
  assert.deepEqual([fmtCost(0), fmtCost(0.004), fmtCost(1.5), fmtCost(123.4)], ['$0.00', '<$0.01', '$1.50', '$123']);
  const now = Date.parse('2026-11-11T12:00:00Z');
  assert.deepEqual(['2026-11-11T12:00:20Z', '2026-11-11T12:42:00Z', '2026-11-11T15:10:00Z', '2026-11-13T16:00:00Z', 'bad'].map(t => fmtLeft(t, now)), ['now', '42m', '3h 10m', '2d 4h', '']);
});

// ---------- the poller ----------
function fakeAgent(p, hub, name, answer) {
  const a = hub.createAgent(p, { name, role: 'worker' });
  a.state = 'idle';
  a.start();
  a.q = { close() { }, calls: 0, usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts) { this.calls++; this.opts = opts; return Promise.resolve().then(() => (typeof answer === 'function' ? answer() : answer)); } };
  return a;
}

test('the poller asks a live agent with skipBehaviors, keeps the snapshot and logs it once', async () => {
  const { hub } = hubWith('proj');
  const p = hub.project('proj');
  const heard = []; hub.on(e => e.type === 'plan_usage' && !e.logged && heard.push(e));
  const a = fakeAgent(p, hub, 'w1', REAL_USAGE);
  const plan = await hub.usage.poll();
  assert.deepEqual(a.q.opts, { skipBehaviors: true });
  assert.equal(plan.windows.seven_day.pct, 53);
  assert.equal(hub.usage.view().available, true);
  assert.equal(p.log.ofType('plan_usage').length, 1);
  assert.equal(heard.at(-1).plan.models[0].label, 'Fable', 'the page hears it');
  await hub.usage.poll();
  assert.equal(p.log.ofType('plan_usage').length, 1, 'nothing changed, nothing logged');
  assert.equal(a.q.calls, 2);
  // a real change is logged
  a.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = () => Promise.resolve({ ...REAL_USAGE, rate_limits: { ...REAL_USAGE.rate_limits, seven_day: { utilization: 61, resets_at: REAL_USAGE.rate_limits.seven_day.resets_at } } });
  await hub.usage.poll();
  assert.equal(p.log.ofType('plan_usage').length, 2);
  assert.equal(hub.usage.plan.windows.seven_day.pct, 61);
});

test('poller fallback: a throw or a null hides the meters with one notice, and recovers by itself', async () => {
  const { hub } = hubWith('proj');
  const p = hub.project('proj');
  let answer = () => { throw new Error('usage is not supported'); };
  fakeAgent(p, hub, 'w1', () => answer());
  assert.equal(await hub.usage.poll(), null);
  assert.equal(hub.usage.view().plan, null);
  assert.equal(hub.usage.view().available, false);
  const notices = () => p.log.ofType('notice').filter(n => /Plan usage is not available/.test(n.text));
  assert.equal(notices().length, 1);
  assert.match(notices()[0].text, /usage is not supported/);
  answer = () => ({ rate_limits_available: false, rate_limits: null });   // an API-key login: null
  await hub.usage.poll();
  await hub.usage.poll();
  assert.equal(notices().length, 1, 'still one notice, however many polls fail');
  assert.equal(hub.usage.view().plan, null);
  answer = () => REAL_USAGE;
  await hub.usage.poll();
  assert.equal(hub.usage.view().available, true);
  assert.ok(hub.usage.view().plan);
  answer = () => { throw new Error('again'); };
  await hub.usage.poll();
  assert.equal(notices().length, 2, 'a new failure after it worked is worth one more notice');
});

test('the poller tries another live agent when one fails, and does nothing with none live', async () => {
  const { hub } = hubWith('proj');
  const p = hub.project('proj');
  assert.equal(await hub.usage.poll(), null, 'no live agent: nothing asked, nothing hidden');
  assert.equal(hub.usage.view().available, null);
  assert.equal(p.log.ofType('notice').length, 0);
  fakeAgent(p, hub, 'bad', () => { throw new Error('closed'); });
  fakeAgent(p, hub, 'good', REAL_USAGE);
  const plan = await hub.usage.poll();
  assert.ok(plan, 'the second agent answered');
  assert.equal(hub.usage.view().available, true);
});

test('rate_limit_event: status colours the meters at once and a changed percent is logged', async () => {
  const { hub } = hubWith('proj');
  const p = hub.project('proj');
  fakeAgent(p, hub, 'w1', REAL_USAGE);
  await hub.usage.poll();
  hub.usage.rateLimit({ status: 'rejected', rateLimitType: 'seven_day', unifiedWindows: { seven_day: { utilization: 1, resetsAt: 1794538800, status: 'rejected' } } }, p);
  const m = meterList(hub.usage.view().plan).find(x => x.key === 'seven_day');
  assert.equal(m.tone, 'red');
  assert.equal(m.pct, 100);
  assert.equal(p.log.ofType('plan_usage').length, 2, 'the jump from 53 to 100 and the rejection are logged');
  hub.usage.rateLimit({ status: 'allowed', rateLimitType: 'seven_day', unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: 1794538800, status: 'allowed' } } }, p);
  assert.equal(meterList(hub.usage.view().plan).find(x => x.key === 'seven_day').tone, 'ok');
});

test('after a restart the last logged snapshot is back, so the meters are not blank until the first poll', async () => {
  const { hub, root } = hubWith('proj');
  const p = hub.project('proj');
  fakeAgent(p, hub, 'w1', REAL_USAGE);
  await hub.usage.poll();
  const again = new Hub({ projects: [p.dir], memory: new Memory(join(root, 'home')), noAgents: true });
  assert.equal(again.usage.view().plan.windows.seven_day.pct, 53);
  assert.equal(again.usage.view().available, true);
});
