// Decision 47 B, in process: passkey checks with real keys, pairing codes, step-up (fresh, once, for one change),
// the Trusted record checked at start, the alerts, restart_hub and the --test-pair guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Guard, stepUpNeed, settingsNeed, makeAlert, pairAlert, dropUnbackedTrusted, makeRestartHub, addressOf, pcRedirect, projectScope, projectTag, cutScope, OPEN_POSTS, STEP_UP_MS } from '../lib/guard.mjs';
import { verifyRegistration, verifyAssertion, parseAuthData } from '../lib/webauthn.mjs';
import { Push, cardsFor, payloadOf } from '../lib/push.mjs';
import { testPairError, startHub, pairedDevices } from '../lib/relaunch.mjs';
import { cruxToolNames, restartHub } from '../lib/tools.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings, projectKey } from '../lib/settings.mjs';
import { FakePasskey, UP, UV } from './fake-passkey.mjs';

const PORT = 4790;
const H = { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` };
// The newest code the hub printed.
const codeIn = lines => [...lines.join('\n').matchAll(/Pairing code \([^)]*\): ([A-Z0-9]{4}-[A-Z0-9]{4})/g)].at(-1)?.[1];
const roots = [];
const tmp = name => { const d = mkdtempSync(join(tmpdir(), `crux-guard-${name}-`)); roots.push(d); return d; };
test.after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

// interactive: as a hub running in a window (the only place a console code is shown).
function newGuard(opts = {}) {
  const out = [], clock = { t: Date.parse('2026-11-12T10:00:00Z') };
  const g = new Guard({ port: PORT, file: null, print: s => out.push(s), now: () => clock.t, interactive: true, ...opts });
  return { g, out, clock };
}
// Pair a fake passkey through the console code, as the page would. Returns { device, cookie, key }.
function pair(g, out, { key = new FakePasskey(), label = 'Test PC', headers = H } = {}) {
  g.printCode('test');
  const opts = g.pairOptions({ headers, code: codeIn(out), label });
  const a = addressOf(headers, PORT);
  const r = g.pairFinish({ headers, credential: key.register({ challenge: opts.publicKey.challenge, origin: a.origin, rpId: a.rpId }) });
  return { ...r, key, cookieHeader: r.cookie.split(';')[0] };
}
function stepUp(g, device, key, need, { headers = H, sign = {} } = {}) {
  const o = g.challenge({ headers, device, purpose: need.purpose, scope: need.scope });
  const a = addressOf(headers, PORT);
  return key.assert({ challenge: o.publicKey.challenge, origin: a.origin, rpId: a.rpId, ...sign });
}

test('a real ES256 registration and assertion check out; a wrong origin, address or missing face check does not', () => {
  const key = new FakePasskey(), ctx = { challenge: 'abc123', origin: 'http://localhost:4790', rpId: 'localhost' };
  const cred = verifyRegistration(key.register(ctx), ctx);
  assert.equal(cred.id, key.id); assert.equal(cred.alg, -7);
  assert.throws(() => verifyRegistration(key.register({ ...ctx, origin: 'http://localhost:4791' }), ctx), /not on http:\/\/localhost:4790/, 'another port is another origin');
  assert.throws(() => verifyRegistration(key.register({ ...ctx, rpId: 'evil.example' }), ctx), /another address/);
  assert.throws(() => verifyRegistration(key.register({ ...ctx, flags: UP }), ctx), /user verification/);
  assert.throws(() => verifyRegistration(key.register({ ...ctx, challenge: 'other' }), ctx), /challenge/);
  assert.throws(() => verifyRegistration({ ...key.register(ctx), publicKeyAlgorithm: -257 }, ctx), /RSA/, 'an EC key cannot claim RS256');
  const count = verifyAssertion(key.assert(ctx), cred, ctx);
  assert.equal(count, 1);
  const bad = key.assert(ctx); bad.signature = key.assert({ ...ctx, challenge: 'zzz' }).signature;
  assert.throws(() => verifyAssertion(bad, cred, ctx), /signature/);
  assert.throws(() => verifyAssertion(key.assert({ ...ctx, type: 'webauthn.create' }), cred, ctx), /webauthn.create/);
  assert.equal(parseAuthData(Buffer.from(key.authData('localhost', { at: true }))).credentialId.toString('base64url'), key.id);
});

test('the passkey address and origin of a request', () => {
  assert.deepEqual(addressOf({ host: 'localhost:4747' }), { rpId: 'localhost', origin: 'http://localhost:4747', secure: false, webauthn: true, port: 4747 });
  assert.deepEqual(addressOf({ host: 'pc.tail1234.ts.net' }), { rpId: 'pc.tail1234.ts.net', origin: 'https://pc.tail1234.ts.net', secure: true, webauthn: true, port: 4747 });
  assert.equal(addressOf({ host: 'localhost:4747', 'x-forwarded-host': 'pc.tail1234.ts.net' }).origin, 'https://pc.tail1234.ts.net', 'tailscale serve with a local Host');
  assert.equal(addressOf({ host: 'localhost:4747', 'x-forwarded-host': 'evil.example' }).origin, 'http://localhost:4747', 'only a tailnet name is taken from it');
  assert.equal(addressOf({ host: '127.0.0.1:4747' }).webauthn, false, 'passkeys need a name');
  assert.equal(addressOf({ host: '[::1]:4747' }).webauthn, false);
});

test('RS256 passkeys check out too', () => {
  const key = new FakePasskey({ alg: -257 }), ctx = { challenge: 'r1', origin: 'https://pc.tail1234.ts.net', rpId: 'pc.tail1234.ts.net' };
  const cred = verifyRegistration(key.register(ctx), ctx);
  assert.equal(verifyAssertion(key.assert(ctx), cred, ctx), 1);
});

test('pairing: the console code works once; the hub keeps a hash of the token, never the token', () => {
  const dir = tmp('store');
  const out = [];
  const g = new Guard({ dir, port: PORT, print: s => out.push(s), interactive: true });
  assert.equal(g.paired().length, 0);
  const r = pair(g, out);
  assert.match(r.cookie, /^crux_device_4790=[\w-]{40,}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Strict$/, 'HttpOnly, Strict, no Secure on http://localhost');
  const token = r.cookieHeader.split('=')[1];
  const file = readFileSync(join(dir, 'devices.json'), 'utf8');
  assert.ok(!file.includes(token), 'the token is not stored');
  assert.ok(file.includes(r.key.id), 'the passkey id is');
  assert.equal(g.deviceFor({ cookie: `other=1; ${r.cookieHeader}` }).id, r.device.id);
  assert.equal(g.deviceFor({ cookie: 'crux_device_4791=' + token }), null, 'a cookie named for another port is not this hub\'s');
  // the same code a second time: spent
  assert.throws(() => g.pairOptions({ headers: H, code: codeIn(out), label: 'again' }), /wrong or has expired/);
  // a fresh Guard reads the device back from the file
  assert.equal(new Guard({ dir, port: PORT, print: () => { } }).deviceFor({ cookie: r.cookieHeader })?.label, 'Test PC');
  // over https (the phone), the cookie is Secure
  const p = pair(g, out, { headers: { host: 'pc.tail1234.ts.net', origin: 'https://pc.tail1234.ts.net' }, label: 'iPhone' });
  assert.match(p.cookie, /; Secure$/);
  assert.equal(p.device.rpId, 'pc.tail1234.ts.net');
});

test('pairing refuses numbers for names, wrong origins, and five wrong codes cancel every code', () => {
  const { g, out, clock } = newGuard();
  g.printCode('test');
  assert.throws(() => g.pairOptions({ headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` }, code: codeIn(out) }), /need a name/);
  assert.throws(() => g.pairOptions({ headers: { ...H, origin: 'http://localhost:4791' }, code: codeIn(out) }), /not the hub/);
  const good = codeIn(out);
  for (let i = 0; i < 4; i++) assert.throws(() => g.pairOptions({ headers: H, code: 'AAAA-AAAA' }), /wrong/);
  assert.throws(() => g.pairOptions({ headers: H, code: 'AAAA-AAAB' }), /wrong/);
  assert.throws(() => g.pairOptions({ headers: H, code: good }), /Too many wrong codes/, 'locked for a minute');
  clock.t += 61000;
  assert.throws(() => g.pairOptions({ headers: H, code: good }), /wrong or has expired/, 'and the good code was cancelled');
  // a code expires after 30 minutes
  g.printCode('test');
  clock.t += 31 * 60000;
  assert.throws(() => g.pairOptions({ headers: H, code: codeIn(out) }), /wrong or has expired/);
  // asking for a new code (no device paired yet): at most every 15 seconds
  assert.equal(g.askForCode().printed, true);
  assert.equal(g.askForCode().printed, false);
});

