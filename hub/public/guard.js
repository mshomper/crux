// The page side of the write guard (decision 47 B): "Pair this device", the step-up prompt ("Confirm it's you") and
// the Devices panel, plus post(), which every change in the page goes through:
//   401 { pair }   -> the Pair panel opens; the change is not made
//   403 { stepUp } -> the step-up prompt opens for exactly that change, then sends it again with the passkey's answer
// Passkeys: navigator.credentials.create / get. The page sends the new key as SPKI (getPublicKey) and the raw
// authenticator data, which the hub checks with node:crypto (lib/webauthn.mjs). Plain ES module; HTML as strings.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (id, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
export const toB64u = buf => { let s = ''; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
export const fromB64u = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));

// What this device calls its passkey, and a first guess at its name.
export function platform(nav = globalThis.navigator || {}) {
  const ua = String(nav.userAgent || ''), touchMac = nav.platform === 'MacIntel' && nav.maxTouchPoints > 1;
  const ios = /iP(hone|ad|od)/.test(ua) || touchMac;
  if (ios) return { ios, word: 'Face ID', glyph: 'face', name: /iPad/.test(ua) || touchMac ? 'iPad' : 'iPhone' };
  if (/Windows/.test(ua)) return { ios, word: 'Windows Hello', glyph: 'finger', name: 'Windows PC' };
  if (/Android/.test(ua)) return { ios, word: 'your screen lock', glyph: 'finger', name: 'Android phone' };
  if (/Macintosh/.test(ua)) return { ios, word: 'Touch ID', glyph: 'finger', name: 'Mac' };
  return { ios, word: 'your passkey', glyph: 'key', name: 'Browser' };
}

// Where a pairing code comes from, for this hub and this device (GET /api/auth/status: codeWhere 'window' | 'none',
// devices = how many are paired). The hub shows a code only in its own window, never in a file (decision 47 review).
const WINDOW = 'the hub\'s own window on the PC (Crux Hub, on the taskbar)';
export function codeHelp(st = {}) {
  const win = st.codeWhere === 'window';
  if (!st.devices) return { text: `The code is in ${WINDOW}.`, print: win };
  return { text: `Get a code on a device already paired: hub menu, Devices, Pair another device.${win ? ` Lost a passkey? The code in ${WINDOW} works too.` : ''}`, print: false };
}
export const START_OVER_NO_WINDOW = 'Starting over needs the hub in a window. Delete devices.json in the .crux-hub folder in your user folder, then double-click Restart Crux Hub.vbs: with no device paired, the hub opens in a window with a code. Every device then pairs again.';

// ---------- the panels, as HTML (testable without a browser) ----------
const head = (iconId, title) => `<header class="ps-head">${ic(iconId)}<h2 id="g-title">${esc(title)}</h2>
  <button type="button" class="ps-x" data-g-close aria-label="Close without changing anything" title="Close without changing anything">${ic('x')}</button></header>`;
const warnLine = text => `<p class="g-warn">${ic('warn')}<span>${esc(text)}</span></p>`;
const steps = n => `<ol class="g-steps" aria-label="Steps"><li class="${n === 1 ? 'on' : 'done'}"><span class="g-hex">1</span>Code</li><li class="g-steps-line"></li><li class="${n === 2 ? 'on' : n > 2 ? 'done' : ''}"><span class="g-hex">2</span>Passkey</li></ol>`;
const glyph = (id, live = false) => `<span class="g-glyph ${live ? 'live' : ''}" aria-hidden="true"><i class="g-ring"></i><i class="g-scan"></i>${ic(id)}</span>`;

