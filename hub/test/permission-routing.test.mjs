// Decision 21 A: workers' permission requests go to the orchestrator first, within the board's rules; hard stops,
// escalations, timeouts and the off switch bring the card to you. Agents are stubbed; nothing reaches Claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';   // homedir: a path outside both the project and temp
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { CommandPolicy } from '../lib/permissions.mjs';
import { cardsFor } from '../lib/push.mjs';

const sent = [];
Agent.prototype.send = function (t) { sent.push([this.name, t]); this.state = 'working'; };
Agent.prototype.close = function () { this.q = null; };

const RULES = 'The orchestrator may ALLOW project work. ALWAYS goes to Matt: pushing to main.';
function setup({ rules = true, orchestrator = true, live = true, settings = {} } = {}) {
  sent.length = 0;
  const root = mkdtempSync(join(tmpdir(), 'crux-route-test-'));
  const dir = join(root, 'proj');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null, initial: settings }) });
  const p = hub.project('proj');
  if (rules) p.board.addEntry({ kind: 'requirement', title: 'Orchestrator permission rules (test)', summary: 'rules', body: RULES, from: 'you' });
  let orch = null;
  if (orchestrator) { orch = hub.ensureOrchestrator(p); if (live) orch.q = {}; }
  const w = hub.startWorker(p, 'builder', 'Build the routing feature', 'you', 'Build permission routing');
  sent.length = 0;
  return { hub, p, orch, w };
}
const ask = (hub, p, w, command, tool = 'Bash') => hub.requestApproval(p, w, tool, tool === 'Bash' ? { command, description: 'a step' } : command);
const last = (p, type) => p.log.ofType(type).at(-1);

test('a worker request with no hard stop goes to the running orchestrator, with everything it needs', () => {
  const { hub, p, orch, w } = setup();
  ask(hub, p, w, 'npm run build');
  const ap = last(p, 'approval');
  assert.equal(ap.routedTo, orch.name);
  assert.equal(ap.rules, 'R001');
  assert.equal(sent.length, 1);
  const [to, msg] = sent[0];
  assert.equal(to, orch.name);
  for (const bit of [`[Permission request ${ap.approval}]`, 'Worker: builder', "Worker's goal: Build permission routing", 'Tool: Bash', 'npm run build', 'answer_permission', 'R001']) assert.ok(msg.includes(bit), bit);
  assert.deepEqual(cardsFor({ ...ap, project: 'proj' }), [], 'no phone push while the orchestrator has it');
});

test('the orchestrator allows: the worker goes ahead and the answer is logged as one line in its thread', async () => {
  const { hub, p, orch, w } = setup();
  const pending = ask(hub, p, w, 'npm run build');
  const id = last(p, 'approval').approval;
  assert.match(hub.answerPermission(p, orch, id, 'allow', 'builds the project (R001)'), /Allowed/);
  assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { command: 'npm run build', description: 'a step' } });
  const line = last(p, 'permission_answer');
  assert.deepEqual({ thread: line.thread, worker: line.worker, tool: line.tool, command: line.command, answer: line.answer, reason: line.reason, by: line.by },
    { thread: 'orchestrator', worker: 'builder', tool: 'Bash', command: 'npm run build', answer: 'allow', reason: 'builds the project (R001)', by: orch.name });
  assert.equal(last(p, 'approval_result').how, `allowed by ${orch.name}`);
  assert.match(hub.answerPermission(p, orch, id, 'allow', 'again'), /no longer waiting/);
});

test('the orchestrator denies: the worker sees the reason', async () => {
  const { hub, p, orch, w } = setup();
  const pending = ask(hub, p, w, 'node scripts/unrelated.mjs');
  const id = last(p, 'approval').approval;
  assert.match(hub.answerPermission(p, orch, id, 'deny', ''), /reason/, 'a reason is required');
  hub.answerPermission(p, orch, id, 'deny', 'not part of the routing task');
  const r = await pending;
  assert.equal(r.behavior, 'deny');
  assert.match(r.message, /not part of the routing task/);
  assert.equal(last(p, 'permission_answer').answer, 'deny');
});

test('escalate brings the card to you, with a phone push, and you answer it as before', async () => {
  const { hub, p, orch, w } = setup();
  const pending = ask(hub, p, w, 'node scripts/migrate.mjs');
  const id = last(p, 'approval').approval;
  hub.answerPermission(p, orch, id, 'escalate', 'changes stored data; Matt should look');
  const esc = last(p, 'approval_escalated');
  assert.equal(esc.approval, id);
  assert.equal(esc.by, orch.name);
  assert.equal(last(p, 'permission_answer').answer, 'escalate');
  assert.deepEqual(cardsFor({ ...esc, project: 'proj' }).map(c => c.card), [`approval:${id}`]);
  assert.match(hub.answerPermission(p, orch, id, 'allow', 'changed my mind'), /already with/);
  hub.answerApproval(id, true);
  assert.equal((await pending).behavior, 'allow');
});