test('no window, no code: nothing is printed or accepted; once a device is paired, asking without a cookie does nothing', () => {
  const { g, out } = newGuard({ interactive: false });
  assert.equal(g.printCode('test'), false);
  assert.deepEqual(g.askForCode(), { printed: false, why: 'nowindow' });
  assert.equal(out.length, 0, 'nothing printed: with no window, output goes to a log file');
  assert.equal(g.codes.size, 0);
  g.codes.set('ABCD-EFGH', { source: 'console', expires: Date.now() + 1e9 });   // even one put there by hand
  assert.throws(() => g.pairOptions({ headers: H, code: 'ABCD-EFGH' }), /wrong or has expired/);
  assert.equal(g.status(H).codeWhere, 'none');
  // in a window: the first device may ask for a code; after that, asking does nothing (codes come from a paired device)
  const w = newGuard();
  pair(w.g, w.out);
  w.clock.t += 60000;
  assert.deepEqual(w.g.askForCode(), { printed: false, why: 'paired' });
  assert.equal(w.g.status(H).codeWhere, 'window');
});

test('the live hub pairs the PC at crux.localhost only; plain localhost page loads move there', () => {
  const { g, out } = newGuard({ port: 4747 });
  g.printCode('test');
  assert.throws(() => g.pairOptions({ headers: { host: 'localhost:4747', origin: 'http://localhost:4747' }, code: codeIn(out) }), /crux\.localhost:4747/);
  const ch = { host: 'crux.localhost:4747', origin: 'http://crux.localhost:4747' };
  const o = g.pairOptions({ headers: ch, code: codeIn(out), label: 'PC' });
  assert.equal(o.publicKey.rp.id, 'crux.localhost');
  const k = new FakePasskey();
  const r = g.pairFinish({ headers: ch, credential: k.register({ challenge: o.publicKey.challenge, origin: 'http://crux.localhost:4747', rpId: 'crux.localhost' }) });
  assert.match(r.cookie, /^crux_device_4747=.*SameSite=Strict$/);
  assert.equal(g.status({ host: '127.0.0.1:4747' }).pcUrl, 'http://crux.localhost:4747');
  assert.equal(g.status({ host: 'localhost:4747' }).webauthn, false, 'the page at plain localhost is sent on, not paired');
  assert.equal(pcRedirect({ method: 'GET', path: '/', url: '/?card=x', host: 'localhost:4747', port: 4747 }), 'http://crux.localhost:4747/?card=x');
  assert.equal(pcRedirect({ method: 'GET', path: '/api/state', url: '/api/state', host: 'localhost:4747', port: 4747 }), null, 'API calls are not moved');
  assert.equal(pcRedirect({ method: 'GET', path: '/', url: '/', host: 'crux.localhost:4747', port: 4747 }), null);
  assert.equal(pcRedirect({ method: 'GET', path: '/', url: '/', host: 'localhost:4791', port: 4791 }), null, 'test hubs stay where they are');
  assert.equal(new Guard({ port: 4791, file: null }).pcUrl, 'http://localhost:4791');
});

