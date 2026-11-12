// Decision 36: what the meters and the panel say, without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { meterHtml, metersHtml, metersLabel, panelHtml, isStale, STALE_MS } from '../public/usage-ui.js';
import { meterList, normalizePlan } from '../public/usage.js';
import { MODEL_HUES } from '../public/models.js';

const now = Date.parse('2026-11-11T20:00:00Z');
const reset = '2026-11-13T00:00:00Z';
const plan = (over = {}) => ({
  subscription: 'max', extra: null, asOf: new Date(now - 30_000).toISOString(),
  windows: { five_hour: { key: 'five_hour', label: '5-hour', pct: 41, resetsAt: '2026-11-11T22:10:00Z' }, seven_day: { key: 'seven_day', label: '7-day', pct: 53, resetsAt: reset } },
  models: [{ key: 'fable', label: 'Fable', pct: 20, resetsAt: reset }], statuses: {}, ...over
});
const tone = (html, key) => new RegExp(`class="um t-(\\w+)[^"]*" data-meter="${key}"`).exec(html)?.[1];
const dayRow = (agent, models, ts = new Date(now - 3600e3).toISOString()) => ({ project: 'demo', ev: { type: 'usage', ts, agent, models } });
const d = (cost, input = 100, output = 10) => ({ cost, input, output, cacheRead: 0, cacheCreation: 0 });

test('the strip shows 5-hour, 7-day and Fable, with percent and time to reset', () => {
  const html = metersHtml(meterList(plan()), now);
  assert.deepEqual([...html.matchAll(/data-meter="([\w-]+)"/g)].map(m => m[1]), ['five_hour', 'seven_day', 'fable']);
  assert.match(html, />41%</);
  assert.match(html, />2h 10m</);
  assert.match(html, />1d 4h</);
  assert.match(html, /--mh:#d58a58/, 'Fable is copper (decision 20)');
  assert.ok(html.includes(MODEL_HUES.fable));
});

test('colours: ok below 80, amber from 80 or at a warning, red only when rejected', () => {
  assert.deepEqual(['five_hour', 'seven_day', 'fable'].map(k => tone(metersHtml(meterList(plan()), now), k)), ['ok', 'ok', 'ok']);
  const hot = plan({ windows: { five_hour: { key: 'five_hour', label: '5-hour', pct: 80, resetsAt: reset }, seven_day: { key: 'seven_day', label: '7-day', pct: 99, resetsAt: reset } } });
  assert.deepEqual(['five_hour', 'seven_day'].map(k => tone(metersHtml(meterList(hot), now), k)), ['amber', 'amber']);
  const warned = plan({ statuses: { seven_day: 'allowed_warning' } });
  assert.equal(tone(metersHtml(meterList(warned), now), 'seven_day'), 'amber', 'a warning at 53%');
  const rejected = plan({ statuses: { five_hour: 'rejected' } });
  const html = metersHtml(meterList(rejected), now);
  assert.equal(tone(html, 'five_hour'), 'red');
  assert.equal(tone(html, 'seven_day'), 'ok', 'only the blocked window is red');
  assert.doesNotMatch(metersHtml(meterList(hot), now), /t-red/, 'full is not red until it is refused');
});

test('an idle 5-hour window is shown as idle, not as zero', () => {
  const idle = plan({ windows: { five_hour: null, seven_day: plan().windows.seven_day } });
  const html = metersHtml(meterList(idle), now);
  assert.match(html, /class="um t-ok idle" data-meter="five_hour"/);
  assert.match(html, />–</);
  assert.match(metersLabel(meterList(idle), idle, now), /5-hour: no window running/);
});

test('no plan: nothing to show, so the meters hide', () => {
  assert.equal(metersHtml(meterList(null), now), '');
  assert.equal(metersHtml(meterList(normalizePlan({ rate_limits_available: false, rate_limits: null })), now), '');
});

test('an old snapshot is stale and says when it was read', () => {
  assert.equal(isStale(plan(), now), false);
  const old = plan({ asOf: new Date(now - STALE_MS - 1000).toISOString() });
  assert.equal(isStale(old, now), true);
  assert.match(metersLabel(meterList(old), old, now), /Last read at/);
  assert.match(panelHtml({ plan: old, rows: [], now }), /Last read at/);
});

test('the panel: plan windows with reset times, spend labelled as an estimate, per model and per agent, Fable\'s share', () => {
  const rows = [
    dayRow('orchestrator-1', { 'claude-fable-5-2': d(6), 'claude-haiku-5-5': d(0.02) }),
    dayRow('usage-meters', { 'claude-sonnet-5-5': d(2) })
  ];
  const html = panelHtml({ plan: plan({ extra: { pct: 25.1 } }), rows, bootAt: now - 7200e3, range: 'session', now });
  for (const needle of ['5-hour', '7-day', 'Fable (7-day)', 'Resets in 2h 10m', 'Extra usage credits', 'Max plan', 'Estimated spend', 'estimated', 'not a bill', 'By model', 'By agent', 'orchestrator-1', 'usage-meters', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5', "Fable's share", '75% of spend', '$8.02']) {
    assert.ok(html.includes(needle), needle);
  }
  assert.match(html, /aria-selected="true" data-range="session"/);
});

test('the panel: the period is today or since the hub started; with nothing logged it says so', () => {
  const yesterday = dayRow('old', { 'claude-opus-5-5': d(50) }, new Date(now - 36 * 3600e3).toISOString());
  const rows = [yesterday, dayRow('now', { 'claude-opus-5-5': d(3) }, new Date(now - 600e3).toISOString())];
  const since = panelHtml({ plan: plan(), rows, bootAt: now - 3600e3, range: 'session', now });
  assert.ok(since.includes('$3.00') && !since.includes('$53.00') && !since.includes('$50.00'));
  assert.match(panelHtml({ plan: plan(), rows: [], bootAt: now, range: 'session', now }), /Nothing since the hub started/);
  assert.match(panelHtml({ plan: plan(), rows: [], range: 'today', now }), /Nothing logged today/);
});

test('with several projects the panel names the project beside each agent', () => {
  const rows = [dayRow('a', { 'claude-opus-5-5': d(1) })];
  assert.ok(panelHtml({ plan: plan(), rows, multi: true, range: 'session', bootAt: 0, now }).includes('demo / a'));
  assert.ok(!panelHtml({ plan: plan(), rows, multi: false, range: 'session', bootAt: 0, now }).includes('demo / a'));
});

test('the meters are not on the core: they live in the strip\'s slot, and the core readout is untouched', () => {
  const ui = readFileSync(new URL('../public/usage-ui.js', import.meta.url), 'utf8');
  const readout = readFileSync(new URL('../public/map-readout.js', import.meta.url), 'utf8');
  const map = readFileSync(new URL('../public/map.js', import.meta.url), 'utf8');
  assert.match(ui, /slot\.append\(this\.el\)/);
  for (const f of [readout, map]) assert.doesNotMatch(f, /usage|plan_usage|meter/i, 'no usage code in the map or the core readout');
});

test('no horizontal scroll: the meters and panel set no fixed width wider than the screen', () => {
  const css = readFileSync(new URL('../public/usage.css', import.meta.url), 'utf8');
  assert.match(css, /@container hud \(max-width:720px\)/, 'a phone layout');
  assert.doesNotMatch(css, /overflow-x:\s*(auto|scroll)/);
  assert.match(readFileSync(new URL('../public/usage-ui.js', import.meta.url), 'utf8'), /innerWidth - 24|innerWidth - 16/, 'the panel is sized from the window');
});
