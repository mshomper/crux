// The conversation area as split columns (decision 39 A, R008): which threads are open, which column has the
// keyboard, how many fit the measured width, and the rail for pinned threads with no room. The rules themselves are
// in pins.js; this class keeps the state per project on this device (local storage, no server change), makes one
// Conversation per open thread and lays them out. With nothing pinned there is one column, as the hub always had.
import { Conversation } from './conversation.js';
import * as P from './pins.js';

const STORE = 'columns';     // { [project]: pins state }
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
    this.convs = new Map();      // "project::thread" -> Conversation, for every open thread (folded ones too)
    this.composes = new Map();   // "project::thread" -> { text, tray }: the draft stays with its thread
    this.sig = '';
    this.rail = document.createElement('nav');
    this.rail.className = 'pin-rail';
    this.rail.setAttribute('aria-label', 'Pinned threads with no room');
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
    return this.states[p];
  }
  set(s) {
    this.states[this.project] = s;
    this.store.set(STORE, this.states);
    this.store.set('thread', s.kb);   // the old single-thread key, kept meaningful
  }
  get kb() { return this.state.kb; }
  isOpen(t) { return P.isOpen(this.state, t); }
  isPinned(t) { return P.isPinned(this.state, t); }
  shown() { return this.measure().shown; }
  open(t) { this.set(P.open(this.state, t, this.shown())); this.markOpened(t); }
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
  // A thread opened again (from the list, a card or the map) starts at its latest message, as it always did.
  markOpened(t) { const c = this.convs.get(key(this.project, t)); if (c && !c.el.isConnected) c.justOpened = true; }

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
    const multi = shown > 1;
    const narrow = multi && (width - (railOn ? P.RAIL_W : 0)) / shown < NARROW;
    return { phone, width, shown, railOn, multi, narrow, sig: `${phone}|${shown}|${railOn}|${narrow}` };
  }

  render() {
    const project = this.project, s = this.state, m = this.measure();
    this.sig = m.sig;
    const { visible, folded } = P.layout(s, m.shown);
    // Conversations for this project's open threads; closed ones (and another project's) go; folded ones wait off the page.
    const open = new Set(s.cols.map(c => key(project, c.t)));
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
    for (const c of visible) this.convs.get(key(project, c.t)).render({ kb: c.t === s.kb, pinned: c.pinned, multi: m.multi, narrow: m.narrow, phone: m.phone, fine });
    // The window's own buttons sit in the right-most header, where they always were.
    const last = this.convs.get(key(project, visible.at(-1).t));
    if (this.winActs.parentElement !== last.acts) last.acts.append(this.winActs);
    if (m.railOn) this.renderRail(folded, s, m.shown);
  }

  // The rail: each folded thread's avatar and its red count; a click shows it in place of the least recently used column.
  renderRail(folded, s, shown) {
    const instead = P.replacedBy(s, shown);
    const html = `<span class="rail-k" title="Pinned threads with no room for a column at this width">${icon('pin')}</span>`
      + folded.map(c => this.host.railItem(c.t, instead)).join('');
    if (this.rail.dataset.html !== html) { this.rail.dataset.html = html; this.rail.innerHTML = html; }
  }
}