test('a device-issued code pairs a second device but cannot start over; the console code can', () => {
  const { g, out } = newGuard();
  const pc = pair(g, out);
  const issued = g.issueCode(pc.device);
  const phoneH = { host: 'pc.tail1234.ts.net', origin: 'https://pc.tail1234.ts.net' };
  assert.throws(() => g.pairOptions({ headers: phoneH, code: issued.code, startOver: true }), /hub's own window/);
  const key = new FakePasskey();
  const o = g.pairOptions({ headers: phoneH, code: issued.code, label: 'iPhone' });
  const r = g.pairFinish({ headers: phoneH, credential: key.register({ challenge: o.publicKey.challenge, origin: 'https://pc.tail1234.ts.net', rpId: 'pc.tail1234.ts.net' }) });
  assert.equal(r.via, 'a code from Test PC');
  assert.equal(g.paired().length, 2);
  // lost passkey: start over with the console code
  g.printCode('test');
  const o2 = g.pairOptions({ headers: H, code: codeIn(out), label: 'New PC', startOver: true });
  const k2 = new FakePasskey();
  const r2 = g.pairFinish({ headers: H, credential: k2.register({ challenge: o2.publicKey.challenge, origin: H.origin, rpId: 'localhost' }) });
  assert.equal(r2.startOver, true);
  assert.deepEqual(r2.removed.map(d => d.label).sort(), ['Test PC', 'iPhone']);
  assert.deepEqual(g.paired().map(d => d.label), ['New PC']);
  assert.equal(g.deviceFor({ cookie: pc.cookieHeader }), null, 'the old PC cookie no longer works');
});

test('step-up: verified once, within a minute, for that change and that device only', () => {
  const { g, out, clock } = newGuard();
  const { device, key } = pair(g, out);
  const need = { purpose: 'project', scope: 'project=c%3A%2Fx;trusted' };
  const ok = g.verifyStepUp({ headers: H, device, stepUp: stepUp(g, device, key, need), need });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.proof.scope, need.scope);
  // replay: the same assertion again
  const a = stepUp(g, device, key, need);
  assert.equal(g.verifyStepUp({ headers: H, device, stepUp: a, need }).ok, true);
  assert.match(g.verifyStepUp({ headers: H, device, stepUp: a, need }).error, /already used/);
  // expiry: more than 60 seconds after the challenge
  const late = stepUp(g, device, key, need);
  clock.t += STEP_UP_MS + 1000;
  assert.match(g.verifyStepUp({ headers: H, device, stepUp: late, need }).error, /more than a minute old/);
  // made for another change
  assert.match(g.verifyStepUp({ headers: H, device, stepUp: stepUp(g, device, key, { purpose: 'push', scope: 'push' }), need }).error, /different change/);
  // asked for on another device
  const other = pair(g, out, { label: 'Other' });
  assert.match(g.verifyStepUp({ headers: H, device: other.device, stepUp: stepUp(g, device, key, need), need }).error, /another device/);
  // no face, fingerprint or PIN
  assert.match(g.verifyStepUp({ headers: H, device, stepUp: stepUp(g, device, key, need, { sign: { flags: UP } }), need }).error, /user verification/);
  // signed on another origin (a test hub on another port relaying)
  assert.match(g.verifyStepUp({ headers: H, device, stepUp: stepUp(g, device, key, need, { sign: { origin: 'http://localhost:4791' } }), need }).error, /not on http:\/\/localhost:4790/);
  // a passkey the hub never paired
  assert.match(g.verifyStepUp({ headers: H, device, stepUp: stepUp(g, device, new FakePasskey(), need), need }).error, /not paired/);
  // nothing sent
  assert.match(g.verifyStepUp({ headers: H, device, stepUp: undefined, need }).error, /Windows Hello or Face ID/);
});

