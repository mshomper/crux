// The All projects map (decision 57 C): the Conductor is the core, and every project is one sector of a ring
// around it. Pure layout and wording, no page objects, so the tests can check them.
//   hubProjects   - the page's All projects groups -> what the map draws per project
//   hubSectors    - one sector per project, clockwise from just after the bottom (the gap there keeps You's spoke clear)
//   hubLayout     - the opened map: core, ring radii, sectors, labels (full, one line, or folded into "+N more"), You
//   hubBays       - the strip: one labelled bay per project either side of the core, compacting as space runs out
//   hubFeed       - the telemetry list: one line per project, the ones waiting on you first

import { radialReserve, clamp } from './map-layout.js';
import { modelLabel } from './models.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const busy = s => s === 'working' || s === 'starting';

// Ring radii, as multiples of the core's radius: the sector band runs from inner to outer, the context gauge sits
// just outside it, and leader lines start at the gauge.
export const RING = { inner: 1.98, outer: 2.5, gauge: 2.62 };

// Label sizes in px: a full label (name, waiting, model and context, agents) and the one-line fold (name and count).
// How wide You's words under its circle are on a phone ("YOU" over "3 WAITING": 64px measured at 390 and 320), with a
// little room for "12 WAITING".
export const YOU_WORDS = 72;

export const LABEL = {
  desk: { full: 92, line: 30, width: 210, lead: 46 },
  phone: { full: 76, line: 24, lead: 0 }
};

// One project for the map. g: a group from hubView (all-projects.js); waitingOf(g, agent) -> how many things of that
// agent's wait on you (threadWaiting), so the page's rule is the only rule.
export function hubProjects(groups, { retireAt = 60, waitingOf = () => 0 } = {}) {
  return (groups || []).map(g => {
    // during a handoff two agents hold the role for a while: the incoming one (not retiring) is the project's now
    const orchs = g.agents.filter(a => a.role === 'orchestrator');
    const orch = orchs.find(a => !a.retiring) || orchs[0] || null;
    const workers = g.agents.filter(a => a.role !== 'orchestrator').map(a => ({
      name: a.name, model: a.model || a.modelSeen || null, state: a.state || 'asleep', needs: (waitingOf(g, a) || 0) > 0
    }));
    return {
      name: g.name, count: g.count || 0, retireAt: Number(g.p?.retireAt) || retireAt,
      model: orch ? orch.model || orch.modelSeen || null : null, effort: orch?.effort || null,
      state: orch ? orch.state || 'asleep' : 'vacant', ctx: orch?.contextPct ?? null, workers
    };
  });
}

// The words a project's label carries.
export function labelLines(p) {
  const n = p.workers.length + (p.state === 'vacant' ? 0 : 1);
  const working = p.workers.filter(w => busy(w.state)).length + (busy(p.state) ? 1 : 0);
  return {
    name: p.name,
    waiting: p.count ? `${p.count} waiting for you` : 'nothing waiting',
    model: p.state === 'vacant' ? 'No orchestrator yet' : `${modelLabel(p.model)} · ${p.ctx == null ? 'context not measured' : `${Math.round(p.ctx)}% context`}`,
    agents: `${n} agent${n === 1 ? '' : 's'} · ${p.state === 'asleep' && !working ? 'asleep' : `${working} working`}`
  };
}

// The hover title of a project's robot, bay or label.
export function projectTitle(p) {
  const l = labelLines(p);
  return `${p.name}: ${l.waiting}. ${l.model}; ${l.agents}. Opens its orchestrator`;
}

// Angles are canvas radians (0 = right, clockwise). The first sector starts just after the bottom, so a gap always
// sits straight down; one or two projects never get more than a third of the ring each.
export function hubSectors(n, { gapDeg = 9, maxSpanDeg = 120 } = {}) {
  if (!n) return [];
  const slice = TAU / n;
  const span = Math.max(2 * DEG, Math.min(slice - gapDeg * DEG, maxSpanDeg * DEG));
  return Array.from({ length: n }, (_, i) => {
    const mid = Math.PI / 2 + (i + 0.5) * slice;
    return { i, mid, a0: mid - span / 2, a1: mid + span / 2, span };
  });
}

// Spread labels in a column: each wants to sit at its own y; keep them h apart and inside [lo, hi].
export function spread(items, h, lo, hi) {
  const out = [...items].sort((a, b) => a.want - b.want).map(x => ({ ...x, y: x.want }));
  for (let k = 0; k < out.length; k++) out[k].y = Math.max(out[k].y, k ? out[k - 1].y + h : lo + h / 2);
  const over = out.length ? out[out.length - 1].y - (hi - h / 2) : 0;
  if (over > 0) {
    out[out.length - 1].y -= over;
    for (let k = out.length - 2; k >= 0; k--) out[k].y = Math.min(out[k].y, out[k + 1].y - h);
  }
  return out;
}

