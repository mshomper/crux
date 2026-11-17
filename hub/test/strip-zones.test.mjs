// The desktop strip's three zones (left: ALL button and meters; middle: the lane; right: Needs you and expand).
// One source of truth: stripLayout returns the zones, and the CSS keys off what map.js writes, with no breakpoints of
// its own. These tests keep every station, name, chip and the core clear of each other and inside the lane, and keep
// the CSS free of container queries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripLayout, STRIP_ZONE } from '../public/map-layout.js';
import { hubBays } from '../public/map-hub.js';

const read = f => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const workers = n => Array.from({ length: n }, (_, i) => ({ id: `w${i}` }));
const H = 124;

test('slot widths 440-1600, with and without ALL, 0-8 and 12 workers: nothing overlaps and nothing meets a zone', () => {
  // the slot is the window minus the thread list (and the board panel when open): from a narrow desktop slot to a wide one
  for (let w = 440; w <= 1600; w += 3) {
    for (const left of [0, 300]) {
      for (const all of [false, true]) {
        for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 12]) {
          const tag = `w=${w} left=${left} all=${all} n=${n}`;
          const S = stripLayout({ left, top: 0, width: w, height: H }, workers(n), false, null, { all });
          const z = S.zones;
          const R = { x0: z.right.x, x1: z.right.x + z.right.w };
          assert.equal(z.left.x + z.left.w, z.lane.x, tag + ': the left zone ends where the lane starts');
          assert.equal(z.lane.x + z.lane.w, R.x0, tag + ': the lane ends where the right zone starts');
          assert.equal(R.x1, left + w, tag + ': the zones fill the strip');
          assert.equal(S.tight, w - STRIP_ZONE.left - STRIP_ZONE.right < STRIP_ZONE.tightBelow);
          if (!S.tight) { assert.equal(z.left.w, STRIP_ZONE.left); assert.equal(z.right.w, STRIP_ZONE.right); }
          // every disc on the strip: stations that show, You, the Board, the core and the fold chip
          const discs = [];
          for (const [k, s] of S.at) if (s.r > 0) discs.push({ k, ...s });
          discs.push({ k: 'core', ...S.core });
          const shown = discs.filter(d => d.k.startsWith('w')).length;
          if (S.fold) {
            discs.push({ k: 'chip', ...S.fold.chip });
            assert.equal(S.fold.n, n - shown, tag + ': every worker is shown or folded');
            for (const id of S.fold.ids) assert.equal(S.at.get(id).r, 0);
          } else assert.equal(shown, n, tag + ': all workers shown');
          for (const d of discs) {
            assert.ok(d.x - d.r >= z.lane.x - 0.5 && d.x + d.r <= z.lane.x + z.lane.w + 0.5, `${tag}: ${d.k} leaves the lane`);
          }
          for (let i = 0; i < discs.length; i++) {
            for (let j = i + 1; j < discs.length; j++) {
              const p = discs[i], q = discs[j];
              assert.ok(Math.hypot(p.x - q.x, p.y - q.y) >= p.r + q.r + 1.5, `${tag}: ${p.k} and ${q.k} overlap`);
            }
          }
          // worker stations stay at least minStep apart, so their circles never touch
          const ws = discs.filter(d => d.k.startsWith('w')).sort((a, b) => a.x - b.x);
          for (let i = 1; i < ws.length; i++) assert.ok(ws[i].x - ws[i - 1].x >= STRIP_ZONE.minStep - 0.5, `${tag}: workers closer than the minimum step`);
          // names (shown only when there is room): one line each, inside the lane, none meeting a neighbour
          if (S.labels) {
            for (const d of ws) assert.ok(d.x - S.labelW / 2 >= z.lane.x - 0.5 && d.x + S.labelW / 2 <= z.lane.x + z.lane.w + 0.5, `${tag}: a name leaves the lane`);
            for (let i = 1; i < ws.length; i++) assert.ok(ws[i].x - ws[i - 1].x >= S.labelW - 0.5, `${tag}: two names overlap`);
          }
          assert.equal(S.wide, z.lane.w >= STRIP_ZONE.ticker);
          assert.ok(S.labelBottom < S.tickerY, `${tag}: the ticker line is below the names`);
        }
      }
    }
  }
});

