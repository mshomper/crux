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

test('1. a shell script that runs git, npm or pip, or uses eval, is a doubt; a plain one is not', () => {
  assert.ok(scanScriptText('pip install requests\n', { kind: 'shell' }).stops.length > 0, 'pip install is a hard stop in a shell script already');
  for (const [text, re] of [['git status\n', /runs git, npm or pip/], ['cd x && npm test\n', /runs git, npm or pip/], ['uv run x.py\n', /runs git, npm or pip/],
    ['cmd="echo hi"\neval "$cmd"\n', /eval/], ['iex $text\n', /eval/]]) {
    const r = scanScriptText(text, { kind: 'shell' });
    assert.ok(r.doubts.some(d => re.test(d)), text);
    assert.deepEqual(r.stops, [], text);
  }
  const plain = scanScriptText('echo hello\nls -la\nmkdir -p out\n', { kind: 'shell' });
  assert.deepEqual([plain.stops, plain.doubts], [[], []]);
  // the same words in a JS file are not this doubt
  assert.ok(!scanScriptText('const git = 1; // npm test\n', { kind: 'js' }).doubts.some(d => /runs git, npm or pip/.test(d)));
});

test('2. a changed test under hub/test/ that only mentions stop words is no hard stop; the doubts remain', async () => {
  const real = readFileSync(new URL('./permission-rules.test.mjs', import.meta.url), 'utf8');
  const stopWords = scanScriptText(real);
  assert.ok(stopWords.stops.length > 0, 'as a plain script it would be a hard stop (the leftover)');
  const proj = tree({ 'hub/test/permission-rules.test.mjs': real + '\n// changed\n', 'hub/test/ssh.test.mjs': "import { readFileSync } from 'node:fs';\nreadFileSync(join(homedir(), '.ssh', 'id_rsa'));\n" });
  for (const f of ['permission-rules.test.mjs', 'ssh.test.mjs']) {
    const scan = scanScripts(await look(proj, `node --test hub/test/${f}`));
    assert.deepEqual(scan.stops, [], f);
    assert.ok(scan.doubts.length > 0, `${f}: still a doubt, so the model may not allow`);
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
  assert.ok(t.doubts.some(d => /git push/.test(d)));
});
