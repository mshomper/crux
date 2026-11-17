// What the page is sent of a project's log (phone speed, 2026-11-16). The whole log was 12.5 MB at about 19,000 events,
// sent again on every refresh, and a thread of 2,000 messages was drawn in full. Now each thread sends its newest
// events in full; older ones of the big kinds go as small stubs (`old: true`, bulky fields removed) that keep every
// field the page reads to work out what is waiting (who, which thread, when, which question an answer closes), so
// Needs you, the map and the counts do not change. "Show older" fetches the full events back, a page at a time.
// Telemetry the page never reads (logged plan_usage, agent_busy, check_shadow) is not sent.

export const WINDOW = 40;  // full events per thread
export const PAGE = 150;     // older events fetched per "Show older"

const BULK = {
  message: ['text', 'attachments', 'images'],
  summary: ['done', 'handoff_notes', 'next_step', 'changed', 'open_questions', 'blocked_on', 'approvals'],
  approval: ['input', 'summary', 'description', 'stops'],
  permission_answer: ['command', 'reason'],
  notice: ['text'],
  visual: []
};
const NOT_SENT = new Set(['plan_usage', 'agent_busy', 'check_shadow']);

const keyOf = e => e.thread || '-';
const slimmable = e => e.type in BULK && e.type !== 'visual';

// The unresolved approvals stay full: they are cards waiting on you.
// A thread keeps its newest KEEP events whatever their age, and up to WINDOW of those from the last day (RECENT_MS): a thread
// last used a week ago still opens with its tail, and the dozens of finished worker threads cost almost nothing.
export const KEEP = 8;
export const RECENT_MS = 86400e3;
function plan(events, now) {
  const resolved = new Set();
  for (const e of events) if (e.type === 'approval_result') resolved.add(e.approval);
  const seen = new Map(), cut = new Map(), since = now - RECENT_MS;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!slimmable(e)) continue;
    const k = keyOf(e), n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    const keep = n <= KEEP || (n <= WINDOW && Date.parse(e.ts) >= since) || (e.type === 'approval' && !resolved.has(e.approval));
    if (!keep) cut.set(e, true);
  }
  return cut;
}

const slim = e => { const s = { ...e, old: true }; for (const f of BULK[e.type]) delete s[f]; return s; };

export function windowed(events, now = Date.now()) {
  const cut = plan(events, now), out = [];
  const older = {};
  for (const e of events) {
    if (NOT_SENT.has(e.type)) continue;
    if (cut.has(e)) { out.push(slim(e)); older[keyOf(e)] = (older[keyOf(e)] || 0) + 1; } else out.push(e);
  }
  return { events: out, older };
}

// Full events of a thread's stubs: the PAGE ending at the stub `before` (an event id; none = the newest stub).
export function olderPage(events, thread, before = '', now = Date.now()) {
  const cut = plan(events, now), all = events.filter(e => cut.has(e) && keyOf(e) === thread);
  let end = before ? all.findIndex(e => e.id === before) + 1 : all.length;
  if (end <= 0) end = before ? 0 : all.length;
  return { events: all.slice(Math.max(0, end - PAGE), end) };
}
