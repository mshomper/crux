// The Expedition module, phase 2 (decisions 68 C, 71): the Lead's four scoped tools, the orchestrator staying out, the
// launch refusals, requests parked instead of carded, the gatherer subagent plumbing and the Conductor's counts.
// Agents are stubbed (helpers/expedition-stub.mjs): nothing starts. The acceptance test of the spec is the first one:
// the Lead cannot message or retire an agent outside its expedition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordAgents, stubHub, StubExpedition, quietMark, quietProblems, MODEL } from './helpers/expedition-stub.mjs';
import { cruxTools, cruxToolNames } from '../lib/tools.mjs';
import { Expedition, ROLES, DISALLOWED_TOOLS } from '../lib/expedition.mjs';

const sent = recordAgents();
// One hub, an orchestrator, a plain worker, and two expeditions (A and B), each with a Lead, a builder and a verifier.
function world({ level = 'auto', conductor = false } = {}) {
  sent.length = 0;
  const env = stubHub({ level, conductor });
  const mk = (question, tag) => {
    const ex = new StubExpedition(env, { question });
    ex.ex.write('BRIEF.md', `# ${question}\n`); ex.ex.write('test/CHECKLIST.md', '1. it works\n');
    ex.ex.start();
    ex.startRole('lead', env.orch.name);
    ex.startRole('builder', ex.agents.lead.name);
    ex.startRole('verifier', ex.agents.lead.name);
    return ex;
  };
  const A = mk('Which JSON library is faster', 'a'), B = mk('Which sort is stable and fast', 'b');
  const plain = env.hub.startWorker(env.p, 'plain', 'Do a thing', env.orch.name, 'Do a thing');
  return { env, A, B, plain, hub: env.hub, p: env.p };
}

