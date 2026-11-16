// The Expedition module on the live map (decisions 68 to 72): what one running expedition looks like, worked out on the
// page from the project's agents and events. No drawing here. An expedition is one cluster: the Lead in the middle,
// one station for each of the five hub roles around it, a count of the gatherers running inside the Lead, and two
// thin arcs for the envelope (time and budget). Red is never used for it (decision 31): amber from 90%.

export const ROLE_ORDER = ['advisor', 'synthesizer', 'skeptic', 'builder', 'verifier'];
export const AMBER_AT = 0.9;   // the last 10% of time or budget is kept for the report (spec 4.4)

const busy = s => s === 'working' || s === 'starting';
const clamp01 = v => Math.min(1, Math.max(0, v));

// "20261116-json-bench" -> "json-bench"
export const slugOf = id => String(id || '').replace(/^\d{8}-/, '');

// The expedition the map shows: the newest one that has started and whose Lead has not sent its one summary yet.
export function liveExpedition(events) {
  const started = events.filter(e => e.type === 'expedition_started' && e.expedition);
  for (let i = started.length - 1; i >= 0; i--) {
    const id = started[i].expedition;
    if (!events.some(e => e.type === 'expedition_step' && e.step === 'summary' && e.expedition === id)) return started[i];
  }
  return null;
}

// Gatherers running now: started and not yet ended, by task id.
export function runningGatherers(events, id) {
  const open = new Set();
  for (const e of events) {
    if (e.type !== 'expedition_subagent' || e.expedition !== id) continue;
    if (e.phase === 'started') open.add(e.taskId); else open.delete(e.taskId);
  }
  return open.size;
}

// The whole picture for the map and the sidebar, or null when no expedition is running in this project.
//   p: { agents, events }, now: ms (a parameter so a test can fix it), activityOf: agent name -> what it is doing.
export function expeditionCluster(p, now = Date.now(), activityOf = () => '') {
  const events = p?.events || [];
  const started = liveExpedition(events);
  if (!started) return null;
  const id = started.expedition;
  const mine = events.filter(e => e.expedition === id);
  const stopped = mine.find(e => e.type === 'expedition_stopped') || null;
  const agents = (p.agents || []).filter(a => a.expedition === id);
  const phase = stopped ? 'writing up' : mine.some(e => e.type === 'expedition_gate') ? 'building' : 'planning';

  const view = (a, role) => {
    if (!a) return { role, id: null, thread: null, state: 'asleep', model: null, effort: null, ctx: null, activity: '', sub: 'not started' };
    const done = a.state === 'retired';
    const state = done ? 'asleep' : a.state || 'asleep';
    const activity = done ? '' : activityOf(a.name) || '';
    const sub = done ? 'done' : busy(state) ? activity || 'working' : state === 'idle' ? 'waits' : state === 'error' ? 'error' : 'asleep';
    return { role, id: a.name, thread: a.thread, state, model: a.model || a.modelSeen || null, effort: a.effort || null, ctx: a.contextPct ?? null, activity, sub, done };
  };
  // The Lead: the newest one that is not retired and not answering its successor.
  const lead = agents.findLast(a => a.expeditionRole === 'lead' && a.state !== 'retired' && a.retiring !== 'overlap')
    || agents.findLast(a => a.expeditionRole === 'lead') || null;
  const leadView = { ...view(lead, 'lead'), id: lead?.name || 'slot:lead' };
  const stations = ROLE_ORDER.map(role => {
    const v = view(agents.findLast(a => a.expeditionRole === role) || null, role);
    return { ...v, id: v.id || `slot:${role}` };
  });

  const env = started.envelope || {};
  const totalMs = (Number(env.hours) || 6) * 3600e3;
  const t0 = Date.parse(started.ts) || now;
  const t1 = stopped ? Date.parse(stopped.ts) || now : now;
  const usedMs = Math.max(0, t1 - t0);
  const usedUSD = mine.filter(e => e.type === 'usage').reduce((n, e) => n + (Number(e.costUSD) || 0), 0);
  const totalUSD = Number(env.dollars) > 0 ? Number(env.dollars) : null;
  const time = { usedMs, totalMs, pct: clamp01(usedMs / totalMs) };
  const budget = { usedUSD, totalUSD, pct: totalUSD ? clamp01(usedUSD / totalUSD) : null };
  const loops = mine.filter(e => e.type === 'expedition_loop');
  const gatherers = runningGatherers(events, id);
  const parked = mine.filter(e => e.type === 'expedition_parked' && e.kind !== 'lesson').length;
  return {
    id, name: slugOf(id), phase, lead: leadView, stations, gatherers, parked, loop: loops.length ? loops[loops.length - 1].number : 0,
    time, budget, amber: time.pct >= AMBER_AT || (budget.pct != null && budget.pct >= AMBER_AT), stopped: !!stopped
  };
}

// The words under the cluster and in the sidebar.
export function fmtDuration(ms) {
  const m = Math.max(0, Math.round(ms / 60000)), h = Math.floor(m / 60);
  return h ? `${h} h${m % 60 ? ` ${m % 60} m` : ''}` : `${m} m`;
}
export function fmtMoney(usd) {
  const v = Number(usd) || 0;
  return `$${v >= 10 ? Math.round(v) : (Math.round(v * 10) / 10).toString()}`;
}
export function clusterCaption(c) {
  const time = `time ${fmtDuration(c.time.usedMs)} of ${fmtDuration(c.time.totalMs)}`;
  const budget = c.budget.totalUSD ? `budget ${fmtMoney(c.budget.usedUSD)} of ${fmtMoney(c.budget.totalUSD)}` : 'budget figure not set';
  return { title: `EXPEDITION · ${c.name.toUpperCase()}`, time, budget, line: `${time}  ${budget}` };
}
// One line for the sidebar row: "building · loop 1 · 3 gatherers · 2 parked".
export function clusterLine(c) {
  return [c.phase, c.loop ? `loop ${c.loop}` : '', c.gatherers ? `${c.gatherers} gatherer${c.gatherers === 1 ? '' : 's'}` : '', c.parked ? `${c.parked} parked` : ''].filter(Boolean).join(' · ');
}
export const PARKED_TIP = n => `${n} parked: things outside the brief that the team did not guess. They are listed in the report.`;
// The members still alive, for the sidebar's small count (the Lead included).
export function liveMembers(p, id) { return (p.agents || []).filter(a => a.expedition === id && a.state !== 'retired').length; }
