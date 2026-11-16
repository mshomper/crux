// A stub expedition for the Expedition module's tests (decisions 68 to 72). It plays all seven roles on a test hub: it
// starts the Lead and the five other hub agents through the real hub code, writes every file of the layout, appends
// every event kind, and gives each agent fake usage through the real Agent.logUsage. No Claude Code process starts.
//
// The invariant test (expedition-invariant.test.mjs) and the dry run (expedition.test.mjs) use it, and every later phase
// reruns the invariant test with it: extend run() when a phase adds a step, and the invariant still has to hold.
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp } from './tmp.mjs';
import { Agent } from '../../lib/agent.mjs';
import { Hub } from '../../lib/hub.mjs';
import { Memory } from '../../lib/memory.mjs';
import { HubSettings } from '../../lib/settings.mjs';
import { Push, cardsFor } from '../../lib/push.mjs';
import { openQuestions } from '../../public/questions.js';
import { Expedition, ROLES } from '../../lib/expedition.mjs';
import { howItRan, howItRanMarkdown } from '../../lib/expedition-report.mjs';

const STARTER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'agent-types', 'starter');
export const MODEL = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-2' };

// Every message an agent is sent, as [agent name, text]. Agents are stubbed: nothing starts. Call once per test file.
export function recordAgents() {
  const sent = [];
  Agent.prototype.send = function (t) { sent.push([this.name, t]); this.state = 'working'; };
  Agent.prototype.close = function () { this.q = null; };
  return sent;
}

// A test hub with one project, the seven expedition types installed as the hub's agent types (copied from the starter
// folder, so the real files are what the stub uses), an orchestrator, and a recording notifier: the phone and the PC
// both subscribe, and every notice either would show lands in `pushed` and `desk`.
export function stubHub({ settings = {} } = {}) {
  const root = makeTmp('crux-expedition-');
  const dir = join(root, 'proj');
  const home = join(root, 'agents-home');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
  for (const f of readdirSync(STARTER).filter(f => /^expedition-.*\.md$/.test(f))) copyFileSync(join(STARTER, f), join(home, '.claude', 'agents', f));
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), agentHome: home, noAgents: true, settings: new HubSettings({ file: null, initial: settings }) });
  const p = hub.project('proj');
  const orch = hub.ensureOrchestrator(p);
  const pushed = [], desk = [];
  const sender = { generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }), sendNotification: async (_s, body) => { pushed.push(JSON.parse(body)); } };
  const push = new Push({ dir: join(root, 'data'), sender, timers: { setTimeout() { }, clearTimeout() { } }, log: () => { } });
  push.subscribe({ endpoint: 'https://push.example/phone', keys: { p256dh: 'k', auth: 'a' } }, 'iPhone');
  push.desktopAttach('pc', (event, data) => desk.push([event, data.card]));
  push.desktopPresence('pc', { idleMs: 1000, locked: false });
  // As in server.mjs: every logged event goes to the push side, with the live approvals.
  hub.on(ev => { if (ev.logged) push.handle(ev, { approvals: hub.approvals, decisionOpen: () => true, decisionStatus: () => 'open', events: () => p.log.events, decisions: () => [] }); });
  return { hub, p, orch, root, dir, pushed, desk, push };
}

