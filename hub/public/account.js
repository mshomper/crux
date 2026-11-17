// The Account card (decision 78 A): which account the agents run on, Plan sign-in or API key, chosen here instead of
// environment variables and a terminal. Opened from the usage panel (usage-ui.js). Same HUD plates as the project cards
// (project-settings.css). The page only ever knows the last four characters of a key; a pasted key goes to the hub in
// one same-origin request and is dropped from the page at once.
//   accountLine(v)       the one line that says what is in use ("Plan sign-in: Alex Doe", "API key ending ...a1b2")
//   accountCard(v, d)    the card as an HTML string (testable without a browser)
//   AccountCard          the pop-up: host { api(path, body), switchTo(body), account() }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (id, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

export const accountLine = v => v?.mode === 'key' ? `API key ending ...${v.keyEnd || '????'}` : `Plan sign-in${v?.planName ? `: ${v.planName}` : ''}`;
export const KEY_HINT = 'Paste your API key (sk-ant-...)';
export const PROTECT_NOTE = 'Kept in Windows\' protected storage for your user, not in any project folder.';

// Whether Switch is on, and what it says.
export function switchState(v, d) {
  if (!v || v.envLocked) return { ok: false, word: 'Switch' };
  const typed = String(d.key || '').trim().length > 0;
  if (d.pick === 'plan') return { ok: v.mode !== 'plan', word: 'Switch' };
  if (!v.canProtect) return { ok: false, word: 'Switch' };
  if (v.mode === 'key') return { ok: typed, word: 'Replace key' };
  return { ok: typed || !!v.savedEnd, word: 'Switch' };
}

function planPlate(v, d) {
  const on = d.pick === 'plan', cur = v.mode === 'plan';
  const who = v.planName ? `Signed in as <b>${esc(v.planName)}</b>` : 'No one is signed in on this PC yet.';
  return `<div class="ps-lv ${on ? 'on' : ''}" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-ac-pick="plan">
    <div class="ps-lv-top"><span class="ps-hex">${ic('user')}</span><span class="ps-lv-name">Plan sign-in</span>${cur ? `<span class="ps-mark">${ic('check')}In use</span>` : ''}</div>
    <div class="ps-lv-sub">Agents use the Claude plan this PC is signed in to, and draw on its limits.</div>
    ${on ? `<div class="ps-lv-body">
      <div class="ac-who">${ic('user')}<span>${who}</span></div>
      <div class="ac-row"><button type="button" class="btn" data-ac-signin ${d.busy ? 'disabled' : ''}>${ic('external')}Sign in as someone else</button></div>
      ${d.waiting ? `<p class="ps-dflt">Waiting for the sign-in window... <button type="button" class="ps-reset" data-ac-recheck>${ic('reset')}Check again</button></p>` : ''}
      <p class="ps-lv-warn">${ic('warn')}<span>This also switches your other Claude Code sessions on this PC.</span></p>
      ${d.signinNote ? `<p class="ps-dflt">${esc(d.signinNote)}</p>` : ''}
    </div>` : ''}
  </div>`;
}
function keyPlate(v, d) {
  const on = d.pick === 'key', cur = v.mode === 'key';
  return `<div class="ps-lv ${on ? 'on' : ''}" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-ac-pick="key">
    <div class="ps-lv-top"><span class="ps-hex">${ic('key')}</span><span class="ps-lv-name">API key</span>${cur ? `<span class="ps-mark">${ic('check')}In use</span>` : ''}</div>
    <div class="ps-lv-sub">Pay per use: Anthropic bills the tokens the agents use to your key. The strip shows tokens and dollars.</div>
    ${on ? `<div class="ps-lv-body">
      ${!v.canProtect ? `<p class="ps-lv-warn">${ic('warn')}<span>This computer cannot protect a saved key (Windows only). Set ANTHROPIC_API_KEY and CRUX_HUB_USE_API_KEY=1 in the environment instead; the README shows how.</span></p>` : `
      ${v.savedEnd ? `<div class="ac-who">${ic('key')}<span>A key ending <b>...${esc(v.savedEnd)}</b> is saved. Paste a new one to replace it.</span></div>` : ''}
      <input class="ac-field" type="password" name="crux-api-key" autocomplete="off" autocapitalize="off" spellcheck="false" data-ac-key placeholder="${esc(KEY_HINT)}" aria-label="API key" value="">
      <p class="ac-lock">${ic('lock')}<span>${esc(PROTECT_NOTE)}</span></p>`}
    </div>` : ''}
  </div>`;
}

