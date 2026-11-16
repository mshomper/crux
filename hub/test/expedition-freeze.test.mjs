// The Expedition module, phase 4 (spec 4.5): the frozen success test. Three layers, each with its own tests:
//  1. the copy and the hash: at the gate the hub keeps test/ outside the worktree (frozen/), and checkFrozen compares and restores;
//  2. the Track A rule: plain writes into test/ and frozen/ are refused (classify-level path spellings, the hub's answer, and
//     the PreToolUse hook, which is where acceptEdits workers' edits are seen). It is narrow on purpose (Matt, 2026-11-16, M042);
//  3. the real guard: an edit the rule misses is found at the next loop result (or the finish) and put back.
// Agents are stubbed: nothing starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync, readdirSync, openSync, closeSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { recordAgents, stubHub, StubExpedition, quietMark, quietProblems } from './helpers/expedition-stub.mjs';
import { cruxTools } from '../lib/tools.mjs';
import { classify, frozenWrite } from '../lib/permission-rules.mjs';

const sent = recordAgents();
const WIN = process.platform === 'win32';

// One expedition past its gate (test/ frozen), with a Lead and a Builder; and a second, plain worker.
function world({ gate = true } = {}) {
  sent.length = 0;
  const env = stubHub({ level: 'auto' });
  const se = new StubExpedition(env, { question: 'Which of two JSON libraries is faster' });
  se.ex.write('BRIEF.md', '# q\n'); se.ex.write('test/CHECKLIST.md', '1. a table\n2. a benchmark\n'); se.ex.write('test/run.json', '{"command":"node bench.mjs"}\n');
  se.ex.start();
  se.startRole('lead', env.orch.name);
  se.startRole('builder', se.agents.lead.name);
  if (gate) se.ex.gate({ verdict: 'approve' });
  const plain = env.hub.startWorker(env.p, 'plain', 'Do a thing', env.orch.name, 'Do a thing');
  const lead = se.agents.lead;
  const rt = cruxTools(env.hub, env.p, lead).instance._registeredTools;
  const call = async (name, args) => (await rt[name].handler(args, {})).content[0].text;
  return { env, se, ex: se.ex, hub: env.hub, p: env.p, lead, builder: se.agents.builder, plain, call };
}
const answers = p => p.log.ofType('permission_answer');

// ---------- 1. the copy and the hash ----------
test('the gate keeps a copy of test/ outside the worktree, hashes both alike, and logs the hash once', () => {
  const { ex, p } = world();
  assert.deepEqual(readdirSync(ex.frozenDir).sort(), ['CHECKLIST.md', 'run.json']);
  assert.equal(readFileSync(join(ex.frozenDir, 'CHECKLIST.md'), 'utf8'), readFileSync(join(ex.testDir, 'CHECKLIST.md'), 'utf8'));
  assert.equal(ex.frozenDir.startsWith(ex.worktree), false, 'the copy is not inside the build worktree');
  assert.equal(ex.frozenDir, join(p.dir, '.crux', 'expeditions', '.frozen', ex.id));
  assert.equal(ex.frozenDir.startsWith(ex.root), false, 'nor inside the expedition\'s own folder: one rm of that cannot take test/ and its copy together');
  assert.equal(ex.files().some(f => f.includes('.frozen')), false);
  assert.equal(ex.state().gate.testHash, ex.testHash());
  assert.deepEqual(ex.checkFrozen('loop'), { checked: true, ok: true });
  assert.equal(p.log.ofType('expedition_integrity').length, 0, 'a clean check logs nothing');
  // The copy is the hub's: an expedition's own files never include a frozen/ name for an agent to address.
  assert.throws(() => ex.path('frozen/CHECKLIST.md'), /not a file of an expedition/);
});

test('before the gate nothing is checked and nothing is locked', async () => {
  const { ex, hub, p, builder } = world({ gate: false });
  assert.deepEqual(ex.checkFrozen('loop'), { checked: false });
  assert.deepEqual(hub.frozenDirs(p, builder), []);
  // Amendments are possible until the gate closes: the freeze rule is not in play (the hook lets the edit through, and the
  // permission callback's answer, whatever the older .crux rule makes of it, is not the frozen-test refusal).
  const hook = builder.options().hooks.PreToolUse[0].hooks[0];
  assert.deepEqual(await hook({ tool_name: 'Edit', tool_input: { file_path: join(ex.testDir, 'CHECKLIST.md'), old_string: 'a', new_string: 'b' }, tool_use_id: 'x', cwd: p.dir }), {});
  const r = await hub.requestApproval(p, builder, 'Write', { file_path: join(ex.testDir, 'CHECKLIST.md'), content: 'amended' });
  assert.doesNotMatch(r.message || '', /frozen success test/);
});