// The invariant (plan 2a), as a check any phase can rerun on any stub: what an expedition must not have caused so far.
// mark: quietMark(env) taken before the expedition started. sent: recordAgents()'s list. Returns the list of problems
// in plain words; empty means quiet. A new route that leaks makes this non-empty, so the invariant test fails.
export function quietMark({ p, orch }) { return { threadEvents: p.log.events.filter(e => e.thread === 'orchestrator').length, sent: 0, orch: orch.name }; }
export function quietProblems(env, mark, sent) {
  const { hub, p, orch, pushed, desk } = env;
  const bad = [];
  const got = sent.filter(([name]) => name === orch.name);
  if (got.length) bad.push(`the orchestrator was sent ${got.length} message(s): ${got.map(([, t]) => String(t).split('\n')[0]).join(' | ')}`);
  if (orch.notes?.length) bad.push(`the orchestrator was left ${orch.notes.length} note(s) for its next turn: ${orch.notes[0]}`);
  const inThread = p.log.events.filter(e => e.thread === 'orchestrator').length - mark.threadEvents;
  if (inThread) bad.push(`${inThread} event(s) were logged in the orchestrator's thread`);
  if (hub.approvals.size) bad.push(`${hub.approvals.size} permission card(s) are open`);
  const kinds = p.log.events.filter(e => ['approval', 'approval_escalated', 'lesson_proposed'].includes(e.type)).map(e => e.type);
  if (kinds.length) bad.push(`card events were logged: ${kinds.join(', ')}`);
  const asks = p.log.events.filter(e => e.type === 'summary' && ((e.questions?.length || 0) + (e.decisions_needed?.length || 0)));
  if (asks.length) bad.push(`${asks.length} summary(ies) carry questions or decisions, so they are cards`);
  if (openQuestions(p.log.events, {}).length) bad.push('Needs you holds an open question');
  if (hub.pendingLessons(p).length) bad.push('a lesson waits for the user');
  const cards = p.log.events.flatMap(e => cardsFor({ ...e, project: p.name }, { decisionOpen: () => true }).map(c => `${e.type}:${c.kind}`));
  if (cards.length) bad.push(`events would raise notices: ${cards.join(', ')}`);
  if (pushed.length) bad.push(`${pushed.length} phone notice(s) were pushed`);
  if (desk.length) bad.push(`${desk.length} PC notice(s) were shown`);
  return bad;
}

const summary = (over = {}) =>({ done: [], changed: [], questions: [], decisions_needed: [], blocked_on: [], next_step: '', visuals: [], approvals: [], open_questions: [], ...over });

export class StubExpedition {
  constructor({ hub, p, orch }, { question = 'Which of two JSON libraries is faster for X?' } = {}) {
    Object.assign(this, { hub, p, orch });
    this.id = Expedition.makeId(question, { date: new Date(2026, 10, 16) });
    this.ex = new Expedition(p, this.id).init();
    this.agents = {};          // role -> agent
    this.expected = { costUSD: 0, byRole: {} };   // the fake usage this stub handed out, to compare with howItRan
    this.cumulative = new Map();
    this.question = question;
  }

  // Start a hub agent for a role, as the Lead's start_worker would (the orchestrator starts the Lead).
  startRole(role, by) {
    const r = ROLES[role];
    const w = this.hub.startWorker(this.p, `exp-${role}`, `Your role: ${r.label}. Expedition ${this.id}.`, by, `${r.label} of ${this.id}`, { type: r.type, expedition: this.id, expeditionRole: role });
    this.agents[role] = w;
    return w;
  }

  // One result with fake usage, through the real Agent.logUsage. modelUsage is cumulative per query, as the SDK's is.
  usage(role, { input = 1000, output = 500, cost = 0.05 } = {}) {
    const a = this.agents[role];
    const model = a.model || MODEL.sonnet;
    const c = this.cumulative.get(a.name) || { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 };
    c.inputTokens += input; c.outputTokens += output; c.costUSD += cost;
    this.cumulative.set(a.name, c);
    a.logUsage({ modelUsage: { [model]: { ...c } } });
    this.expected.costUSD += cost;
    this.expected.byRole[role] = (this.expected.byRole[role] || 0) + cost;
  }

