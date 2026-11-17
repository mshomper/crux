// One live draft from an outside model, for you to run by hand (decision 80). It uses the key already saved by
// offload-live-check.mjs (else asks at a hidden prompt), sends fake neutral source text with the hub's own draft wording, and
// prints ONE line (provider, model, tokens, dollars, milliseconds, ok or the error kind) and then the first 300 characters
// of the draft.
//
//   node tools/offload-draft-live-check.mjs
//   node tools/offload-draft-live-check.mjs --provider google --model gemini-3.5-flash-lite
//
// Run it from the hub folder in PowerShell. Nothing is saved except the key (once, if it was not saved already).
import { ProviderClient, ProviderError, PRESETS } from '../lib/providers.mjs';
import { DRAFT_SYSTEM, DRAFT_TIMEOUT_MS } from '../lib/offload.mjs';
import { getKey, arg, money } from './live-key.mjs';

const provider = arg('provider', 'google');
const model = arg('model', provider === 'openai' ? 'gpt-5-nano' : 'gemini-3.5-flash-lite');
if (!PRESETS[provider] || !PRESETS[provider].needsKey) { console.log(`${provider}  ${model}  error: use google, openai or openrouter here`); process.exit(2); }
const apiKey = await getKey(provider, { noSave: process.argv.includes('--no-save') });
const SOURCE = [
  'Garden club notes, spring.',
  '- Seed order: tomatoes 40 plants, basil 60, beans 25 rows; delivery due the second week of April.',
  '- Volunteers: 12 signed up for the Saturday planting; 3 still needed for watering rota.',
  '- Budget: 480 spent of 650; compost delivery still to pay.',
  '- Problem: the north bed floods after rain; options are raised boards or a drain.'
].join('\n');
try {
  const client = new ProviderClient({ provider, model, apiKey });
  const r = await client.chat({ system: DRAFT_SYSTEM, user: `Instructions:\nWrite a short update for club members with headings Done, Next and Open problem.\n\nSource text:\n${SOURCE}`, maxTokens: 700, timeoutMs: DRAFT_TIMEOUT_MS });
  console.log(`${r.provider}  ${r.model}  tokens ${r.tokens.input}+${r.tokens.output}  ${money(r)}  ${r.ms} ms  ok`);
  console.log(r.text.slice(0, 300));
} catch (e) {
  const kind = e instanceof ProviderError ? e.kind : 'network';
  console.log(`${provider}  ${model}  error: ${kind}${e?.status ? ` (${e.status})` : ''}${e?.retryAfterSec != null ? ` retry after ${e.retryAfterSec} s` : ''}`);
  process.exitCode = 1;
}
