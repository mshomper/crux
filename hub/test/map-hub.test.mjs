// The All projects map (decision 57 C): the Conductor in the middle, one sector per project. Matt's rules: works
// at 390 wide, never scrolls sideways, labels never overlap, and past about six projects it folds gracefully.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hubProjects, hubSectors, hubLayout, hubBays, hubFeed, labelLines, spread, LABEL, RING, YOU_WORDS } from '../public/map-hub.js';
import { stripLayout, stripLane } from '../public/map-layout.js';
import { conductorCore } from '../public/map-sectors.js';
import { conductorReadout } from '../public/map-readout.js';

const TAU = Math.PI * 2;
const norm = a => ((a % TAU) + TAU) % TAU;
const fake = (n, waiting = [1, 3]) => Array.from({ length: n }, (_, i) => ({
  name: `project-${i + 1}`, count: waiting.includes(i) ? i + 1 : 0, retireAt: 60, model: 'claude-opus-5-5', effort: 'high',
  state: i % 3 ? 'idle' : 'working', ctx: 10 + i * 4, workers: Array.from({ length: i % 4 }, (_, k) => ({ name: `w${k}`, model: 'claude-sonnet-5-5', state: 'idle', needs: false }))
}));
// the panel when the map is open: desktop beside a 268px list; a phone takes the whole screen
const DESK = { left: 268, top: 0, width: 1652, height: 1080 };
const LAPTOP = { left: 240, top: 0, width: 1126, height: 768 };
const PHONE = { left: 0, top: 0, width: 390, height: 844 };
const SMALL = { left: 0, top: 0, width: 320, height: 640 };
const COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16];

test('sectors: one per project, never overlapping, a gap always straight down, at most a third of the ring each', () => {
  for (const n of COUNTS) {
    const s = hubSectors(n);
    assert.equal(s.length, n);
    for (const x of s) {
      assert.ok(x.span > 0 && x.span <= TAU / 3 + 1e-9, `n=${n}: span ${x.span}`);
      const down = norm(Math.PI / 2 - x.a0);
      assert.ok(down >= x.span - 1e-9, `n=${n}: sector ${x.i} covers the bottom, where You's spoke runs`);
    }
    for (let i = 1; i < n; i++) assert.ok(s[i].a0 > s[i - 1].a1, `n=${n}: sectors ${i - 1} and ${i} overlap`);
    if (n > 1) assert.ok(s[n - 1].a1 < s[0].a0 + TAU, `n=${n}: last meets first`);
  }
  assert.deepEqual(hubSectors(0), []);
  // four projects sit on the diagonals, as in the mockup Matt picked
  assert.deepEqual(hubSectors(4).map(x => Math.round(norm(x.mid) / Math.PI * 180)), [135, 225, 315, 45]);
});

test('spread keeps labels apart and inside the column', () => {
  const out = spread([{ i: 0, want: 50 }, { i: 1, want: 52 }, { i: 2, want: 54 }, { i: 3, want: 990 }], 90, 0, 1000);
  const ys = out.map(o => o.y).sort((a, b) => a - b);
  for (let k = 1; k < ys.length; k++) assert.ok(ys[k] - ys[k - 1] >= 90 - 1e-9);
  assert.ok(ys[0] >= 45 && ys[ys.length - 1] <= 955);
});

// Every label as a box, for the overlap and edge checks.
function boxes(L, phone, rect) {
  const S = phone ? LABEL.phone : LABEL.desk;
  const out = [];
  for (const l of [...L.labels, ...L.more]) {
    const h = l.mode === 'full' ? S.full : S.line;
    const w = l.width || S.width;
    assert.ok(w >= (phone ? 100 : 170), `a label is ${w}px wide: too narrow to read`);
    const left = l.align === 'left' ? l.x : l.x - w;
    out.push({ left, right: left + w, top: l.y - h / 2 + 1, bottom: l.y + h / 2 - 1, l });
  }
  return out;
}
const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

