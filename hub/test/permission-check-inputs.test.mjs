// M054 (shadow comparison of 2026-11-17): what the one-shot check is given. The text of an uncommitted or changed script
// (capped, or said to be not shown), the house rules in its rules text, and a test hub started with nohup counting as started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { buildPrefix, buildSuffix, scriptTexts, SCRIPT_MAX_BYTES, SCRIPT_MAX_FILES, SCRIPT_MAX_TOTAL } from '../lib/permission-check.mjs';
import { classify } from '../lib/permission-rules.mjs';

const dir = makeTmp('crux-check-inputs-');
const f = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };

test('scriptTexts: an uncommitted script is shown; committed ones are left out', () => {
  const a = f('a.mjs', 'console.log("hi")');
  const r = scriptTexts([{ path: a, kind: 'uncommitted' }, { path: join(dir, 'c.mjs'), kind: 'committed' }]);
  assert.deepEqual(r, [{ path: a, text: 'console.log("hi")' }]);
});

test('scriptTexts: too big, binary, unreadable, secret-named, unresolved and too many are "not shown", never cut', () => {
  const big = f('big.mjs', 'x'.repeat(SCRIPT_MAX_BYTES + 1));
  const bin = f('bin.mjs', 'a\u0000b');
  const sec = f('.env.mjs', 'KEY=1');
  const r = scriptTexts([
    { path: big, kind: 'uncommitted' }, { path: bin, kind: 'uncommitted' }, { path: join(dir, 'gone.mjs'), kind: 'uncommitted' },
    { path: sec, kind: 'uncommitted' }, { path: '(node)', kind: 'unknown', note: 'no such program' }
  ]);
  assert.equal(r.length, 5);
  assert.ok(r.every(x => x.text === undefined && x.note), 'none carries text');
  assert.match(r[0].note, /too big/);
  assert.match(r[1].note, /not a text file/);
  assert.match(r[2].note, /could not be read/);
  assert.match(r[3].note, /secret or key/);
  assert.equal(r[4].note, 'no such program');
  const many = Array.from({ length: SCRIPT_MAX_FILES + 2 }, (_, i) => ({ path: f(`m${i}.mjs`, 'y'.repeat(1000)), kind: 'uncommitted' }));
  const m = scriptTexts(many);
  assert.equal(m.filter(x => x.text).length, SCRIPT_MAX_FILES);
  assert.equal(m.filter(x => x.note).length, 2, 'the rest are listed as not shown');
  const half = SCRIPT_MAX_TOTAL / 3;
  const t = scriptTexts([1, 2, 3, 4].map(i => ({ path: f(`t${i}.mjs`, 'z'.repeat(Math.min(half, SCRIPT_MAX_BYTES))), kind: 'uncommitted' })));
  assert.ok(t.filter(x => x.text).reduce((s, x) => s + x.text.length, 0) <= SCRIPT_MAX_TOTAL, 'the total is capped');
  assert.ok(t.some(x => /too much script text/.test(x.note || '')));
});

test('buildSuffix: the script text sits in a marked block, and a script not shown is said so', () => {
  const s = buildSuffix({ worker: 'w', tool: 'Bash', input: { command: 'node a.mjs' }, nonce: 'n1', scripts: [{ path: 'C:/p/a.mjs', text: 'console.log(1)' }, { path: 'C:/p/b.mjs', note: 'too big to show' }] });
  assert.match(s, /<<<n1 script C:\/p\/a\.mjs>>>\nconsole\.log\(1\)\n<<<n1 end>>>/);
  assert.match(s, /Script C:\/p\/b\.mjs is not shown: too big to show/);
  assert.ok(!/is not shown/.test(buildSuffix({ worker: 'w', tool: 'Bash', input: { command: 'ls' }, nonce: 'n1' })), 'nothing extra without scripts');
});

test('buildPrefix: the rules text carries the script fact and the house rules', () => {
  const p = buildPrefix({ project: 'x', dir: 'C:\\x', temp: 'C:\\t', level: 'Auto', rulesId: 'R005', rulesBody: 'rules' });
  assert.match(p, /not shown \(too big, unreadable, or kept back\), you have not seen it: escalate/);
  assert.match(p, /Edit or Write tool, not with sed -i/);
  assert.match(p, /--no-agents/);
  assert.match(p, /folders the worker made in its own worktree or the temp folder/);
  assert.match(p, /obviously fake one/, 'the dummy-key exception (R012) is still there');
});

test('a test hub started with nohup counts as started, so a later stop of that port is the worker\'s own', () => {
  const base = { tool: 'Bash', projectDir: 'C:/proj', cwd: 'C:/proj/hub', agent: 'w', level: 'auto' };
  const start = classify({ ...base, input: { command: 'CRUX_HUB_DATA="$TEMP/d" CRUX_HOME="$TEMP/h" nohup node server.mjs --port 4801 "$TEMP/p" > "$TEMP/l.log" 2>&1 &' } });
  assert.deepEqual(start.hubsStarted, [4801], `${start.route}: ${start.reasons} ${start.unsure}`);
  const plain = classify({ ...base, input: { command: 'CRUX_HUB_DATA="$TEMP/d" CRUX_HOME="$TEMP/h" node server.mjs --port 4802 "$TEMP/p"' } });
  assert.deepEqual(plain.hubsStarted, [4802]);
  const live = classify({ ...base, input: { command: 'nohup node server.mjs --port 4747' } });
  assert.equal(live.route, 'human', 'the live port stays a hard stop');
  assert.deepEqual(live.hubsStarted, []);
  const stop = classify({ ...base, hubs: [4801], input: { command: 'node tools/stop-test-hub.mjs 4801' } });
  assert.ok(!stop.unsure.some(u => /has not started a hub/.test(u)), 'its own port: no doubt');
});
