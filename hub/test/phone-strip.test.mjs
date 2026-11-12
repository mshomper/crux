// The strip on a phone, from Matt's iPhone (2026-11-11): the plan meters ran into the stations, and the glow
// sat on the labels. The meters get a row of their own; the map keeps to the lane above it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripLane, stripLayout, blendLayouts, radialLayout, PHONE_METER_ROW } from '../public/map-layout.js';
import { outerScale } from '../public/map-hud.js';

const pub = f => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const STRIP_H = 50;                      // the phone strip's height (map.css --hud-h)
const WIDTHS = [320, 360, 390, 430];
const workers = n => Array.from({ length: n }, (_, i) => ({ id: `w${i}` }));
const slot = w => ({ left: 0, top: 59, width: w, height: STRIP_H });   // 59: an iPhone's top safe area

test('the strip is no taller than before, and the meters\' row is the same number in the styles and the layout', () => {
  assert.match(pub('map.css'), /@media \(max-width:720px\)\{\s*:root\{--hud-h:50px\}/, 'still 50px on a phone');
  const css = pub('usage.css');
  const phone = css.slice(css.indexOf('.hud-slot[data-under-row]'));
  assert.match(phone, new RegExp(`\\.hud-slot\\[data-under-row\\] \\.hud\\.docked\\{bottom:${PHONE_METER_ROW}px\\}`), 'the map panel stops above the row');
  assert.match(phone, new RegExp(`\\.usage-meters\\{[^}]*bottom:0;[^}]*height:${PHONE_METER_ROW}px;box-sizing:border-box`), 'the row is exactly that tall');
  assert.match(pub('usage-ui.js'), /dataset\.underRow = '1'; else delete this\.slot\.dataset\.underRow/, 'the row is claimed only while there are meters');
  assert.match(pub('map.js'), /stripLane\(this\.slot\.getBoundingClientRect\(\), this\.phone, !!this\.slot\.dataset\.underRow\)/);
});

test('the lane: the whole strip, minus the meters\' row only on a phone that shows meters', () => {
  const r = slot(390);
  assert.deepEqual(stripLane(r, true, true), { left: 0, top: 59, width: 390, height: STRIP_H - PHONE_METER_ROW });
  assert.equal(stripLane(r, true, false).height, STRIP_H, 'no meters: the map keeps the full strip');
  assert.equal(stripLane({ left: 268, top: 0, width: 900, height: 124 }, false, true).height, 124, 'desktop is untouched');
  assert.equal(stripLane({ left: 0, top: 0, width: 320, height: 8 }, true, true).height, 0, 'never negative');
});

test('320 to 430px: every station, ring and badge stays inside the lane, clear of the meters\' row', () => {
  for (const w of WIDTHS) for (const n of [0, 1, 3, 8]) {
    const lane = stripLane(slot(w), true, true);
    const L = stripLayout(lane, workers(n), true);
    const top = lane.top, bottom = lane.top + lane.height;
    const meterTop = slot(w).top + STRIP_H - PHONE_METER_ROW;
    assert.equal(bottom, meterTop, 'the lane ends where the row starts');
    // the core: its sphere and the tick scale around it (1.18 r, long ticks 5px); the outer scale is not drawn here
    const coreReach = L.core.r * 1.18 + 5;
    assert.ok(L.core.y - coreReach >= top && L.core.y + coreReach <= bottom, `core fits at ${w}px (reach ${coreReach.toFixed(1)})`);
    // a station: its body, the ring 3px out, and a working station's turning dashes 5px out
    for (const [id, s] of L.at) {
      const reach = s.r + 5;
      assert.ok(s.y - reach >= top && s.y + reach <= bottom, `${id} fits at ${w}px with ${n} workers`);
      assert.ok(s.x - reach >= 0 && s.x + reach <= w, `${id} is on screen at ${w}px`);
      assert.ok(Math.abs(s.x - L.core.x) - reach >= coreReach, `${id} is clear of the core at ${w}px`);
    }
  }
});

test('320 to 430px: stations do not sit on each other, up to the eight a phone shows', () => {
  for (const w of WIDTHS) {
    const L = stripLayout(stripLane(slot(w), true, true), workers(8), true);
    const xs = [...L.at.values()].map(s => s.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 12, `stations ${i - 1} and ${i} at ${w}px are ${(xs[i] - xs[i - 1]).toFixed(1)}px apart`);
  }
});

test('the core\'s outer scale is left out of a phone\'s strip and fades in as the map opens, with no jump', () => {
  assert.equal(outerScale(true, 0), 0, 'not drawn in the phone strip');
  assert.equal(outerScale(false, 0), 1, 'the desktop strip keeps it');
  assert.equal(outerScale(true, 0.25), 0.5);
  // the layout stops being "compact" halfway through the zoom: the scale is already full there
  const lane = stripLane(slot(390), true, true);
  const A = stripLayout(lane, workers(2), true), B = radialLayout({ left: 0, top: 0, width: 390, height: 844 }, workers(2), true);
  const before = blendLayouts(A, B, 0.499, { x: 0, y: 0 }), after = blendLayouts(A, B, 0.5, { x: 0, y: 0 });
  assert.ok(Math.abs(outerScale(before.compact, 0.499) - outerScale(after.compact, 0.5)) < 0.01);
});

test('the glow is tamed on a phone only: tight station glow, dimmer backdrop, and the panel clips the rest', () => {
  const css = pub('map.css');
  assert.match(css, /\.hud\{[^}]*overflow:hidden/, 'the map panel clips its own light');
  const glow = /\.hud\.phone\.docked \.hs \.hs-body\{box-shadow:([^}]*)\}/.exec(css)?.[1] || '';
  const blur = Number(/,0 0 (\d+)px/.exec(glow)?.[1]);
  assert.ok(blur > 0 && blur <= 6, `a phone station glows ${blur}px, not the desktop's 18px or more`);
  assert.match(glow, /currentColor/, 'the glow keeps the station\'s own colour (model hue; red only for Matt\'s call)');
  assert.match(css, /\.hud\.phone\.docked \.hud-bg\{opacity:\.\d+\}/);
  assert.doesNotMatch(css.replace(/\.hud\.phone\.docked[^{]*\{[^}]*\}/g, ''), /\.hs-body\{[^}]*0 0 5px/, 'the desktop station styles are as they were');
});

