// Live map layout. Two arrangements of the same pieces:
//   strip  - a lane across the top: You, workers, the core, workers, Board
//   radial - the full map: core in the middle, Board above, You below, workers on two arcs
// Both return viewport coordinates, so the map can blend them while the panel zooms between them.

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// The desktop strip has three fixed zones (the Fable advisor's option A): meters at the left (the ALL button sits
// inside it), the lane (You, workers, core, workers, Board) in the middle, and the Needs you pill with the expand
// button at the right. stripLayout returns these numbers; map.js writes them to the page as CSS variables and a
// class, and the CSS keys off those alone, so the layout and the styles cannot disagree about widths.
// Normal zones: the meters with their labels at the left, "Needs you" plus a two-digit badge at the right. When the
// slot is narrow (the thread list and the board panel take their share of the window) the lane would be under
// `tightBelow`, so the strip goes tight: three thin unlabelled bars and the pill as icon and count, and workers that do
// not fit at `minStep` apart fold into one "+N" chip. ticker: the narrowest lane that shows the one-line "latest".
export const STRIP_ZONE = { left: 176, right: 168, ticker: 700, tightBelow: 480, tightLeft: 96, tightLeftBare: 56, tightRight: 112, minStep: 28, chipR: 10 };

// On a phone the plan meters get a row of their own under the map's lane, so they never share a line with the
// stations. The row's height here must match usage.css (a test checks it).
export const PHONE_METER_ROW = 15;

// The part of the strip's slot the map itself may draw in: all of it, minus the meters' row on a phone.
export function stripLane(rect, phone, meters) {
  const { left, top, width, height } = rect;
  return { left, top, width, height: phone && meters ? Math.max(0, height - PHONE_METER_ROW) : height };
}

// cluster (the Expedition module): its Lead takes a station of its own in the lane (the nearest the core), and its
// five role stations wait on the Lead at radius 0, so the zoom lets them glide out to the cluster (blendLayouts).
// opts.all: the ALL button is shown (the tight left zone then makes room for it).
export function stripLayout(rect, workers, phone, cluster = null, opts = {}) {
  if (cluster) workers = [{ id: cluster.lead.id }, ...workers];
  const { left, top, width: w, height: h } = rect;
  const Z = STRIP_ZONE;
  const at = new Map();
  // zones (desktop only; a phone keeps its one lane and the meters' own row)
  const tight = !phone && w - Z.left - Z.right < Z.tightBelow;
  const zl = phone ? 0 : tight ? (opts.all ? Z.tightLeft : Z.tightLeftBare) : Z.left;
  const zr = phone ? 0 : tight ? Z.tightRight : Z.right;
  const laneL = left + zl, laneW = Math.max(0, w - zl - zr);
  const zones = phone ? null : { left: { x: left, w: zl }, right: { x: left + w - zr, w: zr }, lane: { x: laneL, w: laneW }, top, height: h };
  const cx = laneL + laneW / 2, cy = top + h / 2;
  const small = !phone && laneW < 330;   // a very narrow lane: a smaller core and closer ends
  // a phone's lane is low: the core is sized so its tick scale stays inside it (the outer scale is not drawn there)
  const coreR = phone ? h * 0.3 : h * (small ? 0.2 : 0.25);
  const sr = phone ? 6 : 12;
  const pad = phone ? 20 : tight ? 6 : 10;
  const sy = phone ? cy : top + h * 0.42;   // stations sit a little high so labels fit underneath
  const youX = laneL + pad + sr, boardX = laneL + laneW - pad - sr;
  at.set('you', { x: youX, y: sy, r: sr });
  at.set('board', { x: boardX, y: sy, r: sr });

  const gap = coreR * (phone ? 1.9 : small ? 2.1 : 2.3);
  // Workers that do not fit at minStep apart fold into one "+N" chip, which takes a slot of its own (the workers kept
  // are the first in the list: the ones that matter most now). The folded ones wait at the chip at radius 0.
  let items = workers, folded = [];
  if (!phone) {
    const span = boardX - sr * 2 - (cx + gap);
    const cap = Math.max(0, Math.floor(span / Z.minStep - 0.6));
    if (workers.length > cap * 2) {
      const keep = Math.max(cluster ? 1 : 0, cap * 2 - 1);
      items = [...workers.slice(0, keep), { id: '__more' }];
      folded = workers.slice(keep);
    }
  }
  const right = items.filter((_, i) => i % 2 === 0), leftSide = items.filter((_, i) => i % 2 === 1);
  let spacing = Infinity;
  const place = (list, from, to) => {
    const n = list.length;
    if (!n) return;
    const step = (to - from) / (n + 0.6);
    spacing = Math.min(spacing, Math.abs(step));
    list.forEach((s, i) => at.set(s.id, { x: from + step * (i + 0.8), y: sy, r: sr }));
  };
  place(right, cx + gap, boardX - sr * 2);
  place(leftSide, cx - gap, youX + sr * 2);
  let fold = null;
  if (folded.length) {
    const c = at.get('__more');
    at.delete('__more');
    fold = { n: folded.length, ids: folded.map(s => s.id), chip: { x: c.x, y: c.y, r: Z.chipR } };
    for (const s of folded) at.set(s.id, { x: c.x, y: c.y, r: 0 });
  }
  if (cluster) { const lead = at.get(cluster.lead.id); for (const s of cluster.stations) at.set(s.id, { x: lead.x, y: lead.y, r: 0 }); }
  const gapPx = Math.min(spacing, 170);
  return {
    core: { x: cx, y: cy, r: coreR }, at, labels: !phone && spacing > 50, compact: phone, spacing: gapPx,
    zones, tight, fold, wide: !phone && laneW >= Z.ticker,   // wide: the lane has room for the "latest" line
    // the ticker's line sits below the worker names (labelBottom), measured from the strip's own top
    tickerY: phone ? null : Math.round(h - 16), labelBottom: phone ? null : sy + sr + 8 + 13 - top,
    labelW: Math.round(clamp(gapPx - (phone ? 10 : 8), 40, 150))   // a worker's name: one line, as wide as its neighbours allow
  };
}

