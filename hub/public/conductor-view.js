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
    model: c.model || null, modelSeen: c.modelSeen || null, effort: c.effort || null, type: null, live: !!c.live, retiring: c.retiring || false, restartPending: !!c.restartPending };
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
const SHOWS = new Set(['message', 'summary', 'notice', 'visual', 'lesson_proposed', 'wake', 'reminder', 'cards']);
export const threadItems = c => (c?.events || []).filter(e => e.thread === CONDUCTOR_THREAD && SHOWS.has(e.type));

// ---------- cards in its chat (decision 60 A) ----------
// A "cards" event holds the real cards the hub put in its thread: { items: [{ project, card }], digest?: 'return' |
// 'away' }. The Conductor's notes on them come as "cards_note" events: { of: <cards event id>, intro?, items: [{
// project, card, summary, recommend, fill }] }; the latest note per card wins.
export const itemKey = it => `${it.project}|${it.card}`;
export const cardKind = card => String(card || '').slice(0, String(card || '').indexOf(':'));
export const cardId = card => String(card || '').slice(String(card || '').indexOf(':') + 1);
export const KIND_LABEL = { approval: 'Permission', question: 'Question', decision: 'Decision' };
export function cardNotes(events, id) {
  const out = { intro: '', items: new Map() };
  for (const e of events || []) if (e.type === 'cards_note' && e.of === id) {
    if (e.intro) out.intro = e.intro;
    for (const it of e.items || []) out.items.set(itemKey(it), it);
  }
  return out;
}

// What "Take all recommendations" sends, for the cards still waiting. look(item) describes one card as the page sees
// it: null when it no longer waits, else { kind, options (decision letters), status (decision), open (question rows
// [{ i }]), stops (permission hard stops), recommended (the decision record's own pick) }.
// - a decision: the Conductor's letter when it is one of the options, else the record's own recommendation; a found
//   decision only on "confirm" or "reject";
// - a question with one row still open: the reply text (several rows are answered one by one, on the card);
// - a permission card: "allow" or "deny", never one carrying a hard stop (those take their own tap).
// Returns [{ project, kind, id, choice | text + index | allow }].
export function recommendedActions(ev, notes, look) {
  const out = [];
  for (const it of ev?.items || []) {
    const c = look(it);
    if (!c) continue;
    const fill = String(notes.items.get(itemKey(it))?.fill || '').trim(), id = cardId(it.card);
    if (c.kind === 'decision') {
      if (c.status === 'found') { const w = /^(confirm|yes)\b/i.test(fill) ? 'confirm' : /^reject\b/i.test(fill) ? 'reject' : ''; if (w) out.push({ project: it.project, kind: 'decision', id: Number(id), choice: w }); continue; }
      const letter = fill.match(/^([A-Za-z])\b/)?.[1]?.toUpperCase();
      const choice = letter && (c.options || []).includes(letter) ? letter : c.recommended && (c.options || []).includes(c.recommended) ? c.recommended : '';
      if (choice) out.push({ project: it.project, kind: 'decision', id: Number(id), choice });
    } else if (c.kind === 'question') {
      if (fill && c.open?.length === 1) out.push({ project: it.project, kind: 'question', id, index: c.open[0].i, text: fill });
    } else if (c.kind === 'approval') {
      if (c.stops?.length) continue;
      if (/^allow\b/i.test(fill)) out.push({ project: it.project, kind: 'approval', id, allow: true });
      else if (/^deny\b/i.test(fill)) out.push({ project: it.project, kind: 'approval', id, allow: false });
    }
  }
  return out;
}

// The digest's first line when the Conductor has not written its intro (yet): "4 need you, from 3 projects."
export function digestLine(waiting, projects) {
  if (!waiting) return 'Everything here is answered.';
  return `${waiting} need${waiting === 1 ? 's' : ''} you, from ${projects} project${projects === 1 ? '' : 's'}.`;
}

// The latest few (n: SHOWN on a desk, SHOWN_PHONE on a phone), or all once you asked for the earlier ones.
// hidden: how many are folded.
export function shownItems(items, open = false, n = SHOWN) {
  const hidden = open ? 0 : Math.max(0, items.length - n);
  return { shown: items.slice(hidden), hidden };
}

// One line for the thread list and the section's head: its latest word, else what it is for.
export function lastLine(c) {
  const ev = threadItems(c).filter(e => ['message', 'summary', 'notice', 'cards'].includes(e.type)).at(-1);
  if (!ev) return 'Ask what waits for you across projects';
  if (ev.type === 'summary') return `Summary: ${(ev.done || [])[0] || ev.next_step || 'posted'}`;
  if (ev.type === 'cards') { const n = ev.items?.length || 0; return `${ev.digest ? 'Digest: ' : ''}${n} card${n === 1 ? '' : 's'} for you`; }
  return `${ev.from === 'you' ? 'You: ' : ''}${String(ev.text || '').replace(/^\[Hub: [^\]]*\]\s*/, '')}`;
}

// All projects' Waiting row (decision 59 B). fold: what you opened or folded ({ waiting }); n: how much waits.
// On a phone it opens by default whenever something waits (decision 32); with nothing waiting it is closed and your
// last choice is forgotten, so the next card opens it again.
export function waitingOpen(fold, n, phone) {
  if (!n) { delete fold.waiting; return false; }
  return fold.waiting ?? !!phone;
}
// After you send from the All projects box: Waiting folds, so the Conductor's reply lands in view under your message.
export function foldAfterSend(fold) { fold.waiting = false; return fold; }

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
