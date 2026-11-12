// The live map's line work, drawn on a 2D canvas under the particles:
// edges that thicken with traffic, the core's rotating scales (no context meter: M013),
// station rings, red halos where something needs you, and pings where pulses land.

import { clamp, lerp } from './map-layout.js';
import { bend, onCurve, COLORS, TONE } from './map-particles.js';
import { hueOf, rgb01, pipCount } from './models.js';
import { paintGlass } from './map-core.js';

const rgb = (c, a) => `rgba(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0},${a})`;
const TAU = Math.PI * 2;

// How strongly the core's outer scale is drawn: fully everywhere, except in a phone's strip (compact), where it
// is left out and fades in over the first half of the zoom, so nothing jumps when the map opens.
export const outerScale = (compact, e) => (compact ? clamp(e * 2, 0, 1) : 1);

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
    this.aura(f);
    this.glass(f);
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

    // (No context ring, track or handoff tick any more: Matt, 2026-11-11. M013 shows context in the particles.)

    // outer scale: three arcs turning one way, a dotted ring turning the other
    // A phone's strip is too low for it (it would be cut off at the edges): there it fades in as the map opens.
    const R3 = r * 1.6;
    const outer = outerScale(L.compact, e);
    if (outer > 0.01) {
      c.lineWidth = 1;
      c.strokeStyle = rgb(COLORS.cyan, 0.38 * outer);
      for (let k = 0; k < 3; k++) {
        const a0 = -t * 0.16 + (k * TAU) / 3;
        c.beginPath(); c.arc(x, y, R3, a0, a0 + 1.25 * b); c.stroke();
      }
      c.setLineDash([1, 5]);
      c.lineDashOffset = t * 6;
      c.strokeStyle = rgb(COLORS.accent, 0.3 * outer);
      c.beginPath(); c.arc(x, y, R3 + 6, 0, TAU * b); c.stroke();
      c.setLineDash([]);
    }

    if (e > 0.02) {
      // outermost scale, full map only (the radar sweep is gone: Matt, 2026-11-11)
      const R4 = r * 1.9;
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

    // (No callout beside the core: nothing is written on it. The numbers are in its hover or tap readout, M013.)
  }

  // Soft light behind the particles so the core reads as a source, not a cloud.
  aura({ L, core: info, glass }) {
    const c = this.c, { x, y, r } = L.core;
    // the light is the model's hue (decision 20), gold while the handoff is written
    const col = info.state === 'vacant' ? COLORS.dim : glass ? [0, 1, 2].map(i => lerp(glass.hue[i], TONE.handoff[i], glass.gold)) : COLORS.accent;
    const g = c.createRadialGradient(x, y, 0, x, y, r * 1.5);
    g.addColorStop(0, rgb(col, info.state === 'vacant' ? 0.05 : 0.15));
    g.addColorStop(0.5, rgb(col, 0.06));
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
      // A worker's ring is its model's hue (decision 20), also while it waits on you: only You turns red
      // (decision 31; a worker shows a red count badge instead). Errors are amber, a handoff gold.
      const hue = st.kind === 'worker' ? rgb01(hueOf(st.model)) : null;
      const youRed = st.needs && st.kind !== 'worker';
      const col = youRed ? COLORS.red
        : st.state === 'error' ? COLORS.amber
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
      if (youRed) {
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

  // The core's glass sphere and the liquid in it (map-core.js). With reduced motion this is the whole core:
  // a still sphere at the right level, with a red rim when something waits on Matt.
  glass({ L, glass, staticCore }) {
    if (glass) paintGlass(this.c, L.core.x, L.core.y, L.core.r, glass, { still: !!staticCore });
  }
}