// Which labels a column keeps when they don't all fit: those waiting on you first, then in the hub's order.
// The rest fold into one "+N more" line. Returns { keep, more }.
function fit(items, cap, projects) {
  if (items.length <= cap) return { keep: items, more: [] };
  const room = Math.max(0, cap - 1);   // one slot goes to "+N more"
  const rank = [...items].sort((a, b) => (projects[b.i].count > 0) - (projects[a.i].count > 0) || a.i - b.i);
  const keep = new Set(rank.slice(0, room).map(x => x.i));
  return { keep: items.filter(x => keep.has(x.i)), more: items.filter(x => !keep.has(x.i)).map(x => x.i) };
}

// The opened map. rect: the panel's full rectangle (viewport px). Returns
//   { core, ring: { r1, r2, rg }, sectors, labels: [{ i, x, y, align, mode, edge }], more: [{ x, y, align, n, of }],
//     you: { x, y, r }, reserve, mode }
// label.x is the edge the label hangs from (its left edge when align is 'left', its right edge when 'right');
// edge is where its leader line ends.
export function hubLayout(rect, projects, phone) {
  const n = projects.length;
  const res = radialReserve(rect, phone);
  const ax = rect.left + res.left, ay = rect.top + res.top;
  const aw = Math.max(120, rect.width - res.left - res.right), ah = Math.max(120, rect.height - res.top - res.bottom);
  const cx = ax + aw / 2;
  const sectors = hubSectors(n);
  const youR = phone ? 17 : 21;
  return phone ? phoneLayout() : deskLayout();

  function deskLayout() {
    const S = LABEL.desk;
    const youY = ay + ah - youR - 30;   // room for You's label under it
    const cols = { left: [], right: [] };
    for (const s of sectors) (Math.cos(s.mid) < -1e-6 ? cols.left : cols.right).push({ i: s.i, s });
    const most = Math.max(cols.left.length, cols.right.length, 1);
    const mode = most * S.full <= ah ? 'full' : 'line';
    const h = mode === 'full' ? S.full : S.line;
    const cap = Math.max(1, Math.floor(ah / h));
    // labels narrow a little on a laptop so the ring keeps its size; the ring takes what they and You leave
    const W = clamp(aw * 0.2, 170, S.width);
    const rgMax = Math.min(aw / 2 - W - S.lead - 12, (youY - youR - 12 - ay) / 2);
    const r = clamp(rgMax / RING.gauge, 22, 104);
    const rg = r * RING.gauge;
    const cy = Math.min(ay + ah / 2, youY - youR - 12 - rg);
    const ring = { r1: r * RING.inner, r2: r * RING.outer, rg };
    const labels = [], more = [];
    for (const side of ['left', 'right']) {
      const { keep, more: rest } = fit(cols[side], cap, projects);
      const x = side === 'left' ? cx - rg - S.lead : cx + rg + S.lead;
      const align = side === 'left' ? 'right' : 'left';   // text sits against the ring side
      const want = keep.map(k => ({ i: k.i, want: cy + Math.sin(k.s.mid) * (rg + r * 0.6) }));
      if (rest.length) want.push({ i: -1, want: ay + ah });   // "+N more" goes last in the column
      for (const it of spread(want, h, ay, ay + ah)) {
        if (it.i < 0) more.push({ x, y: it.y, align, n: rest.length, of: rest, width: W });
        else labels.push({ i: it.i, x, y: it.y, align, mode, width: W, edge: { x, y: it.y } });
      }
    }
    return { core: { x: cx, y: cy, r }, ring, sectors, labels, more, you: { x: cx, y: youY, r: youR }, reserve: res, mode };
  }

  function phoneLayout() {
    const S = LABEL.phone;
    const bands = { top: { left: [], right: [] }, bottom: { left: [], right: [] } };
    for (const s of sectors) bands[Math.sin(s.mid) <= 1e-6 ? 'top' : 'bottom'][Math.cos(s.mid) < -1e-6 ? 'left' : 'right'].push({ i: s.i, s });
    const rows = b => Math.max(b.left.length, b.right.length);
    const youBlock = youR * 2 + 34;
    const minRing = 2 * 22 * RING.gauge + 16;
    // full labels only while the ring keeps a readable size (core radius 34); else one-line labels and a bigger ring
    const need = (h, ring) => rows(bands.top) * h + Math.max(rows(bands.bottom) * h, youBlock) + ring;
    const mode = need(S.full, 2 * 34 * RING.gauge + 16) <= ah ? 'full' : 'line';
    const h = mode === 'full' ? S.full : S.line;
    // rows each band may hold, if even one-line labels don't all fit
    const spare = Math.max(0, ah - minRing - youBlock);
    const topRows = Math.min(rows(bands.top), Math.max(1, Math.floor(spare / 2 / h)));
    const bottomRows = Math.min(rows(bands.bottom), Math.max(1, Math.floor((ah - minRing - topRows * h) / h)));
    const topH = topRows * h, bottomH = Math.max(bottomRows * h, youBlock);
    const rg = Math.max(22 * RING.gauge, Math.min(aw / 2 - 8, (ah - topH - bottomH - 16) / 2));
    const r = clamp(rg / RING.gauge, 22, 104);
    const cy = ay + topH + 8 + rg;
    const ring = { r1: r * RING.inner, r2: r * RING.outer, rg: r * RING.gauge };
    // You sits in the bottom band: rows beside its circle stop short of the circle; the row level with its words
    // ("3 WAITING", wider than the circle) stops short of those (review, 2026-11-13: it overlapped them by 3.4px)
    const youY = ay + ah - youR - 30, wordsTop = youY + youR + 4;
    const wide = aw / 2 - youR - 12, narrow = aw / 2 - YOU_WORDS / 2 - 8;
    const widthAt = (band, y) => band === 'bottom' && y + h / 2 > wordsTop ? narrow : wide;
    const labels = [], more = [];
    for (const band of ['top', 'bottom']) {
      const cap = band === 'top' ? topRows : bottomRows;
      const y0 = band === 'top' ? ay : ay + ah - bottomRows * h;
      for (const side of ['left', 'right']) {
        // nearest the ring last in the top band, first in the bottom band, so leader lines don't cross
        const list = [...bands[band][side]].sort((a, b) => Math.sin(a.s.mid) - Math.sin(b.s.mid));
        const { keep, more: rest } = fit(list, cap, projects);
        const x = side === 'left' ? ax : ax + aw;
        const align = side;
        const slots = keep.length + (rest.length ? 1 : 0);
        const base = band === 'top' ? y0 + (cap - slots) * h : y0;   // the top band hugs the ring
        keep.forEach((k, j) => {
          const y = base + (j + 0.5) * h;
          const ex = side === 'left' ? x + 18 : x - 18;
          labels.push({ i: k.i, x, y, align, mode, width: widthAt(band, y), edge: { x: ex, y: band === 'top' ? y + h / 2 - 3 : y - h / 2 + 3 } });
        });
        if (rest.length) { const y = base + (keep.length + 0.5) * h; more.push({ x, y, align, n: rest.length, of: rest, width: widthAt(band, y) }); }
      }
    }
    return { core: { x: cx, y: cy, r }, ring, sectors, labels, more, you: { x: cx, y: youY, r: youR }, reserve: res, mode };
  }
}

