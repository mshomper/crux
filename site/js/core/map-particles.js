// Live map particles: message pulses, station orbiters and background dust. (The orchestrator core
// is in map-core.js.) Plain simulation; drawing is the renderer's job. Every visible particle is
// written into one Float32Array as x, y, size, r, g, b, a (stride 7), in panel pixels.

import { clamp, lerp } from './map-layout.js';

export const STRIDE = 7;

export const COLORS = {
  cyan: [0.44, 0.89, 1.0],
  accent: [0.56, 0.66, 1.0],
  white: [1.0, 0.97, 0.93],
  warm: [1.0, 0.88, 0.7],
  amber: [0.95, 0.73, 0.33],
  red: [0.98, 0.42, 0.46],
  good: [0.37, 0.86, 0.68],
  violet: [0.74, 0.6, 1.0],
  dim: [0.42, 0.48, 0.58]
};

export const TONE = {
  you: COLORS.white, reply: COLORS.cyan, brief: COLORS.accent, summary: COLORS.good,
  entry: COLORS.violet, pick: COLORS.amber, alert: COLORS.red, spawn: COLORS.cyan, core: COLORS.accent, activity: COLORS.dim,
  handoff: [1.0, 0.82, 0.48]
};

const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const rand = (() => { let s = 0x2f6b9c1d; return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9 | 0) >>> 0) / 4294967296; })();

// Where a curved edge between two points bends to. Order-independent, so a pulse
// from A to B and the drawn edge from B to A follow the same curve.
export function bend(a, b, amount, max) {
  const [p, q] = (a.x < b.x || (a.x === b.x && a.y < b.y)) ? [a, b] : [b, a];
  const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1;
  const off = Math.min(len * amount, max);
  return { x: (p.x + q.x) / 2 - (dy / len) * off, y: (p.y + q.y) / 2 + (dx / len) * off };
}
export function onCurve(a, c, b, u) {
  const v = 1 - u;
  return { x: v * v * a.x + 2 * v * u * c.x + u * u * b.x, y: v * v * a.y + 2 * v * u * c.y + u * u * b.y };
}

// ---------- pulses, orbiters, dust ----------
export class Effects {
  constructor() {
    this.pulses = [];
    this.pings = [];
    this.spin = new Map();     // station -> { phase, boostUntil }
    this.dust = Array.from({ length: 46 }, () => ({ x: rand(), y: rand(), z: 0.3 + rand() * 0.7, vx: (rand() - 0.5) * 0.004, vy: (rand() - 0.5) * 0.003, tw: rand() * 6.28 }));
  }

  addPulse(p, now) { this.pulses.push({ ...p, born: now, t0: now + (p.delay || 0), dur: 950 + Math.random() * 250, launched: false }); }
  boost(id, now) { const s = this.spin.get(id) || { phase: Math.random() * 6.28, boostUntil: 0 }; s.boostUntil = now + 2600; this.spin.set(id, s); }

  // Advance; calls onLaunch(pulse) when a pulse leaves and onArrive(pulse) when it lands.
  step(dt, now, onLaunch, onArrive) {
    this.dt = dt;
    for (const p of this.pulses) {
      if (!p.launched && now >= p.t0) { p.launched = true; onLaunch?.(p); }
      if (p.launched && now >= p.t0 + p.dur && !p.done) {
        p.done = true;
        this.pings.push({ id: p.to, tone: p.tone, t0: now });
        onArrive?.(p);
      }
    }
    this.pulses = this.pulses.filter(p => !p.done).slice(-40);
    this.pings = this.pings.filter(p => now - p.t0 < 900);
    for (const d of this.dust) {
      d.x = (d.x + d.vx * dt + 1) % 1; d.y = (d.y + d.vy * dt + 1) % 1; d.tw += dt * (0.6 + d.z);
    }
  }

  // Write comets, orbit dots and dust. `L` is the panel-local layout, `info` station id -> { state }.
  project(out, o, L, info, now, w, h, max) {
    const pt = (x, y, size, c, a) => {
      if (o >= max) return;
      const k = o * STRIDE;
      out[k] = x; out[k + 1] = y; out[k + 2] = size; out[k + 3] = c[0]; out[k + 4] = c[1]; out[k + 5] = c[2]; out[k + 6] = a;
      o++;
    };
    for (const d of this.dust) pt(d.x * w, d.y * h, 1.2 + d.z * 1.4, COLORS.cyan, 0.08 + 0.1 * d.z * (0.6 + 0.4 * Math.sin(d.tw)));

    const at = id => id === 'core' ? L.core : L.at.get(id);
    for (const p of this.pulses) {
      if (!p.launched) continue;
      const a = at(p.from), b = at(p.to);
      if (!a || !b) {
        // A station that has only just been created may not be on the map yet: hold the pulse briefly.
        if (now - p.born < 1600) p.t0 = now; else p.done = true;
        continue;
      }
      const c = bend(a, b, 0.17, L.bendMax);
      const u = clamp((now - p.t0) / p.dur, 0, 1);
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      const col = TONE[p.tone] || COLORS.cyan;
      for (let i = 9; i >= 0; i--) {
        const uu = e - i * 0.022;
        if (uu < 0) continue;
        const q = onCurve(a, c, b, uu);
        const f = 1 - i / 10;
        pt(q.x, q.y, (i ? 2.6 : 7.5) * (0.5 + f * 0.6), i ? col : mix3(col, COLORS.white, 0.5), (i ? 0.55 : 1) * f);
      }
    }

    for (const [id, s] of L.at) {
      const st = info.get(id);
      if (!st || st.kind !== 'worker') continue;
      const sp = this.spin.get(id) || { phase: Math.random() * 6.28, boostUntil: 0 };
      this.spin.set(id, sp);
      const boosted = now < sp.boostUntil;
      const speed = st.state === 'error' ? 0 : boosted ? 5.5 : st.state === 'working' || st.state === 'starting' ? 2.4 : st.state === 'idle' ? 0.5 : 0.12;
      sp.phase += speed * (this.dt || 1 / 60);
      const col = st.needs ? COLORS.red : st.state === 'error' ? COLORS.red : st.state === 'asleep' ? COLORS.dim : COLORS.cyan;
      const rr = s.r + 5 + s.r * 0.15;
      const alpha = st.state === 'asleep' ? 0.35 : 0.9;
      for (let k = 0; k < 3; k++) {
        const ang = sp.phase + (k * Math.PI * 2) / 3;
        const z = Math.sin(ang);
        pt(s.x + Math.cos(ang) * rr, s.y + z * rr * 0.42, (1.8 + (z + 1) * 0.6) * clamp(s.r / 16, 0.6, 1.3), col, alpha * (0.55 + 0.45 * (z + 1) / 2));
      }
    }
    return o;
  }
}
