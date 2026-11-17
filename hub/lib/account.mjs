// The account the agents run on, chosen on the Account card (decision 78 A) instead of environment variables.
//
//   Plan sign-in: agents use this PC's Claude Code sign-in and draw on that plan's limits (the default).
//   API key:      agents use an Anthropic API key; Anthropic bills the tokens to that key.
//
// The key is kept with Windows' per-user protection (DPAPI, CurrentUser) in the hub's data folder (~/.crux-hub/secrets.json,
// next to the hub's other keys), never in a project, a repo, the event log, a notice or a summary. The page only ever learns
// the last four characters. Where the key cannot be protected (anything but Windows), the hub says so and the environment
// variables keep working: ANTHROPIC_API_KEY plus CRUX_HUB_USE_API_KEY=1, which also win over the card when they are set.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { dataDir } from './relaunch.mjs';

const ENTROPY = 'crux-hub-api-key-v1';   // ties a protected key to this use of DPAPI

// ---------- protecting the key ----------
// The key goes to PowerShell on its standard input (never on the command line, where other programs could read it), and
// the protected bytes come back as base64. Only this Windows user on this PC can open them again.
const PS_HEAD = 'Add-Type -AssemblyName System.Security; $t=[Console]::In.ReadToEnd(); $e=[Text.Encoding]::UTF8; $n=$e.GetBytes("' + ENTROPY + '"); $s=[Security.Cryptography.DataProtectionScope]::CurrentUser; ';
const PS_PROTECT = PS_HEAD + '[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($e.GetBytes($t),$n,$s)))';
const PS_UNPROTECT = PS_HEAD + '[Console]::Out.Write($e.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($t.Trim()),$n,$s)))';
// A failure says so in plain words; PowerShell's own message (it can quote the script) is not passed on.
const runPs = (script, input, run, failure) => {
  try { return String(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input, encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] })); }
  catch { throw new Error(failure); }
};

// null where the key cannot be protected. run is injectable so a test never needs Windows.
export function defaultProtector({ platform = process.platform, run = execFileSync } = {}) {
  if (platform !== 'win32') return null;
  return {
    scheme: 'dpapi-user',
    protect: text => runPs(PS_PROTECT, text, run, 'Windows could not protect the key (PowerShell did not run). Nothing was saved.').trim(),
    unprotect: data => runPs(PS_UNPROTECT, data, run, 'Windows could not open the saved key for this user.')
  };
}
export const NO_PROTECT = 'This computer cannot protect a saved key (Windows only). Set ANTHROPIC_API_KEY and CRUX_HUB_USE_API_KEY=1 in the environment instead; the README shows how.';

// ---------- who is signed in ----------
// Claude Code writes the signed-in person's name beside its settings (.claude.json, in CLAUDE_CONFIG_DIR when that is set).
// Only the name and email are read from it, nothing else, and nothing from it is ever logged. Cached by file time.
let planCache = { file: '', mtime: 0, size: 0, name: null };
export function planName(env = process.env, { home = homedir() } = {}) {
  const file = join(env.CLAUDE_CONFIG_DIR || home, '.claude.json');
  try {
    const st = statSync(file);
    if (planCache.file === file && planCache.mtime === st.mtimeMs && planCache.size === st.size) return planCache.name;
    const acct = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))?.oauthAccount;
    const name = [acct?.displayName, acct?.emailAddress].map(s => String(s || '').trim().slice(0, 80)).find(Boolean) || null;
    planCache = { file, mtime: st.mtimeMs, size: st.size, name };
    return name;
  } catch { return null; }
}