test('checkFrozen restores a changed, added, removed or emptied test/, logs it, and names what differed', () => {
  const { ex, p } = world();
  const orig = readFileSync(join(ex.testDir, 'CHECKLIST.md'), 'utf8');
  const cases = [
    ['a changed file', () => writeFileSync(join(ex.testDir, 'CHECKLIST.md'), '1. everything passes\n'), ['CHECKLIST.md (changed)']],
    ['an added file', () => writeFileSync(join(ex.testDir, 'extra.md'), 'x'), ['extra.md (added)']],
    ['a removed file', () => rmSync(join(ex.testDir, 'run.json')), ['run.json (removed)']],
    ['a file in a new folder', () => { mkdirSync(join(ex.testDir, 'sub')); writeFileSync(join(ex.testDir, 'sub', 'a.md'), 'x'); }, ['sub/a.md (added)']],
    ['everything removed', () => rmSync(ex.testDir, { recursive: true, force: true }), ['CHECKLIST.md (removed)', 'run.json (removed)']]
  ];
  for (const [what, tamper, changed] of cases) {
    tamper();
    const r = ex.checkFrozen('loop');
    assert.deepEqual([r.ok, r.restored, r.changed], [false, true, changed], what);
    assert.equal(ex.testHash(), ex.state().gate.testHash, `${what}: test/ is back as frozen`);
    assert.equal(readFileSync(join(ex.testDir, 'CHECKLIST.md'), 'utf8'), orig, what);
    assert.deepEqual(ex.checkFrozen('loop'), { checked: true, ok: true }, `${what}: and the next check is clean`);
  }
  const evs = p.log.ofType('expedition_integrity');
  assert.equal(evs.length, cases.length);
  assert.ok(evs.every(e => e.expedition === ex.id && e.at === 'loop' && e.restored === true && /^[0-9a-f]{64}$/.test(e.expectedHash) && e.foundHash !== e.expectedHash));
  assert.equal(ex.state().integrity.length, cases.length);
});

test('a link planted where test/ was is not followed: it hashes as a link, and is replaced by the real copy', () => {
  const { ex } = world();
  const elsewhere = join(dirname(ex.root), 'elsewhere');
  mkdirSync(elsewhere);
  for (const f of readdirSync(ex.testDir)) writeFileSync(join(elsewhere, f), readFileSync(join(ex.testDir, f)));   // identical content, behind a link
  rmSync(ex.testDir, { recursive: true });
  try { symlinkSync(elsewhere, ex.testDir, 'junction'); } catch (e) { return void console.warn('no link made here:', e.code); }
  const r = ex.checkFrozen('finish');
  assert.deepEqual([r.ok, r.restored], [false, true], 'same bytes behind a link still differ from the frozen copy');
  assert.equal(ex.state().integrity.at(-1).at, 'finish');
  assert.deepEqual(readdirSync(elsewhere).sort(), ['CHECKLIST.md', 'run.json'], 'what the link pointed at is untouched');
  assert.deepEqual(ex.checkFrozen('finish'), { checked: true, ok: true });
});

// ---------- review round 1 of #108 ----------
test('MEDIUM: caches a test run leaves beside the test are not tampering (known answer: __pycache__ next to test_x.py)', async () => {
  sent.length = 0;
  const env = stubHub({ level: 'auto' });
  const se = new StubExpedition(env, { question: 'Which JSON library is faster in Python' });
  const ex = se.ex;
  ex.write('BRIEF.md', '# q\n'); ex.write('test/test_x.py', 'def test_x():\n    assert 1 == 1\n');
  mkdirSync(join(ex.testDir, '__pycache__')); writeFileSync(join(ex.testDir, '__pycache__', 'test_x.cpython-312.pyc'), 'old bytecode');   // there already at the gate: not copied
  ex.start();
  se.startRole('lead', env.orch.name);
  ex.gate({ verdict: 'ok' });
  assert.deepEqual(readdirSync(ex.frozenDir), ['test_x.py'], 'the stored copy holds the test only');
  const call = async (n, a) => (await cruxTools(env.hub, env.p, se.agents.lead).instance._registeredTools[n].handler(a, {})).content[0].text;
  // A run in test/ leaves its usual files.
  mkdirSync(join(ex.testDir, '__pycache__'), { recursive: true });
  writeFileSync(join(ex.testDir, '__pycache__', 'test_x.cpython-312.pyc'), 'new bytecode');
  writeFileSync(join(ex.testDir, '__pycache__', 'other.pyc'), 'x');
  writeFileSync(join(ex.testDir, 'stray.pyc'), 'x');
  mkdirSync(join(ex.testDir, '.pytest_cache', 'v', 'cache'), { recursive: true }); writeFileSync(join(ex.testDir, '.pytest_cache', 'v', 'cache', 'lastfailed'), '{}');
  mkdirSync(join(ex.testDir, 'node_modules', 'm'), { recursive: true }); writeFileSync(join(ex.testDir, 'node_modules', 'm', 'index.js'), 'x');
  assert.deepEqual(ex.checkFrozen('loop'), { checked: true, ok: true });
  assert.equal(await call('expedition_loop_result', { passing: 1 }), 'Loop 1: 1 passing, progress.');
  assert.equal(await call('expedition_loop_result', { passing: 2 }), 'Loop 2: 2 passing, progress.');
  assert.equal(env.p.log.ofType('expedition_integrity').length, 0, 'no false alarm, so no no-progress stop from one either');
  // Real changes still count: a changed source file, a new .py, a name that only looks like a cache.
  for (const [what, tamper] of [['a changed test file', () => writeFileSync(join(ex.testDir, 'test_x.py'), 'def test_x():\n    pass\n')], ['a new .py', () => writeFileSync(join(ex.testDir, 'test_y.py'), 'x')],
    ['a look-alike name', () => writeFileSync(join(ex.testDir, 'pycache.py'), 'x')], ['a .pyc-looking name that is not one', () => writeFileSync(join(ex.testDir, 'x.pyc.py'), 'x')], ['node_modules.js', () => writeFileSync(join(ex.testDir, 'node_modules.js'), 'x')]]) {
    tamper();
    assert.equal(ex.checkFrozen('loop').ok, false, what);
  }
  assert.equal(ex.testHash(), ex.state().gate.testHash);
});

