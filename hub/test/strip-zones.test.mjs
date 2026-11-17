// The desktop strip's three zones (left: ALL button and meters; middle: the lane; right: Needs you and expand).
// One source of truth: stripLayout returns the zones, and the CSS keys off what map.js writes, with no breakpoints of
// its own. These tests keep every station and label inside the lane, and keep the CSS free of container queries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripLayout, STRIP_ZONE } from '../public/map-layout.js';
import { hubBays } from '../public/map-hub.js';

const read = f => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const workers = n => Array.from({ length: n }, (_, i) => ({ id: `w${i}` }));
const H = 124;

test('no station, label or the core meets a zone box, at 720-1600 wide with 0-8 workers', () => {
  for (let w = 720; w <= 1600; w += 4) {
    for (const left of [0, 300]) {   // the slot's own left edge in the window
      for (let n = 0; n <= 8; n++) {
        const S = stripLayout({ left, top: 0, width: w, height: H }, workers(n), false);
        const z = S.zones;
        const L = { x0: z.left.x, x1: z.left.x + z.left.w }, R = { x0: z.right.x, x1: z.right.x + z.right.w };
        assert.equal(z.left.w, STRIP_ZONE.left);
        assert.equal(z.right.w, STRIP_ZONE.right);
        assert.equal(L.x1, z.lane.x, 'the left zone ends where the lane starts');
        assert.equal(z.lane.x + z.lane.w, R.x0, 'the lane ends where the right zone starts');
        const boxes = [...S.at.values()].map(s => ({ x0: s.x - s.r, x1: s.x + s.r }));
        // worker names; You and the Board are icons whose label shows only on hover
        if (S.labels) for (const [k, s] of S.at) if (k.startsWith('w')) boxes.push({ x0: s.x - S.labelW / 2, x1: s.x + S.labelW / 2 });
        boxes.push({ x0: S.core.x - S.core.r, x1: S.core.x + S.core.r });
        for (const b of boxes) {
          assert.ok(b.x0 >= L.x1 - 0.5, `w=${w} n=${n}: something runs into the left zone`);
          assert.ok(b.x1 <= R.x0 + 0.5, `w=${w} n=${n}: something runs into the right zone`);
        }
        // names of neighbouring workers never overlap
        const ids = [...S.at.keys()].filter(k => k.startsWith('w')).map(k => S.at.get(k)).sort((a, b) => a.x - b.x);
        if (S.labels) for (let i = 1; i < ids.length; i++) assert.ok(ids[i].x - ids[i - 1].x >= S.labelW - 0.5, `w=${w} n=${n}: two names overlap`);
        // the ticker shows only when the lane is at least 700 wide
        assert.equal(S.wide, z.lane.w >= 700);
      }
    }
  }
});

test('the screenshot case (1004 wide, ALL shown) is no longer a special case', () => {
  const S = stripLayout({ left: 0, top: 0, width: 1004, height: H }, workers(3), false);
  assert.equal(S.zones.lane.w, 1004 - STRIP_ZONE.left - STRIP_ZONE.right);
  assert.ok(S.at.get('you').x - 12 >= STRIP_ZONE.left, 'You clears the meters and the ALL button');
  assert.ok(S.at.get('board').x + 12 <= 1004 - STRIP_ZONE.right, 'Board clears the Needs you pill');
});

test('a phone strip has no zones and keeps its old geometry', () => {
  const S = stripLayout({ left: 0, top: 0, width: 390, height: 50 }, workers(2), true);
  assert.equal(S.zones, null);
  assert.equal(S.wide, false);
  assert.equal(S.at.get('you').x, 26);
  assert.equal(S.at.get('board').x, 390 - 26);
  assert.equal(S.core.x, 195);
});

test('the All projects bays stay inside the lane', () => {
  const P = n => Array.from({ length: n }, (_, i) => ({ name: `p${i}`, count: 0, workers: [], state: 'idle' }));
  for (const w of [720, 1004, 1280, 1652]) {
    const S = stripLayout({ left: 0, top: 0, width: w, height: H }, [], false);
    const laneL = S.zones.lane.x, laneR = laneL + S.zones.lane.w, board = S.at.get('board');
    for (const n of [1, 3, 6, 12, 20]) {
      const { bays, more } = hubBays({ left: 0, top: 0, width: w, height: H }, P(n), false, { core: S.core, you: S.at.get('you'), rightEnd: board.x + board.r });
      const half = b => (b.mode === 'full' ? b.w : b.mode === 'icon' ? 40 : 20) / 2;
      for (const b of bays) { assert.ok(b.x - half(b) >= laneL - 0.5, `w=${w} n=${n}: a bay leaves the lane at the left`); assert.ok(b.x + half(b) <= laneR + 0.5, `w=${w} n=${n}: a bay leaves the lane at the right`); }
      if (more) assert.ok(more.x - 10 >= laneL && more.x + 10 <= laneR, `w=${w} n=${n}: "+N" is in the lane`);
    }
  }
});

test('the CSS keys off the zone variables and class, with no breakpoint of its own', () => {
  const map = read('map.css'), usage = read('usage.css'), js = read('map.js');
  assert.doesNotMatch(map, /@container hud \(max-width:979px\)/);
  assert.doesNotMatch(usage, /@container hud \(max-width:979px\)/);
  for (const v of ['--zl', '--zr', '--lane-x', '--lane-w']) assert.ok(js.includes(`'${v}'`), `${v} is written by the map`);
  assert.match(js, /classList\.toggle\('strip-zoned'/);
  assert.match(js, /classList\.toggle\('strip-wide'/);
  assert.match(map, /\.strip-zoned\.strip-wide \.hud-read-l/);
  assert.match(usage, /var\(--zl/);
});
