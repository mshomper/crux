// The hub: projects, their agents, and the routing between you, the orchestrator role and workers.
import { basename, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventLog } from './events.mjs';
import { Board } from './board.mjs';
import { DecisionsDesk } from './decisions-desk.mjs';
import { Agent } from './agent.mjs';
import { Memory, VISUAL_TYPES } from './memory.mjs';
import { Attachments, MAX_PER_MESSAGE } from './attachments.mjs';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { CommandPolicy } from './permissions.mjs';
import { classify, rulesEntry, touchesSecrets, defaultRules, connectorTool } from './permission-rules.mjs';
import { HubSettings } from './settings.mjs';
import { CommandSummary } from './summarize.mjs';
import { RETIRE_MESSAGE, SUCCESSOR_MESSAGE, RESUME_MESSAGE } from './prompts.mjs';
import { AgentTypes, EFFORTS, modelId, effortLevel, modelLabel } from './agent-types.mjs';
import { answerMessage, answerNote } from '../public/questions.js';
import { Usage } from './usage.mjs';
import { approvals, gitState, gitLines, realRun, unansweredQuestions, tidyUps, clip, INSTRUCTION_MAX, INDEX_LINES_MAX } from './handoff-facts.mjs';

export class Project {
  constructor(dir) {
    this.dir = resolve(dir);
    this.name = basename(this.dir);
    this.log = new EventLog(this.dir);
    // Decision 35: picks and drafts land in a standing worktree on docs/decisions, never in this folder.
    this.desk = new DecisionsDesk({ projectDir: this.dir });
    this.board = new Board(this.dir, this.log, { desk: this.desk });
    this.attachments = new Attachments(this.dir);
    this.agents = new Map();
    this.generation = 0;
  }
  workers() { return [...this.agents.values()].filter(a => a.role === 'worker' && a.state !== 'retired'); }
  // The holder of the role. One that is writing its handoff still holds it; one in the overlap has passed it on.
  orchestrator() { return [...this.agents.values()].find(a => a.role === 'orchestrator' && a.state !== 'retired' && a.retiring !== 'overlap') || null; }
}

const OVERLAP_MS = 10 * 60 * 1000, HANDOFF_MS = 5 * 60 * 1000, ANSWER_MS = 3 * 60 * 1000;
// A rolling handoff draft (handoff_notes in post_summary) counts as fresh when it was written within this long of
// the agent's last turn: then a handoff is published from it without waking the agent (a cold, cache-expired read).
export const DRAFT_FRESH_MS = 60 * 60 * 1000;
// How often the hub looks for an orchestrator that has sat idle past the idle window (decision 37).
const IDLE_CHECK_MS = 5 * 60 * 1000;
const hasNotes = n => !!n && ['in_flight', 'promises', 'risks', 'next_steps'].some(k => toList(n[k]).length);
const toList = x => (Array.isArray(x) ? x : x ? [x] : []).map(s => String(s).trim()).filter(Boolean);
const when = ts => new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
// After a restart (M014): how old an unfinished turn or unread message may be and still be resumed, and the gap
// between agents waking.
export const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000, RESUME_GAP_MS = 4000;

export class Hub {
  // defaults: { orchestrator: { type, model, effort }, worker: {...} } from ~/crux/hub.json (decision 20).
  // agentHome: the folder whose .claude/agents holds the all-projects types (your home folder).
  // settings: HubSettings (routePermissions, permissionTimeoutSec), from ~/.crux-hub/settings.json.
  // noAgents: a test hub; messages are logged but no real agent starts (see relaunch.mjs, testHubWithoutAgents).
  constructor({ projects, retireAt = 60, memory = new Memory(), defaults = {}, agentHome = homedir(), settings = new HubSettings(), noAgents = false }) {
    this.retireAt = retireAt;
    this.noAgents = !!noAgents;
    this.memory = memory;
    this.settings = settings;
    this.defaults = defaults || {};
    this.agentHome = agentHome;
    this.listeners = new Set();
    this.approvals = new Map();
    this.projects = new Map();
    this.bootAt = Date.now();   // "this session" in the usage panel: since the hub started
    this.usage = new Usage(this);
    this.run = realRun;   // git and gh for the handoff facts; tests swap in a fake
    for (const dir of projects) this.addProject(dir);
    this.idleTimer = setInterval(() => this.idleCheck(), IDLE_CHECK_MS);
    this.idleTimer.unref?.();
    this.usage.restore();
    // After listeners are attached: wake the agents a restart interrupted (M014), every project, a few seconds apart.
    this.resumed = [];
    setTimeout(() => {
      for (const p of this.projects.values()) this.rulesHint(p);
      this.resumeAll();
    }, 0);
  }

  // ---------- after a restart (M014) ----------
  // A message to an agent (from you, or the orchestrator's brief to a worker) that the agent never acted on
  // (no event from it since) most likely died with a restart. Within RESUME_WINDOW_MS it is delivered again.
  undelivered(p, now = Date.now()) {
    const evs = p.log.events;
    const out = [];
    const orchNames = new Set([...p.agents.values()].filter(a => a.role === 'orchestrator').map(a => a.name));
    for (const thread of new Set(evs.filter(e => e.type === 'message' && e.thread).map(e => e.thread))) {
      const agent = thread === 'orchestrator' ? p.orchestrator() : p.agents.get(thread);
      if (thread !== 'orchestrator' && (!agent || agent.state === 'retired')) continue;
      const names = thread === 'orchestrator' ? orchNames : new Set([agent.name]);
      // Messages into the thread: yours, or (in a worker's thread) the orchestrator's. A successor's question to
      // its predecessor is answered within the overlap, not resent.
      const incoming = e => e.type === 'message' && e.thread === thread && !names.has(e.from) && (e.from === 'you' || (thread !== 'orchestrator' && orchNames.has(e.from)));
      const i = evs.findLastIndex(incoming);
      const m = evs[i];
      if (!m || now - Date.parse(m.ts) > RESUME_WINDOW_MS) continue;
      // Starting up (agent_created, agent_session, agent_busy) is not acting on it; a reply, summary, card or pick is.
      const actedOn = evs.slice(i + 1).some(e => (e.type === 'pick' && m.from === 'you') || (!['agent_created', 'agent_session', 'agent_busy', 'notice', 'usage'].includes(e.type) && (names.has(e.from) || names.has(e.agent))));
      if (!actedOn) out.push(m);
    }
    return out;
  }

  // Who wakes after a restart, and why: an agent whose last logged turn had not ended (it was working when the hub
  // stopped), within RESUME_WINDOW_MS, or one with a message it never acted on. Resting agents stay asleep.
  // Workers come first, then the orchestrator, so their news reaches it.
  resumePlan(p, now = Date.now()) {
    const busy = new Map();
    for (const e of p.log.events) if (e.type === 'agent_busy') busy.set(e.agent, e);
    const plan = [];
    const messages = new Map(this.undelivered(p, now).map(m => [m.thread, m]));
    for (const a of p.agents.values()) {
      if (a.state === 'retired' || (a.role === 'orchestrator' && a !== p.orchestrator())) continue;
      const m = messages.get(a.thread);
      const b = busy.get(a.name);
      if (m) plan.push({ agent: a.name, thread: a.thread, why: 'message', message: m, wasWorking: !!b?.busy && Date.parse(b.ts) >= Date.parse(m.ts) });
      else if (b?.busy && now - Date.parse(b.ts) <= RESUME_WINDOW_MS) plan.push({ agent: a.name, thread: a.thread, why: 'working' });
      messages.delete(a.thread);
    }
    // A message of yours to the orchestrator role with no holder yet: the next holder takes it.
    const orphan = messages.get('orchestrator');
    if (orphan) plan.push({ agent: null, thread: 'orchestrator', why: 'message', message: orphan });
    return plan.sort((x, y) => (x.thread === 'orchestrator') - (y.thread === 'orchestrator'));
  }