export const IMPORT_NOTE = 'An agent drafts your profile from it, and you approve it as one batch in Needs you. Nothing is written before you approve. The export is read as data only.';
// The Profile part of the card (decision 79 A): whether a profile exists, Create, and Import from another assistant.
export function profileSection(pf, d) {
  if (!pf) return '';
  const packs = pf.packs ? `, ${pf.packs} project pack${pf.packs === 1 ? '' : 's'}` : '';
  return `<section class="ps-sec ps-last ac-profile"><div class="ps-sec-head">Profile</div>
    <div class="ac-now"><span class="ps-hex ${pf.exists ? 'on' : ''}">${ic('file-text')}</span>
      <div><b>${pf.exists ? 'Profile found' : 'No profile yet'}</b><span class="ac-sub">${pf.exists ? `Core${packs}${pf.hasPrivate ? ', private notes' : ''}.${pf.missing?.length ? ' Some files are missing.' : ''}` : 'Agents start without notes on how you like to work.'}</span></div></div>
    <div class="ac-row ac-pf-row">${pf.exists && !pf.missing?.length ? '' : `<button type="button" class="btn primary" data-pf-create ${d.pfBusy ? 'disabled' : ''}>${ic('plus')}${pf.exists ? 'Create missing files' : 'Create profile'}</button>`}
      <button type="button" class="btn" data-pf-open aria-expanded="${!!d.pfOpen}">${ic('download')}Import from another assistant</button></div>
    ${d.pfNote ? `<p class="ps-dflt diff ac-pf-note">${esc(d.pfNote)}</p>` : ''}
    ${d.pfOpen ? `<div class="ac-import">
      <div class="ac-drop" data-pf-drop><textarea class="ac-field ac-text" data-pf-text rows="5" spellcheck="false" placeholder="Paste the export here, or drop a file on this box" aria-label="Export from another assistant">${esc(d.pfText || '')}</textarea></div>
      <p class="ac-lock">${ic('check')}<span>${esc(IMPORT_NOTE)} Up to ${Number(pf.importCap || 60000).toLocaleString('en-US')} characters.</span></p>
      <div class="ac-row"><button type="button" class="btn primary" data-pf-send ${(d.pfText || '').trim() && !d.pfBusy ? '' : 'disabled'}>${ic('send')}${d.pfBusy ? 'Sorting it...' : 'Sort it'}</button>
        <button type="button" class="btn ghost" data-pf-file-btn>${ic('file-text')}Choose a file</button><input type="file" accept=".txt,.md,.json,.csv,text/*" data-pf-file hidden></div></div>` : ''}
    ${d.pfError ? `<p class="ps-dflt warn ac-err" role="alert">${ic('warn')}${esc(d.pfError)}</p>` : ''}
  </section>`;
}