for (const [label, rect, phone] of [['1920 desktop', DESK, false], ['1366 laptop', LAPTOP, false], ['390 phone', PHONE, true], ['320 phone', SMALL, true]]) {
  test(`opened map at ${label}: every project accounted for, nothing overlaps, nothing leaves the panel`, () => {
    for (const n of COUNTS) {
      const P = fake(n);
      const L = hubLayout(rect, P, phone);
      const shown = new Set(L.labels.map(l => l.i));
      const folded = new Set(L.more.flatMap(m => m.of));
      for (let i = 0; i < n; i++) assert.ok(shown.has(i) !== folded.has(i), `n=${n}: project ${i} must be labelled or folded, once`);
      for (const m of L.more) assert.equal(m.n, m.of.length);
      const B = boxes(L, phone, rect);
      for (const b of B) {
        assert.ok(b.left >= rect.left - 0.5 && b.right <= rect.left + rect.width + 0.5, `n=${n}: a label leaves the panel sideways (${b.left}..${b.right})`);
        assert.ok(b.top >= rect.top && b.bottom <= rect.top + rect.height, `n=${n}: a label leaves the panel vertically`);
      }
      for (let a = 0; a < B.length; a++) for (let b = a + 1; b < B.length; b++) assert.ok(!hit(B[a], B[b]), `n=${n}: labels overlap`);
      // labels stay off the ring and You
      const { x, y } = L.core, rg = L.ring.rg;
      const ringBox = { left: x - rg, right: x + rg, top: y - rg, bottom: y + rg };
      // You's circle, and its words under it (on a phone, wider than the circle)
      const circle = { left: L.you.x - L.you.r - 4, right: L.you.x + L.you.r + 4, top: L.you.y - L.you.r, bottom: L.you.y + L.you.r };
      const half = phone ? YOU_WORDS / 2 : L.you.r + 4;
      const words = { left: L.you.x - half, right: L.you.x + half, top: L.you.y + L.you.r + 4, bottom: L.you.y + L.you.r + 30 };
      for (const b of B) {
        assert.ok(!hit(b, ringBox), `n=${n}: a label covers the ring`);
        assert.ok(!hit(b, circle), `n=${n}: a label covers You`);
        assert.ok(!hit(b, words), `n=${n}: a label covers You's words`);
      }
      // the ring sits inside the panel, clear of the top bar, and above You
      assert.ok(x - rg >= rect.left && x + rg <= rect.left + rect.width, `n=${n}: ring leaves the panel`);
      assert.ok(y - rg >= rect.top + L.reserve.top - 1, `n=${n}: ring under the top bar`);
      assert.ok(y + rg < L.you.y - L.you.r, `n=${n}: ring runs into You`);
      assert.ok(L.core.r >= 22 && L.core.r <= 104);
      assert.ok(L.ring.r1 < L.ring.r2 && L.ring.r2 < L.ring.rg);
    }
  });
}

test('folding: four projects get full labels on desktop and phone; many fold to one line, then to "+N more"', () => {
  assert.equal(hubLayout(DESK, fake(4), false).mode, 'full');
  assert.equal(hubLayout(PHONE, fake(4), true).mode, 'full');
  assert.equal(hubLayout(PHONE, fake(10), true).mode, 'line');
  const crowd = hubLayout(SMALL, fake(16), true);
  assert.equal(crowd.mode, 'line');
  assert.ok(crowd.more.length > 0, 'sixteen projects on a small phone: some fold into "+N more"');
  // projects waiting on you keep their label when others fold
  const P = fake(16, [13, 14, 15]);
  const L = hubLayout(SMALL, P, true);
  const shown = new Set(L.labels.map(l => l.i));
  for (const i of [13, 14, 15]) assert.ok(shown.has(i), `project ${i} waits on you and keeps its label`);
});

