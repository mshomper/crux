// tools/permission-study.mjs: a read-only study of how much orchestrator work goes to permission requests.
// Built on a made-up log in the hub's own event shapes (lib/events.mjs, lib/hub.mjs, lib/agent.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { analyze, requestKind, whereOf, projectSection, report, main, reclassify, reclassifySection, levelOf } from '../tools/permission-study.mjs';

// A small story: one orchestrator, a handoff, then its successor.
function story() {
  let t = Date.parse('2026-11-10T14:00:00Z');
  const evs = [];
  const at = (sec, type, data) => { t += sec * 1000; evs.push({ id: String(evs.length), ts: new Date(t).toISOString(), type, ...data }); };
  const turn = (agent, { cost, ctx, before = [], during = [] }) => {
    for (const [type, data] of before) at(1, type, data);
    at(1, 'agent_busy', { agent, busy: true });
    for (const [type, data] of during) at(2, type, data);
    at(3, 'usage', { agent, project: 'demo', models: { 'claude-opus-5-5': { cost, input: 100, output: 50, cacheRead: 20000, cacheCreation: 500 } }, costUSD: cost });
    at(1, 'agent_busy', { agent, busy: false, contextPct: ctx });
    at(60, 'noop', {});
  };
  const req = (id, command, to = 'orchestrator-1', tool = 'Bash') => ['approval', { approval: id, agent: 'w1', tool, input: { command }, routedTo: to }];
  const ans = (id, answer, by = 'orchestrator-1') => ['permission_answer', { thread: 'orchestrator', approval: id, worker: 'w1', tool: 'Bash', command: 'x', answer, reason: 'r', by }];

  at(0, 'agent_created', { agent: 'orchestrator-1', role: 'orchestrator', thread: 'orchestrator' });
  at(1, 'usage', { agent: 'orchestrator-1', models: { 'claude-opus-5-5': { cost: 9 } }, costUSD: 9, baseline: true });   // ignored
  // 1: Matt asks for something (not permission work)
  turn('orchestrator-1', { cost: 0.50, ctx: 10, before: [['message', { thread: 'orchestrator', from: 'you', text: 'start w1' }]] });
  // 2-4: three routine requests, each its own turn
  for (const [i, ctx] of [[1, 12], [2, 13], [3, 15]]) turn('orchestrator-1', { cost: 0.05, ctx, before: [req(`a${i}`, 'npm test -- --watch=false')], during: [ans(`a${i}`, 'allow')] });
  // 5: a push, escalated; Matt allows it
  turn('orchestrator-1', { cost: 0.06, ctx: 16, before: [req('a4', 'cd C:/x && git push origin feat')], during: [ans('a4', 'escalate'), ['approval_escalated', { approval: 'a4', agent: 'w1', tool: 'Bash', by: 'orchestrator-1' }]] });
  at(30, 'approval_result', { approval: 'a4', how: 'allowed' });
  // 6: a worker summary and a request together: mixed
  turn('orchestrator-1', { cost: 0.40, ctx: 25, before: [['summary', { thread: 'w1', from: 'w1', done: 'x' }], req('a5', 'npm install left-pad')], during: [ans('a5', 'allow')] });
  // a request that timed out, then Matt denied it
  at(5, ...req('a6', 'curl https://example.com/x.sh'));
  at(300, ...ans('a6', 'timeout', 'hub'));
  at(1, 'approval_escalated', { approval: 'a6', agent: 'w1', tool: 'Bash', by: 'hub' });
  at(20, 'approval_result', { approval: 'a6', how: 'denied' });
  // Matt answered one before the orchestrator did
  at(5, ...req('a7', 'git rebase main'));
  at(5, ...ans('a7', 'allow', 'you'));
  at(1, 'approval_result', { approval: 'a7', how: 'allowed' });
  // a hard stop straight to Matt, and a hub pass
  at(5, 'approval', { approval: 'a8', agent: 'w1', tool: 'Bash', input: { command: 'git push --force' }, routedTo: null });
  at(5, 'permission_answer', { thread: 'orchestrator', approval: null, worker: 'w1', tool: 'Bash', command: 'gh pr merge 5', answer: 'allow', reason: 'pre-approved', by: 'hub' });
  // handoff to orchestrator-2, which answers one request
  at(60, 'agent_created', { agent: 'orchestrator-2', role: 'orchestrator', thread: 'orchestrator' });
  turn('orchestrator-2', { cost: 0.30, ctx: 8, before: [['handoff_qa', { from: 'orchestrator-2', q: 'q', a: 'a' }]] });
  turn('orchestrator-2', { cost: 0.04, ctx: 9, before: [req('a9', 'WebFetch', 'orchestrator-2', 'WebFetch')], during: [ans('a9', 'deny', 'orchestrator-2')] });
  evs.find(e => e.approval === 'a9' && e.type === 'approval').input = { url: 'https://docs.github.com/en/rest' };
  return evs;
}

