// Expedition module, phase 1 (decisions 68 to 72): the seven agent files, the expedition fields on agents (saved, read
// back, copied to a successor, carried on usage events), the one upward resolver, the Expedition class (ids, layout,
// files, event kinds, state), the report's "how it ran", and the spec's acceptance: a dry run with stub agents writes
// every file and every event. Agents are stubbed: nothing starts. (The invariant has its own file.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordAgents, stubHub, StubExpedition, MODEL } from './helpers/expedition-stub.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { parseAgentFile } from '../lib/agent-types.mjs';
import { Expedition, ROLES, HUB_ROLES, EVENT_KINDS, END_STEPS, DEFAULT_ENVELOPE, roleOfType, defaultRoles } from '../lib/expedition.mjs';
import { howItRan, howItRanMarkdown, LEAD_LABEL } from '../lib/expedition-report.mjs';
import { MapModel } from '../public/map-model.js';
import { summaryReply } from '../lib/tools.mjs';

const sent = recordAgents();
const here = dirname(fileURLToPath(import.meta.url));
const STARTER = join(here, '..', '..', 'agent-types', 'starter');
const fresh = () => { sent.length = 0; const env = stubHub(); return { env, ex: new StubExpedition(env) }; };
const summary = (over = {}) => ({ done: [], changed: [], questions: [], decisions_needed: [], blocked_on: [], next_step: '', visuals: [], approvals: [], open_questions: [], ...over });

// ---------- the seven agent files (spec section 3, decision 68 C) ----------
test('the seven role files match the spec table: name, model, effort, tools, and the Lead\'s Agent tool', () => {
  const files = readdirSync(STARTER).filter(f => /^expedition-.*\.md$/.test(f)).sort();
  assert.deepEqual(files, ['expedition-advisor.md', 'expedition-builder.md', 'expedition-gatherer.md', 'expedition-lead.md', 'expedition-skeptic.md', 'expedition-synthesizer.md', 'expedition-verifier.md']);
  const spec = { lead: ['opus', 'medium'], advisor: ['fable', 'medium'], gatherer: ['haiku', 'low'], synthesizer: ['opus', 'medium'], skeptic: ['sonnet', 'high'], builder: ['sonnet', 'medium'], verifier: ['opus', 'high'] };
  const types = {};
  for (const f of files) { const t = parseAgentFile(readFileSync(join(STARTER, f), 'utf8'), f); types[t.name] = t; }
  for (const [role, [model, effort]] of Object.entries(spec)) {
    const t = types[`expedition-${role}`];
    assert.ok(t, role);
    assert.ok(t.description.length > 20, `${role} has a description`);
    assert.ok(t.prompt.length > 200, `${role} has standing instructions`);
    assert.ok(t.model.includes(model), `${role} model ${t.model}`);
    assert.equal(t.effort, effort, `${role} effort`);
    // The code's role table says the same as the files, so the launch screen's defaults are the files'.
    assert.equal(ROLES[role].type, t.name);
    assert.ok(t.model.includes(ROLES[role].model) && ROLES[role].effort === t.effort, `${role} table matches its file`);
  }
  // The Lead has the Agent tool (for gatherers) and Write (PLAN.md, DECISIONS.md, REPORT.md); the roles that write a file have Write.
  assert.ok(types['expedition-lead'].tools.includes('Agent'));
  for (const r of ['lead', 'advisor', 'gatherer', 'synthesizer', 'skeptic', 'builder', 'verifier']) assert.ok(types[`expedition-${r}`].tools.includes('Write'), `${r} writes its own file`);
  assert.ok(!types['expedition-gatherer'].tools.includes('Bash'));
  assert.ok(types['expedition-verifier'].tools.includes('Bash') && types['expedition-verifier'].tools.includes('WebFetch'));
  for (const r of ['lead', 'advisor', 'skeptic', 'builder', 'verifier', 'synthesizer']) assert.ok(!types[`expedition-${r}`].tools.includes('CronCreate'), 'no scheduling tool');
  // The limit on gatherers lives in the Lead's instructions (decision 68 C), and the Verifier is never the Builder's model.
  assert.match(types['expedition-lead'].prompt, /at most 4 at once/);
  assert.match(types['expedition-lead'].prompt, /one second round/);
  assert.notEqual(types['expedition-verifier'].model, types['expedition-builder'].model);
  // Which roles are hub agents and which a subagent: Matt's pick (68 C, Synthesizer as a hub agent).
  assert.deepEqual(HUB_ROLES, ['lead', 'advisor', 'synthesizer', 'skeptic', 'builder', 'verifier']);
  assert.equal(ROLES.gatherer.runs, 'subagent');
  assert.equal(roleOfType('expedition-skeptic'), 'skeptic');
  assert.equal(readFileSync(join(STARTER, 'README.md'), 'utf8').includes('expedition-verifier'), true, 'the README lists them');
});

