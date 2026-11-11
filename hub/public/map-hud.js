// The live map's line work, drawn on a 2D canvas under the particles:
// edges that thicken with traffic, the core's rings (context used, handoff mark, rotating scales),
// station rings, red halos where something needs you, and pings where pulses land.

import { clamp, lerp } from './map-layout.js';
import { bend, onCurve, COLORS, TONE } from './map-particles.js';
import { hueOf, rgb01, pipCount } from './models.js';

const rgb = (c, a) => `rgba(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0},${a})`;
const TAU = Math.PI * 2;
const MONO = '"Cascadia Mono", Consolas, ui-monospace, monospace';

export function ctxColor(ctx, retireAt) {
  if (ctx == null) return COLORS.cyan;
  if (ctx >= retireAt) return COLORS.red;
  if (ctx >= retireAt * 0.8) return COLORS.amber;
  return COLORS.cyan;
}

export class HudPainter {
  constructor(canvas) {
    this.canvas = canvas;
    this.c = canvas.getContext('2d');
  }

  resize(w, h, dpr) {
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (W !== this.canvas.width || H !== this.canvas.height) { this.canvas.width = W; this.canvas.height = H; }
    this.w = w; this.h = h; this.dpr = dpr;
  }

  // f: { L, e, t, boot, core, info, pings, now, staticCore }
  paint(f) {
    const c = this.c;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    c.lineCap = 'round';
    this.edges(f);
    if (f.staticCore) this.staticCore(f); else this.aura(f);
    this.rings(f);
    this.stations(f);
    this.pings(f);
  }