// ---------- the choice ----------
export class Account {
  // secrets: a Secrets (lib/setup.mjs). env: the process environment, which the agents' environment is made from.
  constructor({ env = process.env, secrets, file = join(dataDir(env), 'account.json'), platform = process.platform } = {}) {
    Object.assign(this, { env, secrets, file, platform });
    this.source = null;      // 'environment', 'saved' or null: where the agents' key came from at start
    this.key = null;         // the saved key while it is in use: in this process's memory only, never in the environment
    this.problem = '';       // plain words when a saved key could not be opened
  }
  get mode() { try { const m = JSON.parse(readFileSync(this.file, 'utf8').replace(/^﻿/, ''))?.mode; return m === 'plan' || m === 'key' ? m : null; } catch { return null; } }
  setMode(mode) {
    if (mode !== 'plan' && mode !== 'key') throw new Error('Choose Plan sign-in or API key.');
    mkdirSync(join(this.file, '..'), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ mode }) + '\n');
    renameSync(tmp, this.file);
  }
  get canProtect() { return !!this.secrets.protector; }
  get envKey() { return !!(this.env.ANTHROPIC_API_KEY && this.env.CRUX_HUB_USE_API_KEY === '1'); }

  // At start: an API key set in the environment wins. Else the saved key is used when API key is chosen (the desktop app's
  // first-run key, saved before there was a card, counts as chosen while nothing else was).
  applyAtStart({ bundled = false } = {}) {
    if (this.envKey) return this.source = 'environment';
    const m = this.mode;
    if (m === 'key' || (m == null && bundled)) return this.useSaved();
    return this.source = null;
  }
  // The saved key is opened into this process's memory. It is not put in the environment: the hub's own calls take it from
  // currentKey(), and agents get Claude Code's apiKeyHelper (helperCommand), so no command an agent runs sees it.
  useSaved() {
    if (this.envKey) return this.source = 'environment';   // the environment wins
    this.problem = '';
    if (!this.secrets.savedEnd) return this.source = null;
    let k = null;
    try { k = this.secrets.apiKey; } catch { }
    if (!k) {
      this.problem = 'The saved key could not be opened (it may have been saved by another Windows user or on another PC). Paste it again.';
      console.warn('The saved API key could not be opened; the agents use the plan sign-in until it is pasted again on the Account card.');
      return this.source = null;
    }
    if (this.secrets.isClear) { try { this.secrets.save(k); } catch { } }   // a key an earlier version left in the clear is saved protected now
    this.key = k;
    return this.source = 'saved';
  }
  // The key the hub itself calls with, or ''.
  currentKey() { return this.envKey ? this.env.ANTHROPIC_API_KEY : this.key || ''; }
  // The apiKeyHelper command for Claude Code: it runs key-helper.mjs, which opens the key when asked. null unless the saved key
  // is in use. Forward slashes and quotes, because Claude Code runs it through a shell.
  helperCommand({ node = process.execPath, hubDir } = {}) {
    if (this.source !== 'saved' || !this.key) return null;
    const q = s => `"${String(s).replace(/\\/g, '/')}"`;
    return `${q(node)} ${q(join(hubDir, 'lib', 'key-helper.mjs'))} ${q(this.secrets.file)}`;
  }

  // What the page is told. Never the key: its last four characters at most.
  view() {
    const key = this.currentKey();
    return {
      mode: key ? 'key' : 'plan',
      source: this.source,
      envLocked: this.source === 'environment',
      keyEnd: key ? key.slice(-4) : '',
      problem: this.problem,
      savedEnd: this.secrets.savedEnd,
      planName: planName(this.env),
      canProtect: this.canProtect,
      platform: this.platform
    };
  }

  // Save a pasted key (shape-checked by Secrets) or use the one already saved, choose API key, and return what to restart for.
  chooseKey(newKey) {
    if (this.source === 'environment') throw new Error(ENV_WINS);
    if (newKey) this.secrets.save(newKey);
    else if (!this.secrets.savedEnd) throw new Error('Paste your API key first.');
    this.setMode('key');
  }
  choosePlan() {
    if (this.source === 'environment') throw new Error(ENV_WINS);
    this.setMode('plan');
  }
}
export const ENV_WINS = 'The API key comes from the environment variables (ANTHROPIC_API_KEY and CRUX_HUB_USE_API_KEY), and they win over this card. Remove them, then restart the hub, to choose here.';

// ---------- "Sign in as someone else" ----------
// Claude Code's login is interactive (it opens the browser and waits), so the hub opens a terminal window on this PC that
// runs it (login.mjs --signin), and the card re-reads who is signed in while it waits. Windows only; elsewhere the card
// shows the command to run. Never run by a test hub.
// claudePath: the Claude Code the hub's agents run (the desktop app downloads its own at first run, decision 54), so the
// window signs in with the same one.
export function openSignInWindow({ hubDir, claudePath = null, platform = process.platform, spawnFn = spawn, node = process.execPath } = {}) {
  if (platform !== 'win32') return false;
  const cmd = `start "Claude sign-in" cmd.exe /d /c ""${node}" "${join(hubDir, 'login.mjs')}" --signin${claudePath ? ` --claude "${claudePath}"` : ''}"`;
  const child = spawnFn('cmd.exe', ['/d', '/s', '/c', cmd], { windowsVerbatimArguments: true, windowsHide: true, detached: true, stdio: 'ignore' });
  child.unref?.();
  return true;
}
