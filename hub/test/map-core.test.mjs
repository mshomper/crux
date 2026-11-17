// The live map's core (decision 76): how the orchestrator's state becomes what the swarm shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { coreLook, litRadius, coreBudget, SwarmCore, SPARK_COLOR, swarmSeeds, swarmPoint } from '../public/map-core.js';
import { STRIDE, COLORS, TONE } from '../public/map-particles.js';
import { MapModel } from '../public/map-model.js';
import { coreReadout } from '../public/map-readout.js';
import { MODEL_HUES, rgb01 } from '../public/models.js';

const OPUS = 'claude-opus-5-5';
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('context used fills the sphere; the handoff threshold is a full sphere', () => {
  assert.equal(coreLook({ ctx: 0 }).fill, 0);
  assert.ok(near(coreLook({ ctx: 30, retireAt: 60 }).fill, 0.5), '30% of a 60% threshold is half full');
  assert.equal(coreLook({ ctx: 60, retireAt: 60 }).fill, 1);
  assert.equal(coreLook({ ctx: 75, retireAt: 60 }).fill, 1, 'past the threshold it stays full');
  assert.ok(near(coreLook({ ctx: 30, retireAt: 40 }).fill, 0.75), 'the threshold is the hub setting, not a fixed 60');
  assert.equal(coreLook({ ctx: null }).fill, 0, 'no measurement yet: empty');
  assert.equal(coreLook({ state: 'vacant', ctx: 50 }).fill, 0, 'no holder: empty');
});

test('gold arrives over the last fifth before the threshold, and the pulse at it', () => {
  assert.equal(coreLook({ ctx: 30 }).heat, 0);
  assert.equal(coreLook({ ctx: 48 }).heat, 0, '80% of the way to 60 is where the shift starts');
  const h54 = coreLook({ ctx: 54 }).heat, h58 = coreLook({ ctx: 58 }).heat;
  assert.ok(h54 > 0.3 && h54 < 0.7 && h58 > 0.85 && h58 < 1, `heat rises smoothly (${h54}, ${h58})`);
  assert.equal(coreLook({ ctx: 60 }).heat, 1);
  assert.equal(coreLook({ ctx: 59 }).due, 0);
  assert.equal(coreLook({ ctx: 60 }).due, 1, 'handoff due: the gold pulse');
  assert.equal(coreLook({ state: 'writing', ctx: 61 }).gold, 1, 'writing the handoff: all gold');
  assert.equal(coreLook({ state: 'working', ctx: 61 }).gold, 0);
});

test('the hue follows the model (decision 20)', () => {
  for (const [id, fam] of [[OPUS, 'opus'], ['claude-sonnet-5-5', 'sonnet'], ['claude-haiku-5-5', 'haiku'], ['claude-fable-5-2', 'fable']])
    assert.deepEqual(coreLook({ model: id }).hue, rgb01(MODEL_HUES[fam]), fam);
  assert.deepEqual(coreLook({ model: null }).hue, COLORS.cyan, 'unknown model: the HUD cyan');
});

test('effort raises energy and speed; working swirls, idle drifts', () => {
  const e = ['low', 'medium', 'high', 'xhigh', 'max'].map(effort => coreLook({ state: 'working', effort }));
  for (let i = 1; i < e.length; i++) assert.ok(e[i].energy > e[i - 1].energy && e[i].speed > e[i - 1].speed, 'each effort step is livelier');
  const idle = coreLook({ state: 'idle', effort: 'high' }), work = coreLook({ state: 'working', effort: 'high' }), asleep = coreLook({ state: 'asleep', effort: 'high' });
  assert.ok(work.swirl > idle.swirl && idle.swirl > asleep.swirl);
  assert.ok(work.speed > idle.speed && idle.speed > asleep.speed);
  assert.equal(coreLook({ effort: null }).energy, 0.5, 'default effort sits in the middle');
});

test('waiting on Matt, Auto or Ask, and an error', () => {
  assert.equal(coreLook({ needs: true }).flare, 1);
  assert.equal(coreLook({ needs: false }).flare, 0);
  assert.equal(coreLook({ mode: 'ask' }).ask, 1);
  assert.equal(coreLook({ mode: 'auto' }).ask, 0);
  assert.equal(coreLook({ state: 'error' }).fault, 1, 'an error is amber and still, never red (decision 31)');
  assert.equal(coreLook({ state: 'error' }).flare, 0);
  assert.deepEqual([SPARK_COLOR.allowed, SPARK_COLOR.denied, SPARK_COLOR.escalated], [COLORS.good, COLORS.amber, COLORS.red], 'spark colours: green allowed, amber denied, red sent to Matt');
});

