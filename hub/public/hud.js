// The HUD frame's small behaviours (decision 33 A, M008 pass 2). The look itself is hud.css, switched on by
// the data-hud attribute on <html>.
//   hudBoot()               the boot sequence, every time the hub opens (Matt, 2026-11-11)
//   openPanel() / closePanel() a card from the board opened in a HUD panel inside the hub (M008 12)
// ?hudhold freezes the boot sequence for a screenshot.

const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The words of the boot readout, from what the hub knows when it opens. Pure, so it can be tested.
export function bootRows({ project = '', agents = 0, working = 0, waiting = 0 } = {}) {
  return [
    { k: 'Memory board', v: project || 'no project' },
    { k: 'Agents', v: agents ? `${agents}${working ? `, ${working} working` : ''}` : 'none yet' },
    { k: 'Needs you', v: waiting ? String(waiting) : 'all clear', hot: waiting > 0 },
    { k: 'Link', v: 'up' }
  ];
}

// Called once by the page when its first data has arrived. Nothing shows under reduced motion.
export function hudBoot(info) {
  if (!document.documentElement.hasAttribute('data-hud') || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const el = document.createElement('div');
  el.className = 'hud-boot';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<div class="hud-boot-panel"><h2>Crux hub</h2>${bootRows(info).map(r => `<p>${esc(r.k)}<i></i><b class="${r.hot ? 'hot' : ''}">${esc(r.v)}</b></p>`).join('')}</div>`;
  document.body.append(el);
  if (q.has('hudhold')) { document.documentElement.dataset.hudHold = '1'; return; }
  el.addEventListener('animationend', e => { if (e.target === el) el.remove(); });
  setTimeout(() => el.remove(), 3000);   // never left over the hub, whatever the animation does
}

// A card (already rendered as HTML by the page) in a HUD panel over the hub. It closes with its X, Escape,
// or a click outside it; its own buttons work as they do in a thread.
let panel;
export function openPanel(html, label = 'Card') {
  if (!html) return;
  if (!panel) {
    panel = document.createElement('dialog');
    panel.className = 'hud-card';
    panel.innerHTML = `<header class="hc-head"><span class="hud-k"></span><button class="btn ghost icon-only hc-x" aria-label="Close"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header><div class="hc-body"></div>`;
    document.body.append(panel);
    panel.addEventListener('click', e => { if (e.target === panel || e.target.closest('.hc-x')) panel.close(); });
  }
  panel.querySelector('.hud-k').textContent = label;
  panel.setAttribute('aria-label', label);
  panel.querySelector('.hc-body').innerHTML = html;
  if (!panel.open) panel.showModal();
  panel.querySelector('.hc-x').focus();
}
export function closePanel() { if (panel?.open) panel.close(); }
