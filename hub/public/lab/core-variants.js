// Live map core, M013: three candidate looks for showing the orchestrator's state in the particles
// themselves. A lab file: Matt picks one, then the winner moves into map-particles.js.
//   coreLook()     hub state -> the handful of numbers every variant draws from (the tested mapping)
//   ReservoirCore  A: a glass sphere that fills with a swirling liquid
//   StarCore       B: a cloud that gets denser, tighter and hotter
//   ShellsCore     C: a nucleus whose five orbital shells populate from the inside out
// Shared by all three: the red flare at the edge, permission sparks, the Auto / Ask field, the gold pulse.

import { STRIDE, COLORS, TONE } from '../map-particles.js';
import { clamp, lerp } from '../map-layout.js';
import { hueOf, rgb01 } from '../models.js';

const TAU = Math.PI * 2;
const GOLD = TONE.handoff;
const smooth = t => t * t * (3 - 2 * t);
const mulberry = seed => () => { let t = (seed += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const EFFORT_ENERGY = { low: 0.2, medium: 0.4, high: 0.6, xhigh: 0.8, max: 1 };
const STATE = {
  vacant: { swirl: 0, pace: 0.15, bright: 0.35 },
  asleep: { swirl: 0, pace: 0.12, bright: 0.55 },
  idle: { swirl: 0.1, pace: 0.3, bright: 0.85 },
  starting: { swirl: 0.7, pace: 0.8, bright: 0.95 },
  working: { swirl: 1, pace: 1, bright: 1.05 },
  writing: { swirl: 0.5, pace: 0.7, bright: 1.05 },
  error: { swirl: 0, pace: 0.1, bright: 0.7 }
};

// Hub state -> what the core shows. Pure, so it can be tested.
//   fill   0..1  context used, as a share of the handoff threshold (full = handoff due)
//   heat   0..1  the shift toward gold over the last fifth before the threshold
//   due    0|1   at or past the threshold: the gold pulse
//   gold   0|1   writing its handoff: the whole core is gold
//   swirl  0..1  idle drift .. working swirl
//   speed        swirl pace scaled by effort; energy 0..1 is effort alone
//   flare  0|1   something in the orchestrator's thread waits on Matt (red, decision 31)
//   ask    0|1   the project's permission mode: Ask (1) or Auto (0)
export function coreLook({ state = 'idle', ctx = null, retireAt = 60, model = null, effort = null, needs = false, mode = 'auto' } = {}) {
  const s = STATE[state] || STATE.idle;
  const frac = ctx == null || state === 'vacant' ? 0 : ctx / retireAt;
  const energy = EFFORT_ENERGY[effort] ?? 0.5;
  return {
    hue: rgb01(hueOf(model)) || COLORS.cyan,
    fill: clamp(frac, 0, 1),
    heat: smooth(clamp((frac - 0.8) / 0.2, 0, 1)),
    due: frac >= 1 ? 1 : 0,
    gold: state === 'writing' ? 1 : 0,
    swirl: s.swirl,
    speed: s.pace * (0.55 + 0.9 * energy),
    energy,
    bright: s.bright,
    flare: needs ? 1 : 0,
    ask: mode === 'ask' ? 1 : 0
  };
}

const KEYS = ['fill', 'heat', 'due', 'gold', 'swirl', 'speed', 'energy', 'bright', 'flare', 'ask', 'hr', 'hg', 'hb'];

class CoreBase {
  constructor(n, { seed = 11, light = false } = {}) {
    this.n = n;
    this.rand = mulberry(seed);
    this.t = 0; this.dt = 0; this.yaw = 0; this.rot = 0; this.pitch = 0.36; this.flash = 0;
    this.P = { fill: 0, heat: 0, due: 0, gold: 0, swirl: 0, speed: 0.2, energy: 0.5, bright: 0.6, flare: 0, ask: 0, hr: 0.44, hg: 0.89, hb: 1 };
    this.G = { ...this.P };
    this.sparks = [];
    // the field around the core (Auto: free motes; Ask: the same motes held on two hoops)
    const m = this.nMotes = light ? 26 : 46;
    this.mote = new Float32Array(m * 5);   // radius, inclination, node, phase, pace
    for (let i = 0; i < m; i++) { const k = i * 5; this.mote[k] = 1.14 + this.rand() * 0.2; this.mote[k + 1] = (this.rand() - 0.5) * 2.6; this.mote[k + 2] = this.rand() * TAU; this.mote[k + 3] = this.rand() * TAU; this.mote[k + 4] = 0.18 + this.rand() * 0.3; }
    // the red flare: a rim and three prominences, in view space so it always sits on the visible edge
    const f = this.nFlare = light ? 40 : 78;
    this.flareSeed = new Float32Array(f);
    for (let i = 0; i < f; i++) this.flareSeed[i] = this.rand();
    this.init();
  }

  get extra() { return this.nMotes + this.nFlare + 3 * 40; }
  gauss() { let u = 0, v = 0; while (!u) u = this.rand(); while (!v) v = this.rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v); }
  dir() { const z = this.rand() * 2 - 1, a = this.rand() * TAU, r = Math.sqrt(1 - z * z); return [Math.cos(a) * r, z, Math.sin(a) * r]; }

  set(look, snap = false) {
    const G = this.G;
    for (const k of KEYS) if (look[k] != null) G[k] = look[k];
    [G.hr, G.hg, G.hb] = look.hue;
    if (snap) Object.assign(this.P, G);
  }

  // A permission answer: a short spark off the rim at `angle` (toward whoever asked). kind: allowed | escalated.
  spark(kind = 'allowed', angle = -0.6) {
    const parts = [];
    for (let i = 0; i < 22; i++) parts.push((this.rand() - 0.5) * 0.9, 0.5 + this.rand() * 1.6, 0.35 + this.rand() * 0.4);
    this.sparks.push({ t0: this.t, angle, col: kind === 'allowed' ? COLORS.good : COLORS.red, parts });
    this.sparks = this.sparks.slice(-3);
    this.flash = Math.max(this.flash, 0.22);
  }

  step(dt) {
    dt = Math.min(dt, 0.05);
    this.t += dt; this.dt += dt;
    const P = this.P, G = this.G, k = 1 - Math.exp(-dt * 2.4);
    for (const key of KEYS) P[key] += (G[key] - P[key]) * k;
    this.flash *= Math.exp(-dt * 3);
    this.yaw += dt * (0.08 + 0.2 * P.speed);
    this.rot += dt * P.speed;
    this.sparks = this.sparks.filter(s => this.t - s.t0 < 0.8);
    this.advance?.(dt);
  }

  // The gold pulse when a handoff is due: a shell of light leaving the centre every two seconds.
  pulse(rr) {
    if (this.P.due < 0.02) return 0;
    const ph = (this.t % 2) / 2, d = (rr - ph * 1.45) / 0.17;
    return this.P.due * Math.exp(-d * d) * (1 - ph * 0.75);
  }

  begin(cx, cy, r, out, o) {
    this.cx = cx; this.cy = cy; this.r = r; this.out = out; this.o = o;
    this.cyw = Math.cos(this.yaw); this.syw = Math.sin(this.yaw); this.cp = Math.cos(this.pitch); this.sp = Math.sin(this.pitch);
    this.sizeK = clamp(r / 64, 0.48, 1.12);
  }

  // One particle in core space (unit radius), turned and projected into panel pixels.
  put(x, y, z, size, cr, cg, cb, a) {
    const x1 = x * this.cyw + z * this.syw, z1 = -x * this.syw + z * this.cyw;
    const y1 = y * this.cp - z1 * this.sp, z2 = y * this.sp + z1 * this.cp;
    const persp = 4 / (4 + z2), f = this.flash, out = this.out, k = this.o * STRIDE;
    out[k] = this.cx + x1 * this.r * persp; out[k + 1] = this.cy + y1 * this.r * persp;
    out[k + 2] = size * persp * this.sizeK;
    out[k + 3] = cr + (1 - cr) * f; out[k + 4] = cg + (1 - cg) * f; out[k + 5] = cb + (1 - cb) * f;
    out[k + 6] = a * this.P.bright * clamp(1.15 - z2 * 0.38, 0.3, 1.6) * (1 + f * 0.6);
    this.o++;
  }

  // One particle in view space: x, y in core radii from the centre, no rotation.
  flat(x, y, size, cr, cg, cb, a) {
    const out = this.out, k = this.o * STRIDE;
    out[k] = this.cx + x * this.r; out[k + 1] = this.cy + y * this.r; out[k + 2] = size * this.sizeK;
    out[k + 3] = cr; out[k + 4] = cg; out[k + 5] = cb; out[k + 6] = a;
    this.o++;
  }

  project(cx, cy, r, out, o) {
    this.begin(cx, cy, r, out, o);
    this.body();
    this.dt = 0;
    this.field();
    this.flare();
    this.sparkle();
    return this.o;
  }

  field() {
    const P = this.P, m = this.nMotes, half = Math.ceil(m / 2), t = this.t, ask = smooth(clamp(P.ask, 0, 1));
    const cr = lerp(P.hr, 1, 0.3), cg = lerp(P.hg, 1, 0.3), cb = lerp(P.hb, 1, 0.3);
    for (let i = 0; i < m; i++) {
      const k = i * 5, M = this.mote;
      // Auto: its own loose orbit. Ask: an evenly spaced place on one of two crossed hoops.
      const hoop = i < half ? 0 : 1, slot = (hoop ? i - half : i) / (hoop ? m - half : half);
      const rad = lerp(M[k], 1.24, ask), inc = lerp(M[k + 1], hoop ? -0.95 : 0.95, ask), node = lerp(M[k + 2], 0.5, ask);
      const ph = lerp(M[k + 3] + t * M[k + 4] * (0.5 + P.speed), slot * TAU + t * 0.12 * (hoop ? -1 : 1), ask);
      const px = Math.cos(ph) * rad, pz = Math.sin(ph) * rad;
      const y = -pz * Math.sin(inc), z0 = pz * Math.cos(inc);
      const x = px * Math.cos(node) + z0 * Math.sin(node), z = -px * Math.sin(node) + z0 * Math.cos(node);
      this.put(x, y, z, 1.5 + ask * 0.45, cr, cg, cb, 0.55 + ask * 0.35);
    }
  }

  flare() {
    const fl = this.P.flare;
    if (fl < 0.02) return;
    const t = this.t, n = this.nFlare, rim = Math.round(n * 0.58), R = COLORS.red;
    for (let i = 0; i < rim; i++) {
      const a = (i / rim) * TAU + t * 0.12, s = this.flareSeed[i];
      const wave = 0.5 + 0.5 * Math.sin(t * 4.2 - a * 2), lick = Math.max(0, Math.sin(a * 3 + t * 2.3));
      const rad = 1.07 + 0.07 * lick * lick + (s - 0.5) * 0.03;
      this.flat(Math.cos(a) * rad, Math.sin(a) * rad, 1.5 + wave * 1.1, R[0], R[1], R[2], fl * (0.3 + 0.55 * wave));
    }
    const per = Math.floor((n - rim) / 3);
    for (let k = 0; k < 3; k++) {
      const a0 = -0.9 + k * 2.2 + t * 0.07, high = 0.24 * (0.7 + 0.3 * Math.sin(t * 1.7 + k * 2));
      for (let i = 0; i < per; i++) {
        const s = (this.flareSeed[rim + k * per + i] + t * 0.3) % 1, arch = Math.sin(Math.PI * s);
        const a = a0 + (s - 0.5) * 0.56, rad = 1.07 + high * arch;
        const w = 0.25 * arch;
        this.flat(Math.cos(a) * rad, Math.sin(a) * rad, 1.4 + arch * 1.6, lerp(R[0], 1, w), lerp(R[1], 1, w), lerp(R[2], 1, w), fl * 0.95 * arch);
      }
    }
  }

  sparkle() {
    for (const s of this.sparks) {
      const age = this.t - s.t0, u = age / 0.8, c = s.col, ca = Math.cos(s.angle), sa = Math.sin(s.angle);
      // the strike point, a flash running along the rim, and the fan of sparks
      this.flat(ca * 1.06, sa * 1.06, 9 * (1 - u), lerp(c[0], 1, 0.6), lerp(c[1], 1, 0.6), lerp(c[2], 1, 0.6), (1 - u) * (1 - u));
      for (let i = -7; i <= 7; i++) {
        const a = s.angle + i * 0.075 * (1 + u * 2.5), f = (1 - Math.abs(i) / 8) * (1 - u);
        this.flat(Math.cos(a) * 1.06, Math.sin(a) * 1.06, 2.2, c[0], c[1], c[2], f * f * 1.2);
      }
      for (let i = 0; i < s.parts.length; i += 3) {
        const life = s.parts[i + 2];
        if (age > life) continue;
        const q = age / life, a = s.angle + s.parts[i] * (1 + q * 0.5), rad = 1.06 + s.parts[i + 1] * age * (1 - 0.45 * q);
        this.flat(Math.cos(a) * rad, Math.sin(a) * rad, 2.4 * (1 - q * 0.6), lerp(c[0], 1, 0.35), lerp(c[1], 1, 0.35), lerp(c[2], 1, 0.35), 1 - q);
      }
    }
  }
}

// ---------- A: reservoir ----------
// The core is a vessel. Context used is a liquid that fills it from the bottom (a full sphere means the
// handoff is due); the part not yet filled is a faint hollow dome. Working stirs it into a whirlpool.
export class ReservoirCore extends CoreBase {
  init() {
    const n = this.n, nv = this.nv = Math.round(n * 0.86);
    this.rho = new Float32Array(nv); this.th = new Float32Array(nv); this.h = new Float32Array(nv);
    this.dome = new Float32Array(nv); this.w = new Float32Array(nv); this.sd = new Float32Array(nv);
    for (let i = 0; i < nv; i++) {
      const d = this.dir(), rr = Math.cbrt(this.rand()) * 0.95;
      this.rho[i] = Math.hypot(d[0], d[2]) * rr; this.th[i] = Math.atan2(d[2], d[0]); this.h[i] = -d[1] * rr;
      this.dome[i] = 0.99 / Math.max(rr, 0.05); this.sd[i] = this.rand();
    }
    const ng = this.ng = n - nv, golden = Math.PI * (3 - Math.sqrt(5));
    this.glass = new Float32Array(ng * 3);
    for (let i = 0; i < ng; i++) { const y = 1 - (i / (ng - 1)) * 2, r = Math.sqrt(1 - y * y), a = golden * i; this.glass[i * 3] = Math.cos(a) * r; this.glass[i * 3 + 1] = y; this.glass[i * 3 + 2] = Math.sin(a) * r; }
  }

  // Height of the surface (-0.95 .. 0.95) for a share of the sphere's volume.
  level(fill) {
    let a = 0, b = 2;
    for (let i = 0; i < 18; i++) { const s = (a + b) / 2; ((3 * s * s - s * s * s) / 4 < fill) ? a = s : b = s; }
    return ((a + b) / 2 - 1) * 0.95;
  }

  body() {
    const P = this.P, t = this.t, k = 1 - Math.exp(-this.dt * 4.5);
    const lvl = this.level(clamp(P.fill, 0.001, 0.999)), R = 1 - 0.07 * P.heat;
    const amp = (0.018 + 0.05 * P.energy * (0.35 + P.swirl)) * (1 - 0.6 * P.heat), dip = 0.2 * P.swirl, wt = t * (0.8 + 1.6 * P.speed);
    const gold = Math.max(P.gold, 0);
    for (let i = 0; i < this.nv; i++) {
      const rho = this.rho[i], h = this.h[i], s = this.sd[i];
      const th = this.th[i] + this.rot * (0.5 + 0.9 * (1 - rho));
      const surf = lvl - dip * (1 - (rho / 0.95) * (rho / 0.95)) + amp * (Math.sin(3 * th + wt * 2.1) + Math.sin(2 * th - wt * 1.3)) * 0.5;
      const d = surf - h;
      const w = this.w[i] += ((d > 0 ? 1 : 0) - this.w[i]) * k;
      const lx = Math.cos(th) * rho, lz = Math.sin(th) * rho;
      const dk = this.dome[i], dx = Math.cos(this.th[i]) * rho * dk, dz = Math.sin(this.th[i]) * rho * dk, dh = h * dk;
      const x = lerp(dx, lx, w) * R, z = lerp(dz, lz, w) * R, y = -lerp(dh, h, w) * R;
      const rr = Math.hypot(x, y, z), pu = this.pulse(rr);
      const skin = d > 0 ? Math.exp(-d / 0.07) : 0, deep = clamp(d / 1.3, 0, 1);
      let cr = P.hr * (1 - 0.3 * deep), cg = P.hg * (1 - 0.3 * deep), cb = P.hb * (1 - 0.3 * deep);
      const g = Math.max(gold, clamp(P.heat * 1.25 - Math.max(d, 0) * 0.8, 0, 1) * 0.9, pu) * w;
      cr = lerp(cr, GOLD[0], g); cg = lerp(cg, GOLD[1], g); cb = lerp(cb, GOLD[2], g);
      const wh = 0.55 * skin * w;
      cr = lerp(cr, 1, wh); cg = lerp(cg, 1, wh); cb = lerp(cb, 1, wh);
      this.put(x, y, z, lerp(1.1, 1.25 + s * 1.0 + skin * 1.1, w), cr, cg, cb, lerp(0.17, 0.42 + 0.5 * skin, w) * (1 + pu * 0.9));
    }
    const cr = lerp(P.hr, 1, 0.3), cg = lerp(P.hg, 1, 0.3), cb = lerp(P.hb, 1, 0.3);
    for (let i = 0; i < this.ng; i++) {
      const j = i * 3, pu = this.pulse(1) * 0.8, g = Math.max(gold, pu, P.heat * 0.4);
      this.put(this.glass[j] * R, this.glass[j + 1] * R, this.glass[j + 2] * R, 1.15, lerp(cr, GOLD[0], g), lerp(cg, GOLD[1], g), lerp(cb, GOLD[2], g), 0.15 + pu * 0.5);
    }
  }
}

// ---------- B: density and heat ----------
// The core is a small star. Context used lights more of its particles and pulls them in, so it goes
// from a thin wide mist to a dense bright ball that heats to gold from the centre outward.
// Working flattens it into a swirling disc with two arms.
export class StarCore extends CoreBase {
  init() {
    const n = this.n;
    this.r0 = new Float32Array(n); this.th = new Float32Array(n); this.ry = new Float32Array(n); this.rh = new Float32Array(n);
    this.u = new Float32Array(n); this.w = new Float32Array(n); this.sd = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const d = this.dir();
      this.r0[i] = Math.min(1.05, Math.abs(this.gauss()) * 0.5 + 0.04);
      this.th[i] = Math.atan2(d[2], d[0]); this.rh[i] = Math.hypot(d[0], d[2]); this.ry[i] = d[1];
      this.u[i] = this.rand(); this.sd[i] = this.rand();
    }
  }

  body() {
    const P = this.P, t = this.t, k = 1 - Math.exp(-this.dt * 3.5);
    const lit = 0.14 + 0.86 * P.fill, R = lerp(1.3, 0.92, P.fill) * (1 - 0.14 * P.heat);
    const flat = lerp(1, 0.56, P.swirl), wob = 0.04 + 0.1 * P.energy, pace = 0.5 + 1.5 * P.speed;
    for (let i = 0; i < this.n; i++) {
      const r0 = this.r0[i], s = this.sd[i];
      const w = this.w[i] += ((this.u[i] < lit ? 1 : 0) - this.w[i]) * k;
      if (w < 0.01) { this.put(0, 0, 0, 0, 0, 0, 0, 0); continue; }
      let th = this.th[i] + this.rot * 0.55 / (0.3 + r0);
      th -= P.swirl * 0.34 * Math.sin(2 * (th - 4.2 * r0 - this.rot * 0.35));   // bunch into two spiral arms
      const rr = r0 * R * (1 + wob * Math.sin(t * (0.7 + s * 1.6) * pace + s * 40));
      const x = Math.cos(th) * this.rh[i] * rr, z = Math.sin(th) * this.rh[i] * rr, y = this.ry[i] * rr * flat;
      const pu = this.pulse(rr);
      const hot = clamp(1 - r0 / 0.5, 0, 1) * (0.15 + 0.55 * P.fill);
      let cr = lerp(P.hr, 1, hot), cg = lerp(P.hg, 1, hot), cb = lerp(P.hb, 1, hot);
      const g = Math.max(P.gold, P.heat * clamp(1.15 - r0 * 0.55, 0, 1) * 0.88, pu);
      cr = lerp(cr, GOLD[0], g); cg = lerp(cg, GOLD[1], g); cb = lerp(cb, GOLD[2], g);
      this.put(x, y, z, 1.2 + s * 1.2 + hot * 0.5, cr, cg, cb, w * lerp(0.5, 0.72, P.fill) * (1 - 0.35 * hot) * (1 + pu));
    }
  }
}

