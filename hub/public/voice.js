// Voice (decision 61 A): tap the mic, talk, tap again. The clip goes to the hub as one upload (16 kHz, 16-bit mono,
// base64 in JSON, so the hub's usual same-origin and pairing checks apply), and your words come back as your message
// in the Conductor chat, with a mic mark (R011). The mic is open only between the two taps: it is closed before any
// voice plays (WebKit bug 326286). Nothing is recorded to a file; the clip lives in this page's memory until sent.

export const RATE = 16000;
export const MAX_S = 60;
// This open page, for the hub: only the page that spoke plays the answer back (another open page stays quiet).
export const VOICE_CLIENT = (globalThis.crypto?.randomUUID?.() || String(Math.random()).slice(2)).replace(/-/g, '').slice(0, 32);

// Float blocks at the mic's own rate to 16 kHz 16-bit samples: each output sample is the mean of the input samples
// it covers (a box filter, enough to keep speech clean when going down from 44.1 or 48 kHz).
export function downsample(blocks, inRate, outRate = RATE) {
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const b of blocks) { all.set(b, o); o += b.length; }
  const ratio = inRate / outRate;
  const n = Math.floor(total / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), z = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < z; j++) s += all[j];
    const v = Math.max(-1, Math.min(1, s / (z - a)));
    out[i] = v < 0 ? v * 32768 : v * 32767;
  }
  return out;
}

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// One recorder for the page. state: idle | opening | recording | sending. onChange(state, seconds) redraws the mic.
export class VoiceRecorder {
  constructor({ post, onChange = () => { }, onError = () => { } }) {
    Object.assign(this, { post, onChange, onError });
    this.state = 'idle';
    this.ctx = null; this.stream = null; this.node = null; this.blocks = []; this.t0 = 0; this.tick = 0;
  }
  get seconds() { return this.state === 'recording' ? Math.floor((performance.now() - this.t0) / 1000) : 0; }
  set(state) { this.state = state; this.onChange(state, this.seconds); }

  // The mic button: idle opens the mic; recording closes it and sends; a tap while it is still opening gives up.
  toggle() {
    if (this.state === 'idle') return this.start();
    if (this.state === 'recording') return this.stop();
    if (this.state === 'opening') { this.opening = (this.opening || 0) + 1; this.close(); this.set('idle'); }
  }

  async start() {
    this.set('opening');
    const attempt = this.opening = (this.opening || 0) + 1;
    const stale = () => attempt !== this.opening;   // tapped again (given up) while it was opening
    try {
      // The tap that opens the mic also unlocks sound on the iPhone, so a spoken reply can play later without one.
      // resume() is asked for here, inside the tap, before anything is awaited; a browser that never lets sound
      // start must not leave the mic stuck opening, so it is given 4 s.
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      this.ctx ||= new AC();
      const resumed = this.ctx.state === 'running' ? null : this.ctx.resume();
      if (!this.ctx.audioWorklet) throw new Error('This browser cannot record for voice.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (stale()) { for (const t of stream.getTracks()) t.stop(); return; }
      this.stream = stream;
      if (resumed) await Promise.race([resumed, new Promise((_, no) => setTimeout(() => no(new Error('Sound could not start in this browser. Tap the mic again.')), 4000))]);
      if (!this.workletReady) { await this.ctx.audioWorklet.addModule('/voice-worklet.js'); this.workletReady = true; }
      if (stale()) return this.close();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, 'crux-capture');
      this.blocks = [];
      this.node.port.onmessage = e => this.blocks.push(e.data);
      const mute = this.ctx.createGain(); mute.gain.value = 0;   // pulled by the output so it runs, and silent
      src.connect(this.node); this.node.connect(mute); mute.connect(this.ctx.destination);
      this.parts = [src, this.node, mute];
      this.t0 = performance.now();
      this.set('recording');
      this.tick = setInterval(() => {
        if (this.seconds >= MAX_S) this.stop();
        else this.onChange(this.state, this.seconds);
      }, 250);
    } catch (e) {
      if (stale()) return;
      this.close();
      this.set('idle');
      this.onError(e?.name === 'NotAllowedError' ? 'The mic is blocked for this page. Allow it (on the iPhone: tap Allow when asked, or aA, Website Settings, Microphone) and tap the mic again.' : (e?.message || 'The mic did not open.'));
    }
  }

