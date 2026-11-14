// npm run voice-setup: the same setup as the Set up button on the hub page (decision 61 A), from a terminal. It asks
// first, with the size, and does nothing unless you answer y.
import { createInterface } from 'node:readline/promises';
import { Voice, voiceDir, DOWNLOAD_MB, CREDIT } from '../lib/voice.mjs';

const voice = new Voice({ dir: voiceDir() });
if (voice.installed() === 'ready') { console.log(`Voice is already set up in ${voice.dir}.`); process.exit(0); }
console.log(`Voice setup downloads about ${(DOWNLOAD_MB / 1000).toFixed(1)} GB once (speech recognition and Imogen's voice) into\n  ${voice.dir}\nIt runs on this PC only. Removing it later is deleting that folder.\n${CREDIT}\n`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const yes = /^y(es)?$/i.test((await rl.question('Set up voice now? (y/N) ')).trim());
rl.close();
if (!yes) { console.log('Nothing was set up.'); process.exit(0); }
let last = '';
voice.onChange = v => {
  const s = v.setup;
  const line = !s ? '' : s.error ? `Failed: ${s.error}` : s.done ? 'Done. Turn voice on with the speaker icon in All projects.' : s.step === 'packages' ? 'Installing the packages…' : `Downloading the speech models: ${s.pct || 0}%`;
  if (line && line !== last) { console.log(line); last = line; }
  if (s?.done) process.exit(0);
  if (s?.error) process.exit(1);
};
voice.setup();
