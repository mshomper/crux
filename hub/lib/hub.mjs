// The hub: projects, their agents, and the routing between you, the orchestrator role and workers.
import { basename, resolve, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventLog } from './events.mjs';
import { Board } from './board.mjs';
import { DecisionsDesk } from './decisions-desk.mjs';
import { Agent, cleanEnv as checkEnv } from './agent.mjs';
import { Memory, VISUAL_TYPES } from './memory.mjs';
import { checkDollars } from './setup.mjs';
import { Attachments, MAX_PER_MESSAGE } from './attachments.mjs';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { extname } from 'node:path';
import { CommandPolicy } from './permissions.mjs';
import { classify, rulesEntry, touchesSecrets, defaultRules, connectorTool, frozenWrite, expeditionFolderWrite } from './permission-rules.mjs';
import { normalizeOverlay, parseHttpsUrl } from './permission-lists.mjs';
import { PermissionLists, suggest as suggestList, downloadsFrom, quarantineMarks, validPackage, pipName, ECOSYSTEMS } from './permission-lists.mjs';
import { HubSettings, HANDOFF_NUMBERS, CHECK_MODES, OUTSIDE_MODES, projectKey } from './settings.mjs';
import { CommandSummary } from './summarize.mjs';
import { RETIRE_MESSAGE, SUCCESSOR_MESSAGE, RESUME_MESSAGE } from './prompts.mjs';
import { AgentTypes, EFFORTS, EffortCeilings, modelId, effortLevel, modelLabel } from './agent-types.mjs';
import { answerMessage, answerNote, QUESTION_RULES } from '../public/questions.js';
import { family as familyOf } from '../public/models.js';
import { findPass, passFor, PASS_MS } from './merge-pass.mjs';
import { Usage, FABLE_NOTE } from './usage.mjs';
import { PermissionCheck, CHECK_NAME, CHECK_MODEL, sdkCall, apiCall, scriptTexts } from './permission-check.mjs';
import { scriptsFor, parseCommand, changedDiff } from './permission-scripts.mjs';
import { totalsOf, sumCost } from '../public/usage.js';
import { summariseDue, SUMMARY_MODEL } from './month-summaries.mjs';
import { Offload } from './offload.mjs';
import { approvals, gitState, gitLines, realRun, unansweredQuestions, tidyUps, clip, INSTRUCTION_MAX, INDEX_LINES_MAX } from './handoff-facts.mjs';
import { Conductor, CONDUCTOR, CONDUCTOR_ROLE, briefText } from './conductor.mjs';
import { ExpeditionWatchdog, HUB_STOPS as EXPEDITION_HUB_STOPS } from './expedition-watchdog.mjs';
import { Expedition, ROLES as EXPEDITION_ROLES, HUB_ROLES as EXPEDITION_HUB_ROLES, GATHERER_LIMIT, GATHERER_TYPE, GATHERER_ROUND1, GATHERER_RUNS, gathererRule, DEFAULT_ENVELOPE, runJsonProblem, ID_PATTERN as EXPEDITION_ID, defaultRoles as expeditionDefaultRoles, roleOfType as expeditionRoleOfType } from './expedition.mjs';
import { ExpeditionEnd } from './expedition-end.mjs';
import { pageEvents, olderPage, waitingOf, agentsFor, partsOf, diffParts } from './feed.mjs';
import { isProposal, proposalsOf } from './expedition-report.mjs';
import { profileView, createProfile, SYSTEM as IMPORT_SYSTEM, buildUser as importUser, parseBatch, looksCut, TOO_LONG, countsOf, countsLine, applyBatch, BatchStore, IMPORT_CAP, IMPORT_MODEL } from './profile.mjs';
import { dataDir } from './relaunch.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

export class Project {
  // repair: false reads the log and changes nothing in .crux (a test hub on a real folder; the rotation off switch).
  constructor(dir, { repair = true } = {}) {
    this.dir = resolve(dir);
    this.name = basename(this.dir);
    this.log = new EventLog(this.dir, { repair });
    // Decision 35: picks and drafts land in a standing worktree on docs/decisions, never in this folder.
    this.desk = new DecisionsDesk({ projectDir: this.dir });
    this.board = new Board(this.dir, this.log, { desk: this.desk });
    this.attachments = new Attachments(this.dir);
    this.agents = new Map();
    this.generation = 0;
  }
  // Expedition agents (the Expedition module) report to their Lead, not to the orchestrator, so every list that
  // feeds the orchestrator leaves them out. A caller that wants them asks: { expedition: id } for one expedition's
  // agents, { all: true } for every worker (the pause reaches them too).
  workers({ expedition = null, all = false } = {}) {
    return [...this.agents.values()].filter(a => a.role === 'worker' && a.state !== 'retired' && (all || (expedition ? a.expedition === expedition : !a.expedition)));
  }
  // The holder of the role. One that is writing its handoff still holds it; one in the overlap has passed it on.
  orchestrator() { return [...this.agents.values()].find(a => a.role === 'orchestrator' && a.state !== 'retired' && a.retiring !== 'overlap') || null; }
}

// Routing guide 9.5: is a settings change a raise or a lower? A change of model decides (haiku < sonnet < opus < fable);
// with the same model, the effort decides (no effort set counts as medium). Null when neither moved up or down.
export const OUTCOMES = ['done', 'partial', 'blocked'];
const MODEL_RANK ={ haiku: 0, sonnet: 1, opus: 2, fable: 3 };
export function settingsDirection(from, to) {
  const rank = m => MODEL_RANK[familyOf(m)];
  const a = rank(from.model), b = rank(to.model);
  if (a != null && b != null && a !== b) return b > a ? 'raise' : 'lower';
  const e = x => (x ? EFFORTS.indexOf(x) : EFFORTS.indexOf('medium'));
  if (e(from.effort) === e(to.effort)) return null;
  return e(to.effort) > e(from.effort) ? 'raise' : 'lower';
}

// An expedition agent's plain write to a Claude Code settings file (.claude/settings.json, settings.local.json): never allowed
// (spec lesson 9: a subagent once created a stray scheduled task). A first line, not a guarantee; phase 4 widens the path rules.
const SETTINGS_FILE = /(^|\/)\.claude\/settings[^/]*\.json$/i;
export function writesSettingsFile(toolName, input) {
  if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return false;
  return SETTINGS_FILE.test(String(input?.file_path || input?.notebook_path || input?.path || '').replace(/\\/g, '/'));
}

// Decision 66: what the pause says to a request's card, and to the agents (hub.setPaused).
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PAUSE_STOP = 'Work in this project is paused: every new request waits for {{who}}.';
const PAUSE_TO_WORKERS = '[From the hub] {{Who}} paused work in this project. Finish the step you are on, then stop: start nothing new and wait here until you are told to carry on. Any permission request you make now waits for {{who}}.';
const RESUME_TO_WORKERS = '[From the hub] {{Who}} resumed work in this project. Carry on with your task.';
const PAUSE_TO_ORCH = '[From the hub] {{Who}} paused work in this project. Workers were told to stop at their next turn and every new permission request waits for {{who}}. Do not start new work or answer requests as a way of pausing it; wait for {{who}} to resume.';
const RESUME_TO_ORCH = '[From the hub] {{Who}} resumed work in this project. Workers were told to carry on.';
const OVERLAP_MS = 10 * 60 * 1000, HANDOFF_MS = 5 * 60 * 1000, ANSWER_MS = 3 * 60 * 1000, RETIRE_RESULT_WAIT_MS = 2 * 60 * 1000;
// A rolling handoff draft (handoff_notes in post_summary) counts as fresh when it was written within this long of
// the agent's last turn: then a handoff is published from it without waking the agent (a cold, cache-expired read).
export const DRAFT_FRESH_MS = 60 * 60 * 1000;
// How often the hub looks for an orchestrator that has sat idle past the idle window (decision 37).
const IDLE_CHECK_MS = 5 * 60 * 1000;
const DEFAULT_WORKER_TYPE = 'implementer';   // the routing guide's default worker (decision 65)
const hasNotes = n => !!n && ['in_flight', 'promises', 'risks', 'next_steps'].some(k => toList(n[k]).length);
const toList = x => (Array.isArray(x) ? x : x ? [x] : []).map(s => String(s).trim()).filter(Boolean);
const when = ts => new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
// After a restart (M014): how old an unfinished turn or unread message may be and still be resumed, and the gap
// between agents waking.
export const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000, RESUME_GAP_MS = 4000;
const EXPEDITION_IDLE_MS = 24 * 3600e3;   // an expedition with no event for this long no longer blocks a log rotation
export const ROTATE_FIRST_MS = 60 * 1000;   // the first log rotation, this long after start

// A10: what a request could add to Matt's lists (the "Always allow" offers on its card and audit line), as an event field.
const listable = (tool, input) => { const l = suggestList(tool, input); return l.length ? { listable: l } : {}; };

