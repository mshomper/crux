// Live map core (decision 76, A): the orchestrator role as a swarm of particles filling a glass sphere.
// Nothing is written on it; the orchestrator's state is in the swarm itself:
//   context used   how far the bright core has grown out from the centre through a dim haze of the model's hue
//                  (the whole sphere lit = the handoff is due); gold and a little tighter over the last fifth
//   model          the swarm's hue (decision 20)
//   effort, state  how fast it turns: a slow drift when idle, a vortex with three arms when working
//   waiting on you a red flare on the rim (decision 31)
//   permissions    a spark off the glass for every answer; Auto or Ask as loose motes or motes held on two hoops
//   handoff        a gold pulse running out from the centre, then the whole swarm in gold
// coreLook() is the pure mapping from hub state to those numbers. The swarm moves entirely in the GPU's vertex
// shader (SWARM_VS) from fixed per-particle seeds uploaded once; SwarmCore keeps the state on the CPU and hands the
// renderer a few uniforms each frame. The flare, motes and sparks stay on the CPU, written as x, y, size, r, g, b, a
// like every other map particle. swarmPoint() is the same maths in plain JS: the canvas fallback and the tests use it.
// paintGlass() draws the glass (a thin rim, the bright edge and the highlights) on the 2D line canvas.

import { STRIDE, COLORS, TONE } from './map-particles.js';
import { clamp, lerp } from './map-layout.js';
import { hueOf, rgb01 } from './models.js';

const TAU = Math.PI * 2;
const GOLD = TONE.handoff;
const PITCH = 0.36, CP = Math.cos(PITCH), SP = Math.sin(PITCH);
const AXT = 0.8, CA = Math.cos(AXT), SA = Math.sin(AXT);   // the swirl's axis leans toward the viewer: the flow is seen from above
const LENS = 0.14;                // how much the glass ball magnifies what is inside it
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
//   fill   0..1  context used as a share of the handoff threshold (1 = the whole sphere lit, handoff due)
//   heat   0..1  the shift toward gold over the last fifth before the threshold
//   due    0|1   at or past the threshold: the gold pulse
//   gold   0|1   writing its handoff: the whole core is gold
//   swirl  0..1  idle drift .. working vortex
//   speed        turning pace scaled by effort; energy 0..1 is effort alone
//   flare  0|1   something in the orchestrator's thread waits on Matt (red, decision 31)
//   ask    0|1   the project's permission mode: Ask (1) or Auto (0)
//   fault  0|1   the holder hit an error: the swarm goes amber and still (red stays Matt's call)
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

// The radius (in core radii) the bright core has grown to, for a share of the way to the handoff.
export function litRadius(fill, heat = 0) { return 0.97 * (1 - 0.06 * heat) * Math.pow(clamp(fill, 0, 1), 0.75); }

// How many particles each kind of screen gets (Matt, 2026-11-17: 60k on the open map and 30k in the strip hold his
// 165 Hz). The frame-time probe only scales down from these, and back up to them. `fallback` is the sample the plain
// canvas renderer draws when there is no WebGL2.
export function coreBudget(light) {
  return light
    ? { open: 10000, strip: 6000, fallback: 900, motes: 26, flare: 40, sparks: 70 }
    : { open: 60000, strip: 30000, fallback: 2500, motes: 46, flare: 78, sparks: 170 };
}
const Q_MIN = 0.2;          // the probe never sheds more than four fifths
const REF_N = 60000, REF_R = 104, REF_K = 1.15;   // the open map on a desktop: the look was tuned there

// Eight random numbers per particle, the same every run: a prefix of any length is a fair sample of the whole swarm.
export function swarmSeeds(n, seed = 1234) {
  const r = mulberry(seed), a = new Float32Array(n * 8);
  for (let i = 0; i < a.length; i++) a[i] = r();
  return a;
}

