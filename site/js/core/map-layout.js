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

// ---------- the open map's satellites (decision 77 A) ----------
// What a satellite's label takes up, from map.css: the name in 10.5px mono with .06em spacing (.hs-label b) on a 16px
// line, the red "Waiting on you" line in 11.5px sans (.hs.sat.asks .hs-label i, 17px with its gap), a handoff word in
// 10.5px mono capitals with .1em spacing (14px). The px per character run a little wide of the real fonts (Cascadia
// Mono, Consolas or the system monospace), so the layout errs towards room. ring: how far a worker's particle ring
// reaches, in station radii, with its breathing and particle size (map-particles.js RING_REACH is 1.62); labelTop: the
// label's top under a satellite, in station radii plus px (map.css .hs.sat .hs-label); gap: the least clear space
// between any two things.
export const SAT = { name: 6.9, sub: 7.4, ask: 6.6, pad: 4, line: 16, subLine: 14, askLine: 17, ring: 1.7, ringPx: 1, labelTop: 1.62, labelTopPx: 6, gap: 4, chipR: 12 };
// The core's HUD scales reach 1.6 core radii plus 6 px (map-hud.js R3 + 6): nothing else may come inside them.
export const coreKeep = r => r * 1.6 + 6;
// The second line under a satellite: only when it waits on you or is handing over (Matt, 2026-11-17).
export const satSub = s => s.needs ? 'Waiting on you' : s.handoff === 'writing' ? 'writing handoff' : s.handoff === 'overlap' ? 'handing over' : '';
// A satellite's label box, w by h, with its name cut at `cap` px (the page cuts it there too, with an ellipsis).
export function satLabel(s, cap = 150) {
  const sub = satSub(s), ask = !!s.needs;
  const w = Math.max(Math.min(cap, String(s.name ?? '').length * SAT.name + SAT.pad), sub ? Math.min(170, sub.length * (ask ? SAT.ask : SAT.sub) + SAT.pad) : 0);
  return { w, h: SAT.line + (sub ? (ask ? SAT.askLine : SAT.subLine) : 0) };
}

// Steps down when the room is short: robots and rings smaller, names cut shorter, the core a little smaller. When even the
// last step does not fit, the workers at the end of the list fold into a "+N" chip, one at a time.
const SAT_STEPS = [{ s: 1, lw: 150, core: 1 }, { s: 0.85, lw: 120, core: 0.85 }, { s: 0.72, lw: 96, core: 0.72 }, { s: 0.62, lw: 76, core: 0.62 }];
const MORE = '__more';

// The shapes a station takes up: its ring (a circle) and its label (a box under it).
function satShapes(p) {
  if (p.more) return [{ c: true, x: p.x, y: p.y, r: SAT.chipR + 2 }];
  const ring = { c: true, x: p.x, y: p.y, r: p.r * SAT.ring + SAT.ringPx };
  const y0 = p.y + p.r * SAT.labelTop + SAT.labelTopPx;
  return [ring, { c: false, x0: p.x - p.lab.w / 2, x1: p.x + p.lab.w / 2, y0, y1: y0 + p.lab.h }];
}
function endShapes(p) {   // the Board and You: the disc (with its hover growth) and the label under it
  const y0 = p.y + p.r + 8;
  return [{ c: true, x: p.x, y: p.y, r: p.r * 1.12 }, { c: false, x0: p.x - p.lab.w / 2, x1: p.x + p.lab.w / 2, y0, y1: y0 + p.lab.h }];
}
function hit(a, b, g) {
  if (a.c && b.c) return Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r + g;
  if (!a.c && !b.c) return a.x0 < b.x1 + g && b.x0 < a.x1 + g && a.y0 < b.y1 + g && b.y0 < a.y1 + g;
  const c = a.c ? a : b, r = a.c ? b : a;
  return Math.hypot(c.x - clamp(c.x, r.x0, r.x1), c.y - clamp(c.y, r.y0, r.y1)) < c.r + g;
}
const hits = (A, B, g) => A.some(a => B.some(b => hit(a, b, g)));
function inside(S, box) {
  return S.every(s => s.c ? s.x - s.r >= box.x0 && s.x + s.r <= box.x1 && s.y - s.r >= box.y0 && s.y + s.r <= box.y1
    : s.x0 >= box.x0 && s.x1 <= box.x1 && s.y0 >= box.y0 && s.y1 <= box.y1);
}

