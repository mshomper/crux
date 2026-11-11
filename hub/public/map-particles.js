// Live map particles: the orchestrator core, message pulses, station orbiters and background dust.
// Plain simulation; drawing is the renderer's job. Every visible particle is written into one
// Float32Array as x, y, size, r, g, b, a (stride 7), in panel pixels.

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
  entry: COLORS.violet, pick: COLORS.amber, alert: COLORS.red, spawn: COLORS.cyan, core: COLORS.accent, activity: COLORS.dim
};

const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const rand = (() => { let s = 0x2f6b9c1d; return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9 | 0) >>> 0) / 4294967296; })();
const gauss = () => { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

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

// ---------- the core ----------
// A small atom: a hot nucleus, a spherical shell and three tilted orbital rings.
// It re-forms (nebula, helix, sphere) when the orchestrator role passes to a new holder.
const MOODS = {
  vacant: { form: 'nebula', spin: 0.05, turb: 0.55, bright: 0.38, radius: 1.0, breathe: 0.4 },
  asleep: { form: 'sphere', spin: 0.1, turb: 0.06, bright: 0.55, radius: 0.97, breathe: 0.6 },
  idle: { form: 'sphere', spin: 0.2, turb: 0.12, bright: 0.82, radius: 1.0, breathe: 1 },
  starting: { form: 'helix', spin: 0.9, turb: 0.25, bright: 0.95, radius: 1.0, breathe: 0.3 },
  working: { form: 'sphere', spin: 0.36, turb: 0.42, bright: 1.08, radius: 1.05, breathe: 1.4 },
  error: { form: 'sphere', spin: 0.1, turb: 1.4, bright: 0.8, radius: 1.02, breathe: 0.2 }
};

export class ParticleCore {
  constructor(n) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.cur = new Float32Array(n * 3);
    this.seed = new Float32Array(n);
    this.used = new Float32Array(n);
    this.group = new Uint8Array(n);   // 0 nucleus, 1 shell, 2 ring
    this.plane = new Uint8Array(n);
    this.phase = new Float32Array(n);
    this.forms = { sphere: new Float32Array(n * 3), helix: new Float32Array(n * 3), nebula: new Float32Array(n * 3) };
    this.planes = [0, 1, 2].map(k => {
      const tilt = 1.2, yaw = (k * Math.PI * 2) / 3 + 0.4;
      const u = [Math.cos(yaw), 0, Math.sin(yaw)];
      const v = [-Math.sin(yaw) * Math.cos(tilt), Math.sin(tilt), Math.cos(yaw) * Math.cos(tilt)];
      return { u, v, speed: 0.7 + k * 0.25 };
    });
    const nNuc = Math.round(n * 0.16), nShell = Math.round(n * 0.6);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      this.seed[i] = rand();
      this.used[i] = rand();
      const g = i < nNuc ? 0 : i < nNuc + nShell ? 1 : 2;
      this.group[i] = g;
      const S = this.forms.sphere, H = this.forms.helix, N = this.forms.nebula, j = i * 3;
      if (g === 0) {
        const r = Math.abs(gauss()) * 0.16;
        const d = this.dir();
        S[j] = d[0] * r; S[j + 1] = d[1] * r; S[j + 2] = d[2] * r;
      } else if (g === 1) {
        const k = i - nNuc, y = 1 - (k / (nShell - 1)) * 2, rr = Math.sqrt(1 - y * y), th = golden * k;
        const jit = 1 + gauss() * 0.025;
        S[j] = Math.cos(th) * rr * jit; S[j + 1] = y * jit; S[j + 2] = Math.sin(th) * rr * jit;
      } else {
        this.plane[i] = i % 3;
        this.phase[i] = rand() * Math.PI * 2;
      }
      const t = (i / n) * 2 - 1, strand = i % 2, th = t * Math.PI * 3.4 + strand * Math.PI;
      H[j] = Math.cos(th) * 0.58 + gauss() * 0.03; H[j + 1] = t * 1.3; H[j + 2] = Math.sin(th) * 0.58 + gauss() * 0.03;
      const d = this.dir(), r = Math.pow(rand(), 0.6) * 1.75;
      N[j] = d[0] * r; N[j + 1] = d[1] * r * 0.45; N[j + 2] = d[2] * r;
      this.pos[j] = N[j] * 1.6; this.pos[j + 1] = N[j + 1] * 1.6; this.pos[j + 2] = N[j + 2] * 1.6;
      this.cur[j] = N[j]; this.cur[j + 1] = N[j + 1]; this.cur[j + 2] = N[j + 2];
    }
    this.form = 'nebula';
    this.time = 0;
    this.yaw = 0;
    this.pitch = 0.36;
    this.p = { ...MOODS.vacant, red: 0, amber: 0, ctx: 0, flash: 0, throb: 0 };
    this.goal = { ...this.p };
    this.sequence = [];
  }

  dir() {
    const z = rand() * 2 - 1, a = rand() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    return [Math.cos(a) * r, z, Math.sin(a) * r];
  }

  // Map hub state to motion. ctxFrac is the holder's context as a fraction of the handoff threshold.
  setMood({ state, ctx, retireAt, needs }) {
    const m = MOODS[state] || MOODS.idle;
    const frac = ctx == null ? 0 : ctx / retireAt;
    Object.assign(this.goal, m, {
      ctx: ctx == null ? 0 : ctx / 100,
      amber: clamp((frac - 0.8) / 0.2, 0, 1),
      red: state === 'error' ? 1 : frac >= 1 ? 0.6 : 0,
      throb: needs ? 1 : 0
    });
    if (!this.sequence.length) this.form = m.form;
  }

  // The role passes on: the swarm blows out, spins up as a helix and settles around the new holder.
  handoff() {
    const t = this.time;
    for (let i = 0; i < this.n * 3; i += 3) {
      const d = this.dir(), s = 1.5 + rand() * 2.2;
      this.vel[i] += d[0] * s; this.vel[i + 1] += d[1] * s; this.vel[i + 2] += d[2] * s;
    }
    this.p.flash = 1;
    this.sequence = [{ at: t, form: 'nebula' }, { at: t + 1.2, form: 'helix' }, { at: t + 2.5, form: 'sphere' }, { at: t + 3.4, form: null }];
  }

  retire() {
    for (let i = 0; i < this.n * 3; i++) this.vel[i] -= this.pos[i] * 2.5;
    this.p.flash = 0.6;
    this.sequence = [{ at: this.time + 0.5, form: 'nebula' }, { at: this.time + 1.2, form: null }];
  }

  // A pulse leaves the core: kick particles on that side outward, toward the target.
  burst(dx, dy) {
    const len = Math.hypot(dx, dy) || 1;
    const c = Math.cos(-this.yaw), s = Math.sin(-this.yaw);
    const wx = (dx / len) * c, wz = (dx / len) * s, wy = dy / len;
    for (let i = 0; i < this.n; i++) {
      if (this.group[i] !== 1 || rand() > 0.22) continue;
      const j = i * 3;
      const align = this.pos[j] * wx + this.pos[j + 1] * wy + this.pos[j + 2] * wz;
      if (align < 0.2) continue;
      const k = 1.6 + rand() * 1.4;
      this.vel[j] += wx * k; this.vel[j + 1] += wy * k; this.vel[j + 2] += wz * k;
    }
  }

  // Something arrived at the core: a short bright ripple.
  absorb() { this.p.flash = Math.max(this.p.flash, 0.35); for (let i = 0; i < this.n * 3; i++) this.vel[i] += this.pos[i] * 0.6; }

  step(dt) {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    const t = this.time, P = this.p, G = this.goal;
    const k = 1 - Math.exp(-dt * 2.2);
    for (const key of ['spin', 'turb', 'bright', 'radius', 'breathe', 'red', 'amber', 'ctx', 'throb']) P[key] += (G[key] - P[key]) * k;
    P.flash *= Math.exp(-dt * 2.4);
    while (this.sequence.length && t >= this.sequence[0].at) {
      const s = this.sequence.shift();
      this.form = s.form || G.form;
    }
    this.yaw += dt * P.spin;
    const form = this.forms[this.form];
    const kf = 1 - Math.exp(-dt * 2.4), kr = 1 - Math.exp(-dt * 9);
    const breath = 1 + Math.sin(t * 1.7) * 0.035 * P.breathe;
    const R = P.radius * breath, turb = P.turb * 1.7, spring = 7, damp = 3.4;
    const pos = this.pos, vel = this.vel, cur = this.cur;
    for (let i = 0; i < this.n; i++) {
      const j = i * 3;
      let hx, hy, hz, kk = kf;
      if (this.group[i] === 2 && this.form === 'sphere') {
        const pl = this.planes[this.plane[i]];
        this.phase[i] += dt * pl.speed * (1 + P.turb * 0.8);
        const c = Math.cos(this.phase[i]) * 1.4, s = Math.sin(this.phase[i]) * 1.4;
        hx = pl.u[0] * c + pl.v[0] * s; hy = pl.u[1] * c + pl.v[1] * s; hz = pl.u[2] * c + pl.v[2] * s;
        kk = kr;
      } else { hx = form[j]; hy = form[j + 1]; hz = form[j + 2]; }
      cur[j] += (hx - cur[j]) * kk; cur[j + 1] += (hy - cur[j + 1]) * kk; cur[j + 2] += (hz - cur[j + 2]) * kk;
      const x = pos[j], y = pos[j + 1], z = pos[j + 2];
      // A cheap swirling flow field; enough to make the swarm feel alive when an agent works.
      const fx = Math.sin(1.7 * y + t * 0.9) + Math.sin(2.3 * z - t * 0.6);
      const fy = Math.sin(1.9 * z + t * 0.7) + Math.sin(2.1 * x + t * 0.5);
      const fz = Math.sin(1.3 * x - t * 0.8) + Math.sin(2.7 * y + t * 0.4);
      vel[j] += ((cur[j] * R - x) * spring + fx * turb - vel[j] * damp) * dt;
      vel[j + 1] += ((cur[j + 1] * R - y) * spring + fy * turb - vel[j + 1] * damp) * dt;
      vel[j + 2] += ((cur[j + 2] * R - z) * spring + fz * turb - vel[j + 2] * damp) * dt;
      pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt;
    }
  }

  project(cx, cy, r, out, o) {
    const P = this.p;
    const cyw = Math.cos(this.yaw), syw = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const sizeK = clamp(r / 64, 0.48, 1.12);
    const throb = P.throb * (0.5 + 0.5 * Math.sin(this.time * 4.2));
    for (let i = 0; i < this.n; i++) {
      const j = i * 3, x = this.pos[j], y = this.pos[j + 1], z = this.pos[j + 2];
      const x1 = x * cyw + z * syw, z1 = -x * syw + z * cyw;
      const y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
      const persp = 4 / (4 + z2);
      const g = this.group[i], s = this.seed[i];
      let col, size, a;
      if (g === 0) { col = mix3(COLORS.white, COLORS.cyan, s * 0.55); size = 1.8 + s * 1.5; a = 0.8; }
      else if (g === 1) { col = mix3(COLORS.cyan, COLORS.accent, s); size = 1.3 + s * 1.2; a = 0.62; }
      else { col = mix3(COLORS.accent, COLORS.violet, s * 0.7); size = 1.3 + s * 0.9; a = 0.72; }
      if (g !== 0 && this.used[i] < P.ctx) col = mix3(mix3(col, COLORS.warm, 0.3), COLORS.amber, P.amber * 0.85);
      if (P.red > 0.01 || throb > 0.01) col = mix3(col, COLORS.red, Math.max(P.red, throb * 0.75));
      if (P.flash > 0.01) col = mix3(col, COLORS.white, P.flash);
      const depth = clamp(1.15 - z2 * 0.38, 0.3, 1.6);
      const k = o * STRIDE;
      out[k] = cx + x1 * r * persp; out[k + 1] = cy + y1 * r * persp;
      out[k + 2] = size * persp * sizeK;
      out[k + 3] = col[0]; out[k + 4] = col[1]; out[k + 5] = col[2];
      out[k + 6] = a * P.bright * depth * (1 + P.flash * 0.6);
      o++;
    }
    return o;
  }
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
