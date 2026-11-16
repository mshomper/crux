// Which agent questions still wait on you: one rule for the Needs you list, the live map and phone notifications
// (the server imports this file too, so it stays plain JavaScript with no page code in it).
//
// A round summary's questions wait, each on its own, until:
// - you answer it from Needs you (a message of yours whose `answers` names it), or dismiss it;
// - every decision it names (decision 31, D0031, decisions 31 to 33) is picked.
// The whole card goes when you write a plain message in its thread (the latest asking summary there), or when you
// dismiss the card. Only YOU close a question (Matt, 2026-11-16: "stop disappearing"): the orchestrator writing into the
// thread, the asker retiring or being handed off, and a newer summary from the same agent never close an older card.
// Every summary that asked something keeps its own card; a newer one in the same thread hides only the questions it
// repeats (the same words), so a re-ask is one card, not two.

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
// opts: { decisionStatus(id), decisions: the project's decision records ({ id, title, status, options }),
// decisionNotified(id): the server's notices say whether that decision's notice went (the page leaves it out: there the
// decision card shows next to it) }.
export function openQuestions(events, opts) { const r = readCards(events, opts); return withoutRepeatCards(r, opts); }

// Every summary card still asking something, before repeats are set aside (cards), every summary that asked
// (asked: { ev, at, pos }), and every question you yourself settled, in any summary (settled: { id, i, at, thread,
// from, text, when }): answered, dismissed, or answered by your picks; `when` is the settling event's place in the log.
function readCards(events, { decisionStatus = () => undefined } = {}) {
  const dismissed = new Map();
  const gone = new Map();   // summary id -> Map of question place -> where you answered or dismissed it one by one
  const mark = (id, i, pos) => { if (!gone.has(id)) gone.set(id, new Map()); gone.get(id).set(Number(i), pos); };
  const last = new Map();   // thread -> { ev, answered, byYou, when }
  const asked = [];         // every summary that asked something, with how it was closed
  const picked = new Map(); // decision number -> its latest pick's place in the log
  let pos = 0;
  for (const e of events || []) {
    pos++;
    if (e.type === 'pick') picked.set(Number(e.decision), pos);
    if (e.type === 'question_dismissed') { e.index == null ? dismissed.set(e.question, pos) : mark(e.question, e.index, pos); continue; }
    if (!e.thread) continue;
    // at: its place among the asking summaries, so "earlier" never ties (two summaries can share a millisecond);
    // pos: its place in the whole log
    if (e.type === 'summary' && e.questions?.length) { const s = { ev: e, at: asked.length, pos, answered: false, byYou: false }; last.set(e.thread, s); asked.push(s); }
    else if (e.type === 'message') {
      if (e.from === 'you' && Array.isArray(e.answers) && e.answers.length) { for (const a of e.answers) mark(a.question, a.index, pos); continue; }
      // Only your own plain message settles a card. The orchestrator (or a successor agent) writing in the thread, and a
      // Conductor brief (decision 55), are never an answer: the question still waits on you until you answer or dismiss it.
      if (e.conductor || e.from !== 'you') continue;
      const q = last.get(e.thread);
      if (q && !q.answered) { q.answered = true; q.byYou = true; q.when = pos; }
    }
  }
  const settled = [];
  for (const { ev, at, byYou, when } of asked) {
    const done = gone.get(ev.id) || new Map();
    ev.questions.forEach((text, i) => {
      const byPick = answeredByPicks(text, decisionStatus) ? Math.max(0, ...decisionRefs(text).map(n => picked.get(n) || 0)) : null;
      const at2 = byYou ? when : dismissed.has(ev.id) ? dismissed.get(ev.id) : done.has(i) ? done.get(i) : byPick;
      if (at2 != null) settled.push({ id: ev.id, i, at, thread: ev.thread, from: ev.from, text, when: at2 });
    });
  }
  const cards = [];
  for (const { ev, at, pos, answered } of asked) {
    if (answered || dismissed.has(ev.id)) continue;
    const done = gone.get(ev.id) || new Map();
    let byPicks = 0;
    const open = [];
    ev.questions.forEach((text, i) => {
      if (done.has(i)) return;
      if (answeredByPicks(text, decisionStatus)) { byPicks++; return; }
      // The same agent asked it again in a newer summary: that card holds it (so a re-ask is one card, not two).
      if (asked.some(n => n.at > at && n.ev.thread === ev.thread && n.ev.questions.some(t => isRepeat(text, t)))) return;
      open.push({ i, text });
    });
    if (open.length) cards.push({ ...ev, open, byPicks, repeats: [], at, pos });
  }
  return { cards, settled, asked };
}