  // The whole life up to the point where the final summary is due. Returns nothing; the log, the files and the agents
  // hold the result. mid: a Lead round summary and member summaries with questions, decisions and a core lesson, all
  // of which must stay out of the orchestrator's and the user's hands.
  run() {
    const { hub, p, ex, orch } = this;
    // Launch: the brief and the success test (checklist and a runnable command), then the start event and the Lead.
    ex.write('BRIEF.md', `# ${this.question}\nEnvelope: 6 h, 7%.\n`);
    ex.write('test/CHECKLIST.md', '1. A comparison table exists (judged by reading it).\n2. The benchmark runs (judged by running it).\n');
    ex.write('test/run.json', JSON.stringify({ command: 'node bench.mjs', cwd: '.', timeout: 60 }));
    ex.start({ envelope: { dollars: 5 }, planStart: { sevenDayPct: 12.3, resetsAt: '2026-11-20T00:00:00Z' } });
    const lead = this.startRole('lead', orch.name);
    this.usage('lead');
    // Plan, then the plan gate: the Advisor reviews once, the test is amended and frozen.
    ex.write('PLAN.md', '# Plan\n- sub-questions: speed, size, licence\n- build target: a two-library benchmark\n');
    this.startRole('advisor', lead.name);
    ex.write('test/CHECKLIST.md', '1. A comparison table exists (judged by reading it).\n2. The benchmark runs (judged by running it).\n3. Results are tied to a reference (judged by reading the table).\n');
    ex.gate({ verdict: 'approve with changes', amendments: ['3. Results are tied to a reference'] });
    ex.decide({ text: 'Use the 1 MB sample file', reason: 'it is inside the brief', maker: lead.name });
    ex.decide({ text: 'Keep item 3 in the test', reason: 'the reference ties the numbers down', maker: this.agents.advisor.name });
    this.usage('advisor', { cost: 0.4 });
    // Gatherers are subagents inside the Lead: three run in parallel, one note file each, no hub agent of their own.
    for (const n of [1, 2, 3]) { ex.subagent({ phase: 'started', subagentType: ROLES.gatherer.type, taskId: `t${n}` }); ex.write(`notes-${n}.md`, `# Notes ${n}\n- claim | source | link (opened)\nGaps: none\n`); }
    for (const n of [1, 2, 3]) ex.subagent({ phase: 'ended', subagentType: ROLES.gatherer.type, taskId: `t${n}`, tokens: 1200 * n });
    this.usage('lead', { cost: 0.3 });
    // Builder starts once the approach is fixed; Synthesizer and Skeptic follow the notes.
    this.startRole('builder', lead.name);
    this.startRole('synthesizer', lead.name);
    ex.write('synthesis.md', '# Synthesis\nSuperseded by REPORT.md where they differ.\n');
    this.usage('synthesizer', { cost: 0.2 });
    this.startRole('skeptic', lead.name);
    ex.write('skeptic.md', '# Objections\n1. The sample is small.\n');
    this.usage('skeptic', { cost: 0.15 });
    this.usage('builder', { cost: 0.25 });
    this.startRole('verifier', lead.name);
    // Everything an agent could say that would normally reach the orchestrator or the user: questions, decision
    // numbers and a core lesson. Members' summaries go to the Lead; the Lead's own stay in its thread until the end.
    for (const role of ['advisor', 'synthesizer', 'skeptic', 'builder', 'verifier']) {
      hub.postSummary(p, this.agents[role], summary({ done: [`${role} finished a round`], questions: [`Should ${role} widen the scope?`], decisions_needed: [7], next_step: 'wait' }));
    }
    hub.proposeLesson(p, this.agents.builder, 'core', 'Always say which result came from a software GPU.');
    hub.postSummary(p, lead, summary({ done: ['A round of the plan'], questions: ['Matt: is 1 MB fine?'], decisions_needed: [8] }));
    // Build-verify loops: the second makes progress; the test passes.
    ex.loop({ number: 1, passing: 1, progress: true });
    ex.write('verify/VERDICT.md', '# Verdict\n1 PASS, 2 PARTIAL, 3 PASS\n');
    this.usage('verifier', { cost: 0.5 });
    ex.loop({ number: 2, passing: 3, progress: true });
    ex.note('90%', { atPct: 90 });
    ex.park({ text: 'Compare a third library', reason: 'outside the brief', maker: lead.name });
    this.usage('lead', { cost: 0.2 });
    // Stop (the watchdog does this in phase 3), retire everyone but the Lead, then the end steps up to the card.
    ex.stop({ reason: 'passed', totals: { costUSD: this.expected.costUSD } });
    for (const role of ['advisor', 'synthesizer', 'skeptic', 'builder', 'verifier']) hub.retireFinished(p, this.agents[role].name, 'hub', 'expedition ended');
    ex.write('REPORT.md', `# Report\n\n${howItRanMarkdown(howItRan(p.log.events, this.id))}\n`);
    for (const step of ['report', 'commit', 'push', 'pr', 'card']) ex.step(step, step === 'card' ? { title: `Expedition finished: ${this.question}` } : {});
    return this;
  }

  // The Lead's one post_summary to the orchestrator, once the card step is logged.
  finalSummary() {
    return this.hub.postSummary(this.p, this.agents.lead, summary({ done: ['Report written, branch pushed, draft PR opened'], next_step: 'Read the report' }));
  }
}
