// The Retired section of the thread list: folded to one row, compact rows inside, and workers that retired more
// than RETIRED_RECENT_DAYS ago kept behind "Show older". Nothing is removed from the log; this only picks what shows.
// Pure functions, so the counts and the cut-off are tested without a page (test/retired-list.test.mjs).

export const RETIRED_RECENT_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

// When each agent retired: the time of its last agent_retired event, in ms.
export function retiredTimes(events = []) {
  const at = new Map();
  for (const e of events) if (e.type === 'agent_retired' && e.agent) { const t = Date.parse(e.ts); if (!Number.isNaN(t)) at.set(e.agent, t); }
  return at;
}

// Which retired workers show, newest retirement first.
//   recent: retired within the window. older: before it (or with no time found, which counts as old).
//   shown: recent, then the older ones if showOlder; the open thread is always kept, even when it is an old one.
//   count: the number on the "Retired (N)" row, always the recent ones, so it never jumps when older ones open.
//   holdsCurrent: the open thread is one of these workers, so the section opens to show it selected.
export function retiredView(workers, events, { now = Date.now(), showOlder = false, current = null, days = RETIRED_RECENT_DAYS } = {}) {
  const at = retiredTimes(events);
  const cutoff = now - days * DAY_MS;
  const list = workers.filter(a => a.state === 'retired')
    .map(a => ({ agent: a, at: at.get(a.name) ?? null }))
    .sort((x, y) => (y.at ?? -Infinity) - (x.at ?? -Infinity));
  const recent = list.filter(r => r.at != null && r.at >= cutoff).map(r => r.agent);
  const older = list.filter(r => r.at == null || r.at < cutoff).map(r => r.agent);
  const holdsCurrent = current != null && list.some(r => r.agent.thread === current);
  const shown = showOlder ? [...recent, ...older] : [...recent, ...older.filter(a => a.thread === current)];
  return { recent, older, shown, count: recent.length, olderCount: older.length, holdsCurrent, any: list.length > 0 };
}