test('the Verifier refuses to run on the Builder\'s model', () => {
  const { env, ex } = fresh();
  ex.ex.write('BRIEF.md', 'q');
  assert.throws(() => ex.ex.start({ roles: { verifier: { model: 'sonnet' } } }), /Verifier must be a different model from the Builder/);
  assert.equal(env.p.log.ofType('expedition_started').length, 0, 'nothing was logged');
});

// ---------- ids and the layout ----------
test('ids are YYYYMMDD-slug, kept apart on a clash, and files stay inside the layout', () => {
  const d = new Date(2026, 10, 16);
  assert.equal(Expedition.makeId('JSON library speed comparison', { date: d }), '20261116-json-library-speed-comparison', 'a 4-word title fits whole');
  assert.equal(Expedition.makeId('Compare lattice meshing speed across engines', { date: d }), '20261116-compare-lattice-meshing-speed', 'the slug is cut at a word boundary, 30 characters at most');
  assert.equal(Expedition.makeId('Supercalifragilisticexpialidocious-and-more', { date: d }), '20261116-supercalifragilisticexpialidoc', 'one long word is cut hard');
  assert.equal(Expedition.makeId('!!!', { date: d }), '20261116-expedition');
  assert.equal(Expedition.shortTitle('JSON library speed comparison', 'anything'), 'JSON library speed comparison');
  assert.equal(Expedition.shortTitle('', 'Which of two JSON libraries is faster for X?'), 'two JSON libraries faster X', 'no title: the first meaningful words of the question');
  assert.equal(Expedition.shortTitle('one two three four five six seven eight nine ten', 'How should we cache the mesh?'), 'cache mesh', 'too long: falls back to the question');
  assert.equal(Expedition.shortTitle(undefined, ''), 'Expedition');
  assert.equal(Expedition.makeId('JSON bench', { date: d, taken: ['20261116-json-bench'] }), '20261116-json-bench-2');
  assert.equal(Expedition.makeId('JSON bench', { date: d, taken: ['20261116-json-bench', '20261116-json-bench-2'] }), '20261116-json-bench-3');
  const { env } = fresh();
  assert.throws(() => new Expedition(env.p, '../etc'), /not an expedition id/);
  const ex = new Expedition(env.p, '20261116-json-bench').init();
  assert.ok(ex.root.endsWith(join('.crux', 'expeditions', '20261116-json-bench')));
  for (const bad of ['../x.md', '/etc/passwd', 'C:\\x.md', 'test/../../x', 'other.md', 'test/', 'notes-.md', 'frozen/x', '.crux/events.jsonl', 'notes-1.md/../../x']) assert.throws(() => ex.path(bad), /not a file of an expedition/, bad);
  for (const ok of ['BRIEF.md', 'test/CHECKLIST.md', 'test/sub/run.json', 'notes-gpu-2.md', 'verify/VERDICT.md', 'test\\run.json']) ex.path(ok);
  assert.equal(ex.read('PLAN.md'), null, 'a missing file reads as null');
  assert.equal(ex.branch, 'expedition/20261116-json-bench');
  assert.ok(ex.worktree.endsWith(join('.claude', 'worktrees', 'exp-20261116-json-bench')));
});

test('the test hash covers paths and bytes, and an empty test cannot be frozen', () => {
  const { env } = fresh();
  const ex = new Expedition(env.p, '20261116-hash').init();
  assert.throws(() => ex.testHash(), /success test is empty/);
  ex.write('test/CHECKLIST.md', 'one');
  const a = ex.testHash();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(ex.testHash(), a, 'stable');
  ex.write('test/CHECKLIST.md', 'two');
  assert.notEqual(ex.testHash(), a, 'bytes');
  ex.write('test/CHECKLIST.md', 'one');
  assert.equal(ex.testHash(), a);
  ex.write('test/run.json', '{}');
  assert.notEqual(ex.testHash(), a, 'a new file');
});