// ---------- C: orbital shells ----------
// The core is an atom. Five orbits fill with particles from the inside out as context is used; empty
// orbits stay as faint tracks. Idle, the orbits lie nearly flat; working, they tumble like a gyroscope.
const SHELL_R = [0.34, 0.5, 0.66, 0.82, 0.98];
const SHELL_TILT = [0.55, -0.95, 1.2, -0.4, 0.8];
export class ShellsCore extends CoreBase {
  init() {
    const n = this.n, nn = this.nn = Math.round(n * 0.14), ns = n - nn;
    this.nuc = new Float32Array(nn * 3);
    for (let i = 0; i < nn; i++) { const d = this.dir(), r = Math.abs(this.gauss()) * 0.085; this.nuc[i * 3] = d[0] * r; this.nuc[i * 3 + 1] = d[1] * r; this.nuc[i * 3 + 2] = d[2] * r; }
    this.shell = new Uint8Array(ns); this.ph = new Float32Array(ns); this.u = new Float32Array(ns);
    this.jr = new Float32Array(ns); this.jn = new Float32Array(ns); this.w = new Float32Array(ns); this.sd = new Float32Array(ns);
    const total = SHELL_R.reduce((a, b) => a + b, 0);
    let i = 0;
    SHELL_R.forEach((r, k) => {
      const c = k === 4 ? ns - i : Math.round(ns * r / total);
      for (let j = 0; j < c; j++, i++) { this.shell[i] = k; this.ph[i] = (j / c) * TAU; this.u[i] = this.rand(); this.jr[i] = this.gauss() * 0.012; this.jn[i] = this.gauss() * 0.014; this.sd[i] = this.rand(); }
    });
    this.node = SHELL_R.map((_, k) => k * 1.3);
    this.orb = SHELL_R.map(() => 0);
  }

