// Live map core (M013): the orchestrator role as a glass sphere holding liquid light.
// Nothing is written on it; the orchestrator's state is in the sphere itself:
//   context used   the liquid level (a full sphere = the handoff is due); gold and tighter over the last fifth
//   model          the liquid's hue (decision 20)
//   effort, state  how hard the liquid is stirred: idle drift, a whirlpool with bubbles when working
//   waiting on you a red flare on the rim (decision 31)
//   permissions    a spark off the glass for every answer; Auto or Ask as loose motes or motes held on two hoops
//   handoff        a gold pulse that throws the liquid about, then the whole core in gold
// coreLook() is the pure mapping from hub state to those numbers. ReservoirCore simulates the particles
// (written as x, y, size, r, g, b, a like every other map particle); paintGlass() draws the glass and the
// liquid body on the 2D line canvas, which is also the still shown under prefers-reduced-motion.

import { STRIDE, COLORS, TONE } from './map-particles.js';
import { clamp, lerp } from './map-layout.js';
import { hueOf, rgb01 } from './models.js';

const TAU = Math.PI * 2;
const GOLD = TONE.handoff;
const RL = 0.955;                 // the liquid's sphere, just inside the glass
const PITCH = 0.36, CP = Math.cos(PITCH), SP = Math.sin(PITCH);
const LENS = 0.14;                // how much the glass ball magnifies what is inside it
const RING = 40;                  // points on the line where the liquid meets the glass
const smooth = t => t * t * (3 - 2 * t);
const mulberry = seed => () => { let t = (seed += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

export const EFFORT_ENERGY = { low: 0.2, medium: 0.4, high: 0.6, xhigh: 0.8, max: 1 };
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
//   fill   0..1  context used as a share of the handoff threshold (1 = the sphere is full, handoff due)
//   heat   0..1  the shift toward gold over the last fifth before the threshold
//   due    0|1   at or past the threshold: the gold pulse
//   gold   0|1   writing its handoff: the whole core is gold
//   swirl  0..1  idle drift .. working whirlpool
//   speed        swirl pace scaled by effort; energy 0..1 is effort alone
//   flare  0|1   something in the orchestrator's thread waits on Matt (red, decision 31)
//   ask    0|1   the project's permission mode: Ask (1) or Auto (0)
//   fault  0|1   the holder hit an error: the liquid goes amber and still (red stays Matt's call)
export function coreLook({ state = 'idle', ctx = null, retireAt = 60, model = null, effort = null, needs = false, mode = 'auto' } = {}) {
  const s = STATE[state] || STATE.idle;
  const frac = ctx == null || state === 'vacant' || !(retireAt > 0) ? 0 : ctx / retireAt;
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
    ask: mode === 'ask' ? 1 : 0,
    fault: state === 'error' ? 1 : 0
  };
}

// Height of the liquid's resting surface (in core radii, -RL .. RL) for a share of the sphere's volume.
export function levelFor(fill) {
  const f = clamp(fill, 0, 1);
  let a = 0, b = 2;
  for (let i = 0; i < 20; i++) { const s = (a + b) / 2; ((3 * s * s - s * s * s) / 4 < f) ? a = s : b = s; }
  return ((a + b) / 2 - 1) * RL;
}

// How many particles each kind of screen gets. A phone carries about a third of the desktop's load; the
// liquid's body is painted on the 2D canvas on both, so the level reads the same with fewer particles.
export function coreBudget(light) {
  return light
    ? { liquid: 340, glints: 22, bubbles: 10, motes: 26, flare: 40, sparks: 70 }
    : { liquid: 900, glints: 44, bubbles: 26, motes: 46, flare: 78, sparks: 170 };
}

const KEYS = ['fill', 'heat', 'due', 'gold', 'swirl', 'speed', 'energy', 'bright', 'flare', 'ask', 'hr', 'hg', 'hb'];
const SPARK = 10;   // floats per spark: x, y, vx, vy, age, life, type, r, g, b

export class ReservoirCore {
  constructor({ light = false, seed = 11 } = {}) {
    const B = this.budget = coreBudget(light);
    this.light = light;
    this.rand = mulberry(seed);
    this.t = 0; this.dt = 0; this.yaw = 0; this.rot = 0; this.flash = 0; this.q = 1; this.ema = 1 / 60; this.slow = 0;
    this.P = { fill: 0, heat: 0, due: 0, gold: 0, swirl: 0, speed: 0.2, energy: 0.5, bright: 0.35, flare: 0, ask: 0, hr: 0.44, hg: 0.89, hb: 1 };
    this.G = { ...this.P };
    this.look = null;
    // slosh: the surface's tilt is a damped spring that events kick; ripples are rings running over it
    this.tx = 0; this.tz = 0; this.tvx = 0; this.tvz = 0; this.ripples = []; this.events = [];
    this.lvl = -RL; this.a = 0.1; this.dip = 0; this.amp = 0; this.wt = 0; this.pulsePh = 0;

    const n = this.n = B.liquid;
    this.rho = new Float32Array(n); this.th = new Float32Array(n); this.h = new Float32Array(n); this.dome = new Float32Array(n);
    this.w = new Float32Array(n); this.sd = new Float32Array(n);
    this.air = new Uint8Array(n); this.off = new Float32Array(n * 3); this.dv = new Float32Array(n * 3);   // droplets thrown clear of the surface
    for (let i = 0; i < n; i++) {
      const d = this.dir(), rr = Math.cbrt(this.rand()) * RL;
      this.rho[i] = Math.hypot(d[0], d[2]) * rr; this.th[i] = Math.atan2(d[2], d[0]); this.h[i] = -d[1] * rr;
      this.dome[i] = 0.985 / Math.max(rr, 0.05); this.sd[i] = this.rand();
    }
    const ng = B.glints, golden = Math.PI * (3 - Math.sqrt(5));
    this.glint = new Float32Array(ng * 3);
    for (let i = 0; i < ng; i++) { const y = 1 - (i / (ng - 1)) * 2, r = Math.sqrt(1 - y * y), a = golden * i; this.glint[i * 3] = Math.cos(a) * r; this.glint[i * 3 + 1] = y; this.glint[i * 3 + 2] = Math.sin(a) * r; }
    this.bub = new Float32Array(B.bubbles * 4);   // radius, angle, height, pace
    for (let i = 0; i < B.bubbles; i++) this.respawn(i, true);
    this.mote = new Float32Array(B.motes * 5);    // radius, inclination, node, phase, pace
    for (let i = 0; i < B.motes; i++) { const k = i * 5; this.mote[k] = 1.14 + this.rand() * 0.2; this.mote[k + 1] = (this.rand() - 0.5) * 2.6; this.mote[k + 2] = this.rand() * TAU; this.mote[k + 3] = this.rand() * TAU; this.mote[k + 4] = 0.18 + this.rand() * 0.3; }
    this.flareSeed = new Float32Array(B.flare);
    for (let i = 0; i < B.flare; i++) this.flareSeed[i] = this.rand();
    this.sp = new Float32Array(B.sparks * SPARK); this.nsp = 0;
    this.ring = new Float32Array(RING * 2);
    this.viewOut = { ring: this.ring, hue: [0, 0, 0], events: this.events };
  }

  // The most particles one frame can write, for sizing the shared buffer.
  get capacity() { const B = this.budget; return B.liquid + B.glints + B.bubbles + B.motes + B.flare + B.sparks * 3 + 8; }

  gauss() { let u = 0, v = 0; while (!u) u = this.rand(); while (!v) v = this.rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v); }
  dir() { const z = this.rand() * 2 - 1, a = this.rand() * TAU, r = Math.sqrt(1 - z * z); return [Math.cos(a) * r, z, Math.sin(a) * r]; }

  // ---------- state in ----------
  // info: { state, ctx, retireAt, needs, model, effort, mode } straight from the map's model.
  setMood(info) { this.set(coreLook(info)); }

  set(look, snap = false) {
    const G = this.G;
    this.look = look;
    for (const k of KEYS) if (look[k] != null) G[k] = look[k];
    const f = look.fault ? 0.65 : 0;
    G.hr = lerp(look.hue[0], COLORS.amber[0], f); G.hg = lerp(look.hue[1], COLORS.amber[1], f); G.hb = lerp(look.hue[2], COLORS.amber[2], f);
    if (snap) this.settle();
  }

  // Jump straight to the target look (first paint, and the still under reduced motion).
  settle() {
    Object.assign(this.P, this.G);
    this.shape();
    for (let i = 0; i < this.n; i++) this.w[i] = this.h[i] < this.lvl ? 1 : 0;
    this.tx = this.tz = this.tvx = this.tvz = 0;
  }

  // The resting surface for the current look: its height, the radius where it meets the glass,
  // the whirlpool's depth and the height of the small waves.
  shape() {
    const P = this.P;
    this.lvl = levelFor(P.fill) * (1 - 0.07 * P.heat);
    this.a = Math.sqrt(Math.max(RL * RL - this.lvl * this.lvl, 0.01));
    this.dip = P.swirl * (0.07 + 0.2 * P.energy) * Math.min(1, this.a * 1.4);
    this.amp = (0.01 + 0.04 * P.energy * (0.3 + P.swirl)) * (1 - 0.5 * P.heat);
  }

  // ---------- events ----------
  kick(dx, dz, s = 1) { this.tvx += dx * s; this.tvz += dz * s; }
  ripple(x, z, amp) { this.ripples.push({ x, z, t0: this.t, amp }); if (this.ripples.length > 4) this.ripples.shift(); }

  // Throw `count` particles from the surface near (x, z) clear of the liquid; they fall back and rejoin.
  splash(x, z, strength, count, reach = 0.36) {
    const n = Math.round(this.n * this.q), start = (this.rand() * n) | 0;
    for (let k = 0; k < n && count > 0; k++) {
      const i = (start + k) % n;
      if (this.air[i] || this.w[i] < 0.9 || this.lvl - this.h[i] > 0.16) continue;
      const th = this.th[i] + this.rot * (0.5 + 0.9 * (1 - this.rho[i])), px = Math.cos(th) * this.rho[i], pz = Math.sin(th) * this.rho[i];
      if (Math.hypot(px - x, pz - z) > reach) continue;
      const j = i * 3;
      this.air[i] = 1; this.off[j] = this.off[j + 1] = this.off[j + 2] = 0;
      this.dv[j] = this.gauss() * 0.35 + (px - x) * 0.8; this.dv[j + 1] = (1.0 + this.rand() * 1.3) * strength; this.dv[j + 2] = this.gauss() * 0.35 + (pz - z) * 0.8;
      count--;
    }
  }

  // A permission answer: a burst of sparks off the glass at `angle` (screen angle, toward whoever asked).
  // kind: 'allowed' (green) or 'escalated' (red: it went to Matt).
  spark(kind = 'allowed', angle = -0.6) {
    const c = kind === 'allowed' ? COLORS.good : COLORS.red, L = this.light;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const emit = (x, y, vx, vy, life, type) => {
      if (this.nsp >= this.budget.sparks) return;
      const k = this.nsp++ * SPARK, S = this.sp;
      S[k] = x; S[k + 1] = y; S[k + 2] = vx; S[k + 3] = vy; S[k + 4] = 0; S[k + 5] = life; S[k + 6] = type; S[k + 7] = c[0]; S[k + 8] = c[1]; S[k + 9] = c[2];
    };
    for (let i = L ? 24 : 54; i--;) {   // the burst: fast, fanned, dragging trails
      const a = angle + this.gauss() * 0.5, r = this.rand(), v = 0.5 + r * r * 3.6;
      emit(ca * 1.03, sa * 1.03, Math.cos(a) * v, Math.sin(a) * v, 0.45 + this.rand() * 0.85, 0);
    }
    for (let i = L ? 5 : 11; i--;) {    // embers: slow, long-lived, twinkling
      const a = angle + this.gauss() * 0.9, v = 0.15 + this.rand() * 0.55;
      emit(ca * 1.04, sa * 1.04, Math.cos(a) * v, Math.sin(a) * v, 1.2 + this.rand() * 0.9, 1);
    }
    for (let i = L ? 6 : 12; i--;) emit(angle, 0, (i % 2 ? 1 : -1) * (1.4 + this.rand() * 3), 0, 0.45 + this.rand() * 0.5, 2);   // runners along the glass
    this.events.push({ type: 'spark', t0: this.t, angle, col: c });
    if (this.events.length > 4) this.events.shift();
    this.flash = Math.max(this.flash, 0.3);
    // the liquid feels it: recoil, a ripple and a few drops on that side
    this.kick(-ca, sa, 0.55);
    this.ripple(ca * this.a * 0.8, -sa * this.a * 0.8, 0.05);
    this.splash(ca * this.a * 0.7, -sa * this.a * 0.7, 0.8, L ? 4 : 9);
  }

  // The role passes to a new holder: a gold flash that throws the liquid about; the level then runs to the new holder's.
  handoff() {
    const a = this.rand() * TAU;
    this.flash = 1;
    this.kick(Math.cos(a), Math.sin(a), 1.3);
    this.ripple(0, 0, 0.09);
    this.splash(0, 0, 1.25, this.light ? 16 : 42, 1);
    this.events.push({ type: 'handoff', t0: this.t, angle: 0, col: GOLD });
    if (this.events.length > 4) this.events.shift();
  }

  retire() { this.flash = Math.max(this.flash, 0.6); this.kick(this.rand() - 0.5, this.rand() - 0.5, 1.2); }

  // A pulse leaves the core toward (dx, dy) on screen: the liquid leans after it.
  burst(dx, dy) {
    const len = Math.hypot(dx, dy) || 1;
    this.kick(dx / len, -dy / len, 0.32);
    this.ripple((dx / len) * this.a * 0.7, (-dy / len) * this.a * 0.7, 0.025);
  }

  // Something arrived at the core: a ring over the surface and a short glow.
  absorb() { this.flash = Math.max(this.flash, 0.3); this.ripple(0, 0, 0.04); }

  // ---------- simulation ----------
  step(dt) {
    // adaptive budget: if frames run long for a couple of seconds, carry fewer liquid particles
    this.ema += (dt - this.ema) * 0.05;
    this.slow = this.ema > 0.0215 ? this.slow + dt : Math.max(0, this.slow - dt * 2);
    if (this.slow > 2 && this.q > 0.5) { this.q = Math.max(0.5, this.q - 0.17); this.slow = 0; }
    dt = Math.min(dt, 0.05);
    this.t += dt; this.dt += dt;
    const P = this.P, G = this.G, k = 1 - Math.exp(-dt * 2.4), t = this.t;
    for (const key of KEYS) P[key] += (G[key] - P[key]) * k;
    this.flash *= Math.exp(-dt * 3);
    this.yaw += dt * (0.06 + 0.12 * P.speed);
    this.rot += dt * P.speed * (0.7 + 0.9 * P.energy);
    this.wt += dt * (0.8 + 1.6 * P.speed);

    this.shape();
    // slosh: a damped spring, stirred while working
    const stir = P.swirl * (0.5 + P.energy);
    this.tvx += (-22 * this.tx - 1.7 * this.tvx + 1.5 * stir * Math.cos(t * 1.7) + (this.rand() - 0.5) * 5 * stir) * dt;
    this.tvz += (-22 * this.tz - 1.7 * this.tvz + 1.5 * stir * Math.sin(t * 1.3) + (this.rand() - 0.5) * 5 * stir) * dt;
    this.tx = clamp(this.tx + this.tvx * dt, -0.4, 0.4); this.tz = clamp(this.tz + this.tvz * dt, -0.4, 0.4);
    while (this.ripples.length && t - this.ripples[0].t0 > 2.4) this.ripples.shift();
    while (this.events.length && t - this.events[0].t0 > 1.4) this.events.shift();

    // the gold pulse when a handoff is due: every two seconds it leaves the centre and disturbs the liquid
    const ph = (t % 2) / 2;
    if (P.due > 0.5 && ph < this.pulsePh) {
      const a = this.rand() * TAU;
      this.ripple(0, 0, 0.065); this.kick(Math.cos(a), Math.sin(a), 0.4); this.splash(0, 0, 0.85, this.light ? 5 : 12, 0.5);
    }
    this.pulsePh = ph;
    this.stepSparks(dt);
  }

  stepSparks(dt) {
    const S = this.sp;
    let n = 0;
    for (let i = 0; i < this.nsp; i++) {
      const k = i * SPARK;
      S[k + 4] += dt;
      if (S[k + 4] >= S[k + 5]) continue;
      const type = S[k + 6];
      if (type === 2) { S[k] += S[k + 2] * dt; S[k + 2] *= Math.exp(-dt * 2.6); }
      else {
        const drag = Math.exp(-dt * (type ? 1.1 : 2.3));
        S[k + 2] *= drag; S[k + 3] = S[k + 3] * drag + (type ? 0.25 : 0.9) * dt;
        S[k] += S[k + 2] * dt; S[k + 1] += S[k + 3] * dt;
        const r = Math.hypot(S[k], S[k + 1]);
        if (r < 1.02) {   // sparks glance off the glass
          const nx = S[k] / r, ny = S[k + 1] / r, vn = S[k + 2] * nx + S[k + 3] * ny;
          if (vn < 0) { S[k + 2] -= 1.6 * vn * nx; S[k + 3] -= 1.6 * vn * ny; }
          S[k] = nx * 1.02; S[k + 1] = ny * 1.02;
        }
      }
      if (n !== i) S.copyWithin(n * SPARK, k, k + SPARK);
      n++;
    }
    this.nsp = n;
  }

  // Height of the liquid's surface over (x, z), in core radii.
  surfaceAt(x, z) {
    const rho2 = x * x + z * z, rho = Math.sqrt(rho2), a = this.a, wt = this.wt;
    let s = this.lvl + this.tx * x + this.tz * z - this.dip * Math.max(0, 1 - rho2 / (a * a));
    s += this.amp * (Math.sin(5.1 * x + wt * 2.1) * Math.cos(4.3 * z - wt * 1.3) + 0.5 * Math.sin(7.3 * z + wt * 2.9));
    for (const r of this.ripples) {
      const age = this.t - r.t0, d = Math.hypot(x - r.x, z - r.z), front = 0.9 * age;
      if (d < front + 0.12) s += r.amp * Math.exp(-age * 1.5) * Math.sin(15 * (d - front)) * clamp((front + 0.12 - d) * 6, 0, 1);
    }
    return s + 0.03 * Math.exp(-Math.max(0, a - rho) / 0.06);   // surface tension: the liquid climbs the glass a little
  }

  respawn(i, anywhere) {
    const k = i * 4, r = Math.sqrt(this.rand()) * 0.6;
    this.bub[k] = r; this.bub[k + 1] = this.rand() * TAU;
    this.bub[k + 2] = -Math.sqrt(RL * RL - r * r) + 0.04 + (anywhere ? this.rand() * 0.8 : 0);
    this.bub[k + 3] = 0.5 + this.rand();
  }

  pulse(rr) {
    if (this.P.due < 0.02) return 0;
    const d = (rr - this.pulsePh * 1.45) / 0.17;
    return this.P.due * Math.exp(-d * d) * (1 - this.pulsePh * 0.75);
  }

  // ---------- drawing ----------
  project(cx, cy, r, out, o) {
    this.cx = cx; this.cy = cy; this.r = r; this.out = out; this.o = o;
    this.cyw = Math.cos(this.yaw); this.syw = Math.sin(this.yaw);
    this.sizeK = clamp(r / 64, 0.48, 1.12);
    this.body();
    this.dt = 0;
    this.field();
    this.flare();
    this.sparkle();
    return this.o;
  }

  // One particle inside the glass: pitched, projected, then bent by the glass ball (things inside look larger,
  // and crowd together toward the rim).
  inside(x, y, z, size, cr, cg, cb, a) {
    const y1 = y * CP - z * SP, z2 = y * SP + z * CP, persp = 4 / (4 + z2);
    let sx = x * persp, sy = y1 * persp;
    const r2 = sx * sx + sy * sy, lens = 1 + LENS * (1 - Math.min(1, r2)) * (1 + 0.5 * z2);
    sx *= lens; sy *= lens;
    const f = this.flash, out = this.out, k = this.o * STRIDE;
    out[k] = this.cx + sx * this.r; out[k + 1] = this.cy + sy * this.r;
    out[k + 2] = size * persp * lens * this.sizeK;
    out[k + 3] = cr + (1 - cr) * f; out[k + 4] = cg + (1 - cg) * f; out[k + 5] = cb + (1 - cb) * f;
    out[k + 6] = a * this.P.bright * clamp(1.1 - z2 * 0.34, 0.35, 1.5) * (1 + 0.45 * r2 * r2) * (1 + f * 0.6);
    this.o++;
  }

  // One particle around the glass, turning with the core.
  put(x, y, z, size, cr, cg, cb, a) {
    const x1 = x * this.cyw + z * this.syw, z1 = -x * this.syw + z * this.cyw;
    const y1 = y * CP - z1 * SP, z2 = y * SP + z1 * CP, persp = 4 / (4 + z2), out = this.out, k = this.o * STRIDE;
    out[k] = this.cx + x1 * this.r * persp; out[k + 1] = this.cy + y1 * this.r * persp;
    out[k + 2] = size * persp * this.sizeK;
    out[k + 3] = cr; out[k + 4] = cg; out[k + 5] = cb;
    out[k + 6] = a * this.P.bright * clamp(1.15 - z2 * 0.38, 0.3, 1.6);
    this.o++;
  }

  // One particle in view space: x, y in core radii from the centre.
  flat(x, y, size, cr, cg, cb, a) {
    const out = this.out, k = this.o * STRIDE;
    out[k] = this.cx + x * this.r; out[k + 1] = this.cy + y * this.r; out[k + 2] = size * this.sizeK;
    out[k + 3] = cr; out[k + 4] = cg; out[k + 5] = cb; out[k + 6] = a;
    this.o++;
  }

  body() {
    const P = this.P, t = this.t, dt = this.dt, k = 1 - Math.exp(-dt * 4.5), lvl = this.lvl;
    const n = Math.round(this.n * this.q), boost = 1 / Math.sqrt(this.q);
    const gold = P.gold, R = 1 - 0.05 * P.heat;
    for (let i = 0; i < n; i++) {
      const rho = this.rho[i], h = this.h[i], s = this.sd[i], j = i * 3;
      const w = this.w[i] += ((h < lvl ? 1 : 0) - this.w[i]) * k;
      let x, y, z, d = -1;
      if (w > 0.01) {
        // liquid: carried round by the swirl, and its column stretched to follow the moving surface
        const th = this.th[i] + this.rot * (0.5 + 0.9 * (1 - rho));
        const lx = Math.cos(th) * rho, lz = Math.sin(th) * rho;
        const sq = Math.sqrt(Math.max(RL * RL - rho * rho, 1e-4)), top0 = Math.min(lvl, sq), surf = this.surfaceAt(lx, lz), top1 = Math.min(surf, sq);
        const hh = top0 + sq > 0.02 ? -sq + (h + sq) * (top1 + sq) / (top0 + sq) : h;
        d = surf - hh;
        if (w > 0.99) { x = lx; y = -hh; z = lz; }
        else { const dk = this.dome[i], c0 = Math.cos(this.th[i]), s0 = Math.sin(this.th[i]); x = lerp(c0 * rho * dk, lx, w); y = -lerp(h * dk, hh, w); z = lerp(s0 * rho * dk, lz, w); }
      } else { const dk = this.dome[i]; x = Math.cos(this.th[i]) * rho * dk; y = -h * dk; z = Math.sin(this.th[i]) * rho * dk; }
      let fly = 0;
      if (this.air[i]) {
        // a droplet: thrown clear, pulled back by gravity, kept inside the glass
        this.dv[j + 1] -= 5.5 * dt;
        this.off[j] += this.dv[j] * dt; this.off[j + 1] += this.dv[j + 1] * dt; this.off[j + 2] += this.dv[j + 2] * dt;
        if (this.off[j + 1] <= 0 && this.dv[j + 1] < 0) { this.air[i] = 0; this.off[j] = this.off[j + 1] = this.off[j + 2] = 0; }
        else {
          x += this.off[j]; y -= this.off[j + 1]; z += this.off[j + 2];
          const rr = Math.hypot(x, y, z);
          if (rr > 0.93) { const f = 0.93 / rr; x *= f; y *= f; z *= f; this.dv[j] *= 0.6; this.dv[j + 2] *= 0.6; if (this.dv[j + 1] > 0) this.dv[j + 1] *= 0.4; }
          fly = 1;
        }
      }
      x *= R; y *= R; z *= R;
      const pu = this.pulse(Math.hypot(x, y, z));
      const skin = d > 0 ? Math.exp(-d / 0.06) : 0, deep = clamp(d / 1.3, 0, 1);
      let cr = P.hr * (1 - 0.3 * deep), cg = P.hg * (1 - 0.3 * deep), cb = P.hb * (1 - 0.3 * deep);
      const g = Math.max(gold, clamp(P.heat * 1.25 - Math.max(d, 0) * 0.8, 0, 1) * 0.9, pu) * w;
      cr = lerp(cr, GOLD[0], g); cg = lerp(cg, GOLD[1], g); cb = lerp(cb, GOLD[2], g);
      const wh = Math.max(0.6 * skin * w, 0.55 * fly);
      cr = lerp(cr, 1, wh); cg = lerp(cg, 1, wh); cb = lerp(cb, 1, wh);
      this.inside(x, y, z, lerp(1.05, 1.2 + s * 1.0 + skin * 1.2 + fly * 0.5, w) * boost, cr, cg, cb, lerp(0.15, 0.4 + 0.5 * skin + 0.4 * fly, w) * (1 + pu * 0.9));
    }

    // bubbles rising through the liquid while it works; more of them, and faster, with effort
    const act = clamp(P.swirl * 1.3, 0, 1) * (0.35 + 0.65 * P.energy);
    if (act > 0.03 && lvl > -RL * 0.86) {
      const br = lerp(P.hr, 1, 0.6), bg = lerp(P.hg, 1, 0.6), bb = lerp(P.hb, 1, 0.6);
      for (let i = 0; i < this.budget.bubbles; i++) {
        const q = i * 4, B = this.bub;
        B[q + 2] += dt * (0.12 + 0.5 * P.energy) * B[q + 3];
        B[q + 1] += dt * P.speed * 1.3;
        const rad = B[q] * (1 + 0.08 * Math.sin(t * 3 * B[q + 3] + i)), x = Math.cos(B[q + 1]) * rad, z = Math.sin(B[q + 1]) * rad;
        const top = this.surfaceAt(x, z);
        if (B[q + 2] > top - 0.02 || rad * rad + B[q + 2] * B[q + 2] > RL * RL) { this.respawn(i, false); continue; }
        this.inside(x, -B[q + 2], z, 1.0 + B[q + 3] * 0.7, br, bg, bb, act * 0.6 * clamp((top - B[q + 2]) * 8, 0, 1));
      }
    }

    // glints on the glass itself
    const gr = lerp(P.hr, 1, 0.55), gg = lerp(P.hg, 1, 0.55), gb = lerp(P.hb, 1, 0.55), rim = this.pulse(1);
    for (let i = 0; i < this.budget.glints; i++) {
      const j = i * 3, tw = Math.max(0, Math.sin(t * 1.3 + i * 2.4)), g = Math.max(gold, rim);
      this.put(this.glint[j], this.glint[j + 1], this.glint[j + 2], 1.1 + tw * 0.6, lerp(gr, GOLD[0], g), lerp(gg, GOLD[1], g), lerp(gb, GOLD[2], g), 0.1 + 0.3 * tw * tw * tw + rim * 0.5);
    }
  }

  // The field around the core. Auto: free motes on their own loose orbits. Ask: the same motes held, evenly
  // spaced, on two crossed hoops.
  field() {
    const P = this.P, m = this.budget.motes, half = Math.ceil(m / 2), t = this.t, ask = smooth(clamp(P.ask, 0, 1));
    const cr = lerp(P.hr, 1, 0.3), cg = lerp(P.hg, 1, 0.3), cb = lerp(P.hb, 1, 0.3);
    for (let i = 0; i < m; i++) {
      const k = i * 5, M = this.mote;
      const hoop = i < half ? 0 : 1, slot = (hoop ? i - half : i) / (hoop ? m - half : half);
      const rad = lerp(M[k], 1.24, ask), inc = lerp(M[k + 1], hoop ? -0.95 : 0.95, ask), node = lerp(M[k + 2], 0.5, ask);
      const ph = lerp(M[k + 3] + t * M[k + 4] * (0.5 + P.speed), slot * TAU + t * 0.12 * (hoop ? -1 : 1), ask);
      const px = Math.cos(ph) * rad, pz = Math.sin(ph) * rad;
      const y = -pz * Math.sin(inc), z0 = pz * Math.cos(inc);
      this.put(px * Math.cos(node) + z0 * Math.sin(node), y, -px * Math.sin(node) + z0 * Math.cos(node), 1.5 + ask * 0.45, cr, cg, cb, 0.55 + ask * 0.35);
    }
  }

  // Waiting on Matt: a red rim with three prominences, in view space so it always sits on the visible edge.
  flare() {
    const fl = this.P.flare;
    if (fl < 0.02) return;
    const t = this.t, n = this.budget.flare, rim = Math.round(n * 0.58), R = COLORS.red;
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
        const a = a0 + (s - 0.5) * 0.56, rad = 1.07 + high * arch, w = 0.25 * arch;
        this.flat(Math.cos(a) * rad, Math.sin(a) * rad, 1.4 + arch * 1.6, lerp(R[0], 1, w), lerp(R[1], 1, w), lerp(R[2], 1, w), fl * 0.95 * arch);
      }
    }
  }

  sparkle() {
    const S = this.sp;
    for (let i = 0; i < this.nsp; i++) {
      const k = i * SPARK, q = S[k + 4] / S[k + 5], type = S[k + 6], cr = S[k + 7], cg = S[k + 8], cb = S[k + 9];
      if (type === 2) {   // a runner along the glass, with one echo behind it
        const a = S[k], f = (1 - q) * (1 - q);
        this.flat(Math.cos(a) * 1.02, Math.sin(a) * 1.02, 2.6, lerp(1, cr, 0.5), lerp(1, cg, 0.5), lerp(1, cb, 0.5), f * 1.1);
        const b = a - S[k + 2] * 0.03;
        this.flat(Math.cos(b) * 1.02, Math.sin(b) * 1.02, 1.9, cr, cg, cb, f * 0.6);
        continue;
      }
      const tw = type ? 0.45 + 0.55 * Math.sin(S[k + 4] * 34 + i * 1.7) : 1;
      const fade = Math.pow(1 - q, type ? 0.8 : 1.3) * tw, hot = clamp(1 - q * 1.7, 0, 1);
      // the head burns white, then cools to the answer's colour; two samples trail behind along its path
      this.flat(S[k], S[k + 1], (type ? 1.9 : 2.7) * (1 - q * 0.45), lerp(cr, 1, hot), lerp(cg, 1, hot), lerp(cb, 1, hot), fade * 1.15);
      if (type) continue;
      this.flat(S[k] - S[k + 2] * 0.028, S[k + 1] - S[k + 3] * 0.028, 2.0 * (1 - q * 0.5), cr, cg, cb, fade * 0.6);
      this.flat(S[k] - S[k + 2] * 0.058, S[k + 1] - S[k + 3] * 0.058, 1.5 * (1 - q * 0.5), cr, cg, cb, fade * 0.3);
    }
    for (const e of this.events) {   // the strike itself
      if (e.type !== 'spark') continue;
      const u = (this.t - e.t0) / 0.3;
      if (u >= 1) continue;
      const c = e.col;
      this.flat(Math.cos(e.angle) * 1.02, Math.sin(e.angle) * 1.02, 12 * (1 - u * 0.6), lerp(c[0], 1, 0.7), lerp(c[1], 1, 0.7), lerp(c[2], 1, 0.7), (1 - u) * (1 - u) * 1.3);
    }
  }

  // What paintGlass() needs: the line where the liquid meets the glass (screen points in core radii), colours and events.
  view() {
    const P = this.P, V = this.viewOut, a = this.a * 0.995;
    for (let k = 0; k < RING; k++) {
      const ph = (k / RING) * TAU, x = Math.cos(ph) * a, z = Math.sin(ph) * a;
      let h = this.surfaceAt(x, z);
      const rr = Math.hypot(a, h), f = rr > RL ? RL / rr : 1, R = 1 - 0.05 * P.heat;
      const X = x * f * R, Y = -h * f * R, Z = z * f * R;
      const y1 = Y * CP - Z * SP, z2 = Y * SP + Z * CP, persp = 4 / (4 + z2);
      let sx = X * persp, sy = y1 * persp;
      const lens = 1 + LENS * (1 - Math.min(1, sx * sx + sy * sy)) * (1 + 0.5 * z2);
      this.ring[k * 2] = sx * lens; this.ring[k * 2 + 1] = sy * lens;
    }
    V.hue[0] = P.hr; V.hue[1] = P.hg; V.hue[2] = P.hb;
    V.fill = P.fill; V.heat = P.heat; V.gold = P.gold; V.due = P.due; V.bright = P.bright; V.flare = P.flare;
    V.flash = this.flash; V.pulsePh = this.pulsePh; V.t = this.t; V.events = this.events;
    return V;
  }
}