test('the strip: bays never overlap, stay in their zone, and compact as the strip fills', () => {
  for (const [w, h, phone] of [[1652, 124, false], [900, 124, false], [390, 50, true], [320, 50, true]]) {
    const lane = stripLane({ left: 0, top: 0, width: w, height: h }, phone, false);
    const S = stripLayout(lane, [], phone);
    const you = S.at.get('you');
    for (const n of COUNTS) {
      const { bays, more } = hubBays(lane, fake(n), phone, { core: S.core, you });
      const seen = new Set(bays.map(b => b.i));
      for (let i = 0; i < n; i++) assert.ok(seen.has(i) !== !!more?.of.includes(i), `w=${w} n=${n}: project ${i} once`);
      const width = b => b.mode === 'full' ? b.w : b.mode === 'icon' ? (phone ? 26 : 40) : (phone ? 14 : 20);
      const items = [...bays.map(b => ({ x: b.x, w: width(b) })), ...(more ? [{ x: more.x, w: phone ? 14 : 20 }] : [])].sort((a, b) => a.x - b.x);
      for (let k = 1; k < items.length; k++) assert.ok(items[k].x - items[k].w / 2 >= items[k - 1].x + items[k - 1].w / 2 - 0.5, `w=${w} n=${n}: bays overlap`);
      for (const b of items) {
        assert.ok(b.x - b.w / 2 >= you.x + you.r, `w=${w} n=${n}: a bay runs into You`);
        assert.ok(b.x + b.w / 2 <= w, `w=${w} n=${n}: a bay leaves the strip`);
        assert.ok(Math.abs(b.x - S.core.x) >= S.core.r * 1.6, `w=${w} n=${n}: a bay sits on the core`);
      }
      if (phone) assert.ok(bays.every(b => b.mode !== 'full'), 'a phone strip has no room for words');
    }
  }
  const lane = { left: 0, top: 0, width: 1652, height: 124 };
  const S = stripLayout(lane, [], false);
  assert.ok(hubBays(lane, fake(4), false, { core: S.core, you: S.at.get('you') }).bays.every(b => b.mode === 'full'), 'four projects at 1920: full bays');
});

test('words: plain, counted right', () => {
  const [p] = fake(1);
  assert.deepEqual(labelLines({ ...p, count: 2, workers: [], state: 'idle', ctx: 41.6 }), { name: 'project-1', waiting: '2 waiting for you', model: 'Opus 5.5 · 42% context', agents: '1 agent · 0 working' });
  assert.equal(labelLines({ ...p, count: 0, state: 'asleep', workers: [] }).agents, '1 agent · asleep');
  assert.equal(labelLines({ ...p, count: 0 }).waiting, 'nothing waiting');
  assert.equal(labelLines({ ...p, state: 'vacant', model: null, workers: [] }).model, 'No orchestrator yet');
});

test('hubProjects reads the All projects groups, and the page decides what waits on you', () => {
  const groups = [{
    name: 'atlas', count: 2, p: { retireAt: 55 },
    agents: [{ name: 'orchestrator-1', role: 'orchestrator', modelSeen: 'claude-opus-5-5', effort: 'high', state: 'working', contextPct: 42, thread: 'orchestrator' },
      { name: 'reviewer', role: 'worker', model: 'claude-sonnet-5-5', state: 'idle', thread: 'reviewer' }]
  }, { name: 'orchard', count: 0, agents: [] }];
  const P = hubProjects(groups, { retireAt: 60, waitingOf: (g, a) => a.thread === 'reviewer' ? 1 : 0 });
  assert.deepEqual(P[0], { name: 'atlas', count: 2, retireAt: 55, model: 'claude-opus-5-5', effort: 'high', state: 'working', ctx: 42, workers: [{ name: 'reviewer', model: 'claude-sonnet-5-5', state: 'idle', needs: true }] });
  assert.equal(P[1].state, 'vacant');
  assert.equal(P[1].retireAt, 60);
});