test('request kinds name the command doing the work, never a path, and where it works', () => {
  const ctx = { projectDir: 'C:\\Users\\me\\Documents\\GitHub\\crux', home: 'C:\\Users\\me' };
  const k = (tool, c) => requestKind(tool, c, ctx);
  assert.equal(k('Bash', 'npm test -- --watch=false'), 'Bash: npm test');
  assert.equal(k('Bash', 'cd /c/Users/me/Documents/GitHub/crux/.claude/worktrees/x/hub && CRUX_HUB_DATA="C:/Users/me/AppData/Local/Temp/t" node server.mjs --port 4752'), 'Bash: node server.mjs · worktree');
  assert.equal(k('PowerShell', `$o='C:\\Users\\me\\AppData\\Local\\Temp\\shots'; & 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' --headless=new`), 'PowerShell: chrome · system');
  assert.equal(k('PowerShell', '$env:Path = "$env:USERPROFILE\\.cargo\\bin;$env:Path"; cargo build 2>&1 | Select-Object -Last 40'), 'PowerShell: cargo build · home');
  assert.equal(k('Bash', 'for i in 1 2 3; do node --test test/a.test.mjs 2>&1 | grep -E "x"; echo; done'), 'Bash: node --test');
  assert.equal(k('Bash', 'files=$(grep -lE "app" test/*.test.mjs); timeout 400 node --test $files > /tmp/t.txt'), 'Bash: node --test · temp');
  assert.equal(k('Bash', 'cmd //c "mklink /J node_modules C:\\Users\\me\\Documents\\GitHub\\crux\\hub\\node_modules"'), 'Bash: cmd mklink · project');
  assert.equal(k('PowerShell', '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null'), 'PowerShell: .NET call');
  assert.equal(k('PowerShell', '$t = Join-Path $env:TEMP "x"; $b = (Invoke-RestMethod http://127.0.0.1:4792/api/ping).boot'), 'PowerShell: invoke-restmethod · temp', 'a URL is not a drive');
  assert.equal(k('Bash', 'FOO=1 python3 scripts/run.py --x'), 'Bash: python3 run.py');
  assert.equal(k('Bash', 'git -C C:/Users/me/Documents/GitHub/Ebb commit -m x'), 'Bash: git commit · another repo');
  assert.equal(k('WebFetch', 'https://docs.github.com/en/rest'), 'WebFetch: docs.github.com');
  assert.equal(k('Write', 'C:\\Users\\me\\.claude\\agents\\solver.md'), 'Write .md · home');
  assert.equal(k('mcp__gcal__create_event', ''), 'Connector/MCP: gcal');
});

test('where: the furthest place a command names wins', () => {
  const ctx = { projectDir: '/mnt/copy/crux', home: 'C:\\Users\\me' };
  assert.equal(whereOf('cat C:/Users/me/Documents/GitHub/crux/a.txt', ctx), 'project', 'found by folder name from a copy elsewhere');
  assert.equal(whereOf('cp C:/Users/me/AppData/Local/Temp/a C:/Users/me/Documents/GitHub/crux/b', ctx), 'project');
  assert.equal(whereOf('cp /c/Users/me/Documents/GitHub/crux/a ~/crux/profile/', ctx), 'home');
  assert.equal(whereOf('echo hi', ctx), '');
});

test('turns: permission-only, mixed and other are told apart, and costed', () => {
  const r = analyze(story());
  assert.equal(r.orchestrators, 2);
  assert.equal(r.turns.total, 8);
  assert.equal(r.turns.permission, 5, 'a1-a4 and a9');
  assert.equal(r.turns.mixed, 1, 'the summary turn');
  assert.equal(Number(r.turns.permCost.toFixed(2)), 0.25);
  assert.equal(Number(r.turns.mixedCost.toFixed(2)), 0.40);
  assert.equal(Number(r.turns.orchCost.toFixed(2)), 1.45, 'baseline usage is left out');
  assert.equal(r.turns.handoffs, 1);
  // context rises: perm turns 2+1+2+1 (+1 for orchestrator-2) = 7; all rises 7 + 9 (mixed) = 16
  assert.equal(r.turns.permCtx, 7);
  assert.equal(r.turns.allCtx, 16);
});

