// M051 (2026-11-16): the three fixes that bring the permission check's consult share down, and the lines they must not cross.
//   1. A worker's own test file (hub/test/ in its own worktree) is attached in full and counts as seen when everything it loads is followed.
//   2. The hub's own rule modules hold hard-stop words as data: a worker's changed copy is scanned on what the worker ADDED.
//   3. Another hub project's data is never an allow: a hard stop in the rules, a stop in the script scan, a fact in the prompt.
// The model is a stub; git is a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { PermissionCheck, scanScripts, scriptsFor, buildPrefix, buildSuffix, OTHER_PROJECTS_FACT, OWN_TEST_FACT, OWN_TEST_LIMIT } from '../lib/permission-check.mjs';
import { classify } from '../lib/permission-rules.mjs';

const FACTS = { project: 'proj', dir: 'C:\\work\\proj', temp: 'C:\\Temp', level: 'Auto', rulesId: 'R005', rulesBody: 'Rules.' };
const real = f => readFileSync(new URL(`../lib/${f}`, import.meta.url), 'utf8');

// A git that knows three states: clean (committed, unchanged from main), dirty (tracked, changed), untracked. added: name -> the
// lines `git diff -U0` reports as added since the base.
const gitFor = ({ dirty = [], untracked = [], added = {} } = {}) => async args => {
  const name = args.at(-1), sub = args[0];
  if (sub === 'ls-files' && args.includes('--error-unmatch')) return { code: untracked.includes(name) ? 1 : 0, out: '' };
  if (sub === 'ls-files' && args.includes('--full-name')) return { code: 0, out: `${name}\n` };
  if (sub === 'status') return { code: 0, out: dirty.includes(name) ? ` M ${name}\n` : untracked.includes(name) ? `?? ${name}\n` : '' };
  if (sub === 'merge-base') return { code: 0, out: 'abc\n' };
  if (sub === 'cat-file') return { code: 0, out: '' };
  if (sub === 'diff') {
    if (args.includes('--quiet')) return { code: dirty.includes(name) || untracked.includes(name) ? 1 : 0, out: '' };
    return { code: 0, out: added[name] ? `--- a/${name}\n+++ b/${name}\n${added[name].split('\n').map(l => `+${l}`).join('\n')}\n` : '' };
  }
  return { code: 1, out: '' };
};
// <tmp>/proj/.claude/worktrees/<name>/<files>; the worker runs in that worktree.
function worktree(files, name = 'w1') {
  const proj = join(makeTmp('crux-m051-'), 'proj');
  const wt = join(proj, '.claude', 'worktrees', name);
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(wt, f, '..'), { recursive: true }); writeFileSync(join(wt, f), text); }
  return { proj, wt };
}
const pad = n => `// ${'x'.repeat(78)}\n`.repeat(Math.ceil(n / 82));
const checker = (says = 'allow') => { const c = { calls: 0 }; c.run = new PermissionCheck({ call: async () => { c.calls++; return { text: JSON.stringify({ answer: says, reason: 'looks fine' }), via: 'sdk', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {} }; } }); return c; };
const look = (command, proj, wt, git) => scriptsFor(command, { cwd: wt, projectDir: proj, git: gitFor(git) });
const ask = async (c, { proj, wt }, command, git, extra = {}) => c.run.run({ ...FACTS, dir: proj, worker: 'w', goal: 'g', tool: 'Bash', input: { command }, cwd: wt, doubts: [], scripts: await look(command, proj, wt, git), ...extra });
const RUN = 'node --test hub/test/a.test.mjs';
const TEST_OK = "import test from 'node:test';\nimport { x } from '../lib/foo.mjs';\ntest('a', () => { if (x !== 1) throw new Error('no'); });\n";
const FOO = 'export const x = 1;\n';

