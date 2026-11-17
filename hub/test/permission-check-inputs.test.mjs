// M054 (shadow comparison of 2026-11-17): what the one-shot check is given. The text of an uncommitted or changed script
// (capped, or said to be not shown), the house rules in its rules text, and a test hub started with nohup counting as started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { makeTmp } from './helpers/tmp.mjs';
import { scriptsFor, parseCommand } from '../lib/permission-scripts.mjs';
import { buildPrefix, buildSuffix, scriptTexts, SCRIPT_MAX_BYTES, SCRIPT_MAX_FILES, SCRIPT_MAX_TOTAL } from '../lib/permission-check.mjs';
import { classify } from '../lib/permission-rules.mjs';

const dir = makeTmp('crux-check-inputs-');
const f = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };

test('scriptTexts: an uncommitted script is shown; committed ones are left out', () => {
  const a = f('a.mjs', 'console.log("hi")');
  const r = scriptTexts([{ path: a, kind: 'uncommitted' }, { path: join(dir, 'c.mjs'), kind: 'committed' }]);
  assert.deepEqual(r, [{ path: a, text: 'console.log("hi")' }]);
});

test('scriptTexts: too big, binary, unreadable, secret-named and too many are "not shown", never cut; unresolved entries are not here (plain doubts)', () => {
  const big = f('big.mjs', 'x'.repeat(SCRIPT_MAX_BYTES + 1));
  const bin = f('bin.mjs', 'a\u0000b');
  const sec = f('.env.mjs', 'KEY=1');
  const r = scriptTexts([
    { path: big, kind: 'uncommitted' }, { path: bin, kind: 'uncommitted' }, { path: join(dir, 'gone.mjs'), kind: 'uncommitted' },
    { path: sec, kind: 'uncommitted' }, { path: '(node)', kind: 'unknown', note: 'no such program' }, { path: join(dir, 'nope.mjs'), kind: 'missing', note: 'the file does not exist' }
  ]);
  assert.equal(r.length, 4, 'an unknown or missing entry is a doubt, not a not-shown file');
  assert.ok(r.every(x => x.text === undefined && x.note), 'none carries text');
  assert.match(r[0].note, /too big/);
  assert.match(r[1].note, /not a text file/);
  assert.match(r[2].note, /could not be read/);
  assert.match(r[3].note, /secret or key/);
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
  assert.match(p, /Escalate only when a script FILE the command runs exists but is listed as not shown/);
  assert.match(p, /an ordinary doubt: judge it like any request/);
  assert.match(p, /"Temp folders this worker made" \(the hub's own record\)/);
  assert.match(p, /Edit or Write tool, not with sed -i/);
  assert.match(p, /--no-agents/);
  assert.match(p, /folders the worker made in its own worktree or in the temp folder/);
  assert.match(p, /obviously fake one/, 'the dummy-key exception (R012) is still there');
});

// A fake git: tracked = file names git calls committed and clean; dirty = tracked but changed (as in permission-check-gate.test.mjs).
const fakeGit = ({ tracked = [], dirty = [] }) => async (args) => {
  const name = args.at(-1);
  if (args[0] === 'ls-files') return { code: tracked.includes(name) ? 0 : 1, out: '' };
  if (args[0] === 'status') return { code: 0, out: dirty.includes(name) ? ` M ${name}\n` : '' };
  if (args[0] === 'merge-base') return { code: 0, out: 'abc\n' };
  if (args[0] === 'diff') return { code: dirty.includes(name) ? 1 : 0, out: '' };
  return { code: 1, out: '' };
};
const project = (files) => { const d = makeTmp('crux-check-chain-'); for (const [n, t] of Object.entries(files)) writeFileSync(join(d, n), t); return d; };

test('a committed script that imports a changed file: the changed file\'s text is shown, not the unchanged top script', async () => {
  const d = project({ 'top.mjs': 'import "./dep.mjs"; console.log("TOP-UNCHANGED")', 'dep.mjs': 'console.log("DEP-CHANGED")' });
  const git = fakeGit({ tracked: ['top.mjs', 'dep.mjs'], dirty: ['dep.mjs'] });
  const r = await scriptsFor('node top.mjs', { cwd: d, projectDir: d, git });
  assert.equal(r.scripts[0].kind, 'uncommitted');
  assert.deepEqual(r.scripts[0].files.map(x => basename(x.path)), ['dep.mjs']);
  const shown = scriptTexts(r.scripts);
  assert.equal(shown.length, 1);
  assert.match(shown[0].path, /dep\.mjs$/);
  assert.match(shown[0].text, /DEP-CHANGED/);
  assert.ok(!shown.some(x => /TOP-UNCHANGED/.test(x.text || '')), 'the unchanged top file is skipped');
});

test('a committed script that loads a file by a computed name, or one that is not there: a not-shown line naming the file', async () => {
  const d = project({ 'top.mjs': 'const n = "x"; await import("./" + n + ".mjs");', 'gone.mjs': 'import "./missing.mjs"' });
  const git = fakeGit({ tracked: ['top.mjs', 'gone.mjs'] });
  const a = scriptTexts((await scriptsFor('node top.mjs', { cwd: d, projectDir: d, git })).scripts);
  assert.equal(a.length, 1); assert.match(a[0].path, /top\.mjs$/); assert.match(a[0].note, /named at run time, not shown/);
  const b = scriptTexts((await scriptsFor('node gone.mjs', { cwd: d, projectDir: d, git })).scripts);
  assert.equal(b.length, 1); assert.match(b[0].note, /missing\.mjs.*could not be found/);
});

test('an unread command shape is a doubt, not a not-shown file: a log redirect and a $TEMP script path do not make the arguments "built at run time"', async () => {
  const d = project({ 'x.mjs': 'console.log(1)' });
  const p = parseCommand('node x.mjs > "$TEMP/hub.log" 2>&1', { cwd: d });
  assert.deepEqual(p.unread, [], JSON.stringify(p.unread));
  assert.equal(p.files.length, 1);
  const t = makeTmp('crux-check-tmpscript-');
  const rel = relative(tmpdir(), t).replace(/\\/g, '/');
  writeFileSync(join(t, 's.mjs'), 'console.log("TEMP-SCRIPT")');
  const r = await scriptsFor(`node "$TEMP/${rel}/s.mjs"`, { cwd: d, projectDir: d, git: fakeGit({}) });
  assert.ok(r.scripts.every(s => s.kind === 'uncommitted'), `resolved to a real file, not "built at run time": ${JSON.stringify(r.scripts)}`);
  assert.match(scriptTexts(r.scripts)[0].text, /TEMP-SCRIPT/);
});

test('buildSuffix lists the temp folders this worker made (the hub\'s record), newest 20', () => {
  assert.match(buildSuffix({ worker: 'w', tool: 'Bash', input: {}, nonce: 'n' }), /Temp folders this worker made \(the hub's own record\): none/);
  const many = Array.from({ length: 25 }, (_, i) => `C:/t/d${i}`);
  const s = buildSuffix({ worker: 'w', tool: 'Bash', input: {}, madeTemp: new Set(many), nonce: 'n' });
  assert.match(s, /d24/); assert.ok(!/d4,|d4$|d4\n/.test(s) && !/d0,/.test(s), 'only the newest 20');
});

test('nohup and timeout wrap either way round, and a hard stop under them stays a hard stop', () => {
  const base = { tool: 'Bash', projectDir: 'C:/proj', cwd: 'C:/proj', agent: 'w', level: 'auto' };
  for (const command of ['nohup rm -rf /', 'nohup git push origin main', 'nohup node server.mjs --port 4747', 'nohup cat ~/.ssh/id_rsa', 'timeout 5 nohup git push --force origin main', 'nohup timeout 5 rm -rf /', 'nohup timeout 5 node server.mjs --port 4748']) {
    const c = classify({ ...base, input: { command } });
    assert.equal(c.route, 'human', `${command}: ${c.route} ${c.unsure}`);
  }
  const ok = classify({ ...base, input: { command: 'timeout 60 nohup node server.mjs --port 4803 "$TEMP/p"' } });
  assert.deepEqual(ok.hubsStarted, [4803], `${ok.route} ${ok.unsure}`);
  const ok2 = classify({ ...base, input: { command: 'nohup timeout 60 node server.mjs --port 4804 "$TEMP/p"' } });
  assert.deepEqual(ok2.hubsStarted, [4804], `${ok2.route} ${ok2.unsure}`);
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