  edges({ L, e, t, info }) {
    const c = this.c, core = L.core;
    const ringR = core.r * 1.62;
    for (const [id, s] of L.at) {
      const st = info.get(id);
      if (!st) continue;
      const fade = st.fade ?? 1;
      const cp = bend(core, s, 0.17, L.bendMax);
      const len = Math.hypot(s.x - core.x, s.y - core.y) || 1;
      const u0 = clamp(ringR / len, 0, 0.45), u1 = clamp(1 - (s.r + 7) / len, 0.55, 1);
      if (u1 <= u0) continue;
      const path = () => {
        c.beginPath();
        for (let i = 0; i <= 28; i++) {
          const q = onCurve(core, cp, s, lerp(u0, u1, i / 28));
          i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y);
        }
      };
      const traffic = st.traffic ?? 0.4;
      if (st.kind === 'ghost' || st.handoff) {
        // a handoff in progress: a dashed gold line
        path();
        c.setLineDash([5, 6]);
        c.lineDashOffset = -t * 18;
        c.strokeStyle = rgb(TONE.handoff, 0.6 * fade);
        c.lineWidth = 1.4;
        c.stroke();
        c.setLineDash([]);
        continue;
      }
      const scale = lerp(0.75, 1.15, e);
      const needs = st.needs;
      // base spoke: thicker where more work went
      path();
      c.setLineDash([]);
      c.strokeStyle = needs ? rgb(COLORS.red, 0.32 * fade) : rgb(COLORS.cyan, (0.1 + traffic * 0.16) * fade);
      c.lineWidth = (0.8 + traffic * 3.2) * scale;
      c.stroke();
      // flow: dashes moving along the spoke while the station is busy, or towards you when it needs you
      const busy = st.state === 'working' || st.state === 'starting';
      if (busy || needs) {
        path();
        c.setLineDash([2, 9]);
        c.lineDashOffset = (needs ? 1 : -1) * t * 26;
        c.strokeStyle = needs ? rgb(COLORS.red, (0.55 + 0.3 * Math.sin(t * 4)) * fade) : rgb(COLORS.cyan, 0.55 * fade);
        c.lineWidth = 1.4 * scale;
        c.stroke();
        c.setLineDash([]);
      }
    }
  }

  rings({ L, e, t, boot, core: info }) {
    const c = this.c, { x, y, r } = L.core;
    const b = boot ?? 1;
    const col = ctxColor(info.ctx, info.retireAt);
    const vacant = info.state === 'vacant';
    // inner scale: rotating ticks
    const R1 = r * 1.18;
    c.save();
    c.translate(x, y);
    c.rotate(t * 0.05);
    const ticks = 72;
    for (let i = 0; i < ticks * b; i++) {
      const a = (i / ticks) * TAU, long = i % 6 === 0;
      const r0 = R1, r1 = R1 + (long ? 5 + e * 3 : 2.2);
      c.strokeStyle = rgb(COLORS.cyan, long ? 0.34 : 0.16);
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); c.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); c.stroke();
    }
    c.restore();

    // context ring: how much of its context window the holder has used, with the handoff mark
    const R2 = r * 1.36, lw = lerp(2.2, 4, e);
    c.lineWidth = lw;
    c.strokeStyle = 'rgba(255,255,255,0.07)';
    c.beginPath(); c.arc(x, y, R2, 0, TAU); c.stroke();
    if (info.ctx != null && !vacant) {
      const end = -Math.PI / 2 + TAU * clamp(info.ctx / 100, 0, 1) * b;
      c.save();
      c.shadowColor = rgb(col, 0.9); c.shadowBlur = 10 + e * 8;
      c.strokeStyle = rgb(col, 0.95);
      c.beginPath(); c.arc(x, y, R2, -Math.PI / 2, end); c.stroke();
      c.fillStyle = rgb(COLORS.white, 0.95);
      c.beginPath(); c.arc(x + Math.cos(end) * R2, y + Math.sin(end) * R2, lw * 0.8, 0, TAU); c.fill();
      c.restore();
    }
    const ha = -Math.PI / 2 + TAU * clamp(info.retireAt / 100, 0, 1);
    c.strokeStyle = rgb(COLORS.amber, 0.9);
    c.lineWidth = 1.6;
    c.beginPath(); c.moveTo(x + Math.cos(ha) * (R2 - lw - 3), y + Math.sin(ha) * (R2 - lw - 3)); c.lineTo(x + Math.cos(ha) * (R2 + lw + 4), y + Math.sin(ha) * (R2 + lw + 4)); c.stroke();

    // outer scale: three arcs turning one way, a dotted ring turning the other
    const R3 = r * 1.6;
    c.lineWidth = 1;
    c.strokeStyle = rgb(COLORS.cyan, 0.38);
    for (let k = 0; k < 3; k++) {
      const a0 = -t * 0.16 + (k * TAU) / 3;
      c.beginPath(); c.arc(x, y, R3, a0, a0 + 1.25 * b); c.stroke();
    }
    c.setLineDash([1, 5]);
    c.lineDashOffset = t * 6;
    c.strokeStyle = rgb(COLORS.accent, 0.3);
    c.beginPath(); c.arc(x, y, R3 + 6, 0, TAU * b); c.stroke();
    c.setLineDash([]);

    if (e > 0.02) {
      // radar sweep, full map only
      const R4 = r * 1.9, a = t * 0.9;
      if (c.createConicGradient) {
        const g = c.createConicGradient(a - 1.1, x, y);
        g.addColorStop(0, rgb(COLORS.cyan, 0));
        g.addColorStop(0.17, rgb(COLORS.cyan, 0.32 * e));
        g.addColorStop(0.175, rgb(COLORS.cyan, 0));
        c.strokeStyle = g;
        c.lineWidth = 10;
        c.beginPath(); c.arc(x, y, R4, a - 1.1, a); c.stroke();
      }
      c.strokeStyle = rgb(COLORS.cyan, 0.08 * e);
      c.lineWidth = 1;
      c.beginPath(); c.arc(x, y, R4 + 5, 0, TAU); c.stroke();
      // crosshair ticks at the four quarters
      c.strokeStyle = rgb(COLORS.cyan, 0.45 * e);
      for (let k = 0; k < 4; k++) {
        const q = (k * Math.PI) / 2;
        c.beginPath(); c.moveTo(x + Math.cos(q) * (R4 + 1), y + Math.sin(q) * (R4 + 1)); c.lineTo(x + Math.cos(q) * (R4 + 10), y + Math.sin(q) * (R4 + 10)); c.stroke();
      }
    }

    // labels around the core, full map only
    const la = clamp((e - 0.55) / 0.45, 0, 1) * b;
    if (la > 0) {
      const tx = x + Math.cos(ha) * (R2 + 16), ty = y + Math.sin(ha) * (R2 + 16);
      c.font = `600 9.5px ${MONO}`;
      c.textAlign = Math.cos(ha) > 0.2 ? 'left' : Math.cos(ha) < -0.2 ? 'right' : 'center';
      c.fillStyle = rgb(COLORS.amber, 0.85 * la);
      c.fillText(`HANDOFF ${info.retireAt}%`, tx, ty + 3);
      this.callout(L, info, col, la, vacant);
    }
  }

  // A leader-line callout off the core: generation and context used, placed where no spoke runs.
  callout(L, info, col, alpha, vacant) {
    const c = this.c, { x, y, r } = L.core;
    const taken = [...L.at.values()].map(s => Math.atan2(s.y - y, s.x - x));
    const gap = a => Math.min(...taken.map(t => Math.abs(Math.atan2(Math.sin(a - t), Math.cos(a - t)))), 9);
    const cands = [-140, -40, 140, 40, -120, -60, 120, 60, 180, 0].map(d => (d * Math.PI) / 180);
    const a = cands.reduce((best, k) => gap(k) > gap(best) + 0.05 ? k : best, cands[0]);
    const R = r * 1.6 + 9;
    const p0 = { x: x + Math.cos(a) * R, y: y + Math.sin(a) * R };
    const p1 = { x: p0.x + Math.cos(a) * 18, y: p0.y + Math.sin(a) * 18 };
    let dir = Math.cos(a) >= 0 ? 1 : -1;
    if (p1.x + dir * 96 > this.w - 8 || p1.x + dir * 96 < 8) dir = -dir;   // keep it on screen
    const p2 = { x: clamp(p1.x + dir * 92, 8, this.w - 8), y: p1.y };
    c.strokeStyle = rgb(COLORS.cyan, 0.55 * alpha);
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(p0.x, p0.y); c.lineTo(p1.x, p1.y); c.lineTo(p2.x, p2.y); c.stroke();
    c.fillStyle = rgb(COLORS.cyan, 0.9 * alpha);
    c.beginPath(); c.arc(p0.x, p0.y, 2, 0, TAU); c.fill();
    c.fillRect(dir > 0 ? p2.x - 6 : p2.x, p2.y - 1, 6, 2);
    c.textAlign = dir > 0 ? 'left' : 'right';
    const tx = p1.x + dir * 4;
    c.font = `600 10.5px ${MONO}`;
    c.fillStyle = rgb(COLORS.cyan, 0.85 * alpha);
    c.fillText(vacant ? 'ROLE VACANT' : `GEN ${String(info.generation).padStart(2, '0')}`, tx, p1.y - 6);
    c.font = `600 13px ${MONO}`;
    c.fillStyle = rgb(col, 0.95 * alpha);
    c.fillText(info.ctx == null || vacant ? '--' : `${info.ctx}%`, tx, p1.y + 16);
    c.font = `500 9px ${MONO}`;
    c.fillStyle = rgb(COLORS.dim, alpha);
    c.fillText('CONTEXT', tx + dir * (info.ctx == null || vacant ? 22 : 38), p1.y + 15);
  }

  // Soft light behind the particles so the core reads as a source, not a cloud.
  aura({ L, core: info }) {
    const c = this.c, { x, y, r } = L.core;
    const col = info.needs ? COLORS.red : info.state === 'vacant' ? COLORS.dim : COLORS.accent;
    const g = c.createRadialGradient(x, y, 0, x, y, r * 1.5);
    g.addColorStop(0, rgb(COLORS.cyan, info.state === 'vacant' ? 0.06 : 0.2));
    g.addColorStop(0.45, rgb(col, 0.08));
    g.addColorStop(1, rgb(col, 0));
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, r * 1.5, 0, TAU); c.fill();
  }

  stations({ L, t, info }) {
    const c = this.c;
    for (const [id, s] of L.at) {
      const st = info.get(id);
      if (!st) continue;
      const fade = st.fade ?? 1;
      // A worker's ring is its model's hue (decision 20); red, and the handoff gold, still win.
      const hue = st.kind === 'worker' ? rgb01(hueOf(st.model)) : null;
      const col = st.needs || st.state === 'error' ? COLORS.red
        : st.kind === 'ghost' || st.handoff ? TONE.handoff
        : hue ? hue
        : st.kind === 'board' ? COLORS.violet
        : st.kind === 'you' ? COLORS.white
        : st.state === 'asleep' ? COLORS.dim
        : st.state === 'starting' ? COLORS.accent : COLORS.cyan;
      const R = s.r + 3;
      c.lineWidth = hue ? 1.6 : 1.2;
      c.strokeStyle = rgb(col, (st.state === 'asleep' ? (hue ? 0.45 : 0.3) : hue ? 0.75 : 0.55) * fade);
      c.beginPath(); c.arc(s.x, s.y, R, 0, TAU); c.stroke();
      // Effort: five pips over the station in the model's hue, lit 1 to 5 for low to max; hollow at the default.
      if (hue && s.r >= 8) {
        const n = pipCount(st.effort), pr = R + 5.5, step = 0.3;
        for (let k = 0; k < 5; k++) {
          const ang = -Math.PI / 2 + (k - 2) * step * (13 / Math.max(13, s.r));
          const px = s.x + Math.cos(ang) * pr, py = s.y + Math.sin(ang) * pr;
          c.beginPath(); c.arc(px, py, 1.7, 0, TAU);
          if (!n) { c.lineWidth = 1; c.strokeStyle = rgb(hue, 0.75 * fade); c.stroke(); }
          else if (k < n) { c.save(); c.shadowColor = rgb(hue, 0.9); c.shadowBlur = 6; c.fillStyle = rgb(hue, 0.95 * fade); c.fill(); c.restore(); }
          else { c.fillStyle = rgb(hue, 0.22 * fade); c.fill(); }
        }
      }
      if (st.kind === 'worker' && st.ctx != null) {
        c.lineWidth = 2;
        c.strokeStyle = rgb(col, 0.9 * fade);
        c.beginPath(); c.arc(s.x, s.y, R, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(st.ctx / 100, 0, 1)); c.stroke();
      }
      if (st.needs) {
        const k = 0.5 + 0.5 * Math.sin(t * 4.2);
        c.save();
        c.shadowColor = rgb(COLORS.red, 0.9); c.shadowBlur = 14;
        c.strokeStyle = rgb(COLORS.red, (0.45 + 0.4 * k) * fade);
        c.lineWidth = 1.6;
        c.beginPath(); c.arc(s.x, s.y, R + 4 + k * 4, 0, TAU); c.stroke();
        c.restore();
      }
    }
  }

  pings({ L, info, pings, now }) {
    const c = this.c;
    for (const p of pings) {
      const s = p.id === 'core' ? { ...L.core, r: L.core.r * 1.4 } : L.at.get(p.id);
      if (!s || (p.id !== 'core' && !info.get(p.id))) continue;
      const u = clamp((now - p.t0) / 900, 0, 1);
      c.strokeStyle = rgb(TONE[p.tone] || COLORS.cyan, (1 - u) * 0.8);
      c.lineWidth = 1.5 * (1 - u) + 0.5;
      c.beginPath(); c.arc(s.x, s.y, s.r + 4 + u * 22, 0, TAU); c.stroke();
    }
  }

  // Reduced motion: a still core instead of particles.
  staticCore({ L, core: info }) {
    const c = this.c, { x, y, r } = L.core;
    const col = info.needs ? COLORS.red : info.state === 'vacant' ? COLORS.dim : COLORS.cyan;
    const g = c.createRadialGradient(x, y, 0, x, y, r * 1.1);
    g.addColorStop(0, rgb(COLORS.white, info.state === 'vacant' ? 0.25 : 0.9));
    g.addColorStop(0.18, rgb(col, 0.55));
    g.addColorStop(0.6, rgb(COLORS.accent, 0.14));
    g.addColorStop(1, rgb(COLORS.accent, 0));
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, r * 1.1, 0, TAU); c.fill();
    c.strokeStyle = rgb(col, 0.4);
    c.lineWidth = 1;
    c.beginPath(); c.arc(x, y, r, 0, TAU); c.stroke();
    for (let k = 0; k < 3; k++) {
      c.save(); c.translate(x, y); c.rotate((k * Math.PI) / 3 + 0.3);
      c.strokeStyle = rgb(COLORS.accent, 0.35);
      c.beginPath(); c.ellipse(0, 0, r * 1.05, r * 0.36, 0, 0, TAU); c.stroke();
      c.restore();
    }
  }
}
