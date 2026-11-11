// One Claude Code agent hosted through the Agent SDK (decision 0001).
// Runs on the machine's Claude Code login, so usage comes from the user's plan.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { cruxTools, cruxToolNames } from './tools.mjs';
import { orchestratorPrompt, workerPrompt } from './prompts.mjs';

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
  constructor(hub, project, { name, role, task = '', goal = '', generation = 0, sessionId = null, state = 'asleep', predecessor = null, handoffEntry = null }) {
    Object.assign(this, { hub, project, name, role, task, goal, generation, sessionId, state, predecessor, handoffEntry });
    this.questionsLeft = predecessor ? 3 : 0;
    this.thread = role === 'orchestrator' ? 'orchestrator' : name;
    this.q = null;
    this.inbox = null;
    this.cost = 0;
    this.contextPct = null;
  }

  get live() { return !!this.q; }

  setState(state) {
    this.state = state;
    this.hub.emit({ type: 'agent_state', project: this.project.name, thread: this.thread, agent: this.name, state, contextPct: this.contextPct });
  }

  send(textMsg) {
    if (this.state === 'retired' && !this.retiring) throw new Error(`${this.name} has retired`);
    if (!this.q) this.start();
    this.inbox.push({ type: 'user', message: { role: 'user', content: this.hub.memory.personalize(textMsg) }, parent_tool_use_id: null });
    this.setState('working');
  }

  start() {
    const p = this.project;
    const m = this.hub.memory;
    const mem = { index: p.board.index(), core: m.core(), pack: m.pack(p.name), conventions: m.conventions() };
    const append = m.personalize(this.role === 'orchestrator'
      ? orchestratorPrompt({ project: p.name, handoff: p.board.latestHandoff(), generation: this.generation, ...mem })
      : workerPrompt({ project: p.name, name: this.name, task: this.task, handoff: this.handoffEntry ? p.board.read(this.handoffEntry) : null, ...mem }));

    this.inbox = new Inbox();
    const options = {
      cwd: p.dir,
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      settingSources: ['user', 'project', 'local'],
      mcpServers: { crux: cruxTools(this.hub, p, this) },
      allowedTools: cruxToolNames(this),
      disallowedTools: this.role === 'orchestrator' ? ['NotebookEdit'] : [],
      permissionMode: this.role === 'worker' ? 'acceptEdits' : 'default',
      canUseTool: (toolName, input, opts) => this.hub.requestApproval(p, this, toolName, input, opts),
      ...(this.sessionId ? { resume: this.sessionId } : {})
    };
    options.env = cleanEnv();
    this.q = query({ prompt: this.inbox, options });
    this.setState('starting');
    this.loop().catch(err => {
      console.error(`[${p.name}/${this.name}]`, err);
      this.hub.notice(p, this.thread, `${this.name} stopped with an error: ${err.message}`);
      this.setState('error');
    }).finally(() => { this.q = null; this.inbox = null; if (!['retired', 'error'].includes(this.state)) this.setState('asleep'); });
  }

  async loop() {
    for await (const m of this.q) {
      if (m.type === 'system' && m.subtype === 'init') {
        if (m.session_id !== this.sessionId) {
          this.sessionId = m.session_id;
          this.project.log.append('agent_session', { agent: this.name, sessionId: m.session_id, model: m.model });
        }
      } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
        const blocks = m.message?.content || [];
        const said = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        if (said) this.hub.agentSaid(this.project, this, said);
        for (const b of blocks.filter(b => b.type === 'tool_use')) {
          this.hub.emit({ type: 'activity', project: this.project.name, thread: this.thread, agent: this.name, text: describeTool(b) });
        }
      } else if (m.type === 'result') {
        this.cost += m.total_cost_usd || 0;
        try { this.contextPct = Math.round((await this.q.getContextUsage()).percentage); } catch { /* older CLI */ }
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

  close() {
    try { this.inbox?.close(); } catch { }
    try { this.q?.close(); } catch { }
    this.q = null;
  }
}
