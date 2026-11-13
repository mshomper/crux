// One Claude Code agent hosted through the Agent SDK (decision 0001).
// Runs on the machine's Claude Code login, so usage comes from the user's plan.
import { userContent } from './attachments.mjs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { cruxTools, cruxToolNames } from './tools.mjs';
import { orchestratorPrompt, workerPrompt } from './prompts.mjs';
import { rulesEntry, CONNECTOR_SERVERS } from './permission-rules.mjs';
import { UsageLedger, baselineFor } from './usage.mjs';

class Inbox {
  constructor() { this.items = []; this.waiters = []; this.closed = false; }
  push(x) { const w = this.waiters.shift(); if (w) w(); this.items.push(x); }
  close() { this.closed = true; for (const w of this.waiters.splice(0)) w(); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.items.length) { yield this.items.shift(); continue; }
      if (this.closed) return;
      await new Promise(r => this.waiters.push(r));
    }
  }
}

// When the hub is started from inside a Claude session (desktop app or terminal), the parent's session
// variables leak in and make agents expect the host to sign them in. Agents get their own clean environment
// and use the machine's own Claude Code login (or CLAUDE_CODE_OAUTH_TOKEN if you set one).
const KEEP = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY']);
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if ((/^CLAUDE/.test(k) || /^ANTHROPIC_/.test(k)) && !KEEP.has(k)) continue;
    env[k] = v;
  }
  if (process.env.CRUX_HUB_USE_API_KEY !== '1') delete env.ANTHROPIC_API_KEY; // stay on the plan unless asked
  return env;
}

function describeTool(block) {
  const i = block.input || {};
  const short = s => String(s || '').split(/[\\/]/).slice(-2).join('/');
  switch (block.name) {
    case 'Read': return `Reading ${short(i.file_path)}`;
    case 'Edit': case 'Write': return `Editing ${short(i.file_path)}`;
    case 'Bash': return `Running ${String(i.command || '').slice(0, 60)}`;
    case 'Grep': case 'Glob': return `Searching for ${i.pattern}`;
    case 'WebSearch': return `Searching the web`;
    case 'WebFetch': return `Reading a web page`;
    default: return block.name.startsWith('mcp__crux__') ? `Board: ${block.name.slice(11).replace(/_/g, ' ')}` : `Using ${block.name}`;
  }
}

export class Agent {
  constructor(hub, project, { name, role, task = '', goal = '', generation = 0, sessionId = null, state = 'asleep', predecessor = null, handoffEntry = null, type = null, model = null, effort = null }) {
    Object.assign(this, { hub, project, name, role, task, goal, generation, sessionId, state, predecessor, handoffEntry });
    // Decision 20: the agent type it was started as, and its model and effort (null = Claude Code's default).
    // modelSeen is what Claude Code reported at start-up, so a default model still shows its name and colour.
    Object.assign(this, { type, model, effort, modelSeen: null, restartWhenIdle: false });
    this.questionsLeft = predecessor ? 3 : 0;
    this.thread = role === 'orchestrator' ? 'orchestrator' : name;
    this.q = null;
    this.inbox = null;
    this.cost = 0;                 // estimated spend logged by this hub process (decision 36)
    this.ledger = new UsageLedger();
    this.contextPct = null;
  }

  get live() { return !!this.q; }

  setState(state) {
    this.state = state;
    // M014: the start and end of each turn go in the log, so after a restart the hub knows who was mid-turn.
    // Not while the hub itself is stopping: its agents' turns are cut, not finished.
    const busy = state === 'working' || state === 'starting';
    // The end of a turn carries its context size, so the idle handoff (decision 37) still knows it after a restart.
    if (busy !== !!this.busyLogged && !this.hub.stopping) { this.busyLogged = busy; this.project.log.append('agent_busy', { agent: this.name, busy, ...(!busy && this.contextPct != null ? { contextPct: this.contextPct } : {}) }); }
    this.hub.emit({ type: 'agent_state', project: this.project.name, thread: this.thread, agent: this.name, state, contextPct: this.contextPct });
  }

