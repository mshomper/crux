// Opening or closing a pop-up leaves the thread where it was (Matt's phone click-test, 0.17.1).
// On the iPhone, opening a modal dialog (the brief, a picture, the gallery, the board's card) sent the thread behind it
// back to its top, and closing left it there. Chromium never did, so the hub does not rely on the browser: every tap or
// key notes where each list is, and when any dialog opens or closes the lists go back there (at once, on the next
// frame, and once more a moment later, unless you have touched the page since). Lists that were at their end stay
// at their end, so a message that arrived meanwhile is still followed. The page's own scroll is kept too.
// Plain ES module: snapshot and restore take any objects shaped like elements, so tests run them.
export const LISTS = '.feed, .board-body';

// Where each list is now: { lists: [{ el, top, end }], y }.
export function snapshot(doc = document) {
  const lists = [...doc.querySelectorAll(LISTS)].filter(el => el.isConnected !== false)
    .map(el => ({ el, top: el.scrollTop, end: el.scrollHeight - el.scrollTop - el.clientHeight < 2 && el.scrollTop > 0 }));
  return { lists, y: doc.defaultView?.scrollY || 0 };
}

// Put the lists back. A list no longer on the page is skipped; a position past the end lands at the end.
// Returns how many lists it moved.
export function restore(s, win = null) {
  let moved = 0;
  for (const { el, top, end } of s?.lists || []) {
    if (el.isConnected === false) continue;
    const want = end ? el.scrollHeight - el.clientHeight : top;
    if (Math.abs(el.scrollTop - want) > 1) { el.scrollTop = want; moved++; }
  }
  if (win && Math.abs((win.scrollY || 0) - (s?.y || 0)) > 1) win.scrollTo(0, s.y);
  return moved;
}

export function installKeepScroll(doc = document) {
  const win = doc.defaultView;
  let last = null, held = null, touches = 0;
  const openNow = () => !!doc.querySelector('dialog[open]');
  // Noted just before the tap's own handlers run (capture), so it is the position the pop-up was opened from.
  const note = () => { touches++; if (!openNow()) last = snapshot(doc); };
  for (const t of ['pointerdown', 'click', 'keydown']) doc.addEventListener(t, note, true);
  new MutationObserver(changes => {
    for (const m of changes) {
      if (m.target.tagName !== 'DIALOG') continue;
      const opened = m.target.hasAttribute('open');
      if (opened && !held) held = last || snapshot(doc);   // the first pop-up of a stack keeps the position
      const s = held, at = touches;
      if (!s) continue;
      const back = () => { if (touches === at || opened) restore(s, win); };
      restore(s, win);
      win.requestAnimationFrame(back);
      win.setTimeout(back, 250);
      if (!opened && !openNow()) { held = null; last = null; }
    }
  }).observe(doc.body, { attributes: true, attributeFilter: ['open'], subtree: true });
}