// Try one arrangement: core size, station size, orbit and spread. Returns the placed stations, or null if any two
// things touch (rings, labels, the Board, You, the core's scales) or anything leaves the area.
// tilt (degrees) turns both arcs towards the front (positive) or the back, mirrored, so a lone worker on a side can
// leave the core's level on a narrow map.
function satTry(G, step, items, rx, ry, spanDeg, tilt = 0) {
  const { cx, cy, box, sr, coreR, ends } = G;
  const core = [{ c: true, x: cx, y: cy, r: coreKeep(coreR) }];
  const placed = [];
  const right = items.filter((_, i) => i % 2 === 0), left = items.filter((_, i) => i % 2 === 1);
  const arc = (list, a0, a1) => list.forEach((s, i) => {
    const t = list.length === 1 ? 0.5 : i / (list.length - 1);
    const a = (lerp(a0, a1, t) * Math.PI) / 180, depth = (Math.sin(a) + 1) / 2;
    const p = { id: s.id, more: s.id === MORE, x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, r: sr * (0.88 + 0.24 * depth), depth };
    if (!p.more) p.lab = satLabel(s, step.lw);
    placed.push(p);
  });
  arc(right, -spanDeg + tilt, spanDeg + tilt);
  arc(left, 180 + spanDeg - tilt, 180 - spanDeg - tilt);
  const shapes = placed.map(satShapes);
  for (let i = 0; i < placed.length; i++) {
    const S = shapes[i];
    if (!inside(S, box) || hits(S, core, SAT.gap) || ends.some(E => hits(S, E, SAT.gap))) return null;
    for (let j = 0; j < i; j++) if (hits(S, shapes[j], SAT.gap)) return null;
  }
  return placed;
}

