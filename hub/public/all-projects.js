// All projects (decision 42 A): every project's waiting cards and every orchestrator and agent, in one column.
// Also the rules for what waits on Matt in one project (Needs you), so the two can never disagree.
// Pure functions on the page's state (no page objects), shared by app.js and the tests.
//
// A project in the page's state: { name, agents, events, board: { decisions }, permissionMode }.
// pending: the Set of permission request ids still waiting (from /api/state and the live stream).

import { openQuestions as askedOpen, pageStatus } from './questions.js';

// The column's thread id. It is hub-wide: valid in every project, and pinned in one project means pinned in all.
export const HUB_THREAD = 'all';

// ---------- what waits for Matt in one project ----------
export const openDecisions = p => p.board.decisions.filter(d => d.status === 'open' || d.status === 'found');
// Permission requests still waiting. Those with the orchestrator (decision 21) wait on it, not on you, until it
// escalates or runs out of time; you can still answer them, which overrides it.
export function waitingApprovals(p, pending) {
  const done = new Set(p.events.filter(e => e.type === 'approval_result').map(e => e.approval));
  return p.events.filter(e => e.type === 'approval' && !done.has(e.approval) && pending.has(e.approval));
}
export const escalation = (p, id) => p.events.findLast(e => e.type === 'approval_escalated' && e.approval === id);
export const withOrchestrator = (p, pending) => waitingApprovals(p, pending).filter(e => e.routedTo && !escalation(p, e.approval));
export const pendingApprovals = (p, pending) => waitingApprovals(p, pending).filter(e => !e.routedTo || escalation(p, e.approval));
// Questions agents asked that still wait on you; the rule lives in questions.js, shared with the map and the server.
export const openQuestions = p => askedOpen(p.events, { decisionStatus: pageStatus(p) });
// Lessons about you that an agent wants added to the core profile, until you add or skip them (one card).
export function pendingLessons(p) {
  const done = new Set(p.events.filter(e => e.type === 'lesson_result').map(e => e.lesson));
  return p.events.filter(e => e.type === 'lesson_proposed' && !done.has(e.lesson));
}
// Everything in a project that waits for you, by kind; count is how many cards Needs you shows.
export function waiting(p, pending) {
  const approvals = pendingApprovals(p, pending), questions = openQuestions(p), lessons = pendingLessons(p), decisions = openDecisions(p);
  return { approvals, questions, lessons, decisions, count: approvals.length + questions.length + (lessons.length ? 1 : 0) + decisions.length };
}
export const needsCount = (p, pending) => waiting(p, pending).count;
// What waits for you in one thread (a column's red count, decision 39; an agent's count in All projects): its
// permission cards and questions, and the open decisions its round summaries asked for.
export function threadWaiting(p, t, pending) {
  const open = new Set(openDecisions(p).map(d => d.id));
  const asked = new Set(p.events.filter(e => e.type === 'summary' && e.thread === t).flatMap(e => (e.decisions_needed || []).map(Number)).filter(id => open.has(id)));
  return pendingApprovals(p, pending).filter(e => e.thread === t).length + openQuestions(p).filter(q => q.thread === t).length + asked.size;
}

// ---------- the All projects column ----------
const busy = a => ['working', 'starting'].includes(a.state);
// A project's agents for the list: the orchestrator first, then workers that wait on you, then working ones, then
// the rest, each group in the order they started. Retired agents are left out.
export function rosterOf(p, pending) {
  const live = p.agents.filter(a => a.state !== 'retired');
  const rank = a => (threadWaiting(p, a.thread, pending) > 0 ? 0 : busy(a) ? 1 : 2);
  const workers = live.filter(a => a.role === 'worker').map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map(x => x.a);
  return [...live.filter(a => a.role === 'orchestrator'), ...workers];
}

// Every project at once: a group per project (in the hub's order), totals by kind for the count bar.
export function hubView(projects, pending) {
  const groups = projects.map(p => {
    const w = waiting(p, pending), agents = rosterOf(p, pending);
    return { p, name: p.name, mode: p.permissionMode === 'auto' ? 'Auto' : 'Ask', waiting: w, count: w.count, agents, working: agents.filter(busy).length };
  });
  const sum = f => groups.reduce((n, g) => n + f(g), 0);
  const kinds = [
    ['approval', sum(g => g.waiting.approvals.length), 'permission', 'permissions'],
    ['question', sum(g => g.waiting.questions.reduce((n, q) => n + q.open.length, 0)), 'question', 'questions'],
    ['lessons', sum(g => g.waiting.lessons.length ? 1 : 0), 'lesson card', 'lesson cards'],
    ['decision', sum(g => g.waiting.decisions.length), 'decision', 'decisions']
  ].filter(k => k[1]);
  return { groups, kinds, total: sum(g => g.count), agents: sum(g => g.agents.length), working: sum(g => g.working), projects: groups.length };
}

// The project a card or row belongs to: the nearest element marked data-pj (All projects), else the current one.
// Every answer from a card goes to this project, so a card answered in All projects reaches the right agent or
// decision without switching project.
export function projectOf(el, projects, current) {
  const name = el?.closest?.('[data-pj]')?.dataset.pj;
  return (name && projects.find(p => p.name === name)) || current;
}

// ---------- the context ring ----------
// How full an agent's context is, as a ring in its model's hue; the orchestrator's carries a gold mark at the
// hand-off point and turns gold over the last stretch (as the live map's core does). The figure is in the middle.
export const NEAR = 8;   // points before the hand-off where the orchestrator's ring turns gold
export function contextRing(a, { hue, retireAt = 60, size = 30 } = {}) {
  const pct = Math.round(Math.max(0, Math.min(100, Number(a?.contextPct) || 0)));
  const known = a?.contextPct != null;
  const sw = 3, r = size / 2 - sw - 1, c = 2 * Math.PI * r, mid = size / 2;
  const orch = a?.role === 'orchestrator', near = orch && pct >= retireAt - NEAR;
  const col = near ? '#f5c96a' : hue || '#6fe3ff';
  const ang = (retireAt / 100) * 2 * Math.PI - Math.PI / 2;
  const f = n => n.toFixed(2);
  const tick = orch ? `<line class="tick" x1="${f(mid + (r - sw) * Math.cos(ang))}" y1="${f(mid + (r - sw) * Math.sin(ang))}" x2="${f(mid + (r + sw) * Math.cos(ang))}" y2="${f(mid + (r + sw) * Math.sin(ang))}"/>` : '';
  const tip = known ? `${pct}% of context used${orch ? `; hands off at ${retireAt}%` : ''}` : 'Context not reported yet';
  return `<svg class="ctx-ring${near ? ' near' : ''}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="--rc:${col}" role="img" aria-label="${tip}"><title>${tip}</title>`
    + `<circle class="trk" cx="${mid}" cy="${mid}" r="${f(r)}" stroke-width="${sw}"/>`
    + (known ? `<circle class="arc" cx="${mid}" cy="${mid}" r="${f(r)}" stroke-width="${sw}" stroke="${col}" stroke-dasharray="${f(c * pct / 100)} ${f(c)}" transform="rotate(-90 ${mid} ${mid})"/>` : '')
    + `${tick}<text x="${mid}" y="${mid}">${known ? pct : '–'}</text></svg>`;
}
