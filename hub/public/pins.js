// Pinned threads as split columns (decision 39 A, R008): which threads are open as columns, which one has the
// keyboard, how many fit the measured width, which fold to the rail, and what a click opens or replaces.
// Pure functions on plain data (no page), so the rules are easy to read, test and change.
//
// state = { cols: [{ t, pinned }], kb, recent }
//   cols    the open threads, left to right; at most MAX_COLS, at most one not pinned (the "loose" column, which
//           is where browsing happens, as the single conversation always was)
//   kb      the thread whose column has the keyboard
//   recent  the open threads, most recently used first (decides what folds when they do not all fit)

export const MAX_COLS = 3;    // up to three columns share the width
export const MIN_COL = 520;   // narrower than this a conversation stops being readable
export const RAIL_W = 56;     // the slim rail that holds pinned threads with no room

export const initial = (t = 'needs') => ({ cols: [{ t, pinned: false }], kb: t, recent: [t] });

// A stored state read back: anything broken or out of shape falls back to one loose column on `fallback`.
export function normalize(raw, fallback = 'needs') {
  const seen = new Set();
  let cols = (Array.isArray(raw?.cols) ? raw.cols : [])
    .filter(c => c && typeof c.t === 'string' && c.t && !seen.has(c.t) && seen.add(c.t))
    .map(c => ({ t: c.t, pinned: !!c.pinned }))
    .slice(0, MAX_COLS);
  // only one loose column: any extra ones become pinned (they were open; keep them open)
  let loose = 0;
  cols = cols.map(c => c.pinned || loose++ === 0 ? c : { ...c, pinned: true });
  if (!cols.length) return initial(fallback);
  const open = cols.map(c => c.t);
  const kb = open.includes(raw?.kb) ? raw.kb : open[0];
  const rec = (Array.isArray(raw?.recent) ? raw.recent : []).filter(t => open.includes(t) && t !== kb);
  const recent = [kb, ...rec, ...open.filter(t => t !== kb && !rec.includes(t))];
  return { cols, kb, recent: [...new Set(recent)] };
}

export const isOpen = (s, t) => s.cols.some(c => c.t === t);
export const isPinned = (s, t) => s.cols.some(c => c.t === t && c.pinned);
export const pinnedCount = s => s.cols.filter(c => c.pinned).length;

// The keyboard moves to an open thread; it becomes the most recently used.
export function focus(s, t) {
  if (!isOpen(s, t)) return s;
  return { ...s, kb: t, recent: [t, ...s.recent.filter(x => x !== t)] };
}

// How many columns fit in the measured width of the conversation area (not the screen: the sidebar is resizable
// and the board opens and closes). n is how many threads are open. When not all fit, the rail takes its share.
export function fit(width, n, { min = MIN_COL, rail = RAIL_W, max = MAX_COLS } = {}) {
  const want = Math.max(1, Math.min(n, max));
  if (want === 1 || Math.floor(width / min) >= want) return want;
  return Math.max(1, Math.min(want - 1, Math.floor((width - rail) / min)));
}

// Which open threads are on screen when `shown` fit: the keyboard column always stays; after it the most recently
// used; the least recently used fold first. Both lists keep the left-to-right order of the columns.
export function layout(s, shown) {
  const keep = new Set([s.kb, ...s.recent.filter(t => t !== s.kb)].slice(0, Math.max(1, shown)));
  return { visible: s.cols.filter(c => keep.has(c.t)), folded: s.cols.filter(c => !keep.has(c.t)) };
}

// The visible column a folded thread would take the place of: the least recently used one on screen.
export function replacedBy(s, shown) {
  const { visible } = layout(s, shown);
  return [...s.recent].reverse().find(t => visible.some(c => c.t === t)) ?? s.kb;
}

// Show a folded thread (a click on the rail, or on its row in the list): it takes the place, and the position, of
// the least recently used visible column, and gets the keyboard. A thread already on screen just gets the keyboard.
export function show(s, t, shown) {
  if (!isOpen(s, t)) return s;
  if (layout(s, shown).visible.some(c => c.t === t)) return focus(s, t);
  const out = replacedBy(s, shown);
  const a = s.cols.find(c => c.t === t), b = s.cols.find(c => c.t === out);
  return focus({ ...s, cols: s.cols.map(c => c === b ? a : c === a ? b : c) }, t);
}

