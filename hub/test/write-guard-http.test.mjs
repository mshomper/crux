// Decision 47 B over HTTP, against a real test hub (its own port, never 4747; --no-agents --test-pair; every folder in
// temp, deleted afterwards): every POST refuses a request with no device cookie, one request per route; the cookie is
// accepted; no pairing code ever reaches a file or a reply; agent-written pages are sandboxed; a raise to Trusted needs
// its step-up and survives a restart; a paired device pairs another with a real ES256 passkey.
// A test hub has no window, so it never shows a console code: the "paired PC" here is a device written into
// devices.json before the start, as a hand-edited file would be, with a node:crypto passkey.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request, createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { projectKey } from '../lib/settings.mjs';
import { pidsOnPort, stopTree } from '../lib/relaunch.mjs';
import { FakePasskey } from './fake-passkey.mjs';

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const CODE = /Pairing code|[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/;
const TS = 'pc.tail1234.ts.net';   // the phone's way in (tailscale serve)

let port, rport, child, out = '', root, proj, data, crux;
const key = new FakePasskey(), token = randomBytes(32).toString('base64url');
let cookie;
async function startHub() {
  child = spawn(process.execPath, [join(HUB, 'server.mjs'), '--port', String(port), '--remote-port', String(rport), '--no-agents', '--test-pair', proj], {
    cwd: HUB, windowsHide: true,
    env: { ...process.env, CRUX_HUB_DATA: data, CRUX_HOME: crux, USERPROFILE: join(root, 'home'), HOME: join(root, 'home'), CRUX_HUB_AGENTS: '0', CRUX_HUB_PORT: '', CRUX_HUB_RESTARTED: '' }
  });
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 100 && !out.includes('Crux hub: http'); i++) await sleep(100);
  assert.ok(out.includes(`Crux hub: http://127.0.0.1:${port}`), `the test hub started:\n${out}`);
}
async function stopAll() {
  assert.notEqual(port, 4747);
  try { child?.kill(); } catch { }
  for (const pid of await pidsOnPort(port)) await stopTree(pid);   // the hub a restart started, if any
}

