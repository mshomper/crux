// Voice round trip (decision 61 A): Imogen (Phonon) speaks test commands, the speech goes through the same steps as a
// clip from the page (16 kHz 16-bit), Parakeet hears it, and the hub's name snapping runs on the result. Reports word
// errors and how many names came out right, before and after snapping, plus timings. Synthetic speech, so it says
// nothing about a real voice in a real room; it checks the whole chain works and gives a first read on names.
//
//   node voice/roundtrip.mjs [sentences.json]
// The voice folder is CRUX_VOICE_DIR (else %USERPROFILE%\.crux-hub\voice). If it is not set up, this runs setup first
// (a download), so point it at a throwaway folder unless voice is already set up there.
// sentences.json: { "names": [...], "aliases": { "heard": "Name" }, "items": [{ "say": "...", "expect": "..." }] }
import { readFileSync } from 'node:fs';
import { Voice, voiceDir } from '../lib/voice.mjs';
import { snapNames } from '../lib/voice-names.mjs';
import { downsample } from '../public/voice.js';

// Neutral stand-in names with the same shapes as real ones: joined words, a digit for a letter, a hyphen, a number.
const DEFAULT = {
  names: ['crux', 'BrightLoad', 'BrightLign', 'Ebb', 'Harborstone', 'w1nd.lab', 'w1nd.synth', 'bone-lab', 'research', 'orchestrator-6', 'voice-build', 'Conductor'],
  aliases: {},
  items: [
    { say: 'Ask the BrightLoad orchestrator to start the implant review.', expect: 'Ask the BrightLoad orchestrator to start the implant review.' },
    { say: 'What is the Harborstone orchestrator working on right now?', expect: 'What is the Harborstone orchestrator working on right now?' },
    { say: 'Tell the wind lab orchestrator to rerun the pressure test.', expect: 'Tell the w1nd.lab orchestrator to rerun the pressure test.' },
    { say: 'Has voice build finished step one?', expect: 'Has voice-build finished step one?' },
    { say: 'Pick option A on decision sixty one.', expect: 'Pick option A on decision 61.' },
    { say: 'Show me everything waiting in Ebb.', expect: 'Show me everything waiting in Ebb.' },
    { say: 'Send the bone lab orchestrator a note about the scans.', expect: 'Send the bone-lab orchestrator a note about the scans.' },
    { say: 'Merge pull request seventy two after I say yes.', expect: 'Merge pull request 72 after I say yes.' },
    { say: 'Remind me at four o\'clock to check BrightLign.', expect: 'Remind me at 4 o\'clock to check BrightLign.' },
    { say: 'What did orchestrator six say about the crux hub?', expect: 'What did orchestrator-6 say about the crux hub?' },
    { say: 'Pause the research worker until tomorrow morning.', expect: 'Pause the research worker until tomorrow morning.' },
    { say: 'Is the synth project still blocked on the shader bug?', expect: 'Is the synth project still blocked on the shader bug?' },
    { say: 'How much of my weekly plan have I used?', expect: 'How much of my weekly plan have I used?' },
    { say: 'Tell the Conductor to hold everything until I am back.', expect: 'Tell the Conductor to hold everything until I am back.' },
    { say: 'Approve the permission card for Harborstone, but only for this folder.', expect: 'Approve the permission card for Harborstone, but only for this folder.' },
    { say: 'Start a new worker on BrightLoad for the device codes.', expect: 'Start a new worker on BrightLoad for the device codes.' },
    { say: 'Read me the latest handoff from the crux orchestrator.', expect: 'Read me the latest handoff from the crux orchestrator.' },
    { say: 'Decline decision forty eight B and keep A.', expect: 'Decline decision 48 B and keep A.' },
    { say: 'What changed in wind synth since yesterday?', expect: 'What changed in w1nd.synth since yesterday?' },
    { say: 'Close all the cards I have already answered.', expect: 'Close all the cards I have already answered.' }
  ]
};

const NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
// Words for scoring: lower case, no punctuation at the ends, number words as digits (so "61" and "sixty one" match).
function words(s) {
  const w = String(s).toLowerCase().replace(/[“”"!?,;:]/g, ' ').split(/\s+/).map(x => x.replace(/^[.'-]+|[.'-]+$/g, '')).filter(Boolean);
  const out = [];
  for (let i = 0; i < w.length; i++) {
    if (w[i] in TENS) { const t = TENS[w[i]], u = NUM[w[i + 1]]; if (u > 0 && u < 10) { out.push(String(t + u)); i++; } else out.push(String(t)); }
    else if (w[i] in NUM) out.push(String(NUM[w[i]]));
    else out.push(w[i]);
  }
  return out;
}
function editDistance(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const cur = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  }
  return d[b.length];
}
// A WAV (16-bit mono) from the helper, as float samples and its rate.
function readWav(buf) {
  const rate = buf.readUInt32LE(24);
  let at = 12;
  while (at < buf.length - 8 && buf.toString('ascii', at, at + 4) !== 'data') at += 8 + buf.readUInt32LE(at + 4);
  const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + at + 8, buf.byteOffset + at + 8 + buf.readUInt32LE(at + 4)));
  return { rate, samples: Float32Array.from(pcm, s => s / 32768) };
}
const wait = (fn, ms = 600000) => new Promise((ok, no) => { const t0 = Date.now(); const iv = setInterval(() => { const r = fn(); if (r) { clearInterval(iv); ok(r); } else if (Date.now() - t0 > ms) { clearInterval(iv); no(new Error('timed out')); } }, 100); });

const set = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : DEFAULT;
const voice = new Voice({ dir: voiceDir() });
console.log(`Voice folder: ${voice.dir}`);
if (voice.installed() !== 'ready') {
  console.log('Not set up there: running setup (packages from the lockfile, then the models)…');
  const t = Date.now();
  voice.setup();
  await wait(() => voice.setupRun?.done || voice.setupRun?.error);
  if (voice.setupRun.error) { console.error(`Setup failed: ${voice.setupRun.error}`); process.exit(1); }
  console.log(`Setup done in ${Math.round((Date.now() - t) / 1000)} s.`);
}
const t0 = Date.now();
voice.apply(true);
await wait(() => voice.state === 'ready' || voice.state === 'problem', 180000);
if (voice.state !== 'ready') { console.error(`The helper did not start: ${voice.problem}`); process.exit(1); }
console.log(`Helper ready in ${((Date.now() - t0) / 1000).toFixed(1)} s (models loaded in ${(voice.loadMs / 1000).toFixed(1)} s) on port ${voice.port}.\n`);

let errRaw = 0, errSnap = 0, total = 0, namesWanted = 0, namesRaw = 0, namesSnap = 0, wrongSnaps = 0;
const sayMs = [], listenMs = [], speech = [];
const rows = [];
for (const { say, expect } of set.items) {
  const spoken = await voice.say(say);
  const { rate, samples } = readWav(spoken.wav);
  const pcm = downsample([samples], rate);                       // the page's own step: to 16 kHz 16-bit
  const heard = await voice.listen(Buffer.from(pcm.buffer));
  const snapped = snapNames(heard.text, set.names, set.aliases).text;
  const want = words(expect);
  const eRaw = editDistance(words(heard.text), want), eSnap = editDistance(words(snapped), want);
  errRaw += eRaw; errSnap += eSnap; total += want.length;
  const names = set.names.filter(n => expect.toLowerCase().includes(n.toLowerCase()) && new RegExp(`(^|[^\\w.-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`, 'i').test(expect));
  const has = (t, n) => new RegExp(`(^|[^\\w.-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`).test(t);
  namesWanted += names.length;
  namesRaw += names.filter(n => has(heard.text, n)).length;
  namesSnap += names.filter(n => has(snapped, n)).length;
  wrongSnaps += set.names.filter(n => !names.includes(n) && has(snapped, n) && !has(heard.text, n)).length;
  sayMs.push(spoken.ms); listenMs.push(heard.ms); speech.push(spoken.seconds);
  rows.push({ expect, heard: heard.text, snapped, eSnap });
}
voice.apply(false);

for (const r of rows) {
  console.log(`${r.eSnap ? 'x' : 'ok'}  wanted:  ${r.expect}\n    heard:   ${r.heard}${r.snapped !== r.heard ? `\n    snapped: ${r.snapped}` : ''}`);
}
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const pct = (a, b) => `${(100 * a / b).toFixed(1)}%`;
console.log(`\n${set.items.length} commands, ${total} words.`);
console.log(`Word errors: ${errRaw} as heard (${pct(errRaw, total)}), ${errSnap} after snapping (${pct(errSnap, total)}).`);
console.log(`Names right: ${namesRaw} of ${namesWanted} as heard, ${namesSnap} of ${namesWanted} after snapping; wrong snaps: ${wrongSnaps}.`);
console.log(`Speaking: ${Math.round(mean(sayMs))} ms on average per sentence for ${mean(speech).toFixed(1)} s of speech (${(mean(sayMs) / 1000 / mean(speech)).toFixed(2)}x real time).`);
console.log(`Listening: ${Math.round(mean(listenMs))} ms on average per clip (max ${Math.max(...listenMs)} ms).`);