// ---------- events: every kind, each carrying expedition ----------
test('the event kinds enforce their payloads, their order, and carry expedition: <id>', () => {
  const { env } = fresh();
  const ex = new Expedition(env.p, '20261116-kinds').init();
  assert.throws(() => ex.decide({ text: 'x', reason: 'y', maker: 'z' }), /is new; this needs/);
  assert.throws(() => ex.start(), /BRIEF\.md is needed/);
  ex.write('BRIEF.md', 'q');
  const started = ex.start({ envelope: { hours: 1 } });
  assert.equal(started.expedition, '20261116-kinds');
  assert.deepEqual(started.envelope, { ...DEFAULT_ENVELOPE, hours: 1 });
  assert.deepEqual(started.roles, defaultRoles());
  assert.match(started.briefHash, /^[0-9a-f]{64}$/);
  assert.equal(started.branch, 'expedition/20261116-kinds');
  assert.throws(() => ex.start(), /is planning; this needs it to be new/);
  assert.throws(() => ex.gate({ verdict: 'ok' }), /success test is empty/);
  ex.write('test/CHECKLIST.md', '1. x');
  assert.throws(() => ex.gate({ verdict: ' ' }), /verdict is needed/);
  assert.throws(() => ex.loop({ number: 1, passing: 0, progress: false }), /needs it to be running/);
  const gate = ex.gate({ verdict: 'approve', amendments: 'one' });
  assert.deepEqual(gate.amendments, ['one']);
  assert.equal(gate.testHash, ex.testHash());
  assert.throws(() => ex.gate({ verdict: 'again' }), /is running; this needs it to be planning/, 'the test is amended only before the freeze');
  assert.equal(ex.decide({ text: 'Use A', reason: 'in scope', maker: 'lead' }).number, 1);
  assert.equal(ex.decide({ text: 'Use B', reason: 'in scope', maker: 'advisor' }).number, 2);
  assert.equal(ex.read('DECISIONS.md'), '1. Use A. Reason: in scope. By: lead.\n2. Use B. Reason: in scope. By: advisor.\n');
  assert.throws(() => ex.decide({ text: 'x', reason: '', maker: 'z' }), /reason is needed/);
  assert.throws(() => ex.loop({ number: 0, passing: 0, progress: false }), /number from 1/);
  ex.loop({ number: 1, passing: 2, progress: 1 });
  assert.equal(ex.state().loops[0].progress, true);
  ex.note('90%');
  ex.subagent({ phase: 'started', subagentType: 'expedition-gatherer', taskId: 'a' });
  ex.subagent({ phase: 'started', subagentType: 'expedition-gatherer', taskId: 'b' });
  assert.equal(ex.runningSubagents(), 2);
  ex.subagent({ phase: 'ended', subagentType: 'expedition-gatherer', taskId: 'a', tokens: 10 });
  assert.equal(ex.runningSubagents(), 1);
  assert.throws(() => ex.subagent({ phase: 'paused', subagentType: 'x', taskId: 't' }), /started or ended/);
  assert.throws(() => ex.stop({ reason: 'bored' }), /stop reason is one of/);
  assert.throws(() => ex.step('report'), /needs it to be stopped/);
  ex.stop({ reason: 'time', totals: { costUSD: 1 } });
  assert.equal(ex.state().phase, 'stopped');
  assert.throws(() => ex.stop({ reason: 'time' }), /is stopped; this needs/);
  assert.throws(() => ex.step('lunch'), /end step is one of/);
  assert.ok(ex.step('report'));
  assert.equal(ex.step('report'), null, 'a step already done is skipped');
  assert.equal(ex.summaryDue(), false);
  for (const s of END_STEPS.filter(s => s !== 'report' && s !== 'summary')) ex.step(s);
  assert.equal(ex.summaryDue(), true);
  ex.step('summary');
  assert.equal(ex.state().phase, 'ended');
  assert.equal(ex.summaryDue(), false, 'once');
  assert.throws(() => ex.record('expedition_unknown'), /Unknown expedition event/);
  // Everything logged for it carries the id.
  const mine = env.p.log.events.filter(e => e.type.startsWith('expedition_'));
  assert.ok(mine.length >= 15);
  for (const e of mine) assert.equal(e.expedition, '20261116-kinds', e.type);
  // Other expeditions' state is separate.
  assert.equal(new Expedition(env.p, '20261116-other').state().phase, 'new');
  assert.deepEqual(Expedition.all(env.p), [{ id: '20261116-kinds', phase: 'ended' }]);
});

