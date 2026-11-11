// Restarting the hub (M010): from the Restart item in the hub's own menu, or from "Restart Crux Hub.vbs" when the
// hub is stuck or stopped. Either way the new hub runs detached with no window, started exactly as the last one was.
//
// Each running hub writes how it was started to <data>/launch-<port>.json, and a restarted hub's output goes to
// <data>/hub-<port>.log. <data> is CRUX_HUB_DATA or ~/.crux-hub, outside every repo, as for the hub's settings.
import { spawn, execFile } from 'node:child_process';
import { openSync, closeSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const HUB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 4747;
export const dataDir = (env = process.env) => env.CRUX_HUB_DATA || join(homedir(), '.crux-hub');
export const launchFile = (port, env) => join(dataDir(env), `launch-${port}.json`);
export const logFile = (port, env) => join(dataDir(env), `hub-${port}.log`);

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
export function readLaunch(port = DEFAULT_PORT, env = process.env) {
  try {
    const s = JSON.parse(readFileSync(launchFile(port, env), 'utf8'));
    if (s && typeof s.node === 'string' && Array.isArray(s.args) && typeof s.cwd === 'string') return { port: Number(port), node: s.node, args: s.args.map(String), cwd: s.cwd };
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
