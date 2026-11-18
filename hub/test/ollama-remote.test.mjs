// Decision 82 A: Ollama on one of the owner's Tailscale machines. The address rule (good and bad, look-alikes included), Local
// accepted for a Tailscale address, the free-memory guard and the unload skipped for a remote address, a plain failure when it
// does not answer, no redirects, the cloud-tag refusal for every address, and the panel's Ollama address box. No network: the
// remote address is only ever given to an injected fetch, and a local mock server stands in for this PC's own Ollama.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { ollamaAddress, isTailscaleIp, showAddress } from '../public/ollama-address.js';
import { ProviderClient, ProviderError } from '../lib/providers.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { Offload, ProviderKeys } from '../lib/offload.mjs';
import { cruxTools } from '../lib/tools.mjs';
import { hubPanel, hubChanges } from '../public/project-settings.js';
import { outsideDraft, outsideChanges, jobNotes, outsideInput, ollamaStatus } from '../public/outside-panel.js';

const GOOD = ['http://100.101.102.103:11434', 'https://100.64.0.1:11434', 'http://100.127.255.254:8080', '100.100.1.2:11434', 'http://my-pc.tail1234.ts.net:11434', 'https://My-PC.Tail1234.TS.NET:11434', 'http://100.101.102.103:11434/v1', 'http://100.101.102.103:11434/v1/'];
const BAD = [
  'http://100.63.255.255:11434', 'http://100.128.0.1:11434', 'http://100.0.0.1:11434', 'http://101.100.1.2:11434', 'http://10.0.0.5:11434', 'http://192.168.1.20:11434', 'http://172.16.0.9:11434',   // look-alike and private-LAN addresses
  'http://evil.ts.net.example.com:11434', 'http://ts.net:11434', 'http://.ts.net:11434', 'http://evilts.net:11434', 'http://my-pc.ts.net.:11434', 'http://example.com:11434', 'http://pc.tailscale.com:11434',
  'http://100.101.102.103', 'https://my-pc.tail1234.ts.net',   // no port
  'ftp://100.101.102.103:11434', 'file:///etc/passwd', 'javascript:alert(1)',
  'http://user:pw@100.101.102.103:11434', 'http://100.101.102.103:11434/other', 'http://100.101.102.103:11434/v1?x=1', 'http://100.101.102.103:11434/#frag',
  'http://100.101.102.103.example.com:11434', 'http://[fd7a:115c:a1e0::1]:11434', 'http://0.0.0.0:11434', 'http://169.254.169.254:80/', 'not an address at all', 'http://', 'http://100.101.102.103:11434@evil.example.com'
];

test('the address rule: this PC and Tailscale machines in, everything else out (look-alikes too)', () => {
  for (const a of GOOD) { const r = ollamaAddress(a); assert.equal(r.ok, true, a); assert.equal(r.kind, 'tailscale', a); assert.match(r.base, /\/v1\/$/); }
  for (const a of BAD) assert.equal(ollamaAddress(a).ok, false, `${a} is refused`);
  for (const a of ['http://127.0.0.1:11434/v1/', 'http://localhost:11434', 'http://[::1]:11434/v1']) assert.equal(ollamaAddress(a).kind, 'loopback', a);
  assert.deepEqual(ollamaAddress('https://My-PC.Tail1234.TS.NET:11434'), { ok: true, kind: 'tailscale', host: 'my-pc.tail1234.ts.net', port: '11434', origin: 'https://my-pc.tail1234.ts.net:11434', base: 'https://my-pc.tail1234.ts.net:11434/v1/' }, 'names are lower-cased');
  assert.equal(ollamaAddress('https://my-pc.tail1234.ts.net:443').ok, false, 'a default port is dropped by the address parser, so it counts as no port: write the port Ollama listens on');
  assert.equal(ollamaAddress('100.100.1.2:11434').origin, 'http://100.100.1.2:11434', 'a bare host and port counts as http');
  assert.equal(ollamaAddress('').empty, true);
  // other spellings of an address are judged by what they really are
  assert.equal(ollamaAddress('http://0x64.0x65.0x66.0x67:11434').ok, true, 'hex spelling of 100.101.102.103 is the same machine');
  assert.equal(ollamaAddress('http://0x0a.0x00.0x00.0x05:11434').ok, false, 'hex spelling of 10.0.0.5 is a LAN address');
  assert.equal(ollamaAddress('http://1684234849:11434').ok, true, 'one big number: 100.101.102.103');
  assert.equal(ollamaAddress('http://2130706433:11434').kind, 'loopback', 'one big number: 127.0.0.1');
  assert.equal(isTailscaleIp('100.64.0.0'), true); assert.equal(isTailscaleIp('100.63.255.255'), false); assert.equal(isTailscaleIp('100.128.0.0'), false);
  assert.equal(showAddress('http://100.101.102.103:11434/v1/'), 'http://100.101.102.103:11434');
});