test('LOW: a restore swaps a prepared copy in by rename, so a file held open cannot leave test/ half-deleted', () => {
  const { ex, p } = world();
  const orig = readFileSync(join(ex.testDir, 'CHECKLIST.md'), 'utf8');
  writeFileSync(join(ex.testDir, 'CHECKLIST.md'), '1. trivially true\n');
  writeFileSync(join(ex.testDir, 'extra.md'), 'x');
  const held = openSync(join(ex.testDir, 'extra.md'), 'r');   // a process still has a file of test/ open (Windows refuses to move the folder)
  let r;
  try { r = ex.checkFrozen('loop'); } finally { closeSync(held); }
  if (r.restored) {
    assert.equal(ex.testHash(), ex.state().gate.testHash, 'where the system lets the folder move, it is restored whole');
  } else {
    assert.equal(r.ok, false);
    assert.match(r.why, /test\/ was left as found/);
    assert.equal(readFileSync(join(ex.testDir, 'CHECKLIST.md'), 'utf8'), '1. trivially true\n', 'not half-deleted: every file is still there, as found');
    assert.deepEqual(readdirSync(ex.testDir).sort(), ['CHECKLIST.md', 'extra.md', 'run.json']);
    assert.equal(p.log.ofType('expedition_integrity').at(-1).restored, false);
    assert.equal(ex.checkFrozen('loop').restored, true, 'and the next check, with nothing open, restores it');
  }
  assert.equal(readFileSync(join(ex.testDir, 'CHECKLIST.md'), 'utf8'), orig);
  assert.deepEqual(readdirSync(ex.root).filter(n => n.startsWith('.test-')), [], 'no leftover temporary folders');
  assert.deepEqual(readdirSync(ex.testDir).sort(), ['CHECKLIST.md', 'run.json']);
});

test('LOW: removing the whole expedition folder does not take the stored copy with it, and the rule refuses the .frozen folder too', async () => {
  const { ex, p, builder, hub } = world();
  rmSync(ex.root, { recursive: true, force: true });
  assert.equal(readdirSync(ex.frozenDir).length, 2, 'the copy survives');
  assert.deepEqual(hub.frozenDirs(p, builder).map(d => d.replace(/\\/g, '/').split('/.crux/')[1]), [`expeditions/${ex.id}/test`, 'expeditions/.frozen']);
  const r = await hub.requestApproval(p, builder, 'Bash', { command: 'rm -rf .crux/expeditions/.frozen' });
  assert.match(r.message, /^Not allowed: Writes into the frozen success test/);
});

test('if the frozen copy itself was changed nothing can be restored, and that is said', () => {
  const { ex } = world();
  writeFileSync(join(ex.frozenDir, 'CHECKLIST.md'), 'copy tampered');
  writeFileSync(join(ex.testDir, 'CHECKLIST.md'), 'test tampered');
  const r = ex.checkFrozen('loop');
  assert.deepEqual([r.ok, r.restored], [false, false]);
  assert.match(r.why, /frozen copy itself no longer matches/);
  assert.equal(readFileSync(join(ex.testDir, 'CHECKLIST.md'), 'utf8'), 'test tampered', 'test/ is left as found rather than overwritten by a copy that cannot be trusted');
  assert.equal(ex.state().integrity.at(-1).restored, false);
});

// ---------- 2. the Track A rule: plain writes only ----------
function paths() {
  const { ex, p } = world();
  const t = ex.testDir, f = ex.frozenDir, wt = ex.worktree;
  return { ex, p, dirs: [t, ex.frozenRoot], t, f, wt, project: p.dir, id: ex.id };   // as hub.frozenDirs: test/ and the folder of stored copies
}
const sh = (command, tool = 'Bash') => ({ tool, input: { command } });