// The swarm, in the vertex shader. swarmPoint() below is the same maths; keep the two in step.
export const SWARM_VS = `#version 300 es
precision highp float;
layout(location=0) in vec4 aA;
layout(location=1) in vec4 aB;
uniform vec2 uRes; uniform float uDpr;
uniform vec2 uC; uniform float uR, uSizeK, uDens;
uniform float uT, uRot, uFill, uHeat, uSwirl, uEnergy, uBright, uGold, uDue, uPh, uFlash, uKick;
uniform vec2 uLean;
uniform vec3 uHue;
out vec4 vCol;
const float TAU = 6.28318531;
const vec3 GOLD = vec3(${GOLD.join(', ')});
const vec3 WHITE = vec3(1.0);
const float CP = ${CP.toFixed(6)}, SP = ${SP.toFixed(6)}, CA = ${CA.toFixed(6)}, SA = ${SA.toFixed(6)};
vec3 dirOf(float u, float v) { float z = 2.0 * u - 1.0, a = TAU * v, r = sqrt(max(0.0, 1.0 - z * z)); return vec3(cos(a) * r, z, sin(a) * r); }
float gaussOf(float u, float v) { return sqrt(-2.0 * log(max(u, 1e-6))) * cos(TAU * v); }
void main() {
  float rr0 = pow(aA.x, 0.333333) * 0.97;
  vec3 d = dirOf(aA.y, aA.z);
  float rho = length(d.xz) * rr0, h = d.y * rr0;
  float th = atan(d.z, d.x) + uRot * (0.3 + 0.95 * (1.0 - rr0));
  float arm = step(aB.y, 0.5 * uSwirl);   // working: half the swarm rides three vortex arms
  if (arm > 0.5) {
    th = floor(aA.w * 3.0) * TAU / 3.0 - 3.2 * rho + uRot * 0.85 + (aB.z - 0.5) * 0.6 * (0.3 + rho);
    h *= 0.3;
  }
  vec3 p = vec3(cos(th) * rho, -h, sin(th) * rho);
  float nuc = step(fract(aA.w * 7.3 + aB.z * 1.7), 0.05);   // a hot nucleus at the centre
  if (nuc > 0.5) p = d * abs(gaussOf(aA.x, aB.y)) * 0.075 * (1.0 + 0.4 * uEnergy);
  float wob = 0.025 + 0.045 * uSwirl * uEnergy;
  p += wob * vec3(sin(aB.w * TAU + uT * (0.7 + aA.w)), sin(aB.z * TAU * 1.7 + uT * (0.5 + aB.x)), cos(aB.w * TAU * 1.3 + uT * (0.6 + aB.y)));
  p = vec3(p.x, p.y * CA - p.z * SA, p.y * SA + p.z * CA);
  p *= (1.0 - 0.06 * uHeat) * (1.0 + 0.018 * sin(uT * 1.7));
  float rr = length(p), has = step(0.01, uFill);
  float Rlit = 0.97 * (1.0 - 0.06 * uHeat) * pow(max(uFill, 1e-4), 0.75);
  float lit = (1.0 - smoothstep(Rlit - 0.07, Rlit + 0.02, rr)) * has;
  float e = (rr - Rlit) / 0.03, edge = exp(-e * e) * has * (1.0 - uDue);
  float core = clamp(1.0 - rr / max(Rlit, 0.05), 0.0, 1.0);
  float dp = (rr - uPh * 1.45) / 0.17, pu = uDue * exp(-dp * dp) * (1.0 - uPh * 0.75);
  float g = max(uGold, max(uHeat, pu));
  vec3 hot = mix(mix(uHue, WHITE, 0.08 + 0.4 * core * core * core), mix(GOLD, WHITE, 0.35 * core * core), g);
  vec3 haze = mix(uHue * 0.7, GOLD * 0.8, max(uGold, uHeat * 0.35));
  vec3 col = mix(mix(haze, hot, lit), WHITE, edge * 0.45);
  float tw = 0.65 + 0.35 * sin(uT * (2.0 + 6.0 * aB.x) + aB.w * TAU);
  float a = mix(0.07 + 0.06 * arm, (0.42 + 0.25 * uEnergy) * tw, lit) + edge * 1.1 + pu * 0.9;
  float size = mix(0.75 + 0.45 * aB.x, 0.9 + 0.9 * aB.x * aB.x, lit) + edge * 0.5 + pu * 0.7;
  if (nuc > 0.5) { col = mix(mix(uHue, WHITE, 0.6), GOLD, max(uGold, uHeat)); a = 0.9 + 0.5 * uEnergy; size = 1.2 + aB.x; }
  float spark = step(fract(aA.w * 13.7 + aB.w * 3.1), 0.035);   // one in thirty is a spark; the rest a fine dust
  a = mix(a * 0.28, a + 0.1, spark);
  size *= mix(0.8, 1.5, spark);
  col = mix(col, WHITE, 0.25 * spark);
  p *= 1.0 + uKick * (0.25 + 0.5 * aB.x);   // a handoff throws the swarm out; it settles back
  float y1 = p.y * CP - p.z * SP, z2 = p.y * SP + p.z * CP, persp = 4.0 / (4.0 + z2);
  vec2 s = vec2(p.x, y1) * persp;
  float lens = 1.0 + ${LENS} * (1.0 - min(1.0, dot(s, s))) * (1.0 + 0.5 * z2);
  vec2 cl = (uC + (s * lens + uLean * rr * rr) * uR) / uRes * 2.0 - 1.0;
  gl_Position = vec4(cl.x, -cl.y, 0.0, 1.0);
  gl_PointSize = max(1.0, size * persp * lens * uSizeK * uDpr * 2.2);
  col += (1.0 - col) * uFlash;
  vCol = vec4(col, a * uDens * uBright * clamp(1.1 - z2 * 0.34, 0.35, 1.5) * (1.0 + uFlash * 0.6));
}`;

