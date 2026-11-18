// Which addresses the hub may use for Ollama (decision 82 A): this PC's own loopback, or one of the owner's machines on the
// private Tailscale network (a 100.64.0.0/10 address, or a name ending .ts.net), over http or https, with a port. Nothing
// else. One plain function, no DOM and no imports, so the hub (lib/providers.mjs, lib/settings.mjs) and the Whole hub panel
// (outside-panel.js) apply exactly the same rule: the panel to say so while you type, the hub at save and again at every call.
//
//   ollamaAddress(text)  ->  { ok: true, kind: 'loopback' | 'tailscale', host, port, origin, base }
//                        or  { ok: false, empty, why }
// base is the address the hub calls: the origin plus /v1/ (Ollama's OpenAI-compatible path). A bare "host:port" counts as http.
// The URL parser turns odd spellings of an IPv4 address (hex, octal, a single number) into dotted decimal before the checks run.

export const ADDRESS_HELP = 'Leave empty for Ollama on this PC. Or one of your own machines on Tailscale: an address like http://100.101.102.103:11434, or a name like https://my-pc.your-tailnet.ts.net:11434. It needs a port; nothing else is accepted.';

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
const NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/;

const refuse = why => ({ ok: false, empty: false, why });

export function ollamaAddress(input) {
  let s = String(input ?? '').trim();
  if (!s) return { ok: false, empty: true, why: 'No address.' };
  if (s.length > 200) return refuse('That address is too long.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let u;
  try { u = new URL(s); } catch { return refuse('That is not an address the hub can read.'); }
  if (!['http:', 'https:'].includes(u.protocol)) return refuse('Use http or https.');
  if (u.username || u.password || u.search || u.hash) return refuse('The address must be only the machine and its port.');
  if (!['', '/', '/v1', '/v1/'].includes(u.pathname)) return refuse('The address must be only the machine and its port.');
  const host = u.hostname.toLowerCase();
  let kind = null;
  if (LOOPBACK.includes(host)) kind = 'loopback';
  else if (isTailscaleIp(host) || (host.length <= 253 && NAME.test(host))) kind = 'tailscale';
  if (!kind) return refuse('Only this PC or one of your Tailscale machines (a 100.64.x.x to 100.127.x.x address, or a name ending .ts.net).');
  if (kind === 'tailscale' && !u.port) return refuse('A Tailscale address needs its port, for example :11434.');
  const origin = `${u.protocol}//${u.host}`;
  return { ok: true, kind, host: host.replace(/^\[|\]$/g, ''), port: u.port || null, origin, base: `${origin}/v1/` };
}

// 100.64.0.0/10: 100.64.0.0 to 100.127.255.255. Strict dotted decimal (the URL parser has already normalised other spellings).
export function isTailscaleIp(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  return a === 100 && b >= 64 && b <= 127 && c <= 255 && d <= 255;
}

// The address as the panel's box shows it: the origin, without the /v1/ the hub adds.
export const showAddress = base => { const a = ollamaAddress(base); return a.ok ? a.origin : String(base || ''); };
