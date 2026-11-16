// The permission check scans the text of every script it attaches (and code written in the command) in code: a hard stop
// in it goes to Matt before any model call; a doubt means the model may not allow. Also the node_modules fact in the prefix.
// The model is a stub that counts its calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { PermissionCheck, scanScripts, scriptsFor } from '../lib/permission-check.mjs';
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
  for (const text of ["exec('git ' + 'push origin main')", "cp.spawnSync('git', ['merge', 'feature'])", "Start-Process git -ArgumentList 'push','origin','main'", "execSync('gh pr merge 12 --squash')", "exec(`git reset --hard origin/main`)", "execSync('npm install left-pad')"])
    assert.ok(scanScriptText(text).stops.length > 0, text);
  for (const text of ["console.log('hello')", "const merged = items.push(1)", "writeFileSync('out.txt', 'x')", "execFileSync('git', ['status'])", 'function mergeSort(a) { return a }'])
    assert.deepEqual(scanScriptText(text).stops, [], text);
  // a shell script is all commands: the same words are stops there without a call next to them
  assert.ok(scanScriptText('git push origin HEAD:main\n', { kind: 'shell' }).stops.length > 0);
});

test('round 2 (#95 review): words are a hard stop only where they do something; elsewhere they are doubts', () => {
  // text that only mentions: a test's data, a message, a table of rules
  for (const text of ["const cases = ['git push origin main', 'gh pr merge 12']", "console.log('Open http://localhost:4747/ in your browser')", "const dir = join(homedir(), '.crux-hub');", "const home = '~/crux'; const env = '.env';", "const p = 4747;"]) {
    const r = scanScriptText(text);
    assert.deepEqual(r.stops, [], text);
  }
  // words are notes: shown to the model, its allow stands (the narrowing of #101); the strong doubts are in the other tests
  assert.ok(scanScriptText("const dir = join(homedir(), '.crux-hub');").notes.length > 0, 'a note');
  assert.deepEqual(scanScriptText("const dir = join(homedir(), '.crux-hub');").doubts, []);
  assert.ok(scanScriptText("const cases = ['git push origin main']").notes.some(d => /git push/.test(d)));
  // where it does something
  for (const text of ["await fetch(`http://localhost:4747/api/x`, { method: 'POST' })", "execSync('git push origin main')", "readFileSync(join(homedir(), '.ssh', 'id_rsa'))", "rmSync(join(homedir(), '.claude', 'agents'), { recursive: true })"])
    assert.ok(scanScriptText(text).stops.length > 0, text);
});

test('the hub\'s own server.mjs, changed, run as `node hub/server.mjs --port 4800`, has no hard stop (it names .crux-hub, ~/crux and 4747)', async () => {
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.ok(/\.crux-hub|crux/.test(src) && /4747/.test(src), 'the file does name them');
  const proj = tree({ 'hub/server.mjs': src + '\n// changed by the worker\n' });
  const scripts = await scriptsFor('node hub/server.mjs --port 4800', { cwd: proj, projectDir: proj, git: fakeGit() });
  assert.equal(scripts.scripts[0].kind, 'attached');
  const scan = scanScripts(scripts);
  assert.deepEqual(scan.stops, [], 'no hard stop');
});

test('the relative imports of an attached script are scanned too: run.mjs imports push.mjs, which force-pushes', async () => {
  const proj = tree({ 'tools/run.mjs': "import { go } from './push.mjs';\ngo();\n", 'tools/push.mjs': "import { execFileSync } from 'node:child_process';\nexport const go = () => execFileSync('git', ['push', '--force', 'origin', 'HEAD:main']);\n", 'tools/safe.mjs': "export const x = 1;\n" });
  const scripts = await scriptsFor('node tools/run.mjs', { cwd: proj, projectDir: proj, git: fakeGit() });
  assert.deepEqual(scripts.imports.map(i => i.path.split(/[\\/]/).pop()), ['push.mjs']);
  const scan = scanScripts(scripts);
  assert.ok(scan.stops.some(s => /push\.mjs \(imported\)/.test(s) && /git/.test(s)), scan.stops.join('|'));
  const c = checker('allow');
  const r = await c.run.run({ ...FACTS, dir: proj, worker: 'w', goal: 'g', tool: 'Bash', input: { command: 'node tools/run.mjs' }, cwd: proj, doubts: [], scripts });
  assert.equal(r.answer, 'escalate');
  assert.equal(c.calls, 0);
  // a committed, unchanged import is the project's reviewed code: followed, not scanned
  const ok = await scriptsFor('node tools/run.mjs', { cwd: proj, projectDir: proj, git: fakeGit(['push.mjs']) });
  assert.deepEqual(ok.imports, []);
});