// One swarm particle in plain JS (the same maths as SWARM_VS): written at out[k] as x, y, size, r, g, b, a in panel
// pixels. `info`, when given, gets the particle's radius, how lit it is and whether it is in the nucleus.
const mixv = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const sstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
export function swarmPoint(S, i, U, out, k, info) {
  const j = i * 8, A0 = S[j], A1 = S[j + 1], A2 = S[j + 2], A3 = S[j + 3], B0 = S[j + 4], B1 = S[j + 5], B2 = S[j + 6], B3 = S[j + 7];
  const rr0 = Math.cbrt(A0) * 0.97;
  const dz = 2 * A1 - 1, da = TAU * A2, dr = Math.sqrt(Math.max(0, 1 - dz * dz)), d = [Math.cos(da) * dr, dz, Math.sin(da) * dr];
  let rho = Math.hypot(d[0], d[2]) * rr0, h = d[1] * rr0;
  let th = Math.atan2(d[2], d[0]) + U.uRot * (0.3 + 0.95 * (1 - rr0));
  const arm = B1 <= 0.5 * U.uSwirl ? 1 : 0;
  if (arm) { th = Math.floor(A3 * 3) * TAU / 3 - 3.2 * rho + U.uRot * 0.85 + (B2 - 0.5) * 0.6 * (0.3 + rho); h *= 0.3; }
  let x = Math.cos(th) * rho, y = -h, z = Math.sin(th) * rho;
  const nuc = ((A3 * 7.3 + B2 * 1.7) % 1) <= 0.05 ? 1 : 0;
  if (nuc) { const g = Math.abs(Math.sqrt(-2 * Math.log(Math.max(A0, 1e-6))) * Math.cos(TAU * B1)) * 0.075 * (1 + 0.4 * U.uEnergy); x = d[0] * g; y = d[1] * g; z = d[2] * g; }
  const t = U.uT, wob = 0.025 + 0.045 * U.uSwirl * U.uEnergy;
  x += wob * Math.sin(B3 * TAU + t * (0.7 + A3)); y += wob * Math.sin(B2 * TAU * 1.7 + t * (0.5 + B0)); z += wob * Math.cos(B3 * TAU * 1.3 + t * (0.6 + B1));
  [y, z] = [y * CA - z * SA, y * SA + z * CA];
  const R = (1 - 0.06 * U.uHeat) * (1 + 0.018 * Math.sin(t * 1.7));
  x *= R; y *= R; z *= R;
  const rr = Math.hypot(x, y, z), has = U.uFill >= 0.01 ? 1 : 0;
  const Rlit = litRadius(U.uFill, U.uHeat);
  const lit = (1 - sstep(Rlit - 0.07, Rlit + 0.02, rr)) * has;
  const e = (rr - Rlit) / 0.03, edge = Math.exp(-e * e) * has * (1 - U.uDue);
  const core = clamp(1 - rr / Math.max(Rlit, 0.05), 0, 1);
  const dp = (rr - U.uPh * 1.45) / 0.17, pu = U.uDue * Math.exp(-dp * dp) * (1 - U.uPh * 0.75);
  const g = Math.max(U.uGold, U.uHeat, pu);
  const hot = mixv(mixv(U.uHue, [1, 1, 1], 0.08 + 0.4 * core ** 3), mixv(GOLD, [1, 1, 1], 0.35 * core * core), g);
  const haze = mixv(U.uHue.map(c => c * 0.7), GOLD.map(c => c * 0.8), Math.max(U.uGold, U.uHeat * 0.35));
  let col = mixv(mixv(haze, hot, lit), [1, 1, 1], edge * 0.45);
  const tw = 0.65 + 0.35 * Math.sin(t * (2 + 6 * B0) + B3 * TAU);
  let a = lerp(0.07 + 0.06 * arm, (0.42 + 0.25 * U.uEnergy) * tw, lit) + edge * 1.1 + pu * 0.9;
  let size = lerp(0.75 + 0.45 * B0, 0.9 + 0.9 * B0 * B0, lit) + edge * 0.5 + pu * 0.7;
  if (nuc) { col = mixv(mixv(U.uHue, [1, 1, 1], 0.6), GOLD, Math.max(U.uGold, U.uHeat)); a = 0.9 + 0.5 * U.uEnergy; size = 1.2 + B0; }
  const spark = ((A3 * 13.7 + B3 * 3.1) % 1) <= 0.035 ? 1 : 0;
  a = spark ? a + 0.1 : a * 0.28;
  size *= spark ? 1.5 : 0.8;
  if (spark) col = mixv(col, [1, 1, 1], 0.25);
  const kk = 1 + U.uKick * (0.25 + 0.5 * B0);
  x *= kk; y *= kk; z *= kk;
  const y1 = y * CP - z * SP, z2 = y * SP + z * CP, persp = 4 / (4 + z2);
  const sx = x * persp, sy = y1 * persp, lens = 1 + LENS * (1 - Math.min(1, sx * sx + sy * sy)) * (1 + 0.5 * z2);
  const f = U.uFlash;
  out[k] = U.uC[0] + (sx * lens + U.uLean[0] * rr * rr) * U.uR;
  out[k + 1] = U.uC[1] + (sy * lens + U.uLean[1] * rr * rr) * U.uR;
  out[k + 2] = size * persp * lens * U.uSizeK;
  out[k + 3] = col[0] + (1 - col[0]) * f; out[k + 4] = col[1] + (1 - col[1]) * f; out[k + 5] = col[2] + (1 - col[2]) * f;
  out[k + 6] = a * U.uDens * U.uBright * clamp(1.1 - z2 * 0.34, 0.35, 1.5) * (1 + f * 0.6);
  if (info) { info.rr = rr; info.lit = lit; info.nuc = nuc; info.spark = spark; }
}