  advance(dt) {
    const P = this.P;
    for (let k = 0; k < 5; k++) {
      this.node[k] += dt * P.speed * (0.22 + 0.09 * k) * (0.25 + P.swirl) * (k % 2 ? -1 : 1);
      this.orb[k] += dt * (0.25 + P.speed) * (1.1 / (0.4 + SHELL_R[k]));
    }
  }

  body() {
    const P = this.P, t = this.t, k = 1 - Math.exp(-this.dt * 3.5);
    const tight = 1 - 0.14 * P.heat, spread = lerp(0.3, 1, P.swirl);
    const jit = 1 + 0.5 * P.energy * (0.3 + P.swirl);
    const nb = 0.65 + 0.35 * P.energy, ng = Math.max(P.gold, P.heat * 0.6, this.pulse(0.05));
    const ncr = lerp(lerp(P.hr, 1, 0.6), GOLD[0], ng), ncg = lerp(lerp(P.hg, 1, 0.6), GOLD[1], ng), ncb = lerp(lerp(P.hb, 1, 0.6), GOLD[2], ng);
    for (let i = 0; i < this.nn; i++) {
      const j = i * 3, b = jit * (1 + 0.25 * Math.sin(t * 5 * (0.4 + P.speed) + i));
      this.put(this.nuc[j] * b, this.nuc[j + 1] * b, this.nuc[j + 2] * b, 1.7 + (i % 5) * 0.32, ncr, ncg, ncb, 0.8 * nb);
    }
    const ci = [], si = [], cn = [], sn = [], fk = [], gk = [];
    for (let s = 0; s < 5; s++) {
      const inc = SHELL_TILT[s] * spread;
      ci[s] = Math.cos(inc); si[s] = Math.sin(inc); cn[s] = Math.cos(this.node[s]); sn[s] = Math.sin(this.node[s]);
      fk[s] = clamp(P.fill * 5 - s, 0, 1);
      gk[s] = Math.max(P.gold, clamp(P.heat * 1.3 - (4 - s) * 0.1, 0, 1) * 0.9, this.pulse(SHELL_R[s] * tight));
    }
    for (let i = 0; i < this.shell.length; i++) {
      const s = this.shell[i], sd = this.sd[i];
      const w = this.w[i] += ((this.u[i] < fk[s] ? 1 : 0) - this.w[i]) * k;
      const rad = (SHELL_R[s] + this.jr[i] * jit) * tight, a = this.ph[i] + this.orb[s];
      const px = Math.cos(a) * rad, pz = Math.sin(a) * rad, py = this.jn[i] * jit;
      const y = py * ci[s] - pz * si[s], z0 = py * si[s] + pz * ci[s];
      const x = px * cn[s] + z0 * sn[s], z = -px * sn[s] + z0 * cn[s];
      const g = gk[s] * w, wh = 0.25 * sd * w, pu = this.pulse(rad);
      const cr = lerp(lerp(P.hr, 1, wh), GOLD[0], g), cg = lerp(lerp(P.hg, 1, wh), GOLD[1], g), cb = lerp(lerp(P.hb, 1, wh), GOLD[2], g);
      this.put(x, y, z, lerp(1.0, 1.5 + sd * 1.1, w), cr, cg, cb, lerp(0.2, 0.78, w) * (1 + pu));
    }
  }
}

