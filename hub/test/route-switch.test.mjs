// Decision 21's switch in the sidebar (route-switch.js): plain words both ways, amber mark only when off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routeSwitch } from '../public/route-switch.js';

test('on: the orchestrator answers routine requests, risky ones still come to you; no amber mark', () => {
  const r = routeSwitch({ on: true, rules: 'R005' });
  assert.equal(r.word, 'Orchestrator answers');
  assert.equal(r.warn, false);
  assert.match(r.tip, /every project/i);
  assert.match(r.tip, /R005/);
  assert.match(r.tip, /risky ones always come to you/);
});

test('on without rules on the board says they still come to you', () => {
  assert.match(routeSwitch({ on: true }).tip, /no rules on the board yet/);
});

test('off: everything to you, with the amber mark', () => {
  const r = routeSwitch({ on: false });
  assert.equal(r.word, 'All to you');
  assert.equal(r.warn, true);
  assert.match(r.tip, /interrupts you/);
});

test('the bare shield button is gone from the thread header; the switch lives under the hub name', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('id="route-perms"'), 'no icon-only toggle in the header');
  const side = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));
  assert.ok(side.indexOf('id="hub-switches"') > side.indexOf('side-head') && side.indexOf('id="hub-switches"') < side.indexOf('id="projects"'), 'above the project picker');
});