// a fetch that records what it was asked and answers like Ollama's /v1/chat/completions
function fakeFetch(mode = 'ok') {
  const f = async (url, init) => {
    f.calls.push({ url: String(url), init });
    if (mode === 'down') throw new TypeError('fetch failed');
    if (mode === 'hang') return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok from the second PC' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  f.calls = [];
  return f;
}
const REMOTE = 'http://100.101.102.103:11434';

test('a Tailscale address skips the free-memory guard and the unload; this PC keeps both', async () => {
  let reads = 0;
  const vram = async () => { reads++; return 1; };   // would refuse as busy
  const remote = new ProviderClient({ provider: 'ollama', model: 'gemma3:12b', baseUrl: REMOTE, fetchFn: fakeFetch(), vramReader: vram });
  assert.equal(remote.remote, true);
  const f = fakeFetch(); remote.fetchFn = f;
  const r = await remote.chat({ system: 's', user: 'u' });
  assert.equal(r.text, 'ok from the second PC'); assert.equal(r.provider, 'ollama'); assert.equal(r.costUSD, 0);
  assert.equal(reads, 0, 'the guard did not run');
  assert.deepEqual(f.calls.map(c => c.url), [`${REMOTE}/v1/chat/completions`], 'no unload call: only the one job');
  assert.equal(f.calls[0].init.headers.authorization, undefined, 'no key for Ollama');
  // this PC: the guard refuses a busy card, and the unload follows a good call
  const local = new ProviderClient({ provider: 'ollama', model: 'gemma3:4b', baseUrl: 'http://127.0.0.1:11434/v1/', fetchFn: fakeFetch(), vramReader: vram });
  assert.equal(local.remote, false);
  await assert.rejects(() => local.chat({ system: 's', user: 'u' }), e => e.kind === 'busy');
  assert.equal(reads, 1);
  const lf = fakeFetch(); const ok = new ProviderClient({ provider: 'ollama', model: 'gemma3:4b', baseUrl: 'http://127.0.0.1:11434/v1/', fetchFn: lf, vramReader: async () => 16000 });
  await ok.chat({ system: 's', user: 'u' });
  assert.deepEqual(lf.calls.map(c => new URL(c.url).pathname), ['/v1/chat/completions', '/api/generate'], 'this PC: the unload follows');
});

test('a second PC that does not answer fails plainly, once, with the name, and no model is tried instead', async () => {
  const down = fakeFetch('down');
  const c = new ProviderClient({ provider: 'ollama', model: 'gemma3:12b', baseUrl: 'https://my-pc.tail1234.ts.net:11434', fetchFn: down });
  await assert.rejects(() => c.chat({ system: 's', user: 'u' }), e => e instanceof ProviderError && e.kind === 'unreachable' && e.message === 'Ollama at my-pc.tail1234.ts.net did not answer.' && e.provider === 'ollama');
  assert.equal(down.calls.length, 1, 'no retry, and no unload to a machine that is not there');
  // asleep: the call hangs until its own timeout, and says the same
  const hang = fakeFetch('hang');
  const slow = new ProviderClient({ provider: 'ollama', model: 'm', baseUrl: REMOTE, fetchFn: hang, timeoutMs: 150 });
  const t0 = Date.now();
  await assert.rejects(() => slow.chat({ system: 's', user: 'u' }), e => e.kind === 'unreachable' && e.message === 'Ollama at 100.101.102.103 did not answer.');
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(hang.calls.length, 1);
  assert.equal(new ProviderClient({ provider: 'ollama', model: 'm', baseUrl: REMOTE }).timeoutMs, 120000, 'the timeout stays at 120 seconds');
  // this PC that is off keeps its own plain words
  const here = new ProviderClient({ provider: 'ollama', model: 'm', baseUrl: 'http://127.0.0.1:11434/v1/', fetchFn: fakeFetch('down'), vramReader: async () => 16000 });
  await assert.rejects(() => here.chat({ system: 's', user: 'u' }), e => e.kind === 'network');
});

test('a redirect is never followed to another address; every bad address is refused when the client is made', async () => {
  const f = fakeFetch('redirect');
  const c = new ProviderClient({ provider: 'ollama', model: 'm', baseUrl: REMOTE, fetchFn: f });
  await assert.rejects(() => c.chat({ system: 's', user: 'u' }), e => e.kind === 'refused' && !/169/.test(e.message));
  assert.equal(f.calls.length, 1, 'only the saved address was asked');
  assert.equal(f.calls[0].init.redirect, 'manual', 'the fetch is told not to follow');
  for (const bad of ['http://192.168.1.20:11434', 'http://100.63.1.1:11434', 'http://evil.ts.net.example.com:11434', 'https://example.com'])
    assert.throws(() => new ProviderClient({ provider: 'ollama', model: 'm', baseUrl: bad }), e => e instanceof ProviderError && e.kind === 'address' && /Tailscale/.test(e.message), bad);
});

// ---------- through the hub's settings and the Local rule ----------
const protector = { scheme: 'test', protect: s => `sealed:${s}`, unprotect: s => s.slice(7) };
function world(t, { mode = 'local', routes } = {}) {
  const root = makeTmp('crux-ollama-remote-', t), dir = join(root, 'proj'), data = join(root, 'data');
  mkdirSync(join(dir, '.crux'), { recursive: true }); mkdirSync(data, { recursive: true });
  const settings = new HubSettings({ file: null });
  settings.set({ outsideRoutes: routes || { ask: { provider: 'ollama', model: 'gemma3:12b', baseUrl: REMOTE }, draft: { provider: 'ollama', model: 'gemma3:12b', baseUrl: REMOTE } } });
  settings.setProject(dir, { outsideModels: mode });
  const fetchFn = fakeFetch();
  const offload = new Offload({ settings, keys: new ProviderKeys({ env: { CRUX_HUB_DATA: data }, protector }), fetchFn, vramReader: async () => 1 });
  return { root, dir, settings, offload, fetchFn };
}

test('a Tailscale address counts as Local: a project set to Local uses it, with the guard skipped; a cloud provider still cannot', async t => {
  const w = world(t, { mode: 'local' });
  assert.equal(w.settings.get('outsideRoutes').ask.baseUrl, `${REMOTE}/v1/`, 'saved as the address the hub calls');
  assert.deepEqual(w.offload.plan(w.dir, 'ask'), { mode: 'local', job: 'ask', provider: 'ollama', model: 'gemma3:12b' });
  const r = await w.offload.chat(w.dir, { system: 's', user: 'u' }, 'ask');
  assert.equal(r.text, 'ok from the second PC');
  assert.equal(w.fetchFn.calls.length, 1); assert.equal(w.fetchFn.calls[0].url, `${REMOTE}/v1/chat/completions`);
  const cloud = world(t, { mode: 'local', routes: { ask: { provider: 'google', model: 'm' } } });
  assert.equal(cloud.offload.plan(cloud.dir, 'ask'), null, 'Google is still not Local');
  // and Any may use it too (no key and no plan terms are asked of a machine of yours)
  const any = world(t, { mode: 'any' });
  assert.equal((await any.offload.chat(any.dir, { system: 's', user: 'u' }, 'ask')).provider, 'ollama');
});

test('the cloud-tag refusal stays for every Ollama address and every mode', async t => {
  for (const [mode, baseUrl] of [['local', REMOTE], ['any', REMOTE], ['local', undefined], ['any', undefined]]) {
    const w = world(t, { mode, routes: { ask: { provider: 'ollama', model: 'gpt-oss:20b-cloud', ...(baseUrl ? { baseUrl } : {}) } } });
    assert.throws(() => w.offload.client(w.dir, 'ask'), e => e.kind === 'refused', `${mode} ${baseUrl || 'this PC'}`);
    assert.equal(w.fetchFn.calls.length, 0);
  }
});

test('settings refuse a bad Ollama address at save: the route is not kept; a good one is saved normalised', t => {
  const root = makeTmp('crux-ollama-settings-', t), file = join(root, 'settings.json');
  const s = new HubSettings({ file });
  for (const bad of ['http://192.168.1.20:11434', 'http://100.63.0.1:11434', 'http://evil.ts.net.example.com:11434', 'http://100.101.102.103'])
    { s.set({ outsideRoutes: { ask: { provider: 'ollama', model: 'm', baseUrl: bad } } }); assert.equal(s.get('outsideRoutes').ask, undefined, bad); }
  assert.ok(!/192\.168|evil/.test(readFileSync(file, 'utf8')), 'a refused address never reaches settings.json');
  s.set({ outsideRoutes: { ask: { provider: 'ollama', model: 'gemma3:12b', baseUrl: '100.101.102.103:11434' } } });
  assert.equal(s.get('outsideRoutes').ask.baseUrl, 'http://100.101.102.103:11434/v1/');
  assert.equal(new HubSettings({ file }).get('outsideRoutes').ask.baseUrl, 'http://100.101.102.103:11434/v1/', 'and kept across a restart');
  // an address typed by hand into the file is dropped at load too, and the job reads as not set
  const hand = makeTmp('crux-ollama-hand-', t), hf = join(hand, 'settings.json');
  mkdirSync(hand, { recursive: true });
  writeFileSync(hf, JSON.stringify({ outsideRoutes: { ask: { provider: 'ollama', model: 'm', baseUrl: 'http://192.168.1.20:11434' } } }));
  assert.equal(new HubSettings({ file: hf }).get('outsideRoutes').ask, undefined);
});

test('an agent cannot choose or change the address: the tool takes no address and the route is the hub\'s', async t => {
  const w = world(t);
  const hub = { memory: { personalize: s => s }, offload: w.offload };
  const project = { dir: w.dir, name: 'proj', board: {}, log: { events: [], append() { } }, hubWide: false };
  const rt = cruxTools(hub, project, { name: 'a', role: 'worker', thread: 'a' }).instance._registeredTools;
  for (const n of ['ask_outside_model', 'draft_with_outside_model']) {
    const fields = Object.keys(rt[n].inputSchema.shape);
    assert.ok(!fields.some(f => /url|address|host|base|provider|model/i.test(f)), `${n}: ${fields}`);
  }
});

// ---------- the panel ----------
const INFO = { keys: {}, canProtect: true, priced: { text: [], image: [] }, providers: { google: { imageModel: 'gemini-nano-banana-2.1' }, openai: { imageModel: 'gpt-image-2' }, openrouter: { imageModel: null }, ollama: { imageModel: null, local: true } } };
const PSET = { routePermissions: true, permissionTimeoutSec: 300, retireAt: 60, idleHandoffMin: 60, idleFloorPct: 25, workerRetireAt: 60, workerHandoffFloorPct: 35 };
const PNUMS = { permissionTimeoutSec: '300', retireAt: '60', idleHandoffMin: '60', idleFloorPct: '25', workerRetireAt: '60', workerHandoffFloorPct: '35' };
const panel = (settings = {}, mutate = null) => { const o = outsideDraft({ ...PSET, ...settings }, INFO); mutate?.(o); o.errors = {}; return { o, d: { route: true, nums: PNUMS, errors: o.errors, outside: o } }; };

test('the panel has an Ollama address box (placeholder this PC), says what an address is, and marks a refused one', () => {
  const { d } = panel();
  const html = hubPanel(d);
  assert.match(html, /data-ps-keybox="ollama"/);
  assert.match(html, /data-ps-ollama placeholder="This PC"/);
  assert.match(html, /Using Ollama on this PC\./);
  assert.match(html, /name ending|your own machines on Tailscale/, 'hover help says what is accepted');
  const good = panel({ outsideRoutes: { ask: { provider: 'ollama', model: 'gemma3:12b', baseUrl: `${REMOTE}/v1/` } } });
  assert.equal(good.o.ollama, REMOTE, 'the box shows the saved address without /v1/');
  assert.match(hubPanel(good.d), /Your Tailscale machine 100\.101\.102\.103\. Jobs there count as Local\./);
  assert.deepEqual(jobNotes('ask', good.o), []);
  // a refused address: the box says why, the job gets an amber note, Done sends nothing and shows the error
  const bad = panel({ outsideRoutes: { ask: { provider: 'ollama', model: 'gemma3:12b' } } }, o => { o.ollama = 'http://192.168.1.20:11434'; });
  assert.match(hubPanel(bad.d), /Refused: Only this PC or one of your Tailscale machines/);
  assert.match(jobNotes('ask', bad.o).join(' '), /Ollama address is refused/);
  const ch = hubChanges(PSET, bad.d);
  assert.match(ch.errors['ollama-address'], /Tailscale/); assert.equal(ch.body.outsideRoutes, undefined);
  assert.match(hubPanel({ ...bad.d, errors: ch.errors }), /role="alert">[^]*Only this PC/);
  assert.equal(ollamaStatus('evil.ts.net.example.com:11434').cls, 'warn');
  assert.equal(ollamaStatus('my-pc.tail1234.ts.net:11434').cls, 'ok');
});

test('Done sends the address on every Ollama job, leaves cloud jobs alone, and an empty box means this PC', () => {
  const settings = { outsideRoutes: { ask: { provider: 'ollama', model: 'gemma3:12b' }, draft: { provider: 'google', model: 'gemini-3.5-flash-lite' } }, outsideTerms: { google: 'paid' } };
  const set = panel(settings, o => { o.ollama = 'https://my-pc.tail1234.ts.net:11434'; o.routes.draft = { provider: 'ollama', model: 'gemma3:12b' }; });
  const ch = outsideChanges({ ...PSET, ...settings }, set.o);
  assert.deepEqual(ch.errors, {});
  assert.deepEqual(ch.body.outsideRoutes, { ask: { provider: 'ollama', model: 'gemma3:12b', baseUrl: 'https://my-pc.tail1234.ts.net:11434/v1/' }, draft: { provider: 'ollama', model: 'gemma3:12b', baseUrl: 'https://my-pc.tail1234.ts.net:11434/v1/' } });
  const cleared = panel({ outsideRoutes: { ask: { provider: 'ollama', model: 'gemma3:12b', baseUrl: `${REMOTE}/v1/` } } }, o => { o.ollama = ''; });
  assert.deepEqual(outsideChanges({ ...PSET, outsideRoutes: { ask: { provider: 'ollama', model: 'gemma3:12b', baseUrl: `${REMOTE}/v1/` } } }, cleared.o).body.outsideRoutes, { ask: { provider: 'ollama', model: 'gemma3:12b' } });
  const same = panel({ outsideRoutes: { ask: { provider: 'ollama', model: 'gemma3:12b', baseUrl: `${REMOTE}/v1/` } } });
  assert.deepEqual(outsideChanges({ ...PSET, outsideRoutes: { ask: { provider: 'ollama', model: 'gemma3:12b', baseUrl: `${REMOTE}/v1/` } } }, same.o).body, {}, 'unchanged: nothing is sent');
  // typing updates the line in place and keeps the draft
  const line = { className: '', innerHTML: '' }, box = { querySelector: () => line }, input = { matches: s => s === '[data-ps-ollama]', value: 'http://100.101.102.103:11434', closest: () => box };
  outsideInput(input, set.o);
  assert.equal(set.o.ollama, 'http://100.101.102.103:11434'); assert.match(line.className, /ok/); assert.match(line.innerHTML, /Your Tailscale machine/);
});
