// Which thread an event belongs to, and which kinds the page gets only as a recent window (load less, 0.26.0).
// Shared by the server (lib/feed.mjs) and the page (app.js), so both count the same way. Plain JavaScript, no page code.

// The kinds drawn in a thread's conversation. The page gets each thread's newest of these; "Show older" pages the rest.
export const DISPLAY = new Set(['message', 'summary', 'approval', 'approval_result', 'permission_answer', 'notice', 'visual', 'entry']);
// Telemetry the page never reads: not sent.
export const NOT_SENT = new Set(['plan_usage', 'agent_busy', 'check_shadow']);

// A board entry shows in its poster's thread (the page does the same in threadEvents).
export const threadOf = (e, agentThread) => (e.type === 'entry' ? agentThread.get(e.from) || e.thread : e.thread) || '-';

// What the page counts as "something happened in this thread" (the unread dot) and as traffic (the map's activity).
export const countsAsUnread = e => e.type !== 'permission_answer' && !NOT_SENT.has(e.type);
export const countsAsTraffic = e => ['message', 'summary', 'approval', 'entry'].includes(e.type);
