// The permission check scans the text of every script it attaches (and code written in the command) in code: a hard stop
// in it goes to Matt before any model call; a doubt means the model may not allow. Also the node_modules fact in the prefix.
// The model is a stub that counts its calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { PROMPT, PermissionCheck, buildPrefix, buildSuffix, scanScripts, scriptsFor, EXTRA_FACT, CHECK_MODEL } from '../lib/permission-check.mjs';
import { scanScriptText } from '../lib/permission-rules.mjs';

const fakeGit = (tracked = []) => async (args) => {
  const name = args.at(-1);
  if (args[0] === 'ls-files') return { code: tracked.includes(name) ? 0 : 1, out: '' };
  if (args[0] === 'status') return { code: 0, out: '' };
  if (args[0] === 'merge-base') return { code: 0, out: 'abc\n' };
  if (args[0] === 'diff') return { code: 0, out: '' };
  return { code: 1, out: '' };
};
const tree = files => {
  const proj = join(makeTmp('crux-check-scan-'), 'proj');
  mkdirSync(proj, { recursive: true });
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(proj, f, '..'), { recursive: true }); writeFileSync(join(proj, f), text); }
  return proj;
};
const FACTS = { project: 'proj', dir: 'C:\\work\\proj', temp: 'C:\\Temp', level: 'Auto', rulesId: 'R005', rulesBody: 'Rules.' };
// A checker whose model always says `says`, and counts how often it was asked.
const checker = (says = 'allow') => { const c = { calls: 0, users: [] }; c.run = new PermissionCheck({ call: async ({ user }) => { c.calls++; c.users.push(user); return { text: JSON.stringify({ answer: says, reason: 'looks fine' }), via: 'sdk', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {} }; } }); return c; };
const ask = async (c, proj, command, git = []) => {
  const scripts = await scriptsFor(command, { cwd: proj, projectDir: proj, git: fakeGit(git) });
  return c.run.run({ ...FACTS, dir: proj, worker: 'w', goal: 'g', tool: 'Bash', input: { command }, cwd: proj, doubts: [], scripts });
};

test('the four shapes inside an attached script go to you in code, with no model call', async () => {
  const shapes = {
    'git push to main': "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['push', 'origin', 'HEAD:main']);\n",
    'a write to ~/.claude/agents': "import { writeFileSync } from 'node:fs';\nimport { homedir } from 'node:os';\nimport { join } from 'node:path';\nwriteFileSync(join(homedir(), '.claude', 'agents', 'x.md'), 'hi');\n",
    'a read of ~/.ssh': "import { readFileSync } from 'node:fs';\nconsole.log(readFileSync(process.env.HOME + '/.ssh/id_ed25519', 'utf8'));\n",
    'a POST to the live hub': "await fetch('http://localhost:4747/api/restart', { method: 'POST' });\n"
  };
  for (const [name, text] of Object.entries(shapes)) {
    const proj = tree({ 'tools/x.mjs': text });
    const c = checker('allow');
    const r = await ask(c, proj, 'node tools/x.mjs');
    assert.equal(c.calls, 0, `${name}: the model is not asked`);
    assert.equal(r.valid, true, name);
    assert.equal(r.answer, 'escalate', `${name}: ${r.reason}`);
    assert.match(r.reason, /hard stop|without asking the model/, name);
    assert.equal(r.via, 'code');
  }
});

test('"git" + " push" built up, a PowerShell push, and gh pr merge are caught in script text', () => {
  for (const text of ["run('git ' + 'push origin main')", "cp.spawnSync('git', ['merge', 'feature'])", "Start-Process git -ArgumentList 'push','origin','main'", 'gh pr merge 12 --squash', "exec(`git reset --hard origin/main`)", "execSync('npm install left-pad')"])
    assert.ok(scanScriptText(text).stops.length > 0, text);
  for (const text of ["console.log('hello')", "const merged = items.push(1)", "writeFileSync('out.txt', 'x')", "execFileSync('git', ['status'])", 'function mergeSort(a) { return a }'])
    assert.deepEqual(scanScriptText(text).stops, [], text);
});

test('code written in the command (node -e, a heredoc) is scanned too', async () => {
  const proj = tree({ 'a.mjs': 'console.log(1)' });
  const c = checker('allow');
  const r = await ask(c, proj, `node -e "require('child_process').execFileSync('git',['push','origin','HEAD:main'])"`);
  assert.equal(r.answer, 'escalate');
  assert.equal(c.calls, 0);
  const h = await ask(c, proj, "node - <<'EOF'\nfetch('http://127.0.0.1:4748/x', { method: 'POST' })\nEOF");
  assert.equal(h.answer, 'escalate');
  assert.equal(c.calls, 0);
});

