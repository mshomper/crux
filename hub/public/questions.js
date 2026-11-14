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
// opts: { decisionStatus(id), decisions: the project's decision records ({ id, title, status, options }) }.
export function openQuestions(events, opts) { const r = readCards(events, opts); return withoutRepeatCards(r, opts); }

// Every summary card still asking something, before repeats are set aside (cards), and every question you yourself
// settled, in any summary (settled: { ts, thread, from, text }): answered, dismissed, or answered by your picks.
// dormant: worker cards the orchestrator closed by writing into the worker's thread. Decision 64: one of those still
// holds a question the orchestrator then asks you again, so the re-ask is hidden behind it and it shows again.
function readCards(events, { decisionStatus = () => undefined } = {}) {
  const dismissed = new Set(), retired = new Set();
  const gone = new Map();   // summary id -> Set of question places answered or dismissed one by one (by you)
  const mark = (id, i) => { if (!gone.has(id)) gone.set(id, new Set()); gone.get(id).add(Number(i)); };
  const last = new Map();   // thread -> { ev, answered, byYou }
  const asked = [];         // every summary that asked something, with how it was closed
  const picked = new Map(); // decision number -> its latest pick's place in the log (decision 64)
  let pos = 0;
  for (const e of events || []) {
    pos++;
    if (e.type === 'pick') picked.set(Number(e.decision), pos);
    if (e.type === 'question_dismissed') { e.index == null ? dismissed.add(e.question) : mark(e.question, e.index); continue; }
    if (e.type === 'agent_retired') retired.add(e.agent);
    if (!e.thread) continue;
    // at: its place among the asking summaries, so "earlier" never ties (two summaries can share a millisecond);
    // pos: its place in the whole log
    if (e.type === 'summary' && e.questions?.length) { const s = { ev: e, at: asked.length, pos, answered: false, byYou: false }; last.set(e.thread, s); asked.push(s); }
    else if (e.type === 'message') {
      if (e.from === 'you' && Array.isArray(e.answers) && e.answers.length) { for (const a of e.answers) mark(a.question, a.index); continue; }
      // A Conductor brief (decision 55) logged in a project's thread is never an answer: only you (or the orchestrator
      // answering its worker) can settle a question that waits on you.
      if (e.conductor) continue;
      const q = last.get(e.thread);
      if (q && e.from !== q.ev.from && !q.answered) { q.answered = true; q.byYou = e.from === 'you'; q.byOrch = e.thread !== 'orchestrator' && ORCH.test(String(e.from)); }
      else if (q?.byOrch && e.from === 'you') { q.byYou = true; q.byOrch = false; }   // you replied after the orchestrator did
    }
  }
  const settled = [];
  for (const { ev, at, byYou } of asked) {
    const done = gone.get(ev.id) || new Set(), all = byYou || dismissed.has(ev.id);
    ev.questions.forEach((text, i) => { if (all || done.has(i) || answeredByPicks(text, decisionStatus)) settled.push({ at, thread: ev.thread, from: ev.from, text }); });
  }
  const cards = [], dormant = [];
  for (const { ev, at, pos, answered, byOrch } of last.values()) {
    if (dismissed.has(ev.id) || retired.has(ev.from) || (answered && !byOrch)) continue;
    const done = gone.get(ev.id) || new Set();
    let byPicks = 0;
    const open = [];
    ev.questions.forEach((text, i) => {
      if (done.has(i)) return;
      if (answeredByPicks(text, decisionStatus)) { byPicks++; return; }
      open.push({ i, text });
    });
    if (open.length) (answered ? dormant : cards).push({ ...ev, open, byPicks, repeats: [], at, pos });
  }
  return { cards, settled, dormant, picked };
}
const ORCH = /^orchestrator-\d+$/;   // the holders of the orchestrator role (hub.mjs createAgent names them so)

// A question lives in one card (Matt, 2026-11-14; decision 64). Where a later card in this project repeats a question
// an earlier card from another thread still holds open (an orchestrator re-asking its worker's question), the repeat
// is hidden here, where cards are drawn, and listed under the card's `repeats` ({ i, text, of: who holds it, holder:
// that card's summary id }). Nothing is dropped from the log. Once you answer or dismiss the first one, its repeats
// count as answered too (answered: true); if the first card closes without you (its agent retired or handed off, a
// newer summary), the repeat shows again by itself. The orchestrator writing into its worker's thread does not let go
// of a question it then asks you again: the worker's card shows again with just that question, and holds the re-ask.
// A question whose choice an open decision card in the project already asks (the decision's title or options match
// it) is hidden behind that decision (decision: its number); once you pick that decision, after the question was
// asked, your pick answers it too (answered: true).
function withoutRepeatCards({ cards, settled = [], dormant = [], picked = new Map() }, { decisions = [] } = {}) {
  const shown = [], revived = new Map();
  const all = Array.isArray(decisions) ? decisions : [];
  const openDecisions = all.filter(d => ['open', 'found'].includes(d?.status));
  const pickedAfter = c => all.filter(d => !['open', 'found'].includes(d?.status) && (picked.get(Number(d.id)) || 0) > c.pos);
  for (const c of [...cards].sort((a, b) => a.at - b.at)) {
    const earlier = shown.filter(d => d.thread !== c.thread);
    const open = [];
    for (const q of c.open) {
      const holder = earlier.find(d => d.open.some(w => isRepeat(q.text, w.text)));
      const yours = !holder && settled.find(s => s.thread !== c.thread && s.at < c.at && isRepeat(q.text, s.text));
      const sleeper = !holder && !yours && dormant.find(d => d.thread !== c.thread && d.at < c.at && d.open.some(w => isRepeat(q.text, w.text)));
      const decision = !holder && !yours && !sleeper && openDecisions.find(d => decisionCovers(q.text, d));
      const pick = !holder && !yours && !sleeper && !decision && pickedAfter(c).find(d => decisionCovers(q.text, d));
      if (pick) c.repeats.push({ ...q, of: `D${String(pick.id).padStart(4, '0')}`, decision: Number(pick.id), answered: true });
      else if (holder) c.repeats.push({ ...q, of: holder.from, thread: holder.thread, holder: holder.id });
      else if (yours) c.repeats.push({ ...q, of: yours.from, thread: yours.thread, answered: true });
      else if (sleeper) {
        let r = revived.get(sleeper.id);
        if (!r) { r = { ...sleeper, open: [], repeats: [], revived: true }; revived.set(sleeper.id, r); shown.push(r); }
        for (const w of sleeper.open) if (isRepeat(q.text, w.text) && !r.open.some(x => x.i === w.i)) r.open.push(w);
        c.repeats.push({ ...q, of: sleeper.from, thread: sleeper.thread, holder: sleeper.id });
      }
      else if (decision) c.repeats.push({ ...q, of: `D${String(decision.id).padStart(4, '0')}`, decision: Number(decision.id) });
      else open.push(q);
    }
    c.open = open;
    if (open.length) shown.push(c);
  }
  for (const r of revived.values()) r.open.sort((a, b) => a.i - b.i);
  return [...cards, ...revived.values()].filter(c => c.open.length);
}

