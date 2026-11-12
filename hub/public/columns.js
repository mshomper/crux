// The conversation area as split columns (decision 39 A, R008): which threads are open, which column has the
// keyboard, how many fit the measured width, and the rail for pinned threads with no room. The rules themselves are
// in pins.js; this class keeps the state per project on this device (local storage, no server change), makes one
// Conversation per open thread and lays them out. With nothing pinned there is one column, as the hub always had.
import { Conversation } from './conversation.js';
import * as P from './pins.js';
import { HUB_THREAD } from './all-projects.js';

const STORE = 'columns';     // { [project]: pins state }
const HUB_PIN = 'hub-pinned';   // whether All projects (decision 42) is pinned: one answer for the whole hub
const NARROW = 760;          // a column narrower than this, beside others, gets the short message-box hint
const key = (p, t) => `${p}::${t}`;
const icon = id => `<svg class="icon"><use href="#i-${id}"/></svg>`;

export class Columns {
  // area: the element the columns share (its measured width decides how many fit); template: one conversation's
  // markup; winActs: the window's own buttons (bell, Board, All projects), kept in the right-most header;
  // host: what app.js knows and does (see app.js); store: local storage helper.
  constructor({ area, template, winActs, host, store, phoneMq, fineMq }) {
    Object.assign(this, { area, template, winActs, host, store, phoneMq, fineMq });
    const saved = store.get(STORE, {});
    this.states = saved && typeof saved === 'object' ? saved : {};
    this.checked = new Set();
    this.hubPinned = store.get(HUB_PIN, false) === true;
    this.synced = null;          // the project whose All projects pin last caught up with the hub's
    this.convs = new Map();      // "project::thread" -> Conversation, for every open thread (folded ones too)
    this.composes = new Map();   // "project::thread" -> { text, tray }: the draft stays with its thread
    this.sig = '';
    this.rail = document.createElement('nav');
    this.rail.className = 'pin-rail';
    this.rail.setAttribute('aria-label', 'Open threads with no room for a column');
    this.rail.addEventListener('click', e => { const b = e.target.closest('[data-rail]'); if (b) { this.showFolded(b.dataset.rail); host.changed(true); } });
    // What a conversation asks of its columns: the keyboard, its pin and close buttons; the rest goes to app.js.
    this.convHost = {
      ...host,
      focused: c => { if (this.focus(c.thread)) host.kbChanged(); },
      action: (name, c) => {
        if (name === 'pin') { this.isPinned(c.thread) ? this.unpin(c.thread) : this.pin(c.thread); return host.changed(); }
        if (name === 'close') { this.close(c.thread); return host.changed(); }
        host.action(name, c);
      }
    };
    // The sidebar is resizable and the board opens and closes: re-lay out whenever the area's width changes enough.
    new ResizeObserver(() => { if (this.measure().sig !== this.sig) host.render(); }).observe(area);
  }

  // ---------- state, per project ----------
  get project() { return this.host.proj()?.name || ''; }
  get state() {
    const p = this.project;
    if (!this.checked.has(p)) { this.states[p] = P.normalize(this.states[p], this.host.startThread()); this.checked.add(p); }
    if (this.synced !== p) { this.synced = p; this.syncHub(p); }
    return this.states[p];
  }
  set(s) {
    this.states[this.project] = s;
    this.store.set(STORE, this.states);
    this.store.set('thread', s.kb);   // the old single-thread key, kept meaningful
    // The project on screen decides whether All projects is pinned (a pin, an unpin, or a click that took its place).
    const hub = P.isPinned(s, HUB_THREAD);
    if (hub !== this.hubPinned) { this.hubPinned = hub; this.store.set(HUB_PIN, hub); }
  }
  // All projects is one column for the whole hub (decision 42): pinned in one project means pinned in every project.
  // Another project catches up the first time it is drawn after a switch, by the usual pin and unpin rules (R008, R010).
  syncHub(p) {
    const s = this.states[p];
    if (P.isPinned(s, HUB_THREAD) === this.hubPinned) return;
    this.states[p] = this.hubPinned ? P.pin(s, HUB_THREAD) : P.unpin(s, HUB_THREAD);
    this.store.set(STORE, this.states);
  }
  // On a phone (pins ignored) with every column pinned, a thread you open is shown on its own without touching the
  // pins; with a loose column (always, on a real phone) it replaces it as the one conversation always did.
  get phoneThread() { return this.phoneMq.matches && this.phoneT?.p === this.project ? this.phoneT.t : null; }
  get kb() { return this.phoneThread || this.state.kb; }
  isOpen(t) { return P.isOpen(this.state, t); }
  isPinned(t) { return P.isPinned(this.state, t); }
  shown() { return this.measure().shown; }
  open(t) {
    const s = this.state;
    if (this.phoneMq.matches && !P.isOpen(s, t) && s.cols.every(c => c.pinned)) { this.phoneT = { p: this.project, t }; return; }
    this.phoneT = null;
    this.set(P.open(s, t, this.shown())); this.markOpened(t);
  }
  pin(t) { const was = this.isOpen(t); this.set(P.pin(this.state, t)); if (!was) this.markOpened(t); }
  unpin(t) { this.set(P.unpin(this.state, t)); }
  close(t) { this.set(P.close(this.state, t)); }
  showFolded(t) { this.set(P.show(this.state, t, this.shown())); }
  // The keyboard moved to another column (a click or focus in it): only the marks change, nothing is redrawn,
  // so the click that moved it still lands.
  focus(t) {
    const s = this.state;
    if (s.kb === t || !P.isOpen(s, t)) return false;
    this.set(P.focus(s, t));
    for (const c of this.convs.values()) c.el.classList.toggle('kb', c.thread === t);
    return true;
  }
  // A thread opened (from the list, a card or the map), even one already on screen, goes to its latest message
  // (Needs you: to the top), as a click always did. A rail click instead shows a column where you left it.
  markOpened(t) { const c = this.convs.get(key(this.project, t)); if (c) c.justOpened = true; }