  // Every project's plan, started RESUME_GAP_MS apart so a dozen agents do not all start at once.
  resumeAll(now = Date.now()) {
    const all = [...this.projects.values()].flatMap(p => this.resumePlan(p, now).map(r => ({ ...r, project: p.name })));
    this.resumed = all.map(({ project, agent, thread, why }) => ({ project, agent: agent || 'orchestrator', thread, why }));
    all.forEach((r, i) => {
      const t = setTimeout(() => this.resumeOne(this.project(r.project), r), i * RESUME_GAP_MS);
      t.unref?.();
    });
    // A turn marked unfinished but too old to resume is closed, so it is not picked up at a later start.
    for (const p of this.projects.values()) {
      const planned = new Set(all.filter(r => r.project === p.name).map(r => r.agent));
      const last = new Map();
      for (const e of p.log.events) if (e.type === 'agent_busy') last.set(e.agent, e);
      for (const [name, e] of last) if (e.busy && !planned.has(name)) { p.log.append('agent_busy', { agent: name, busy: false, stale: true }); const a = p.agents.get(name); if (a) a.busyLogged = false; }
    }
    return this.resumed;
  }

  // Only the unread messages, at once (used by tests and kept for callers of the older name).
  redeliver(p) { for (const r of this.resumePlan(p).filter(r => r.why === 'message')) this.resumeOne(p, r); }

  resumeOne(p, r) {
    try {
      if (r.why === 'message') {
        const m = r.message;
        const when = new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const whose = m.from === 'you' ? 'your message' : `the message from ${m.from}`;
        this.notice(p, m.thread, r.wasWorking
          ? `The hub restarted while ${r.agent} was working on ${whose} from ${when}, so it was sent again.`
          : `The hub restarted before ${whose} from ${when} reached its agent, so it was delivered again.`);
        const text = m.from === 'you' ? m.text : `[From the orchestrator, ${m.from}]\n${m.text}`;
        if (m.thread === 'orchestrator') this.ensureOrchestrator(p).send(text, m.attachments);
        else p.agents.get(m.thread)?.send(text, m.attachments);
      } else {
        const a = p.agents.get(r.agent);
        if (!a || a.state === 'retired' || a.live) return;
        this.notice(p, a.thread, `The hub restarted while ${a.name} was working; it was asked to carry on.`);
        a.send(RESUME_MESSAGE);
      }
    } catch (e) { this.notice(p, r.thread, `Could not resume after the restart: ${e.message}`); }
  }

  // ---------- plumbing ----------
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { for (const fn of this.listeners) fn(ev); }

  addProject(dir) {
    const p = new Project(dir);
    if (this.projects.has(p.name)) return this.projects.get(p.name);
    this.projects.set(p.name, p);
    this.restore(p);
    p.log.on(ev => this.emit({ ...ev, project: p.name, logged: true }));
    p.desk.notice = text => this.notice(p, 'orchestrator', text);
    if (this.noAgents) p.desk.local = true;   // a test hub never pushes decision records to the real GitHub
    return p;
  }

  project(name) {
    const p = this.projects.get(name);
    if (!p) throw new Error(`Unknown project ${name}`);
    return p;
  }

  // Rebuild agents from the log; none are running after a restart, they resume on their next message.
  restore(p) {
    for (const ev of p.log.events) {
      if (ev.type === 'agent_created') {
        p.agents.set(ev.agent, new Agent(this, p, { name: ev.agent, role: ev.role, task: ev.task, goal: ev.goal, generation: ev.generation, predecessor: ev.predecessor, handoffEntry: ev.handoffEntry, type: ev.agentType || null, model: ev.model || null, effort: ev.effort || null }));
        if (ev.role === 'orchestrator') p.generation = Math.max(p.generation, ev.generation);
      } else if (ev.type === 'agent_session' && p.agents.has(ev.agent)) {
        const a = p.agents.get(ev.agent);
        a.sessionId = ev.sessionId;
        if (ev.model) a.modelSeen = ev.model;
      } else if (ev.type === 'agent_settings' && p.agents.has(ev.agent)) {
        const a = p.agents.get(ev.agent);
        for (const k of ['model', 'effort']) if (k in ev) a[k] = ev[k] || null;
        if ('agentType' in ev) a.type = ev.agentType || null;
      } else if (ev.type === 'agent_retired' && p.agents.has(ev.agent)) {
        p.agents.get(ev.agent).state = 'retired';
      } else if (ev.type === 'agent_busy' && p.agents.has(ev.agent)) {
        p.agents.get(ev.agent).busyLogged = !!ev.busy;
        if (ev.contextPct != null) p.agents.get(ev.agent).contextPct = ev.contextPct;   // for the idle handoff after a restart
      }
    }
    // A handoff cut short by a restart: the overlap is over, so the predecessor is done.
    for (const a of p.agents.values()) a.questionsLeft = a.predecessor && p.agents.get(a.predecessor)?.state !== 'retired' ? 3 : 0;
  }

  notice(p, thread, text) { p.log.append('notice', { thread, text }); }

  // ---------- agents ----------
  createAgent(p, { name, role, task = '', goal = '', predecessor = null, handoffEntry = null, settings = {} }) {
    const s = this.resolveSettings(p, role, settings);   // checked before anything is written
    const generation = role === 'orchestrator' ? ++p.generation : 0;
    if (role === 'orchestrator') name = `orchestrator-${generation}`;
    let unique = name, n = 2;
    while (p.agents.has(unique)) unique = `${name}-${n++}`;
    const a = new Agent(this, p, { name: unique, role, task, goal, generation, predecessor, handoffEntry, ...s });
    p.agents.set(unique, a);
    p.log.append('agent_created', { agent: unique, role, task, goal, generation, predecessor, handoffEntry, thread: a.thread, agentType: s.type, model: s.model, effort: s.effort });
    return a;
  }

  // ---------- agent types, models and effort (decision 20) ----------
  agentTypes(p) { return new AgentTypes({ home: this.agentHome, projectDir: p.dir }); }

  // What an agent starts with. Explicit picks win; then its type's; then the role's defaults from hub.json;
  // anything left unset is Claude Code's own default. Throws on an unknown type or effort.
  // A type named only by hub.json, or inherited from a predecessor, is dropped quietly if its file is gone.
  resolveSettings(p, role, { type, model, effort, inherited = false } = {}) {
    const dflt = this.defaults[role] || {};
    const typeName = type === undefined ? dflt.type : type;
    const t = typeName ? this.agentTypes(p).get(typeName) : null;
    if (typeName && !t && type !== undefined && !inherited) {
      const names = this.agentTypes(p).list().map(x => x.name);
      throw new Error(`No agent type "${typeName}". ${names.length ? `Types: ${names.join(', ')}.` : 'No types are set up yet.'}`);
    }
    if (effort && !effortLevel(effort)) throw new Error(`Effort must be one of ${EFFORTS.join(', ')}.`);
    const pickModel = model !== undefined && model !== '' ? modelId(model) : undefined;
    const pickEffort = effort !== undefined && effort !== '' ? effortLevel(effort) : undefined;
    return {
      type: t?.name || null,
      model: pickModel !== undefined ? pickModel : t?.model || modelId(dflt.model) || null,
      effort: pickEffort !== undefined ? pickEffort : t?.effort || effortLevel(dflt.effort) || null
    };
  }

  // One line for people: "reviewer · Sonnet 5.5 · effort medium".
  describeSettings(a) {
    return [a.type, a.model || a.modelSeen ? modelLabel(a.model || a.modelSeen) : 'default model', a.effort ? `effort ${a.effort}` : 'default effort'].filter(Boolean).join(' · ');
  }