test('file tools: absolute and relative spellings of a path inside test/ or frozen/ are refused', () => {
  const { dirs, t, f, wt, project, id } = paths();
  const at = (tool, field, value, cwd) => frozenWrite(tool, { [field]: value }, { dirs, cwd, projectDir: project });
  const inTest = join(t, 'CHECKLIST.md'), inFrozen = join(f, 'run.json');
  const fromProject = x => relative(project, x), fromWorktree = x => relative(wt, x);
  for (const tool of ['Write', 'Edit', 'MultiEdit']) {
    assert.match(at(tool, 'file_path', inTest, project), /^Writes into the frozen success test/, tool);
    assert.ok(at(tool, 'file_path', inFrozen, project), `${tool}: the stored copy`);
  }
  assert.ok(at('NotebookEdit', 'notebook_path', join(t, 'a.ipynb'), project));
  assert.ok(at('Write', 'file_path', join(t, 'new-file.md'), project), 'a new file in test/ too');
  assert.ok(at('Write', 'file_path', join(t, 'sub', 'deeper', 'x.md'), project), 'and a new folder');
  // Relative: from the project folder, from the Builder's worktree (up three folders), with ./ and .. in the middle.
  assert.ok(at('Write', 'file_path', fromProject(inTest), project));
  assert.ok(at('Write', 'file_path', `./${fromProject(inTest).replace(/\\/g, '/')}`, project));
  assert.ok(at('Write', 'file_path', fromWorktree(inTest), wt), 'the worktree reaches the project\'s .crux by going up');
  assert.ok(at('Write', 'file_path', join(project, '.crux', 'expeditions', id, 'notes-1.md', '..', 'test', 'a.md'), project), '.. through a sibling');
  assert.ok(at('Write', 'file_path', join(wt, '..', '..', '..', '.crux', 'expeditions', id, 'test', 'a.md'), wt), 'an absolute path through the worktree and back out');
  assert.ok(at('Edit', 'file_path', `${project}/.crux/expeditions/${id}/test/a.md`, project), 'forward slashes');
  if (WIN) {
    assert.ok(at('Write', 'file_path', inTest.replace(/\\/g, '/'), project), 'forward slashes on Windows');
    assert.ok(at('Write', 'file_path', inTest.toUpperCase(), project), 'any case on Windows');
    assert.ok(at('Write', 'file_path', inTest[0].toLowerCase() + inTest.slice(1), project), 'a lower-case drive letter');
    assert.ok(at('Write', 'file_path', `\\\\?\\${inTest}`, project), 'the \\\\?\\ form');
    assert.ok(at('Write', 'file_path', `/${inTest[0].toLowerCase()}${inTest.slice(2).replace(/\\/g, '/')}`, project), 'Git Bash /c/... form');
    assert.ok(at('Write', 'file_path', fromWorktree(inTest).replace(/\\/g, '/'), wt));
  }
});

test('file tools: everything else is left to the normal rules (narrow on purpose)', () => {
  const { dirs, t, f, project, id } = paths();
  const root = join(project, '.crux', 'expeditions', id);
  const ok = (tool, p) => assert.equal(frozenWrite(tool, { file_path: p }, { dirs, cwd: project, projectDir: project }), null, p);
  ok('Write', join(root, 'REPORT.md'));
  ok('Write', join(root, 'verify', 'VERDICT.md'));
  ok('Write', join(root, 'notes-1.md'));
  ok('Write', join(root, 'test.md'));               // a look-alike name
  ok('Write', join(root, 'tests', 'a.md'));
  ok('Write', join(root, 'testing', 'a.md'));
  ok('Write', join(root, 'frozen2', 'a.md'));
  ok('Write', join(project, 'src', 'test', 'a.test.js'));   // the project's own test/ is not an expedition's
  ok('Write', join(project, 'test', 'a.md'));
  ok('Write', join(root, 'x', '..', 'REPORT.md'));
  // Reading is never refused here, whatever the path (Read, Glob, Grep are not writes).
  for (const tool of ['Read', 'Glob', 'Grep', 'WebFetch']) assert.equal(frozenWrite(tool, { file_path: join(t, 'CHECKLIST.md'), path: t, url: 'https://example.org' }, { dirs, cwd: project, projectDir: project }), null, tool);
  // No frozen folders (a plain agent, or before the gate): never anything.
  assert.equal(frozenWrite('Write', { file_path: join(t, 'a.md') }, { dirs: [], cwd: project, projectDir: project }), null);
  void f;
});

