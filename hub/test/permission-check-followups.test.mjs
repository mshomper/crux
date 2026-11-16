// Leftovers from the #95 review: (1) any load of the process module makes a script unread, and a shell script that runs git,
// npm or pip, or uses eval, is a doubt; (2) the project's own tests under hub/test/ are full of strings about git push and
// ~/.ssh because they test the rules, so a stop there needs a real spawn of a stop command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { scanScripts, scriptsFor } from '../lib/permission-check.mjs';
import { scanScriptText } from '../lib/permission-rules.mjs';
import { loadsUnseen } from '../lib/permission-scripts.mjs';

const fakeGit = () => async (args) => (args[0] === 'merge-base' ? { code: 0, out: 'abc\n' } : args[0] === 'status' || args[0] === 'diff' ? { code: 0, out: '' } : { code: 1, out: '' });
const tree = files => {
  const proj = join(makeTmp('crux-followups-'), 'proj');
  mkdirSync(proj, { recursive: true });
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(proj, f, '..'), { recursive: true }); writeFileSync(join(proj, f), text); }
  return proj;
};
const look = (proj, cmd) => scriptsFor(cmd, { cwd: proj, projectDir: proj, git: fakeGit() });

test('1. any load of the process module makes a script unread, aliased or not', async () => {
  const shapes = {
    'a.mjs': "import { execSync } from 'node:child_process';\nexecSync('git status');\n",
    'b.mjs': "import cp from 'child_process';\ncp['exec' + 'Sync']('git ' + 'status');\n",
    'c.cjs': "const { execSync: run } = require('child_process');\nrun('echo hi');\n",
    'd.mjs': "const m = await import('node:child_process');\nm.execSync('echo hi');\n",
    'e.mjs': "import * as proc from 'node:child_process/promises';\n",
    'f.py': 'import subprocess as sp\nsp.run(["git", "status"])\n',
    'g.py': 'from subprocess import run as go\ngo(["git", "status"])\n'
  };
  const proj = tree({ ...shapes, 'plain.mjs': "console.log('hello');\n", 'plain.py': 'print(1)\n' });
  for (const f of Object.keys(shapes)) {
    const r = await look(proj, f.endsWith('.py') ? `python ${f}` : `node ${f}`);
    assert.equal(r.unread, true, f);
    assert.ok(r.scripts[0].loads.some(l => /loads the process module/.test(l)), `${f}: ${r.scripts[0].loads}`);
  }
  assert.equal((await look(proj, 'node plain.mjs')).unread, false);
  assert.equal((await look(proj, 'python plain.py')).unread, false);
  // a one-liner on the command line keeps the narrower rule: execSync('git status') is a plain command
  assert.deepEqual(loadsUnseen(`require('child_process').execSync('git status')`, { inline: true }), []);
});

test('1. a shell script that runs git, npm or pip is a note (the model\'s allow stands); eval is a strong doubt; a plain one is neither', () => {
  assert.ok(scanScriptText('pip install requests\n', { kind: 'shell' }).stops.length > 0, 'pip install is a hard stop in a shell script already');
  for (const text of ['git status\n', 'cd x && npm test\n', 'uv run x.py\n']) {
    const r = scanScriptText(text, { kind: 'shell' });
    assert.ok(r.notes.some(d => /runs git, npm or pip/.test(d)), text);
    assert.deepEqual([r.stops, r.doubts], [[], []], text);
  }
  for (const text of ['cmd="echo hi"\neval "$cmd"\n', 'iex $text\n']) {
    const r = scanScriptText(text, { kind: 'shell' });
    assert.ok(r.doubts.some(d => /eval/.test(d)), text);
    assert.deepEqual(r.stops, [], text);
  }
  const plain = scanScriptText('echo hello\nls -la\nmkdir -p out\n', { kind: 'shell' });
  assert.deepEqual([plain.stops, plain.doubts, plain.notes], [[], [], []]);
  // the same words in a JS file (or only in a comment) are not this note
  assert.ok(!scanScriptText('const git = 1; // npm test\n', { kind: 'js' }).notes.some(d => /runs git, npm or pip/.test(d)));
});

