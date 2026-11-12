// Markdown in agents' chat messages, following CommonMark and GitHub's tables closely enough for what agents write.
// Plain ES module with no page code, so tests run it. Everything is escaped first; only the tags below are made.
//
// Blocks: paragraphs (line breaks kept), headings (shown as a bold line), fenced code, quotes, rules, bullet lists
// (- * +) and numbered lists (1. or 1)), nested by indentation, and tables (a header row, then a row of dashes with
// optional colons for alignment). A list or a table may follow a paragraph line directly, with no blank line between;
// a numbered list does that only when it starts at 1, as in CommonMark, so "in\n2. we" stays a sentence.
// Inline: `code`, **bold**, *italic*, [links](https://...) and bare https links. Only http and https links are made.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- inline ----------
export function inline(src) {
  const keep = [];
  const hold = html => `\u0000${keep.push(html) - 1}\u0000`;
  let s = String(src ?? '');
  s = s.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) => hold(`<a href="${esc(url)}" target="_blank" rel="noopener">${inlineText(text)}</a>`));
  s = s.replace(/<(https?:\/\/[^\s>]+)>/g, (_, url) => hold(link(url)));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_])/g, (_, pre, url) => pre + hold(link(url)));
  return inlineText(s).replace(/\u0000(\d+)\u0000/g, (_, i) => keep[i]);
}
const link = url => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
function inlineText(s) {
  return esc(s)   // placeholders (\u0000n\u0000) pass through esc untouched
    .replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([^_]*?\S)__/g, '<strong>$1</strong>')
    .replace(/(^|[\s(>])\*(?=[^*\s])([^*]*?[^*\s])\*(?=$|[\s).,;:!?<])/g, '$1<em>$2</em>');
}

// ---------- blocks ----------
const LIST = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const indentOf = l => l.replace(/\t/g, '    ').match(/^ */)[0].length;
const isBlank = l => !l.trim();
const isFence = l => /^\s*```/.test(l);
const isHeading = l => /^\s{0,3}#{1,6}\s+/.test(l);
const isRule = l => /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l);
const isQuote = l => /^\s{0,3}>/.test(l);
const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const splitRow = l => {
  let s = l.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
};
const isTableStart = (lines, i) => lines[i]?.includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && DELIM.test(lines[i + 1]) && (lines[i + 1].includes('|') || splitRow(lines[i]).length === 1)
  && splitRow(lines[i]).length === splitRow(lines[i + 1]).length;

// Can this line start a new block in the middle of a paragraph?
function interrupts(lines, i) {
  const l = lines[i];
  if (isFence(l) || isHeading(l) || isQuote(l) || isTableStart(lines, i)) return true;
  const m = LIST.exec(l);
  if (m && m[3].trim()) return /^\d/.test(m[2]) ? parseInt(m[2], 10) === 1 : true;
  return false;
}

export function md(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  return blocks(lines, 0, lines.length);
}

function blocks(lines, from, to) {
  const out = [];
  let i = from;
  while (i < to) {
    const l = lines[i];
    if (isBlank(l)) { i++; continue; }
    if (isFence(l)) {
      const body = [];
      i++;
      while (i < to && !isFence(lines[i])) body.push(lines[i++]);
      i++;   // the closing fence (or the end)
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (isHeading(l)) { out.push(`<p><strong>${inline(l.replace(/^\s*#+\s+/, '').replace(/\s+#+\s*$/, ''))}</strong></p>`); i++; continue; }
    if (isRule(l)) { out.push('<hr>'); i++; continue; }
    if (isQuote(l)) {
      const body = [];
      while (i < to && isQuote(lines[i])) body.push(lines[i++].replace(/^\s{0,3}> ?/, ''));
      out.push(`<blockquote>${blocks(body, 0, body.length)}</blockquote>`);
      continue;
    }
    if (isTableStart(lines, i)) { i = table(lines, i, to, out); continue; }
    if (LIST.test(l) && LIST.exec(l)[3].trim()) { i = list(lines, i, to, out); continue; }
    // A paragraph: lines until a blank line or a block that may interrupt it.
    const para = [l.trim()];
    i++;
    while (i < to && !isBlank(lines[i]) && !interrupts(lines, i)) para.push(lines[i++].trim());
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}

function table(lines, i, to, out) {
  const head = splitRow(lines[i]);
  const align = splitRow(lines[i + 1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '');
  const cell = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tag}>`;
  const fit = r => head.map((_, k) => r[k] ?? '');
  const rows = [];
  i += 2;
  while (i < to && !isBlank(lines[i]) && lines[i].includes('|') && !isFence(lines[i])) rows.push(fit(splitRow(lines[i++])));
  // The table fits its box by wrapping its cells; the box scrolls on its own only as a last resort, never the page.
  out.push(`<div class="md-table-box"><table class="md-table"><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, k) => cell('td', c, k)).join('')}</tr>`).join('')}</tbody></table></div>`);
  return i;
}

// A list and everything nested in it. Items are lines that match LIST at this list's indent; deeper list lines
// nest in the item above; other lines continue the item's text (lazily, as CommonMark allows). A blank line ends
// the list unless the next line is another item of it, or is indented under the current item.
function list(lines, i, to, out) {
  const first = LIST.exec(lines[i]);
  const base = indentOf(lines[i]);
  const ordered = /^\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  while (i < to) {
    const l = lines[i];
    const m = LIST.exec(l);
    if (isBlank(l)) {
      let j = i + 1;
      while (j < to && isBlank(lines[j])) j++;
      const n = j < to ? LIST.exec(lines[j]) : null;
      const sameList = n && indentOf(lines[j]) === base && /^\d/.test(n[2]) === ordered;
      const nested = j < to && items.length && indentOf(lines[j]) > base;
      if (!sameList && !nested) break;
      i = j;
      continue;
    }
    if (m && indentOf(l) === base && /^\d/.test(m[2]) === ordered && m[3].trim()) { items.push({ text: [m[3]], sub: [] }); i++; continue; }
    if (m && indentOf(l) < base) break;
    if (m && /^\d/.test(m[2]) !== ordered && indentOf(l) === base) break;   // another kind of list starts
    if (!items.length) break;
    const cur = items.at(-1);
    if (m && indentOf(l) > base) {
      // A nested list: take every line indented deeper than this list (and blank lines between them).
      const sub = [];
      while (i < to && (isBlank(lines[i]) ? (i + 1 < to && indentOf(lines[i + 1]) > base && !isBlank(lines[i + 1])) : indentOf(lines[i]) > base)) sub.push(lines[i++]);
      cur.sub.push(blocks(sub, 0, sub.length));
      continue;
    }
    if (interrupts(lines, i) && indentOf(l) <= base) break;
    cur.text.push(l.trim());
    i++;
  }
  const tag = ordered ? 'ol' : 'ul';
  out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.map(it => `<li>${it.text.map(inline).join('<br>')}${it.sub.join('')}</li>`).join('')}</${tag}>`);
  return i;
}
