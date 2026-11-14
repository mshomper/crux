// The Conductor (decision 55 A): one hub-wide agent above the project orchestrators. It reads every project and routes
// requests to orchestrators. It is woken on demand: by your message, by a project's summary or a new card for you
// (batched, so a busy project does not wake it for every event), or by a reminder it set. It follows the orchestrator's
// retire-at-threshold, handoff and idle-handoff rules (decisions 10, 16, 37).
//
// Its log, board (handoffs only) and attachments live in the hub's own state folder (<data>/conductor, next to
// settings.json), never in a project. In the page it is the thread at the top of All projects (decision 42).
//
// Its authority is small on purpose, and the hub enforces it, not only the prompt: no built-in tools at all (no file
// reads or edits, no Bash or PowerShell, no subagents, no web), no settings, plugins or MCP servers from disk, and a
// permission callback that refuses anything but its own board tools. Its board tools only read projects; the one
// that writes into a project, message_agent, reaches that project's orchestrator and never a worker.
import { resolve, join } from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { EventLog } from './events.mjs';
import { Board } from './board.mjs';
import { Attachments } from './attachments.mjs';
import { conductorPrompt, RESUME_MESSAGE } from './prompts.mjs';
import { waiting as waitingFor, pendingLessons } from '../public/all-projects.js';
import { openQuestions as openAsked } from '../public/questions.js';   // on events (the all-projects one takes a project)
import { CONNECTOR_SERVERS } from './permission-rules.mjs';

export const CONDUCTOR = '~conductor';          // its place name in URLs and live events; never a project folder's name
export const CONDUCTOR_THREAD = 'conductor';
export const CONDUCTOR_ROLE = 'conductor';
export const WAKE_MS = 2 * 60 * 1000;           // updates within this long of the first one wake it once
export const MAX_AUTO_WAKES = 6;                 // automatic wakes (projects' updates) an hour at most
const HOUR_MS = 60 * 60 * 1000;
export const BRIEF_ANSWER_MS = 30 * 60 * 1000;   // an orchestrator's first summary this soon after a brief answers it
const REMINDER_CHECK_MS = 60 * 1000;
const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
const EVENTS_SHOWN = 400;                        // the page gets this many of its latest events
const REMINDER_MAX_DAYS = 400;

// Its board tools, by name. These and nothing else: the permission callback refuses every other tool.
export const CONDUCTOR_TOOLS = ['hub_overview', 'needs_you', 'board_index', 'board_read', 'latest_handoff', 'list_agents',
  'message_agent', 'plan_usage', 'profile_read', 'post_summary', 'propose_lesson', 'post_visual',
  'set_reminder', 'list_reminders', 'clear_reminder', 'write_handoff'];
// Named as well as switched off (tools: []), so a later SDK default can never hand them back.
export const CONDUCTOR_DENIED = ['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill', 'SlashCommand',
  'TodoWrite', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree'];
export const conductorToolNames = agent => [...CONDUCTOR_TOOLS, ...(agent?.predecessor ? ['ask_predecessor'] : [])].map(n => `mcp__crux__${n}`);

// The Conductor's place: shaped like a project where the hub's shared code (agents, handoffs, notices) needs it,
// but it holds no repo, no decisions and no workers.
export class ConductorHome {
  constructor(dir) {
    this.dir = resolve(dir);
    this.name = CONDUCTOR;
    this.hubWide = true;
    this.log = new EventLog(this.dir);
    this.board = new Board(this.dir, this.log);
    this.attachments = new Attachments(this.dir);
    this.agents = new Map();
    this.generation = 0;
    this.desk = { usable: () => false, ready: () => false, commitPending() { }, local: true };
  }
  workers() { return []; }
  holder() { return [...this.agents.values()].find(a => a.role === CONDUCTOR_ROLE && a.state !== 'retired' && a.retiring !== 'overlap') || null; }
  orchestrator() { return this.holder(); }   // the hub's role code (retire, idle handoff) asks for "the holder" by this name
}

const when = ts => new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });

export class Conductor {
  constructor(hub, dir, { wakeMs = WAKE_MS } = {}) {
    this.hub = hub;
    this.home = new ConductorHome(dir);
    this.wakeMs = wakeMs;
    this.maxAutoWakes = MAX_AUTO_WAKES;
    // Lines waiting for the next wake: { line, reminder? }. Update lines are logged as they come (wake_pending), so a
    // restart keeps them; due reminders are found again from the log, since they are marked done only once delivered.
    this.pending = this.restorePending();
    this.timer = null;
    this.activity = '';
    this.off = hub.on(ev => this.heard(ev));
    this.reminderTimer = setInterval(() => this.dueReminders(), REMINDER_CHECK_MS);
    this.reminderTimer.unref?.();
    if (this.pending.length && this.wakesOn()) this.arm(this.wakeMs);
  }

  restorePending() {
    const evs = this.home.log.events;
    const from = evs.findLastIndex(e => e.type === 'wake' || e.type === 'wake_taken');
    return evs.slice(from + 1).filter(e => e.type === 'wake_pending').map(e => ({ line: e.line }));
  }

  stop() { this.off?.(); clearTimeout(this.timer); clearInterval(this.reminderTimer); }
  holder() { return this.home.holder(); }

  // The holder, started if none: a fresh one reads the latest Conductor handoff. Model and effort come from hub.json's
  // defaults.conductor, else the orchestrator's; never an agent type (types carry tools it must not have).
  ensure() {
    const cur = this.holder();
    if (cur) return cur;
    const a = this.hub.createAgent(this.home, { role: CONDUCTOR_ROLE, settings: { type: null } });
    this.hub.notice(this.home, CONDUCTOR_THREAD, `${a.name} holds the Conductor role${this.home.board.latestHandoff(CONDUCTOR_ROLE) ? ', starting from the latest handoff' : ''}.`);
    return a;
  }

  // ---------- messages ----------
  // Yours, at once. Updates waiting for a batched wake ride along in front of it.
  // extra: more fields for the message event (answers: the Conductor's questions it answers, from its question card).
  fromYou(text, attachments = [], extra = {}) {
    this.home.log.append('message', { thread: CONDUCTOR_THREAD, from: 'you', text, ...extra, ...(attachments.length ? { attachments } : {}) });
    const a = this.ensure();
    const lines = this.take('wake_taken');
    if (lines) a.noteForNextTurn(lines);
    a.send(text, attachments);
  }

  // message_agent: to a project's orchestrator only (never a worker). Logged in that project's orchestrator thread
  // (marked conductor, so it never counts as your answer to a question), and one line in the Conductor's own thread.
  // It reaches the holder of the role, resting or not; it never starts one (decision 55 A: no starting orchestrators).
  toOrchestrator(projectName, from, msg) {
    const p = this.project(projectName);
    msg = String(msg || '').trim();
    if (!msg) return 'Write the message first.';
    const orch = p.orchestrator();
    if (!orch) return `${p.name} has no orchestrator running, and the Conductor cannot start one. Nothing was sent. Tell {{who}}: an orchestrator starts when {{who}} writes in ${p.name}'s orchestrator thread.`;
    p.log.append('message', { thread: 'orchestrator', from, text: msg, conductor: true });
    this.hub.notice(this.home, CONDUCTOR_THREAD, `${from} sent a brief to ${p.name}'s orchestrator.`);
    orch.send(`[From the Conductor, ${from}, on {{who}}'s side]\n${msg}`);
    return `Sent to ${p.name}'s orchestrator.`;
  }

  project(name) {
    const p = this.hub.projects.get(String(name || '').trim());
    if (!p) throw new Error(`No project called "${name}". Projects: ${[...this.hub.projects.keys()].join(', ')}.`);
    return p;
  }

