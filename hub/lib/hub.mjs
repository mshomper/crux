// The hub: projects, their agents, and the routing between you, the orchestrator role and workers.
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventLog } from './events.mjs';
import { Board } from './board.mjs';
import { Agent } from './agent.mjs';
import { RETIRE_MESSAGE } from './prompts.mjs';

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
  orchestrator() { return [...this.agents.values()].find(a => a.role === 'orchestrator' && a.state !== 'retired' && !a.retiring) || null; }
}

export class Hub {
  constructor({ projects, retireAt = 60 }) {
    this.retireAt = retireAt;
    this.listeners = new Set();
    this.approvals = new Map();
    this.projects = new Map();
    for (const dir of projects) this.addProject(dir);
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
        p.agents.set(ev.agent, new Agent(this, p, { name: ev.agent, role: ev.role, task: ev.task, generation: ev.generation }));
        if (ev.role === 'orchestrator') p.generation = Math.max(p.generation, ev.generation);
      } else if (ev.type === 'agent_session' && p.agents.has(ev.agent)) {
        p.agents.get(ev.agent).sessionId = ev.sessionId;
      } else if (ev.type === 'agent_retired' && p.agents.has(ev.agent)) {
        p.agents.get(ev.agent).state = 'retired';
      }
    }
  }

  notice(p, thread, text) { p.log.append('notice', { thread, text }); }

  // ---------- agents ----------
  createAgent(p, { name, role, task = '' }) {
    const generation = role === 'orchestrator' ? ++p.generation : 0;
    if (role === 'orchestrator') name = `orchestrator-${generation}`;
    let unique = name, n = 2;
    while (p.agents.has(unique)) unique = `${name}-${n++}`;
    const a = new Agent(this, p, { name: unique, role, task, generation });
    p.agents.set(unique, a);
    p.log.append('agent_created', { agent: unique, role, task, generation, thread: a.thread });
    return a;
  }

  ensureOrchestrator(p) {
    const cur = p.orchestrator();
    if (cur && !cur.retiring) return cur;
    const a = this.createAgent(p, { role: 'orchestrator' });
    this.notice(p, 'orchestrator', `${a.name} holds the orchestrator role${p.board.latestHandoff() ? ', starting from the latest handoff' : ''}.`);
    return a;
  }

  startWorker(p, name, task, by = 'you') {
    const w = this.createAgent(p, { name, role: 'worker', task });
    p.log.append('message', { thread: w.thread, from: by, text: task });
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
    if (s.decisions_needed.length) lines.push(`Decisions waiting on the human: ${s.decisions_needed.map(n => 'D' + String(n).padStart(4, '0')).join(', ')}`);
    if (s.next_step) lines.push(`Proposed next step: ${s.next_step}`);
    this.ensureOrchestrator(p).send(lines.join('\n'));
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
    if (orch?.live) orch.send(`The human made these calls:\n${lines.join('\n')}\nCarry on with them.`);
    else for (const w of p.workers().filter(w => w.live)) w.send(`The human made these calls:\n${lines.join('\n')}`);
    return done.map(x => x.d);
  }

  // ---------- approvals (tool permission prompts become cards) ----------
  requestApproval(p, agent, toolName, input, { signal, title, description } = {}) {
    return new Promise(resolvePromise => {
      const id = randomUUID();
      const finish = (result, how) => {
        if (!this.approvals.has(id)) return;
        this.approvals.delete(id);
        p.log.append('approval_result', { thread: agent.thread, approval: id, how });
        resolvePromise(result);
      };
      this.approvals.set(id, { p, agent, toolName, input, finish });
      p.log.append('approval', { thread: agent.thread, approval: id, agent: agent.name, tool: toolName, input, title: title || null, description: description || null });
      signal?.addEventListener('abort', () => finish({ behavior: 'deny', message: 'Cancelled' }, 'cancelled'));
    });
  }

  answerApproval(id, allow, note) {
    const a = this.approvals.get(id);
    if (!a) throw new Error('That approval is no longer waiting (the agent may have restarted).');
    a.finish(allow ? { behavior: 'allow', updatedInput: a.input } : { behavior: 'deny', message: note || 'The human declined this.' }, allow ? 'allowed' : 'denied');
  }

  // ---------- the orchestrator role ----------
  onIdle(p, agent) {
    if (agent.retiring) return this.finishRetire(p, agent);
    if (agent.role === 'orchestrator' && agent.contextPct != null && agent.contextPct >= this.retireAt) {
      this.notice(p, 'orchestrator', `${agent.name} is at ${agent.contextPct}% of its context; handing the role on.`);
      this.retire(p);
    }
  }

  retire(p) {
    const orch = p.orchestrator();
    if (!orch) throw new Error('No orchestrator to retire');
    if (orch.retiring) return;
    orch.retiring = true;
    if (!orch.sessionId) return this.finishRetire(p, orch); // never started; nothing to hand off
    orch.send(RETIRE_MESSAGE);
    orch.retireTimer = setTimeout(() => this.finishRetire(p, orch), 5 * 60 * 1000);
  }

  finishRetire(p, orch) {
    clearTimeout(orch.retireTimer);
    if (orch.state === 'retired' && !orch.retiring) return;
    orch.retiring = false;
    orch.close();
    orch.setState('retired');
    p.log.append('agent_retired', { agent: orch.name, thread: 'orchestrator' });
    const h = p.board.latestHandoff();
    this.notice(p, 'orchestrator', `${orch.name} retired${h && h.from === orch.name ? ` and left handoff ${h.entryId}` : ' without a handoff'}. The next orchestrator starts when there is something to do.`);
  }

  // ---------- views ----------
  state() {
    return [...this.projects.values()].map(p => ({
      name: p.name, dir: p.dir,
      agents: [...p.agents.values()].map(a => ({ name: a.name, role: a.role, thread: a.thread, state: a.state, task: a.task, contextPct: a.contextPct, live: a.live })),
      events: p.log.events,
      board: p.board.snapshot(),
      pendingApprovals: [...this.approvals.entries()].filter(([, a]) => a.p === p).map(([id]) => id)
    }));
  }
}