test('the passkey counter keeps its highest value: a 0 or a lower count after a higher one is refused', () => {
  const { g, out } = newGuard();
  const { device, key } = pair(g, out);
  const need = { purpose: 'push', scope: 'push' };
  key.count = 4;
  assert.equal(g.verifyStepUp({ headers: H, device, stepUp: stepUp(g, device, key, need), need }).ok, true);
  assert.equal(device.credential.signCount, 5);
  key.count = -1;   // the next assertion counts 0
  assert.match(g.verifyStepUp({ headers: H, device, stepUp: stepUp(g, device, key, need), need }).error, /counter went backwards/);
  assert.equal(device.credential.signCount, 5, 'never reset to 0');
  key.count = 2;
  assert.match(g.verifyStepUp({ headers: H, device, stepUp: stepUp(g, device, key, need), need }).error, /counter went backwards/);
  key.count = 9;
  assert.equal(g.verifyStepUp({ headers: H, device, stepUp: stepUp(g, device, key, need), need }).ok, true);
  assert.equal(device.credential.signCount, 10);
  // a passkey that never counts (both 0) is fine
  const flat = pair(g, out, { label: 'Flat' });
  flat.key.count = -1;
  assert.equal(g.verifyStepUp({ headers: H, device: flat.device, stepUp: stepUp(g, flat.device, flat.key, need), need }).ok, true);
});

