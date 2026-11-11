// The hub: projects, their agents, and the routing between you, the orchestrator role and workers.
import { basename, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventLog } from './events.mjs';
import { Board } from './board.mjs';
import { Agent } from './agent.mjs';
import { Memory } from './memory.mjs';
import { CommandPolicy } from './permissions.mjs';
import { CommandSummary } from './summarize.mjs';
import { RETIRE_MESSAGE, SUCCESSOR_MESSAGE } from './prompts.mjs';
import { AgentTypes, EFFORTS, modelId, effortLevel, modelLabel } from './agent-types.mjs';

export class Project {
  constructor(dir) {
    this.dir = resolve(dir);
    this.name = basename(this.dir);
    this.log = new EventLog(this.dir);
    this.board = new Board(this.dir, this.log);
    this.agents = new Map();
    this.generation = 0;
  }
  workers() { return [...this.agents.values()].filter(a => a.role === 'worker' && a.state !== 'retired'); }
  // The holder of the role. One that is writing its handoff still holds it; one in the overlap has passed it on.
  orchestrator() { return [...this.agents.values()].find(a => a.role === 'orchestrator' && a.state !== 'retired' && a.retiring !== 'overlap') || null; }
}

const OVERLAP_MS = 10 * 60 * 1000, HANDOFF_MS = 5 * 60 * 1000, ANSWER_MS = 3 * 60 * 1000;

export class Hub {
  // defaults: { orchestrator: { type, model, effort }, worker: {...} } from ~/crux/hub.json (decision 20).
  // agentHome: the folder whose .claude/agents holds the all-projects types (your home folder).
  constructor({ projects, retireAt = 60, memory = new Memory(), defaults = {}, agentHome = homedir() }) {
    this.retireAt = retireAt;
    this.memory = memory;
    this.defaults = defaults || {};
    this.agentHome = agentHome;
    this.listeners = new Set();
    this.approvals = new Map();
    this.projects = new Map();
    for (const dir of projects) this.addProject(dir);
    // After listeners are attached: deliver any message of yours that a restart cut off.
    setTimeout(() => { for (const p of this.projects.values()) this.redeliver(p); }, 0);
  }

  // A message you sent within the last 10 minutes that its agent never acted on (no event from that agent since)
  // most likely died with a restart. Deliver it again, with a note, rather than leave you waiting on silence.
  undelivered(p, now = Date.now()) {
    const evs = p.log.events;
    const out = [];
    for (const thread of new Set(evs.filter(e => e.type === 'message' && e.from === 'you').map(e => e.thread))) {
      const i = evs.findLastIndex(e => e.type === 'message' && e.from === 'you' && e.thread === thread);
      const m = evs[i];
      if (!m || now - Date.parse(m.ts) > 10 * 60 * 1000) continue;
      const agent = thread === 'orchestrator' ? p.orchestrator() : p.agents.get(thread);
      if (thread !== 'orchestrator' && (!agent || agent.state === 'retired')) continue;
      const names = new Set([agent?.name, ...(thread === 'orchestrator' ? [...p.agents.values()].filter(a => a.role === 'orchestrator').map(a => a.name) : [])].filter(Boolean));
      // Starting up (agent_created, agent_session) is not acting on it; a reply, summary, card or pick is.
      const actedOn = evs.slice(i + 1).some(e => e.type === 'pick' || (!['agent_created', 'agent_session', 'notice'].includes(e.type) && (names.has(e.from) || names.has(e.agent))));
      if (!actedOn) out.push(m);
    }
    return out;
  }