test('hard stops never reach the orchestrator', async () => {
  const { hub, p, w } = setup();
  for (const cmd of ['git push origin main', 'git -C hub push --force origin feat/x', 'npm test && git push origin master', 'npm install zod', `echo x > "${join(homedir(), 'notes.txt').replace(/\\/g, '/')}"`, 'curl https://example.com', 'node server.mjs', 'gh pr merge 3']) {
    ask(hub, p, w, cmd);
    const ap = last(p, 'approval');
    assert.equal(ap.routedTo, null, cmd);
    assert.ok(ap.stops.length, cmd);
    assert.deepEqual(cardsFor({ ...ap, project: 'proj' }).map(c => c.kind), ['approval'], `phone push for ${cmd}`);
  }
  assert.equal(sent.length, 0);
});

test('no answer within the timeout: the card comes to you', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { hub, p, orch, w } = setup();
  const pending = ask(hub, p, w, 'npm run build');
  const id = last(p, 'approval').approval;
  t.mock.timers.tick(119_000);
  assert.equal(p.log.ofType('approval_escalated').length, 0);
  t.mock.timers.tick(1_000);
  const esc = last(p, 'approval_escalated');
  assert.equal(esc.approval, id);
  assert.equal(esc.by, 'hub');
  assert.match(esc.reason, /2 minutes/);
  assert.equal(last(p, 'permission_answer').answer, 'timeout');
  assert.match(hub.answerPermission(p, orch, id, 'allow', 'late'), /already with/);
  hub.answerApproval(id, false, 'no');
  assert.equal((await pending).behavior, 'deny');
});

test('you can override a request the orchestrator still has; the audit line says so', async () => {
  const { hub, p, orch, w } = setup();
  const pending = ask(hub, p, w, 'npm run build');
  const id = last(p, 'approval').approval;
  hub.answerApproval(id, true);
  assert.equal((await pending).behavior, 'allow');
  assert.equal(last(p, 'permission_answer').by, 'you');
  assert.match(hub.answerPermission(p, orch, id, 'deny', 'too late'), /no longer waiting/);
});

test('the off switch: requests with the orchestrator come to you, and new ones skip it', () => {
  const { hub, p, w } = setup();
  ask(hub, p, w, 'npm run build');
  const id = last(p, 'approval').approval;
  hub.setRouting(false);
  assert.equal(hub.settings.get('routePermissions'), false);
  assert.equal(last(p, 'approval_escalated').approval, id);
  assert.ok(p.log.ofType('notice').some(n => n.thread === 'orchestrator' && /comes to you/.test(n.text)));
  sent.length = 0;
  ask(hub, p, w, 'npm run lint');
  assert.equal(last(p, 'approval').routedTo, null);
  assert.equal(sent.length, 0);
  hub.setRouting(true);
  ask(hub, p, w, 'npm run lint');
  assert.ok(last(p, 'approval').routedTo);
});

test('routing is on by default and can start off from hub.json', () => {
  assert.equal(new HubSettings({ file: null }).get('routePermissions'), true);
  assert.equal(new HubSettings({ file: null }).get('permissionTimeoutSec'), 120);
  const { hub, p, w } = setup({ settings: { routePermissions: false } });
  ask(hub, p, w, 'npm run build');
  assert.equal(last(p, 'approval').routedTo, null);
});

test('a resting orchestrator (asleep since a restart) is woken by the request; no phone push', () => {
  const { hub, p, orch, w } = setup({ live: false });
  ask(hub, p, w, 'npm run build');
  const ap = last(p, 'approval');
  assert.equal(ap.routedTo, orch.name);
  assert.deepEqual(sent.map(s => s[0]), [orch.name], 'the request wakes it');
  assert.deepEqual(cardsFor({ ...ap, project: 'proj' }), []);
});

test('no orchestrator, no rules on the board, or a request from the orchestrator itself: a card, as before', () => {
  for (const opts of [{ orchestrator: false }, { rules: false }]) {
    const { hub, p, w } = setup(opts);
    ask(hub, p, w, 'npm run build');
    assert.equal(last(p, 'approval').routedTo, null, JSON.stringify(opts));
    assert.equal(sent.length, 0);
  }
  const { hub, p, orch } = setup();
  hub.requestApproval(p, orch, 'Bash', { command: 'npm run build' });
  assert.equal(last(p, 'approval').routedTo, null);
});