// ---------- agent fields ----------
test('expedition and expeditionRole are saved in agent_created, restored, copied to a successor, and on usage events', () => {
  const { env, ex } = fresh();
  ex.ex.write('BRIEF.md', 'q');
  const lead = ex.startRole('lead', env.orch.name);
  assert.deepEqual([lead.expedition, lead.expeditionRole, lead.type, lead.role], [ex.id, 'lead', 'expedition-lead', 'worker']);
  assert.match(lead.model, /opus/);
  assert.equal(lead.effort, 'medium');
  const created = env.p.log.ofType('agent_created').find(e => e.agent === lead.name);
  assert.equal(created.expedition, ex.id);
  assert.equal(created.expeditionRole, 'lead');
  // A plain worker's agent_created carries neither field.
  const plain = env.hub.startWorker(env.p, 'plain', 'x', 'you', 'x');
  const pc = env.p.log.ofType('agent_created').find(e => e.agent === plain.name);
  assert.ok(!('expedition' in pc) && !('expeditionRole' in pc));
  assert.equal(plain.expedition, null);
  // Usage events carry them.
  ex.usage('lead');
  const u = env.p.log.ofType('usage').find(e => e.agent === lead.name);
  assert.equal(u.expedition, ex.id);
  assert.equal(u.expeditionRole, 'lead');
  ex.agents.builder = env.hub.startWorker(env.p, 'b', 'x', lead.name, 'b', { type: 'expedition-builder', expedition: ex.id, expeditionRole: 'builder' });
  plain.logUsage({ modelUsage: { [MODEL.sonnet]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } } });
  assert.ok(!('expedition' in env.p.log.ofType('usage').find(e => e.agent === plain.name)));
  // Read back after a restart: a new hub over the same log.
  const hub2 = new Hub({ projects: [env.dir], memory: new Memory(join(env.root, 'home')), agentHome: join(env.root, 'agents-home'), noAgents: true, settings: new HubSettings({ file: null }) });
  const p2 = hub2.project('proj');
  const lead2 = p2.agents.get(lead.name);
  assert.deepEqual([lead2.expedition, lead2.expeditionRole, lead2.type], [ex.id, 'lead', 'expedition-lead']);
  assert.equal(p2.agents.get(plain.name).expedition, null);
  assert.equal(p2.agents.get('b').expeditionRole, 'builder');
  // A successor keeps them (the Lead's handoff, phase 2): the same path the 60% handoff takes.
  lead.sessionId = 's1';
  lead.leftHandoff = 'H001';
  lead.retiring = 'writing';
  env.hub.startSuccessor(env.p, lead);
  clearTimeout(lead.overlapTimer);   // the 10-minute overlap timer must not keep the test process alive
  const succ = [...env.p.agents.values()].find(a => a.predecessor === lead.name);
  assert.deepEqual([succ.expedition, succ.expeditionRole, succ.type], [ex.id, 'lead', 'expedition-lead']);
  assert.equal(env.hub.expeditionLead(env.p, ex.id), succ, 'the Lead is found by expedition id, not by name; the outgoing one is not it');
  const sc = env.p.log.ofType('agent_created').find(e => e.agent === succ.name);
  assert.equal(sc.expedition, ex.id);
  // The hub's state() carries them for the page.
  const st = env.hub.state()[0].agents.find(a => a.name === succ.name);
  assert.deepEqual([st.expedition, st.expeditionRole], [ex.id, 'lead']);
  assert.ok(!('expedition' in env.hub.state()[0].agents.find(a => a.name === plain.name)));
});

test('only hub code can make an expedition agent: bad ids, unknown roles and non-workers are refused', () => {
  const { env } = fresh();
  const { hub, p } = env;
  assert.throws(() => hub.startWorker(p, 'x', 't', 'you', 'g', { expedition: 'nope', expeditionRole: 'lead' }), /Not an expedition agent/);
  assert.throws(() => hub.startWorker(p, 'x', 't', 'you', 'g', { expedition: '20261116-ok', expeditionRole: 'king' }), /Not an expedition agent/);
  assert.throws(() => hub.createAgent(p, { role: 'orchestrator', settings: { expedition: '20261116-ok', expeditionRole: 'lead' } }), /Not an expedition agent/);
  assert.equal([...p.agents.values()].some(a => a.expedition), false, 'nothing was created');
  assert.equal(p.log.ofType('agent_created').some(e => e.expedition), false, 'nothing was logged');
});

