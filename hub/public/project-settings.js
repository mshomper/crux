// Per-project settings and the Whole hub panel (decision 44 B), with the Trusted level (decision 45 B).
//   levelChip(p)            the project row's ASK / AUTO / TRUSTED chip; a tap opens that project's settings card
//   projectCard(p, hub, d)  the card: level (what it allows, the always-to-you list folding open on request), the
//                           three handoff numbers (empty = the hub default, shown under each) and connectors
//   hubPanel(s, d)          the Whole hub panel from the three-dots menu: who answers requests, the wait before a
//                           request comes to you, and the hub defaults for the three handoff numbers
//   SettingsCards           the two pop-ups: changes are kept in a draft and saved with Done; the X, Escape or a
//                           click outside close without changing anything. Saved as same-origin JSON (C001).
// Plain functions return HTML strings, so they can be tested without a browser.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (id, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const help = tip => `<span class="ps-help" title="${esc(tip)}" aria-label="${esc(tip)}" role="img">${ic('help')}</span>`;

// The merge line, in Matt's settled words (decision 45 B; THE MERGE RULE in lib/permission-rules.mjs).
export const MERGE_LINE = 'Merges: the orchestrator merges after a review, once you say yes.';

export const LEVELS = {
  standard: {
    word: 'Ask', icon: 'sh1', sub: 'Every action beyond reading is checked first.',
    ok: ['Reading and searching files'],
    you: ['Edits, builds, tests and git: the orchestrator answers first, then you', 'Everything Auto would ask about']
  },
  auto: {
    word: 'Auto', icon: 'sh2', sub: 'Work that stays in the project runs on its own.',
    ok: ['Edit, build and test inside the project, its worktrees and temp folders', 'Local git, feature-branch pushes, opening PRs', 'Fetching from GitHub'],
    you: ['Installing packages', 'Other websites: the orchestrator checks first', MERGE_LINE]
  },
  trusted: {
    word: 'Trusted', icon: 'sh3', sub: 'For your own projects: Auto, plus installs and the open web.',
    ok: ['Everything Auto allows', 'Installing packages into the project (npm, pip and the like)', 'Reading and downloading from any website into the project'],
    you: [MERGE_LINE, 'Installing software system-wide (winget, npm -g)', 'Sending anything to a website'],
    note: 'Set only here, never from a file in the repo: a repo you clone cannot give itself Trusted.'
  }
};
export const LEVEL_ORDER = ['standard', 'auto', 'trusted'];
const levelOf = p => (LEVELS[p?.permissionMode] ? p.permissionMode : 'standard');

// The fixed stops (decision 45): the same at every level.
export const ALWAYS = ['Force push', 'Rewriting pushed history', 'Deleting branches', 'Pushing straight to main', 'Writing outside the project',
  'Passwords and keys', 'Stopping the live hub', 'Installing software system-wide', 'Sending or deleting mail, calendar, drive'];

// The three handoff numbers: label, unit, help and the range the hub accepts (lib/settings.mjs HANDOFF_NUMBERS).
export const NUMBERS = [
  { k: 'retireAt', icon: 'gauge', label: 'Hand off at', unit: '% context', min: 10, max: 95,
    tip: 'The orchestrator writes a handoff and a fresh one takes over when it has used this much of its context (decision 10).' },
  { k: 'idleHandoffMin', icon: 'clock', label: 'Or after idle for', unit: 'minutes', min: 0, max: 1440,
    tip: 'An orchestrator that has had nothing to do for this long hands off on its own. 0 means never (decision 37).' },
  { k: 'idleFloorPct', icon: 'floor', label: 'Only when above', unit: '% context', min: 0, max: 100,
    tip: 'An idle orchestrator that has used less of its context than this keeps going: a fresh one would not save much (decision 37).' }
];
export const TIMEOUT = { k: 'permissionTimeoutSec', icon: 'clock', label: 'Comes to you after', unit: 'seconds', min: 10, max: 3600,
  tip: 'How long the orchestrator has to answer a worker\'s request before the card comes to you.' };

// A typed value: '' (use the default, when allowed), a whole number in range, or an error in plain words.
export function readNumber(text, f, { allowEmpty = true } = {}) {
  const s = String(text ?? '').trim();
  if (!s) return allowEmpty ? { value: null } : { error: 'Needs a number' };
  if (!/^\d+$/.test(s)) return { error: 'Whole numbers only' };
  const v = Number(s);
  if (v < f.min || v > f.max) return { error: `Between ${f.min} and ${f.max}` };
  return { value: v };
}

