// Decision 47 B over HTTP, against a real test hub (its own port, never 4747; --no-agents --test-pair; every folder in
// temp, deleted afterwards): every POST refuses a request with no device cookie, one request per route; the cookie is
// accepted; the console code pairs a real ES256 passkey; a raise to Trusted needs its step-up and survives a restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request, createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { projectKey } from '../lib/settings.mjs';
import { pidsOnPort, stopTree } from '../lib/relaunch.mjs';
import { FakePasskey } from './fake-passkey.mjs';

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

let port, child, out = '', root, proj, data;
async function startHub() {
  child = spawn(process.execPath, [join(HUB, 'server.mjs'), '--port', String(port), '--no-agents', '--test-pair', proj], {
    cwd: HUB, windowsHide: true,
    env: { ...process.env, CRUX_HUB_DATA: data, CRUX_HOME: join(root, 'crux'), USERPROFILE: join(root, 'home'), HOME: join(root, 'home'), CRUX_HUB_AGENTS: '0', CRUX_HUB_PORT: '', CRUX_HUB_RESTARTED: '' }
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
  root = mkdtempSync(join(tmpdir(), 'crux-guard-http-'));
  proj = join(root, 'proj'); data = join(root, 'data');
  for (const d of [join(proj, '.crux'), join(root, 'crux'), join(root, 'home'), data]) mkdirSync(d, { recursive: true });
  await startHub();
});
test.after(async () => {
  await stopAll();
  await sleep(500);
  for (let i = 0; i < 10; i++) { try { rmSync(root, { recursive: true, force: true }); break; } catch { await sleep(500); } }
});

// A request as the hub's own page would send it (Host, Origin, JSON), or with a different host.
function call(method, path, { body, cookie, host = `localhost:${port}` } = {}) {
  return new Promise((ok, bad) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { host, ...(data ? { 'content-type': 'application/json', origin: `http://${host}`, 'content-length': data.length } : {}), ...(cookie ? { cookie } : {}) };
    const r = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => { const text = Buffer.concat(parts).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { } ok({ status: res.statusCode, headers: res.headers, json, text }); });
    });
    r.on('error', bad);
    if (data) r.write(data);
    r.end();
  });
}
const cookieOf = r => String([].concat(r.headers['set-cookie'] || [])[0] || '').split(';')[0];
const ORIGIN = () => `http://localhost:${port}`;
const postRoutes = () => [...new Set([...readFileSync(join(HUB, 'server.mjs'), 'utf8').matchAll(/'POST (\/api\/[\w/-]+)'/g)].map(m => m[1]))];
const OPEN = ['/api/pair/code', '/api/pair/options', '/api/pair/finish'];

test('every POST route refuses a request with no device cookie (one request per route)', async () => {
  const routes = postRoutes();
  for (const r of ['/api/approval', '/api/pick', '/api/send', '/api/worker', '/api/retire', '/api/answer', '/api/settings', '/api/entry-status', '/api/push/subscribe', '/api/restart', '/api/presence', '/api/auth/challenge'])
    assert.ok(routes.includes(r), `${r} is among the routes checked`);
  assert.equal(routes.filter(r => !OPEN.includes(r)).length, 24, `24 routes need the cookie: ${routes.join(' ')}`);
  for (const path of routes.filter(r => !OPEN.includes(r))) {
    const r = await call('POST', path, { body: {} });
    assert.equal(r.status, 401, `${path} without a cookie: ${r.status} ${r.text}`);
    assert.equal(r.json.pair, true, path);
    assert.match(r.json.error, /not paired/, path);
  }
  // a forged cookie, or a cookie named for another port, is no better
  assert.equal((await call('POST', '/api/send', { body: { project: 'proj', thread: 'orchestrator', text: 'hi' }, cookie: `crux_device_${port}=forged` })).status, 401);
  assert.equal((await call('POST', '/api/send', { body: { project: 'proj', thread: 'orchestrator', text: 'hi' }, cookie: 'crux_device_4747=forged' })).status, 401);
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
  const sent = await call('POST', '/api/send', { body: { project: 'proj', thread: 'orchestrator', text: 'Hello from a paired device' }, cookie: testCookie });
  assert.equal(sent.status, 200);
});

