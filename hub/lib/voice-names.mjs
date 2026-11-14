// Voice (decision 61 A): snap near-miss project and agent names in a transcript to the names the hub knows.
// Parakeet takes no list of names, so "bright load", "Harbor stone", "wind lab" or "orchestrator six" come out as
// heard; this puts BrightLoad, Harborstone, w1nd.lab and orchestrator-6 back. A stretch of one to three words is
// replaced only when it is clearly close to exactly one name; short names (under four letters) only when heard
// exactly, and then only their spelling is fixed. What was heard is kept on the message, so a wrong snap shows.

// Number words only, never their sound-alikes ("to", "for"): "the orchestrator to start" must stay as said.
const NUMBERS = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12' };
// How a name written with digits for letters is said: f13ld is "field".
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' };

const letters = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
// A rough sound key: one letter per sound, vowels after the first dropped, doubles collapsed.
function sound(s) {
  // "cc" and "ck" sound as k ("Acculode"), the g in "gn" is silent ("Acculine" for a name ending in "lign").
  let k = letters(s).replace(/ph/g, 'f').replace(/gn/g, 'n').replace(/cc|ck|q|c(?=[aou])|c$/g, 'k').replace(/c/g, 's').replace(/z/g, 's').replace(/x/g, 'ks').replace(/w(?=[^aeiou]|$)/g, '').replace(/y/g, 'i');
  k = k[0] + k.slice(1).replace(/[aeiouh]/g, '');
  return k.replace(/(.)\1+/g, '$1');
}
function lev(a, b) {
  if (a === b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}
const like = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);

// The ways one name may be heard, as letter keys: as written, digits said as letters (f13ld -> field), and a trailing
// number said either way (orchestrator-6, orchestrator six).
function keysFor(name) {
  const k = letters(name);
  const out = new Set([k]);
  const leet = k.replace(/[0-9]/g, d => LEET[d] ?? d);
  if (/[a-z]/.test(k.replace(/[0-9]+$/, '')) && /[0-9]/.test(k.replace(/[0-9]+$/, ''))) out.add(leet.replace(/[0-9]+$/, '') + (k.match(/[0-9]+$/)?.[0] || ''));
  return [...out];
}
// A stretch of words as a letter key, with number words as digits.
const stretchKey = words => words.map(w => NUMBERS[letters(w)] ?? letters(w)).join('');

// text: the transcript. names: the names to snap to. aliases: { "heard words": "Name" } for names no ear will get.
// Returns { text, snapped: [{ from, to }] }.
export function snapNames(text, names = [], aliases = {}) {
  const src = String(text || '');
  const known = [...new Set(names.map(n => String(n || '').trim()).filter(Boolean))].map(name => ({ name, keys: keysFor(name), short: letters(name).length < 4 }));
  const alias = Object.entries(aliases || {}).map(([heard, name]) => ({ key: stretchKey(String(heard).split(/\s+/)), name: String(name) })).filter(a => a.key && a.name);
  // Words with their places in the text, so the rest (punctuation, spacing) stays as said.
  const words = [...src.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'.-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu)].map(m => ({ w: m[0], at: m.index, end: m.index + m[0].length }));
  const out = []; const snapped = [];
  let i = 0, cursor = 0;
  while (i < words.length) {
    let best = null;
    for (let n = Math.min(3, words.length - i); n >= 1; n--) {
      const stretch = words.slice(i, i + n);
      const key = stretchKey(stretch.map(s => s.w));
      if (key.length < 2) continue;
      const a = alias.find(x => x.key === key);
      if (a) { best = { n, name: a.name, score: 2 }; break; }
      const hits = [];
      for (const k of known) {
        let score = 0;
        for (const nk of k.keys) {
          // A name ending in a number (orchestrator-6) needs that number heard: "the orchestrator" stays as said.
          if ((nk.match(/[0-9]+$/)?.[0] || '') !== (key.match(/[0-9]+$/)?.[0] || '')) continue;
          if (key === nk) score = Math.max(score, 1.5);
          // A near miss starts as the name starts, so a word in front ("did orchestrator six") is never swallowed.
          else if (!k.short && nk.length >= 4 && key[0] === nk[0]) {
            const l = like(key, nk), sameSound = sound(key) === sound(nk);
            if (l >= 0.8 || (sameSound && l >= 0.6)) score = Math.max(score, l + (sameSound ? 0.2 : 0));
          }
        }
        if (score) hits.push({ name: k.name, score });
      }
      if (!hits.length) continue;
      hits.sort((x, y) => y.score - x.score);
      if (hits[1] && hits[1].score === hits[0].score && hits[1].name !== hits[0].name) continue;   // two names fit as well: leave it
      if (!best || hits[0].score > best.score) best = { n, ...hits[0] };
      if (best.score >= 1.5) break;
    }
    if (best) {
      const first = words[i], last = words[i + best.n - 1];
      const heard = src.slice(first.at, last.end);
      out.push(src.slice(cursor, first.at), best.name);
      if (heard !== best.name) snapped.push({ from: heard, to: best.name });
      cursor = last.end; i += best.n;
    } else i++;
  }
  out.push(src.slice(cursor));
  return { text: out.join(''), snapped };
}