// ---------- the one resolver and the lists ----------
test('upwardOf: orchestrator for everyone else, the Lead for members, none for the Lead until its summary is due', () => {
  const { env, ex } = fresh();
  const { hub, p } = env;
  const plain = hub.startWorker(p, 'plain', 'x', 'you', 'x');
  assert.deepEqual(hub.upwardOf(p, plain), { to: 'orchestrator' });
  assert.deepEqual(hub.upwardOf(p, env.orch), { to: 'orchestrator' });
  ex.ex.write('BRIEF.md', 'q');
  ex.ex.write('test/CHECKLIST.md', '1');
  ex.ex.start();
  const lead = ex.startRole('lead', env.orch.name);
  const builder = ex.startRole('builder', lead.name);
  assert.deepEqual(hub.upwardOf(p, lead), { to: 'none' });
  const up = hub.upwardOf(p, builder);
  assert.equal(up.to, 'lead');
  assert.equal(up.agent, lead);
  // A Lead that is answering its successor is not the one a member reports to.
  lead.retiring = 'overlap';
  assert.deepEqual(hub.upwardOf(p, builder), { to: 'none' });
  lead.retiring = false;
  hub.finishRetire(p, lead);
  assert.deepEqual(hub.upwardOf(p, builder), { to: 'none' }, 'the Lead has stopped');
});

test('workers() and the map leave expedition agents out by default; they are asked for by expedition id', () => {
  const { env, ex } = fresh();
  const { hub, p } = env;
  const plain = hub.startWorker(p, 'plain', 'x', 'you', 'x');
  ex.ex.write('BRIEF.md', 'q'); ex.ex.write('test/CHECKLIST.md', '1'); ex.ex.start();
  const lead = ex.startRole('lead', env.orch.name);
  const builder = ex.startRole('builder', lead.name);
  assert.deepEqual(p.workers(), [plain]);
  assert.deepEqual(p.workers({ expedition: ex.id }).sort((a, b) => a.name.localeCompare(b.name)), [builder, lead]);
  assert.equal(p.workers({ all: true }).length, 3);
  // The orchestrator's list and the handoff facts name no expedition agent as a worker; one line says it is running.
  assert.deepEqual(hub.agentList(p).workers.map(w => w.name), [plain.name]);
  const facts = hub.handoffFacts(p, env.orch);
  assert.ok(!facts.includes(builder.name) && !facts.includes(lead.name), facts);
  assert.match(facts, new RegExp(`- expedition ${ex.id} planning`));
  // Picks go to the orchestrator, or with none live to every live worker: never to an expedition's agents (route 1).
  for (const a of [plain, lead, builder]) Object.defineProperty(a, 'live', { get: () => true, configurable: true });
  sent.length = 0;
  hub.pickMany(p, []);
  assert.deepEqual(sent.map(([n]) => n), [plain.name]);
  // The map's stations: the page's model gets state() agents and leaves expedition agents out.
  const model = new MapModel();
  model.setProject({ name: p.name, agents: hub.state()[0].agents, events: p.log.events, board: { decisions: [], entries: [] } }, new Set());
  assert.deepEqual(model.workers().list.map(w => w.id), [plain.name]);
  // The pause reaches them too: they are workers.
  sent.length = 0;
  hub.setPaused(p, true, 'you');
  assert.deepEqual(sent.map(([n]) => n).sort(), [builder.name, lead.name, plain.name].sort());
});