test('shell: redirections and mv, rm, sed -i, tee, cp, touch, Set-Content into test/ or frozen/ are refused; reading it is not', () => {
  const { dirs, t, f, wt, project, id } = paths();
  const rel = x => relative(project, x).replace(/\\/g, '/');
  const T = rel(t), F = rel(f);
  const chk = (c, o = {}) => frozenWrite(o.tool || 'Bash', { command: c }, { dirs, cwd: o.cwd || project, projectDir: project });
  const refused = [
    `echo x > ${T}/a.md`, `echo x >> ${T}/CHECKLIST.md`, `echo x>${T}/a.md`, `echo x 2> ${T}/e.log`, `echo x &> ${T}/e.log`, `cat a.md > "${T}/a b.md"`, `printf hi > '${T}/a.md'`,
    `echo x | tee ${T}/a.md`, `echo x | tee -a ${T}/CHECKLIST.md`, `mv a.md ${T}/a.md`, `mv ${T}/CHECKLIST.md /tmp/x`, `mv -f ${T} /tmp/gone`, `rm ${T}/run.json`, `rm -rf ${T}`, `rm -rf ${T}/`, `rm -f ${F}/CHECKLIST.md`, `rm -rf .crux/expeditions/.frozen`, `rm -rf .crux/expeditions/.frozen/20250101-another-one`, `echo x > .crux/expeditions/.frozen/${id}/run.json`,
    `sed -i s/a/b/ ${T}/CHECKLIST.md`, `sed -i'' s/a/b/ ${T}/CHECKLIST.md`, `sed -i.bak s/a/b/ ${T}/CHECKLIST.md`, `sed -Ei s/a/b/ ${T}/CHECKLIST.md`, `sed --in-place s/a/b/ ${T}/CHECKLIST.md`,
    `cp a.md ${T}/a.md`, `cp -r build ${T}/`, `cp a.md ${F}/a.md`, `touch ${T}/a.md`, `mkdir ${T}/sub`, `truncate -s 0 ${T}/CHECKLIST.md`,
    `echo ok && echo x > ${T}/a.md`, `ls; rm ${T}/run.json`, `true || echo x > ${T}/a.md`, `echo x > ./${T}/../test/a.md`,
    `echo x > ${t.replace(/\\/g, '/')}/a.md`, `rm "${t}${WIN ? '\\' : '/'}run.json"`,
    `cd ${T} && echo x > a.md`, `cd ${T}; rm run.json`, `cd .crux/expeditions/${id} && cd test && touch a.md`, `pushd ${T} && sed -i s/a/b/ CHECKLIST.md`
  ];
  for (const c of refused) assert.match(chk(c) || '', /^Writes into the frozen success test/, c);
  // From the Builder's worktree: up three folders, or the absolute path.
  const up = relative(wt, t).replace(/\\/g, '/');
  for (const c of [`echo x > ${up}/a.md`, `rm ${up}/run.json`, `cd ${up} && touch a.md`, `echo x > ${t.replace(/\\/g, '/')}/a.md`]) assert.ok(chk(c, { cwd: wt }), c);
  // PowerShell.
  const ps = (c, cwd) => chk(c, { tool: 'PowerShell', cwd });
  for (const c of [`Set-Content -Path ${T}/a.md -Value x`, `Set-Content ${T.replace(/\//g, '\\')}\\a.md x`, `Add-Content -Path '${T}/CHECKLIST.md' -Value x`, `'x' | Out-File ${T}/a.md`, `echo hi > ${T.replace(/\//g, '\\')}\\a.md`,
    `Remove-Item -Recurse -Force ${T}`, `Remove-Item .\\${T.replace(/\//g, '\\')}\\run.json`, `Move-Item a.md ${T}/a.md`, `Copy-Item a.md -Destination ${T}/a.md`, `New-Item -ItemType File ${T}/a.md`, `Clear-Content ${T}/CHECKLIST.md`, `ri ${T}/run.json`,
    `Set-Location ${T}; Set-Content a.md x`, `cd ${T}; 'x' > a.md`]) assert.match(ps(c, project) || '', /^Writes into the frozen success test/, c);
  // Reading, listing, copying FROM it and writing beside it are all fine.
  const fine = [`cat ${T}/CHECKLIST.md`, `ls ${T}`, `grep -r item ${T}`, `cp ${T}/CHECKLIST.md /tmp/copy.md`, `cp -r ${T} /tmp/test-copy`, `cp ${T}/run.json run.json`, `grep x ${T}/CHECKLIST.md > out.txt`, `sed -n 1p ${T}/CHECKLIST.md`, `sed s/a/b/ ${T}/CHECKLIST.md > out.md`,
    `node bench.mjs < ${T}/run.json`, `echo x > ${rel(join(project, '.crux', 'expeditions', id, 'REPORT.md'))}`, `echo x > .crux/expeditions/${id}/test2/a.md`, `echo x > notes.md`, `diff ${T}/CHECKLIST.md ${F}/CHECKLIST.md`, `sha256sum ${T}/*`, `echo x 2>&1`, `echo x >&2`,
    `cd ${T} && cat CHECKLIST.md`, `cd ${T} && cd .. && echo x > REPORT.md`, 'echo "no redirect > in this quoted text"', `git status`, `npm test`, `node ${T}/../../../../bench.mjs`];
  for (const c of fine) assert.equal(chk(c), null, c);
  assert.equal(ps(`Get-Content ${T}/CHECKLIST.md`, project), null);
  assert.equal(ps(`Copy-Item ${T}/CHECKLIST.md C:\\temp\\x.md`, project), null);
});

test('what the rule does not read is left to the hash check: variables, scripts, links (documented, not guaranteed)', () => {
  const { dirs, t, project } = paths();
  const T = relative(project, t).replace(/\\/g, '/');
  const miss = c => assert.equal(frozenWrite('Bash', { command: c }, { dirs, cwd: project, projectDir: project }), null, c);
  miss(`D=${T}; echo x > $D/a.md`);
  miss(`echo x > "${T}"/$(echo a).md`);
  miss(`node -e "require('fs').writeFileSync('${T}/a.md','x')"`);
  miss(`python -c "open('${T}/a.md','w').write('x')"`);
  miss(`bash -c 'echo x > ${T}/a.md'`);
  miss(`dd if=a.md of=${T}/a.md`);
});

