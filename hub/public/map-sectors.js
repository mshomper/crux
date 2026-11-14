// The All projects map's drawing (decision 57 C): projects as sectors of one ring around the Conductor in the opened
// map, and as labelled bays in the strip. The geometry comes from map-hub.js; this file draws it.
//   canvas - sector bands, tick scale, context gauge with the hand-off mark, worker dots, spokes, leader lines, the
//            red glow of a project waiting on you (decision 31's one exception: on this map a whole sector turns red)
//   DOM    - each project's robot with its red count, its label and its strip bay: buttons with a hover title that
//            open the project's orchestrator (data-pj), and "+N more" (data-open-all), which opens All projects
// Nothing animates under prefers-reduced-motion: the still map draws the same picture at t = 0.

import { robot } from './robots.js';
import { hueOf, rgb01 } from './models.js';
import { clamp, lerp } from './map-layout.js';
import { COLORS, TONE } from './map-particles.js';
import { RING, LABEL, labelLines, projectTitle } from './map-hub.js';

const TAU = Math.PI * 2;
const GOLD = [0.96, 0.79, 0.42];
const NEAR = 8;   // points before the hand-off where the gauge turns gold (as the context ring in All projects)
const rgb = (c, a) => `rgba(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0},${a})`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const busy = s => s === 'working' || s === 'starting';
const hueRgb = model => rgb01(hueOf(model)) || COLORS.cyan;

export class SectorView {
  constructor(panel) {
    this.over = document.createElement('div');
    this.over.className = 'hub-over';
    panel.querySelector('.hud-stations').after(this.over);
    this.places = [];
    this.els = new Map();     // name -> { bay, bot, tag }
    this.moreEls = [];
    this.pings = new Map();   // name -> time of the last event from that project
  }

  // places: hubProjects(); the DOM for each is redrawn only when what it shows changes
  set(places) {
    this.places = places;
    const names = new Set(places.map(p => p.name));
    for (const [name, e] of this.els) if (!names.has(name)) { e.bay.remove(); e.bot.remove(); e.tag.remove(); this.els.delete(name); }
    for (const p of places) {
      let e = this.els.get(p.name);
      if (!e) {
        e = { bay: this.button('hb'), bot: this.button('hp-bot'), tag: this.button('hp-tag') };
        this.els.set(p.name, e);
      }
      const key = JSON.stringify([p.count, p.model, p.effort, p.state, p.ctx == null ? null : Math.round(p.ctx), p.retireAt, p.workers.length, p.workers.filter(w => busy(w.state)).length]);
      if (e.key === key) continue;
      e.key = key;
      const l = labelLines(p), hue = hueOf(p.model) || '#6fe3ff', title = projectTitle(p);
      const agent = { model: p.model, effort: p.effort, state: p.state === 'vacant' ? 'asleep' : p.state, role: 'orchestrator' };
      const bot = size => robot(agent, { size, needs: p.count > 0, cls: 'calm' });
      const pct = p.ctx == null ? 0 : clamp(p.ctx, 0, 100), near = p.ctx != null && p.ctx >= p.retireAt - NEAR;
      const badge = p.count ? `<span class="hb-n">${p.count}</span>` : '';
      for (const el of [e.bay, e.bot, e.tag]) {
        el.dataset.pj = p.name;
        el.title = title;
        el.setAttribute('aria-label', title);
        el.classList.toggle('hot', p.count > 0);
        el.classList.toggle('asleep', p.state === 'asleep' || p.state === 'vacant');
        el.style.setProperty('--h', hue);
      }
      e.bay.innerHTML = `${bot(28)}<span class="hb-t"><b>${esc(p.name)}</b><i>${esc(p.count ? `${p.count} waiting` : p.state === 'vacant' ? 'no orchestrator' : p.state)}</i>`
        + `<span class="hb-bar"><s style="width:${pct}%${near ? ';background:#f5c96a' : ''}"></s><u style="left:${clamp(p.retireAt, 0, 100)}%"></u></span></span>${badge}`;
      e.bot.innerHTML = bot(48) + badge;
      e.tag.innerHTML = `<b>${esc(l.name)}</b><span class="w">${esc(l.waiting)}</span><span class="m">${esc(l.model)}</span><span class="m">${esc(l.agents)}</span>`
        // the one-line fold: the name first (it never gives way), the count as a red number, else the state word,
        // which shortens if it must
        + `<span class="ln"><b>${esc(l.name)}</b>${p.count ? `<span class="n" aria-label="${p.count} waiting">${p.count}</span>` : `<span class="w">${esc(busy(p.state) ? 'working' : p.state === 'vacant' ? '–' : p.state)}</span>`}</span>`;
    }
  }