  // Change a running or resting agent. The model switches at once when the agent is live; effort too, through
  // Claude Code's live settings. A type change (new tools and instructions) needs a fresh start: at once if the
  // agent is resting, else as soon as it goes idle. It resumes the same conversation on its next message.
  async setAgentSettings(p, name, changes = {}, by = 'you') {
    const a = name === 'orchestrator' ? p.orchestrator() : p.agents.get(name);
    if (!a) throw new Error(`No agent called ${name}`);
    if (a.state === 'retired') throw new Error(`${name} has retired.`);
    const next = {};
    if ('type' in changes && (changes.type || null) !== a.type) {
      const t = changes.type ? this.agentTypes(p).get(changes.type) : null;
      if (changes.type && !t) throw new Error(`No agent type "${changes.type}".`);
      next.type = t?.name || null;
      // A new type brings its model and effort, unless those were picked in the same change.
      if (t && !('model' in changes) && t.model) next.model = t.model;
      if (t && !('effort' in changes) && t.effort) next.effort = t.effort;
    }
    if ('model' in changes) next.model = modelId(changes.model);
    if ('effort' in changes) {
      if (changes.effort && !effortLevel(changes.effort)) throw new Error(`Effort must be one of ${EFFORTS.join(', ')}.`);
      next.effort = effortLevel(changes.effort);
    }
    for (const k of Object.keys(next)) if (next[k] === a[k]) delete next[k];
    if (!Object.keys(next).length) return { changed: false, settings: this.describeSettings(a) };

    Object.assign(a, next);
    const ev = { agent: a.name, thread: a.thread, by };
    if ('type' in next) ev.agentType = next.type;
    if ('model' in next) ev.model = next.model;
    if ('effort' in next) ev.effort = next.effort;
    p.log.append('agent_settings', ev);

    let when = 'from its next start';
    if (a.live) {
      const live = 'type' in next ? false : await a.applyLive({ model: next.model, effort: next.effort });
      if (live) when = 'now';
      else if (a.state === 'idle' && !a.retiring && !a.capture) { a.close(); when = 'from its next message'; }
      else { a.restartWhenIdle = true; when = 'once it finishes what it is doing'; }
    }
    const line = `${by === 'you' ? 'You' : by} set ${a.name} to ${this.describeSettings(a)}; it applies ${when}.`;
    this.notice(p, a.thread, line);
    // The orchestrator's changes (set_agent_settings) are logged in its own thread too, for you to see in one place.
    if (by !== 'you' && a.thread !== 'orchestrator') this.notice(p, 'orchestrator', line);
    return { changed: true, settings: this.describeSettings(a), when };
  }

  ensureOrchestrator(p) {
    const cur = p.orchestrator();
    if (cur) return cur;
    const a = this.createAgent(p, { role: 'orchestrator' });
    this.notice(p, 'orchestrator', `${a.name} holds the orchestrator role${p.board.latestHandoff() ? ', starting from the latest handoff' : ''}.`);
    return a;
  }

  startWorker(p, name, task, by = 'you', goal = '', settings = {}) {
    if (!goal) goal = String(task).split('\n')[0].slice(0, 90);
    const w = this.createAgent(p, { name, role: 'worker', task, goal, settings });
    // The brief carries what the worker was started as, so the thread shows it from the first message.
    p.log.append('message', { thread: w.thread, from: by, text: task, agentType: w.type, model: w.model, effort: w.effort });
    w.send(task);
    return w;
  }

  // ---------- messages ----------
  // ids: attachment ids the page uploaded first (decision 23). The event keeps only id, type and size.
  // extra: more fields for the message event (answers: the summary questions it answers, from Needs you).
  fromYou(p, thread, text, ids = [], extra = {}) {
    if (ids.length > MAX_PER_MESSAGE) throw new Error(`Up to ${MAX_PER_MESSAGE} images per message.`);
    const attachments = ids.map(id => p.attachments.ref(id));
    const a = thread === 'orchestrator' ? null : p.agents.get(thread);
    if (thread !== 'orchestrator' && (!a || a.state === 'retired')) throw new Error(`No active agent ${thread}`);
    p.log.append('message', { thread, from: 'you', text, ...extra, ...(attachments.length ? { attachments } : {}) });
    (a || this.ensureOrchestrator(p)).send(text, attachments);
  }

  agentSaid(p, agent, text) {
    if (agent.capture) agent.capture.buf.push(text);
    p.log.append('message', { thread: agent.thread, from: agent.name, text });
  }

  orchestratorToWorker(p, orch, to, text) {
    const w = p.agents.get(to);
    if (!w || w.role !== 'worker' || w.state === 'retired') throw new Error(`No active worker ${to}`);
    p.log.append('message', { thread: w.thread, from: orch.name, text });
    w.send(`[From the orchestrator, ${orch.name}]\n${text}`);
  }

  postSummary(p, agent, s) {
    p.log.append('summary', { thread: agent.thread, from: agent.name, ...s });
    if (agent.role !== 'worker') return;
    const orch = p.orchestrator();
    if (!orch && !s.questions.length && !s.decisions_needed.length) return; // nothing to route; you see it in the thread
    const lines = [`[Summary from worker ${agent.name}]`];
    const sec = (label, xs) => xs?.length && lines.push(`${label}:\n${xs.map(x => '- ' + x).join('\n')}`);
    sec('Done', s.done); sec('Changed', s.changed); sec('Questions', s.questions); sec('Blocked on', s.blocked_on);
    if (s.decisions_needed.length) lines.push(`Decisions waiting on {{who}}: ${s.decisions_needed.map(n => 'D' + String(n).padStart(4, '0')).join(', ')}`);
    if (s.next_step) lines.push(`Proposed next step: ${s.next_step}`);
    this.ensureOrchestrator(p).send(lines.join('\n'));
  }

  // ---------- questions from round summaries (M010) ----------
  askedIn(p, id) {
    const ev = p.log.events.find(e => e.id === id && e.type === 'summary' && e.questions?.length);
    if (!ev) throw new Error('That question is no longer here.');
    return ev;
  }

  // Dismiss on a question card, or on one question in it (index): it leaves Needs you, and no phone notification
  // goes out for it. The agent is not told; its summary stays in its thread. No thread, so nothing turns unread.
  dismissQuestion(p, id, by = 'you', index = null) {
    const ev = this.askedIn(p, id);
    const i = index == null || index === '' ? null : Number(index);
    if (i !== null && !(Number.isInteger(i) && i >= 0 && i < ev.questions.length)) throw new Error('No such question in that card.');
    const same = e => e.type === 'question_dismissed' && e.question === id && (e.index ?? null) === i;
    if (!p.log.events.some(same)) p.log.append('question_dismissed', { question: id, ...(i === null ? {} : { index: i }), asker: ev.from, by });
    return { ok: true };
  }

  // Answers typed in Needs you: one message to the asking agent's thread, each question quoted with its answer.
  // The message names the questions it answers, so those leave Needs you and the rest of the card stays.
  answerQuestions(p, id, answers = []) {
    const ev = this.askedIn(p, id);
    const items = (Array.isArray(answers) ? answers : [])
      .map(a => ({ index: Number(a?.index), answer: String(a?.text ?? '').trim() }))
      .filter(a => a.answer && Number.isInteger(a.index) && a.index >= 0 && a.index < ev.questions.length);
    if (!items.length) throw new Error('Type an answer first.');
    const pairs = items.map(a => ({ question: ev.questions[a.index], answer: a.answer }));
    this.fromYou(p, ev.thread, answerMessage(pairs), [], { answers: items.map(a => ({ question: id, index: a.index })) });
    // A worker's questions: one line in the orchestrator thread, and a note the orchestrator reads with its next
    // message, so it knows they are answered and does not ask again. It is not woken just for this. The
    // orchestrator's own questions skip this: the answer already goes to its thread.
    if (p.agents.get(ev.from)?.role === 'worker') {
      this.notice(p, 'orchestrator', answerNote('You', ev.from, pairs));
      p.orchestrator()?.noteForNextTurn(`[Hub note] ${answerNote('{{Who}}', ev.from, pairs)}. ${ev.from} has the answers; these questions are settled, so don't ask them again.`);
    }
    return { ok: true, thread: ev.thread, answered: items.map(a => a.index) };
  }