  // Close the mic at once, then send what was said.
  async stop() {
    if (this.state !== 'recording') return;
    const rate = this.ctx.sampleRate, blocks = this.blocks;
    this.close();
    const pcm = downsample(blocks, rate);
    if (pcm.length < RATE / 4) { this.set('idle'); return this.onError('That was too short to hear. Tap the mic, talk, then tap again.'); }
    this.set('sending');
    try { await this.post('/api/voice/listen', { audio: toBase64(new Uint8Array(pcm.buffer)), client: VOICE_CLIENT }); }
    catch (e) { this.onError(e?.message || 'Sending the clip failed.'); }
    finally { this.set('idle'); }
  }

  // Drop what was said without sending it (the cancel mark while recording).
  cancel() { if (this.state !== 'recording') return; this.close(); this.set('idle'); }

  close() {
    clearInterval(this.tick);
    for (const t of this.stream?.getTracks() || []) t.stop();   // the mic's light goes out here
    for (const p of this.parts || []) { try { p.disconnect(); } catch { } }
    if (this.node) this.node.port.onmessage = null;
    this.stream = null; this.node = null; this.parts = null; this.blocks = [];
  }
}

// The answer read aloud (step 2): one voice_say event's sentences, fetched one by one from the hub (each a WAV made in
// memory) and played back to back through the AudioContext the mic tap unlocked. The next sentence is fetched while
// one plays. stop() ends it at once and drops the rest; nothing is kept.
export class VoicePlayer {
  constructor({ ctx, fetchSentence, onChange = () => { }, onError = () => { } }) {
    Object.assign(this, { ctx, fetchSentence, onChange, onError });
    this.playing = null;   // { id, source, stopped }
  }
  get speaking() { return !!this.playing; }
  async play(ev) {
    this.stop();
    const ctx = this.ctx();
    if (!ctx || !ev?.sentences?.length) return;
    const run = this.playing = { id: ev.id, source: null, stopped: false };
    this.onChange(true);
    try {
      if (ctx.state !== 'running') await ctx.resume();
      let next = this.fetchSentence(ev.id, 0);
      for (let n = 0; n < ev.sentences.length; n++) {
        const bytes = await next;
        if (run.stopped) return;
        next = n + 1 < ev.sentences.length ? this.fetchSentence(ev.id, n + 1) : null;
        next?.catch(() => { });
        const buf = await ctx.decodeAudioData(bytes);
        if (run.stopped) return;
        await new Promise(done => {
          const src = run.source = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          src.onended = done;
          run.done = done;
          src.start();
        });
      }
    } catch (e) {
      if (!run.stopped) this.onError(e?.message || 'The voice could not play.');
    } finally {
      if (this.playing === run) { this.playing = null; this.onChange(false); }
    }
  }
  stop() {
    const run = this.playing;
    if (!run) return false;
    run.stopped = true;
    try { run.source?.stop(); } catch { }
    run.done?.();
    this.playing = null;
    this.onChange(false);
    return true;
  }
}

export const clock = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
// The line above the message box while voice is busy: { text, cancel (show the cancel mark), tone }. Empty text: none.
export function voiceLine({ rec = 'idle', secs = 0, v = null, speaking = false } = {}) {
  if (speaking) return { text: 'Imogen is speaking · tap anywhere to stop', tone: 'speak' };
  if (rec === 'opening') return { text: 'Opening the mic… (tap it again to give up)' };
  if (rec === 'recording') return { text: `Listening ${clock(secs)} · tap the mic again to send`, cancel: true, tone: 'rec' };
  if (rec === 'sending') return { text: 'Hearing what you said…' };
  const s = v?.setup;
  if (s && !s.error && !s.done) return { text: s.step === 'packages' ? 'Setting up voice: installing the packages…' : `Setting up voice: downloading the speech models, ${s.pct || 0}%` };
  if (s?.error) return { text: s.error, tone: 'warn' };
  if (v?.on && v.state === 'starting') return { text: 'Voice is starting…' };
  return { text: '' };
}

export function switchTip(v) {
  if (!v) return 'Voice';
  const credit = v.credit ? `\n${v.credit}` : '';
  if (v.setup && !v.setup.error && !v.setup.done) return `Voice is being set up on the PC.${credit}`;
  if (!v.on) return `Voice is off. Turn it on to talk to the Conductor with the mic.${credit}`;
  if (v.state === 'problem') return `Voice has a problem: ${v.problem}${credit}`;
  if (v.state === 'starting') return `Voice is starting (a few seconds). Tap to turn it off.${credit}`;
  return `Voice is on: tap the mic, talk, tap again. Tap here to turn it off.${credit}`;
}