// A question lives in one card (Matt, 2026-11-14; decision 64, made strict after review). Where a later card in this
// project repeats a question an earlier card from another thread still holds open (isRepeat: the same words, nothing
// added), the repeat is hidden here, where cards are drawn, and listed under the card's `repeats` ({ i, text, of: who
// holds it, holder: that card's summary id }). Nothing is dropped from the log. Only open cards hold repeats. Once you
// answer or dismiss the holder while the repeat waits behind it, the repeat counts as answered too (answered: true);
// a question you settled in an earlier round never hides a new one. If the holder closes without you (its agent
// retired or handed off, a newer summary, the orchestrator wrote into that thread), the repeat shows again by itself.
// A question that asks only what an open decision card asks (decisionCovers) is hidden behind it (decision: its
// number), on the server only once that decision has been notified (opts.decisionNotified).
function withoutRepeatCards({ cards, settled = [] }, { decisions = [], decisionNotified = () => true } = {}) {
  const shown = [];
  const openDecisions = (Array.isArray(decisions) ? decisions : []).filter(d => ['open', 'found'].includes(d?.status) && decisionNotified(Number(d.id)));
  for (const c of [...cards].sort((a, b) => a.at - b.at)) {
    const earlier = shown.filter(d => d.thread !== c.thread);
    const open = [];
    for (const q of c.open) {
      const holder = earlier.find(d => d.open.some(w => isRepeat(q.text, w.text)));
      // Settled after this question was asked (it waited behind that card then), never in an earlier round.
      const yours = !holder && settled.find(s => s.thread !== c.thread && s.at < c.at && s.when > c.pos && isRepeat(q.text, s.text));
      const decision = !holder && !yours && openDecisions.find(d => decisionCovers(q.text, d));
      if (holder) c.repeats.push({ ...q, of: holder.from, thread: holder.thread, holder: holder.id });
      else if (yours) c.repeats.push({ ...q, of: yours.from, thread: yours.thread, answered: true });
      else if (decision) c.repeats.push({ ...q, of: `D${String(decision.id).padStart(4, '0')}`, decision: Number(decision.id) });
      else open.push(q);
    }
    c.open = open;
    if (open.length) shown.push(c);
  }
  return cards.filter(c => c.open.length);
}

// The repeats hidden from each summary's card, by summary id, for the small "also in w1's card" note in its thread.
export function repeatsIn(events, opts) {
  const r = readCards(events, opts), out = new Map();
  withoutRepeatCards(r, opts);
  for (const c of r.cards) if (c.repeats.length) out.set(c.id, c.repeats);
  return out;
}

export function questionOpen(events, id, opts) { return openQuestions(events, opts).some(q => q.id === id); }

// Decision 64, for notices only: for each question still open in card `id`, the earlier summaries (other threads)
// that asked the same question and that you have not answered or dismissed. A card closed without you (the
// orchestrator wrote into the worker's thread) no longer holds a repeat, so the re-ask shows; but if the first card's
// notice already went, the re-ask needs no second one. Null when the card is not open.
export function askedBefore(events, id, opts) {
  const r = readCards(events, opts);
  const card = withoutRepeatCards(r, opts).find(c => c.id === id);
  if (!card) return null;
  const yours = new Set(r.settled.map(s => `${s.id}#${s.i}`));
  return card.open.map(q => r.asked
    .filter(s => s.ev.thread !== card.thread && s.at < card.at && s.ev.questions.some((t, i) => !yours.has(`${s.ev.id}#${i}`) && isRepeat(q.text, t)))
    .map(s => s.ev.id));
}