test('classify: a frozen write is a stop of its own; without frozen folders the same request is as before', () => {
  const { dirs, t, wt, project } = paths();
  const base = { tool: 'Write', input: { file_path: join(t, 'CHECKLIST.md'), content: 'x' }, projectDir: project, cwd: wt, level: 'auto' };
  const c = classify({ ...base, frozen: dirs });
  assert.deepEqual([c.route, c.frozen], ['human', true]);
  assert.match(c.reasons[0], /frozen success test/);
  assert.deepEqual([c.tempMade, c.downloaded, c.hubsStarted], [[], [], []]);
  for (const lvl of ['standard', 'trusted']) assert.equal(classify({ ...base, frozen: dirs, level: lvl }).frozen, true, lvl);
  const plain = classify(base);
  assert.equal(plain.frozen, undefined, 'without frozen folders the freeze rule is not in play');
  assert.deepEqual(plain.reasons, ['Writes the hub\'s own log (.crux)'], 'only the older .crux rule speaks, as before');
  assert.equal(classify({ ...base, input: { file_path: join(project, 'src', 'a.js'), content: 'x' }, frozen: dirs }).route, 'allow', 'and other files are judged as before, frozen folders or not');
  assert.equal(classify({ tool: 'Bash', input: { command: `echo x > ${join(t, 'a.md').replace(/\\/g, '/')}` }, projectDir: project, cwd: wt, level: 'auto', frozen: dirs }).frozen, true);
  assert.equal(classify({ tool: 'Bash', input: { command: 'git status' }, projectDir: project, cwd: wt, level: 'auto', frozen: dirs }).route, 'allow');
});

// ---------- 2b. the hub: refused, not parked, not carded; keyed on the hub's own field ----------
test('an expedition agent\'s plain write to test/ after the gate is refused: no card, not parked, logged in its own thread', async () => {
  const { hub, p, ex, builder, lead, plain, env, se } = world();
  const mark = quietMark(env);
  const parked = p.log.ofType('expedition_parked').length, before = answers(p).length;
  const target = join(ex.testDir, 'CHECKLIST.md');
  for (const [agent, tool, input] of [[builder, 'Write', { file_path: target, content: 'weak' }], [builder, 'Edit', { file_path: target, old_string: '1.', new_string: '0.' }], [builder, 'MultiEdit', { file_path: target, edits: [] }],
    [lead, 'Bash', { command: `echo weak > "${target}"` }], [builder, 'Bash', { command: `rm ${join(ex.frozenDir, 'run.json')}` }], [builder, 'Bash', { command: 'sed -i s/a/b/ .crux/expeditions/' + ex.id + '/test/CHECKLIST.md' }]]) {
    const r = await hub.requestApproval(p, agent, tool, input);
    assert.equal(r.behavior, 'deny', `${agent.name} ${tool}`);
    assert.match(r.message, /^Not allowed: Writes into the frozen success test/);
  }
  const mine = answers(p).slice(before);
  assert.equal(mine.length, 6);
  assert.ok(mine.every(a => a.answer === 'deny' && a.by === 'hub' && a.expedition === se.id && a.approval === null && a.thread === (a.worker === lead.name ? lead.thread : builder.thread)));
  assert.equal(p.log.ofType('expedition_parked').length, parked, 'refused, not parked: nothing to propose as a next expedition');
  assert.equal(hub.approvals.size, 0);
  assert.equal(p.log.ofType('approval').length, 0);
  assert.deepEqual(quietProblems(env, mark, sent), []);
  assert.equal(readFileSync(target, 'utf8'), '1. a table\n2. a benchmark\n', 'and nothing was written (the hub never ran it)');
  // Anything else the builder does is judged as before: a read is fine, and a command that only reads test/ is fine.
  assert.equal((await hub.requestApproval(p, builder, 'Read', { file_path: target })).behavior, 'allow');
  assert.equal((await hub.requestApproval(p, builder, 'Bash', { command: `cat ${target}` })).behavior, 'allow');
  assert.equal((await hub.requestApproval(p, builder, 'Bash', { command: 'git status' })).behavior, 'allow');
  // A plain worker in the same project is not an expedition agent: it has no frozen folders, and the freeze refusal is never its answer.
  assert.deepEqual(hub.frozenDirs(p, plain), []);
  const asked = hub.requestApproval(p, plain, 'Write', { file_path: target, content: 'x' });
  assert.equal(await Promise.race([asked, new Promise(r => setTimeout(() => r('waiting'), 30))]), 'waiting', 'the older .crux rule makes it a card, as it always did');
  for (const a of hub.approvals.values()) a.finish({ behavior: 'deny', message: 'test' }, 'denied');
});

test('keyed on the hub\'s own record of the agent: another expedition\'s agent has its own frozen folders only, and what an agent writes changes nothing', async () => {
  const { hub, p, ex, builder, env } = world();
  // A second expedition, gate closed too: its builder may not write its own test/, but a path of the first one is not "its" frozen folder.
  const se2 = new StubExpedition(env, { question: 'Which sort is stable and fast' });
  se2.ex.write('BRIEF.md', '# q\n'); se2.ex.write('test/CHECKLIST.md', '1. sorted\n'); se2.ex.start();
  se2.startRole('lead', env.orch.name);
  const b2 = se2.startRole('builder', se2.agents.lead.name);
  assert.deepEqual(hub.frozenDirs(p, b2), [], 'its gate is still open');
  se2.ex.gate({ verdict: 'ok' });
  assert.deepEqual(hub.frozenDirs(p, b2), [se2.ex.testDir, se2.ex.frozenRoot]);
  assert.deepEqual(hub.frozenDirs(p, builder), [ex.testDir, ex.frozenRoot]);
  assert.equal((await hub.requestApproval(p, b2, 'Write', { file_path: join(se2.ex.testDir, 'CHECKLIST.md'), content: 'x' })).behavior, 'deny');
  assert.doesNotMatch((await hub.requestApproval(p, b2, 'Write', { file_path: join(ex.testDir, 'CHECKLIST.md'), content: 'x' })).message, /frozen success test/, 'not this agent\'s expedition: the hash check of that one is its guard');
  const hook = b2.options().hooks.PreToolUse[0].hooks[0];
  assert.deepEqual(await hook({ tool_name: 'Write', tool_input: { file_path: join(ex.testDir, 'CHECKLIST.md') }, tool_use_id: 'y', cwd: p.dir }), {});
  assert.equal((await hook({ tool_name: 'Write', tool_input: { file_path: join(se2.ex.testDir, 'CHECKLIST.md') }, tool_use_id: 'z', cwd: p.dir })).hookSpecificOutput.permissionDecision, 'deny');
  // Nothing in a request names the expedition: extra fields in the tool input change nothing.
  const r = await hub.requestApproval(p, b2, 'Write', { file_path: join(se2.ex.testDir, 'a.md'), content: 'x', expedition: 'none', expeditionRole: 'lead', frozen: [] });
  assert.equal(r.behavior, 'deny');
});