// ---------- 1. a worker's own test files count as seen ----------
test('1: a worker\'s own test file over 16 KB, importing its own new module, is attached in full and is not held back', async () => {
  const t = worktree({ 'hub/test/a.test.mjs': TEST_OK + pad(30 * 1024), 'hub/lib/foo.mjs': FOO });
  const git = { untracked: ['a.test.mjs', 'foo.mjs'] };
  const s = await look(RUN, t.proj, t.wt, git);
  const f = s.scripts.find(x => /a\.test\.mjs$/.test(x.path));
  assert.equal(f.kind, 'attached');
  assert.equal(f.cutOff, false, 'attached in full');
  assert.ok(f.bytes > 16 * 1024 && f.bytes < OWN_TEST_LIMIT);
  assert.equal(f.own, true);
  assert.deepEqual(f.loads, []);
  assert.equal(s.unread, false, 'nothing is unread');
  const c = checker('allow');
  const r = await ask(c, t, RUN, git);
  assert.equal(r.answer, 'allow', r.reason);
  assert.equal(r.downgraded, false);
  assert.equal(c.calls, 1);
  assert.match(buildSuffix({ worker: 'w', tool: 'Bash', input: { command: RUN }, scripts: s }), /the worker's own test file in its own worktree/);
  assert.ok(buildPrefix(FACTS).includes(OWN_TEST_FACT));
});

test('1: a changed (not new) test file, and a test that spawns only git, count as seen too', async () => {
  const test1 = "import test from 'node:test';\nimport { execFileSync } from 'node:child_process';\nimport { x } from '../lib/foo.mjs';\ntest('a', () => { execFileSync('git', ['status'], { cwd: process.cwd() }); });\n";
  const t = worktree({ 'hub/test/a.test.mjs': test1, 'hub/lib/foo.mjs': FOO });
  const s = await look(RUN, t.proj, t.wt, { dirty: ['a.test.mjs'], untracked: ['foo.mjs'] });
  assert.equal(s.unread, false);
});

test('1: a test that imports a committed, unchanged file is seen (the committed file is main\'s)', async () => {
  const t = worktree({ 'hub/test/a.test.mjs': TEST_OK, 'hub/lib/foo.mjs': FOO });
  const s = await look(RUN, t.proj, t.wt, { untracked: ['a.test.mjs'] });
  assert.equal(s.unread, false);
  assert.equal(s.scripts.find(x => /foo\.mjs$/.test(x.path)), undefined, 'a committed import is followed, not listed');
});

test('1 (negative): a test file over the size limit is cut off and still held back', async () => {
  const t = worktree({ 'hub/test/a.test.mjs': TEST_OK + pad(OWN_TEST_LIMIT + 4096), 'hub/lib/foo.mjs': FOO });
  const s = await look(RUN, t.proj, t.wt, { untracked: ['a.test.mjs', 'foo.mjs'] });
  assert.equal(s.scripts.find(x => /a\.test\.mjs$/.test(x.path)).cutOff, true);
  assert.equal(s.unread, true);
  const r = await ask(checker('allow'), t, RUN, { untracked: ['a.test.mjs', 'foo.mjs'] });
  assert.equal(r.answer, 'consult');
});

test('1 (negative): another worker\'s test, and a script that is not under hub/test/, are not "own": they stay held back', async () => {
  const other = worktree({ 'hub/test/a.test.mjs': TEST_OK, 'hub/lib/foo.mjs': FOO }, 'someone-else');
  // run from w1 (cwd), the file is in someone-else's worktree
  const wt1 = join(other.proj, '.claude', 'worktrees', 'w1');
  mkdirSync(wt1, { recursive: true });
  const git = { untracked: ['a.test.mjs', 'foo.mjs'] };
  const s = await scriptsFor(`node --test ../someone-else/hub/test/a.test.mjs`, { cwd: wt1, projectDir: other.proj, git: gitFor(git) });
  assert.equal(s.unread, true, "someone else's worktree is not the worker's own");
  const plain = worktree({ 'tools/x.mjs': TEST_OK, 'hub/lib/foo.mjs': FOO });
  const s2 = await look('node tools/x.mjs', plain.proj, plain.wt, { untracked: ['x.mjs', 'foo.mjs'] });
  assert.equal(s2.unread, true, 'a worker-written script that imports another file is still held back (decision 67)');
});

test('1 (negative): a test that starts a program the hub cannot name, loads a file named at run time, or imports a missing file is still held back', async () => {
  const cases = {
    'execSync of a built-up command': "import test from 'node:test';\nimport { execSync } from 'node:child_process';\ntest('a', () => { execSync('rm -rf ' + process.env.X); });\n",
    'spawn of the node binary': "import { spawn } from 'node:child_process';\nspawn(process.execPath, [process.env.S]);\n",
    'a file named at run time': "import test from 'node:test';\nconst f = process.env.F;\nawait import(f);\n",
    'an import that is not there': "import { y } from '../lib/missing.mjs';\n",
    'a script run by name in its text': "import test from 'node:test';\nconst s = 'node tools/other.mjs';\n",
    'eval': "import test from 'node:test';\neval(process.env.CODE);\n"
  };
  for (const [name, text] of Object.entries(cases)) {
    const t = worktree({ 'hub/test/a.test.mjs': text, 'hub/lib/foo.mjs': FOO });
    const s = await look(RUN, t.proj, t.wt, { untracked: ['a.test.mjs', 'foo.mjs'] });
    assert.equal(s.unread, true, name);
  }
});

test('1 (negative): a test that imports a worker-written module which starts a program of its own is still held back', async () => {
  const lib = "import { execSync } from 'node:child_process';\nexport const x = () => execSync('make all');\n";
  const t = worktree({ 'hub/test/a.test.mjs': TEST_OK, 'hub/lib/foo.mjs': lib });
  const s = await look(RUN, t.proj, t.wt, { untracked: ['a.test.mjs', 'foo.mjs'] });
  assert.equal(s.unread, true);
});

test('1 (negative): a worker-written test or module that pushes or merges is still caught, in code, with no model call', async () => {
  const push = "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['push', 'origin', 'HEAD:main']);\n";
  const merge = "import { execFileSync } from 'node:child_process';\nexecFileSync('gh', ['pr', 'merge', '12', '--squash']);\n";
  const git = { untracked: ['a.test.mjs', 'foo.mjs'] };
  const shapes = {
    'the test itself pushes': { 'hub/test/a.test.mjs': TEST_OK + push, 'hub/lib/foo.mjs': FOO },
    'the test itself merges': { 'hub/test/a.test.mjs': TEST_OK + merge, 'hub/lib/foo.mjs': FOO },
    'the module it imports pushes': { 'hub/test/a.test.mjs': TEST_OK, 'hub/lib/foo.mjs': FOO + push },
    'the module it imports merges': { 'hub/test/a.test.mjs': TEST_OK, 'hub/lib/foo.mjs': FOO + merge }
  };
  for (const [name, files] of Object.entries(shapes)) {
    const t = worktree(files);
    const c = checker('allow');
    const r = await ask(c, t, RUN, git);
    assert.equal(r.answer, 'escalate', `${name}: ${r.reason}`);
    assert.equal(c.calls, 0, `${name}: the model is not asked`);
    assert.equal(r.via, 'code');
  }
});

test('1: a glob over many committed tests names them and attaches only what changed', async () => {
  const files = { 'hub/lib/foo.mjs': FOO };
  for (let i = 0; i < 20; i++) files[`hub/test/t${i}.test.mjs`] = TEST_OK;
  const t = worktree(files);
  const s = await look('node --test "hub/test/*.test.mjs"', t.proj, t.wt, { dirty: ['t3.test.mjs'] });
  assert.equal(s.scripts.filter(x => x.kind === 'committed').length, 19);
  assert.equal(s.scripts.filter(x => x.kind === 'attached').length, 1);
  assert.equal(s.unread, false);
  // more changed tests than can be read: held back
  const s2 = await look('node --test "hub/test/*.test.mjs"', t.proj, t.wt, { dirty: Array.from({ length: 12 }, (_, i) => `t${i}.test.mjs`) });
  assert.equal(s2.unread, true);
});

// ---------- 2. the hub's own rule modules are data, not commands ----------
const rulesTree = (extra = {}) => worktree({
  'hub/test/a.test.mjs': "import test from 'node:test';\nimport { classify } from '../lib/permission-rules.mjs';\ntest('a', () => { classify({}); });\n",
  'hub/lib/permission-rules.mjs': real('permission-rules.mjs'),
  'hub/lib/permission-lists.mjs': real('permission-lists.mjs'),
  'hub/lib/permissions.mjs': real('permissions.mjs'),
  'hub/lib/settings.mjs': real('settings.mjs'),
  ...extra
});

test('2: the real rule modules, whole, hold hard-stop words as data: that is the false positive (what main did)', () => {
  const stops = scanScripts({ scripts: [], imports: [{ path: 'permission-rules.mjs', text: real('permission-rules.mjs') }, { path: 'permission-lists.mjs', text: real('permission-lists.mjs') }], inlineCode: [] }).stops;
  assert.ok(stops.length > 0, 'a whole-file scan of the hub\'s rule modules finds "hard stops": ' + stops[0]);
});

test('2: a test that imports a rule module the worker changed is scanned on the added lines only: no escalation', async () => {
  const t = rulesTree();
  const git = { untracked: ['a.test.mjs'], dirty: ['permission-rules.mjs'], added: { 'permission-rules.mjs': '// a harmless added line\nconst EXTRA = /^frozen/;' } };
  const s = await look(RUN, t.proj, t.wt, git);
  const imp = s.imports.find(x => /permission-rules\.mjs$/.test(x.path));
  assert.ok(imp, 'the changed rule module is read');
  assert.equal(imp.text, '// a harmless added line\nconst EXTRA = /^frozen/;', 'on what the worker added');
  assert.deepEqual(scanScripts(s).stops, [], 'no hard stop');
  assert.equal(s.unread, false, 'and the test is seen');
  const c = checker('allow');
  const r = await ask(c, t, RUN, git);
  assert.equal(r.answer, 'allow', r.reason);
  assert.equal(c.calls, 1);
});

test('2 (negative): a rule module whose ADDED lines run a push or a merge is still caught', async () => {
  const added = {
    'a push to main': "execFileSync('git', ['push', 'origin', 'HEAD:main']);",
    'a gh merge': "execFileSync('gh', ['pr', 'merge', '12', '--squash']);",
    'an install': "execFileSync('npm', ['install', 'left-pad']);"
  };
  for (const [name, line] of Object.entries(added)) {
    const t = rulesTree();
    const git = { untracked: ['a.test.mjs'], dirty: ['permission-rules.mjs'], added: { 'permission-rules.mjs': line } };
    const c = checker('allow');
    const r = await ask(c, t, RUN, git);
    assert.equal(r.answer, 'escalate', `${name}: ${r.reason}`);
    assert.equal(c.calls, 0, name);
  }
});

test('2 (negative): the same text in any other file is scanned whole, and a rule module git cannot diff is scanned whole', async () => {
  // the rules' text under another name: not exempt
  const other = worktree({ 'hub/test/a.test.mjs': "import test from 'node:test';\nimport { classify } from '../lib/rules-copy.mjs';\n", 'hub/lib/rules-copy.mjs': real('permission-rules.mjs') });
  const s = await look(RUN, other.proj, other.wt, { untracked: ['a.test.mjs', 'rules-copy.mjs'] });
  assert.ok(scanScripts(s).stops.length > 0, 'a copy under another name is read whole');
  // a new (untracked) file with a rule module's name is not main's: read whole
  const fresh = rulesTree();
  const s2 = await look(RUN, fresh.proj, fresh.wt, { untracked: ['a.test.mjs', 'permission-rules.mjs'] });
  assert.ok(scanScripts(s2).stops.length > 0, 'a new file with a rule module\'s name is read whole');
});

test('2: the rule modules the worker did not change are committed: not scanned, and the test is seen', async () => {
  const t = rulesTree();
  const s = await look(RUN, t.proj, t.wt, { untracked: ['a.test.mjs'] });
  assert.deepEqual(scanScripts(s).stops, []);
  assert.equal(s.unread, false);
});

// ---------- 3. another project's data is never an allow, and never a hard stop: the orchestrator decides ----------
const HOME = process.platform === 'win32' ? 'C:\\Users\\me' : '/home/me';
const MINE = process.platform === 'win32' ? 'C:\\Users\\me\\GitHub\\crux' : '/home/me/GitHub/crux';
const OTHER = process.platform === 'win32' ? 'C:\\Users\\me\\GitHub\\AcuLoad' : '/home/me/GitHub/AcuLoad';
const OTHER2 = process.platform === 'win32' ? 'C:\\Users\\me\\life' : '/home/me/life';
const cls = (tool, input, extra = {}) => classify({ tool, input, projectDir: MINE, home: HOME, tmp: HOME + '\\tmp', level: 'auto', otherProjects: [MINE, OTHER, OTHER2], ...extra });
const slash = p => p.replace(/\\/g, '/');
const gitBash = p => p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');

test('3: reading another hub project\'s event log or files is unclear (to the orchestrator), never allowed on the spot, by every way of naming it', () => {
  const log = `${OTHER}\\.crux\\events.jsonl`;
  const named = [
    ['Read', { file_path: log }],
    ['Read', { file_path: `${OTHER}\\src\\app.js` }],
    ['Grep', { pattern: 'error', path: `${OTHER}` }],
    ['Glob', { pattern: `${slash(OTHER)}/**/*.md` }],
    ['Bash', { command: `cat "${log}"` }],
    ['Bash', { command: `cat ${slash(log)} | head -5` }],
    ['Bash', { command: `grep -c '"type":"usage"' ${gitBash(log)}` }],
    ['Bash', { command: `ls ${gitBash(OTHER)}` }],
    ['Bash', { command: `wc -l "${OTHER2}\\.crux\\events.jsonl"` }],
    ['PowerShell', { command: `Get-Content '${log}' | Select-Object -First 3` }],
    ['PowerShell', { command: `Get-ChildItem -Recurse ${OTHER}` }],
    ['Bash', { command: `node tools/calib.mjs "${MINE}\\.crux\\events.jsonl" "${log}"` }],
    ['Bash', { command: `node -e "console.log(require('fs').readFileSync('${log.replace(/\\/g, '\\\\')}','utf8').length)"` }],
    ['Bash', { command: `cd ${gitBash(OTHER)} && git log --oneline | head -3` }]
  ];
  for (const [tool, input] of named) {
    const c = cls(tool, input);
    assert.equal(c.route, 'unsure', `${tool} ${JSON.stringify(input)}: ${c.route} ${c.reasons}`);
    assert.ok(c.unsure.some(r => /another project's data/.test(r)), `${tool}: ${c.unsure}`);
    assert.deepEqual(c.reasons, [], 'not a hard stop');
  }
});

test('3: a relative path that reaches the other project from the worker\'s folder is unclear too', () => {
  const cwd = `${MINE}\\.claude\\worktrees\\w1`;
  const c = cls('Bash', { command: 'cat ../../../../AcuLoad/.crux/events.jsonl' }, { cwd });
  assert.equal(c.route, 'unsure');
  assert.ok(c.unsure.some(r => /another project's data/.test(r)), String(c.unsure));
  assert.equal(cls('Read', { file_path: '../../../../AcuLoad/README.md' }, { cwd }).route, 'unsure');
});

test('3 (negative): a write into another project is still the hard stop it was (outside the project)', () => {
  for (const [tool, input] of [['Write', { file_path: `${OTHER}\\notes.md`, content: 'x' }], ['Bash', { command: `echo hi > ${slash(OTHER)}/notes.md` }], ['Bash', { command: `rm -rf ${slash(OTHER)}/.crux` }]]) {
    const c = cls(tool, input);
    assert.equal(c.route, 'human', `${tool} ${JSON.stringify(input)}: ${c.route}`);
    assert.ok(c.reasons.some(r => /outside the project/i.test(r)), String(c.reasons));
  }
});

test('3 (negative): the project\'s own files, its own log and its worktrees, and a folder that only starts with another project\'s name, are not flagged', () => {
  const ok = [
    ['Read', { file_path: `${MINE}\\.crux\\events.jsonl` }],
    ['Read', { file_path: `${MINE}\\.claude\\worktrees\\w1\\hub\\lib\\hub.mjs` }],
    ['Bash', { command: `cat ${slash(MINE)}/README.md | head -3` }],
    ['Bash', { command: `cat ${slash(OTHER)}2/README.md | head -3` }],
    ['Bash', { command: `ls ${slash(MINE)}/../AcuLoad-notes 2>/dev/null` }]
  ];
  for (const [tool, input] of ok) {
    const c = cls(tool, input);
    assert.ok(!c.unsure.some(r => /another project's data/.test(r)), `${tool} ${JSON.stringify(input)}: ${c.unsure}`);
  }
  // no list of other projects: nothing changes
  assert.ok(!classify({ tool: 'Read', input: { file_path: `${OTHER}\\x` }, projectDir: MINE, home: HOME, level: 'auto' }).unsure.some(r => /another project's data/.test(r)));
  // a folder that holds this project is not "another project"
  const parent = classify({ tool: 'Read', input: { file_path: `${MINE}\\README.md` }, projectDir: MINE, home: HOME, level: 'auto', otherProjects: [HOME + '\\GitHub', MINE] });
  assert.ok(!parent.unsure.some(r => /another project's data/.test(r)));
});

test('3: a script (or a file it imports, or code in the command) that names another project\'s folder is listed by the scan, and the check says consult (the orchestrator decides) without a model call', async () => {
  const dirs = [OTHER];
  const named = `import { readFileSync } from 'node:fs';\nconsole.log(readFileSync('${OTHER.replace(/\\/g, '/')}/.crux/events.jsonl', 'utf8').length);\n`;
  assert.ok(scanScripts({ scripts: [{ kind: 'attached', path: 'x.mjs', text: named }] }, { dirs, own: MINE }).others.some(s => /another hub project's folder/.test(s)));
  assert.ok(scanScripts({ scripts: [], imports: [{ path: 'lib.mjs', text: named }], inlineCode: [] }, { dirs, own: MINE }).others.length > 0);
  assert.ok(scanScripts({ scripts: [], imports: [], inlineCode: [named] }, { dirs, own: MINE }).others.length > 0);
  assert.deepEqual(scanScripts({ scripts: [{ kind: 'attached', path: 'x.mjs', text: named }] }, { dirs, own: MINE }).stops, [], 'not a hard stop');
  assert.deepEqual(scanScripts({ scripts: [{ kind: 'attached', path: 'x.mjs', text: "console.log('hi')" }] }, { dirs, own: MINE }).others, []);
  assert.deepEqual(scanScripts({ scripts: [{ kind: 'attached', path: 'x.mjs', text: named }] }).others, [], 'no list: nothing listed');
  // through the check, with a real script: the same script is a plain read when the hub lists no such project, a consult when it does
  const t = worktree({ 'tools/x.mjs': `import { readFileSync } from 'node:fs';\nreadFileSync('PLACEHOLDER');\n` });
  const other = `${t.proj}-b`;
  writeFileSync(join(t.wt, 'tools', 'x.mjs'), `import { readFileSync } from 'node:fs';\nconsole.log(readFileSync('${other.replace(/\\/g, '/')}/.crux/events.jsonl', 'utf8').length);\n`);
  const git = { untracked: ['x.mjs'] };
  const c0 = checker('allow');
  const r0 = await ask(c0, t, 'node tools/x.mjs', git, { otherProjects: [] });
  assert.equal(r0.answer, 'allow', 'no other project listed: nothing to stop');
  const c1 = checker('allow');
  const r1 = await ask(c1, t, 'node tools/x.mjs', git, { otherProjects: [other, t.proj] });
  assert.equal(r1.answer, 'consult', r1.reason);
  assert.equal(r1.via, 'code');
  assert.equal(c1.calls, 0, 'no model call');
  assert.match(r1.reason, /another hub project's/);
  // the same in shadow mode: the model is asked, the answer is still consult, the model's own word is kept beside it
  const c1s = checker('allow');
  const r1s = await ask(c1s, t, 'node tools/x.mjs', git, { otherProjects: [other, t.proj], shadow: true });
  assert.equal(r1s.answer, 'consult');
  assert.equal(r1s.raw, 'allow');
  assert.equal(c1s.calls, 1);
  // a command that itself names the other project (no script at all) is a consult in code too
  const c1c = checker('allow');
  const r1c = await c1c.run.run({ ...FACTS, dir: t.proj, worker: 'w', goal: 'g', tool: 'Bash', input: { command: `cat ${other.replace(/\\/g, '/')}/.crux/events.jsonl | head -3` }, cwd: t.wt, doubts: [], scripts: null, otherProjects: [other, t.proj] });
  assert.equal(r1c.answer, 'consult');
  assert.equal(c1c.calls, 0);
  // a real hard stop still wins over it: escalate
  const pushy = worktree({ 'tools/x.mjs': `import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['push', 'origin', 'HEAD:main']);\n` });
  writeFileSync(join(pushy.wt, 'tools', 'x.mjs'), `import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['push', 'origin', 'HEAD:main']);\n// ${`${pushy.proj}-b`.replace(/\\/g, '/')}/.crux\n`);
  const r1p = await ask(checker('allow'), pushy, 'node tools/x.mjs', git, { otherProjects: [`${pushy.proj}-b`, pushy.proj] });
  assert.equal(r1p.answer, 'escalate', r1p.reason);
  // the project's own folder, and a folder that only starts with the other's name, are not "another project"
  writeFileSync(join(t.wt, 'tools', 'x.mjs'), `import { readFileSync } from 'node:fs';\nconsole.log(readFileSync('${other.replace(/\\/g, '/')}2/a.txt', 'utf8').length, '${t.proj.replace(/\\/g, '/')}');\n`);
  const r2 = await ask(checker('allow'), t, 'node tools/x.mjs', git, { otherProjects: [other, t.proj] });
  assert.equal(r2.answer, 'allow', r2.reason);
});

test('3: the check\'s instructions say it too', () => {
  const s = buildPrefix(FACTS);
  assert.ok(s.includes(OTHER_PROJECTS_FACT));
  assert.match(OTHER_PROJECTS_FACT, /never an allow/);
  assert.match(OTHER_PROJECTS_FACT, /consult/);
  assert.ok(!/escalate\. Only Matt/.test(OTHER_PROJECTS_FACT), 'not a hard stop');
  assert.ok(s.indexOf(OTHER_PROJECTS_FACT) < s.indexOf('THE PROJECT\'S RULES'), 'a project fact, before the rules');
  assert.ok(!s.includes('AcuLoad'), 'no other project is named to the model');
});

// ---------- 3, through the hub: the list of projects comes from the hub, not from the request ----------
Agent.prototype.send = function () { this.state = 'working'; };
Agent.prototype.close = function () { this.q = null; };
test('3: in a hub with two projects, a worker in one that reads the other\'s log goes to the orchestrator (never allowed on the spot, no hard stop), at Auto', async () => {
  const root = makeTmp('crux-m051-hub-');
  const a = join(root, 'alpha'), b = join(root, 'beta');
  for (const d of [a, b]) mkdirSync(join(d, '.crux'), { recursive: true });
  writeFileSync(join(b, '.crux', 'events.jsonl'), '');
  const hub = new Hub({ projects: [a, b], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }) });
  const p = hub.project('alpha');
  assert.deepEqual(hub.otherProjectDirs(p), [b]);
  p.board.addEntry({ kind: 'requirement', title: 'Orchestrator permission rules (test)', summary: 'rules', body: 'The orchestrator may ALLOW project work. ALWAYS goes to Matt: pushing to main.', from: 'you' });
  const orch = hub.ensureOrchestrator(p); orch.q = {};
  const w = hub.startWorker(p, 'builder', 'Build the feature', 'you', 'Build it');
  w.q = {};
  hub.setPermissionMode(p, 'auto');
  const own = hub.requestApproval(p, w, 'Bash', { command: `cat ${join(a, '.crux', 'events.jsonl').replace(/\\/g, '/')} | head -2`, description: 'own log' });
  const other = hub.requestApproval(p, w, 'Bash', { command: `cat ${join(b, '.crux', 'events.jsonl').replace(/\\/g, '/')} | head -2`, description: 'the other one' });
  const reads = hub.requestApproval(p, w, 'Read', { file_path: join(b, '.crux', 'events.jsonl') });   // a plain Read of it: not answered on the spot either
  const ownRead = await hub.requestApproval(p, w, 'Read', { file_path: join(a, '.crux', 'events.jsonl') });
  assert.equal(ownRead.behavior, 'allow', 'its own log is read as before');
  assert.equal((await own).behavior, 'allow', 'and so is a cat of its own log');
  const find = () => p.log.ofType('approval').filter(c => /beta/i.test(String(c.input?.command || c.input?.file_path)));
  for (let i = 0; i < 300 && find().length < 2; i++) await new Promise(r => setTimeout(r, 10));
  const cards = find();
  assert.equal(cards.length, 2, 'a waiting request for the cat and one for the Read');
  for (const card of cards) {
    assert.equal(card.routedTo, orch.name, 'it goes to the orchestrator, not to Matt');
    assert.deepEqual(card.stops || [], [], 'no hard stop');
  }
  for (const e of [...hub.approvals.values()]) e.finish({ behavior: 'deny', message: 'test' }, 'test');
  assert.equal((await other).behavior, 'deny');
  assert.equal((await reads).behavior, 'deny');
});

// ---------- the cd rule: brackets and || inside a quoted string are text (66 of 187 held-back lines in the first study) ----------
import { parseCommand } from '../lib/permission-scripts.mjs';
import { replayShadow } from '../tools/permission-study.mjs';
test('cd: a grep pattern with brackets, or "||" in an echo, no longer makes the folder unreadable; a real group or || still does', () => {
  const unreadCd = c => parseCommand(c, { shell: 'bash' }).unread.some(u => u.head === 'cd');
  assert.equal(unreadCd('cd hub && node --test test/a.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail)"'), false);
  assert.equal(unreadCd('cd hub && echo "a || b" && ls'), false);
  assert.equal(unreadCd('cd hub && (cd .. ; node evil.mjs)'), true, 'a group is still unread');
  assert.equal(unreadCd('cd hub || node evil.mjs'), true, 'a real || is still unread');
  assert.equal(unreadCd('cd hub && { cd ..; node evil.mjs; }'), true);
  assert.equal(unreadCd('cd "$TEMP/x" && ls'), true, 'a folder it cannot work out is still unread');
});

test('the study replay: test runs and rule-module stops are re-judged, another project\'s folder escalates, long (cut) lines stay held back', () => {
  const line = (o) => ({ type: 'check_shadow', ts: '2026-11-16T10:00:00Z', valid: true, tool: 'Bash', ...o });
  const events = [
    line({ answer: 'consult', rawAnswer: 'allow', downgraded: true, unread: true, command: 'cd hub && node --test test/a.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"' }),
    line({ answer: 'consult', rawAnswer: 'allow', downgraded: true, unread: true, command: 'node tools/other.mjs' }),
    line({ answer: 'consult', rawAnswer: 'allow', downgraded: true, unread: true, command: 'node --test test/a.test.mjs ' + 'x'.repeat(400) }),
    line({ answer: 'escalate', rawAnswer: 'consult', scanStops: ['permission-rules.mjs (imported): it runs "gh pr merge", a hard stop'], command: 'node --test test/a.test.mjs' }),
    line({ answer: 'escalate', rawAnswer: 'allow', unread: true, scanStops: ['permission-rules.mjs (imported): it runs "gh pr merge", a hard stop'], command: 'node tools/other.mjs' }),
    line({ answer: 'allow', rawAnswer: 'allow', command: `cat ${slash(OTHER)}/.crux/events.jsonl | head -3` }),
    line({ answer: 'allow', rawAnswer: 'allow', command: 'ls' })
  ];
  const r = replayShadow(events, { parseCommand, otherDirs: [OTHER] });
  assert.equal(r.total, 7);
  assert.deepEqual(r.before, { consult: 3, allow: 2, escalate: 2, deny: 0 });
  assert.equal(r.testRuns, 1);
  assert.equal(r.ruleModuleStops, 2);
  assert.equal(r.otherProject, 1);
  assert.deepEqual(r.after, { consult: 5, allow: 2, escalate: 0, deny: 0 }, JSON.stringify(r.after));
});

test('a redirect written as one word (2>&1, >/dev/null) is not a file for node --test to run; a script after a lone > is still read', async () => {
  const files = c => parseCommand(c, { shell: 'bash' }).files.map(f => f.path);
  assert.deepEqual(files('node --test test/a.test.mjs 2>&1 | grep fail'), ['test/a.test.mjs']);
  assert.deepEqual(files('node --test test/a.test.mjs >/dev/null 2>&1'), ['test/a.test.mjs']);
  assert.deepEqual(files('node --test test/a.test.mjs > out.txt evil.mjs'), ['test/a.test.mjs', '>', 'out.txt', 'evil.mjs'], 'a lone ">" keeps every word (nothing is hidden)');
  assert.deepEqual(files('node tools/x.mjs 2>&1'), ['tools/x.mjs']);
  // a redirect to a file is still a write: a command that writes and runs a script is still "not what was read"
  assert.equal(parseCommand('node --test test/a.test.mjs >out.txt', { shell: 'bash' }).mutates, true);
});