export function accountCard(v, d) {
  const sw = switchState(v, d);
  return `<div class="ps-head"><h2 id="ps-title">Account</h2><button type="button" class="ps-x" data-ac-close aria-label="Close without changing anything" title="Close without changing anything">${ic('x')}</button></div>
  <div class="ps-body">
    <section class="ps-sec"><div class="ps-sec-head">In use now</div>
      <div class="ac-now"><span class="ps-hex on">${ic(v.mode === 'key' ? 'key' : 'user')}</span>
        <div><b>${esc(accountLine(v))}</b><span class="ac-sub">${v.mode === 'key' ? 'Pay per use, billed to this key.' : 'Drawing on this plan\'s limits.'}</span></div></div>
      ${v.problem ? `<p class="ps-lv-warn ac-env">${ic('warn')}<span>${esc(v.problem)}</span></p>` : ''}
      ${v.envLocked ? `<p class="ps-lv-warn ac-env">${ic('warn')}<span>This key comes from the environment variables ANTHROPIC_API_KEY and CRUX_HUB_USE_API_KEY. They win over this card: remove them and restart the hub to choose here.</span></p>` : ''}
    </section>
    <section class="ps-sec"><div class="ps-sec-head">Choose</div>
      <div class="ps-levels ${v.envLocked ? 'ac-locked' : ''}" role="radiogroup" aria-label="Account">${planPlate(v, d)}${keyPlate(v, d)}</div>
      ${d.error ? `<p class="ps-dflt warn ac-err" role="alert">${ic('warn')}${esc(d.error)}</p>` : ''}
    </section>
    ${profileSection(d.profile, d)}
  </div>
  <div class="ps-foot">
    <p class="ps-note ac-restart">${ic('warn')}<span>Switching restarts the hub. This page reconnects by itself, and agents carry on after it.</span></p>
    <button type="button" class="btn ghost" data-ac-close>Cancel</button>
    <button type="button" class="btn primary ps-done" data-ac-switch ${sw.ok && !d.busy ? '' : 'disabled'}>${ic('restart')}${sw.word}</button>
  </div>`;
}

