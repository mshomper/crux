// Decision 67: with the permission check ON for a project, a worker request that Auto would allow only because it runs a
// script inside the project goes to the check when the script chain is not committed and unchanged from main (or is
// unread); committed, unchanged scripts stay allowed at once. In shadow mode it is allowed as today and the check only
// logs check_shadow. Off: unchanged. The model is a stub; git is a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { CHECK_MODEL, CHECK_NAME, PermissionCheck } from '../lib/permission-check.mjs';
import { compareShadow } from '../tools/permission-study.mjs';

const sent = [];
Agent.prototype.send = function (t) { sent.push([this.name, t]); this.state = 'working'; };
Agent.prototype.close = function () { this.q = null; };

const RULES = 'The orchestrator may ALLOW project work. ALWAYS goes to Matt: pushing to main.';
const tick = () => new Promise(r => setImmediate(r));
async function settle() { for (let i = 0; i < 10; i++) await tick(); }
const last = (p, type) => p.log.ofType(type).at(-1);

// tracked: file names git reports as committed and clean; dirty: tracked but changed.
function setup({ mode = 'on', tracked = [], dirty = [], replies = [{ answer: 'allow', reason: 'reads the script, harmless' }], level = 'auto' } = {}) {
  sent.length = 0;
  const root = makeTmp('crux-check-gate-');
  const dir = join(root, 'proj');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'x.mjs'), 'console.log("project script")');
  writeFileSync(join(dir, 'scripts', 'x.sh'), 'echo project');
  writeFileSync(join(dir, 'scripts', 'x.ps1'), 'Write-Host project');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'node scripts/x.mjs' } }));
  const calls = [], gitCalls = [];
  let n = 0;
  const call = async arg => {
    calls.push(arg);
    const r = replies[Math.min(n++, replies.length - 1)];
    return { text: JSON.stringify(r), via: 'sdk', tokens: { input: 30, output: 12, cacheRead: 800, cacheCreation: 0 }, modelUsage: { [CHECK_MODEL]: { inputTokens: 30, outputTokens: 12, cacheReadInputTokens: 800, cacheCreationInputTokens: 0, costUSD: 0.004 } }, costUSD: 0.004 };
  };
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }), checker: new PermissionCheck({ call, timeoutMs: 5000 }) });
  hub.checkGit = async (args) => {
    gitCalls.push(args[0]);
    const name = args.at(-1);
    if (args[0] === 'ls-files') return { code: tracked.includes(name) ? 0 : 1, out: '' };
    if (args[0] === 'status') return { code: 0, out: dirty.includes(name) ? ` M ${name}\n` : '' };
    if (args[0] === 'merge-base') return { code: 0, out: 'abc\n' };
    if (args[0] === 'diff') return { code: dirty.includes(name) ? 1 : 0, out: '' };
    return { code: 1, out: '' };
  };
  const p = hub.project('proj');
  p.board.addEntry({ kind: 'requirement', title: 'Orchestrator permission rules (test)', summary: 'rules', body: RULES, from: 'you' });
  const orch = hub.ensureOrchestrator(p); orch.q = {};
  const w = hub.startWorker(p, 'builder', 'Build the feature', 'you', 'Build it');
  w.q = {};
  hub.setPermissionMode(p, level);
  if (mode !== 'off') hub.setCheckMode(p, mode);
  sent.length = 0;
  return { hub, p, orch, w, calls, gitCalls, dir };
}
const ask = (hub, p, w, command, tool = 'Bash') => hub.requestApproval(p, w, tool, { command, description: 'a step' });
const SCRIPTS = [['node scripts/x.mjs', 'Bash', 'x.mjs'], ['bash ./scripts/x.sh', 'Bash', 'x.sh'], ['powershell -File .\\scripts\\x.ps1', 'PowerShell', 'x.ps1'], ['npm run build', 'Bash', 'x.mjs']];

test('Auto alone allows a project script at once (the starting point: check off)', async () => {
  for (const [cmd, tool] of SCRIPTS) {
    const { hub, p, w, calls, gitCalls } = setup({ mode: 'off' });
    const r = await ask(hub, p, w, cmd, tool);
    assert.equal(r.behavior, 'allow', cmd);
    assert.equal(p.log.ofType('approval').length, 0, `${cmd}: no card`);
    assert.equal(gitCalls.length, 0, `${cmd}: nothing was looked up`);
    assert.equal(calls.length, 0);
  }
});