test('2. a changed test under hub/test/ that only mentions stop words is no hard stop; the notes remain', async () => {
  const real = readFileSync(new URL('./permission-rules.test.mjs', import.meta.url), 'utf8');
  const proj = tree({ 'hub/test/permission-rules.test.mjs': real + '\n// changed\n', 'hub/test/ssh.test.mjs': "import { readFileSync } from 'node:fs';\nreadFileSync(join(homedir(), '.ssh', 'id_rsa'));\n" });
  for (const f of ['permission-rules.test.mjs', 'ssh.test.mjs']) {
    const scan = scanScripts(await look(proj, `node --test hub/test/${f}`));
    assert.deepEqual(scan.stops, [], f);
    assert.ok(scan.notes.length > 0, `${f}: still noted, for the model to read`);
  }
});

test('2. in hub/test/, a real spawn of a stop command is still a stop; the same file elsewhere is a stop for every pattern', async () => {
  const spawnPush = "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['push', 'origin', 'HEAD:main']);\n";
  const proj = tree({ 'hub/test/x.test.mjs': spawnPush, 'tools/x.mjs': spawnPush, 'tools/ssh.mjs': "readFileSync(join(homedir(), '.ssh', 'id_rsa'));\n" });
  assert.ok(scanScripts(await look(proj, 'node --test hub/test/x.test.mjs')).stops.some(s => /git push/.test(s)), 'a real spawn in a test is a stop');
  assert.ok(scanScripts(await look(proj, 'node tools/x.mjs')).stops.length > 0);
  assert.ok(scanScripts(await look(proj, 'node tools/ssh.mjs')).stops.length > 0, 'outside hub/test/ nothing changes');
  // a test that spawns something else and merely names push elsewhere is not a stop
  const t = scanScriptText("execFileSync('git', ['status']);\nconst cases = ['git push origin main'];\nclassify({ command: 'git push origin main' });\n", { test: true });
  assert.deepEqual(t.stops, []);
  assert.ok(t.notes.some(d => /git push/.test(d)));
});

// ---------- round 2 of the #99 review ----------
import { symlinkSync, mkdtempSync } from 'node:fs';
import { isProjectTest } from '../lib/permission-scripts.mjs';

test('R2-1. require( or import( with anything but one plain string literal is a name built at run time: unread', async () => {
  const shapes = {
    'a.cjs': "const m = require('child' + '_process');\nm.execSync('echo hi');\n",
    'b.cjs': "const x = 'process';\nconst m = require(`child_${x}`);\n",
    'c.cjs': "const name = ['child', 'process'].join('_');\nrequire(name);\n",
    'd.mjs': "const m = await import('child' + '_process');\n",
    'e.mjs': "const m = await import(`node:child_${'process'}`);\n",
    'f.cjs': "const m = require('node:child' + '_process');\n"
  };
  const proj = tree({ ...shapes, 'ok.cjs': "const fs = require('node:fs');\nconst p = require(`node:path`);\nconsole.log(typeof fs, typeof p);\n" });
  for (const f of Object.keys(shapes)) {
    const r = await look(proj, `node ${f}`);
    assert.equal(r.unread, true, f);
    assert.ok(r.scripts[0].loads.includes('loads a file named at run time'), `${f}: ${r.scripts[0].loads}`);
  }
  assert.equal((await look(proj, 'node ok.cjs')).unread, false, 'plain literals are fine');
  // pieces joined with + are an obscured-text doubt as well
  assert.ok(scanScriptText("run('pu' + 'sh')").doubts.some(d => /joins short pieces/.test(d)));
  assert.ok(!scanScriptText("const s = 'a fairly long sentence about nothing at all' + ' and another long one here';").doubts.some(d => /joins short pieces/.test(d)));
});