test('a need is cut the same way the challenge cuts it, so a long scope still matches', () => {
  const { g, out } = newGuard();
  const { device, key } = pair(g, out);
  const long = { purpose: 'unpair', scope: 'device=' + 'x'.repeat(600) };
  const need = { purpose: long.purpose, scope: cutScope(long.scope) };
  assert.equal(need.scope.length, 400);
  assert.equal(g.verifyStepUp({ headers: H, device, stepUp: stepUp(g, device, key, long), need }).ok, true, 'challenge() made from the long scope matches the cut need');
  assert.ok(stepUpNeed('POST /api/devices/remove', { id: 'd'.repeat(900) }, {}).scope.length <= 400);
});

test('a pairing push says how the device was paired, not only the name it gave', () => {
  const d = { label: 'iPhone', rpId: 'pc.tail1234.ts.net' };
  assert.equal(pairAlert({ device: d, via: 'a code from Windows PC', removed: [] }).title, 'Device paired with a code from Windows PC: iPhone');
  assert.equal(pairAlert({ device: d, via: 'the code from the hub\'s window', removed: [] }).title, 'Device paired with the code in the hub\'s window: iPhone');
  assert.match(pairAlert({ device: d, via: 'the code from the hub\'s window', removed: [{ label: 'Old PC' }], startOver: true }).title, /^Every device was unpaired, with the code in the hub's window$/);
});

test('a live hub with no device paired restarts into a window; otherwise, and test hubs, with none', () => {
  const calls = [], fake = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() { } }; };
  const spec = { port: 4747, node: 'C:/Program Files/nodejs/node.exe', args: ['C:/hub/server.mjs'], cwd: 'C:/hub' };
  startHub(spec, { window: true, spawnFn: fake, platform: 'win32', env: {} });
  assert.equal(calls[0].cmd, 'cmd.exe');
  assert.equal(calls[0].args.at(-1), '"start "Crux Hub" /min "C:/Program Files/nodejs/node.exe" "C:/hub/server.mjs""');
  assert.equal(calls[0].opts.windowsVerbatimArguments, true);
  assert.equal(calls[0].opts.stdio, 'ignore', 'nothing goes to a log file: the window shows it');
  startHub(spec, { window: false, spawnFn: fake, platform: 'win32', env: {} });
  assert.equal(calls[1].cmd, spec.node, 'detached as before');
  const data = tmp('paired');
  assert.equal(pairedDevices({ CRUX_HUB_DATA: data }), 0);
  writeFileSync(join(data, 'devices.json'), JSON.stringify({ devices: [{ id: 'd1' }, { id: 'dtest', test: true }] }));
  assert.equal(pairedDevices({ CRUX_HUB_DATA: data }), 1);
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(src, /startHub\(launchSpec\(\{ port \}\), \{ window: port === 4747 && !guard\.paired\(\)\.length \}\)/);
  assert.match(readFileSync(new URL('../restart.mjs', import.meta.url), 'utf8'), /const window = port === DEFAULT_PORT && pairedDevices\(\) === 0;/);
});