  // Switching projects never changes pins: that project's columns come back as they were. With nothing pinned there,
  // its orchestrator opens (Matt, 2026-11-11: a project opens on its orchestrator's chat).
  // All projects pinned (hub-wide, decision 42) does not count: the project still opens on its orchestrator beside it.
  projectOpened() { this.phoneT = null; if (!this.state.cols.some(c => c.pinned && c.t !== HUB_THREAD)) this.open('orchestrator'); }

  // Columns whose thread no longer exists here go, and the cleaned list is written back. `valid`: this project's
  // threads (Needs you, the orchestrator, every agent's thread, retired ones included). All projects is valid everywhere.
  prune(valid) {
    const ok = new Set([...valid, HUB_THREAD]), s = this.state;
    const next = P.prune(s, ok, this.host.startThread());
    if (next !== s) this.set(next);
    if (this.phoneT && !ok.has(this.phoneT.t)) this.phoneT = null;
  }

  // A notification's card, drawn in a column already on screen (Needs you first for a waiting card, then All projects,
  // then the card's own thread), or null. The page then uses that copy and leaves the layout alone.
  cardColumn(card, { waiting, thread }) {
    for (const t of waiting ? ['needs', HUB_THREAD, thread] : [thread]) { const c = t && this.visible(t); if (c?.findCard(card, this.project)) return c; }
    return null;
  }

  // ---------- conversations ----------
  conv(project, t) {
    const k = key(project, t);
    let c = this.convs.get(k);
    if (!c) {
      if (!this.composes.has(k)) this.composes.set(k, { text: '', tray: [] });
      c = new Conversation({ project, thread: t, template: this.template, host: this.convHost, compose: this.composes.get(k) });
      this.convs.set(k, c);
    }
    return c;
  }
  byEl(el) { for (const c of this.convs.values()) if (c.el === el) return c; return null; }
  // The conversation showing thread t on screen, or null.
  visible(t) { const c = this.convs.get(key(this.project, t)); return c?.el.isConnected ? c : null; }
  kbConv() { return this.visible(this.kb); }
  convAt(node) { const el = node?.closest?.('.conv'); return el ? this.byEl(el) : null; }
  all() { return [...this.convs.values()].filter(c => c.el.isConnected); }

  // ---------- layout ----------
  measure() {
    const phone = this.phoneMq.matches, n = this.state.cols.length;
    const width = this.area.clientWidth;
    const shown = phone ? 1 : P.fit(width, n);
    const railOn = !phone && shown < n;
    const multi = shown > 1 || railOn;   // a column beside the rail is a column like the others
    const narrow = multi && (width - (railOn ? P.RAIL_W : 0)) / shown < NARROW;
    return { phone, width, shown, railOn, multi, narrow, sig: `${phone}|${shown}|${railOn}|${narrow}` };
  }

  render() {
    const valid = this.host.threads?.();
    if (valid) this.prune(valid);
    const project = this.project, s = this.state, m = this.measure();
    this.sig = m.sig;
    let { visible, folded } = P.layout(s, m.shown);
    const pt = this.phoneThread;
    if (pt) { visible = [{ t: pt, pinned: false }]; folded = s.cols.filter(c => c.t !== pt); }
    else if (!m.phone) this.phoneT = null;
    const kb = pt || s.kb;
    // Conversations for this project's open threads; closed ones (and another project's) go; folded ones wait off the page.
    const open = new Set([...s.cols.map(c => key(project, c.t)), ...(pt ? [key(project, pt)] : [])]);
    for (const [k, c] of this.convs) if (!open.has(k)) { c.destroy(); this.convs.delete(k); }
    for (const c of folded) this.convs.get(key(project, c.t))?.detach();
    const els = visible.map(c => this.conv(project, c.t).el);
    if (m.railOn) els.push(this.rail); else this.rail.remove();
    els.forEach((el, i) => {
      const at = this.area.children[i];
      if (at === el) return;
      this.byEl(el)?.keepScroll();   // a moved list comes back where it was
      this.area.insertBefore(el, at || null);
    });
    for (const el of [...this.area.children].slice(els.length)) { const c = this.byEl(el); c ? c.detach() : el.remove(); }
    this.area.style.gridTemplateColumns = `repeat(${visible.length}, minmax(0, 1fr))${m.railOn ? ` ${P.RAIL_W}px` : ''}`;
    this.area.classList.toggle('multi', m.multi);
    const fine = this.fineMq.matches;
    for (const c of visible) this.convs.get(key(project, c.t)).render({ kb: c.t === kb, pinned: c.pinned, multi: m.multi, narrow: m.narrow, phone: m.phone, fine });
    // The window's own buttons sit in the right-most header, where they always were.
    const last = this.convs.get(key(project, visible.at(-1).t));
    if (this.winActs.parentElement !== last.acts) last.acts.append(this.winActs);
    if (m.railOn) this.renderRail(folded, s, m.shown);
  }

  // The rail: each folded thread's avatar and its red count; a click shows it in place of the least recently used column.
  renderRail(folded, s, shown) {
    const instead = P.replacedBy(s, shown);
    const html = `<span class="rail-k" title="Threads with no room for a column at this width">${icon('pin')}</span>`
      + folded.map(c => this.host.railItem(c.t, instead, c.pinned)).join('');
    if (this.rail.dataset.html !== html) { this.rail.dataset.html = html; this.rail.innerHTML = html; }
  }
}