// The strip. rect: the strip's lane; core and you: where stripLayout put them. Returns
//   { bays: [{ i, x, y, mode, w }], more: { x, y, n, of } | null }
// mode: 'full' (robot, name, waiting, context bar), 'icon' (robot and count), 'dot' (a small robot).
export function hubBays(rect, projects, phone, { core, you, rightEnd } = {}) {
  const n = projects.length;
  const y = core.y;
  const gap = core.r * (phone ? 2.1 : 2.6);
  const leftZone = [you.x + you.r + (phone ? 10 : 18), core.x - gap];
  const rightZone = [core.x + gap, rightEnd ?? rect.left + rect.width - (phone ? 8 : 18)];
  const sides = { right: [], left: [] };
  for (let i = 0; i < n; i++) sides[i % 2 === 0 ? 'right' : 'left'].push(i);
  const bays = [];
  let more = null;
  const min = { full: 170, icon: phone ? 30 : 46, dot: phone ? 16 : 22 };
  for (const side of ['right', 'left']) {
    const [a, b] = side === 'right' ? rightZone : leftZone;
    const Z = Math.max(0, b - a);
    let list = sides[side];
    let slot = list.length ? Z / list.length : Z;
    if (list.length && slot < min.dot) {   // even small robots don't fit: keep what fits, the rest fold into "+N"
      const room = Math.max(0, Math.floor(Z / min.dot) - 1);
      const rank = [...list].sort((p, q) => (projects[q].count > 0) - (projects[p].count > 0) || p - q);
      const keep = new Set(rank.slice(0, room));
      const rest = list.filter(i => !keep.has(i));
      list = list.filter(i => keep.has(i));
      slot = min.dot;
      const k = list.length;
      const x = side === 'right' ? a + (k + 0.5) * slot : b - (k + 0.5) * slot;
      more = { x, y, n: rest.length + (more?.n || 0), of: [...(more?.of || []), ...rest] };
    }
    const mode = !phone && slot >= min.full ? 'full' : slot >= min.icon ? 'icon' : 'dot';
    list.forEach((i, j) => {
      const x = side === 'right' ? a + (j + 0.5) * slot : b - (j + 0.5) * slot;
      bays.push({ i, x, y, mode, w: mode === 'full' ? Math.min(slot - 16, 232) : null });
    });
  }
  return { bays: bays.sort((p, q) => p.i - q.i), more };
}

// Telemetry in hub mode: one line per project, those waiting on you first, then working ones, then the rest.
export function hubFeed(projects) {
  const rank = p => (p.count ? 0 : busy(p.state) || p.workers.some(w => busy(w.state)) ? 1 : 2);
  return projects.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map(({ p }) => {
    const l = labelLines(p);
    return { name: p.name, tone: p.count ? 'alert' : busy(p.state) ? 'reply' : 'activity', text: p.count ? l.waiting : `${l.agents} · ${p.ctx == null ? 'context –' : `${Math.round(p.ctx)}%`}` };
  });
}