const KEYS = ['fill', 'heat', 'due', 'gold', 'swirl', 'speed', 'energy', 'bright', 'flare', 'ask', 'hr', 'hg', 'hb'];
const SPARK = 10;   // floats per spark: x, y, vx, vy, age, life, type, r, g, b
export const SPARK_COLOR = { allowed: COLORS.good, denied: COLORS.amber, escalated: COLORS.red };

export class SwarmCore {
  constructor({ light = false, seed = 11 } = {}) {
    const B = this.budget = coreBudget(light);
    this.light = light;
    this.rand = mulberry(seed);
    this.t = 0; this.yaw = 0; this.rot = 0; this.flash = 0; this.pulsePh = 0;
    this.kick = 0; this.kv = 0;                            // the handoff's throw: a spring that settles back
    this.lx = 0; this.ly = 0; this.lvx = 0; this.lvy = 0;  // the lean toward a pulse or away from a spark: a spring too
    // the frame-time probe: the share of the budget drawn, a smoothed frame time, the screen's own pace, a trial cut
    this.q = 1; this.ema = 1 / 60; this.ref = 1 / 60; this.slow = 0; this.calm = 0; this.trial = null; this.floor = 0;
    this.ring = new Float32Array(400); this.ri = 0; this.rn = 0; this.since = 0;
    this.P = { fill: 0, heat: 0, due: 0, gold: 0, swirl: 0, speed: 0.2, energy: 0.5, bright: 0.35, flare: 0, ask: 0, hr: 0.44, hg: 0.89, hb: 1 };
    this.G = { ...this.P };
    this.look = null;
    this.events = [];
    this.cx = 0; this.cy = 0; this.r = 1;
    this.mote = new Float32Array(B.motes * 5);    // radius, inclination, node, phase, pace
    for (let i = 0; i < B.motes; i++) { const k = i * 5; this.mote[k] = 1.14 + this.rand() * 0.2; this.mote[k + 1] = (this.rand() - 0.5) * 2.6; this.mote[k + 2] = this.rand() * TAU; this.mote[k + 3] = this.rand() * TAU; this.mote[k + 4] = 0.18 + this.rand() * 0.3; }
    this.flareSeed = new Float32Array(B.flare);
    for (let i = 0; i < B.flare; i++) this.flareSeed[i] = this.rand();
    this.sp = new Float32Array(B.sparks * SPARK); this.nsp = 0;
    this.U = { uC: [0, 0], uR: 1, uSizeK: 1, uDens: 1, uT: 0, uRot: 0, uFill: 0, uHeat: 0, uSwirl: 0, uEnergy: 0.5, uBright: 1, uGold: 0, uDue: 0, uPh: 0, uFlash: 0, uKick: 0, uLean: [0, 0], uHue: [0, 0, 0] };
    this.swarmOut = { count: 0, u: this.U, max: B.open };   // max: the renderer uploads that many seeds, once
    this.viewOut = { hue: [0, 0, 0], events: this.events };
    this.seeds = null;   // made on first use by the canvas fallback
  }