  redeliver(p) {
    for (const m of this.undelivered(p)) {
      const when = new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      this.notice(p, m.thread, `The hub restarted before your message from ${when} reached its agent, so it was delivered again.`);
      try {
        if (m.thread === 'orchestrator') this.ensureOrchestrator(p).send(m.text);
        else p.agents.get(m.thread)?.send(m.text);
      } catch (e) { this.notice(p, m.thread, `Could not deliver it again: ${e.message}`); }
    }
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
    const a = p.agents.get(name);
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
    this.notice(p, a.thread, `${by === 'you' ? 'You' : by} set ${a.name} to ${this.describeSettings(a)}; it applies ${when}.`);
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
  fromYou(p, thread, text) {
    p.log.append('message', { thread, from: 'you', text });
    if (thread === 'orchestrator') return this.ensureOrchestrator(p).send(text);
    const a = p.agents.get(thread);
    if (!a || a.state === 'retired') throw new Error(`No active agent ${thread}`);
    a.send(text);
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

  postVisual(p, agent, path, caption) {
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
  // Settled without a card: reading Crux's own files (not your private notes), the orchestrator writing decision
  // records and running the Crux build. Refused without a card: the orchestrator editing anything else.
  autoAnswer(p, agent, toolName, input) {
    const norm = s => String(s || '').replace(/\\/g, '/').toLowerCase();
    const file = norm(input.file_path || input.path || input.notebook_path);
    const home = norm(homedir());
    const cruxDirs = [`${home}/.claude/skills/`, `${home}/crux/`];
    const privateNotes = norm(join(this.memory.profileDir, 'private.md'));
    if (['Read', 'Glob', 'Grep'].includes(toolName) && file && file !== privateNotes && cruxDirs.some(d => file.startsWith(d))) return { behavior: 'allow', updatedInput: input };
    const decisions = norm(join(p.dir, '.decisions')) + '/';
    if (['Write', 'Edit', 'MultiEdit'].includes(toolName) && agent.role === 'orchestrator') {
      return file.startsWith(decisions)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'The orchestrator only writes Crux decision records (.decisions/). Send other file changes to a worker with message_agent or start_worker.' };
    }
    const cmd = String(input.command || '').trim();
    if (/^(Bash|PowerShell)$/.test(toolName) && /^node\s+("[^"]*[\\/]crux[\\/]scripts[\\/](build|rollup)\.mjs"|\S*[\\/]crux[\\/]scripts[\\/](build|rollup)\.mjs)(\s+("[^"]*"|[\w.\\/:-]+))?$/.test(cmd)) {
      return { behavior: 'allow', updatedInput: input };
    }
    // Commands that only read (listing, git status and diff, versions) run without a card.
    if (/^(Bash|PowerShell)$/.test(toolName) && CommandPolicy.readOnly(toolName, cmd)) return { behavior: 'allow', updatedInput: input };
    return null;
  }

  requestApproval(p, agent, toolName, input, { signal, title, description, suggestions } = {}) {
    const auto = this.autoAnswer(p, agent, toolName, input);
    if (auto) return Promise.resolve(auto);
    return new Promise(resolvePromise => {
      const id = randomUUID();
      const always = CommandPolicy.alwaysRules(toolName, input, suggestions);
      const finish = (result, how) => {
        if (!this.approvals.has(id)) return;
        this.approvals.delete(id);
        p.log.append('approval_result', { thread: agent.thread, approval: id, how });
        resolvePromise(result);
      };
      this.approvals.set(id, { p, agent, toolName, input, finish, always });
      p.log.append('approval', { thread: agent.thread, approval: id, agent: agent.name, tool: toolName, input, title: title || null, description: description || null, always: always ? CommandPolicy.describe(always) : null, summary: CommandSummary.of(toolName, input) });
      signal?.addEventListener('abort', () => finish({ behavior: 'deny', message: 'Cancelled' }, 'cancelled'));
    });
  }

  // "Always" saves Claude Code's own suggested rule to the project's .claude/settings.local.json, where you can review or remove it.
  answerApproval(id, allow, note, always = false) {
    const a = this.approvals.get(id);
    if (!a) throw new Error('That approval is no longer waiting (the agent may have restarted).');
    if (always && !a.always) throw new Error('This one can only be allowed once.');
    if (always) this.notice(a.p, a.agent.thread, `Saved to this project's Claude Code settings (.claude/settings.local.json): always allow ${CommandPolicy.describe(a.always).join('; ')}`);
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
      this.retire(p, agent);
    }
  }

