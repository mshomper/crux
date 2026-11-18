// M054 (shadow comparison of 2026-11-17): what the one-shot check is given. The text of an uncommitted or changed script
// (capped, or said to be not shown), the house rules in its rules text, and a test hub started with nohup counting as started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename, relative } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { makeTmp } from './helpers/tmp.mjs';
import { scriptsFor, parseCommand, isCommittedFile, changedDiff, defaultGit, resolveJoinTemp } from '../lib/permission-scripts.mjs';
import { buildPrefix, buildSuffix, scriptTexts, SCRIPT_MAX_BYTES, SCRIPT_MAX_FILES, SCRIPT_MAX_TOTAL, SCRIPT_FACT, TEST_RUN_FACT, HOUSE_RULES_FACT } from '../lib/permission-check.mjs';
import { classify } from '../lib/permission-rules.mjs';

const dir = makeTmp('crux-check-inputs-');
const f = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };

test('scriptTexts: an uncommitted script is shown; committed ones are left out', async () => {
  const a = f('a.mjs', 'console.log("hi")');
  const r = await scriptTexts([{ path: a, kind: 'uncommitted' }, { path: join(dir, 'c.mjs'), kind: 'committed' }]);
  assert.deepEqual(r, [{ path: a, text: 'console.log("hi")' }]);
});