test('the bright core grows with context: nothing lit when empty, the whole sphere at the handoff', () => {
  assert.equal(litRadius(0), 0);
  assert.ok(near(litRadius(1), 0.97), 'full: the whole swarm (it fills 0.97 of the glass)');
  assert.ok(near(litRadius(0.3), 0.97 * 0.3 ** 0.75), '30% of the way: 0.39 of the radius');
  let last = -1;
  for (let f = 0; f <= 1.0001; f += 0.05) { const r = litRadius(f); assert.ok(r > last, 'grows with context'); last = r; }
  assert.ok(litRadius(1, 1) < litRadius(1, 0), 'a little tighter in the last fifth');
});

test('budgets: 60k open and 30k strip on a desktop, about 10k on a phone (Matt, 2026-11-17)', () => {
  const d = coreBudget(false), p = coreBudget(true);
  assert.deepEqual([d.open, d.strip], [60000, 30000]);
  assert.ok(p.open >= 8000 && p.open <= 12000 && p.strip <= p.open, `phone ${p.open} / ${p.strip}`);
});

// Run a core for a while and collect what it draws on the CPU (flare, motes, sparks), plus the swarm's uniforms.
function run(info, { seconds = 3, light = false, before, r = 50 } = {}) {
  const core = new SwarmCore({ light });
  core.setMood(info); core.settle();
  before?.(core);
  for (let i = 0; i < seconds * 60; i++) core.step(1 / 60);
  const out = new Float32Array((core.capacity + 8) * STRIDE);
  const n = core.project(100, 100, r, out, 0);
  return { core, out, n, swarm: core.swarm() };
}
// The swarm as the GPU draws it, through the same maths in JS: n particles, with each one's radius and how lit it is.
function swarmOf(core, n = 4000) {
  const S = swarmSeeds(n), { u } = core.swarm(), out = new Float32Array(n * STRIDE), info = {}, pts = [];
  for (let i = 0; i < n; i++) { swarmPoint(S, i, u, out, i * STRIDE, info); pts.push({ ...info }); }
  return { out, n, pts };
}
const count = ({ out, n }, pred) => { let c = 0; for (let i = 0; i < n; i++) { const k = i * STRIDE; if (pred(out[k + 3], out[k + 4], out[k + 5], out[k + 6], out[k], out[k + 1])) c++; } return c; };
const isRed = (r, g, b, a) => a > 0.05 && r > 0.9 && g < 0.6 && b < 0.6;
const isGold = (r, g, b, a) => a > 0.05 && r > 0.9 && g > 0.7 && b < 0.62;
const isGreen = (r, g, b, a) => a > 0.05 && g > r + 0.2 && g > b;

test('the CPU particles stay inside their budget and everything drawn is finite', () => {
  for (const light of [false, true]) {
    const r = run({ state: 'working', ctx: 30, model: OPUS, effort: 'max', needs: true, mode: 'ask' }, { light, before: c => { c.spark('allowed', 0); c.spark('escalated', 2); c.handoff(); } });
    assert.ok(r.n <= r.core.capacity - r.core.budget.fallback, `${r.n} particles within ${r.core.capacity}`);
    for (let i = 0; i < r.n * STRIDE; i++) assert.ok(Number.isFinite(r.out[i]), 'finite');
    for (const [k, v] of Object.entries(r.swarm.u)) for (const x of [v].flat()) assert.ok(Number.isFinite(x), `uniform ${k} finite`);
    const s = swarmOf(r.core, 3000);
    for (let i = 0; i < s.n * STRIDE; i++) assert.ok(Number.isFinite(s.out[i]), 'swarm finite');
  }
});

