// Crux hub live map (decision 0017): an always-on strip over the conversation that zooms into
// the centre of the screen as the full map when you engage it.
//   centre   - the orchestrator role as a glass sphere of liquid light (map-core.js, M013): level = context
//              used, hue = model, stir = effort and state, red flare = waiting on you, sparks = permission
//              answers; nothing is written on it, the numbers are in its hover or tap readout
//   stations - workers, plus You and the Board; red when something needs you
//   pulses   - messages, summaries, board posts, picks and approvals flying along the edges
// Driven by the hub's SSE events. With prefers-reduced-motion it draws a still map.
//
// All projects (decision 57 C): while the All projects column is the one in focus, the map shows the whole hub
// instead: the Conductor is the core, every project is a sector of one ring around it (map-hub.js, map-sectors.js),
// and in the strip each project is a labelled bay. A project opens its orchestrator. In a project's own map an ALL
// button at the strip's left end (the Conductor's halo and the hub's red total) goes back up.

import { MapModel } from './map-model.js';
import { stripLayout, stripLane, radialLayout, blendLayouts, easeInOut, clamp, lerp } from './map-layout.js';
import { Effects, STRIDE, bend } from './map-particles.js';
import { ReservoirCore, stream } from './map-core.js';
import { createRenderer } from './map-gl.js';
import { HudPainter } from './map-hud.js';
import { NeedsPopover } from './map-needs.js';
import { CoreReadout, coreReadout, conductorReadout } from './map-readout.js';
import { hueOf, rgb01, describe } from './models.js';
import { robot, robotKey, conductorBot } from './robots.js';
import { hubLayout, hubBays, hubFeed } from './map-hub.js';
import { SectorView, conductorCore } from './map-sectors.js';