test('a raise to Trusted is kept as its signed step-up and checked again from scratch', () => {
  const { g, out } = newGuard();
  const { device, key } = pair(g, out);
  const k = 'c:/users/x/proj';
  const need = { purpose: 'project', scope: `${projectTag(k)};trusted` };
  const v = g.verifyStepUp({ headers: H, device, stepUp: stepUp(g, device, key, need), need });
  g.recordRaise(k, v.proof);
  assert.equal(g.raiseBacked(k), true);
  assert.equal(g.raiseBacked('c:/users/x/other'), false, 'not for another project');
  g.raises['c:/users/x/other'] = { ...v.proof, scope: `${projectTag('c:/users/x/other')};trusted` };
  assert.equal(g.raiseBacked('c:/users/x/other'), false, 'a copied record whose scope was edited no longer checks out');
  const conn = { purpose: 'project', scope: `${projectTag(k)};connectors` };
  g.raises[k] = g.verifyStepUp({ headers: H, device, stepUp: stepUp(g, device, key, conn), need: conn }).proof;
  assert.equal(g.raiseBacked(k), false, 'a step-up for connectors is not a raise');
  g.raises[k] = v.proof;
  g.remove(device.id);
  assert.equal(g.raiseBacked(k), false, 'its passkey was unpaired');
});

test('which changes need a step-up', () => {
  const p = { name: 'proj', dir: 'C:/x/proj' };
  const hub = { project: n => { if (n !== 'proj') throw new Error('Unknown project'); return p; }, permissionMode: () => 'auto', connectorsOn: () => false, settings: { all: () => ({ routePermissions: false, permissionTimeoutSec: 120, retireAt: 60 }) } };
  assert.deepEqual(settingsNeed({ project: 'proj', permissionMode: 'trusted' }, hub), { purpose: 'project', scope: `${projectScope('C:/x/proj')};trusted`, why: 'Raise proj to Trusted' });
  assert.match(projectScope('C:/x/proj'), /^project=[0-9a-f]{24}$/, 'a short hash, whatever the path');
  assert.equal(settingsNeed({ project: 'proj', permissionMode: 'standard' }, hub), null, 'lowering: cookie only');
  assert.equal(settingsNeed({ project: 'proj', handoff: { retireAt: 50 } }, hub), null, 'a project\'s own handoff numbers: cookie only');
  assert.match(settingsNeed({ project: 'proj', connectors: true }, hub).scope, /;connectors$/);
  assert.equal(settingsNeed({ project: 'proj', connectors: false }, hub), null);
  assert.equal(settingsNeed({ routePermissions: false }, hub), null, 'orchestrator answers off: cookie only');
  assert.equal(settingsNeed({ routePermissions: true }, hub).purpose, 'hub', 'on: step-up');
  assert.equal(settingsNeed({ project: 'proj', routePermissions: true }, hub).scope, `${projectScope('C:/x/proj')};routing`, 'even beside a project');
  assert.equal(settingsNeed({ permissionTimeoutSec: 300 }, hub).purpose, 'hub');
  assert.equal(settingsNeed({ permissionTimeoutSec: 120 }, hub), null, 'no change, no step-up');
  assert.equal(settingsNeed({ workerHandoffFloorPct: 40 }, hub).purpose, 'hub', 'a hub-wide number added later is covered');
  assert.equal(settingsNeed({ project: 'nope', permissionMode: 'trusted' }, hub), null, 'an unknown project is refused by the route itself');
  assert.equal(stepUpNeed('POST /api/push/subscribe', {}, hub).purpose, 'push');
  assert.equal(stepUpNeed('POST /api/pair/issue', {}, hub).purpose, 'pair');
  assert.equal(stepUpNeed('POST /api/devices/remove', { id: 'd1' }, hub).scope, 'device=d1');
  assert.equal(stepUpNeed('POST /api/approval', {}, hub), null);
  assert.deepEqual([...OPEN_POSTS].sort(), ['/api/pair/code', '/api/pair/finish', '/api/pair/options']);
});

function fakePush() {
  const sent = [];
  return { sent, send: async p => { sent.push(p); return 1; } };
}

