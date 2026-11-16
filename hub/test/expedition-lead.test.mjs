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
  assert.throws(() => hub.launchExpedition(p, { brief: '   ' }), /brief is empty/);
  assert.throws(() => hub.launchExpedition(p, { brief: 'q', roles: { verifier: { model: 'sonnet' } } }), /Verifier and the Builder both run on/);
  assert.equal(Expedition.all(p).length, 0, 'a refusal writes nothing');
  assert.equal(p.log.ofType('agent_created').filter(e => e.expedition).length, 0);
  // At Ask.
  hub.setPermissionMode(p, 'standard', 'you');
  assert.throws(() => hub.launchExpedition(p, { brief: 'q' }), /project is at Ask.*Auto or Trusted/);
  hub.setPermissionMode(p, 'auto', 'you');
  // Success.
  const r = hub.launchExpedition(p, { question: 'Which of two JSON libraries is faster for X?', brief: 'Compare two JSON libraries.\nSuccess: a table and a runnable benchmark.', test: { 'CHECKLIST.md': '1. a table\n', 'run.json': '{"command":"node bench.mjs"}' }, envelope: { hours: 2, dollars: 5 }, gatherers: 9 }, 'you');
  assert.match(r.id, /^\d{8}-which-of-two-json-libraries-is-faster-fo$/, 'the slug is the question\'s words, cut at 40 characters');
  const ex = new Expedition(p, r.id);
  assert.equal(ex.state().phase, 'planning');
  assert.match(ex.read('BRIEF.md'), /Compare two JSON libraries/);
  assert.deepEqual(ex.testFiles(), ['test/CHECKLIST.md', 'test/run.json']);
  assert.deepEqual([r.expedition.envelope.hours, r.expedition.envelope.dollars, r.expedition.envelope.gatherers], [2, 5, 4], 'gatherers are capped at the hard limit of 4');
  const lead = p.agents.get(r.lead);
  assert.deepEqual([lead.expedition, lead.expeditionRole, lead.type, lead.model, lead.effort], [r.id, 'lead', 'expedition-lead', MODEL.opus, 'medium']);
  assert.match(lead.task, /Gatherers: up to 4 at once/);
  assert.match(lead.task, /Compare two JSON libraries/);
  assert.deepEqual(Object.fromEntries(Object.entries(r.expedition.roles).map(([k, v]) => [k, v.model])), { lead: MODEL.opus, advisor: MODEL.fable, gatherer: MODEL.haiku, synthesizer: MODEL.opus, skeptic: MODEL.sonnet, builder: MODEL.sonnet, verifier: MODEL.opus });
  // One at a time: refused while it runs, and while it is writing up; allowed once the Lead's summary has gone.
  assert.throws(() => hub.launchExpedition(p, { brief: 'another' }), /still planning: one expedition runs per project at a time/);
  ex.write('test/CHECKLIST.md', '1. a table\n2. a benchmark\n');
  ex.gate({ verdict: 'ok' });
  ex.stop({ reason: 'passed' });
  assert.throws(() => hub.launchExpedition(p, { brief: 'another' }), /still writing up/);
  for (const s of ['report', 'commit', 'push', 'pr', 'card', 'summary']) ex.step(s);
  const second = hub.launchExpedition(p, { question: 'Which of two JSON libraries is faster for X?', brief: 'again' });
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

  // With the check on: allow and deny settle on the spot; escalate, consult and a failure are parked. Still no card.
  sent.length = 0;
  const env2 = stubHub({ level: 'auto' });
  const w2 = world2(env2);
  env2.hub.settings.setProject(env2.p.dir, { permissionCheck: 'on' });
  let answer = { valid: true, answer: 'allow', reason: 'a public page, read only', model: 'claude-sonnet-5-5' };
  env2.hub.checkerMade = { run: async () => answer };
  const mark2 = quietMark(env2);
  const q = () => env2.hub.requestApproval(env2.p, w2.lead, 'WebFetch', { url: `https://example.org/${Math.random()}`, prompt: 'p' }, { toolUseID: 'tu-9', agentID: 'agent-9' });
  w2.lead.noteSubagent({ tool_use_id: 'tu-9', agent_id: 'agent-9', agent_type: 'expedition-gatherer' });
  assert.equal((await q()).behavior, 'allow');
  const allowed = env2.p.log.ofType('permission_answer').at(-1);
  assert.deepEqual([allowed.answer, allowed.by, allowed.thread, allowed.expedition, allowed.subagent], ['allow', 'permission check', w2.lead.thread, w2.id, { id: 'agent-9', type: 'expedition-gatherer' }]);
  answer = { valid: true, answer: 'deny', reason: 'not a page the brief names', model: 'claude-sonnet-5-5' };
  const denied = await q();
  assert.match(denied.message, /^The permission check declined/);
  for (const a of [{ valid: true, answer: 'escalate', reason: 'a licence question' }, { valid: true, answer: 'consult', reason: 'unsure' }, { valid: false, error: 'no answer' }]) {
    answer = a;
    const r = await q();
    assert.equal(r.behavior, 'deny');
    assert.match(r.message, /^Parked, not allowed/);
  }
  assert.equal(env2.hub.approvals.size, 0);
  assert.deepEqual(quietProblems(env2, mark2, sent), []);
  assert.equal(env2.p.log.ofType('expedition_parked').filter(e => e.kind === 'request').length, 3, 'one parked line per distinct request: the three that were parked');
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