  // ---------- memory layers (decisions 13 and 15) ----------
  proposeLesson(p, agent, scope, lesson) {
    if (scope === 'project') {
      const pack = this.memory.addProjectLesson(p.name, lesson, agent.name);
      p.log.append('lesson', { thread: agent.thread, from: agent.name, pack, text: lesson });
      return `Added to the ${pack} pack.`;
    }
    p.log.append('lesson_proposed', { thread: agent.thread, from: agent.name, lesson: randomUUID(), text: lesson });
    return 'Queued for {{who}} to approve; it joins the core profile once they do.';
  }

  pendingLessons(p) {
    const done = new Set(p.log.ofType('lesson_result').map(e => e.lesson));
    return p.log.ofType('lesson_proposed').filter(e => !done.has(e.lesson));
  }

  answerLessons(p, ids, accept) {
    const pending = this.pendingLessons(p).filter(e => ids.includes(e.lesson));
    for (const e of pending) {
      if (accept) this.memory.addCoreLesson(e.text, e.from);
      p.log.append('lesson_result', { lesson: e.lesson, accepted: !!accept, thread: e.thread });
    }
    return pending.length;
  }

  // PNG, JPEG, GIF and WebP screenshots go to the project's attachments store, like pasted images (decision 23);
  // SVG and HTML pages stay in the media folder, where the server can sandbox them.
  postVisual(p, agent, path, caption) {
    const ext = extname(String(path)).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext) && existsSync(path) && statSync(path).isFile()) {
      if (statSync(path).size > 8 * 1024 * 1024) throw new Error('Visuals must be under 8 MB');
      const attachment = p.attachments.save(readFileSync(path), 'That visual');
      return p.log.append('visual', { thread: agent.thread, from: agent.name, visual: attachment.id, kind: 'image', attachment, caption });
    }
    if (!VISUAL_TYPES[ext]) throw new Error(`Visuals must be one of ${Object.keys(VISUAL_TYPES).join(', ')}`);
    const { file, kind } = this.memory.storeVisual(p.name, path);
    return p.log.append('visual', { thread: agent.thread, from: agent.name, visual: file, kind, caption });
  }

  readProfile(p, agent, section, reason) {
    if (section === 'private') {
      if (!reason) return 'Say why the task needs the private section (reason), then ask again.';
      this.notice(p, agent.thread, `${agent.name} read your private notes: ${reason}`);
    }
    return this.memory.readSection(section, p.name) || `Nothing in "${section}". Sections: core, pack, conventions, private, ${this.memory.packs().map(n => 'pack:' + n).join(', ')}.`;
  }

  // ---------- decisions ----------
  pick(p, id, choice, reason = '') {
    const d = p.board.pick(id, choice, reason);
    const label = d.chosen ? `${d.chosen}: ${d.options.find(o => o.key === d.chosen)?.name}` : d.status;
    p.log.append('pick', { decision: d.id, choice: d.chosen || d.status, title: d.title, label, reason, thread: 'orchestrator' });
    return { d, label };
  }

  pickMany(p, picks) {
    const done = picks.map(({ id, choice, reason }) => this.pick(p, id, choice, reason));
    const lines = done.map(({ d, label }) => `D${String(d.id).padStart(4, '0')} ${d.title}: picked ${label}${d.reason ? '. Reason: ' + d.reason : ''}`);
    const orch = p.orchestrator();
    if (orch?.live) orch.send(`{{Who}} made these calls:\n${lines.join('\n')}\nCarry on with them.`);
    else for (const w of p.workers().filter(w => w.live)) w.send(`{{Who}} made these calls:\n${lines.join('\n')}`);
    return done.map(x => x.d);
  }

  // ---------- approvals (tool permission prompts become cards) ----------
  // Settled without a card or the orchestrator (R003): reading, searching and read-only commands, for any path,
  // except secrets and your private notes; the orchestrator writing decision records and running the Crux build.
  // Refused without a card: the orchestrator editing anything else.
  autoAnswer(p, agent, toolName, input) {
    const norm = s => String(s || '').replace(/\\/g, '/').toLowerCase();
    const file = norm(input.file_path || input.path || input.notebook_path);
    const privateNotes = norm(join(this.memory.profileDir, 'private.md'));
    const readsPrivate = (file && file === privateNotes) || /private\.md/i.test(String(input.command || input.pattern || ''));
    if (['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'].includes(toolName) && !readsPrivate && !touchesSecrets(toolName, input)) return { behavior: 'allow', updatedInput: input };
    // Decision 35: the orchestrator writes records in the decisions worktree, never in the main folder's .decisions.
    const records = p.desk.usable() ? p.desk.decisionsDir : join(p.dir, '.decisions');
    const decisions = norm(records) + '/';
    if (['Write', 'Edit', 'MultiEdit'].includes(toolName) && agent.role === 'orchestrator') {
      if (file.startsWith(decisions)) { p.desk.usable() && p.desk.ensure(); return { behavior: 'allow', updatedInput: input }; }
      return file.startsWith(norm(join(p.dir, '.decisions')) + '/')
        ? { behavior: 'deny', message: `Decision records go in the decisions worktree, not the main folder: write it as ${join(records, file.split('/').pop())}. The hub commits it to the docs/decisions branch when your turn ends.` }
        : { behavior: 'deny', message: `The orchestrator only writes Crux decision records (${records}). Send other file changes to a worker with message_agent or start_worker.` };
    }
    const cmd = String(input.command || '').trim();
    if (/^(Bash|PowerShell)$/.test(toolName) && /^node\s+("[^"]*[\\/]crux[\\/]scripts[\\/](build|rollup)\.mjs"|\S*[\\/]crux[\\/]scripts[\\/](build|rollup)\.mjs)(\s+("[^"]*"|[\w.\\/:-]+))?$/.test(cmd)) {
      return { behavior: 'allow', updatedInput: input };
    }
    // Commands that only read (listing, git status and diff, versions) run without a card.
    if (/^(Bash|PowerShell)$/.test(toolName) && CommandPolicy.readOnly(toolName, cmd) && !readsPrivate && !touchesSecrets(toolName, input)) return { behavior: 'allow', updatedInput: input };
    return null;
  }

  // Decision 21 A: a worker's request goes to the orchestrator first, unless the hub's own matcher finds a hard stop
  // in the permission rules (or cannot read it), routing is off, there is no rules entry, or no orchestrator is
  // running. Then it is a card for you, as before. If the orchestrator escalates or does not answer in time, too.
  requestApproval(p, agent, toolName, input, { signal, title, description, suggestions } = {}) {
    const auto = this.autoAnswer(p, agent, toolName, input);
    if (auto) return Promise.resolve(auto);
    const route = this.routeFor(p, agent, toolName, input);
    if (route.logged) {
      const i = input || {};
      p.log.append('permission_answer', { thread: 'orchestrator', approval: null, worker: agent.name, workerThread: agent.thread, tool: toolName, command: String(i.command || i.file_path || i.url || JSON.stringify(i)).slice(0, 400), answer: 'allow', reason: `Auto mode, its own request: not fully readable (${route.logged.join('; ')}), no hard stop in it`, by: 'hub' });
    }
    if (route.allow) return Promise.resolve({ behavior: 'allow', updatedInput: input });   // auto mode, contained (decision 34)
    return new Promise(resolvePromise => {
      const id = randomUUID();
      const always = CommandPolicy.alwaysRules(toolName, input, suggestions);
      const finish = (result, how) => {
        const a = this.approvals.get(id);
        if (!a) return;
        clearTimeout(a.timer);
        this.approvals.delete(id);
        p.log.append('approval_result', { thread: agent.thread, approval: id, how });
        resolvePromise(result);
      };
      const entry = { p, agent, toolName, input, finish, always, routedTo: route.to, escalated: false };
      this.approvals.set(id, entry);
      p.log.append('approval', { thread: agent.thread, approval: id, agent: agent.name, tool: toolName, input, title: title || null, description: description || null, always: always ? CommandPolicy.describe(always) : null, summary: CommandSummary.of(toolName, input), routedTo: route.to, stops: route.stops, rules: route.rules });
      signal?.addEventListener('abort', () => finish({ behavior: 'deny', message: 'Cancelled' }, 'cancelled'));
      if (route.to) {
        entry.timer = setTimeout(() => this.escalate(id, `No answer within ${this.timeoutLabel()}`, 'hub'), this.settings.get('permissionTimeoutSec') * 1000);
        entry.timer?.unref?.();   // the server keeps the process alive; a waiting request alone should not
        try { p.agents.get(route.to).send(this.permissionMessage(p, p.agents.get(route.to), id, agent, toolName, input, route.rules, route.unsure)); }
        catch (e) { this.escalate(id, `Could not reach the orchestrator: ${e.message}`, 'hub'); }
      }
    });
  }

  // Where a request goes: { allow } in auto mode for contained work; else { to: orchestrator name | null,
  // stops: [why it comes to you], rules: entry id | null }. Hard stops always come to you.
  // Auto mode (decision 34, R004): only requests the hub cannot classify go to the orchestrator.
  // Standard mode (decision 21): everything that is not a hard stop goes to the orchestrator.
  routeFor(p, agent, toolName, input) {
    const rules = this.rulesFor(p);
    agent.tempDirs ||= new Set();
    const { route, reasons, unsure, tempMade } = classify({ tool: toolName, input, projectDir: p.dir, agent: agent.name, madeTemp: agent.tempDirs });
    for (const d of tempMade) agent.tempDirs.add(d);   // temp folders it makes are its own to delete later (R005)
    if (route === 'human') return { to: null, stops: reasons, rules: rules?.entryId || null };
    if (route === 'allow' && this.permissionMode(p) === 'auto') return { allow: true };
    // The orchestrator's own unclear requests have no one to route to: in auto mode, with no hard stop in them,
    // they are allowed and logged in its thread for Matt to audit.
    // Never a connector or any other MCP server's tool (plugin servers can reach mail and calendar too): the
    // orchestrator's own requests for those come to Matt as a card.
    if (route === 'unsure' && agent.role === 'orchestrator' && this.permissionMode(p) === 'auto' && !connectorTool(toolName) && !/^mcp__(?!crux__)/.test(toolName)) return { allow: true, logged: unsure };
    if (agent.role !== 'worker') return { to: null, stops: [], rules: null };
    if (!this.settings.get('routePermissions') || !rules) return { to: null, stops: [], rules: rules?.entryId || null };
    // A resting orchestrator (asleep since a restart, or between turns) is woken by the request, so the card does not
    // jump to your phone just because it was asleep. It still comes to you on escalate or after the timeout.
    const orch = p.orchestrator();
    if (!orch || orch.retiring || ['error', 'retired'].includes(orch.state)) return { to: null, stops: [], rules: rules.entryId };
    return { to: orch.name, stops: [], rules: rules.entryId, unsure };
  }

  // Per project: "auto" or "standard" (shown as Auto and Ask). The switch in the page, kept in hub settings by project
  // folder, wins; then the repo's committed .crux-hub.json ({ "permissions": "auto" }) as the starting value; else standard.
  permissionMode(p) {
    const set = this.settings.project?.(p.dir)?.permissionMode;
    if (set) return set === 'auto' ? 'auto' : 'standard';
    try { return JSON.parse(readFileSync(join(p.dir, '.crux-hub.json'), 'utf8')).permissions === 'auto' ? 'auto' : 'standard'; } catch { return 'standard'; }
  }

  setPermissionMode(p, mode, by = 'you') {
    mode = mode === 'auto' ? 'auto' : 'standard';
    const was = this.permissionMode(p);
    this.settings.setProject(p.dir, { permissionMode: mode });
    if (mode === was) return mode;
    p.log.append('project_settings', { permissionMode: mode, by, thread: 'orchestrator' });
    this.notice(p, 'orchestrator', mode === 'auto'
      ? `${by === 'you' ? 'You' : by} switched ${p.name} to Auto: work that stays in the project or a temp folder runs without asking; unclear requests go to the orchestrator, hard stops to you.`
      : `${by === 'you' ? 'You' : by} switched ${p.name} to Ask: anything beyond reading goes to the orchestrator first, hard stops to you.`);
    if (mode === 'auto') this.rulesHint(p);
    return mode;
  }

  // Matt's claude.ai connectors in this project's agents: off unless turned on. The switch in the page wins; then the
  // repo's .crux-hub.json ({ "connectors": true }); else off.
  connectorsOn(p) {
    const set = this.settings.project?.(p.dir)?.connectors;
    if (typeof set === 'boolean') return set;
    try { return JSON.parse(readFileSync(join(p.dir, '.crux-hub.json'), 'utf8')).connectors === true; } catch { return false; }
  }

  // Agents pick the change up on their next start: at once if resting, else when they finish what they are doing.
  setConnectors(p, on, by = 'you') {
    on = !!on;
    const was = this.connectorsOn(p);
    this.settings.setProject(p.dir, { connectors: on });
    if (on === was) return on;
    p.log.append('project_settings', { connectors: on, by, thread: 'orchestrator' });
    for (const a of p.agents.values()) {
      if (!a.live || a.state === 'retired') continue;
      if (a.state === 'idle' && !a.retiring && !a.capture) a.close(); else a.restartWhenIdle = true;
    }
    this.notice(p, 'orchestrator', on
      ? `${by === 'you' ? 'You' : by} turned connectors on for ${p.name}: agents here can see your mail, calendar and drive tools. Reads go to the orchestrator; sends, shares, changes and deletes always come to you.`
      : `${by === 'you' ? 'You' : by} turned connectors off for ${p.name}: agents here no longer load your mail, calendar or drive tools.`);
    return on;
  }

  // The rules the orchestrator answers under: the board's entry; in Auto mode with no entry, the hub's built-in
  // defaults (R005's text with this project's folders); in Ask mode with no entry, none (everything comes to you).
  rulesFor(p) {
    return rulesEntry(p.board) || (this.permissionMode(p) === 'auto' ? defaultRules(p.dir) : null);
  }

  // Once per project: in Auto with no rules entry, suggest the orchestrator draft one for Matt.
  rulesHint(p) {
    if (rulesEntry(p.board) || this.permissionMode(p) !== 'auto' || p.log.ofType('rules_hint').length) return false;
    p.log.append('rules_hint', { thread: 'orchestrator' });
    this.notice(p, 'orchestrator', `${p.name} has no permission rules entry on its board, so the orchestrator answers unclear requests under the hub's built-in defaults (the crux rules, with this project's folders). Orchestrator: draft a rules entry for {{who}} to approve.`);
    return true;
  }

  timeoutLabel() { const s = this.settings.get('permissionTimeoutSec'); return s % 60 ? `${s} seconds` : `${s / 60} minute${s === 60 ? '' : 's'}`; }

  // What the orchestrator gets: the request id, the worker and its goal, the tool and its full input, and the rules.
  // The rules text is in its instructions; it is repeated here only when the board's rules changed since it started.
  permissionMessage(p, orch, id, worker, toolName, input, rulesId, unsure = []) {
    const rules = this.rulesFor(p);
    const changed = rules && orch.rulesSeen !== `${rules.entryId}@${rules.ts}`;
    const shown = toolName === 'Bash' || toolName === 'PowerShell' ? `Command:\n${input.command}${input.description ? `\nIts description: ${input.description}` : ''}` : `Input:\n${JSON.stringify(input, null, 1)}`;
    return [
      `[Permission request ${id}]`,
      `Worker: ${worker.name}`,
      `Worker's goal: ${worker.goal || String(worker.task || '').split('\n')[0].slice(0, 200) || '(none given)'}`,
      `Tool: ${toolName}`,
      shown,
      unsure?.length ? `The hub found no hard stop, but could not classify it: ${unsure.join('; ')}.` : 'The hub found no hard stop in it.',
      rules?.isDefault ? 'This project\'s board has no permission rules entry, so you are working from the hub\'s built-in defaults (in your instructions).' : '',
      `Decide under ${rulesId}: call answer_permission with request_id "${id}", answer allow, deny or escalate, and a one-line reason. Do it now, with no other text; after ${this.timeoutLabel()} it goes to {{who}}.`,
      changed ? `\nThe rules changed since you started. Current rules (${rules.entryId}):\n${rules.body}` : ''
    ].join('\n');
  }

  // The orchestrator's answer. Logged in its thread as one line, for you to audit.
  answerPermission(p, orch, id, answer, reason = '') {
    const a = this.approvals.get(id);
    if (!a || a.p !== p) return 'That request is no longer waiting (answered by {{who}}, timed out, or cancelled).';
    if (!a.routedTo || a.escalated) return 'That request is already with {{who}}.';
    reason = String(reason || '').trim();
    if (!reason) return 'Give a one-line reason, then answer again.';
    if (answer === 'escalate') { this.escalate(id, reason, orch.name); return 'Sent to {{who}}.'; }
    this.logAnswer(a, id, answer === 'allow' ? 'allow' : 'deny', reason, orch.name);
    a.finish(answer === 'allow'
      ? { behavior: 'allow', updatedInput: a.input }
      : { behavior: 'deny', message: `The orchestrator (${orch.name}) declined: ${reason}` },
      answer === 'allow' ? `allowed by ${orch.name}` : `denied by ${orch.name}`);
    return answer === 'allow' ? 'Allowed.' : 'Denied; the worker sees your reason.';
  }

  logAnswer(a, id, answer, reason, by) {
    const i = a.input || {};
    a.p.log.append('permission_answer', { thread: 'orchestrator', approval: id, worker: a.agent.name, workerThread: a.agent.thread, tool: a.toolName, command: String(i.command || i.file_path || i.notebook_path || i.url || i.query || JSON.stringify(i)).slice(0, 400), answer, reason, by });
  }

  // The card comes to you: escalated by the orchestrator, timed out, or routing switched off. It buzzes your phone.
  escalate(id, reason, by) {
    const a = this.approvals.get(id);
    if (!a || !a.routedTo || a.escalated) return;
    clearTimeout(a.timer);
    a.escalated = true;
    this.logAnswer(a, id, by === 'hub' ? 'timeout' : 'escalate', reason, by);
    a.p.log.append('approval_escalated', { thread: a.agent.thread, approval: id, agent: a.agent.name, tool: a.toolName, reason, by });
  }

  // The off switch: everything comes to you. Requests already with the orchestrator come to you at once.
  setRouting(on, by = 'you') {
    const was = this.settings.get('routePermissions');
    this.settings.set({ routePermissions: !!on });
    if (was === !!on) return this.settings.all();
    for (const [id, a] of this.approvals) if (!on && a.routedTo && !a.escalated) this.escalate(id, 'Routing to the orchestrator was switched off', by);
    for (const p of this.projects.values()) {
      this.notice(p, 'orchestrator', on ? 'The orchestrator answers workers\' permission requests again, within the board\'s rules; hard stops still come to you.' : 'Every permission request now comes to you; the orchestrator no longer answers them.');
    }
    return this.settings.all();
  }

  // "Always" saves Claude Code's own suggested rule to the project's .claude/settings.local.json, where you can review or remove it.
  // You can answer a request that is still with the orchestrator; that overrides it, and the line in its thread says so.
  answerApproval(id, allow, note, always = false) {
    const a = this.approvals.get(id);
    if (!a) throw new Error('That approval is no longer waiting (the agent may have restarted).');
    if (always && !a.always) throw new Error('This one can only be allowed once.');
    if (always) this.notice(a.p, a.agent.thread, `Saved to this project's Claude Code settings (.claude/settings.local.json): always allow ${CommandPolicy.describe(a.always).join('; ')}`);
    if (a.routedTo && !a.escalated) this.logAnswer(a, id, allow ? 'allow' : 'deny', note || 'Answered before the orchestrator did', 'you');
    a.finish(allow
      ? { behavior: 'allow', updatedInput: a.input, ...(always ? { updatedPermissions: a.always } : {}) }
      : { behavior: 'deny', message: note || this.memory.personalize('{{Who}} declined this.') },
      allow ? (always ? 'always allowed' : 'allowed') : 'denied');
  }

  // ---------- handoffs (decisions 10 and 16) ----------
  // An agent retires in three steps: it writes the judgement half of a handoff (the hub adds the facts),
  // a successor starts and may ask it up to three questions, then it retires. Workers follow the same rule.
  onIdle(p, agent) {
    if (agent.capture) { // it just answered a successor's question
      const { buf, res } = agent.capture;
      agent.capture = null;
      res(buf.join('\n').trim() || '(No answer.)');
      return;
    }
    if (agent.retiring === 'writing') {
      if (agent.leftHandoff || agent.nudged) return this.startSuccessor(p, agent);
      agent.nudged = true;
      agent.send('The handoff is not written yet. Call write_handoff now, filling every heading ("none" where empty).');
      return;
    }
    if (agent.retiring === 'overlap') return;
    // Decision 35: drafts the orchestrator wrote into the decisions worktree are committed and pushed now.
    if (agent.role === 'orchestrator') {
      try { p.desk.commitPending(`Record drafts from ${agent.name}`); }
      catch (e) { this.notice(p, 'orchestrator', `Could not commit the decision drafts: ${e.message.split('\n')[0]}`); }
    }
    if (agent.predecessor && !agent.tookOver) { // the successor's first turn is over: the overlap ends
      agent.tookOver = true;
      const old = p.agents.get(agent.predecessor);
      if (old?.retiring) this.finishRetire(p, old);
    }
    if (agent.restartWhenIdle) {   // settings that need a fresh start (decision 20); it resumes on its next message
      agent.restartWhenIdle = false;
      agent.close();
    }
    if (agent.contextPct != null && agent.contextPct >= this.retireAt) {
      this.notice(p, agent.thread, `${agent.name} is at ${agent.contextPct}% of its context; handing ${agent.role === 'orchestrator' ? 'the role' : 'its task'} on.`);
      this.retire(p, agent, { reason: 'threshold' });
    }
  }

  // reason: 'asked' (you, or the API), 'threshold' (decision 10) or 'idle' (decision 37).
  // With a fresh rolling draft and the agent not mid-turn, the hub publishes the handoff from the draft plus fresh
  // facts without waking it. An idle handoff then retires it at once: no successor and no overlap until the next
  // message, which starts a fresh holder from the handoff. Otherwise the agent writes the handoff as before.
  // Returns 'draft', 'writing' or 'none' (it never started).
  retire(p, agent = p.orchestrator(), { reason = 'asked' } = {}) {
    if (typeof agent === 'string') agent = p.agents.get(agent);
    if (!agent || agent.state === 'retired') throw new Error('No active agent to retire');
    if (agent.retiring) return agent.retiring;
    agent.retiring = 'writing';
    if (!agent.sessionId) { this.finishRetire(p, agent); return 'none'; } // never started; nothing to hand off
    const draft = !['working', 'starting'].includes(agent.state) && this.freshDraft(p, agent);
    if (draft) {
      this.publishHandoff(p, agent, draft.handoff_notes, { draft });
      // Idle, or resting past the cache window: questions to it would cost a cold read, so it retires now and the
      // next message starts a fresh holder. A worker's task needs a successor to carry on, so it always gets one.
      const idle = agent.role === 'orchestrator' && (reason === 'idle' || Date.now() - this.lastActive(p, agent) >= DRAFT_FRESH_MS);
      this.notice(p, agent.thread, `${agent.name}'s handoff ${agent.leftHandoff} was written from its rolling draft (${when(draft.ts)}) plus fresh facts, without waking it.${idle ? ' The next orchestrator starts from it with your next message.' : ''}`);
      if (idle) this.finishRetire(p, agent);
      else this.startSuccessor(p, agent);
      return 'draft';
    }
    agent.send(RETIRE_MESSAGE(agent.role));
    agent.retireTimer = setTimeout(() => { if (agent.retiring === 'writing') this.startSuccessor(p, agent); }, HANDOFF_MS);
    return 'writing';
  }

  // ---------- rolling handoff draft and the idle handoff (decision 37) ----------
  // The newest handoff_notes this agent gave with a round summary.
  draftFor(p, agent) { return p.log.ofType('summary').filter(e => e.from === agent.name && hasNotes(e.handoff_notes)).at(-1) || null; }

  // When the agent last did anything: now if it is mid-turn, else the end of its last turn (or its start).
  lastActive(p, agent, now = Date.now()) {
    if (['working', 'starting'].includes(agent.state)) return now;
    const e = p.log.events.findLast(e => e.type === 'agent_busy' && e.agent === agent.name) || p.log.events.find(e => e.type === 'agent_created' && e.agent === agent.name);
    return e ? Date.parse(e.ts) : now;
  }

  // Fresh: written within DRAFT_FRESH_MS of the agent's last turn, so nothing much can have happened since.
  freshDraft(p, agent) {
    const d = this.draftFor(p, agent);
    return d && this.lastActive(p, agent) - Date.parse(d.ts) <= DRAFT_FRESH_MS ? d : null;
  }

  // Decision 37 B: an orchestrator idle for the idle window (minutes) above the floor (percent of context) hands off,
  // so the next message reaches a fresh holder instead of a cold re-read of a long context. Both are hub settings.
  idleCheck(now = Date.now()) {
    const windowMin = Number(this.settings.get('idleHandoffMin')), floor = Number(this.settings.get('idleFloorPct'));
    if (!(windowMin > 0)) return [];
    const done = [];
    for (const p of this.projects.values()) {
      const o = p.orchestrator();
      if (!o || o.retiring || o.capture || !o.sessionId || ['working', 'starting', 'error'].includes(o.state)) continue;
      if (o.contextPct == null || o.contextPct < floor) continue;
      if ([...this.approvals.values()].some(a => a.routedTo === o.name && !a.escalated)) continue;
      const idleMin = Math.floor((now - this.lastActive(p, o, now)) / 60000);
      if (idleMin < windowMin) continue;
      this.notice(p, 'orchestrator', `${o.name} has been idle for ${idleMin} minutes at ${o.contextPct}% of its context, so it hands the role on (decision 37).`);
      try { this.retire(p, o, { reason: 'idle' }); done.push(p.name); }
      catch (e) { this.notice(p, 'orchestrator', `The idle handoff failed: ${e.message}`); }
    }
    return done;
  }

  // The facts half: what the hub knows for certain. The same shape for orchestrators and workers (decision 16):
  // your approvals and instructions, the work and its last instructions, git, open questions, tidy-ups.
  handoffFacts(p, agent) {
    const evs = p.log.events;
    const lines = [];
    const summaries = evs.filter(e => e.type === 'summary');
    const orchNames = new Set([...p.agents.values()].filter(a => a.role === 'orchestrator').map(a => a.name));
    const lastSummary = a => summaries.filter(e => e.from === a.name).at(-1);
    const lastInstruction = (w, max) => {
      const m = evs.findLast(e => e.type === 'message' && e.thread === w.thread && orchNames.has(e.from));
      return m ? `Last instruction from ${m.from} (${when(m.ts)}): "${clip(m.text, max)}"` : 'No instruction from the orchestrator yet.';
    };
    const prev = agent.role === 'orchestrator' ? p.board.latestHandoff() : (agent.handoffEntry ? p.board.read(agent.handoffEntry) : null);
    const since = prev ? Date.parse(prev.ts) : 0;
    // Approvals the orchestrator noted itself (post_summary approvals).
    const tagged = summaries.filter(e => e.thread === 'orchestrator' && Date.parse(e.ts) >= since)
      .flatMap(e => toList(e.approvals).map(text => ({ ts: e.ts, text, by: e.from })));
    const fmtSummary = s => [`done ${toList(s.done).join('; ') || 'nothing'}`, `changed ${toList(s.changed).join(', ') || 'nothing'}`,
      toList(s.questions).length && `asked ${toList(s.questions).join(' | ')}`, toList(s.blocked_on).length && `blocked on ${toList(s.blocked_on).join('; ')}`,
      s.next_step && `next ${s.next_step}`].filter(Boolean).join('; ');

    let a;
    if (agent.role === 'worker') {
      lines.push(`Task goal: ${agent.goal || '(none given)'}`);
      const s = lastSummary(agent);
      lines.push(s ? `Last summary (${when(s.ts)}): ${fmtSummary(s)}` : 'No summary posted yet.');
      lines.push(lastInstruction(agent, 600));
      a = approvals(evs, { since, threads: [agent.thread], mention: agent.name.replace(/-\d+$/, ''), tagged: tagged.filter(t => t.text.includes(agent.name.replace(/-\d+$/, ''))) });
    } else {
      a = approvals(evs, { since, tagged });
    }
    lines.push(`Standing approvals and instructions from {{who}} (${prev ? `since handoff ${prev.entryId}` : 'all so far'}; whole, oldest first):`);
    lines.push(...(a.kept.length ? a.kept.map(x => `- [${when(x.ts)}${x.answer ? ', answered in Needs you' : ''}${x.thread !== 'orchestrator' ? `, in ${x.thread}'s thread` : ''}${x.noted ? `, noted by ${x.noted}` : ''}] ${x.text}`) : ['- none']));
    if (a.dropped) lines.push(`- (${a.dropped} older ones not shown; read the thread if needed.)`);
    if (prev) lines.push(`- (Earlier ones are in handoff ${prev.entryId}.)`);

    if (agent.role === 'orchestrator') {
      const ws = p.workers().filter(w => w !== agent);
      lines.push('Workers:', ...(ws.length ? ws.map(w => {
        const s = lastSummary(w);
        return `- ${w.name} (${w.state}): ${w.goal || w.task.slice(0, 80)}. ${s ? `Last summary (${when(s.ts)}): ${clip(s.next_step || toList(s.done)[0] || 'posted', 300)}` : 'No summary yet'}. ${lastInstruction(w, INSTRUCTION_MAX)}`;
      }) : ['- none']));
    }

    lines.push(...gitLines(this.gitState(p), { summaries: summaries.filter(e => !orchNames.has(e.from)), events: evs, tagged }));

    const status = id => p.board.decision(id)?.status;
    const qs = unansweredQuestions(evs, { thread: agent.thread, decisionStatus: status });
    lines.push(`Questions still waiting on {{who}}:`, ...(qs.length ? qs.map(q => `- ${q}`) : ['- none']));

    if (agent.role === 'orchestrator') {
      const open = p.board.decisions().filter(d => ['open', 'found'].includes(d.status));
      lines.push('Decisions waiting on {{who}}:', ...(open.length ? open.map(d => `- D${String(d.id).padStart(4, '0')} ${d.title}${d.recommended ? ` (recommended ${d.recommended})` : ''}`) : ['- none']));
      const cards = [...this.approvals.values()].filter(x => x.p === p);
      if (cards.length) lines.push('Permission cards waiting:', ...cards.map(x => `- ${x.agent.name} wants ${x.toolName}${x.routedTo && !x.escalated ? ` (with ${x.routedTo})` : ''}`));
      const lessons = this.pendingLessons(p);
      if (lessons.length) lines.push('Profile lessons waiting for {{who}}:', ...lessons.map(e => `- ${e.text}`));
      const tidy = tidyUps(p.board, evs);
      if (tidy.length) lines.push(`Suggested tidy-ups (memos that look done or superseded; retire them only with {{who}}'s OK):`, ...tidy.map(t => `- ${t.id} ${t.title}. ${t.why}`));
      const n = p.board.index().split('\n').length;
      if (n > INDEX_LINES_MAX) lines.push(`Board index: ${n} lines, over ${INDEX_LINES_MAX}. Propose a tidy to {{who}} (retire done memos, merge old ones).`);
    }
    return lines.join('\n');
  }

  // Git state for the facts, from the project folder. Never throws: what it cannot read, it says.
  gitState(p) {
    try { return gitState(p.dir, this.run); }
    catch (e) { return { worktrees: [], prs: null, main: null, errors: [`git state unreadable (${e.message})`] }; }
  }

  writeHandoff(p, agent, j) {
    if (agent.retiring !== 'writing') return 'You are not retiring, so no handoff is needed.';
    if (agent.leftHandoff) return `Handoff ${agent.leftHandoff} is already written. Reply "done".`;
    const ev = this.publishHandoff(p, agent, j);
    return `Handoff ${ev.entryId} posted. Reply "done" and stop.`;
  }

  // The handoff entry: judgement (written now, or taken from the rolling draft) plus the facts.
  publishHandoff(p, agent, j = {}, { draft = null, stale = false } = {}) {
    const sec = (title, xs) => `### ${title}\n${toList(xs).map(x => `- ${x}`).join('\n') || '- none'}`;
    const note = draft ? `_Written by the hub from ${agent.name}'s ${stale ? 'last' : 'rolling'} handoff draft of ${when(draft.ts)}, plus fresh facts${stale ? '; the agent did not write a new one' : '; the agent was not woken'}._` : '';
    const body = [
      note, sec('In flight, and why', j.in_flight), sec('Promises to {{who}}', j.promises),
      sec('Risks and things easy to miss', j.risks), sec('Next steps', j.next_steps),
      `### Facts (from the hub)\n${this.handoffFacts(p, agent)}`
    ].filter(Boolean).join('\n\n').replaceAll('{{who}}', this.memory.userName() || 'the user');
    const ev = p.board.addEntry({ kind: 'handoff', title: `Handoff from ${agent.name}`, summary: toList(j.next_steps)[0] || 'handoff', body, from: agent.name, role: agent.role, ...(draft ? { fromDraft: draft.id } : {}) });
    agent.leftHandoff = ev.entryId;
    for (const r of j.retire_entries || []) p.board.retireEntry(r.id, r.why, agent.name);
    for (const l of toList(j.promote_to_core).filter(x => x.toLowerCase() !== 'none')) this.proposeLesson(p, agent, 'core', l);
    return ev;
  }

  startSuccessor(p, old) {
    if (old.retiring !== 'writing') return;
    clearTimeout(old.retireTimer);
    if (!old.leftHandoff) {   // it did not write one in time: its last draft if any, else a note saying so
      const d = this.draftFor(p, old);
      this.publishHandoff(p, old, d ? d.handoff_notes : { in_flight: ['(The agent did not write its part of the handoff.)'] }, { draft: d, stale: !!d });
    }
    old.retiring = 'overlap';
    const entryId = old.leftHandoff;
    // The successor keeps its predecessor's type, model and effort.
    const settings = { type: old.type, model: old.model, effort: old.effort, inherited: true };
    const succ = old.role === 'orchestrator'
      ? this.createAgent(p, { role: 'orchestrator', predecessor: old.name, handoffEntry: entryId, settings })
      : this.createAgent(p, { name: old.name.replace(/-\d+$/, ''), role: 'worker', task: old.task, goal: old.goal, predecessor: old.name, handoffEntry: entryId, settings });
    this.notice(p, old.thread, `${old.name} left handoff ${entryId}; ${succ.name} takes over${old.role === 'worker' ? ` in its own thread` : ''}.`);
    if (old.role === 'worker') this.notice(p, succ.thread, `${succ.name} continues the work of ${old.name}, from handoff ${entryId}.`);
    succ.send(SUCCESSOR_MESSAGE(old.role, old.name, entryId));
    old.overlapTimer = setTimeout(() => this.finishRetire(p, old), OVERLAP_MS);
  }

  async askPredecessor(p, succ, question) {
    const old = p.agents.get(succ.predecessor);
    if (succ.questionsLeft <= 0) return 'No questions left. Use the handoff and the board.';
    if (!old || old.retiring !== 'overlap') return `${succ.predecessor} has already retired. Use the handoff and the board.`;
    succ.questionsLeft--;
    p.log.append('message', { thread: old.thread, from: succ.name, text: question });
    const answer = await new Promise(res => {
      old.capture = { buf: [], res };
      old.send(`[Question from ${succ.name}, who took over from you] ${question}\nAnswer in a few sentences.`);
      setTimeout(() => { if (old.capture?.res === res) { old.capture = null; res('(No answer within three minutes.)'); } }, ANSWER_MS);
    });
    p.log.append('handoff_qa', { entryId: succ.handoffEntry, from: succ.name, q: question, a: answer, thread: succ.thread });
    if (succ.questionsLeft === 0) this.finishRetire(p, old);
    return answer;
  }

  // A worker whose job is finished: retire it with no handoff and no successor. You or the orchestrator can do this.
  retireFinished(p, name, by = 'you', reason = '') {
    const a = p.agents.get(name);
    if (!a || a.role !== 'worker') throw new Error(`No worker called ${name}`);
    if (a.state === 'retired') return `${name} has already retired.`;
    if (a.retiring) return `${name} is already handing off.`;
    if ([...this.approvals.values()].some(x => x.agent === a)) return `${name} is waiting on a permission card; answer or deny it first.`;
    this.finishRetire(p, a);
    this.notice(p, a.thread, `${by === 'you' ? 'You' : by} retired ${name} as finished${reason ? `: ${reason}` : ''}.`);
    return `${name} retired.`;
  }

  finishRetire(p, agent) {
    clearTimeout(agent.retireTimer); clearTimeout(agent.overlapTimer);
    if (agent.state === 'retired') return;
    agent.capture?.res('(Retired before answering.)');
    agent.capture = null;
    agent.retiring = false;
    for (const [id, a] of this.approvals) if (a.routedTo === agent.name) this.escalate(id, `${agent.name} retired before answering`, 'hub');
    agent.close();
    agent.setState('retired');
    p.log.append('agent_retired', { agent: agent.name, thread: agent.thread });
    this.notice(p, agent.thread, `${agent.name} retired${agent.leftHandoff ? ` after handoff ${agent.leftHandoff}` : ''}.${agent.role === 'orchestrator' && !agent.leftHandoff ? ' The next orchestrator starts when there is something to do.' : ''}`);
  }

  // ---------- views ----------
  state() {
    return [...this.projects.values()].map(p => ({
      name: p.name, dir: p.dir,
      agents: [...p.agents.values()].map(a => ({ name: a.name, role: a.role, thread: a.thread, state: a.state, task: a.task, goal: a.goal, contextPct: a.contextPct, live: a.live, retiring: a.retiring || false, predecessor: a.predecessor, type: a.type, model: a.model, effort: a.effort, modelSeen: a.modelSeen, restartPending: a.restartWhenIdle })),
      types: this.agentTypes(p).list().map(({ name, description, model, effort, tools, source }) => ({ name, description, model, effort, tools, source })),
      events: p.log.events,
      board: p.board.snapshot(),
      pack: this.memory.packName(p.name),
      pendingApprovals: [...this.approvals.entries()].filter(([, a]) => a.p === p).map(([id]) => id),
      permissionRules: this.rulesFor(p)?.entryId || null,
      permissionMode: this.permissionMode(p),
      connectors: this.connectorsOn(p)
    }));
  }
}
