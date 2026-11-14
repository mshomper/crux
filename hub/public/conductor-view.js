// The Conductor in the page (decision 55): the hub-wide agent whose thread sits at the top of All projects (decision 42),
// above every project's waiting cards and agents. Pure functions on the state /api/state sends as "conductor"
// (lib/conductor.mjs view()), shared by app.js and the tests.
//
// c: { place, thread, role, name, state, contextPct, model, modelSeen, effort, live, retiring, retireAt, activity,
//      waiting, wakes, pendingWake, events }

export const CONDUCTOR = '~conductor';      // its place name in URLs and live events (lib/conductor.mjs)
export const CONDUCTOR_THREAD = 'conductor';
export const SHOWN = 6;                     // the latest items shown; the rest fold behind "Show earlier"
export const SHOWN_PHONE = 2;               // on a phone: so the waiting cards are on the first screen (decision 32)

// Its holder as an agent the shared drawing understands (robot, model chip, context ring). With no holder yet it is
// asleep and has no model: the plain helmet with the halo.
export function agentOf(c) {
  if (!c) return null;
  return { name: c.name || 'Conductor', role: 'conductor', thread: CONDUCTOR_THREAD, state: c.state || 'asleep', contextPct: c.contextPct ?? null,
    model: c.model || null, modelSeen: c.modelSeen || null, effort: c.effort || null, type: null, live: !!c.live, retiring: c.retiring || false };
}

// Its place, shaped like a project where cards and messages are drawn (attachments come from /att/~conductor/...).
export function placeOf(c) {
  c.events ||= [];
  return { name: CONDUCTOR, events: c.events, board: { decisions: [] }, retireAt: c.retireAt, get agents() { return c.name ? [agentOf(c)] : []; } };
}

// A live event under its place name: logged ones join its events; state and activity update it. False: not for it.
export function applyEvent(c, ev) {
  if (!c || ev?.project !== CONDUCTOR) return false;
  if (ev.logged) { c.events.push(ev); return true; }
  if (ev.type === 'agent_state') {
    c.state = ev.state; c.contextPct = ev.contextPct ?? c.contextPct; if (ev.agent) c.name = ev.agent;
    if (!['working', 'starting'].includes(ev.state)) c.activity = '';
    return true;
  }
  if (ev.type === 'activity') { c.activity = `${ev.agent}: ${ev.text}`; return true; }
  return false;
}

// What its thread shows, oldest first: messages, round summaries, notices, pictures, reminders and the update batches
// that woke it. Usage and start-up events stay out.
const SHOWS = new Set(['message', 'summary', 'notice', 'visual', 'lesson_proposed', 'wake', 'reminder']);
export const threadItems = c => (c?.events || []).filter(e => e.thread === CONDUCTOR_THREAD && SHOWS.has(e.type));

// The latest few (n: SHOWN on a desk, SHOWN_PHONE on a phone), or all once you asked for the earlier ones.
// hidden: how many are folded.
export function shownItems(items, open = false, n = SHOWN) {
  const hidden = open ? 0 : Math.max(0, items.length - n);
  return { shown: items.slice(hidden), hidden };
}

// One line for the thread list and the section's head: its latest word, else what it is for.
export function lastLine(c) {
  const ev = threadItems(c).filter(e => ['message', 'summary', 'notice'].includes(e.type)).at(-1);
  if (!ev) return 'Ask what waits for you across projects';
  if (ev.type === 'summary') return `Summary: ${(ev.done || [])[0] || ev.next_step || 'posted'}`;
  return `${ev.from === 'you' ? 'You: ' : ''}${String(ev.text || '').replace(/^\[Hub: [^\]]*\]\s*/, '')}`;
}

// "Updates from 3 projects woke it": the batch line, short, with the projects named.
export function wakeLine(ev) {
  const lines = String(ev.text || '').split('\n').filter(l => l.startsWith('- '));
  const names = [...new Set(lines.map(l => l.slice(2).split(':')[0]).filter(n => !/^Reminder /.test(n)))];
  const reminders = lines.filter(l => /^- Reminder /.test(l)).length;
  const parts = [];
  if (names.length) parts.push(`${lines.length - reminders} update${lines.length - reminders === 1 ? '' : 's'} from ${names.join(', ')}`);
  if (reminders) parts.push(`${reminders} reminder${reminders === 1 ? '' : 's'} due`);
  return `Woken by ${parts.join(' and ') || 'updates'}`;
}
