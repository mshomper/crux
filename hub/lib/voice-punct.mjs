// Voice (decision 61 A): spoken punctuation becomes marks. Matt dictates his punctuation out of habit ("thanks for
// responding comma Conductor period"), and Parakeet writes the words, sometimes misheard ("Kama", "Commer",
// "exclamation, Mark?"), sometimes beside a mark it put there itself ("responding, comma"). The mark goes onto the
// word before, a duplicate mark is dropped, and the word after a full stop, question mark, exclamation mark or new line
// gets a capital. A punctuation word used as a word stays: after "a", "the", "put" and the like ("a comma separated
// list", "the period between releases"), and "period" unless it ends a sentence ("the trial period ends Friday").

// Each mark and the ways it is said or misheard (lower-case words). Longer sayings are tried first.
const MARKS = [
  { mark: '?', said: [['question', 'mark'], ['question', 'marks']] },
  { mark: '!', said: [['exclamation', 'point'], ['exclamation', 'mark'], ['exclamation', 'marks']] },
  { mark: '.', said: [['full', 'stop'], ['fullstop']] },
  { mark: '.', said: [['period']], weak: true },
  { mark: ';', said: [['semicolon'], ['semi', 'colon'], ['semi-colon']] },
  { mark: ':', said: [['colon']] },
  { mark: ',', said: [['comma'], ['kama'], ['commer'], ['comer']] },
  { mark: '\n\n', said: [['new', 'paragraph']] },
  { mark: '\n', said: [['new', 'line'], ['newline']] },
  { mark: 'open', said: [['open', 'quote'], ['open', 'quotes']] },
  { mark: 'close', said: [['close', 'quote'], ['close', 'quotes'], ['end', 'quote'], ['unquote']] },
  { mark: 'dash', said: [['dash']] }
].flatMap(m => m.said.map(said => ({ ...m, said }))).sort((a, b) => b.said.length - a.said.length);

// A word before that makes the next one a word, not dictation ("a comma", "the period", "put a colon").
const AS_WORD_AFTER = new Set(['a', 'an', 'the', 'this', 'that', 'these', 'those', 'each', 'every', 'no', 'per', 'of', 'with', 'after',
  'before', 'use', 'using', 'put', 'add', 'any', 'some', 'another', 'my', 'your', 'our', 'his', 'her', 'its', 'their', 'which', 'what', 'missing', 'extra']);
// Words after that make it a word ("comma separated", "comma delimited").
const AS_WORD_BEFORE = new Set(['separated', 'delimited', 'splice', 'splices', 'key', 'sign']);
// "period" with these before it is the noun ("trial period", "grace period").
const PERIOD_NOUNS = new Set(['trial', 'grace', 'waiting', 'review', 'test', 'testing', 'notice', 'billing', 'time', 'sprint', 'release', 'cooling', 'holding', 'probation', 'free']);
const MARKED = /[,.;:!?]/;
const low = s => String(s).toLowerCase().replace(/’/g, "'");

// text: a transcript. Returns { text, changed }.
export function dictate(text) {
  const src = String(text || '');
  // Words, each with the text after it (spaces and any marks Parakeet put), and what comes before the first.
  const re = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
  const words = []; let m, lead = '', last = 0;
  while ((m = re.exec(src))) {
    if (!words.length) lead = src.slice(0, m.index);
    else words[words.length - 1].sep = src.slice(last, m.index);
    words.push({ w: m[0], sep: '' });
    last = m.index + m[0].length;
  }
  if (!words.length) return { text: src, changed: false };
  words[words.length - 1].sep = src.slice(last);

  const out = [];
  let changed = false, capNext = false, openNext = false;
  for (let i = 0; i < words.length; i++) {
    // The words of a saying may have marks Parakeet put between them ("exclamation, Mark?").
    const hit = MARKS.find(k => k.said.every((s, j) => low(words[i + j]?.w || '') === s && (j === k.said.length - 1 || /^[\s,.;:!?]*$/.test(words[i + j].sep))));
    if (hit && dictation(hit, words, i)) {
      changed = true;
      const prev = out[out.length - 1];
      // The mark replaces whatever Parakeet put after the word before (one mark, ours). The spoken words and any
      // marks after them go; what follows comes after the space or line set here.
      if (hit.mark === 'open') openNext = true;
      else if (prev) {
        prev.sep = { close: '" ', dash: ' — ', '\n': '\n', '\n\n': '\n\n' }[hit.mark] ?? `${hit.mark} `;
        if (/[.?!\n]/.test(hit.mark)) capNext = true;
      } else capNext = true;   // dictated at the very start ("new paragraph here is..."): nothing to attach to
      i += hit.said.length - 1;
      continue;
    }
    let w = words[i].w;
    if (capNext) { w = w[0].toUpperCase() + w.slice(1); capNext = false; }
    if (openNext) { w = `"${w}`; openNext = false; }
    out.push({ w, sep: words[i].sep });
  }
  if (!changed) return { text: src, changed: false };
  const txt = (lead + out.map(x => x.w + x.sep).join('')).replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  return { text: txt, changed: true };
}

// Is this spoken punctuation dictation, or the word itself?
function dictation(k, words, i) {
  const n = k.said.length, prev = words[i - 1], next = words[i + n];
  // A capital "A" mid-sentence is a letter ("option A dash the safe one"), not the article.
  const article = prev && AS_WORD_AFTER.has(low(prev.w)) && !(prev.w === 'A' && i > 1);
  if (article && !MARKED.test(prev.sep)) return false;
  if (next && AS_WORD_BEFORE.has(low(next.w))) return false;
  if (!k.weak) return true;
  // "period" alone ends a sentence: the last word, before a mark Parakeet put, or before a capital; never a question.
  if (prev && PERIOD_NOUNS.has(low(prev.w)) && !MARKED.test(prev.sep)) return false;
  const after = words[i].sep;
  if (/\?/.test(after)) return false;   // "how long is the grace period?"
  if (!next) return true;
  return /[.!,;:]/.test(after) || /^\p{Lu}/u.test(next.w);
}