  retire(p, agent = p.orchestrator()) {
    if (typeof agent === 'string') agent = p.agents.get(agent);
    if (!agent || agent.state === 'retired') throw new Error('No active agent to retire');
    if (agent.retiring) return;
    agent.retiring = 'writing';
    if (!agent.sessionId) return this.finishRetire(p, agent); // never started; nothing to hand off
    agent.send(RETIRE_MESSAGE(agent.role));
    agent.retireTimer = setTimeout(() => { if (agent.retiring === 'writing') this.startSuccessor(p, agent); }, HANDOFF_MS);
  }

  // The facts half: what the hub knows for certain.
  handoffFacts(p, agent) {
    const lines = [];
    const lastSummary = a => p.log.ofType('summary').filter(e => e.from === a.name).at(-1);
    const mine = p.log.ofType('message').filter(e => e.thread === agent.thread && e.from === 'you').slice(-5);
    if (agent.role === 'worker') {
      lines.push(`Task goal: ${agent.goal || '(none given)'}`);
      const s = lastSummary(agent);
      if (s) lines.push(`Last summary: done ${s.done.join('; ') || 'nothing'}; changed ${s.changed.join(', ') || 'nothing'}${s.next_step ? `; next ${s.next_step}` : ''}`);
    } else {
      const ws = p.workers().filter(w => w !== agent);
      lines.push('Workers:', ...(ws.length ? ws.map(w => {
        const s = lastSummary(w);
        return `- ${w.name} (${w.state}): ${w.goal || w.task.slice(0, 80)}${s ? `. Last summary: ${s.next_step || s.done[0] || 'posted'}` : ''}`;
      }) : ['- none']));
      const open = p.board.decisions().filter(d => ['open', 'found'].includes(d.status));
      lines.push('Decisions waiting on {{who}}:', ...(open.length ? open.map(d => `- D${String(d.id).padStart(4, '0')} ${d.title}${d.recommended ? ` (recommended ${d.recommended})` : ''}`) : ['- none']));
      const cards = [...this.approvals.values()].filter(a => a.p === p);
      if (cards.length) lines.push('Permission cards waiting:', ...cards.map(a => `- ${a.agent.name} wants ${a.toolName}`));
      const lessons = this.pendingLessons(p);
      if (lessons.length) lines.push('Profile lessons waiting for {{who}}:', ...lessons.map(e => `- ${e.text}`));
    }
    if (mine.length) lines.push('Latest messages from {{who}}:', ...mine.map(e => `- ${e.text.replace(/\s+/g, ' ').slice(0, 200)}`));
    return lines.join('\n');
  }

  writeHandoff(p, agent, j) {
    if (agent.retiring !== 'writing') return 'You are not retiring, so no handoff is needed.';
    if (agent.leftHandoff) return `Handoff ${agent.leftHandoff} is already written. Reply "done".`;
    const sec = (title, xs) => `### ${title}\n${(xs || []).map(x => `- ${x}`).join('\n') || '- none'}`;
    const body = [
      sec('In flight, and why', j.in_flight), sec('Promises to {{who}}', j.promises),
      sec('Risks and things easy to miss', j.risks), sec('Next steps', j.next_steps),
      `### Facts (from the hub)\n${this.handoffFacts(p, agent)}`
    ].join('\n\n').replaceAll('{{who}}', this.memory.userName() || 'the user');
    const ev = p.board.addEntry({ kind: 'handoff', title: `Handoff from ${agent.name}`, summary: (j.next_steps || [])[0] || 'handoff', body, from: agent.name, role: agent.role });
    agent.leftHandoff = ev.entryId;
    for (const r of j.retire_entries || []) p.board.retireEntry(r.id, r.why, agent.name);
    for (const l of (j.promote_to_core || []).filter(x => x && x.toLowerCase() !== 'none')) this.proposeLesson(p, agent, 'core', l);
    return `Handoff ${ev.entryId} posted. Reply "done" and stop.`;
  }

  startSuccessor(p, old) {
    if (old.retiring !== 'writing') return;
    clearTimeout(old.retireTimer);
    if (!old.leftHandoff) this.writeHandoff(p, old, { in_flight: ['(The agent did not write its part of the handoff.)'] });
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
      pendingApprovals: [...this.approvals.entries()].filter(([, a]) => a.p === p).map(([id]) => id)
    }));
  }
}
