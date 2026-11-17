// One live picture from Google's image model, for you to run by hand (decision 80). It uses the Google key already saved by
// offload-live-check.mjs (else asks for it at a hidden prompt), makes ONE picture from a neutral prompt, saves it as a PNG in a
// new temp folder and prints ONE line: the file's path, the model, tokens, dollars, milliseconds, ok or the error kind.
//
//   node tools/offload-image-live-check.mjs
//   node tools/offload-image-live-check.mjs --model gemini-3.1-flash-image --ratio 16:9
//
// Run it from the hub folder in PowerShell. It costs a few cents, and Google's image models need billing turned on for the
// key's project (their free tier lists them as "Not available"); a refused answer (403 or 429) usually means that.
// Delete the temp folder it names when you have looked at the picture.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderClient, ProviderError, ASPECT_RATIOS } from '../lib/providers.mjs';
import { getKey, arg, money } from './live-key.mjs';

const model = arg('model', null);
const ratio = arg('ratio', '1:1');
if (!ASPECT_RATIOS.includes(ratio)) { console.log(`error: ratio must be one of ${ASPECT_RATIOS.join(', ')}`); process.exit(2); }
const apiKey = await getKey('google', { noSave: process.argv.includes('--no-save'), label: 'Google AI Studio' });
try {
  const client = new ProviderClient({ provider: 'google', model: 'unused', apiKey, ...(model ? { imageModel: model } : {}) });
  const r = await client.image({ prompt: 'A simple flat illustration of a small wooden sailboat on calm blue water, pale sky, no text.', aspectRatio: ratio });
  const dir = mkdtempSync(join(tmpdir(), 'crux-image-check-'));
  const file = join(dir, r.mime === 'image/jpeg' ? 'check.jpg' : r.mime === 'image/webp' ? 'check.webp' : 'check.png');
  writeFileSync(file, Buffer.from(r.b64, 'base64'));
  console.log(`${file}\n${r.provider}  ${r.model}  ${ratio}  tokens ${r.tokens.input}+${r.tokens.output}  ${money(r)}  ${r.ms} ms  ok`);
} catch (e) {
  const kind = e instanceof ProviderError ? e.kind : 'network';
  console.log(`google  ${model || 'image model'}  error: ${kind}${e?.status ? ` (${e.status})` : ''}${e?.retryAfterSec != null ? ` retry after ${e.retryAfterSec} s` : ''}${[403, 429].includes(e?.status) ? '  (images need billing turned on for the key)' : ''}`);
  process.exitCode = 1;
}