// Room the full map leaves for its own chrome (top bar, telemetry column or tray).
export function radialReserve(rect, phone) {
  const wideTele = !phone && rect.width >= 1040;
  return wideTele
    ? { top: 64, right: 330, bottom: 28, left: 24, tele: 'side' }
    : { top: 60, right: 14, bottom: phone ? 240 : 226, left: 14, tele: 'tray' };
}

// The Expedition module: with a running expedition the full map keeps the orchestrator, You, the Board and any plain
// workers in a column at the left and gives the rest to the cluster; on a phone the core, You and the Board sit in a
// band across the top and the cluster fills the space under it. cluster: { lead: { id }, stations: [{ id }] ×5 }.
const CLUSTER_ANGLES = [-75, -15, 50, 115, 180];   // advisor, synthesizer, skeptic, builder, verifier: as in the mockup
export const CLUSTER_CAPTION = { wide: 74, phone: 92 };

export function radialLayout(rect, workers, phone, cluster = null) {
  const res = radialReserve(rect, phone);
  const ax = rect.left + res.left, ay = rect.top + res.top;
  const aw = Math.max(120, rect.width - res.left - res.right), ah = Math.max(120, rect.height - res.top - res.bottom);
  if (!cluster) return radialIn(ax, ay, aw, ah, workers, phone, res);
  if (phone) {
    const bandH = 96, bottom = 170;   // the tray under the map keeps only the feed here (map.css .has-exp)
    const band = stripLayout({ left: rect.left, top: ay, width: rect.width, height: bandH }, workers, true);
    for (const s of band.at.values()) s.r = 15;
    band.at.get('you').x = rect.left + 36;
    band.at.get('board').x = rect.left + rect.width - 36;
    band.core.r = Math.min(band.core.r, 24);
    const region = { x: rect.left + 8, y: ay + bandH + 6, w: rect.width - 16, h: Math.max(120, rect.height - res.top - bottom - bandH - 6) };
    const geom = placeCluster(band.at, region, cluster, true);
    return { core: band.core, at: band.at, labels: true, compact: false, reserve: { ...res, bottom }, cluster: geom, spacing: band.spacing };
  }
  const leftW = clamp(aw * 0.27, 190, 270);
  const left = radialIn(ax, ay, leftW, ah, workers, false, res);
  const region = { x: ax + leftW, y: ay, w: Math.max(180, aw - leftW), h: ah };
  left.cluster = placeCluster(left.at, region, cluster, false);
  return left;
}

