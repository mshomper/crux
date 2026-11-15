// Routing guide section 9: effort ceilings, type and outcome on usage, the raise log, the advisor notice and the
// Fable meter warning. Agents are stubbed; temp folders stand in for the home folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub, settingsDirection } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { EffortCeilings } from '../lib/agent-types.mjs';
import { FABLE_NOTE } from '../lib/usage.mjs';
import { normalizePlan, routingStats, usageKind } from '../public/usage.js';
import { panelHtml } from '../public/usage-ui.js';

Agent.prototype.send = function (t) { this.state = 'working'; };
Agent.prototype.close = function () { this.q = null; };

const REFUSED = "Effort level 'xhigh' is not supported for this model";
const ADVISOR = '---\nname: advisor\ndescription: one review\nmodel: fable\neffort: high\ntools: Read\n---\nBe brief.\n';

function setup() {
  const root = makeTmp('crux-hub-routing-');
  const home = join(root, 'home'), dir = join(root, 'proj');
  mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(dir, '.crux'), { recursive: true });
  writeFileSync(join(home, '.claude', 'agents', 'advisor.md'), ADVISOR);
  // file: null keeps settings in memory: a learned effort ceiling must never reach the real ~/.crux-hub/settings.json.
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'crux')), agentHome: home, settings: new HubSettings({ file: null }) });
  return { hub, p: hub.project('proj') };
}

// ---------- item 1: effort ceiling ----------
test('effort refusals are recognised by their words, and nothing else is', () => {
  for (const t of ["Effort level 'xhigh' is not supported for this model", 'The model does not support effort max', 'invalid effort: max', 'effort is unsupported by claude-sonnet-5-5'])
    assert.ok(EffortCeilings.isRefusal(t), t);
  for (const t of ['rate limit reached', 'Claude Code is not logged in', 'effort made the build pass', ''])
    assert.ok(!EffortCeilings.isRefusal(t), t);
});

test('a refusal teaches the ceiling: the model accepts only the levels below the refused one', () => {
  const saved = [];
  const c = new EffortCeilings({}, m => saved.push(m));
  assert.equal(c.clamp('m', 'max'), 'max', 'nothing known yet: the level stands');
  assert.equal(c.learn('m', 'xhigh', REFUSED), 'high');
  assert.deepEqual(c.list('m'), ['low', 'medium', 'high']);
  assert.equal(c.clamp('m', 'max'), 'high');
  assert.equal(c.clamp('m', 'medium'), 'medium');
  assert.equal(c.clamp('other', 'max'), 'max', 'kept per model');
  assert.equal(c.learn('m', 'high', REFUSED), 'medium', 'a later refusal lowers it again');
  assert.equal(c.learn('m', 'low', REFUSED), null, 'nothing below low');
  assert.equal(c.learn('n', 'xhigh'), null, 'no error text, no proof: nothing learned');
  assert.equal(c.list('n'), null);
  assert.equal(saved.length, 3, 'each lesson is handed on to be saved');
  assert.deepEqual(new EffortCeilings(saved[0]).list('m'), ['low', 'medium', 'high'], 'and reloads');
  const e = saved[0].m;
  assert.deepEqual([e.level, e.from, e.error], ['high', 'sdk-refusal', REFUSED], 'each entry carries its proof');
  assert.ok(Number.isFinite(Date.parse(e.learnedAt)));
});

test('a stored ceiling without the proof shape is ignored, and the next save drops it', () => {
  const real = { level: 'high', allowed: ['low', 'medium', 'high'], learnedAt: '2026-11-15T10:00:00Z', from: 'sdk-refusal', error: REFUSED };
  const saved = [];
  const c = new EffortCeilings({
    old: ['low', 'medium', 'high'],                                                   // the first format: a bare list
    noFrom: { level: 'high', allowed: ['low', 'medium', 'high'], learnedAt: real.learnedAt, error: REFUSED },
    noError: { ...real, error: '' },
    wrongSource: { ...real, from: 'guess' },
    badTime: { ...real, learnedAt: 'yesterday' },
    badLevels: { ...real, allowed: ['low', 'turbo'] },
    good: real
  }, m => saved.push(m));
  for (const k of ['old', 'noFrom', 'noError', 'wrongSource', 'badTime', 'badLevels']) assert.equal(c.list(k), null, k);
  assert.equal(c.clamp('old', 'max'), 'max', 'an ignored entry limits nothing');
  assert.deepEqual(c.list('good'), ['low', 'medium', 'high']);
  c.learn('other', 'max', REFUSED);
  assert.deepEqual(Object.keys(saved[0]).sort(), ['good', 'other'], 'what is saved holds only entries with proof');
});