test('on: a committed, unchanged project script stays allowed at once; the check is not asked', async () => {
  for (const [cmd, tool] of SCRIPTS) {
    const { hub, p, w, calls } = setup({ tracked: ['x.mjs', 'x.sh', 'x.ps1', 'package.json'] });
    const r = await ask(hub, p, w, cmd, tool);
    assert.equal(r.behavior, 'allow', cmd);
    assert.equal(p.log.ofType('approval').length, 0, `${cmd}: no card`);
    assert.equal(p.log.ofType('permission_answer').length, 0, `${cmd}: nothing logged, as for any Auto allow`);
    assert.equal(calls.length, 0, `${cmd}: the check was not asked`);
  }
});

test('on: a worker-written (untracked) or changed script goes to the check; its answer decides', async () => {
  for (const [cmd, tool, file] of SCRIPTS) {
    for (const state of [{ tracked: [] }, { tracked: ['x.mjs', 'x.sh', 'x.ps1', 'package.json'], dirty: [file, 'package.json'] }]) {
      const { hub, p, w, calls } = setup({ ...state, replies: [{ answer: 'deny', reason: 'it deletes things outside the project' }] });
      const pending = ask(hub, p, w, cmd, tool);
      await settle();   // the script is looked at first (git, files), so the card follows a moment later
      const ap = last(p, 'approval');
      assert.equal(ap.routedTo, CHECK_NAME, `${cmd}: with the check first`);
      const r = await pending;
      assert.equal(r.behavior, 'deny', cmd);
      assert.match(r.message, /permission check declined: it deletes things outside the project/);
      assert.equal(calls.length, 1, cmd);
      assert.match(calls[0].user, /Auto mode would allow it because it runs a script inside the project, but that script .* is not committed and unchanged from main/);
      assert.ok(calls[0].user.includes('attached in full'), `${cmd}: the script text is attached for the check`);
      assert.equal(last(p, 'permission_answer').by, CHECK_NAME);
    }
  }
  const ok = setup({ tracked: [] });
  assert.equal((await ask(ok.hub, ok.p, ok.w, 'node scripts/x.mjs')).behavior, 'allow', 'the check says allow: it goes ahead');
  assert.equal(last(ok.p, 'permission_answer').answer, 'allow');
  assert.equal(last(ok.p, 'permission_answer').by, CHECK_NAME);
});

test('on: escalate and consult work as for any request; an unread script cannot be allowed by the check', async () => {
  const esc = setup({ tracked: [], replies: [{ answer: 'escalate', reason: 'would change the live hub' }] });
  const pe = ask(esc.hub, esc.p, esc.w, 'node scripts/x.mjs');
  await settle();
  assert.equal(last(esc.p, 'approval_escalated').by, CHECK_NAME);
  esc.hub.answerApproval(last(esc.p, 'approval').approval, true);
  assert.equal((await pe).behavior, 'allow');
  // a script that loads another file is unread: the model's allow is turned into consult, and the orchestrator is asked
  const { hub, p, orch, w, dir } = setup({ tracked: [], replies: [{ answer: 'allow', reason: 'looks fine' }] });
  writeFileSync(join(dir, 'scripts', 'loader.mjs'), "import { go } from './helper.mjs';\ngo();");
  const pending = ask(hub, p, w, 'node scripts/loader.mjs');
  await settle();
  const id = last(p, 'approval').approval;
  assert.equal(last(p, 'permission_answer').answer, 'consult');
  assert.equal(sent.at(-1)[0], orch.name);
  hub.answerPermission(p, orch, id, 'deny', 'not now');
  assert.equal((await pending).behavior, 'deny');
});

test('on: the 5 minutes run from the request, not from the end of the script look-up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { hub, p, w } = setup({ tracked: [], replies: [{ answer: 'consult', reason: 'needs the goal' }] });
  const pending = ask(hub, p, w, 'node scripts/x.mjs');
  await settle();
  t.mock.timers.tick(299_000);
  assert.equal(p.log.ofType('approval_escalated').length, 0);
  t.mock.timers.tick(1_000);
  assert.match(last(p, 'approval_escalated').reason, /5 minutes/);
  hub.answerApproval(last(p, 'approval').approval, false);
  await pending;
});

