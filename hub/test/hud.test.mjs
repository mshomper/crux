// The HUD frame (decision 33 A, M008 pass 2): the boot readout's words, and that the frame's colours stay readable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bootRows } from '../public/hud.js';

const css = name => readFileSync(fileURLToPath(new URL(`../public/${name}`, import.meta.url)), 'utf8');
const HUD = css('hud.css'), BASE = css('style.css'), MAP = css('map.css');

test('the boot readout says what the hub knows when it opens', () => {
  const rows = bootRows({ project: 'crux', agents: 4, working: 2, waiting: 3 });
  assert.deepEqual(rows.map(r => r.k), ['Memory board', 'Agents', 'Needs you', 'Link']);
  assert.deepEqual(rows.map(r => r.v), ['crux', '4, 2 working', '3', 'up']);
  assert.equal(rows[2].hot, true, 'red only when something waits on Matt');
  const calm = bootRows({ project: 'crux', agents: 1 });
  assert.deepEqual(calm.map(r => r.v), ['crux', '1', 'all clear', 'up']);
  assert.equal(calm[2].hot, false);
  assert.deepEqual(bootRows().map(r => r.v), ['no project', 'none yet', 'all clear', 'up']);
});

// ---- contrast: WCAG ratio of a colour (with alpha) over a stack of backgrounds ----
const token = (src, name) => { const m = new RegExp(`${name}:([^;}]+)`).exec(src); assert.ok(m, `${name} is defined`); return m[1].trim(); };
function rgba(v) {
  if (v.startsWith('#')) { const h = v.slice(1); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).concat(1); }
  const n = v.match(/[\d.]+/g).map(Number);
  return [n[0], n[1], n[2], n[3] ?? 1];
}
const over = (top, under) => { const [r, g, b, a] = rgba(top), u = typeof under === 'string' ? rgba(under) : under; return [r * a + u[0] * (1 - a), g * a + u[1] * (1 - a), b * a + u[2] * (1 - a), 1]; };
const lum = c => { const [r, g, b] = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (fg, bg) => { const a = lum(over(fg, bg)), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };

test('text and labels on the HUD plates keep at least 4.5 to 1', () => {
  const bg = token(BASE, '--bg');
  const plate = over(token(HUD, '--hud-plate'), bg), red = over(token(HUD, '--hud-plate-red'), bg), deep = over(token(HUD, '--hud-deep'), bg);
  const pairs = [
    ['message and card text on a plate', token(BASE, '--text'), plate],
    ['card text on a card waiting for Matt', token(BASE, '--text'), red],
    ['muted text on a plate', token(BASE, '--muted'), plate],
    ['muted text on a card waiting for Matt', token(BASE, '--muted'), red],
    ['faint text on the page', token(BASE, '--faint'), rgba(bg)],
    ['mono labels on the page', token(HUD, '--hud-label'), rgba(bg)],
    ['mono labels on a plate', token(HUD, '--hud-label'), plate],
    ['mono labels on a card waiting for Matt', token(HUD, '--hud-label'), red],
    ['the thread title on the page', token(MAP, '--hud-ice'), rgba(bg)],
    ['typed text in the message box', token(BASE, '--text'), deep],
    ['the send button label', token(MAP, '--hud-ice'), over('rgba(111,227,255,.14)', bg)]
  ];
  for (const [what, fg, on] of pairs) {
    const r = ratio(fg, on);
    assert.ok(r >= 4.5, `${what}: ${r.toFixed(2)} to 1`);
  }
});

test('the frame hangs off one attribute, and red is kept for what waits on Matt', () => {
  const rules = HUD.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.trim()).filter(r => r.includes('{'));
  const own = /^(\.hud-|\.hc-|@|html\[data-hud|from|to|\d+%)/;
  for (const r of rules) {
    const sel = r.slice(0, r.indexOf('{')).trim();
    // split the selector list on commas, but not the commas inside :is(...) or :not(...)
    const parts = []; let depth = 0, cur = '';
    for (const ch of sel) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && !depth) { parts.push(cur); cur = ''; } else cur += ch; }
    parts.push(cur);
    for (const s of parts) assert.ok(own.test(s.trim()), `"${s.trim().slice(0, 60)}" is scoped to the HUD frame`);
  }
  const redRules = rules.filter(r => /--hud-red\b|--hud-redline\b|242,114,122/.test(r.slice(r.indexOf('{'))) && r.startsWith('html[data-hud]') && !r.includes('--hud-redline:'));
  assert.ok(redRules.length > 0);
  for (const r of redRules) assert.match(r.slice(0, r.indexOf('{')), /decision:not\(\.done\)|\.hot|hud-boot/, `red only on waiting things: ${r.slice(0, 70)}`);
});

test('nothing moves under reduced motion', () => {
  const block = HUD.slice(HUD.lastIndexOf('@media (prefers-reduced-motion:reduce)'));
  assert.match(block, /\.hud-boot\{display:none\}/, 'no boot sequence');
  assert.match(block, /\.card\.flash\{animation:none/, 'the lock-on becomes a still outline');
  assert.match(block, /\.empty::before\{animation:none\}/);
});