// ---------- 2c. the PreToolUse hook: where acceptEdits workers' edits are seen ----------
test('the PreToolUse hook refuses a plain write into the frozen test for any expedition agent, gatherers included, and leaves everything else alone', async () => {
  const { hub, p, ex, builder, lead, plain, env } = world();
  const mark = quietMark(env);
  const hook = a => a.options().hooks.PreToolUse[0].hooks[0];
  const denied = out => [out?.hookSpecificOutput?.hookEventName, out?.hookSpecificOutput?.permissionDecision];
  const target = join(ex.testDir, 'CHECKLIST.md');
  const call = (a, over) => hook(a)({ hook_event_name: 'PreToolUse', tool_use_id: `tu-${Math.random()}`, cwd: p.dir, ...over });
  assert.deepEqual(denied(await call(builder, { tool_name: 'Write', tool_input: { file_path: target, content: 'x' } })), ['PreToolUse', 'deny']);
  assert.deepEqual(denied(await call(builder, { tool_name: 'Edit', tool_input: { file_path: relative(ex.worktree, target), old_string: 'a', new_string: 'b' }, cwd: ex.worktree })), ['PreToolUse', 'deny'], 'relative to where the call runs (the hook\'s cwd)');
  assert.deepEqual(denied(await call(builder, { tool_name: 'Bash', tool_input: { command: 'mv ../../../.crux/expeditions/' + ex.id + '/test/run.json /tmp/x' }, cwd: ex.worktree })), ['PreToolUse', 'deny']);
  // The Lead's gatherer (a subagent: the hook carries agent_id) is refused too, and the log says which subagent.
  const g = await call(lead, { tool_name: 'Write', tool_input: { file_path: target, content: 'x' }, agent_id: 'sub-1', agent_type: 'expedition-gatherer', tool_use_id: 'tu-g' });
  assert.deepEqual(denied(g), ['PreToolUse', 'deny']);
  assert.match(g.hookSpecificOutput.permissionDecisionReason, /^Not allowed: Writes into the frozen success test/);
  assert.deepEqual(answers(p).at(-1).subagent, { id: 'sub-1', type: 'expedition-gatherer' });
  assert.equal(answers(p).filter(a => a.answer === 'deny' && a.expedition === ex.id).length, 4, 'every refusal is logged once, in the agent\'s thread');
  // Everything else passes straight through: other files, reading, other tools, no tool input at all.
  for (const over of [{ tool_name: 'Write', tool_input: { file_path: join(ex.root, 'REPORT.md'), content: 'x' } }, { tool_name: 'Read', tool_input: { file_path: target } }, { tool_name: 'Bash', tool_input: { command: `cat ${target}` } },
    { tool_name: 'Bash', tool_input: { command: 'git status' } }, { tool_name: 'Agent', tool_input: {} }, { tool_name: 'Write' }, {}]) assert.deepEqual(await call(builder, over), {}, JSON.stringify(over).slice(0, 80));
  // A plain worker's hook never refuses (it has no frozen folders), and nothing here was a card.
  assert.deepEqual(await call(plain, { tool_name: 'Write', tool_input: { file_path: target, content: 'x' } }), {});
  assert.deepEqual(quietProblems(env, mark, sent), []);
  void hub;
});