  // The most CPU particles one frame can write (the flare, motes and sparks, plus the canvas fallback's sample).
  get capacity() { const B = this.budget; return B.motes + B.flare + B.sparks * 3 + B.fallback + 8; }
  gauss() { let u = 0, v = 0; while (!u) u = this.rand(); while (!v) v = this.rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v); }

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
    this.kick = this.kv = this.lx = this.ly = this.lvx = this.lvy = 0;
    this.flash = 0; this.nsp = 0; this.events.length = 0;
  }

  // ---------- events ----------
  // A permission answer: a burst of sparks off the glass at `angle` (screen angle, toward whoever asked).
  // kind: 'allowed' (green), 'denied' (amber) or 'escalated' (red: it went to Matt, decision 31).
  spark(kind = 'allowed', angle = -0.6) {
    const c = SPARK_COLOR[kind] || COLORS.good, L = this.light;
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
    this.lvx -= ca * 0.4; this.lvy -= sa * 0.4;   // the swarm recoils from the strike
  }

  // The role passes to a new holder: a gold flash that throws the swarm out; the lit core then runs to the new holder's.
  handoff() {
    this.flash = 1;
    this.kv += 2.5;
    this.events.push({ type: 'handoff', t0: this.t, angle: 0, col: GOLD });
    if (this.events.length > 4) this.events.shift();
  }

  retire() { this.flash = Math.max(this.flash, 0.6); this.kv -= 2; }

  // A pulse leaves the core toward (dx, dy) on screen: the swarm leans after it.
  burst(dx, dy) { const len = Math.hypot(dx, dy) || 1; this.lvx += (dx / len) * 0.35; this.lvy += (dy / len) * 0.35; }

  // Something arrived at the core: a short glow and a small swell.
  absorb() { this.flash = Math.max(this.flash, 0.3); this.kv += 0.5; }

  // ---------- time ----------
  // probe: false while the map holds the frame rate down on purpose (the strip runs at about 30 a second)
  step(dt, probe = true) {
    if (probe) this.probe(dt);
    dt = Math.min(dt, 0.05);
    this.t += dt;
    const P = this.P, G = this.G, k = 1 - Math.exp(-dt * 2.4), t = this.t;
    for (const key of KEYS) P[key] += (G[key] - P[key]) * k;
    this.flash *= Math.exp(-dt * 3);
    this.yaw += dt * (0.06 + 0.12 * P.speed);
    this.rot += dt * P.speed * (0.7 + 0.9 * P.energy);
    this.kv += (-30 * this.kick - 6 * this.kv) * dt; this.kick += this.kv * dt;
    this.lvx += (-22 * this.lx - 4 * this.lvx) * dt; this.lx += this.lvx * dt;
    this.lvy += (-22 * this.ly - 4 * this.lvy) * dt; this.ly += this.lvy * dt;
    while (this.events.length && t - this.events[0].t0 > 1.4) this.events.shift();
    // the gold pulse when a handoff is due: every two seconds it leaves the centre and the swarm swells after it
    const ph = (t % 2) / 2;
    if (P.due > 0.5 && ph < this.pulsePh) this.kv += 0.7;
    this.pulsePh = ph;
    this.stepSparks(dt);
  }

  // The frame-time probe. The screen's own pace is the 10th percentile of the last two seconds of frames (so a 30 Hz
  // screen reads as 30, and one short frame changes nothing). When frames run long for a second and a half, it tries
  // drawing a fifth fewer particles for two seconds and keeps the cut only if frames got shorter; if they did not, the
  // particles were not the cost, so it puts them back and leaves them until frames get clearly worse. When frames have
  // run well for four seconds it draws a little more again, up to the budget. It never chases more than ~58 a second.
  probe(raw) {
    if (!(raw > 0) || raw > 0.25) return;   // a hidden tab or a hiccup tells nothing
    this.ema += (raw - this.ema) * 0.06;
    const R = this.ring;
    R[this.ri] = raw; this.ri = (this.ri + 1) % R.length; this.rn = Math.min(this.rn + 1, R.length);
    if ((this.since += raw) > 0.5) { this.since = 0; this.ref = this.pace(); }
    if (this.trial) {
      if ((this.trial.left -= raw) > 0) return;
      if (this.ema > this.trial.ema * 0.93) { this.q = this.trial.q; this.floor = this.trial.ema; }   // the cut did not help
      this.trial = null; this.slow = 0; this.calm = -4;
      return;
    }
    const slowAt = Math.min(Math.max(this.ref * 1.35, 1 / 50), 1 / 40), fastAt = Math.max(this.ref * 1.15, 1 / 58);
    const slow = this.ema > slowAt && (!this.floor || this.ema > this.floor * 1.25);
    if (slow) { this.slow += raw; this.calm = 0; }
    else { this.slow = Math.max(0, this.slow - raw * 2); this.calm = this.ema < fastAt ? this.calm + raw : 0; }
    if (this.ema < slowAt) this.floor = 0;   // frames are fine again: a later slowdown may be the particles
    if (this.slow > 1.5 && this.q > Q_MIN) { this.trial = { q: this.q, ema: this.ema, left: 2 }; this.q = Math.max(Q_MIN, this.q * 0.8); this.slow = 0; }
    else if (this.calm > 4 && this.q < 1) { this.q = Math.min(1, this.q * 1.12); this.calm = 0; }
  }

  // The 10th percentile of the frames in the last two seconds.
  pace() {
    const R = this.ring, out = [];
    let sum = 0;
    for (let k = 1; k <= this.rn && sum < 2; k++) { const v = R[(this.ri - k + R.length) % R.length]; out.push(v); sum += v; }
    out.sort((a, b) => a - b);
    return out[Math.floor(out.length * 0.1)] || this.ref;
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

  // ---------- drawing ----------
  // The CPU particles around the swarm (motes, flare, sparks), written into `out` from slot `o`; returns the next free slot.
  // Also records where the core sits, for swarm().
  project(cx, cy, r, out, o) {
    this.cx = cx; this.cy = cy; this.r = r; this.out = out; this.o = o;
    this.cyw = Math.cos(this.yaw); this.syw = Math.sin(this.yaw);
    this.sizeK = clamp(r / 64, 0.48, 1.12);
    this.field();
    this.flare();
    this.sparkle();
    return this.o;
  }

  // What the GPU draws this frame: { count, u } with u the shader's uniforms. The count runs from the strip's budget to
  // the open map's with the core's size, times the probe's share; each particle is brightened as the count drops, so
  // the glow per pixel stays the same at any size and any count.
  swarm() {
    const B = this.budget, P = this.P, U = this.U, r = this.r;
    const rS = this.light ? 15 : 31, rO = this.light ? 52 : REF_R;
    const n = Math.max(400, Math.round(lerp(B.strip, B.open, clamp((r - rS) / (rO - rS), 0, 1)) * this.q));
    const sizeK = clamp(r / 90, 0.45, 1.15);
    U.uC[0] = this.cx; U.uC[1] = this.cy; U.uR = r; U.uSizeK = sizeK;
    U.uDens = Math.pow((REF_N * (r / REF_R) ** 2 * (REF_K / sizeK) ** 2) / n, 0.85);
    // time and turn are wrapped at a long period so the GPU's floats keep their precision on a map left open for days
    // (one small jump every half hour or so)
    U.uT = this.t % 1800; U.uRot = this.rot % (TAU * 400); U.uFill = P.fill; U.uHeat = P.heat; U.uSwirl = P.swirl; U.uEnergy = P.energy;
    U.uBright = P.bright; U.uGold = P.gold; U.uDue = P.due; U.uPh = this.pulsePh; U.uFlash = this.flash; U.uKick = this.kick;
    U.uLean[0] = this.lx; U.uLean[1] = this.ly;
    U.uHue[0] = P.hr; U.uHue[1] = P.hg; U.uHue[2] = P.hb;
    this.swarmOut.count = n;
    return this.swarmOut;
  }

  // The canvas fallback (no WebGL2): a sample of the swarm drawn on the CPU with the same maths. Returns the next free slot.
  cpuSwarm(out, o) {
    const { count, u } = this.swarm(), n = Math.max(100, Math.min(count, Math.round(this.budget.fallback * this.q)));
    this.seeds ||= swarmSeeds(this.budget.fallback);
    const dens = u.uDens;
    u.uDens = dens * Math.pow(count / n, 0.85);
    for (let i = 0; i < n; i++) swarmPoint(this.seeds, i, u, out, (o + i) * STRIDE);
    u.uDens = dens;
    return o + n;
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

  // What paintGlass() needs: colours, the handoff pulse and recent events.
  view() {
    const P = this.P, V = this.viewOut;
    V.hue[0] = P.hr; V.hue[1] = P.hg; V.hue[2] = P.hb;
    V.fill = P.fill; V.heat = P.heat; V.gold = P.gold; V.due = P.due; V.bright = P.bright; V.flare = P.flare;
    V.flash = this.flash; V.pulsePh = this.pulsePh; V.t = this.t; V.events = this.events;
    return V;
  }
}

// ---------- the glass, on the 2D canvas: a thin rim, the bright edge and the highlights; no body of its own ----------
const rgba = (c, a) => `rgba(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0},${a})`;
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const WHITE = [1, 1, 1];

// Draw the glass at (x, y) with radius r from a core's view(). `still` adds a red rim for the reduced-motion map when
// something waits on Matt, in case the still frame of particles could not be drawn.
export function paintGlass(c, x, y, r, v, { still = false } = {}) {
  const k = clamp(v.bright, 0.3, 1.1), hue = v.hue, t = v.t;
  c.save();
  c.lineCap = 'round'; c.lineJoin = 'round';

  // the edge that catches light (fresnel), brightest at the rim
  let g = c.createRadialGradient(x, y, r * 0.78, x, y, r);
  g.addColorStop(0, rgba(hue, 0)); g.addColorStop(0.82, rgba(hue, 0.05 * k)); g.addColorStop(1, rgba(mix(hue, WHITE, 0.5), 0.26 * k));
  c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
  // rim: its own line, lit gold as the handoff pulse reaches it, lit by sparks and handoffs
  const d = (v.pulsePh - 0.69) / 0.1, rimGold = Math.max(v.gold * 0.6, v.due * Math.exp(-d * d) * 0.9);
  const rimCol = mix(mix(hue, WHITE, 0.45), GOLD, rimGold);
  c.shadowColor = rgba(rimCol, 0.8); c.shadowBlur = r * (0.08 + 0.3 * rimGold + 0.4 * v.flash);
  c.strokeStyle = rgba(rimCol, clamp((0.45 + 0.4 * rimGold + 0.5 * v.flash) * k, 0, 1)); c.lineWidth = Math.max(0.8, r * 0.014);
  c.beginPath(); c.arc(x, y, r, 0, TAU); c.stroke();
  c.shadowBlur = 0;
  // the lamp's reflection inside the far wall, lower right
  c.strokeStyle = rgba(WHITE, 0.1 * k); c.lineWidth = r * 0.045;
  c.beginPath(); c.arc(x, y, r * 0.9, 0.3, 1.25); c.stroke();
  // light along the near edge, upper left
  c.strokeStyle = rgba(WHITE, 0.35 * k); c.lineWidth = Math.max(0.7, r * 0.024);
  c.beginPath(); c.arc(x, y, r * 0.94, 3.45, 4.4); c.stroke();
  // specular highlight: a soft window and a hot point
  c.save();
  c.translate(x - r * 0.4, y - r * 0.46); c.rotate(-0.66); c.scale(1, 0.5);
  g = c.createRadialGradient(0, 0, 0, 0, 0, r * 0.25);
  g.addColorStop(0, rgba(WHITE, 0.38 * k)); g.addColorStop(0.6, rgba(WHITE, 0.1 * k)); g.addColorStop(1, rgba(WHITE, 0));
  c.fillStyle = g; c.beginPath(); c.arc(0, 0, r * 0.25, 0, TAU); c.fill();
  c.restore();
  c.fillStyle = rgba(WHITE, 0.85 * k); c.beginPath(); c.arc(x - r * 0.48, y - r * 0.5, Math.max(0.7, r * 0.024), 0, TAU); c.fill();

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

  if (still && v.flare > 0.5) {
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
