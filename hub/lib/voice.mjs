// Voice (decision 61 A): the local Python helper that listens (Parakeet TDT 0.6B v3 through onnx-asr) and speaks
// (Phonon 31M, voice Imogen), both on the CPU.
//
// Where things live: the helper's code and its pinned package list are in hub/voice/ (helper.py, pyproject.toml,
// uv.lock). What gets installed goes in ONE folder outside the repo, %USERPROFILE%\.crux-hub\voice\ (or CRUX_VOICE_DIR):
// venv\ (its Python environment), models\ (the model downloads) and ready.json (written when setup finished, with the
// lockfile it installed). Removing voice is deleting that folder.
//
// The helper runs only while the voice switch is on. It listens on 127.0.0.1 at a port Windows picks (never 4747/4748)
// and takes only requests that carry this start's key and no Origin, so no web page can use it. It leaves by itself
// when the hub closes its stdin (the hub stopped, or voice went off). Audio is never written to disk: clips and speech
// pass through memory only.
import { spawn as nodeSpawn } from 'node:child_process';
import { request } from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { dataDir } from './relaunch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const VOICE_PROJECT = join(here, '..', 'voice');
export const voiceDir = (env = process.env) => env.CRUX_VOICE_DIR || join(dataDir(env), 'voice');
// What setup downloads, for the pop-up and the progress bar (measured 2026-11-14: models 838 MB, packages 143 MB).
export const DOWNLOAD_MB = 1000;
const MODELS_BYTES = 838 * 1024 * 1024;
export const LISTEN_RATE = 16000;
export const MAX_CLIP_S = 60;
export const CREDIT = 'Speech recognition: NVIDIA Parakeet TDT 0.6B v3 (CC BY 4.0), via onnx-asr (MIT). Voice: Phonon 31M by Gradium (Apache 2.0), voice Imogen.';
// Crashes allowed before it stays down with an amber mark: 3 in 5 minutes.
const CRASHES = 3, CRASH_WINDOW_MS = 5 * 60 * 1000;
// The only variables the helper gets from the hub's environment: what Windows and Python need, nothing secret.
const PASS_ENV = ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'COMSPEC', 'OS', 'LANG'];

