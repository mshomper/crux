// Voice on the iPhone (Matt's first use, hub 0.21.0): Imogen was much too quiet. The mic now records through a sound
// context made for each recording and closed when it ends; Imogen plays through her own one that never had the mic in
// it; the iPhone is told 'play-and-record' while listening and 'playback' while she speaks (navigator.audioSession);
// and the helper brings Phonon's speech up to phone loudness with a soft limiter.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VoiceRecorder, VoicePlayer, audioMode } from '../public/voice.js';

const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');
const tick = () => new Promise(r => setImmediate(r));

// A page with only what voice uses: sound contexts, a mic, an audio session.
const made = [], modes = [], tracks = [];
class FakeCtx {
  constructor() { this.state = 'suspended'; this.sampleRate = 48000; this.destination = {}; this.closed = false; made.push(this); this.audioWorklet = { addModule: async () => { } }; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; this.closed = true; }
  createMediaStreamSource() { return { connect() { }, disconnect() { } }; }
  createGain() { return { gain: {}, connect() { }, disconnect() { } }; }
}
const session = { _t: 'auto', get type() { return this._t; }, set type(v) { this._t = v; modes.push(v); } };
const saved = { AudioContext: globalThis.AudioContext, AudioWorkletNode: globalThis.AudioWorkletNode, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
globalThis.AudioContext = FakeCtx;
globalThis.AudioWorkletNode = class { constructor() { this.port = {}; } connect() { } disconnect() { } };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { audioSession: session, mediaDevices: { getUserMedia: async () => { const t = { stopped: false, stop() { this.stopped = true; } }; tracks.push(t); return { getTracks: () => [t] }; } } } });
after(() => {
  globalThis.AudioContext = saved.AudioContext; globalThis.AudioWorkletNode = saved.AudioWorkletNode;
  if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator);
});

test('each recording has its own sound context, closed with the mic; Imogen keeps one that never had the mic', async () => {
  const posted = [];
  const rec = new VoiceRecorder({ post: async (p, b) => posted.push(p) });
  await rec.start();
  assert.equal(rec.state, 'recording');
  assert.equal(made.length, 2, 'one to play through, one to record through');
  const [play, cap1] = made;
  assert.equal(rec.playCtx, play);
  assert.equal(play.state, 'running', 'unlocked by the same tap, for her answer later');
  assert.deepEqual(modes, ['play-and-record']);
  rec.blocks = [new Float32Array(48000)];   // a second of sound
  await rec.stop();
  assert.equal(tracks[0].stopped, true, 'the mic is off');
  assert.equal(cap1.closed, true, 'its sound context is closed');
  assert.equal(play.closed, false, 'hers stays');
  assert.equal(rec.ctx, null);
  assert.deepEqual(modes, ['play-and-record', 'auto']);
  assert.deepEqual(posted, ['/api/voice/listen']);
  await rec.start();
  assert.equal(made.length, 3, 'the next recording gets a new one');
  assert.equal(rec.playCtx, play);
  rec.cancel();
  assert.equal(made[2].closed, true);
});

test('while she speaks the iPhone is in playback; after (or on a stop) back to auto', async () => {
  modes.length = 0;
  const ctx = new FakeCtx(); ctx.state = 'running';
  ctx.decodeAudioData = async b => ({ b });
  const sources = [];
  ctx.createBufferSource = () => { const s = { connect() { }, start() { }, stop() { } }; sources.push(s); return s; };
  const p = new VoicePlayer({ ctx: () => ctx, fetchSentence: async () => Buffer.from('x') });
  const done = p.play({ id: 'v', sentences: ['a'] });
  await tick(); await tick();
  assert.deepEqual(modes, ['playback']);
  sources[0].onended(); await done;
  assert.deepEqual(modes, ['playback', 'auto']);
  const again = p.play({ id: 'v', sentences: ['a'] });
  await tick(); await tick();
  p.stop(); await again;
  assert.equal(modes.at(-1), 'auto');
});

test('without navigator.audioSession (other browsers, older iOS) nothing breaks', () => {
  assert.doesNotThrow(() => audioMode('playback', {}));
  assert.doesNotThrow(() => audioMode('playback', undefined));
  const s = { type: 'auto' }; audioMode('playback', { audioSession: s });
  assert.equal(s.type, 'playback');
});

test('the helper brings Phonon up to phone loudness with a soft limiter, on every sentence', () => {
  const py = src('../voice/helper.py');
  assert.match(py, /TARGET_RMS_DB = -16\.0/);
  assert.match(py, /MAX_GAIN_DB = 9\.0/);
  assert.match(py, /CEILING = 0\.891/);
  assert.match(py, /return wav_bytes\(louder\(samples\), rate\)/);
  assert.match(py, /np\.tanh\(\(a\[over\] - knee\) \/ \(CEILING - knee\)\)/, 'peaks bend under -1 dBFS, never clip');
  assert.match(src('../public/app.js'), /ctx: \(\) => voiceRec\.playCtx/);
});
