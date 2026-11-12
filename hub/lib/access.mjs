// Who may talk to the hub (decision 18 A). The server only listens on 127.0.0.1; the phone reaches it through
// `tailscale serve`, which proxies https://<machine>.<tailnet>.ts.net to that loopback port. So every request
// arrives from loopback, and what tells them apart is the Host and Origin headers:
// - Host must be this machine (localhost, 127.0.0.1, ::1) or a Tailscale name (*.ts.net). Anything else is a web
//   page using DNS rebinding to reach the loopback port, and is refused.
// - Requests that change something (POST and friends) must come from one of those same addresses (Origin), and
//   carry JSON. A page on some other site cannot send JSON cross-site without a CORS preflight, which we never answer.
// Extra names (say a Tailscale machine name without the ts.net suffix) can be added with CRUX_HUB_HOSTS=a,b.

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// A port written any way but plainly (localhost:04747, :0, :99999, :abc) is no browser's; such a Host is refused ('').
export function hostName(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return '';
  const port = h.startsWith('[') ? h.slice(h.indexOf(']') + 1) : (/:[^:]*$/.exec(h)?.[0] ?? '');
  if (port && !(/^:[1-9]\d{0,4}$/.test(port) && Number(port.slice(1)) <= 65535)) return '';
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1); // [::1]:4747
  return h.slice(0, h.length - port.length).replace(/\.$/, '');
}

export function allowedHost(name, extra = []) {
  if (!name) return false;
  if (LOCAL.has(name)) return true;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(name)) return true;
  return extra.includes(name);
}

export function isLocalHost(name) { return LOCAL.has(name); }

export function extraHosts(env = process.env) {
  return String(env.CRUX_HUB_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

// Returns null when the request may go on, or a short reason when it must be refused (403).
// openPaths: GET endpoints any page may read (the hub's "are you running?" ping).
export function checkRequest({ method = 'GET', path = '/', headers = {} }, { extra = [], openPaths = ['/api/ping'] } = {}) {
  const host = hostName(headers.host);
  if (!allowedHost(host, extra)) return `Host ${host || '(none)'} is not this hub`;
  if (SAFE.has(method)) return null;
  if (openPaths.includes(path) && method === 'GET') return null;
  const origin = headers.origin;
  if (origin !== undefined) {
    let o;
    try { o = new URL(origin); } catch { return 'Bad origin'; }
    if (!/^https?:$/.test(o.protocol) || !allowedHost(hostName(o.host), extra)) return `Origin ${origin} may not change the hub`;
  } else if (headers['sec-fetch-site'] && !['same-origin', 'none'].includes(headers['sec-fetch-site'])) {
    return 'Cross-site request';
  }
  if (!/^application\/json\b/i.test(String(headers['content-type'] || ''))) return 'Send JSON';
  return null;
}

// Images and documents attached in threads (decision 23) are read only by the hub's own page. On top of checkRequest (the Host
// rule), a read must not come from another site: browsers say so in Sec-Fetch-Site, and an Origin, when sent,
// must be one of the hub's addresses. The response also carries Cross-Origin-Resource-Policy: same-origin.
export function checkAttachmentRead(headers = {}, { extra = [] } = {}) {
  const NO = 'Attachments open only from the hub’s own page';
  const site = headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) return NO;
  const origin = headers.origin;
  if (origin !== undefined && origin !== 'null') {
    let o;
    try { o = new URL(origin); } catch { return 'Bad origin'; }
    if (!allowedHost(hostName(o.host), extra) || hostName(o.host) !== hostName(headers.host)) return NO;
  } else if (origin === 'null') return NO;
  return null;
}