export function levelChip(p) {
  const k = levelOf(p), L = LEVELS[k];
  const conn = p?.connectors ? ' Connectors are on.' : '';
  const tip = `${L.word}: ${L.sub}${conn} Click for this project's settings.`;
  return `<button class="lvchip ${k}" data-settings-open aria-haspopup="dialog" title="${esc(tip)}" aria-label="${esc(tip)}">${ic(L.icon)}<span class="lv-w">${L.word}</span>${p?.connectors ? `<span class="lv-conn">${ic('plug')}</span>` : ''}</button>`;
}

const list = (items, cls, icon) => items.map(t => `<li class="${cls}">${ic(icon)}<span>${esc(t)}</span></li>`).join('');
function plate(k, on) {
  const L = LEVELS[k];
  const tip = `${L.word}. Runs on its own: ${L.ok.join('; ')}. Comes to you: ${L.you.join('; ')}.${L.note ? ` ${L.note}` : ''}`;
  return `<div class="ps-lv ${on ? 'on' : ''}" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-ps-level="${k}" title="${esc(on ? (L.note || '') : tip)}">
    <div class="ps-lv-top"><span class="ps-hex">${ic(L.icon)}</span><span class="ps-lv-name">${L.word}</span>${on ? `<span class="ps-mark">${ic('check')}Chosen</span>` : ''}</div>
    <div class="ps-lv-sub">${esc(L.sub)}</div>
    ${on ? `<div class="ps-lv-body">
      <div class="ps-cap">Runs on its own</div><ul class="ps-list">${list(L.ok, 'ok', 'check')}</ul>
      <div class="ps-cap">Comes to you</div><ul class="ps-list">${list(L.you, 'you', 'hand')}</ul>
    </div>` : ''}
  </div>`;
}
function always(open) {
  return `<details class="ps-always" ${open ? 'open' : ''}><summary>${ic('lock')}<span>Always comes to you, at every level</span><span class="ps-n">${ALWAYS.length}</span>${ic('chev', 'ps-chev')}</summary>
    <div class="ps-tags">${ALWAYS.map(t => `<span class="ps-tag">${esc(t)}</span>`).join('')}</div></details>`;
}

// One number row. own: the text in the box ('' = the default); dflt: the hub default (null in the hub panel itself).
function numRow(f, own, dflt, error, scope) {
  const id = `ps-${scope}-${f.k}`;
  const set = String(own ?? '').trim() !== '';
  const amount = `${dflt}${f.unit.startsWith('%') ? '' : ' '}${f.unit}`;   // "60% context", "60 minutes"
  const under = error ? `<span class="ps-dflt warn">${ic('warn')}${esc(error)}</span>`
    : dflt == null ? `<span class="ps-dflt">${f.min === 0 && f.k === 'idleHandoffMin' ? '0 means never' : `${f.min} to ${f.max}`}</span>`
      : set ? `<span class="ps-dflt diff">Hub default ${esc(amount)}. <button type="button" class="ps-reset" data-ps-reset="${f.k}" title="Clear: use the hub default">${ic('reset')}Reset</button></span>`
        : `<span class="ps-dflt">Empty: uses the hub default, ${esc(amount)}</span>`;
  return `<div class="ps-num ${error ? 'bad' : ''}">
    <span class="ps-num-l"><label class="ps-num-label" for="${id}">${ic(f.icon)}<span>${esc(f.label)}</span></label>${help(f.tip)}</span>
    <span class="ps-num-in"><input id="${id}" type="text" inputmode="numeric" autocomplete="off" maxlength="4" data-ps-num="${f.k}" value="${esc(own ?? '')}" ${dflt != null ? `placeholder="${dflt}"` : ''} aria-describedby="${id}-d"><span class="ps-unit">${esc(f.unit)}</span></span>
    <span id="${id}-d" class="ps-under">${under}</span>
  </div>`;
}
const seg = (on, name, labels = ['Off', 'On']) => `<div class="ps-seg" role="radiogroup" aria-label="${esc(name)}">
  <button type="button" role="radio" aria-checked="${!on}" class="${on ? '' : 'on'}" data-ps-seg="${name}" data-v="0">${labels[0]}</button>
  <button type="button" role="radio" aria-checked="${on}" class="${on ? 'on' : ''}" data-ps-seg="${name}" data-v="1">${labels[1]}</button></div>`;

const head = (iconId, title) => `<header class="ps-head">${ic(iconId)}<h2 id="ps-title">${esc(title)}</h2>
  <button type="button" class="ps-x" data-ps-close aria-label="Close without changing anything" title="Close without changing anything">${ic('x')}</button></header>`;
const foot = note => `<footer class="ps-foot"><p class="ps-note">${note}</p><button type="button" class="btn primary ps-done" data-ps-done>${ic('check')}Done</button></footer>`;