test('a hub whose saved settings hold an old-shape ceiling ignores it', () => {
  const settings = new HubSettings({ file: null });
  settings.effortCeilings = { 'claude-sonnet-5-5': ['low', 'medium', 'high'] };
  const root = makeTmp('crux-hub-routing-old-');
  mkdirSync(join(root, 'proj', '.crux'), { recursive: true });
  const hub = new Hub({ projects: [join(root, 'proj')], memory: new Memory(join(root, 'crux')), agentHome: join(root, 'home'), settings });
  assert.equal(hub.effortCeilings.clamp('claude-sonnet-5-5', 'max'), 'max');
});

test('live switch: a refused level drops to the highest accepted, is remembered, and says so once', async () => {
  const { hub, p } = setup();
  const w = hub.startWorker(p, 'w', 'task', 'you', '', { model: 'sonnet', effort: 'medium' });
  const calls = [];
  w.q = { setModel: async () => {}, applyFlagSettings: async s => { calls.push(s.effortLevel); if (['xhigh', 'max'].includes(s.effortLevel)) throw new Error(`Effort level '${s.effortLevel}' is not supported for this model`); } };
  w.state = 'working';
  const r = await hub.setAgentSettings(p, 'w', { effort: 'xhigh' });
  assert.equal(r.when, 'now');
  assert.deepEqual(calls, ['xhigh', 'high'], 'refused, then the next level down');
  assert.equal(w.effort, 'high');
  assert.deepEqual(hub.effortCeilings.list('claude-sonnet-5-5'), ['low', 'medium', 'high']);
  const lines = p.log.ofType('notice').filter(n => n.thread === 'w' && /does not accept effort xhigh/.test(n.text));
  assert.equal(lines.length, 1);
  assert.ok(p.log.ofType('agent_settings').some(e => e.by === 'hub' && e.effort === 'high'));

  // Known now: max goes straight to high, with no call the model would refuse.
  calls.length = 0;
  await hub.setAgentSettings(p, 'w', { effort: 'medium' });
  await hub.setAgentSettings(p, 'w', { effort: 'max' }, 'you');
  assert.deepEqual(calls, ['medium', 'high']);
  assert.equal(w.effort, 'high');
});

test('live switch: an error that is not an effort refusal still fails the switch (restart fallback)', async () => {
  const { hub, p } = setup();
  const w = hub.startWorker(p, 'w', 'task', 'you', '', { model: 'sonnet', effort: 'low' });
  w.q = { setModel: async () => {}, applyFlagSettings: async () => { throw new Error('connection closed'); } };
  assert.equal(await w.applyLive({ effort: 'high' }), false);
  assert.equal(hub.effortCeilings.list('claude-sonnet-5-5'), null, 'nothing learned');
});

test('an error result that refuses the effort lowers it and starts the run again; others do not', async () => {
  const { hub, p } = setup();
  const w = hub.startWorker(p, 'w', 'task', 'you', '', { model: 'sonnet', effort: 'max' });
  let restarts = 0;
  w.restartAfterRefusal = () => { restarts++; };
  const q = w.q = { close() {}, getContextUsage: async () => ({ percentage: 5 }) };
  await w.onMessage({ type: 'result', is_error: true, subtype: 'error_during_execution', result: 'Invalid effort: max is not supported by this model' }, q);
  assert.equal(restarts, 1);
  assert.equal(w.effort, 'xhigh', 'one step down; the next refusal goes on down');
  await w.onMessage({ type: 'result', is_error: true, subtype: 'error_during_execution', result: 'Something else broke' }, q);
  assert.equal(restarts, 1);
  assert.equal(w.effort, 'xhigh');
  // A thrown error takes the same road.
  assert.equal(w.lowerForRefusal('effort xhigh is not supported'), 'high');
  assert.equal(new Agent(hub, p, { name: 'x', role: 'worker', effort: null }).lowerForRefusal('effort max is not supported'), null, 'no effort set: nothing to lower');
});

// ---------- item 4: type and outcome on usage ----------
test('a usage event carries the agent type, model and effort at the time', () => {
  const { hub, p } = setup();
  const w = hub.startWorker(p, 'w', 'task', 'you', '', { type: 'advisor' });
  w.sessionAtStart = null;
  w.logUsage({ modelUsage: { 'claude-fable-5-2': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.5 } } });
  const ev = p.log.ofType('usage').at(-1);
  assert.deepEqual([ev.agentType, ev.model, ev.effort], ['advisor', 'claude-fable-5-2', 'high']);
});

