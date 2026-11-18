// Decision 81 A, over HTTP against a real test hub (own port, never 4747 or 4748; --no-agents --test-pair; every folder in temp,
// deleted afterwards): the key route needs the step-up, saves the key protected, answers with its last four characters only, never
// shows it again (state, files other than the protected key file, the hub's own output), and removes it. A fake key only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request, createServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp, removeTmp } from './helpers/tmp.mjs';
import { pidsOnPort, stopTree } from '../lib/relaunch.mjs';

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const FAKE = 'AIzaFAKE-fake-fake-fake-0000-WXYZ';   // not a real key

let port, child, out = '', root;
function call(method, path, body) {
  return new Promise((ok, bad) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const host = `localhost:${port}`;
    const headers = { host, ...(payload ? { 'content-type': 'application/json', origin: `http://${host}`, 'content-length': payload.length } : {}) };
    const r = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      const parts = [];
      res.on('data', x => parts.push(x));
      res.on('end', () => { const text = Buffer.concat(parts).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { } ok({ status: res.statusCode, json, text }); });
    });
    r.on('error', bad);
    if (payload) r.write(payload);
    r.end();
  });
}

const allFiles = dir => !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]);

test('over HTTP: the outside key route asks for the step-up, saves protected, shows the last four only, and removes', { skip: process.platform !== 'win32' && 'the protected key store is Windows only' }, async t => {
  do { port = await freePort(); } while (port === 4747 || port === 4748);
  const rport = await freePort();
  root = makeTmp('crux-outside-keys-');
  const proj = join(root, 'proj'), data = join(root, 'data'), crux = join(root, 'crux');
  for (const d of [join(proj, '.crux'), join(root, 'home'), crux, data]) mkdirSync(d, { recursive: true });
  child = spawn(process.execPath, [join(HUB, 'server.mjs'), '--port', String(port), '--remote-port', String(rport), '--no-agents', '--test-pair', proj], {
    cwd: HUB, windowsHide: true,
    env: { ...process.env, CRUX_HUB_DATA: data, CRUX_HOME: crux, USERPROFILE: join(root, 'home'), HOME: join(root, 'home'), CRUX_HUB_AGENTS: '0', CRUX_HUB_PORT: '', CRUX_HUB_RESTARTED: '' }
  });
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  t.after(async () => {
    assert.notEqual(port, 4747); assert.notEqual(port, 4748);
    try { child.kill(); } catch { }
    for (const pid of await pidsOnPort(port)) await stopTree(pid);
    await sleep(500);
    removeTmp(root);
  });
  for (let i = 0; i < 100 && !out.includes('Crux hub: http'); i++) await sleep(100);
  assert.ok(out.includes(`Crux hub: http://127.0.0.1:${port}`), `the test hub started:\n${out}`);

  // nothing saved: the page is told so, and the price table and picture models, not a key
  const s0 = (await call('GET', '/api/state')).json;
  assert.deepEqual(s0.outsideInfo.keys, {});
  assert.ok(s0.outsideInfo.priced.text.includes('gemini-3.5-flash-lite') && s0.outsideInfo.providers.google.imageModel);
  assert.equal(s0.settings.outsideRoutes, undefined, 'no provider is set until one is saved');

  // a big change: asks first, and the ask does not hold the key
  const ask = await call('POST', '/api/outside/key', { provider: 'google', apiKey: FAKE });
  assert.equal(ask.status, 403, ask.text);
  assert.equal(ask.json.stepUp.purpose, 'outside-key');
  assert.ok(!ask.text.includes(FAKE), 'the refusal does not echo the key');
  assert.deepEqual((await call('GET', '/api/state')).json.outsideInfo.keys, {}, 'nothing saved without the step-up');

  const saved = await call('POST', '/api/outside/key', { provider: 'google', apiKey: FAKE, stepUp: { fallback: true } });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.json.outsideInfo.keys, { google: { saved: true, end: 'WXYZ' } });
  assert.ok(!saved.text.includes(FAKE), 'the answer carries only the last four');

  const state = await call('GET', '/api/state');
  assert.deepEqual(state.json.outsideInfo.keys, { google: { saved: true, end: 'WXYZ' } });
  assert.ok(!state.text.includes(FAKE), 'the page state never has the key');
  assert.ok(!out.includes(FAKE), 'the hub\'s own output never has the key');
  const keyFile = join(data, 'provider-keys.json');
  assert.ok(existsSync(keyFile) && !readFileSync(keyFile, 'utf8').includes(FAKE), 'the key file holds the protected text only');
  for (const f of allFiles(root)) {
    if (f === keyFile) continue;
    assert.ok(!readFileSync(f).includes(FAKE), `${f} does not hold the key`);   // events, settings, logs: nowhere else
  }

  // a bad key shape is refused in plain words that do not repeat it; an unknown provider and Ollama take no key
  const bad = await call('POST', '/api/outside/key', { provider: 'openai', apiKey: 'short', stepUp: { fallback: true } });
  assert.notEqual(bad.status, 200); assert.ok(!bad.text.includes('short"') || /look like a key/.test(bad.text));
  assert.match(bad.text, /does not look like a key/);
  assert.notEqual((await call('POST', '/api/outside/key', { provider: 'ollama', apiKey: FAKE, stepUp: { fallback: true } })).status, 200);
  assert.deepEqual((await call('GET', '/api/state')).json.outsideInfo.keys, { google: { saved: true, end: 'WXYZ' } });

  // routes and plans are saved by the ordinary settings route (a whole-hub change)
  const routes = { outsideRoutes: { ask: { provider: 'google', model: 'gemini-3.5-flash-lite' }, draft: { provider: 'google', model: 'gemini-3.5-flash-lite' }, image: { provider: 'google', model: '' } }, outsideTerms: { google: 'paid' } };
  const r = await call('POST', '/api/settings', { ...routes, stepUp: { fallback: true } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.settings.outsideRoutes.image, { provider: 'google', model: null });
  assert.equal((await call('GET', '/api/state')).json.settings.outsideTerms.google, 'paid');

  const gone = await call('POST', '/api/outside/key', { provider: 'google', remove: true, stepUp: { fallback: true } });
  assert.equal(gone.status, 200, gone.text);
  assert.deepEqual(gone.json.outsideInfo.keys, {});
  assert.ok(!readFileSync(keyFile, 'utf8').includes('protected'), 'removed from the file');
});
