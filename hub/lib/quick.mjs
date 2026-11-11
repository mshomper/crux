// Short replies that pick decisions without retyping them:
//   "all" / "take all recommended"   every open decision's recommendation
//   "all but 4A" / "all, 7C"          recommendations, with overrides
//   "4A 7B" / "D0004 A"               specific picks
//   "B"                               when exactly one decision is open
// Anything else is a normal message for the agent (returns null).
export function parseQuickPicks(text, open) {
  const t = String(text).trim();
  if (!open.length || t.length > 80) return null;
  if (/^[A-Za-z]$/.test(t)) return open.length === 1 && open[0].options?.some(o => o.key === t.toUpperCase()) ? [{ id: open[0].id, choice: t.toUpperCase() }] : null;
  const byId = new Map(open.map(d => [d.id, d]));
  const pairRe = /\bD?0*(\d{1,4})\s*([A-Za-z])\b/g;
  const pairs = [...t.matchAll(pairRe)].map(m => ({ id: Number(m[1]), choice: m[2].toUpperCase() }));
  const all = /^(take |pick |yes,? )?(all|everything)\b/i.test(t);
  const rest = t.replace(pairRe, '')
    .replace(/\b(take|pick|all|everything|recommended|recommendations|but|except|and|yes|with|the|of|them)\b/gi, '')
    .replace(/[\s,.;:!]+/g, '');
  if (rest.length) return null;
  const picks = new Map();
  if (all) for (const d of open) if (d.recommended) picks.set(d.id, { id: d.id, choice: d.recommended });
  for (const p of pairs) {
    const d = byId.get(p.id);
    if (d && d.options?.some(o => o.key === p.choice)) picks.set(p.id, p);
    else return null; // a pick that doesn't fit: let the agent handle the message
  }
  return picks.size ? [...picks.values()] : null;
}