// ---------- 3. the real guard: tamper and restore through the Lead's tools ----------
test('tamper-and-restore: an edit the deny rule misses is found at the next loop result, restored, and that loop is a Verifier FAIL with no progress', async () => {
  const { ex, call, p, env } = world();
  const mark = quietMark(env);
  assert.equal(await call('expedition_loop_result', { passing: 1 }), 'Loop 1: 1 passing, progress.');
  // A script the rule cannot read rewrites test/ (nothing asks anyone: it is not a plain write).
  writeFileSync(join(ex.testDir, 'CHECKLIST.md'), '1. nothing to check\n');
  writeFileSync(join(ex.testDir, 'extra.md'), 'x');
  const said = await call('expedition_loop_result', { passing: 5 });
  assert.match(said, /^Loop 2: FAIL\. test\/ no longer matched the hash logged at the gate \(CHECKLIST\.md \(changed\), extra\.md \(added\)\)\. The hub restored it from its copy in \.crux\/expeditions\/\.frozen\/.*\/ and logged it\. The 5 passing you reported do not count: this loop is a Verifier FAIL with no progress\. Run the loop again against the restored test\.$/);
  assert.equal(readFileSync(join(ex.testDir, 'CHECKLIST.md'), 'utf8'), '1. a table\n2. a benchmark\n');
  assert.equal(ex.exists('test/extra.md'), false);
  const loop = p.log.ofType('expedition_loop').at(-1);
  assert.deepEqual([loop.number, loop.passing, loop.progress, loop.tampered], [2, 5, false, true]);
  const ev = p.log.ofType('expedition_integrity').at(-1);
  assert.deepEqual([ev.at, ev.restored, ev.changed, ev.expedition], ['loop', true, ['CHECKLIST.md (changed)', 'extra.md (added)'], ex.id]);
  assert.equal(ex.state().phase, 'running', 'one FAIL does not stop it');
  // The tampered loop's 5 is not the best so far: an honest 2 after it is progress over the honest 1.
  assert.equal(await call('expedition_loop_result', { passing: 2 }), 'Loop 3: 2 passing, progress.');
  assert.equal(p.log.ofType('expedition_integrity').length, 1, 'a clean loop logs nothing');
  assert.deepEqual(quietProblems(env, mark, sent), []);
});

test('tampering at two loops in a row is two FAILs with no progress, so the hub stops it (no-progress)', async () => {
  const { ex, call, p } = world();
  await call('expedition_loop_result', { passing: 1 });
  writeFileSync(join(ex.testDir, 'run.json'), '{}');
  assert.match(await call('expedition_loop_result', { passing: 9 }), /^Loop 2: FAIL\./);
  writeFileSync(join(ex.testDir, 'run.json'), '{"command":"true"}');
  const said = await call('expedition_loop_result', { passing: 9 });
  assert.match(said, /^Loop 3: FAIL\. .*Two loops in a row made no progress, so the hub has stopped the expedition \(no-progress\)/);
  assert.equal(ex.state().stopped.reason, 'no-progress');
  assert.equal(p.log.ofType('expedition_integrity').length, 2);
  assert.equal(ex.testHash(), ex.state().gate.testHash, 'and test/ is as frozen for the report and the Verifier');
});

test('tamper-and-restore at the finish: a changed test/ is restored and the finish is refused as a Verifier FAIL; a clean one finishes', async () => {
  const { ex, call, p } = world();
  await call('expedition_loop_result', { passing: 3 });
  writeFileSync(join(ex.testDir, 'CHECKLIST.md'), '1. trivially true\n');
  const refused = await call('expedition_finish', {});
  assert.match(refused, /^Not finished: test\/ no longer matched the hash logged at the gate \(CHECKLIST\.md \(changed\)\)\. The hub restored it .*This counts as a Verifier FAIL, so it is not finished as passed: have the Verifier run the restored test in another build-verify loop first\.$/);
  assert.equal(ex.state().phase, 'running');
  assert.equal(p.log.ofType('expedition_stopped').length, 0);
  assert.equal(p.log.ofType('expedition_integrity').at(-1).at, 'finish');
  assert.equal(ex.testHash(), ex.state().gate.testHash);
  await call('expedition_loop_result', { passing: 4 });
  assert.match(await call('expedition_finish', {}), /^Stopped \(passed\)\./);
  assert.equal(ex.state().stopped.reason, 'passed');
});

test('when the stored copy is damaged too the Lead is told nothing can be restored, and neither a loop nor the finish counts', async () => {
  const { ex, call } = world();
  await call('expedition_loop_result', { passing: 2 });
  writeFileSync(join(ex.frozenDir, 'run.json'), 'damaged');
  writeFileSync(join(ex.testDir, 'CHECKLIST.md'), '1. trivially true\n');
  const said = await call('expedition_loop_result', { passing: 3 });
  assert.match(said, /^Loop 2: FAIL\. test\/ no longer matched the hash logged at the gate \(.*\), and the hub could not restore it \(the frozen copy itself no longer matches the logged hash\)\. Nothing run against it can be trusted\. The 3 passing you reported do not count/);
  assert.match(await call('expedition_finish', {}), /^Not finished: test\/ no longer matched the hash logged at the gate .*could not restore it/);
  assert.equal(ex.state().phase, 'running');
  assert.ok(ex.state().integrity.every(e => e.restored === false && /frozen copy itself/.test(e.why)));
});

test('close_gate\'s tool text says the real lock, not an agreement; the Lead is told what the hub does', async () => {
  const { lead, env, call } = world({ gate: false });
  const rt = cruxTools(env.hub, env.p, lead).instance._registeredTools;
  const d = rt.expedition_close_gate.description;
  assert.doesNotMatch(d, /by agreement|later phase/);
  assert.match(d, /keeps a copy of it outside the worktree/);
  assert.match(d, /\.crux\/expeditions\/\.frozen\/<id>\//);
  assert.match(d, /__pycache__.*verify\/run-N\//);
  assert.match(d, /restores test\/ from its copy.*Verifier FAIL/);
  assert.match(rt.expedition_loop_result.description, /checks test\/ against the frozen copy/);
  assert.match(rt.expedition_finish.description, /unchanged from the frozen copy/);
  assert.match(await call('expedition_close_gate', { verdict: 'ok' }), /test\/ is locked from here: writes into it are refused/);
});
