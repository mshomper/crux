// Look A's hero: the Hub's own live core (copied from hub/public, unchanged) with three worker stations.
// Under prefers-reduced-motion it draws one still frame and stops.
import { ReservoirCore, stream } from './core/map-core.js';
import { createRenderer } from './core/map-gl.js';
import { HudPainter } from './core/map-hud.js';
import { STRIDE, bend } from './core/map-particles.js';

class HeroCore {
  constructor(el) {
    this.el = el;
    this.glow = el.querySelector('#core-glow');
    this.lines = el.querySelector('#core-lines');
    this.still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.core = new ReservoirCore({ light: innerWidth <= 860, seed: 11 });
    this.mood = { state: 'working', ctx: 42, model: 'claude-opus-5-5', effort: 'high' };
    this.core.setMood(this.mood);
    this.core.settle();
    this.renderer = createRenderer(this.glow);
    this.hud = new HudPainter(this.lines);
    this.buf = new Float32Array((this.core.capacity + 120) * STRIDE);
    // angle (radians, 0 = right, clockwise on screen), colour, and whether a stream of particles runs to it
    this.stations = [
      { a: -2.5, rgb: '111,227,255', flow: true },
      { a: -0.42, rgb: '242,114,122', flow: false },
      { a: 1.12, rgb: '95,211,174', flow: true }
    ];
    this.labels = [...el.querySelectorAll('.callout.st')];
    this.coreLabel = el.querySelector('.c-core');
    new ResizeObserver(() => this.layout()).observe(el);
    this.layout();
    if (this.still) { for (let k = 0; k < 420; k++) { this.core.step(1 / 60); if (k >= 380) this.draw(0.66); } this.paint(7); return; }
    let last = performance.now();
    const frame = now => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      this.core.step(dt); this.draw(0.66); this.paint(now / 1000);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  layout() {
    const w = this.el.clientWidth, h = this.el.clientHeight, phone = w < 520;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = w; this.h = h; this.dpr = dpr;
    this.renderer.resize(w, h, dpr);
    this.hud.resize(w, h, dpr);
    const r = Math.min(w / (phone ? 4.6 : 4.5), h / 4.9);
    this.t = { x: w / 2, y: h / 2 + 8, r };
    const reach = r * (phone ? 2.02 : 2.12);
    this.stations.forEach((s, i) => {
      s.x = this.t.x + Math.cos(s.a) * reach * (phone ? 1 : 1.08);
      s.y = this.t.y + Math.sin(s.a) * reach * (phone ? 0.92 : 0.9);
      s.r = phone ? 9 : 13;
      const lab = this.labels[i];
      lab.style.left = Math.max(56, Math.min(w - 56, s.x)) + 'px';
      lab.style.top = (s.y + s.r + 12) + 'px';
    });
    this.coreLabel.style.left = this.t.x + 'px';
    this.coreLabel.style.top = Math.max(0, this.t.y - r * 1.9 - 46) + 'px';
    if (this.still) { this.draw(0.66); this.paint(7); }
  }

  draw(trail) {
    const t = this.t;
    let o = this.core.project(t.x, t.y, t.r, this.buf, 0);
    this.stations.forEach((s, k) => {
      if (!s.flow) return;
      const via = bend(t, s, 0.17, 60), len = Math.hypot(s.x - t.x, s.y - t.y);
      o = stream(this.buf, o, t, via, s, this.core.t, this.core.look.hue, { u0: Math.min(0.5, t.r * 1.05 / len), u1: 1 - (s.r + 3) / len, n: 9, pace: 0.25 + 0.4 * this.core.look.energy, seed: k * 0.37 });
    });
    this.renderer.draw(this.buf, o, trail);
  }

  paint(time) {
    const c = this.hud.c, t = this.t;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    c.lineCap = 'round';
    const f = { L: { core: t, at: new Map() }, e: 1, t: time, boot: 1, core: { state: this.mood.state }, glass: this.core.view(), staticCore: this.still };
    this.hud.aura(f); this.hud.glass(f); this.hud.rings(f);
    for (const s of this.stations) {
      // a faint link, then the station: a ring, a lit centre, a slow turning arc
      c.strokeStyle = `rgba(${s.rgb},.16)`; c.lineWidth = 1; c.setLineDash([2, 6]);
      const d = Math.hypot(s.x - t.x, s.y - t.y), ux = (s.x - t.x) / d, uy = (s.y - t.y) / d;
      c.beginPath(); c.moveTo(t.x + ux * t.r * 1.95, t.y + uy * t.r * 1.95); c.lineTo(s.x - ux * (s.r + 8), s.y - uy * (s.r + 8)); c.stroke();
      c.setLineDash([]);
      const g = c.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 3);
      g.addColorStop(0, `rgba(${s.rgb},.3)`); g.addColorStop(1, `rgba(${s.rgb},0)`);
      c.fillStyle = g; c.beginPath(); c.arc(s.x, s.y, s.r * 3, 0, 6.2832); c.fill();
      c.strokeStyle = `rgba(${s.rgb},.85)`; c.lineWidth = 1.4;
      c.beginPath(); c.arc(s.x, s.y, s.r, 0, 6.2832); c.stroke();
      c.fillStyle = `rgba(${s.rgb},.9)`; c.beginPath(); c.arc(s.x, s.y, s.r * 0.36, 0, 6.2832); c.fill();
      c.strokeStyle = `rgba(${s.rgb},.5)`; c.lineWidth = 1;
      const a0 = time * 0.5 + s.a;
      c.beginPath(); c.arc(s.x, s.y, s.r + 5, a0, a0 + 1.9); c.stroke();
    }
  }
}

const el = document.querySelector('.hero-core');
if (el && document.documentElement.dataset.look === 'a') {
  try { new HeroCore(el); } catch (e) { console.error(e); el.classList.add('no-core'); }
}
