// Phone check: a small readout of live screen numbers, for a screenshot from a real phone (phone pass 2).
// Off by default. On with ?debug=phone (remembered on that device) or from the hub menu; off with ?debug=off or
// the menu again. It never takes a tap: everything under it works as usual.
//
// It shows what Safari is doing: the visible area (visualViewport) and its zoom, the page width and the widest
// element sticking out past the screen edge (clipping ignored, since iPhone zoom does not always honour it), the
// focused box and its real font size, and a count of jumps: frames where the latest message moved on screen while
// no finger was down, each with what changed in that frame.

const KEY = 'crux-hub:debug-phone';
export const debugWanted = (search, stored) => {
  const v = new URLSearchParams(search).get('debug');
  if (v === 'phone') return true;
  if (v === 'off') return false;
  return stored === '1';
};

// One jump's story: the parts that changed between two frames, biggest first, in plain short words.
export function jumpCause(a, b) {
  const parts = [['view top', b.vvTop - a.vvTop], ['view height', b.vvH - a.vvH], ['app top', b.appTop - a.appTop], ['list scroll', b.scroll - a.scroll],
    ['list height', b.feedH - a.feedH], ['box height', b.boxH - a.boxH], ['page scroll', b.scrollY - a.scrollY], ['zoom', Math.round((b.scale - a.scale) * 100)]];
  const moved = parts.filter(([, d]) => Math.abs(d) >= 1).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
  return moved.length ? moved.map(([k, d]) => `${k} ${d > 0 ? '+' : ''}${Math.round(d)}`).join(' · ') : 'nothing measured changed';
}

// Expected moves are not jumps: the box gaining or losing a line (the list follows it by exactly that much), and the
// keyboard opening or closing (the visible height changes). Anything else that moves the latest message is a jump.
export function moveKind(a, b, dy) {
  const box = b.boxH - a.boxH;
  if (Math.abs(box) >= 1 && Math.abs(dy + box) < 2) return 'line';
  if (Math.abs(b.vvH - a.vvH) >= 40 || (Math.abs(b.feedH - a.feedH) >= 40 && Math.abs(box) < 1)) return 'keyboard';
  return 'jump';
}