test('on: only requests that run a script are looked at; a plain command, the orchestrator and MCP tools are not', async () => {
  const { hub, p, orch, w, calls, gitCalls } = setup({ tracked: [] });
  for (const cmd of ['git status --short', 'git log --oneline -3', 'ls -la scripts', 'echo hello']) {
    assert.equal((await ask(hub, p, w, cmd)).behavior, 'allow', cmd);
  }
  assert.equal(gitCalls.length, 0, 'nothing was asked of git');
  assert.equal(p.log.ofType('approval').length, 0);
  // the orchestrator's own request: unchanged (the check is for workers)
  assert.equal((await hub.requestApproval(p, orch, 'Bash', { command: 'node scripts/x.mjs' })).behavior, 'allow');
  assert.equal(calls.length, 0);
  assert.equal(p.log.ofType('approval').length, 0);
  // routing off: nothing asks the check, so Auto allows as before
  hub.settings.set({ routePermissions: false });
  assert.equal((await ask(hub, p, w, 'node scripts/x.mjs')).behavior, 'allow');
  assert.equal(calls.length, 0);
});

test('shadow: allowed at once as today; the check reads the script and logs check_shadow, and the study can compare', async () => {
  for (const [cmd, tool] of SCRIPTS) {
    const { hub, p, w, calls } = setup({ mode: 'shadow', tracked: [], replies: [{ answer: 'deny', reason: 'rewrites a file outside the project' }] });
    const r = await ask(hub, p, w, cmd, tool);
    assert.equal(r.behavior, 'allow', `${cmd}: allowed as today`);
    assert.equal(p.log.ofType('approval').length, 0, `${cmd}: no card`);
    await settle();
    assert.equal(calls.length, 1, `${cmd}: the check ran beside`);
    const sh = last(p, 'check_shadow');
    assert.deepEqual([sh.worker, sh.answer, sh.reason, sh.valid], ['builder', 'deny', 'rewrites a file outside the project', true], cmd);
    assert.equal(sh.thread, undefined);
    const ans = last(p, 'permission_answer');
    assert.deepEqual([ans.approval, ans.answer, ans.by], [sh.approval, 'allow', 'hub'], `${cmd}: the real answer is logged under the same id`);
    const c = compareShadow(p.log.events);
    assert.equal(c.disagree.length, 1, `${cmd}: the study lists it: the check would have denied what Auto allowed`);
    assert.equal(c.disagree[0].real, 'allow');
    assert.equal(last(p, 'usage').shadow, true);
  }
});

test('shadow: a committed, unchanged script is allowed and the check is not run for it', async () => {
  const { hub, p, w, calls } = setup({ mode: 'shadow', tracked: ['x.mjs', 'package.json'] });
  assert.equal((await ask(hub, p, w, 'node scripts/x.mjs')).behavior, 'allow');
  assert.equal((await ask(hub, p, w, 'npm run build')).behavior, 'allow');
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(p.log.ofType('check_shadow').length, 0);
  assert.equal(p.log.ofType('permission_answer').length, 0);
});

test('shadow: a failing check changes nothing for the worker', async () => {
  const { hub, p, w } = setup({ mode: 'shadow', tracked: [], replies: [{ text: 'garbled' }] });
  assert.equal((await ask(hub, p, w, 'node scripts/x.mjs')).behavior, 'allow');
  await settle();
  assert.equal(last(p, 'check_shadow').valid, false);
});

test('a hard stop is still a hard stop, and the pause still holds everything, whatever the check mode', async () => {
  const { hub, p, w, calls } = setup({ tracked: [] });
  ask(hub, p, w, 'git push origin main');
  assert.equal(last(p, 'approval').routedTo, null);
  hub.setPaused(p, true);
  ask(hub, p, w, 'node scripts/x.mjs');
  assert.equal(last(p, 'approval').routedTo, null);
  assert.match(last(p, 'approval').stops[0], /paused/);
  await settle();
  assert.equal(calls.length, 0);
});

test('Ask level is not affected: its requests already go to the orchestrator, or with the check on, to the check', async () => {
  const { hub, p, w, calls } = setup({ level: 'standard', tracked: ['x.mjs'] });
  const pending = ask(hub, p, w, 'node scripts/x.mjs');
  assert.equal(last(p, 'approval').routedTo, CHECK_NAME);
  assert.equal((await pending).behavior, 'allow');
  assert.equal(calls.length, 1);
});