// Put a new column just right of the keyboard column.
const besideKb = (cols, kb, col) => { const at = cols.findIndex(c => c.t === kb) + 1; return [...cols.slice(0, at), col, ...cols.slice(at)]; };

// A thread clicked in the list (or opened from the map, a card or a new agent):
// - already open: show it (see show) and give it the keyboard;
// - a loose column is open: the thread takes its place, as the single conversation always did;
// - every column is pinned and there are fewer than three: it opens as a new column beside the keyboard column;
// - three pinned: it takes the place of the column that has the keyboard (that thread is unpinned).
export function open(s, t, shown = MAX_COLS) {
  if (isOpen(s, t)) return show(s, t, shown);
  const loose = s.cols.findIndex(c => !c.pinned);
  let cols, recent = s.recent;
  // (A project switch does not come through here: switching projects never changes pins; see Columns.projectOpened.)
  if (loose >= 0) { recent = recent.filter(x => x !== s.cols[loose].t); cols = s.cols.map((c, i) => i === loose ? { t, pinned: false } : c); }
  else if (s.cols.length < MAX_COLS) cols = besideKb(s.cols, s.kb, { t, pinned: false });
  else { recent = recent.filter(x => x !== s.kb); cols = s.cols.map(c => c.t === s.kb ? { t, pinned: false } : c); }
  return { cols, kb: t, recent: [t, ...recent.filter(x => x !== t)] };
}

// The pin on a thread row or in a column header.
// - an open thread: its column is pinned and stays where it is;
// - a thread not open: it opens as a pinned column beside the keyboard column; the keyboard stays where it is.
//   With no room left the loose column closes; with three pinned the keyboard column gives up its place (as a
//   click would) and the keyboard moves to the new column.
export function pin(s, t) {
  if (isOpen(s, t)) return { ...s, cols: s.cols.map(c => c.t === t ? { ...c, pinned: true } : c) };
  let cols = besideKb(s.cols, s.kb, { t, pinned: true }), kb = s.kb;
  if (cols.length > MAX_COLS) {
    const loose = cols.find(c => !c.pinned);
    const gone = loose ? loose.t : s.kb;
    cols = cols.filter(c => c.t !== gone);
    if (gone === s.kb) kb = t;
  }
  const open = new Set(cols.map(c => c.t));
  const rest = s.recent.filter(x => open.has(x) && x !== t && x !== kb);
  return { cols, kb, recent: kb === t ? [t, ...rest] : [kb, t, ...rest] };
}

// Close a column. The last column never closes (there is always a conversation on screen).
export function close(s, t) {
  if (!isOpen(s, t) || s.cols.length === 1) return s;
  const recent = s.recent.filter(x => x !== t);
  return { cols: s.cols.filter(c => c.t !== t), kb: s.kb === t ? recent[0] : s.kb, recent };
}

// Columns whose thread no longer exists in this project go (a removed agent, or a name from another project).
// `valid` is a Set of the project's threads (retired agents' threads stay valid: their column shows, box closed).
// Nothing left: one loose column on `fallback`, if that is valid here, else Needs you. Unchanged: the same object.
export function prune(s, valid, fallback = 'needs') {
  const ok = t => valid.has(t);
  if (s.cols.every(c => ok(c.t))) return s;
  const cols = s.cols.filter(c => ok(c.t));
  if (!cols.length) return initial(ok(fallback) ? fallback : 'needs');
  const recent = s.recent.filter(ok);
  return normalize({ cols, kb: ok(s.kb) ? s.kb : recent[0] ?? cols[0].t, recent });
}

// Unpin: the column closes (its hover label says so), unless it is the only one, which just stops being pinned.
export function unpin(s, t) {
  if (!isPinned(s, t)) return s;
  if (s.cols.length === 1) return { ...s, cols: [{ t, pinned: false }] };
  return close(s, t);
}
