// The live map's core (M013): how the orchestrator's state becomes what the glass sphere shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { coreLook, levelFor, coreBudget, ReservoirCore, SPARK_COLOR } from '../public/map-core.js';
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

test('the level is honest about volume', () => {
  assert.ok(levelFor(0) < -0.95 && levelFor(1) > 0.95);
  assert.ok(Math.abs(levelFor(0.5)) < 1e-3, 'half the volume is the equator');
  let last = -2;
  for (let f = 0; f <= 1.0001; f += 0.05) { const l = levelFor(f); assert.ok(l > last, 'rises with fill'); last = l; }
});

test('a phone carries about a third of the particles', () => {
  const d = coreBudget(false), p = coreBudget(true);
  const sum = b => Object.values(b).reduce((a, n) => a + n, 0);
  assert.ok(sum(p) < sum(d) * 0.42 && sum(p) > sum(d) * 0.25, `${sum(p)} of ${sum(d)}`);
});

// Run a core for a while and collect what it draws.
function run(info, { seconds = 3, light = false, before } = {}) {
  const core = new ReservoirCore({ light });
  core.setMood(info); core.settle();
  before?.(core);
  for (let i = 0; i < seconds * 60; i++) core.step(1 / 60);
  const out = new Float32Array((core.capacity + 8) * STRIDE);
  const n = core.project(100, 100, 50, out, 0);
  return { core, out, n };
}
const count = ({ out, n }, pred) => { let c = 0; for (let i = 0; i < n; i++) { const k = i * STRIDE; if (pred(out[k + 3], out[k + 4], out[k + 5], out[k + 6], out[k], out[k + 1])) c++; } return c; };
const isRed = (r, g, b, a) => a > 0.05 && r > 0.9 && g < 0.6 && b < 0.6;
const isGold = (r, g, b, a) => a > 0.05 && r > 0.9 && g > 0.7 && b < 0.62;
const isGreen = (r, g, b, a) => a > 0.05 && g > r + 0.2 && g > b;

test('the simulation stays inside its budget and draws finite numbers', () => {
  for (const light of [false, true]) {
    const r = run({ state: 'working', ctx: 30, model: OPUS, effort: 'max', needs: true, mode: 'ask' }, { light, before: c => { c.spark('allowed', 0); c.spark('escalated', 2); c.handoff(); } });
    assert.ok(r.n <= r.core.capacity, `${r.n} particles within ${r.core.capacity}`);
    for (let i = 0; i < r.n * STRIDE; i++) assert.ok(Number.isFinite(r.out[i]), 'finite');
  }
});

test('what the particles show: fill, gold near the handoff, red only when Matt is needed', () => {
  const liquid = c => { let n = 0; for (let i = 0; i < c.n; i++) if (c.w[i] > 0.5) n++; return n / c.n; };
  assert.ok(Math.abs(liquid(run({ state: 'idle', ctx: 30, model: OPUS }).core) - 0.5) < 0.06, 'half the particles are liquid at half fill');
  assert.ok(liquid(run({ state: 'idle', ctx: 6, model: OPUS }).core) < 0.16);
  assert.equal(count(run({ state: 'working', ctx: 30, model: OPUS }), isGold), 0, 'no gold at 30%');
  assert.ok(count(run({ state: 'working', ctx: 58, model: OPUS }), isGold) > 100, 'gold near the threshold');
  assert.equal(count(run({ state: 'working', ctx: 58, model: OPUS }), isRed), 0, 'near the handoff is gold, not red');
  assert.ok(count(run({ state: 'idle', ctx: 30, model: OPUS, needs: true }), isRed) > 40, 'the red flare when something waits on Matt');
  assert.equal(count(run({ state: 'error', ctx: 30, model: OPUS }), isRed), 0, 'an error is not red');
});

test('a permission answer throws sparks that burn out', () => {
  const lit = run({ state: 'working', ctx: 30, model: OPUS }, { seconds: 0.1, before: c => c.spark('allowed', 0) });
  assert.ok(lit.core.nsp > 40 && count(lit, isGreen) > 20, 'a green burst');
  assert.ok(lit.core.tvx !== 0, 'the liquid feels it');
  const sent = run({ state: 'working', ctx: 30, model: OPUS }, { seconds: 0.1, before: c => c.spark('escalated', 0) });
  assert.ok(count(sent, isRed) > 20, 'red when it went to Matt');
  assert.equal(run({ state: 'working', ctx: 30, model: OPUS }, { seconds: 3, before: c => c.spark('allowed', 0) }).core.nsp, 0, 'all gone after three seconds');
});

test('the handoff pulse disturbs the liquid', () => {
  const calm = run({ state: 'idle', ctx: 30, model: OPUS }, { seconds: 4 }).core;
  const due = run({ state: 'idle', ctx: 61, model: OPUS }, { seconds: 4 }).core;
  assert.equal(calm.ripples.length, 0);
  assert.ok(due.ripples.length > 0, 'rings run over the surface while the handoff is due');
});

test('the budget adapts when frames run long, and never below half', () => {
  const core = new ReservoirCore();
  core.setMood({ state: 'working', ctx: 30 });
  for (let i = 0; i < 60 * 4; i++) core.step(1 / 60);
  assert.equal(core.q, 1, 'steady 60 fps keeps the full budget');
  for (let i = 0; i < 30 * 20; i++) core.step(1 / 30);
  assert.ok(core.q < 1 && core.q >= 0.5, `slow frames shed particles (${core.q})`);
});

test('the line where liquid meets glass stays inside the sphere', () => {
  const { core } = run({ state: 'working', ctx: 45, model: OPUS, effort: 'max' });
  const v = core.view();
  for (let i = 0; i < v.ring.length; i += 2) assert.ok(Math.hypot(v.ring[i], v.ring[i + 1]) < 1.02);
  assert.deepEqual([...v.hue].map(x => +x.toFixed(2)), rgb01(MODEL_HUES.opus).map(x => +x.toFixed(2)));
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

test('the readout carries the numbers the sphere does not', () => {
  const m = new MapModel();
  m.setProject(project(), new Set());
  const r = coreReadout(m.core(), { busy: 1, resting: 2 });
  const row = k => r.rows.find(x => x.k === k);
  assert.equal(r.title, 'orchestrator-3');
  assert.equal(r.sub, 'Generation 3');
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
  assert.equal(coreReadout({ state: 'vacant' }).state, 'No holder');
  assert.ok(TONE.handoff, 'gold is the handoff tone');
});