// ---------- the spec's acceptance: the Lead stays inside its expedition ----------
test('the Lead cannot message or retire an agent outside its expedition', () => {
  const { A, B, plain, hub, p, env } = world();
  const lead = A.agents.lead, mine = A.agents.builder;
  sent.length = 0;
  const logBefore = p.log.events.length;
  // Everything outside A is refused the same way: another expedition's members and Lead, a plain worker, the orchestrator,
  // itself, a name that does not exist.
  for (const to of [B.agents.builder.name, B.agents.lead.name, plain.name, env.orch.name, lead.name, 'nobody']) {
    assert.throws(() => hub.leadMessage(p, lead, to, 'hello'), /No agent called .* in your expedition/, to);
    assert.throws(() => hub.leadRetire(p, lead, to, 'done'), /No agent called .* in your expedition/, to);
  }
  assert.equal(sent.length, 0, 'nothing was sent to anyone');
  assert.equal(p.log.events.length, logBefore, 'nothing was logged either');
  for (const a of [B.agents.builder, B.agents.lead, plain, env.orch]) assert.notEqual(a.state, 'retired');
  // Inside A it works.
  hub.leadMessage(p, lead, mine.name, 'Use the frozen test');
  assert.deepEqual(sent, [[mine.name, `[From the Lead, ${lead.name}]\nUse the frozen test`]]);
  assert.equal(p.log.ofType('message').at(-1).thread, mine.thread);
  assert.match(hub.leadRetire(p, lead, mine.name, 'built'), /retired/);
  assert.equal(mine.state, 'retired');
  // A retired member is gone for the Lead too.
  assert.throws(() => hub.leadMessage(p, lead, mine.name, 'again'), /No agent called/);
  // Only a Lead has these: a member of A is refused outright.
  assert.throws(() => hub.leadMessage(p, A.agents.verifier, B.agents.builder.name, 'x'), /Only an expedition's Lead/);
  assert.throws(() => hub.leadAgents(p, plain), /Only an expedition's Lead/);
});

test('the same through the tools the Lead really gets: four tools, each limited to its expedition', async () => {
  const { A, B, plain, hub, p } = world();
  const lead = A.agents.lead;
  const rt = cruxTools(hub, p, lead).instance._registeredTools;
  for (const n of ['list_agents', 'message_agent', 'retire_worker', 'start_worker']) assert.ok(rt[n], n);
  for (const n of ['handoff_worker', 'set_agent_settings', 'answer_permission', 'restart_hub', 'mark_entry_done', 'list_agent_types']) assert.ok(!rt[n], `${n} is the orchestrator's`);
  assert.deepEqual(cruxToolNames(lead).filter(n => /list_agents|message_agent|retire_worker|start_worker/.test(n)).sort(),
    ['mcp__crux__list_agents', 'mcp__crux__message_agent', 'mcp__crux__retire_worker', 'mcp__crux__start_worker']);
  const text = r => r.content[0].text;
  assert.match(text(await rt.message_agent.handler({ to: B.agents.builder.name, text: 'x' }, {})), /^Not sent: No agent called/);
  assert.match(text(await rt.message_agent.handler({ to: plain.name, text: 'x' }, {})), /^Not sent: No agent called/);
  assert.match(text(await rt.retire_worker.handler({ name: B.agents.builder.name, reason: 'x' }, {})), /^Not retired: No agent called/);
  assert.match(text(await rt.message_agent.handler({ to: A.agents.builder.name, text: 'go' }, {})), /^Sent to/);
  // list_agents shows only A's team (not the Lead itself, not B, not the plain worker).
  const list = JSON.parse(text(await rt.list_agents.handler({}, {})));
  assert.equal(list.expedition, A.id);
  assert.deepEqual(list.team.map(t => t.name).sort(), [A.agents.builder.name, A.agents.verifier.name].sort());
  assert.equal(list.gatherers.limit, 4);
  assert.equal(list.gatherers.runsLimit, 8);
  // start_worker offers exactly the five hub types.
  assert.deepEqual(rt.start_worker.inputSchema.shape.type.options.sort(), ['expedition-advisor', 'expedition-builder', 'expedition-skeptic', 'expedition-synthesizer', 'expedition-verifier']);
  // Other roles keep the worker tools and nothing of the Lead's.
  const builderTools = cruxTools(hub, p, A.agents.builder).instance._registeredTools;
  assert.ok(!builderTools.message_agent && !builderTools.start_worker && !builderTools.list_agents);
});

test('start_worker: only the five hub types, the expedition and role stamped by the hub, model and effort from the launch picks', () => {
  const { A, hub, p, env } = world();
  const lead = A.agents.lead;
  for (const type of ['implementer', 'expedition-lead', 'expedition-gatherer', 'orchestrator', '', undefined]) {
    assert.throws(() => hub.leadStart(p, lead, { type, task: 'x' }), /only these roles/, String(type));
  }
  assert.throws(() => hub.leadStart(p, lead, { type: 'expedition-skeptic', task: '  ' }), /Give the agent its task/);
  const skeptic = hub.leadStart(p, lead, { type: 'expedition-skeptic', goal: 'Break the synthesis', task: 'Read the notes.' });
  assert.deepEqual([skeptic.expedition, skeptic.expeditionRole, skeptic.type, skeptic.role], [A.id, 'skeptic', 'expedition-skeptic', 'worker']);
  assert.equal(skeptic.model, MODEL.sonnet);
  assert.equal(skeptic.effort, 'high');
  assert.match(skeptic.task, /^You are the Skeptic of expedition .* your Lead is exp-lead/);
  assert.match(skeptic.task, /Read the notes\.$/);
  assert.equal(p.log.ofType('agent_created').at(-1).expedition, A.id);
  // Two starts of one role are fine (an Advisor is woken more than once) and get their own names.
  const adv1 = hub.leadStart(p, lead, { type: 'expedition-advisor', task: 'Review the plan.' });
  const adv2 = hub.leadStart(p, lead, { type: 'expedition-advisor', task: 'Review again.' });
  assert.deepEqual([adv1.name, adv2.name], ['exp-advisor', 'exp-advisor-2']);
  // The Lead's own picks are not a thing: the picks stored at launch decide (here, an override stored in the started event).
  assert.equal(hub.leadList?.length, undefined);
  // The Verifier is never on the Builder's model, whatever the files say: a started event whose picks collide is refused.
  const { A: A2, hub: h2, p: p2 } = world();
  const started = p2.log.events.find(e => e.type === 'expedition_started' && e.expedition === A2.id);
  started.roles.verifier.model = started.roles.builder.model;
  A2.ex.cache = null;
  assert.throws(() => h2.leadStart(p2, A2.agents.lead, { type: 'expedition-verifier', task: 'x' }), /Verifier and the Builder both run on/);
  // Not before the expedition started, and not once it has stopped.
  const env2 = stubHub({ level: 'auto' });
  const ex3 = new StubExpedition(env2, { question: 'q three' });
  const lead3 = ex3.startRole('lead', env2.orch.name);
  assert.throws(() => env2.hub.leadStart(env2.p, lead3, { type: 'expedition-skeptic', task: 'x' }), /not started: no new agents/);
  ex3.ex.write('BRIEF.md', 'q'); ex3.ex.write('test/CHECKLIST.md', '1'); ex3.ex.start();
  ex3.ex.stop({ reason: 'passed' });   // a hub stop (time, budget, Matt) offers no Verifier at all: see expedition-watchdog.test.mjs
  assert.throws(() => env2.hub.leadStart(env2.p, lead3, { type: 'expedition-skeptic', task: 'x' }), /is stopped: only a Verifier can be started now/);
  assert.throws(() => env2.hub.leadStart(env2.p, lead3, { type: 'expedition-builder', task: 'x' }), /only a Verifier can be started now/);
  // The Verifier checks the report after the stop (spec 4.8): that one role may start.
  const late = env2.hub.leadStart(env2.p, lead3, { type: 'expedition-verifier', task: 'Check the report.' });
  assert.deepEqual([late.expeditionRole, late.expedition], ['verifier', ex3.id]);
  void env;
});

// ---------- the orchestrator stays out (phase 1 review) ----------
test('the orchestrator cannot message, retire, hand on or re-set an expedition member; the user still can', async () => {
  const { A, plain, hub, p, env } = world();
  const member = A.agents.builder, orch = env.orch;
  sent.length = 0;
  assert.throws(() => hub.orchestratorToWorker(p, orch, member.name, 'hi'), /belongs to expedition .*orchestrator stays out/);
  assert.throws(() => hub.retireFinished(p, member.name, orch.name, 'done'), /belongs to expedition/);
  assert.match(hub.handoffWorker(p, member.name, orch.name, 'half done'), /belongs to expedition/);
  await assert.rejects(() => hub.setAgentSettings(p, member.name, { effort: 'high' }, orch.name, 'tests failed'), /belongs to expedition/);
  await assert.rejects(() => hub.setAgentSettings(p, A.agents.lead.name, { model: 'sonnet' }, orch.name, ''), /belongs to expedition/);
  assert.equal(sent.length, 0);
  assert.equal(member.state === 'retired', false);
  // The same calls on a plain worker are as before.
  hub.orchestratorToWorker(p, orch, plain.name, 'hi');
  assert.deepEqual(sent.at(-1), [plain.name, `[From the orchestrator, ${orch.name}]\nhi`]);
  assert.equal((await hub.setAgentSettings(p, plain.name, { effort: 'high' }, orch.name, 'tests failed')).changed, true);
  // The user is not an orchestrator: they can set and stop an expedition's member from the page.
  assert.equal((await hub.setAgentSettings(p, member.name, { effort: 'high' }, 'you')).changed, true);
  assert.match(hub.retireFinished(p, member.name, 'you', 'stopped by me'), /retired/);
  // list_agents never shows them to the orchestrator.
  assert.deepEqual(hub.agentList(p).workers.map(w => w.name), [plain.name]);
});

// ---------- launch refusals ----------
test('launchExpedition refuses an empty brief, a second expedition, a project at Ask, a missing type, and a Verifier on the Builder\'s model', () => {
  sent.length = 0;
  const env = stubHub({ level: 'auto' });
  const { hub, p } = env;
  assert.throws(() => hub.launchExpedition(p, { brief: '   ' }), /The ask is empty/);   // phase 5: the ask (question or brief) is all a launch needs
  assert.throws(() => hub.launchExpedition(p, { brief: 'q', roles: { verifier: { model: 'sonnet' } } }), /Verifier and the Builder both run on/);
  assert.equal(Expedition.all(p).length, 0, 'a refusal writes nothing');
  assert.equal(p.log.ofType('agent_created').filter(e => e.expedition).length, 0);
  // At Ask.
  hub.setPermissionMode(p, 'standard', 'you');
  assert.throws(() => hub.launchExpedition(p, { brief: 'q' }), /project is at Ask.*Auto or Trusted/);
  hub.setPermissionMode(p, 'auto', 'you');
  // Success.
  const r = hub.launchExpedition(p, { question: 'Which of two JSON libraries is faster for X?', shortTitle: 'JSON library speed comparison', brief: 'Compare two JSON libraries.\nSuccess: a table and a runnable benchmark.', test: { 'CHECKLIST.md': '1. a table\n', 'run.json': '{"command":"node bench.mjs"}' }, envelope: { hours: 2, dollars: 5 }, gatherers: 9 }, 'you');
  assert.match(r.id, /^\d{8}-json-library-speed-comparison$/, 'the slug comes from the short title');
  assert.equal(r.expedition.title, 'JSON library speed comparison');
  const ex = new Expedition(p, r.id);
  assert.equal(ex.state().phase, 'planning');
  assert.match(ex.read('BRIEF.md'), /Compare two JSON libraries/);
  assert.deepEqual(ex.testFiles(), ['test/CHECKLIST.md', 'test/run.json']);
  assert.deepEqual([r.expedition.envelope.hours, r.expedition.envelope.dollars, r.expedition.envelope.gatherers], [2, 5, 4], 'gatherers are capped at the hard limit of 4');
  const lead = p.agents.get(r.lead);
  assert.deepEqual([lead.expedition, lead.expeditionRole, lead.type, lead.model, lead.effort], [r.id, 'lead', 'expedition-lead', MODEL.opus, 'medium']);
  assert.match(lead.task, /at most 4 at once, and one second round, 8 gatherer runs in all \(the hub refuses a 9th\)/);
  assert.match(lead.task, /up to 8 web searches and 6 page opens each, and at least 2 pages actually opened/);
  assert.match(lead.task, /reader run.*counts inside the 8/);
  assert.match(lead.task, /Compare two JSON libraries/);
  assert.deepEqual(Object.fromEntries(Object.entries(r.expedition.roles).map(([k, v]) => [k, v.model])), { lead: MODEL.opus, advisor: MODEL.fable, gatherer: MODEL.haiku, synthesizer: MODEL.opus, skeptic: MODEL.sonnet, builder: MODEL.sonnet, verifier: MODEL.opus });
  // One at a time: refused while it runs, and while it is writing up; allowed once the Lead's summary has gone.
  assert.throws(() => hub.launchExpedition(p, { brief: 'another' }), /still planning: one expedition runs per project at a time/);
  ex.write('test/CHECKLIST.md', '1. a table\n2. a benchmark\n');
  ex.gate({ verdict: 'ok' });
  ex.stop({ reason: 'passed' });
  assert.throws(() => hub.launchExpedition(p, { brief: 'another' }), /still writing up/);
  for (const s of ['report', 'commit', 'push', 'pr', 'card', 'summary']) ex.step(s);
  const second = hub.launchExpedition(p, { question: 'Which of two JSON libraries is faster for X?', shortTitle: 'JSON library speed comparison', brief: 'again', test: { 'CHECKLIST.md': '1. a table\n' } });
  assert.match(second.id, /-2$/, 'a second one on the same day with the same slug gets -2');
});

test('launch refuses when an agent type file is missing, naming it, before anything is written', () => {
  sent.length = 0;
  const env = stubHub({ level: 'auto' });
  const { hub, p } = env;
  hub.agentHome = join(env.root, 'no-agents-here');   // a hub whose home has none of the expedition-*.md files
  assert.throws(() => hub.launchExpedition(p, { brief: 'q' }), /agent type expedition-lead is not set up.*agent-types\/starter/);
  assert.equal(Expedition.all(p).length, 0);
  assert.equal(existsSync(join(p.dir, '.crux', 'expeditions')), false);
});

// ---------- requests: never a card, never the orchestrator ----------
test('an expedition request that would be a card is parked or denied; the one-shot check settles the rest where it is on', async () => {
  const { A, plain, hub, p, env } = world();
  const { builder, lead } = A.agents;
  const mark = quietMark(env);
  const ask = (agent, tool, input, opts) => hub.requestApproval(p, agent, tool, input, opts);
  // Hard stops are parked (never run, never a card).
  for (const command of ['git push --force origin main', 'git push origin main', 'rm -rf /tmp/other-folder-that-is-outside']) {
    const r = await ask(builder, 'Bash', { command });
    assert.equal(r.behavior, 'deny', command);
    assert.match(r.message, /^Parked, not allowed/);
  }
  // Auto cannot settle a web page: parked, because the check is off. The orchestrator is not asked.
  const web = await ask(lead, 'WebFetch', { url: 'https://example.org/x', prompt: 'p' });
  assert.equal(web.behavior, 'deny');
  assert.equal(hub.approvals.size, 0);
  assert.deepEqual(sent.filter(([n]) => n === env.orch.name), []);
  assert.equal(p.log.ofType('approval').length, 0);
  assert.deepEqual(quietProblems(env, mark, sent), []);
  // A settings file is a plain refusal, not a parked item.
  const parkedBefore = p.log.ofType('expedition_parked').length;
  const settings = await ask(builder, 'Edit', { file_path: join(p.dir, '.claude', 'settings.json'), old_string: 'a', new_string: 'b' });
  assert.match(settings.message, /^Not allowed: .*settings file/);
  assert.equal(p.log.ofType('expedition_parked').length, parkedBefore);
  // The same request twice is one parked line, not two.
  await ask(lead, 'WebFetch', { url: 'https://example.org/x', prompt: 'p' });
  assert.equal(p.log.ofType('expedition_parked').filter(e => e.tool === 'WebFetch').length, 1);
  // Reads and contained work still run, with no line at all.
  assert.equal((await ask(builder, 'Read', { file_path: join(p.dir, 'README.md') })).behavior, 'allow');
  // A plain worker's unclear request is a card as before (control).
  hub.requestApproval(p, plain, 'WebFetch', { url: 'https://example.org/x', prompt: 'p' });
  assert.equal(p.log.ofType('approval').length, 1);
  assert.equal(hub.approvals.size, 1);

  // With the check on: allow and deny settle on the spot; escalate and a failure are parked. Still no card.
  sent.length = 0;
  const env2 = stubHub({ level: 'auto' });
  const w2 = world2(env2);
  env2.hub.settings.setProject(env2.p.dir, { permissionCheck: 'on' });
  let answer = { valid: true, answer: 'allow', reason: 'a public page, read only', model: 'claude-sonnet-5-5' };
  env2.hub.checkerMade = { run: async () => answer };
  const mark2 = quietMark(env2);
  const q = () => env2.hub.requestApproval(env2.p, w2.lead, 'WebFetch', { url: `http://example.org/${Math.random()}`, prompt: 'p' }, { toolUseID: 'tu-9', agentID: 'agent-9' });
  w2.lead.noteSubagent({ tool_use_id: 'tu-9', agent_id: 'agent-9', agent_type: 'expedition-gatherer' });
  assert.equal((await q()).behavior, 'allow');
  const allowed = env2.p.log.ofType('permission_answer').at(-1);
  assert.deepEqual([allowed.answer, allowed.by, allowed.thread, allowed.expedition, allowed.subagent], ['allow', 'permission check', w2.lead.thread, w2.id, { id: 'agent-9', type: 'expedition-gatherer' }]);
  answer = { valid: true, answer: 'deny', reason: 'not a page the brief names', model: 'claude-sonnet-5-5' };
  const denied = await q();
  assert.match(denied.message, /^The permission check declined/);
  for (const a of [{ valid: true, answer: 'escalate', reason: 'a licence question' }, { valid: false, error: 'no answer' }]) {
    answer = a;
    const r = await q();
    assert.equal(r.behavior, 'deny');
    assert.match(r.message, /^Parked, not allowed/);
  }
  assert.equal(env2.hub.approvals.size, 0);
  assert.deepEqual(quietProblems(env2, mark2, sent), []);
  assert.equal(env2.p.log.ofType('expedition_parked').filter(e => e.kind === 'request').length, 2, 'one parked line per distinct request: the two that were parked');
  assert.ok(env2.p.log.ofType('expedition_parked').filter(e => e.kind === 'request').every(e => e.subagent?.id === 'agent-9'));
});

// One expedition on a given hub (for the check-on half of the test above).
function world2(env) {
  const ex = new StubExpedition(env, { question: 'Check on' });
  ex.ex.write('BRIEF.md', 'q'); ex.ex.write('test/CHECKLIST.md', '1'); ex.ex.start();
  ex.startRole('lead', env.orch.name);
  return { id: ex.id, lead: ex.agents.lead };
}

test('paused: an expedition\'s request is denied "wait" even for a Lead whose final summary is due (no card, not parked)', async () => {
  sent.length = 0;
  const ex = new StubExpedition(stubHub({ level: 'auto' }), { question: 'Pause test' });
  const { hub, p } = ex;
  ex.ex.write('BRIEF.md', 'q'); ex.ex.write('test/CHECKLIST.md', '1'); ex.ex.start();
  const lead = ex.startRole('lead', ex.orch.name);
  ex.ex.stop({ reason: 'passed' });
  for (const s of ['report', 'commit', 'push', 'pr', 'card']) ex.ex.step(s);
  assert.equal(hub.upwardOf(p, lead).to, 'orchestrator', 'its summary is due, so its output now goes up');
  hub.setPaused(p, true, 'you');
  const r = await hub.requestApproval(p, lead, 'Bash', { command: 'npm run build' });
  assert.match(r.message, /paused/);
  assert.equal(hub.approvals.size, 0);
  assert.equal(p.log.ofType('approval').length, 0);
  // And not paused: the same Lead's request is still never a card (a Lead with its summary due included).
  hub.setPaused(p, false, 'you');
  const web = await hub.requestApproval(p, lead, 'WebFetch', { url: 'https://example.org/', prompt: 'p' });
  assert.match(web.message, /^Parked/);
  assert.equal(hub.approvals.size, 0);
});

// ---------- decision 75 A: the gatherer allowance ----------
test('the hub refuses a ninth gatherer run and a fifth at once, with a reason the Lead can act on; other Agent calls are not counted', async () => {
  const { A, p, hub } = world();
  const lead = A.agents.lead, ex = A.ex;
  const hook = lead.options().hooks.PreToolUse[0].hooks[0];
  const call = (id, type = 'expedition-gatherer') => hook({ tool_name: 'Agent', tool_use_id: id, tool_input: { subagent_type: type } });
  const start = n => lead.onTask({ type: 'system', subtype: 'task_started', task_id: n, subagent_type: 'expedition-gatherer', task_type: 'local_agent' });
  const end = n => lead.onTask({ type: 'system', subtype: 'task_notification', task_id: n, status: 'completed', usage: { total_tokens: 10 } });
  // Four at once: the fifth, sent before any has even started, is refused; a repeat of an allowed call is not counted twice.
  for (const id of ['c1', 'c2', 'c3', 'c4']) assert.deepEqual(await call(id), {}, id);
  assert.deepEqual(await call('c1'), {}, 'a repeat of the same call');
  const five = await call('c5');
  assert.equal(five.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(five.hookSpecificOutput.permissionDecisionReason, /4 gatherers are already running and 4 is the most at once.*4 of 8 runs left/);
  assert.deepEqual(await call('x1', 'general-purpose'), {}, 'only gatherer runs are counted');
  // Round 1 finishes; four more (round 2) are fine, then a ninth is refused even with nobody running.
  ['c1', 'c2', 'c3', 'c4'].forEach(start); ['c1', 'c2', 'c3', 'c4'].forEach(end);
  for (const id of ['d1', 'd2', 'd3', 'd4']) assert.deepEqual(await call(id), {}, id);
  ['d1', 'd2', 'd3', 'd4'].forEach(start); ['d1', 'd2', 'd3', 'd4'].forEach(end);
  assert.equal(ex.gathererRuns().total, 8);
  assert.equal(ex.runningSubagents(), 0);
  const nine = await call('e1');
  assert.equal(nine.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(nine.hookSpecificOutput.permissionDecisionReason, /used all 8 gatherer runs.*say in the report which gaps stayed open/);
  // The count is rebuilt from the log (a restart does not reset it); list_agents shows it.
  const list = hub.leadAgents(p, lead);
  assert.deepEqual([list.gatherers.runs, list.gatherers.runsLimit, list.gatherers.limit], [8, 8, 4]);
  assert.match(list.gatherers.note, /8 gatherer runs in all/);
});

test('an allowed call that never starts frees its slot and run after 2 minutes, at the end of the Lead\'s turn, and at a query restart; the expiry is logged and rebuilds the same', async () => {
  const { A, p } = world();
  const lead = A.agents.lead, ex = A.ex;
  const hook = lead.options().hooks.PreToolUse[0].hooks[0];
  const call = id => hook({ tool_name: 'Agent', tool_use_id: id, tool_input: { subagent_type: 'expedition-gatherer' } });
  for (const id of ['c1', 'c2', 'c3', 'c4']) await call(id);
  assert.deepEqual([ex.gathererRuns().total, ex.gathererRuns().pending], [4, 4]);
  assert.equal((await call('c5')).hookSpecificOutput.permissionDecision, 'deny');
  // After 2 minutes the four never-started calls stop counting; the block logs it.
  const later = Date.now() + 3 * 60 * 1000;
  assert.equal(ex.gathererBlock('c6', 4, later), null, 'a slot is free again');
  assert.equal(ex.gathererRuns(later).total, 0, 'and none of the four counts toward the 8');
  assert.equal(p.log.ofType('expedition_note').filter(e => e.kind === 'gatherer-expired').length, 4, 'the expiry is in the log');
  // A fresh Expedition built from the same log gets the same counts, with no clock help.
  const again = new Expedition(p, A.id);
  assert.deepEqual([again.gathererRuns().total, again.gathererRuns().pending], [0, 0]);
  // The end of the Lead's turn clears what is still waiting.
  await call('d1'); await call('d2');
  assert.equal(ex.gathererRuns().total, 2);
  lead.onMessage({ type: 'result', subtype: 'success', is_error: false, usage: {}, modelUsage: {}, total_cost_usd: 0 }, null);
  assert.equal(ex.gathererRuns().total, 0, 'turn end');
  // A query restart clears them too; a started task is never cleared.
  await call('e1'); await call('e2');
  lead.onTask({ type: 'system', subtype: 'task_started', task_id: 't1', subagent_type: 'expedition-gatherer', task_type: 'local_agent' });
  lead.closeOpenSubagents();
  assert.deepEqual([ex.gathererRuns().total, ex.gathererRuns().started, ex.runningSubagents()], [1, 1, 0], 'one started task stays counted; the call that never started is gone');
  assert.deepEqual([new Expedition(p, A.id).gathererRuns().total], [1]);
});

test('an empty tool call id does not collapse calls, and only gatherers count toward the 4 at once', async () => {
  const { A } = world();
  const ex = A.ex, hook = A.agents.lead.options().hooks.PreToolUse[0].hooks[0];
  for (let i = 0; i < 3; i++) assert.deepEqual(await hook({ tool_name: 'Agent', tool_use_id: '', tool_input: { subagent_type: 'expedition-gatherer' } }), {});
  assert.equal(ex.gathererRuns().total, 3, 'three calls with no id are three runs');
  // Other subagents running do not use up a gatherer slot.
  const lead = A.agents.lead;
  lead.onTask({ type: 'system', subtype: 'task_started', task_id: 'o1', subagent_type: 'general-purpose', task_type: 'local_agent' });
  lead.onTask({ type: 'system', subtype: 'task_started', task_id: 'o2', subagent_type: 'general-purpose', task_type: 'local_agent' });
  assert.equal(ex.runningSubagents(), 2);
  assert.equal(ex.runningSubagents('expedition-gatherer'), 0);
  assert.deepEqual(await hook({ tool_name: 'Agent', tool_use_id: 'z', tool_input: { subagent_type: 'expedition-gatherer' } }), {}, 'the 4th gatherer fits beside two other subagents');
});

test('a gatherer\'s search and open counts go on its ended event and out of memory', async () => {
  const { A, p } = world();
  const lead = A.agents.lead, hook = lead.options().hooks.PreToolUse[0].hooks[0];
  lead.onTask({ type: 'system', subtype: 'task_started', task_id: 'g1', subagent_type: 'expedition-gatherer', task_type: 'local_agent' });
  const g = tool => hook({ tool_name: tool, tool_use_id: `${tool}${Math.random()}`, agent_id: 'g1', agent_type: 'expedition-gatherer', tool_input: {} });
  for (const t of ['WebSearch', 'WebSearch', 'WebFetch']) await g(t);
  lead.onTask({ type: 'system', subtype: 'task_notification', task_id: 'g1', status: 'completed', usage: { total_tokens: 5 } });
  const ended = p.log.ofType('expedition_subagent').find(e => e.phase === 'ended');
  assert.deepEqual([ended.searches, ended.opens], [2, 1]);
  assert.equal(lead.gathererUse.has('g1'), false, 'dropped when it ends');
});

test('a gatherer\'s own searches and page opens are counted and refused past 8 and 6; other tools and other agents are left alone', async () => {
  const { A } = world();
  const hook = A.agents.lead.options().hooks.PreToolUse[0].hooks[0];
  const g = (tool, id = 'g1', type = 'expedition-gatherer') => hook({ tool_name: tool, tool_use_id: `${tool}-${Math.random()}`, agent_id: id, agent_type: type, tool_input: {} });
  for (let i = 0; i < 8; i++) assert.deepEqual(await g('WebSearch'), {}, `search ${i + 1}`);
  const s9 = await g('WebSearch');
  assert.equal(s9.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(s9.hookSpecificOutput.permissionDecisionReason, /used your 8 web searches/);
  for (let i = 0; i < 6; i++) assert.deepEqual(await g('WebFetch'), {}, `open ${i + 1}`);
  assert.match((await g('WebFetch')).hookSpecificOutput.permissionDecisionReason, /opened your 6 pages/);
  assert.deepEqual(await g('Read'), {}, 'Read is not counted');
  assert.deepEqual(await g('WebSearch', 'g2'), {}, 'another gatherer has its own allowance');
});

// ---------- the gatherers: the SDK's task messages ----------
test('task messages move the gatherer count and are logged as expedition_subagent; background tasks and strangers are ignored', () => {
  const { A, p } = world();
  const lead = A.agents.lead, ex = A.ex;
  const msg = (subtype, over) => ({ type: 'system', subtype, ...over });
  lead.onTask(msg('task_started', { task_id: 't1', subagent_type: 'expedition-gatherer', task_type: 'local_agent', description: 'speed' }));
  lead.onTask(msg('task_started', { task_id: 't2', subagent_type: 'expedition-gatherer' }));
  lead.onTask(msg('task_started', { task_id: 't2', subagent_type: 'expedition-gatherer' }));            // a repeat is one task
  lead.onTask(msg('task_started', { task_id: 'sh', task_type: 'local_bash' }));                         // a shell, not a gatherer
  lead.onTask(msg('task_started', { task_id: 'amb', subagent_type: 'x', ambient: true }));              // housekeeping
  assert.equal(ex.runningSubagents(), 2);
  lead.onTask(msg('task_progress', { task_id: 't1', usage: { total_tokens: 900, tool_uses: 2, duration_ms: 10 } }));
  assert.equal(lead.subagents.get('t1').tokens, 900, 'kept for the watchdog\'s estimate; not logged');
  lead.onTask(msg('task_notification', { task_id: 't1', status: 'completed', usage: { total_tokens: 1500, tool_uses: 4, duration_ms: 20 } }));
  lead.onTask(msg('task_notification', { task_id: 'never-seen', status: 'completed' }));
  assert.equal(ex.runningSubagents(), 1);
  const evs = p.log.ofType('expedition_subagent');
  assert.deepEqual(evs.map(e => [e.phase, e.taskId, e.subagentType, e.tokens ?? null, e.status ?? null, e.expedition]), [
    ['started', 't1', 'expedition-gatherer', null, null, A.id], ['started', 't2', 'expedition-gatherer', null, null, A.id], ['ended', 't1', 'expedition-gatherer', 1500, 'completed', A.id]]);
  // Through onMessage, the Lead's own message loop (and only the Lead's).
  return Promise.resolve(lead.onMessage(msg('task_started', { task_id: 't3', subagent_type: 'expedition-gatherer' }), null)).then(async () => {
    assert.equal(ex.runningSubagents(), 2);
    await A.agents.builder.onMessage(msg('task_started', { task_id: 'b1', subagent_type: 'expedition-gatherer' }), null);
    assert.equal(ex.runningSubagents(), 2, 'a builder is not the Lead: its task messages are not gatherers');
    // A new query cannot have the old one's subagents: the log's open ones are closed.
    lead.closeOpenSubagents();
    assert.equal(ex.runningSubagents(), 0);
    assert.deepEqual(p.log.ofType('expedition_subagent').slice(-2).map(e => [e.phase, e.status]), [['ended', 'stopped'], ['ended', 'stopped']]);
  });
});

// ---------- the query options of an expedition's agents ----------
test('the Lead\'s query carries the gatherer definition and the Agent tool; every expedition agent has no scheduling or trigger tools; others are unchanged', () => {
  const { A, plain, env } = world();
  const lead = A.agents.lead, builder = A.agents.builder;
  const o = lead.options();
  assert.deepEqual(Object.keys(o.agents), ['expedition-gatherer']);
  const g = o.agents['expedition-gatherer'];
  assert.deepEqual([g.model, g.effort], [MODEL.haiku, 'low']);
  assert.deepEqual(g.tools, ['WebSearch', 'WebFetch', 'Read', 'Write']);
  assert.match(g.prompt, /Answer only your one sub-question/);
  assert.deepEqual(g.disallowedTools, DISALLOWED_TOOLS);
  assert.ok(o.tools.includes('Agent'), 'the Agent tool is the Lead\'s (its type\'s tools list)');
  assert.ok(o.allowedTools.includes('mcp__crux__start_worker'));
  for (const x of [o, builder.options()]) for (const t of ['CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'ScheduleWakeup']) assert.ok(x.disallowedTools.includes(t), t);
  assert.equal(builder.options().agents, undefined);
  assert.ok(!builder.options().allowedTools.includes('mcp__crux__start_worker'));
  // The launch screen's gatherer pick (stored in expedition_started) wins over the file.
  const started = env.p.log.events.find(e => e.type === 'expedition_started' && e.expedition === A.id);
  started.roles.gatherer = { type: 'expedition-gatherer', model: 'sonnet', effort: 'medium' };
  A.ex.cache = null;
  const g2 = lead.options().agents['expedition-gatherer'];
  assert.deepEqual([g2.model, g2.effort], [MODEL.sonnet, 'medium']);
  // A plain worker and the orchestrator get neither.
  assert.equal(plain.options().agents, undefined);
  assert.ok(!plain.options().disallowedTools.includes('CronCreate'));
  assert.equal(env.orch.options().agents, undefined);
});

// The first real expedition (f13ld.mesh, 2026-11-16): all six gatherers said their session had only Read and Write. The Lead's
// own tools list (Agent, Read, Grep, Glob, Write, Edit) is the base set of its session and a subagent gets only what that has,
// so the gatherer file's WebSearch and WebFetch never reached them.
test('the Lead\'s session carries every tool its gatherers need (web search and fetch), but the Lead may not use the borrowed ones itself', async () => {
  const { A, hub, p } = world();
  const lead = A.agents.lead;
  const o = lead.options();
  const g = o.agents['expedition-gatherer'];
  for (const t of g.tools) assert.ok(o.tools.includes(t), `${t}: a gatherer's tool must be in the Lead's session, or the gatherer does not get it`);
  assert.ok(o.tools.includes('WebSearch') && o.tools.includes('WebFetch'));
  for (const t of ['Agent', 'Read', 'Grep', 'Glob', 'Write', 'Edit']) assert.ok(o.tools.includes(t), `${t} stays the Lead's`);
  assert.equal(new Set(o.tools).size, o.tools.length, 'no tool is listed twice');
  // The hook: a gatherer's own WebSearch is let through; the Lead's own is refused with a pointer to its gatherers.
  const hook = o.hooks.PreToolUse[0].hooks[0];
  const web = { tool_name: 'WebSearch', tool_input: { query: 'gpu marching cubes webgpu' }, tool_use_id: 'tu-w' };
  assert.deepEqual(await hook({ ...web, agent_id: 'agent-1', agent_type: 'expedition-gatherer' }), {});
  const own = await hook(web);
  assert.equal(own.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(own.hookSpecificOutput.permissionDecisionReason, /gatherers/);
  assert.deepEqual(await hook({ tool_name: 'Read', tool_input: { file_path: join(p.dir, 'README.md') }, tool_use_id: 'tu-r' }), {});
  // The permission path, for a gatherer's WebSearch during the running expedition: allowed, no card, nothing parked.
  lead.noteSubagent({ tool_use_id: 'tu-s', agent_id: 'agent-1', agent_type: 'expedition-gatherer' });
  const r = await hub.requestApproval(p, lead, 'WebSearch', { query: 'gpu marching cubes webgpu' }, { toolUseID: 'tu-s', agentID: 'agent-1' });
  assert.equal(r.behavior, 'allow');
  assert.equal(p.log.ofType('expedition_parked').filter(e => e.tool === 'WebSearch').length, 0);
  assert.equal(hub.approvals.size, 0);
  // Only tools the Lead lacks are borrowed (a tool it already has is not listed twice or taken from it).
  const bash = lead.leadTools(['Read', 'Write'], { x: { tools: ['Bash', 'Read'] }, y: { tools: ['Bash', 'WebFetch'] } });
  assert.deepEqual(bash, { all: ['Read', 'Write', 'Bash', 'WebFetch'], borrowed: ['Bash', 'WebFetch'] });
});

test('research reads: an unlisted https page is allowed for a gatherer, the Skeptic and the Verifier while the expedition runs; not for the Lead, not after it, and downloads stay parked', async () => {
  const { A, plain, hub, p, env } = world();
  const lead = A.agents.lead, verifier = A.agents.verifier, builder = A.agents.builder;
  const mark = quietMark(env);
  const page = { url: 'https://www.khronos.org/opengl/wiki/Marching_Cubes', prompt: 'the table' };
  const asGatherer = (url = page.url) => { lead.noteSubagent({ tool_use_id: 'tu-g', agent_id: 'agent-g', agent_type: 'expedition-gatherer' }); return hub.requestApproval(p, lead, 'WebFetch', { ...page, url }, { toolUseID: 'tu-g', agentID: 'agent-g' }); };
  const parked = r => assert.match(r.message, /^Parked, not allowed/);
  // A gatherer subagent (the Lead's request, tagged with the subagent behind it) and the Verifier: allowed, no card, nothing parked.
  assert.equal((await asGatherer()).behavior, 'allow');
  assert.equal((await hub.requestApproval(p, verifier, 'WebFetch', page)).behavior, 'allow');
  assert.equal(p.log.ofType('expedition_parked').length, 0);
  assert.deepEqual(quietProblems(env, mark, sent), []);
  // Still the strict gate: http, a port, an IP address, user info, a machine-local name.
  for (const url of ['http://www.khronos.org/x', 'https://www.khronos.org:8443/x', 'https://192.168.1.5/admin', 'https://user@www.khronos.org/x', 'https://nas.local/x', 'https://localhost/x']) parked(await asGatherer(url));
  // The Lead's own read, the builder's, and a plain worker's: the usual rules (parked in an expedition, a card outside).
  parked(await hub.requestApproval(p, lead, 'WebFetch', page));
  parked(await hub.requestApproval(p, builder, 'WebFetch', page));
  hub.requestApproval(p, plain, 'WebFetch', page);
  assert.equal(hub.approvals.size, 1, 'a plain worker outside an expedition still gets a card');
  for (const a of hub.approvals.values()) a.finish({ behavior: 'deny', message: 'test' }, 'denied');
  // A download by a gatherer is another tool and stays parked; so does a POST by shell.
  parked(await hub.requestApproval(p, lead, 'Bash', { command: 'curl -L -o /tmp/stl-parser.zip https://example.org/stl-parser.zip' }, { toolUseID: 'tu-g', agentID: 'agent-g' }));
  parked(await hub.requestApproval(p, lead, 'Bash', { command: 'curl -X POST -d x=1 https://example.org/form' }, { toolUseID: 'tu-g', agentID: 'agent-g' }));
  // After the stop: a gatherer or the Skeptic is refused; the Verifier's report pass may still read. After the end: nobody.
  A.ex.stop({ reason: 'passed', totals: {} });
  parked(await asGatherer());
  assert.equal((await hub.requestApproval(p, verifier, 'WebFetch', page)).behavior, 'allow');
  for (const s of ['report', 'commit', 'push', 'pr', 'card', 'summary']) A.ex.step(s);
  assert.equal(A.ex.state().phase, 'ended');
  parked(await asGatherer());
  parked(await hub.requestApproval(p, verifier, 'WebFetch', page));
});

test('a gatherer\'s request is tagged with the subagent behind it (hook agent_id and type, or the SDK\'s agentID); the Lead\'s own is not', () => {
  const { A, plain } = world();
  const lead = A.agents.lead;
  lead.noteSubagent({ tool_use_id: 'a', agent_id: 'sub-1', agent_type: 'expedition-gatherer' });
  lead.noteSubagent({ tool_use_id: 'b' });                      // the Lead's own call: no agent_id
  lead.noteSubagent({ tool_use_id: 'c', agent_id: '' });
  assert.deepEqual(lead.subagentFor('a', 'sub-1'), { id: 'sub-1', type: 'expedition-gatherer' });
  assert.deepEqual(lead.subagentFor('a'), { id: 'sub-1', type: 'expedition-gatherer' });
  assert.deepEqual(lead.subagentFor('zzz', 'sub-2'), { id: 'sub-2', type: null });
  assert.equal(lead.subagentFor('b'), null);
  assert.equal(lead.subagentFor('c'), null);
  // The type falls back to a task the hub counted for that id.
  lead.onTask({ type: 'system', subtype: 'task_started', task_id: 'sub-3', subagent_type: 'expedition-gatherer' });
  assert.deepEqual(lead.subagentFor('zzz', 'sub-3'), { id: 'sub-3', type: 'expedition-gatherer' });
  // A plain agent (not in an expedition) keeps no subagent notes, so nothing of it reaches an event.
  plain.noteSubagent({ tool_use_id: 'x', agent_id: 'sub-9', agent_type: 't' });
  assert.equal(plain.toolSubagents, undefined);
});

// ---------- the Conductor and the thread list ----------
test('the Conductor counts an expedition\'s agents as no workers and no one working; it lists the expedition as one entry', () => {
  const { A, B, plain, hub, p } = world({ conductor: true });
  for (const a of [A.agents.lead, A.agents.builder, A.agents.verifier, plain]) a.state = 'working';
  const o = hub.conductor.overview().projects.find(x => x.name === p.name);
  assert.deepEqual([o.workers, o.working], [1, 1], 'only the plain worker');
  const list = hub.conductor.agents(p);
  assert.deepEqual(list.map(a => a.name).sort(), [plain.name, hub.project(p.name).orchestrator().name, `expedition ${A.id}`, `expedition ${B.id}`].sort());
  assert.equal(list.find(a => a.role === 'expedition').state, 'planning');
});

// ---------- review follow-ups (#104) ----------
test('launch checks the success-test file names before it writes anything', () => {
  sent.length = 0;
  const env = stubHub({ level: 'auto' });
  const { hub, p } = env;
  for (const name of ['../evil.md', 'sub/x.md', 'BRIEF.md', 'brief.md', '.hidden', 'a\b.md', '']) {
    assert.throws(() => hub.launchExpedition(p, { brief: 'q', test: { 'CHECKLIST.md': '1', [name]: 'x' } }), /not a name for a success-test file/, name);
  }
  assert.equal(Expedition.all(p).length, 0);
  assert.equal(existsSync(join(p.dir, '.crux', 'expeditions')), false, 'no folder, no BRIEF.md');
  assert.equal(p.log.ofType('agent_created').filter(e => e.expedition).length, 0);
});

// A merge pass is a plain worker's: logged by a card answer, it lets that exact command through once.
test('a merge pass never lets an expedition agent merge: parked, no allow, no waiting entry, the check never asked', async () => {
  const { A, plain, hub, p, env } = world();
  const builder = A.agents.builder;
  let asked = 0;
  hub.checkerMade = { run: async () => { asked++; return { valid: true, answer: 'allow', reason: 'x' }; } };
  hub.settings.setProject(p.dir, { permissionCheck: 'on' });
  const pass = (asker, n) => p.log.append('merge_pass', { pass: `pass-${asker}`, card: `question:${asker}`, asker, number: n, thread: asker });
  pass(builder.name, 12); pass(plain.name, 12);
  const cmd = { command: 'gh pr merge 12 --squash' };
  // Control: the same pass lets a plain worker's merge through at once, logged as a pass.
  const ok = await hub.requestApproval(p, plain, 'Bash', cmd);
  assert.equal(ok.behavior, 'allow');
  assert.ok(p.log.ofType('permission_answer').some(e => e.pass === `pass-${plain.name}` && e.answer === 'allow'));
  const answersBefore = p.log.ofType('permission_answer').length, parkedBefore = p.log.ofType('expedition_parked').length;
  // The Builder asks for that exact command with a pass of its own on the log.
  const r = await hub.requestApproval(p, builder, 'Bash', cmd);
  assert.equal(r.behavior, 'deny');
  assert.match(r.message, /^Parked, not allowed/);
  const mine = p.log.ofType('permission_answer').slice(answersBefore);
  assert.deepEqual(mine.map(e => [e.answer, e.pass ?? null]), [['deny', null]], 'one deny, no allow, no pass used');
  assert.equal(p.log.ofType('expedition_parked').length, parkedBefore + 1);
  assert.equal(hub.approvals.size, 0);
  assert.equal(p.log.ofType('approval').length, 0);
  assert.equal(asked, 0, 'the check was never called');
  void env;
});

test('check on: an unclear request is judged by the check and allowed by it, with no waiting entry or approval event', async () => {
  sent.length = 0;
  const env = stubHub({ level: 'auto' });
  const ex = world2(env), { hub, p } = env;
  hub.settings.setProject(p.dir, { permissionCheck: 'on' });
  const calls = [];
  hub.checkerMade = { run: async req => { calls.push(req.tool); return { valid: true, answer: 'allow', reason: 'a public page, read only', model: 'claude-sonnet-5-5' }; } };
  const mark = quietMark(env);
  const r = await hub.requestApproval(p, ex.lead, 'WebFetch', { url: 'http://example.org/page', prompt: 'p' });
  assert.equal(r.behavior, 'allow');
  assert.deepEqual(calls, ['WebFetch'], 'the check was asked once');
  assert.equal(hub.approvals.size, 0);
  assert.equal(p.log.ofType('approval').length, 0);
  const a = p.log.ofType('permission_answer').at(-1);
  assert.deepEqual([a.answer, a.by, a.thread, a.expedition], ['allow', 'permission check', ex.lead.thread, ex.id]);
  assert.deepEqual(quietProblems(env, mark, sent), []);
});

test('check on: the check\'s usage for an expedition\'s request carries the expedition, so its spend counts against the budget', async () => {
  sent.length = 0;
  const env = stubHub({ level: 'auto' });
  const ex = world2(env), { hub, p } = env;
  hub.settings.setProject(p.dir, { permissionCheck: 'on' });
  hub.checkerMade = { run: async () => ({ valid: true, answer: 'allow', reason: 'fine', model: 'claude-sonnet-5-5', modelUsage: { 'claude-sonnet-5-5': { inputTokens: 100, outputTokens: 20, costUSD: 0.01 } } }) };
  const mark = quietMark(env);
  const r = await hub.requestApproval(p, ex.lead, 'WebFetch', { url: 'http://example.org/page', prompt: 'p' });
  assert.equal(r.behavior, 'allow');
  const usage = p.log.ofType('usage').filter(e => e.agentType === 'check');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].expedition, ex.id, 'its spend counts against the expedition');
  assert.deepEqual(quietProblems(env, mark, sent), []);
});
