// Satellites (decision 77 A): the workers pulled in round a larger core, with depth, and each wearing a ring of particles
// lit for its own share of context.
import test from 'node:test';
import assert from 'node:assert/strict';
import { radialLayout, radialReserve } from '../public/map-layout.js';
import { stationRing, RING_REACH, RING_MAX, STRIDE, TONE } from '../public/map-particles.js';

const WORKERS = Array.from({ length: 6 }, (_, i) => ({ id: `w${i}` }));

test('the open map: a larger core, the workers on a closer orbit inside the Board and You, front ones larger', () => {
  const rect = { left: 0, top: 0, width: 1600, height: 1100 };
  const L = radialLayout(rect, WORKERS, false), res = radialReserve(rect, false);
  const aw = rect.width - res.left - res.right;
  assert.ok(L.core.r > 104 && L.core.r <= 116, `core ${L.core.r}`);
  const ws = WORKERS.map(w => L.at.get(w.id)), board = L.at.get('board'), you = L.at.get('you');
  for (const s of ws) {
    assert.ok(Math.abs(s.x - L.core.x) <= aw * 0.30 + 1, 'within about 30% of the width from the centre');
    assert.ok(s.y > board.y + board.r && s.y < you.y - you.r, 'between the Board and You');
    const d = Math.hypot(s.x - L.core.x, s.y - L.core.y);
    assert.ok(d - s.r * RING_REACH > L.core.r * 1.5, 'its ring clear of the core and its HUD rings');
    assert.ok(s.depth >= 0 && s.depth <= 1);
  }
  const front = ws.reduce((a, b) => (b.y > a.y ? b : a)), back = ws.reduce((a, b) => (b.y < a.y ? b : a));
  assert.ok(front.r > back.r && front.depth > back.depth, 'the front station is larger and nearer');
});

test('the phone still fits: stations stay inside the panel', () => {
  const rect = { left: 0, top: 0, width: 390, height: 844 };
  const L = radialLayout(rect, WORKERS, true);
  for (const s of L.at.values()) assert.ok(s.x - s.r >= 0 && s.x + s.r <= rect.width, `${s.x}`);
});

// count the ring's lit particles, by how bright they are
function ring(opts, r = 21) {
  const out = new Float32Array(RING_MAX * STRIDE), n = stationRing(out, 0, { x: 0, y: 0, r }, { hue: [0.7, 0.5, 1], n: 160, ...opts });
  const pts = [];
  for (let i = 0; i < n; i++) { const k = i * STRIDE; pts.push({ x: out[k], y: out[k + 1], size: out[k + 2], c: [out[k + 3], out[k + 4], out[k + 5]], a: out[k + 6] }); }
  return pts;
}

test('a worker ring: lit clockwise from the top for its share of context, gold over the last fifth', () => {
  for (const frac of [0, 0.25, 0.5, 0.9]) {
    const pts = ring({ frac, state: 'working', t: 3.7 }), body = pts.slice(0, 160);
    const lit = body.filter(p => p.a > 0.5).length / body.length;
    assert.ok(Math.abs(lit - frac) < 0.03, `${frac}: ${lit.toFixed(3)} lit`);
    // every lit particle sits clockwise from the top within the lit share
    for (const p of body.filter(p => p.a > 0.5)) { let th = Math.atan2(p.x, -p.y); if (th < 0) th += 2 * Math.PI; assert.ok(th / (2 * Math.PI) <= frac + 1e-9); }
    assert.equal(pts.length, frac > 0.005 ? 161 : 160, 'plus a bright head where the lit arc ends');
  }
  const reach = Math.hypot(ring({ frac: 0.3, state: 'working' })[0].x, ring({ frac: 0.3, state: 'working' })[0].y);
  assert.ok(Math.abs(reach / (21 * RING_REACH) - 1) < 0.08, 'it sits at the ring reach');
  const gold = ring({ frac: 0.95, state: 'working' }).filter(p => p.a > 0.5)[0].c, plain = ring({ frac: 0.5, state: 'working' }).filter(p => p.a > 0.5)[0].c;
  assert.ok(gold[2] < plain[2] && gold[0] > plain[0], 'warmer near its handoff');
  assert.ok(TONE.handoff[0] > TONE.handoff[2]);
});

test('a resting ring is dimmer and breathes; an asleep one dimmest', () => {
  const sum = pts => pts.reduce((a, p) => a + p.a, 0);
  const work = sum(ring({ frac: 0.5, state: 'working' })), asleep = sum(ring({ frac: 0.5, state: 'asleep' }));
  assert.ok(asleep < work * 0.6, 'asleep is dim');
  const r0 = Math.hypot(...Object.values(ring({ frac: 0, state: 'idle', t: 0 })[5]).slice(0, 2));
  const r1 = Math.hypot(...Object.values(ring({ frac: 0, state: 'idle', t: 1 })[5]).slice(0, 2));
  assert.notEqual(r0.toFixed(4), r1.toFixed(4), 'its radius moves while it rests');
});

test('a ring never writes more than its share of the buffer', () => {
  assert.equal(ring({ frac: 0.5, n: 10000 }).length, RING_MAX);
});