// The open map (decision 77 A, satellites): a larger core, and the workers pulled in close round it on a tilted orbit
// (about 30% of the width), front ones a little larger and brighter (depth 0 at the back to 1 at the front). The Board
// sits at the top of the area and You at the bottom. Rings, labels, the Board, You and the core's scales never touch:
// when the room is short the stations step down in size (SAT_STEPS), and workers that still do not fit fold into a
// "+N" chip (fold: { n, ids, chip }); a folded worker waits at the chip at radius 0. Each worker's entry carries lw, the
// width its name may take.
function radialIn(ax, ay, aw, ah, workers, phone, res) {
  const cx = ax + aw / 2, cy = ay + ah / 2;
  const box = { x0: ax, y0: ay, x1: ax + aw, y1: ay + ah };
  const baseCore = clamp(Math.min(aw, ah) * 0.16, 34, 116), baseSr = phone ? 17 : 21;
  const youLab = { w: 10 * SAT.sub + SAT.pad, h: SAT.line + 1 + 13 }, boardLab = { w: 5 * SAT.name + SAT.pad, h: SAT.line };
  const attempt = (items, step) => {
    const sr = baseSr * step.s, coreR = Math.max(Math.min(baseCore, 34), baseCore * step.core);
    // the Board at the top edge, You at the bottom with its two-line label under it
    const board = { x: cx, y: ay + sr * 1.12 + 2, r: sr, lab: boardLab }, you = { x: cx, y: ay + ah - sr - 8 - youLab.h - 2, r: sr, lab: youLab };
    const ends = [endShapes(board), endShapes(you)];
    const coreS = [{ c: true, x: cx, y: cy, r: coreKeep(coreR) }];
    const G = { cx, cy, box, sr, coreR, ends };
    const fallback = { items, step, G, board, you, placed: null };
    if (ends.some(E => hits(E, coreS, SAT.gap))) return fallback;
    const nR = Math.ceil(items.length / 2);
    const halfW = Math.max(sr * 1.12 * SAT.ring + SAT.ringPx, ...items.map(s => s.id === MORE ? SAT.chipR : satLabel(s, step.lw).w / 2));
    const rxMax = aw / 2 - halfW - 1;
    const rxPref = Math.min(rxMax, Math.max(coreKeep(coreR) + sr * SAT.ring + SAT.gap, Math.min(aw / 2 - 90, aw * 0.30)));
    const rxs = [...new Set([rxPref, (rxPref + rxMax) / 2, rxMax].map(Math.round))].filter(v => v > 0);
    const ryPref = ah * 0.29, ryCap = ah / 2;
    const rys = [...new Set([ryPref, ryPref * 1.25, ryPref * 1.5, ryPref * 0.75].map(v => Math.round(Math.min(ryCap, v))))];
    const span0 = Math.min(56, 14 * nR);   // a few workers bunch near the middle; many use the whole arc
    const spans = [...new Set([span0, span0 + 12, span0 + 24, Math.max(8, span0 - 12)].map(v => Math.min(84, v)))];
    for (const tilt of [0, 30, -30]) for (const rx of rxs) for (const ry of rys) for (const sp of spans) {
      const placed = satTry(G, step, items, rx, ry, sp, tilt);
      if (placed) return { ...fallback, placed };
    }
    return fallback;
  };
  let fit = null;
  for (let keep = workers.length; keep >= 0 && !fit; keep--) {
    const items = keep < workers.length ? [...workers.slice(0, keep), { id: MORE }] : workers;
    for (const step of SAT_STEPS) {
      const a = attempt(items, step);
      if (a.placed) { fit = { ...a, keep }; break; }
    }
  }
  // nothing fits (a tiny window): keep every worker at the smallest step on the preferred orbit, and say so
  const g = fit || (() => {
    const step = SAT_STEPS[SAT_STEPS.length - 1], a = attempt(workers, step);
    const G = a.G, rx = Math.max(1, aw * 0.3), ry = ah * 0.29;
    const placed = [];
    const right = workers.filter((_, i) => i % 2 === 0), left = workers.filter((_, i) => i % 2 === 1);
    const arc = (list, a0, a1) => list.forEach((s, i) => {
      const t = list.length === 1 ? 0.5 : i / (list.length - 1), an = (lerp(a0, a1, t) * Math.PI) / 180, depth = (Math.sin(an) + 1) / 2;
      placed.push({ id: s.id, x: G.cx + Math.cos(an) * rx, y: G.cy + Math.sin(an) * ry, r: G.sr * (0.88 + 0.24 * depth), depth, lab: satLabel(s, step.lw) });
    });
    arc(right, -56, 56); arc(left, 236, 124);
    return { ...a, placed, keep: workers.length, crowded: true };
  })();
  const at = new Map();
  at.set('board', { x: g.board.x, y: g.board.y, r: g.board.r });
  at.set('you', { x: g.you.x, y: g.you.y, r: g.you.r });
  let fold = null;
  for (const p of g.placed) {
    if (p.more) continue;
    at.set(p.id, { x: p.x, y: p.y, r: p.r, depth: p.depth, lw: g.step.lw });
  }
  const chip = g.placed.find(p => p.more);
  if (chip) {
    const rest = workers.slice(g.keep);
    fold = { n: rest.length, ids: rest.map(s => s.id), chip: { x: chip.x, y: chip.y, r: SAT.chipR } };
    for (const s of rest) at.set(s.id, { x: chip.x, y: chip.y, r: 0, depth: 1 });
  }
  return { core: { x: cx, y: cy, r: g.G.coreR }, at, labels: true, compact: false, reserve: res, fold, crowded: !!g.crowded };
}

// Blend two layouts (viewport coordinates) and return panel-local coordinates.
export function blendLayouts(a, b, e, origin) {
  const mix = (p, q) => ({ x: lerp(p.x, q.x, e) - origin.x, y: lerp(p.y, q.y, e) - origin.y, r: lerp(p.r, q.r, e), depth: lerp(p.depth ?? 1, q.depth ?? 1, e), lw: q.lw ?? p.lw });
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
