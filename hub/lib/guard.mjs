// The write guard (decision 47 B): only a paired device may act as you.
//
// - Pairing: a device registers a passkey once (Windows Hello on the PC, Face ID in the iPhone home-screen app) and
//   gets a random device token in an HttpOnly, SameSite=Strict cookie (Secure over https) named for this hub's port.
//   The hub keeps only a SHA-256 of each token, plus each passkey's public key and id, in <data>/devices.json.
// - Bootstrapping: a one-time pairing code shown only in the hub's own interactive window (a TTY), never written to a
//   file (log included), the page or the API. A hub with no window shows none: with no device paired it asks you to
//   start it in a window (and its own restarts open one). Once a device is paired, new devices get a code from a
//   paired device after Windows Hello or Face ID; the window's code is then only the lost-passkey path, and asking
//   for a fresh one without a cookie does nothing. Codes work once, expire, and five wrong tries within ten minutes
//   cancel every code for a minute.
// - On the PC the live hub is http://crux.localhost:4747 (plain localhost page loads move there): its cookie and
//   passkey belong to that name only, so other programs' servers on localhost:<port> never receive the cookie.
// - Every POST but the three pairing steps needs the cookie (server.mjs). The few big changes also need a step-up: a
//   passkey assertion with user verification, made on a hub-issued challenge less than 60 seconds old, bound to that
//   one change (purpose and scope are hashed into the challenge), used once.
// - A raise to Trusted keeps its signed step-up as the record; at start, a Trusted project whose record does not check
//   out against a paired passkey drops to Auto (dropUnbackedTrusted).
//
// What it does not stop (decision 47's residual risk): a same-user process that edits ~/.crux-hub or the hub's code,
// or lifts the browser's cookie. It stops slips and prompt injections, and makes a real attempt several deliberate
// steps, each of which pushes an alert to the phone.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { hostName, isLocalHost } from './access.mjs';
import { b64u, unb64u, sha256, verifyRegistration, verifyAssertion, challengeOf, parseAuthData, signatureOk } from './webauthn.mjs';
import { projectKey } from './settings.mjs';

export const STEP_UP_MS = 60 * 1000;            // a step-up challenge is good for this long, and once
export const PAIR_MS = 3 * 60 * 1000;           // from Next to the passkey being made
export const CONSOLE_CODE_MS = 30 * 60 * 1000;  // the code printed in the hub's window
export const DEVICE_CODE_MS = 10 * 60 * 1000;   // a code issued by a paired device
const MAX_WRONG = 5, WRONG_WINDOW_MS = 10 * 60 * 1000, LOCK_MS = 60 * 1000, PRINT_GAP_MS = 15 * 1000;
const COOKIE_MAX_AGE = 400 * 24 * 3600;          // the longest browsers keep a cookie
const SEEN_SAVE_MS = 10 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I/L

// The only POSTs a device without the cookie may make: the steps of pairing it.
export const OPEN_POSTS = new Set(['/api/pair/code', '/api/pair/options', '/api/pair/finish']);
export const PURPOSES = new Set(['project', 'hub', 'push', 'pair', 'unpair']);
export const NOT_PAIRED = 'This device is not paired with the hub, so it cannot make changes. Pair it first: "Pair this device" on the hub page.';

export class GuardError extends Error {
  constructor(message, status = 403) { super(message); this.status = status; }
}