  // ---------- waking on demand, batched ----------
  // A project's event that should reach the Conductor, as one line, or null. Its own place is never a trigger.
  wakeLine(ev) {
    if (!ev?.logged || ev.project === CONDUCTOR || !this.hub.projects.has(ev.project)) return null;
    const asks = n => n ? `, ${n} question${n === 1 ? '' : 's'}` : '';
    if (ev.type === 'summary') {
      const ds = (ev.decisions_needed || []).length, qs = (ev.questions || []).length;
      // Only a summary that asks something of you wakes it: routine rounds are the orchestrator's, and you see them
      // in the project. Nor the orchestrator's answer to the Conductor's own brief: no back-and-forth between them.
      if (!ds && !qs) return null;
      if (ev.thread === 'orchestrator' && this.answersBrief(this.hub.projects.get(ev.project), ev)) return null;
      return `- ${ev.project}: ${ev.from} posted a round summary${asks(qs)}${ds ? `, ${ds} decision${ds === 1 ? '' : 's'} to pick` : ''}`;
    }
    if ((ev.type === 'approval' && !ev.routedTo) || ev.type === 'approval_escalated') return `- ${ev.project}: a permission card from ${ev.agent} waits for {{who}}`;
    return null;
  }

  // Does this orchestrator summary answer a Conductor brief? Only the FIRST orchestrator summary after a brief, within
  // BRIEF_ANSWER_MS of it, and only when the brief was the last message into that thread from outside (not yours).
  // Later summaries wake it as usual: worker results and permission requests leave no message in the thread, so
  // "the last outside message" alone would keep an old brief in force all day.
  answersBrief(p, ev) {
    if (!p) return false;
    const orchs = new Set([...p.agents.values()].filter(a => a.role === 'orchestrator').map(a => a.name));
    const evs = p.log.events, i = evs.findIndex(e => e.id === ev.id);   // ev is the hub's copy of the logged event
    const before = i < 0 ? evs : evs.slice(0, i);
    const j = before.findLastIndex(e => e.type === 'message' && e.thread === 'orchestrator' && !orchs.has(e.from));
    const brief = before[j];
    if (!brief?.conductor || Date.parse(ev.ts) - Date.parse(brief.ts) > BRIEF_ANSWER_MS) return false;
    return !before.slice(j + 1).some(e => e.type === 'summary' && e.thread === 'orchestrator');
  }

  // Wakes need the switch on (settings conductorWakes, on by default) and more than one project: with one, the page
  // shows no All projects column, so a Conductor working there would be out of sight.
  wakesOn() { return this.hub.settings.get('conductorWakes') !== false && this.hub.projects.size > 1 && !this.hub.noAgents; }

  // Automatic wakes (from projects' updates) in the last hour, from the log, so a restart does not reset the count.
  // Your messages and due reminders are not counted and always wake it.
  autoWakes(now = Date.now()) { return this.home.log.ofType('wake').filter(e => e.auto !== false && now - Date.parse(e.ts) < HOUR_MS); }

  heard(ev) {
    if (ev?.project === CONDUCTOR && (ev.type === 'activity' || ev.type === 'agent_state')) {
      if (ev.type === 'activity') this.activity = `${ev.agent}: ${ev.text}`;
      else if (!['working', 'starting'].includes(ev.state)) this.activity = '';
      this.hub.emit({ type: 'conductor_state', conductor: this.view({ events: false }) });
      return;
    }
    const line = this.wakeLine(ev);
    if (!line || !this.wakesOn()) return;
    this.queue(line);
  }

  queue(line) {
    this.pending.push({ line });
    this.home.log.append('wake_pending', { line });
    this.arm(this.wakeMs);
  }

