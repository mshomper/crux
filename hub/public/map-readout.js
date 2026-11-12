// The core's readout (M013): nothing is written on the glass sphere, so the exact numbers live here.
// Point at the core (or tap it on a phone) to see who holds the orchestrator role, its model and effort,
// context used and where it hands off, the permission mode, and what waits on you.

import { modelLabel, EFFORT_WORDS, pips, hueOf } from './models.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATE_WORDS = { vacant: 'No holder', asleep: 'Asleep', idle: 'Idle', starting: 'Starting', working: 'Working', writing: 'Writing its handoff', error: 'Stopped on an error' };

// The map model's core() -> the readout's words. Pure, so it can be tested.
// Returns { title, sub, state, hue, effort, rows: [{ k, v, note?, tone?, pips? }] }; tone is '', 'amber', 'gold' or 'red'.
export function coreReadout(core, { busy = 0, resting = 0 } = {}) {
  if (!core || core.state === 'vacant') {
    return { title: 'Orchestrator role', sub: '', state: STATE_WORDS.vacant, hue: null, effort: null, rows: [{ k: 'Role', v: 'Starts when you send a message' }] };
  }
  const ctx = core.ctx, at = core.retireAt;
  const level = ctx == null ? '' : ctx >= at ? 'gold' : ctx >= at * 0.8 ? 'amber' : '';
  const rows = [
    { k: 'Model', v: modelLabel(core.model) },
    { k: 'Effort', v: core.effort ? EFFORT_WORDS[core.effort] : 'Default', pips: true },
    { k: 'Context', v: ctx == null ? 'Not measured yet' : `${ctx}% used`, note: level === 'gold' ? `Handoff due (set at ${at}%)` : `Hands off at ${at}%`, tone: level },
    { k: 'Permissions', ...({ auto: { v: 'Auto', note: 'Contained work runs without asking' }, trusted: { v: 'Trusted', note: 'Auto, plus installs and the open web' } }[core.mode] || { v: 'Ask', note: 'Requests go to the orchestrator first' }) }
  ];
  if (core.waiting) rows.push({ k: 'Needs you', v: `${core.waiting} waiting`, tone: 'red' });
  rows.push({ k: 'Workers', v: `${busy} working, ${resting} resting` });
  if (core.activity) rows.push({ k: 'Doing', v: core.activity });
  return { title: core.holder || 'Orchestrator', sub: `Generation ${core.generation}`, state: STATE_WORDS[core.state] || core.state, hue: hueOf(core.model), effort: core.effort, rows };
}

export class CoreReadout {
  constructor({ open }) {
    this.el = document.createElement('div');
    this.el.className = 'core-pop';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Orchestrator details');
    this.el.hidden = true;
    document.body.append(this.el);
    this.key = '';
    this.el.addEventListener('pointerenter', () => clearTimeout(this.closeTimer));
    this.el.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') this.closeSoon(); });
    this.el.addEventListener('click', e => { if (e.target.closest('[data-core-open]')) { this.hide(); open(); } });
    addEventListener('keydown', e => { if (e.key === 'Escape') this.hide(); });
    document.addEventListener('pointerdown', e => { if (!this.el.hidden && !this.el.contains(e.target) && !e.target.closest('.hud')) this.hide(); });
  }

  get open() { return !this.el.hidden; }

  // data: what coreReadout() returned; at: { x, y, r } of the core in window coordinates.
  show(data, at) {
    clearTimeout(this.closeTimer);
    this.set(data);
    this.el.hidden = false;
    this.place(at);
  }

  set(data) {
    const html = `<header class="cp-head"><b>${esc(data.title)}</b><span>${esc(data.sub)}</span><em>${esc(data.state)}</em></header>
      <dl class="cp-rows">${data.rows.map(r => `<div class="${esc(r.tone || '')}"><dt>${esc(r.k)}</dt><dd><b>${esc(r.v)}</b>${r.pips ? pips(data.effort) : ''}${r.note ? `<i>${esc(r.note)}</i>` : ''}</dd></div>`).join('')}</dl>
      <button class="cp-open" data-core-open>Open its chat</button>`;
    if (html !== this.key) { this.key = html; this.el.innerHTML = html; }
    data.hue ? this.el.style.setProperty('--mh', data.hue) : this.el.style.removeProperty('--mh');
  }

  hide() { clearTimeout(this.closeTimer); this.el.hidden = true; }
  closeSoon() { clearTimeout(this.closeTimer); this.closeTimer = setTimeout(() => this.hide(), 300); }

  // In the strip it hangs under the sphere, clear of the stations beside it. In the open map it sits beside
  // the sphere when there is room (so it never covers it), else under or over it. Always inside the window.
  place(at) {
    if (!at) return;
    const w = Math.min(268, innerWidth - 24);
    this.el.style.width = `${w}px`;
    const h = this.el.offsetHeight, gap = at.r * 1.3 + 12;
    let left, top;
    if (at.under != null) { left = at.x - w / 2; top = at.under + 6; }
    else if (at.x + gap + w <= innerWidth - 12) { left = at.x + gap; top = at.y - h / 2; }
    else if (at.x - gap - w >= 12) { left = at.x - gap - w; top = at.y - h / 2; }
    else { left = at.x - w / 2; top = at.y + gap + h <= innerHeight - 12 ? at.y + gap : at.y - gap - h; }
    this.el.style.left = `${Math.max(12, Math.min(innerWidth - w - 12, left))}px`;
    this.el.style.top = `${Math.max(12, Math.min(innerHeight - h - 12, top))}px`;
  }
}
