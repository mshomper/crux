// Matt's trusted sites and approved packages (permission plan v3, section A10; decision 66 A).
//
// What the hub settles in code, with no model, from lists only Matt can change:
//   - Trusted sites: PAGES (WebFetch reads) and DOWNLOADS (curl / Invoke-WebRequest GET into a quarantine folder in
//     temp). Hosts that serve anyone's files (github.com, huggingface.co, ...) get pages only, unless pinned to an
//     owner/repo path Matt approved.
//   - Approved packages: exact name, the default registry, future versions, behind a 3-day release-age gate and a
//     major-version gate (both go to Matt), with install scripts off where the tool allows. npm, pip (only through the
//     project's .venv) and Hugging Face models (pinned revision, safetensors only).
//   - Builds that fetch only what is pinned: cargo build / fetch --locked and npm ci, when the lockfile, manifests and
//     registry config are unchanged from the merge-base with main.
//
// The one rule everywhere: anything that cannot be read or matched strictly is NOT allowed here. It stays exactly as
// permission-rules.mjs left it (a stop or a doubt). This module can only turn a stop or a doubt about a request it
// understands completely into an allow; it never turns anything into a harsher answer except the two gates, which
// send a listed package to Matt.
//
// Storage: hub settings (settings.json in the hub's data folder), never a repo file. Only Matt adds: the page's
// add action (server.mjs) is the single way in; no agent tool reaches it.
import { existsSync, lstatSync, realpathSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { projectKey } from './settings.mjs';

export const MIN_AGE_MS = 3 * 24 * 3600 * 1000;      // a release younger than this goes to Matt
export const LOOKUP_TTL_MS = 6 * 3600 * 1000;        // how long a registry answer is kept (npm and pinned pip: the release dates never change)
export const PIP_FRESH_MS = 2 * 60 * 1000;           // unpinned pip takes whatever is newest: its answer must be this fresh
export const QUARANTINE_DIR = 'crux-quarantine';     // under the temp folder
export const LISTS_VERSION = 1;

// ---------- the seed list (plan v3, A10: for Matt to review on the settings card) ----------
const S = (host, o = {}) => ({ host, subdomains: o.subdomains !== false, access: 'pages', pin: null, scope: 'all', by: 'seed', note: o.note || '' });
export const SEED_SITES = [
  // research and regulatory
  S('fda.gov'), S('nih.gov'), S('ncbi.nlm.nih.gov'), S('pubmed.ncbi.nlm.nih.gov'), S('onlinelibrary.wiley.com'), S('sciencedirect.com'),
  S('link.springer.com'), S('astm.org'), S('iso.org'),
  // coding
  S('docs.github.com'), S('developer.mozilla.org'), S('nodejs.org'), S('docs.python.org'), S('learn.microsoft.com'), S('docs.rs'),
  S('rust-lang.org'), S('tauri.app'), S('w3.org'), S('gpuweb.github.io', { subdomains: false }), S('threejs.org'),
  // pages only (they serve anyone's files)
  S('github.com', { subdomains: false }), S('raw.githubusercontent.com', { subdomains: false }), S('npmjs.com'), S('pypi.org'), S('crates.io'),
  S('stackoverflow.com'), S('huggingface.co')
];

// Hosts that serve anyone's files: pages only, unless an entry is pinned to an owner/repo path. A subdomain of one counts too.
export const OPEN_HOSTS = ['github.com', 'raw.githubusercontent.com', 'huggingface.co', 'pypi.org', 'npmjs.com', 'stackoverflow.com', 'crates.io',
  'gist.github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'sourceforge.net', 'githubusercontent.com', 'github.io', 'pythonhosted.org',
  'unpkg.com', 'jsdelivr.net', 'amazonaws.com', 'googleapis.com', 'blob.core.windows.net', 'cloudfront.net', 'dropbox.com', 'drive.google.com',
  'docs.google.com', 'onedrive.live.com', '1drv.ms', 'pastebin.com', 'discordapp.com', 'imgur.com', 'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev',
  'registry.npmjs.org', 'hf.co', 'zenodo.org', 'figshare.com'];
export const isOpenHost = h => OPEN_HOSTS.some(o => h === o || h.endsWith(`.${o}`));

// ---------- addresses ----------
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
export function validHost(h) {
  const s = String(h ?? '');
  return HOST_RE.test(s) && !s.split('.').some(l => l.startsWith('xn--'));
}
// A web address read the strict way: https only, a plain host name with a dot boundary, no user info, port, IP form or
// punycode, no redirect tricks in the path. A word that fails is not an address this module will match.
// -> { ok: true, host, path, query } or { ok: false, why }
export function parseHttpsUrl(raw) {
  const s = String(raw ?? '');
  const no = why => ({ ok: false, why });
  if (!s) return no('There is no address');
  if (s.length > 400) return no('The address is longer than 400 characters');
  if (/[^\x21-\x7e]/.test(s) || /[\\[\]{}]/.test(s)) return no('The address has spaces, backslashes, brackets, braces or characters that are not plain ASCII');
  if (/^http:\/\//i.test(s)) return no('Only https addresses count (this one is http)');
  const m = /^https:\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(s);
  if (!m) return no('Not a plain https address');
  const auth = m[1].toLowerCase();
  if (auth.includes('@')) return no('The address has user info in front of the host (name@host)');
  if (auth.includes(':') || auth.includes('[')) return no('The address names a port or an IP address');
  if (!HOST_RE.test(auth)) return no('The host is not a plain host name (an IP form, a trailing dot or odd characters)');
  if (auth.split('.').some(l => l.startsWith('xn--'))) return no('The host is written in punycode (xn--)');
  const path = m[2] || '/';
  if (/%(2e|2f|5c|00|25)/i.test(path)) return no('The path hides a dot, slash or backslash behind a % code');
  if (path.split('/').some(x => x === '..' || x === '.')) return no('The path goes through . or ..');
  let u;
  try { u = new URL(s); } catch { return no('The address does not parse'); }
  if (u.protocol !== 'https:' || u.hostname !== auth || u.port !== '' || u.username || u.password) return no('The address does not read the same way twice');
  return { ok: true, host: auth, path, query: m[3] || '' };
}

const hostMatches = (e, host) => host === e.host || (!!e.subdomains && host.endsWith(`.${e.host}`));
const underPin = (path, pin) => { const p = path.toLowerCase(), n = String(pin).toLowerCase(); return p === n || p.startsWith(`${n}/`); };
// The entry that lets this address be read (want 'pages') or downloaded (want 'downloads'), or null.
// entries: the list's sites; key: the project (a site narrowed to one project only counts there).
export function matchSite(sites, u, want, key) {
  const open = isOpenHost(u.host);
  for (const e of sites || []) {
    if (e.scope !== 'all' && e.scope !== key) continue;
    if (!hostMatches(e, u.host)) continue;
    if (want === 'downloads' && e.access !== 'downloads') continue;
    if (e.pin && !underPin(u.path, e.pin)) continue;
    if (want === 'downloads' && open && !e.pin) continue;   // a site that serves anyone's files: only a pinned path
    return e;
  }
  return null;
}
// A path to pin a download to, for the hosts that give out repos: /owner/repo.
export function pinFor(host, path) {
  if (!['github.com', 'raw.githubusercontent.com', 'huggingface.co'].includes(host)) return null;
  const m = /^\/([\w.-]+)\/([\w.-]+)(?:\/|$)/.exec(path);
  return m ? `/${m[1]}/${m[2]}`.toLowerCase() : null;
}

// ---------- versions and the registries ----------
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
export const majorOf = v => { const m = /^v?(\d+)/.exec(String(v ?? '')); return m ? Number(m[1]) : null; };
const isPre = (eco, v) => eco === 'npm' ? /-/.test(v) : /(?:^|[.\d])(a|b|c|rc|dev|alpha|beta|pre|preview)\d*(?:\.|$)/i.test(v) && !/post/i.test(v);
const sv = v => { const m = SEMVER.exec(v); return m && { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null }; };
const cmpSv = (a, b) => { for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return a.n[i] - b.n[i]; return 0; };

// npm: '' | latest | X.Y.Z | ^X[.Y[.Z]] | ~X[.Y[.Z]]  (the forms npm install writes); pip: '' | ==X.Y.Z (any release spelling).
export const NPM_SPEC = /^(?:latest|[~^]?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)$/;
// before: npm install --before=DATE (ms): only releases published by then can be picked, as npm itself does; the
// dist-tag `latest` wins when it is allowed and satisfies the spec (npm's own rule), else the highest release that does.
export function resolveVersion(eco, spec, info, before = null) {
  const ok = v => !before || (info.versions[v]?.at != null && info.versions[v].at <= before);
  const known = Object.keys(info.versions || {}).filter(ok);
  const latest = info.latest && ok(info.latest) ? info.latest : null;
  if (eco === 'pip' || eco === 'pypi') {
    if (!spec) return info.latest ? { version: info.latest } : { why: 'the registry names no latest release' };
    const m = /^==\s*([\w.!+-]+)$/.exec(spec);
    return m && info.versions[m[1]] ? { version: m[1] } : { why: `the registry has no release ${spec}` };
  }
  const highest = pred => { let best = null; for (const v of known) { const p = sv(v); if (!p || p.pre || !pred(p)) continue; if (!best || cmpSv(p, best.p) > 0) best = { v, p }; } return best; };
  if (!spec || spec === 'latest') {
    if (latest) return { version: latest };
    const h = before ? highest(() => true) : null;
    return h ? { version: h.v } : { why: before ? 'the registry has no release from before that date' : 'the registry names no latest release' };
  }
  const op = /^[~^]/.test(spec) ? spec[0] : '';
  const body = op ? spec.slice(1) : spec;
  const parts = body.split('-')[0].split('.').map(Number);
  if (!op && SEMVER.test(body)) return info.versions[body] && ok(body) ? { version: body } : { why: `the registry has no release ${body}${before ? ' from before that date' : ''}` };
  if (!op && parts.length === 3) return { why: `cannot resolve ${spec}` };
  const [a, b = null, c = null] = parts;
  const lo = [a, b ?? 0, c ?? 0];
  let hi;
  if (!op) hi = b == null ? [a + 1, 0, 0] : [a, b + 1, 0];           // 1 means 1.x.x, 1.2 means 1.2.x
  else if (op === '~') hi = b == null ? [a + 1, 0, 0] : [a, b + 1, 0];
  else hi = a > 0 || b == null ? [a + 1, 0, 0] : (b > 0 || c == null ? [0, b + 1, 0] : [0, 0, c + 1]);   // caret
  if (op === '^' && a === 0 && b == null) hi = [1, 0, 0];
  const inRange = p => cmpSv(p, { n: lo }) >= 0 && cmpSv(p, { n: hi }) < 0;
  const lp = latest && sv(latest);
  if (lp && !lp.pre && inRange(lp)) return { version: latest };   // npm takes the latest tag when it satisfies the range
  const best = highest(inRange);
  return best ? { version: best.v } : { why: `no release matches ${spec}${before ? ' from before that date' : ''}` };
}
// A change that may break things: a new major, or (for 0.x) a new minor. base: { major, minor } of what the project has.
export function isJump(version, base) {
  const m = /^v?(\d+)\.?(\d*)/.exec(String(version ?? ''));
  if (!m || !base || base.major == null) return true;
  const major = Number(m[1]), minor = m[2] === '' ? 0 : Number(m[2]);
  if (major !== base.major) return major > base.major;
  if (major === 0) return base.minor == null ? true : minor > base.minor;
  return false;
}

// What a registry says, reduced to { latest, versions: { v: { at: ms, yanked } } }; null when it is not that shape.
export function parseRegistry(eco, doc) {
  try {
    if (eco === 'npm') {
      const latest = doc?.['dist-tags']?.latest;
      const versions = {};
      for (const v of Object.keys(doc.versions || {})) {
        const at = Date.parse(doc.time?.[v]);
        versions[v] = { at: Number.isFinite(at) ? at : null, yanked: !!doc.versions[v]?.deprecated && /yank|withdrawn|security/i.test(String(doc.versions[v].deprecated)) };
      }
      return latest && Object.keys(versions).length ? { latest, versions } : null;
    }
    if (eco === 'pip') {
      const latest = doc?.info?.version;
      const versions = {};
      for (const [v, files] of Object.entries(doc.releases || {})) {
        if (!Array.isArray(files) || !files.length) continue;
        const times = files.map(f => Date.parse(f.upload_time_iso_8601 || f.upload_time)).filter(Number.isFinite);
        versions[v] = { at: times.length ? Math.max(...times) : null, yanked: files.every(f => f.yanked) };   // the newest file of the release counts
      }
      return latest && versions[latest] ? { latest, versions } : null;
    }
  } catch { }
  return null;
}
export function registryUrl(eco, name) {
  if (eco === 'npm') return `https://registry.npmjs.org/${name.startsWith('@') ? name.replace('/', '%2f') : name}`;
  if (eco === 'pip') return `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
  return null;
}
// The registry, asked asynchronously (the hub is never blocked): classification reads the remembered answer, and a miss
// starts a fetch for the next ask (PermissionLists.lookup). A failed lookup is null (it goes to Matt).
export async function registryLookup(eco, name) {
  const url = registryUrl(eco, name);
  if (!url) return null;
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'crux-hub-permission-lists' }, signal: AbortSignal.timeout(7000) });
    return r.ok ? parseRegistry(eco, await r.json()) : null;
  } catch { return null; }
}

// ---------- package names ----------
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PIP_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const HF_NAME = /^[\w.-]+\/[\w.-]+$/;
export const ECOSYSTEMS = { npm: 'npm', pip: 'pip', huggingface: 'Hugging Face' };
export const pipName = n => String(n).toLowerCase().replace(/[-_.]+/g, '-');
export function validPackage(eco, name) {
  const n = String(name ?? '');
  if (n.length > 214) return false;
  return eco === 'npm' ? NPM_NAME.test(n) : eco === 'pip' ? PIP_NAME.test(n) : eco === 'huggingface' ? HF_NAME.test(n) : false;
}
const sameName = (eco, a, b) => eco === 'pip' ? pipName(a) === pipName(b) : eco === 'huggingface' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;
const findPackage = (list, eco, name, key) => (list || []).find(e => e.eco === eco && (e.scope === 'all' || e.scope === key) && sameName(eco, e.name, name));

// ---------- the lists (hub settings) ----------
const newId = p => `${p}${randomBytes(4).toString('hex')}`;
export class ListsError extends Error { }

export class PermissionLists {
  // settings: the hub's HubSettings (lists live in its settings.json). fetcher: async (eco, name) -> registry info or null.
  constructor({ settings, fetcher = registryLookup, now = () => Date.now(), home = homedir() } = {}) {
    this.settings = settings;
    this.fetcher = fetcher;
    this.now = now;
    this.home = home;
    this.cache = new Map();
    this.inflight = new Map();
    if (!this.data) this.save({ v: LISTS_VERSION, seeded: new Date().toISOString(), sites: SEED_SITES.map(s => ({ id: newId('s'), ...s, at: new Date().toISOString() })), packages: [] });
  }
  get data() { const l = this.settings?.lists; return l && Array.isArray(l.sites) && Array.isArray(l.packages) ? l : null; }
  save(l) { this.settings.setLists(l); }

  // The registry answer, from memory only (classification never waits for the network). Older than maxAgeMs, or never
  // asked: null, and a fetch starts so the next ask has it. Matt's own add pre-fills it (prime).
  lookup = (eco, name, maxAgeMs = LOOKUP_TTL_MS) => {
    const hit = this.cache.get(`${eco}:${name}`);
    if (hit && this.now() - hit.t <= maxAgeMs) return hit.v;
    this.prime(eco, name).catch(() => { });
    return null;
  };
  // Ask the registry now (once at a time) and remember the answer. Resolves to it, or null when the registry failed.
  prime(eco, name) {
    const k = `${eco}:${name}`;
    if (this.inflight.has(k)) return this.inflight.get(k);
    const p = Promise.resolve().then(() => this.fetcher(eco, name)).catch(() => null).then(v => { if (v) this.cache.set(k, { t: this.now(), v }); else this.cache.delete(k); return v || null; }).finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  // The snapshot classify() reads for one project.
  forProject(dir) {
    const key = projectKey(dir), d = this.data || { sites: [], packages: [] };
    return { key, sites: d.sites.filter(e => e.scope === 'all' || e.scope === key), packages: d.packages.filter(e => e.scope === 'all' || e.scope === key),
      lookup: this.lookup, now: this.now, home: this.home };
  }

  // Everything, for the settings card. names: project key -> project name.
  view(names = {}) {
    const d = this.data || { sites: [], packages: [] };
    const scopeName = s => s === 'all' ? 'Every project' : (names[s] || s);
    const out = e => ({ ...e, scopeName: scopeName(e.scope) });
    return { minAgeDays: MIN_AGE_MS / 86400000, sites: d.sites.map(e => ({ ...out(e), open: isOpenHost(e.host) })), packages: d.packages.map(out), ecosystems: ECOSYSTEMS };
  }

  addSite({ host, access = 'pages', pin = null, scope = 'all', subdomains, by = 'you' } = {}) {
    const h = String(host ?? '').trim().toLowerCase();
    if (!validHost(h)) throw new ListsError('Type just the site\'s name, like fda.gov: no https://, port, path or odd characters.');
    if (!['pages', 'downloads'].includes(access)) throw new ListsError('Pages or downloads.');
    let p = null;
    if (pin != null && String(pin).trim() !== '') {
      p = String(pin).trim().toLowerCase().replace(/\/+$/, '');
      if (!/^(\/[\w.~-]+){1,6}$/.test(p) || p.split('/').some(x => x === '.' || x === '..')) throw new ListsError('A pinned path looks like /owner/repo.');
    }
    const open = isOpenHost(h);
    if (access === 'downloads' && open && !p) throw new ListsError(`${h} serves anyone's files: pin downloads to one path, like /owner/repo.`);
    const sub = p ? false : subdomains === false ? false : !open;
    const sc = this.scopeOf(scope);
    const d = this.data;
    const same = d.sites.find(e => e.host === h && (e.pin || null) === p && e.scope === sc);
    if (same) {
      // "Always allow downloads" on a site already listed for pages upgrades it (Matt's confirm is the add's step-up).
      if (same.access === 'pages' && access === 'downloads') return this.setAccess(same.id, 'downloads');
      throw new ListsError(`${h}${p || ''} is already on the list.`);
    }
    const e = { id: newId('s'), host: h, subdomains: sub, access, pin: p, scope: sc, by: String(by).slice(0, 80), at: new Date(this.now()).toISOString() };
    this.save({ ...d, sites: [...d.sites, e] });
    return e;
  }
  // baseMajor / baseMinor: the version Matt saw when approving (the baseline for a fresh project). revision: a Hugging
  // Face model is approved at one pinned revision (a full 40-character commit); another revision comes to Matt.
  addPackage({ eco, name, scope = 'all', baseMajor = null, baseMinor = null, revision = null, by = 'you' } = {}) {
    if (!ECOSYSTEMS[eco]) throw new ListsError('npm, pip or Hugging Face.');
    const n = eco === 'pip' ? pipName(String(name ?? '').trim()) : String(name ?? '').trim();
    if (!validPackage(eco, n)) throw new ListsError(eco === 'huggingface' ? 'A Hugging Face model looks like organisation/name.' : 'That is not a plain package name (no versions, paths, addresses or spaces).');
    const rev = eco === 'huggingface' ? String(revision ?? '').trim().toLowerCase() : null;
    if (eco === 'huggingface' && !/^[0-9a-f]{40}$/.test(rev)) throw new ListsError('A model is approved at one revision: give the full 40-character commit.');
    const sc = this.scopeOf(scope), d = this.data;
    if (d.packages.some(e => e.eco === eco && sameName(eco, e.name, n) && e.scope === sc)) throw new ListsError(`${n} is already on the list.`);
    const e = { id: newId('p'), eco, name: n, baseMajor: Number.isInteger(baseMajor) ? baseMajor : null, baseMinor: Number.isInteger(baseMinor) ? baseMinor : null, ...(rev ? { revision: rev } : {}), scope: sc, by: String(by).slice(0, 80), at: new Date(this.now()).toISOString() };
    this.save({ ...d, packages: [...d.packages, e] });
    return e;
  }
  // Pages to downloads (or back) is its own explicit choice. A site that serves anyone's files needs its pinned path first.
  setAccess(id, access) {
    const d = this.data, e = d.sites.find(x => x.id === id);
    if (!e) throw new ListsError('That site is not on the list any more.');
    if (!['pages', 'downloads'].includes(access)) throw new ListsError('Pages or downloads.');
    if (access === 'downloads' && isOpenHost(e.host) && !e.pin) throw new ListsError(`${e.host} serves anyone's files: remove it and add it again pinned to a path like /owner/repo.`);
    if (e.access === access) return e;
    const next = { ...e, access };
    this.save({ ...d, sites: d.sites.map(x => x.id === id ? next : x) });
    return next;
  }
  remove(id) {
    const d = this.data, s = d.sites.find(x => x.id === id), p = d.packages.find(x => x.id === id);
    if (!s && !p) return null;
    this.save({ ...d, sites: d.sites.filter(x => x.id !== id), packages: d.packages.filter(x => x.id !== id) });
    return s ? { kind: 'site', ...s } : { kind: 'package', ...p };
  }
  scopeOf(scope) { return !scope || scope === 'all' ? 'all' : String(scope); }
}

// ---------- reading a command, strictly ----------
// One simple command only. Nothing is guessed: any shell syntax that could change what runs (a second command, a
// pipe, a redirect, a variable, a substitution, a glob, a backtick, a comment, an escape) makes it unreadable, and the
// request stays where permission-rules.mjs put it. -> array of words, or null.
const TEMP_VAR = /^\$env:(?:temp|tmp)(?![\w])/i;
export function readWords(cmd, ps) {
  let s = String(cmd ?? '').trim();
  if (ps && /^&\s+\S/.test(s)) s = s.slice(1).trim();   // PowerShell's call operator in front of a quoted program path
  if (!s || s.length > 1500 || /[\r\n\0\u2028\u2029]/.test(s)) return null;
  const words = [];
  let cur = null, i = 0;
  const add = ch => { cur = (cur ?? '') + ch; };
  const stop = () => { if (cur !== null) { words.push(cur); cur = null; } };
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t') { stop(); i++; continue; }
    if (ch === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0 || (ps && s[j + 1] === "'")) return null;   // unclosed, or PowerShell's '' escape
      const inner = s.slice(i + 1, j);
      if (ps && /[\u2018\u2019]/.test(inner)) return null;
      cur ??= '';
      cur += inner; i = j + 1; continue;
    }
    if (ch === '"') {
      let j = i + 1, inner = '';
      for (; j < s.length && s[j] !== '"'; j++) {
        const c = s[j];
        if (c === '`') return null;
        if (!ps && c === '\\' && /[$`"\\]/.test(s[j + 1] || '')) return null;
        if (c === '$') { if (!(ps && TEMP_VAR.test(s.slice(j)) && inner === '')) return null; }
        if (ps && /[\u201c\u201d]/.test(c)) return null;
        inner += c;
      }
      if (j >= s.length) return null;
      if (ps && s[j + 1] === '"') return null;
      cur ??= '';
      cur += inner; i = j + 1; continue;
    }
    if (/[;|&<>`(){}[\]*?!#~]/.test(ch) && !(ch === '~' && cur !== null) && !(ch === '#' && cur !== null)) return null;
    if (ch === '\\' && !ps) return null;
    if (ch === ',' && ps) return null;
    if (ch === '@' && cur === null) return null;
    if (ch === '$') { if (!(ps && cur === null && TEMP_VAR.test(s.slice(i)))) return null; }
    if (/[\u2018\u2019\u201c\u201d]/.test(ch)) return null;
    add(ch); i++;
  }
  stop();
  return words.length && words.length <= 40 ? words : null;
}

// ---------- the quarantine folder ----------
const slash = p => String(p).replace(/\\/g, '/');
const low = p => slash(p).toLowerCase();
const realOrNull = p => { try { return realpathSync.native(p); } catch { return null; } };
// A word as an absolute path: Git Bash's /tmp and /c/..., $env:TEMP in PowerShell, a drive path. Anything relative,
// odd or going up is null.
export function absolutePath(word, tmp) {
  let s = String(word);
  if (/\$env:/i.test(s)) { if (!TEMP_VAR.test(s)) return null; s = s.replace(TEMP_VAR, tmp); }
  s = slash(s);
  let m;
  if (/^\/tmp(\/|$)/.test(s)) s = slash(join(tmp, s.slice(5)));
  else if ((m = /^\/([a-z])\/(.*)$/i.exec(s))) s = `${m[1].toUpperCase()}:/${m[2]}`;
  if (!/^[a-z]:\//i.test(s) && !(process.platform !== 'win32' && s.startsWith('/'))) return null;
  const parts = s.split('/');
  if (parts.some((x, i) => (x === '..' || x === '.') || (i > 0 && x === '') || /~\d/.test(x) || (i > 0 && /[. ]$/.test(x)) || (i > 0 && /[:<>"|?*]/.test(x)))) return null;
  return s.replace(/\/+$/, '');
}
// One quarantine folder per project: <temp>/crux-quarantine-<project folder name>.
export const quarantineName = projectDir => `${QUARANTINE_DIR}-${basename(resolve(String(projectDir))).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'project'}`;
function quarantineRoots(tmp, name) {
  const roots = new Set([slash(join(tmp, name))]);
  const real = realOrNull(tmp);
  if (real) roots.add(slash(join(real, name)));
  return [...roots];
}
// Every quarantine folder in temp, whichever project made it (crux-quarantine*): anything inside counts as downloaded,
// so running it, or a copy of it, stays a stop. Lower-case, forward slashes, in both spellings of the temp folder.
export function quarantineMarks(tmp) {
  const out = new Set();
  const real = realOrNull(tmp);
  for (const base of new Set([tmp, real].filter(Boolean))) {
    let names = [];
    try { names = readdirSync(base); } catch { continue; }
    for (const n of names) if (/^crux-quarantine/i.test(n)) out.add(low(join(base, n)));
  }
  return [...out];
}
// A place to save into: inside this project's quarantine folder (a real folder, not a link, and really inside temp),
// its parent a real folder inside it, and nothing there yet. -> { path } or { why }.
export function quarantineTarget(word, tmp, { dir = false, name = QUARANTINE_DIR } = {}) {
  const abs = absolutePath(word, tmp);
  if (!abs) return { why: 'The place to save it is not a plain full path' };
  const roots = quarantineRoots(tmp, name);
  const root = roots.find(r => low(abs).startsWith(`${r.toLowerCase()}/`));
  if (!root) return { why: `Downloads may only be saved inside this project's quarantine folder (${slash(join(tmp, name))})` };
  // The folder itself must be a plain folder directly in temp: a junction or link there would lead anywhere.
  let rootSt;
  try { rootSt = lstatSync(root); } catch { return { why: `The quarantine folder does not exist yet: make ${slash(join(tmp, name))} first` }; }
  const realTmp = realOrNull(tmp), realRootDir = realOrNull(root);
  if (!rootSt.isDirectory() || rootSt.isSymbolicLink() || !realTmp || !realRootDir || low(realRootDir) !== low(join(realTmp, name))) return { why: 'The quarantine folder is a link, or does not sit directly in the temp folder' };
  const file = basename(abs);
  if (!/^[A-Za-z0-9][\w.@+-]{0,100}$/.test(file) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(file)) return { why: 'The file name is not a plain name' };
  const parent = dirname(abs);
  let st;
  try { st = lstatSync(parent); } catch { return { why: 'The folder to save into does not exist yet: make it inside the quarantine folder first' }; }
  const realParent = realOrNull(parent), realRoot = realRootDir;
  if (!st.isDirectory() || st.isSymbolicLink() || !realParent || !(low(realParent) === low(realRoot) || low(realParent).startsWith(`${low(realRoot)}/`))) return { why: 'The folder to save into is a link or sits outside the quarantine folder' };
  let there = null;
  try { there = lstatSync(abs); } catch (e) { if (e?.code !== 'ENOENT') return { why: 'Cannot tell what is already there' }; }
  if (there) {
    if (!dir) return { why: 'A file is already there: downloads never go over an existing file' };
    if (!there.isDirectory() || there.isSymbolicLink()) return { why: 'Something that is not a plain folder is already there' };
    let names;
    try { names = readdirSync(abs); } catch { return { why: 'Cannot tell what is already there' }; }
    if (names.length) return { why: 'That folder already has files in it' };
  }
  return { path: abs };
}
// Any mention of a quarantine folder by name, in any spelling (/tmp/..., $env:TEMP\..., a full path).
export const inQuarantine = text => /crux-quarantine/i.test(String(text));
// The longest part of a path that exists, replaced by its real long name (links followed, 8.3 names opened), plus the
// rest as written: where the path really leads. Lower-case, forward slashes.
function realish(p) {
  let d = resolve(String(p)), rest = [];
  for (let i = 0; i < 60; i++) {
    const r = realOrNull(d);
    if (r) return low(join(r, ...rest.reverse()));
    const up = dirname(d);
    if (up === d) break;
    rest.push(basename(d)); d = up;
  }
  return low(resolve(String(p)));
}
// A word as a path with no checks (it may hold glob characters): /tmp, /c/..., $env:TEMP, a drive path, else from cwd.
function looseAbs(tok, cwd, tmp) {
  let s = slash(String(tok).replace(TEMP_VAR, tmp)), m;
  if (/^\/tmp(\/|$)/.test(s)) s = slash(join(tmp, s.slice(5)));
  else if ((m = /^\/([a-z])\/(.*)$/i.exec(s))) s = `${m[1].toUpperCase()}:/${m[2]}`;
  else if (!/^[a-z]:\//i.test(s) && !s.startsWith('/')) s = slash(join(cwd, s));
  return s;
}
const HARMLESS = new Set(['ls', 'dir', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'pwd', 'echo', 'printf', 'cd', 'pushd', 'popd', 'sha256sum', 'md5sum', 'get-childitem', 'gci',
  'get-item', 'gi', 'get-content', 'gc', 'get-filehash', 'test-path', 'set-location', 'sl', 'push-location', 'pop-location', 'mkdir', 'md', 'write-output', 'write-host', 'select-object',
  'sort-object', 'measure-object', 'where-object', 'format-table', 'ft', 'select-string', 'sls', 'grep', 'rg', 'new-item', 'ni']);
const JUNCTIONISH = /\b(junction|symboliclink|hardlink|mklink)\b|\bln\s+-\w*s|new-item[^;&|\n]*-itemtype\s+(?!directory)/i;
// Does a command touch a quarantine folder, however it spells the path (a relative path from inside it, .., a glob, an
// 8.3 name, a link) or run from inside one? And does it do more than look? -> true when it does both: that is a copy,
// a move or a run of something downloaded, never an allow by itself.
export function leavesQuarantine(text, cwd, tmp) {
  const t = String(text);
  const marks = quarantineMarks(tmp);
  let touched = inQuarantine(t) || (marks.length > 0 && marks.some(m => under(realish(cwd), m)));
  if (!touched && marks.length) {
    for (const raw of t.split(/[\s;&|()<>]+/)) {
      let tok = raw.replace(/^['"]+|['"]+$/g, '');
      if (!tok) continue;
      if (/^-+[\w-]*=/.test(tok)) tok = tok.slice(tok.indexOf('=') + 1);
      else if (tok.startsWith('-')) continue;
      if (/[$%]/.test(tok)) { touched = true; break; }   // a variable: where it leads is not known
      const g = tok.search(/[*?[]/);
      if (g >= 0) {
        // A glob may stand for the quarantine folder itself (/tmp/crux-q*/...) or for a folder on the way to it: match the
        // path up to the glob's own folder name against the folders, cut to the same depth. A glob inside a folder is
        // judged by the folder before it, like any path.
        const segEnd = tok.slice(g).search(/[\\/]/), pre = segEnd < 0 ? tok : tok.slice(0, g + segEnd);
        const re = new RegExp(`^${low(looseAbs(pre, cwd, tmp)).replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\[!/g, '[^')}$`);
        const depth = low(looseAbs(pre, cwd, tmp)).split('/').length;
        try { if (marks.some(m => re.test(m.split('/').slice(0, depth).join('/')))) { touched = true; break; } } catch { touched = true; break; }
        const h = tok.slice(0, g), cut = Math.max(h.lastIndexOf('/'), h.lastIndexOf('\\'));
        tok = cut > 0 ? h.slice(0, cut) : cut === 0 ? h.slice(0, 1) : '.';
      }
      const abs = absolutePath(tok, tmp) || resolve(cwd, tok);
      if (marks.some(m => under(realish(abs), m))) { touched = true; break; }
    }
  }
  if (!touched) return false;
  if (JUNCTIONISH.test(t) || />/.test(t)) return true;
  return t.split(/;|&&|\|\||\||&|\r?\n/).some(s => {
    const w = s.trim().replace(/^&\s*/, '').split(/\s+/)[0] || '';
    return w && !HARMLESS.has(w.toLowerCase().replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/, ''));
  });
}

// ---------- the shapes ----------
// Each parser returns { ok: false } (not this shape at all), or { ok: true, ... } plus problems: [text] that stop it
// from being allowed here. Only the shapes below are ever matched.
const num = v => /^\d{1,4}$/.test(String(v ?? ''));

// curl [-sSf] [--max-time N] -o FILE URL   (never -L, -O, data, headers, proxies, config or credentials)
function parseCurl(a) {
  const r = { ok: true, problems: [], url: null, out: null, hard: false, noRc: false };
  const bad = t => { r.hard = true; r.problems.push(`curl option ${t} is not one the hub reads (no redirects, sends, headers, credentials, proxies or config files)`); };
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t === '-q' || t === '--disable') { if (i === 0) r.noRc = true; else bad(t); continue; }   // first: curl reads no .curlrc
    if (/^--(silent|show-error|fail|fail-with-body|tlsv1\.2)$/.test(t)) continue;
    if (/^--(max-time|connect-timeout|retry)$/.test(t)) { if (!num(a[++i])) bad(t); continue; }
    if (t === '--proto') { if (a[++i] !== '=https') bad(t); continue; }
    if (t === '--output') { if (r.out !== null || a[i + 1] == null) bad(t); else r.out = a[++i]; continue; }
    if (/^-[sSf]*o?$/.test(t) && t.length > 1) { if (t.endsWith('o')) { if (r.out !== null || a[i + 1] == null) bad(t); else r.out = a[++i]; } continue; }
    if (t.startsWith('-')) { bad(t); continue; }
    if (r.url !== null) { r.problems.push('curl names more than one address'); continue; }
    r.url = t;
  }
  if (r.url === null) r.problems.push('curl names no address');
  if (r.out === null) r.problems.push('curl does not save to a file (-o FILE)');
  return r;
}
// Invoke-WebRequest -Uri URL -OutFile FILE -MaximumRedirection 0 [-UseBasicParsing] [-TimeoutSec N] [-Method Get]
function parseIwr(a) {
  const r = { ok: true, problems: [], url: null, out: null, hard: false };
  let redirects = null, basic = false;
  const bad = t => { r.hard = true; r.problems.push(`Invoke-WebRequest parameter ${t} is not one the hub reads (no sends, headers, credentials, proxies or splatting)`); };
  for (let i = 0; i < a.length; i++) {
    const t = a[i], k = t.toLowerCase();
    if (k === '-usebasicparsing') { basic = true; continue; }
    if (k === '-timeoutsec') { if (!num(a[++i])) bad(t); continue; }
    if (k === '-maximumredirection') { redirects = a[++i]; continue; }
    if (k === '-method') { if (!/^get$/i.test(a[++i] || '')) bad(t); continue; }
    if (k === '-erroraction') { if (!/^(stop|silentlycontinue)$/i.test(a[++i] || '')) bad(t); continue; }
    if (k === '-uri') { if (r.url !== null || a[i + 1] == null) bad(t); else r.url = a[++i]; continue; }
    if (k === '-outfile') { if (r.out !== null || a[i + 1] == null) bad(t); else r.out = a[++i]; continue; }
    if (t.startsWith('-')) { bad(t); continue; }
    if (r.url !== null) { r.problems.push('Invoke-WebRequest names more than one address'); continue; }
    r.url = t;
  }
  if (redirects !== '0') r.problems.push('Invoke-WebRequest follows redirects unless -MaximumRedirection 0 is given');
  if (!basic) r.problems.push('Invoke-WebRequest without -UseBasicParsing runs the page through the browser engine');
  if (r.url === null) r.problems.push('Invoke-WebRequest names no address');
  if (r.out === null) r.problems.push('Invoke-WebRequest does not save to a file (-OutFile)');
  return r;
}

// npm install [--save-dev] --ignore-scripts name[@spec]...   (npm ci is a lockfile build, below)
const NPM_FLAGS = /^(--ignore-scripts|--save-dev|-D|--save|-S|--save-exact|-E|--no-audit|--no-fund|--silent|--no-progress)$/;
// --before=YYYY-MM-DD, at least 3 days ago: npm then picks only releases published by that day, for the package and for
// everything it pulls in, so no young release gets in whatever the registry says.
function parseNpmInstall(a, problems, now = Date.now()) {
  const specs = [];
  let scripts = false, hard = false, before = null;
  for (const t of a) {
    const bm = /^--before=(\d{4}-\d{2}-\d{2})$/.exec(t);
    if (bm) {
      const ms = Date.parse(`${bm[1]}T00:00:00Z`);
      if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== bm[1]) problems.push(`--before ${bm[1]} is not a date`);
      else if (now - ms < MIN_AGE_MS) problems.push(`--before=${bm[1]} is less than 3 days ago: npm would take releases younger than the 3-day wait`);
      else before = ms;
      continue;
    }
    if (NPM_FLAGS.test(t)) { if (t === '--ignore-scripts') scripts = true; continue; }
    if (t.startsWith('-')) { problems.push(`npm option ${t} is not one the hub reads`); if (/^--?(g|global|registry|prefix|userconfig|globalconfig|location|workspace|w|workspaces|cache|proxy|https-proxy|ca|cafile|script-shell|install-links|C)/.test(t)) hard = true; continue; }
    const m = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@(.+))?$/.exec(t);
    if (!m || (m[2] !== undefined && !NPM_SPEC.test(m[2]))) { problems.push(`${t} is not a plain package name with an optional plain version (aliases, git or file sources and ranges beyond ^ and ~ are not read)`); hard = true; continue; }
    specs.push({ name: m[1], spec: m[2] || '' });
  }
  if (!specs.length) problems.push('npm install names no package');
  if (!scripts) problems.push('npm install without --ignore-scripts would run the packages\' own install scripts');
  if (!before && !problems.some(p => /--before/.test(p))) problems.push('npm install without --before=<a date at least 3 days ago> could take a release younger than 3 days, or one pulled in by a dependency');
  return { specs, hard, before };
}
// <project>\.venv\Scripts\python -m pip install --only-binary=:all: name[==X.Y.Z]...
const PIP_FLAGS = /^(-q|--quiet|--disable-pip-version-check|--no-input|--upgrade|-U)$/;
// --isolated: pip reads no environment settings and no user config (an index or proxy set there would reroute it).
function parsePipInstall(a, problems) {
  const specs = [];
  let binary = false, hard = false, isolated = false;
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t === '--isolated') { isolated = true; continue; }
    if (t === '--only-binary=:all:' || (t === '--only-binary' && a[i + 1] === ':all:')) { binary = true; if (t === '--only-binary') i++; continue; }
    if (PIP_FLAGS.test(t)) continue;
    if (t.startsWith('-')) { problems.push(`pip option ${t} is not one the hub reads`); if (/^(-i|--index-url|--extra-index-url|-r|--requirement|-e|--editable|--target|-t|--user|--prefix|--root|--find-links|-f|--proxy|--trusted-host|--cert|--no-index)/.test(t)) hard = true; continue; }
    const m = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:(==[\w.!+-]+))?$/.exec(t);
    if (!m) { problems.push(`${t} is not a plain package name with an optional ==version (extras, URLs, paths, files and other version forms are not read)`); hard = true; continue; }
    specs.push({ name: m[1], spec: m[2] || '' });
  }
  if (!specs.length) problems.push('pip install names no package');
  if (!binary) problems.push('pip install without --only-binary=:all: could run a package\'s build scripts');
  if (!isolated) problems.push('pip install without --isolated would read index and proxy settings from the environment and config files');
  return { specs, hard };
}
// hf download org/name --revision <40 hex> --include '*.safetensors' --local-dir <quarantine>/dir
// Weights and plain text only: a .json (config.json can name code to load, "auto_map") cannot be checked before it is
// downloaded, so a command that asks for one goes to Matt.
const SAFE_FILE = /^[\w.*-]+(?:\/[\w.*-]+)*\.(?:safetensors|txt)$/i;
function parseHf(a, problems) {
  const r = { repo: null, revision: null, includes: [], localDir: null, files: [] };
  let hard = false;
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t === '--revision') { r.revision = a[++i]; continue; }
    if (t === '--include') { if (a[i + 1] == null) problems.push('--include has nothing after it'); else r.includes.push(a[++i]); continue; }
    if (t === '--local-dir') { r.localDir = a[++i]; continue; }
    if (t === '--repo-type') { if (a[++i] !== 'model') { problems.push('Only models are read (--repo-type model)'); hard = true; } continue; }
    if (t === '--quiet' || t === '-q') continue;
    if (t.startsWith('-')) { problems.push(`Hugging Face option ${t} is not one the hub reads (no tokens, caches or other routes)`); hard = true; continue; }
    if (r.repo === null) r.repo = t; else r.files.push(t);
  }
  if (!r.repo || !HF_NAME.test(r.repo)) { problems.push('The model is not written as organisation/name'); hard = true; }
  if (!r.revision || !/^[0-9a-f]{40}$/.test(r.revision)) problems.push('The revision is not pinned to a full 40-character commit');
  if (!r.localDir) problems.push('Models are saved into the quarantine folder with --local-dir');
  if (!r.includes.length && !r.files.length) problems.push('Name the files (--include) so only safetensors and plain text files are fetched');
  for (const f of [...r.includes, ...r.files]) if (!SAFE_FILE.test(f)) problems.push(`${f} is not a .safetensors or .txt file (pickle formats and config files can make a loader run code)`);
  return { r, hard };
}
// cargo build|fetch --locked ...   and   npm ci [--ignore-scripts ...]
const CARGO_FLAGS = /^(--locked|--release|-r|--workspace|--all-targets|--lib|--bins|--quiet|-q|--all-features)$/;
function parseCargo(a, problems) {
  const sub = a[0];
  if (!['build', 'fetch'].includes(sub)) return null;
  let locked = false;
  for (let i = 1; i < a.length; i++) {
    const t = a[i];
    if (t === '--locked') { locked = true; continue; }
    if (CARGO_FLAGS.test(t)) continue;
    if ((t === '-p' || t === '--package') && /^[\w-]+$/.test(a[i + 1] || '')) { i++; continue; }
    problems.push(`cargo option ${t} is not one the hub reads (no --config, --manifest-path, registries or targets)`);
  }
  if (!locked) problems.push(`cargo ${sub} without --locked could fetch newer versions than the lockfile`);
  return { sub };
}
const NPM_CI_FLAGS = /^(--ignore-scripts|--no-audit|--no-fund|--silent|--no-progress)$/;

// ---------- builds that fetch only what is pinned ----------
const gitOut = (cwd, args) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], { cwd, encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'ignore'] });
const gitOk = (cwd, args) => { try { execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, timeout: 15000, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: 'ignore' }); return true; } catch { return false; } };
const WATCHED = /(^|\/)(cargo\.toml|cargo\.lock|package\.json|package-lock\.json|npm-shrinkwrap\.json|\.npmrc|\.yarnrc(\.yml)?|rust-toolchain(\.toml)?|pnpm-workspace\.yaml|\.pnpmfile\.cjs)$|(^|\/)\.cargo\/config(\.toml)?$/i;
// An .npmrc that reroutes npm: a registry (also per scope, also with the key in quotes), a proxy, a CA, a shell or node
// option, another config file, switched-off TLS checks or switched-on install scripts.
const NPMRC_KEYS = /^(@[\w.-]+:)?registry$|^(https-)?proxy$|^noproxy$|^script-shell$|^node-options$|^cafile$|^ca(\[\])?$|^prefix$|^globalconfig$|^userconfig$|^replace-registry-host$/;
export function npmrcBad(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*[;#]/.test(line)) continue;
    const m = /^\s*["']?([^="'\s]+)["']?\s*=\s*["']?(.*?)["']?\s*$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].toLowerCase();
    if (NPMRC_KEYS.test(k) || ((k === 'strict-ssl' || k === 'ignore-scripts') && v === 'false')) return true;
  }
  return false;
}
const NPMRC_BAD = { test: npmrcBad };
const CARGO_CONFIG_BAD = /^\s*\[(source|registries|patch|net)\b|replace-with\s*=|^\s*\[http\]|proxy\s*=|^\s*\[env\]|^\s*\[build\]|^\s*\[target\.|^\s*\[alias\]/im;
const readText = f => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
const NON_REGISTRY = /^(git(\+\w+)?|github|gitlab|bitbucket|https?|file|link|workspace|npm|portal|patch):|^[\w.-]+\/[\w.-]+(#.*)?$|\.(tgz|tar\.gz|zip)$/i;
function manifestFindings(rel, text) {
  if (/(^|\/)package\.json$/i.test(rel)) {
    let j;
    try { j = JSON.parse(text); } catch { return [`${rel} cannot be read`]; }
    const bad = [];
    const walk = (o, where) => { if (typeof o === 'string') { if (NON_REGISTRY.test(o.trim())) bad.push(`${rel}: ${where} is a git, path or address source`); } else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, `${where}.${k}`); };
    for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'resolutions']) if (j[k]) walk(j[k], k);
    return bad;
  }
  if (/(^|\/)cargo\.toml$/i.test(rel)) {
    const bad = [];
    if (/^\s*\[(patch|replace)\b/im.test(text)) bad.push(`${rel} has a [patch] or [replace] section`);
    if (/\b(git|path|registry|registry-index)\s*=\s*["']/.test(text)) bad.push(`${rel} has a git, path or other-registry dependency`);
    return bad;
  }
  return [];
}
// Lockfile, manifests and registry config unchanged from the merge-base with main? -> [] when so, else why not.
// The repository must be the project's own: the project folder is its top, and the folder the command runs in belongs
// to the same repository (the project folder or one of its registered worktrees), so a repository made inside the
// project cannot stand in for it. The base is the project's own origin/main only, never a local branch.
export function lockfileProblems(cwd, { projectDir, home = homedir() } = {}) {
  const none = 'This folder is not in the project\'s own git repository, which the hub can read';
  let top, common, worktrees;
  try {
    const topCwd = gitOut(cwd, ['rev-parse', '--show-toplevel']).trim();
    const topProj = gitOut(projectDir, ['rev-parse', '--show-toplevel']).trim();
    const commonCwd = gitOut(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    common = gitOut(projectDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    if (!topCwd || !topProj || !commonCwd || !common) return [none];
    if (low(topProj) !== low(resolve(projectDir))) return ['The project folder is not the top of its own git repository'];
    if (low(commonCwd) !== low(common)) return ['This folder belongs to a different git repository than the project'];
    worktrees = gitOut(projectDir, ['worktree', 'list', '--porcelain']).split(/\r?\n/).filter(l => l.startsWith('worktree ')).map(l => low(l.slice(9).trim()));
    if (!worktrees.includes(low(topCwd))) return ['This folder is not the project or one of its registered worktrees'];
    top = topCwd;
  } catch { return [none]; }
  let base = null;
  try { base = gitOut(top, ['merge-base', 'HEAD', 'origin/main']).trim(); } catch { base = null; }
  if (!base) return ['The hub cannot find where this branch left the project\'s origin/main (no merge-base)'];
  let inBase, inTree;
  try {
    inBase = gitOut(top, ['ls-tree', '-r', '--name-only', '--full-tree', '-z', base]).split('\0').filter(Boolean);
    inTree = gitOut(top, ['ls-files', '-z', '--full-name', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  } catch { return ['The hub cannot list the repository\'s files']; }
  const probe = new Set();
  for (const f of [...inBase, ...inTree]) if (WATCHED.test(f)) probe.add(f);
  // Ignored files git does not list: the config the tools read from here upward.
  const topS = slash(top), cwdS = slash(resolve(cwd));
  let dir = low(cwdS).startsWith(`${low(topS)}/`) ? cwdS.slice(topS.length).replace(/^\/+/, '') : '';
  for (let i = 0; i < 30; i++) {
    for (const n of ['.npmrc', '.cargo/config.toml', '.cargo/config']) probe.add(dir ? `${dir}/${n}` : n);
    if (!dir) break;
    dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
  }
  const why = [];
  for (const rel of probe) {
    const file = join(top, rel);
    const inT = existsSync(file), inB = inBase.includes(rel);
    if (!inT && !inB) continue;
    if (inT !== inB) { why.push(`${rel} ${inT ? 'is new' : 'was removed'} since main`); continue; }
    if (!gitOk(top, ['diff', '--quiet', '--no-ext-diff', '--no-textconv', base, '--', rel])) { why.push(`${rel} changed since main`); continue; }
    const text = readText(file);
    if (text == null) { why.push(`${rel} cannot be read`); continue; }
    if (/(^|\/)\.npmrc$/i.test(rel) && NPMRC_BAD.test(text)) why.push(`${rel} sets a registry, proxy or script option`);
    else if (/\.cargo\/config/i.test(rel) && CARGO_CONFIG_BAD.test(text)) why.push(`${rel} sets a registry, source, patch or build option`);
    why.push(...manifestFindings(rel, text));
  }
  for (const [f, re] of [[join(home, '.npmrc'), NPMRC_BAD], [join(home, '.cargo', 'config.toml'), CARGO_CONFIG_BAD], [join(home, '.cargo', 'config'), CARGO_CONFIG_BAD]]) {
    const t = readText(f);
    if (t != null && re.test(t)) why.push(`${f.replace(home, '~')} sets a registry, proxy or source option`);
  }
  return why.slice(0, 6);
}

// ---------- the install gates ----------
const ago = ms => { const h = Math.max(0, Math.round(ms / 3600000)); return h < 48 ? `${h} hour${h === 1 ? '' : 's'}` : `${Math.round(h / 24)} days`; };
// The major version a project already has: installed, else written in its manifest.
// -> { major, minor } of a version or a declared range ("^3.1.0"), or null.
const verBase = v => { const m = /^[~^=v\s>]*(\d+)(?:\.(\d+))?/.exec(String(v ?? '')); return m ? { major: Number(m[1]), minor: m[2] === undefined ? null : Number(m[2]) } : null; };
function npmBaseline(cwd, name) {
  const inst = readText(join(cwd, 'node_modules', ...name.split('/'), 'package.json'));
  if (inst) { try { const b = verBase(JSON.parse(inst).version); if (b) return b; } catch { } }
  const pj = readText(join(cwd, 'package.json'));
  if (pj) {
    try {
      const j = JSON.parse(pj);
      for (const k of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const b = typeof j[k]?.[name] === 'string' ? verBase(j[k][name]) : null;
        if (b) return b;
      }
    } catch { }
  }
  return null;
}
function pipBaseline(venv, name) {
  const want = pipName(name);
  const roots = [join(venv, 'Lib', 'site-packages')];
  try { for (const d of readdirSync(join(venv, 'lib'))) roots.push(join(venv, 'lib', d, 'site-packages')); } catch { }
  for (const r of roots) {
    let names = [];
    try { names = readdirSync(r); } catch { continue; }
    for (const n of names) {
      const m = /^(.+?)-(\d[^-]*)\.dist-info$/.exec(n);
      if (m && pipName(m[1]) === want) { const b = verBase(m[2]); if (b) return b; }
    }
  }
  return null;
}
// -> [] when the release may be installed, else the reasons it goes to Matt.
// before: npm's --before date (ms). maxAgeMs: how old the remembered registry answer may be.
function gate(lists, eco, spec, entry, baseline, { before = null, maxAgeMs } = {}) {
  const label = `${spec.name}${spec.spec ? ` (${spec.spec})` : ''}`;
  let info = null;
  try { info = lists.lookup(eco, spec.name, maxAgeMs); } catch { info = null; }
  if (!info) return [`The registry could not be asked when ${label} was released (it is being looked up now, so the next try can be settled), and the 3-day check was not done`];
  const now = lists.now();
  const r = resolveVersion(eco, spec.spec, info, before);
  if (r.why) {
    const r0 = before ? resolveVersion(eco, spec.spec, info) : null, at0 = r0?.version ? info.versions[r0.version]?.at : null;
    if (at0 != null && now - at0 < MIN_AGE_MS) return [`${label} ${r0.version} was released ${ago(now - at0)} ago, under the 3-day wait`];
    return [`${label}: ${r.why}`];
  }
  const rel = info.versions[r.version];
  if (!rel || rel.at == null) return [`${label} ${r.version}: the registry gives no release date`];
  if (rel.yanked) return [`${label} ${r.version} was withdrawn by its author`];
  if (now - rel.at < MIN_AGE_MS) return [`${label} ${r.version} was released ${ago(now - rel.at)} ago, under the 3-day wait`];
  if (isPre(eco, r.version)) return [`${label} ${r.version} is a pre-release`];
  const base = baseline ?? (entry.baseMajor != null ? { major: entry.baseMajor, minor: entry.baseMinor ?? null } : null);
  if (!base) return [`${label} ${r.version}: no earlier version of it is in this project to compare the major version with`];
  if (isJump(r.version, base)) return [`${label} ${r.version} is a major version jump (the project has ${base.major}.${base.major === 0 && base.minor != null ? `${base.minor}.` : ''}x)`];
  return [];
}

// ---------- one request ----------
const under = (p, root) => { const a = low(p), r = low(root); return a === r || a.startsWith(`${r}/`); };
const NET_REASON = /^(Reaches the network|Reaches the npm registry|Installs|Changes dependencies|Saves a GitHub download outside)/;

// ctx: { lists (forProject snapshot), tool, input, projectDir, cwd (where the command runs), tmp, home }
// -> null (not a request about the lists) | { allow, why, downloads: [{ path, url, host }] } | { gate: [reasons] } | { note: [problems] }
export function decide(ctx) {
  const { lists, tool, input } = ctx;
  if (!lists) return null;
  if (tool === 'WebFetch') {
    const u = parseHttpsUrl(input?.url);
    if (!u.ok) return { note: [u.why] };
    const e = matchSite(lists.sites, u, 'pages', lists.key);
    return e ? { allow: true, why: `${u.host} is on your trusted sites (pages)` } : null;
  }
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const ps = tool === 'PowerShell';
  const words = readWords(input?.command, ps);
  if (!words) return null;
  if (/^\w+=/.test(words[0])) return null;
  const head = programOf(words[0]);   // '' unless a bare program name: ./npm, tools\curl and the like are not read
  const rest = words.slice(1);
  const tmp = ctx.tmp || tmpdir();
  const cwd = ctx.cwd || ctx.projectDir;
  const home = ctx.home || homedir();

  // ----- downloads into the quarantine folder -----
  const isCurl = head === 'curl' && (!ps || /^curl\.exe$/i.test(words[0]));
  const isIwr = ps && (head === 'invoke-webrequest' || head === 'iwr');
  if (isCurl || isIwr) {
    const r = isCurl ? parseCurl(rest) : parseIwr(rest);
    const u = r.url === null ? null : parseHttpsUrl(r.url);
    const problems = [...r.problems];
    if (isCurl && !r.noRc) { const rc = curlConfigFound([cwd, ctx.projectDir, home]); if (rc) problems.push(`curl would read its settings from ${rc} (put -q first to skip it)`); }
    if (isCurl) { const px = Object.keys(process.env).find(k => /^(https?_proxy|all_proxy)$/i.test(k) && process.env[k]); if (px) problems.push(`a proxy is set in the environment (${px})`); }
    if (u && !u.ok) problems.push(u.why);
    let site = null;
    if (u?.ok) {
      site = matchSite(lists.sites, u, 'downloads', lists.key);
      if (!site) { if (!problems.length) return null; problems.push(`${u.host} is not on your list for downloads`); }
    }
    let target = null;
    if (r.out !== null) { target = quarantineTarget(r.out, tmp, { name: quarantineName(ctx.projectDir) }); if (target.why) problems.push(target.why); }
    if (problems.length || !site || !target?.path) return { note: problems };
    return { allow: true, why: `${u.host} is on your trusted sites (downloads, into the quarantine folder)`, downloads: [{ path: target.path, url: `https://${u.host}${u.path}`, host: u.host }] };
  }

  // ----- Hugging Face models: pinned revision, safetensors only, into the quarantine folder -----
  if (head === 'hf' || head === 'huggingface-cli') {
    if (rest[0] !== 'download') return null;
    const problems = [];
    const { r } = parseHf(rest.slice(1), problems);
    const entry = r.repo && findPackage(lists.packages, 'huggingface', r.repo, lists.key);
    if (!entry) return null;
    let target = null;
    if (r.localDir) { target = quarantineTarget(r.localDir, tmp, { dir: true, name: quarantineName(ctx.projectDir) }); if (target.why) problems.push(target.why); }
    if (problems.length || !target?.path) return { note: problems };
    // Approved at one pinned revision: another one (or an entry with none) is Matt's to approve.
    if (!entry.revision) return { gate: [`${r.repo} was approved without a pinned revision: approve it again with the revision you want`] };
    if (entry.revision !== String(r.revision).toLowerCase()) return { gate: [`${r.repo} at revision ${String(r.revision).slice(0, 12)} is not the revision you approved (${entry.revision.slice(0, 12)})`] };
    return { allow: true, why: `${r.repo} is an approved Hugging Face model (pinned revision, safetensors only)`, downloads: [{ path: target.path, url: `huggingface.co/${r.repo}@${r.revision}`, host: 'huggingface.co' }] };
  }

  // ----- npm -----
  if (head === 'npm') {
    const sub = rest[0];
    if (!['install', 'i', 'add', 'ci'].includes(sub || '')) return null;
    if (!under(cwd, ctx.projectDir)) return null;
    if (sub === 'ci') return lockedBuild('npm ci', rest.slice(1), ctx, 'npm');
    const problems = [];
    const { specs, before } = parseNpmInstall(rest.slice(1), problems, lists.now());
    const entries = specs.map(s => findPackage(lists.packages, 'npm', s.name, lists.key));
    if (!specs.length || entries.some(e => !e)) return null;   // something in it is not approved: it stays as it was
    if (!existsSync(join(cwd, 'package.json'))) problems.push('There is no package.json in the folder it runs in');
    for (const f of [join(cwd, '.npmrc'), join(ctx.projectDir, '.npmrc'), join(home, '.npmrc')]) { const t = readText(f); if (t != null && NPMRC_BAD.test(t)) problems.push('An .npmrc sets a registry, proxy or script option'); }
    if (problems.length) return { note: problems };
    const gates = specs.flatMap((s, i) => gate(lists, 'npm', s, entries[i], npmBaseline(cwd, s.name), { before }));
    if (gates.length) return { gate: gates };
    return { allow: true, why: `${specs.map(s => s.name).join(', ')} ${specs.length > 1 ? 'are' : 'is'} on your approved packages (npm, scripts off)` };
  }

  // ----- pip, only through the project's own .venv -----
  if (/^(python3?|py)(\.exe)?$/i.test(basename(slash(words[0])))) {
    if (!(rest[0] === '-m' && rest[1] === 'pip' && rest[2] === 'install')) return null;
    const w0 = slash(words[0]);
    const exe = absolutePath(w0, tmp) || (/^(\.\/)?\.venv\//.test(w0) ? slash(resolve(cwd, w0)) : null);
    const venv = join(ctx.projectDir, '.venv');
    const ok = exe && ['Scripts/python', 'Scripts/python.exe', 'bin/python', 'bin/python3'].some(p => low(exe) === low(`${venv}/${p}`));
    if (!ok) return null;   // not the project's own .venv: pip stays a stop
    const problems = [];
    if (!existsSync(join(venv, 'pyvenv.cfg'))) problems.push('The project\'s .venv has no pyvenv.cfg');
    const { specs } = parsePipInstall(rest.slice(3), problems);
    const entries = specs.map(s => findPackage(lists.packages, 'pip', s.name, lists.key));
    if (!specs.length || entries.some(e => !e)) return null;
    const cfg = pipConfigFound(venv, home);
    if (cfg) problems.push(cfg);
    if (problems.length) return { note: problems };
    // A pinned release never changes, so its answer may be old; an unpinned one takes whatever is newest, so it must be fresh.
    const gates = specs.flatMap((s, i) => gate(lists, 'pip', s, entries[i], pipBaseline(venv, s.name), { maxAgeMs: s.spec ? LOOKUP_TTL_MS : PIP_FRESH_MS }));
    if (gates.length) return { gate: gates };
    return { allow: true, why: `${specs.map(s => s.name).join(', ')} ${specs.length > 1 ? 'are' : 'is'} on your approved packages (pip in the project's .venv, wheels only)` };
  }

  // ----- cargo build / fetch --locked -----
  if (head === 'cargo') {
    if (!under(cwd, ctx.projectDir)) return null;
    const problems = [];
    const c = parseCargo(rest, problems);
    if (!c) return null;
    return lockedBuild(`cargo ${c.sub}`, null, ctx, 'cargo', problems);
  }
  return null;
}
// pip settings that could point it at another index or proxy: a pip.ini / pip.conf in the project's .venv, in the user's
// or the machine's usual places, PIP_CONFIG_FILE, or any PIP_ setting in the hub's own environment. -> why, or null.
function pipConfigFound(venv, home) {
  const env = Object.keys(process.env).find(k => /^pip_/i.test(k) && process.env[k]);
  if (env) return `${env} is set in the environment pip would run in`;
  const files = [join(venv, 'pip.ini'), join(venv, 'pip.conf'), join(home, 'pip', 'pip.ini'), join(home, '.pip', 'pip.conf'), join(home, '.config', 'pip', 'pip.conf'), '/etc/pip.conf', '/etc/xdg/pip/pip.conf']
    .concat([process.env.APPDATA, process.env.ProgramData, process.env.XDG_CONFIG_HOME].filter(Boolean).map(d => join(d, 'pip', d === process.env.XDG_CONFIG_HOME ? 'pip.conf' : 'pip.ini')));
  for (const f of files) {
    const t = readText(f);
    if (t != null && (f.startsWith(venv) || /index|find-links|proxy|trusted-host|cert|no-index/i.test(t))) return `${f.replace(home, '~')} sets pip options`;
  }
  return null;
}
// A bare program name (no folder in front): npm, npm.cmd, curl.exe -> npm, npm, curl; anything else ''.
const programOf = w => /^[A-Za-z][\w.-]*$/.test(w) ? w.toLowerCase().replace(/\.(exe|cmd|bat)$/, '') : '';
// A curl settings file it would pick up on its own, in the places it looks: the first one found, or null.
function curlConfigFound(dirs) {
  const homes = [process.env.CURL_HOME, process.env.XDG_CONFIG_HOME, process.env.APPDATA, process.env.USERPROFILE, process.env.HOME].filter(Boolean);
  for (const d of [...dirs, ...homes]) for (const n of ['.curlrc', '_curlrc', 'curlrc']) { const f = join(d, n); if (existsSync(f)) return f; }
  return null;
}

function lockedBuild(what, npmArgs, ctx, kind, problems = []) {
  const cwd = ctx.cwd || ctx.projectDir;
  if (kind === 'npm') for (const t of npmArgs) if (!NPM_CI_FLAGS.test(t)) problems.push(`npm ci option ${t} is not one the hub reads`);
  if (kind === 'npm' && !npmArgs.includes('--ignore-scripts')) problems.push('npm ci without --ignore-scripts would run the pinned packages\' install scripts');
  if (kind === 'npm' && !existsSync(join(cwd, 'package-lock.json'))) problems.push('There is no package-lock.json in the folder it runs in');
  if (kind === 'cargo') { let d = resolve(cwd), found = false; for (let i = 0; i < 12 && !found; i++) { found = existsSync(join(d, 'Cargo.lock')); const up = dirname(d); if (up === d) break; d = up; } if (!found) problems.push('There is no Cargo.lock to build from'); }
  if (problems.length) return { note: problems };
  const changed = lockfileProblems(cwd, { projectDir: ctx.projectDir, home: ctx.home || homedir() });
  if (changed.length) return { note: [`${what} is only settled here when the lockfile, manifests and registry config match main: ${changed.join('; ')}`] };
  return { allow: true, why: `${what} fetches only what the lockfile pins, and the lockfile, manifests and registry config match main` };
}

// The hook (permission-rules.mjs classify): the result of the normal check in, the final result out.
// out: { route, reasons, unsure }. downloaded: classify's Set of files this agent saved (running one stays a stop).
export function settleLists(out, ctx) {
  if (!ctx?.lists) return out;
  let v = null;
  try { v = decide(ctx); } catch { v = null; }   // a failure here is never an allow
  const tmp = ctx.tmp || tmpdir();
  const text = String(ctx.input?.command || '');
  if (v?.allow && out.route !== 'allow') {
    // Only a stop or a doubt about the network or an install is turned into an allow; any other hard stop stays.
    if (out.route === 'human' && !out.reasons.every(r => NET_REASON.test(r))) return out;
    if (SECRET_WORDS.test(text)) return out;
    for (const d of v.downloads || []) ctx.downloaded?.add(slash(d.path).toLowerCase().replace(/\/+$/, ''));
    return { ...out, route: 'allow', reasons: [], unsure: [], listed: v.why, downloads: v.downloads || [] };
  }
  if (v?.allow) { for (const d of v.downloads || []) ctx.downloaded?.add(slash(d.path).toLowerCase().replace(/\/+$/, '')); return { ...out, listed: v.why, downloads: v.downloads || [] }; }
  if (v?.gate && out.route !== 'allow') {   // Trusted already lets installs through; the gates are for what would otherwise be a stop
    const reasons = v.gate.map(g => `Approved package, but it comes to you: ${g}`);
    return { ...out, route: 'human', reasons: [...new Set([...out.reasons, ...reasons])] };
  }
  if (v?.note?.length) {
    const add = v.note.map(n => `Not settled by your lists: ${n}`);
    return out.route === 'human' ? { ...out, reasons: [...out.reasons, ...add] } : out.route === 'unsure' ? { ...out, unsure: [...out.unsure, ...add] } : out;
  }
  // Moving, copying or running something in a quarantine folder is its own request, never an allow by itself: every path
  // the command names is resolved (relative to where it runs, .., globs, 8.3 names, links) before it is judged.
  if (out.route === 'allow' && /^(Bash|PowerShell)$/.test(ctx.tool)) {
    let leaves = true;
    try { leaves = leavesQuarantine(text, ctx.cwd || ctx.projectDir, tmp); } catch { leaves = true; }   // cannot tell: not an allow
    if (leaves) return { ...out, route: 'unsure', unsure: ['Moves, copies or runs something in a quarantine folder: only the check or the orchestrator can say yes to that'] };
  }
  return out;
}
const SECRET_WORDS = /\.env\b|\.ssh\b|\.crux-hub\b|\bid_(rsa|ed25519)\b|\bcredentials?\b|\bpassword\b|\bsecret\b|api[_-]?key|\.npmrc|\.pypirc|\.netrc/i;

// ---------- the "Always allow" offers on Matt's cards ----------
// What a request could add to the lists: [{ kind: 'site', host, access, pin }, { kind: 'package', eco, name }]. Only
// plainly readable requests offer anything; the add itself is checked again by the server.
export function suggest(tool, input) {
  const out = [];
  if (tool === 'WebFetch') {
    const u = parseHttpsUrl(input?.url);
    if (u.ok) out.push({ kind: 'site', host: u.host, access: 'pages', pin: null });
    return out;
  }
  if (tool !== 'Bash' && tool !== 'PowerShell') return out;
  const ps = tool === 'PowerShell';
  const words = readWords(input?.command, ps);
  if (!words || /^\w+=/.test(words[0])) return out;
  const head = programOf(words[0]), rest = words.slice(1);
  if ((head === 'curl' && (!ps || /^curl\.exe$/i.test(words[0]))) || (ps && (head === 'invoke-webrequest' || head === 'iwr'))) {
    const r = head === 'curl' ? parseCurl(rest) : parseIwr(rest);
    const u = r.url === null ? null : parseHttpsUrl(r.url);
    if (u?.ok && !r.hard) {
      const pin = isOpenHost(u.host) ? pinFor(u.host, u.path) : null;
      if (!isOpenHost(u.host) || pin) out.push({ kind: 'site', host: u.host, access: 'downloads', pin });
    }
    return out;
  }
  const problems = [];
  if (head === 'npm' && ['install', 'i', 'add'].includes(rest[0] || '')) {
    const { specs, hard } = parseNpmInstall(rest.slice(1), problems);
    if (!hard) for (const s of specs.slice(0, 3)) out.push({ kind: 'package', eco: 'npm', name: s.name });
  } else if (/^(python3?|py)(\.exe)?$/i.test(basename(slash(words[0]))) && rest[0] === '-m' && rest[1] === 'pip' && rest[2] === 'install') {
    const { specs, hard } = parsePipInstall(rest.slice(3), problems);
    if (!hard) for (const s of specs.slice(0, 3)) out.push({ kind: 'package', eco: 'pip', name: pipName(s.name) });
  } else if ((head === 'hf' || head === 'huggingface-cli') && rest[0] === 'download') {
    const { r, hard } = parseHf(rest.slice(1), problems);
    if (!hard && r.repo && /^[0-9a-f]{40}$/i.test(r.revision || '')) out.push({ kind: 'package', eco: 'huggingface', name: r.repo, revision: r.revision.toLowerCase() });
  }
  return out;
}

// ---------- the downloads record (kept per project in its event log) ----------
// Every file a listed or contained download saved, from the project's log: running one stays a stop for every agent
// of the project, across restarts. The log's own 'download' events are the record.
export function downloadsFrom(events) {
  const set = new Set();
  for (const e of events || []) if (e?.type === 'download' && typeof e.path === 'string') set.add(slash(e.path).toLowerCase().replace(/\/+$/, ''));
  return set;
}
