// Shared by the outside-model live checks (offload-image-live-check.mjs, offload-draft-live-check.mjs): the saved key for a
// provider from the hub's protected key file, or a hidden prompt for it (never an argument, never printed).
import { ProviderKeys } from '../lib/offload.mjs';

// Reads a line without echoing it. Refuses when stdin is not a real terminal, since the key would show.
function hidden(promptText) {
  return new Promise(resolve => {
    const { stdin, stdout } = process;
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

// The key for `provider`: saved one first; else asked for, and saved unless noSave.
export async function getKey(provider, { noSave = false, label = provider } = {}) {
  const keys = new ProviderKeys();
  let apiKey = keys.get(provider);
  if (!apiKey) {
    apiKey = (await hidden(`Paste the ${label} key (it is not shown): `)).trim();
    if (!noSave) { try { keys.save(provider, apiKey); } catch (e) { console.log(`error: key not saved (${e.message})`); process.exit(2); } }
  }
  return apiKey;
}

export const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
export const money = r => (r.costUSD == null ? 'dollars unknown' : `$${r.costUSD.toFixed(4)}${r.estimated ? ' (estimate)' : ''}`);