const hashToken = t => sha256(String(t)).toString('hex');
const iso = ms => new Date(ms).toISOString();
const sameHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const cleanLabel = s => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'A device';
const cleanTransports = t => Array.isArray(t) ? t.filter(x => /^[a-z-]{2,20}$/.test(String(x))).slice(0, 6) : [];
const okDevice = d => d && typeof d.id === 'string' && typeof d.tokenHash === 'string' && d.credential && typeof d.credential.id === 'string' && typeof d.credential.publicKey === 'string';
// The challenge for a step-up: the hub's random bytes and the change it is for, hashed together. The signed
// clientDataJSON then names that change, which is what lets a stored raise be checked again at start.
export const bindChallenge = (random, purpose, scope) => sha256(random, Buffer.from(`\n${purpose}\n${scope}`));
export const scopeHas = (scope, part) => String(scope || '').split(';').includes(part);
// A project in a scope: a short hash of its folder key, so a scope stays well under the cut whatever the path.
export const projectTag = key => `project=${sha256(String(key)).toString('hex').slice(0, 24)}`;
export const projectScope = dir => projectTag(projectKey(dir));
// One cut for a scope, used both where a change says what it needs and where the challenge is made, so they match.
export const cutScope = s => String(s ?? '').slice(0, 400);
// The PC's own name for a hub: crux.localhost for the live hub on 4747, plain localhost for test hubs (which are
// opened at 127.0.0.1 and pair at localhost:<port>, a name the live hub's cookie never goes to).
export const pcNameFor = port => (Number(port) === 4747 ? 'crux.localhost' : 'localhost');
// A page load of the live hub at plain localhost moves to its own name. Returns the new address, or null.
export function pcRedirect({ method, path, url, host, port }) {
  if (method !== 'GET' || pcNameFor(port) === 'localhost' || hostName(host) !== 'localhost' || !['/', '/index.html'].includes(path)) return null;
  return `http://${pcNameFor(port)}:${Number(port)}${url}`;
}

// Where a request was made: the passkey's address (rpId), the page's origin and whether it came over https.
// Passkeys bind to a name, so 127.0.0.1 and [::1] cannot pair (webauthn: false).
// tailscale serve passes the phone's own Host through; should it ever arrive as this machine with the tailnet name in
// X-Forwarded-Host, that name is used. Either header can be written by any local program, so neither is trusted for
// anything but naming the address: a wrong name only makes the passkey check fail.
export function addressOf(headers = {}, port = 4747) {
  const fwd = hostName(String(headers['x-forwarded-host'] || '').split(',')[0]);
  const useFwd = isLocalHost(hostName(headers.host)) && /\.ts\.net$/.test(fwd);
  const hostHeader = useFwd ? String(headers['x-forwarded-host']).split(',')[0] : headers.host;
  const host = hostName(hostHeader);
  const raw = String(hostHeader || '').trim().toLowerCase().replace(/\.(?=:\d+$|$)/, '');
  let origin;
  if (isLocalHost(host)) origin = `http://${raw}`;   // checkRequest made sure it carries this hub's own port
  else if (/\.ts\.net$/.test(host)) origin = `https://${raw.replace(/:443$/, '')}`;   // tailscale serve: https only
  else {   // an extra name (CRUX_HUB_HOSTS): the scheme the page was opened with
    let scheme = 'http';
    try { const o = new URL(headers.origin); if (hostName(o.host) === host) scheme = o.protocol.slice(0, -1); } catch { }
    origin = `${scheme}://${raw.replace(scheme === 'https' ? /:443$/ : /:80$/, '')}`;
  }
  const ip = !host || host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host);
  return { rpId: host, origin, secure: origin.startsWith('https:'), webauthn: !ip, port: Number(port) };
}

export class Guard {
  // file: null keeps devices in memory only (tests). now: the clock (tests move it). print: where codes go (stdout).
  // interactive: the hub runs in a window you can see (stdout is a TTY); only then is a pairing code ever printed.
  constructor({ dir = process.env.CRUX_HUB_DATA || join(homedir(), '.crux-hub'), port = 4747, now = () => Date.now(), print = s => console.log(s), file, interactive = false } = {}) {
    Object.assign(this, { dir, port: Number(port), now, print, interactive: !!interactive });
    this.pcName = pcNameFor(port);
    this.pcUrl = `http://${this.pcName}:${this.port}`;
    this.file = file === undefined ? join(dir, 'devices.json') : file;
    this.challenges = new Map();   // challenge (base64url) -> what it is for
    this.codes = new Map();        // code -> { source: 'console' | 'device', expires, by }
    this.wrong = []; this.lockedUntil = 0; this.lastPrint = 0; this.seenSaved = 0;
    this.load();
  }
  get cookieName() { return `crux_device_${this.port}`; }