test('the swarm fills the whole sphere at any context; context is how much of it is lit', () => {
  for (const ctx of [0, 18, 36, 51]) {
    const { pts } = swarmOf(run({ state: 'idle', ctx, model: OPUS }).core);
    const outer = pts.filter(p => p.rr > 0.6).length / pts.length;
    assert.ok(outer > 0.65, `the outer shell is full at ${ctx}% (${outer.toFixed(2)})`);   // (0.97^3 - 0.6^3) / 0.97^3 = 0.76
    assert.ok(pts.every(p => p.rr < 1.0), 'nothing outside the glass when calm');
  }
  // the share of particles inside the lit radius follows its volume: fill^2.25 (the nucleus adds about 5%)
  for (const [ctx, fill] of [[18, 0.3], [36, 0.6], [51, 0.85]]) {
    const { pts } = swarmOf(run({ state: 'idle', ctx, model: OPUS }).core), want = fill ** 2.25;
    const lit = pts.filter(p => !p.nuc && p.lit > 0.5).length / pts.filter(p => !p.nuc).length;
    assert.ok(Math.abs(lit - want) < 0.06, `${ctx}% context: ${lit.toFixed(3)} lit, expected about ${want.toFixed(3)}`);
  }
  const none = swarmOf(run({ state: 'idle', ctx: 0, model: OPUS }).core).pts.filter(p => p.lit > 0).length;
  assert.equal(none, 0, 'no context: nothing lit but the nucleus');
  const full = swarmOf(run({ state: 'idle', ctx: 61, model: OPUS }).core).pts;
  assert.ok(full.filter(p => p.lit > 0.5).length / full.length > 0.95, 'handoff due: the whole sphere lit');
});

test('what the particles show: gold near the handoff, red only when Matt is needed', () => {
  const gold = ctx => count(swarmOf(run({ state: 'working', ctx, model: OPUS }).core), isGold);
  assert.equal(gold(30), 0, 'no gold at half way');
  assert.ok(gold(58) > 300, 'gold near the threshold');
  assert.equal(count(swarmOf(run({ state: 'working', ctx: 58, model: OPUS }).core), isRed), 0, 'near the handoff is gold, not red');
  assert.ok(count(run({ state: 'idle', ctx: 30, model: OPUS, needs: true }), isRed) > 40, 'the red flare when something waits on Matt');
  assert.equal(count(run({ state: 'error', ctx: 30, model: OPUS }), isRed), 0, 'an error is not red');
  assert.equal(count(swarmOf(run({ state: 'error', ctx: 30, model: OPUS }).core), isRed), 0, 'nor is its swarm');
});

test('working turns the swarm faster and gives it arms', () => {
  const idle = run({ state: 'idle', ctx: 30, model: OPUS, effort: 'high' }), work = run({ state: 'working', ctx: 30, model: OPUS, effort: 'high' });
  assert.ok(work.swarm.u.uRot > idle.swarm.u.uRot * 2, 'faster');
  assert.ok(work.swarm.u.uSwirl === 1 && idle.swarm.u.uSwirl < 0.2, 'the vortex arms come with work');
});

test('a permission answer throws sparks that burn out', () => {
  const lit = run({ state: 'working', ctx: 30, model: OPUS }, { seconds: 0.1, before: c => c.spark('allowed', 0) });
  assert.ok(lit.core.nsp > 40 && count(lit, isGreen) > 20, 'a green burst');
  assert.ok(lit.core.lx < 0, 'the swarm recoils from the strike');
  const sent = run({ state: 'working', ctx: 30, model: OPUS }, { seconds: 0.1, before: c => c.spark('escalated', 0) });
  assert.ok(count(sent, isRed) > 20, 'red when it went to Matt');
  assert.equal(run({ state: 'working', ctx: 30, model: OPUS }, { seconds: 3, before: c => c.spark('allowed', 0) }).core.nsp, 0, 'all gone after three seconds');
});

test('a handoff throws the swarm out and it settles back; the due pulse swells it', () => {
  const thrown = run({ state: 'idle', ctx: 30, model: OPUS }, { seconds: 0.15, before: c => c.handoff() });
  assert.ok(thrown.core.kick > 0.1, `thrown out (${thrown.core.kick})`);
  assert.ok(Math.abs(run({ state: 'idle', ctx: 30, model: OPUS }, { seconds: 4, before: c => c.handoff() }).core.kick) < 0.01, 'settled after four seconds');
  assert.equal(run({ state: 'idle', ctx: 30, model: OPUS }, { seconds: 4 }).core.kick, 0, 'calm when nothing happens');
  assert.equal(run({ state: 'idle', ctx: 61, model: OPUS }, { seconds: 4 }).swarm.u.uDue, 1, 'the gold pulse runs while due');
});