// d: the draft { level, connectors, nums: { k: text }, errors: { k: text }, alwaysOpen }.
export function projectCard(p, hub, d) {
  return `${head('folder', p.name)}
  <div class="ps-body">
    <section class="ps-sec"><h3 class="ps-sec-head">How much agents may do ${help('Pick one. The chosen level shows what runs on its own and what comes to you; hover the others for theirs.')}</h3>
      <div class="ps-levels" role="radiogroup" aria-label="How much agents may do">${LEVEL_ORDER.map(k => plate(k, d.level === k)).join('')}</div>
      ${always(d.alwaysOpen)}</section>
    <section class="ps-sec"><h3 class="ps-sec-head">When the orchestrator hands off</h3>
      <div class="ps-nums">${NUMBERS.map(f => numRow(f, d.nums[f.k], hub[f.k], d.errors?.[f.k], 'p')).join('')}</div></section>
    <section class="ps-sec ps-last"><h3 class="ps-sec-head">Connectors</h3>
      <div class="ps-conn">${seg(d.connectors, 'connectors')}<p>Mail, calendar and drive tools for this project's agents. Sends, shares and deletes always come to you.</p></div></section>
  </div>
  ${foot(`Saved on this computer, not in the repo, when you press Done, and noted in ${esc(p.name)}'s orchestrator thread. Hub-wide settings are in the hub menu.`)}`;
}

// d: { route, nums: { k: text } (the three defaults and permissionTimeoutSec), errors }.
export function hubPanel(d) {
  return `${head('hub', 'Whole hub')}
  <div class="ps-body">
    <section class="ps-sec"><h3 class="ps-sec-head">Permission requests</h3>
      <div class="ps-row"><span class="ps-num-l"><span class="ps-num-label">${ic('shield')}<span>The orchestrator answers first</span></span>${help('Workers\' routine permission requests go to the orchestrator, which answers within the board\'s rules; risky ones always come to you. Off: every request comes to you.')}</span>
        ${seg(d.route, 'route')}</div>
      <div class="ps-nums">${numRow(TIMEOUT, d.nums[TIMEOUT.k], null, d.errors?.[TIMEOUT.k], 'h')}</div></section>
    <section class="ps-sec ps-last"><h3 class="ps-sec-head">Handoff defaults for every project ${help('A project can set its own numbers on its settings card; an empty box there uses these.')}</h3>
      <div class="ps-nums">${NUMBERS.map(f => numRow(f, d.nums[f.k], null, d.errors?.[f.k], 'h')).join('')}</div></section>
  </div>
  ${foot('Saved on this computer when you press Done. Numbers a project set for itself stay as they are.')}`;
}

// What Done sends for a project: only what changed. Returns { body, errors }.
export function projectChanges(p, d) {
  const errors = {}, handoff = {};
  for (const f of NUMBERS) {
    const r = readNumber(d.nums[f.k], f);
    if (r.error) { errors[f.k] = r.error; continue; }
    if (r.value !== (p.ownHandoff?.[f.k] ?? null)) handoff[f.k] = r.value;
  }
  const body = {};
  if (d.level !== levelOf(p)) body.permissionMode = d.level;
  if (d.connectors !== !!p.connectors) body.connectors = d.connectors;
  if (Object.keys(handoff).length) body.handoff = handoff;
  return { body, errors };
}
export function hubChanges(settings, d) {
  const errors = {}, body = {};
  for (const f of [TIMEOUT, ...NUMBERS]) {
    const r = readNumber(d.nums[f.k], f, { allowEmpty: false });
    if (r.error) { errors[f.k] = r.error; continue; }
    if (r.value !== settings[f.k]) body[f.k] = r.value;
  }
  if (d.route !== (settings.routePermissions !== false)) body.routePermissions = d.route;
  return { body, errors };
}

// The two pop-ups. host: { api(path, body), reload(), toast(msg), sideRect() }.
export class SettingsCards {
  constructor(host) {
    this.host = host;
    this.el = document.createElement('dialog');
    this.el.className = 'pset';
    this.el.setAttribute('aria-labelledby', 'ps-title');
    document.body.append(this.el);
    this.el.addEventListener('click', e => this.click(e));
    this.el.addEventListener('input', e => this.input(e));
    this.el.addEventListener('keydown', e => this.key(e));
    this.el.addEventListener('toggle', e => { if (e.target.matches?.('.ps-always') && this.d) this.d.alwaysOpen = e.target.open; }, true);
    this.el.addEventListener('close', () => { this.kind = null; this.d = null; this.opener?.focus?.({ preventScroll: true }); });
    addEventListener('resize', () => this.place());
  }
  get open() { return this.el.open; }

