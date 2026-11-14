// Voice (decision 61 A): the helper runs only while the switch is on, leaves when its stdin closes, comes back after a
// crash (3 times in 5 minutes at most), gets nothing secret from the hub's environment, and never writes audio to disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { Voice, decodeClip, MAX_CLIP_S, LISTEN_RATE } from '../lib/voice.mjs';
import { SETTING_DEFAULTS, HubSettings } from '../lib/settings.mjs';
import { downsample, toBase64, voiceLine, switchTip } from '../public/voice.js';

const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.stdin = { ended: false, on() { }, end() { this.ended = true; setImmediate(() => c.emit('exit', 0)); } };
  c.killed = false; c.kill = () => { c.killed = true; c.emit('exit', 1); };
  c.say = obj => c.stdout.emit('data', JSON.stringify(obj) + '\n');
  return c;
}
// A voice folder that looks set up (ready.json for the current lockfile, and a python.exe in its venv).
function setUpDir(t) {
  const dir = makeTmp('crux-voice-', t);
  const v = new Voice({ dir });
  mkdirSync(join(v.python, '..'), { recursive: true });
  writeFileSync(v.python, '');
  writeFileSync(join(dir, 'ready.json'), JSON.stringify({ lock: v.lockId() }));
  return dir;
}
function voiceWith(t, extra = {}) {
  const spawned = [];
  const v = new Voice({ dir: setUpDir(t), env: { PATH: 'x', SystemRoot: 'C:\\Windows', ANTHROPIC_API_KEY: 'sk-ant-secret', CRUX_HUB_GUARD: 'off' }, spawn: (cmd, args, opts) => { const c = fakeChild(); spawned.push({ cmd, args, opts, c }); return c; }, ...extra });
  return { v, spawned };
}

test('the voice switch is off by default, and kept like the other hub settings', t => {
  assert.equal(SETTING_DEFAULTS.voice, false);
  const s = new HubSettings({ file: null });
  assert.equal(s.get('voice'), false);
  s.set({ voice: true });
  assert.equal(s.get('voice'), true);
  s.set({ voice: 'yes' });   // only a true or false changes it
  assert.equal(s.get('voice'), true);
});

test('nothing runs until the switch is on; on starts one helper with a fresh key; off closes its stdin', async t => {
  const { v, spawned } = voiceWith(t);
  assert.equal(spawned.length, 0);
  assert.equal(v.view().state, 'off');
  v.apply(true);
  assert.equal(spawned.length, 1);
  const { cmd, args, opts, c } = spawned[0];
  assert.equal(cmd, v.python);
  assert.deepEqual(args, ['-I', v.helper]);
  assert.equal(opts.env.HF_HUB_OFFLINE, '1');
  assert.equal(opts.env.CRUX_VOICE_KEY.length, 48);
  assert.equal(opts.env.HF_HOME, v.models);
  assert.equal(opts.env.ANTHROPIC_API_KEY, undefined, 'no secrets from the hub');
  assert.equal(opts.env.CRUX_HUB_GUARD, undefined);
  assert.equal(v.view().state, 'starting');
  c.say({ ready: true, port: 51234, loadMs: 4000 });
  assert.equal(v.view().state, 'ready');
  assert.equal(v.port, 51234);
  v.apply(true);   // already on: no second helper
  assert.equal(spawned.length, 1);
  v.apply(false);
  assert.equal(c.stdin.ended, true);
  assert.equal(v.view().state, 'off');
  await new Promise(r => setImmediate(r));
  assert.equal(v.child, null);
  assert.equal(c.killed, false, 'it left by itself, no kill');
});

