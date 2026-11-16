// The report's generated parts (spec 4.3 and 8): pure functions of the event log, so the figures are measured, not
// estimated (lesson 7 of the reference run). Section 7, "how it ran", is here; the finished card and the claims check
// come in phase 5.
import { ROLES } from './expedition.mjs';

// The order rows are shown in: the hub roles. The gatherers are subagents inside the Lead (decision 68 C): they have no row
// of their own, and the Lead's row says so.
const ROW_ORDER = ['lead', 'advisor', 'synthesizer', 'skeptic', 'builder', 'verifier'];
export const LEAD_LABEL = 'Lead (incl. gatherers)';
export const NOT_SPLIT_NOTE = 'Gatherers run inside the Lead, so their time and cost are in the Lead\'s line and are not split out.';

const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
const label = role => (role === 'lead' ? LEAD_LABEL : ROLES[role]?.label || role);

// Time, tokens and cost per role, loops and the stop reason, from the events of one expedition.
// events: the project's event log (all of it is fine; other expeditions' and non-expedition events are ignored).
export function howItRan(events, id) {
  const mine = events.filter(e => e.expedition === id);
  const started = mine.find(e => e.type === 'expedition_started') || null;
  const stopped = mine.findLast(e => e.type === 'expedition_stopped') || null;
  const roleOf = new Map(mine.filter(e => e.type === 'agent_created').map(e => [e.agent, e.expeditionRole]));
  const rows = new Map();
  const row = role => {
    if (!rows.has(role)) rows.set(role, { role, label: label(role), agents: new Set(), turns: 0, workMs: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, costUSD: 0 });
    return rows.get(role);
  };
  for (const e of mine.filter(e => e.type === 'usage')) {
    const r = row(e.expeditionRole || roleOf.get(e.agent) || 'unknown');
    r.agents.add(e.agent);
    const models = Object.values(e.models || {});
    if (models.length) r.turns++;
    for (const m of models) for (const k of Object.keys(r.tokens)) r.tokens[k] += num(m[k]);
    r.costUSD += num(e.costUSD);
  }
  // Time at work: from each agent's busy marks (agent_busy carries no expedition tag, so match by the agent's name).
  // A turn still open at the stop counts up to the stop (or the last event).
  const names = new Set(roleOf.keys());
  let end = stopped ? Date.parse(stopped.ts) : 0;
  if (!stopped) for (const e of events) end = Math.max(end, Date.parse(e.ts) || 0);
  const openSince = new Map();
  for (const e of events) {
    if (e.type !== 'agent_busy' || !names.has(e.agent)) continue;
    const role = roleOf.get(e.agent), t = Date.parse(e.ts);
    if (e.busy) { if (!openSince.has(e.agent)) openSince.set(e.agent, t); continue; }
    if (openSince.has(e.agent)) { row(role).workMs += Math.max(0, t - openSince.get(e.agent)); openSince.delete(e.agent); row(role).agents.add(e.agent); }
  }
  for (const [agent, t] of openSince) { const r = row(roleOf.get(agent)); r.workMs += Math.max(0, end - t); r.agents.add(agent); }

  const ordered = [...rows.values()].sort((a, b) => (ROW_ORDER.indexOf(a.role) + 1 || 99) - (ROW_ORDER.indexOf(b.role) + 1 || 99)).map(r => ({ ...r, agents: [...r.agents] }));
  const totals = { turns: 0, workMs: 0, costUSD: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } };
  for (const r of ordered) {
    totals.turns += r.turns; totals.workMs += r.workMs; totals.costUSD += r.costUSD;
    for (const k of Object.keys(totals.tokens)) totals.tokens[k] += r.tokens[k];
  }
  return {
    id,
    rows: ordered,
    totals,
    elapsedMs: started && stopped ? Math.max(0, Date.parse(stopped.ts) - Date.parse(started.ts)) : null,
    stopReason: stopped?.reason || null,
    loops: mine.filter(e => e.type === 'expedition_loop').map(e => ({ number: e.number, passing: e.passing, progress: !!e.progress })),
    decisions: mine.filter(e => e.type === 'expedition_decision').length,
    parked: mine.filter(e => e.type === 'expedition_parked' && e.kind !== 'lesson').length,
    lessons: mine.filter(e => e.type === 'expedition_parked' && e.kind === 'lesson').length,
    notes: ordered.some(r => r.role === 'lead') ? [NOT_SPLIT_NOTE] : []
  };
}

const dur = ms => { if (ms == null) return 'n/a'; const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };
const tok = n => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const usd = n => `$${n.toFixed(2)}`;

// Section 7 of REPORT.md as Markdown. "Lessons" is left for the Lead to add; this part is only what the log says.
export function howItRanMarkdown(r) {
  const out = ['## How it ran', ''];
  out.push(`Generated from the hub's event log (usage events and expedition events), not estimated. Stop reason: ${r.stopReason || 'not stopped yet'}. Elapsed: ${dur(r.elapsedMs)}.`, '');
  out.push('| Role | Agents | Turns | Time at work | Tokens (in / out) | Cost |', '|---|---|---|---|---|---|');
  for (const x of r.rows) out.push(`| ${x.label} | ${x.agents.length} | ${x.turns} | ${dur(x.workMs)} | ${tok(x.tokens.input + x.tokens.cacheRead + x.tokens.cacheCreation)} / ${tok(x.tokens.output)} | ${usd(x.costUSD)} |`);
  out.push(`| **Total** | | ${r.totals.turns} | ${dur(r.totals.workMs)} | ${tok(r.totals.tokens.input + r.totals.tokens.cacheRead + r.totals.tokens.cacheCreation)} / ${tok(r.totals.tokens.output)} | ${usd(r.totals.costUSD)} |`);
  for (const n of r.notes) out.push('', n);
  out.push('', `Build-verify loops: ${r.loops.length ? r.loops.map(l => `${l.number} (${l.passing} passing${l.progress ? '' : ', no progress'})`).join('; ') : 'none'}. Decisions made on the user's behalf: ${r.decisions}. Parked: ${r.parked}.${r.lessons ? ` Core lessons held: ${r.lessons}.` : ''}`);
  return out.join('\n');
}
