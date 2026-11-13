// Live updates change a list in place, and the reader stays where they were (Matt's iPhone, 0.17.2).
// Every message, summary, permission line or state change used to rebuild a whole list (a thread, Needs you, All
// projects, the board, the thread list) from scratch and trust the browser to keep its scroll position. The iPhone
// does not: a list whose every item (and picture) is pulled out and put back is sent to its top. Now a redraw keeps
// every item that did not change and swaps only the ones that did (usually one added at the end), and the column puts
// the item you were reading back where it was on screen (anchorOf / backTo), at once and again once the new part has
// been laid out, unless you have touched the list since.
// Plain ES module; works on anything shaped like elements, so tests run it with the small page stand-in.

// The new items, parsed off the page (a template: pictures do not start loading, nothing runs), or null when the
// markup has loose text at its top level, which only a full redraw can show.
function parseItems(html, doc) {
  const t = doc.createElement('template');
  const root = t.content ? (t.innerHTML = html, t.content) : (() => { const d = doc.createElement('div'); d.innerHTML = html; return d; })();
  if ([...(root.childNodes || [])].some(n => n.nodeType === 3 && n.textContent.trim())) return null;
  return [...root.children];
}

// Make `list` show `html`, keeping every item whose markup is unchanged (the same element, so its pictures stay
// loaded and its height never drops to nothing). Items that match at the start and at the end stay; only the run
// between them is swapped. Returns { kept, added, removed }.
export function patchList(list, html, doc = list.ownerDocument || globalThis.document) {
  const next = parseItems(html, doc);
  const cur = [...list.children];
  if (!next) {
    list.innerHTML = html;
    for (const el of list.children) el._src = el.outerHTML;
    return { kept: 0, added: list.children.length, removed: cur.length };
  }
  const src = next.map(el => el.outerHTML);
  let a = 0, b = 0;
  while (a < cur.length && a < next.length && cur[a]._src === src[a]) a++;
  while (b < cur.length - a && b < next.length - a && cur[cur.length - 1 - b]._src === src[next.length - 1 - b]) b++;
  // New items go in first and the old ones come out after, so the list never shrinks on the way.
  const before = cur[cur.length - b] || null;
  for (let i = a; i < next.length - b; i++) { next[i]._src = src[i]; list.insertBefore(next[i], before); }
  for (const el of cur.slice(a, cur.length - b)) el.remove();
  return { kept: a + b, added: next.length - a - b, removed: cur.length - a - b };
}

// The first item still showing at the top of the list, and how far below the list's top edge it starts.
export function anchorOf(list) {
  const box = list.getBoundingClientRect();
  for (const el of list.children) {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.bottom > box.top + 1) return { el, off: r.top - box.top, top: list.scrollTop };
  }
  return { el: null, off: 0, top: list.scrollTop };
}

// Scroll so that item sits where it did; an item that has gone leaves the list at its old position. Never past the
// end. Returns whether it moved the list.
export function backTo(list, a) {
  let want = a.top;
  if (a.el && a.el.isConnected !== false && a.el.parentElement === list)
    want = list.scrollTop + (a.el.getBoundingClientRect().top - list.getBoundingClientRect().top) - a.off;
  want = Math.max(0, Math.min(want, list.scrollHeight - list.clientHeight));
  if (Math.abs(list.scrollTop - want) <= 1) return false;
  list.scrollTop = want;
  return true;
}
