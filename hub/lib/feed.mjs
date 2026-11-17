// What the page is sent of a project, and how it is kept up to date (decision 74 B, step A: "load less").
//
// The page used to receive every event of the log and work out what waits on you from them, so its start-up and its
// every refresh grew with the log. Now:
//  - each thread sends its newest conversation events (pageEvents); the rest is paged on request (olderPage);
//  - what waits on you (question cards, old open permission requests, per-thread decision asks, unread and traffic
//    counts) is worked out here, from the whole log, with the very same rules the page used (public/questions.js);
//  - after something changes, the page gets a small patch of the parts that changed (diffParts), not the state again.

import { DISPLAY, NOT_SENT, threadOf, countsAsUnread, countsAsTraffic } from '../public/feed-rules.js';
import { openQuestions, repeatsIn } from '../public/questions.js';

export const KEEP = 6;              // a thread always sends its newest events of this many, whatever their age
export const WINDOW = 30;           // and up to this many of the last day
export const RECENT_MS = 86400e3;
export const SUMMARIES = 4;         // past its newest KEEP events, a thread sends no more once it has sent this many summaries (the newest KEEP count among them)
export const PAGE = 150;            // events one "Show older" brings
export const RETIRED_MS = 14 * 86400e3; // retired agents older than this go as bare names
const TEXT_CUT = 400;

const ts = e => Date.parse(e.ts) || 0;
const agentThreads = agents => new Map(agents.map(a => [a.name, a.thread]));

// Per thread, newest first: which conversation events fall outside what the page is sent. The cut is one line per
// thread (everything older than it is out), so "Show older" can page back from it without gaps.
// `from`: where the live log starts in `events` (the ones before it come from the snapshot, decision 74 B; their
// conversation is read from the archive, not shown from memory).
function cutOff(events, threads, now, from = 0) {
  const seen = new Map(), summaries = new Map(), closed = new Set(), out = new Set(), since = now - RECENT_MS;
  for (let i = events.length - 1; i >= from; i--) {
    const e = events[i];
    if (!DISPLAY.has(e.type)) continue;
    const t = threadOf(e, threads);
    if (closed.has(t)) { out.add(e); continue; }
    const n = (seen.get(t) || 0) + 1;
    seen.set(t, n);
    const s = (summaries.get(t) || 0) + (e.type === 'summary' ? 1 : 0);
    summaries.set(t, s);
    if (n > KEEP && (n > WINDOW || ts(e) < since || s > SUMMARIES)) { closed.add(t); out.add(e); }
  }
  return out;
}

// A usage event as the meters read it: when, who, which kind of agent, and the tokens and cost by model.
const slimUsage = e => ({ id: e.id, ts: e.ts, type: e.type, agent: e.agent, agentType: e.agentType, role: e.role, models: e.models });
const withoutBody = ({ body, ...e }) => e;
const slimCreated = e => (e.task && e.task.length > 200 ? { ...e, task: e.task.slice(0, 200) } : e);

// The events the page is sent for one project: { events, older } with older = how many conversation events of each
// thread were left out.
// usageSince: the meters read today and since the hub started, so older usage events are not sent.
export function pageEvents(events, agents, now = Date.now(), usageSince = 0, from = 0) {
  const threads = agentThreads(agents), out = cutOff(events, threads, now, from), send = [], older = {};
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (NOT_SENT.has(e.type) || (i < from && DISPLAY.has(e.type))) continue;
    if (out.has(e)) { const t = threadOf(e, threads); older[t] = (older[t] || 0) + 1; continue; }
    if (e.type === 'usage') { if (ts(e) >= usageSince) send.push(slimUsage(e)); continue; }
    send.push(e.type === 'agent_created' ? slimCreated(e) : e.type === 'entry' ? withoutBody(e) : e);   // an entry's words come when it is opened on the board
  }
  return { events: send, older };
}

// "Show older": the PAGE conversation events of a thread that come just before `before` (the id of the oldest one the
// page holds for it; none: the newest left out). stale: the id is not one of this thread's, so the page should reload.
// Past the events in memory it reads the archive (decision 74 B): archive = { page({ thread, before, exclude, n, threadOf }),
// count } from the log, where count is how many conversation events of the thread are in the archive and not in memory.
// beforeTs: the time of `before`, for a page that holds archived events (they are not in memory to look up).
export function olderPage(events, agents, thread, before = '', now = Date.now(), archive = null, beforeTs = '', from = 0) {
  const threads = agentThreads(agents), mine = events.filter((e, i) => i >= from && DISPLAY.has(e.type) && threadOf(e, threads) === thread);
  const fromArchive = (anchor, n) => archive.page({ thread, before: anchor, exclude: new Set(mine.map(e => e.id)), n, threadOf: e => threadOf(e, threads) });
  let end;
  if (before) {
    end = mine.findIndex(e => e.id === before);
    if (end < 0) {
      if (!archive || !beforeTs) return { events: [], left: 0, stale: true };   // not an event this hub knows for the thread
      const ap = fromArchive({ id: before, ts: beforeTs }, PAGE);
      return { events: ap.events, left: ap.left };
    }
  } else { const out = cutOff(events, threads, now, from); end = mine.findIndex(e => !out.has(e)); if (end < 0) end = mine.length; }
  const start = Math.max(0, end - PAGE);
  let page = mine.slice(start, end), left = start + (archive?.count || 0);
  if (start === 0 && archive && page.length < PAGE) {   // memory is used up: the rest comes from the archive
    const ap = fromArchive(page[0] || mine[end] || null, PAGE - page.length);
    page = [...ap.events, ...page]; left = ap.left;
  }
  return { events: page, left };
}