export class Hub {
  // defaults: { orchestrator: { type, model, effort }, worker: {...} } from ~/crux/hub.json (decision 20).
  // agentHome: the folder whose .claude/agents holds the all-projects types (your home folder).
  // settings: HubSettings (routePermissions, permissionTimeoutSec, the handoff defaults, and per project the level,
  // connectors and handoff numbers), from ~/.crux-hub/settings.json. The --retire-at start flag is only its
  // starting value for retireAt (server.mjs); a change in the page wins (decision 44 B).
  // noAgents: a test hub; messages are logged but no real agent starts (see relaunch.mjs, testHubWithoutAgents).
  // conductorDir: where the Conductor (decision 55) keeps its log and handoffs, in the hub's own state folder
  // (server.mjs: <data>/conductor). Null: no Conductor (tests that do not ask for one).
  // checker: the one-shot permission check (decision 66, lib/permission-check.mjs); tests pass one with a stubbed model.
  // Left out, it is made on first use: the Agent SDK on this machine's sign-in, or the API when a key is set up.
  constructor({ projects, memory = new Memory(), defaults = {}, agentHome = homedir(), settings = new HubSettings(), noAgents = false, conductorDir = null, checker = null, expeditionWatch = {}, rotateLogs = !noAgents, summariser = null, profileCall = null, batches = null, promptFile = null, offload = null }) {
    this.noAgents = !!noAgents;
    // Decision 79 A: the profile import. profileCall is the one model call with no tools that sorts an export (made on first
    // use; tests pass a fake). The proposed text waits in the hub's data folder until it is accepted or cancelled.
    this.profileCall = profileCall;
    this.batches = batches || new BatchStore();
    this.promptFile = promptFile || join(dataDir(), 'profile-prompt.json');
    // The API key the hub itself calls with (the permission check, the month summaries): the environment's, or the saved one
    // the server hands over (decision 78 A). A saved key is never put in the environment the agents inherit: they get
    // apiKeyHelper instead, a command Claude Code runs to read it when it needs it.
    this.apiKey = () => (process.env.CRUX_HUB_USE_API_KEY === '1' ? process.env.ANTHROPIC_API_KEY || '' : '');
    this.apiKeyHelper = null;
    this.keyProblem = '';   // set when Claude Code says it is not using the helper's key (noteKeySource); shown on the Account card
    // Decision 74 B: old events move to the archive when a log is due. Never on a test hub (it may be looking at a real
    // folder another hub is writing), unless a test asks; CRUX_HUB_NO_ROTATE=1 turns it off, recovery included.
    this.rotatesLogs = rotateLogs !== false && process.env.CRUX_HUB_NO_ROTATE !== '1';
    // Months older than six months get a short summary per thread from a small model, on the rotation timer. Off with the
    // rotation, or on its own with CRUX_HUB_NO_SUMMARIES=1. A test hub makes no model call unless a test passes a summariser.
    this.summariserMade = summariser;
    this.summarisesMonths = this.rotatesLogs && process.env.CRUX_HUB_NO_SUMMARIES !== '1' && (!!summariser || !noAgents);
    this.summarising = null;
    this.summaryFailures = new Map();   // month -> failures this run; after two it is left alone until a restart
    this.checkerMade = checker;
    this.checkGit = null;   // how the Auto script gate asks git whether a script is committed (lib/permission-scripts.mjs); tests swap in a fake
    this.memory = memory;
    this.settings = settings;
    // Outside models (expedition 20261117): the per-project switch, the provider keys and the calls. Off unless a project's
    // switch is set in the hub settings; tests pass their own with a mock server's address.
    this.offload = offload || new Offload({ settings });
    this.defaults = defaults || {};
    // Routing guide 9.1: effort levels each model accepts, learned from refusals and kept in the hub settings.
    this.effortCeilings = new EffortCeilings(settings?.effortCeilings, map => { try { settings?.save?.({ effortCeilings: map }); } catch { /* kept for this run */ } });
    this.agentHome = agentHome;
    // Plan v3 A10: Matt's trusted sites and approved packages (null for a settings stub that cannot keep them).
    this.lists = typeof settings?.setLists === 'function' ? new PermissionLists({ settings }) : null;
    this.listeners = new Set();
    this.approvals = new Map();
    this.projects = new Map();
    this.bootAt = Date.now();   // "this session" in the usage panel: since the hub started
    this.usage = new Usage(this);
    this.run = realRun;   // git and gh for the handoff facts; tests swap in a fake
    for (const dir of projects) this.addProject(dir);
    this.conductor = conductorDir ? new Conductor(this, conductorDir) : null;
    if (this.conductor) {
      const home = this.conductor.home;
      this.restore(home);
      this.markQuestionRules(home);
      home.log.on(ev => this.emit({ ...ev, project: CONDUCTOR, logged: true }));
    }
    this.idleTimer = setInterval(() => { this.idleCheck(); this.auditChecks(); }, IDLE_CHECK_MS);
    this.idleTimer.unref?.();
    this.usage.restore();
    // The Expedition watchdog (decisions 69 and 71): rebuilt from the logs now, checked every 30 seconds and after every
    // counted message. Nothing launches an expedition yet, so until phase 5 it finds nothing to watch. A live hub makes its
    // first check only after resumeAll (below), so a Lead cannot get both a resume message and its final message from one
    // start; a test hub has no resume and checks at once.
    this.expeditionEnd = new ExpeditionEnd(this);   // the end's logged steps (phase 5); the watchdog's check sweeps it. Its clock is the real one (log times are real); tests set end.now
    this.expeditionWatch = new ExpeditionWatchdog(this, expeditionWatch);   // tests pass { now, timers, checkMs, stopWaitMs }
    this.expeditionWatch.start({ firstCheck: this.noAgents });
    // Decision 64 A raised a shorter saved permission wait to 5 minutes, once: said once in each orchestrator thread.
    const from = this.settings?.timeoutRaisedFrom;
    if (from != null) {
      const label = s => (s % 60 ? `${s} seconds` : `${s / 60} minute${s === 60 ? '' : 's'}`);
      for (const p of this.projects.values()) this.notice(p, 'orchestrator', `Permission wait raised from ${label(from)} to ${label(this.settings.get('permissionTimeoutSec'))} (decision 64): a request the orchestrator has not answered comes to you after that. Change it on the hub settings card.`);
    }
    // After listeners are attached: wake the agents a restart interrupted (M014), every project, a few seconds apart.
    this.resumed = [];
    // A test hub has no real agents, so it writes no resume or hint notices into the logs.
    if (!this.noAgents) setTimeout(() => {
      for (const p of this.projects.values()) this.rulesHint(p);
      this.resumeAll();
      this.expeditionWatch.safeCheck();   // after the resume plan is made: an expedition stop a restart cut short is carried on now
      try { this.conductor?.resume(); } catch (e) { console.warn('Conductor resume failed:', e.message); }
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
      const into = e => e.type === 'message' && e.thread === thread && !names.has(e.from);
      // In the orchestrator thread your message and a Conductor brief (decision 55) are looked at apart, so a restart
      // resends each one still unread: never one instead of the other.
      const kinds = thread === 'orchestrator'
        ? [e => into(e) && e.from === 'you', e => into(e) && !!e.conductor]
        : [e => into(e) && (e.from === 'you' || orchNames.has(e.from))];
      for (const kind of kinds) {
        const i = evs.findLastIndex(kind);
        const m = evs[i];
        if (!m || now - Date.parse(m.ts) > RESUME_WINDOW_MS) continue;
        // Starting up (agent_created, agent_session, agent_busy) is not acting on it; a reply, summary, card or pick is.
        const actedOn = evs.slice(i + 1).some(e => (e.type === 'pick' && m.from === 'you') || (!['agent_created', 'agent_session', 'agent_busy', 'notice', 'usage', 'raise'].includes(e.type) && (names.has(e.from) || names.has(e.agent))));
        if (!actedOn) out.push({ m, i });
      }
    }
    // Oldest first by place in the log, never by time stamp: two messages logged in the same millisecond keep the
    // order they were written in.
    return out.sort((a, b) => a.i - b.i).map(x => x.m);
  }

  // Who wakes after a restart, and why: an agent whose last logged turn had not ended (it was working when the hub
  // stopped), within RESUME_WINDOW_MS, or one with a message it never acted on. Resting agents stay asleep.
  // Workers come first, then the orchestrator, so their news reaches it.
  resumePlan(p, now = Date.now()) {
    const busy = new Map();
    for (const e of p.log.events) if (e.type === 'agent_busy') busy.set(e.agent, e);
    const plan = [];
    const messages = new Map();   // thread -> its unread messages, oldest first (yours and a Conductor brief can both be)
    for (const m of this.undelivered(p, now)) messages.set(m.thread, [...(messages.get(m.thread) || []), m]);
    for (const a of p.agents.values()) {
      if (a.state === 'retired' || (a.role === 'orchestrator' && a !== p.orchestrator())) continue;
      // M049 5: a hub stop (time, budget, the user's Stop) whose final message was not sent yet is finished by the watchdog's
      // first check after this plan, and that message is what wakes the agent: a resume message first would be a second one.
      if (a.expedition && this.expeditionStopPending(p, a)) continue;
      const ms = messages.get(a.thread) || [];
      const b = busy.get(a.name);
      for (const m of ms) plan.push({ agent: a.name, thread: a.thread, why: 'message', message: m, wasWorking: !!b?.busy && Date.parse(b.ts) >= Date.parse(m.ts) });
      if (!ms.length && b?.busy && now - Date.parse(b.ts) <= RESUME_WINDOW_MS) plan.push({ agent: a.name, thread: a.thread, why: 'working' });
      messages.delete(a.thread);
    }
    // A message of yours to the orchestrator role with no holder yet: the next holder takes it.
    // Never a Conductor brief: a restart does not start an orchestrator for one. Only a live Conductor request does
    // (decision 63 A); here, with no holder, the brief waits.
    const orphan = (messages.get('orchestrator') || []).filter(m => !m.conductor).at(-1);
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
        const text = m.from === 'you' ? m.text : m.conductor ? briefText(m.from, m.text, m.request, m.replyExpected !== false) : `[From the orchestrator, ${m.from}]\n${m.text}`;
        if (m.thread === 'orchestrator') this.ensureOrchestrator(p).send(text, m.attachments, m.conductor && m.request ? { request: m.request } : null);
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
    const p = new Project(dir, { repair: this.rotatesLogs });
    if (p.name === CONDUCTOR) throw new Error(`"${CONDUCTOR}" is the Conductor's own name; rename that folder to add it as a project.`);
    if (this.projects.has(p.name)) return this.projects.get(p.name);
    this.projects.set(p.name, p);
    // The first rotation waits a minute after start (an old hub that is still shutting down may append to the log meanwhile),
    // then it is tried every six hours.
    if (this.rotatesLogs && !this.rotateTimer) {
      this.rotateTimer = setTimeout(() => { this.rotateLogs(); this.rotateTimer = setInterval(() => this.rotateLogs(), 6 * 3600e3); this.rotateTimer.unref?.(); }, ROTATE_FIRST_MS);
      this.rotateTimer.unref?.();
    }
    this.restore(p);
    this.markQuestionRules(p);
    p.log.on(ev => this.emit({ ...ev, project: p.name, logged: true }));
    p.desk.notice = text => this.notice(p, 'orchestrator', text);
    if (this.noAgents) p.desk.local = true;   // a test hub never pushes decision records to the real GitHub
    p.board.freshPages();   // decision 41: pages are local, so rebuild any a pull left missing or stale
    return p;
  }

  // One-time cutover for the question rules (public/questions.js): the first start with them logs this event, once per
  // log. Questions asked before it keep the old closing rules (so the backlog stays closed); later ones wait for you.
  // It lives in the log, so a restart and every device read the same moment.
  markQuestionRules(p) {
    if (!p.log.events.some(e => e.type === QUESTION_RULES)) p.log.append(QUESTION_RULES, { version: 2 });
  }

  project(name) {
    const p = this.projects.get(name);
    if (!p) throw new Error(`Unknown project ${name}`);
    return p;
  }
  // A project, or the Conductor's own place (decision 55) for the few routes it shares with projects: messages,
  // attachments, handoff, lessons. Everything else (workers, settings, picks) asks project() and so refuses it.
  place(name) { return name === CONDUCTOR && this.conductor ? this.conductor.home : this.project(name); }

  // Rebuild agents from the log; none are running after a restart, they resume on their next message.
  restore(p) {
    for (const ev of p.log.events) {
      if (ev.type === 'agent_created') {
        p.agents.set(ev.agent, new Agent(this, p, { name: ev.agent, role: ev.role, task: ev.task, goal: ev.goal, generation: ev.generation, predecessor: ev.predecessor, handoffEntry: ev.handoffEntry, type: ev.agentType || null, model: ev.model || null, effort: ev.effort || null, expedition: ev.expedition || null, expeditionRole: ev.expeditionRole || null }));
        if (ev.role !== 'worker') p.generation = Math.max(p.generation, ev.generation);
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

  notice(p, thread, text) { p.log.append('notice', { thread, text: this.memory.personalize(text) }); }

  // ---------- agents ----------
  createAgent(p, { name, role, task = '', goal = '', predecessor = null, handoffEntry = null, settings = {} }) {
    const s = this.resolveSettings(p, role, settings);   // checked before anything is written
    // The Expedition module: only hub code passes these (the orchestrator's and the Lead's start_worker do not), and the
    // successor of an expedition agent inherits them. Checked before anything is written, like the settings.
    const ex = settings.expedition ? { expedition: String(settings.expedition), expeditionRole: settings.expeditionRole || null } : {};
    if (ex.expedition && (role !== 'worker' || !EXPEDITION_ID.test(ex.expedition) || !EXPEDITION_ROLES[ex.expeditionRole])) throw new Error(`Not an expedition agent: ${ex.expedition} / ${ex.expeditionRole}.`);
    // The orchestrator and the Conductor are roles: each holder is numbered (orchestrator-3, conductor-2).
    const generation = role !== 'worker' ? ++p.generation : 0;
    if (role !== 'worker') name = `${role}-${generation}`;
    let unique = name, n = 2;
    while (p.agents.has(unique)) unique = `${name}-${n++}`;
    const a = new Agent(this, p, { name: unique, role, task, goal, generation, predecessor, handoffEntry, ...s, ...ex });
    p.agents.set(unique, a);
    if (role === 'orchestrator' && this.usage?.fableSpell) a.noteForNextTurn(FABLE_NOTE);   // a successor during the spell
    p.log.append('agent_created', { agent: unique, role, task, goal, generation, predecessor, handoffEntry, thread: a.thread, agentType: s.type, model: s.model, effort: s.effort, ...ex });
    return a;
  }

  // ---------- agent types, models and effort (decision 20) ----------
  agentTypes(p) { return new AgentTypes({ home: this.agentHome, projectDir: p.dir }); }

  // What an agent starts with. Explicit picks win; then its type's; then the role's defaults from hub.json;
  // anything left unset is Claude Code's own default. Throws on an unknown type or effort.
  // A type named only by hub.json, or inherited from a predecessor, is dropped quietly if its file is gone.
  resolveSettings(p, role, { type, model, effort, inherited = false } = {}) {
    // The Conductor without its own defaults runs as the orchestrator does (model and effort; never a type).
    const dflt = this.defaults[role] || (role === CONDUCTOR_ROLE ? { ...this.defaults.orchestrator, type: undefined } : null) || {};
    // Every worker has a type (guide, decision 65): none given means the default worker, "implementer".
    const defaulted = role === 'worker' && !(type === undefined ? dflt.type : type);
    const typeName = defaulted ? DEFAULT_WORKER_TYPE : type === undefined ? dflt.type : type;
    const t = typeName ? this.agentTypes(p).get(typeName) : null;
    if (typeName && !t && type !== undefined && !inherited) {
      const names = this.agentTypes(p).list().map(x => x.name);
      throw new Error(`No agent type "${typeName}". ${names.length ? `Types: ${names.join(', ')}.` : 'No types are set up yet.'}`);
    }
    if (effort && !effortLevel(effort)) throw new Error(`Effort must be one of ${EFFORTS.join(', ')}.`);
    const pickModel = model !== undefined && model !== '' ? modelId(model) : undefined;
    const pickEffort = effort !== undefined && effort !== '' ? effortLevel(effort) : undefined;
    return {
      type: t?.name || (defaulted ? DEFAULT_WORKER_TYPE : null),
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
  // Routing guide 9.5: a change that goes up or down in model or effort is logged as a `raise` event (direction
  // 'raise' or 'lower') with the settings before and after and a one-line reason. The reason is required when an
  // orchestrator raises (by is not 'you'); the chip on a thread (by 'you') may leave it out.
  async setAgentSettings(p, name, changes = {}, by = 'you', reason = '') {
    reason = String(reason || '').trim().slice(0, 200);
    const a = name === 'orchestrator' ? p.orchestrator() : p.agents.get(name);
    if (!a) throw new Error(`No agent called ${name}`);
    if (a.state === 'retired') throw new Error(`${name} has retired.`);
    const stay = this.orchestratorStaysOut(p, a, by);
    if (stay) throw new Error(stay);
    // The Conductor (decision 55) changes model and effort only: an agent type would bring its own tools and
    // instructions, which it must never have. Its tools are fixed in lib/conductor.mjs whatever is recorded here.
    if (a.role === CONDUCTOR_ROLE && 'type' in changes) {
      if (changes.type) throw new Error('The Conductor has no agent type: its tools are fixed (decision 55). Change its model or effort instead.');
      changes = { ...changes }; delete changes.type;
    }
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

    const from = { model: a.model || a.modelSeen || null, effort: a.effort };
    const to = { model: 'model' in next ? next.model : a.model, effort: 'effort' in next ? next.effort : a.effort };
    const direction = settingsDirection(from, to);
    if (direction === 'raise' && by !== 'you' && !reason) throw new Error('Raising a model or effort needs a one-line reason: add reason (for example "tests failed twice at medium").');

    Object.assign(a, next);
    const ev = { agent: a.name, thread: a.thread, by };
    if ('type' in next) ev.agentType = next.type;
    if ('model' in next) ev.model = next.model;
    if ('effort' in next) ev.effort = next.effort;
    p.log.append('agent_settings', ev);
    if (direction) p.log.append('raise', { agent: a.name, thread: a.thread, by, direction, agentType: a.type, from, to: { model: to.model || from.model, effort: to.effort }, ...(reason ? { reason } : {}) });

    let when = 'from its next start';
    if (a.live) {
      const live = 'type' in next ? false : await a.applyLive({ model: next.model, effort: next.effort });
      if (live) when = 'now';
      else if (a.state === 'idle' && !a.retiring && !a.capture) { a.close(); when = 'from its next message'; }
      else { a.restartWhenIdle = true; when = 'once it finishes what it is doing'; }
    }
    const line = `${by === 'you' ? 'You' : by} set ${a.name} to ${this.describeSettings(a)}; it applies ${when}.${direction ? ` (a ${direction})` : ''}${reason ? ` Reason: ${reason}` : ''}`;
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

  // ---------- who an agent reports to (the Expedition module, plan section 2a) ----------
  // The one answer every upward route asks: where does this agent's output go? { to: 'orchestrator' } as it always has
  // (every agent that is not in an expedition), { to: 'lead', agent } for an expedition's members, { to: 'none' } for
  // the Lead until its one final summary is due, and for a member whose Lead is gone. No route tests agent.expedition
  // itself, so a new route that asks this cannot leak.
  upwardOf(p, agent) {
    if (!agent?.expedition) return { to: 'orchestrator' };
    if (agent.expeditionRole === 'lead') return this.expeditionOf(p, agent).summaryDue() ? { to: 'orchestrator' } : { to: 'none' };
    const lead = this.expeditionLead(p, agent.expedition);
    return lead ? { to: 'lead', agent: lead } : { to: 'none' };
  }

  expeditionOf(p, agentOrId) {
    return new Expedition(p, typeof agentOrId === 'string' ? agentOrId : agentOrId.expedition);
  }

  // The Lead of an expedition: the newest one not retired and not answering its successor (a successor has a new name).
  expeditionLead(p, id) {
    return [...p.agents.values()].findLast(a => a.expedition === id && a.expeditionRole === 'lead' && a.state !== 'retired' && a.retiring !== 'overlap') || null;
  }

  // ---------- the orchestrator stays out; the Lead's scoped tools; launching (decisions 68 to 71, phase 2) ----------
  // Any agent of an expedition: it never reaches the orchestrator or a card, whatever it is asked or asks (decision 71).
  isExpeditionAgent(agent) { return !!agent?.expedition; }

  // The orchestrator does not message, retire, hand on or re-set an expedition's members: the expedition reports to it
  // once, at the end, and the user stops it from the map. A refusal in plain words, or null. by: the actor's name (or the
  // agent itself); 'you' and 'hub' are not orchestrators, so the user keeps every control.
  orchestratorStaysOut(p, agent, by) {
    if (!agent?.expedition) return null;
    const actor = typeof by === 'string' ? p.agents.get(by) : by;
    if (actor?.role !== 'orchestrator') return null;
    return `${agent.name} belongs to expedition ${agent.expedition}: its Lead runs it and the orchestrator stays out until the one summary at the end.`;
  }

  // The Lead's own expedition (and a refusal for anyone who is not a Lead).
  leadScope(p, lead) {
    if (lead?.expeditionRole !== 'lead' || !lead.expedition) throw new Error("Only an expedition's Lead can do that.");
    return this.expeditionOf(p, lead);
  }

  // A member of the Lead's expedition by name. Anything else (an agent of another expedition, a plain worker, the
  // orchestrator, a retired member, a name that does not exist) is the same plain refusal, so it says nothing about them.
  leadMember(p, lead, name) {
    this.leadScope(p, lead);
    const a = p.agents.get(String(name ?? '').trim());
    if (!a || a.expedition !== lead.expedition || a.expeditionRole === 'lead' || a.role !== 'worker' || a.state === 'retired') throw new Error(`No agent called ${name} in your expedition. list_agents shows your team.`);
    return a;
  }

  // The Lead's list_agents: its own team, nobody else.
  leadAgents(p, lead) {
    const ex = this.leadScope(p, lead), s = ex.state();
    return {
      expedition: ex.id, phase: s.phase,
      gatherers: { running: ex.runningSubagents(), limit: GATHERER_LIMIT, runs: ex.gathererRuns().total, runsLimit: GATHERER_RUNS, note: gathererRule(GATHERER_LIMIT) },
      team: p.workers({ expedition: ex.id }).filter(w => w.expeditionRole !== 'lead').map(w => ({
        name: w.name, role: w.expeditionRole, state: w.state, goal: w.goal, context_pct: w.contextPct ?? null,
        model: w.model || w.modelSeen || null, effort: w.effort || null, type: w.type || null
      }))
    };
  }

  leadMessage(p, lead, to, text) {
    const w = this.leadMember(p, lead, to);
    p.log.append('message', { thread: w.thread, from: lead.name, text });
    w.send(`[From the Lead, ${lead.name}]\n${text}`);
    return w;
  }

  leadRetire(p, lead, name, reason = '') {
    const w = this.leadMember(p, lead, name);
    return this.retireFinished(p, w.name, lead.name, reason);
  }

  // The Lead starts one of the five hub roles. Only those types; the expedition and role are stamped here (the Lead cannot
  // pass them); model and effort are the launch screen's picks for that role (stored in expedition_started), never the Lead's.
  leadStart(p, lead, { type, goal = '', task }) {
    const ex = this.leadScope(p, lead), s = ex.state();
    const role = expeditionRoleOfType(String(type ?? '').trim());
    // After the Lead's own stop (passed, no-progress) only a Verifier may start: it checks the report's numbers and claims
    // (spec 4.8, step 1). After a hub stop (time, budget, the user's Stop) nothing may: the team is retired, the budget is
    // gone, and the report says the claims were not checked.
    const leadStop = s.stopped && !EXPEDITION_HUB_STOPS.includes(s.stopped.reason);
    const open = s.started && (['planning', 'running'].includes(s.phase) || (s.phase === 'stopped' && role === 'verifier' && leadStop));
    if (!open) throw new Error(s.phase === 'stopped' ? (leadStop ? `Expedition ${ex.id} is stopped: only a Verifier can be started now, to check the report.` : `Expedition ${ex.id} was stopped by the hub (${s.stopped.reason}): no agent can be started now. The report says the claims were not checked.`) : `Expedition ${ex.id} is ${s.phase === 'new' ? 'not started' : s.phase}: no new agents can be started.`);
    const allowed = EXPEDITION_HUB_ROLES.filter(r => r !== 'lead');
    if (!role || !allowed.includes(role)) throw new Error(`An expedition starts only these roles, by type: ${allowed.map(r => EXPEDITION_ROLES[r].type).join(', ')}. Gatherers (expedition-gatherer) are not started: call them with the Agent tool.`);
    const brief = String(task ?? '').trim();
    if (!brief) throw new Error('Give the agent its task.');
    const pick = s.started.roles?.[role] || {};
    const settings = { type: EXPEDITION_ROLES[role].type, model: pick.model || undefined, effort: pick.effort || undefined, expedition: ex.id, expeditionRole: role };
    // The Verifier is never on the Builder's model (spec section 3): checked on what each would really run as.
    if (role === 'verifier') {
      const b = s.started.roles?.builder || {};
      const mine = this.resolveSettings(p, 'worker', settings).model, theirs = this.resolveSettings(p, 'worker', { type: EXPEDITION_ROLES.builder.type, model: b.model || undefined, effort: b.effort || undefined }).model;
      if (mine && mine === theirs) throw new Error(`The Verifier and the Builder both run on ${mine}. The Verifier must be a different model from the Builder.`);
    }
    const label = EXPEDITION_ROLES[role].label;
    const header = `You are the ${label} of expedition ${ex.id} in ${p.name} (type ${settings.type}); your Lead is ${lead.name}. The expedition's files are in .crux/expeditions/${ex.id}/ (the build worktree is .claude/worktrees/exp-${ex.id}, branch expedition/${ex.id}). Your post_summary goes to the Lead, as text, and nothing else is read by anyone: nobody can answer a question during an expedition, so ask the Lead (it replies by message), decide inside your task, or say what you left out and why. Never merge, never use scheduling or trigger tools, never edit settings files.\n\n---\n\n`;
    return this.startWorker(p, `exp-${role}`, header + brief, lead.name, String(goal || '').trim().slice(0, 90) || `${label} of ${ex.id}`, settings);
  }

  // Launch (spec section 5; phase 5 adds the screen and the endpoint). Refuses, in plain words and before anything is
  // written, when: the brief is empty, an expedition already runs in this project, the project is at Ask, an agent type is
  // missing, or the Verifier would run on the Builder's model. test: files for test/ by name ({ 'CHECKLIST.md': '...' }).
  // preApprovals (phase 4; the launch panel fills it in phase 5): { sites, packages } for this expedition's agents only. Checked
  // before anything is written, kept in the start event, never added to the user's own lists.
  launchExpedition(p, input = {}, by = 'you') {
    const plan = this.prepareLaunch(p, input);   // every refusal is here, before anything is written
    const { text, question, test, envelope, merged, limit, preApprovals, origin } = plan;
    const dir = join(p.dir, '.crux', 'expeditions');
    const taken = [...Expedition.all(p).map(x => x.id), ...(existsSync(dir) ? readdirSync(dir) : [])];
    const id = Expedition.makeId(question || text.split('\n')[0], { taken });
    const ex = new Expedition(p, id).init();
    ex.write('BRIEF.md', `${text}\n`);
    for (const [name, body] of Object.entries(test)) ex.write(`test/${name}`, body);
    // planStart: the 7-day meter's reading at launch, as a record (it can be minutes old; null under an API key or before the
    // meters load). Spend measure 2 counts from the first fresh reading after the launch, which the watchdog logs itself.
    ex.start({ envelope: { ...envelope, gatherers: limit }, roles: merged, planStart: this.expeditionWatch.planStart(), preApprovals, question: question || text.split('\n')[0], ...(origin ? { origin } : {}) });
    if (input.draft) p.log.append('expedition_draft_closed', { draft: String(input.draft), status: 'launched', expedition: id });
    const e = ex.state().started.envelope;
    const task = [
      `You are the Lead of expedition ${id} in ${p.name}. Its folder is .crux/expeditions/${id}/ : BRIEF.md (the question, scope and envelope) and test/ (the success test) are there; everything you and your team write goes in that folder.`,
      `Envelope: ${e.hours} hours${e.dollars != null ? ` and about $${e.dollars}` : ''}, about ${e.percent}% of the week's plan; the hub enforces it and tells you at 90%. The build goes in the worktree .claude/worktrees/exp-${id} on the branch expedition/${id} (the Builder creates it from the main branch if it is not there).`,
      Object.keys(test).length
        ? `The success test came with the launch: it is in test/ (${Object.keys(test).join(', ')}). Keep it; the Advisor reviews it with your plan at the gate.`
        : 'No success test came with the launch, only the question. While you plan, draft it yourself in test/: CHECKLIST.md (numbered items, each saying how it is judged) and test/run.json where commands help (see your agent file for its shape). The Advisor reviews it at the plan gate, and the gate freezes it.',
      `${gathererRule(limit)} This launch: ${limit} at once.`,
      `Your tools: start_worker (type one of expedition-advisor, expedition-synthesizer, expedition-skeptic, expedition-builder, expedition-verifier), message_agent, retire_worker and list_agents, all limited to this expedition, plus the Agent tool. Nobody is available to answer questions: decide inside the brief or park the line of work.`,
      `The end: when the success test passes call expedition_finish; when your report (REPORT.md) is written and the Verifier's claims pass is applied, call expedition_report_ready. The hub then copies the report onto the branch, pushes it, opens a draft pull request and posts the finished card, and tells you when to send your one post_summary. You never merge.`,
      '', 'The brief:', '', text
    ].join('\n');
    const lead = this.startWorker(p, 'exp-lead', task, by, `Expedition ${id}`.slice(0, 90), { type: merged.lead.type, model: merged.lead.model, effort: merged.lead.effort, expedition: id, expeditionRole: 'lead' });
    return { id, lead: lead.name, expedition: ex.state().started, dollarCap: this.dollarCap(e, input.envelope) };
  }

  // ---------- phase 5: defaults, the dollar cap, drafts and the launch ----------
  // hub.json: { "defaults": { "expedition": { "envelope": { "hours", "percent", "dollars" }, "dollarsPerPercent": 9, "gatherers": 3,
  //   "roles": { "builder": { "model": "sonnet", "effort": "medium" } } } } }. Read once at start (spec 11).
  expeditionConfig() { const c = this.defaults?.expedition; return c && typeof c === 'object' ? c : {}; }

  // Decision 69 C: the ONE confirmed figure, dollars of estimated spend per 1% of the week's plan, from hub.json. Nothing
  // else supplies it and none is invented: without it there is no dollar cap, and a launch runs on time and the meter only.
  dollarsPerPercent() { const n = Number(this.expeditionConfig().dollarsPerPercent); return Number.isFinite(n) && n > 0 ? n : null; }

  // A dollar limit the user chose to keep (the launch panel's "remember"): hub.json already has it; this makes the running hub use it.
  rememberDollarCap(dollars) {
    const d = this.defaults && typeof this.defaults === 'object' ? this.defaults : (this.defaults = {});
    const ex = d.expedition && typeof d.expedition === 'object' ? d.expedition : (d.expedition = {});
    ex.envelope = { ...(ex.envelope || {}), dollars: Number(dollars) };
  }

  // The envelope a launch starts from: built-ins (6 h, 7%), then hub.json, then this launch's own picks. dollars: this launch's
  // figure, else hub.json's, else percent x the confirmed dollars-per-percent, else null (no cap).
  expeditionEnvelope(over = {}) {
    const cfg = this.expeditionConfig().envelope || {};
    const pos = v => (Number(v) > 0 ? Number(v) : null);
    const hours = pos(over.hours) ?? pos(cfg.hours) ?? DEFAULT_ENVELOPE.hours;
    const percent = pos(over.percent) ?? pos(cfg.percent) ?? DEFAULT_ENVELOPE.percent;
    // The hub's own confirmed figure always wins over a dollar figure a page sends along (decision 69 C); with none confirmed,
    // a figure the user typed is theirs and stands, and otherwise there is no dollar cap.
    const per = this.dollarsPerPercent();
    const typed = pos(over.dollars) ?? pos(cfg.dollars);
    const dollars = per ? Math.round(percent * per * 100) / 100 : typed == null ? null : Math.round(typed * 100) / 100;
    return { hours, percent, dollars };
  }

  // What the launch screen says about the budget. meterGuard: the 7-day meter guard exists (it hides under an API key).
  // confirmed: only the dollars-per-percent figure in hub.json is "the confirmed figure" (decision 69 C). source says where the cap
  // came from: 'figure' (percent x that figure), 'typed' (a figure typed at this launch: it counts as the user's own confirmation
  // for this run), 'hub.json envelope' (a dollar figure in hub.json's envelope alone: a cap, but not a confirmed figure), or null.
  // over: the envelope the launch itself sent.
  dollarCap(envelope = this.expeditionEnvelope(), over = {}) {
    const per = this.dollarsPerPercent(), meterGuard = this.usage?.available !== false;
    const typed = Number(over?.dollars) > 0, cfgDollars = Number(this.expeditionConfig().envelope?.dollars) > 0;
    const source = envelope.dollars == null ? null : per ? 'figure' : typed ? 'typed' : cfgDollars ? 'hub.json envelope' : null;
    const note = envelope.dollars != null
      ? (per && envelope.dollars === Math.round(envelope.percent * per * 100) / 100 ? `${envelope.percent}% of the week is about $${envelope.dollars} (at $${per} per 1%, the figure in hub.json). The run stops at that dollar figure or when the 7-day meter rises ${envelope.percent} points, whichever comes first.` : `The run stops at about $${envelope.dollars}${source === 'hub.json envelope' ? ' (a dollar figure in hub.json\'s envelope, not a confirmed dollars-per-percent figure)' : ''}${meterGuard ? ` or when the 7-day meter rises ${envelope.percent} points, whichever comes first` : ' (the meters are hidden under an API key, so only this and the time limit hold)'}.`)
      : `No dollars-per-percent figure is confirmed yet, so there is no dollar cap: this run is held by the time limit${meterGuard ? ` and the 7-day meter (up ${envelope.percent} points)` : ' only (the meters are hidden under an API key)'}. Set defaults.expedition.dollarsPerPercent in hub.json: dollars of estimated spend per 1% of the week.`;
    return { confirmed: per != null, dollarsPerPercent: per, dollars: envelope.dollars, source, meterGuard, note };
  }

  // The role table a launch starts from, and what the launch screen shows: the agent type files, then hub.json's
  // defaults.expedition.roles, then the built-ins; a pick on the launch screen wins over all of them.
  expeditionRoleDefaults(p) {
    const types = this.agentTypes(p), cfg = this.expeditionConfig().roles || {}, out = {};
    for (const [role, d] of Object.entries(EXPEDITION_ROLES)) {
      const t = types.get(d.type), c = cfg[role] || {};
      out[role] = { type: d.type, model: modelId(c.model) || t?.model || modelId(d.model), effort: effortLevel(c.effort) || t?.effort || d.effort, runs: d.runs, label: d.label, installed: !!t };
    }
    return out;
  }

  // Would a launch be accepted now, as to the project itself (not the content)? A plain-words reason, or null.
  launchBlock(p) {
    const running = Expedition.all(p).find(x => x.phase !== 'ended');
    if (running) return `Expedition ${running.id} is still ${running.phase === 'stopped' ? 'writing up' : running.phase}: one expedition runs per project at a time.`;
    if (this.permissionMode(p) === 'standard') return 'This project is at Ask. An expedition needs Auto or Trusted: at Ask every request that is more than a read would wait for an orchestrator, and an expedition has nobody to ask. Raise the level on the project card first.';
    const types = this.agentTypes(p);
    for (const d of Object.values(expeditionDefaultRoles())) if (!types.get(d.type)) return `The agent type ${d.type} is not set up: it is not in ${join(this.agentHome, '.claude', 'agents')}, and the hub could not add it there when it started (it adds the expedition files itself, so that folder may not be writable). Copy the expedition-*.md files from agent-types/starter into that folder, or this project's .claude/agents.`;
    return null;
  }

  // Every check a launch makes, in this order, before anything is written (D0071: the launch is the OK, so nothing may be
  // half done). draft: a thread draft checks the content only (the project may be busy now and free when its Launch is pressed).
  // -> the plan to write: { text, question, test, envelope, merged (roles), limit, preApprovals, origin }
  prepareLaunch(p, input = {}, { draft = false } = {}) {
    const { brief, question = '', test = {}, envelope = {}, roles = {}, gatherers, preApprovals = null } = input;
    // The ask is the only thing a launch needs: the brief may be just the question.
    const text = String(brief || question || '').trim();
    if (!text) throw new Error('The ask is empty: write the question the expedition should answer.');
    if (!draft) { const block = this.launchBlock(p); if (block) throw new Error(block); }
    const def = this.expeditionRoleDefaults(p), merged = {};
    for (const [role, d] of Object.entries(def)) {
      const o = roles?.[role] || {};
      if (o.effort && !effortLevel(o.effort)) throw new Error(`The ${d.label}'s effort must be one of ${EFFORTS.join(', ')}.`);
      merged[role] = { type: d.type, model: modelId(o.model) || d.model, effort: effortLevel(o.effort) || d.effort };
    }
    const problem = Expedition.rolesProblem(merged);
    if (problem) throw new Error(problem);
    // The test files are plain names (no folders, no .., not BRIEF.md): checked before anything is written.
    const files = {};
    for (const [name, body] of Object.entries(test || {})) {
      if (!/^[A-Za-z0-9][\w.-]*$/.test(name) || name.includes('..') || /^BRIEF\.md$/i.test(name)) throw new Error(`"${name}" is not a name for a success-test file: use a plain file name such as CHECKLIST.md or run.json.`);
      if (String(body ?? '').trim()) files[name] = String(body);
    }
    const pre = preApprovals ? { ...preApprovals, packages: this.coercePackages(preApprovals.packages) } : null;
    try { normalizeOverlay(pre, { strict: true }); } catch (e) { throw new Error(e.message); }   // before the folder exists
    // No test is needed at launch (Matt, 2026-11-16: a launch is one plain ask): the Lead drafts CHECKLIST.md, and run.json where
    // commands help, in test/ while planning, and the plan gate freezes it. One that does come is checked here, not at the gate.
    if (files['run.json']) { const bad = runJsonProblem(files['run.json']); if (bad) throw new Error(bad); }
    // A dollar figure the page sends is a plain number of dollars, 500 at most (checked only while it is the user's own: with the
    // confirmed figure the hub's own figure wins and a page's is ignored).
    if (this.dollarsPerPercent() == null && envelope?.dollars != null && envelope.dollars !== '') { const c = checkDollars(envelope.dollars); if (c.problem) throw new Error(c.problem); }
    const env = this.expeditionEnvelope(envelope || {});
    if (this.usage?.available === false && env.dollars == null) throw new Error('Under an API key the plan meters are hidden, so the only budget guard is a dollar cap, and none is set. Give the envelope a dollar figure, or set defaults.expedition.dollarsPerPercent in hub.json.');
    const cfgG = Number(this.expeditionConfig().gatherers);
    const limit = Math.min(GATHERER_LIMIT, Math.max(1, Math.round(Number(gatherers ?? cfgG)) || 3));
    let origin = null;
    if (input.draft && !draft) {
      const d = p.log.events.find(e => e.type === 'expedition_draft' && e.id === String(input.draft));
      if (!d) throw new Error('That draft is no longer here.');
      if (p.log.events.some(e => e.type === 'expedition_draft_closed' && e.draft === d.id)) throw new Error('That draft was already launched or dismissed.');
    }
    if (input.proposal && !draft) {
      const { expedition: from, parked: pid } = input.proposal || {};
      const e = p.log.events.find(x => x.id === String(pid) && x.expedition === from && isProposal(x));
      if (!e) throw new Error('That proposed expedition is no longer here.');
      if (p.log.events.some(x => x.type === 'expedition_started' && x.origin?.parked === e.id)) throw new Error('That proposed expedition was already launched.');
      origin = { expedition: from, parked: e.id };
    }
    return { text, question: String(question || '').trim(), test: files, envelope: env, merged, limit, preApprovals: pre, origin };
  }

  // Package pre-approvals from the launch panel (M049 8): the baseline version can come as numbers, numeric strings, or the
  // version the user saw ("3.4.1"); permission-lists' cleanPackage reads it. Anything else is left for it to refuse.
  coercePackages(list) { return Array.isArray(list) ? list.map(x => (x && typeof x === 'object' ? { ...x } : x)) : list; }

  // The orchestrator's draft (decision 70 A): one card in its thread with Launch and Edit. It checks the content like a
  // launch does, so a draft that could never launch is refused to the orchestrator, in plain words, and nothing is logged.
  draftExpedition(p, agent, args = {}) {
    const input = {
      brief: args.brief, question: args.question, test: Array.isArray(args.test_files) ? Object.fromEntries(args.test_files.map(f => [String(f?.name ?? ''), f?.content])) : (args.test || {}),
      envelope: { ...(args.hours ? { hours: args.hours } : {}), ...(args.percent ? { percent: args.percent } : {}) }, gatherers: args.gatherers,
      preApprovals: args.sites || args.packages ? { sites: args.sites || [], packages: args.packages || [] } : null, roles: args.roles || {}
    };
    const plan = this.prepareLaunch(p, input, { draft: true });
    const ev = p.log.append('expedition_draft', { thread: 'orchestrator', from: agent.name, question: plan.question || plan.text.split('\n')[0].slice(0, 200), brief: plan.text, test: plan.test, envelope: input.envelope, roles: input.roles, gatherers: plan.limit, preApprovals: plan.preApprovals });
    return { id: ev.id, blocked: this.launchBlock(p) };
  }

  // Close a draft card without launching it (the Dismiss on the card).
  dismissExpeditionDraft(p, id) {
    const d = p.log.events.find(e => e.type === 'expedition_draft' && e.id === String(id));
    if (!d) throw new Error('That draft is no longer here.');
    if (p.log.events.some(e => e.type === 'expedition_draft_closed' && e.draft === d.id)) return { ok: true };
    p.log.append('expedition_draft_closed', { draft: d.id, status: 'dismissed' });
    return { ok: true };
  }

  // Every project's expedition on the state feed (decisions 69 to 72): what the launch screen, the map's Stop, the sidebar row,
  // the thread card and the Launch on parked items read. See the shape in the phase 5 checkpoint.
  expeditionView(p) {
    const env = this.expeditionEnvelope(), cap = this.dollarCap(env), cfgG = Number(this.expeditionConfig().gatherers);
    const all = Expedition.all(p), evs = p.log.events;
    const live = id => [...p.agents.values()].filter(a => a.expedition === id && a.state !== 'retired').length;
    const prOf = ex => { const s = ex.stepEvent('pr'); return s?.ok ? { url: s.url || null, number: s.number ?? null, draft: s.draft !== false } : null; };
    const brief = x => {
      const ex = this.expeditionOf(p, x.id), s = ex.state();
      return { ex, s, id: x.id, question: s.started?.question || x.id, phase: x.phase, stopReason: s.stopped?.reason || null };
    };
    const open = all.filter(x => x.phase !== 'ended' || live(x.id) > 0).at(-1);
    let current = null;
    if (open) {
      const { ex, s, id, question, phase, stopReason } = brief(open);
      current = { id, name: question, question, phase, stopReason, startedAt: s.started?.ts || null, envelope: s.started?.envelope || null, roles: s.started?.roles || null, lead: this.expeditionLead(p, id)?.name || null, liveAgents: live(id), steps: [...s.steps], branch: ex.branch, pr: prOf(ex), answer: s.finished?.answer || null };
    }
    const launchedFrom = new Set(evs.filter(e => e.type === 'expedition_started' && e.origin).map(e => e.origin.parked));
    const ended = all.filter(x => x.phase === 'ended').reverse();
    const past = ended.slice(0, 10).map(x => {
      const { ex, s, id, question, stopReason } = brief(x), f = s.finished;
      return { id, question, stopReason, answer: f?.answer || null, branch: ex.branch, pr: f?.pr || prOf(ex), pushed: !!f?.pushed, problem: f?.problem || null, decisions: s.decisions.length, parked: f?.parked ?? proposalsOf(evs, id).length, loops: s.loops.length, passing: f?.passing ?? null, claimsChecked: !!f?.claimsChecked, finishedAt: f?.ts || s.stopped?.ts || null };
    });
    const proposals = ended.slice(0, 5).flatMap(x => proposalsOf(evs, x.id, this.expeditionOf(p, x.id).state().started?.question || '')).filter(q => !launchedFrom.has(q.id));
    const closed = new Set(evs.filter(e => e.type === 'expedition_draft_closed').map(e => e.draft));
    const drafts = evs.filter(e => e.type === 'expedition_draft' && !closed.has(e.id)).map(({ id, ts, from, question, brief: b, test, envelope, roles, gatherers, preApprovals }) => ({ id, ts, from, question, brief: b, test, envelope, roles, gatherers, preApprovals }));
    return {
      defaults: { envelope: { hours: env.hours, percent: env.percent }, dollarsPerPercent: cap.dollarsPerPercent, dollars: cap.dollars, meterGuard: cap.meterGuard, gatherers: Math.min(GATHERER_LIMIT, Math.max(1, Math.round(cfgG) || 3)), gathererLimit: GATHERER_LIMIT, roles: this.expeditionRoleDefaults(p) },
      budgetNote: cap.note, launch: (() => { const reason = this.launchBlock(p); return { ok: !reason, reason }; })(),
      current, past, drafts, proposals
    };
  }

  // A hub stop is logged but its final message to the Lead is not: the watchdog sends it at its next check (after a restart,
  // the first one). Every member of that expedition is left asleep until then; the members are retired by the sequence and the
  // Lead is woken by the final message.
  expeditionStopPending(p, agent) {
    try {
      const s = this.expeditionOf(p, agent).state();
      return !!(s.stopped && EXPEDITION_HUB_STOPS.includes(s.stopped.reason) && !s.finalNote);
    } catch { return false; }
  }

  // An expedition agent whose expedition is in its last stretch (the 90% note has gone, or it has stopped): no handoff.
  expeditionClosing(p, agent) {
    if (!agent?.expedition) return false;
    const s = this.expeditionOf(p, agent).state();
    return !!(s.reserveNote || s.stopped);
  }

  // ---------- phase 4: the frozen test and the launch's pre-approvals ----------
  // The folders frozen from the plan gate on: the agent's own test/ and the folder holding the stored copies. Read from the
  // hub's own record of which expedition the agent belongs to (agent.expedition, set at creation and read back from the log),
  // never from anything the agent says or writes. [] for a plain agent, and for an expedition before its gate.
  frozenDirs(p, agent) {
    if (!agent?.expedition) return [];
    try {
      const ex = this.expeditionOf(p, agent);
      return ex.state().gate ? [ex.testDir, ex.frozenRoot] : [];   // frozenRoot: every stored copy, so one rm cannot take them
    } catch { return []; }
  }

  // The pre-approved sites and packages the launch gave this agent's expedition (the start event), only while it is planning
  // or running: it ends at expedition_stopped, and a restart rebuilds it from the log. null for a plain agent.
  expeditionOverlay(p, agent) {
    if (!agent?.expedition) return null;
    try {
      const s = this.expeditionOf(p, agent).state();
      return s.started && (s.phase === 'planning' || s.phase === 'running') ? s.started.preApprovals || null : null;
    } catch { return null; }
  }

  // Asked from the PreToolUse hook for every tool call (the Agent tool aside), for the Lead's gatherers too. Workers run in
  // acceptEdits mode, where Claude Code approves edits and plain file commands inside the working folder itself and never asks
  // canUseTool; a hook's deny is the one place that still sees them. The same narrow rule as classify's (frozenWrite), logged
  // like any refusal. A plain-words reason, or null. hookInput: { tool_name, tool_input, cwd, tool_use_id, agent_id }.
  expeditionFrozenBlock(p, agent, hookInput) {
    if (!agent?.expedition || !hookInput?.tool_name) return null;
    const dirs = this.frozenDirs(p, agent);
    const input = hookInput.tool_input || {};
    const cwd = hookInput.cwd || agent.cwdFor?.(hookInput.tool_use_id) || null;
    let why = null;
    if (dirs.length) { try { why = frozenWrite(hookInput.tool_name, input, { dirs, cwd, projectDir: p.dir }); } catch { why = null; } }   // never break the agent's call: the hash check is the real guard
    // Review round 1: the file tools under .crux may write only in the agent's own expedition folder (acceptEdits never asks
    // canUseTool for them, so classify's rule is not seen): the same rule, asked here.
    if (!why) { try { why = expeditionFolderWrite(hookInput.tool_name, input, { root: this.expeditionOf(p, agent).root, projectDir: p.dir, cwd }); } catch { why = null; } }
    if (!why) return null;
    const subagent = agent.subagentFor?.(hookInput.tool_use_id, hookInput.agent_id) || null;
    return this.denyQuiet(p, agent, hookInput.tool_name, input, why, { subagent }).message;
  }

  // After a hub stop (time, budget, the user's Stop) the Lead may not call the Agent tool: its gatherers are gone with the
  // interrupt, and a new one would spend budget that is used up. Asked from the PreToolUse hook (the Agent call does not reach
  // canUseTool, M046), which can deny. A plain-words reason, or null.
  // Decision 75 A: and a gatherer run past the allowance (8 in all, 4 at once) is refused with the reason. hookInput: the hook's
  // input (tool_use_id, tool_input); without it only the stop is checked.
  expeditionToolBlock(p, agent, toolName, hookInput = null) {
    if (agent?.expeditionRole !== 'lead' || !agent.expedition || !['Agent', 'Task'].includes(toolName)) return null;
    const ex = this.expeditionOf(p, agent), s = ex.state();
    const stopped = s.stopped;
    if (stopped && EXPEDITION_HUB_STOPS.includes(stopped.reason)) return `The expedition was stopped by the hub (${stopped.reason}): no gatherer can be started now. Write the report from what exists and say the claims were not checked.`;
    if (hookInput?.tool_input?.subagent_type !== GATHERER_TYPE) return null;
    const why = ex.gathererBlock(hookInput.tool_use_id, s.started?.envelope?.gatherers);
    if (why) return why;
    ex.gathererCall(hookInput.tool_use_id);
    return null;
  }

  // A gatherer's own WebSearch and WebFetch (hook calls with agent_id): up to 8 searches and 6 page opens each (decision 75 A).
  // Counted by the gatherer's id on the Lead's agent object (gathererUse); the count goes onto the gatherer's ended event and the
  // entry is dropped (Agent.takeGathererUse). A plain reason or null.
  gathererToolBlock(agent, hookInput) {
    if (!agent?.expedition || hookInput?.agent_type !== GATHERER_TYPE || !hookInput.agent_id) return null;
    const kind = hookInput.tool_name === 'WebSearch' ? 'searches' : hookInput.tool_name === 'WebFetch' ? 'opens' : null;
    if (!kind) return null;
    const use = ((agent.gathererUse ||= new Map()).get(hookInput.agent_id) || (agent.gathererUse.set(hookInput.agent_id, { searches: 0, opens: 0 }), agent.gathererUse.get(hookInput.agent_id)));
    if (use[kind] >= GATHERER_ROUND1[kind]) return kind === 'searches'
      ? `You have used your ${GATHERER_ROUND1.searches} web searches. Open the pages you have not read yet, or stop and write your notes and gaps.`
      : `You have opened your ${GATHERER_ROUND1.opens} pages. Write your notes and list what is left as gaps.`;
    use[kind]++;
    return null;
  }

  // The user's Stop (reason 'Matt'): the watchdog's stop sequence for one expedition (spec 4.4 and 4.8). POST /api/expedition/stop
  // calls it (M049 2). id: the expedition's, or left out for the one that is running.
  stopExpedition(p, id = null, reason = 'Matt') {
    if (!['Matt', 'time', 'budget'].includes(reason)) throw new Error(`The hub stops an expedition for Matt, time or budget; "${reason}" is the Lead's to log (expedition_finish, expedition_loop_result).`);
    if (!id) {
      const open = Expedition.all(p).findLast(x => x.phase === 'planning' || x.phase === 'running');
      if (!open) throw new Error(`No expedition is running in ${p.name}.`);
      id = open.id;
    }
    return this.expeditionWatch.stopNow(p, String(id), reason);
  }

  startWorker(p, name, task, by = 'you', goal = '', settings = {}) {
    if (!goal) goal = String(task).split('\n')[0].slice(0, 90);
    const w = this.createAgent(p, { name, role: 'worker', task, goal, settings });
    // The brief carries what the worker was started as, so the thread shows it from the first message.
    p.log.append('message', { thread: w.thread, from: by, text: task, agentType: w.type, model: w.model, effort: w.effort });
    // Routing guide 9.6: each advisor call is one line in the orchestrator's thread (counted in the usage panel).
    if (w.type === 'advisor') this.notice(p, 'orchestrator', `Advisor called: ${w.name} (${goal}).`);
    w.send(task);
    return w;
  }

  // ---------- messages ----------
  // ids: attachments the page uploaded first (decision 23), as ids or { id, name }. The event keeps only id, type,
  // size and the cleaned original name (display text).
  // extra: more fields for the message event (answers: the summary questions it answers, from Needs you).
  fromYou(p, thread, text, ids = [], extra = {}) {
    if (ids.length > MAX_PER_MESSAGE) throw new Error(`Up to ${MAX_PER_MESSAGE} attachments per message.`);
    const attachments = ids.map(x => x && typeof x === 'object' ? p.attachments.ref(String(x.id || ''), x.name) : p.attachments.ref(String(x)));
    if (p.hubWide) return this.conductor.fromYou(text, attachments, extra);   // the Conductor's thread (decision 55)
    const a = thread === 'orchestrator' ? null : p.agents.get(thread);
    if (thread !== 'orchestrator' && (!a || a.state === 'retired')) throw new Error(`No active agent ${thread}`);
    p.log.append('message', { thread, from: 'you', text, ...extra, ...(attachments.length ? { attachments } : {}) });
    (a || this.ensureOrchestrator(p)).send(text, attachments);
  }

  agentSaid(p, agent, text) {
    if (agent.capture) agent.capture.buf.push(text);
    // Voice (decision 61 A): the Conductor's answer to a spoken message loses its Spoken line, which is read aloud.
    const v = p.hubWide && agent.role === 'conductor' ? this.conductor?.voiceSaid(text) : null;
    if (!v) return p.log.append('message', { thread: agent.thread, from: agent.name, text });
    const ev = v.rest ? p.log.append('message', { thread: agent.thread, from: agent.name, text: v.rest }) : null;
    this.conductor.voiceLogged(ev, v);
    return ev;
  }

  orchestratorToWorker(p, orch, to, text) {
    const w = p.agents.get(to);
    if (!w || w.role !== 'worker' || w.state === 'retired') throw new Error(`No active worker ${to}`);
    const stay = this.orchestratorStaysOut(p, w, orch);
    if (stay) throw new Error(stay);
    p.log.append('message', { thread: w.thread, from: orch.name, text });
    w.send(`[From the orchestrator, ${orch.name}]\n${text}`);
  }

  // Every question is kept as asked: a repeat of a question already waiting in another card is hidden only where cards
  // are drawn (public/questions.js openQuestions), so it comes back by itself if that card closes unanswered.
  // The Conductor never lists decisions of its own: they are the projects' cards; it may only mention them.
  // Decision 64: a line under questions with no question mark (that does not open like a question either) asks nothing, so it is no card: it is kept as a plain
  // line (notes) in the summary. Returns { notes } so post_summary can tell the agent.
  postSummary(p, agent, s) {
    const decisions = agent.role === CONDUCTOR_ROLE ? [] : s.decisions_needed || [];
    const asked = (s.questions || []).map(q => String(q).trim()).filter(Boolean);
    // A line that opens like a question or a request (Please, Pick, Should, Which...) stays a card even without one.
    const asks = q => q.includes('?') || /^(please|pick|choose|should|may|can|will|do|is|which|what)\b/i.test(q);
    const notes = asked.filter(q => !asks(q));
    // Routing guide 9.4: how the round went, optional; anything but done, partial or blocked is dropped.
    const { outcome, ...rest } = s;
    s = { ...rest, ...(OUTCOMES.includes(outcome) ? { outcome } : {}), questions: asked.filter(asks), decisions_needed: decisions, ...(notes.length ? { notes } : {}) };
    // The Expedition module: an expedition never raises a card (decision 71). Its questions and decisions are held out of
    // the logged summary, so nothing reads them as a card or a notice, and go to the Lead as text instead (below).
    const held = agent.expedition && (s.questions.length || s.decisions_needed.length) ? { questions: s.questions, decisions_needed: s.decisions_needed } : null;
    if (agent.expedition) s = { ...s, questions: [], decisions_needed: [], ...(held ? { held } : {}) };
    p.log.append('summary', { thread: agent.thread, from: agent.name, ...s, ...(agent.expedition ? { expedition: agent.expedition } : {}) });
    const result = { notes, ...(held ? { held: true } : {}) };
    if (agent.role !== 'worker') return result;
    const up = this.upwardOf(p, agent);
    if (up.to === 'none') return result;   // a Lead before its final summary, or a member whose Lead is gone: it shows in its own thread
    // Nothing to route; you see it in the thread. (A Lead's final summary always goes: it starts an orchestrator if none runs.)
    if (!agent.expedition && !p.orchestrator() && !s.questions.length && !s.decisions_needed.length) return result;
    const lines = [`[Summary from ${agent.expedition ? `${EXPEDITION_ROLES[agent.expeditionRole]?.label.toLowerCase() || 'expedition member'}` : 'worker'} ${agent.name}]`];
    const sec = (label, xs) => xs?.length && lines.push(`${label}:\n${xs.map(x => '- ' + x).join('\n')}`);
    const asks2 = held?.questions || s.questions;
    sec('Done', s.done); sec('Changed', s.changed); sec(held ? 'Questions (nobody is available to answer: decide in scope or park them)' : 'Questions', asks2); sec('Notes', s.notes); sec('Blocked on', s.blocked_on);
    if (held?.decisions_needed.length) lines.push(`Decision numbers named (decide in scope or park): ${held.decisions_needed.map(n => 'D' + String(n).padStart(4, '0')).join(', ')}`);
    else if (s.decisions_needed.length) lines.push(`Decisions waiting on {{who}}: ${s.decisions_needed.map(n => 'D' + String(n).padStart(4, '0')).join(', ')}`);
    if (s.next_step) lines.push(`Proposed next step: ${s.next_step}`);
    if (s.outcome) lines.push(`Outcome: ${s.outcome}`);
    if (up.to === 'lead') { up.agent.send(lines.join('\n')); return result; }
    this.ensureOrchestrator(p).send(lines.join('\n'));
    // The Lead's one summary to the orchestrator is logged as the end's last step, so it goes only once.
    if (agent.expedition) this.expeditionOf(p, agent).step('summary', { agent: agent.name });
    return result;
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
      .map(a => ({ index: Number(a?.index), answer: String(a?.text ?? '').trim(), own: a?.own === true }))
      .filter(a => a.answer && Number.isInteger(a.index) && a.index >= 0 && a.index < ev.questions.length);
    if (!items.length) throw new Error('Type an answer first.');
    const pairs = items.map(a => ({ question: ev.questions[a.index], answer: a.answer }));
    // A question stays on Needs you after its asker retires (Matt, 2026-11-16), so you can still answer it. A retired
    // agent has no box to read it: the answer goes to the orchestrator thread, naming who asked.
    const asker = ev.thread === 'orchestrator' ? null : p.agents.get(ev.thread);
    const askerGone = ev.thread !== 'orchestrator' && (!asker || asker.state === 'retired');
    const text = askerGone ? `[Answers to ${ev.from}'s questions; ${ev.from} has retired, so they come to you]\n\n${answerMessage(pairs)}` : answerMessage(pairs);
    this.fromYou(p, askerGone ? 'orchestrator' : ev.thread, text, [], { answers: items.map(a => ({ question: id, index: a.index })) });
    // Decision 64: your yes on a merge question's card pre-approves that merge, only when the page marks the answer as
    // your own words (own: true). Missing means no pass: the Conductor's suggestion (Take all, or its pre-filled box
    // sent as it was), or an older page.
    for (const a of items) if (a.own) this.grantMergePass(p, ev, a.index, a.answer);
    // A worker's questions: one line in the orchestrator thread, and a note the orchestrator reads with its next
    // message, so it knows they are answered and does not ask again. It is not woken just for this. The
    // orchestrator's own questions skip this: the answer already goes to its thread.
    if (!askerGone && p.agents.get(ev.from)?.role === 'worker') {
      this.notice(p, 'orchestrator', answerNote('You', ev.from, pairs));
      p.orchestrator()?.noteForNextTurn(`[Hub note] ${answerNote('{{Who}}', ev.from, pairs)}. ${ev.from} has the answers; these questions are settled, so don't ask them again.`);
    }
    return { ok: true, thread: askerGone ? 'orchestrator' : ev.thread, answered: items.map(a => a.index) };
  }

  // Decision 64, part 3: your own answer to question i of summary ev, from its card. A plain yes to a question asking
  // to merge one PR logs a merge pass (lib/merge-pass.mjs) and a line in the orchestrator thread saying exactly what
  // it allows. Only called from answerQuestions, for answers the page marks as your own.
  grantMergePass(p, ev, i, answer) {
    const g = passFor(ev.questions?.[i], answer);
    if (!g) return null;
    const pass = randomUUID().slice(0, 8), card = `question:${ev.id}`;
    const e = p.log.append('merge_pass', { pass, card, asker: ev.from, thread: ev.thread, index: i, number: g.number, by: 'you' });
    this.notice(p, 'orchestrator', `Your yes to ${ev.from}'s question pre-approves gh pr merge ${g.number} (with --merge or --squash or neither), once, by ${ev.from} only, for ${PASS_MS / 60000} minutes. No other command, flag or repo. Dismissing that card, or a no, wait or stop from you in ${ev.thread === 'orchestrator' ? 'the orchestrator thread' : `${ev.thread}'s thread`}, cancels it.`);
    return e;
  }

  // ---------- memory layers (decisions 13 and 15) ----------
  proposeLesson(p, agent, scope, lesson) {
    if (scope === 'project') {
      const pack = this.memory.addProjectLesson(p.name, lesson, agent.name);
      p.log.append('lesson', { thread: agent.thread, from: agent.name, pack, text: lesson });
      return `Added to the ${pack} pack.`;
    }
    // An expedition raises no card (decision 71): a core lesson is held and listed in the report, where {{who}} promotes
    // it. Unlike the summary routes this holds for the Lead after its final summary too (a lesson is never a card).
    if (agent.expedition) {
      this.expeditionOf(p, agent).park({ text: lesson, reason: 'a core lesson, held for the report', maker: agent.name, kind: 'lesson' });
      return 'Held in the expedition report; {{who}} can promote it from there.';
    }
    p.log.append('lesson_proposed', { thread: agent.thread, from: agent.name, lesson: randomUUID(), text: lesson });
    return 'Queued for {{who}} to approve; it joins the core profile once they do.';
  }

  pendingLessons(p) {
    const done = new Set(p.log.ofType('lesson_result').map(e => e.lesson));
    return p.log.ofType('lesson_proposed').filter(e => !done.has(e.lesson));
  }

  // Claude Code's start-up message says where its key came from (apiKeySource). With the saved key set up for agents it must
  // say apiKeyHelper; anything else means they may be on another account, so the card says so.
  noteKeySource(src) {
    if (!this.apiKeyHelper || !src) return;
    this.keyProblem = src === 'apiKeyHelper' ? '' : `Claude Code is not using the saved key (it reports "${String(src).slice(0, 40)}"), so the agents may be running on another account. Switch again, or restart the hub.`;
  }

  // ---------- the profile (decision 79 A): Create, and Import as one batch ----------
  promptDismissed() { try { return JSON.parse(readFileSync(this.promptFile, 'utf8')).dismissed === true; } catch { return false; } }
  dismissPrompt() { mkdirSync(join(this.promptFile, '..'), { recursive: true }); writeFileSync(this.promptFile, JSON.stringify({ dismissed: true, at: new Date().toISOString() })); }
  profileView() { return profileView(this.memory, { promptDismissed: this.promptDismissed() }); }
  createProfile() { const made = createProfile(this.memory); return { ...made, profile: this.profileView() }; }
  get importer() {
    if (this.profileCall) return this.profileCall;
    if (this.noAgents) return async () => { throw new Error('A test hub makes no model call.'); };
    const key = this.apiKey();   // the environment's key or the Account card's saved one, as the checker uses
    return (this.profileCall = key ? apiCall({ apiKey: key, model: IMPORT_MODEL, maxTokens: 16000 }) : async arg => {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      return sdkCall({ query, model: IMPORT_MODEL, claudePath: this.claudeCode?.() || null, env: checkEnv(), cwd: tmpdir() })(arg);
    });
  }
  // The pasted export is untrusted data: one call with no tools sorts it; nothing is written until the batch is accepted.
  // The export itself is never logged; the log gets the batch's id and counts. Returns { counts }.
  async importProfile(p, text) {
    const t = String(text ?? '').trim();
    if (!t) throw new Error('Paste or drop an export first.');
    if (t.length > IMPORT_CAP) throw new Error(`That export is ${t.length.toLocaleString('en-US')} characters; at most ${IMPORT_CAP.toLocaleString('en-US')} are taken in one go. Paste the part you care about, or split it.`);
    if (this.pendingLessons(p).some(e => e.batch)) throw new Error('An import is already waiting in Needs you. Accept or cancel it first.');
    let res;
    try { res = await this.importer({ system: IMPORT_SYSTEM, user: importUser(t), signal: AbortSignal.timeout(120000) }); }
    catch (e) { if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error(TOO_LONG); throw e; }   // 120 s and no answer: too much for one pass
    if (res?.modelUsage && Object.keys(res.modelUsage).length) {
      const models = totalsOf(res.modelUsage);
      p.log.append('usage', { agent: 'profile import', project: p.name, agentType: 'summary', role: 'summary', model: IMPORT_MODEL, effort: null, models, costUSD: sumCost(models), listUSD: res.listUSD ?? null, via: res.via || null });
    }
    if (res?.stopReason === 'max_tokens' || looksCut(res?.text)) throw new Error(TOO_LONG);   // the answer was cut off before it closed
    const batch = parseBatch(res?.text);
    if (!batch) throw new Error('Nothing usable was found in that export. Nothing was changed.');
    // Another import may have finished while the model was working: one waiting batch at a time, so never two cards.
    if (this.pendingLessons(p).some(e => e.batch)) throw new Error('An import is already waiting in Needs you. Accept or cancel it first.');
    const id = this.batches.save(batch), counts = countsOf(batch);
    p.log.append('lesson_proposed', { thread: 'orchestrator', from: 'profile import', lesson: id, text: `Profile import: ${countsLine(counts)}`, batch: true, counts });
    return { counts };
  }
  // What the batch card shows. The private lines are shown on this PC only.
  profileBatch(id, { local = true } = {}) {
    const b = this.batches.read(id);
    if (!b) throw new Error('That import is no longer waiting.');
    return { core: b.core, packs: b.packs, private: local ? b.private : b.private.map(() => '(shown on the PC only)'), left: b.left || 0 };
  }

  // local: whether the answer comes from this PC. An import with private notes is accepted on the PC only (a phone may cancel it).
  answerLessons(p, ids, accept, { local = true } = {}) {
    const pending = this.pendingLessons(p).filter(e => ids.includes(e.lesson));
    if (accept && !local && pending.some(e => e.batch && this.batches.read(e.lesson)?.private?.length)) throw new Error('Accept this on the PC: it adds private notes. You can cancel it from here.');
    for (const e of pending) {
      if (e.batch) {   // a profile import: written only now, on Accept; Cancel drops the proposed text
        let ok = false;
        if (accept) { const b = this.batches.read(e.lesson); if (b) { applyBatch(this.memory, b); ok = true; } }
        this.batches.remove(e.lesson);
        p.log.append('lesson_result', { lesson: e.lesson, accepted: ok, thread: e.thread, ...(accept && !ok ? { note: 'The proposed text was gone, so nothing was added.' } : {}) });
        continue;
      }
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
      const attachment = p.attachments.save(readFileSync(path), undefined, { imageOnly: true, label: 'That visual' });
      return p.log.append('visual', { thread: agent.thread, from: agent.name, visual: attachment.id, kind: 'image', attachment, caption });
    }
    if (!VISUAL_TYPES[ext]) throw new Error(`Visuals must be one of ${Object.keys(VISUAL_TYPES).join(', ')}`);
    const { file, kind } = this.memory.storeVisual(p.name, path);
    return p.log.append('visual', { thread: agent.thread, from: agent.name, visual: file, kind, caption });
  }

  // A picture the hub itself made (make_image): stored and posted exactly like a post_visual PNG, so it shows in the thread
  // and "<id>" works in a summary's visuals and a decision's images. Returns the id; throws a plain reason when it is not a picture.
  postImage(p, agent, buf, caption) {
    const attachment = p.attachments.save(buf, undefined, { imageOnly: true, label: 'That picture' });
    p.log.append('visual', { thread: agent.thread, from: agent.name, visual: attachment.id, kind: 'image', attachment, caption: String(caption || '').slice(0, 200) });
    return attachment.id;
  }

  // ---------- outside models (decision 80): the per-project switch, kept in hub settings only ----------
  outsideMode(p) { return this.settings.outsideMode?.(p.dir) || 'off'; }
  setOutsideMode(p, mode, by = 'you') {
    if (!OUTSIDE_MODES.includes(mode)) return this.outsideMode(p);
    const was = this.outsideMode(p);
    this.settings.setProject(p.dir, { outsideModels: mode });
    if (mode === was) return mode;
    p.log.append('project_settings', { outsideModels: mode, was, by, thread: 'orchestrator' });
    const who = by === 'you' ? 'You' : by;
    this.notice(p, 'orchestrator', {
      off: `${who} turned outside models off for ${p.name}: no text or picture goes to another provider.`,
      local: `${who} set outside models to Local only for ${p.name}: drafts may go to a model on this computer; pictures stay off.`,
      any: `${who} set outside models to Any for ${p.name}: the hub may send an agent's short questions, draft text and picture prompts to the provider chosen for the hub, within its allowance. Agents started from now on can use ask_outside_model, draft_with_outside_model and make_image.`
    }[mode]);
    return mode;
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
  // cwd: the folder the tool call runs in (decision 64 A), so a glob is matched against what it would really read.
  autoAnswer(p, agent, toolName, input, cwd = p.dir) {
    const norm = s => String(s || '').replace(/\\/g, '/').toLowerCase();
    const file = norm(input.file_path || input.path || input.notebook_path);
    const privateNotes = norm(join(this.memory.profileDir, 'private.md'));
    const readsPrivate = (file && file === privateNotes) || /private\.md/i.test(String(input.command || input.pattern || ''));
    if (['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'].includes(toolName) && !readsPrivate && !touchesSecrets(toolName, input, cwd)) return { behavior: 'allow', updatedInput: input };
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
    if (/^(Bash|PowerShell)$/.test(toolName) && CommandPolicy.readOnly(toolName, cmd) && !readsPrivate && !touchesSecrets(toolName, input, cwd)) return { behavior: 'allow', updatedInput: input };
    return null;
  }

  // Decision 21 A: a worker's request goes to the orchestrator first, unless the hub's own matcher finds a hard stop
  // in the permission rules (or cannot read it), routing is off, there is no rules entry, or no orchestrator is
  // running. Then it is a card for you, as before. If the orchestrator escalates or does not answer in time, too.
  requestApproval(p, agent, toolName, input, { signal, title, description, suggestions, toolUseID, agentID, warmed } = {}) {
    // A10: an install of approved packages waits (up to about 5 seconds) for the registry's answer before it is judged.
    const warm = warmed ? null : this.lists?.warm(toolName, input, p.dir, undefined, this.expeditionOverlay(p, agent));
    if (warm) return warm.then(() => signal?.aborted ? { behavior: 'deny', message: 'Cancelled' } : this.requestApproval(p, agent, toolName, input, { signal, title, description, suggestions, toolUseID, agentID, warmed: true }));
    const auto = this.autoAnswer(p, agent, toolName, input, agent.cwdFor?.(toolUseID) || p.dir);
    if (auto) return Promise.resolve(auto);
    // The Expedition module (decision 71): a gatherer's request arrives as its Lead's, so this says which subagent asked.
    const subagent = agent.expedition ? agent.subagentFor?.(toolUseID, agentID) || null : null;
    // An expedition agent's settings files are never written (spec lesson 9): denied at every level, logged, not parked.
    if (agent.expedition && writesSettingsFile(toolName, input)) return Promise.resolve(this.denyQuiet(p, agent, toolName, input, 'it edits a Claude Code settings file, which an expedition never changes', { subagent }));
    // Decision 66: while work in this project is paused, every new request that is not a plain read comes to you as a
    // card, whatever the level or the check would have said (workers are told to stop; a request already waiting
    // with the orchestrator or the check carries on).
    const paused = this.isPaused(p);
    // The Expedition module (plan 2a, route 8): while paused an expedition's request is never a card (decision 71). It is
    // denied with "wait", logged in the agent's own thread, and not parked.
    if (paused && agent.expedition) {
      const i = input || {};
      p.log.append('permission_answer', { thread: agent.thread, approval: null, worker: agent.name, workerThread: agent.thread, tool: toolName, command: String(i.command || i.file_path || i.url || JSON.stringify(i)).slice(0, 400), answer: 'deny', reason: 'paused, wait', by: 'hub', expedition: agent.expedition });
      return Promise.resolve({ behavior: 'deny', message: 'Work in this project is paused: wait until it is resumed, then ask again. This is not parked.' });
    }
    // Research is the point of an expedition: its gatherers, Skeptic and Verifier read ordinary web pages without a listed site.
    const page = agent.expedition && toolName === 'WebFetch' ? this.expeditionPageRead(p, agent, input, subagent) : null;
    if (page) return Promise.resolve({ behavior: 'allow', updatedInput: input });   // like a listed site: it just runs, no answer line
    // Decision 64: a merge you already said yes to in a card goes through at once, logged (lib/merge-pass.mjs).
    // (An expedition agent never has a merge pass: merging is blocked outright, spec 4.6.)
    const pass = paused || agent.expedition ? null : findPass(p.log.events, toolName, input, { dir: p.dir, agent: agent.name, ...(this.gitOrigin ? { origin: this.gitOrigin } : {}) });
    if (pass) {
      p.log.append('permission_answer', { thread: 'orchestrator', approval: null, worker: agent.name, workerThread: agent.thread, tool: toolName, command: String(input?.command || '').slice(0, 400), answer: 'allow', reason: this.memory.personalize(`pre-approved by {{who}}'s answer on ${pass.card} (${pass.asker})`), by: 'hub', pass: pass.pass, passNumber: pass.number });
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    // Decision 64 A: the checker starts in the folder this tool call runs in (toolUseID -> the hook's cwd).
    const route = paused ? this.pausedRoute(p, agent, toolName, input, toolUseID) : this.routeFor(p, agent, toolName, input, toolUseID);
    // The Expedition module (phase 4): a plain write into the frozen success test is refused, not parked (nothing to propose).
    if (route.denied) return Promise.resolve(this.denyQuiet(p, agent, toolName, input, route.denied, { subagent }));
    // The Expedition module (decision 71): a request that would be a card, or go to the orchestrator, is parked instead.
    if (route.parked) return Promise.resolve(this.parkRequest(p, agent, toolName, input, route.parked, { subagent }));
    if (route.logged) {
      const i = input || {};
      p.log.append('permission_answer', { thread: 'orchestrator', approval: null, worker: agent.name, workerThread: agent.thread, tool: toolName, command: String(i.command || i.file_path || i.url || JSON.stringify(i)).slice(0, 400), answer: 'allow', reason: `Auto mode, its own request: not fully readable (${route.logged.join('; ')}), no hard stop in it`, by: 'hub' });
    }
    // Test hubs this request starts (plan A7) count as this agent's only once the request is allowed, by the hub or by an answer.
    const starts = this.startsOf?.agent === agent ? this.startsOf.ports : [];
    this.startsOf = null;
    const noteStarts = () => { agent.testHubs ||= new Set(); for (const port of starts) agent.testHubs.add(port); };
    // Decision 67 (its routing stays, decision 73): with the check on or in shadow, Auto's "it runs a script inside the project" is looked at first.
    if (route.allow && route.scriptGate) return this.gateScript(p, agent, toolName, input, route, { signal, title, description, suggestions, noteStarts, subagent });
    if (route.allow) { noteStarts(); return Promise.resolve({ behavior: 'allow', updatedInput: input }); }   // auto mode, contained (decision 34)
    // An expedition's request the check is to judge: asked on the spot, with no card and no waiting entry (decision 71).
    if (agent.expedition && route.check) return this.quietCheck(p, agent, toolName, input, route, { signal, noteStarts, subagent });
    return this.openApproval(p, agent, toolName, input, route, { signal, title, description, suggestions, noteStarts });
  }

  // A plain page read for an expedition agent (spec section 1 and decision 71: research is the point): why it is allowed, or
  // null (then the usual rules judge it: Matt's trusted sites, the check, parking). Only while the expedition is planning or
  // running (the Verifier's report pass after a stop too), by a gatherer, the Skeptic or the Verifier, never the Lead itself.
  // The address must read as a strict https page: no http, port, IP address, user info or odd spelling (parseHttpsUrl), and not
  // a machine-local name. Downloads (curl and the like), installs and anything that writes or sends are other tools, not this.
  expeditionPageRead(p, agent, input, subagent) {
    if (!subagent && !['skeptic', 'verifier'].includes(agent.expeditionRole)) return null;   // the Lead itself, the builder and the rest: usual rules
    let phase;
    try { phase = this.expeditionOf(p, agent).state().phase; } catch { return null; }
    if (!(phase === 'planning' || phase === 'running' || (phase === 'stopped' && agent.expeditionRole === 'verifier'))) return null;
    const u = parseHttpsUrl(input?.url);
    if (!u.ok || /\.(local|localhost|internal|intranet|lan|home|corp|private|test|invalid|example)$/.test(u.host)) return null;
    return `an ordinary https page (${u.host}): reading is the expedition's job`;
  }

  // ---------- an expedition's requests: no card, no orchestrator (decision 71; the full parking rules are phase 4) ----------
  // A request that would have been a card or gone to the orchestrator is denied with "parked" and logged twice: the answer
  // (in the agent's own thread) and an expedition_parked event the report lists. Repeats of the same request are one line.
  // subagent: { id, type } when a gatherer inside the Lead asked (plan 2b item 4).
  parkRequest(p, agent, toolName, input, reasons, { subagent = null } = {}) {
    const why = [].concat(reasons).filter(Boolean).join('; ') || 'the hub could not settle it';
    const i = input || {};
    const command = String(i.command || i.file_path || i.notebook_path || i.url || i.query || JSON.stringify(i)).slice(0, 400);
    p.log.append('permission_answer', { thread: agent.thread, approval: null, worker: agent.name, workerThread: agent.thread, tool: toolName, command, answer: 'deny', reason: `parked: ${why}`, by: 'hub', expedition: agent.expedition, ...(subagent ? { subagent } : {}) });
    const text = `${toolName}: ${command}`;
    const ex = this.expeditionOf(p, agent);
    try {
      if (!ex.state().parked.some(e => e.kind === 'request' && e.text === text)) ex.park({ text, reason: why, maker: agent.name, kind: 'request', tool: toolName, ...(subagent ? { subagent } : {}) });
    } catch { /* the expedition is not started yet: the answer above is the record */ }
    return { behavior: 'deny', message: `Parked, not allowed: ${why}. Nobody is available to approve it during an expedition: work around it inside the brief, or stop that line of work and say so in your summary. It is listed in the report.` };
  }

  // A refusal that is not parked: logged in the agent's own thread, no card, nothing for the report to propose.
  denyQuiet(p, agent, toolName, input, why, { subagent = null } = {}) {
    const i = input || {};
    p.log.append('permission_answer', { thread: agent.thread, approval: null, worker: agent.name, workerThread: agent.thread, tool: toolName, command: String(i.command || i.file_path || i.notebook_path || i.url || JSON.stringify(i)).slice(0, 400), answer: 'deny', reason: why, by: 'hub', expedition: agent.expedition, ...(subagent ? { subagent } : {}) });
    return { behavior: 'deny', message: `Not allowed: ${why}.` };
  }

  // The one-shot permission check on an expedition's request (decision 66 where the check is on). Allow and deny settle it;
  // anything else (escalate, no valid answer) is parked. The orchestrator is never asked and no card opens.
  async quietCheck(p, agent, toolName, input, route, { signal, noteStarts = () => {}, subagent = null } = {}) {
    const id = randomUUID();
    const a = { p, agent, toolName, input, route, routedTo: CHECK_NAME, subagent };
    let res;
    try { res = await this.checker.run(await this.checkRequest(a)); }
    catch (e) { res = { valid: false, error: e?.message || String(e), model: CHECK_MODEL }; }
    try { this.logCheckUsage(p, id, res, false, agent.expedition); } catch (e) { console.warn('Check usage not logged:', e?.message || e); }
    if (signal?.aborted) return { behavior: 'deny', message: 'Cancelled' };
    const extra = { model: res.model || CHECK_MODEL };
    if (res.valid && res.answer === 'allow') { this.logAnswer(a, id, 'allow', res.reason, CHECK_NAME, extra); noteStarts(); return { behavior: 'allow', updatedInput: input }; }
    if (res.valid && res.answer === 'deny') { this.logAnswer(a, id, 'deny', res.reason, CHECK_NAME, extra); return { behavior: 'deny', message: `The permission check declined: ${res.reason}` }; }
    return this.parkRequest(p, agent, toolName, input, res.valid ? `the permission check could not settle it: ${res.reason}` : `the permission check gave no valid answer (${res.error})`, { subagent });
  }

  // The card, its waiting entry and its timer: a request that is not settled on the spot. waitedMs: time already spent on
  // this request (the script look-up of decision 67), so the 5 minutes still run from the original request.
  openApproval(p, agent, toolName, input, route, { signal, title, description, suggestions, waitedMs = 0, noteStarts = () => {} } = {}) {
    // Belt and braces (decision 71): no path may open a card or wait for the orchestrator for an expedition's agent.
    if (agent.expedition) return Promise.resolve(this.parkRequest(p, agent, toolName, input, route.stops?.length ? route.stops : 'it would have been a card'));
    return new Promise(resolvePromise => {
      const id = randomUUID();
      const always = CommandPolicy.alwaysRules(toolName, input, suggestions);
      const finish = (result, how) => {
        const a = this.approvals.get(id);
        if (!a) return;
        if (result?.behavior === 'allow') noteStarts();
        clearTimeout(a.timer);
        this.approvals.delete(id);
        p.log.append('approval_result', { thread: agent.thread, approval: id, how });
        resolvePromise(result);
      };
      const entry = { p, agent, toolName, input, finish, always, routedTo: route.to, escalated: false, route };
      this.approvals.set(id, entry);
      p.log.append('approval', { thread: agent.thread, approval: id, agent: agent.name, tool: toolName, input, title: title || null, description: description || null, always: always ? CommandPolicy.describe(always) : null, summary: CommandSummary.of(toolName, input), routedTo: route.to, stops: route.stops, rules: route.rules, ...listable(toolName, input) });
      signal?.addEventListener('abort', () => finish({ behavior: 'deny', message: 'Cancelled' }, 'cancelled'));
      // The orchestrator's own turn is blocked while a hard-stop card of its own waits for you, so it cannot read a worker's
      // request: that one comes to you at once. Routing returns to normal when the orchestrator's card is answered.
      if (route.to && route.to !== CHECK_NAME && this.orchestratorBlocked(p, route.to, entry)) {
        this.escalate(id, `${route.to} is waiting for you on a card of its own`, 'hub');
        return;
      }
      if (route.to) {
        entry.timer = setTimeout(() => this.escalate(id, `No answer within ${this.timeoutLabel()}`, 'hub'), Math.max(0, this.settings.get('permissionTimeoutSec') * 1000 - waitedMs));
        entry.timer?.unref?.();   // the server keeps the process alive; a waiting request alone should not
        if (route.check) this.runCheck(id, entry);   // the 5 minutes above run from this request, whatever the check says
        else {
          // Shadow mode changes nothing live: the request goes to the orchestrator at once, as today, with no note about the
          // check. What the check would have answered is only logged, in check_shadow.
          try { p.agents.get(route.to).send(this.permissionMessage(p, p.agents.get(route.to), id, agent, toolName, input, route.rules, route.unsure, route.cwd), [], { approval: id }); }
          catch (e) { this.escalate(id, `Could not reach the orchestrator: ${e.message}`, 'hub'); }
          if (route.shadow) this.runShadow(id, entry);
        }
      }
    });
  }

  // ---------- the one-shot permission check (decision 66, plan v3 Track B) ----------
  // Per project: 'off' (default), 'shadow' or 'on'. Kept in hub settings only, never read from the repo; turning it
  // on needs the step-up (lib/guard.mjs settingsNeed).
  checkMode(p) { return this.settings.project?.(p.dir)?.permissionCheck || 'off'; }

  setCheckMode(p, mode, by = 'you') {
    if (!CHECK_MODES.includes(mode)) return this.checkMode(p);
    const was = this.checkMode(p);
    this.settings.setProject(p.dir, { permissionCheck: mode });
    if (mode === was) return mode;
    p.log.append('project_settings', { permissionCheck: mode, was, by, thread: 'orchestrator' });
    const who = by === 'you' ? 'You' : by;
    this.notice(p, 'orchestrator', {
      off: `${who} turned the permission check off for ${p.name}: workers' unclear requests come to the orchestrator first, as before.`,
      shadow: `${who} put the permission check in shadow mode for ${p.name}: it reads each request beside the orchestrator and only logs what it would have said. You still answer as before.`,
      on: `${who} turned the permission check on for ${p.name}: a one-shot model check answers workers' unclear requests instead of you, with allow, deny or escalate (an escalation goes to {{who}}). You are asked only when it gives no valid answer, and its denials and escalations are noted for you at your next turn. Hard stops still come to {{who}}.`
    }[mode]);
    // Requests the orchestrator or the check hold now are not taken back: they finish where they are.
    return mode;
  }

  // The hub-level pause (decision 66, plan B6): every new permission request is held as a card for you, and workers are
  // told to stop at their next turn. Kept in hub settings, so it survives a restart.
  isPaused(p) { return !!this.settings.project?.(p.dir)?.paused; }

  setPaused(p, on, by = 'you') {
    on = !!on;
    const was = this.isPaused(p);
    this.settings.setProject(p.dir, { paused: on });
    if (was === on) return on;
    p.log.append('project_settings', { paused: on, by, thread: 'orchestrator' });
    const who = by === 'you' ? 'You' : by;
    this.notice(p, 'orchestrator', on
      ? `${who} paused work in ${p.name}: every new permission request now comes to {{who}} as a card, and workers were told to stop at their next turn.`
      : `${who} resumed work in ${p.name}: permission requests are answered as before, and workers were told to carry on.`);
    const msg = on ? PAUSE_TO_WORKERS : RESUME_TO_WORKERS;
    for (const w of p.workers({ all: true })) {   // an expedition's members are workers: they are told to stop too
      if (!w.live && !this.noAgents) continue;   // asleep: it reads nothing until it is woken, and then by a real message
      try { w.send(msg); } catch { /* retiring or retired */ }
    }
    const orch = p.orchestrator();
    orch?.noteForNextTurn(on ? PAUSE_TO_ORCH : RESUME_TO_ORCH);
    return on;
  }

  // What the check is sent for one waiting request (see permission-check.mjs buildPrefix / buildSuffix).
  checkRequest(a) {
    const { p, agent, toolName, input, route } = a;
    const rules = this.rulesFor(p);
    const cwd = route.cwd || p.dir;
    return {
      project: p.name, dir: p.dir, temp: tmpdir(), level: { standard: 'Ask', auto: 'Auto', trusted: 'Trusted' }[this.permissionMode(p)],
      rulesId: rules?.entryId, rulesBody: rules?.body, worker: agent.name,
      goal: agent.goal || String(agent.task || '').split('\n')[0].slice(0, 200),
      tool: toolName, input, cwd, doubts: route.unsure || [], scripts: route.scripts || [],
      madeTemp: [...(agent.tempDirs || [])],   // the temp folders this agent made, the hub's own record (R005: its own to delete)
      testPorts: [...(agent.testHubs || [])]   // plan A7: the test hubs this agent started, the hub's own record
    };
  }

  // The checker, made on first use. The API when a key is set up for the hub (CRUX_HUB_USE_API_KEY=1 with
  // ANTHROPIC_API_KEY, the same switch the agents use); else the Agent SDK on this machine's sign-in.
  get checker() {
    if (this.checkerMade) return this.checkerMade;
    const key = this.apiKey();
    const call = key ? apiCall({ apiKey: key }) : async arg => {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      return sdkCall({ query, claudePath: this.claudeCode?.() || null, env: checkEnv(), cwd: tmpdir() })(arg);
    };
    return (this.checkerMade = new PermissionCheck({ call }));
  }

  // The check's usage: one `usage` event, filed under the type "check" in the usage panel (role check). `via` says
  // whether it went through the SDK (plan usage) or the API (money); listUSD is the list-price estimate of either.
  // expedition: the id when the request was an expedition agent's, so its spend counts toward the expedition's budget.
  logCheckUsage(p, id, res, shadow, expedition = null) {
    if (!res?.modelUsage || !Object.keys(res.modelUsage).length) return;
    const models = totalsOf(res.modelUsage);
    p.log.append('usage', { agent: CHECK_NAME, project: p.name, agentType: 'check', role: 'check', model: res.model || CHECK_MODEL, effort: null, models, costUSD: sumCost(models), listUSD: res.listUSD ?? null, via: res.via || null, approval: id, ...(shadow ? { shadow: true } : {}), ...(expedition ? { expedition } : {}) });
  }

  // The check answered (or failed) for a request it holds: apply it. A request you answered, or that timed out or was
  // cancelled while the check ran, is left alone (the 5-minute timer runs from the original request).
  // Never rejects: whatever goes wrong, the request falls back (to the orchestrator, or to you) instead of hanging
  // until the timer, and nothing is left as an unhandled rejection.
  async runCheck(id, a) {
    try {
      let res;
      try { res = await this.checker.run(await this.checkRequest(a)); }
      catch (e) { res = { valid: false, error: e?.message || String(e), model: CHECK_MODEL }; }
      try { this.logCheckUsage(a.p, id, res, false); } catch (e) { console.warn('Check usage not logged:', e?.message || e); }
      if (this.approvals.get(id) !== a || a.escalated || a.routedTo !== CHECK_NAME) return;
      this.settleFromCheck(id, a, res);
    } catch (e) {
      try { if (this.approvals.get(id) === a && !a.escalated) this.escalate(id, `The permission check's answer could not be applied: ${e?.message || e}`, 'hub'); }
      catch (e2) { console.warn('Permission check failed:', e2?.message || e2); }
    }
  }

  settleFromCheck(id, a, res) {
    const p = a.p, orch = this.liveOrchestrator(p);
    const extra = { model: res.model || CHECK_MODEL };
    if (!res.valid) {   // no valid answer: the orchestrator decides as it did before the check; with none running, you
      const why = `The permission check gave no valid answer (${res.error})`;
      if (orch) return this.fallBackToOrchestrator(id, a, orch, why, extra);
      return this.escalate(id, `${why}, and no orchestrator is running`, CHECK_NAME);
    }
    const reason = res.reason;
    if (res.answer === 'allow') {
      this.logAnswer(a, id, 'allow', reason, CHECK_NAME, extra);
      return a.finish({ behavior: 'allow', updatedInput: a.input }, `allowed by ${CHECK_NAME}`);
    }
    if (res.answer === 'deny') {
      this.logAnswer(a, id, 'deny', reason, CHECK_NAME, extra);
      this.noteCheck(p, 'denied', a, reason);
      return a.finish({ behavior: 'deny', message: `The permission check declined: ${reason}` }, `denied by ${CHECK_NAME}`);
    }
    this.noteCheck(p, 'sent to you', a, reason);   // escalate: a card for you, as when the orchestrator escalates
    return this.escalate(id, reason, CHECK_NAME);
  }

  // Does this orchestrator have a hard-stop card of its own waiting for you (so it cannot read anything else)?
  orchestratorBlocked(p, name, except) {
    return [...this.approvals.values()].some(a => a !== except && a.p === p && !a.routedTo && a.agent.name === name);
  }

  // The check gave no valid answer (a bad reply, a model error, a timeout): the request now waits with the orchestrator, as it
  // would without the check. Its timer is still the original one. Logged as a "consult" line: the hub's own note that it passed on.
  fallBackToOrchestrator(id, a, orch, why, extra) {
    if (this.orchestratorBlocked(a.p, orch.name, a)) {   // its turn is blocked on a card of its own: straight to you
      a.routedTo = orch.name;
      return this.escalate(id, `${orch.name} is waiting for you on a card of its own`, CHECK_NAME);
    }
    this.logAnswer(a, id, 'consult', why, CHECK_NAME, extra);
    a.routedTo = orch.name;
    const said = `${why}, so it comes to you.`;
    try { orch.send(this.permissionMessage(a.p, orch, id, a.agent, a.toolName, a.input, a.route.rules, a.route.unsure, a.route.cwd, said), [], { approval: id }); }
    catch (e) { this.escalate(id, `Could not reach the orchestrator: ${e.message}`, 'hub'); }
  }

  // Shadow mode: the check reads the same request the orchestrator was sent and writes one `check_shadow` line. It has
  // no answer tool and touches nothing; hub/tools/permission-study.mjs --check compares it with the real answer.
  // Never rejects (a shadow run must not be able to disturb the real request).
  async runShadow(id, a) {
    try {
      let res;
      try { res = await this.checker.run(await this.checkRequest(a)); }
      catch (e) { res = { valid: false, error: e?.message || String(e), model: CHECK_MODEL }; }
      try { this.logCheckUsage(a.p, id, res, true, a.agent.expedition || null); } catch (e) { console.warn('Check usage not logged:', e?.message || e); }
      const i = a.input || {};
      // No thread: it is a log line for the study tool, not a message, so it never counts as unread in any thread.
      a.p.log.append('check_shadow', {
        approval: id, worker: a.agent.name, tool: a.toolName,
        command: String(i.command || i.file_path || i.notebook_path || i.url || i.query || JSON.stringify(i)).slice(0, 400),
        valid: !!res.valid, answer: res.valid ? res.answer : null, reason: res.valid ? res.reason : res.error,
        model: res.model || CHECK_MODEL, ...(a.agent.expedition ? { expedition: a.agent.expedition } : {}), ms: res.ms ?? null
      });
    } catch (e) { console.warn('Shadow check failed:', e?.message || e); }
  }

  // The orchestrator hears of the check's denials and escalations at its next turn (it does not wake for them).
  noteCheck(p, what, a, reason) {
    if (a.agent.expedition) return;   // an expedition's denials go to the agent that asked and to the log only
    const orch = p.orchestrator();
    if (!orch || (orch.notes?.length || 0) >= 40) return;
    const i = a.input || {};
    const cmd = String(i.command || i.file_path || i.notebook_path || i.url || i.query || JSON.stringify(i)).replace(/\s+/g, ' ').slice(0, 160);
    orch.noteForNextTurn(`[From the hub] The permission check ${what} ${a.agent.name}'s ${a.toolName} request: ${cmd} (${reason})`);
  }

  // Plan B5: once a week, 10 random allows the check gave go into one line list for you, so a mistake both the check
  // and the orchestrator would make is looked at too. The week starts at the last list, else at the first allow.
  // Returns the event, or null.
  auditAllows(p, { now = Date.now(), rng = Math.random, count = 10 } = {}) {
    const evs = p.log.events;
    const last = evs.findLast(e => e.type === 'check_audit');
    const allows = evs.filter(e => e.type === 'permission_answer' && e.by === CHECK_NAME && e.answer === 'allow');
    const since = last ? Date.parse(last.ts) : (allows.length ? Date.parse(allows[0].ts) : now);
    if (now - since < WEEK_MS) return null;
    const fresh = allows.filter(e => Date.parse(e.ts) > since || !last);
    if (!fresh.length) return null;
    const pool = [...fresh];
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const items = pool.slice(0, count).map(e => ({ worker: e.worker, tool: e.tool, command: String(e.command || '').slice(0, 240), reason: String(e.reason || '').slice(0, 200), when: e.ts }));
    return p.log.append('check_audit', { thread: 'orchestrator', total: fresh.length, items });
  }
  auditChecks(now = Date.now()) {
    for (const p of this.projects.values()) { try { if (this.checkMode(p) !== 'off') this.auditAllows(p, { now }); } catch (e) { console.warn('Check audit failed:', e.message); } }
  }

  // Where a request goes: { allow } in auto mode for contained work; else { to: orchestrator name | null,
  // stops: [why it comes to you], rules: entry id | null }. Hard stops always come to you.
  // Auto mode (decision 34, R004): only requests the hub cannot classify go to the orchestrator.
  // Standard mode (decision 21): everything that is not a hard stop goes to the orchestrator.
  // toolUseID: the SDK's id for this tool call, so the folder the agent's command really runs in (its worktree, from
  // the hook in agent.mjs) is the one the checker starts from (decision 64 A); unknown: the project folder, as before.
  routeFor(p, agent, toolName, input, toolUseID = null) {
    const rules = this.rulesFor(p);
    agent.tempDirs ||= new Set();
    const level = this.permissionMode(p);
    const cwd = agent.cwdFor?.(toolUseID) || null;
    agent.downloads ||= new Set();
    agent.testHubs ||= new Set();   // plan A7: ports of the test hubs this agent started; it may stop only those
    // A10: the project's record of downloaded files (its event log) counts for every agent, across restarts; Matt's lists.
    // Everything inside a quarantine folder (any project's) counts as downloaded too: running it, or a copy of it, is a stop.
    const marks = quarantineMarks(tmpdir());
    const known = new Set([...downloadsFrom(p.log.events), ...marks]);
    // Phase 4: an expedition agent's classify also gets its frozen folders, and its launch's pre-approvals as an overlay on
    // Matt's lists (never saved into them). Both come from the hub's own record of the agent's expedition.
    const c = classify({ tool: toolName, input, projectDir: p.dir, cwd, agent: agent.name, madeTemp: agent.tempDirs, downloaded: [...agent.downloads, ...known], hubs: agent.testHubs, level, lists: this.lists?.forProject(p.dir, this.expeditionOverlay(p, agent)), frozen: this.frozenDirs(p, agent), expeditionRoot: agent.expedition ? this.expeditionOf(p, agent).root : null });
    if (c.frozen) return { denied: c.reasons[0] };
    // A plain mistake: an existing project file changed with a command-line script (sed -i, an inline node or python script, ...).
    // Refused at once as a deny, with no card, no orchestrator and no check call (M042: mistakes, not disguise).
    if (c.rewrite && c.route !== 'human') return { denied: c.rewrite };
    for (const d of c.downloaded || []) if (!known.has(d)) p.log.append('download', { path: d, agent: agent.name, thread: agent.thread, ...(c.downloads?.find(x => x.path.toLowerCase().replace(/\\/g, '/') === d) || {}) });
    const { route, tempMade } = c;
    this.startsOf = { agent, ports: route === 'human' ? [] : c.hubsStarted || [] };   // noted in requestApproval, once the request is allowed
    const [reasons, unsure] = [c.reasons, c.unsure].map(l => l.map(s => this.memory.personalize(s)));   // they reach cards: the user's own name
    for (const d of tempMade) agent.tempDirs.add(d);   // temp folders it makes are its own to delete later (R005)
    // Files it downloads: running one in a later request is a stop too (review of decision 64 A). The newest 200.
    for (const d of c.downloaded || []) { agent.downloads.delete(d); agent.downloads.add(d); }
    while (agent.downloads.size > 200) agent.downloads.delete(agent.downloads.values().next().value);
    // The Expedition module (decision 71): what would be a card is parked. A hard stop is never run, only logged and parked.
    if (route === 'human') return agent.expedition ? { parked: reasons.length ? reasons : ['a hard stop'] } : { to: null, stops: reasons, rules: rules?.entryId || null };
    if (route === 'allow' && this.autoLike(p)) return this.scriptGateFor(p, agent, toolName, input, cwd, rules) || { allow: true };
    // The orchestrator's own unclear requests have no one to route to: in auto mode, with no hard stop in them,
    // they are allowed and logged in its thread for Matt to audit.
    // Never a connector or any other MCP server's tool (plugin servers can reach mail and calendar too): the
    // orchestrator's own requests for those come to Matt as a card.
    // Nor one that runs text the hub cannot read as a command (iex ('git pu' + 'sh'), [scriptblock]::Create), or a
    // wrapper (sh -c, xargs, Start-Process) fed a variable or a built-up argument: it could hide any hard stop, so it
    // comes to you (review of M039, round 1). A wrapper with plain words (xargs wc -l, cmd /c npm start) is allowed and
    // logged like any other unclear request (round 2: notice volume).
    const opaqueRun = c.unsure.some(u => /^Runs text as a command/.test(u))
      || (c.unsure.some(u => /^Runs commands the hub cannot read/.test(u)) && c.unsure.some(u => /^(Uses a variable|An argument in brackets|Command substitution)/.test(u)));
    if (route === 'unsure' && agent.role === 'orchestrator' && this.autoLike(p) && !opaqueRun && !connectorTool(toolName) && !/^mcp__(?!crux__)/.test(toolName)) return { allow: true, logged: unsure };
    if (agent.role !== 'worker') return { to: null, stops: [], rules: null };
    // An expedition's unclear request goes to the one-shot check where it is on, and is otherwise parked: never to the
    // orchestrator (it stays out) and never to a card. Not for connectors or other MCP tools, as for everyone.
    if (agent.expedition) {
      const checked = this.checkMode(p) === 'on' && !connectorTool(toolName) && !/^mcp__/.test(toolName) && this.settings.get('routePermissions') && rules;
      return checked ? { to: CHECK_NAME, check: true, stops: [], rules: rules.entryId, unsure, cwd } : { parked: unsure.length ? unsure : ['the hub could not settle it at this level'] };
    }
    if (!this.settings.get('routePermissions') || !rules) return { to: null, stops: [], rules: rules?.entryId || null };
    // A resting orchestrator (asleep since a restart, or between turns) is woken by the request, so the card does not
    // jump to your phone just because it was asleep. It still comes to you on escalate or after the timeout.
    const orch = this.liveOrchestrator(p);
    // Decisions 66 and 73: with the permission check on for this project, it answers instead of the orchestrator, even when no
    // orchestrator is running (an escalate comes to you, as the orchestrator's would). In shadow mode the orchestrator answers as before and the
    // check runs beside it, only logging.
    // Never a connector (mail, calendar, drive) or any other MCP tool: R006 keeps those with the orchestrator or you, and
    // their content is not sent to a model for a verdict. They go to the orchestrator as before, even in shadow mode.
    const mode = connectorTool(toolName) || /^mcp__/.test(toolName) ? 'off' : this.checkMode(p);
    if (mode === 'on') return { to: CHECK_NAME, check: true, stops: [], rules: rules.entryId, unsure, cwd };
    if (!orch) return { to: null, stops: [], rules: rules.entryId };
    return { to: orch.name, stops: [], rules: rules.entryId, unsure, cwd, ...(mode === 'shadow' ? { shadow: true } : {}) };
  }

  // Decision 67 (routing kept by decision 73): a worker request Auto allows only because it runs a script inside the project is not
  // simply allowed when the permission check is on (or in shadow) for the project: the script chain must be committed and
  // unchanged from main first (gateScript). Off: unchanged. Returns { allow: true, scriptGate } to be looked at, or null for
  // "allow as today". Only a request that starts a script, a package script, a shell string or code written in the command is
  // looked at, so a plain `git status` never waits for git. Never a connector or other MCP tool, the orchestrator's own
  // requests, or anything when routing is off or there are no rules (nothing then asks the check).
  scriptGateFor(p, agent, toolName, input, cwd, rules) {
    if (agent.role !== 'worker' || !rules || !this.settings.get('routePermissions') || !/^(Bash|PowerShell)$/.test(toolName)) return null;
    const mode = this.checkMode(p);
    if (mode === 'off') return null;
    const c = parseCommand(String(input?.command || ''), { shell: toolName === 'PowerShell' ? 'powershell' : 'bash', cwd: cwd || p.dir });
    // An unread part counts unless it is just a program the reader does not know with no path or script among its words
    // (docker ps, gh pr view): Auto allows that as today.
    if (!(c.files.length || c.runners.length || c.inline.length || c.nested.length || c.unread.some(u => !u.prog || u.pathy))) return null;
    return { allow: true, scriptGate: { mode, cwd: cwd || p.dir, rules: rules.entryId, since: Date.now() } };
  }

  // Decision 67. Committed and unchanged scripts (and nothing else unread) stay allowed at once. A worker-written, changed
  // or unread chain: with the check on, the check judges it plainly from the request, like any request the hub could not
  // settle (the 5 minutes run from the request); in shadow mode it is allowed as today and the check reads the request and
  // writes a check_shadow line. The text of an uncommitted or changed script is sent with the request, capped (M054).
  async gateScript(p, agent, toolName, input, route, { signal, title, description, suggestions, noteStarts = () => {}, subagent = null } = {}) {
    const g = route.scriptGate;
    // In shadow mode the answer is allow whatever the look-up finds, so the worker is not made to wait for it (the walk of a
    // script's chain took seconds): it is allowed at once, and the look-up, the permission_answer line and the check run beside it.
    if (g.mode === 'shadow') {
      noteStarts();
      this.shadowGate(p, agent, toolName, input, g, subagent);
      return { behavior: 'allow', updatedInput: input };
    }
    const look = await this.lookUpScripts(p, toolName, input, g);
    if (look.clean) { noteStarts(); return { behavior: 'allow', updatedInput: input }; }
    if (signal?.aborted) return { behavior: 'deny', message: 'Cancelled' };
    const checkRoute = { to: CHECK_NAME, check: true, stops: [], rules: g.rules, unsure: look.unsure, cwd: g.cwd, scripts: look.shown };
    if (agent.expedition) return this.quietCheck(p, agent, toolName, input, checkRoute, { signal, noteStarts, subagent });   // no card, no waiting entry
    return this.openApproval(p, agent, toolName, input, checkRoute, { signal, title, description, suggestions, waitedMs: Date.now() - g.since, noteStarts });
  }

  // What the script gate learns about the scripts a command runs: { clean: true } when every one is committed and unchanged, else
  // { clean: false, unsure, shown }: the hub's reasons (ordinary doubts for the model, decision 73) and the text of the changed
  // files, or why they are not shown (permission-check.mjs scriptTexts).
  async lookUpScripts(p, toolName, input, g) {
    let scripts = null;
    const git = this.checkGit || undefined;
    try {
      scripts = await scriptsFor(String(input?.command || ''), { cwd: g.cwd, projectDir: p.dir, shell: toolName === 'PowerShell' ? 'powershell' : 'bash', ...(git ? { git } : {}) });
    } catch (e) { console.warn('Script look-up failed:', e?.message || e); }
    if (!!scripts && !scripts.unread && scripts.scripts.every(s => s.kind === 'committed')) return { clean: true };
    const unsure = [scripts ? 'Auto mode would allow it because it runs a script inside the project, but that script (or something it loads) is not committed and unchanged from main'
      : 'Auto mode would allow it because it runs a script inside the project, and the hub could not look at the script'];
    let shown = [];
    try { shown = await scriptTexts(scripts ? scripts.scripts : [], { diff: file => changedDiff(file, git ? { git } : {}) }); } catch (e) { console.warn('Script text not read:', e?.message || e); }
    // Everything else the hub could not read is an ordinary doubt for the model to weigh, as for any request (decision 73), one
    // line per file: it is not a reason to escalate by itself.
    for (const s of scripts?.scripts || []) {
      if (s.kind === 'uncommitted') unsure.push(...(s.doubts || []));
      else if (s.kind !== 'committed' && s.notShown !== true) unsure.push(`${s.path}: ${s.note || 'the hub could not resolve it to a file'}`);
    }
    for (const l of scripts?.inlineLoads || []) unsure.push(`code written in the command loads something the hub has not seen (${l})`);
    return { clean: false, unsure: [...new Set(unsure)], shown };
  }

  // Shadow mode, beside the worker (never awaited by it): look at the scripts, and when they are not all committed and unchanged,
  // log the hub's allow under a request id and let the check read the request, so the study can compare. Never rejects.
  async shadowGate(p, agent, toolName, input, g, subagent = null) {
    try {
      const look = await this.lookUpScripts(p, toolName, input, g);
      if (look.clean) return;
      const id = randomUUID();
      const i = input || {};
      // An expedition agent's line is filed in its own thread and tagged, never in the orchestrator's (decision 71).
      p.log.append('permission_answer', { thread: agent.expedition ? agent.thread : 'orchestrator', approval: id, worker: agent.name, workerThread: agent.thread, tool: toolName, command: String(i.command || '').slice(0, 400), answer: 'allow', reason: 'Auto mode: it runs a script inside the project (the check reads it in shadow mode only)', by: 'hub', ...(agent.expedition ? { expedition: agent.expedition, ...(subagent ? { subagent } : {}) } : {}) });
      await this.runShadow(id, { p, agent, toolName, input, route: { unsure: look.unsure, cwd: g.cwd, rules: g.rules, scripts: look.shown } });
    } catch (e) { console.warn('Shadow script gate failed:', e?.message || e); }
  }

  // While paused: a card for you. If the request is also a hard stop, its reasons stay on the card next to the pause, so
  // you can see what you are letting through. (classify here is only read; nothing it learns is kept.)
  pausedRoute(p, agent, toolName, input, toolUseID = null) {
    const stops = [this.memory.personalize(PAUSE_STOP)];
    try {
      const c = classify({ tool: toolName, input, projectDir: p.dir, cwd: agent.cwdFor?.(toolUseID) || null, agent: agent.name, madeTemp: new Set(agent.tempDirs || []), downloaded: new Set(agent.downloads || []), level: this.permissionMode(p) });
      if (c.route === 'human') stops.push(...c.reasons.map(s => this.memory.personalize(s)));
    } catch { /* the pause alone is reason enough for the card */ }
    return { to: null, stops, rules: this.rulesFor(p)?.entryId || null };
  }

  // The orchestrator that can take a request: not retiring, not in error, not retired; null otherwise.
  liveOrchestrator(p) {
    const orch = p.orchestrator();
    return orch && !orch.retiring && !['error', 'retired'].includes(orch.state) ? orch : null;
  }

  // Per project: "standard", "auto" or "trusted" (shown as Ask, Auto and Trusted; decisions 34 and 45). The level set
  // in the page, kept in hub settings by project folder, wins; then the repo's committed .crux-hub.json
  // ({ "permissions": "auto" }) as the starting value; else standard. Trusted is set only from the hub page: a repo
  // file that asks for "trusted" gets Auto, so a cloned repo cannot trust itself.
  permissionMode(p) {
    const set = this.settings.project?.(p.dir)?.permissionMode;
    if (set) return ['auto', 'trusted'].includes(set) ? set : 'standard';
    try { return ['auto', 'trusted'].includes(JSON.parse(readFileSync(join(p.dir, '.crux-hub.json'), 'utf8')).permissions) ? 'auto' : 'standard'; } catch { return 'standard'; }
  }
  // Auto and Trusted both let contained work run without asking; Trusted allows a little more (permission-rules.mjs).
  autoLike(p) { return this.permissionMode(p) !== 'standard'; }

  setPermissionMode(p, mode, by = 'you') {
    mode = ['auto', 'trusted'].includes(mode) ? mode : 'standard';
    const was = this.permissionMode(p);
    this.settings.setProject(p.dir, { permissionMode: mode });
    if (mode === was) return mode;
    // Raised or lowered, and where from: the hub page (the settings card, by = 'you') or something else. The words
    // never claim a person did it; a raise to Trusted also goes to the owner's phone (push.mjs), so a raise nobody
    // made on purpose is seen at once.
    const rank = { standard: 0, auto: 1, trusted: 2 };
    const raised = rank[mode] > rank[was];
    p.log.append('project_settings', { permissionMode: mode, was, raised, by, thread: 'orchestrator' });
    const word = { standard: 'Ask', auto: 'Auto', trusted: 'Trusted' }[mode];
    const how = `The level of ${p.name} was ${raised ? 'raised' : 'lowered'} to ${word} ${by === 'you' ? 'from the hub page' : `by ${by}`}`;
    this.notice(p, 'orchestrator', {
      auto: `${how}: work that stays in the project or a temp folder runs without asking; unclear requests go to the orchestrator, hard stops to you.`,
      trusted: `${how}: as Auto, plus installing packages into the project and reading or downloading from any website into it. Merges still need your yes on each one; the fixed stops (force push, history, branch deletion, pushing to main, writes outside, secrets, the live hub, system-wide installs, connector sends) still come to you.`,
      standard: `${how}: anything beyond reading goes to the orchestrator first, hard stops to you.`
    }[mode]);
    if (mode !== 'standard') this.rulesHint(p);
    return mode;
  }

  // ---------- handoff numbers per project (decision 44 B; amends 10 and 37) ----------
  // Each project may set its own idle window, idle floor and context threshold; empty means the hub default.
  handoffNumbers(p) {
    return Object.fromEntries(Object.keys(HANDOFF_NUMBERS).map(k => [k, this.settings.projectNumber?.(p.dir, k) ?? this.settings.get(k)]));
  }
  // The project's own values only (null where it uses the hub default), for the settings card.
  ownHandoffNumbers(p) {
    const own = this.settings.project?.(p.dir) || {};
    return Object.fromEntries(Object.keys(HANDOFF_NUMBERS).map(k => [k, typeof own[k] === 'number' ? own[k] : null]));
  }
  retireAtFor(p) { return Number(this.handoffNumbers(p).retireAt) || this.retireAt; }
  // Workers hand off at the hub-wide worker mark (default 60), not the project's orchestrator mark (decision 46).
  workerRetireAt() { const v = Number(this.settings.get('workerRetireAt')); return v >= 1 && v <= 100 ? v : 60; }
  markFor(p, agent) { return agent.role === 'worker' ? this.workerRetireAt() : this.retireAtFor(p); }

  // changes: any of idleHandoffMin, idleFloorPct, retireAt (null or '' = back to the hub default). Noted in the
  // project's orchestrator thread when something changed.
  setHandoffNumbers(p, changes, by = 'you') {
    const pick = Object.fromEntries(Object.keys(HANDOFF_NUMBERS).filter(k => k in (changes || {})).map(k => [k, changes[k]]));
    if (!Object.keys(pick).length) return this.handoffNumbers(p);
    const before = JSON.stringify(this.ownHandoffNumbers(p));
    this.settings.setProject(p.dir, pick);
    const own = this.ownHandoffNumbers(p);
    if (JSON.stringify(own) === before) return this.handoffNumbers(p);
    const n = this.handoffNumbers(p);
    p.log.append('project_settings', { handoff: own, by, thread: 'orchestrator' });
    const mark = k => own[k] == null ? ' (hub default)' : '';
    this.notice(p, 'orchestrator', `${by === 'you' ? 'You' : by} changed ${p.name}'s handoff numbers: the orchestrator hands off at ${n.retireAt}% of its context${mark('retireAt')}, ${n.idleHandoffMin > 0 ? `or after ${n.idleHandoffMin} minutes idle${mark('idleHandoffMin')} when above ${n.idleFloorPct}%${mark('idleFloorPct')}` : `and never for being idle${mark('idleHandoffMin')}`}.`);
    return n;
  }
  get retireAt() { return Number(this.settings.get('retireAt')) || 60; }

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

  // ---------- Matt's trusted sites and approved packages (plan v3, A10) ----------
  // Only the page's own actions reach these (server.mjs, behind the write guard and a fresh step-up for adding): no
  // agent tool does. scope: 'all' (every project) or 'project' (this one only).
  listsView(p) {
    if (!this.lists) return { sites: [], packages: [], minAgeDays: 3, ecosystems: {}, scopeKey: projectKey(p.dir), project: p.name };
    const names = Object.fromEntries([...this.projects.values()].map(x => [projectKey(x.dir), x.name]));
    return { ...this.lists.view(names), scopeKey: projectKey(p.dir), project: p.name };
  }
  async addToLists(p, body = {}, by = 'you') {
    if (!this.lists) throw new Error('This hub cannot keep trusted lists.');
    const scope = body.scope === 'project' ? projectKey(p.dir) : 'all';
    const who = by === 'you' ? 'You' : by;
    const where = scope === 'all' ? 'every project' : p.name;
    if (body.kind === 'site') {
      const e = this.lists.addSite({ host: body.host, access: body.access || 'pages', pin: body.pin, scope, subdomains: body.subdomains, by });
      this.notice(p, 'orchestrator', `${who} added ${e.host}${e.pin || ''} to the trusted sites (${e.access}) for ${where}. Matching reads of it need no card${e.access === 'downloads' ? '; downloads go to a quarantine folder in temp and running them still comes to you' : ''}.`);
      return e;
    }
    if (body.kind === 'package') {
      // The version the project may move to on its own is the one it has now; for a fresh package, the latest at the time of approval.
      const eco = body.eco;
      const asked = eco === 'pip' ? pipName(String(body.name || '').trim()) : String(body.name || '').trim();
      const info = !this.noAgents && validPackage(eco, asked) && (eco === 'npm' || eco === 'pip') ? await this.lists.prime(eco, asked) : null;   // a test hub never calls out; this also fills the remembered answer
      const v = /^(\d+)\.(\d+)/.exec(String(info?.latest ?? ''));
      const e = this.lists.addPackage({ eco, name: body.name, scope, baseMajor: v ? Number(v[1]) : null, baseMinor: v ? Number(v[2]) : null, revision: body.revision, by });
      this.notice(p, 'orchestrator', `${who} added ${e.name} (${ECOSYSTEMS[e.eco] || e.eco}) to the approved packages for ${where}. Installs of it need no card, except a release under 3 days old or a new major version.`);
      return e;
    }
    throw new Error('Add a site or a package.');
  }
  setListAccess(p, id, access, by = 'you') {
    if (!this.lists) throw new Error('This hub cannot keep trusted lists.');
    const e = this.lists.setAccess(id, access);
    this.notice(p, 'orchestrator', `${by === 'you' ? 'You' : by} ${access === 'downloads' ? 'allowed downloads from' : 'limited to pages'} ${e.host}${e.pin || ''}.`);
    return e;
  }
  removeFromLists(p, id, by = 'you') {
    if (!this.lists) throw new Error('This hub cannot keep trusted lists.');
    const e = this.lists.remove(id);
    if (!e) throw new Error('That entry is not on the list any more.');
    this.notice(p, 'orchestrator', `${by === 'you' ? 'You' : by} removed ${e.kind === 'site' ? `${e.host}${e.pin || ''} from the trusted sites` : `${e.name} (${ECOSYSTEMS[e.eco] || e.eco}) from the approved packages`}.`);
    return e;
  }

  // The rules the orchestrator answers under: the board's entry; in Auto mode with no entry, the hub's built-in
  // defaults (R005's text with this project's folders); in Ask mode with no entry, none (everything comes to you).
  rulesFor(p) {
    return rulesEntry(p.board) || (this.autoLike(p) ? defaultRules(p.dir, undefined, this.permissionMode(p)) : null);
  }

  // Once per project: in Auto with no rules entry, suggest the orchestrator draft one for Matt.
  rulesHint(p) {
    if (rulesEntry(p.board) || !this.autoLike(p) || p.log.ofType('rules_hint').length) return false;
    p.log.append('rules_hint', { thread: 'orchestrator' });
    this.notice(p, 'orchestrator', `${p.name} has no permission rules entry on its board, so the orchestrator answers unclear requests under the hub's built-in defaults (the crux rules, with this project's folders). Orchestrator: draft a rules entry for {{who}} to approve.`);
    return true;
  }

  timeoutLabel() { const s = this.settings.get('permissionTimeoutSec'); return s % 60 ? `${s} seconds` : `${s / 60} minute${s === 60 ? '' : 's'}`; }

  // What the orchestrator gets: the request id, the worker and its goal, the tool and its full input, and the rules.
  // The rules text is in its instructions; it is repeated here only when the board's rules changed since it started.
  // checkSaid (decision 66): what the permission check said when it passed the request on to the orchestrator.
  permissionMessage(p, orch, id, worker, toolName, input, rulesId, unsure = [], cwd = null, checkSaid = '') {
    const rules = this.rulesFor(p);
    const changed = rules && orch.rulesSeen !== `${rules.entryId}@${rules.ts}`;
    const shown = toolName === 'Bash' || toolName === 'PowerShell' ? `Command:\n${input.command}${input.description ? `\nIts description: ${input.description}` : ''}` : `Input:\n${JSON.stringify(input, null, 1)}`;
    return [
      `[Permission request ${id}]`,
      `Worker: ${worker.name}`,
      `Worker's goal: ${worker.goal || String(worker.task || '').split('\n')[0].slice(0, 200) || '(none given)'}`,
      `Tool: ${toolName}`,
      ...(cwd ? [`Runs in: ${cwd}`] : []),
      shown,
      unsure?.length ? `The hub found no hard stop, but could not classify it: ${unsure.join('; ')}.` : 'The hub found no hard stop in it.',
      checkSaid,
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
    // Plan B6: only the agent the request was routed to may answer it (not another worker or orchestrator).
    if (!orch || a.routedTo !== orch.name) return 'That request was not routed to you, so you cannot answer it.';
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

  // extra: more fields for the line (the check adds its model).
  logAnswer(a, id, answer, reason, by, extra = {}) {
    const i = a.input || {};
    // An expedition agent's answers are logged in its own thread, never the orchestrator's (decision 71), tagged with the
    // expedition and, when a gatherer inside the Lead asked, with which subagent (plan 2b item 4).
    const ex = a.agent.expedition ? { expedition: a.agent.expedition, ...(a.subagent ? { subagent: a.subagent } : {}) } : {};
    a.p.log.append('permission_answer', { thread: a.agent.expedition ? a.agent.thread : 'orchestrator', approval: id, worker: a.agent.name, workerThread: a.agent.thread, tool: a.toolName, command: String(i.command || i.file_path || i.notebook_path || i.url || i.query || JSON.stringify(i)).slice(0, 400), answer, reason, by, ...(by === CHECK_NAME ? { model: CHECK_MODEL } : {}), ...(answer === 'allow' ? listable(a.toolName, i) : {}), ...ex, ...extra });
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

  // The mid-turn warning level: the agent's own handoff mark plus 15 points, never above 85%.
  warnLevelFor(p, agent) { return Math.min(85, this.markFor(p, agent) + 15); }

  // Called by an agent when it has read its context size during a turn. One message per turn, once the level is passed:
  // it goes in as a normal message (the running turn takes it in), and the usual end-of-turn handoff follows (onIdle).
  // Not the Conductor, not a retiring agent, not an expedition member whose expedition is closing.
  midTurnWarn(p, agent) {
    const pct = agent.contextPct;
    if (pct == null || agent.warnedThisTurn || agent.role === 'conductor' || agent.retiring || agent.state === 'retired') return false;
    if (pct < this.warnLevelFor(p, agent) || this.expeditionClosing(p, agent)) return false;
    agent.warnedThisTurn = true;
    p.log.append('context_warning', { agent: agent.name, contextPct: pct, thread: agent.thread });
    agent.send(`[From the hub] You are at ${pct}% of your context. Finish the step you're on, post your summary with handoff notes, and end your turn; the hub hands ${agent.role !== 'worker' ? 'the role' : 'your task'} on after it.`);
    return true;
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
    // Phase 5: a Lead's turn ending is when its expedition's end can start (after a stop) and when every expedition agent
    // retires (after its summary). The watchdog's check sweeps the same thing every 30 seconds and after a restart.
    if (agent.expedition) { try { this.expeditionEnd.consider(p, agent.expedition); } catch (e) { console.warn('Expedition end:', e?.message || e); } }
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
    // Decision 62: a Conductor request it was given and did not answer gets one reminder, as a short follow-up turn,
    // before anything else, a threshold handoff included (that waits for the end of the reminder's turn).
    if (agent.role === 'orchestrator' && !p.hubWide && this.conductor?.remindReplies(p, agent)) return;
    // No handoff once the 90% note has gone, or the expedition has stopped: the Lead (or any member) finishes the write-up
    // itself, and the final turn must not land on an agent that is handing over (plan phase 2). Before 90% the threshold
    // handoff applies as for any worker.
    if (agent.contextPct != null && agent.contextPct >= this.markFor(p, agent) && !this.expeditionClosing(p, agent)) {
      this.notice(p, agent.thread, `${agent.name} is at ${agent.contextPct}% of its context; handing ${agent.role !== 'worker' ? 'the role' : 'its task'} on.`);
      this.retire(p, agent, { reason: 'threshold' });
      return;
    }
    if (p.hubWide) this.conductor?.afterTurn();   // updates that came in while it worked: one more turn for them
  }

  // reason: 'asked' (you, or the API), 'threshold' (decision 10), 'idle' (decision 37) or 'orchestrator' (a worker
  // handed on early, decision 46).
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
      const idle = agent.role !== 'worker' && (reason === 'idle' || Date.now() - this.lastActive(p, agent) >= DRAFT_FRESH_MS);
      this.notice(p, agent.thread, `${agent.name}'s handoff ${agent.leftHandoff} was written from its rolling draft (${when(draft.ts)}) plus fresh facts, without waking it.${idle ? ` The next ${agent.role === CONDUCTOR_ROLE ? 'Conductor' : 'orchestrator'} starts from it with your next message.` : ''}`);
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
  // so the next message reaches a fresh holder instead of a cold re-read of a long context. Both are read per project,
  // falling back to the hub defaults (decision 44 B).
  idleCheck(now = Date.now()) {
    const done = [];
    // The Conductor follows the same rule, with the hub's default numbers (its place has no settings of its own).
    for (const p of [...this.projects.values(), ...(this.conductor ? [this.conductor.home] : [])]) {
      const n = this.handoffNumbers(p);
      const windowMin = Number(n.idleHandoffMin), floor = Number(n.idleFloorPct);
      if (!(windowMin > 0)) continue;
      const o = p.orchestrator();
      if (!o || o.retiring || o.capture || !o.sessionId || ['working', 'starting', 'error'].includes(o.state)) continue;
      if (o.contextPct == null || o.contextPct < floor) continue;
      if ([...this.approvals.values()].some(a => a.routedTo === o.name && !a.escalated)) continue;
      const idleMin = Math.floor((now - this.lastActive(p, o, now)) / 60000);
      if (idleMin < windowMin) continue;
      this.notice(p, o.thread, `${o.name} has been idle for ${idleMin} minutes at ${o.contextPct}% of its context, so it hands the role on (decision 37).`);
      try { this.retire(p, o, { reason: 'idle' }); done.push(p.name); }
      catch (e) { this.notice(p, o.thread, `The idle handoff failed: ${e.message}`); }
    }
    return done;
  }

  // The facts half: what the hub knows for certain. The same shape for orchestrators and workers (decision 16):
  // your approvals and instructions, the work and its last instructions, git, open questions, tidy-ups.
  handoffFacts(p, agent) {
    if (agent.role === CONDUCTOR_ROLE) return this.conductor.facts(agent);   // its own facts: no repo, no workers
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
    // The standing approvals can be older than the live log: read the archive back to `since` (decision 74 B).
    const evsA = p.log.snapshotCount ? p.log.eventsSince(since) : evs;
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
      a = approvals(evsA, { since, threads: [agent.thread], mention: agent.name.replace(/-\d+$/, ''), tagged: tagged.filter(t => t.text.includes(agent.name.replace(/-\d+$/, ''))) });
    } else {
      a = approvals(evsA, { since, tagged });
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
      // An expedition is one line, not workers with summaries and cards: it reports to its Lead until its end.
      // M049 1: one that has ended stays listed until every one of its agents has retired.
      const liveOf = id => [...p.agents.values()].filter(a => a.expedition === id && a.state !== 'retired').length;
      const ex = Expedition.all(p).filter(x => x.phase !== 'ended' || liveOf(x.id) > 0);
      if (ex.length) lines.push('Expeditions (run by their own Lead; they report here once, at the end):', ...ex.map(x => `- expedition ${x.id} ${{ new: 'not started', planning: 'planning', running: 'running', stopped: 'writing up', ended: `ended, ${liveOf(x.id)} agent${liveOf(x.id) === 1 ? '' : 's'} still retiring` }[x.phase]}`));
    }

    lines.push(...gitLines(this.gitState(p), { summaries: summaries.filter(e => !orchNames.has(e.from)), events: evs, tagged }));

    const status = id => p.board.decision(id)?.status;
    const qs = unansweredQuestions(evs, { thread: agent.thread, decisionStatus: status });
    lines.push(`Questions still waiting on {{who}}:`, ...(qs.length ? qs.map(q => `- ${q}`) : ['- none']));

    if (agent.role === 'orchestrator') {
      const open = p.board.decisions().filter(d => ['open', 'found'].includes(d.status));
      lines.push('Decisions waiting on {{who}}:', ...(open.length ? open.map(d => `- D${String(d.id).padStart(4, '0')} ${d.title}${d.recommended ? ` (recommended ${d.recommended})` : ''}`) : ['- none']));
      // Decision 62: requests from the Conductor still waiting for this project's reply.
      const reqs = this.conductor?.openRequests(p.name) || [];
      if (reqs.length) lines.push('Conductor requests waiting for a reply (answer each with reply_to_conductor):', ...reqs.map(r => `- ${r.request} (${when(r.ts)}): "${clip(r.text, 300)}"`));
      const cards = [...this.approvals.values()].filter(x => x.p === p);
      if (cards.length) lines.push('Permission cards waiting:', ...cards.map(x => `- ${x.agent.name} wants ${x.toolName}${x.routedTo && !x.escalated ? ` (with ${x.routedTo})` : ''}`));
      const lessons = this.pendingLessons(p);
      if (lessons.length) lines.push('Profile lessons waiting for {{who}}:', ...lessons.map(e => `- ${e.text}`));
      const tidy = tidyUps(p.board, evs);
      if (tidy.length) lines.push(`Suggested tidy-ups (memos that look done or superseded; mark finished ones done with mark_entry_done, retire others only with {{who}}'s OK):`, ...tidy.map(t => `- ${t.id} ${t.title}. ${t.why}`));
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
    // An expedition agent's successor keeps its expedition and role too (the Lead's takes the final turn).
    const settings = { type: old.type || undefined, model: old.model, effort: old.effort, inherited: true, ...(old.expedition ? { expedition: old.expedition, expeditionRole: old.expeditionRole } : {}) };   // a worker with no type gets the default one
    const succ = old.role !== 'worker'
      ? this.createAgent(p, { role: old.role, predecessor: old.name, handoffEntry: entryId, settings })
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

  // ---------- the orchestrator hands a worker on (decision 46 A; amends 3 and 10) ----------
  // From the hub-wide floor up to the project's own mark, at the end of the worker's turn, with a one-line reason.
  // At the mark the hub still hands off by itself (onIdle). Never mid-turn, never below the floor.
  workerFloor() { const v = Number(this.settings.get('workerHandoffFloorPct')); return Number.isFinite(v) ? v : 35; }

  // Null when early handoffs are possible in this project; else why not: its own mark is at or below the floor.
  earlyHandoffOff(p) {
    const mark = this.workerRetireAt(), floor = this.workerFloor();
    return mark > floor ? null : `Not available in ${p.name}: its hand-off mark (${mark}%) is at or below the hub's floor for early handoffs (${floor}%), so its workers hand off only by themselves at ${mark}%.`;
  }

  // Why this agent cannot be handed on now, in a plain line; null when it can.
  workerHandoffBlock(p, a) {
    const floor = this.workerFloor();
    if (a.role === 'orchestrator') return 'That is the orchestrator. It hands the role on at its own mark, after a long idle stretch, or on {{who}}\'s word; not with this tool.';
    if (a.state === 'retired') return `${a.name} has retired.`;
    if (a.retiring) return `${a.name} is already handing off.`;
    const off = this.earlyHandoffOff(p);
    if (off) return off;
    if (a.contextPct == null) return `${a.name}'s context level is not known yet (it reports it at the end of a turn), so it cannot be handed on before ${floor}%.`;
    if (a.contextPct < floor) return `${a.name} is at ${a.contextPct}% of its context, below the ${floor}% floor. Not yet.`;
    if (['working', 'starting'].includes(a.state)) return `${a.name} is in the middle of a turn. Call handoff_worker again when its turn ends (its summary reaches you then).`;
    if ([...this.approvals.values()].some(x => x.agent === a)) return `${a.name} is waiting on a permission card. Call handoff_worker again once that is answered and its turn ends.`;
    if (!a.sessionId) return `${a.name} has not started yet, so there is nothing to hand on.`;
    return null;
  }

  // The orchestrator's list (list_agents): each worker's context %, model and effort, whether it can be handed on now,
  // and the project's two marks, so the orchestrator can judge.
  agentList(p) {
    const mark = this.workerRetireAt(), floor = this.workerFloor();
    return {
      handoff: {
        orchestrator_automatic_at_pct: this.retireAtFor(p),
        worker_automatic_at_pct: mark,
        orchestrator_may_from_pct: floor,
        note: this.earlyHandoffOff(p) || `Workers hand off by themselves at ${mark}% of their context. From ${floor}% you may hand one on with handoff_worker at the end of its turn.`
      },
      workers: p.workers().map(w => ({
        name: w.name, state: w.state, goal: w.goal,
        context_pct: w.contextPct ?? null,
        model: w.model || w.modelSeen || null,
        effort: w.effort || null,
        type: w.type || null,
        runs_as: this.describeSettings(w),
        handoff_worker: this.workerHandoffBlock(p, w) || 'available now'
      }))
    };
  }

  // handoff_worker: the same path as the automatic handoff at the mark (retire with a successor, decision 16). The
  // reason goes in the worker's thread and the orchestrator's. Returns the plain line the tool shows.
  handoffWorker(p, name, by, reason = '') {
    reason = String(reason || '').trim().replace(/\s+/g, ' ');
    const a = name === 'orchestrator' ? p.orchestrator() : p.agents.get(name);
    if (!a) return /^orchestrator(-\d+)?$/.test(name) ? this.workerHandoffBlock(p, { role: 'orchestrator' }) : `No worker called ${name}. Names are in list_agents.`;
    const stay = this.orchestratorStaysOut(p, a, by);
    if (stay) return stay;
    const blocked = this.workerHandoffBlock(p, a);
    if (blocked) return blocked;
    if (!reason) return 'Give a one-line reason, then call it again.';
    const line = `${by} hands ${a.name}'s task to a fresh agent at ${a.contextPct}% of its context: ${reason}`;
    this.notice(p, a.thread, line);
    this.notice(p, 'orchestrator', line);
    p.log.append('worker_handoff', { agent: a.name, by, reason, contextPct: a.contextPct, thread: a.thread });
    const how = this.retire(p, a, { reason: 'orchestrator' });
    return how === 'draft'
      ? `Handed on: handoff ${a.leftHandoff} was written from ${a.name}'s rolling draft plus fresh facts, and a fresh agent with the same type, model and effort takes over in its own thread.`
      : `${a.name} is writing its handoff now; a fresh agent with the same type, model and effort takes over when it is done.`;
  }

  // A worker whose job is finished: retire it with no handoff and no successor. You or the orchestrator can do this.
  retireFinished(p, name, by = 'you', reason = '') {
    const a = p.agents.get(name);
    if (!a || a.role !== 'worker') throw new Error(`No worker called ${name}`);
    const stay = this.orchestratorStaysOut(p, a, by);
    if (stay) throw new Error(stay);
    if (a.state === 'retired') return `${name} has already retired.`;
    if (a.retiring) return `${name} is already handing off.`;
    if ([...this.approvals.values()].some(x => x.agent === a)) return `${name} is waiting on a permission card; answer or deny it first.`;
    // An agent still in its turn (it posted its summary and the Lead retired it at once) has not logged its usage yet: that
    // arrives with the turn's result. Closing it now loses the spend, so it retires when the result is in (or after a cap).
    if (a.live && ['working', 'starting'].includes(a.state)) {
      if (!a.finishWhenIdle) {
        a.finishWhenIdle = { by, reason };
        a.finishTimer = setTimeout(() => this.finishRetire(p, a), RETIRE_RESULT_WAIT_MS);
        a.finishTimer.unref?.();
      }
      return `${name} is finishing its turn and retires as soon as it ends.`;
    }
    this.finishRetire(p, a);
    this.notice(p, a.thread, `${by === 'you' ? 'You' : by} retired ${name} as finished${reason ? `: ${reason}` : ''}.`);
    return `${name} retired.`;
  }

  finishRetire(p, agent) {
    clearTimeout(agent.retireTimer); clearTimeout(agent.overlapTimer); clearTimeout(agent.finishTimer);
    const deferred = agent.finishWhenIdle;
    agent.finishWhenIdle = null;
    if (agent.state === 'retired') return;
    // A retire that waited for the turn's result says what the direct path says, now that it has happened.
    if (deferred) this.notice(p, agent.thread, `${deferred.by === 'you' ? 'You' : deferred.by} retired ${agent.name} as finished${deferred.reason ? `: ${deferred.reason}` : ''}.`);
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
  // "Show older" in a thread: the page of conversation events just before the oldest one the page holds (lib/feed.mjs).
  // Past what is in memory it reads the project's archive (decision 74 B, lib/archive.mjs).
  older(project, thread, before, ts) {
    const p = this.project(String(project || '')), t = String(thread || '-');
    const archive = { page: o => p.log.archivedPage(o), count: p.log.archivedOlder()[t] || 0 };
    return olderPage(p.log.events, [...p.agents.values()].map(a => ({ name: a.name, thread: a.thread })), t, String(before || ''), Date.now(), archive, String(ts || ''), p.log.snapshotCount);
  }

  // When the expedition last wrote anything to the log (ms), 0 when nothing of it is in memory.
  expeditionActiveAt(p, id) {
    const e = p.log.events.findLast(x => x.expedition === id);
    return e ? Date.parse(e.ts) || 0 : 0;
  }

  // Moves each project's log older than about two weeks into its archive, when it is due (lib/archive.mjs). At start and
  // every few hours. CRUX_HUB_NO_ROTATE=1 turns it off (a plain off switch for the hub folder's owner).
  rotateLogs() {
    if (!this.rotatesLogs) return [];
    const done = [];
    for (const p of this.projects.values()) {
      try {
        // Not while an expedition is at work: its watchdog and Lead work from the log in memory. One with no event in the
        // last day is stuck or abandoned and does not hold the rotation back for ever.
        const busy = Expedition.all(p).filter(x => !['new', 'ended'].includes(x.phase) && this.expeditionActiveAt(p, x.id) > Date.now() - EXPEDITION_IDLE_MS);
        if (busy.length) { console.log(`Log archive: ${p.name}: skipped, expedition ${busy.map(x => x.id).join(', ')} is still active.`); continue; }
        const r = p.log.rotateIfDue();
        if (r) { done.push({ project: p.name, ...r }); console.log(`Log archive: ${p.name}: ${r.archived} events moved to ${r.months.join(', ')}; ${r.liveEvents} left in the live log.`); }
      } catch (e) { console.error(`Log archive: ${p.name}: rotation failed, the live log is untouched: ${e.message}`); }
    }
    if (this.summarisesMonths) this.summariseSoon();
    return done;
  }

  // The month summariser: Haiku through the Agent SDK on this machine's sign-in (or the API when a key is set up, like the
  // permission check), one call per thread-month, no tools. Made on first use; tests pass their own.
  get summariser() {
    if (this.summariserMade) return this.summariserMade;
    const key = this.apiKey();
    return (this.summariserMade = key ? apiCall({ apiKey: key, model: SUMMARY_MODEL }) : async arg => {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      return sdkCall({ query, model: SUMMARY_MODEL, claudePath: this.claudeCode?.() || null, env: checkEnv(), cwd: tmpdir() })(arg);
    });
  }

  // Summarises the due months of every project, in the background and one run at a time. Never throws, never blocks the
  // rotation or start-up; a failure leaves no file and is tried again on the next tick. Returns the run (tests wait on it).
  summariseSoon() {
    if (this.summarising) return this.summarising;
    const run = (async () => {
      for (const p of this.projects.values()) {
        // The choice is made here, per project: a project whose switch allows a set-up provider is summarised by it, and by
        // nothing else (a failure leaves the month for the next tick; it never drops to Claude). Otherwise Claude, as before.
        const outside = this.offload?.plan(p.dir) || null;
        const onUsage = res => {
          if (!res?.modelUsage || !Object.keys(res.modelUsage).length) return;
          if (res.via === 'outside') { this.offload.logUsage(p, res, { agent: 'month summaries', agentType: 'summary', role: 'summary', purpose: 'month summary' }); return; }
          const models = totalsOf(res.modelUsage);
          p.log.append('usage', { agent: 'month summaries', project: p.name, agentType: 'summary', role: 'summary', model: Object.keys(res.modelUsage)[0] || SUMMARY_MODEL, effort: null, models, costUSD: sumCost(models), listUSD: res.listUSD ?? null, via: res.via || null });
        };
        const summarise = outside ? (arg => this.offload.chat(p.dir, { ...arg, maxTokens: 400 })) : (arg => this.summariser(arg));
        const source = outside ? `${outside.provider}:${outside.model}` : 'claude';
        const r = await summariseDue(p.log.dir, { summarise, onUsage, source, label: `: ${p.name}`, failures: this.summaryFailures });
        const ok = r.filter(x => !x.error);
        if (ok.length) console.log(`Month summaries: ${p.name}: ${ok.map(x => `${x.ym} (${x.threads} threads, ${x.calls} model calls)`).join(', ')}.`);
      }
    })().catch(e => console.error(`Month summaries: ${e.message}`)).finally(() => { this.summarising = null; });
    return (this.summarising = run);
  }

  // The words of one board entry. The page gets entries without them and asks when you open one.
  entryBody(project, entryId) {
    const e = this.project(String(project || '')).log.events.findLast(x => x.type === 'entry' && x.entryId === String(entryId));
    return { body: e?.body || '' };
  }

  // One project as the page holds it (decision 74 B, step A: load less; lib/feed.mjs). events: false leaves the event
  // list out, for the patches that follow a change.
  pageProject(p, { events = true } = {}) {
    const now = Date.now(), evs = p.log.events;
    const views = [...p.agents.values()].map(a => ({ name: a.name, role: a.role, thread: a.thread, state: a.state, task: a.task, goal: a.goal, contextPct: a.contextPct, live: a.live, retiring: a.retiring || false, predecessor: a.predecessor, type: a.type, model: a.model, effort: a.effort, modelSeen: a.modelSeen, restartPending: a.restartWhenIdle, ...(a.expedition ? { expedition: a.expedition, expeditionRole: a.expeditionRole } : {}) }));
    const board = p.board.snapshot();
    board.entries = board.entries.map(({ body, ...e }) => ({ ...e, hasBody: !!body }));
    // The meters read today and since the hub started: usage events from before the earlier of 36 hours ago (any day's
    // midnight, in any time zone, is later) and the hub's start are not sent.
    const usageSince = Math.min(this.bootAt || now, now - 36 * 3600e3);
    const pending = [...this.approvals.entries()].filter(([, a]) => a.p === p).map(([id]) => id);
    const w = waitingOf(evs, views, board.decisions, pending, p.log.carried), pe = events ? pageEvents(evs, views, now, usageSince, p.log.snapshotCount) : null;
    if (pe) for (const [t, n] of Object.entries(p.log.archivedOlder())) pe.older[t] = (pe.older[t] || 0) + n;   // what "Show older" can still bring from the archive
    return {
      name: p.name, dir: p.dir,
      ...(pe ? { events: pe.events, older: pe.older } : {}),
      agents: agentsFor(views, evs, now),
      wait: { questions: w.questions, repeats: w.repeats, approvals: w.approvals, askedDecisions: w.askedDecisions },
      counts: w.counts, traffic: w.traffic,
      types: this.agentTypes(p).list().map(({ name, description, model, effort, tools, source }) => ({ name, description, model, effort, tools, source })),
      board,
      pack: this.memory.packName(p.name),
      pendingApprovals: [...this.approvals.entries()].filter(([, a]) => a.p === p).map(([id]) => id),
      permissionRules: this.rulesFor(p)?.entryId || null,
      permissionMode: this.permissionMode(p),
      permissionCheck: this.checkMode(p),   // decision 66: off, shadow or on
      outsideModels: this.outsideMode(p),   // decision 80: off, local or any
      paused: this.isPaused(p),
      connectors: this.connectorsOn(p),
      // Decision 44 B: the handoff numbers in force here, and the project's own (null = the hub default).
      handoff: this.handoffNumbers(p),
      ownHandoff: this.ownHandoffNumbers(p),
      retireAt: this.retireAtFor(p),
      expedition: this.expeditionView(p)   // phase 5: defaults, what is running, past ones, drafts and proposed next expeditions
    };
  }

  state() { return [...this.projects.values()].map(p => { const v = this.pageProject(p); this.baseline(p, v); return v; }); }

  // The parts of each project as last sent (text), the base the next patch is measured from. The first state read of a
  // project sets it; only patches move it, so every page that follows the stream gets every change once.
  baseline(p, view) {
    this.sent ||= new Map();
    if (!this.sent.has(p.name)) this.sent.set(p.name, new Map([...partsOf(view)].map(([k, v]) => [k, JSON.stringify(v ?? null)])));
  }

  // What changed in a project since the last patch, or null.
  patchFor(project) {
    const p = this.projects.get(project);
    if (!p) return null;
    const view = this.pageProject(p, { events: false });
    // No page has read this project yet (it was added after the first state read): it cannot be patched, it must be read.
    if (!this.sent?.has(p.name)) { this.baseline(p, view); return { unknown: true }; }
    const d = diffParts(this.sent.get(p.name), view);
    if (!d) return null;
    this.sent.set(p.name, d.next);
    return d.patch;
  }
}