test('a crash brings it back after 2 s; three in five minutes leave it down with the reason', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { v, spawned } = voiceWith(t);
  v.apply(true);
  for (let i = 0; i < 2; i++) {
    spawned.at(-1).c.stderr.emit('data', 'onnxruntime: out of memory\n');
    spawned.at(-1).c.emit('exit', 1);
    assert.equal(v.view().state, 'starting');
    t.mock.timers.tick(2000);
    assert.equal(spawned.length, i + 2);
  }
  spawned.at(-1).c.stderr.emit('data', 'onnxruntime: out of memory\n');
  spawned.at(-1).c.emit('exit', 1);
  assert.equal(v.view().state, 'problem');
  assert.match(v.view().problem, /keeps stopping: onnxruntime: out of memory/);
  t.mock.timers.tick(10000);
  assert.equal(spawned.length, 3);
  v.apply(false);
});

test('not set up: switching on starts nothing and says so; a set-up folder from an older lockfile needs setup again', t => {
  const dir = makeTmp('crux-voice-', t);
  const spawned = [];
  const v = new Voice({ dir, spawn: () => { spawned.push(1); return fakeChild(); } });
  assert.equal(v.installed(), 'none');
  v.apply(true);
  assert.equal(spawned.length, 0);
  assert.equal(v.view().state, 'problem');
  assert.match(v.view().problem, /not set up/);
  const ok = setUpDir(t);
  writeFileSync(join(ok, 'ready.json'), JSON.stringify({ lock: 'older' }));
  assert.equal(new Voice({ dir: ok }).installed(), 'stale');
  // The fingerprint ignores line endings: a checkout with Windows line endings is the same lockfile.
  const lf = makeTmp('crux-voice-lock-', t), crlf = makeTmp('crux-voice-lock-', t);
  writeFileSync(join(lf, 'uv.lock'), 'version = 1\n[[package]]\nname = "x"\n');
  writeFileSync(join(crlf, 'uv.lock'), 'version = 1\r\n[[package]]\r\nname = "x"\r\n');
  assert.equal(new Voice({ dir: ok, project: lf }).lockId(), new Voice({ dir: ok, project: crlf }).lockId());
});

test('setup: uv makes the environment from the lockfile with no cache left, then the helper downloads the models', async t => {
  const dir = makeTmp('crux-voice-', t);
  const runs = [];
  const v = new Voice({
    dir, env: { PATH: 'x' }, spawn: (cmd, args, opts) => {
      runs.push({ cmd, args, opts });
      const c = fakeChild();
      setImmediate(() => {
        if (cmd === 'uv') { mkdirSync(join(v.python, '..'), { recursive: true }); writeFileSync(v.python, ''); }
        c.emit('exit', 0);
      });
      return c;
    }
  });
  const changes = [];
  v.onChange = s => changes.push(s.setup?.step);
  v.setup();
  await new Promise(r => { const iv = setInterval(() => { if (v.setupRun?.done || v.setupRun?.error) { clearInterval(iv); r(); } }, 5); });
  assert.equal(v.setupRun.error, undefined);
  assert.equal(runs[0].cmd, 'uv');
  assert.deepEqual(runs[0].args.slice(0, 3), ['sync', '--frozen', '--no-cache']);
  assert.equal(runs[0].opts.env.UV_PROJECT_ENVIRONMENT, join(dir, 'venv'));
  assert.deepEqual(runs[1].args, ['-I', v.helper, '--setup']);
  assert.equal(runs[1].opts.env.HF_HOME, join(dir, 'models'));
  assert.equal(v.installed(), 'ready');
  assert.deepEqual([...new Set(changes)], ['packages', 'models', 'done']);
});

test('setup without uv says what to install, and does not start anything', async t => {
  const dir = makeTmp('crux-voice-', t);
  const v = new Voice({ dir, spawn: () => { const c = fakeChild(); setImmediate(() => c.emit('error', Object.assign(new Error('spawn uv ENOENT'), { code: 'ENOENT' }))); return c; } });
  v.setup();
  await new Promise(r => { const iv = setInterval(() => { if (v.setupRun?.error) { clearInterval(iv); r(); } }, 5); });
  assert.match(v.setupRun.error, /needs uv/);
  assert.equal(v.installed(), 'none');
});

test('asking a helper that is off or still starting fails plainly', async t => {
  const { v } = voiceWith(t);
  await assert.rejects(v.listen(Buffer.alloc(16000)), /Voice is off/);
  v.apply(true);
  await assert.rejects(v.listen(Buffer.alloc(16000)), /still starting/);
  v.apply(false);
});

