// The phone header, from Matt's iPhone screenshot: even spacing around the name and chip, no dark box behind the
// chip, and a list whose top line fades under the header's edge instead of being sliced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = f => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const phone = s => s.slice(s.lastIndexOf('@media (max-width:720px){'));

test('the chip draws its fill and outline in a layer with its own corners, so no square shows around it', () => {
  const p = phone(css('style.css'));
  assert.match(p, /\.main-head button\.mchip::before\{[^}]*border-radius:inherit/);
  assert.match(p, /\.main-head button\.mchip,[^{]*\{[^}]*background:none/);
  assert.doesNotMatch(p, /mchip::after/, 'the old pill-shaped outline is gone');
});

test('air between the name and the chip, and the same 12 px after Back at every width', () => {
  assert.match(phone(css('style.css')), /\.title-block h1\{[^}]*margin-bottom:5px/);
  const hud = css('hud.css');
  assert.equal((hud.match(/\.back\{[^}]*margin-right:(\d+)px/g) || []).map(r => r.match(/margin-right:(\d+)px/)[1]).join(','), '6,6');
});

test('the list fades in over its top 12 px on phones', () => {
  assert.match(phone(css('style.css')), /\.feed\{-webkit-mask-image:linear-gradient\(transparent,#000 12px\);mask-image:linear-gradient\(transparent,#000 12px\)\}/);
});

test('table cells keep words whole; long paths and links may still break', () => {
  const s = css('style.css');
  assert.match(s, /\.md-table th,\.md-table td\{[^}]*overflow-wrap:break-word/);
  assert.match(s, /\.md-table :is\(code,a\)\{overflow-wrap:anywhere\}/);
  assert.match(s, /\.md-table-box\{[^}]*overflow-x:auto/, 'the table box, never the page, scrolls as a last resort');
});