test('post_summary keeps outcome only when it is done, partial or blocked', () => {
  const { hub, p } = setup();
  const o = hub.ensureOrchestrator(p);
  const w = hub.startWorker(p, 'w', 'task');
  hub.postSummary(p, w, { done: ['x'], outcome: 'done' });
  assert.equal(p.log.ofType('summary').at(-1).outcome, 'done');
  hub.postSummary(p, w, { done: ['y'], outcome: 'great' });
  assert.ok(!('outcome' in p.log.ofType('summary').at(-1)));
  hub.postSummary(p, w, { done: ['z'] });
  assert.ok(!('outcome' in p.log.ofType('summary').at(-1)), 'optional');
  assert.ok(o.name);
});

const ev = (type, o = {}) => ({ type, ts: '2026-11-15T10:00:00Z', ...o });
const rows = [
  ['agent_created', { agent: 'a', role: 'worker', agentType: 'implementer' }],
  ['agent_created', { agent: 'b', role: 'worker', agentType: 'implementer' }],
  ['agent_created', { agent: 'adv', role: 'worker', agentType: 'advisor' }],
  ['usage', { agent: 'a', agentType: 'implementer', models: { m: { cost: 3 } } }],
  ['usage', { agent: 'adv', agentType: 'advisor', models: { m: { cost: 1 } } }],
  ['usage', { agent: 'orchestrator-1', models: { m: { cost: 6 } } }],
  ['summary', { from: 'a', outcome: 'done' }],
  ['summary', { from: 'b', outcome: 'done' }],
  ['summary', { from: 'orchestrator-1', outcome: 'done' }],
  ['raise', { agent: 'b', direction: 'raise' }],
  ['raise', { agent: 'b', direction: 'lower' }]
].map(([t, o]) => ({ project: 'proj', ev: ev(t, o) }));

test('routingStats: spend by type, tasks finished at their starting setting, raises, advisor calls', () => {
  const s = routingStats(rows, { since: 0, now: Date.parse('2026-11-16T10:00:00Z') });
  assert.deepEqual(s.types.map(t => [t.type, t.cost]), [['orchestrator', 6], ['implementer', 3], ['advisor', 1]]);
  assert.equal(s.tasks, 2, 'only workers\' done summaries count');
  assert.equal(s.unraised, 1, 'worker b was raised');
  assert.equal(s.share, 0.5);
  assert.deepEqual([s.raises, s.lowers, s.advisorWeek], [1, 1, 1]);
  assert.equal(routingStats(rows, { now: Date.parse('2026-11-30T00:00:00Z') }).advisorWeek, 0, 'a week, no longer');
  assert.equal(routingStats([], {}).share, null);
  assert.equal(usageKind({ agent: 'conductor-2' }), 'conductor');
});

test('the usage panel shows spend by type, the kept share and advisor calls this week', () => {
  const html = panelHtml({ plan: null, rows, bootAt: 0, range: 'session', now: Date.parse('2026-11-16T10:00:00Z') });
  assert.match(html, /By type/);
  assert.match(html, /Finished at starting setting[\s\S]*?50%/);
  assert.match(html, /Advisor calls this week[\s\S]*?<em>1<\/em>/);
});

// ---------- item 5: raise log ----------
test('settingsDirection: model decides, else effort (no effort counts as medium)', () => {
  assert.equal(settingsDirection({ model: 'claude-sonnet-5-5', effort: 'high' }, { model: 'claude-opus-5-5', effort: 'low' }), 'raise');
  assert.equal(settingsDirection({ model: 'claude-opus-5-5', effort: 'low' }, { model: 'claude-haiku-5-5', effort: 'max' }), 'lower');
  assert.equal(settingsDirection({ model: 'claude-sonnet-5-5', effort: null }, { model: 'claude-sonnet-5-5', effort: 'high' }), 'raise');
  assert.equal(settingsDirection({ model: 'claude-sonnet-5-5', effort: null }, { model: 'claude-sonnet-5-5', effort: 'medium' }), null);
});

