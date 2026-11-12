// The memory board panel (decision 12, M008 B): entries grouped into sections you open and close, each with
// its count. What waits for you is open by default; the rest folds to one line each. A filter searches every
// section at once. Grouping and filtering are plain functions, so they are tested without a page.

export const SECTIONS = [
  { key: 'waiting', label: 'Waiting for your call', hot: true, open: true },
  { key: 'requirements', label: 'Requirements' },
  { key: 'conventions', label: 'Conventions' },
  { key: 'decided', label: 'Decisions' },
  { key: 'memos', label: 'Memos' },
  { key: 'handoffs', label: 'Handoffs' },
  { key: 'parked', label: 'Parked' },
  { key: 'history', label: 'History', note: 'Superseded, rejected or retired. Kept, never deleted.' }
];

const pad = n => String(n).padStart(4, '0');

// Board snapshot ({ decisions, entries }) to sections of items, newest handoff first.
export function groupBoard(board = {}) {
  const ds = board.decisions || [], es = board.entries || [];
  const dec = d => ({ type: 'decision', id: `D${pad(d.id)}`, num: d.id, title: d.title, status: d.status, d });
  const ent = e => ({ type: 'entry', id: e.entryId, title: e.title, status: e.status, e });
  const live = es.filter(e => e.status === 'active');
  const by = {
    waiting: ds.filter(d => d.status === 'open' || d.status === 'found').map(dec),
    requirements: live.filter(e => e.kind === 'requirement').map(ent),
    conventions: live.filter(e => e.kind === 'convention').map(ent),
    decided: ds.filter(d => d.status === 'decided').map(dec),
    memos: live.filter(e => e.kind === 'memo').map(ent),
    handoffs: live.filter(e => e.kind === 'handoff').map(ent).reverse(),
    parked: ds.filter(d => d.status === 'parked').map(dec),
    history: [...ds.filter(d => ['superseded', 'rejected'].includes(d.status)).map(dec), ...es.filter(e => e.status !== 'active' && e.kind !== 'handoff').map(ent)]
  };
  return SECTIONS.map(s => ({ ...s, items: by[s.key] }));
}

// Every word of the filter must appear in an item's id, title, summary, choice or status. "D31", "d0031" and
// "31" all find decision 31; "R5" finds R005.
export function matches(item, filter) {
  const words = String(filter || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const d = item.d, e = item.e;
  const chosen = d?.chosen ? `${d.chosen} ${(d.options || []).find(o => o.key === d.chosen)?.name || ''}` : '';
  const hay = [item.id, item.title, item.status, chosen, d?.context, e?.summary, e?.from, e?.kind].filter(Boolean).join(' ').toLowerCase();
  return words.every(w => {
    const ref = /^([dmrch])?0*(\d{1,4})$/.exec(w);
    if (ref) {
      const m = /^([a-z])0*(\d+)$/.exec(String(item.id).toLowerCase());
      const same = m && Number(m[2]) === Number(ref[2]) && (!ref[1] || ref[1] === m[1]);
      return !!same || (!ref[1] && hay.includes(w));
    }
    return hay.includes(w);
  });
}

// The sections to show: with a filter, only matching items, every section with a match open; without one,
// each section open as you left it (S.boardOpen), else its default.
export function boardView(board, { filter = '', open = {} } = {}) {
  const f = String(filter || '').trim();
  return groupBoard(board).map(s => {
    const items = f ? s.items.filter(i => matches(i, f)) : s.items;
    return { ...s, total: s.items.length, items, isOpen: f ? items.length > 0 : (open[s.key] ?? !!s.open) };
  }).filter(s => (f ? s.items.length : s.total));
}