// ---------- routes 4, 6, 7, 8 through the one resolver ----------
test('a member\'s questions go to the Lead as text and open no card; a core lesson is held; the check\'s denials stay out of the orchestrator\'s notes', () => {
  const { env, ex } = fresh();
  const { hub, p, orch } = env;
  ex.ex.write('BRIEF.md', 'q'); ex.ex.write('test/CHECKLIST.md', '1'); ex.ex.start();
  const lead = ex.startRole('lead', orch.name);
  const verifier = ex.startRole('verifier', lead.name);
  sent.length = 0;
  const r = hub.postSummary(p, verifier, summary({ done: ['ran it'], questions: ['Is 5 ms close enough?'], decisions_needed: [3], outcome: 'partial' }));
  assert.equal(r.held, true);
  const ev = p.log.ofType('summary').at(-1);
  assert.deepEqual([ev.questions, ev.decisions_needed, ev.held.questions, ev.held.decisions_needed, ev.expedition], [[], [], ['Is 5 ms close enough?'], [3], ex.id]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], lead.name);
  assert.match(sent[0][1], /^\[Summary from verifier exp-verifier\]\nDone:\n- ran it\nQuestions \(nobody is available/);
  assert.match(sent[0][1], /Outcome: partial/);
  // The tool's reply tells the agent nobody will answer.
  assert.match(summaryReply(r),/Nobody is available to answer questions during an expedition/);
  // Core lessons are held; project lessons go to the pack as ever.
  assert.match(hub.proposeLesson(p, verifier, 'core', 'Mark substitute results.'), /Held in the expedition report/);
  assert.equal(hub.pendingLessons(p).length, 0);
  assert.equal(p.log.ofType('expedition_parked').filter(e => e.kind === 'lesson').length, 1);
  // Route 4: a check denial for an expedition agent leaves no note for the orchestrator; a plain worker's still does.
  const plain = hub.startWorker(p, 'plain', 'x', 'you', 'x');
  hub.noteCheck(p, 'denied', { agent: verifier, toolName: 'Bash', input: { command: 'rm x' } }, 'no');
  assert.equal(orch.notes?.length || 0, 0);
  hub.noteCheck(p, 'denied', { agent: plain, toolName: 'Bash', input: { command: 'rm x' } }, 'no');
  assert.equal(orch.notes.length, 1);
});

test('route 8: while paused an expedition request is denied with no card and no phone notice; a plain worker\'s is a card as before', async () => {
  const { env, ex } = fresh();
  const { hub, p, orch } = env;
  ex.ex.write('BRIEF.md', 'q'); ex.ex.write('test/CHECKLIST.md', '1'); ex.ex.start();
  const lead = ex.startRole('lead', orch.name);
  const builder = ex.startRole('builder', lead.name);
  const plain = hub.startWorker(p, 'plain', 'x', 'you', 'x');
  hub.setPaused(p, true, 'you');
  const r = await hub.requestApproval(p, builder, 'Bash', { command: 'npm run build' });
  assert.equal(r.behavior, 'deny');
  assert.match(r.message, /paused.*wait.*not parked/);
  assert.equal(hub.approvals.size, 0);
  const a = p.log.ofType('permission_answer').at(-1);
  assert.deepEqual([a.answer, a.reason, a.by, a.thread, a.expedition], ['deny', 'paused, wait', 'hub', builder.thread, ex.id]);
  assert.equal(p.log.ofType('approval').length, 0);
  await new Promise(r => setImmediate(r));
  assert.deepEqual([env.pushed.length, env.desk.length], [0, 0], 'no phone or PC notice');
  hub.requestApproval(p, plain, 'Bash', { command: 'npm run build' });
  assert.equal(p.log.ofType('approval').length, 1, 'a plain worker still gets its card');
  assert.equal(hub.approvals.size, 1);
});