test('npm pre and post hooks of a package script are read and scanned', async () => {
  const proj = tree({ 'package.json': JSON.stringify({ scripts: { build: 'node tools/ok.mjs', prebuild: 'node tools/pre.mjs', postbuild: 'node tools/post.mjs' } }),
    'tools/ok.mjs': 'console.log(1)', 'tools/pre.mjs': "execFileSync('git', ['push', 'origin', 'HEAD:main'])", 'tools/post.mjs': "await fetch('http://127.0.0.1:4748/api/restart')" });
  const scripts = await scriptsFor('npm run build', { cwd: proj, projectDir: proj, git: fakeGit() });
  const scan = scanScripts(scripts);
  assert.ok(scan.stops.some(s => /^pre\.mjs/.test(s)), 'prebuild: ' + scan.stops.join('|'));
  assert.ok(scan.stops.some(s => /^post\.mjs/.test(s)), 'postbuild: ' + scan.stops.join('|'));
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

test('a strong doubt means the model may not allow: an allow becomes consult, and the model is told; a word note does not', async () => {
  const proj = tree({ 'tools/obscured.mjs': "const w = 'pu' + 'sh';\nconsole.log(w);\n", 'tools/net.mjs': "const r = await fetch('https://example.com/data.json');\nconsole.log(await r.text());\n" });
  const c = checker('allow');
  const r = await ask(c, proj, 'node tools/obscured.mjs');
  assert.equal(c.calls, 1);
  assert.equal(r.answer, 'consult');
  assert.equal(r.downgraded, true);
  assert.equal(r.raw, 'allow');
  assert.match(r.reason, /scan of a script's text found a doubt/);
  assert.match(c.users[0], /hub's own scan of the script text found the following, so you may not allow/);
  assert.match(c.users[0], /obscured\.mjs: it joins short pieces/);
  // a model that says deny or escalate keeps its word
  const d = checker('deny');
  assert.equal((await ask(d, proj, 'node tools/obscured.mjs')).answer, 'deny');
  // a word (the network) is a note: shown to the model, and its allow stands
  const n = checker('allow');
  const a = await ask(n, proj, 'node tools/net.mjs');
  assert.equal(a.answer, 'allow');
  assert.equal(a.downgraded, false);
  assert.match(n.users[0], /also noticed these words in the script text. They are notes, not findings/);
  assert.match(n.users[0], /net\.mjs: it uses the network/);
  assert.doesNotMatch(n.users[0], /so you may not allow/);
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

// ---------- the hub: shadow changes nothing live; only "on" escalates for a scan hard stop ----------
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
const sent = [];
Agent.prototype.send = function (t) { sent.push([this.name, t]); this.state = 'working'; };
Agent.prototype.close = function () { this.q = null; };
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };

function hubWith(mode, scriptText) {
  sent.length = 0;
  const root = makeTmp('crux-check-scanhub-');
  const dir = join(root, 'proj');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  writeFileSync(join(dir, 'tools', 'x.mjs'), scriptText);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'node tools/x.mjs' } }));
  const calls = [];
  const checker = new PermissionCheck({ call: async arg => { calls.push(arg); return { text: '{"answer":"allow","reason":"fine"}', via: 'sdk', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {} }; } });
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }), checker });
  hub.checkGit = async () => ({ code: 1, out: '' });
  const p = hub.project('proj');
  p.board.addEntry({ kind: 'requirement', title: 'Orchestrator permission rules (test)', summary: 'rules', body: 'The orchestrator may ALLOW project work.', from: 'you' });
  const orch = hub.ensureOrchestrator(p); orch.q = {};
  const w = hub.startWorker(p, 'builder', 'Build it', 'you', 'Build it');
  w.q = {};
  hub.setCheckMode(p, mode);
  sent.length = 0;
  return { hub, p, orch, w, calls };
}
const PUSH = "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['push', 'origin', 'HEAD:main']);\n";