test('alerts: a note in every orchestrator thread and a push', async () => {
  const notes = [];
  const hub = { projects: new Map([['a', { name: 'a' }], ['b', { name: 'b' }]]), notice: (p, t, text) => notes.push([p.name, t, text]) };
  const push = fakePush();
  await makeAlert({ hub, push })({ title: 'New device paired: iPhone', note: 'iPhone was paired.' });
  assert.deepEqual(notes, [['a', 'orchestrator', 'iPhone was paired.'], ['b', 'orchestrator', 'iPhone was paired.']]);
  assert.equal(push.sent[0].kind, 'security');
  assert.equal(push.sent[0].title, 'New device paired: iPhone');
  assert.match(push.sent[0].url, /^\/\?card=devices%3A/);
});

test('push: a dropped subscription is told; no subscriptions means nothing is loaded; ids, not endpoints', async () => {
  const dir = tmp('push');
  const p = new Push({ dir, sender: { sendNotification: async s => { if (s.endpoint.endsWith('/gone')) { const e = new Error('gone'); e.statusCode = 410; throw e; } } } });
  p._keys = { publicKey: 'pub', privateKey: 'priv' };
  const told = [];
  p.onDropped = subs => told.push(...subs.map(s => s.label));
  assert.equal(await new Push({ dir: tmp('empty') }).send({ title: 'x' }), 0, 'no subscriptions: returns at once');
  p.subscribe({ endpoint: 'https://push.example/ok', keys: { p256dh: 'a', auth: 'b' } }, 'Phone');
  p.subscribe({ endpoint: 'https://push.example/gone', keys: { p256dh: 'a', auth: 'b' } }, 'Old tablet');
  assert.equal(await p.send({ title: 't' }), 1);
  assert.deepEqual(told, ['Old tablet']);
  const [only] = p.list();
  assert.equal(only.label, 'Phone');
  assert.ok(!JSON.stringify(p.list()).includes('push.example'), 'the list never shows an endpoint');
  assert.equal(p.byId(only.id).endpoint, 'https://push.example/ok');
});

test('the Trusted push carries Undo', () => {
  const [card] = cardsFor({ type: 'project_settings', permissionMode: 'trusted', raised: true, id: 'e1', project: 'proj' });
  assert.deepEqual(payloadOf(card).actions, ['undo']);
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /action: 'undo'/);
  assert.match(sw, /e\.action === 'undo'/);
});

function trustedHub(name) {
  const root = tmp(name), dir = join(root, 'proj');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  const settings = new HubSettings({ file: null });
  settings.setProject(dir, { permissionMode: 'trusted' });
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings, noAgents: true });
  return { hub, p: hub.project('proj'), dir };
}

test('at start, a Trusted project with no raise on record drops to Auto, with a note and a push', () => {
  const { hub, p } = trustedHub('drop');
  const { g } = newGuard();
  const push = fakePush();
  assert.deepEqual(dropUnbackedTrusted({ hub, guard: g, push }), ['proj']);
  assert.equal(hub.permissionMode(p), 'auto');
  assert.ok(p.log.ofType('notice').some(n => n.thread === 'orchestrator' && /no raise from a paired device on record/.test(n.text)));
  assert.equal(push.sent[0].kind, 'level');
  assert.equal(push.sent[0].title, 'proj dropped to Auto');
});

test('at start, a Trusted project whose raise checks out stays Trusted', () => {
  const { hub, p, dir } = trustedHub('keep');
  const { g, out } = newGuard();
  const { device, key } = pair(g, out);
  const need = settingsNeed({ project: 'proj', permissionMode: 'trusted' }, { ...hub, permissionMode: () => 'auto', connectorsOn: () => false, project: n => hub.project(n), settings: hub.settings });
  g.recordRaise(projectKey(dir), g.verifyStepUp({ headers: H, device, stepUp: stepUp(g, device, key, need), need }).proof);
  const push = fakePush();
  assert.deepEqual(dropUnbackedTrusted({ hub, guard: g, push }), []);
  assert.equal(hub.permissionMode(p), 'trusted');
  assert.equal(push.sent.length, 0);
});