// ---------- how it ran ----------
test('howItRan: per-role rows from the log, the Lead as "incl. gatherers", totals equal the usage handed out', () => {
  const { env, ex } = fresh();
  ex.run();
  const r = howItRan(env.p.log.events, ex.id);
  assert.deepEqual(r.rows.map(x => x.role), ['lead', 'advisor', 'synthesizer', 'skeptic', 'builder', 'verifier']);
  assert.equal(r.rows[0].label, LEAD_LABEL);
  assert.equal(LEAD_LABEL, 'Lead (incl. gatherers)');
  assert.ok(!r.rows.some(x => x.role === 'gatherer'), 'gatherers have no row of their own');
  assert.match(r.notes[0], /Gatherers run inside the Lead.*not split out/);
  for (const [role, cost] of Object.entries(ex.expected.byRole)) assert.ok(Math.abs(r.rows.find(x => x.role === role).costUSD - cost) < 1e-9, role);
  assert.ok(Math.abs(r.totals.costUSD - ex.expected.costUSD) < 1e-9);
  const lead = r.rows[0];
  assert.equal(lead.turns, 3);
  assert.equal(lead.tokens.input, 3000);
  assert.equal(lead.tokens.output, 1500);
  assert.equal(r.totals.turns, 8, 'three Lead results and one each for the other five');
  assert.equal(r.stopReason, 'passed');
  assert.deepEqual(r.loops, [{ number: 1, passing: 1, progress: true, tampered: false }, { number: 2, passing: 3, progress: true, tampered: false }]);
  assert.equal(r.decisions, 2);
  assert.equal(r.parked, 3, 'the Lead\'s one parked item and the two requests parked in phase 2; the lesson is counted apart');
  assert.equal(r.lessons, 1);
  assert.ok(r.elapsedMs >= 0);
  // The Markdown is section 7 of the report, with the Lead row and the note.
  const md = howItRanMarkdown(r);
  assert.match(md, /^## How it ran/);
  assert.match(md, /\| Lead \(incl\. gatherers\) \| 1 \| 3 \|/);
  assert.match(md, /\| \*\*Total\*\* \|/);
  assert.match(md, /Gatherers run inside the Lead/);
  assert.match(md, /Stop reason: passed/);
  assert.match(md, /1 \(1 passing\); 2 \(3 passing\)/);
  // Another expedition's events and plain usage are not mixed in.
  const other = howItRan([...env.p.log.events, { type: 'usage', ts: '2026-11-16T10:00:00Z', agent: 'x', expedition: 'other', expeditionRole: 'lead', models: { m: { input: 5, output: 5 } }, costUSD: 9 }], ex.id);
  assert.equal(other.totals.costUSD, r.totals.costUSD);
  assert.equal(howItRan([], 'none').rows.length, 0);
});

// ---------- the spec's acceptance: a dry run writes every file and every event ----------
test('a dry run with stub agents writes every file of the layout and every event kind, each with expedition: <id>', () => {
  const { env, ex } = fresh();
  ex.run();
  const x = ex.ex;
  assert.deepEqual(x.files(), ['BRIEF.md', 'DECISIONS.md', 'PLAN.md', 'REPORT.md', 'notes-1.md', 'notes-2.md', 'notes-3.md', 'skeptic.md', 'synthesis.md', 'test/CHECKLIST.md', 'test/run.json', 'verify/VERDICT.md']);
  assert.ok(existsSync(join(env.dir, '.crux', 'expeditions', ex.id, 'REPORT.md')));
  assert.match(x.read('REPORT.md'), /## How it ran/);
  assert.match(x.read('synthesis.md'), /Superseded by REPORT\.md where they differ/);
  // Every event kind, once at least, and all of them carry the id.
  const kinds = new Set(env.p.log.events.filter(e => e.expedition === ex.id).map(e => e.type));
  for (const k of EVENT_KINDS) assert.ok(kinds.has(k), `${k} was logged`);
  for (const e of env.p.log.events.filter(e => e.type.startsWith('expedition_'))) assert.equal(e.expedition, ex.id, e.type);
  for (const e of env.p.log.events.filter(e => e.type === 'usage' && e.expedition)) assert.ok(e.expeditionRole && e.agent.startsWith('exp-'), 'usage events carry the role');
  // The payloads the spec lists.
  const st = x.state();
  assert.match(st.started.briefHash, /^[0-9a-f]{64}$/);
  assert.equal(st.started.envelope.dollars, 5);
  assert.deepEqual(Object.keys(st.started.roles), Object.keys(ROLES));
  assert.deepEqual(st.started.planStart, { sevenDayPct: 12.3, resetsAt: '2026-11-20T00:00:00Z' });
  assert.equal(st.gate.verdict, 'approve with changes');
  assert.equal(st.gate.testHash, x.testHash(), 'the frozen hash is what test/ hashes to now');
  assert.equal(st.decisions.length, 2);
  assert.deepEqual(st.decisions.map(d => [d.number, d.maker]), [[1, 'exp-lead'], [2, 'exp-advisor']]);
  assert.equal(st.loops.length, 2);
  assert.equal(st.stopped.reason, 'passed');
  assert.deepEqual([...st.steps], ['report', 'commit', 'push', 'pr', 'card']);
  assert.equal(st.phase, 'stopped');
  // The hub agents: the Lead stays; the other five were retired at the end.
  assert.deepEqual(env.p.workers({ expedition: ex.id }).map(w => w.expeditionRole), ['lead']);
  // The state is rebuilt from the log alone: a new Expedition object over the same log reads the same.
  const again = new Expedition(env.p, ex.id).state();
  assert.deepEqual([again.phase, [...again.steps], again.decisions.length], [st.phase, [...st.steps], 2]);
});