const lastLine = s => String(s || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';

export class Voice {
  constructor({ dir = voiceDir(), project = VOICE_PROJECT, env = process.env, spawn = nodeSpawn, onChange = () => { }, uv = 'uv' } = {}) {
    this.dir = dir; this.project = project; this.env = env; this.spawn = spawn; this.onChange = onChange; this.uv = uv;
    this.state = 'off';        // off | starting | ready | problem
    this.problem = '';
    this.child = null; this.port = null; this.key = null;
    this.wanted = false;       // the switch is on
    this.crashes = [];
    this.setupRun = null;      // { step, pct, error } while setup runs, and its error after
  }

  get python() { return join(this.dir, 'venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python'); }
  get helper() { return join(this.project, 'helper.py'); }
  get models() { return join(this.dir, 'models'); }
  // The lockfile's fingerprint, the same whichever line endings git checked it out with.
  lockId() {
    try { return createHash('sha256').update(readFileSync(join(this.project, 'uv.lock'), 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 16); } catch { return ''; }
  }
  // 'ready' (set up with this lockfile), 'stale' (set up with an older one: setup again), or 'none'.
  installed() {
    let r = null;
    try { r = JSON.parse(readFileSync(join(this.dir, 'ready.json'), 'utf8')); } catch { }
    if (!r || !existsSync(this.python)) return 'none';
    return r.lock === this.lockId() ? 'ready' : 'stale';
  }

  view() {
    return {
      on: this.wanted, state: this.state, problem: this.problem, installed: this.installed(),
      setup: this.setupRun ? { ...this.setupRun } : null, downloadMB: DOWNLOAD_MB, credit: CREDIT
    };
  }
  changed() { try { this.onChange(this.view()); } catch { } }
  helperEnv(extra) {
    const env = {};
    for (const k of PASS_ENV) if (this.env[k] != null) env[k] = this.env[k];
    return { ...env, HF_HOME: this.models, HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_SYMLINKS_WARNING: '1', PYTHONUTF8: '1', ...extra };
  }

  // ---------- the switch ----------
  apply(on) { if (on) this.start(); else this.stop(); return this.view(); }

  start() {
    this.wanted = true;
    if (this.child) return;
    if (this.installed() !== 'ready') { this.state = 'problem'; this.problem = 'Voice is not set up on the PC yet.'; return this.changed(); }
    this.key = randomBytes(24).toString('hex');
    this.port = null; this.state = 'starting'; this.problem = '';
    const child = this.child = this.spawn(this.python, ['-I', this.helper], {
      env: this.helperEnv({ HF_HUB_OFFLINE: '1', CRUX_VOICE_KEY: this.key }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    let out = '', err = '';
    child.stdout.on('data', d => {
      out += d;
      let i;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i); out = out.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (child !== this.child) return;
        if (m.ready && m.port) { this.port = m.port; this.state = 'ready'; this.loadMs = m.loadMs; this.changed(); }
        else if (m.error) { this.problem = m.error; }
      }
    });
    child.stderr.on('data', d => { err = (err + d).slice(-4000); });
    child.stdin.on('error', () => { });
    child.on('error', e => { this.problem = `The voice helper could not start: ${e.message}`; });
    child.on('exit', code => {
      if (child !== this.child) return;
      this.child = null; this.port = null;
      if (!this.wanted) { this.state = 'off'; return this.changed(); }
      // Stopped while wanted: a crash. Back up after 2 s, up to 3 times in 5 minutes.
      const now = Date.now();
      this.crashes = [...this.crashes.filter(t => now - t < CRASH_WINDOW_MS), now];
      const why = this.problem || lastLine(err) || `it stopped (code ${code})`;
      if (this.crashes.length >= CRASHES) { this.state = 'problem'; this.problem = `The voice helper keeps stopping: ${why}`; return this.changed(); }
      this.state = 'starting'; this.problem = '';
      this.changed();
      this.restartTimer = setTimeout(() => { if (this.wanted && !this.child) this.start(); }, 2000);
      this.restartTimer.unref?.();
    });
    this.changed();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) { if (this.state !== 'off') { this.state = 'off'; this.problem = ''; this.changed(); } return; }
    this.state = 'off'; this.problem = '';
    try { child.stdin.end(); } catch { }
    // It leaves when its stdin closes; if it has not in 4 s, the hub stops its own child.
    const t = setTimeout(() => { try { child.kill(); } catch { } }, 4000);
    t.unref?.();
    child.once('exit', () => clearTimeout(t));
    this.changed();
  }

  // ---------- talking to the helper ----------
  ask(path, body, type) {
    if (this.state !== 'ready' || !this.port) return Promise.reject(new Error(this.wanted ? 'The voice is still starting: try again in a few seconds.' : 'Voice is off.'));
    return new Promise((ok, no) => {
      const req = request({ host: '127.0.0.1', port: this.port, path, method: 'POST', headers: { 'content-type': type, 'content-length': body.length, 'x-voice-key': this.key }, timeout: 30000 }, res => {
        const parts = [];
        res.on('data', c => parts.push(c));
        res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      });
      req.on('timeout', () => req.destroy(new Error('The voice helper took too long.')));
      req.on('error', no);
      req.end(body);
    });
  }
  // A clip (16 kHz, 16-bit, mono PCM) to text: { text, seconds, ms }.
  async listen(pcm) {
    const r = await this.ask('/listen', pcm, 'application/octet-stream');
    const out = JSON.parse(r.body.toString('utf8') || '{}');
    if (r.status !== 200) throw new Error(out.error || 'The voice helper could not listen.');
    return out;
  }
  // One sentence to speech: a WAV in memory.
  async say(text) {
    const r = await this.ask('/say', Buffer.from(JSON.stringify({ text })), 'application/json');
    if (r.status !== 200) throw new Error(JSON.parse(r.body.toString('utf8') || '{}').error || 'The voice helper could not speak.');
    return { wav: r.body, seconds: Number(r.headers['x-voice-seconds']) || null, ms: Number(r.headers['x-voice-ms']) || null };
  }

  // ---------- setup: only when you press Set up, never unattended ----------
  // uv makes the environment from the lockfile (no cache left behind), then the helper downloads the models once.
  // Progress: { step: 'packages' | 'models', pct, error }.
  setup() {
    if (this.setupRun && !this.setupRun.error && !this.setupRun.done) return this.view();
    this.setupRun = { step: 'packages', pct: 0 };
    this.changed();
    this.runSetup().then(() => {
      this.setupRun = { step: 'done', pct: 100, done: true };
      this.changed();
      if (this.wanted && !this.child) this.start();
    }, e => {
      this.setupRun = { ...(this.setupRun || {}), error: e.message };
      this.changed();
    });
    return this.view();
  }
  async runSetup() {
    mkdirSync(this.dir, { recursive: true });
    await this.run(this.uv, ['sync', '--frozen', '--no-cache', '--python', '3.12', '--project', this.project], { ...this.env, UV_PROJECT_ENVIRONMENT: join(this.dir, 'venv') }, 'Installing the voice packages',
      e => e.code === 'ENOENT' ? 'Voice setup needs uv (Astral\'s Python installer) on this PC. Install it from https://docs.astral.sh/uv/ and press Set up again.' : null);
    this.setupRun = { step: 'models', pct: 0 };
    this.changed();
    const tick = setInterval(() => {
      const pct = Math.min(99, Math.round(100 * folderBytes(this.models) / MODELS_BYTES));
      if (this.setupRun && pct !== this.setupRun.pct) { this.setupRun = { ...this.setupRun, pct }; this.changed(); }
    }, 1000);
    try { await this.run(this.python, ['-I', this.helper, '--setup'], this.helperEnv({}), 'Downloading the speech models'); } finally { clearInterval(tick); }
    writeFileSync(join(this.dir, 'ready.json'), JSON.stringify({ lock: this.lockId(), at: new Date().toISOString() }, null, 1));
  }
  run(cmd, args, env, what, explain = () => null) {
    return new Promise((ok, no) => {
      let err = '', out = '';
      const child = this.spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child.stdout.on('data', d => { out = (out + d).slice(-4000); });
      child.stderr.on('data', d => { err = (err + d).slice(-4000); });
      child.on('error', e => no(new Error(explain(e) || `${what} failed: ${e.message}`)));
      child.on('exit', code => {
        if (code === 0) return ok();
        let said = ''; try { said = JSON.parse(lastLine(out)).error || ''; } catch { }
        no(new Error(`${what} failed: ${said || lastLine(err.replace(/.*\d+%\|.*$/gm, '')) || `code ${code}`}`));
      });
    });
  }
}

function folderBytes(dir) {
  let n = 0;
  let list = [];
  try { list = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of list) {
    const p = join(dir, e.name);
    try { n += e.isDirectory() ? folderBytes(p) : statSync(p).size; } catch { }
  }
  return n;
}

// The page's clip, base64 of 16 kHz 16-bit mono PCM, checked and decoded. At most 60 s.
export function decodeClip(audio) {
  const s = String(audio || '');
  if (!s || !/^[A-Za-z0-9+/]+=*$/.test(s)) throw new Error('No sound came through. Tap the mic and try again.');
  const buf = Buffer.from(s, 'base64');
  if (buf.length > MAX_CLIP_S * LISTEN_RATE * 2) throw new Error(`Clips can be up to ${MAX_CLIP_S} seconds.`);
  if (buf.length % 2) throw new Error('The clip came through damaged. Try again.');
  return buf;
}