test('the count follows the core size, and the frame-time probe scales it down and back up to the budget', () => {
  const c = new SwarmCore();
  c.setMood({ state: 'working', ctx: 30 });
  const at = r => { c.project(0, 0, r, new Float32Array(c.capacity * STRIDE), 0); return c.swarm().count; };
  assert.equal(at(104), 60000, 'open map');
  assert.equal(at(31), 30000, 'strip');
  assert.equal(at(200), 60000, 'never above the budget');
  // the glow per pixel stays the same: particles brighten as the count drops
  const dOpen = (at(104), c.swarm().u.uDens), dStrip = (at(31), c.swarm().u.uDens);
  assert.ok(near(dOpen, 1, 1e-9) && dStrip > 0.5 && dStrip < 2, `${dOpen}, ${dStrip}`);
  for (let i = 0; i < 60 * 4; i++) c.step(1 / 60);
  assert.equal(c.q, 1, 'steady 60 fps keeps the full budget');
  for (let i = 0; i < 165 * 4; i++) c.step(1 / 165);
  assert.equal(c.q, 1, 'a 165 Hz screen too');
});

test('the probe: a 30 Hz screen is not slow; a GPU that the particles hold back sheds them and gets them back', () => {
  // known answer (review of #134): 120 s of 1/30 frames with 1% at 1/60 must leave the full budget
  const screen30 = new SwarmCore();
  screen30.setMood({ state: 'working', ctx: 30 });
  for (let i = 0; i < 30 * 120; i++) screen30.step(i % 100 === 0 ? 1 / 60 : 1 / 30);
  assert.equal(screen30.q, 1, `a 30 Hz screen keeps the full budget (${screen30.q})`);
  // a GPU whose frame time follows the particle count: 0.045 s at the full budget, never faster than the 60 Hz screen
  const c = new SwarmCore();
  c.setMood({ state: 'working', ctx: 30 });
  const gpu = q => Math.max(1 / 60, 0.045 * q);
  for (let i = 0; i < 60 * 30; i++) c.step(gpu(c.q));
  assert.ok(c.q < 0.6 && c.q >= 0.2, `the cuts helped, so they stay (${c.q.toFixed(2)})`);
  for (let i = 0; i < 60 * 90; i++) c.step(1 / 60);
  assert.equal(c.q, 1, 'and recovers to the full budget once frames run well');
  // the cost is elsewhere (frames slow whatever the count): a cut is tried once, then put back
  const busy = new SwarmCore();
  busy.setMood({ state: 'working', ctx: 30 });
  for (let i = 0; i < 60 * 3; i++) busy.step(1 / 60);
  for (let i = 0; i < 25 * 60; i++) busy.step(1 / 25);
  assert.equal(busy.q, 1, `particles not the cost: the budget is put back (${busy.q})`);
});

test('the canvas fallback draws a CPU sample of the swarm, within the buffer', () => {
  const c = new SwarmCore();
  c.setMood({ state: 'working', ctx: 30, model: OPUS });
  const out = new Float32Array(c.capacity * STRIDE);
  const o = c.project(100, 100, 104, out, 0), end = c.cpuSwarm(out, o);
  assert.equal(end - o, c.budget.fallback);
  assert.ok(end <= c.capacity);
  for (let i = o * STRIDE; i < end * STRIDE; i++) assert.ok(Number.isFinite(out[i]));
});

test('the glass takes the model hue', () => {
  const { core } = run({ state: 'working', ctx: 45, model: OPUS, effort: 'max' });
  assert.deepEqual([...core.view().hue].map(x => +x.toFixed(2)), rgb01(MODEL_HUES.opus).map(x => +x.toFixed(2)));
});

// ---------- wiring: the map model and the readout ----------
const project = (over = {}) => ({
  name: 'p', events: [], board: { decisions: [], entries: [] }, permissionMode: 'auto',
  agents: [{ name: 'orchestrator-3', role: 'orchestrator', thread: 'orchestrator', state: 'working', contextPct: 42, model: OPUS, effort: 'high' },
    { name: 'builder', role: 'worker', thread: 'builder', state: 'working' }],
  ...over
});