  arm(ms) {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, Math.max(0, ms));
    this.timer.unref?.();
  }

  // Everything waiting, as one message; due reminders delivered with it are marked done now (not when they fell due,
  // so a restart before delivery finds them again). marker: the event that says the lines were handed over.
  take(marker = 'wake', extra = {}) {
    if (!this.pending.length) return '';
    const items = this.pending;
    this.pending = [];
    const lines = [...new Set(items.map(x => x.line))];
    const msg = `[Hub: updates since you last heard]\n${lines.join('\n')}`;
    this.home.log.append(marker, { ...(marker === 'wake' ? { thread: CONDUCTOR_THREAD } : {}), text: msg, ...extra });
    for (const r of items.filter(x => x.reminder)) this.home.log.append('reminder_done', { thread: CONDUCTOR_THREAD, reminder: r.reminder, why: 'due' });
    return msg;
  }

  // One turn for everything queued. A busy, retiring or answering holder takes it at the end of its turn (afterTurn).
  // force: a due reminder, which is never held back. Otherwise at most maxAutoWakes automatic wakes an hour: past
  // that, the lines wait (and ride along with your next message) until the oldest wake leaves the hour.
  flush({ force = false, now = Date.now() } = {}) {
    if (!this.pending.length) return false;
    const cur = this.holder();
    if (cur && (['working', 'starting'].includes(cur.state) || cur.retiring || cur.capture)) return false;
    const auto = !this.pending.some(x => x.reminder);
    if (auto && !force) {
      const recent = this.autoWakes(now);
      if (recent.length >= this.maxAutoWakes) { this.arm(Date.parse(recent[0].ts) + HOUR_MS - now + 1000); return false; }
    }
    const a = this.ensure();
    const msg = this.take('wake', { agent: a.name, auto });
    a.send(msg);
    return true;
  }

  // The hub calls this when the Conductor goes idle (Hub.onIdle): a due reminder at once, updates after the window.
  afterTurn() {
    if (!this.pending.length) return;
    if (this.pending.some(x => x.reminder)) { clearTimeout(this.timer); this.timer = null; this.flush({ force: true }); }
    else this.arm(this.wakeMs);
  }

  // ---------- reminders across days ----------
  reminders() {
    const done = new Set(this.home.log.ofType('reminder_done').map(e => e.reminder));
    return this.home.log.ofType('reminder').filter(e => !done.has(e.reminder)).map(e => ({ id: e.reminder, at: e.at, text: e.text, from: e.from }));
  }
  setReminder(at, msg, from) {
    const t = Date.parse(String(at || ''));
    if (!Number.isFinite(t)) return 'Give the time as a date and time, e.g. 2026-11-20T09:00 (your local time) or with a Z for UTC.';
    if (t <= Date.now()) return 'That time has passed. Give a time in the future.';
    if (t - Date.now() > REMINDER_MAX_DAYS * 864e5) return `Reminders go up to ${REMINDER_MAX_DAYS} days ahead.`;
    msg = String(msg || '').trim().slice(0, 400);
    if (!msg) return 'Say what to remind about.';
    const id = `rem-${(this.home.log.ofType('reminder').length + 1).toString().padStart(3, '0')}`;
    this.home.log.append('reminder', { thread: CONDUCTOR_THREAD, reminder: id, at: new Date(t).toISOString(), text: msg, from });
    return `Reminder ${id} set for ${when(t)}.`;
  }
  clearReminder(id, why = 'cleared') {
    const r = this.reminders().find(x => x.id === String(id || '').trim());
    if (!r) return `No reminder ${id} waiting.`;
    this.home.log.append('reminder_done', { thread: CONDUCTOR_THREAD, reminder: r.id, why });
    return `Reminder ${r.id} cleared.`;
  }
  // Due ones wake the Conductor at once (no batching, no hourly cap): they are rare and time matters. Each is marked
  // done only once it is delivered (take); a busy Conductor gets it at the end of its turn (afterTurn).
  dueReminders(now = Date.now()) {
    const queued = new Set(this.pending.map(x => x.reminder).filter(Boolean));
    const due = this.reminders().filter(r => Date.parse(r.at) <= now && !queued.has(r.id));
    if (!due.length || this.hub.noAgents) return due.length;
    for (const r of due) this.pending.push({ line: `- Reminder ${r.id} is due (set for ${when(r.at)}): ${r.text}`, reminder: r.id });
    clearTimeout(this.timer); this.timer = null;
    this.flush({ force: true, now });
    return due.length;
  }

  // ---------- what it reads ----------
  // A project as the page sees it, for the shared Needs you rules (public/all-projects.js).
  pageProject(p) {
    return { name: p.name, events: p.log.events, board: { decisions: p.board.decisions() }, agents: [...p.agents.values()].map(a => ({ name: a.name, role: a.role, thread: a.thread, state: a.state })), permissionMode: this.hub.permissionMode(p) };
  }
  pendingIds() { return new Set([...this.hub.approvals.keys()]); }

  // What waits for you in one project, most urgent first: permission cards, questions, decisions, then lessons.
  needsYou(p) {
    const w = waitingFor(this.pageProject(p), this.pendingIds());
    const items = [
      ...w.approvals.map(e => ({ kind: 'permission', from: e.agent, what: e.summary?.plain || e.input?.description || `use ${e.tool}`, since: e.ts })),
      ...w.questions.map(q => ({ kind: 'question', from: q.from, what: q.open.map(x => x.text), since: q.ts })),
      ...w.decisions.map(d => ({ kind: 'decision', id: `D${String(d.id).padStart(4, '0')}`, what: d.title, recommended: d.recommended || null, lead: d.lead || null })),
      ...(w.lessons.length ? [{ kind: 'lessons', what: `${w.lessons.length} lesson${w.lessons.length === 1 ? '' : 's'} for the core profile` }] : [])
    ];
    return { project: p.name, count: w.count, items };
  }

  overview() {
    const pending = this.pendingIds();
    return {
      projects: [...this.hub.projects.values()].map(p => {
        const w = waitingFor(this.pageProject(p), pending), o = p.orchestrator();
        const live = [...p.agents.values()].filter(a => a.state !== 'retired');
        return {
          name: p.name, level: { standard: 'Ask', auto: 'Auto', trusted: 'Trusted' }[this.hub.permissionMode(p)],
          waiting: { total: w.count, permissions: w.approvals.length, questions: w.questions.length, decisions: w.decisions.length, lessons: w.lessons.length },
          orchestrator: o ? { name: o.name, state: o.state, context_pct: o.contextPct ?? null } : null,
          workers: live.filter(a => a.role === 'worker').length,
          working: live.filter(a => ['working', 'starting'].includes(a.state)).length
        };
      }),
      plan_usage: this.hub.usage?.view?.() || null
    };
  }

  agents(p) {
    return [...p.agents.values()].filter(a => a.state !== 'retired').map(a => ({
      name: a.name, role: a.role, state: a.state, goal: a.goal || '', context_pct: a.contextPct ?? null, runs_as: this.hub.describeSettings(a)
    }));
  }

  // profile_read for the Conductor: the core, the conventions, or a pack. Never the private section.
  profile(section) {
    const s = String(section || '').trim();
    if (s === 'private') return 'The Conductor never reads the private section.';
    if (s === 'pack') return 'Name the pack: "pack:<name>".';
    return this.hub.memory.readSection(s, '') || `Nothing in "${s}". Sections: core, conventions, ${this.hub.memory.packs().map(n => 'pack:' + n).join(', ')}.`;
  }

  // ---------- the agent's set-up ----------
  // Its query options: its own prompt, its own tools, nothing from disk, and a callback that refuses everything else.
  options(agent) {
    const m = this.hub.memory;
    const append = m.personalize(conductorPrompt({
      generation: agent.generation, handoff: this.home.board.latestHandoff(CONDUCTOR_ROLE), core: m.core(), conventions: m.conventions(),
      projects: [...this.hub.projects.keys()], reminders: this.reminders()
    }));
    const allowed = conductorToolNames(agent);
    return {
      cwd: this.home.dir,
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      settingSources: [],          // no CLAUDE.md, settings, hooks or plugins from disk
      strictMcpConfig: true,       // only the hub's own MCP server
      tools: [],                   // no built-in tools at all
      mcpServers: { crux: this.tools(agent) },
      allowedTools: allowed,
      disallowedTools: [...CONDUCTOR_DENIED, ...CONNECTOR_SERVERS],
      settings: { disableClaudeAiConnectors: true },
      permissionMode: 'default',
      canUseTool: async (toolName, input) => this.decide(toolName, input, agent),
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.effort ? { effort: agent.effort } : {}),
      ...(agent.sessionId ? { resume: agent.sessionId } : {})
    };
  }

  // The permission callback: its own board tools only. Never a card for you, never the orchestrator.
  decide(toolName, input, agent) {
    if (conductorToolNames(agent).includes(toolName)) return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: `The Conductor cannot use ${toolName}. It reads projects and briefs their orchestrators (message_agent); file changes, commands, agents, permissions, merges and pushes stay with the projects and with {{who}}.`.replaceAll('{{who}}', this.hub.memory.userName() || 'the user') };
  }

  tools(agent) {
    const hub = this.hub, home = this.home;
    const out = s => text(hub.memory.personalize(typeof s === 'string' ? s : JSON.stringify(s, null, 1)));
    const safe = fn => async args => { try { return out(await fn(args)); } catch (e) { return out(`Not done: ${e.message}`); } };
    const list = z.array(z.string()).optional().default([]);
    const heading = what => z.array(z.string()).min(1).describe(`${what}. Write "none" if there is nothing.`);
    const project = z.string().describe('The project\'s name, as hub_overview lists it.');
    const tools = [
      tool('hub_overview', 'Every project at a glance: what waits for {{who}} by kind, its permission level, its orchestrator\'s state and context, how many workers and how many are working; plus the plan usage meters.', {},
        safe(() => this.overview())),
      tool('needs_you', hub.memory.personalize('What waits for {{who}}, most urgent first (permission cards, questions, decisions, lessons): in one project, or in every project when none is named.'),
        { project: z.string().optional().describe('Leave out for every project.') },
        safe(({ project: name }) => name ? this.needsYou(this.project(name)) : [...hub.projects.values()].map(p => this.needsYou(p)).filter(x => x.count).sort((a, b) => b.count - a.count))),
      tool('board_index', 'One line per active item on one project\'s memory board.', { project },
        safe(({ project: name }) => this.project(name).board.index())),
      tool('board_read', 'Read one board item of one project in full: a decision (D0007 or 7) or an entry (R003, C001, M002, H001).', { project, id: z.string() },
        safe(({ project: name, id }) => this.project(name).board.read(id) || `Nothing on ${name}'s board with id ${id}.`)),
      tool('latest_handoff', 'The latest orchestrator handoff of one project, in full.', { project },
        safe(({ project: name }) => this.project(name).board.latestHandoff() || `${name} has no orchestrator handoff yet.`)),
      tool('list_agents', 'One project\'s active agents: the orchestrator and its workers, with state, goal, context % and model.', { project },
        safe(({ project: name }) => this.agents(this.project(name)))),
      tool('message_agent', 'Send a brief to one project\'s ORCHESTRATOR (never a worker): a request from {{who}}, a usage warning, or a conflict to draft a decision card for. Carry only what that project needs, never details from another project.',
        { project, text: z.string().min(1) },
        safe(({ project: name, text: msg }) => this.toOrchestrator(name, agent.name, msg))),
      tool('plan_usage', 'The plan usage meters (5-hour, 7-day, per model), as the hub\'s strip shows them; null when not available.', {},
        safe(() => hub.usage?.view?.() || null)),
      tool('profile_read', hub.memory.personalize('Re-read part of {{who}}\'s profile: "core", "conventions" (the cross-project roll-up and its conflicts) or "pack:<name>". Never the private section.'),
        { section: z.string() }, safe(({ section }) => this.profile(section))),
      tool('post_summary', hub.memory.personalize('Post your round summary to your thread, where {{who}} sees it.'),
        {
          done: list, changed: list, questions: list.describe('Questions for {{who}}, in plain words.'),
          decisions_needed: z.array(z.number()).optional().default([]), blocked_on: list, next_step: z.string().optional().default(''),
          visuals: list.describe('Ids from post_visual.'),
          handoff_notes: z.object({ in_flight: list, promises: list, risks: list, next_steps: list }).optional().describe('Your handoff judgement as of now, a line or two per heading. The hub keeps the newest as a rolling draft.'),
          approvals: list, open_questions: list
        },
        safe(args => { hub.postSummary(home, agent, args); return 'Summary posted. Stop here and wait.'; })),
      tool('propose_lesson', hub.memory.personalize('Record a lasting lesson about how {{who}} wants work done across projects. It waits for {{who}}\'s OK before it joins the core profile.'),
        { lesson: z.string().max(400) }, safe(({ lesson }) => hub.proposeLesson(home, agent, 'core', lesson))),
      tool('post_visual', hub.memory.personalize('Show {{who}} a picture (png, jpg, gif, webp, svg) or a small self-contained HTML page from a file the hub can read. Returns an id for post_summary visuals.'),
        { path: z.string(), caption: z.string().max(200) },
        safe(({ path, caption }) => `Posted visual ${hub.postVisual(home, agent, path, caption).visual}.`)),
      tool('set_reminder', 'Set a reminder that may run across days: the hub wakes you with it when it is due. Time as a date and time (2026-11-20T09:00, local time) or with Z for UTC.',
        { at: z.string(), text: z.string().max(400) }, safe(({ at, text: msg }) => this.setReminder(at, msg, agent.name))),
      tool('list_reminders', 'The reminders still waiting, with their ids and times.', {},
        safe(() => this.reminders().map(r => ({ id: r.id, due: when(r.at), text: r.text })))),
      tool('clear_reminder', 'Clear a waiting reminder by its id.', { id: z.string() }, safe(({ id }) => this.clearReminder(id))),
      tool('write_handoff', 'Only when told you are retiring. The hub adds the facts it knows; you write the judgement under every heading.',
        {
          in_flight: heading('What is in flight and why'), promises: heading('Promises made that are not yet kept'),
          risks: heading('Risks and things easy to miss'), next_steps: heading('What you would do next, in order'),
          promote_to_core: list
        },
        safe(args => hub.writeHandoff(home, agent, args)))
    ];
    if (agent.predecessor) tools.push(tool('ask_predecessor', 'Ask the Conductor you took over from one short question (at most three in all).',
      { question: z.string().max(500) }, safe(({ question }) => hub.askPredecessor(home, agent, question))));
    return createSdkMcpServer({ name: 'crux', version: '0.3.0', tools });
  }

  // ---------- handoffs (decision 16): the facts half ----------
  facts(agent) {
    const evs = this.home.log.events, lines = [];
    const prev = this.home.board.latestHandoff(CONDUCTOR_ROLE);
    const since = prev ? Date.parse(prev.ts) : 0;
    const mine = evs.filter(e => e.thread === CONDUCTOR_THREAD && Date.parse(e.ts) >= since);
    const yours = mine.filter(e => e.type === 'message' && e.from === 'you').slice(-12);
    lines.push(`Messages from {{who}} (${prev ? `since handoff ${prev.entryId}` : 'all so far'}, the last ${yours.length}):`);
    lines.push(...(yours.length ? yours.map(e => `- [${when(e.ts)}] ${String(e.text).slice(0, 400)}`) : ['- none']));
    const sent = mine.filter(e => e.type === 'notice' && / sent a brief to /.test(e.text)).slice(-12);
    lines.push('Briefs sent to orchestrators:', ...(sent.length ? sent.map(e => `- [${when(e.ts)}] ${e.text}`) : ['- none']));
    const rs = this.reminders();
    lines.push('Reminders still waiting:', ...(rs.length ? rs.map(r => `- ${r.id} due ${when(r.at)}: ${r.text}`) : ['- none']));
    const qs = openAsked(this.home.log.events, {});
    lines.push('Questions still waiting on {{who}}:', ...(qs.length ? qs.flatMap(q => q.open.map(x => `- ${x.text}`)) : ['- none']));
    const lessons = pendingLessons({ events: evs });
    if (lessons.length) lines.push('Profile lessons waiting for {{who}}:', ...lessons.map(e => `- ${e.text}`));
    const o = this.overview();
    lines.push('Projects now:', ...o.projects.map(p => `- ${p.name}: ${p.waiting.total} waiting for {{who}}; orchestrator ${p.orchestrator ? `${p.orchestrator.name} (${p.orchestrator.state})` : 'none'}; ${p.working} of ${p.workers} workers working`));
    return lines.join('\n');
  }

  // ---------- after a restart (M014) ----------
  // Your last message, if the Conductor never acted on it, is delivered again; a turn cut short is resumed.
  resume(now = Date.now()) {
    const evs = this.home.log.events;
    const names = new Set([...this.home.agents.values()].map(a => a.name));
    const i = evs.findLastIndex(e => e.type === 'message' && e.thread === CONDUCTOR_THREAD && e.from === 'you');
    const m = evs[i];
    if (m && now - Date.parse(m.ts) <= RESUME_WINDOW_MS && !evs.slice(i + 1).some(e => !['agent_created', 'agent_session', 'agent_busy', 'notice', 'usage', 'plan_usage'].includes(e.type) && (names.has(e.from) || names.has(e.agent)))) {
      this.hub.notice(this.home, CONDUCTOR_THREAD, 'The hub restarted before your last message reached the Conductor, so it was delivered again.');
      const a = this.ensure();
      a.send(m.text, m.attachments || []);
      return 'message';
    }
    const a = this.holder();
    const busy = a && evs.findLast(e => e.type === 'agent_busy' && e.agent === a.name);
    if (a && busy?.busy) {
      if (now - Date.parse(busy.ts) <= RESUME_WINDOW_MS) { this.hub.notice(this.home, CONDUCTOR_THREAD, `The hub restarted while ${a.name} was working; it was asked to carry on.`); a.send(RESUME_MESSAGE); return 'working'; }
      this.home.log.append('agent_busy', { agent: a.name, busy: false, stale: true }); a.busyLogged = false;
    }
    return null;
  }

  // ---------- what the page gets (/api/state "conductor", and conductor_state on the live stream) ----------
  // state: 'asleep' (no one holds the role, or resting), 'starting', 'working', 'idle', 'error'. waiting: what in its
  // thread waits on you (its open questions, and its lesson card).
  // The page shows only the latest EVENTS_SHOWN events, so what waits on you comes whole, from the full log: its open
  // questions (questions, drawn as answerable cards) and its unanswered lessons (lessons). waiting counts exactly those.
  view({ events = true } = {}) {
    const a = this.holder();
    const evs = this.home.log.events;
    const questions = openAsked(evs, {}), lessons = pendingLessons({ events: evs });
    const waiting = questions.reduce((n, q) => n + q.open.length, 0) + (lessons.length ? 1 : 0);
    return {
      place: CONDUCTOR, thread: CONDUCTOR_THREAD, role: CONDUCTOR_ROLE,
      name: a?.name || null, state: a ? a.state : 'asleep', contextPct: a?.contextPct ?? null,
      model: a?.model || null, modelSeen: a?.modelSeen || null, effort: a?.effort || null, type: null,
      live: !!a?.live, retiring: a?.retiring || false, restartPending: !!a?.restartWhenIdle,
      retireAt: this.hub.retireAtFor(this.home), activity: this.activity, waiting,
      wakes: this.wakesOn(), pendingWake: this.pending.length, questions, lessons,
      ...(events ? { events: evs.slice(-EVENTS_SHOWN), olderEvents: Math.max(0, evs.length - EVENTS_SHOWN) } : {})
    };
  }
}