// ---------- the glass, on the 2D canvas ----------
const rgba = (c, a) => `rgba(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0},${a})`;
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const WHITE = [1, 1, 1];

// Draw the sphere at (x, y) with radius r from a core's view(). `still` adds what the particles would
// otherwise show (the red rim), for the reduced-motion map.
export function paintGlass(c, x, y, r, v, { still = false } = {}) {
  const k = clamp(v.bright, 0.3, 1.1), hue = v.hue, t = v.t;
  const liq = mix(hue, GOLD, Math.max(v.gold, v.heat * 0.8)), ring = v.ring;
  const px = i => x + ring[(i % RING) * 2] * r, py = i => y + ring[(i % RING) * 2 + 1] * r;
  c.save();
  c.lineCap = 'round'; c.lineJoin = 'round';

  // the glass body: barely there, a little denser toward the edge
  let g = c.createRadialGradient(x - r * 0.25, y - r * 0.3, r * 0.1, x, y, r);
  g.addColorStop(0, rgba(hue, 0.075 * k)); g.addColorStop(0.7, rgba(hue, 0.03 * k)); g.addColorStop(1, rgba(hue, 0.11 * k));
  c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();

  if (v.fill > 0.012) {
    // the liquid: its near wall below the front of the surface line, then the surface itself
    const half = RING / 2, body = new Path2D(), face = new Path2D();
    body.moveTo(px(half), py(half));
    for (let i = half + 1; i <= RING; i++) body.lineTo(px(i), py(i));
    const aR = Math.atan2(py(0) - y, px(0) - x), aL = Math.atan2(py(half) - y, px(half) - x);
    body.arc(x, y, r * 0.975, aR, aL < aR ? aL + TAU : aL, false);
    body.closePath();
    face.moveTo(px(0), py(0));
    for (let i = 1; i < RING; i++) face.lineTo(px(i), py(i));
    face.closePath();
    let top = Infinity;
    for (let i = 0; i < RING; i++) top = Math.min(top, py(i));

    c.save();
    c.beginPath(); c.arc(x, y, r * 0.985, 0, TAU); c.clip();
    g = c.createLinearGradient(0, top, 0, y + r);
    g.addColorStop(0, rgba(liq, 0.34 * k)); g.addColorStop(0.5, rgba(mix(liq, hue, 0.5), 0.22 * k)); g.addColorStop(1, rgba(mix(hue, [0, 0, 0], 0.45), 0.2 * k));
    c.fillStyle = g; c.fill(body);
    // caustics: light gathered by the glass, wandering inside the liquid on the side away from the lamp
    c.save(); c.clip(body);
    for (let i = 0; i < 3; i++) {
      const bx = x + r * (0.26 + 0.14 * Math.sin(t * 0.7 + i * 2.1)), by = y + r * (0.5 + 0.12 * Math.cos(t * 0.9 + i * 1.7)), br = r * (0.3 + 0.08 * Math.sin(t * 1.3 + i));
      g = c.createRadialGradient(bx, by, 0, bx, by, br);
      g.addColorStop(0, rgba(mix(liq, WHITE, 0.55), 0.13 * k)); g.addColorStop(1, rgba(liq, 0));
      c.fillStyle = g; c.fillRect(bx - br, by - br, br * 2, br * 2);
    }
    c.restore();
    c.fillStyle = rgba(mix(liq, WHITE, 0.3), 0.15 * k); c.fill(face);
    // where liquid meets glass: a soft line all the way round, bright along the front, with caustic glints running on it
    const lw = Math.max(0.7, r * 0.02);
    c.strokeStyle = rgba(mix(liq, WHITE, 0.4), 0.3 * k); c.lineWidth = lw * 0.7; c.stroke(face);
    c.beginPath(); c.moveTo(px(half), py(half));
    for (let i = half + 1; i <= RING; i++) c.lineTo(px(i), py(i));
    c.shadowColor = rgba(liq, 0.9); c.shadowBlur = r * 0.14;
    c.strokeStyle = rgba(mix(liq, WHITE, 0.6), 0.8 * k); c.lineWidth = lw; c.stroke();
    c.setLineDash([r * 0.035, r * 0.26]); c.lineDashOffset = -t * r * 0.1;
    c.strokeStyle = rgba(WHITE, 0.7 * k); c.lineWidth = lw * 1.2; c.stroke();
    c.setLineDash([]); c.shadowBlur = 0;
    c.restore();
  }

  // the glass over it: an edge that catches light (fresnel), brightest at the rim
  g = c.createRadialGradient(x, y, r * 0.74, x, y, r);
  g.addColorStop(0, rgba(hue, 0)); g.addColorStop(0.8, rgba(hue, 0.07 * k)); g.addColorStop(1, rgba(mix(hue, WHITE, 0.5), 0.34 * k));
  c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
  // rim: its own line, lit gold as the handoff pulse reaches it, lit by sparks and handoffs
  const d = (v.pulsePh - 0.69) / 0.1, rimGold = Math.max(v.gold * 0.6, v.due * Math.exp(-d * d) * 0.9);
  const rimCol = mix(mix(hue, WHITE, 0.45), GOLD, rimGold);
  c.shadowColor = rgba(rimCol, 0.8); c.shadowBlur = r * (0.08 + 0.3 * rimGold + 0.4 * v.flash);
  c.strokeStyle = rgba(rimCol, clamp((0.5 + 0.4 * rimGold + 0.5 * v.flash) * k, 0, 1)); c.lineWidth = Math.max(0.8, r * 0.016);
  c.beginPath(); c.arc(x, y, r, 0, TAU); c.stroke();
  c.shadowBlur = 0;
  // the lamp's reflection inside the far wall, lower right
  c.strokeStyle = rgba(WHITE, 0.13 * k); c.lineWidth = r * 0.05;
  c.beginPath(); c.arc(x, y, r * 0.9, 0.3, 1.25); c.stroke();
  c.strokeStyle = rgba(WHITE, 0.1 * k); c.lineWidth = r * 0.02;
  c.beginPath(); c.arc(x, y, r * 0.83, 0.5, 1.05); c.stroke();
  // light along the near edge, upper left
  c.strokeStyle = rgba(WHITE, 0.4 * k); c.lineWidth = Math.max(0.7, r * 0.028);
  c.beginPath(); c.arc(x, y, r * 0.935, 3.45, 4.4); c.stroke();
  // specular highlight: a soft window and a hot point
  c.save();
  c.translate(x - r * 0.4, y - r * 0.46); c.rotate(-0.66); c.scale(1, 0.5);
  g = c.createRadialGradient(0, 0, 0, 0, 0, r * 0.27);
  g.addColorStop(0, rgba(WHITE, 0.5 * k)); g.addColorStop(0.6, rgba(WHITE, 0.14 * k)); g.addColorStop(1, rgba(WHITE, 0));
  c.fillStyle = g; c.beginPath(); c.arc(0, 0, r * 0.27, 0, TAU); c.fill();
  c.restore();
  c.fillStyle = rgba(WHITE, 0.9 * k); c.beginPath(); c.arc(x - r * 0.48, y - r * 0.5, Math.max(0.7, r * 0.028), 0, TAU); c.fill();

  // sparks and handoffs light the glass: a glow racing both ways round the rim, and a star at the strike
  for (const e of v.events) {
    const u = (t - e.t0) / (e.type === 'handoff' ? 1.2 : 0.75);
    if (u >= 1) continue;
    const f = (1 - u) * (1 - u), spread = e.type === 'handoff' ? Math.PI : 0.12 + u * 1.7;
    c.shadowColor = rgba(e.col, 0.95); c.shadowBlur = r * 0.3;
    c.strokeStyle = rgba(mix(e.col, WHITE, 0.3), f); c.lineWidth = Math.max(1, r * 0.035 * (1 - u * 0.5));
    c.beginPath(); c.arc(x, y, r, e.angle - spread, e.angle + spread); c.stroke();
    c.shadowBlur = 0;
    if (e.type === 'spark' && u < 0.5) {
      const sx = x + Math.cos(e.angle) * r * 1.02, sy = y + Math.sin(e.angle) * r * 1.02, s = 1 - u * 2, len = r * 0.75 * s;
      for (const a of [0, Math.PI / 2, e.angle + Math.PI / 4]) {
        const dx = Math.cos(a) * len * (a ? 0.55 : 1), dy = Math.sin(a) * len * (a ? 0.55 : 1);
        g = c.createLinearGradient(sx - dx, sy - dy, sx + dx, sy + dy);
        g.addColorStop(0, rgba(e.col, 0)); g.addColorStop(0.5, rgba(mix(e.col, WHITE, 0.75), s)); g.addColorStop(1, rgba(e.col, 0));
        c.strokeStyle = g; c.lineWidth = Math.max(0.8, r * 0.014);
        c.beginPath(); c.moveTo(sx - dx, sy - dy); c.lineTo(sx + dx, sy + dy); c.stroke();
      }
    }
  }

  if (still && v.flare > 0.5) {   // no particles in the still: the red rim says someone waits on Matt
    c.shadowColor = rgba(COLORS.red, 0.9); c.shadowBlur = r * 0.2;
    c.strokeStyle = rgba(COLORS.red, 0.85); c.lineWidth = Math.max(1.2, r * 0.03);
    c.beginPath(); c.arc(x, y, r * 1.07, 0, TAU); c.stroke();
  }
  c.restore();
}

// Workers in flight: a stream of the core's particles running out along the spoke to a busy station.
// from, via, to are panel points (the curve the map's edges use); returns the next free slot.
export function stream(out, o, from, via, to, t, hue, { u0 = 0.2, u1 = 0.92, n = 9, pace = 0.45, seed = 0, alpha = 1 } = {}) {
  for (let i = 0; i < n; i++) {
    const s = (i / n + t * pace + seed) % 1, u = lerp(u0, u1, s), v = 1 - u;
    const k = o * STRIDE, a = Math.sin(Math.PI * s);
    out[k] = v * v * from.x + 2 * v * u * via.x + u * u * to.x + Math.sin(i * 7.3 + t * 3) * 1.6;
    out[k + 1] = v * v * from.y + 2 * v * u * via.y + u * u * to.y + Math.cos(i * 5.1 + t * 2.6) * 1.6;
    out[k + 2] = 1.3 + a * 1.1;
    out[k + 3] = lerp(hue[0], 1, 0.25); out[k + 4] = lerp(hue[1], 1, 0.25); out[k + 5] = lerp(hue[2], 1, 0.25); out[k + 6] = 0.85 * a * alpha;
    o++;
  }
  return o;
}
