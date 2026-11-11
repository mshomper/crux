// What the live map shows, worked out from the hub's project state and event stream.
// No drawing here: stations, what needs you, the telemetry feed, and which pulses an event fires.

const MAX_FEED = 16;

export class MapModel {
  constructor() {
    this.retireAt = 60;
    this.project = null;
    this.pending = new Set();
    this.feed = [];
    this.activity = new Map();   // agent -> { text, ts }
    this.lastSeen = new Map();   // agent -> ts of its last event, for sorting who matters now
    this.seeded = null;          // project name the feed was seeded from
  }

  setProject(p, pending) {
    this.project = p || null;
    this.pending = pending || new Set();
    if (p && this.seeded !== p.name) this.seed(p);
  }

  // ---------- who is on the map ----------
  get holder() { return this.project?.agents.find(a => a.role === 'orchestrator' && a.state !== 'retired') || null; }

  get generation() {
    const h = this.holder;
    if (h) return Number(String(h.name).split('-').pop()) || 1;
    const gens = (this.project?.events || []).filter(e => e.type === 'agent_created' && e.role === 'orchestrator').map(e => e.generation || 0);
    return gens.length ? Math.max(...gens) : 0;
  }

  stationId(agentName) {
    const a = this.project?.agents.find(x => x.name === agentName);
    if (!a) return /^orchestrator-/.test(agentName || '') ? 'core' : null;
    return a.role === 'orchestrator' ? 'core' : a.name;
  }

  // Workers worth a station, in a stable order (creation), capped to `max` by what matters now.
  workers(max = 12) {
    const p = this.project;
    if (!p) return { list: [], hidden: 0 };
    const all = p.agents.filter(a => a.role === 'worker' && a.state !== 'retired');
    const needs = this.needsByThread();
    const traffic = this.traffic();
    const score = a => (needs.has(a.thread) ? 1e15 : 0) + (['working', 'starting'].includes(a.state) ? 1e14 : 0) + (this.lastSeen.get(a.name) || 0);
    const keep = new Set([...all].sort((x, y) => score(y) - score(x)).slice(0, max).map(a => a.name));
    const maxTraffic = Math.max(1, ...traffic.values());
    const list = all.filter(a => keep.has(a.name)).map(a => ({
      id: a.name, kind: 'worker', name: a.name, thread: a.thread, state: a.state || 'asleep',
      ctx: a.contextPct, needs: needs.has(a.thread), goal: goalOf(a),
      activity: this.activityOf(a.name),
      traffic: (traffic.get(a.thread) || 0) / maxTraffic
    }));
    return { list, hidden: all.length - list.length };
  }

  activityOf(agent) {
    const x = this.activity.get(agent);
    return x && Date.now() - x.ts < 20000 ? x.text : '';
  }

  // ---------- what needs you ----------
  pendingApprovals() {
    const p = this.project;
    if (!p) return [];
    const done = new Set(p.events.filter(e => e.type === 'approval_result').map(e => e.approval));
    return p.events.filter(e => e.type === 'approval' && !done.has(e.approval) && this.pending.has(e.approval));
  }

  // Same rule as the Needs you list: the latest summary that asked something, until someone else replies.
  openQuestions() {
    const p = this.project;
    if (!p) return [];
    const out = [];
    for (const t of new Set(p.events.map(e => e.thread).filter(Boolean))) {
      const evs = p.events.filter(e => e.thread === t);
      const i = evs.findLastIndex(e => e.type === 'summary' && e.questions?.length);
      if (i < 0) continue;
      if (evs.slice(i + 1).some(e => e.type === 'message' && e.from !== evs[i].from)) continue;
      out.push(evs[i]);
    }
    return out;
  }

  openDecisions() { return (this.project?.board?.decisions || []).filter(d => d.status === 'open' || d.status === 'found'); }

  needsByThread() {
    const s = new Set();
    for (const a of this.pendingApprovals()) s.add(a.thread);
    for (const q of this.openQuestions()) s.add(q.thread);
    return s;
  }

  needsCount() { return this.openDecisions().length + this.pendingApprovals().length + this.openQuestions().length; }

  boardCounts() {
    const b = this.project?.board || {};
    return { decisions: (b.decisions || []).length, entries: (b.entries || []).filter(e => e.status === 'active').length };
  }

  // How much has happened in each thread: messages, summaries, approvals, board posts.
  traffic() {
    const m = new Map();
    for (const e of this.project?.events || []) {
      if (!['message', 'summary', 'approval', 'entry'].includes(e.type) || !e.thread) continue;
      m.set(e.thread, (m.get(e.thread) || 0) + 1);
    }
    return m;
  }

  core() {
    const h = this.holder;
    const needs = this.needsByThread().has('orchestrator');
    return {
      holder: h ? h.name : null,
      generation: this.generation,
      state: h ? h.state || 'asleep' : 'vacant',
      ctx: h?.contextPct ?? null,
      retireAt: this.retireAt,
      needs,
      activity: h ? this.activityOf(h.name) : ''
    };
  }

  // ---------- events ----------
  seed(p) {
    this.seeded = p.name;
    this.feed = [];
    this.activity.clear();
    this.lastSeen.clear();
    for (const ev of p.events) {
      const who = ev.agent || ev.from;
      if (who && who !== 'you') this.lastSeen.set(who, Date.parse(ev.ts) || 0);
    }
    for (const ev of p.events.slice(-60)) { const line = this.describe(ev); if (line) this.feed.unshift(line); }
    this.feed.length = Math.min(this.feed.length, MAX_FEED);
  }