test('the Board station does not inherit the board panel\'s line and full-height box (same class name)', () => {
  assert.match(pub('style.css'), /\.board::before\{content:""/, 'the panel still has its own edge line');
  const css = pub('map.css');
  assert.match(css, /\.hud \.hs\.board::before\{content:none\}/);
  assert.match(css, /\.hud \.hs\.board\{inset:0 auto auto 0;height:0;/);
});

test('the corner brackets are left out of a phone\'s strip, where they would cross the end stations', () => {
  assert.match(pub('map.css'), /\.hud\.phone\.docked \.hud-corner\{display:none\}/);
});

test('the header on a phone: Back is a framed button with air before the name; a project opens on its orchestrator', () => {
  const css = pub('hud.css');
  const phone = css.slice(css.indexOf('/* ---------- phone ---------- */'));
  const back = /html\[data-hud\] \.back\{([^}]*)\}/.exec(phone)?.[1] || '';
  assert.match(back, /border:1px solid var\(--hud-edge\)/);
  assert.match(back, /width:46px;height:46px/, 'at least a 44px target');
  assert.match(back, /margin-right:6px/);
  assert.doesNotMatch(css.slice(0, css.indexOf('/* ---------- phone ---------- */')), /\.back\{/, 'phone only');
  // a project opens on its orchestrator, unless threads are pinned there (decision 39; columns.js projectOpened)
  assert.match(pub('app.js'), /\[data-project\]'\); if \(pj\) \{[^}]*return openProject\(\); \}/);
  assert.match(pub('columns.js'), /projectOpened\(\) \{[^}]*if \(!this\.state\.cols\.some\(c => c\.pinned\)\) this\.open\('orchestrator'\); \}/);
});
