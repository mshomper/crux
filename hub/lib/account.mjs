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
const runPs = (script, input, run) => String(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input, encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }));

// null where the key cannot be protected. run is injectable so a test never needs Windows.
export function defaultProtector({ platform = process.platform, run = execFileSync } = {}) {
  if (platform !== 'win32') return null;
  return {
    scheme: 'dpapi-user',
    protect: text => runPs(PS_PROTECT, text, run).trim(),
    unprotect: data => runPs(PS_UNPROTECT, data, run)
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
const KEY_VARS = ['ANTHROPIC_API_KEY', 'CRUX_HUB_USE_API_KEY'];
export class Account {
  // secrets: a Secrets (lib/setup.mjs). env: the process environment, which the agents' environment is made from.
  constructor({ env = process.env, secrets, file = join(dataDir(env), 'account.json'), platform = process.platform } = {}) {
    Object.assign(this, { env, secrets, file, platform });
    this.source = null;      // 'environment', 'saved' or null: where the agents' key came from at start
    this.injected = null;    // what the environment held before the saved key went into it, so a restart can undo it
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

  // At start: an API key set in the environment wins. Else the saved key goes in when API key is chosen (the desktop app's
  // first-run key, saved before there was a card, counts as chosen while nothing else was). Same path as
  // CRUX_HUB_USE_API_KEY=1 always was: the agents read these two variables.
  applyAtStart({ bundled = false } = {}) {
    if (this.envKey) return this.source = 'environment';
    const m = this.mode;
    if (m === 'key' || (m == null && bundled)) return this.useSaved();
    return this.source = null;
  }
  useSaved() {
    const k = this.secrets.apiKey;
    if (!k) return this.source = null;
    if (!this.injected) this.injected = Object.fromEntries(KEY_VARS.map(v => [v, this.env[v]]));
    this.env.ANTHROPIC_API_KEY = k;
    this.env.CRUX_HUB_USE_API_KEY = '1';
    return this.source = 'saved';
  }
  // The environment the next hub is started with: what this one was started with, without the saved key it added.
  restartEnv() {
    const env = { ...this.env };
    if (this.injected) for (const v of KEY_VARS) { if (this.injected[v] === undefined) delete env[v]; else env[v] = this.injected[v]; }
    return env;
  }

  // What the page is told. Never the key: its last four characters at most.
  view() {
    const key = this.envKey ? this.env.ANTHROPIC_API_KEY : '';
    return {
      mode: this.envKey ? 'key' : 'plan',
      source: this.source,
      envLocked: this.source === 'environment',
      keyEnd: key ? key.slice(-4) : '',
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
export function openSignInWindow({ hubDir, platform = process.platform, spawnFn = spawn, node = process.execPath } = {}) {
  if (platform !== 'win32') return false;
  const cmd = `start "Claude sign-in" cmd.exe /d /c ""${node}" "${join(hubDir, 'login.mjs')}" --signin"`;
  const child = spawnFn('cmd.exe', ['/d', '/s', '/c', cmd], { windowsVerbatimArguments: true, windowsHide: true, detached: true, stdio: 'ignore' });
  child.unref?.();
  return true;
}
