// The left sidebar's width: drag the seam to widen it (desktop with a mouse only), double-click it for the default.
// The width is kept across reloads; the conversation takes the rest. The phone layout never uses this.

export const SIDE_DEFAULT = 268;     // today's width, and the narrowest it goes
export const SIDE_MAX_SHARE = 0.4;   // at most this share of the window

// The widest the sidebar may be in a window this wide (never under the default).
export const sideMax = viewport => Math.max(SIDE_DEFAULT, Math.floor(viewport * SIDE_MAX_SHARE));
export const clampSide = (w, viewport) => Math.round(Math.min(sideMax(viewport), Math.max(SIDE_DEFAULT, w)));

// A stored width read back: anything that is not a number means the default (null: nothing to set).
export function storedSide(raw, viewport) {
  const w = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(w)) return null;
  return clampSide(w, viewport);
}

const KEY = 'crux-hub:side-width';

export class SideResizer {
  // app: the grid that holds the sidebar; grip: the thin strip on the seam; canResize: a media query (desk + mouse).
  constructor({ app, grip, canResize, onResize = () => { } }) {
    Object.assign(this, { app, grip, canResize, onResize });
    this.wanted = this.read();   // what you chose; shown clamped to the window
    this.drag = null;
    this.frame = 0;
    grip.addEventListener('pointerdown', e => this.down(e));
    grip.addEventListener('pointermove', e => this.move(e));
    grip.addEventListener('pointerup', e => this.up(e));
    grip.addEventListener('pointercancel', e => this.up(e));
    grip.addEventListener('lostpointercapture', e => this.up(e));
    grip.addEventListener('dblclick', () => this.reset());
    addEventListener('resize', () => this.apply());
    canResize.addEventListener?.('change', () => this.apply());
    this.apply();
  }
  read() { try { return storedSide(localStorage.getItem(KEY), Infinity); } catch { return null; } }
  save(w) { try { w == null ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, String(w)); } catch { } }
  set(w) {
    if (w == null || !this.canResize.matches) this.app.style.removeProperty('--side-w');
    else this.app.style.setProperty('--side-w', `${clampSide(w, innerWidth)}px`);
  }
  apply() { this.set(this.wanted); this.onResize(); }

  down(e) {
    if (e.button !== 0 || !this.canResize.matches) return;
    e.preventDefault();   // no text selection, no focus jump
    this.grip.setPointerCapture(e.pointerId);
    this.drag = { id: e.pointerId, x: e.clientX, w: this.app.querySelector('.side').getBoundingClientRect().width };
    document.documentElement.classList.add('side-resizing');
  }
  move(e) {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.next = clampSide(this.drag.w + e.clientX - this.drag.x, innerWidth);
    this.frame ||= requestAnimationFrame(() => { this.frame = 0; this.set(this.next); });   // one layout per frame
  }
  up(e) {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.drag = null;
    document.documentElement.classList.remove('side-resizing');
    if (this.next != null) { this.wanted = this.next === SIDE_DEFAULT ? null : this.next; this.next = null; this.save(this.wanted); this.apply(); }
  }
  reset() { this.wanted = null; this.save(null); this.apply(); }
}