  openProject(p, { alwaysOpen = false } = {}) {
    this.kind = 'project'; this.p = p;
    const s = this.host.hubSettings();
    this.hub = Object.fromEntries(NUMBERS.map(f => [f.k, s[f.k]]));   // the hub defaults, shown under each box
    const own = p.ownHandoff || {};
    this.d = { level: levelOf(p), connectors: !!p.connectors, nums: Object.fromEntries(NUMBERS.map(f => [f.k, own[f.k] == null ? '' : String(own[f.k])])), errors: {}, alwaysOpen };
    this.show();
  }
  openHub() {
    const s = this.host.hubSettings();
    this.kind = 'hub';
    this.d = { route: s.routePermissions !== false, nums: Object.fromEntries([TIMEOUT, ...NUMBERS].map(f => [f.k, String(s[f.k] ?? '')])), errors: {} };
    this.show();
  }
  show() {
    this.opener = document.activeElement;
    this.render();
    if (!this.el.open) this.el.showModal();
    this.place();
    (this.el.querySelector('.ps-lv.on') || this.el.querySelector('.ps-x'))?.focus({ preventScroll: true });
  }
  render() {
    const keep = this.el.querySelector('.ps-body')?.scrollTop || 0;
    this.el.classList.toggle('hubp', this.kind === 'hub');
    this.el.innerHTML = this.kind === 'hub' ? hubPanel(this.d) : projectCard(this.p, this.hub, this.d);
    const body = this.el.querySelector('.ps-body'); if (body) body.scrollTop = keep;
  }
  // On a desk the card opens beside the thread list, level with the project row (the chip it came from); on a phone
  // it fills the screen (project-settings.css).
  place() {
    if (!this.el.open) return;
    const r = this.host.sideRect?.();
    if (!r || matchMedia('(max-width: 720px)').matches) { this.el.style.left = ''; this.el.style.top = ''; return; }
    const left = Math.round(r.right + 16);
    this.el.style.left = `${left}px`;
    this.el.style.setProperty('--ps-left', `${left}px`);
    this.el.style.top = `${this.kind === 'hub' ? 16 : 56}px`;
  }
  close() { if (this.el.open) this.el.close(); }

  click(e) {
    if (e.target === this.el) return this.close();   // a click outside the card (on the backdrop)
    if (e.target.closest('[data-ps-close]')) return this.close();
    if (e.target.closest('[data-ps-done]')) return this.done();
    const lv = e.target.closest('[data-ps-level]');
    if (lv && this.d.level !== lv.dataset.psLevel) { this.d.level = lv.dataset.psLevel; this.render(); this.el.querySelector('.ps-lv.on')?.focus({ preventScroll: true }); return; }
    const sg = e.target.closest('[data-ps-seg]');
    if (sg) { this.d[sg.dataset.psSeg === 'route' ? 'route' : 'connectors'] = sg.dataset.v === '1'; this.render(); this.el.querySelector(`[data-ps-seg="${sg.dataset.psSeg}"].on`)?.focus(); return; }
    const rs = e.target.closest('[data-ps-reset]');
    if (rs) { this.d.nums[rs.dataset.psReset] = ''; delete this.d.errors[rs.dataset.psReset]; this.render(); this.el.querySelector(`[data-ps-num="${rs.dataset.psReset}"]`)?.focus(); }
  }
  input(e) {
    const k = e.target.dataset?.psNum;
    if (!k) return;
    this.d.nums[k] = e.target.value;
    if (this.d.errors[k]) { delete this.d.errors[k]; const row = e.target.closest('.ps-num'); row?.classList.remove('bad'); }
  }
  // Arrow keys move between the levels (a radio group); Enter or Space picks the focused one. Enter in a box saves.
  key(e) {
    const lv = e.target.closest?.('[data-ps-level]');
    if (lv && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', ' ', 'Enter'].includes(e.key)) {
      e.preventDefault();
      const i = LEVEL_ORDER.indexOf(lv.dataset.psLevel);
      const next = e.key === ' ' || e.key === 'Enter' ? LEVEL_ORDER[i] : LEVEL_ORDER[(i + (/Down|Right/.test(e.key) ? 1 : LEVEL_ORDER.length - 1)) % LEVEL_ORDER.length];
      this.d.level = next; this.render(); this.el.querySelector('.ps-lv.on')?.focus();
      return;
    }
    if (e.key === 'Enter' && e.target.matches?.('[data-ps-num]')) { e.preventDefault(); this.done(); }
  }
  async done() {
    const { body, errors } = this.kind === 'hub' ? hubChanges(this.host.hubSettings(), this.d) : projectChanges(this.p, this.d);
    if (Object.keys(errors).length) {
      this.d.errors = errors; this.render();
      this.el.querySelector('.ps-num.bad input')?.focus();
      return;
    }
    if (!Object.keys(body).length) return this.close();
    const btn = this.el.querySelector('[data-ps-done]'); if (btn) btn.disabled = true;
    try {
      await this.host.api('/api/settings', this.kind === 'hub' ? body : { project: this.p.name, ...body });
      this.close();
      await this.host.reload();
    } catch (err) {
      if (btn) btn.disabled = false;
      this.host.toast(err.message || 'Could not save the settings.');
    }
  }
}