test('during a handoff the project shows its incoming orchestrator, not the one retiring', () => {
  const [p] = hubProjects([{ name: 'atlas', count: 0, agents: [
    { name: 'orchestrator-1', role: 'orchestrator', model: 'claude-opus-5-5', state: 'idle', contextPct: 61, retiring: 'overlap' },
    { name: 'orchestrator-2', role: 'orchestrator', model: 'claude-sonnet-5-5', state: 'working', contextPct: 6 }
  ] }]);
  assert.equal(p.model, 'claude-sonnet-5-5');
  assert.equal(p.ctx, 6);
  assert.equal(p.workers.length, 0, 'the outgoing orchestrator is not counted as a worker');
});

// Review MEDIUM 1 (2026-11-13): moving the keyboard between pinned columns left the map in the wrong mode until the
// next live event. The map update now runs on its own, from render() and from a focus change alike.
test('moving focus between columns updates the map at once', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const kb = app.match(/kbChanged: \(\) => \{([^}]*)\}/);
  assert.ok(kb, 'kbChanged is there');
  assert.match(kb[1], /updateMap\(\)/, 'a focus change updates the map');
  const render = app.slice(app.indexOf('function render() {'), app.indexOf('function updateMap() {'));
  assert.match(render, /updateMap\(\);/, 'render updates the map through the same function');
  const upd = app.slice(app.indexOf('function updateMap() {'), app.indexOf('// ---------- actions ----------'));
  assert.match(upd, /hubMap = S\.projects\.length > 1 && cols\.kb === AP\.HUB_THREAD/, 'the mode follows the column in focus');
  assert.match(upd, /map\.update\(/);
});

test('the telemetry list puts projects waiting on you first, then working ones', () => {
  const P = fake(4, [2]);
  P[0].state = 'idle'; P[1].state = 'working'; P[3].state = 'idle';
  for (const p of P) for (const w of p.workers) w.state = 'idle';
  assert.deepEqual(hubFeed(P).map(l => l.name), ['project-3', 'project-2', 'project-1', 'project-4']);
  assert.equal(hubFeed(P)[0].tone, 'alert');
});

test('ring radii stay in order', () => assert.ok(RING.inner < RING.outer && RING.outer < RING.gauge));

test('the core is the Conductor: its state, context and model from /api/state, and its own readout', () => {
  assert.equal(conductorCore(null).state, 'vacant', 'an older hub with no Conductor: a dim core');
  const asleep = conductorCore({ name: null, state: 'asleep', retireAt: 60, waiting: 0 });
  assert.equal(asleep.state, 'asleep');
  assert.equal(asleep.holder, null);
  const c = conductorCore({ name: 'conductor-1', state: 'working', contextPct: 31, modelSeen: 'claude-opus-5-5', effort: 'high', retireAt: 55, waiting: 1, activity: 'Reading atlas' });
  assert.deepEqual({ holder: c.holder, state: c.state, ctx: c.ctx, retireAt: c.retireAt, needs: c.needs, model: c.model, mode: c.mode },
    { holder: 'conductor-1', state: 'working', ctx: 31, retireAt: 55, needs: true, model: 'claude-opus-5-5', mode: 'auto' });
  assert.equal(conductorCore({ name: 'conductor-1', state: 'idle', retiring: 'writing' }).state, 'writing', 'writing its handoff turns the glass gold');
  const r = conductorReadout(c, { projects: 4, waiting: 3 });
  assert.equal(r.title, 'conductor-1');
  assert.equal(r.sub, 'Conductor');
  assert.ok(r.rows.some(x => x.k === 'Projects' && x.v === '4 projects' && x.note === '3 waiting for you' && x.tone === 'red'));
  assert.ok(r.rows.some(x => x.k === 'Context' && x.note === 'Hands off at 55%'));
  assert.ok(!r.rows.some(x => x.k === 'Permissions'), 'the Conductor answers no permission requests');
  assert.equal(r.action, 'Show its thread', 'its thread is in All projects, already in focus: the button says what it does');
  assert.equal(conductorReadout(conductorCore(null), { projects: 2 }).state, 'Not running');
});