test('an orchestrator\'s raise needs a reason and is logged as a raise; lowering logs too; the chip needs no reason', async () => {
  const { hub, p } = setup();
  const o = hub.ensureOrchestrator(p);
  hub.startWorker(p, 'w', 'task', 'you', '', { model: 'sonnet', effort: 'medium' });
  await assert.rejects(hub.setAgentSettings(p, 'w', { effort: 'high' }, o.name), /needs a one-line reason/);
  assert.equal(p.log.ofType('raise').length, 0, 'nothing changed, nothing logged');

  await hub.setAgentSettings(p, 'w', { model: 'opus', effort: 'high' }, o.name, 'tests failed twice at medium');
  const r = p.log.ofType('raise').at(-1);
  assert.equal(r.direction, 'raise');
  assert.deepEqual(r.from, { model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.deepEqual(r.to, { model: 'claude-opus-5-5', effort: 'high' });
  assert.equal(r.reason, 'tests failed twice at medium');
  assert.equal(r.by, o.name);
  assert.ok(p.log.ofType('notice').some(n => n.thread === 'orchestrator' && /\(a raise\) Reason: tests failed twice/.test(n.text)));

  await hub.setAgentSettings(p, 'w', { model: 'sonnet', effort: 'medium' }, o.name);   // lowering: reason optional
  assert.equal(p.log.ofType('raise').at(-1).direction, 'lower');
  assert.ok(!('reason' in p.log.ofType('raise').at(-1)));

  await hub.setAgentSettings(p, 'w', { effort: 'high' });   // Matt's chip: no reason needed, still logged
  const c = p.log.ofType('raise').at(-1);
  assert.deepEqual([c.by, c.direction], ['you', 'raise']);
  await hub.setAgentSettings(p, 'w', { type: 'advisor' }, 'you');   // a type change that moves the model counts
  assert.equal(p.log.ofType('raise').at(-1).to.model, 'claude-fable-5-2');
});

// ---------- item 6: advisor notice ----------
test('starting an advisor puts one line in the orchestrator\'s thread; other types do not', () => {
  const { hub, p } = setup();
  hub.ensureOrchestrator(p);
  const before = p.log.ofType('notice').length;
  hub.startWorker(p, 'plain', 'task');
  assert.equal(p.log.ofType('notice').length, before);
  hub.startWorker(p, 'adv-1', 'review it', 'orchestrator-1', 'plan review', { type: 'advisor' });
  const n = p.log.ofType('notice').slice(before);
  assert.equal(n.length, 1);
  assert.equal(n[0].thread, 'orchestrator');
  assert.match(n[0].text, /Advisor called: adv-1/);
});

// ---------- item 7: Fable meter warning ----------
const fablePlan = pct => normalizePlan({ rate_limits_available: true, rate_limits: { seven_day: { utilization: 10 }, model_scoped: [{ display_name: 'Fable', utilization: pct }] } });

test('the Fable meter turning amber tells each orchestrator once per spell, and a successor in the spell too', () => {
  const { hub, p } = setup();
  const o = hub.ensureOrchestrator(p);
  hub.usage.setPlan(fablePlan(40), p);
  assert.deepEqual(o.notes || [], [], 'below amber: nothing');
  hub.usage.setPlan(fablePlan(85), p);
  assert.deepEqual(o.notes, [FABLE_NOTE]);
  assert.match(FABLE_NOTE, /deep-reviewer/);
  assert.equal(p.log.ofType('fable_warning').length, 1);
  assert.ok(p.log.ofType('notice').some(n => n.thread === 'orchestrator' && /Fable weekly meter is amber/.test(n.text)));
  hub.usage.setPlan(fablePlan(90), p);
  hub.usage.rateLimit({ rateLimitType: 'seven_day_fable', status: 'allowed_warning' }, p);
  assert.equal(o.notes.length, 1, 'still amber: not again');
  assert.equal(p.log.ofType('fable_warning').length, 1);

  o.state = 'retired';
  const next = hub.createAgent(p, { role: 'orchestrator' });
  assert.deepEqual(next.notes, [FABLE_NOTE], 'a successor starting during the spell');

  hub.usage.rateLimit({ rateLimitType: 'seven_day_fable', status: 'allowed' }, p);
  hub.usage.setPlan(fablePlan(30), p);   // spell over
  hub.usage.setPlan(fablePlan(88), p);   // a new spell
  assert.equal(p.log.ofType('fable_warning').length, 2);
  assert.equal(next.notes.length, 2);
});

test('a red Fable meter counts as a warning too; a hub with no plan numbers does nothing', () => {
  const { hub, p } = setup();
  const o = hub.ensureOrchestrator(p);
  hub.usage.checkFable();
  assert.deepEqual(o.notes || [], []);
  hub.usage.statuses = { seven_day_fable: 'rejected' };
  hub.usage.setPlan(fablePlan(50), p);
  assert.equal(o.notes.length, 1);
});
