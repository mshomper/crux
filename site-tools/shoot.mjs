// Takes a PNG of a page with headless Edge or Chrome. No dependencies; a tool for building the site, not part of it.
//   node shoot.mjs --out shot.png --url option-a.html --w 1440            (serves --root, default this folder)
//   node shoot.mjs --out hub.png --url http://127.0.0.1:4801/ --w 1440 --h 900 --view
// --view shoots just the window (w x h); the default is the whole page height. --dpr 2 for sharp phone shots.
// --wait ms waits after load (default 1200). --eval "js" runs in the page before the shot. --motion reduce.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve, dirname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const a = process.argv.slice(2), opt = {};
for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) { const k = a[i].slice(2); opt[k] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true; }
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(opt.root || here), W = Number(opt.w) || 1440, H = Number(opt.h) || 900, dpr = Number(opt.dpr) || 1;
const wait = Number(opt.wait) || 1200, out = resolve(opt.out || 'shot.png');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.json': 'application/json' };
let server = null, url = String(opt.url || 'index.html');
if (!/^https?:/.test(url)) {
  server = createServer(async (req, res) => {
    const p = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (p !== root && !p.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    try { const body = await readFile(p); res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body); }
    catch { res.writeHead(404).end('not found'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/${url.replace(/^\//, '')}`;
}

const exe = [process.env.SHOOT_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => p && existsSync(p));
if (!exe) { console.error('No Edge or Chrome found; set SHOOT_BROWSER.'); process.exit(1); }
const profile = await mkdtemp(join(tmpdir(), 'crux-shoot-'));
const child = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--window-size=${W},${H}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((ok, bad) => {
  let buf = ''; const t = setTimeout(() => bad(new Error('browser did not start')), 20000);
  child.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
});

const ws = new WebSocket(wsUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
let seq = 0; const pending = new Map(), events = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.bad(new Error(m.error.message)) : p.ok(m.result); } else if (m.method) events.push(m); };
const send = (method, params = {}, sessionId) => new Promise((ok, bad) => { const id = ++seq; pending.set(id, { ok, bad }); ws.send(JSON.stringify({ id, method, params, sessionId })); });

let code = 0;
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable'); await S('Runtime.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: dpr, mobile: W <= 720 });
  if (W <= 720) await S('Emulation.setTouchEmulationEnabled', { enabled: true });
  if (opt.motion) await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: String(opt.motion) }] });
  if (opt.noscript) await S('Emulation.setScriptExecutionDisabled', { value: true });   // the page's own scripts are off
  await S('Page.navigate', { url });
  for (let i = 0; i < 100 && !events.some(e => e.method === 'Page.loadEventFired'); i++) await sleep(100);
  await sleep(wait);
  if (typeof opt.eval === 'string') { await S('Runtime.evaluate', { expression: opt.eval, awaitPromise: true }); await sleep(400); }
  // --print "js": run it in the page (it may return a promise) and print what it returns
  if (typeof opt.print === 'string' && !opt.noscript) { const r = await S('Runtime.evaluate', { expression: opt.print, awaitPromise: true, returnByValue: true }); console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 1)); }
  const m = await S('Runtime.evaluate', { expression: 'JSON.stringify({h:Math.ceil(document.documentElement.scrollHeight),sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})', returnByValue: true });
  const dim = JSON.parse(m.result.value);
  const h = opt.view ? H : Math.min(dim.h, 16000);
  const shot = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !opt.view, clip: { x: 0, y: 0, width: W, height: h, scale: 1 } });
  await mkdir(dirname(out), { recursive: true });
  // --slice N: a tall page as several pictures of N CSS pixels each (name-1.png, name-2.png, ...)
  const step = Number(opt.slice) || 0;
  if (step && !opt.view && dim.h > step) {
    for (let y = 0, n = 1; y < dim.h; y += step, n++) {
      const part = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y, width: W, height: Math.min(step, dim.h - y), scale: 1 } });
      await writeFile(out.replace(/\.png$/, `-${n}.png`), Buffer.from(part.data, 'base64'));
    }
    console.log(`sliced: page height ${dim.h}, ${Math.ceil(dim.h / step)} parts`);
  } else await writeFile(out, Buffer.from(shot.data, 'base64'));
  console.log(`${out}  ${W}x${h} @${dpr}x  page scrollWidth ${dim.sw} / clientWidth ${dim.cw}${dim.sw > dim.cw ? '  SIDEWAYS SCROLL' : ''}`);
  const errs = events.filter(e => e.method === 'Runtime.exceptionThrown').map(e => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
  if (errs.length) console.log('page errors:\n' + errs.join('\n'));
} catch (e) { console.error(String(e)); code = 1; }
try { await send('Browser.close'); } catch {}
await new Promise(r => { child.on('exit', r); setTimeout(r, 4000); });
server?.close();
await sleep(300);
await rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(code);
