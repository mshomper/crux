// Restarting the hub (M010): from the Restart item in the hub's own menu, or from "Restart Crux Hub.vbs" when the
// hub is stuck or stopped. Either way the new hub runs detached with no window, started exactly as the last one was.
//
// Each running hub writes how it was started to <data>/launch-<port>.json, and a restarted hub's output goes to
// <data>/hub-<port>.log. <data> is CRUX_HUB_DATA or ~/.crux-hub, outside every repo, as for the hub's settings.
import { spawn, execFile } from 'node:child_process';
import { openSync, closeSync, writeFileSync, readFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const HUB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 4747;
export const dataDir = (env = process.env) => env.CRUX_HUB_DATA || join(homedir(), '.crux-hub');
export const launchFile = (port, env) => join(dataDir(env), `launch-${port}.json`);
export const logFile = (port, env) => join(dataDir(env), `hub-${port}.log`);

// A test hub starts no real agents, so a click-test cannot spend plan usage or act in a project by accident:
// when started with --no-agents, or with its data folder (CRUX_HUB_DATA) inside the system temp folder.
// CRUX_HUB_AGENTS=1 lets a test that needs a real agent have one.
export function testHubWithoutAgents({ args = [], env = process.env, tmp = tmpdir() } = {}) {
  if (env.CRUX_HUB_AGENTS === '1') return false;
  if (args.includes('--no-agents')) return true;
  const norm = s => resolve(String(s)).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  return !!env.CRUX_HUB_DATA && (norm(env.CRUX_HUB_DATA) + '/').startsWith(norm(tmp) + '/');
}

// A test hub must be given its project folders on the command line; it never reads ~/crux/hub.json or uses the
// current folder, which would load real projects. The exception: CRUX_HOME inside the temp folder, whose hub.json
// is a throwaway one (the desktop app's first-run rehearsal). Returns the message to print, or '' when the start is fine.
export function testHubFolderError({ noAgents, folders = [], tempHome = false }) {
  return noAgents && !folders.length && !tempHome
    ? 'Test hub refused: give its project folders on the command line (it never falls back to hub.json or the current folder).'
    : '';
}

// Whether a folder (CRUX_HOME, CRUX_HUB_DATA) sits inside the system temp folder.
export function inTemp(dir, tmp = tmpdir()) {
  if (!dir) return false;
  const norm = s => resolve(String(s)).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  return (norm(dir) + '/').startsWith(norm(tmp) + '/');
}

// --test-pair (decision 47): a test hub may start with one fake paired device, so screenshots and tests can make
// changes. Never the live hub: only on a port other than 4747, with --no-agents (or data in temp) and no real agents,
// and with its data folder (CRUX_HUB_DATA) inside the system temp folder. Returns the message to print, or ''.
export function testPairError({ wanted, noAgents, port, env = process.env, tmp = tmpdir() }) {
  if (!wanted) return '';
  const norm = s => resolve(String(s)).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const tempData = !!env.CRUX_HUB_DATA && (norm(env.CRUX_HUB_DATA) + '/').startsWith(norm(tmp) + '/');
  if (Number(port) === DEFAULT_PORT || !Number.isInteger(Number(port))) return '--test-pair refused: never on port 4747, the live hub.';
  if (!noAgents) return '--test-pair refused: only on a test hub with no agents (--no-agents, and CRUX_HUB_AGENTS not 1).';
  if (!tempData) return '--test-pair refused: the hub\'s data folder (CRUX_HUB_DATA) must be inside the temp folder.';
  return '';
}

// A short fingerprint of the page's files (every file under public/, names and contents). It changes whenever
// any page file does, so an open page can tell that it is out of date.
export function pageBuild(dir) {
  const h = createHash('sha256');
  const walk = d => {
    for (const name of readdirSync(d).sort()) {
      const f = join(d, name);
      if (statSync(f).isDirectory()) walk(f);
      else { h.update(relative(dir, f).replace(/\\/g, '/')); h.update('\0'); h.update(readFileSync(f)); h.update('\0'); }
    }
  };
  try { walk(dir); } catch { return 'unknown'; }
  return h.digest('hex').slice(0, 12);
}

// How this process was started: the same node, flags, script, arguments and folder.
export function launchSpec({ port, execPath = process.execPath, execArgv = process.execArgv, argv = process.argv, cwd = process.cwd() }) {
  return { port: Number(port), node: execPath, args: [...execArgv, ...argv.slice(1)], cwd };
}

export function saveLaunch(spec, env = process.env) {
  try {
    mkdirSync(dataDir(env), { recursive: true });
    writeFileSync(launchFile(spec.port, env), JSON.stringify({ ...spec, saved: new Date().toISOString() }, null, 1));
  } catch (e) { console.warn(`Could not save how the hub was started: ${e.message}`); }
}

// The saved start for a port, or the plain one: node server.mjs in the hub folder (projects from ~/crux/hub.json).
// A saved start whose node, script or folder is gone (the desktop app reinstalled elsewhere, a deleted clone) is
// passed over for the plain one.
export function readLaunch(port = DEFAULT_PORT, env = process.env, exists = existsSync) {
  try {
    const s = JSON.parse(readFileSync(launchFile(port, env), 'utf8'));
    const script = s && Array.isArray(s.args) ? s.args.map(String).find(a => /server\.mjs$/.test(a)) : null;
    const there = s && exists(s.node) && exists(s.cwd) && (!script || exists(resolve(String(s.cwd), script)));
    if (there && typeof s.node === 'string' && Array.isArray(s.args) && typeof s.cwd === 'string') return { port: Number(port), node: s.node, args: s.args.map(String), cwd: s.cwd };
  } catch { }
  return { port: Number(port), node: process.execPath, args: [join(HUB_DIR, 'server.mjs'), ...(Number(port) === DEFAULT_PORT ? [] : ['--port', String(port)])], cwd: HUB_DIR };
}

// Start a hub detached from this process, with no window. CRUX_HUB_RESTARTED tells it to wait for the port
// if the old hub has not let go of it yet.
export function startDetached(spec, { env = process.env, spawnFn = spawn } = {}) {
  let out = 'ignore';
  try { mkdirSync(dataDir(env), { recursive: true }); out = openSync(logFile(spec.port, env), 'w'); } catch { }
  try {
    const child = spawnFn(spec.node, spec.args, { cwd: spec.cwd, env: { ...env, CRUX_HUB_RESTARTED: '1' }, detached: true, windowsHide: true, stdio: ['ignore', out, out] });
    child.unref?.();
    return child;
  } finally { if (typeof out === 'number') closeSync(out); }
}


// Process ids listening on a TCP port, from `netstat -ano -p TCP` (Windows). Listening sockets are the ones whose
// remote address is 0.0.0.0:0 or [::]:0, which holds in every language Windows is set to.
export function listeningPids(netstat, port) {
  const pids = new Set();
  for (const line of String(netstat).split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+(?:0\.0\.0\.0|\[::\]):0\s+\S+\s+(\d+)\s*$/i.exec(line);
    if (m && Number(m[2]) === Number(port) && Number(m[3]) > 0) pids.add(Number(m[3]));
  }
  return [...pids];
}

const run = (cmd, args) => new Promise(res => execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, stdout) => res({ ok: !err, out: String(stdout || '') })));

export async function pidsOnPort(port) {
  if (process.platform !== 'win32') {
    const r = await run('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN']);
    return r.out.split(/\s+/).filter(Boolean).map(Number);
  }
  return listeningPids((await run('netstat', ['-ano', '-p', 'TCP'])).out, port);
}

// Stop a process and everything it started (its agents' Claude Code processes).
export async function stopTree(pid) {
  if (!pid || pid === process.pid) return false;
  if (process.platform === 'win32') return (await run('taskkill', ['/PID', String(pid), '/T', '/F'])).ok;
  try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Ask the hub on a port whether it is up. Returns its boot id, or null.
export async function ping(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? ((await r.json()).boot || 'up') : null;
  } catch { return null; }
}

export async function waitFor(check, { timeoutMs = 30000, everyMs = 300 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await check();
    if (v) return v;
    await sleep(everyMs);
  }
  return null;
}

// Open the hub in the default browser.
export function openApp(url, { spawnFn = spawn } = {}) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawnFn(cmd, args, { detached: true, windowsHide: true, stdio: 'ignore' }).unref?.();
}
