// Which agent questions still wait on you: one rule for the Needs you list, the live map and phone notifications
// (the server imports this file too, so it stays plain JavaScript with no page code in it).
//
// A round summary's questions wait, each on its own, until:
// - you answer it from Needs you (a message of yours whose `answers` names it), or dismiss it;
// - every decision it names (decision 31, D0031, decisions 31 to 33) is picked.
// The whole card goes when someone other than the asker writes a plain message in its thread (you, or the
// orchestrator answering for you), when you dismiss the card, or when the agent that asked retires.
// Only the latest summary that asked something counts in each thread.

const SETTLED = s => !!s && !['open', 'found'].includes(s);

// The decision numbers a piece of text names: "D0031", "D31", "decision 31", "decisions 31, 32 and 33",
// "decisions 31 to 33", "D0031 to D0033". Ranges longer than 20 are ignored as noise.
export function decisionRefs(text) {
  const s = String(text || '');
  const ids = new Set();
  const range = (a, b) => { a = Number(a); b = Number(b); if (b >= a && b - a <= 20) for (let i = a; i <= b; i++) ids.add(i); };
  for (const m of s.matchAll(/\bD0*(\d{1,4})\s*(?:to|through|-|–)\s*D0*(\d{1,4})\b/g)) range(m[1], m[2]);
  for (const m of s.matchAll(/\bD0*(\d{1,4})\b/g)) ids.add(Number(m[1]));
  const list = /\bdecisions?\s+(D?\d{1,4}(?:\s*(?:,|\band\b|\bor\b|\bto\b|\bthrough\b|-|–)\s*D?\d{1,4})*)/gi;
  for (const m of s.matchAll(list)) {
    for (const part of m[1].split(/\s*(?:,|\band\b|\bor\b)\s*/i)) {
      const r = /^D?0*(\d{1,4})\s*(?:to|through|-|–)\s*D?0*(\d{1,4})$/i.exec(part.trim());
      if (r) { range(r[1], r[2]); continue; }
      const n = /^D?0*(\d{1,4})$/i.exec(part.trim());
      if (n) ids.add(Number(n[1]));
    }
  }
  return [...ids].sort((a, b) => a - b);
}

// A question is answered by your picks when it names at least one decision and every one it names exists and is
// no longer open. decisionStatus(id) gives a decision's status, or undefined when there is no such decision.
export function answeredByPicks(question, decisionStatus = () => undefined) {
  const ids = decisionRefs(question);
  return ids.length > 0 && ids.every(id => SETTLED(decisionStatus(id)));
}

// The summaries still asking you something, one per thread. Each has `open`: [{ i, text }] for the questions
// still waiting (i is the question's place in the summary), and `byPicks`: how many your picks answered.
export function openQuestions(events, opts) { const r = readCards(events, opts); return withoutRepeatCards(r.cards, r.settled); }

// Every summary card still asking something, before repeats are set aside (cards), and every question you yourself
// settled, in any summary (settled: { ts, thread, from, text }): answered, dismissed, or answered by your picks.
function readCards(events, { decisionStatus = () => undefined } = {}) {
  const dismissed = new Set(), retired = new Set();
  const gone = new Map();   // summary id -> Set of question places answered or dismissed one by one (by you)
  const mark = (id, i) => { if (!gone.has(id)) gone.set(id, new Set()); gone.get(id).add(Number(i)); };
  const last = new Map();   // thread -> { ev, answered, byYou }
  const asked = [];         // every summary that asked something, with how it was closed
  for (const e of events || []) {
    if (e.type === 'question_dismissed') { e.index == null ? dismissed.add(e.question) : mark(e.question, e.index); continue; }
    if (e.type === 'agent_retired') retired.add(e.agent);
    if (!e.thread) continue;
    if (e.type === 'summary' && e.questions?.length) { const s = { ev: e, answered: false, byYou: false }; last.set(e.thread, s); asked.push(s); }
    else if (e.type === 'message') {
      if (e.from === 'you' && Array.isArray(e.answers) && e.answers.length) { for (const a of e.answers) mark(a.question, a.index); continue; }
      // A Conductor brief (decision 55) logged in a project's thread is never an answer: only you (or the orchestrator
      // answering its worker) can settle a question that waits on you.
      if (e.conductor) continue;
      const q = last.get(e.thread);
      if (q && e.from !== q.ev.from && !q.answered) { q.answered = true; q.byYou = e.from === 'you'; }
    }
  }
  const settled = [];
  for (const { ev, byYou } of asked) {
    const done = gone.get(ev.id) || new Set(), all = byYou || dismissed.has(ev.id);
    ev.questions.forEach((text, i) => { if (all || done.has(i) || answeredByPicks(text, decisionStatus)) settled.push({ ts: ev.ts, thread: ev.thread, from: ev.from, text }); });
  }
  const cards = [];
  for (const { ev, answered } of last.values()) {
    if (answered || dismissed.has(ev.id) || retired.has(ev.from)) continue;
    const done = gone.get(ev.id) || new Set();
    let byPicks = 0;
    const open = [];
    ev.questions.forEach((text, i) => {
      if (done.has(i)) return;
      if (answeredByPicks(text, decisionStatus)) { byPicks++; return; }
      open.push({ i, text });
    });
    if (open.length) cards.push({ ...ev, open, byPicks, repeats: [] });
  }
  return { cards, settled };
}

