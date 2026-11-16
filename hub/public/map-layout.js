// Live map layout. Two arrangements of the same pieces:
//   strip  - a lane across the top: You, workers, the core, workers, Board
//   radial - the full map: core in the middle, Board above, You below, workers on two arcs
// Both return viewport coordinates, so the map can blend them while the panel zooms between them.

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

const STRIP_SIDE = 214;   // room for the readout blocks at each end of a wide strip

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
export function stripLayout(rect, workers, phone, cluster = null) {
  if (cluster) workers = [{ id: cluster.lead.id }, ...workers];
  const { left, top, width: w, height: h } = rect;
  const at = new Map();
  const cx = left + w / 2, cy = top + h / 2;
  // a phone's lane is low: the core is sized so its tick scale stays inside it (the outer scale is not drawn there)
  const coreR = phone ? h * 0.3 : h * 0.25;
  const wide = !phone && w >= 980;
  const side = phone ? 10 : wide ? STRIP_SIDE : 18;
  const sr = phone ? 6 : 12;
  const sy = phone ? cy : top + h * 0.42;   // stations sit a little high so labels fit underneath
  const youX = left + side + sr + 10, boardX = left + w - side - sr - 10;
  at.set('you', { x: youX, y: sy, r: sr });
  at.set('board', { x: boardX, y: sy, r: sr });

  const right = workers.filter((_, i) => i % 2 === 0), leftSide = workers.filter((_, i) => i % 2 === 1);
  const gap = coreR * (phone ? 1.9 : 2.3);
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
  if (cluster) { const lead = at.get(cluster.lead.id); for (const s of cluster.stations) at.set(s.id, { x: lead.x, y: lead.y, r: 0 }); }
  return { core: { x: cx, y: cy, r: coreR }, at, labels: !phone && spacing > 50, compact: phone, spacing: Math.min(spacing, 170) };
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

function radialIn(ax, ay, aw, ah, workers, phone, res) {
  const cx = ax + aw / 2, cy = ay + ah / 2;
  const m = Math.min(aw, ah);
  const coreR = clamp(m * 0.13, 34, 104);
  const sr = phone ? 17 : 21;
  const ringOuter = coreR * 1.75 + sr + 14;
  const rx = Math.max(ringOuter, Math.min(aw / 2 - 74, aw * 0.42));
  const ry = Math.max(ringOuter * 0.8, ah / 2 - sr - 38);   // room for the label under You
  const at = new Map();
  at.set('board', { x: cx, y: cy - ry, r: sr });
  at.set('you', { x: cx, y: cy + ry, r: sr });

  const right = workers.filter((_, i) => i % 2 === 0), left = workers.filter((_, i) => i % 2 === 1);
  const gapDeg = 34;
  const arc = (list, a0, a1) => list.forEach((s, i) => {
    const t = list.length === 1 ? 0.5 : i / (list.length - 1);
    const a = (lerp(a0, a1, t) * Math.PI) / 180;
    at.set(s.id, { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, r: sr });
  });
  const span = n => Math.min(90 - gapDeg, 14 * n);   // a few workers bunch near the middle; many use the whole arc
  arc(right, -span(right.length), span(right.length));
  arc(left, 180 + span(left.length), 180 - span(left.length));
  return { core: { x: cx, y: cy, r: coreR }, at, labels: true, compact: false, reserve: res };
}

// Blend two layouts (viewport coordinates) and return panel-local coordinates.
export function blendLayouts(a, b, e, origin) {
  const mix = (p, q) => ({ x: lerp(p.x, q.x, e) - origin.x, y: lerp(p.y, q.y, e) - origin.y, r: lerp(p.r, q.r, e) });
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