// Elements that reach past the screen edge, ignoring clipping: the widest one, as "tag#id.class right-edge".
export function widestOutside(doc = document, W = innerWidth) {
  let worst = null;
  for (const el of doc.body.querySelectorAll('*')) {
    if (el.closest('.phone-check')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const over = Math.max(r.right - W, -r.left);
    if (over > 0.5 && (!worst || over > worst.over)) worst = { over, el, right: r.right, left: r.left };
  }
  if (!worst) return null;
  const e = worst.el, cls = typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
  return { label: `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${cls}`, over: Math.round(worst.over), left: Math.round(worst.left), right: Math.round(worst.right) };
}

export class PhoneCheck {
  constructor({ version = () => '' } = {}) {
    this.version = version;
    this.el = null;
    this.on = false;
    this.jumps = 0; this.expected = 0; this.zooms = 0; this.vvEvents = 0; this.maxScale = 1;
    this.log = [];
    this.touchUntil = 0;
  }

  static wanted() {
    let stored = null;
    try { stored = localStorage.getItem(KEY); } catch { }
    const on = debugWanted(location.search, stored);
    try { on ? localStorage.setItem(KEY, '1') : localStorage.removeItem(KEY); } catch { }
    return on;
  }

  toggle() { this.on ? this.stop() : this.start(); try { this.on ? localStorage.setItem(KEY, '1') : localStorage.removeItem(KEY); } catch { } }

  start() {
    if (this.on) return;
    this.on = true;
    this.el = document.createElement('div');
    this.el.className = 'phone-check';
    this.el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.el);
    const vv = window.visualViewport;
    this.onVv = () => { this.vvEvents++; };
    vv?.addEventListener('resize', this.onVv); vv?.addEventListener('scroll', this.onVv);
    this.onTouch = e => { this.touchUntil = e.type === 'touchend' || e.type === 'touchcancel' ? performance.now() + 1500 : Infinity; };
    for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) addEventListener(t, this.onTouch, { passive: true, capture: true });
    this.onFocus = () => { this.wide = widestOutside(); };
    addEventListener('focusin', this.onFocus);
    this.prev = this.sample();
    const frame = () => { if (!this.on) return; this.step(); this.raf = requestAnimationFrame(frame); };
    this.raf = requestAnimationFrame(frame);
    this.wide = widestOutside();
    this.timer = setInterval(() => { this.wide = widestOutside(); this.draw(); }, 1000);
    this.draw();
  }

  stop() {
    if (!this.on) return;
    this.on = false;
    cancelAnimationFrame(this.raf); clearInterval(this.timer);
    const vv = window.visualViewport;
    vv?.removeEventListener('resize', this.onVv); vv?.removeEventListener('scroll', this.onVv);
    for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) removeEventListener(t, this.onTouch, { capture: true });
    removeEventListener('focusin', this.onFocus);
    this.el?.remove(); this.el = null;
  }

  sample() {
    const vv = window.visualViewport || { width: innerWidth, height: innerHeight, offsetTop: 0, scale: 1 };
    const feed = document.getElementById('feed'), box = document.getElementById('input');
    const last = feed?.lastElementChild;
    const css = getComputedStyle(document.documentElement);
    return {
      vvW: vv.width, vvH: vv.height, vvTop: vv.offsetTop, scale: vv.scale || 1, scrollY,
      appTop: parseFloat(css.getPropertyValue('--app-top')) || 0,
      scroll: feed?.scrollTop || 0, feedH: feed?.clientHeight || 0, boxH: box?.offsetHeight || 0,
      lastY: last ? last.getBoundingClientRect().bottom : 0
    };
  }

  step() {
    const now = this.sample(), was = this.prev;
    this.prev = now;
    if (Math.abs(now.scale - was.scale) > 0.005) {
      this.zooms++;
      this.maxScale = Math.max(this.maxScale, now.scale);
      const f = document.activeElement;
      this.note(`zoom ×${now.scale.toFixed(2)}${f && f !== document.body ? ` on ${f.tagName.toLowerCase()}${f.id ? '#' + f.id : ''} ${getComputedStyle(f).fontSize}` : ''}`);
    }
    const dy = now.lastY - was.lastY;
    if (Math.abs(dy) >= 2 && performance.now() > this.touchUntil) {
      const kind = moveKind(was, now, dy);
      if (kind === 'jump') this.jumps++; else this.expected++;
      this.note(`${kind === 'jump' ? 'jump' : kind} ${dy > 0 ? '+' : ''}${Math.round(dy)}: ${jumpCause(was, now)}`);
    }
  }

  note(line) {
    this.log.unshift(`${new Date().toTimeString().slice(3, 8)} ${line}`);
    this.log.length = Math.min(this.log.length, 3);
    this.draw();
  }

  draw() {
    if (!this.el) return;
    const s = this.prev || this.sample();
    const f = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    const fr = f?.getBoundingClientRect();
    const root = document.documentElement;
    const rows = [
      `PHONE CHECK ${this.version()} · jumps ${this.jumps} · zooms ${this.zooms} (max ×${this.maxScale.toFixed(2)})`,
      `view ${Math.round(s.vvW)}×${Math.round(s.vvH)} top ${Math.round(s.vvTop)} ×${s.scale.toFixed(2)} · window ${innerWidth}×${innerHeight} y${Math.round(scrollY)} · page ${root.scrollWidth}`,
      `edge: ${this.wide ? `${this.wide.label} ${this.wide.left}..${this.wide.right}` : 'nothing past it'}`,
      `focus: ${f ? `${f.tagName.toLowerCase()}${f.id ? '#' + f.id : ''} ${getComputedStyle(f).fontSize} h${Math.round(fr.height)}` : 'none'} · keyboard ${root.classList.contains('kb') ? 'open' : 'closed'} · app ${root.style.getPropertyValue('--app-h') || 'auto'}@${root.style.getPropertyValue('--app-top') || '0'}`,
      `expected moves ${this.expected} · view events ${this.vvEvents}`,
      ...this.log
    ];
    this.el.textContent = rows.join('\n');
  }
}