// The repeats hidden from each summary's card, by summary id, for the small "also in w1's card" note in its thread.
export function repeatsIn(events, opts) {
  const r = readCards(events, opts), out = new Map();
  withoutRepeatCards(r, opts);
  for (const c of r.cards) if (c.repeats.length) out.set(c.id, c.repeats);
  return out;
}

export function questionOpen(events, id, opts) { return openQuestions(events, opts).some(q => q.id === id); }

// Decision 64: the card that holds a summary's questions when its own card is hidden as a repeat, so a phone notice
// goes for the card that shows: { holder: summary id } (a question card), { decision: n }, or null.
export function holderOf(events, id, opts) {
  const reps = repeatsIn(events, opts).get(id) || [];
  const r = reps.find(x => x.holder) || reps.find(x => x.decision);
  return r ? (r.holder ? { holder: r.holder } : { decision: r.decision }) : null;
}

// Is `asked` a repeat of `open`, already waiting? Equal once case, punctuation and spacing are set aside, or shorter
// and found whole inside it, or (decision 64) mostly the same words: at least 70% of the meaningful words of each are
// in the other, so a re-ask in looser words still matches. Never a short one (under 24 characters cleaned: "Ship it?"
// is too common to match), and never on fewer than three meaningful words.
const plainWords = q => String(q || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const REPEAT_OVERLAP = 0.7;
// Words that carry no meaning of their own here. "no" and "not" are kept: they turn a question round.
const STOP = new Set(('a an the and or but if then so to of in on at by for with from into onto as is are was were be been being am do does did ' +
  'have has had i me my we us our you your it its this that these those there here what which who whom whose when where why how can could may ' +
  'might shall should will would must yes ok okay please just also too very now still yet any some all each both either than up out about again ' +
  'once more most other such only own same let lets want like go ahead').split(' '));
const stem = w => w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
export const meaningfulWords = q => new Set(plainWords(q).split(' ').filter(w => w.length > 1 && !STOP.has(w)).map(stem));
// The share of `part`'s meaningful words that are also in `whole` (0 when part has none).
function share(part, whole) {
  if (!part.size) return 0;
  let n = 0;
  for (const w of part) if (whole.has(w)) n++;
  return n / part.size;
}
export function wordOverlap(a, b) { const A = meaningfulWords(a), B = meaningfulWords(b); return Math.min(share(A, B), share(B, A)); }
export function isRepeat(asked, open) {
  const x = plainWords(asked), y = plainWords(open);
  if (x.length < 24 || !y) return false;
  if (x === y || (x.length < y.length && y.includes(x))) return true;
  if (y.length < 24) return false;
  const A = meaningfulWords(asked), B = meaningfulWords(open);
  return A.size >= 3 && B.size >= 3 && share(A, B) >= REPEAT_OVERLAP && share(B, A) >= REPEAT_OVERLAP;
}

// Decision 64: does an open decision card already ask this question's choice? Its title's meaningful words (three or
// more) are 70% in the question, or the question names at least two of its options (each option's name, of two or
// more meaningful words, 70% in it). Naming a decision's number alone is not enough: "D59 is ready; bump the version?"
// asks something else.
export function decisionCovers(question, d) {
  if (!d || plainWords(question).length < 24) return false;
  const Q = meaningfulWords(question), T = meaningfulWords(d.title);
  if (T.size >= 3 && share(T, Q) >= REPEAT_OVERLAP) return true;
  const named = (d.options || []).filter(o => { const O = meaningfulWords(o?.name); return O.size >= 2 && share(O, Q) >= REPEAT_OVERLAP; });
  return named.length >= 2;
}

// The page's project state ({ events, board: { decisions } }) to the options above.
export const pageStatus = p => id => (p?.board?.decisions || []).find(d => d.id === Number(id))?.status;
export const pageAsk = p => ({ decisionStatus: pageStatus(p), decisions: p?.board?.decisions || [] });

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