const ICON = {
  agent: '<rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 4v3M9.5 12h.01M14.5 12h.01"/>',
  you: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1.2-3.6 4-5.5 7-5.5s5.8 1.9 7 5.5"/>',
  board: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15M14.5 4.5v15"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  ghost: '<circle cx="12" cy="6" r="2.5"/><circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M11 8.2L7.2 14.8M13 8.2l3.8 6.6"/>'
};
const svg = (name, cls = 'hud-i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DUR = 0.62;           // seconds for the zoom
const GLYPHS = '█▓▒░<>/\\|=+*#01';

export class LiveMap {
  constructor(slot, { open, openIn } = {}) {
    this.slot = slot;
    this.openThread = open || (() => {});
    this.openIn = openIn || (() => {});   // (project name, thread): a project on the All projects map
    this.hubMode = false;
    this.places = [];
    this.model = new MapModel();
    this.reducedMq = matchMedia('(prefers-reduced-motion: reduce)');
    this.phoneMq = matchMedia('(max-width: 720px)');
    this.e = 0;
    this.target = 0;
    this.boot = 1;
    this.workers = [];
    this.hidden = 0;
    this.info = new Map();
    this.stationEls = new Map();
    this.leaving = new Map();
    this.entering = new Map();
    this.feedKey = '';
    this.last = performance.now();
    this.needsPop = new NeedsPopover({ open: t => this.go(t) });
    this.readout = new CoreReadout({ open: () => this.go(this.coreThread) });
    this.build();
    this.sectors = new SectorView(this.panel);
    this.hud = new HudPainter(this.lineCanvas);
    this.core = new ReservoirCore({ light: this.phone });   // a phone carries about a third of the particles
    this.fx = new Effects();
    this.buf = new Float32Array((this.core.capacity + 700 + 12 * 9) * STRIDE);
    this.setMotion();
    this.reducedMq.addEventListener('change', () => this.setMotion());
    addEventListener('resize', () => this.reduced && this.drawStatic());
    addEventListener('keydown', e => { if (e.key === 'Escape' && this.target === 1) this.collapse(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.kick(); });
    const ro = new ResizeObserver(() => this.reduced ? this.drawStatic() : this.kick());
    ro.observe(slot);
    ro.observe(this.panel);   // the lane changes height when the row under it comes or goes: a still map redraws for that too
    if (new URLSearchParams(location.search).has('mapdebug')) window.__liveMap = this;
  }

  get phone() { return this.phoneMq.matches; }
  // Where the core opens: the orchestrator, or on the All projects map the column the Conductor's thread is pinned in.
  get coreThread() { return this.hubMode ? 'all' : 'orchestrator'; }
  get multi() { return (this.hub?.projects || 0) > 1; }
  get reduced() { return this.reducedMq.matches || !this.renderer; }

  setMotion() {
    if (!this.reducedMq.matches && !this.renderer) {
      try { this.renderer = createRenderer(this.glCanvas); } catch { this.renderer = null; }
    }
    this.panel.classList.toggle('still', this.reduced);
    this.reduced ? this.drawStatic() : this.kick();
  }

  // ---------- DOM ----------
  build() {
    this.slot.innerHTML = `
      <section class="hud" role="region" aria-label="Live map">
        <div class="hud-bg"></div>
        <canvas class="hud-lines" aria-hidden="true"></canvas>
        <canvas class="hud-glow" aria-hidden="true"></canvas>
        <div class="hud-stations"></div>
        <div class="hud-read hud-read-l">
          <span class="k">Latest</span>
          <span class="hud-ticker" data-r="ticker" aria-live="off"></span>
        </div>
        <div class="hud-read hud-read-r">
          <button class="hud-needs" data-needs></button>
        </div>
        <header class="hud-top">
          <div class="hud-title"><span class="hud-live"></span><b>Live map</b><span class="dim" data-r="proj"></span></div>
          <button class="hud-needs big" data-needs></button>
          <button class="hud-btn hud-close" aria-label="Close the live map">${svg('close')}</button>
        </header>
        <aside class="hud-tele">
          <div class="tele-holder"></div>
          <div class="tele-feed"><h3>Telemetry</h3><ol></ol></div>
        </aside>
        <button class="hud-btn hud-open" aria-label="Open the live map">${svg('expand')}</button>
        <button class="hud-up" data-up hidden></button>
        <i class="hud-corner tl"></i><i class="hud-corner tr"></i><i class="hud-corner bl"></i><i class="hud-corner br"></i>
        <div class="hud-scan"></div>
      </section>`;
    const q = s => this.slot.querySelector(s);
    this.panel = q('.hud');
    this.glCanvas = q('.hud-glow');
    this.lineCanvas = q('.hud-lines');
    this.stationsEl = q('.hud-stations');
    this.feedEl = q('.tele-feed ol');
    this.holderEl = q('.tele-holder');
    this.r = Object.fromEntries([...this.slot.querySelectorAll('[data-r]')].map(el => [el.dataset.r, el]));
    this.needsEls = [...this.slot.querySelectorAll('[data-needs]')];

    this.upEl = q('.hud-up');
    this.panel.addEventListener('click', e => {
      // decision 57 C: ALL goes up to every project; a project's bay, sector, label or telemetry line opens its
      // orchestrator; "+N more" opens the All projects column
      if (e.target.closest('[data-up]')) { this.needsPop.hide(); this.readout.hide(); return this.go('all'); }
      const pj = e.target.closest('[data-pj]');
      if (pj) { this.needsPop.hide(); this.readout.hide(); return this.goProject(pj.dataset.pj); }
      if (e.target.closest('[data-open-all]')) return this.go('all');
      const st = e.target.closest('.hs');
      // You: the first tap shows what is waiting, right here; a second tap opens Needs you.
      if (st?.dataset.id === 'you' && this.needsPop.count && this.needsPop.el.hidden) return this.needsPop.show();
      if (st) { this.needsPop.hide(); return this.go(st.dataset.thread); }
      if (e.target.closest('[data-needs]')) return this.go(this.multi ? 'all' : 'needs');
      if (e.target.closest('.hud-close')) return this.collapse();
      if (e.target.closest('.tele-feed li[data-thread]')) return this.go(e.target.closest('li').dataset.thread);
      if (this.target === 0) { this.readout.hide(); return this.expand(); }
      if (!this.overCore(e)) return this.readout.hide();
      // The core: with a mouse the readout is already showing, so a click opens the chat. A tap shows the
      // readout first; a second tap (or its button) opens the chat.
      if (this.touch && !this.readout.open) return this.showReadout();
      this.readout.hide();
      this.go(this.coreThread);
    });
    this.panel.addEventListener('pointerdown', e => { this.touch = e.pointerType !== 'mouse'; });
    this.panel.addEventListener('pointermove', e => {
      const over = this.overCore(e);
      this.panel.classList.toggle('over-core', this.target === 1 && over);
      if (e.pointerType !== 'mouse') return;
      // pointing at the core shows its numbers, in the strip and in the open map
      const on = this.overCore(e, 1.12) && !e.target.closest('.hs, button');
      if (on && !this.readout.open) this.showReadout();
      else if (!on && this.readout.open && !this.readoutClosing) { this.readoutClosing = true; this.readout.closeSoon(); }
      if (on) { this.readoutClosing = false; clearTimeout(this.readout.closeTimer); }
    });
    this.panel.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') this.readout.closeSoon(); });
  }

  overCore(e, k = 1.45) {
    if (!this.L) return false;
    const b = this.panel.getBoundingClientRect();
    const { x, y, r } = this.L.core;
    return Math.hypot(e.clientX - b.left - x, e.clientY - b.top - y) < r * k;
  }

  readoutData() {
    if (this.hubMode) return conductorReadout(this.coreInfo, { projects: this.places.length, waiting: this.hub?.total || 0 });
    const workers = this.workers.filter(w => w.kind === 'worker');
    const busy = workers.filter(a => ['working', 'starting'].includes(a.state)).length;
    return coreReadout(this.coreInfo || this.model.core(), { busy, resting: workers.length - busy });
  }

  showReadout() {
    if (!this.L) return;
    const b = this.panel.getBoundingClientRect();
    this.readoutClosing = false;
    this.readout.show(this.readoutData(), { x: b.left + this.L.core.x, y: b.top + this.L.core.y, r: this.L.core.r, under: this.target === 0 ? b.bottom : null });
  }

  go(thread) {
    if (!thread) return;
    this.openThread(thread);
    if (this.target === 1) this.collapse();
  }

  // A project on the All projects map: its orchestrator's chat, in that project (the strip then shows its own map).
  goProject(name) {
    if (!name) return;
    this.openIn(name, 'orchestrator');
    if (this.target === 1) this.collapse();
  }

  expand() {
    if (this.target === 1) return;
    this.target = 1;
    this.boot = 0;
    this.panel.classList.add('open');
    this.returnFocus = document.activeElement;
    this.reduced ? this.drawStatic() : this.kick();
    setTimeout(() => this.panel.querySelector('.hud-close')?.focus({ preventScroll: true }), 60);
  }

  collapse() {
    if (this.target === 0) return;
    this.target = 0;
    this.panel.classList.remove('open');
    this.reduced ? this.drawStatic() : this.kick();
    if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
  }

  // ---------- data in ----------
  set retireAt(v) { if (v) this.model.retireAt = Number(v); }

  // hub: { total, projects, approvals } across the hub (decision 42): with more than one project the Needs you counter
  // and the You station (its count and its popover) show every project and open All projects; the core and the
  // telemetry stay this project's.
  // With the All projects column in focus (decision 57 C), hub also carries mode: true, places (hubProjects) and
  // conductor (/api/state's conductor, or null): the map then shows the whole hub around the Conductor.
  update(project, pending, hub = null) {
    this.hub = hub;
    const hubMode = !!hub?.mode && (hub.places?.length || 0) > 1;
    if (hubMode !== this.hubMode) { this.hubMode = hubMode; this.panel.classList.toggle('hubmode', hubMode); this.readout.hide(); this.feedKey = ''; }
    this.places = hubMode ? hub.places : [];
    this.model.setProject(project, pending);
    let { list, hidden } = this.model.workers(this.phone ? 8 : 12);
    if (hubMode) { list = []; hidden = 0; }   // the hub map has no worker stations: workers are dots in their sector
    const now = performance.now();
    const ids = new Set(list.map(w => w.id));
    for (const w of this.workers) {
      if (!ids.has(w.id) && this.L?.at.get(w.id)) this.leaving.set(w.id, { pos: { ...this.L.at.get(w.id) }, t0: now, info: { ...this.info.get(w.id) } });
    }
    for (const w of list) if (!this.workers.some(x => x.id === w.id) && this.workers.length + this.info.size) this.entering.set(w.id, now);
    this.workers = list;
    this.hidden = hidden;
    const core = hubMode ? conductorCore(hub.conductor) : this.model.core();
    this.coreInfo = core;
    this.core.setMood(core);   // state, context, model, effort, waiting on you, Auto or Ask (see coreLook)
    if (this.readout.open) this.readout.set(this.readoutData());
    const needs = this.model.needsCount();
    const board = this.model.boardCounts();
    this.info = new Map(list.map(w => [w.id, w]));
    const you = this.multi ? this.hub.total : needs;
    this.info.set('you', { id: 'you', kind: 'you', name: 'You', thread: this.multi ? 'all' : 'needs', state: you ? 'needs' : 'idle', needs: you > 0, traffic: 0.5, sub: you ? `${you} waiting` : 'all clear' });
    // the Board belongs to one project: the hub map leaves it out
    if (!hubMode) this.info.set('board', { id: 'board', kind: 'board', name: 'Board', thread: 'board', state: 'idle', needs: false, traffic: 0.35, sub: `${board.decisions} decision${board.decisions === 1 ? '' : 's'} · ${board.entries} entr${board.entries === 1 ? 'y' : 'ies'}` });
    this.syncStations();
    if (hubMode) this.sectors.set(this.places);
    this.syncUp();
    this.needsPop.set(project, pending, needs, this.multi ? { approvals: this.hub.approvals || [], total: this.hub.total } : null);
    const youEl = this.stationEls.get('you');
    if (youEl) this.needsPop.attach(youEl);
    this.syncText(core, needs);
    this.syncFeed();
    if (this.reduced) this.drawStatic();
  }

  // The ALL button (decision 57 C): in a project's own map while the hub runs more than one project. The Conductor's
  // halo in its model's hue, the red total across the hub, and a click goes up to All projects.
  syncUp() {
    const show = !this.hubMode && this.multi;
    if (this.upEl.hidden === !show && !show) return;
    this.upEl.hidden = !show;
    this.panel.classList.toggle('up', show);
    if (!show) return;
    const c = this.hub?.conductor, n = this.hub?.total || 0;
    const agent = { model: c?.model || c?.modelSeen || null, effort: c?.effort || null, state: c?.name ? c.state : 'asleep', role: 'conductor' };
    const html = `<span class="up-ring"${hueOf(agent.model) ? ` style="--mh:${hueOf(agent.model)}"` : ''}>${conductorBot(agent, { size: 24, cls: 'calm' })}${n ? `<b class="up-n">${n}</b>` : ''}</span><i>All</i>`;
    if (this.upEl.dataset.html !== html) { this.upEl.dataset.html = html; this.upEl.innerHTML = html; }
    const tip = `All projects and the Conductor${n ? `: ${n} waiting for your call` : ''}`;
    if (this.upEl.title !== tip) { this.upEl.title = tip; this.upEl.setAttribute('aria-label', tip); }
  }

  event(project, ev) {
    if (this.hubMode) {
      // the hub map: a project's logged event flashes its sector; its own map keeps its feed up to date for later
      if (project && ev.logged) this.sectors.ping(project.name, performance.now());
      if (project && project.name === this.model.project?.name) this.model.ingest(ev);
      this.kick();
      return;
    }
    if (!project || project.name !== this.model.project?.name) return;
    const res = this.model.ingest(ev);
    if (this.reduced) return;
    const now = performance.now();
    for (const p of res.pulses) this.fx.addPulse(p, now);
    if (res.spin) this.fx.boost(res.spin, now);
    if (res.core === 'handoff') this.core.handoff();
    if (res.core === 'retire') this.core.retire();
    if (res.spark) {
      // a permission answer: a spark off the glass on the side of the worker that asked
      const s = res.spark.to && this.L?.at.get(res.spark.to), c = this.L?.core;
      this.core.spark(res.spark.kind, s && c ? Math.atan2(s.y - c.y, s.x - c.x) : -Math.PI / 2);
    }
    if (res.line) this.freshLine = res.line.id;
    this.kick();
  }

  // ---------- stations ----------
  syncStations() {
    const all = [...this.info.values(), ...[...this.leaving.entries()].map(([id, l]) => ({ ...l.info, id }))];
    const seen = new Set();
    for (const s of all) {
      if (!s?.id) continue;
      seen.add(s.id);
      let el = this.stationEls.get(s.id);
      if (!el) {
        el = document.createElement('button');
        el.type = 'button';
        el.dataset.id = s.id;
        el.innerHTML = `<span class="hs-body">${svg(s.kind === 'worker' ? 'agent' : s.kind)}<span class="hs-badge" hidden></span></span><span class="hs-label"><b></b><i></i></span>`;
        this.stationsEl.append(el);
        this.stationEls.set(s.id, el);
      }
      const sub = s.kind === 'ghost' ? 'handing over'
        : s.kind === 'worker' ? (s.needs ? 'needs you' : s.handoff === 'writing' ? 'writing handoff' : s.handoff === 'overlap' ? 'handing over' : s.activity || s.state) : s.sub;
      // Decision 31 and M008 8: only You turns fully red. A worker that is waiting on you keeps its model hue
      // and wears a red badge with how many things wait.
      const asking = s.kind === 'worker' && s.needs;
      const cls = `hs ${s.kind} ${s.state || ''} ${s.handoff ? 'handoff' : ''} ${s.needs ? (asking ? 'asks' : 'needs') : ''} ${this.leaving.has(s.id) ? 'leaving' : ''} ${this.entering.has(s.id) ? 'entering' : ''}`;
      // The station body takes its model's hue too (decision 20).
      const hue = s.kind === 'worker' ? hueOf(s.model) : null;
      const full = hue && !s.handoff && s.state !== 'error' ? `${cls} mh` : cls;   // handoff gold and the error amber win
      if (s.kind === 'worker') {   // its model family's robot (M015), redrawn only when its look changes
        const key = robotKey(s, asking);
        if (el.dataset.bot !== key) { el.dataset.bot = key; el.querySelector('.hs-body > svg').outerHTML = robot(s, { size: 28, needs: asking, cls: 'hud-i' }); }
      }
      const badge = el.querySelector('.hs-badge');
      const n = asking ? Math.max(1, s.asks || 0) : 0;
      if (badge && badge.textContent !== String(n || '')) { badge.textContent = n ? String(n) : ''; badge.hidden = !n; }
      if (el.className !== full) el.className = full;
      if ((el.style.getPropertyValue('--mh') || null) !== hue) hue ? el.style.setProperty('--mh', hue) : el.style.removeProperty('--mh');
      el.dataset.thread = s.thread;
      const label = s.kind === 'worker' || s.kind === 'ghost' ? s.name : s.name.toUpperCase();
      const b = el.querySelector('b'), i = el.querySelector('i');
      if (b.textContent !== label) b.textContent = label;
      if (i.dataset.text !== sub) this.decode(i, sub);
      const tip = s.kind === 'worker' ? `${s.name} (${describe(s)}): ${s.goal || s.state}` : s.kind === 'ghost' ? `${s.name}: ${s.goal || s.state}` : s.kind === 'you' ? (s.needs ? 'Point here to see and answer what is waiting' : 'Nothing waiting') : 'Open the memory board';
      if (el.title !== tip) { el.title = tip; el.setAttribute('aria-label', `${label}, ${sub}`); }
    }
    for (const [id, el] of this.stationEls) if (!seen.has(id)) { el.remove(); this.stationEls.delete(id); }
  }

  syncText(core, needs) {
    const st = core.state === 'writing' ? 'writing handoff' : core.state;
    // No generation, state or context numbers on screen (Matt, 2026-11-11): the sphere shows them and its readout spells them out.
    this.r.proj.textContent = this.hubMode ? '// all projects' : this.model.project ? `// ${this.model.project.name}` : '';
    // The counter: this project's count, or with several projects everything in the hub (decision 42).
    const multi = this.multi, count = multi ? this.hub.total : needs;
    const tip = multi
      ? (count ? `${count} waiting for your call across ${this.hub.projects} projects (${needs} here). Opens All projects` : `Nothing waiting in any of the ${this.hub.projects} projects. Opens All projects`)
      : (count ? `${count} waiting for your call` : 'Nothing waiting for you');
    for (const el of this.needsEls) {
      const html = count ? `${svg('alert')}<span>Needs you</span><b>${count}</b>` : `<span>All clear</span>`;
      if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
      el.classList.toggle('hot', count > 0);
      el.setAttribute('aria-label', tip);
      el.title = tip;
    }
    if (this.hubMode) return this.syncHubText(core);
    const workers = this.workers.filter(w => w.kind === 'worker');
    const busy = workers.filter(a => ['working', 'starting'].includes(a.state)).length;
    const holder = `
      <div class="th-k">Orchestrator role</div>
      <div class="th-name"><span>${esc(core.holder || 'No holder')}</span><span class="th-state ${esc(st)}">${esc(st)}</span></div>
      <div class="th-act">${core.activity ? `<span class="caret">&gt;</span> ${esc(core.activity)}` : core.state === 'vacant' ? 'Starts when you send a message' : 'Point at or tap the core for details'}</div>
      <div class="th-stats"><span><b>${busy}</b>working</span><span><b>${workers.length - busy}</b>resting</span><span class="${needs ? 'hot' : ''}"><b>${needs}</b>need you</span>${this.hidden ? `<span><b>+${this.hidden}</b>off map</span>` : ''}</div>`;
    if (this.holderEl.dataset.html !== holder) { this.holderEl.dataset.html = holder; this.holderEl.innerHTML = holder; }
    const top = this.model.feed[0];
    const tick = top ? `${top.actor} ▸ ${top.text}` : 'Waiting for activity';
    if (this.r.ticker.dataset.text !== tick) this.decode(this.r.ticker, tick);
  }

  // The hub map's telemetry: the Conductor's card, and the ticker on what it is doing (else the top project line).
  syncHubText(core) {
    const P = this.places, isBusy = s => s === 'working' || s === 'starting';
    const working = P.filter(p => isBusy(p.state) || p.workers.some(w => isBusy(w.state))).length;
    const waiting = this.hub?.total || 0;
    const st = !core.holder ? (core.state === 'vacant' ? 'not running' : 'asleep') : core.state === 'writing' ? 'writing handoff' : core.state;
    const holder = `
      <div class="th-k">Conductor</div>
      <div class="th-name"><span>${esc(core.holder || 'Conductor')}</span><span class="th-state ${esc(core.state)}">${esc(st)}</span></div>
      <div class="th-act">${core.activity ? `<span class="caret">&gt;</span> ${esc(core.activity)}` : core.holder ? 'Point at or tap the core for details' : 'Wakes when you write to it in All projects'}</div>
      <div class="th-stats"><span><b>${P.length}</b>projects</span><span><b>${working}</b>working</span><span class="${waiting ? 'hot' : ''}"><b>${waiting}</b>need you</span></div>`;
    if (this.holderEl.dataset.html !== holder) { this.holderEl.dataset.html = holder; this.holderEl.innerHTML = holder; }
    const top = hubFeed(P)[0];
    const tick = core.activity ? `Conductor ▸ ${core.activity}` : top ? `${top.name} ▸ ${top.text}` : 'Waiting for activity';
    if (this.r.ticker.dataset.text !== tick) this.decode(this.r.ticker, tick);
  }

  syncFeed() {
    if (this.hubMode) {
      // one line per project, those waiting on you first; a click opens its orchestrator
      const html = hubFeed(this.places).map(l => `<li class="tone-${esc(l.tone)}" data-pj="${esc(l.name)}" title="Open ${esc(l.name)}'s orchestrator"><time></time><b>${esc(l.name)}</b><span>${esc(l.text)}</span></li>`).join('')
        || '<li class="empty"><span>No projects yet.</span></li>';
      if (html !== this.feedKey) { this.feedKey = html; this.feedEl.innerHTML = html; }
      return;
    }
    const ago = ts => { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 50 ? 'now' : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
    const threadOf = l => l.actor === 'You' ? (l.target === 'orchestrator' ? 'orchestrator' : l.target) : /^orchestrator-/.test(l.actor) ? 'orchestrator' : this.model.project?.agents.some(a => a.name === l.actor) ? l.actor : '';
    const html = this.model.feed.map(l => {
      const t = threadOf(l);
      return `<li class="tone-${esc(l.tone)} ${l.id === this.freshLine ? 'fresh' : ''}" ${t && t !== 'you' ? `data-thread="${esc(t)}"` : ''}><time>${ago(l.ts)}</time><b>${esc(l.actor)}${l.target && l.target !== 'you' && l.kind === 'message' ? ` <em>▸ ${esc(l.target)}</em>` : ''}</b><span>${esc(l.text)}</span></li>`;
    }).join('') || '<li class="empty"><span>Nothing yet. Pulses and actions show up here.</span></li>';
    if (html !== this.feedKey) { this.feedKey = html; this.feedEl.innerHTML = html; }
    this.freshLine = null;
  }

  // Scramble-then-resolve text, the HUD's way of saying "this just changed".
  decode(el, text) {
    if (!el) return;
    text = String(text ?? '');
    if (el.dataset.text === text) return;
    el.dataset.text = text;
    clearInterval(el._dec);
    if (this.reduced || !el.dataset.seen) { el.textContent = text; el.dataset.seen = '1'; return; }
    let i = 0;
    const n = Math.min(text.length, 48);
    el._dec = setInterval(() => {
      i += Math.max(1, Math.ceil(n / 9));
      el.textContent = text.slice(0, i) + [...text.slice(i, n)].map(ch => ch === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0]).join('') + (n < text.length && i < n ? '' : text.slice(n));
      if (i >= n) { el.textContent = text; clearInterval(el._dec); }
    }, 28);
  }

  // ---------- geometry ----------
  geometry(E) {
    // on a phone the slot may keep a slim row under the lane for something else (data-under-row); the map stays out of it
    const s = stripLane(this.slot.getBoundingClientRect(), this.phone, !!this.slot.dataset.underRow);
    const app = this.slot.parentElement.getBoundingClientRect();
    const tgt = this.phone
      ? { left: 0, top: 0, width: innerWidth, height: innerHeight }
      : { left: s.left, top: s.top, width: s.width, height: Math.max(s.height, app.bottom - s.top) };
    const rect = E <= 0 ? { left: s.left, top: s.top, width: s.width, height: s.height }
      : { left: lerp(s.left, tgt.left, E), top: lerp(s.top, tgt.top, E), width: lerp(s.width, tgt.width, E), height: lerp(s.height, tgt.height, E) };
    return { slot: s, tgt, rect };
  }

  place(E) {
    const { slot, tgt, rect } = this.geometry(E);
    const docked = E <= 0 && this.target === 0;
    this.panel.classList.toggle('docked', docked);
    this.panel.classList.toggle('phone', this.phone);
    if (docked) this.panel.style.cssText = '';
    else Object.assign(this.panel.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
    this.panel.style.setProperty('--e', E.toFixed(3));
    const w = rect.width, h = rect.height;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.hud.resize(w, h, dpr);
    this.renderer?.resize(w, h, Math.min(dpr, 1.5));
    const origin = { x: rect.left, y: rect.top };
    let A, B, L;
    if (this.hubMode) {
      // decision 57 C: the Conductor and You in the strip, project bays either side; open, one sector per project
      A = stripLayout(slot, [], this.phone);
      const H = hubLayout(tgt, this.places, this.phone);
      B = { core: H.core, at: new Map([['you', H.you]]), labels: true, compact: false, reserve: H.reserve };
      L = blendLayouts(A, B, E, origin);
      L.at.delete('board');
      const board = A.at.get('board');   // the strip's right end: where the Board would sit, clear of the readout
      this.H = { A, B: H, bays: hubBays(slot, this.places, this.phone, { core: A.core, you: A.at.get('you'), rightEnd: board.x + board.r }), o: origin, phone: this.phone };
    } else {
      // the ALL button takes the strip's left end; You and the workers move over for it
      const lead = this.panel.classList.contains('up') ? (this.phone ? 30 : 52) : 0;
      A = stripLayout(lead ? { ...slot, left: slot.left + lead, width: slot.width - lead } : slot, this.workers, this.phone);
      B = radialLayout(tgt, this.workers, this.phone);
      L = blendLayouts(A, B, E, origin);
      this.H = null;
      this.sectors.hide();
    }
    L.bendMax = lerp(slot.height * 0.36, 420, E);
    this.panel.dataset.tele = B.reserve.tele;
    this.panel.classList.toggle('no-labels', !L.labels);
    this.panel.style.setProperty('--lw', Math.round(clamp(lerp(A.spacing - 10, 150, E), 40, 150)) + 'px');
    this.panel.style.setProperty('--cx', L.core.x.toFixed(1) + 'px');
    this.panel.style.setProperty('--cy', L.core.y.toFixed(1) + 'px');
    this.L = L;
    this.size = { w, h };
    return L;
  }

  // When a station joins or leaves, the others glide to their new places instead of jumping.
  glide(L, k) {
    this.smooth ||= new Map();
    for (const [id, s] of L.at) {
      const p = this.smooth.get(id);
      if (!p || k >= 1) { this.smooth.set(id, { ...s }); continue; }
      p.x += (s.x - p.x) * k; p.y += (s.y - p.y) * k; p.r += (s.r - p.r) * k;
      L.at.set(id, { ...p });
    }
    for (const id of this.smooth.keys()) if (!L.at.has(id)) this.smooth.delete(id);
  }

  // Leaving stations keep their last spot while they fade; entering ones fade in.
  withTransitions(L, now) {
    const info = new Map(this.info);
    for (const [id, l] of this.leaving) {
      const u = (now - l.t0) / 700;
      if (u >= 1) { this.leaving.delete(id); this.syncStations(); continue; }
      L.at.set(id, l.pos);
      info.set(id, { ...l.info, fade: 1 - u });
    }
    for (const [id, t0] of this.entering) {
      const u = (now - t0) / 700;
      if (u >= 1) { this.entering.delete(id); this.syncStations(); continue; }
      const s = info.get(id);
      if (s) info.set(id, { ...s, fade: u });
    }
    return info;
  }

  positionStations(L, info) {
    for (const [id, el] of this.stationEls) {
      const s = L.at.get(id);
      if (!s) { el.style.opacity = '0'; continue; }
      el.style.transform = `translate3d(${s.x.toFixed(1)}px,${s.y.toFixed(1)}px,0)`;
      el.style.setProperty('--r', s.r.toFixed(1) + 'px');
      const f = info.get(id)?.fade;
      el.style.opacity = f == null ? '' : String(clamp(f, 0, 1));
    }
  }

  // ---------- animation ----------
  kick() {
    if (this.reduced || this.running || document.hidden) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(t => this.frame(t));
  }

  frame() {
    if (document.hidden || this.reduced) { this.running = false; return; }
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.e !== this.target) this.e = clamp(this.e + Math.sign(this.target - this.e) * dt / DUR, 0, 1);
    const E = easeInOut(this.e);
    const zooming = this.e !== this.target || (this.e > 0 && this.e < 1);
    if (this.target === 1) this.boot = Math.min(1, this.boot + dt / 1.1);
    const L = this.place(E);
    this.glide(L, zooming ? 1 : 1 - Math.exp(-dt * 7));
    const info = this.withTransitions(L, now);
    this.core.step(dt);
    this.fx.step(dt, now,
      p => { if (p.from === 'core') { const b = L.at.get(p.to); if (b) this.core.burst(b.x - L.core.x, b.y - L.core.y); } },
      p => { if (p.to === 'core') this.core.absorb(); });
    let o = this.core.project(L.core.x, L.core.y, L.core.r, this.buf, 0);
    o = this.fx.project(this.buf, o, L, info, now, this.size.w, this.size.h, this.buf.length / STRIDE - 12 * 9);
    o = this.streams(o, L, info);
    try { this.renderer.draw(this.buf, o, zooming ? 0.35 : lerp(0.72, 0.6, E)); }
    catch (err) { console.warn('Live map renderer stopped:', err); this.renderer = null; this.setMotion(); return; }
    this.hud.paint({ L, e: E, t: now / 1000, boot: this.boot, core: this.coreInfo || this.model.core(), glass: this.core.view(), info, pings: this.fx.pings, now });
    if (this.H) this.sectors.draw(this.hud.c, { L, H: this.H, e: E, t: now / 1000, still: false, now, size: this.size });
    this.positionStations(L, info);
    if (now - (this.lastText || 0) > 1000) {
      this.lastText = now;
      // activity lines expire after a while; refresh the words without waiting for the next event
      if (this.model.project) { this.workers = this.workers.map(w => ({ ...w, activity: this.model.activityOf(w.id) })); for (const w of this.workers) this.info.set(w.id, w); this.syncStations(); this.syncFeed(); }
    }
    requestAnimationFrame(t => this.frame(t));
  }

  // Workers in flight: the core's own particles stream out along the spoke to every worker that is working.
  streams(o, L, info) {
    const hue = this.core.look?.hue;
    if (!hue) return o;
    let k = 0;
    if (this.H) {
      // the hub map: a short stream from the Conductor to every project that has work running (at most 8)
      const isBusy = s => s === 'working' || s === 'starting';
      for (const [, s] of this.sectors.anchors(L, this.H, easeInOut(this.e))) {
        if (k >= 8 || !(isBusy(s.p.state) || s.p.workers.some(w => isBusy(w.state)))) continue;
        const len = Math.hypot(s.x - L.core.x, s.y - L.core.y) || 1;
        o = stream(this.buf, o, L.core, bend(L.core, s, 0.08, L.bendMax), s, this.core.t, rgb01(hueOf(s.p.model)) || hue, {
          u0: Math.min(0.5, (L.core.r * 1.12) / len), u1: Math.max(0.55, 1 - 16 / len), n: L.core.r < 20 ? 4 : 5,
          pace: 0.25 + 0.4 * this.core.look.energy, seed: k++ * 0.37
        });
      }
      return o;
    }
    for (const [id, s] of L.at) {
      const st = info.get(id);
      if (!st || st.kind !== 'worker' || !['working', 'starting'].includes(st.state) || k >= 12) continue;
      const len = Math.hypot(s.x - L.core.x, s.y - L.core.y) || 1;
      o = stream(this.buf, o, L.core, bend(L.core, s, 0.17, L.bendMax), s, this.core.t, hue, {
        u0: Math.min(0.5, (L.core.r * 1.12) / len), u1: 1 - (s.r + 4) / len, n: L.core.r < 20 ? 5 : 9,
        pace: 0.25 + 0.4 * this.core.look.energy, seed: k++ * 0.37, alpha: st.fade ?? 1
      });
    }
    return o;
  }

  drawStatic() {
    this.e = this.target;
    const L = this.place(this.e);
    this.entering.clear(); this.leaving.clear();   // a still has no fades: stations are simply there or not
    const info = this.withTransitions(L, performance.now());
    this.renderer?.clear?.();
    this.core.settle();   // the still shows the sphere at its level, with no motion
    this.hud.paint({ L, e: this.e, t: 0, boot: 1, core: this.coreInfo || this.model.core(), glass: this.core.view(), info, pings: [], now: 0, staticCore: true });
    if (this.H) this.sectors.draw(this.hud.c, { L, H: this.H, e: this.e, t: 0, still: true, now: 0, size: this.size });
    this.positionStations(L, info);
  }
}