// s: { step: 'code' | 'make' | 'done' | 'noname' | 'nokey', st (auth status), plat, code, label, error, busy, standalone }
export function pairPanel(s) {
  const p = s.plat, st = s.st || {};
  let body;
  const pc = st.pcUrl || `http://localhost:${st.port || 4747}`;
  if (s.step === 'noname') {
    body = `<div class="g-hero">${glyph('key')}<div><p class="g-lead">This PC pairs at the hub's own name</p>
      <p class="g-sub">Passkeys need a name, and on this PC the hub keeps its cookie on ${esc(pc.replace(/^http:\/\//, ''))} only, so other programs never receive it.</p></div></div>
      <a class="btn primary g-wide" href="${esc(pc)}/">${ic('external')}Open ${esc(pc)}</a>`;
  } else if (s.step === 'nowindow') {
    body = `<div class="g-hero">${glyph('pc')}<div><p class="g-lead">Start the hub in a window to pair the first device</p>
      <p class="g-sub">The hub shows the first pairing code only in its own window, never in a file. Double-click <b>Restart Crux Hub.vbs</b> in the hub folder: with no device paired yet, it restarts the hub in a window (Crux Hub, on the taskbar). Then reload this page.</p></div></div>
      <button type="button" class="btn ghost g-wide" data-g-close>Close</button>`;
  } else if (s.step === 'nokey') {
    body = `<div class="g-hero">${glyph('key')}<div><p class="g-lead">This browser cannot make passkeys here.</p>
      <p class="g-sub">Use Edge or Chrome on the PC at ${esc(pc)}, or the Crux app on your phone's home screen (its Tailscale address).</p></div></div>`;
  } else if (s.step === 'done') {
    body = `<div class="g-hero g-done">${glyph('check')}<div><p class="g-lead">Paired</p><p class="g-sub">${esc(s.label)} can now answer cards, pick and send. Big changes still ask for ${esc(p.word)}.</p></div></div>`;
  } else if (s.step === 'make') {
    body = `${steps(2)}
      <div class="g-hero">${glyph(p.glyph, true)}<div><p class="g-lead">Make this device's passkey</p>
        <p class="g-sub">${esc(p.word === 'your passkey' ? 'Your device' : p.word)} asks for your face, fingerprint or PIN. Only a public key leaves this device.</p></div></div>
      ${s.error ? warnLine(s.error) : ''}
      <button type="button" class="btn primary g-big" data-g-make ${s.busy ? 'disabled' : ''}>${ic(p.glyph)}Use ${esc(p.word)}</button>
      <button type="button" class="btn ghost g-wide" data-g-back>${ic('back')}Back</button>`;
  } else {
    const help = codeHelp(st);
    body = `${steps(1)}
      <div class="g-hero">${glyph('key')}<div><p class="g-lead">Changes from this device need a passkey first</p>
        <p class="g-sub">Pair once with ${esc(p.word)}. After that, answers, picks and messages need no taps; only big changes ask again.</p></div></div>
      ${p.ios && !s.standalone ? warnLine('Pair from the Crux app on your home screen: Safari and the home-screen app keep separate sign-ins.') : ''}
      <label class="g-field"><span class="g-cap">${ic('lock')}Pairing code</span>
        <input class="g-code" data-g-code type="text" inputmode="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="9" placeholder="XXXX-XXXX" value="${esc(s.code || '')}" aria-describedby="g-code-where"></label>
      <p class="g-hint" id="g-code-where">${esc(help.text)} Never send it to an agent.
        ${help.print ? `<button type="button" class="ps-reset" data-g-print title="The hub shows a fresh code in its own window; the old one stops working">${ic('reset')}Show a new code</button>` : ''}</p>
      <label class="g-field"><span class="g-cap">${ic(p.glyph === 'face' ? 'phone' : 'pc')}Name for this device</span>
        <input data-g-label type="text" autocomplete="off" maxlength="40" value="${esc(s.label || p.name)}"></label>
      ${s.error ? warnLine(s.error) : ''}
      <button type="button" class="btn primary g-big" data-g-next ${s.busy ? 'disabled' : ''}>${ic('chev')}Next</button>
      ${st.devices ? `<details class="g-fold"><summary>${ic('help')}<span>Lost a passkey?</span>${ic('chev', 'ps-chev')}</summary>
        ${st.codeWhere === 'window'
          ? `<p>Use the code from the hub's own window (not one from another device) and start over: every paired device is unpaired, then this one pairs. Your phone gets a notification.</p>
        <button type="button" class="btn deny g-wide" data-g-startover ${s.busy ? 'disabled' : ''}>${ic('unlink')}Unpair every device, then pair this one</button>`
          : `<p>${esc(START_OVER_NO_WINDOW)}</p>`}</details>` : ''}`;
  }
  return `${head('key', 'Pair this device')}<div class="ps-body g-body">${body}</div>`;
}