test.before(async () => {
  do { port = await freePort(); } while (port === 4747);
  do { rport = await freePort(); } while (rport === 4747 || rport === 4748 || rport === port);
  root = mkdtempSync(join(tmpdir(), 'crux-guard-http-'));
  proj = join(root, 'proj'); data = join(root, 'data'); crux = join(root, 'crux');
  for (const d of [join(proj, '.crux'), join(proj, '.decisions', 'images'), join(crux, 'media', 'proj'), join(root, 'home'), data]) mkdirSync(d, { recursive: true });
  // Agent-written things the hub serves: a decision record (its page is built at start), a picture, the roll-up, a visual.
  copyFileSync(join(HUB, '..', '.decisions', '0001-session-messaging.json'), join(proj, '.decisions', '0001-session-messaging.json'));
  writeFileSync(join(proj, '.decisions', '.gitignore'), '*.html\n');   // pages are built locally (decision 41)
  writeFileSync(join(proj, '.decisions', '0001-session-messaging.md'), '# 0001 Session messaging\n<script>alert(1)</script>\n');
  writeFileSync(join(proj, '.decisions', 'images', '0001-pic.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  writeFileSync(join(crux, 'index.html'), '<!doctype html><title>All projects</title><script>document.title = "ran"</script>');
  writeFileSync(join(crux, 'config.json'), JSON.stringify({ roots: [root] }));
  writeFileSync(join(crux, 'media', 'proj', 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  // The paired PC.
  const now = new Date().toISOString();
  writeFileSync(join(data, 'devices.json'), JSON.stringify({ version: 1, raises: {}, devices: [{ id: 'dseed', label: 'Test PC', rpId: TS, origin: `https://${TS}`, tokenHash: createHash('sha256').update(token).digest('hex'),
    credential: { id: key.id, publicKey: key.spki.toString('base64url'), alg: -7, signCount: 0, transports: ['internal'] }, created: now, lastSeen: now, via: 'written by the test' }] }));
  cookie = `crux_device_${port}=${token}`;
  await startHub();
});
test.after(async () => {
  await stopAll();
  await sleep(500);
  for (let i = 0; i < 10; i++) { try { rmSync(root, { recursive: true, force: true }); break; } catch { await sleep(500); } }
});

// A request as the hub's own page would send it (Host, Origin, JSON), or with a different host.
// Remote by default: the phone's requests come through tailscale serve, with a *.ts.net Host and forwarding headers.
function call(method, path, { body, cookie: c, host = TS, extra = {}, to = port } = {}) {
  return new Promise((ok, bad) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const remote = /\.ts\.net$/.test(host);
    const headers = { host, ...(remote ? { 'x-forwarded-for': '100.101.102.103', 'x-forwarded-proto': 'https' } : {}), ...(payload ? { 'content-type': 'application/json', origin: `${remote ? 'https' : 'http'}://${host}`, 'content-length': payload.length } : {}), ...(c ? { cookie: c } : {}), ...extra };
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];   // extra: { origin: undefined } drops it
    const r = request({ host: '127.0.0.1', port: to, method, path, headers }, res => {
      const parts = [];
      res.on('data', x => parts.push(x));
      res.on('end', () => { const text = Buffer.concat(parts).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { } ok({ status: res.statusCode, headers: res.headers, json, text }); });
    });
    r.on('error', bad);
    if (payload) r.write(payload);
    r.end();
  });
}
const cookieOf = r => String([].concat(r.headers['set-cookie'] || [])[0] || '').split(';')[0];
const ORIGIN = () => `https://${TS}`;
const LOCAL = () => `localhost:${port}`;
const postRoutes = () => [...new Set([...readFileSync(join(HUB, 'server.mjs'), 'utf8').matchAll(/'POST (\/api\/[\w/-]+)'/g)].map(m => m[1]))];
const OPEN = ['/api/pair/code', '/api/pair/options', '/api/pair/finish'];
const filesUnder = dir => readdirSync(dir).flatMap(n => { const f = join(dir, n); return statSync(f).isDirectory() ? filesUnder(f) : [f]; });

test('every POST route refuses a request with no device cookie (one request per route)', async () => {
  const routes = postRoutes();
  for (const r of ['/api/approval', '/api/pick', '/api/send', '/api/worker', '/api/retire', '/api/answer', '/api/settings', '/api/entry-status', '/api/push/subscribe', '/api/restart', '/api/presence', '/api/auth/challenge'])
    assert.ok(routes.includes(r), `${r} is among the routes checked`);
  // 29 since the desktop app's setup routes (decisions 52 and 54): /api/setup/key, /claude, /browse, /folders;
  // 30 with the desktop app's reports (decision 58): /api/desktop/presence.
  assert.equal(routes.filter(r => !OPEN.includes(r)).length, 30, `30 routes need a paired device: ${routes.join(' ')}`);
  for (const path of routes.filter(r => !OPEN.includes(r))) {
    const r = await call('POST', path, { body: {} });
    assert.equal(r.status, 401, `${path} without a cookie: ${r.status} ${r.text}`);
    assert.equal(r.json.pair, true, path);
    assert.match(r.json.error, /not paired/, path);
  }
  // a forged cookie, or a cookie named for another port, is no better
  assert.equal((await call('POST', '/api/send', { body: { project: 'proj', thread: 'orchestrator', text: 'hi' }, cookie: `crux_device_${port}=forged` })).status, 401);
  assert.equal((await call('POST', '/api/send', { body: { project: 'proj', thread: 'orchestrator', text: 'hi' }, cookie: `crux_device_4747=${token}` })).status, 401);
  // reads stay open
  assert.equal((await call('GET', '/api/state')).status, 200);
  assert.equal((await call('GET', '/api/auth/status')).json.paired, false);
});

let testCookie;
test('the test device\'s cookie is accepted on every route; the big changes then ask for a step-up', async () => {
  const page = await call('GET', '/');
  testCookie = cookieOf(page);
  assert.match(testCookie, new RegExp(`^crux_device_${port}=`), 'the --test-pair hub hands its cookie to the page');
  assert.match(String(page.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
  const stepUps = { '/api/push/subscribe': 'push', '/api/pair/issue': 'pair', '/api/devices/remove': 'unpair' };
  for (const path of postRoutes().filter(r => !OPEN.includes(r) && r !== '/api/restart')) {
    const r = await call('POST', path, { body: {}, cookie: testCookie });
    assert.notEqual(r.status, 401, `${path} with the cookie`);
    if (stepUps[path]) { assert.equal(r.status, 403, path); assert.equal(r.json.stepUp.purpose, stepUps[path], path); }
  }
  const raise = await call('POST', '/api/settings', { body: { project: 'proj', permissionMode: 'trusted' }, cookie: testCookie });
  assert.equal(raise.status, 403);
  assert.equal(raise.json.stepUp.purpose, 'project');
  assert.equal(raise.json.stepUp.why, 'Raise proj to Trusted');
  const lower = await call('POST', '/api/settings', { body: { project: 'proj', permissionMode: 'standard' }, cookie: testCookie });
  assert.equal(lower.status, 200, 'lowering needs only the cookie');
  assert.equal((await call('POST', '/api/send', { body: { project: 'proj', thread: 'orchestrator', text: 'Hello from a paired device' }, cookie: testCookie })).status, 200);
});

const pcKey = new FakePasskey();
// A big change from the PC page: once the PC has its passkey, a Windows Hello confirmation made with it.
async function confirmPC(need) {
  const ch = await call('POST', '/api/auth/challenge', { body: { purpose: need.purpose, scope: need.scope }, host: LOCAL() });
  assert.equal(ch.status, 200, ch.text);
  return pcKey.assert({ challenge: ch.json.publicKey.challenge, origin: `http://${LOCAL()}`, rpId: 'localhost' });
}

test('this PC: no login for everyday changes; its first big change sets up Windows Hello (or goes ahead without it, with a note); the phone\'s path still needs a cookie', async () => {
  const msg = { project: 'proj', thread: 'orchestrator', text: 'From the PC' };
  const st = await call('GET', '/api/auth/status', { host: LOCAL() });
  assert.equal(st.json.paired, true); assert.equal(st.json.device.local, true);
  // everyday changes: no cookie, no prompt
  assert.equal((await call('POST', '/api/send', { body: msg, host: LOCAL() })).status, 200, 'localhost, page Origin');
  assert.equal((await call('POST', '/api/send', { body: msg, host: `crux.localhost:${port}` })).status, 200, 'crux.localhost, no forwarded headers');
  assert.equal((await call('POST', '/api/send', { body: msg, host: LOCAL(), extra: { origin: undefined } })).status, 200, 'a local tool with no Origin');
  assert.equal((await call('POST', '/api/settings', { body: { project: 'proj', permissionMode: 'auto', handoff: { retireAt: 55 } }, host: LOCAL() })).status, 200, 'ordinary settings');
  const issued = await call('POST', '/api/pair/issue', { body: {}, host: LOCAL() });
  assert.equal(issued.status, 200, 'Pair another device just shows a code, no Windows Hello');
  assert.match(issued.json.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal((await call('GET', '/api/devices', { host: LOCAL() })).json.devices[0].label, 'This PC');
  // a big change, no PC passkey yet: asks to set one up; with no Windows Hello in the browser it goes ahead
  const big = { project: 'proj', permissionMode: 'trusted' };
  const ask = await call('POST', '/api/settings', { body: big, host: LOCAL() });
  assert.equal(ask.status, 403); assert.equal(ask.json.stepUp.enroll, true);
  const fallback = await call('POST', '/api/settings', { body: { ...big, stepUp: { fallback: true } }, host: LOCAL() });
  assert.equal(fallback.status, 200, fallback.text); assert.equal(fallback.json.permissionMode, 'trusted');
  assert.equal(JSON.parse(readFileSync(join(data, 'devices.json'), 'utf8')).raises[projectKey(proj)].local, true, 'recorded as raised from this PC');
  const notes = (await call('GET', '/api/state')).json.projects[0].events.filter(e => e.type === 'notice').map(e => e.text);
  assert.ok(notes.some(t => /made on this PC without Windows Hello/.test(t)), 'and told');
  // the first big change with Windows Hello sets up the PC's passkey (no code)
  const conn = await call('POST', '/api/settings', { body: { project: 'proj', connectors: true }, host: LOCAL() });
  assert.equal(conn.json.stepUp.enroll, true);
  const o = await call('POST', '/api/pc/enroll', { body: { purpose: conn.json.stepUp.purpose, scope: conn.json.stepUp.scope }, host: LOCAL() });
  assert.equal(o.status, 200, o.text);
  const enrolled = await call('POST', '/api/settings', { body: { project: 'proj', connectors: true, stepUp: { enroll: pcKey.register({ challenge: o.json.publicKey.challenge, origin: `http://${LOCAL()}`, rpId: 'localhost' }) } }, host: LOCAL() });
  assert.equal(enrolled.status, 200, enrolled.text); assert.equal(enrolled.json.connectors, true);
  // from now on: Windows Hello, no fallback
  const hub = { permissionTimeoutSec: 300 };
  const need = (await call('POST', '/api/settings', { body: hub, host: LOCAL() })).json.stepUp;
  assert.ok(need && !need.enroll, 'a normal confirmation now');
  assert.equal((await call('POST', '/api/settings', { body: { ...hub, stepUp: { fallback: true } }, host: LOCAL() })).status, 403, 'no fallback once the PC has its passkey');
  assert.equal((await call('POST', '/api/settings', { body: { ...hub, stepUp: await confirmPC(need) }, host: LOCAL() })).json.settings.permissionTimeoutSec, 300);
  assert.equal((await call('POST', '/api/pc/enroll', { body: { purpose: 'push', scope: 'push' }, cookie: testCookie })).status, 403, 'a remote device cannot set up the PC passkey');
  // the phone's path, and anything that came through a proxy: refused without a cookie
  assert.equal((await call('POST', '/api/send', { body: msg })).status, 401, 'Host ts.net');
  assert.equal((await call('POST', '/api/send', { body: msg, to: rport })).status, 401, 'the phone port');
  assert.equal((await call('POST', '/api/send', { body: msg, host: `localhost:${rport}`, to: rport })).status, 401, 'the phone port, even with a local Host');
  assert.equal((await call('POST', '/api/send', { body: msg, host: LOCAL(), extra: { 'x-forwarded-for': '100.1.2.3' } })).status, 401, 'X-Forwarded-For');
  assert.equal((await call('POST', '/api/send', { body: msg, host: `crux.localhost:${port}`, extra: { 'x-forwarded-host': TS } })).status, 401, 'serve passing a spoofed Host through');
  assert.equal((await call('POST', '/api/send', { body: msg, host: LOCAL(), extra: { 'tailscale-user-login': 'someone@example.com' } })).status, 401, 'Tailscale identity');
  assert.equal((await call('POST', '/api/send', { body: msg, host: `127.0.0.1:${port}` })).status, 401, '127.0.0.1 is not the PC name');
  assert.equal((await call('POST', '/api/send', { body: msg, host: LOCAL(), extra: { origin: 'http://localhost:3000' } })).status, 401, 'a page on another local port');
  assert.equal((await call('POST', '/api/send', { body: msg, host: LOCAL(), extra: { origin: 'https://evil.example' } })).status, 403, 'a foreign page is refused by the page checks');
  // back to where the tests below expect it
  for (const b of [{ project: 'proj', permissionMode: 'standard', connectors: false, handoff: { retireAt: null } }, { permissionTimeoutSec: 120 }]) {
    let r = await call('POST', '/api/settings', { body: b, host: LOCAL() });
    if (r.status === 403) r = await call('POST', '/api/settings', { body: { ...b, stepUp: await confirmPC(r.json.stepUp) }, host: LOCAL() });
    assert.equal(r.status, 200, r.text);
  }
});

test('no pairing code ever reaches a file, a reply or the page: a hub with no window shows none', async () => {
  const st = await call('GET', '/api/auth/status');
  assert.equal(st.json.codeWhere, 'none', 'this hub has no window');
  assert.equal(st.json.devices, 1);
  for (let i = 0; i < 3; i++) {
    const asked = await call('POST', '/api/pair/code', { body: {} });
    assert.equal(asked.status, 200);
    assert.equal(asked.json.printed, false, 'asking for a code without a cookie does nothing');
  }
  assert.doesNotMatch(out, CODE, 'nothing code-like in what the hub printed (its log, after a restart)');
  for (const f of filesUnder(data)) assert.doesNotMatch(readFileSync(f, 'utf8'), /Pairing code/, `${f} holds no pairing code`);
  assert.doesNotMatch(st.text, CODE);
  for (const guess of ['AAAA-AAAA', 'K7QM-3XPD']) assert.equal((await call('POST', '/api/pair/options', { body: { code: guess, label: 'Script' } })).status, 403, 'no code works');
});

test('agent-written pages, pictures, the roll-up and visuals are served sandboxed with nosniff; attachments stay stricter', async () => {
  const sandboxed = async path => {
    const r = await call('GET', path);
    assert.equal(r.status, 200, `${path}: ${r.status} ${r.text.slice(0, 200)}`);
    assert.equal(r.headers['content-security-policy'], 'sandbox allow-scripts allow-popups', path);
    assert.doesNotMatch(r.headers['content-security-policy'], /allow-same-origin/, path);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', path);
    return r;
  };
  const page = await sandboxed('/p/proj/0001-session-messaging.html');
  assert.match(page.text, /fetch\('http:\/\/localhost:4747\/api\/ping'\)/, 'a real Crux page');
  await sandboxed('/p/proj/index.html');
  await sandboxed('/p/proj/images/0001-pic.png');
  await sandboxed('/all');
  await sandboxed('/files/0/proj/.decisions/0001-session-messaging.html');
  await sandboxed('/files/0/proj/.decisions/0001-session-messaging.md');
  await sandboxed('/media/proj/pic.svg');
  // a thread attachment: no scripts at all
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const att = await call('POST', '/api/attach', { body: { project: 'proj', data: png }, cookie: testCookie });
  assert.equal(att.status, 200, att.text);
  const a = await call('GET', `/att/proj/${att.json.id}`);
  assert.equal(a.headers['content-security-policy'], "default-src 'none'; sandbox");
  assert.equal(a.headers['x-content-type-options'], 'nosniff');
  // the hub's own replies carry nosniff too
  assert.equal((await call('GET', '/api/state')).headers['x-content-type-options'], 'nosniff');
});

async function confirm(need, { cookie: c = cookie, sign = {} } = {}) {
  const ch = await call('POST', '/api/auth/challenge', { body: { purpose: need.purpose, scope: need.scope }, cookie: c });
  assert.equal(ch.status, 200, ch.text);
  return key.assert({ challenge: ch.json.publicKey.challenge, origin: ORIGIN(), rpId: TS, ...sign });
}

test('raising to Trusted needs a fresh step-up made for it; a replay or a missing face check is refused', async () => {
  assert.equal((await call('GET', '/api/auth/status', { cookie })).json.paired, true, 'the written-in PC is paired');
  const body = { project: 'proj', permissionMode: 'trusted' };
  const first = await call('POST', '/api/settings', { body, cookie });
  assert.equal(first.status, 403);
  const need = first.json.stepUp;
  const noFace = await call('POST', '/api/settings', { body: { ...body, stepUp: await confirm(need, { sign: { flags: 0x01 } }) }, cookie });
  assert.equal(noFace.status, 403); assert.match(noFace.json.error, /user verification/);
  const wrong = await call('POST', '/api/settings', { body: { ...body, stepUp: await confirm({ purpose: 'push', scope: 'push' }) }, cookie });
  assert.equal(wrong.status, 403); assert.match(wrong.json.error, /different change/);
  const stepUp = await confirm(need);
  const ok = await call('POST', '/api/settings', { body: { ...body, stepUp }, cookie });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.permissionMode, 'trusted');
  const raises = JSON.parse(readFileSync(join(data, 'devices.json'), 'utf8')).raises;
  assert.ok(raises[projectKey(proj)], 'the signed step-up is kept as the raise');
  // the same step-up again, after lowering
  assert.equal((await call('POST', '/api/settings', { body: { project: 'proj', permissionMode: 'auto' }, cookie })).status, 200);
  assert.ok(!JSON.parse(readFileSync(join(data, 'devices.json'), 'utf8')).raises[projectKey(proj)], 'lowering lets the record go');
  const replay = await call('POST', '/api/settings', { body: { ...body, stepUp }, cookie });
  assert.equal(replay.status, 403); assert.match(replay.json.error, /already used/);
  // the test device cannot use a challenge the paired device asked for
  const other = await call('POST', '/api/settings', { body: { ...body, stepUp: await confirm(need) }, cookie: testCookie });
  assert.equal(other.status, 403); assert.match(other.json.error, /another device/);
  // raise again for the restart below
  assert.equal((await call('POST', '/api/settings', { body: { ...body, stepUp: await confirm(need) }, cookie })).status, 200);
});

test('a paired device pairs another (real ES256 registration over HTTP) after a step-up; unpairing needs one too', async () => {
  const issued = await call('POST', '/api/pair/issue', { body: { stepUp: await confirm({ purpose: 'pair', scope: 'pair' }) }, cookie });
  assert.equal(issued.status, 200, issued.text);
  assert.match(issued.json.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.ok(!out.includes(issued.json.code), 'the issued code is shown to the paired device only, not printed');
  assert.equal((await call('POST', '/api/pair/options', { body: { code: issued.json.code, label: 'PC' }, host: `127.0.0.1:${port}` })).status, 400, 'no passkeys on 127.0.0.1');
  const opts = await call('POST', '/api/pair/options', { body: { code: issued.json.code, label: 'Second PC' } });
  assert.equal(opts.status, 200, opts.text);
  assert.equal(opts.json.publicKey.rp.id, TS);
  assert.equal(opts.json.publicKey.authenticatorSelection.userVerification, 'required');
  const second = new FakePasskey();
  const fin = await call('POST', '/api/pair/finish', { body: { credential: second.register({ challenge: opts.json.publicKey.challenge, origin: ORIGIN(), rpId: TS }) } });
  assert.equal(fin.status, 200, fin.text);
  const secondCookie = cookieOf(fin);
  assert.match(String(fin.headers['set-cookie']), /HttpOnly; SameSite=Strict; Secure$/, 'Secure over the tailnet https address');
  assert.equal((await call('GET', '/api/auth/status', { cookie: secondCookie })).json.paired, true);
  assert.ok(!readFileSync(join(data, 'devices.json'), 'utf8').includes(secondCookie.split('=')[1]), 'devices.json holds a hash, not the token');
  assert.equal((await call('POST', '/api/pair/options', { body: { code: issued.json.code, label: 'again' } })).status, 403, 'the code worked once');
  const list = (await call('GET', '/api/devices', { cookie })).json.devices;
  const d2 = list.find(d => d.label === 'Second PC');
  assert.equal(d2.via, 'a code from Test PC');
  assert.equal((await call('POST', '/api/devices/remove', { body: { id: d2.id }, cookie })).status, 403, 'unpairing asks first');
  const gone = await call('POST', '/api/devices/remove', { body: { id: d2.id, stepUp: await confirm({ purpose: 'unpair', scope: `device=${d2.id}` }) }, cookie });
  assert.equal(gone.status, 200, gone.text);
  assert.equal((await call('POST', '/api/send', { body: { project: 'proj', thread: 'orchestrator', text: 'x' }, cookie: secondCookie })).status, 401, 'its cookie stops working');
  const notes = (await call('GET', '/api/state')).json.projects[0].events.filter(e => e.type === 'notice' && e.thread === 'orchestrator').map(e => e.text);
  assert.ok(notes.some(t => /Second PC \(pc\.tail1234\.ts\.net\) was paired with the hub, using a code from Test PC/.test(t)), 'the pairing is noted');
  assert.ok(notes.some(t => /Second PC \(pc\.tail1234\.ts\.net\) was unpaired from the hub, with its passkey, from Test PC/.test(t)), 'and the unpairing');
});

test('restart: allowed for a paired device; the new hub keeps a Trusted level raised from this PC', async () => {
  assert.equal((await call('POST', '/api/settings', { body: { project: 'proj', permissionMode: 'auto' }, host: LOCAL() })).status, 200);
  const ask = await call('POST', '/api/settings', { body: { project: 'proj', permissionMode: 'trusted' }, host: LOCAL() });
  assert.equal(ask.status, 403, 'a big change on the PC asks for its Windows Hello');
  assert.equal((await call('POST', '/api/settings', { body: { project: 'proj', permissionMode: 'trusted', stepUp: await confirmPC(ask.json.stepUp) }, host: LOCAL() })).status, 200);
  const before = (await call('GET', '/api/ping')).json.boot;
  const r = await call('POST', '/api/restart', { body: {}, cookie });
  assert.equal(r.status, 200, r.text);
  let boot = null;
  for (let i = 0; i < 100 && (!boot || boot === before); i++) { await sleep(300); boot = (await call('GET', '/api/ping').catch(() => ({ json: null }))).json?.boot; }
  assert.ok(boot && boot !== before, 'a new hub answered');
  const st = (await call('GET', '/api/state')).json;
  assert.equal(st.projects[0].permissionMode, 'trusted', 'its raise checked out at start');
  assert.equal((await call('GET', '/api/auth/status', { cookie })).json.paired, true, 'the device is still paired');
  const log = join(data, `hub-${port}.log`);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /Pairing code/, 'the restarted hub\'s log holds no code');
});

test('the off switch (CRUX_HUB_GUARD=off): the hub takes changes as before decision 47, the phone\'s path included', async () => {
  let offPort; do { offPort = await freePort(); } while ([4747, 4748, port, rport].includes(offPort));
  const offData = join(root, 'off-data');
  mkdirSync(offData, { recursive: true });
  let text = '';
  const off = spawn(process.execPath, [join(HUB, 'server.mjs'), '--port', String(offPort), '--no-agents', proj], {
    cwd: HUB, windowsHide: true, env: { ...process.env, CRUX_HUB_DATA: offData, CRUX_HOME: crux, USERPROFILE: join(root, 'home'), HOME: join(root, 'home'), CRUX_HUB_AGENTS: '0', CRUX_HUB_PORT: '', CRUX_HUB_RESTARTED: '', CRUX_HUB_GUARD: 'off' }
  });
  off.stdout.on('data', d => { text += d; });
  try {
    for (let i = 0; i < 100 && !text.includes('Write guard: OFF'); i++) await sleep(100);
    assert.match(text, /Write guard: OFF/);
    const r = await call('POST', '/api/send', { body: { project: 'proj', thread: 'orchestrator', text: 'guard off' }, to: offPort });
    assert.equal(r.status, 200, `a ts.net request with no cookie: ${r.text}`);
    const big = await call('POST', '/api/settings', { body: { project: 'proj', permissionMode: 'trusted' }, to: offPort });
    assert.equal(big.status, 200, 'and a big change with no step-up');
    assert.equal((await call('POST', '/api/settings', { body: { project: 'proj', permissionMode: 'standard' }, to: offPort })).status, 200);
  } finally {
    off.kill();
    for (const pid of await pidsOnPort(offPort)) await stopTree(pid);
  }
});