test('a doubt-level finding means the model may not allow: an allow becomes consult, and the model is told', async () => {
  const proj = tree({ 'tools/net.mjs': "const r = await fetch('https://example.com/data.json');\nconsole.log(await r.text());\n" });
  const c = checker('allow');
  const r = await ask(c, proj, 'node tools/net.mjs');
  assert.equal(c.calls, 1);
  assert.equal(r.answer, 'consult');
  assert.equal(r.downgraded, true);
  assert.equal(r.raw, 'allow');
  assert.match(r.reason, /scan of a script's text found a doubt/);
  assert.match(c.users[0], /hub's own scan of the script text found the following/);
  assert.match(c.users[0], /net\.mjs: it uses the network/);
  // a model that says deny or escalate keeps its word
  const d = checker('deny');
  assert.equal((await ask(d, proj, 'node tools/net.mjs')).answer, 'deny');
});

test('a clean attached script is still the model\'s to allow; a committed script is not scanned', async () => {
  const proj = tree({ 'tools/ok.mjs': "console.log('hello');\n", 'tools/pushy.mjs': "execFileSync('git', ['push', 'origin', 'HEAD:main'])" });
  const c = checker('allow');
  const r = await ask(c, proj, 'node tools/ok.mjs');
  assert.equal(r.answer, 'allow');
  assert.equal(c.calls, 1);
  assert.doesNotMatch(c.users[0], /hub's own scan/);
  const t = await ask(c, proj, 'node tools/pushy.mjs', ['pushy.mjs']);   // committed and unchanged: the project's reviewed code
  assert.equal(c.calls, 2, 'asked the model');
  assert.equal(t.valid, true);
});

test('a hard stop past the 16 KB the model is sent is still found', async () => {
  const proj = tree({ 'tools/big.mjs': `// ${'x'.repeat(20000)}\nexecFileSync('git', ['push', 'origin', 'HEAD:main'])\n` });
  const scripts = await scriptsFor('node tools/big.mjs', { cwd: proj, projectDir: proj, git: fakeGit() });
  assert.equal(scripts.scripts[0].cutOff, true);
  assert.ok(!scripts.scripts[0].text.includes('push'), 'the model does not see it');
  assert.ok(scanScripts(scripts).stops.length > 0);
});

test('shadow and on use the same path: an escalate in code needs no model, whatever it would have said', async () => {
  const proj = tree({ 'tools/x.mjs': "fetch('http://localhost:4747/api/state', { method: 'POST' })" });
  for (const says of ['allow', 'deny', 'consult', 'escalate']) {
    const c = checker(says);
    assert.equal((await ask(c, proj, 'node tools/x.mjs')).answer, 'escalate');
    assert.equal(c.calls, 0);
  }
});

test('the prefix says node_modules may be a junction, after the plan\'s facts and before the rules; the plan text is otherwise unchanged', () => {
  const s = buildPrefix(FACTS);
  assert.ok(s.includes(EXTRA_FACT));
  assert.match(EXTRA_FACT, /node_modules.*junction.*project's own packages.*changes the main project/);
  assert.ok(s.indexOf('Hard stops can\n  still hide inside what it could not read: finding them is your main job.') < s.indexOf(EXTRA_FACT));
  assert.ok(s.indexOf(EXTRA_FACT) < s.indexOf("THE PROJECT'S RULES"));
  assert.ok(!PROMPT.includes('node_modules'),'PROMPT itself is the plan\'s text, untouched');
  assert.equal(s.replace(`\n${EXTRA_FACT}`, ''), buildPrefix({ ...FACTS }).replace(`\n${EXTRA_FACT}`, ''));
  // without the line, the prefix is exactly what the plan's prompt makes
  const plain = PROMPT.replace('<project>\\.claude\\worktrees\\<name>', () => `${FACTS.dir}\\.claude\\worktrees\\<name>`);
  assert.equal(s.replace(`\n${EXTRA_FACT}`, '').length, plain.replace(/<rules body>|<posix dir>|<project>|<dir>|<temp>|<level>|<id>/g, m => ({ '<rules body>': FACTS.rulesBody, '<posix dir>': '/c/work/proj', '<project>': 'proj', '<dir>': FACTS.dir, '<temp>': FACTS.temp, '<level>': FACTS.level, '<id>': FACTS.rulesId })[m]).length);
});