  button(cls) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = cls;
    this.over.append(el);
    return el;
  }

  // A logged event from a project: its robot flashes once.
  ping(name, now) { if (this.els.has(name)) this.pings.set(name, now); }

  hide() { this.over.hidden = true; }

  // Where each project sits right now (panel px), for the particle streams: its strip bay blended into its sector.
  anchors(L, H, e) {
    const out = new Map();
    for (const [k, s] of H.B.sectors.entries()) {
      const p = this.places[k]; if (!p) continue;
      const bay = H.bays.bays.find(b => b.i === k);
      const r = L.core.r, mid = (RING.inner + RING.outer) / 2 * r;
      const open = { x: L.core.x + Math.cos(s.mid) * mid, y: L.core.y + Math.sin(s.mid) * mid };
      const strip = bay ? { x: bay.x - H.o.x, y: bay.y - H.o.y } : open;
      out.set(p.name, { x: lerp(strip.x, open.x, e), y: lerp(strip.y, open.y, e), p });
    }
    return out;
  }

  // c: the HUD canvas (already scaled for the screen); L: the blended layout (panel px); H: { A, B, bays, o } from
  // map.js; e: 0 strip .. 1 open; t: seconds (0 when still); size: the panel's { w, h }.
  draw(c, { L, H, e, t, still, now, size }) {
    this.over.hidden = false;
    const stripA = clamp(1 - e * 2.6, 0, 1), openA = clamp((e - 0.35) / 0.5, 0, 1), tagA = clamp((e - 0.6) * 2.5, 0, 1);
    const pulse = still ? 0.6 : 0.5 + 0.5 * Math.sin(t * 4.2);
    c.save();
    c.lineCap = 'round';
    if (stripA > 0) this.drawStrip(c, L, H, stripA, t, still);
    if (openA > 0) this.drawRing(c, L, H, openA, pulse, t, still, now);
    c.restore();
    this.placeDom(L, H, { stripA, openA, tagA, size });
  }

  // The strip: a link from the core to each bay, red where that bay's project waits on you.
  drawStrip(c, L, H, a, t, still) {
    const core = L.core, y = core.y;
    for (const side of [1, -1]) {
      const list = H.bays.bays.filter(b => Math.sign(b.x - H.o.x - core.x) === side).sort((p, q) => side * (p.x - q.x));
      let from = core.x + side * core.r * 1.62;
      for (const b of list) {
        const p = this.places[b.i]; if (!p) continue;
        const x = b.x - H.o.x;
        c.strokeStyle = p.count ? rgb(COLORS.red, 0.5 * a) : rgb(hueRgb(p.model), 0.3 * a);
        c.lineWidth = p.count ? 1.6 : 1.1;
        c.beginPath(); c.moveTo(from, y); c.lineTo(x, y); c.stroke();
        if (p.count && !still) {
          c.setLineDash([2, 8]); c.lineDashOffset = t * 26;
          c.strokeStyle = rgb(COLORS.red, 0.85 * a);
          c.beginPath(); c.moveTo(from, y); c.lineTo(x, y); c.stroke();
          c.setLineDash([]);
        }
        from = x;
      }
    }
  }

  drawRing(c, L, H, a, pulse, t, still, now) {
    const core = L.core, r = core.r;
    const r1 = r * RING.inner, r2 = r * RING.outer, rg = r * RING.gauge, band = r2 - r1;
    const phone = H.phone;
    // a faint full ring under the sectors
    c.strokeStyle = rgb(COLORS.cyan, 0.12 * a); c.lineWidth = 1;
    c.beginPath(); c.arc(core.x, core.y, (r1 + r2) / 2, 0, TAU); c.stroke();
    const botR = this.botSize(r, phone) / 2;
    for (const s of H.B.sectors) {
      const p = this.places[s.i]; if (!p) continue;
      const hue = hueRgb(p.model), hot = p.count > 0, sleepy = p.state === 'asleep' || p.state === 'vacant';
      const tone = hot ? COLORS.red : hue;
      // the band
      c.beginPath(); c.arc(core.x, core.y, r2, s.a0, s.a1); c.arc(core.x, core.y, r1, s.a1, s.a0, true); c.closePath();
      const g = c.createRadialGradient(core.x, core.y, r1, core.x, core.y, r2);
      g.addColorStop(0, rgb(tone, 0.05 * a)); g.addColorStop(1, rgb(tone, (hot ? 0.24 : sleepy ? 0.08 : 0.14) * a));
      c.fillStyle = g; c.fill();
      c.lineWidth = hot ? 1.8 : 1.2;
      c.strokeStyle = hot ? rgb(COLORS.red, (0.6 + 0.35 * pulse) * a) : rgb(hue, (sleepy ? 0.35 : 0.6) * a);
      if (hot) { c.shadowColor = rgb(COLORS.red, 0.9 * a); c.shadowBlur = 12; }
      c.stroke(); c.shadowBlur = 0;
      // tick scale along the inner edge
      const ticks = Math.max(4, Math.round(s.span / 0.087));
      for (let k = 0; k <= ticks; k++) {
        const ang = s.a0 + (s.span * k) / ticks, major = k % 4 === 0;
        c.strokeStyle = rgb(hue, (major ? 0.5 : 0.22) * a); c.lineWidth = 1;
        c.beginPath(); c.moveTo(core.x + Math.cos(ang) * r1, core.y + Math.sin(ang) * r1);
        c.lineTo(core.x + Math.cos(ang) * (r1 + (major ? 6 : 3)), core.y + Math.sin(ang) * (r1 + (major ? 6 : 3))); c.stroke();
      }
      // context gauge just outside the band, with the hand-off mark (gold near it, as the context ring does)
      c.lineCap = 'butt';
      c.lineWidth = phone ? 3 : 4;
      c.strokeStyle = rgb([1, 1, 1], 0.07 * a);
      c.beginPath(); c.arc(core.x, core.y, rg, s.a0, s.a1); c.stroke();
      if (p.ctx != null) {
        const near = p.ctx >= p.retireAt - NEAR, col = near ? GOLD : hue;
        c.strokeStyle = rgb(col, 0.95 * a); c.shadowColor = rgb(col, 0.8 * a); c.shadowBlur = 8;
        c.beginPath(); c.arc(core.x, core.y, rg, s.a0, s.a0 + s.span * clamp(p.ctx, 0, 100) / 100); c.stroke(); c.shadowBlur = 0;
      }
      const am = s.a0 + s.span * clamp(p.retireAt, 0, 100) / 100;
      c.strokeStyle = rgb(GOLD, a); c.lineWidth = 2;
      c.beginPath(); c.moveTo(core.x + Math.cos(am) * (rg - 6), core.y + Math.sin(am) * (rg - 6)); c.lineTo(core.x + Math.cos(am) * (rg + 6), core.y + Math.sin(am) * (rg + 6)); c.stroke();
      c.lineCap = 'round';
      // workers: dots along the outer part of the band, either side of the robot, as many as fit
      const rd = r2 - band * 0.18, dr = phone ? 2.6 : clamp(band * 0.075, 2.6, 4.4);
      const step = Math.max((dr * 2 + 3) / rd, 0.06), clear = (botR + dr + 3) / rd;
      const per = Math.max(0, Math.floor((s.span / 2 - clear - dr / rd) / step) + 1);
      p.workers.slice(0, per * 2).forEach((w, k) => {
        const side = k % 2 ? -1 : 1, j = Math.floor(k / 2);
        const ang = s.mid + side * (clear + j * step);
        const x = core.x + Math.cos(ang) * rd, y = core.y + Math.sin(ang) * rd;
        const col = w.needs ? COLORS.red : hueRgb(w.model);
        c.beginPath(); c.arc(x, y, dr, 0, TAU);
        if (busy(w.state) || w.needs) { c.shadowColor = rgb(col, 0.9 * a); c.shadowBlur = 8; c.fillStyle = rgb(col, 0.95 * a); c.fill(); c.shadowBlur = 0; }
        else { c.fillStyle = rgb(col, 0.25 * a); c.fill(); c.strokeStyle = rgb(col, 0.9 * a); c.lineWidth = 1.2; c.stroke(); }
      });
      // spoke from the Conductor's ring to the sector, flowing toward you while the project waits on you
      const s0 = { x: core.x + Math.cos(s.mid) * r * 1.65, y: core.y + Math.sin(s.mid) * r * 1.65 };
      const s1 = { x: core.x + Math.cos(s.mid) * r1, y: core.y + Math.sin(s.mid) * r1 };
      c.strokeStyle = hot ? rgb(COLORS.red, 0.45 * a) : rgb(COLORS.cyan, (busy(p.state) ? 0.3 : 0.16) * a); c.lineWidth = 1;
      c.beginPath(); c.moveTo(s0.x, s0.y); c.lineTo(s1.x, s1.y); c.stroke();
      if (hot && !still) { c.setLineDash([2, 8]); c.lineDashOffset = t * 26; c.strokeStyle = rgb(COLORS.red, 0.85 * a); c.stroke(); c.setLineDash([]); }
      // a ping when an event lands from that project
      const pt = this.pings.get(p.name);
      if (pt != null && !still) {
        const u = clamp((now - pt) / 900, 0, 1);
        if (u < 1) {
          const bm = (r1 + r2) / 2;
          c.strokeStyle = rgb(TONE.reply, (1 - u) * 0.8 * a); c.lineWidth = 1.5 * (1 - u) + 0.5;
          c.beginPath(); c.arc(core.x + Math.cos(s.mid) * bm, core.y + Math.sin(s.mid) * bm, botR + 3 + u * 18, 0, TAU); c.stroke();
        } else this.pings.delete(p.name);
      }
    }
    // leader lines to the labels
    const o = H.o;
    const tagA = clamp((a - 0.5) * 2, 0, 1);
    if (tagA <= 0) return;
    // on a phone, labels stack in rows above and below the ring: a leader to a row further out would cross the row
    // nearer the ring, so leaders are drawn only where a label is alone on its side of its band; otherwise the rows
    // follow the ring's order, and every sector is tappable on its own
    const stack = l => `${l.align}:${l.y < core.y + o.y ? 'top' : 'bottom'}`;
    const counts = new Map();
    if (phone) for (const l of [...H.B.labels, ...H.B.more]) counts.set(stack(l), (counts.get(stack(l)) || 0) + 1);
    for (const l of H.B.labels) {
      if (phone && counts.get(stack(l)) > 1) continue;
      const s = H.B.sectors[l.i], p = this.places[l.i]; if (!s || !p) continue;
      const hue = hueRgb(p.model), hot = p.count > 0;
      const ox = core.x + Math.cos(s.mid) * (rg + 6), oy = core.y + Math.sin(s.mid) * (rg + 6);
      const ex = l.edge.x - o.x, ey = l.edge.y - o.y;
      c.strokeStyle = hot ? rgb(COLORS.red, 0.7 * tagA) : rgb(hue, 0.5 * tagA); c.lineWidth = 1;
      c.beginPath(); c.moveTo(ox, oy);
      if (!phone) c.lineTo(ex + (l.align === 'left' ? -26 : 26), ey);
      c.lineTo(ex, ey); c.stroke();
      c.fillStyle = hot ? rgb(COLORS.red, 0.9 * tagA) : rgb(hue, 0.9 * tagA);
      c.beginPath(); c.arc(ox, oy, 2.2, 0, TAU); c.fill();
    }
  }

  // the crowned helmet fills about two thirds of its 48-grid box, so the box may overhang the band a little
  botSize(r, phone) { return Math.round(clamp((RING.outer - RING.inner) * r * 1.1, phone ? 20 : 24, phone ? 36 : 60)); }

  placeDom(L, H, { stripA, openA, tagA }) {
    const o = H.o, core = L.core, r = core.r, phone = H.phone;
    const S = phone ? LABEL.phone : LABEL.desk;
    const bm = (RING.inner + RING.outer) / 2 * r;
    const bs = this.botSize(r, phone);
    const show = (el, a) => { el.style.opacity = a >= 1 ? '' : a.toFixed(3); el.style.visibility = a < 0.05 ? 'hidden' : ''; el.classList.toggle('off', a < 0.5); };
    const bays = new Map(H.bays.bays.map(b => [b.i, b]));
    const labels = new Map(H.B.labels.map(l => [l.i, l]));
    this.places.forEach((p, i) => {
      const e = this.els.get(p.name); if (!e) return;
      // strip bay
      const b = bays.get(i);
      if (b) {
        e.bay.className = e.bay.className.replace(/\b(full|icon|dot)\b/g, '').trim() + ' ' + b.mode;
        e.bay.style.transform = `translate3d(${(b.x - o.x).toFixed(1)}px,${(b.y - o.y).toFixed(1)}px,0) translate(-50%,-50%)`;
        e.bay.style.width = b.mode === 'full' ? `${Math.round(b.w)}px` : '';
        show(e.bay, stripA);
      } else show(e.bay, 0);
      // robot in its sector
      const s = H.B.sectors[i];
      if (s) {
        e.bot.style.setProperty('--bs', `${bs}px`);
        e.bot.style.transform = `translate3d(${(core.x + Math.cos(s.mid) * bm).toFixed(1)}px,${(core.y + Math.sin(s.mid) * bm).toFixed(1)}px,0) translate(-50%,-50%)`;
        show(e.bot, openA);
      } else show(e.bot, 0);
      // label
      const l = labels.get(i);
      if (l) {
        const w = l.width || S.width, h = l.mode === 'full' ? S.full : S.line;
        e.tag.classList.toggle('line', l.mode !== 'full');
        e.tag.classList.toggle('r', l.align === 'right');
        e.tag.classList.toggle('ph', !!phone);
        Object.assign(e.tag.style, { width: `${Math.round(w)}px`, height: `${h - 6}px`,
          transform: `translate3d(${((l.align === 'left' ? l.x : l.x - w) - o.x).toFixed(1)}px,${(l.y - h / 2 + 3 - o.y).toFixed(1)}px,0)` });
        show(e.tag, tagA);
      } else show(e.tag, 0);
    });
    // "+N more": in the strip and beside the ring, opening All projects
    const more = [...(H.bays.more ? [{ ...H.bays.more, strip: true }] : []), ...H.B.more];
    while (this.moreEls.length < more.length) { const el = this.button('hp-more'); el.dataset.openAll = ''; this.moreEls.push(el); }
    this.moreEls.forEach((el, k) => {
      const m = more[k];
      if (!m) return show(el, 0);
      const names = m.of.map(i => this.places[i]?.name).filter(Boolean);
      const text = m.strip ? `+${m.n}` : `+${m.n} more`;
      if (el.textContent !== text) el.textContent = text;
      // All projects is already the column in focus: a click closes the map (or, in the strip, leaves you there)
      el.title = m.strip ? `${names.join(', ')}: in the All projects list below` : `${names.join(', ')}: close the map to see ${m.n === 1 ? 'it' : 'them'} in All projects`;
      el.classList.toggle('strip', !!m.strip);
      el.classList.toggle('r', m.align === 'right');
      el.classList.toggle('hot', m.of.some(i => this.places[i]?.count > 0));
      if (m.strip) {
        el.style.width = ''; el.style.height = '';
        el.style.transform = `translate3d(${(m.x - o.x).toFixed(1)}px,${(m.y - o.y).toFixed(1)}px,0) translate(-50%,-50%)`;
        show(el, stripA);
      } else {
        const w = m.width || S.width;
        Object.assign(el.style, { width: `${Math.round(w)}px`, height: `${S.line - 6}px`,
          transform: `translate3d(${((m.align === 'left' ? m.x : m.x - w) - o.x).toFixed(1)}px,${(m.y - S.line / 2 + 3 - o.y).toFixed(1)}px,0)` });
        show(el, tagA);
      }
    });
  }
}

// The Conductor's numbers for the core's readout and the telemetry card. c: /api/state's conductor (null without one).
export function conductorCore(c) {
  // mode stays 'auto': the Conductor answers no permission requests, so its glass shows no Ask field
  if (!c) return { holder: null, generation: '', state: 'vacant', ctx: null, retireAt: 60, needs: false, waiting: 0, activity: '', model: null, effort: null, mode: 'auto', role: 'conductor' };
  return {
    holder: c.name || null, generation: '', state: c.name ? (c.retiring ? 'writing' : c.state || 'asleep') : 'asleep', ctx: c.contextPct ?? null,
    // its activity line arrives as "conductor-1: Reading atlas"; the name is shown beside it already
    retireAt: Number(c.retireAt) || 60, needs: (c.waiting || 0) > 0, waiting: c.waiting || 0,
    activity: String(c.activity || '').replace(c.name ? new RegExp(`^${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*`) : /^$/, ''),
    model: c.model || c.modelSeen || null, effort: c.effort || null, mode: 'auto', role: 'conductor'
  };
}