export const VARIANTS = {
  A: { name: 'Reservoir', line: 'A glass sphere that fills with liquid light. Full means hand off.', make: (n, o) => new ReservoirCore(n, o) },
  B: { name: 'Density and heat', line: 'A star that gets denser, tighter and hotter as context is used.', make: (n, o) => new StarCore(n, o) },
  C: { name: 'Orbital shells', line: 'An atom whose five orbits fill from the inside out.', make: (n, o) => new ShellsCore(n, o) }
};

// Workers in flight: a stream of the core's particles running out along the spoke to a busy station.
// from, via, to are panel points (the same curve the map's edges use); returns the next free slot.
export function stream(out, o, from, via, to, t, hue, { u0 = 0.2, u1 = 0.92, n = 9, pace = 0.45, seed = 0 } = {}) {
  for (let i = 0; i < n; i++) {
    const s = (i / n + t * pace + seed) % 1, u = lerp(u0, u1, s), v = 1 - u;
    const x = v * v * from.x + 2 * v * u * via.x + u * u * to.x, y = v * v * from.y + 2 * v * u * via.y + u * u * to.y;
    const k = o * STRIDE, a = Math.sin(Math.PI * s);
    out[k] = x + Math.sin(i * 7.3 + t * 3) * 1.6; out[k + 1] = y + Math.cos(i * 5.1 + t * 2.6) * 1.6; out[k + 2] = 1.3 + a * 1.1;
    out[k + 3] = lerp(hue[0], 1, 0.25); out[k + 4] = lerp(hue[1], 1, 0.25); out[k + 5] = lerp(hue[2], 1, 0.25); out[k + 6] = 0.85 * a;
    o++;
  }
  return o;
}