// The cluster inside region { x, y, w, h }: the Lead in the middle, the role stations on a ring, two arcs outside them
// (time, the outer one, and budget) and room under it for the caption and Stop. Writes the stations into `at`.
function placeCluster(at, region, cluster, phone) {
  const cap = phone ? CLUSTER_CAPTION.phone : CLUSTER_CAPTION.wide;
  const sr = phone ? 17 : 21;
  const Ro = Math.max(60, Math.min(region.w, region.h - cap) / 2 - (phone ? 6 : 10));
  const cx = region.x + region.w / 2, cy = region.y + (region.h - cap) / 2;
  const leadR = clamp(Ro * 0.16, 20, 40);
  const Rs = Ro * 0.64;
  at.set(cluster.lead.id, { x: cx, y: cy, r: leadR });
  cluster.stations.forEach((s, i) => {
    const a = (CLUSTER_ANGLES[i] * Math.PI) / 180;
    at.set(s.id, { x: cx + Math.cos(a) * Rs, y: cy + Math.sin(a) * Rs, r: sr });
  });
  return {
    x: cx, y: cy, Ro, Rb: Ro - 9, Rs, k: 1, leadId: cluster.lead.id, ids: cluster.stations.map(s => s.id),
    caption: { x: cx, y: cy + Ro + 12, w: Math.min(region.w, 440) },
    warn: { x: cx + Ro * 0.8, y: cy - Ro * 0.86 }
  };
}

// The open map (decision 77 A, satellites): a larger core, and the workers pulled in close round it on a tilted orbit
// (about 30% of the width), front ones a little larger and brighter (depth 0 at the back to 1 at the front). The Board
// and You keep their places at the top and bottom of the area.
function radialIn(ax, ay, aw, ah, workers, phone, res) {
  const cx = ax + aw / 2, cy = ay + ah / 2;
  const m = Math.min(aw, ah);
  const coreR = clamp(m * 0.16, 34, 116);
  const sr = phone ? 17 : 21;
  const ringOuter = coreR * 1.7 + sr * 1.62 + 12;   // clear of the core's HUD rings, counting the worker's own ring
  const ryEnds = Math.max(ringOuter * 0.8, ah / 2 - sr - 38);   // room for the label under You
  const rx = Math.max(ringOuter, Math.min(aw / 2 - 90, aw * 0.30));
  const ry = Math.min(ryEnds - sr * 2.2, Math.max(ringOuter * 0.78, ah * 0.29));
  const at = new Map();
  at.set('board', { x: cx, y: cy - ryEnds, r: sr });
  at.set('you', { x: cx, y: cy + ryEnds, r: sr });

  const right = workers.filter((_, i) => i % 2 === 0), left = workers.filter((_, i) => i % 2 === 1);
  const gapDeg = 34;
  const arc = (list, a0, a1) => list.forEach((s, i) => {
    const t = list.length === 1 ? 0.5 : i / (list.length - 1);
    const a = (lerp(a0, a1, t) * Math.PI) / 180, depth = (Math.sin(a) + 1) / 2;
    at.set(s.id, { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, r: sr * (0.88 + 0.24 * depth), depth });
  });
  const span = n => Math.min(90 - gapDeg, 14 * n);   // a few workers bunch near the middle; many use the whole arc
  arc(right, -span(right.length), span(right.length));
  arc(left, 180 + span(left.length), 180 - span(left.length));
  return { core: { x: cx, y: cy, r: coreR }, at, labels: true, compact: false, reserve: res };
}

// Blend two layouts (viewport coordinates) and return panel-local coordinates.
export function blendLayouts(a, b, e, origin) {
  const mix = (p, q) => ({ x: lerp(p.x, q.x, e) - origin.x, y: lerp(p.y, q.y, e) - origin.y, r: lerp(p.r, q.r, e), depth: lerp(p.depth ?? 1, q.depth ?? 1, e) });
  const at = new Map();
  for (const [id, q] of b.at) {
    const p = a.at.get(id) || q;
    at.set(id, mix(p, q));
  }
  for (const [id, p] of a.at) if (!at.has(id)) at.set(id, mix(p, p));
  const out = { core: mix(a.core, b.core), at, labels: e > 0.5 ? b.labels : a.labels, compact: e < 0.5 && a.compact };
  // The cluster's arcs open from the Lead's place in the lane to their full size as the map zooms in; k is how far.
  const g = b.cluster;
  if (g) {
    const from = a.at.get(g.leadId) || { x: g.x, y: g.y };
    const to = (v, w) => ({ x: lerp(from.x, v.x, e) - origin.x, y: lerp(from.y, v.y, e) - origin.y });
    const c = to(g);
    out.cluster = { ...g, ...c, k: e, Ro: g.Ro * e, Rb: g.Rb * e, Rs: g.Rs * e, caption: { ...g.caption, ...to(g.caption) }, warn: { ...g.warn, ...to(g.warn) } };
  }
  return out;
}