// Agents for the page: live and recently retired in full; long-retired ones as bare names (the older retired list
// shows only who they were).
export function agentsFor(views, events, now = Date.now()) {
  const retiredAt = new Map();
  for (const e of events) if (e.type === 'agent_retired') retiredAt.set(e.agent, ts(e));
  return views.map(a => {
    if (a.state !== 'retired') return a;
    const at = retiredAt.get(a.name);
    // recently retired: whole, but its task and goal cut (the thread header shows the start of them)
    if (at && at >= now - RETIRED_MS) return { ...a, ...(a.task ? { task: a.task.slice(0, TEXT_CUT) } : {}), ...(a.goal ? { goal: String(a.goal).slice(0, TEXT_CUT) } : {}) };
    return { name: a.name, role: a.role, thread: a.thread, state: a.state, type: a.type, model: a.model, effort: a.effort, predecessor: a.predecessor, ...(a.expedition ? { expedition: a.expedition, expeditionRole: a.expeditionRole } : {}) };
  });
}

// What waits on you and the counts the page used to work out from the whole log, from the whole log, here.
// pending: the ids of the permission requests the hub still holds; only those are named (when given).
// carried: the unread and traffic counts of events the log's snapshot left out (lib/archive.mjs), so they count as before.
export function waitingOf(events, agents, decisions, pending = null, carried = null) {
  const holds = pending ? new Set(pending) : null;
  const opts = { decisionStatus: id => (decisions || []).find(d => d.id === Number(id))?.status, decisions: decisions || [] };
  const threads = agentThreads(agents);
  const resolved = new Set(), askedDecisions = {}, counts = {}, traffic = {};
  for (const e of events) if (e.type === 'approval_result') resolved.add(e.approval);
  for (const e of events) {
    if (NOT_SENT.has(e.type)) continue;
    const t = threadOf(e, threads);
    if (e.type === 'summary' && e.thread) for (const n of e.decisions_needed || []) (askedDecisions[e.thread] ||= new Set()).add(Number(n));
    if (countsAsTraffic(e) && e.thread) traffic[e.thread] = (traffic[e.thread] || 0) + 1;   // the map counts a thread's own events only
    if (t === '-') continue;   // no thread: it counts in none
    if (countsAsUnread(e)) counts[t] = (counts[t] || 0) + 1;
  }
  for (const [t, n] of Object.entries(carried?.counts || {})) counts[t] = (counts[t] || 0) + n;
  for (const [t, n] of Object.entries(carried?.traffic || {})) traffic[t] = (traffic[t] || 0) + n;
  return {
    questions: openQuestions(events, opts),
    repeats: Object.fromEntries(repeatsIn(events, opts)),
    // the permission requests the hub still holds without an answer, whatever their age
    approvals: events.filter(e => e.type === 'approval' && !resolved.has(e.approval) && (!holds || holds.has(e.approval))),
    askedDecisions: Object.fromEntries(Object.entries(askedDecisions).map(([t, s]) => [t, [...s]])),
    counts, traffic
  };
}

// ---------- patches ----------
// A project's view split into parts that change on their own: each agent, each decision, each board entry, and every
// other top-level field (the waiting parts one each). A patch is the parts whose text changed, plus the ones gone.
export function partsOf(view) {
  const m = new Map();
  for (const a of view.agents || []) m.set(`a:${a.name}`, a);
  for (const d of view.board?.decisions || []) m.set(`d:${d.id}`, d);
  for (const e of view.board?.entries || []) m.set(`e:${e.entryId}`, e);
  for (const [k, v] of Object.entries(view)) {
    if (['agents', 'board', 'wait', 'events', 'older', 'counts', 'traffic'].includes(k)) continue;
    m.set(`k:${k}`, v);
  }
  for (const [k, v] of Object.entries(view.wait || {})) if (!['counts', 'traffic'].includes(k)) m.set(`w:${k}`, v);
  return m;
}
// prev: Map key -> JSON text of the last parts sent (kept by the caller); returns { patch, next } or null when
// nothing changed. The order of agents and decisions comes along as `order` so the page can keep its lists in step.
export function diffParts(prev, view) {
  const parts = partsOf(view), next = new Map(), set = {};
  for (const [k, v] of parts) {
    const text = JSON.stringify(v ?? null);
    next.set(k, text);
    if (prev.get(k) !== text) set[k] = v ?? null;
  }
  const del = [...prev.keys()].filter(k => !next.has(k));
  if (!Object.keys(set).length && !del.length) return null;
  const order = { agents: (view.agents || []).map(a => a.name), decisions: (view.board?.decisions || []).map(d => d.id), entries: (view.board?.entries || []).map(e => e.entryId) };
  return { patch: { set, del, order }, next };
}