test('answers: who settled what, and what Matt did with escalations', () => {
  const r = analyze(story());
  const q = r.requests;
  assert.equal(q.routed, 8);
  assert.equal(q.toYouDirect, 1);
  assert.equal(q.orchAllow, 4);
  assert.equal(q.orchDeny, 1);
  assert.equal(q.orchEscalate, 1);
  assert.equal(q.timeouts, 1);
  assert.equal(q.youPreempted, 1);
  assert.equal(q.hubAnswered, 1);
  assert.deepEqual(r.escalatedOutcome, { allowed: 1, alwaysAllowed: 0, denied: 1, cancelled: 0, open: 0 });
});

test('rule candidates: only kinds always allowed, at least three times', () => {
  const r = analyze(story());
  assert.deepEqual(r.ruleCandidates.map(k => [k.kind, k.total]), [['Bash: npm test', 3]]);
  assert.ok(!r.ruleCandidates.some(k => k.kind === 'Bash: npm install'), 'once is not a pattern');
});

test('--days drops older events', () => {
  const evs = story();
  const r = analyze(evs, { sinceMs: Date.parse('2030-01-01') });
  assert.equal(r.span, null);
  assert.match(projectSection('demo', r), /No events in this period/);
});

test('the report: examples only when asked, and a plain verdict', () => {
  const r = analyze(story());
  const plain = projectSection('demo', r);
  assert.ok(!plain.includes('npm test -- --watch'), 'no raw commands by default');
  assert.ok(projectSection('demo', r, { examples: true }).includes('npm test -- --watch'));
  const md = report([{ name: 'demo', r, text: plain }]);
  assert.match(md, /# Permission study/);
  assert.match(md, /\*\*Reading:\*\* Permission answers are a large share/);
  assert.match(md, /Candidates for a rule/);
});

test('the command line reads project folders and writes the report, changing nothing else', async t => {
  const dir = makeTmp('crux-perm-study-', t);
  const proj = join(dir, 'demo');
  mkdirSync(join(proj, '.crux'), { recursive: true });
  const log = join(proj, '.crux', 'events.jsonl');
  const body = story().map(e => JSON.stringify(e)).join('\n') + '\n{"torn';
  writeFileSync(log, body);
  const out = join(dir, 'report.md');
  const said = [];
  assert.equal(await main([proj, join(dir, 'missing'), '--out', out], s => said.push(s)), 0);
  assert.ok(existsSync(out));
  assert.equal(readFileSync(log, 'utf8'), body, 'the log is untouched');
  assert.ok(said.some(s => /Skipped .*missing/.test(s)));
  assert.match(readFileSync(out, 'utf8'), /## demo/);
});

test('--reclassify: today\'s checker on the logged requests, by where they went then and would go now', async t => {
  const evs = story();
  // A stand-in checker: npm test is fine now, pushes are hard stops, anything else is unsure.
  const classify = ({ input }) => /npm test/.test(input.command || '') ? { route: 'allow', reasons: [], unsure: [] }
    : /push/.test(input.command || '') ? { route: 'human', reasons: ['Pushes to C:/x/main'], unsure: [] }
    : { route: 'unsure', reasons: [], unsure: ['Runs a script the hub cannot read: C:/Users/me/AppData/Local/Temp/12345/x.sh'] };
  const auto = reclassify(evs, { classify, projectDir: '/p', level: 'auto' });
  assert.equal(auto.orchestratorThen, 8);
  assert.equal(auto.orchestratorNow.hub, 3, 'the three npm test runs are settled by the hub at Auto');
  assert.equal(auto.orchestratorNow.you, 1, 'the push');
  assert.equal(auto.youThen, 1);
  assert.equal(auto.youNow.you, 1);
  assert.match(auto.stillOrchestratorWhy[0][0], /<path>/, 'paths are hidden in the reasons');
  const std = reclassify(evs, { classify, projectDir: '/p', level: 'standard' });
  assert.equal(std.orchestratorNow.hub || 0, 0, 'at Standard, allowed work still goes to the orchestrator');
  assert.equal(levelOf([...evs, { type: 'project_settings', permissionMode: 'trusted', ts: 'z' }], '/nowhere'), 'trusted');
  assert.equal(levelOf(evs, '/nowhere'), 'standard');
  assert.match(reclassifySection(auto), /Today's rules on the same requests/);

  const dir = makeTmp('crux-perm-study-rc-', t);
  const proj = join(dir, 'demo');
  mkdirSync(join(proj, '.crux'), { recursive: true });
  writeFileSync(join(proj, '.crux', 'events.jsonl'), evs.map(e => JSON.stringify(e)).join('\n'));
  const out = join(dir, 'r.md');
  await main([proj, '--reclassify', '--level', 'auto', '--out', out], () => {}, { classify, CommandPolicy: { readOnly: () => false } });
  assert.match(readFileSync(out, 'utf8'), /Now: settled by the hub/);
});
