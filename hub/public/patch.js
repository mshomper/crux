// Applying a small update from the hub to a project the page holds (the other end of lib/feed.mjs diffParts).
// Pure: no page objects, so a test runs it. `patch` is { set: { key: value }, del: [key], order }, where a key is
// "a:<agent name>", "d:<decision id>", "e:<entry id>", "w:<waiting part>" or "k:<other field>".

const LIST = { a: p => p.agents, d: p => p.board.decisions, e: p => p.board.entries };
const ID = { a: x => x.name, d: x => String(x.id), e: x => x.entryId };

export function applyViewPatch(p, patch) {
  const put = (arr, t, id, v) => { const i = arr.findIndex(x => ID[t](x) === id); if (i >= 0) arr[i] = v; else arr.push(v); };
  for (const [k, v] of Object.entries(patch.set || {})) {
    const t = k[0], id = k.slice(2);
    if (t === 'k') p[id] = v;
    else if (t === 'w') (p.wait ||= {})[id] = v;
    else if (LIST[t]) put(LIST[t](p), t, id, v);
  }
  for (const k of patch.del || []) {
    const t = k[0], id = k.slice(2);
    if (t === 'k') delete p[id];
    else if (t === 'w') delete p.wait?.[id];
    else if (LIST[t]) { const arr = LIST[t](p), i = arr.findIndex(x => ID[t](x) === id); if (i >= 0) arr.splice(i, 1); }
  }
  // The hub's order for agents, decisions and entries.
  const sortBy = (arr, ids, t) => { const at = new Map((ids || []).map((x, i) => [String(x), i])); arr.sort((x, y) => (at.get(ID[t](x)) ?? 1e9) - (at.get(ID[t](y)) ?? 1e9)); };
  if (patch.order) { sortBy(p.agents, patch.order.agents, 'a'); sortBy(p.board.decisions, patch.order.decisions, 'd'); sortBy(p.board.entries, patch.order.entries, 'e'); }
  return p;
}