  send(textMsg, attachments = []) {
    if (this.state === 'retired' && !this.retiring) throw new Error(`${this.name} has retired`);
    // A test hub: the message is in the log, but no Claude Code process starts.
    if (this.hub.noAgents) {
      if (!this.toldNoAgents) { this.toldNoAgents = true; this.hub.notice(this.project, this.thread, `Test hub: ${this.name} does not start here, so messages to it are kept but not read.`); }
      return;
    }
    const message = this.userMessage(this.withNotes(textMsg), attachments);   // built first: a missing image fails before start-up
    if (!this.q) this.start();
    this.inbox.push(message);
    this.setState('working');
  }

  // Notes the hub wants this agent to read, without waking it for them: they ride in front of its next message.
  noteForNextTurn(text) { (this.notes ||= []).push(text); }
  withNotes(textMsg) {
    if (!this.notes?.length) return textMsg;
    const out = `${this.notes.join('\n')}\n\n${textMsg || ''}`;
    this.notes = [];
    return out;
  }

  // The SDK user message (decision 23): images go in as image content blocks, so the agent sees them.
  userMessage(textMsg, attachments = []) {
    const text = this.hub.memory.personalize(textMsg || '');
    return { type: 'user', message: { role: 'user', content: userContent(text, attachments, this.project.attachments) }, parent_tool_use_id: null };
  }

