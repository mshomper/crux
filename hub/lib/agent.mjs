// One Claude Code agent hosted through the Agent SDK (decision 0001).
// Runs on the machine's Claude Code login, so usage comes from the user's plan.
import { userContent } from './attachments.mjs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { cruxTools, cruxToolNames } from './tools.mjs';
import { orchestratorPrompt, workerPrompt } from './prompts.mjs';
import { rulesEntry, CONNECTOR_SERVERS } from './permission-rules.mjs';
import { UsageLedger, baselineFor } from './usage.mjs';
import { EFFORTS, EffortCeilings, modelLabel, modelId, effortLevel } from './agent-types.mjs';
import { isNoOutputNudge } from './conductor.mjs';
import { Expedition, ROLES as EXPEDITION_ROLES, DISALLOWED_TOOLS as EXPEDITION_DISALLOWED } from './expedition.mjs';

// meta: what the hub wants to know about a message once Claude Code takes it in (onYield): a Conductor brief's request
// id (decision 62), so a reminder goes only for a brief really delivered.
export class Inbox {
  constructor() { this.items = []; this.waiters = []; this.closed = false; this.onYield = null; }
  push(x, meta = null) { const w = this.waiters.shift(); if (w) w(); this.items.push({ x, meta }); }
  close() { this.closed = true; for (const w of this.waiters.splice(0)) w(); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.items.length) { const { x, meta } = this.items.shift(); if (meta) this.onYield?.(meta); yield x; continue; }
      if (this.closed) return;
      await new Promise(r => this.waiters.push(r));
    }
  }
}