test('shadow: a scan hard stop changes nothing live: the request goes to the orchestrator at once with no note; the model is still asked; check_shadow logs both', async () => {
  const { hub, p, orch, w, calls } = hubWith('shadow', PUSH);
  hub.requestApproval(p, w, 'Bash', { command: 'npm run build', description: 'a step' });
  // at once, in the same tick, before any scan has run
  const msgs = sent.filter(([n]) => n === orch.name);
  assert.equal(msgs.length, 1);
  assert.doesNotMatch(msgs[0][1], /scan|shadow|permission check/i, 'no word about the check in the request text');
  await settle();
  const a = [...hub.approvals.values()].at(-1);
  assert.equal(a.escalated, false, 'nothing was escalated to you');
  assert.equal(a.routedTo, orch.name);
  assert.equal(p.log.ofType('permission_answer').filter(e => e.by === 'permission check').length, 0, 'the check answered nothing');
  assert.equal(calls.length, 1, 'the model was asked, so the study sees what it says on the dangerous cases');
  const sh = p.log.ofType('check_shadow').at(-1);
  assert.equal(sh.answer, 'escalate', 'what On would do');
  assert.equal(sh.rawAnswer, 'allow', 'what the model said');
  assert.ok(sh.scanStops.some(s => /git push/.test(s)), 'the finding is in the log line');
  assert.match(sh.reason, /The model said allow/);
});

test('shadow: a clean script adds nothing; the shadow run still logs', async () => {
  const { hub, p, orch, w, calls } = hubWith('shadow', "console.log('hello')\n");
  hub.requestApproval(p, w, 'Bash', { command: 'npm run build', description: 'a step' });
  await settle();
  assert.doesNotMatch(sent.find(([n]) => n === orch.name)[1], /own scan/);
  assert.equal(calls.length, 1);
  const sh = p.log.ofType('check_shadow').at(-1);
  assert.equal(sh.answer, 'allow');
  assert.equal(sh.scanStops, undefined);
});

test('shadow: a scan slower than 2 s, or one that throws, never delays or changes the request', async () => {
  // slow: the git look-up hangs; the orchestrator already has the request
  const slow = hubWith('shadow', PUSH);
  slow.hub.checkGit = () => new Promise(() => { });
  slow.hub.requestApproval(slow.p, slow.w, 'Bash', { command: 'npm run build', description: 'a step' });
  assert.equal(sent.filter(([n]) => n === slow.orch.name).length, 1, 'sent at once');
  assert.doesNotMatch(sent.find(([n]) => n === slow.orch.name)[1], /scan/i);
  await settle();
  assert.equal([...slow.hub.approvals.values()].at(-1).escalated, false);
  // throws: the scan fails; the request is as today, and nothing is logged as an answer
  const bad = hubWith('shadow', PUSH);
  bad.hub.checkRequest = async () => { throw new Error('scan failed'); };
  bad.hub.requestApproval(bad.p, bad.w, 'Bash', { command: 'npm run build', description: 'a step' });
  assert.equal(sent.filter(([n]) => n === bad.orch.name).length, 1);
  await settle();
  const a = [...bad.hub.approvals.values()].at(-1);
  assert.equal(a.escalated, false);
  assert.equal(a.routedTo, bad.orch.name);
  assert.equal(bad.p.log.ofType('check_shadow').at(-1).valid, false, 'logged as no valid answer');
  assert.equal(bad.p.log.ofType('permission_answer').length, 0);
});

test('on: the same scan hard stop escalates to you in code, with no model call and no orchestrator message', async () => {
  const { hub, p, orch, w, calls } = hubWith('on', PUSH);
  hub.requestApproval(p, w, 'Bash', { command: 'npm run build', description: 'a step' });
  await settle();
  const a = [...hub.approvals.values()].at(-1);
  assert.equal(a.escalated, true, 'a card for you');
  assert.equal(calls.length, 0);
  assert.equal(sent.filter(([n]) => n === orch.name).length, 0, 'the orchestrator was not asked');
});