test('narrow slots fold the extra workers into a "+N" chip and keep the first in the list', () => {
  const S = stripLayout({ left: 0, top: 0, width: 453, height: H }, workers(6), false, null, { all: true });
  assert.ok(S.tight && S.fold && S.fold.n > 0);
  assert.equal(S.fold.ids[0], `w${6 - S.fold.n}`, 'the first workers in the list are the ones kept');
  assert.equal(stripLayout({ left: 0, top: 0, width: 1600, height: H }, workers(8), false).fold, null, 'a wide strip folds nothing');
  assert.equal(stripLayout({ left: 0, top: 0, width: 453, height: H }, workers(0), false).fold, null);
});

test('the screenshot case (1004 wide, ALL shown) is no longer a special case', () => {
  const S = stripLayout({ left: 0, top: 0, width: 1004, height: H }, workers(3), false, null, { all: true });
  assert.equal(S.zones.lane.w, 1004 - STRIP_ZONE.left - STRIP_ZONE.right);
  assert.equal(S.tight, false);
  assert.ok(S.at.get('you').x - 12 >= STRIP_ZONE.left, 'You clears the meters and the ALL button');
  assert.ok(S.at.get('board').x + 12 <= 1004 - STRIP_ZONE.right, 'Board clears the Needs you pill');
});

test('a phone strip has no zones and keeps its old geometry', () => {
  const S = stripLayout({ left: 0, top: 0, width: 390, height: 50 }, workers(2), true);
  assert.equal(S.zones, null);
  assert.equal(S.fold, null);
  assert.equal(S.wide, false);
  assert.equal(S.at.get('you').x, 26);
  assert.equal(S.at.get('board').x, 390 - 26);
  assert.equal(S.core.x, 195);
});

test('the All projects bays stay inside the lane', () => {
  const P = n => Array.from({ length: n }, (_, i) => ({ name: `p${i}`, count: 0, workers: [], state: 'idle' }));
  for (const w of [440, 453, 560, 720, 1004, 1280, 1652]) {
    const S = stripLayout({ left: 0, top: 0, width: w, height: H }, [], false);
    const laneL = S.zones.lane.x, laneR = laneL + S.zones.lane.w, board = S.at.get('board');
    for (const n of [1, 3, 6, 12, 20]) {
      const { bays, more } = hubBays({ left: 0, top: 0, width: w, height: H }, P(n), false, { core: S.core, you: S.at.get('you'), rightEnd: board.x + board.r });
      const half = b => (b.mode === 'full' ? b.w : b.mode === 'icon' ? 40 : 20) / 2;
      for (const b of bays) {
        assert.ok(b.x - half(b) >= laneL - 0.5, `w=${w} n=${n}: a bay leaves the lane at the left`);
        assert.ok(b.x + half(b) <= laneR + 0.5, `w=${w} n=${n}: a bay leaves the lane at the right`);
      }
      if (more) assert.ok(more.x - 10 >= laneL && more.x + 10 <= laneR, `w=${w} n=${n}: "+N" is in the lane`);
    }
  }
});

test('the CSS keys off the zone variables and class, with no breakpoint of its own', () => {
  const map = read('map.css'), usage = read('usage.css'), js = read('map.js');
  assert.doesNotMatch(map, /@container hud \(max-width:979px\)/);
  assert.doesNotMatch(usage, /@container hud \(max-width:979px\)/);
  for (const v of ['--zl', '--zr', '--lane-x', '--lane-w', '--tick-y']) assert.ok(js.includes(`'${v}'`), `${v} is written by the map`);
  assert.match(js, /classList\.toggle\('strip-zoned'/);
  assert.match(js, /classList\.toggle\('strip-wide'/);
  assert.match(js, /classList\.toggle\('strip-tight'/);
  assert.match(map, /\.strip-zoned\.strip-wide \.hud-read-l/);
  assert.match(usage, /var\(--zl/);
  assert.match(usage, /\.strip-tight \.um-l/, 'the tight strip drops the meter words');
  assert.match(map, /\.hud:not\(\.docked\) \.hud-read-r \.hud-needs\{pointer-events:none\}/, 'an invisible pill takes no clicks while the map is open');
  assert.match(map, /\.strip-tight \.hud-read-r \.hud-needs \.nl/, 'the tight pill drops the word, not the count');
  assert.doesNotMatch(map, /\.hud-read-r \.hud-needs>span\{[^}]*ellipsis/, 'no cut-off words in the pill');
});