// s: { need: { why }, plat, ready, busy, error }
export function stepUpPanel(s) {
  const p = s.plat;
  return `${head('shield', 'Confirm it\'s you')}<div class="ps-body g-body">
    <div class="g-hero">${glyph(p.glyph, true)}<div><p class="g-lead">${esc(s.need?.why || 'A big change')}</p>
      <p class="g-sub">Only big changes ask for this. Good for one minute, for this change only.</p></div></div>
    ${s.error ? warnLine(s.error) : ''}
    <button type="button" class="btn primary g-big" data-g-confirm ${s.ready && !s.busy ? '' : 'disabled'}>${ic(p.glyph)}${s.busy ? 'Waiting for ' : 'Confirm with '}${esc(p.word)}</button>
    <button type="button" class="btn ghost g-wide" data-g-close>Cancel</button></div>`;
}

const when = iso => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString([], { day: 'numeric', month: 'short' }); };
const ago = iso => { if (!iso) return 'never'; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
// s: { list: { devices, push }, code, error, busy }
export function devicesPanel(s) {
  const L = s.list || { devices: [], push: [] };
  const dev = d => `<li class="g-row ${d.you ? 'you' : ''}"><span class="g-row-ic">${ic(/ts\.net$/.test(d.address) ? 'phone' : 'pc')}</span>
    <span class="g-row-t"><b>${esc(d.label)}</b>${d.you ? '<span class="g-chip">This device</span>' : ''}<span class="g-row-s">${esc(d.address === 'localhost' ? 'this PC (localhost)' : d.address || 'test hub')} · paired ${esc(when(d.created))} · used ${esc(ago(d.lastSeen))}</span></span>
    ${d.test ? '' : `<button type="button" class="btn ghost icon-only g-rm" data-g-unpair="${esc(d.id)}" aria-label="Unpair ${esc(d.label)}" title="Unpair ${esc(d.label)} and forget its passkey (asks to confirm it's you)">${ic('unlink')}</button>`}</li>`;
  const sub = x => `<li class="g-row"><span class="g-row-ic">${ic('bell')}</span><span class="g-row-t"><b>${esc(x.label)}</b><span class="g-row-s">notifications since ${esc(when(x.added))}</span></span>
    <button type="button" class="btn ghost icon-only g-rm" data-g-unpush="${esc(x.id)}" aria-label="Stop notifications to ${esc(x.label)}" title="Stop notifications to ${esc(x.label)}">${ic('x')}</button></li>`;
  const code = s.code ? `<div class="g-issued"><span class="g-cap">${ic('lock')}Code for the new device</span><b class="g-code-big">${esc(s.code.code)}</b>
    <p class="g-hint">Type it on the new device under Pair this device. It works once, for ${esc(s.code.minutes)} minutes.</p></div>` : '';
  return `${head('key', 'Devices')}<div class="ps-body g-body">
    <section class="ps-sec"><h3 class="ps-sec-head">Paired devices</h3><ul class="g-list">${L.devices.map(dev).join('') || '<li class="g-none faint">None yet</li>'}</ul></section>
    <section class="ps-sec ps-last"><h3 class="ps-sec-head">Get notifications</h3><ul class="g-list">${L.push.map(sub).join('') || '<li class="g-none faint">No device yet: tap the bell on your phone</li>'}</ul></section>
    ${s.error ? warnLine(s.error) : ''}${code}
  </div>
  <footer class="ps-foot"><p class="ps-note">Every change here notifies your phone and notes it in the orchestrator thread.</p>
    <button type="button" class="btn primary" data-g-issue ${s.busy ? 'disabled' : ''}>${ic('plus')}Pair another device</button></footer>`;
}

// ---------- the controller ----------
async function raw(path, body) {
  const res = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}
const plainError = e => e?.name === 'NotAllowedError' ? 'Cancelled, or it took too long. Try again.'
  : e?.name === 'SecurityError' ? 'Passkeys do not work on this address. Open the hub at localhost, or at its Tailscale address on the phone.'
    : e?.name === 'InvalidStateError' ? 'This device already has a passkey for the hub.'
      : e?.message || 'Something went wrong.';

export class GuardUI {
  // host: { toast(msg, tone), reload(), changed(paired) }
  constructor(host) {
    this.host = host;
    this.plat = platform();
    this.st = null;
    this.panel = this.dialog('gset');          // Pair this device, Devices
    this.confirmEl = this.dialog('gset gconf'); // Confirm it's you (opens over the others)
  }
  dialog(cls) {
    const el = document.createElement('dialog');
    el.className = `pset ${cls}`;
    el.setAttribute('aria-labelledby', 'g-title');
    document.body.append(el);
    el.addEventListener('pointerdown', e => { el.downOutside = e.target === el; });
    return el;
  }
  get paired() { return !!this.st?.paired; }

  async check() {
    const r = await raw('/api/auth/status').catch(() => null);
    if (r?.ok) this.st = r.json;
    this.host.changed?.(this.st ? !!this.st.paired : null);   // null: the hub did not answer, so say nothing
    return this.st;
  }

  // Every change in the page: see the top of this file.
  async post(path, body = {}) {
    const r = await raw(path, body);
    if (r.status === 401 && r.json.pair) { if (this.st) this.st.paired = false; this.host.changed?.(false); this.openPair(); throw new Error(r.json.error); }
    if (r.status === 403 && r.json.stepUp) return this.confirm(r.json.stepUp, stepUp => raw(path, { ...body, stepUp }));
    if (!r.ok) throw new Error(r.json.error || 'The hub refused that.');
    return r.json;
  }

  // ---------- Pair this device ----------
  async openPair() {
    if (this.panel.open && this.kind === 'pair') return;
    if (!this.st) await this.check();
    const named = this.st ? this.st.webauthn : !/^\d+(\.\d+){3}$|^\[/.test(location.hostname);
    const can = typeof PublicKeyCredential !== 'undefined' && isSecureContext;
    const noWindow = this.st && !this.st.devices && this.st.codeWhere !== 'window';   // the first device needs the hub in a window
    this.kind = 'pair';
    this.s = { step: !named ? 'noname' : !can ? 'nokey' : noWindow ? 'nowindow' : 'code', st: this.st, plat: this.plat, label: this.plat.name, standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true };
    this.show(this.panel, () => pairPanel(this.s));
    this.panel.onclick = e => this.pairClick(e);
    this.panel.oninput = e => { if (e.target.matches('[data-g-code]')) this.s.code = e.target.value; if (e.target.matches('[data-g-label]')) this.s.label = e.target.value; };
    this.panel.onkeydown = e => { if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); this.pairNext(false); } };
    this.panel.querySelector('[data-g-code]')?.focus({ preventScroll: true });
  }
  async pairClick(e) {
    if (this.outside(e, this.panel) || e.target.closest('[data-g-close]')) return this.panel.close();
    if (e.target.closest('[data-g-next]')) return this.pairNext(false);
    if (e.target.closest('[data-g-startover]')) return this.pairNext(true);
    if (e.target.closest('[data-g-back]')) { this.s = { ...this.s, step: 'code', error: '', options: null }; return this.redraw(this.panel); }
    if (e.target.closest('[data-g-make]')) return this.pairMake();
    if (e.target.closest('[data-g-print]')) {
      const r = await raw('/api/pair/code', {});
      this.host.toast(r.json.printed ? `A new code is in ${WINDOW}.` : r.json.waitSec ? `Wait ${r.json.waitSec} seconds before asking again.` : r.ok ? 'No new code: the hub shows one only in its window, and only for the first device.' : (r.json.error || 'The hub did not answer.'), 'info');
    }
  }
  async pairNext(startOver) {
    this.s.code = this.panel.querySelector('[data-g-code]')?.value || this.s.code;
    this.s.label = this.panel.querySelector('[data-g-label]')?.value || this.s.label;
    this.s.busy = true; this.redraw(this.panel);
    const r = await raw('/api/pair/options', { code: this.s.code, label: this.s.label, startOver });
    this.s.busy = false;
    if (!r.ok) { this.s.error = r.json.error || 'The hub refused that.'; return this.redraw(this.panel); }
    this.s = { ...this.s, step: 'make', options: r.json.publicKey, error: '' };
    this.redraw(this.panel);
    this.panel.querySelector('[data-g-make]')?.focus({ preventScroll: true });
  }
  async pairMake() {
    const o = this.s.options;
    this.s.busy = true; this.redraw(this.panel);
    try {
      const cred = await navigator.credentials.create({ publicKey: { ...o, challenge: fromB64u(o.challenge), user: { ...o.user, id: fromB64u(o.user.id) } } });
      const res = cred.response;
      if (typeof res.getPublicKey !== 'function' || !res.getPublicKey()) throw new Error('This browser is too old to pair (it cannot hand over the passkey\'s public key).');
      const r = await raw('/api/pair/finish', { credential: { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, clientDataJSON: toB64u(res.clientDataJSON), authenticatorData: toB64u(res.getAuthenticatorData()), publicKey: toB64u(res.getPublicKey()), publicKeyAlgorithm: res.getPublicKeyAlgorithm(), transports: res.getTransports?.() || [] } });
      if (!r.ok) throw new Error(r.json.error || 'The hub refused the passkey.');
      this.s = { ...this.s, step: 'done', busy: false, label: r.json.device?.label || this.s.label };
      this.redraw(this.panel);
      await this.check();
      setTimeout(() => { if (this.kind === 'pair') this.panel.close(); this.host.reload?.(); }, 1400);
    } catch (e) {
      this.s.busy = false; this.s.error = plainError(e);
      if (/expired|run out|more than 3 minutes/.test(this.s.error)) this.s.step = 'code';
      this.redraw(this.panel);
    }
  }

  // ---------- Confirm it's you (step-up) ----------
  // need: { purpose, scope, why } from the hub's 403. submit(stepUp) sends the change again; the prompt stays open on a
  // refusal so you can try again, and closes on success. Cancel: "Not changed".
  confirm(need, submit) {
    if (this.pending) this.pending.reject(new Error('Not changed: another confirmation was started.'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.c = { need, plat: this.plat, ready: false, busy: false, error: '', submit };
      this.show(this.confirmEl, () => stepUpPanel(this.c));
      this.confirmEl.onclick = e => {
        if (this.outside(e, this.confirmEl) || e.target.closest('[data-g-close]')) return this.confirmEl.close();
        if (e.target.closest('[data-g-confirm]')) this.confirmGo();
      };
      this.confirmEl.onclose = () => { const p = this.pending; this.pending = null; p?.reject(new Error('Not changed: it was not confirmed.')); };
      this.challenge();
    });
  }
  async challenge() {
    const r = await raw('/api/auth/challenge', { purpose: this.c.need.purpose, scope: this.c.need.scope });
    if (!r.ok) { this.c.error = r.json.error || 'The hub did not answer.'; if (r.status === 401) { this.confirmEl.close(); this.openPair(); return; } }
    else { this.c.options = r.json.publicKey; this.c.ready = true; }
    this.redraw(this.confirmEl);
    this.confirmEl.querySelector('[data-g-confirm]')?.focus({ preventScroll: true });
  }
  async confirmGo() {
    const o = this.c.options;
    if (!o) return;
    this.c.busy = true; this.c.error = ''; this.redraw(this.confirmEl);
    let a;
    try {
      const cred = await navigator.credentials.get({ publicKey: { ...o, challenge: fromB64u(o.challenge), allowCredentials: (o.allowCredentials || []).map(c => ({ ...c, id: fromB64u(c.id) })) } });
      const res = cred.response;
      a = { id: cred.id, clientDataJSON: toB64u(res.clientDataJSON), authenticatorData: toB64u(res.authenticatorData), signature: toB64u(res.signature) };
    } catch (e) { this.c.busy = false; this.c.error = plainError(e); this.c.ready = false; this.redraw(this.confirmEl); return this.challenge(); }
    const r = await this.c.submit(a).catch(e => ({ ok: false, status: 0, json: { error: e.message } }));
    this.c.busy = false;
    if (r.ok) { const p = this.pending; this.pending = null; this.confirmEl.close(); return p?.resolve(r.json); }
    if (r.status === 403 && r.json.stepUp) { this.c.error = r.json.error; this.c.ready = false; this.redraw(this.confirmEl); return this.challenge(); }
    const p = this.pending; this.pending = null; this.confirmEl.close();
    p?.reject(new Error(r.json.error || 'The hub refused that.'));
  }

  // ---------- Devices ----------
  async openDevices() {
    if (!this.st) await this.check();
    if (!this.paired) return this.openPair();
    this.kind = 'devices';
    this.d = { list: null, code: null, error: '', busy: false };
    await this.loadDevices();
    this.show(this.panel, () => devicesPanel(this.d));
    this.panel.oninput = null; this.panel.onkeydown = null;
    this.panel.onclick = e => this.devicesClick(e);
  }
  async loadDevices() { const r = await raw('/api/devices'); this.d.list = r.ok ? r.json : { devices: [], push: [] }; }
  async devicesClick(e) {
    if (this.outside(e, this.panel) || e.target.closest('[data-g-close]')) return this.panel.close();
    const act = async fn => { this.d.error = ''; try { await fn(); } catch (err) { this.d.error = err.message; } await this.loadDevices(); if (this.kind === 'devices' && this.panel.open) this.redraw(this.panel); };
    const un = e.target.closest('[data-g-unpair]');
    if (un) return act(async () => { const r = await this.post('/api/devices/remove', { id: un.dataset.gUnpair }); if (r.you) { await this.check(); this.panel.close(); this.host.reload?.(); } });
    const up = e.target.closest('[data-g-unpush]');
    if (up) return act(() => this.post('/api/push/remove', { id: up.dataset.gUnpush }));
    if (e.target.closest('[data-g-issue]')) return act(async () => { this.d.code = await this.post('/api/pair/issue', {}); });
  }

  // ---------- plumbing ----------
  outside(e, el) { if (e.target !== el) return false; const out = el.downOutside; el.downOutside = false; return out; }
  show(el, draw) {
    el.draw = draw;
    this.redraw(el);
    if (!el.open) el.showModal();
  }
  redraw(el) {
    const keep = el.querySelector('.ps-body')?.scrollTop || 0;
    const focused = el.contains(document.activeElement) && document.activeElement.matches('input') ? document.activeElement.dataset : null;
    el.innerHTML = el.draw();
    const body = el.querySelector('.ps-body'); if (body) body.scrollTop = keep;
    if (focused) el.querySelector(focused.gCode !== undefined ? '[data-g-code]' : focused.gLabel !== undefined ? '[data-g-label]' : 'input')?.focus({ preventScroll: true });
  }
}
