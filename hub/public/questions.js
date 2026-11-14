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
export function openQuestions(events, { decisionStatus = () => undefined } = {}) {
  const dismissed = new Set(), retired = new Set();
  const gone = new Map();   // summary id -> Set of question places answered or dismissed one by one
  const mark = (id, i) => { if (!gone.has(id)) gone.set(id, new Set()); gone.get(id).add(Number(i)); };
  const last = new Map();   // thread -> { ev, answered }
  for (const e of events || []) {
    if (e.type === 'question_dismissed') { e.index == null ? dismissed.add(e.question) : mark(e.question, e.index); continue; }
    if (e.type === 'agent_retired') retired.add(e.agent);
    if (!e.thread) continue;
    if (e.type === 'summary' && e.questions?.length) last.set(e.thread, { ev: e, answered: false });
    else if (e.type === 'message') {
      if (e.from === 'you' && Array.isArray(e.answers) && e.answers.length) { for (const a of e.answers) mark(a.question, a.index); continue; }
      // A Conductor brief (decision 55) logged in a project's thread is never an answer: only you (or the orchestrator
      // answering its worker) can settle a question that waits on you.
      if (e.conductor) continue;
      const q = last.get(e.thread);
      if (q && e.from !== q.ev.from) q.answered = true;
    }
  }
  const out = [];
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
    if (open.length) out.push({ ...ev, open, byPicks });
  }
  return out;
}

export function questionOpen(events, id, opts) { return openQuestions(events, opts).some(q => q.id === id); }

// Two questions that ask the same thing: equal once case, punctuation and spacing are set aside, or one holds the
// other whole (24 characters or more). A question lives in one card only (Matt, 2026-11-14): an orchestrator does not
// re-ask its worker's waiting question, and the Conductor does not re-ask a project's.
const plainWords = q => String(q || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function sameQuestion(a, b) {
  const x = plainWords(a), y = plainWords(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length < y.length ? [x, y] : [y, x];
  return s.length >= 24 && l.includes(s);
}
// questions minus those already waiting elsewhere (texts): { kept, dropped }.
export function withoutRepeats(questions = [], waiting = []) {
  const kept = [], dropped = [];
  for (const q of questions) (waiting.some(w => sameQuestion(q, w)) ? dropped : kept).push(q);
  return { kept, dropped };
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