test('check on: a worker-written script is judged by the check and allowed by it, with no waiting entry or approval event', async () => {
  sent.length = 0;
  const env = stubHub({ level: 'auto' });
  const ex = world2(env), { hub, p } = env;
  writeFileSync(join(p.dir, 'build.mjs'), 'console.log(1)\n');
  hub.settings.setProject(p.dir, { permissionCheck: 'on' });
  const calls = [];
  hub.checkerMade = { run: async req => { calls.push(req.tool); return { valid: true, answer: 'allow', reason: 'a small script of its own', model: 'claude-sonnet-5-5' }; } };
  const mark = quietMark(env);
  const r = await hub.requestApproval(p, ex.lead, 'Bash', { command: 'node build.mjs' });
  assert.equal(r.behavior, 'allow');
  assert.deepEqual(calls, ['Bash'], 'the check was asked once');
  assert.equal(hub.approvals.size, 0);
  assert.equal(p.log.ofType('approval').length, 0);
  const a = p.log.ofType('permission_answer').at(-1);
  assert.deepEqual([a.answer, a.by, a.thread, a.expedition], ['allow', 'permission check', ex.lead.thread, ex.id]);
  assert.deepEqual(quietProblems(env, mark, sent), []);
});

test('shadow check: an expedition agent\'s line and the check\'s usage carry the expedition and stay out of the orchestrator\'s thread', async () => {
  sent.length = 0;
  const env = stubHub({ level: 'auto' });
  const ex = world2(env), { hub, p } = env;
  writeFileSync(join(p.dir, 'build.mjs'), 'console.log(1)\n');
  hub.settings.setProject(p.dir, { permissionCheck: 'shadow' });
  hub.checkerMade = { run: async () => ({ valid: true, answer: 'allow', reason: 'fine', model: 'claude-sonnet-5-5', modelUsage: { 'claude-sonnet-5-5': { inputTokens: 100, outputTokens: 20, costUSD: 0.01 } } }) };
  const mark = quietMark(env);
  const r = await hub.requestApproval(p, ex.lead, 'Bash', { command: 'node build.mjs' });
  assert.equal(r.behavior, 'allow', 'shadow mode allows as Auto does');
  for (let i = 0; i < 20 && !p.log.ofType('check_shadow').length; i++) await new Promise(res => setImmediate(res));
  const line = p.log.ofType('permission_answer').at(-1);
  assert.deepEqual([line.thread, line.expedition], [ex.lead.thread, ex.id]);
  assert.equal(p.log.ofType('check_shadow').at(-1).expedition, ex.id);
  const usage = p.log.ofType('usage').filter(e => e.agentType === 'check');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].expedition, ex.id, 'its spend counts against the expedition');
  assert.deepEqual(quietProblems(env, mark, sent), []);
});
