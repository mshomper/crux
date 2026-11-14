// First run of the installed desktop app (decisions 52 A and 54 B): the API key, the project folders and Claude Code.
//
// Only a hub that came with the app has this screen: the app's build step puts bundled.json in its hub folder. A hub
// run from a clone never shows it. The key is kept in the hub's data folder (~/.crux-hub/secrets.json, next to the
// hub's settings), never in settings.json, the state the page reads, a log or a repo; the page only learns whether
// one is saved and its last four characters. Folders go into hub.json, where the hub already reads them.
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { dataDir } from './relaunch.mjs';

export const isBundled = hubDir => existsSync(join(hubDir, 'bundled.json'));
export const hubConfigFile = (env = process.env) => join(env.CRUX_HOME || join(homedir(), 'crux'), 'hub.json');

// ---------- the API key ----------
export const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;
export class Secrets {
  constructor({ env = process.env, file = join(dataDir(env), 'secrets.json') } = {}) { Object.assign(this, { env, file }); }
  read() { try { return JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')) || {}; } catch { return {}; } }
  get apiKey() { const k = this.read().anthropicApiKey; return typeof k === 'string' && KEY_SHAPE.test(k) ? k : null; }
  save(key) {
    const k = String(key || '').trim();
    if (!KEY_SHAPE.test(k)) throw new Error('That does not look like an Anthropic API key. It starts with sk-ant- (copy it from console.anthropic.com, API keys).');
    mkdirSync(dataDir(this.env), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...this.read(), anthropicApiKey: k }, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
    return k;
  }
  // At start and after a save: agents use the saved key unless one is already set in the environment.
  apply(env = process.env) {
    if (env.ANTHROPIC_API_KEY && env.CRUX_HUB_USE_API_KEY === '1') return 'environment';
    const k = this.apiKey;
    if (!k) return null;
    env.ANTHROPIC_API_KEY = k;
    env.CRUX_HUB_USE_API_KEY = '1';
    return 'saved';
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
