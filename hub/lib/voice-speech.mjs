// Voice (decision 61 A): what Imogen says back. While a spoken message is being answered, the Conductor starts the
// message that answers it with one line, "Spoken: ...", of 1-3 short plain sentences. The hub lifts that line off
// (it never shows as text) and splits it into sentences. A reply without one gets its first plain sentences read.

export const MAX_SENTENCES = 3;
const MAX_CHARS = 420;          // all sentences together
const MAX_SENTENCE = 220;       // one sentence, cut at a word if longer

// { spoken, rest }: the Spoken line's words (or '') and the reply without that line.
// Written as "Spoken: ...", "**Spoken:** ...", "**Spoken**: ...", or with the label on its own line and the words on
// the lines under it (up to a blank line).
export function liftSpoken(text) {
  const src = String(text || '');
  const m = /^[ \t>]*(?:\*\*|__|\*|_)?spoken(?:\*\*|__|\*|_)?[ \t]*(?::|-(?=[ \t]))(?:\*\*|__|\*|_)?[ \t]*(.*?)[ \t]*$/im.exec(src);
  if (!m) return { spoken: '', rest: src };
  let words = m[1].replace(/^(?:\*\*|__)|(?:\*\*|__)$/g, '').trim(), end = m.index + m[0].length;
  if (!words) {   // the label alone: the words are the lines under it, up to a blank line
    const after = /^\r?\n((?:[ \t>]*\S.*(?:\r?\n|$))+)/.exec(src.slice(end));
    if (!after) return { spoken: '', rest: src };
    words = after[1].split(/\r?\n/).map(l => l.replace(/^[ \t>]+/, '').trim()).filter(Boolean).join(' ');
    end += after[0].length;
  }
  if (!words) return { spoken: '', rest: src };
  const rest = (src.slice(0, m.index) + src.slice(end)).replace(/^\s*\n/, '').replace(/\n{3,}/g, '\n\n').trim();
  return { spoken: words, rest };
}

// Markdown to plain words: no code, links as their words, no headings, list marks, emphasis or tables.
export function plain(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Plain text to at most three sentences that fit.
export function sentences(text, max = MAX_SENTENCES) {
  const parts = plain(text).split(/(?<=[.!?])\s+(?=["'(\p{Lu}\d])/u).map(s => s.trim()).filter(s => /[\p{L}\d]/u.test(s));
  const out = []; let total = 0;
  for (let s of parts) {
    if (s.length > MAX_SENTENCE) s = s.slice(0, MAX_SENTENCE).replace(/\s+\S*$/, '') + '…';
    if (out.length && total + s.length > MAX_CHARS) break;
    out.push(s); total += s.length;
    if (out.length >= max) break;
  }
  return out;
}
