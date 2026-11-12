// Plan meters in the always-on strip, and the usage panel behind them (decision 36).
//   meters  - 5-hour, 7-day and one per model window the plan has (Fable in copper); percent and time to reset.
//             Amber at a warning or 80% and up, red only when a window rejects work (decision 31).
//             Hidden when the hub has no plan numbers (the usage call failed, or plan limits do not apply).
//   panel   - click the meters: plan windows with reset times; estimated spend today and since the hub started,
//             per model and per agent; Fable's share. Spend is an estimate from list prices, not a bill.
// The core has no meters of its own: its readout stays as it is (Matt's rule).
import { hueOf, modelLabel, MODEL_HUES } from './models.js';
import { meterList, aggregate, fmtTokens, fmtCost, fmtLeft } from './usage.js';

export const STALE_MS = 15 * 60 * 1000;   // a snapshot older than this is shown dimmed, with when it was read
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const X = '<svg class="hud-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const pctText = p => (p == null ? '–' : `${Math.round(p)}%`);
const clock = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
const whenText = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }); };
export const isStale = (plan, now = Date.now()) => !plan?.asOf || now - Date.parse(plan.asOf) > STALE_MS;

// One meter. Classes carry the tone (t-ok, t-amber, t-red); a model window carries its hue.
export function meterHtml(m, now = Date.now()) {
  const hue = m.model ? hueOf(`claude-${m.model}`) || MODEL_HUES.fable : null;
  const left = m.idle ? 'idle' : fmtLeft(m.resetsAt, now);
  return `<span class="um t-${m.tone}${m.idle ? ' idle' : ''}" data-meter="${esc(m.key)}"${hue ? ` style="--mh:${hue}"` : ''}>
      <i class="um-l">${esc(m.label)}</i><span class="um-bar"><b style="--p:${m.idle ? 0 : m.pct}%"></b></span><em class="um-p">${pctText(m.pct)}</em><s class="um-r">${esc(left)}</s></span>`;
}
export function metersHtml(list, now = Date.now()) { return list.map(m => meterHtml(m, now)).join(''); }

// The words a screen reader hears, and the hover text.
export function metersLabel(list, plan, now = Date.now()) {
  const parts = list.map(m => (m.idle ? `${m.full}: no window running` : `${m.full}: ${Math.round(m.pct)}% used${m.resetsAt ? `, resets in ${fmtLeft(m.resetsAt, now)}` : ''}${m.tone === 'red' ? ', blocked' : m.tone === 'amber' ? ', getting close' : ''}`));
  return `Plan usage. ${parts.join('. ')}.${isStale(plan, now) && plan?.asOf ? ` Last read at ${clock(plan.asOf)}.` : ''} Click for details.`;
}

const rowTokens = r => `in ${fmtTokens(r.input)} · out ${fmtTokens(r.output)}${r.cacheRead ? ` · cache ${fmtTokens(r.cacheRead)}` : ''}`;