test('an orchestrator retiring with a request open passes it to you', () => {
  const { hub, p, orch, w } = setup();
  ask(hub, p, w, 'npm run build');
  hub.finishRetire(p, orch);
  assert.match(last(p, 'approval_escalated').reason, /retired/);
});

test('reads and read-only commands are allowed at once, for any path, except secrets (R003)', async () => {
  const { hub, p, w } = setup();
  const home = homedir();
  const allowed = r => r?.behavior === 'allow';
  const outside = join(tmpdir(), 'some-other-folder', 'shot.png');
  assert.ok(allowed(hub.autoAnswer(p, w, 'Read', { file_path: outside })), 'a screenshot in a temp folder');
  assert.ok(allowed(hub.autoAnswer(p, w, 'Read', { file_path: join(home, 'Documents', 'x.md') })));
  assert.ok(allowed(hub.autoAnswer(p, w, 'Glob', { pattern: '**/*.mjs', path: join(home, 'Documents') })));
  assert.ok(allowed(hub.autoAnswer(p, w, 'Grep', { pattern: 'approval', path: '..' })));
  for (const c of ['git status', 'git diff --stat', 'git log --oneline -5', 'git show HEAD', 'git branch -a', 'ls ../other', 'cat ../README.md', 'head -20 hub/x.mjs', 'npm test', 'npm test --prefix hub', 'node --test test/a.test.mjs', 'npm test 2>&1 | tail -20']) {
    assert.ok(allowed(hub.autoAnswer(p, w, 'Bash', { command: c })), c);
  }
  for (const [tool, input] of [
    ['Read', { file_path: join(home, '.ssh', 'id_rsa') }], ['Read', { file_path: join(p.dir, '.env') }], ['Read', { file_path: join(p.dir, '.env.local') }],
    ['Read', { file_path: join(home, '.crux-hub', 'vapid.json') }], ['Grep', { pattern: 'x', path: join(home, '.ssh') }],
    ['Bash', { command: 'cat ~/.ssh/id_rsa' }], ['Bash', { command: 'cat .env' }], ['Bash', { command: 'echo $ANTHROPIC_API_KEY' }],
    ['Bash', { command: 'git branch -D x' }], ['Bash', { command: 'npm test && rm -rf x' }], ['Bash', { command: 'node --test --require ./x.js' }]
  ]) assert.equal(hub.autoAnswer(p, w, tool, input), null, JSON.stringify(input));
  // A secret read still becomes a card for you, never routed.
  hub.requestApproval(p, w, 'Read', { file_path: join(home, '.ssh', 'id_rsa') });
  assert.equal(last(p, 'approval').routedTo, null);
});

test('"Always allow" saves a prefix pattern, not the literal command, and nothing risky', () => {
  const rule = cmd => CommandPolicy.alwaysRules('Bash', { command: cmd }, [])?.[0]?.rules[0].ruleContent ?? null;
  assert.equal(rule('npm test --prefix hub'), 'npm test*');
  assert.equal(rule('npm run lint -- --fix'), 'npm run lint*');
  assert.equal(rule('node --test test/permission-routing.test.mjs'), 'node --test*');
  assert.equal(rule('node scripts/check.mjs --all'), 'node scripts/check.mjs*');
  assert.equal(rule('git add hub/lib/hub.mjs'), 'git add*');
  assert.equal(rule('ls -la hub'), 'ls*');
  const saved = CommandPolicy.alwaysRules('Bash', { command: 'npm test' }, [])[0];
  assert.equal(saved.destination, 'localSettings');
  assert.equal(saved.behavior, 'allow');
  for (const c of ['git branch feat/x', 'git commit -m "x"', 'git push origin feat/x', 'npm install zod', 'rm -rf x', 'npm test && git push', 'python -c "x"',
    'node -e "x"', 'bash -c "npm test"', 'find . -name x', 'sed -i s/a/b/ x', 'gh pr create', 'FOO=1 npm test', 'npm test $X', 'echo `x`']) {
    assert.equal(rule(c), null, c);
  }
  assert.deepEqual(CommandPolicy.describe(CommandPolicy.alwaysRules('Bash', { command: 'npm test' }, [])), ['Bash: npm test …']);
});