export class AccountCard {
  constructor(host) {
    this.host = host;
    this.el = document.createElement('dialog');
    this.el.className = 'pset acard';
    this.el.setAttribute('aria-labelledby', 'ps-title');
    document.body.append(this.el);
    this.el.addEventListener('pointerdown', e => { this.downOutside = e.target === this.el; });
    this.el.addEventListener('click', e => this.click(e));
    this.el.addEventListener('input', e => {
      if (e.target.matches?.('[data-ac-key]')) { this.typedKey = this.d.key = e.target.value; this.d.error = ''; this.refreshSwitch(); }
      else if (e.target.matches?.('[data-pf-text]')) { this.d.pfText = e.target.value; this.d.pfError = ''; const b = this.el.querySelector('[data-pf-send]'); if (b) b.disabled = !(this.d.pfText.trim() && !this.d.pfBusy); }
    });
    // drop a file on the paste box: its text goes in (up to the cap; the hub says plainly if it is too long)
    this.el.addEventListener('dragover', e => { if (e.target.closest?.('[data-pf-drop]')) { e.preventDefault(); e.target.closest('[data-pf-drop]').classList.add('over'); } });
    this.el.addEventListener('dragleave', e => e.target.closest?.('[data-pf-drop]')?.classList.remove('over'));
    this.el.addEventListener('drop', e => { const z = e.target.closest?.('[data-pf-drop]'); if (!z) return; e.preventDefault(); z.classList.remove('over'); this.takeFile(e.dataTransfer?.files?.[0]); });
    this.el.addEventListener('change', e => { if (e.target.matches?.('[data-pf-file]')) { this.takeFile(e.target.files?.[0]); e.target.value = ''; } });
    this.el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches?.('[data-ac-key]')) { e.preventDefault(); this.go(); } });
    this.el.addEventListener('close', () => { this.stopWatching(); this.typedKey = ''; if (this.d) this.d.key = ''; this.d = null; this.opener?.focus?.({ preventScroll: true }); });
    addEventListener('resize', () => this.place());
  }
  get open() { return this.el.open; }
  get view() { return this.v || this.host.account() || { mode: 'plan', canProtect: false }; }

  show() {
    this.v = null; this.typedKey = '';
    const v = this.view;
    this.d = { pick: v.mode, key: '', error: '', busy: false, waiting: false, signinNote: '', profile: this.host.profile?.() || null, pfOpen: false, pfText: '', pfBusy: false, pfError: '', pfNote: '' };
    this.opener = document.activeElement;
    this.render();
    if (!this.el.open) this.el.showModal();
    this.place();
    this.el.querySelector('.ps-lv.on')?.focus({ preventScroll: true });
  }
  render() {
    if (!this.d) return;
    const keep = this.el.querySelector('.ps-body')?.scrollTop || 0;
    // A typed key is kept across a redraw, set on the field itself and never written into the markup. d.key always equals
    // what the field holds (or will hold when it is shown again), so Switch never counts a key the field no longer has.
    const live = this.el.querySelector('[data-ac-key]'); if (live) this.typedKey = live.value;
    this.el.innerHTML = accountCard(this.view, this.d);
    const field = this.el.querySelector('[data-ac-key]'); if (field) field.value = this.typedKey || '';
    this.d.key = this.typedKey || '';
    const body = this.el.querySelector('.ps-body'); if (body) body.scrollTop = keep;
  }
  refreshSwitch() {
    const b = this.el.querySelector('[data-ac-switch]'); if (!b) return;
    const s = switchState(this.view, this.d);
    b.disabled = !(s.ok && !this.d.busy);
    b.lastChild.textContent = s.word;
  }
  // Same place as the project cards: beside the thread list on a desk, the whole screen on a phone.
  place() {
    if (!this.el.open) return;
    const r = this.host.sideRect?.();
    if (!r || matchMedia('(max-width: 720px)').matches) { this.el.style.left = ''; this.el.style.top = ''; return; }
    const left = Math.round(r.right + 16);
    this.el.style.left = `${left}px`;
    this.el.style.setProperty('--ps-left', `${left}px`);
    this.el.style.top = '56px';
  }
  close() { if (this.el.open) this.el.close(); }

  click(e) {
    if (e.target === this.el) { const out = this.downOutside; this.downOutside = false; return out ? this.close() : undefined; }
    if (e.target.closest('[data-ac-close]')) return this.close();
    if (e.target.closest('[data-ac-switch]')) return void this.go();
    if (e.target.closest('[data-ac-signin]')) return void this.signIn();
    if (e.target.closest('[data-ac-recheck]')) return void this.refresh();
    if (e.target.closest('[data-pf-create]')) return void this.createProfile();
    if (e.target.closest('[data-pf-open]')) { this.d.pfOpen = !this.d.pfOpen; this.d.pfError = ''; this.render(); this.el.querySelector('[data-pf-text]')?.focus({ preventScroll: true }); this.el.querySelector('.ac-import')?.scrollIntoView({ block: 'end' }); return; }
    if (e.target.closest('[data-pf-file-btn]')) return void this.el.querySelector('[data-pf-file]')?.click();
    if (e.target.closest('[data-pf-send]')) return void this.sendImport();
    const pick = e.target.closest('[data-ac-pick]');
    if (pick && !this.view.envLocked && this.d.pick !== pick.dataset.acPick) {
      this.d.pick = pick.dataset.acPick; this.d.error = '';
      this.render();
      this.el.querySelector('[data-ac-key]')?.focus({ preventScroll: true });
    }
  }

  async go() {
    const s = switchState(this.view, this.d);
    if (!s.ok || this.d.busy) return;
    const body = this.d.pick === 'plan' ? { mode: 'plan' } : { mode: 'key', ...(this.d.key.trim() ? { apiKey: this.d.key.trim() } : {}) };
    this.d.busy = true; this.d.error = ''; this.render();
    try {
      await this.host.switchTo(body);   // restarts the hub and waits for it to come back
      this.close();
    } catch (e) {
      if (!this.d) return;
      this.d.busy = false; this.d.error = e.message || 'The account was not changed.'; this.render();
    } finally { body.apiKey = ''; }
  }

  // ---------- the profile (decision 79 A) ----------
  async createProfile() {
    this.d.pfBusy = true; this.d.pfError = ''; this.render();
    try {
      const r = await this.host.api('/api/profile/create', {});
      this.host.setProfile?.(r.profile); this.d.profile = r.profile;
      const git = { initialised: ', and a local git repository was started in your home Crux folder (nothing is sent anywhere)', unavailable: '. Git is not installed on this PC, so the folder is not under version control', inside: '. Your home Crux folder sits inside another git repository, so it was left as it is: check that repository is private' }[r.git] || '';
      this.d.pfNote = `${r.created?.length ? (r.skipped?.length ? 'Missing profile files created' : 'Profile created') : 'Nothing was missing'}${git}. Fill it in with Import, or let agents add lessons as you work.`;
    } catch (e) { this.d.pfError = e.message; }
    this.d.pfBusy = false; this.render();
  }
  async takeFile(file) {
    if (!file) return;
    const cap = this.d.profile?.importCap || 60000;
    // The size is checked before the file is read: a huge file is never loaded into the page (a character is at most 4 bytes).
    if (file.size > cap * 4) { this.d.pfOpen = true; this.d.pfError = `That file is ${(file.size / 1048576).toFixed(1)} MB; at most ${cap.toLocaleString('en-US')} characters are taken in one go. Cut it down first.`; return this.render(); }
    try {
      const text = await file.text();
      this.d.pfOpen = true; this.d.pfText = text; this.d.pfError = text.length > cap ? `That file is ${text.length.toLocaleString('en-US')} characters; at most ${cap.toLocaleString('en-US')} are taken in one go. Cut it down first.` : '';
    } catch { this.d.pfError = 'That file could not be read as text.'; }
    this.render();
  }
  async sendImport() {
    const text = this.d.pfText.trim();
    if (!text || this.d.pfBusy) return;
    this.d.pfBusy = true; this.d.pfError = ''; this.render();
    try {
      await this.host.api('/api/profile/import', { project: this.host.project?.(), text });
      this.d.pfText = '';
      this.close();
      this.host.afterImport?.();   // Needs you, where the batch waits
    } catch (e) { this.d.pfBusy = false; this.d.pfError = e.message; this.render(); }
  }

  // "Sign in as someone else": the hub opens a terminal window on this PC; then the card re-reads who is signed in.
  async signIn() {
    this.d.busy = true; this.d.signinNote = ''; this.render();
    try {
      const r = await this.host.api('/api/account/signin', {});
      this.d.busy = false;
      if (r.opened) { this.d.waiting = true; this.d.baseId = this.view.planId || null; this.watch(); }
      else this.d.signinNote = r.test ? 'A test hub opens no sign-in window.' : `Open a terminal on this PC and run: ${r.command || 'claude auth login'}`;
    } catch (e) { this.d.busy = false; this.d.error = e.message; }
    this.render();
  }
  async refresh() {
    try {
      this.v = await this.host.api('/api/account');
      // The person is compared by id (two people can share a display name); an unreadable first look is replaced by the first
      // one that can be read, never counted as a change (the hub itself watches and restarts, this only words the card).
      if (this.d?.waiting && !this.d.baseId && this.v.planId) this.d.baseId = this.v.planId;
      const changed = this.d?.waiting && this.d.baseId && this.v.planId && this.v.planId !== this.d.baseId;
      if (changed) { this.d.waiting = false; this.stopWatching(); this.d.signinNote = `Signed in as ${this.v.planName}. The hub restarts in a moment so its agents use it.`; }
      this.render();
      if (changed) setTimeout(() => this.close(), 2500);   // the hub restarts by itself when it sees the new name (even with this card closed)
    } catch { /* the hub is busy: the next check tries again */ }
  }
  watch() {
    this.stopWatching();
    const until = Date.now() + 3 * 60 * 1000;
    this.timer = setInterval(() => { if (Date.now() > until) { if (this.d) { this.d.waiting = false; this.render(); } return this.stopWatching(); } this.refresh(); }, 3000);
  }
  stopWatching() { clearInterval(this.timer); this.timer = null; }
}