  // The query options for this agent's next start. Kept apart from start() so tests can check them.
  options() {
    const p = this.project;
    const m = this.hub.memory;
    const type = this.type ? this.hub.agentTypes(p).get(this.type) : null;
    const mem = { index: p.board.index(), core: m.core(), pack: m.pack(p.name), conventions: m.conventions() };
    // The permission rules it starts with, read from the board (decision 21). The hub repeats them in a request if they change.
    const rules = this.role === 'orchestrator' ? (this.hub.rulesFor ? this.hub.rulesFor(p) : rulesEntry(p.board)) : null;
    if (rules) this.rulesSeen = `${rules.entryId}@${rules.ts}`;
    const append = m.personalize(this.role === 'orchestrator'
      ? orchestratorPrompt({ project: p.name, handoff: p.board.latestHandoff(), generation: this.generation, types: this.hub.agentTypes(p).list(), permissionRules: rules, routing: this.hub.settings?.get('routePermissions') !== false, recordsDir: p.desk?.usable?.() ? p.desk.decisionsDir : '.decisions', ...mem })
      : workerPrompt({ project: p.name, name: this.name, task: this.task, handoff: this.handoffEntry ? p.board.read(this.handoffEntry) : null, type, ...mem }));
    // A type's tools are limits, as in Claude Code: they set which built-in tools it has. They do not skip
    // permission cards. The board tools are always there.
    const builtIn = type?.tools?.filter(t => !t.startsWith('mcp__'));
    // Matt's claude.ai connectors (mail, calendar, drive) are off unless this project turns them on: they are neither
    // connected (disableClaudeAiConnectors) nor offered (the known connector servers are disallowed by name).
    const connectors = this.hub.connectorsOn ? this.hub.connectorsOn(p) : false;
    return {
      cwd: p.dir,
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      settingSources: ['user', 'project', 'local'],
      mcpServers: { crux: cruxTools(this.hub, p, this) },
      allowedTools: cruxToolNames(this),
      disallowedTools: [...(this.role === 'orchestrator' ? ['NotebookEdit'] : []), ...(connectors ? [] : CONNECTOR_SERVERS)],
      ...(connectors ? {} : { settings: { disableClaudeAiConnectors: true } }),
      permissionMode: this.role === 'worker' ? 'acceptEdits' : 'default',
      canUseTool: (toolName, input, opts) => this.hub.requestApproval(p, this, toolName, input, opts),
      ...(builtIn?.length ? { tools: builtIn } : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      ...(this.sessionId ? { resume: this.sessionId } : {})
    };
  }

  start() {
    const p = this.project;
    this.inbox = new Inbox();
    this.beginRun();
    const options = this.options();
    options.env = cleanEnv();
    // Decision 54 B: the desktop app's hub runs the Claude Code its setup screen downloaded (or one installed on the
    // PC); a clone's SDK finds its own copy, and no path is passed.
    const claude = this.hub.claudeCode?.();
    if (claude) options.pathToClaudeCodeExecutable = claude;
    this.restartWhenIdle = false;
    const q = this.q = query({ prompt: this.inbox, options });
    this.setState('starting');
    this.loop(q).catch(err => {
      console.error(`[${p.name}/${this.name}]`, err);
      this.hub.notice(p, this.thread, `${this.name} stopped with an error: ${err.message}`);
      this.setState('error');
    }).finally(() => {
      if (this.q && this.q !== q) return;   // closed for a restart, and already started again
      this.q = null; this.inbox = null;
      if (!['retired', 'error'].includes(this.state)) this.setState('asleep');
    });
  }

  // Change model or effort while the query is running. False when it cannot, so the caller restarts it instead.
  // Bounded in time: the orchestrator may change its own settings from inside a tool call (set_agent_settings),
  // and a switch that never answers must not hold that call up; it then applies at the next start instead.
  async applyLive({ model, effort }, timeoutMs = 8000) {
    const q = this.q;
    if (!q) return false;
    let timer;
    const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error('no answer in time')), timeoutMs); });
    try {
      await Promise.race([(async () => {
        if (model !== undefined) await q.setModel(model || undefined);
        if (effort !== undefined) await q.applyFlagSettings({ effortLevel: effort || null });
      })(), late]);
      return true;
    } catch (e) {
      console.warn(`[${this.project.name}/${this.name}] live settings change failed:`, e.message);
      return false;
    } finally { clearTimeout(timer); }
  }

  async loop(q) {
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        if (m.model && m.model !== this.modelSeen) this.modelSeen = m.model;
        if (m.session_id !== this.sessionId) {
          this.sessionId = m.session_id;
          this.project.log.append('agent_session', { agent: this.name, sessionId: m.session_id, model: m.model, effort: this.effort, agentType: this.type });
        }
      } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
        const blocks = m.message?.content || [];
        const said = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        if (said) this.hub.agentSaid(this.project, this, said);
        for (const b of blocks.filter(b => b.type === 'tool_use')) {
          this.hub.emit({ type: 'activity', project: this.project.name, thread: this.thread, agent: this.name, text: describeTool(b) });
        }
      } else if (m.type === 'rate_limit_event') {
        this.hub.usage?.rateLimit(m.rate_limit_info, this.project);
      } else if (m.type === 'result') {
        this.logUsage(m);
        try { this.contextPct = Math.round((await q.getContextUsage()).percentage); } catch { /* older CLI */ }
        if (/not logged in/i.test(m.result || '')) {
          this.hub.notice(this.project, this.thread, 'Claude Code is not signed in on this machine. Stop the hub, run "npm run login" in the hub folder, sign in with your Claude plan, then start the hub again.');
        } else if (m.is_error && m.subtype !== 'success') {
          this.hub.notice(this.project, this.thread, `${this.name} stopped: ${m.subtype.replace(/_/g, ' ')}`);
        }
        this.setState('idle');
        this.hub.onIdle(this.project, this);
      }
    }
  }

  // A new query starts: its running totals start over, and the session it resumes (if any) is remembered, since
  // that session's first result already carries its earlier turns (decision 36).
  beginRun() {
    this.ledger = new UsageLedger();
    this.sessionAtStart = this.sessionId;
  }

  // Decision 36: one usage event per result, with what this result added per model. The result's modelUsage holds
  // running totals for the whole query, so the ledger keeps the last totals and only the difference is logged.
  // `cost` is this agent's estimated spend since the hub started counting it (not total_cost_usd added up again).
  logUsage(m) {
    const usage = m.modelUsage;
    if (!usage || !Object.keys(usage).length) return;
    const p = this.project;
    const fresh = !this.sessionAtStart;
    const baseline = this.ledger.totals ? null : baselineFor(p.log, this.name, this.sessionAtStart);
    const r = this.ledger.record(usage, { baseline, fresh });
    if (!Object.keys(r.delta).length && !r.baseline) { this.hub.usage?.note(); return; }
    this.cost += r.costUSD;
    p.log.append('usage', { agent: this.name, project: p.name, sessionId: this.sessionId, models: r.delta, costUSD: r.costUSD, totals: r.totals, ...(r.baseline ? { baseline: true } : {}), ...(r.reset ? { reset: true } : {}) });
    this.hub.usage?.note();
  }

  close() {
    try { this.inbox?.close(); } catch { }
    try { this.q?.close(); } catch { }
    this.q = null;
  }
}
