// First run of the installed desktop app (decisions 52 A and 54 B): the API key, the project folders and Claude Code.
//
// Only a hub that came with the app has this screen: the app's build step puts bundled.json in its hub folder. A hub
// run from a clone never shows it. The key is kept, protected for this Windows user, in the hub's data folder
// (~/.crux-hub/secrets.json, next to the hub's settings), never in settings.json, the state the page reads, a log or a
// repo; the page only learns whether one is saved and its last four characters. Folders go into hub.json, where the hub already reads them.
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { dataDir } from './relaunch.mjs';
import { defaultProtector, NO_PROTECT } from './account.mjs';

export const isBundled = hubDir => existsSync(join(hubDir, 'bundled.json'));
export const hubConfigFile = (env = process.env) => join(env.CRUX_HOME || join(homedir(), 'crux'), 'hub.json');

// ---------- the API key ----------
export const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;
// The key is kept with Windows' per-user protection (account.mjs): secrets.json holds the protected text and the key's last
// four characters, never the key. A key saved in the clear by an earlier version is still read, and replaced by a protected
// one at the next save. Where nothing can protect it, saving is refused (the environment variables still work).
export class Secrets {
  constructor({ env = process.env, file = join(dataDir(env), 'secrets.json'), protector = defaultProtector() } = {}) { Object.assign(this, { env, file, protector }); }
  read() { try { return JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')) || {}; } catch { return {}; } }
  // The key, opened. Only when it is about to be used (start, a switch), never for a page.
  get apiKey() {
    const d = this.read();
    let k = d.anthropicApiKey;
    if (typeof d.anthropicApiKeyProtected === 'string') {
      try { k = this.protector?.unprotect(d.anthropicApiKeyProtected); } catch { k = null; }
    }
    return typeof k === 'string' && KEY_SHAPE.test(k) ? k : null;
  }
  // A key an earlier version saved in the clear (and a protector that could seal it now).
  get isClear() { const d = this.read(); return !!this.protector && typeof d.anthropicApiKeyProtected !== 'string' && typeof d.anthropicApiKey === 'string' && KEY_SHAPE.test(d.anthropicApiKey); }
  // The last four characters, kept beside the protected key so the page can say which one is saved without opening it.
  get savedEnd() {
    const d = this.read();
    if (typeof d.anthropicApiKeyProtected === 'string') return /^[A-Za-z0-9_-]{4}$/.test(d.anthropicApiKeyEnd || '') ? d.anthropicApiKeyEnd : '';
    return typeof d.anthropicApiKey === 'string' && KEY_SHAPE.test(d.anthropicApiKey) ? keyEnd(d.anthropicApiKey) : '';
  }
  save(key) {
    const k = String(key || '').trim();
    if (!KEY_SHAPE.test(k)) throw new Error('That does not look like an Anthropic API key. It starts with sk-ant- (copy it from console.anthropic.com, API keys).');
    if (!this.protector) throw new Error(NO_PROTECT);
    const sealed = this.protector.protect(k);
    mkdirSync(dataDir(this.env), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const { anthropicApiKey: _old, ...rest } = this.read();   // the clear copy of an earlier version goes
    writeFileSync(tmp, JSON.stringify({ ...rest, anthropicApiKeyProtected: sealed, anthropicApiKeyEnd: keyEnd(k) }, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
    return k;
  }
}
export const keyEnd = k => (k ? k.slice(-4) : '');

// Ask Anthropic whether it takes the key (a list of models, which costs nothing). 'ok', 'refused', or 'unchecked'
// when it cannot be reached; an unreachable check never blocks saving.
export async function checkKey(key, { fetchFn = globalThis.fetch } = {}) {
  try {
    const r = await fetchFn('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(8000) });
    if (r.status === 401 || r.status === 403) return 'refused';
    return r.ok ? 'ok' : 'unchecked';
  } catch { return 'unchecked'; }
}

// ---------- project folders ----------
// Each must be an existing folder given as a full path. Returns { folders, problems }.
export function checkFolders(list, { exists = existsSync, isDir = p => statSync(p).isDirectory() } = {}) {
  const folders = [], problems = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const s = String(raw || '').trim().replace(/^"(.*)"$/, '$1');
    if (!s) continue;
    if (!isAbsolute(s)) { problems.push(`${s}: give the full path, like C:\\Users\\you\\Documents\\project`); continue; }
    const p = resolve(s);
    let ok = false;
    try { ok = exists(p) && isDir(p); } catch { }
    if (!ok) { problems.push(`${s}: no such folder`); continue; }
    if (!folders.some(f => f.toLowerCase() === p.toLowerCase())) folders.push(p);
  }
  return { folders, problems };
}

export function readHubConfig(file = hubConfigFile()) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {}; } catch { return {}; }
}
// Saves the folders into hub.json, keeping everything else in it.
export function saveProjects(folders, file = hubConfigFile()) {
  const cfg = readHubConfig(file);
  cfg.projects = folders.map(f => f.replace(/\\/g, '/'));
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return cfg.projects;
}

// Saves a dollar limit as the default for every expedition launch (defaults.expedition.envelope.dollars), keeping the rest of
// hub.json. For an API-key user with no dollars-per-percent figure. Returns the saved figure.
export const MAX_RUN_DOLLARS = 500;   // the most one run's dollar limit may be (the launch panel checks the same figure)
// A dollar figure as the user typed it or a page sent it: a plain number above 0 and at most MAX_RUN_DOLLARS, rounded to cents.
// -> { value } or { problem } in plain words. "1,5" is refused, never read as 15.
export function checkDollars(v) {
  const s = String(v ?? '').trim().replace(/^\$/, '');
  if (!/^\d+(\.\d+)?$/.test(s) || !(Number(s) > 0)) return { problem: 'The dollar limit must be a plain number above 0, for example 10.' };
  const n = Math.round(Number(s) * 100) / 100;
  if (n > MAX_RUN_DOLLARS) return { problem: `The dollar limit for one run is at most $${MAX_RUN_DOLLARS}.` };
  return n > 0 ? { value: n } : { problem: 'The dollar limit must be a plain number above 0, for example 10.' };
}
export function saveDollarCap(dollars, file = hubConfigFile()) {
  const c = checkDollars(dollars);
  if (c.problem) throw new Error(c.problem);
  const n = c.value;
  // A hub.json that exists but cannot be read is never rewritten: that would drop the user's projects and settings.
  let cfg = {};
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
    if (text.trim()) {
      try { cfg = JSON.parse(text); } catch (e) { throw new Error(`${file} could not be read (${e.message}), so the dollar limit was not saved. Fix or remove that file first.`); }
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${file} is not a JSON object, so the dollar limit was not saved.`);
    }
  }
  const defaults = cfg.defaults && typeof cfg.defaults === 'object' ? cfg.defaults : (cfg.defaults = {});
  const ex = defaults.expedition && typeof defaults.expedition === 'object' ? defaults.expedition : (defaults.expedition = {});
  ex.envelope = { ...(ex.envelope && typeof ex.envelope === 'object' ? ex.envelope : {}), dollars: n };
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return n;
}

// The Windows folder picker, shown on this PC's screen, on top. Resolves to the chosen path, or '' when closed.
export function pickFolder({ run = execFile } = {}) {
  if (process.platform !== 'win32') return Promise.resolve('');
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Width = 0; Height = 0; StartPosition = "CenterScreen" }',
    '$owner.Show(); $owner.Activate()',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog -Property @{ Description = "Pick a project folder for Crux"; ShowNewFolderButton = $true; UseDescriptionForTitle = $true }',
    'if ($d.ShowDialog($owner) -eq "OK") { [Console]::Out.Write($d.SelectedPath) }',
    '$owner.Close()'
  ].join('; ');
  return new Promise(res => run('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 10 * 60 * 1000 }, (err, out) => res(err ? '' : String(out || '').trim())));
}