test('scriptTexts: too big, binary, unreadable, secret-named and too many are "not shown", never cut; unresolved entries are not here (plain doubts)', async () => {
  const big = f('big.mjs', 'x'.repeat(SCRIPT_MAX_BYTES + 1));
  const bin = f('bin.mjs', 'a\u0000b');
  const sec = f('.env.mjs', 'KEY=1');
  const r = await scriptTexts([
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
  const m = await scriptTexts(many);
  assert.equal(m.filter(x => x.text).length, SCRIPT_MAX_FILES);
  assert.equal(m.filter(x => x.note).length, 2, 'the rest are listed as not shown');
  const half = SCRIPT_MAX_TOTAL / 3;
  const t = await scriptTexts([1, 2, 3, 4].map(i => ({ path: f(`t${i}.mjs`, 'z'.repeat(Math.min(half, SCRIPT_MAX_BYTES))), kind: 'uncommitted' })));
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
  assert.match(p, /Otherwise escalate for an unseen script only when a script FILE the command runs exists but is listed as not shown/);
  assert.match(p, /A script file that does not exist runs nothing .*so a missing file is an ordinary doubt, not an unseen script: do not escalate for that alone, but if the same command writes that file first, judge what it writes/);
  assert.match(p, /an ordinary doubt: judge it like any request/);
  assert.match(p, /"Temp folders this worker made" \(the hub's own record\)/);
  assert.match(p, /Edit or Write tool, not with sed -i/);
  assert.match(p, /--no-agents/);
  assert.match(p, /folders the worker made in its own worktree or in the temp folder/);
  assert.match(p, /obviously fake value, whatever prefix it carries/, 'the dummy-key exception (R012) is still there');
});

// M063 (2026-11-18): the three facts replayed on the shadow log's escalations, and the house-rules clause PR #139 made unnecessary.
test('buildPrefix: the plain test-run fact comes right after the script fact; the temp-scripts clause is gone from the house rules', () => {
  const p = buildPrefix({ project: 'x', dir: 'C:\\x', temp: 'C:\\t', level: 'Auto', rulesId: 'R005', rulesBody: 'rules' });
  assert.ok(p.includes(SCRIPT_FACT) && p.includes(TEST_RUN_FACT) && p.includes(HOUSE_RULES_FACT));
  assert.ok(p.indexOf(SCRIPT_FACT) + SCRIPT_FACT.length + 1 === p.indexOf(TEST_RUN_FACT), 'the line right after the script line');
  assert.ok(p.indexOf(TEST_RUN_FACT) < p.indexOf(HOUSE_RULES_FACT));
  for (const bit of ['A plain test run is fine even when a test file, or a module it loads, is listed as not shown (too big, or over the count).', 'A plain test run is `node --test <files>` (or `npm test`)',
    'under a test folder inside the worker\'s own worktree (the folder named in "Runs in", under .claude/worktrees)', 'starts no other program, deletes only folders the worker made, and sends nothing over the network',
    'A test run from the main project folder (not a worktree), a test file outside the project, or a test run joined to anything else in that list follows the other rules.']) assert.ok(p.includes(bit), bit);
  assert.ok(!/worker's own temp scripts/.test(p) && !/this holds for/.test(p), 'the clause is dropped');
  assert.match(p, /or an inline script that rewrites a file \(deny, and say to use Edit\)\. A test hub/);
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
  const shown = await scriptTexts(r.scripts);
  assert.equal(shown.length, 1);
  assert.match(shown[0].path, /dep\.mjs$/);
  assert.match(shown[0].text, /DEP-CHANGED/);
  assert.ok(!shown.some(x => /TOP-UNCHANGED/.test(x.text || '')), 'the unchanged top file is skipped');
});

test('a load named at run time: a not-shown line when the file is changed, a plain doubt when it is committed and unchanged; a missing import is a doubt everywhere', async () => {
  const d = project({ 'top.mjs': 'const n = "x"; await import("./" + n + ".mjs");', 'gone.mjs': 'import "./missing.mjs"' });
  // unchanged (committed): the hub could not follow it, which is a doubt, not an unseen file
  const git = fakeGit({ tracked: ['top.mjs', 'gone.mjs'] });
  const ra = await scriptsFor('node top.mjs', { cwd: d, projectDir: d, git });
  assert.deepEqual(await scriptTexts(ra.scripts), [], 'nothing is "not shown"');
  assert.match(ra.scripts[0].doubts.join('\n'), /top\.mjs: it loads a file named at run time/);
  assert.equal(ra.scripts[0].doubts.length, 1, 'one line per file');
  const rb = await scriptsFor('node gone.mjs', { cwd: d, projectDir: d, git });
  assert.deepEqual(await scriptTexts(rb.scripts), []);
  assert.match(rb.scripts[0].doubts[0], /missing\.mjs, which could not be found/);
  // changed: its text is shown, and what it loads that nobody can see is a not-shown line; a missing import is still only a doubt
  const gitC = fakeGit({ tracked: ['top.mjs', 'gone.mjs'], dirty: ['top.mjs', 'gone.mjs'] });
  const a = await scriptTexts((await scriptsFor('node top.mjs', { cwd: d, projectDir: d, git: gitC })).scripts);
  assert.equal(a.length, 2); assert.match(a[0].text, /await import/); assert.match(a[1].note, /named at run time, not shown/);
  const b = await scriptTexts((await scriptsFor('node gone.mjs', { cwd: d, projectDir: d, git: gitC })).scripts);
  assert.equal(b.length, 1); assert.match(b[0].text, /missing\.mjs/);
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
  assert.match((await scriptTexts(r.scripts))[0].text, /TEMP-SCRIPT/);
});

test('more than 8 scripts: that is a not-shown line, not a doubt', async () => {
  const names = Array.from({ length: 10 }, (_, i) => `s${i}.mjs`);
  const d = project(Object.fromEntries(names.map(n => [n, 'console.log(1)'])));
  const r = await scriptsFor(names.map(n => `node ${n}`).join(' && '), { cwd: d, projectDir: d, git: fakeGit({}) });
  const shown = await scriptTexts(r.scripts);
  assert.ok(shown.some(x => /more scripts/.test(x.path) && /rest are not listed/.test(x.note)), JSON.stringify(shown.map(x => x.path)));
});

// ---- a real git repository: the known answer, the one-pass state, the diff of a big changed file ----
const realGit = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
function realRepo(files) {
  const d = makeTmp('crux-check-real-');
  mkdirSync(join(d, 'tools'), { recursive: true }); mkdirSync(join(d, 'test'), { recursive: true });
  for (const [n, t] of Object.entries(files)) writeFileSync(join(d, n), t);
  realGit(d, 'init', '-q', '-b', 'main'); realGit(d, 'config', 'user.email', 'a@b.c'); realGit(d, 'config', 'user.name', 'T'); realGit(d, 'config', 'commit.gpgsign', 'false');
  realGit(d, 'add', '-A'); realGit(d, 'commit', '-q', '-m', 'c');
  return d;
}
const TOOL = {
  'tools/stop-test-hub.mjs': 'import "./relaunch.mjs"; console.log("stop")', 'tools/relaunch.mjs': 'import "../server.mjs"; import "./nope.mjs";',
  'server.mjs': 'const m = "./" + process.argv[2]; await import(m);',
  'test/x.test.mjs': 'import test from "node:test"; test("a", () => {});', 'test/y.test.mjs': 'import test from "node:test"; test("b", () => {});'
};

test('known answer: only test/x.test.mjs changed, then stopping its own test hub and running that test give no not-shown line', async () => {
  const d = realRepo(TOOL);
  writeFileSync(join(d, 'test', 'x.test.mjs'), 'import test from "node:test"; test("a-changed", () => {});');
  const stop = await scriptsFor('node tools/stop-test-hub.mjs 4801', { cwd: d, projectDir: d });
  assert.deepEqual(await scriptTexts(stop.scripts), [], 'every file in that chain is unchanged: no text, no not-shown line');
  assert.ok(stop.scripts[0].doubts.length >= 1, 'what the hub could not follow there is a doubt');
  assert.ok(stop.scripts[0].doubts.every(x => /relaunch\.mjs|server\.mjs/.test(x)));
  const run = await scriptsFor('node --test test/x.test.mjs', { cwd: d, projectDir: d });
  const shown = await scriptTexts(run.scripts);
  assert.equal(shown.length, 1); assert.match(shown[0].text, /a-changed/); assert.ok(!shown.some(x => x.note));
  const other = await scriptsFor('node --test test/y.test.mjs', { cwd: d, projectDir: d });
  assert.equal(other.scripts[0].kind, 'committed', 'an unchanged test is still committed (one pass over the repository gives the same answer)');
});

test('the one-pass answer matches the per-file answer on a real repository: tracked, changed, untracked, ignored, staged, and in a new folder', async () => {
  const d = realRepo({ 'a.mjs': '1', 'b.mjs': '2', 'c.mjs': '3', '.gitignore': 'ig.mjs\n' });
  writeFileSync(join(d, 'b.mjs'), 'changed');
  writeFileSync(join(d, 'new.mjs'), 'new'); writeFileSync(join(d, 'ig.mjs'), 'ig');
  writeFileSync(join(d, 'c.mjs'), 'staged'); realGit(d, 'add', 'c.mjs');
  mkdirSync(join(d, 'newdir')); writeFileSync(join(d, 'newdir', 'n.mjs'), 'n');
  const perFile = file => isCommittedFile(file, { projectDir: d, git: (args, cwd) => defaultGit(args, cwd) });   // a wrapper is not defaultGit itself: the per-file questions
  for (const n of ['a.mjs', 'b.mjs', 'c.mjs', 'new.mjs', 'ig.mjs', 'newdir/n.mjs']) {
    const file = join(d, n);
    assert.equal(await isCommittedFile(file, { projectDir: d }), await perFile(file), n);
  }
  assert.equal(await isCommittedFile(join(d, 'a.mjs'), { projectDir: d }), true);
  assert.equal(await isCommittedFile(join(d, 'newdir', 'n.mjs'), { projectDir: d }), false);
});

test('a changed file over the cap is shown as its change from main; only a change over the cap, or an untracked file, is not shown', async () => {
  const big = Array.from({ length: 600 }, (_, i) => `const line${i} = ${i}; // padding padding padding`).join('\n');
  assert.ok(big.length > SCRIPT_MAX_BYTES);
  const d = realRepo({ 'big.mjs': big, 'other.mjs': big });
  writeFileSync(join(d, 'big.mjs'), big + '\nconsole.log("ONE-LINE-CHANGE");');
  writeFileSync(join(d, 'other.mjs'), big.replace(/padding/g, 'rewritten'));   // every line changed: the diff is over the cap too
  writeFileSync(join(d, 'untracked.mjs'), big);
  const r = await scriptTexts([{ path: join(d, 'big.mjs'), kind: 'uncommitted' }, { path: join(d, 'other.mjs'), kind: 'uncommitted' }, { path: join(d, 'untracked.mjs'), kind: 'uncommitted' }], { diff: file => changedDiff(file) });
  assert.equal(r[0].diff, true); assert.match(r[0].text, /ONE-LINE-CHANGE/); assert.ok(r[0].text.length <= SCRIPT_MAX_BYTES);
  assert.match(r[1].note, /change from main is too big too/);
  assert.match(r[2].note, /no change from main to show instead/);
  assert.match(buildSuffix({ worker: 'w', tool: 'Bash', input: {}, nonce: 'n', scripts: [r[0]] }), /script .*big\.mjs \(its change from main, as a diff/);
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

test('deleting the home folder itself is a hard stop, under nohup or not; a folder inside the project is not', () => {
  const home = homedir().replace(/\\/g, '/');
  const base = { tool: 'Bash', projectDir: `${home}/proj`, cwd: `${home}/proj`, agent: 'w', level: 'auto' };
  const posix = home.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  for (const command of ['rm -rf ~', 'rm -rf ~/', 'rm -rf $HOME', 'rm -rf "$HOME"', `rm -rf ${home}`, `rm -rf ${posix}`, 'rm -rf %USERPROFILE%', 'nohup rm -rf ~', 'timeout 5 nohup rm -rf $HOME', 'rm -r -f ~']) {
    const c = classify({ ...base, input: { command } });
    assert.equal(c.route, 'human', `${command}: ${c.route} ${c.unsure}`);
    assert.match(c.reasons.join(' '), /home folder itself/, command);
  }
  const ps = classify({ ...base, tool: 'PowerShell', input: { command: 'Remove-Item -Recurse -Force $env:USERPROFILE' } });
  assert.equal(ps.route, 'human'); assert.match(ps.reasons.join(' '), /home folder itself/);
  const inside = classify({ ...base, input: { command: 'rm -rf ./build' } });
  assert.notEqual(inside.route, 'human', `a folder inside the project: ${inside.reasons}`);
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