  // Turn one hub event into feed lines and pulses. Returns { pulses, line, core } for the view to animate.
  ingest(ev) {
    const out = { pulses: [], line: null, core: null };
    const who = ev.agent || ev.from;
    if (who && who !== 'you') this.lastSeen.set(who, Date.now());
    if (ev.type === 'activity') {
      this.activity.set(ev.agent, { text: ev.text, ts: Date.now() });
      out.spin = this.stationId(ev.agent);
    }
    if (ev.type === 'agent_state' && !['working', 'starting'].includes(ev.state)) this.activity.delete(ev.agent);
    out.pulses = this.pulsesFor(ev);
    if (ev.type === 'agent_created' && ev.role === 'orchestrator') out.core = 'handoff';
    if (ev.type === 'agent_retired') out.core = 'retire';
    const line = this.describe(ev);
    if (line) {
      // Repeated tool use by one agent replaces its last line instead of flooding the feed.
      if (ev.type === 'activity' && this.feed[0]?.kind === 'activity' && this.feed[0].actor === ev.agent) this.feed.shift();
      this.feed.unshift(line);
      this.feed.length = Math.min(this.feed.length, MAX_FEED);
      out.line = line;
    }
    return out;
  }

  pulsesFor(ev) {
    const id = n => this.stationId(n);
    const thread = t => t === 'orchestrator' ? 'core' : t;
    switch (ev.type) {
      case 'message': {
        if (ev.from === 'you') return [{ from: 'you', to: thread(ev.thread), tone: 'you' }];
        const src = id(ev.from);
        if (!src) return [];
        if (src === 'core') return [{ from: 'core', to: ev.thread === 'orchestrator' ? 'you' : ev.thread, tone: ev.thread === 'orchestrator' ? 'reply' : 'brief' }];
        return [{ from: src, to: 'you', tone: 'reply' }];
      }
      case 'summary': {
        const src = id(ev.from);
        if (!src) return [];
        return src === 'core' ? [{ from: 'core', to: 'you', tone: 'summary' }] : [{ from: src, to: 'core', tone: 'summary' }];
      }
      case 'entry': { const src = id(ev.from); return src ? [{ from: src, to: 'board', tone: 'entry' }] : []; }
      case 'pick': return [{ from: 'you', to: 'board', tone: 'pick' }, { from: 'you', to: 'core', tone: 'pick', delay: 260 }];
      case 'approval': { const src = id(ev.agent); return src ? [{ from: src, to: 'you', tone: 'alert' }] : []; }
      case 'approval_result': return [{ from: 'you', to: thread(ev.thread), tone: ev.how === 'allowed' ? 'you' : 'alert' }];
      case 'agent_created': return ev.role === 'worker' ? [{ from: 'core', to: ev.agent, tone: 'spawn', delay: 450 }] : [];
      default: return [];
    }
  }

  describe(ev) {
    const short = s => String(s || '').replace(/\s+/g, ' ').trim();
    const t = Date.parse(ev.ts) || Date.now();
    const L = (kind, actor, text, tone, target = '') => ({ id: ev.id || `${kind}-${t}-${Math.random()}`, kind, actor, target, text, tone, ts: t });
    const name = n => n === 'you' ? 'You' : n;
    switch (ev.type) {
      case 'message':
        if (ev.from === 'you') return L('message', 'You', short(ev.text), 'you', ev.thread === 'orchestrator' ? 'orchestrator' : ev.thread);
        return L('message', name(ev.from), short(ev.text), /^orchestrator-/.test(ev.from) ? 'brief' : 'reply', /^orchestrator-/.test(ev.from) && ev.thread !== 'orchestrator' ? ev.thread : 'you');
      case 'summary': return L('summary', ev.from, `finished a round${ev.done?.[0] ? ': ' + short(ev.done[0]) : ''}`, 'summary');
      case 'entry': return L('entry', ev.from, `posted ${ev.entryId || 'an entry'} to the board${ev.title ? ': ' + short(ev.title) : ''}`, 'entry');
      case 'pick': return L('pick', 'You', `picked D${String(ev.decision).padStart(4, '0')} ${short(ev.label)}`, 'pick');
      case 'approval': return L('approval', ev.agent, `asks to use ${ev.title || ev.tool}`, 'alert');
      case 'approval_result': return L('approval', 'You', `${ev.how || 'answered'} a request`, ev.how === 'allowed' ? 'you' : 'alert');
      case 'agent_created': return L('created', ev.agent, ev.role === 'orchestrator' ? `takes the orchestrator role (gen ${ev.generation})` : 'joined as a worker', ev.role === 'orchestrator' ? 'core' : 'spawn');
      case 'agent_retired': return L('retired', ev.agent, 'retired and handed the role on', 'core');
      case 'activity': return L('activity', ev.agent, short(ev.text), 'activity');
      default: return null;
    }
  }
}

export function goalOf(a) {
  if (a?.goal) return a.goal;
  const first = String(a?.task || '').split(/\n|(?<=\.)\s/)[0];
  return first.length > 90 ? first.slice(0, 88) + '…' : first;
}