test('the map model hands the core its model, effort, context and permission mode', () => {
  const m = new MapModel();
  m.retireAt = 55;
  m.setProject(project(), new Set());
  const c = m.core();
  assert.deepEqual([c.state, c.ctx, c.retireAt, c.model, c.effort, c.mode, c.needs], ['working', 42, 55, OPUS, 'high', 'auto', false]);
  const look = coreLook(c);
  assert.ok(near(look.fill, 42 / 55) && look.ask === 0 && look.swirl === 1);
  m.setProject(project({ permissionMode: 'standard' }), new Set());
  assert.equal(m.core().mode, 'ask');
  const seen = project(); seen.agents[0] = { ...seen.agents[0], model: null, modelSeen: 'claude-fable-5-2' };
  m.setProject(seen, new Set());
  assert.equal(m.core().model, 'claude-fable-5-2', 'falls back to the model Claude Code reported');
});

test('permission answers become sparks toward the worker that asked', () => {
  const m = new MapModel();
  m.setProject(project(), new Set());
  assert.deepEqual(m.ingest({ type: 'permission_answer', worker: 'builder', answer: 'allow', by: 'orchestrator-3' }).spark, { kind: 'allowed', to: 'builder' });
  assert.equal(m.ingest({ type: 'permission_answer', worker: 'builder', answer: 'deny' }).spark.kind, 'denied');
  assert.equal(m.ingest({ type: 'permission_answer', worker: 'builder', answer: 'escalate' }).spark.kind, 'escalated');
  assert.equal(m.ingest({ type: 'permission_answer', worker: 'orchestrator-3', answer: 'allow', by: 'hub' }).spark.to, 'core', 'its own request sparks at the core');
  assert.equal(m.ingest({ type: 'message', from: 'you', thread: 'orchestrator', text: 'hi' }).spark, null);
});

test('a permission request still with the orchestrator is not counted as waiting for Matt until it escalates', () => {
  const m = new MapModel();
  const p = project();
  p.events = [...p.events, { type: 'approval', approval: 'ap1', thread: 'builder', routedTo: 'orchestrator-3' }];
  m.setProject(p, new Set(['ap1']));
  const before = m.needsCount();
  assert.equal(m.pendingApprovals().length, 0);
  p.events = [...p.events, { type: 'approval_escalated', approval: 'ap1' }];
  m.setProject(p, new Set(['ap1']));
  assert.equal(m.pendingApprovals().length, 1);
  assert.equal(m.needsCount(), before + 1);
});

test('the readout carries the numbers the sphere does not', () => {
  const m = new MapModel();
  m.setProject(project(), new Set());
  const r = coreReadout(m.core(), { busy: 1, resting: 2 });
  const row = k => r.rows.find(x => x.k === k);
  // shown by its project with its holder number (Matt, 2026-11-14): "p v3", not "orchestrator-3" or "Generation 3"
  assert.equal(r.title, 'p v3');
  assert.equal(r.sub, 'Orchestrator');
  assert.equal(r.state, 'Working');
  assert.equal(row('Model').v, 'Opus 5.5');
  assert.equal(row('Effort').v, 'High');
  assert.equal(row('Context').v, '42% used');
  assert.equal(row('Context').note, 'Hands off at 60%');
  assert.equal(row('Permissions').v, 'Auto');
  assert.equal(row('Workers').v, '1 working, 2 resting');
  assert.equal(row('Needs you'), undefined);
  assert.equal(coreReadout({ ...m.core(), ctx: 50 }).rows.find(x => x.k === 'Context').tone, 'amber');
  const due = coreReadout({ ...m.core(), ctx: 61, waiting: 2, mode: 'ask' });
  assert.equal(due.rows.find(x => x.k === 'Context').tone, 'gold');
  assert.match(due.rows.find(x => x.k === 'Context').note, /Handoff due/);
  assert.deepEqual(due.rows.find(x => x.k === 'Needs you'), { k: 'Needs you', v: '2 waiting', tone: 'red' });
  assert.equal(due.rows.find(x => x.k === 'Permissions').v, 'Ask');
  assert.equal(row('Doing'), undefined, 'no activity line when nothing is running');
  assert.equal(coreReadout({ ...m.core(), activity: 'Reading map.js' }).rows.at(-1).v, 'Reading map.js', 'what it is doing right now');
  assert.equal(coreReadout({ state: 'vacant' }).state, 'No holder');
  assert.ok(TONE.handoff, 'gold is the handoff tone');
});
