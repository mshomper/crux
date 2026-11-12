// The model-family robots (M015): which robot an agent gets, and how effort, state and role show on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { robot, robotKey, glowFor } from '../public/robots.js';
import { MODEL_HUES } from '../public/models.js';

const MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-2' };
const count = (s, re) => (s.match(re) || []).length;

test('each model family has its own robot, tinted by its hue', () => {
  const art = new Set();
  for (const [fam, model] of Object.entries(MODELS)) {
    const s = robot({ model });
    assert.match(s, new RegExp(`class="bot bot-${fam} `));
    assert.ok(s.includes(`color:${MODEL_HUES[fam]}`), `${fam} carries its hue`);
    art.add(s.replace(/^<svg[^>]*>/, ''));
  }
  assert.equal(art.size, 4, 'four different drawings');
  assert.match(robot({ modelSeen: MODELS.fable }), /bot-fable/, 'falls back to the model Claude Code reported');
});

test('a model that is not known yet gets the plain helmet, with no hue of its own', () => {
  for (const a of [null, {}, { model: 'something-else' }]) {
    const s = robot(a);
    assert.match(s, /bot-plain/);
    assert.ok(!s.includes('color:'));
  }
});

test('effort: the visor burns brighter at each step, and pips appear from 40px up', () => {
  const g = ['low', 'medium', 'high', 'xhigh', 'max'].map(glowFor);
  for (let i = 1; i < g.length; i++) assert.ok(g[i] > g[i - 1]);
  assert.ok(g[0] >= 0.35 && g[4] === 1);
  assert.equal(glowFor(null), 0.7, 'default effort sits in the middle');
  assert.ok(robot({ model: MODELS.opus, effort: 'max' }).includes('--glow:1.00'));
  assert.equal(count(robot({ model: MODELS.opus, effort: 'high' }, { size: 24 }), /class="p/g), 0, 'no pips at 24px');
  const big = robot({ model: MODELS.opus, effort: 'high' }, { size: 48 });
  assert.equal(count(big, /class="p/g), 5, 'five pips at 48px');
  assert.equal(count(big, /class="p on"/g), 3, 'high lights three');
  assert.equal(count(robot({ model: MODELS.opus, effort: 'max' }, { size: 128 }), /class="p on"/g), 5);
  assert.equal(count(robot({ model: MODELS.opus }, { size: 48 }), /class="p hollow"/g), 5, 'hollow at the default effort, like the pips elsewhere');
});

test('state and waiting on Matt show as classes; unknown states fall back to idle', () => {
  for (const st of ['idle', 'working', 'starting', 'asleep', 'error', 'retired']) assert.match(robot({ model: MODELS.sonnet, state: st }), new RegExp(` st-${st}[ "]`));
  assert.match(robot({ model: MODELS.sonnet, state: '"><script>' }), / st-idle[ "]/, 'never copies an unknown state into the markup');
  assert.ok(!robot({ model: MODELS.sonnet, state: '"><script>' }).includes('script'));
  assert.match(robot({ model: MODELS.sonnet }, { needs: true }), / needs[ "]/);
  assert.ok(!/ needs[ "]/.test(robot({ model: MODELS.sonnet })));
});

test('the orchestrator wears the crown', () => {
  assert.ok(robot({ model: MODELS.opus, role: 'orchestrator' }).includes('class="crown"'));
  assert.ok(!robot({ model: MODELS.opus, role: 'worker' }).includes('class="crown"'));
  assert.ok(robot({ model: MODELS.opus, role: 'worker' }, { crown: true }).includes('class="crown"'));
  assert.ok(!robot({ model: MODELS.opus, role: 'orchestrator' }, { crown: false }).includes('class="crown"'));
});

test('a robot is redrawn only when its look changes', () => {
  const a = { model: MODELS.haiku, effort: 'low', state: 'idle', role: 'worker', name: 'x', contextPct: 10 };
  assert.equal(robotKey(a), robotKey({ ...a, contextPct: 55, name: 'y' }), 'context and name do not matter');
  for (const change of [{ model: MODELS.opus }, { effort: 'max' }, { state: 'working' }]) assert.notEqual(robotKey(a), robotKey({ ...a, ...change }));
  assert.notEqual(robotKey(a), robotKey(a, true), 'waiting on Matt changes it');
});