test('the orchestrator prompt reads the rules from the board, and explains the tool', () => {
  const { p, orch } = setup();
  const prompt = () => orch.options().systemPrompt.append;
  assert.ok(prompt().includes(RULES));
  assert.ok(prompt().includes('answer_permission'));
  assert.ok(prompt().includes('R001'));
  p.board.addEntry({ kind: 'requirement', title: 'Orchestrator permission rules (newer)', summary: 'r', body: 'NEW RULES TEXT', supersedes: 'R001', from: 'you' });
  assert.ok(prompt().includes('NEW RULES TEXT'));
  assert.ok(!prompt().includes(RULES));
  assert.ok(prompt().includes('R002'));
  assert.ok(orch.options().allowedTools.includes('mcp__crux__answer_permission'));
});

test('auto mode (decision 34): contained work is allowed at once, only unclear requests reach the orchestrator', async () => {
  const { hub, p, orch, w } = setup();
  writeFileSync(join(p.dir, '.crux-hub.json'), '{ "permissions": "auto" }');
  assert.equal(hub.permissionMode(p), 'auto');
  const before = p.log.events.length;
  for (const c of ['npm run build', 'rm -rf hub/tmp', 'git commit -m "x"', 'git push -u origin feat/routing', 'node server.mjs --port 4748']) {
    assert.equal((await ask(hub, p, w, c)).behavior, 'allow', c);
  }
  assert.equal((await hub.requestApproval(p, w, 'Edit', { file_path: join(p.dir, 'hub', 'a.mjs') })).behavior, 'allow');
  assert.equal(p.log.events.length, before, 'no cards and no events for contained work');
  assert.equal(sent.length, 0);
  // unclear: to the orchestrator, which is told why
  ask(hub, p, w, 'mytool --sync');
  assert.equal(last(p, 'approval').routedTo, orch.name);
  assert.match(sent.at(-1)[1], /could not classify it: Not sure what this does \(mytool\)/);
  // hard stops: still to you
  ask(hub, p, w, 'git push origin main');
  assert.equal(last(p, 'approval').routedTo, null);
  // the hub's own switch wins over the repo file, and is logged
  hub.setPermissionMode(p, 'standard');
  assert.equal(hub.permissionMode(p), 'standard');
  assert.equal(last(p, 'project_settings').permissionMode, 'standard');
  ask(hub, p, w, 'npm run build');
  assert.equal(last(p, 'approval').routedTo, orch.name, 'standard mode: through the orchestrator');
});

test('auto mode applies to the orchestrator too: its reads and contained work pass, unclear ones pass and are logged, hard stops come to you', async () => {
  const { hub, p, orch } = setup();
  writeFileSync(join(p.dir, '.crux-hub.json'), '{ "permissions": "auto" }');
  const go = command => hub.requestApproval(p, orch, 'Bash', { command });
  const before = p.log.ofType('permission_answer').length;
  for (const c of [
    `cd ${p.dir.replace(/\\/g, '/')} && git status --short`,
    'curl -s localhost:4747/api/state | node -e "let s=\'\';process.stdin.on(\'data\',d=>s+=d).on(\'end\',()=>console.log(JSON.parse(s).projects.length))"',
    'tail -n 400 .crux/events.jsonl | node -e "let s=\'\';process.stdin.on(\'data\',d=>s+=d).on(\'end\',()=>console.log(s.split(\'\\n\').length))"',
    'grep -n "classify" hub/lib/permissions.mjs | head -30'
  ]) assert.equal((await go(c)).behavior, 'allow', c);
  assert.equal(p.log.ofType('permission_answer').length, before, 'clear reads are not logged');
  // unclear, with no hard stop: allowed, and one line in its thread
  assert.equal((await go('B=$(git branch --show-current); echo $B')).behavior, 'allow');
  const line = last(p, 'permission_answer');
  assert.equal(line.thread, 'orchestrator');
  assert.equal(line.by, 'hub');
  assert.match(line.reason, /not fully readable/);
  // a real hard stop still comes to you as a card
  go('git push origin main');
  assert.equal(last(p, 'approval').agent, orch.name);
  assert.ok(last(p, 'approval').stops.length);
});

test('without a repo setting, a repo stays in standard mode (the decision 21 flow)', () => {
  const { hub, p } = setup();
  assert.equal(hub.permissionMode(p), 'standard');
});

test('a request after the rules changed carries the new rules text', () => {
  const { hub, p, orch, w } = setup();
  orch.options();   // started with R001
  p.board.addEntry({ kind: 'requirement', title: 'Orchestrator permission rules (newer)', summary: 'r', body: 'NEWER RULES', supersedes: 'R001', from: 'you' });
  ask(hub, p, w, 'npm run build');
  assert.ok(sent.at(-1)[1].includes('NEWER RULES'));
  assert.ok(sent.at(-1)[1].includes('R002'));
});