// Is `asked` a repeat of `held`, a question already waiting? Equal once case, punctuation and spacing are set aside,
// or shorter and found whole inside it (on word boundaries); never a longer question (it asks more), never a short one
// (under 24 characters cleaned: "Ship it?" is too common to match). And every number, version, PR id, option letter
// and name in it appears in the held one too, so "PR 6" never matches "PR 63", nor "option A" a held "option B".
const plainWords = q => String(q || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function isRepeat(asked, held) {
  const x = plainWords(asked), y = plainWords(held);
  if (x.length < 24 || !y) return false;
  if (!(x === y || (x.length < y.length && ` ${y} `.includes(` ${x} `)))) return false;
  return factsIn(asked, held);
}

// The facts a question carries: numbers, versions and ids (any word with a digit), option letters (a capital on its
// own), and names (a capitalised word inside a sentence, or a word with a hyphen or underscore).
function facts(text) {
  const s = String(text || '');
  const ids = (s.match(/[\p{L}\p{N}._#-]*\d[\p{L}\p{N}._-]*/gu) || []).map(w => w.replace(/^#+/, '').replace(/[._-]+$/, '').toLowerCase());
  const letters = (s.match(/\b[A-Z]\b/g) || []).filter(l => l !== 'I');
  const names = [];
  for (const sentence of s.split(/(?<=[.!?:;])\s+/)) {
    const words = sentence.match(/[\p{L}\p{N}_-]+/gu) || [];
    words.forEach((w, k) => { if (/[-_]/.test(w) || (k > 0 && /^\p{Lu}\p{L}/u.test(w))) names.push(w.toLowerCase()); });
  }
  return { ids, letters, names };
}
// Is every fact of `part` also in `whole`?
function factsIn(part, whole) {
  const p = facts(part), w = facts(whole);
  const wordsOf = new Set((String(whole || '').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || []));
  const ids = new Set(w.ids), letters = new Set(w.letters);
  return p.ids.every(x => ids.has(x)) && p.letters.every(x => letters.has(x)) && p.names.every(x => wordsOf.has(x));
}
// Words that carry no meaning of their own here. "no" and "not" are kept: they turn a question round.
const STOP = new Set(('a an the and or but if then so to of in on at by for with from into onto as is are was were be been being am do does did ' +
  'have has had i me my we us our you your it its this that these those there here what which who whom whose when where why how can could may ' +
  'might shall should will would must yes ok okay please just also too very now still yet any some all each both either than up out about again ' +
  'once more most other such only own same let lets want like go ahead').split(' '));
const stem = w => w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
const meaningfulWords = q => new Set(plainWords(q).split(' ').filter(w => w.length > 1 && !STOP.has(w)).map(stem));
// The share of `part`'s meaningful words that are also in `whole` (0 when part has none).
function share(part, whole) {
  if (!part.size) return 0;
  let n = 0;
  for (const w of part) if (whole.has(w)) n++;
  return n / part.size;
}

// Decision 64: does decision card d already ask everything this question asks? Both ways: the question asks the
// decision's choice (70% of the title's meaningful words, three or more, are in it, or it names two of the options),
// and it adds nothing beyond the decision's title and options: every meaningful word, number, option letter and name
// in it is there too. Naming a decision's number alone is never enough ("D59 is ready; bump the version?").
export function decisionCovers(question, d) {
  if (!d || plainWords(question).length < 24) return false;
  const Q = meaningfulWords(question), T = meaningfulWords(d.title);
  const asks = (T.size >= 3 && share(T, Q) >= 0.7)
    || (d.options || []).filter(o => { const O = meaningfulWords(o?.name); return O.size >= 2 && share(O, Q) >= 0.7; }).length >= 2;
  if (!asks) return false;
  const text = [d.title, ...(d.options || []).flatMap(o => [o?.key, o?.name, o?.summary])].filter(Boolean).join('. ');
  return share(Q, meaningfulWords(text)) === 1 && factsIn(question, text);
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