test('clips: base64 of 16-bit samples, at most 60 seconds', () => {
  assert.equal(decodeClip(Buffer.alloc(3200).toString('base64')).length, 3200);
  assert.throws(() => decodeClip(''), /No sound/);
  assert.throws(() => decodeClip('not base64!'), /No sound/);
  assert.throws(() => decodeClip(Buffer.alloc(MAX_CLIP_S * LISTEN_RATE * 2 + 2).toString('base64')), /up to 60 seconds/);
  assert.throws(() => decodeClip(Buffer.alloc(3).toString('base64')), /damaged/);
});

test('the page turns 48 kHz mic blocks into 16 kHz 16-bit samples, and into base64', () => {
  const block = new Float32Array(4800).fill(0.5);
  const out = downsample([block, block], 48000);
  assert.equal(out.length, 3200);
  assert.ok(out.every(s => s === Math.round(0.5 * 32767) || s === Math.floor(0.5 * 32767)));
  assert.equal(downsample([new Float32Array([2, -2, 2])], 16000).join(), '32767,-32768,32767');
  const b = new Uint8Array([1, 2, 3, 250]);
  assert.equal(toBase64(b), Buffer.from(b).toString('base64'));
});

test('the line above the box and the switch say what voice is doing', () => {
  assert.match(voiceLine({ rec: 'recording', secs: 7 }).text, /Listening 0:07/);
  assert.equal(voiceLine({ rec: 'recording' }).cancel, true);
  assert.match(voiceLine({ v: { setup: { step: 'models', pct: 42 } } }).text, /42%/);
  assert.equal(voiceLine({ v: { setup: { error: 'Voice setup needs uv' } } }).tone, 'warn');
  assert.equal(voiceLine({ v: { on: true, state: 'ready' } }).text, '');
  const credit = 'Speech recognition: NVIDIA Parakeet';
  assert.match(switchTip({ on: false, credit }), /Voice is off[\s\S]*Parakeet/);
  assert.match(switchTip({ on: true, state: 'problem', problem: 'boom', credit }), /problem: boom/);
});

test('audio is never written to disk: the helper writes no files, and the hub writes only ready.json', () => {
  const py = src('../voice/helper.py');
  assert.doesNotMatch(py, /(?<!wave\.|os\.)\bopen\((?!os\.devnull, "r"\))|\.save\(|NamedTemporaryFile|tofile|soundfile/);
  assert.deepEqual([...py.matchAll(/wave\.open\((\w+)/g)].map(m => m[1]), ['buf'], 'the WAV is written into memory (io.BytesIO) only');
  assert.match(py, /buf = io\.BytesIO\(\)/);
  const js = src('../lib/voice.mjs');
  assert.deepEqual([...js.matchAll(/writeFileSync\((.+?\)),/g)].map(m => m[1]), ["join(this.dir, 'ready.json')"]);
  assert.doesNotMatch(js, /createWriteStream|appendFileSync/);
});

test('the server: voice routes go through the usual checks, setup is PC only, and the spoken message is marked', () => {
  const s = src('../server.mjs');
  assert.match(s, /'POST \/api\/voice\/listen': async/);
  assert.match(s, /'POST \/api\/voice\/setup': \(_, \{ local \}\) => \{\s*if \(!local\) throw new GuardError/);
  assert.match(s, /\{ voice: true, \.\.\.\(snapped\.length \? \{ heard \} : \{\}\) \}/);
  assert.match(s, /'\/api\/voice\/listen': Math\.ceil\(MAX_CLIP_S \* LISTEN_RATE \* 2 \* 4 \/ 3\)/);
  assert.doesNotMatch(src('../lib/guard.mjs'), /voice/, 'no pairing exception: a remote device must be paired (decision 48)');
  assert.match(src('../lib/conductor.mjs'), /if \(extra\.voice\) \{\s*a\.noteForNextTurn\(VOICE_NOTE\);/);
});