// The panel's body. state: { plan, rows, bootAt, range: 'today' | 'session', multi, now }
export function panelHtml({ plan, rows, bootAt, range = 'today', multi = false, now = Date.now() }) {
  const list = meterList(plan);
  const stale = isStale(plan, now);
  const win = m => `<div class="up-win t-${m.tone}${m.idle ? ' idle' : ''}"${m.model ? ` style="--mh:${hueOf(`claude-${m.model}`) || MODEL_HUES.fable}"` : ''}>
      <div class="up-wl"><b>${esc(m.full)}</b><span>${m.idle ? 'no window running' : pctText(m.pct)}</span></div>
      <span class="um-bar big"><b style="--p:${m.idle ? 0 : m.pct}%"></b></span>
      ${m.idle ? '' : `<div class="up-wr">Resets in ${esc(fmtLeft(m.resetsAt, now))}${m.resetsAt ? ` · ${esc(whenText(m.resetsAt))}` : ''}</div>`}</div>`;
  const plans = list.length
    ? list.map(win).join('') + (plan.extra ? `<div class="up-win"><div class="up-wl"><b>Extra usage credits</b><span>${pctText(plan.extra.pct)}</span></div><span class="um-bar big"><b style="--p:${plan.extra.pct}%"></b></span></div>` : '')
      + (stale && plan.asOf ? `<p class="up-faint">Last read at ${esc(clock(plan.asOf))}. It updates while an agent is running.</p>` : '')
    : '<p class="up-faint">No plan numbers right now.</p>';

  const since = range === 'session' ? bootAt || 0 : new Date().setHours(0, 0, 0, 0);
  const agg = aggregate(rows, { since });
  const empty = !agg.models.length;
  const fableWin = plan?.models.find(m => m.key === 'fable');
  const fable = agg.fable.cost > 0 || fableWin
    ? `<div class="up-fable"><div class="up-wl"><b>Fable's share</b><span>${agg.fable.cost > 0 ? `${Math.round(agg.fable.share * 100)}% of spend` : 'none yet'}</span></div>
        <span class="um-bar big" style="--mh:${MODEL_HUES.fable}"><b style="--p:${Math.round(agg.fable.share * 100)}%"></b></span>
        <div class="up-wr">${agg.fable.cost > 0 ? `${fmtCost(agg.fable.cost)} of ${fmtCost(agg.total.cost)} estimated · ${Math.round(agg.fable.tokenShare * 100)}% of input and output tokens` : 'No Fable use logged in this period'}${fableWin ? ` · weekly window ${pctText(fableWin.pct)}` : ''}</div></div>`
    : '';
  const modelRow = m => `<li style="--mh:${hueOf(m.id) || '#8792ad'}"><span class="up-dot"></span><div><b>${esc(modelLabel(m.id))}</b><i>${esc(rowTokens(m))}</i></div><em>${fmtCost(m.cost)}</em></li>`;
  const agentRow = a => `<li style="--mh:${hueOf(a.model) || '#8792ad'}"><span class="up-dot"></span><div><b>${esc(multi ? `${a.project} / ${a.agent}` : a.agent)}</b><i>${esc(a.model ? modelLabel(a.model) + ' · ' : '')}${esc(rowTokens(a))}</i></div><em>${fmtCost(a.cost)}</em></li>`;
  const spend = `<div class="up-tabs" role="tablist" aria-label="Period">
      <button role="tab" aria-selected="${range === 'today'}" data-range="today">Today</button><button role="tab" aria-selected="${range === 'session'}" data-range="session">Since hub start</button></div>
    ${empty ? `<p class="up-faint">${range === 'session' ? 'Nothing since the hub started.' : 'Nothing logged today.'} Totals appear after an agent's next reply.</p>` : `
    <div class="up-total"><b>${fmtCost(agg.total.cost)}</b><span>estimated · ${fmtTokens(agg.total.input + agg.total.output)} input and output tokens</span></div>
    ${fable}
    <h4>By model</h4><ul class="up-list">${agg.models.map(modelRow).join('')}</ul>
    <h4>By agent</h4><ul class="up-list">${agg.agents.map(agentRow).join('')}</ul>`}`;

  return `<header class="up-head"><span class="hud-k">Usage</span><b>${plan?.subscription ? esc(`${plan.subscription[0].toUpperCase()}${plan.subscription.slice(1)} plan`) : 'Plan'}</b><button class="up-x" data-up-close aria-label="Close" title="Close">${X}</button></header>
    <div class="up-body"><h3>Plan limits</h3>${plans}<h3>Estimated spend</h3>${spend}
    <p class="up-note">Spend is estimated at list prices, not a bill. Plan percentages come from your Claude plan.</p></div>`;
}