// A question lives in one card (Matt, 2026-11-14). Where a later card in this project repeats a question an earlier
// card from another thread still holds open (an orchestrator re-asking its worker's question), the repeat is hidden
// here, where cards are drawn, and listed under the card's `repeats` ({ i, text, of: who holds it }). Nothing is
// dropped from the log. Once you answer or dismiss the first one, its repeats count as answered too (answered: true);
// if the first card closes without you (its agent retired or handed off, a newer summary, the orchestrator wrote into
// that thread), the repeat shows again by itself.
function withoutRepeatCards(cards, settled = []) {
  const shown = [];
  for (const c of [...cards].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) {
    const earlier = shown.filter(d => d.thread !== c.thread);
    const open = [];
    for (const q of c.open) {
      const holder = earlier.find(d => d.open.some(w => isRepeat(q.text, w.text)));
      const yours = !holder && settled.find(s => s.thread !== c.thread && String(s.ts) < String(c.ts) && isRepeat(q.text, s.text));
      if (holder) c.repeats.push({ ...q, of: holder.from, thread: holder.thread });
      else if (yours) c.repeats.push({ ...q, of: yours.from, thread: yours.thread, answered: true });
      else open.push(q);
    }
    c.open = open;
    if (open.length) shown.push(c);
  }
  return cards.filter(c => c.open.length);
}

// The repeats hidden from each summary's card, by summary id, for the small "also in w1's card" note in its thread.
export function repeatsIn(events, opts) {
  const { cards, settled } = readCards(events, opts), out = new Map();
  withoutRepeatCards(cards, settled);
  for (const c of cards) if (c.repeats.length) out.set(c.id, c.repeats);
  return out;
}

export function questionOpen(events, id, opts) { return openQuestions(events, opts).some(q => q.id === id); }

// Is `asked` a repeat of `open`, already waiting? Equal once case, punctuation and spacing are set aside, or shorter
// and found whole inside it; never a longer question (it asks more), and never a short one (under 24 characters
// cleaned: "Ship it?" is too common to match).
const plainWords = q => String(q || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function isRepeat(asked, open) {
  const x = plainWords(asked), y = plainWords(open);
  if (x.length < 24 || !y) return false;
  return x === y || (x.length < y.length && y.includes(x));
}

// The page's project state ({ events, board: { decisions } }) to the options above.
export const pageStatus = p => id => (p?.board?.decisions || []).find(d => d.id === Number(id))?.status;

// A question that is plainly yes or no gets Yes and No buttons: it opens like "Should I ..." or ends "Go ahead?",
// and offers no choice between things ("A or B?").
export function isYesNo(question) {
  const s = String(question || '').trim();
  const last = s.split(/(?<=[.!?])\s+/).filter(x => x.endsWith('?')).at(-1) || '';
  if (!last || /\bor\b|\bwhich\b|\bwhat\b|\bhow\b|\bwhen\b|\bwhere\b|\bwho\b|\bwhy\b/i.test(last)) return false;
  return /^(should|shall|can|could|may|do|does|did|is|are|was|were|will|would|have|has|ok|okay|go ahead|want|merge|push|ready)\b/i.test(last) || /\b(go ahead|ok|okay|all right|alright)\?$/i.test(last);
}

// The message your answers go out as, in the asking agent's thread: each question quoted, then your answer.
//   > Small batch as v0.35.1 ... Go ahead?
//   Yes, go ahead
export const QUOTE_MAX = 300;
export function answerMessage(items) {
  return items.filter(x => String(x.answer || '').trim()).map(({ question, answer }) => {
    const q = String(question).replace(/\s+/g, ' ').trim();
    const quoted = q.length > QUOTE_MAX ? q.slice(0, QUOTE_MAX - 1).trimEnd() + '…' : q;
    return `> ${quoted}\n${String(answer).trim()}`;
  }).join('\n\n');
}

// One line for the orchestrator thread when you answer a worker's questions from Needs you:
//   You answered map-core: Hide the map strip while typing? Yes; Which hint would you keep…? Neither
// Each question shrinks to its gist (the sentence that asks, cut at a word), each answer to one short line.
export const GIST_MAX = 72, ANSWER_MAX = 60, NOTE_MAX = 280;
const flat = s => String(s || '').replace(/\s+/g, ' ').trim();
function cut(s, max) {
  if (s.length <= max) return s;
  const head = s.slice(0, max - 1);
  return (head.lastIndexOf(' ') > max * 0.6 ? head.slice(0, head.lastIndexOf(' ')) : head).replace(/[\s,;:.]+$/, '') + '…';
}
export function questionGist(question) {
  const q = flat(question);
  const asks = q.split(/(?<=[.!?])\s+/).filter(x => x.endsWith('?'));
  const s = asks.at(-1) || q;
  if (s.length <= GIST_MAX) return s;
  return s.endsWith('?') ? cut(s.slice(0, -1), GIST_MAX - 1) + '?' : cut(s, GIST_MAX);
}
export function answerNote(who, asker, items) {
  const parts = items.filter(x => flat(x.answer)).map(({ question, answer }) => {
    const g = questionGist(question);
    return `${g}${/[?:]$/.test(g) ? '' : ':'} ${cut(flat(answer), ANSWER_MAX)}`;
  });
  return cut(`${who} answered ${asker}: ${parts.join('; ')}`, NOTE_MAX);
}
