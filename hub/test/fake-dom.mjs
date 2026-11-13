// A small stand-in for the browser's page objects, enough to run Columns and Conversation (decision 39) under
// node --test without a browser or a new dependency. Elements, a tag parser for innerHTML and the page's own
// template, simple selectors (tag, .class, [attr], [attr="v"], descendant), events that bubble, focus.
// Not a test file itself (the runner picks up *.test.mjs only).

const VOID = new Set(['input', 'img', 'br', 'hr', 'use', 'meta', 'link', 'path', 'circle', 'rect']);
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const unent = s => s.replace(/&(amp|lt|gt|quot|#39);/g, m => ENT[m]);
const kebab = s => s.replace(/[A-Z]/g, c => '-' + c.toLowerCase());

// ---------- selectors ----------
function compound(src) {
  const m = /^([a-z][\w-]*)?((?:\.[\w-]+|\[[^\]]+\])*)$/i.exec(src.trim());
  if (!m) throw new Error(`fake-dom: selector not supported: ${src}`);
  const parts = [...(m[2] || '').matchAll(/\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g)];
  return el => (!m[1] || el.tagName === m[1].toLowerCase())
    && parts.every(p => p[1] ? el.classList.contains(p[1]) : p[3] !== undefined ? el.getAttribute(p[2]) === p[3] : el.hasAttribute(p[2]));
}
function matcher(sel) {
  const lists = sel.split(',').map(s => s.trim().split(/\s+/).map(compound));
  return el => lists.some(chain => {
    if (!chain.at(-1)(el)) return false;
    let node = el.parentElement;
    for (let i = chain.length - 2; i >= 0; i--) { while (node && !chain[i](node)) node = node.parentElement; if (!node) return false; node = node.parentElement; }
    return true;
  });
}

// ---------- elements ----------
export class FakeEl {
  constructor(tag = 'div') {
    this.tagName = tag.toLowerCase();
    this.attrs = new Map(); this.kids = []; this.parent = null; this.listeners = {};
    this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } };
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0; this.clientWidth = 0;
    this.value = ''; this.placeholder = ''; this.title = ''; this._text = ''; this._html = '';
    this.selectionStart = 0; this.selectionEnd = 0;
    const self = this;
    this.dataset = new Proxy({}, {
      get: (_, k) => typeof k === 'string' ? self.getAttribute('data-' + kebab(k)) ?? undefined : undefined,
      set: (_, k, v) => { self.setAttribute('data-' + kebab(k), String(v)); return true; },
      deleteProperty: (_, k) => { self.removeAttribute('data-' + kebab(k)); return true; },
      has: (_, k) => self.hasAttribute('data-' + kebab(k))
    });
    this.classList = {
      contains: c => (self.getAttribute('class') || '').split(/\s+/).includes(c),
      add: (...cs) => { for (const c of cs) if (!self.classList.contains(c)) self.setAttribute('class', `${self.getAttribute('class') || ''} ${c}`.trim()); },
      remove: (...cs) => self.setAttribute('class', (self.getAttribute('class') || '').split(/\s+/).filter(x => x && !cs.includes(x)).join(' ')),
      toggle: (c, force) => { const on = force ?? !self.classList.contains(c); on ? self.classList.add(c) : self.classList.remove(c); return on; }
    };
  }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get id() { return this.getAttribute('id') || ''; }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { v ? this.setAttribute('hidden', '') : this.removeAttribute('hidden'); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { v ? this.setAttribute('disabled', '') : this.removeAttribute('disabled'); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v ?? ''); this.kids = []; }
  get innerHTML() { return this._html; }
  // The element's own markup: its source when it came from the parser (text included), else built from its parts.
  get outerHTML() {
    if (this._outer !== undefined) return this._outer;
    const attrs = [...this.attrs].map(([k, v]) => ` ${k}="${v}"`).join('');
    return `<${this.tagName}${attrs}>${this._text}${this.kids.map(k => k.outerHTML).join('')}</${this.tagName}>`;
  }
  set innerHTML(v) { this._html = String(v); for (const k of this.kids) k.parent = null; this.kids = []; for (const n of parse(this._html)) this.appendChild(n); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  get children() { return [...this.kids]; }
  get firstElementChild() { return this.kids[0] || null; }
  get lastElementChild() { return this.kids.at(-1) || null; }
  get parentElement() { return this.parent; }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return !!n._connected; }
  appendChild(el) { el.remove(); el.parent = this; this.kids.push(el); return el; }
  append(...els) { for (const e of els) this.appendChild(e); }
  insertBefore(el, ref) {
    if (!ref) return this.appendChild(el);
    el.remove();
    el.parent = this; this.kids.splice(this.kids.indexOf(ref), 0, el); return el;
  }
  remove() { if (!this.parent) return; this.parent.kids.splice(this.parent.kids.indexOf(this), 1); this.parent = null; }
  contains(el) { for (let n = el; n; n = n.parent) if (n === this) return true; return false; }
  *walk() { for (const k of this.kids) { yield k; yield* k.walk(); } }
  querySelectorAll(sel) { const m = matcher(sel); return [...this.walk()].filter(m); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  matches(sel) { return matcher(sel)(this); }
  closest(sel) { const m = matcher(sel); for (let n = this; n; n = n.parent) if (m(n)) return n; return null; }
  cloneNode(deep) {
    const c = new FakeEl(this.tagName);
    for (const [k, v] of this.attrs) c.attrs.set(k, v);
    c.value = this.value; c._text = this._text;
    if (deep) for (const k of this.kids) c.appendChild(k.cloneNode(true));
    return c;
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
  dispatchEvent(e) {
    e.target ||= this;
    e.defaultPrevented ||= false;
    e.preventDefault ||= () => { e.defaultPrevented = true; };
    for (let n = this; n; n = n.parent) for (const fn of n.listeners[e.type] || []) fn(e);
    return !e.defaultPrevented;
  }
  focus() { globalThis.document.activeElement = this; this.dispatchEvent({ type: 'focusin' }); }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
  requestSubmit() { this.dispatchEvent({ type: 'submit' }); }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  getBoundingClientRect() { return { x: 0, y: 0, width: this.clientWidth, height: this.clientHeight, left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight }; }
}

// ---------- a tag parser: elements and attributes; text is dropped ----------
export function parse(html) {
  const root = new FakeEl('#root');
  let cur = root;
  const src = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of src.matchAll(/<(\/)?([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/)?>/g)) {
    const [, close, tag, attrs, selfClose] = m;
    const t = tag.toLowerCase();
    if (close) { for (let n = cur; n !== root; n = n.parent) if (n.tagName === t) { n._outer = src.slice(n._start, m.index + m[0].length); cur = n.parent; break; } continue; }
    const el = new FakeEl(t);
    for (const a of attrs.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1], unent(a[2] ?? ''));
    cur.appendChild(el);
    el._start = m.index;
    if (!selfClose && !VOID.has(t)) cur = el; else el._outer = m[0];
  }
  const out = root.children;
  for (const k of out) k.parent = null;
  return out;
}

// The page's own conversation template (index.html), as the browser would give it to Conversation.
export function templateFrom(indexHtml, id) {
  const inner = new RegExp(`<template id="${id}">([\\s\\S]*?)</template>`).exec(indexHtml)[1];
  const [first] = parse(inner);
  return { content: { firstElementChild: first } };
}

// Globals the classes touch: document (activeElement, createElement) and ResizeObserver.
export function installDom() {
  globalThis.document = { activeElement: null, createElement: tag => new FakeEl(tag) };
  globalThis.ResizeObserver = class { observe() { } disconnect() { } };
}
