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

// Nothing on the open map touches: every worker's ring and label, the Board and You with their labels, the "+N" chip and
// the core's HUD scales. The shapes are worked out here from the page's own sizes (map.css, map-hud.js), not from the
// layout's helpers: a ring reaches 1.62 station radii (plus 4.5% breathing and a particle), a satellite's label starts
// 1.62 radii + 6 px under its centre, a name line is 16 px tall at about 6.9 px a character (10.5px mono, .06em), cut
// at the station's lw; the core's scales reach 1.6 core radii + 6 px.
const LONG = ['gatherer-allowance', 'core-particles-2', 'robot-satellites', 'permission-checker', 'strip-layout-fix', 'expedition-builder', 'review-135-deep', 'decisions-clerk'];
const SIZES = [[800, 600, false], [1100, 700, false], [1600, 900, false], [390, 700, true], [390, 844, true]];
function shapesOf(L, workers) {
  const out = [];
  const core = L.core;
  out.push({ who: 'core', S: [{ c: true, x: core.x, y: core.y, r: core.r * 1.6 + 6 }] });
  for (const id of ['board', 'you']) {
    const s = L.at.get(id), w = id === 'you' ? 10 * 7.2 : 5 * 6.8, h = id === 'you' ? 30 : 16, y0 = s.y + s.r + 8;
    out.push({ who: id, S: [{ c: true, x: s.x, y: s.y, r: s.r * 1.12 }, { x0: s.x - w / 2, x1: s.x + w / 2, y0, y1: y0 + h }] });
  }
  for (const wk of workers) {
    const s = L.at.get(wk.id);
    if (!s.r) continue;   // folded into the chip
    const nameW = Math.min(s.lw ?? 150, wk.name.length * 6.9), subW = wk.needs ? 14 * 6.4 : 0, w = Math.max(nameW, subW), h = 16 + (wk.needs ? 17 : 0);
    const y0 = s.y + s.r * 1.62 + 6;
    out.push({ who: wk.name, S: [{ c: true, x: s.x, y: s.y, r: s.r * 1.62 * 1.045 + 1 }, { x0: s.x - w / 2, x1: s.x + w / 2, y0, y1: y0 + h }] });
  }
  if (L.fold) out.push({ who: '+N', S: [{ c: true, x: L.fold.chip.x, y: L.fold.chip.y, r: L.fold.chip.r }] });
  return out;
}
function touches(a, b) {
  if (a.c && b.c) return Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r;
  if (!a.c && !b.c) return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const c = a.c ? a : b, r = a.c ? b : a;
  return Math.hypot(c.x - clamp(c.x, r.x0, r.x1), c.y - clamp(c.y, r.y0, r.y1)) < c.r;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

test('the open map: rings, labels, You, the Board and the core never touch, at five window sizes and 2 to 8 workers', () => {
  for (const [width, height, phone] of SIZES) for (const n of [2, 4, 6, 8]) {
    const workers = LONG.slice(0, n).map((name, i) => ({ id: `w${i}`, name, needs: i === 1 }));
    const rect = { left: 0, top: 0, width, height };
    const L = radialLayout(rect, workers, phone), res = radialReserve(rect, phone);
    const where = `${width}x${height}, ${n} workers`;
    assert.ok(!L.crowded, `${where}: crowded`);
    const items = shapesOf(L, workers);
    for (let i = 0; i < items.length; i++) for (let j = 0; j < i; j++) {
      const hitAny = items[i].S.some(a => items[j].S.some(b => touches(a, b)));
      assert.ok(!hitAny, `${where}: ${items[i].who} touches ${items[j].who}`);
    }
    // everything inside the map's own area (clear of the top bar, the telemetry and the tray)
    const box = { x0: res.left, y0: res.top, x1: width - res.right, y1: height - res.bottom };
    for (const it of items) for (const s of it.S) {
      const [x0, x1, y0, y1] = s.c ? [s.x - s.r, s.x + s.r, s.y - s.r, s.y + s.r] : [s.x0, s.x1, s.y0, s.y1];
      assert.ok(x0 >= box.x0 - 0.5 && x1 <= box.x1 + 0.5 && y0 >= box.y0 - 0.5 && y1 <= box.y1 + 0.5, `${where}: ${it.who} leaves the area`);
    }
    // every worker is either on the orbit or counted in the chip
    const shown = workers.filter(w => L.at.get(w.id).r > 0).length;
    assert.equal(shown + (L.fold ? L.fold.n : 0), n, `${where}: a worker went missing`);
  }
});

test('the room decides: a big window keeps all 8 at full size; a short one steps down or folds the last ones into +N', () => {
  const workers = LONG.map((name, i) => ({ id: `w${i}`, name }));
  const big = radialLayout({ left: 0, top: 0, width: 1600, height: 900 }, workers, false);
  assert.equal(big.fold, null, 'nothing folded at 1600x900');
  assert.equal(big.at.get('w0').lw, 150, 'names at full width');
  const small = radialLayout({ left: 0, top: 0, width: 800, height: 600 }, workers, false);
  const smaller = small.fold || [...small.at.values()].some(s => s.lw < 150);
  assert.ok(smaller, '800x600 with 8 long names steps down or folds');
  if (small.fold) assert.deepEqual(small.fold.ids, workers.slice(workers.length - small.fold.n).map(w => w.id), 'the last in the list fold first');
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