  // ---------- storage ----------
  load() {
    let d = {};
    if (this.file && existsSync(this.file)) {
      try { d = JSON.parse(readFileSync(this.file, 'utf8')); }
      catch (e) { this.print(`Could not read ${this.file} (${e.message}). No device counts as paired until one pairs again.`); }
    }
    this.devices = Array.isArray(d.devices) ? d.devices.filter(okDevice) : [];
    this.raises = d.raises && typeof d.raises === 'object' && !Array.isArray(d.raises) ? d.raises : {};
  }
  save() {
    if (!this.file) return;
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, devices: this.devices.filter(d => !d.test), raises: this.raises }, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  paired() { return this.devices.filter(d => !d.test); }

  // ---------- the device cookie ----------
  tokenOf(headers = {}) {
    for (const part of String(headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === this.cookieName) return part.slice(i + 1).trim();
    }
    return '';
  }
  deviceFor(headers = {}) {
    const t = this.tokenOf(headers);
    if (!t || t.length > 200) return null;
    const h = hashToken(t);
    const d = this.devices.find(x => sameHex(x.tokenHash, h));
    if (!d) return null;
    const now = this.now();
    d.lastSeen = iso(now);
    if (now - this.seenSaved > SEEN_SAVE_MS) { this.seenSaved = now; try { this.save(); } catch { } }
    return d;
  }
  cookie(token, secure, maxAge = COOKIE_MAX_AGE) {
    return `${this.cookieName}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  }
  clearCookie(secure) { return this.cookie('', secure, 0); }

  // A browser that sent an Origin must have sent this address's own (the signed clientDataJSON is checked too).
  sameOrigin(headers, a) {
    if (headers.origin !== undefined && headers.origin !== a.origin) throw new GuardError(`This page (${headers.origin}) is not the hub at ${a.origin}.`);
  }
  needName(a) {
    if (!a.webauthn) throw new GuardError(`Passkeys need a name, not a number: open ${this.pcUrl} to pair or confirm on this PC.`, 400);
    if (a.rpId === 'localhost' && this.pcName !== 'localhost') throw new GuardError(`On this PC the hub pairs at ${this.pcUrl}, so its cookie is never sent to other programs on localhost. Open that address.`, 400);
  }

  // ---------- pairing codes ----------
  newCode() {
    let s = '';
    while (s.length < 8) for (const x of randomBytes(12)) if (x < 248 && s.length < 8) s += ALPHABET[x % 31];   // 31 x 8 = 248: no bias
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  }
  // The console code: shown in the hub's own window only, one at a time. Never returned to a caller, and never
  // printed at all when the hub has no window (its output then goes to a log file, which any program can read).
  printCode(why = 'at start') {
    if (!this.interactive) return false;
    for (const [c, v] of this.codes) if (v.source === 'console') this.codes.delete(c);
    const code = this.newCode();
    this.codes.set(code, { source: 'console', expires: this.now() + CONSOLE_CODE_MS });
    this.lastPrint = this.now();
    const line = '-'.repeat(66);
    this.print(`${line}\n  Pairing code (${why}): ${code}\n  Type it under "Pair this device" on the hub page. It works once, for 30 minutes.\n  Never send it to anyone, and never paste it to an agent.\n${line}`);
    return true;
  }
  // "Print a new code" on the pair panel: only for the first device, only into a window, at most every 15 seconds.
  // Once a device is paired it does nothing: new devices get their code from a paired device.
  askForCode() {
    if (!this.interactive) return { printed: false, why: 'nowindow' };
    if (this.paired().length) return { printed: false, why: 'paired' };
    const wait = this.lastPrint + PRINT_GAP_MS - this.now();
    if (wait > 0) return { printed: false, waitSec: Math.ceil(wait / 1000) };
    this.printCode('asked for from the hub page');
    return { printed: true };
  }
  // A code from a paired device (after its step-up), shown on that device to type on the new one.
  issueCode(device) {
    for (const [c, v] of this.codes) if (v.source === 'device' && v.deviceId === device.id) this.codes.delete(c);
    const code = this.newCode();
    this.codes.set(code, { source: 'device', expires: this.now() + DEVICE_CODE_MS, by: device.label, deviceId: device.id });
    return { code, minutes: DEVICE_CODE_MS / 60000 };
  }
  checkCode(text) {
    const now = this.now();
    if (now < this.lockedUntil) throw new GuardError('Too many wrong codes. Wait a minute, then ask for a new code.', 429);
    const s = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const code = s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : '';
    const v = code && this.codes.get(code);
    if (v && v.expires >= now && (v.source !== 'console' || this.interactive)) return { code, ...v };
    if (v) this.codes.delete(code);
    this.wrong = this.wrong.filter(t => now - t < WRONG_WINDOW_MS);
    this.wrong.push(now);
    if (this.wrong.length >= MAX_WRONG) {
      this.wrong = []; this.lockedUntil = now + LOCK_MS; this.codes.clear();
      this.print('Pairing: five wrong codes, so every pairing code was cancelled. Ask for a new one from the hub page in a minute.');
    }
    throw new GuardError('That code is wrong or has expired. Each code works once; ask for a new one if you need to.');
  }

  putChallenge(challenge, rec) {
    const now = this.now();
    for (const [k, r] of this.challenges) if (r.expires < now) this.challenges.delete(k);
    while (this.challenges.size >= 200) this.challenges.delete(this.challenges.keys().next().value);
    this.challenges.set(challenge, rec);
  }
  takeChallenge(clientDataJSON, kind) {
    const ch = challengeOf(clientDataJSON);
    const rec = ch && this.challenges.get(ch);
    if (!rec || rec.kind !== kind) return null;
    this.challenges.delete(ch);   // tried once, whatever the outcome
    return { ch, rec };
  }

  // ---------- pairing ----------
  // Step 1: a code, a name for the device; returns the options for navigator.credentials.create. The code is checked
  // here and spent in step 2, so a passkey prompt you cancel does not burn it.
  pairOptions({ headers = {}, code, label, startOver = false }) {
    const a = addressOf(headers, this.port);
    this.sameOrigin(headers, a); this.needName(a);
    const c = this.checkCode(code);
    if (startOver && c.source !== 'console') throw new GuardError('Starting over needs the code from the hub\'s own window.');
    for (const [k, r] of this.challenges) if (r.code === c.code) this.challenges.delete(k);
    const challenge = b64u(randomBytes(32));
    const name = cleanLabel(label);
    this.putChallenge(challenge, { kind: 'create', code: c.code, source: c.source, by: c.by, startOver: !!startOver, rpId: a.rpId, origin: a.origin, label: name, expires: this.now() + PAIR_MS });
    return {
      publicKey: {
        challenge, rp: { id: a.rpId, name: 'Crux Hub' },
        user: { id: b64u(randomBytes(16)), name: `Crux Hub · ${name}`, displayName: name },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', requireResidentKey: false, userVerification: 'required' },
        timeout: 120000, attestation: 'none'
      }
    };
  }
  // Step 2: the new passkey. Returns { device, cookie, removed, via, startOver }.
  pairFinish({ headers = {}, credential }) {
    const a = addressOf(headers, this.port);
    this.sameOrigin(headers, a); this.needName(a);
    const t = this.takeChallenge(credential?.clientDataJSON, 'create');
    if (!t) throw new GuardError('This pairing has run out. Start again with Next.');
    const { ch, rec } = t, now = this.now();
    if (rec.expires < now) throw new GuardError('This pairing took more than 3 minutes. Start again with Next.');
    if (rec.rpId !== a.rpId || rec.origin !== a.origin) throw new GuardError('This pairing was started on another address.');
    const v = this.codes.get(rec.code);
    if (!v || v.expires < now) throw new GuardError('The pairing code has expired. Ask for a new one.');
    let cred;
    try { cred = verifyRegistration(credential, { challenge: ch, origin: a.origin, rpId: a.rpId }); }
    catch (e) { throw new GuardError(`The passkey was not accepted: ${e.message}.`, 400); }
    if (this.devices.some(d => d.credential?.id === cred.id)) throw new GuardError('That passkey is already paired.', 400);
    this.codes.delete(rec.code);   // a code works once
    const removed = rec.startOver ? this.devices.splice(0).filter(d => !d.test) : [];
    const token = b64u(randomBytes(32));
    const via = rec.source === 'console' ? 'the code from the hub\'s window' : `a code from ${rec.by || 'a paired device'}`;
    const device = { id: `d${randomBytes(5).toString('hex')}`, label: rec.label, rpId: a.rpId, origin: a.origin, tokenHash: hashToken(token), credential: { ...cred, transports: cleanTransports(credential.transports) }, created: iso(now), lastSeen: iso(now), via };
    this.devices.push(device);
    this.save();
    return { device, cookie: this.cookie(token, a.secure), removed, via, startOver: rec.startOver };
  }

  // ---------- step-up ----------
  // Options for navigator.credentials.get, for one change (purpose and scope come from stepUpNeed via the 403).
  challenge({ headers = {}, device, purpose, scope = '' }) {
    if (!PURPOSES.has(purpose)) throw new GuardError('Unknown kind of confirmation.', 400);
    scope = cutScope(scope);
    const a = addressOf(headers, this.port);
    this.sameOrigin(headers, a); this.needName(a);
    const random = randomBytes(32);
    const challenge = b64u(bindChallenge(random, purpose, scope));
    this.putChallenge(challenge, { kind: 'get', random: b64u(random), purpose, scope, deviceId: device.id, rpId: a.rpId, origin: a.origin, expires: this.now() + STEP_UP_MS });
    const allow = this.devices.filter(d => d.rpId === a.rpId && d.credential).map(d => ({ type: 'public-key', id: d.credential.id, ...(d.credential.transports?.length ? { transports: d.credential.transports } : {}) }));
    return { publicKey: { challenge, rpId: a.rpId, allowCredentials: allow, userVerification: 'required', timeout: STEP_UP_MS } };
  }
  // need: { purpose, scope }. Returns { ok: true, holder, proof } or { ok: false, error }.
  verifyStepUp({ headers = {}, device, stepUp, need }) {
    const fail = error => ({ ok: false, error });
    if (!stepUp || typeof stepUp !== 'object') return fail('This change needs Windows Hello or Face ID first.');
    const a = addressOf(headers, this.port);
    const t = this.takeChallenge(stepUp.clientDataJSON, 'get');
    if (!t) return fail('That confirmation was already used, or the hub never asked for it. Confirm again.');
    const { ch, rec } = t;
    if (rec.expires < this.now()) return fail('That confirmation is more than a minute old. Confirm again.');
    if (!device || rec.deviceId !== device.id) return fail('That confirmation was asked for on another device.');
    if (rec.purpose !== need.purpose || rec.scope !== need.scope) return fail('That confirmation was for a different change.');
    if (rec.rpId !== a.rpId || rec.origin !== a.origin) return fail('That confirmation was made on another address.');
    const holder = this.devices.find(d => d.rpId === a.rpId && d.credential?.id === String(stepUp.id || ''));
    if (!holder) return fail('That passkey is not paired with this hub.');
    let count;
    try { count = verifyAssertion(stepUp, holder.credential, { challenge: ch, origin: a.origin, rpId: a.rpId }); }
    catch (e) { return fail(`The confirmation did not check out: ${e.message}.`); }
    holder.credential.signCount = Math.max(Number(holder.credential.signCount) || 0, count);   // never back to 0
    holder.lastStepUp = iso(this.now());
    this.save();
    const proof = { at: iso(this.now()), deviceId: holder.id, credentialId: holder.credential.id, rpId: a.rpId, origin: a.origin, random: rec.random, purpose: rec.purpose, scope: rec.scope, clientDataJSON: stepUp.clientDataJSON, authenticatorData: stepUp.authenticatorData, signature: stepUp.signature };
    return { ok: true, holder, proof };
  }

  // ---------- Trusted raises ----------
  recordRaise(key, proof) { this.raises[key] = proof; this.save(); }
  clearRaise(key) { if (this.raises[key]) { delete this.raises[key]; this.save(); } }
  // Checked from scratch: the stored step-up names this project and Trusted, carries user verification, and is signed
  // by a passkey that is still paired.
  raiseBacked(key) {
    const r = this.raises[key];
    if (!r || typeof r !== 'object') return false;
    try {
      if (r.purpose !== 'project' || !scopeHas(r.scope, projectTag(key)) || !scopeHas(r.scope, 'trusted')) return false;
      const holder = this.devices.find(d => d.id === r.deviceId && d.rpId === r.rpId && d.credential?.id === r.credentialId);
      if (!holder) return false;
      const cdBytes = unb64u(r.clientDataJSON), adBytes = unb64u(r.authenticatorData);
      const cd = JSON.parse(cdBytes.toString('utf8'));
      if (cd.type !== 'webauthn.get' || String(cd.challenge).replace(/=+$/, '') !== b64u(bindChallenge(unb64u(r.random), r.purpose, r.scope)) || cd.origin !== r.origin) return false;
      const ad = parseAuthData(adBytes);
      if (!sha256(r.rpId).equals(ad.rpIdHash) || !ad.uv) return false;
      return signatureOk(holder.credential, adBytes, cdBytes, unb64u(r.signature));
    } catch { return false; }
  }

  // ---------- the device list ----------
  status(headers = {}) {
    const a = addressOf(headers, this.port), me = this.deviceFor(headers);
    return { paired: !!me, device: me ? { id: me.id, label: me.label, test: !!me.test } : null, address: a.rpId, webauthn: a.webauthn && !(a.rpId === 'localhost' && this.pcName !== 'localhost'),
      passkeyHere: this.devices.some(d => d.rpId === a.rpId && d.credential), devices: this.paired().length, port: this.port, pcUrl: this.pcUrl, codeWhere: this.interactive ? 'window' : 'none' };
  }
  list(headers = {}) {
    const me = this.deviceFor(headers);
    return this.devices.map(d => ({ id: d.id, label: d.label, address: d.rpId || '', created: d.created, lastSeen: d.lastSeen, via: d.via || '', you: d === me, test: !!d.test }));
  }
  remove(id) {
    const i = this.devices.findIndex(d => d.id === String(id || ''));
    if (i < 0) throw new GuardError('That device is not paired.', 404);
    const [d] = this.devices.splice(i, 1);
    this.save();
    return d;
  }

  // A test hub only (server.mjs refuses it anywhere else): one fake device, kept in memory. Its token goes out as a
  // cookie with the page, so screenshots and tests can make changes.
  testPair() {
    const token = b64u(randomBytes(32));
    this.devices.push({ id: 'dtest', label: 'Test device', rpId: '', origin: '', tokenHash: hashToken(token), credential: null, created: iso(this.now()), lastSeen: iso(this.now()), via: 'the test-hub flag', test: true });
    this.testToken = token;
    return token;
  }
}

// ---------- which changes need a step-up ----------
// Returns null, or { purpose, scope, why } for the confirmation panel. Only the server's view counts: the page learns
// what is needed from the 403 and asks for exactly that.
export function stepUpNeed(route, body = {}, hub) {
  const need = needFor(route, body, hub);
  return need && { ...need, scope: cutScope(need.scope) };   // cut as challenge() cuts it, so a long path still matches
}
function needFor(route, body, hub) {
  switch (route) {
    case 'POST /api/settings': return settingsNeed(body, hub);
    case 'POST /api/push/subscribe': return { purpose: 'push', scope: 'push', why: 'Add this device to the hub\'s notifications' };
    case 'POST /api/pair/issue': return { purpose: 'pair', scope: 'pair', why: 'Pair another device' };
    case 'POST /api/devices/remove': return { purpose: 'unpair', scope: `device=${String(body.id || '').slice(0, 40)}`, why: 'Unpair a device and its passkey' };
    default: return null;
  }
}

// Settings: raising a project to Trusted, turning its connectors on, turning orchestrator answers on, and any other
// hub-wide change (the wait, the handoff numbers and floors, and any added later). Lowering a level, connectors off,
// orchestrator answers off and a project's own handoff numbers need only the cookie.
export function settingsNeed(body = {}, hub) {
  const parts = [], why = [];
  let p = null;
  if (body.project) { try { p = hub.project(body.project); } catch { return null; } }   // the route refuses it
  if (p) {
    if (body.permissionMode === 'trusted' && hub.permissionMode(p) !== 'trusted') { parts.push('trusted'); why.push(`raise ${p.name} to Trusted`); }
    if (body.connectors === true && !hub.connectorsOn(p)) { parts.push('connectors'); why.push(`turn connectors on for ${p.name}`); }
  }
  const cur = hub.settings.all();
  if (body.routePermissions === true && cur.routePermissions === false) { parts.push('routing'); why.push('let the orchestrator answer requests'); }
  if (!p) {
    const other = Object.entries(body).filter(([k, v]) => !['project', 'stepUp', 'routePermissions'].includes(k) && v != null && v !== '' && String(v) !== String(cur[k]));
    if (other.length) { parts.push('hub'); why.push('change settings for the whole hub'); }
  }
  if (!parts.length) return null;
  const text = why.join(' and ');
  return p ? { purpose: 'project', scope: [projectScope(p.dir), ...parts].join(';'), why: text[0].toUpperCase() + text.slice(1) }
    : { purpose: 'hub', scope: parts.join(';'), why: text[0].toUpperCase() + text.slice(1) };
}

// ---------- alerts, the start check and the orchestrator's restart ----------
// Any change to the paired devices, their passkeys or the push devices: a note in every project's orchestrator
// thread and a push to every phone (sent before a removal, so the device leaving hears it too).
export function makeAlert({ hub, push, warn = s => console.warn(s) }) {
  return async ({ title, note }) => {
    for (const p of hub.projects.values()) hub.notice(p, 'orchestrator', note);
    const card = `devices:${Date.now().toString(36)}`;
    try { await push.send({ kind: 'security', title, body: 'Crux Hub', card, project: '', url: `/?card=${encodeURIComponent(card)}` }); }
    catch (e) { warn(`Push failed: ${e.message}`); }
  };
}

// The alert for a pairing (pairFinish's result). The title says how the device was paired, not just the name it
// chose for itself, since a name can be anything.
export function pairAlert(r) {
  const d = r.device;
  const how = r.via.startsWith('a code from ') ? `with a code from ${r.via.slice('a code from '.length)}` : 'with the code in the hub\'s window';
  return r.startOver
    ? { title: `Every device was unpaired, ${how}`, note: `Every paired device was unpaired (${r.removed.map(x => x.label).join(', ') || 'none'}) with the code from the hub's window, and ${d.label} (${d.rpId}) paired in their place. If this was not you, stop the hub and check who can reach this PC.` }
    : { title: `Device paired ${how}: ${d.label}`, note: `${d.label} (${d.rpId}) was paired with the hub, using ${r.via}. If this was not you, unpair it under Devices in the hub menu.` };
}

// At start: a project at Trusted with no raise the guard can check drops to Auto, with a note and a push.
export function dropUnbackedTrusted({ hub, guard, push, warn = s => console.warn(s) }) {
  const dropped = [];
  for (const p of hub.projects.values()) {
    const key = projectKey(p.dir);
    if (hub.permissionMode(p) !== 'trusted' || guard.raiseBacked(key)) continue;
    hub.setPermissionMode(p, 'auto', 'the hub at start');
    guard.clearRaise(key);
    hub.notice(p, 'orchestrator', `${p.name} was at Trusted with no raise from a paired device on record, so it starts at Auto. Since hub 0.16 a raise to Trusted needs Windows Hello or Face ID; raise it again from its settings card if you want it.`);
    const ev = p.log.ofType('project_settings').at(-1);
    push.send({ kind: 'level', title: `${p.name} dropped to Auto`, body: p.name, card: `level:${ev?.id || p.name}`, project: p.name, url: `/?project=${encodeURIComponent(p.name)}&card=${encodeURIComponent(`level:${ev?.id || p.name}`)}` })
      .catch(e => warn(`Push failed: ${e.message}`));
    dropped.push(p.name);
  }
  return dropped;
}

// restart_hub (orchestrator only): through the hub process itself, no HTTP. A note in the thread, a one-line push,
// then the same restart as the hub menu's. Not within a minute of the hub starting, and at most 3 in 15 minutes (the
// times travel to the restarted hub in CRUX_HUB_RESTARTS), so a confused loop stays slow and stops.
export const RESTARTS_MAX = 3, RESTARTS_WINDOW_MS = 15 * 60 * 1000;
export function makeRestartHub({ hub, push, restart, bootAt = Date.now(), now = () => Date.now(), minUpMs = 60 * 1000, delayMs = 1500, env = process.env, warn = s => console.warn(s) }) {
  let going = false;
  return async (project, agent, reason) => {
    reason = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (agent?.role !== 'orchestrator') return 'Only the orchestrator can restart the hub.';
    if (!reason) return 'Give a one-line reason (for example "merged #53"), then call restart_hub again.';
    if (going) return 'The hub is already restarting.';
    const up = now() - bootAt;
    if (up < minUpMs) return `The hub started ${Math.max(1, Math.round(up / 1000))} seconds ago. Wait a minute before restarting it again.`;
    const recent = String(env.CRUX_HUB_RESTARTS || '').split(',').map(Number).filter(t => Number.isFinite(t) && now() - t < RESTARTS_WINDOW_MS);
    if (recent.length >= RESTARTS_MAX) return `The hub was restarted ${recent.length} times in the last 15 minutes with restart_hub. Ask {{who}} to restart it from the hub menu if it is really needed.`;
    env.CRUX_HUB_RESTARTS = [...recent, now()].join(',');
    going = true;
    hub.notice(project, 'orchestrator', `${agent.name} restarted the hub: ${reason}`);
    try {
      await Promise.race([push.send({ kind: 'restart', title: 'The hub is restarting', body: `Asked by ${agent.name} in ${project.name}`, card: `notice:restart`, project: project.name, url: `/?project=${encodeURIComponent(project.name)}&card=notice:restart` }),
        new Promise(r => { const t = setTimeout(r, 3000); t.unref?.(); })]);
    } catch (e) { warn(`Push failed: ${e.message}`); }
    setTimeout(restart, delayMs);
    return 'Restarting now. Your turn stops here; you are asked to carry on once the new hub is up.';
  };
}
