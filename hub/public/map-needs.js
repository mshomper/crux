// The "You" station's popover: what is waiting for you, answerable right on the live map.
// Hover the station (or tap it on a phone) to see each permission request in plain words with
// Allow / Always allow / Deny. The buttons carry the same data-approve / data-deny attributes as
// the cards in the chat, so app.js answers them exactly the same way.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>'
};
const svg = n => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;

export class NeedsPopover {
  constructor({ open }) {
    this.openThread = open;
    this.el = document.createElement('div');
    this.el.className = 'needs-pop';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Waiting for you');
    this.el.hidden = true;
    document.body.append(this.el);
    this.anchor = null;
    this.items = { approvals: [], others: 0 };
    this.el.addEventListener('pointerenter', () => clearTimeout(this.closeTimer));
    this.el.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') this.closeSoon(); });
    this.el.addEventListener('click', e => {
      if (e.target.closest('[data-needs-open]')) { this.hide(); this.openThread('needs'); }
      if (e.target.closest('[data-pop-close]')) this.hide();
    });
    addEventListener('keydown', e => { if (e.key === 'Escape' && !this.el.hidden) this.hide(); });
    document.addEventListener('pointerdown', e => {
      if (!this.el.hidden && !this.el.contains(e.target) && !this.anchor?.contains(e.target)) this.hide();
    });
    addEventListener('resize', () => this.place());
  }

  // project: the hub's project state; pending: ids of approvals still waiting; total: everything that needs you.
  set(project, pending, total) {
    const done = new Set(project.events.filter(e => e.type === 'approval_result').map(e => e.approval));
    const approvals = project.events.filter(e => e.type === 'approval' && pending.has(e.approval) && !done.has(e.approval));
    this.items = { approvals, others: Math.max(0, total - approvals.length) };
    if (!this.el.hidden) { if (this.count) { this.render(); this.place(); } else this.hide(); }
  }

  get count() { return this.items.approvals.length + this.items.others; }

  attach(stationEl) {
    if (this.anchor === stationEl) return;
    this.anchor = stationEl;
    stationEl.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse' && this.count) { clearTimeout(this.closeTimer); this.show(); } });
    stationEl.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') this.closeSoon(); });
  }

  // A tap or click on You toggles the popover instead of leaving the map, while something waits.
  toggle() {
    if (!this.count) return false;
    this.el.hidden ? this.show() : this.hide();
    return true;
  }

  show() { this.render(); this.el.hidden = false; this.place(); }
  hide() { clearTimeout(this.closeTimer); this.el.hidden = true; }
  closeSoon() { clearTimeout(this.closeTimer); this.closeTimer = setTimeout(() => this.hide(), 350); }

  render() {
    const { approvals, others } = this.items;
    const cards = approvals.map(ev => {
      const plain = ev.summary?.plain || ev.input?.description || ev.description || `use ${ev.tool}`;
      const tags = (ev.summary?.tags || []).map(t => `<span class="tag ${esc(t.level)}">${esc(t.text)}</span>`).join('');
      return `<article class="np-card">
        <div class="np-who">${esc(ev.agent)} wants to</div>
        <div class="np-what">${esc(plain[0].toLowerCase() + plain.slice(1))}</div>
        ${tags ? `<div class="np-tags">${tags}</div>` : ''}
        <div class="np-acts">
          <button class="np-btn primary" data-approve="${esc(ev.approval)}">${svg('check')}Allow</button>
          ${ev.always ? `<button class="np-btn" data-approve="${esc(ev.approval)}" data-always title="Always: ${esc(ev.always.join('; '))}">${svg('check')}Always</button>` : ''}
          <button class="np-btn" data-deny="${esc(ev.approval)}">${svg('x')}Deny</button>
        </div>
      </article>`;
    }).join('');
    const more = others ? `<button class="np-more" data-needs-open>${others} decision${others === 1 ? '' : 's'} or question${others === 1 ? '' : 's'} in Needs you ${svg('arrow')}</button>` : '';
    this.el.innerHTML = `<header class="np-head"><b>Waiting for you</b><span>${this.count}</span><button class="np-x" data-pop-close aria-label="Close">${svg('x')}</button></header>
      <div class="np-list">${cards || ''}</div>${more}`;
  }

  // Sit above or below the You station, whichever has room, kept inside the window.
  place() {
    if (this.el.hidden || !this.anchor) return;
    if (!this.anchor.style.transform) return requestAnimationFrame(() => this.place()); // the map has not placed its stations yet
    // The station button is a zero-size point; its icon and label are what you see, so measure those.
    const rs = [...this.anchor.children].map(c => c.getBoundingClientRect()).filter(r => r.width || r.height);
    const a = rs.length
      ? { left: Math.min(...rs.map(r => r.left)), right: Math.max(...rs.map(r => r.right)), top: Math.min(...rs.map(r => r.top)), bottom: Math.max(...rs.map(r => r.bottom)) }
      : this.anchor.getBoundingClientRect();
    a.width = a.right - a.left;
    const w = Math.min(360, innerWidth - 24);
    this.el.style.width = `${w}px`;
    const icon = this.anchor.querySelector('.hs-body')?.getBoundingClientRect();
    const cx = icon && icon.width ? icon.left + icon.width / 2 : a.left + a.width / 2;
    const left = Math.max(12, Math.min(innerWidth - w - 12, cx - w / 2));
    const h = this.el.offsetHeight;
    const below = a.bottom + 8, above = a.top - 8 - h;
    const top = below + h <= innerHeight - 12 || above < 12 ? Math.min(below, innerHeight - 12 - h) : above;
    this.el.style.left = `${left}px`;
    this.el.style.top = `${Math.max(12, top)}px`;
  }
}
