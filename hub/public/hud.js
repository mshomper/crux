// The HUD frame's small behaviours (decision 33 A, M008 pass 2); the look itself is hud.css.
//   - which level of the frame is on: html[data-hud]
//   - the boot line (restrained) or boot sequence (full) when the hub opens
// Lab switches while Matt chooses a level: ?hud=off|restrained|full, and ?hudhold to freeze the boot for a screenshot.

const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
export const LEVELS = ['off', 'restrained', 'full'];
export const hudLevel = (param, dflt = 'restrained') => LEVELS.includes(param) ? param : dflt;

// The words of the boot readout, from what the hub knows when it opens. Pure, so it can be tested.
export function bootRows({ project = '', agents = 0, working = 0, waiting = 0 } = {}) {
  return [
    { k: 'Memory board', v: project || 'no project' },
    { k: 'Agents', v: agents ? `${agents}${working ? `, ${working} working` : ''}` : 'none yet' },
    { k: 'Needs you', v: waiting ? String(waiting) : 'all clear', hot: waiting > 0 },
    { k: 'Link', v: 'up' }
  ];
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Called once by the page when its first data has arrived.
export function hudBoot(info) {
  const level = document.documentElement.dataset.hud;
  if (!level || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const rows = bootRows(info);
  if (level === 'full') {
    const el = document.createElement('div');
    el.className = 'hud-boot';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<div class="hud-boot-panel"><h2>Crux hub</h2>${rows.map(r => `<p>${esc(r.k)}<i></i><b class="${r.hot ? 'hot' : ''}">${esc(r.v)}</b></p>`).join('')}</div>`;
    document.body.append(el);
    if (!q.has('hudhold')) el.addEventListener('animationend', e => { if (e.target === el) el.remove(); });
    return;
  }
  const head = document.querySelector('.main-head');
  if (!head) return;
  const el = document.createElement('div');
  el.className = 'hud-bootline';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<span>Link <b>up</b></span><span>Agents <b>${esc(rows[1].v)}</b></span><span>Needs you <b>${esc(rows[2].v)}</b></span><i></i>`;
  head.append(el);
  if (!q.has('hudhold')) el.addEventListener('animationend', e => { if (e.target === el) el.remove(); });
}

if (typeof document !== 'undefined') {
  const level = hudLevel(q.get('hud'));
  if (level !== 'off') document.documentElement.dataset.hud = level;
  if (q.has('hudhold')) document.documentElement.dataset.hudHold = '1';
}