test('R2-2. a path is a test only when its real path is inside the project and under hub/test/', async () => {
  const root = makeTmp('crux-followups-r2-');
  const proj = join(root, 'proj'), outside = join(root, 'outside');
  for (const d of [join(proj, 'hub', 'test'), join(proj, '.claude', 'worktrees', 'w1', 'hub', 'test'), join(proj, 'other', 'hub', 'test'), join(proj, 'hub', 'testing'), outside]) mkdirSync(d, { recursive: true });
  const files = { in: join(proj, 'hub', 'test', 'x.test.mjs'), wt: join(proj, '.claude', 'worktrees', 'w1', 'hub', 'test', 'x.test.mjs'), nested: join(proj, 'other', 'hub', 'test', 'x.test.mjs'),
    sibling: join(proj, 'hub', 'testing', 'x.test.mjs'), out: join(outside, 'x.test.mjs') };
  for (const f of Object.values(files)) writeFileSync(f, 'x');
  assert.equal(isProjectTest(files.in, proj), true);
  assert.equal(isProjectTest(files.wt, proj), true, 'in one of the project\'s worktrees');
  assert.equal(isProjectTest(files.nested, proj), false, 'some other hub/test');
  assert.equal(isProjectTest(files.sibling, proj), false);
  assert.equal(isProjectTest(files.out, proj), false, 'outside the project');
  assert.equal(isProjectTest(files.in, null), false);
  // a junction at hub/test that points outside: the real path decides
  const proj2 = join(root, 'proj2');
  mkdirSync(join(proj2, 'hub'), { recursive: true });
  symlinkSync(outside, join(proj2, 'hub', 'test'), 'junction');
  assert.equal(isProjectTest(join(proj2, 'hub', 'test', 'x.test.mjs'), proj2), false, 'a link to a folder outside the project');
  // and scriptsFor passes it through to the scan: the same words are a stop in the linked file, a doubt in a real test
  const words = "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['push', 'origin', 'HEAD:main']);\n";
  writeFileSync(join(outside, 'y.test.mjs'), words);
  assert.ok(scanScripts(await look(proj2, 'node --test hub/test/y.test.mjs')).stops.length > 0);
});

test('R2-2. in a test, a stop stays when the file loads the process module in code and the command sits next to a spawn, wrappers included', () => {
  const wrapper = "import { execSync } from 'node:child_process';\nconst sh = c => execSync(c);\nsh('git push origin main');\n";
  assert.ok(scanScriptText(wrapper, { test: true }).stops.some(s => /git push/.test(s)), 'a wrapper around execSync');
  const required = "const { execSync } = require('child_process');\nexecSync('git push origin main');\n";
  assert.ok(scanScriptText(required, { test: true }).stops.length > 0);
  // the process module named only in data does not count; nor do words with no process module at all
  const data = "const cases = ['node -e \"require(\'child_process\').execSync(\'git push\')\"', 'git push'];\nclassify({ command: cases[0] });\n";
  assert.deepEqual(scanScriptText(data, { test: true }).stops, []);
  assert.deepEqual(scanScriptText("execSync('git push origin main');\n", { test: true }).stops, [], 'no import: it cannot start anything');
  // a test that loads it and also names ~/.ssh as data: the secret is a doubt, the command (if any) a stop
  const mixed = scanScriptText("import { execFileSync } from 'node:child_process';\nconst ssh = '.ssh';\nreadFileSync(join(homedir(), '.ssh', 'id_rsa'));\nexecFileSync('git', ['status']);\n", { test: true });
  assert.deepEqual(mixed.stops, []);
  assert.ok(mixed.notes.some(d => /\.ssh/.test(d)));
});

test('R2-3. shell: git, npm or pip after a path separator is a note, and a command word held in a variable is a strong doubt', () => {
  for (const text of ['/usr/bin/git status\n', String.raw`C:\Program Files\Git\bin\git.exe status` + '\n', 'cd x && /usr/local/bin/npm test\n', './node_modules/.bin/../../bin/pip3 list\n'])
    assert.ok(scanScriptText(text, { kind: 'shell' }).notes.some(d => /runs git, npm or pip/.test(d)), text);
  for (const text of ['g=git\n$g status\n', 'g=git\n${g} status\n', 'g=git; $g push\n', '& $g status\n', '%g% status\n'])
    assert.ok(scanScriptText(text, { kind: 'shell' }).doubts.some(d => /command held in a variable/.test(d)), text);
  // assignments and ordinary words are not
  for (const text of ['g=git\n$x = 5\necho done\n', 'echo $g\nls -la\n'])
    assert.ok(!scanScriptText(text, { kind: 'shell' }).doubts.some(d => /command held in a variable/.test(d)), text);
});
