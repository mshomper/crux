// Which Claude Code program the hub's agents run (decision 54 B).
//
// A hub installed from a clone has the program inside the Agent SDK's own platform package (node_modules), and the SDK
// finds it by itself. The installed desktop app ships without it (it is 330 MB and Anthropic's): on first run the setup
// screen downloads the exact version this SDK expects, Anthropic's own npm package for it, checks it against the
// checksum in the SDK's manifest, and keeps it in the hub's data folder (~/.crux-hub/claude-code/<version>/), outside
// the app's install folder, so app updates never remove it and a new SDK version fetches a new one. A Claude Code
// already installed on the PC is used only when that download is missing (offline).
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { existsSync, readFileSync, mkdirSync, openSync, writeSync, closeSync, renameSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { dataDir } from './relaunch.mjs';

const require = createRequire(import.meta.url);
const REGISTRY = 'https://registry.npmjs.org';

// What this hub's SDK expects: its version, the Claude Code version it was built with, and for this platform the
// binary's name, size and SHA-256 (the SDK's manifest.json). null when the SDK cannot be found.
export function expected({ platform = `${process.platform}-${process.arch}`, sdkDir = null } = {}) {
  try {
    const dir = sdkDir || dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const bin = manifest.platforms?.[platform];
    if (!bin) return null;
    const name = `@anthropic-ai/claude-agent-sdk-${platform}`;
    return {
      sdkDir: dir, sdkVersion: pkg.version, version: manifest.version || pkg.claudeCodeVersion, platform,
      binary: bin.binary, checksum: String(bin.checksum).toLowerCase(), size: Number(bin.size), pkg: name,
      url: `${REGISTRY}/${name}/-/${name.split('/')[1]}-${pkg.version}.tgz`
    };
  } catch { return null; }
}

// The SDK's own copy (a clone's npm install, with optional packages): next to the SDK in node_modules.
export function sdkOwnBinary(exp) {
  if (!exp) return null;
  const f = join(exp.sdkDir, '..', exp.pkg.split('/')[1], exp.binary);
  return existsSync(f) ? f : null;
}

// Where the downloaded copy lives: <hub data>/claude-code/<version>/<binary>.
export const downloadedPath = (exp, env = process.env) => join(dataDir(env), 'claude-code', exp.version, exp.binary);
export function downloadedBinary(exp, env = process.env) {
  if (!exp) return null;
  const f = downloadedPath(exp, env);
  try { return statSync(f).size === exp.size ? f : null; } catch { return null; }
}

// A Claude Code already on this PC, for when the download is missing (offline): Anthropic's installer
// (~/.local/bin), winget's links, then anything named claude.exe on the PATH.
export function installedBinary({ env = process.env, home = homedir(), exists = existsSync } = {}) {
  if (process.platform !== 'win32') return null;
  const spots = [
    join(home, '.local', 'bin', 'claude.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
    ...String(env.PATH || env.Path || '').split(delimiter).filter(Boolean).map(d => join(d, 'claude.exe'))
  ].filter(Boolean);
  return spots.find(f => exists(f)) || null;
}

// An earlier download for another SDK version (kept until the new one is in place): the newest one.
export function previousBinary(exp, env = process.env) {
  if (!exp) return null;
  const root = join(dataDir(env), 'claude-code');
  let dirs = [];
  try { dirs = readdirSync(root).filter(v => v !== exp.version); } catch { return null; }
  const newer = (a, b) => b.localeCompare(a, undefined, { numeric: true });
  for (const v of dirs.sort(newer)) { const f = join(root, v, exp.binary); if (existsSync(f)) return f; }
  return null;
}

// The program the agents should run, and where it came from: 'sdk' (the SDK finds it; no path is passed),
// 'downloaded' (the exact version), or a fallback: 'previous' (an earlier download) or 'installed' (one already on
// the PC). Decision 54 B: a fallback is for when the download cannot be reached; it never makes setup complete by
// itself (claudeReady). null when there is nothing at all.
export function resolveClaude({ env = process.env, exp = expected() } = {}) {
  if (sdkOwnBinary(exp)) return { source: 'sdk', path: null, version: exp.version };
  const d = downloadedBinary(exp, env);
  if (d) return { source: 'downloaded', path: d, version: exp.version };
  const p = previousBinary(exp, env);
  if (p) return { source: 'previous', path: p, version: null };
  const i = installedBinary({ env });
  if (i) return { source: 'installed', path: i, version: null };
  return { source: null, path: null, version: exp?.version || null };
}

// Whether Claude Code counts as set up: the exact version, or a fallback only while the download cannot be reached.
export const claudeReady = (cc, download = {}) => cc.source === 'sdk' || cc.source === 'downloaded' || (!!cc.source && download.state === 'error' && !!download.offline);

// After a new download: earlier versions go (one that is still running stays until next time).
export function removeOlder(exp, env = process.env) {
  const root = join(dataDir(env), 'claude-code');
  let dirs = [];
  try { dirs = readdirSync(root).filter(v => v !== exp.version); } catch { return; }
  for (const v of dirs) { try { rmSync(join(root, v), { recursive: true, force: true }); } catch { } }
}

// ---------- the download ----------
// A .tgz is a gzip of a tar: 512-byte headers, each followed by the file's bytes padded to 512. This keeps one entry
// (package/<binary>) as it streams by, so the 150 MB package is never written to disk whole.
export class TarPick extends Writable {
  constructor(entry, onData) { super(); Object.assign(this, { entry, onData, buf: Buffer.alloc(0), left: 0, pad: 0, keep: false, found: false }); }
  _write(chunk, _enc, done) {
    try {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      while (this.buf.length) {
        if (this.left > 0) {
          const n = Math.min(this.left, this.buf.length);
          if (this.keep) this.onData(this.buf.subarray(0, n));
          this.buf = this.buf.subarray(n); this.left -= n;
          if (!this.left) this.keep = false;
          continue;
        }
        if (this.pad > 0) { const n = Math.min(this.pad, this.buf.length); this.buf = this.buf.subarray(n); this.pad -= n; continue; }
        if (this.buf.length < 512) break;
        const h = this.buf.subarray(0, 512);
        this.buf = this.buf.subarray(512);
        if (h.every(b => b === 0)) continue;   // the two empty blocks at the end
        const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
        const size = parseInt(str(124, 136).trim() || '0', 8);
        const name = (str(257, 263).startsWith('ustar') && str(345, 500) ? str(345, 500) + '/' : '') + str(0, 100);
        const type = String.fromCharCode(h[156] || 48);
        this.left = size; this.pad = (512 - (size % 512)) % 512;
        this.keep = (type === '0' || type === '\0') && name === this.entry;
        if (this.keep) this.found = true;
        if (!size) this.keep = false;
      }
      done();
    } catch (e) { done(e); }
  }
}

// Downloads, checks and puts the expected Claude Code in place. One at a time; state() is what the setup screen shows.
export class ClaudeDownload {
  constructor({ env = process.env, exp = expected(), fetchFn = globalThis.fetch } = {}) {
    Object.assign(this, { env, exp, fetchFn });
    this.st = { state: 'idle', received: 0, total: 0, error: '' };
  }
  state() { return { ...this.st }; }
  async start() {
    if (this.st.state === 'downloading') return this.state();
    const exp = this.exp;
    if (!exp) { this.st = { state: 'error', received: 0, total: 0, error: 'This hub cannot tell which Claude Code it needs (its Agent SDK is missing).' }; return this.state(); }
    this.st = { state: 'downloading', received: 0, total: 0, error: '' };
    this.run().catch(() => { });
    return this.state();
  }
  async run() {
    const exp = this.exp, dest = downloadedPath(exp, this.env), part = `${dest}.part`;
    let fd = null;
    try {
      mkdirSync(dirname(dest), { recursive: true });
      const res = await this.fetchFn(exp.url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
      if (!res.ok || !res.body) throw new Error(`The download server answered ${res.status}.`);
      this.st.total = Number(res.headers.get('content-length')) || 0;
      fd = openSync(part, 'w');
      const hash = createHash('sha256');
      let written = 0;
      const pick = new TarPick(`package/${exp.binary}`, b => { hash.update(b); writeSync(fd, b); written += b.length; });
      const counted = Readable.fromWeb(res.body);
      counted.on('data', c => { this.st.received += c.length; });
      await pipeline(counted, createGunzip(), pick);
      closeSync(fd); fd = null;
      if (!pick.found) throw new Error('The package did not hold the Claude Code program.');
      this.st.state = 'checking';
      const sum = hash.digest('hex');
      if (written !== exp.size || sum !== exp.checksum) throw new Error('The downloaded program did not match its checksum, so it was not kept.');
      renameSync(part, dest);
      removeOlder(exp, this.env);
      this.st.state = 'done';
    } catch (e) {
      if (fd !== null) try { closeSync(fd); } catch { }
      try { rmSync(part, { force: true }); } catch { }
      const net = /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|aborted|timeout/i.test(String(e?.cause?.code || e?.message || e));
      this.st.state = 'error';
      this.st.offline = net;   // only then may a fallback copy stand in (decision 54 B)
      this.st.error = net ? 'Could not reach the download server. Check the internet connection (or a proxy or firewall), then try again.' : String(e.message || e);
    }
  }
}
