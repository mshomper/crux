// One live call to an outside model, for you to run by hand (expedition 20261117). It asks for the key at a hidden prompt
// (never an argument, never printed), saves it through the hub's protected key file, makes ONE short call and prints ONE line:
//   provider, model, tokens, dollars, milliseconds, ok or the error kind.
//
//   node tools/offload-live-check.mjs --provider google --model gemini-3.5-flash-lite
//   node tools/offload-live-check.mjs --provider openai --model gpt-5-nano
//   node tools/offload-live-check.mjs --provider ollama --model gemma3:4b      (no key; the model must be pulled already)
//
// Keys are saved in the hub's data folder (CRUX_HUB_DATA, else ~/.crux-hub) in provider-keys.json, protected for this
// Windows user. Run it from the hub folder. Add --no-save to use the key for this one call without saving it.
import { ProviderKeys } from '../lib/offload.mjs';
import { ProviderClient, ProviderError, PRESETS } from '../lib/providers.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const provider = arg('provider', 'google');
const model = arg('model', provider === 'openai' ? 'gpt-5-nano' : provider === 'ollama' ? 'gemma3:4b' : 'gemini-3.5-flash-lite');
const noSave = process.argv.includes('--no-save');

// Reads a line without echoing it. Falls back to a plain line when stdin is not a terminal (a pipe).
function hidden(promptText) {
  return new Promise(resolve => {
    const { stdin, stdout } = process;
    // Not a real terminal (Git Bash, a pipe): the key would be echoed, so refuse.
    if (!stdin.isTTY) { console.log('This needs a real terminal so the key stays hidden. Run it from PowerShell or Windows Terminal, not Git Bash.'); process.exit(2); }
    stdout.write(promptText);
    let buf = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = ch => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); return resolve(buf); }
        if (c === '\u0003') { stdin.setRawMode(false); stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1); else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

if (!PRESETS[provider]) { console.log(`${provider}  ${model}  error: unknown provider (openai, google, openrouter, ollama)`); process.exit(2); }
const keys = new ProviderKeys();
let apiKey = null;
if (PRESETS[provider].needsKey) {
  apiKey = keys.get(provider);
  if (!apiKey) {
    apiKey = (await hidden(`Paste the ${provider} key (it is not shown): `)).trim();
    if (!noSave) { try { keys.save(provider, apiKey); } catch (e) { console.log(`${provider}  ${model}  error: key not saved (${e.message})`); process.exit(2); } }
  }
}
try {
  const client = new ProviderClient({ provider, model, apiKey });   // each preset keeps its own timeout (Ollama 120 s)
  const r = await client.chat({ system: 'Answer in one short sentence.', user: 'Say that the outside model call works.', maxTokens: 60 });
  console.log(`${r.provider}  ${r.model}  tokens ${r.tokens.input}+${r.tokens.output}  ${r.costUSD == null ? 'dollars unknown (model not in the price table)' : r.costUnit === 'credits' ? `${r.costUSD.toFixed(6)} credits (as reported)` : `$${r.costUSD.toFixed(6)}`}  ${r.ms} ms  ok`);
} catch (e) {
  const kind = e instanceof ProviderError ? e.kind : 'network';
  console.log(`${provider}  ${model}  error: ${kind}${e?.status ? ` (${e.status})` : ''}${e?.retryAfterSec != null ? ` retry after ${e.retryAfterSec} s` : ''}`);
  process.exitCode = 1;
}