export class UsageUI {
  // slot: the strip's slot (#hud). source(): { rows: [{ project, ev }], bootAt, multi }.
  constructor(slot, { source }) {
    this.slot = slot;
    this.source = source;
    this.plan = null;
    this.range = 'today';
    this.key = '';
    this.panelKey = '';
    this.el = document.createElement('div');
    this.el.className = 'usage-meters';
    this.el.setAttribute('role', 'button');
    this.el.tabIndex = 0;
    this.el.hidden = true;
    slot.append(this.el);
    this.pop = document.createElement('div');
    this.pop.className = 'usage-pop';
    this.pop.setAttribute('role', 'dialog');
    this.pop.setAttribute('aria-label', 'Usage');
    this.pop.hidden = true;
    document.body.append(this.pop);
    this.el.addEventListener('click', () => this.toggle());
    this.el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggle(); } });
    this.pop.addEventListener('click', e => {
      if (e.target.closest('[data-up-close]')) return this.close(true);
      const r = e.target.closest('[data-range]');
      if (r) { this.range = r.dataset.range; this.drawPanel(); }
    });
    addEventListener('keydown', e => { if (e.key === 'Escape' && this.isOpen) this.close(true); });
    document.addEventListener('pointerdown', e => { if (this.isOpen && !this.pop.contains(e.target) && !this.el.contains(e.target)) this.close(); });
    addEventListener('resize', () => this.place());
    setInterval(() => this.draw(), 60000).unref?.();   // the reset times count down
  }

  get isOpen() { return !this.pop.hidden; }

  // view: { plan, available } from the hub; null plan hides the meters.
  setPlan(view) { this.plan = view?.plan || null; this.draw(); }

  draw() {
    const now = Date.now();
    const list = meterList(this.plan);
    const on = list.length > 0;
    this.slot.classList.toggle('has-usage', on);
    this.el.hidden = !on;
    this.el.classList.toggle('stale', on && isStale(this.plan, now));
    if (on) {
      const html = metersHtml(list, now);
      if (html !== this.key) { this.key = html; this.el.innerHTML = html; }
      const label = metersLabel(list, this.plan, now);
      this.el.setAttribute('aria-label', label);
      this.el.title = label;
    } else { this.key = ''; if (this.isOpen) this.close(); }
    if (this.isOpen) this.drawPanel();
  }

  drawPanel() {
    const s = this.source();
    const html = panelHtml({ plan: this.plan, rows: s.rows, bootAt: s.bootAt, multi: s.multi, range: this.range });
    if (html !== this.panelKey) {
      const keep = this.pop.querySelector('.up-body')?.scrollTop || 0;
      this.panelKey = html;
      this.pop.innerHTML = html;
      const body = this.pop.querySelector('.up-body');
      if (body) body.scrollTop = keep;
    }
    this.place();
  }

  toggle() { this.isOpen ? this.close(true) : this.open(); }
  open() { if (this.el.hidden) return; this.pop.hidden = false; this.el.setAttribute('aria-expanded', 'true'); this.panelKey = ''; this.drawPanel(); }
  close(refocus = false) {
    this.pop.hidden = true;
    this.el.setAttribute('aria-expanded', 'false');
    if (refocus && !this.el.hidden) this.el.focus({ preventScroll: true });
  }

  // Under the strip, lined up with the meters; on a phone a sheet across the width. Always inside the window.
  place() {
    if (!this.isOpen) return;
    const b = this.slot.getBoundingClientRect(), m = this.el.getBoundingClientRect();
    const phone = innerWidth <= 720;
    const w = phone ? innerWidth - 16 : Math.min(400, innerWidth - 24);
    const top = Math.round(b.bottom + 6);
    this.pop.style.width = `${w}px`;
    this.pop.style.left = `${phone ? 8 : Math.max(12, Math.min(innerWidth - w - 12, m.left))}px`;
    this.pop.style.top = `${top}px`;
    this.pop.style.maxHeight = `${Math.max(240, innerHeight - top - 12)}px`;
  }
}