// When the hub is started from inside a Claude session (desktop app or terminal), the parent's session
// variables leak in and make agents expect the host to sign them in. Agents get their own clean environment
// and use the machine's own Claude Code login (or CLAUDE_CODE_OAUTH_TOKEN if you set one).
const KEEP = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY']);
export function cleanEnv() {
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
  constructor(hub, project, { name, role, task = '', goal = '', generation = 0, sessionId = null, state = 'asleep', predecessor = null, handoffEntry = null, type = null, model = null, effort = null, expedition = null, expeditionRole = null }) {
    Object.assign(this, { hub, project, name, role, task, goal, generation, sessionId, state, predecessor, handoffEntry });
    // The Expedition module: the expedition this agent belongs to (its id) and its role in it. Set only by the hub,
    // saved in agent_created and carried on every usage event; permissions and routing key on these, never on anything
    // the agent writes.
    Object.assign(this, { expedition: expedition || null, expeditionRole: expedition ? expeditionRole || null : null });
    // Decision 20: the agent type it was started as, and its model and effort (null = Claude Code's default).
    // modelSeen is what Claude Code reported at start-up, so a default model still shows its name and colour.
    Object.assign(this, { type, model, effort, modelSeen: null, restartWhenIdle: false });
    this.questionsLeft = predecessor ? 3 : 0;
    // Role threads keep their name across holders: 'orchestrator' in a project, 'conductor' hub-wide (decision 55).
    this.thread = role === 'orchestrator' || role === 'conductor' ? role : name;
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

  // The Expedition watchdog's stop (phase 3): end the turn now. The SDK answers within milliseconds with an error result
  // (error_during_execution, aborted_streaming) that still carries usage, the session stays alive for its next message,
  // and the turn's in-flight subagents and their shell tasks are killed with it (spike, M046). An agent that is not in a
  // turn gets no result from an interrupt, so nothing is sent for it and false comes back.
  async interrupt() {
    const q = this.q;
    if (!q || !['working', 'starting'].includes(this.state) || typeof q.interrupt !== 'function') return false;
    this.interrupted = true;   // the error result that follows is the hub's doing: no "stopped" notice, no error flag
    try { await q.interrupt(); return true; }
    catch (e) { this.interrupted = false; console.warn(`[${this.project.name}/${this.name}] interrupt failed:`, e.message); return false; }
  }

  // Backstop for the interrupt: the subagent tasks the hub counted that are still open are stopped one by one.
  async stopTasks() {
    const q = this.q;
    if (!q || typeof q.stopTask !== 'function') return 0;
    let n = 0;
    for (const id of [...(this.subagents?.keys() || [])]) { try { await q.stopTask(id); n++; } catch { /* already over */ } }
    return n;
  }

  // meta (optional): { request } for a Conductor brief (decision 62); noted as delivered once Claude Code takes it in.
  send(textMsg, attachments = [], meta = null) {
    if (this.state === 'retired' && !this.retiring) throw new Error(`${this.name} has retired`);
    // A test hub: the message is in the log, but no Claude Code process starts.
    if (this.hub.noAgents) {
      if (!this.toldNoAgents) { this.toldNoAgents = true; this.hub.notice(this.project, this.thread, `Test hub: ${this.name} does not start here, so messages to it are kept but not read.`); }
      return;
    }
    const message = this.userMessage(this.withNotes(textMsg), attachments);   // built first: a missing image fails before start-up
    if (!this.q) this.start();
    this.lastMeta = meta;
    this.lastMessage = message;   // kept in case the run is refused at start-up and must go again (restartAfterRefusal)
    this.inbox.push(message, meta);
    this.setState('working');
  }

  // Decision 64 A: the folder each tool call runs in, as Claude Code reports it to the PreToolUse hook (a cd in an
  // earlier command carries over, so a worker in its worktree is in its worktree). The permission checker starts
  // there instead of the project folder. Kept for the last 64 calls; looked up by the SDK's tool call id.
  noteCwd(input) {
    if (!input || typeof input.cwd !== 'string' || !input.cwd || typeof input.tool_use_id !== 'string') return;
    (this.toolCwds ||= new Map()).set(input.tool_use_id, input.cwd);
    if (this.toolCwds.size > 64) this.toolCwds.delete(this.toolCwds.keys().next().value);
  }
  cwdFor(toolUseID) { return (toolUseID && this.toolCwds?.get(toolUseID)) || null; }

  // The Expedition module (plan 2b item 4): a gatherer's tool request arrives through its Lead's own permission callback,
  // so it carries the Lead's name and tag. The hook sees which subagent made the call (agent_id, agent_type; absent on the
  // Lead's own calls). Kept for the last 64 calls, by the SDK's tool call id. Changes no decision: it only lets the log say
  // "a gatherer asked for this".
  noteSubagent(input) {
    if (!this.expedition || typeof input?.tool_use_id !== 'string' || typeof input.agent_id !== 'string' || !input.agent_id) return;
    (this.toolSubagents ||= new Map()).set(input.tool_use_id, { id: input.agent_id, type: typeof input.agent_type === 'string' ? input.agent_type : null });
    if (this.toolSubagents.size > 64) this.toolSubagents.delete(this.toolSubagents.keys().next().value);
  }
  // { id, type } of the subagent behind a permission request, or null when the Lead asked itself. agentID: the SDK's
  // canUseTool field; the type comes from the hook (by tool call id), else from a task the hub counted for that id.
  subagentFor(toolUseID, agentID = null) {
    const seen = (toolUseID && this.toolSubagents?.get(toolUseID)) || null;
    const id = agentID || seen?.id || null;
    if (!id) return null;
    const task = [...(this.subagents?.values() || [])].find(t => t.agent === id || t.taskId === id);
    return { id, type: seen?.type || task?.type || null };
  }

  // Decision 62: a Conductor brief reached Claude Code as input for this agent. Logged with the agent's name, so a
  // successor is never reminded of a brief it never had.
  noteDelivered(meta) {
    if (meta?.request) this.project.log.append('brief_delivered', { request: meta.request, agent: this.name });
    if (meta?.approval) this.project.log.append('approval_delivered', { approval: meta.approval, agent: this.name });
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

  // The Lead's gatherer definition for the query's `agents` option (decision 68 C): the expedition-gatherer type file, with
  // the model and effort the launch screen picked for the gatherers (hub.json defaults and the file otherwise). The Lead
  // calls it with the Agent tool; the limit of 4 at once and one second round is in its file and brief. null for anyone else.
  expeditionAgents() {
    if (this.expeditionRole !== 'lead' || !this.expedition) return null;
    const p = this.project;
    const type = this.hub.agentTypes(p).get(EXPEDITION_ROLES.gatherer.type);
    if (!type) return null;
    const pick = new Expedition(p, this.expedition).state().started?.roles?.gatherer || {};
    const model = modelId(pick.model) || type.model, effort = effortLevel(pick.effort) || type.effort;
    return {
      [type.name]: {
        description: type.description || 'Answers one expedition sub-question with notes and sources',
        prompt: type.prompt,
        ...(type.tools?.length ? { tools: type.tools.filter(t => !t.startsWith('mcp__')) } : {}),
        disallowedTools: EXPEDITION_DISALLOWED,
        ...(model ? { model } : {}), ...(effort ? { effort } : {})
      }
    };
  }

  // The query options for this agent's next start. Kept apart from start() so tests can check them.
  options() {
    // The Conductor (decision 55) has its own prompt, tools and permission callback, and nothing from disk.
    if (this.role === 'conductor') return this.hub.conductor.options(this);
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
      disallowedTools: [...(this.role === 'orchestrator' ? ['NotebookEdit'] : []), ...(this.expedition ? EXPEDITION_DISALLOWED : []), ...(connectors ? [] : CONNECTOR_SERVERS)],
      ...(this.expeditionRole === 'lead' && this.expeditionAgents() ? { agents: this.expeditionAgents() } : {}),
      ...(connectors ? {} : { settings: { disableClaudeAiConnectors: true } }),
      permissionMode: this.role === 'worker' ? 'acceptEdits' : 'default',
      canUseTool: (toolName, input, opts) => this.hub.requestApproval(p, this, toolName, input, opts),
      // Only notes where the call runs (noteCwd); it never allows, denies or changes anything.
      // Notes where the call runs (noteCwd) and which subagent made it; the one thing it can refuse is the Expedition Lead's
      // Agent tool after a hub stop (hub.expeditionToolBlock). Everything else is left to the permission callback.
      hooks: { PreToolUse: [{ hooks: [async input => {
        this.noteCwd(input); this.noteSubagent(input);
        const why = input?.agent_id ? null : this.hub.expeditionToolBlock?.(p, this, input?.tool_name);
        return why ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } } : {};
      }] }] },
      ...(builtIn?.length ? { tools: builtIn } : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      ...(this.sessionId ? { resume: this.sessionId } : {})
    };
  }

  // options() plus the process environment: the clean one, with what the role adds on top (the Conductor's quiet tools).
  queryOptions() {
    const options = this.options();
    options.env = { ...cleanEnv(), ...(options.env || {}) };
    return options;
  }

  // ---------- effort ceiling (routing guide 9.1) ----------
  // The model a ceiling is kept for: the one picked, else the one Claude Code reported at start-up.
  effortKey() { return this.model || this.modelSeen || null; }

  // The agent now runs at a lower effort than asked: logged like any settings change, and one line in its thread.
  noteLowered(asked, level, known) {
    this.effort = level;
    this.project.log.append('agent_settings', { agent: this.name, thread: this.thread, by: 'hub', effort: level });
    // A lower forced by the hub counts in the usage panel like any other (routing guide 9.5).
    const model = this.effortKey();
    this.project.log.append('raise', { agent: this.name, thread: this.thread, by: 'hub', direction: 'lower', agentType: this.type, from: { model, effort: asked }, to: { model, effort: level }, reason: `${modelLabel(model)} does not accept effort ${asked}` });
    this.hub.notice(this.project, this.thread, `${modelLabel(this.effortKey())} does not accept effort ${asked}${known ? ' (the hub has seen it refused before)' : ''}, so ${this.name} runs at ${level || 'its default'} instead. The hub remembers this for that model.`);
  }

  // The SDK refused this agent's effort (error text given): learn the model's ceiling and drop to the highest level it
  // accepts. Returns the new level, or null when this was no effort refusal or nothing lower exists.
  lowerForRefusal(text) {
    const asked = this.effort, key = this.effortKey();
    if (!asked || !key || !EffortCeilings.isRefusal(text)) return null;
    const level = this.hub.effortCeilings?.learn(key, asked, text);
    if (!level) return null;
    this.noteLowered(asked, level, false);
    return level;
  }

  // Start the query again after a refusal, with the message the refused run had taken in.
  restartAfterRefusal() {
    const again = this.lastMessage, meta = this.lastMeta;
    try { this.inbox?.close(); } catch { }
    try { this.q?.close(); } catch { }
    this.q = null;
    this.start();
    if (again) this.inbox.push(again, meta);   // with its meta, so a Conductor brief's delivery is still tracked
    this.setState('working');
  }

  start() {
    const p = this.project;
    // A ceiling the hub already knows for this model: start at the highest accepted level.
    const known = this.effort ? this.hub.effortCeilings?.clamp(this.effortKey(), this.effort) : this.effort;
    if (known !== this.effort) this.noteLowered(this.effort, known, true);
    this.inbox = new Inbox();
    this.inbox.onYield = meta => this.noteDelivered(meta);
    this.beginRun();
    const options = this.queryOptions();
    // Decision 54 B: the desktop app's hub runs the Claude Code its setup screen downloaded (or one installed on the
    // PC); a clone's SDK finds its own copy, and no path is passed.
    const claude = this.hub.claudeCode?.();
    if (claude) options.pathToClaudeCodeExecutable = claude;
    this.restartWhenIdle = false;
    const q = this.q = query({ prompt: this.inbox, options });
    this.setState('starting');
    this.loop(q).catch(err => {
      // A refused effort level may come as a thrown error: drop to what the model accepts and go again, once per refusal.
      if (this.q === q && this.lowerForRefusal(err?.message)) return this.restartAfterRefusal();
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
        if (effort !== undefined) await this.applyEffortLive(q, effort);
      })(), late]);
      return true;
    } catch (e) {
      console.warn(`[${this.project.name}/${this.name}] live settings change failed:`, e.message);
      return false;
    } finally { clearTimeout(timer); }
  }

  // The live effort switch (routing guide 9.1): a level the model is known to refuse is lowered first; one the SDK
  // refuses now is learned, lowered and tried again, down the ladder, until a level is taken.
  async applyEffortLive(q, effort) {
    const key = this.effortKey();
    let level = effort ? this.hub.effortCeilings?.clamp(key, effort) ?? effort : effort;
    const known = level !== effort;
    for (let i = 0; i <= EFFORTS.length; i++) {
      try { await q.applyFlagSettings({ effortLevel: level || null }); break; }
      catch (e) {
        const lower = level && key && EffortCeilings.isRefusal(e?.message) ? this.hub.effortCeilings?.learn(key, level, e.message) : null;
        if (!lower) throw e;
        level = lower;
      }
    }
    if (level !== effort) this.noteLowered(effort, level, known);
  }

  async loop(q) {
    for await (const m of q) await this.onMessage(m, q);
  }

  // One SDK message. Kept apart from loop() so tests can feed it messages.
  async onMessage(m, q) {
    // The Expedition watchdog (phase 3) counts every assistant message of an expedition agent, a gatherer's included
    // (the stream carries subagent frames with agent_id), once per message id.
    if (m.type === 'assistant' && this.expedition) this.hub.expeditionWatch?.onAssistant(this, m);
    if (isNoOutputNudge(m)) {
      // The Conductor may end a turn with no text (a wake that needs nothing). Should Claude Code still ask it for
      // visible output, what it writes in reply stays out of its thread, and no summary is posted, until the result.
      if (this.role === 'conductor') this.quietTurn = true;
    } else if (m.type === 'system' && m.subtype === 'init') {
      if (m.model && m.model !== this.modelSeen) this.modelSeen = m.model;
      if (m.session_id !== this.sessionId) {
        this.sessionId = m.session_id;
        this.project.log.append('agent_session', { agent: this.name, sessionId: m.session_id, model: m.model, effort: this.effort, agentType: this.type });
      }
    } else if (m.type === 'system' && /^task_(started|progress|notification)$/.test(m.subtype) && this.expeditionRole === 'lead') {
      this.onTask(m);
    } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
      // Decision 62: when this turn started (its first output since the last result), so the reminder knows which
      // briefs were delivered before it.
      if (!this.inTurn) { this.inTurn = true; this.turnStartedAt = Date.now(); }
      const blocks = m.message?.content || [];
      const said = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (said && !this.quietTurn) this.hub.agentSaid(this.project, this, said);
      for (const b of blocks.filter(b => b.type === 'tool_use')) {
        this.hub.emit({ type: 'activity', project: this.project.name, thread: this.thread, agent: this.name, text: describeTool(b) });
      }
    } else if (m.type === 'rate_limit_event') {
      this.hub.usage?.rateLimit(m.rate_limit_info, this.project);
    } else if (m.type === 'result') {
      this.quietTurn = false;
      // The turn that just ended: its start, and whether it ended in an error (no reminder then).
      // A turn the watchdog interrupted ends in an error result by design: not an error, and no notice for it.
      const cut = this.interrupted && m.terminal_reason === 'aborted_streaming';
      if (this.interrupted) this.interrupted = false;
      this.lastTurn = { start: this.inTurn ? this.turnStartedAt : Date.now(), end: Date.now(), error: !cut && !!m.is_error && m.subtype !== 'success' };
      this.inTurn = false;
      this.logUsage(m);
      if (this.expedition) this.hub.expeditionWatch?.onResult(this);   // the result's figure replaces the estimate
      // A refused effort level may come back as an error result instead: lower it and run the message again.
      const errText = m.is_error ? [m.result, ...(m.errors || [])].filter(Boolean).join(' ') : '';
      if (errText && this.q === q && this.lowerForRefusal(errText)) return this.restartAfterRefusal();
      try { this.contextPct = Math.round((await q.getContextUsage()).percentage); } catch { /* older CLI */ }
      if (/not logged in/i.test(m.result || '')) {
        this.hub.notice(this.project, this.thread, 'Claude Code is not signed in on this machine. Stop the hub, run "npm run login" in the hub folder, sign in with your Claude plan, then start the hub again.');
      } else if (m.is_error && m.subtype !== 'success' && !cut) {
        this.hub.notice(this.project, this.thread, `${this.name} stopped: ${m.subtype.replace(/_/g, ' ')}`);
      }
      this.setState('idle');
      this.hub.onIdle(this.project, this);
    }
  }

  // The Expedition module (decision 68 C, plan 2b item 5): the Lead's gatherers are Claude Code subagents inside its query.
  // The SDK says when one starts, how far it has got, and how it ended; the hub counts them (the map's badge) and logs each
  // as an expedition_subagent event. It does not cap them: the limit of 4 at once and one second round is in the Lead's
  // file and brief. Background and housekeeping tasks (a shell, a watcher) are not gatherers and are left out.
  onTask(m) {
    if (m.ambient || m.skip_transcript || (m.task_type && m.task_type !== 'local_agent')) return;
    const id = String(m.task_id || '');
    if (!id) return;
    const ex = new Expedition(this.project, this.expedition);
    const live = (this.subagents ||= new Map());
    if (m.subtype === 'task_started') {
      if (live.has(id)) return;
      const type = m.subagent_type || 'subagent';
      live.set(id, { taskId: id, type, tokens: 0, startedAt: Date.now(), agent: null });
      ex.subagent({ phase: 'started', subagentType: type, taskId: id });
    } else if (m.subtype === 'task_progress') {
      const t = live.get(id);
      // total_tokens is the size of the subagent's latest call, not what it has spent so far (spike M046). The watchdog
      // counts a gatherer's spend from its own assistant frames; this and tool_uses are only its fallback lower bound.
      if (t && Number.isFinite(m.usage?.total_tokens)) { t.tokens = m.usage.total_tokens; t.toolUses = m.usage.tool_uses ?? t.toolUses; }
    } else {
      const t = live.get(id);
      if (!t) return;   // not one the hub saw start (a restart in between): nothing to close
      live.delete(id);
      const tokens = Number.isFinite(m.usage?.total_tokens) ? m.usage.total_tokens : t.tokens;
      ex.subagent({ phase: 'ended', subagentType: t.type, taskId: id, tokens, status: m.status || null });
    }
  }

  // A new query cannot have the old one's subagents: any the log still shows as running ended with it.
  closeOpenSubagents() {
    const ex = new Expedition(this.project, this.expedition);
    const open = new Map();
    for (const e of ex.state().subagents) { if (e.phase === 'started') open.set(e.taskId, e); else open.delete(e.taskId); }
    for (const e of open.values()) ex.subagent({ phase: 'ended', subagentType: e.subagentType, taskId: e.taskId, status: 'stopped' });
    this.subagents = new Map();
  }

  // A new query starts: its running totals start over, and the session it resumes (if any) is remembered, since
  // that session's first result already carries its earlier turns (decision 36).
  beginRun() {
    if (this.expeditionRole === 'lead') this.closeOpenSubagents();
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
    p.log.append('usage', { agent: this.name, project: p.name, sessionId: this.sessionId, agentType: this.type, model: this.model || this.modelSeen || null, effort: this.effort, models: r.delta, costUSD: r.costUSD, totals: r.totals, ...(this.expedition ? { expedition: this.expedition, expeditionRole: this.expeditionRole } : {}), ...(r.baseline ? { baseline: true } : {}), ...(r.reset ? { reset: true } : {}) });
    this.hub.usage?.note();
  }

  close() {
    try { this.inbox?.close(); } catch { }
    try { this.q?.close(); } catch { }
    this.q = null;
  }
}