let key, cookie;
test('the console code pairs a real ES256 passkey; the code never appears in a response', async () => {
  const asked = await call('POST', '/api/pair/code', { body: {} });
  assert.equal(asked.status, 200);
  assert.deepEqual(asked.json, { printed: true });
  const code = [...out.matchAll(/Pairing code \([^)]*\): ([A-Z0-9]{4}-[A-Z0-9]{4})/g)].at(-1)?.[1];
  assert.ok(code, 'printed in the hub\'s own output');
  const st = await call('GET', '/api/auth/status');
  assert.ok(!st.text.includes(code), 'not in the status');
  assert.equal(st.json.codeWhere, 'output');
  assert.equal((await call('POST', '/api/pair/options', { body: { code: 'WRNG-CODE', label: 'x' } })).status, 403, 'a wrong code');
  assert.equal((await call('POST', '/api/pair/options', { body: { code, label: 'PC' }, host: `127.0.0.1:${port}` })).status, 400, 'no passkeys on 127.0.0.1');
  const opts = await call('POST', '/api/pair/options', { body: { code, label: 'Test PC' } });
  assert.equal(opts.status, 200, opts.text);
  assert.equal(opts.json.publicKey.rp.id, 'localhost');
  assert.equal(opts.json.publicKey.authenticatorSelection.userVerification, 'required');
  key = new FakePasskey();
  const fin = await call('POST', '/api/pair/finish', { body: { credential: key.register({ challenge: opts.json.publicKey.challenge, origin: ORIGIN(), rpId: 'localhost' }) } });
  assert.equal(fin.status, 200, fin.text);
  cookie = cookieOf(fin);
  assert.match(String(fin.headers['set-cookie']), /HttpOnly; SameSite=Strict$/);
  assert.equal((await call('GET', '/api/auth/status', { cookie })).json.paired, true);
  const file = readFileSync(join(data, 'devices.json'), 'utf8');
  assert.ok(!file.includes(cookie.split('=')[1]), 'devices.json holds a hash, not the token');
  // the alert, in the orchestrator thread
  const st2 = await call('GET', '/api/state');
  assert.ok(st2.json.projects[0].events.some(e => e.type === 'notice' && e.thread === 'orchestrator' && /Test PC \(localhost\) was paired with the hub, using the code from the hub's window/.test(e.text)));
  // the same code again: spent
  assert.equal((await call('POST', '/api/pair/options', { body: { code, label: 'again' } })).status, 403);
});

async function confirm(need, { cookie: c = cookie, sign = {} } = {}) {
  const ch = await call('POST', '/api/auth/challenge', { body: { purpose: need.purpose, scope: need.scope }, cookie: c });
  assert.equal(ch.status, 200, ch.text);
  return key.assert({ challenge: ch.json.publicKey.challenge, origin: ORIGIN(), rpId: 'localhost', ...sign });
}

test('raising to Trusted needs a fresh step-up made for it; a replay or a missing face check is refused', async () => {
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

test('pairing another device needs a step-up and gives a one-time code; unpairing needs one too', async () => {
  const issued = await call('POST', '/api/pair/issue', { body: { stepUp: await confirm({ purpose: 'pair', scope: 'pair' }) }, cookie });
  assert.equal(issued.status, 200, issued.text);
  assert.match(issued.json.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const phoneKey = new FakePasskey();
  const opts = await call('POST', '/api/pair/options', { body: { code: issued.json.code, label: 'Second PC' } });
  const fin = await call('POST', '/api/pair/finish', { body: { credential: phoneKey.register({ challenge: opts.json.publicKey.challenge, origin: ORIGIN(), rpId: 'localhost' }) } });
  assert.equal(fin.status, 200, fin.text);
  const list = (await call('GET', '/api/devices', { cookie })).json.devices;
  const second = list.find(d => d.label === 'Second PC');
  assert.equal(second.via, 'a code from Test PC');
  assert.equal((await call('POST', '/api/devices/remove', { body: { id: second.id }, cookie })).status, 403, 'unpairing asks first');
  const gone = await call('POST', '/api/devices/remove', { body: { id: second.id, stepUp: await confirm({ purpose: 'unpair', scope: `device=${second.id}` }) }, cookie });
  assert.equal(gone.status, 200, gone.text);
  assert.equal((await call('POST', '/api/send', { body: { project: 'proj', thread: 'orchestrator', text: 'x' }, cookie: cookieOf(fin) })).status, 401, 'its cookie stops working');
  const notes = (await call('GET', '/api/state')).json.projects[0].events.filter(e => e.type === 'notice').map(e => e.text);
  assert.ok(notes.some(t => /Second PC \(localhost\) was unpaired from the hub, with its passkey, from Test PC/.test(t)));
});

test('restart: allowed for a paired device; the new hub keeps the passkey-backed Trusted level', async () => {
  const before = (await call('GET', '/api/ping')).json.boot;
  const r = await call('POST', '/api/restart', { body: {}, cookie });
  assert.equal(r.status, 200, r.text);
  let boot = null;
  for (let i = 0; i < 100 && (!boot || boot === before); i++) { await sleep(300); boot = (await call('GET', '/api/ping').catch(() => ({ json: null }))).json?.boot; }
  assert.ok(boot && boot !== before, 'a new hub answered');
  const st = (await call('GET', '/api/state')).json;
  assert.equal(st.projects[0].permissionMode, 'trusted', 'its raise checked out at start');
  assert.equal((await call('GET', '/api/auth/status', { cookie })).json.paired, true, 'the device is still paired');
});
