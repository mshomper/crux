// Live map layout. Two arrangements of the same pieces:
//   strip  - a lane across the top: You, workers, the core, workers, Board
//   radial - the full map: core in the middle, Board above, You below, workers on two arcs
// Both return viewport coordinates, so the map can blend them while the panel zooms between them.

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

const STRIP_SIDE = 214;   // room for the readout blocks at each end of a wide strip

export function stripLayout(rect, workers, phone) {
  const { left, top, width: w, height: h } = rect;
  const at = new Map();
  const cx = left + w / 2, cy = top + h / 2;
  const coreR = phone ? h * 0.26 : h * 0.25;
  const wide = !phone && w >= 980;
  const side = phone ? 10 : wide ? STRIP_SIDE : 18;
  const sr = phone ? 6 : 12;
  const sy = phone ? cy : top + h * 0.42;   // stations sit a little high so labels fit underneath
  const youX = left + side + sr + 10, boardX = left + w - side - sr - 10;
  at.set('you', { x: youX, y: sy, r: sr });
  at.set('board', { x: boardX, y: sy, r: sr });

  const right = workers.filter((_, i) => i % 2 === 0), leftSide = workers.filter((_, i) => i % 2 === 1);
  const gap = coreR * (phone ? 2.1 : 2.3);
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
  return { core: { x: cx, y: cy, r: coreR }, at, labels: !phone && spacing > 50, compact: phone, spacing: Math.min(spacing, 170) };
}

// Room the full map leaves for its own chrome (top bar, telemetry column or tray).
export function radialReserve(rect, phone) {
  const wideTele = !phone && rect.width >= 1040;
  return wideTele
    ? { top: 64, right: 330, bottom: 28, left: 24, tele: 'side' }
    : { top: 60, right: 14, bottom: phone ? 240 : 226, left: 14, tele: 'tray' };
}

export function radialLayout(rect, workers, phone) {
  const res = radialReserve(rect, phone);
  const ax = rect.left + res.left, ay = rect.top + res.top;
  const aw = Math.max(120, rect.width - res.left - res.right), ah = Math.max(120, rect.height - res.top - res.bottom);
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
  return { core: mix(a.core, b.core), at, labels: e > 0.5 ? b.labels : a.labels, compact: e < 0.5 && a.compact };
}