test('restart_hub: orchestrator only, with a reason, not within a minute of start; notes, pushes, then restarts', async () => {
  assert.ok(cruxToolNames({ role: 'orchestrator' }).includes('mcp__crux__restart_hub'));
  assert.ok(!cruxToolNames({ role: 'worker' }).includes('mcp__crux__restart_hub'), 'workers do not get it');
  const notes = [], push = fakePush(), env = {};
  let restarted = 0, now = 1_000_000;
  const hub = { notice: (p, t, text) => notes.push([t, text]) };
  hub.restartHub = makeRestartHub({ hub, push, restart: () => restarted++, bootAt: now, now: () => now, delayMs: 0, env });
  const project = { name: 'proj' }, orch = { name: 'orchestrator-4', role: 'orchestrator' };
  assert.match(await restartHub(hub, project, { name: 'w1', role: 'worker' }, 'x'), /Only the orchestrator/);
  assert.match(await restartHub(hub, project, orch, 'merged #53'), /seconds ago/, 'too soon after start');
  now += 61000;
  assert.match(await restartHub(hub, project, orch, '  '), /one-line reason/);
  assert.match(await restartHub(hub, project, orch, 'merged #53'), /Restarting now/);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(restarted, 1);
  assert.deepEqual(notes, [['orchestrator', 'orchestrator-4 restarted the hub: merged #53']]);
  assert.equal(push.sent[0].title, 'The hub is restarting');
  assert.equal(push.sent[0].body, 'Asked by orchestrator-4 in proj', 'the push says who and where, not the reason (C001)');
  assert.match(await restartHub(hub, project, orch, 'again'), /already restarting/);
  assert.match(await restartHub({}, project, orch, 'x'), /cannot restart itself/, 'a hub with no server');
  // at most 3 in 15 minutes: the times travel to the next hub in its environment
  assert.equal(env.CRUX_HUB_RESTARTS.split(',').length, 1);
  for (let i = 0; i < 2; i++) {   // two more restarted hubs, each up for over a minute
    now += 2 * 60000;
    const next = makeRestartHub({ hub, push, restart: () => restarted++, bootAt: now - 61000, now: () => now, delayMs: 0, env });
    assert.match(await next(project, orch, `merge ${i}`), /Restarting now/);
  }
  now += 2 * 60000;
  const fourth = makeRestartHub({ hub, push, restart: () => restarted++, bootAt: now - 61000, now: () => now, delayMs: 0, env });
  assert.match(await fourth(project, orch, 'once more'), /3 times in the last 15 minutes/);
  now += 15 * 60000;
  assert.match(await makeRestartHub({ hub, push, restart: () => { }, bootAt: now - 61000, now: () => now, delayMs: 0, env })(project, orch, 'later'), /Restarting now/, 'fine again later');
});

test('--test-pair: never the live hub', () => {
  const tmpData = join(tmpdir(), 'crux-x', 'data');
  assert.equal(testPairError({ wanted: false, noAgents: false, port: 4747 }), '');
  assert.equal(testPairError({ wanted: true, noAgents: true, port: 4791, env: { CRUX_HUB_DATA: tmpData } }), '');
  assert.match(testPairError({ wanted: true, noAgents: true, port: 4747, env: { CRUX_HUB_DATA: tmpData } }), /4747/);
  assert.match(testPairError({ wanted: true, noAgents: false, port: 4791, env: { CRUX_HUB_DATA: tmpData } }), /no agents/);
  assert.match(testPairError({ wanted: true, noAgents: true, port: 4791, env: {} }), /temp folder/, 'the live data folder');
  assert.match(testPairError({ wanted: true, noAgents: true, port: 4791, env: { CRUX_HUB_DATA: 'C:/Users/x/.crux-hub' } }), /temp folder/);
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.ok(src.indexOf('testPairError(') < src.indexOf('server.listen(port'), 'checked before the hub listens');
  assert.match(src, /if \(pairError\) \{ console\.error\(pairError\); process\.exit\(1\); \}/);
});
