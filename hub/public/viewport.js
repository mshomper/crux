// Phones: keep the hub inside the part of the screen you can see, so the composer sits right above the keyboard
// and the page does not jump when a box is tapped. Plain ES module, no page code in fitViewport (tests run it).
//
// iPhone Safari does not shrink the page when the keyboard opens: it pans a smaller "visual viewport" over it
// (visualViewport.height and offsetTop). Android Chrome resizes the page itself (interactive-widget in the
// viewport meta). Either way the hub is sized to visualViewport.height and placed at its offsetTop.

// The keyboard counts as open when a text box has focus and the visible height drops below 80% of the tallest
// seen at this width (a new width, after turning the phone, starts a new tallest).
export const KEYBOARD_SHARE = 0.8;

// vv: { width, height, offsetTop, scale }; prev: what the last call returned; editing: a text box has focus.
// Returns { height, top, keyboard, tallest, width } or, while you pinch-zoom (scale above 1), { zoomed: true }
// so the layout is left alone.
export function fitViewport(vv, prev = {}, editing = false) {
  if (!vv || !(vv.height > 0)) return { ...prev, zoomed: false };
  if (vv.scale && Math.abs(vv.scale - 1) > 0.01) return { ...prev, zoomed: true };
  const width = Math.round(vv.width);
  const tallest = prev.width === width ? Math.max(prev.tallest || 0, vv.height) : vv.height;
  return {
    width,
    tallest,
    height: Math.round(vv.height),
    top: Math.max(0, Math.round(vv.offsetTop || 0)),
    keyboard: !!editing && vv.height < tallest * KEYBOARD_SHARE,
    zoomed: false
  };
}

export const isEditable = el => !!el && (el.isContentEditable || el.matches?.('textarea, select, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=file])'));

// Writes --app-h and --app-top on the root element and the classes "vv" (fitting is on) and "kb" (keyboard open).
export class ViewportFit {
  constructor(root, { onChange = () => { } } = {}) {
    this.root = root;
    this.onChange = onChange;
    this.state = {};
    this.frame = 0;
  }

  start() {
    const vv = window.visualViewport;
    if (!vv) return this;
    this.root.classList.add('vv');
    const soon = () => { cancelAnimationFrame(this.frame); this.frame = requestAnimationFrame(() => this.apply()); };
    vv.addEventListener('resize', soon);
    vv.addEventListener('scroll', soon);
    addEventListener('focusin', soon);
    addEventListener('focusout', () => setTimeout(soon, 50));   // the keyboard closes a moment after the blur
    this.apply();
    return this;
  }

  apply() {
    const vv = window.visualViewport;
    const was = this.state;
    const next = fitViewport({ width: vv.width, height: vv.height, offsetTop: vv.offsetTop, scale: vv.scale }, was, isEditable(document.activeElement));
    this.state = next;
    if (next.zoomed) return;
    if (next.height === was.height && next.top === was.top && next.keyboard === was.keyboard) return;
    this.root.style.setProperty('--app-h', next.height + 'px');
    this.root.style.setProperty('--app-top', next.top + 'px');
    this.root.classList.toggle('kb', next.keyboard);
    this.onChange(next, was);
  }
}
