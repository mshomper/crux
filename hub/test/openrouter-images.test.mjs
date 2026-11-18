// Pictures through OpenRouter's image route (POST <base>images): the request, the picture saved like post_visual, the cost taken
// from the provider's own usage.cost (else unknown and counted at the fallback rate), ':free' and unpaid refused, no default
// picture model, a 402 and an SVG-only answer in plain words, and the panel offering OpenRouter for pictures. A local mock server
// on 127.0.0.1 stands in for OpenRouter; nothing leaves this machine. A fake key built at run time.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { PRESETS, ProviderClient } from '../lib/providers.mjs';
import { ProviderKeys, Offload } from '../lib/offload.mjs';
import { cruxTools, cruxToolNames } from '../lib/tools.mjs';
import { hubPanel, hubChanges } from '../public/project-settings.js';
import { outsideDraft, outsideChanges, jobNotes } from '../public/outside-panel.js';

const KEY = ['s', 'k-or-v1-'].join('') + 'fake'.repeat(10);   // built at run time; not a real key
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const MODEL = 'recraft/recraft-v4.1-flash-v2';

const mock = { mode: 'ok', requests: [] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    let json = null; try { json = JSON.parse(body); } catch { /* not json */ }
    mock.requests.push({ path: req.url, headers: req.headers, body: json });
    if (mock.mode === '402') { res.writeHead(402, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `out of credit for ${req.headers.authorization}` } })); }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (!req.url.endsWith('/images')) { res.writeHead(404); return res.end('{}'); }
    if (mock.mode === 'svg') return res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('<svg/>').toString('base64'), media_type: 'image/svg+xml' }], usage: { cost: 0.02 } }));
    if (mock.mode === 'empty') return res.end(JSON.stringify({ data: [] }));
    if (mock.mode === 'url') return res.end(JSON.stringify({ data: [{ url: 'http://169.254.169.254/x.png' }] }));
    const usage = mock.mode === 'nocost' ? { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 } : { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12, cost: 0.0391 };
    return res.end(JSON.stringify({ data: [{ b64_json: PNG_B64, media_type: 'image/png' }], usage }));
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${server.address().port}/v1/`;
after(() => new Promise(r => { server.closeAllConnections?.(); server.close(r); }));
const reset = (mode = 'ok') => { mock.mode = mode; mock.requests.length = 0; };

const protector = { scheme: 'test', protect: s => `sealed:${Buffer.from(s).toString('base64').split('').reverse().join('')}`, unprotect: s => Buffer.from(s.slice(7).split('').reverse().join(''), 'base64').toString() };
const agentOf = { name: 'worker-1', role: 'worker', type: 'implementer', thread: 'worker-1' };

function world(t, { model = MODEL, terms = 'paid', limits = {}, mode = 'any' } = {}) {
  const root = makeTmp('crux-or-images-', t), dir = join(root, 'proj'), data = join(root, 'data');
  mkdirSync(join(dir, '.crux'), { recursive: true }); mkdirSync(data, { recursive: true });
  const settings = new HubSettings({ file: null });
  settings.set({ outsideRoutes: { image: { provider: 'openrouter', model } }, outsideTerms: { openrouter: terms } });
  settings.setProject(dir, { outsideModels: mode, ...limits });
  const keys = new ProviderKeys({ env: { CRUX_HUB_DATA: data }, protector }); keys.save('openrouter', KEY);
  const offload = new Offload({ settings, keys, baseUrls: { openrouter: MOCK }, timeoutMs: 2000 });
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings, noAgents: true, rotateLogs: false, offload });
  return { root, dir, settings, keys, offload, hub, p: hub.project('proj') };
}
const tools = w => cruxTools(w.hub, w.p, agentOf).instance._registeredTools;
const run = async (w, args) => (await tools(w).make_image.handler(args, {})).content[0].text;

test('make_image through OpenRouter: the image route gets the documented request, the picture is saved like post_visual, the reported cost is logged', async t => {
  reset();
  const w = world(t);
  assert.ok(cruxToolNames(agentOf, w.hub, w.p).includes('mcp__crux__make_image'));
  const out = await run(w, { prompt: 'A flat illustration of a lighthouse', aspect_ratio: '16:9' });
  const r = mock.requests.at(-1);
  assert.equal(r.path, '/v1/images');
  assert.equal(r.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(r.body, { model: MODEL, prompt: 'A flat illustration of a lighthouse', n: 1, aspect_ratio: '16:9', output_format: 'png', provider: { data_collection: 'deny' } });
  const v = w.p.log.events.findLast(e => e.type === 'visual');
  assert.match(v.visual, /^[0-9a-f]{32}\.png$/); assert.ok(existsSync(w.p.attachments.path(v.visual)));
  assert.match(v.caption, new RegExp(`lighthouse.*openrouter ${MODEL.replace('/', '\\/')}`));
  assert.match(out, new RegExp(`visual ${v.visual}`)); assert.match(out, /0\.0391 credits as the provider reports/); assert.match(out, / [0-9]+\.[0-9] s\)/);
  const u = w.p.log.events.findLast(e => e.type === 'usage');
  assert.deepEqual([u.via, u.provider, u.model, u.purpose], ['outside', 'openrouter', MODEL, 'make_image']);
  assert.equal(u.costKnown, true); assert.equal(u.costUnit, 'credits'); assert.ok(Math.abs(u.costUSD - 0.0391) < 1e-9);
  assert.ok(!readFileSync(join(w.dir, '.crux', 'events.jsonl'), 'utf8').includes(KEY));
});

test('without a reported cost the cost is unknown and the picture counts at the fallback rate toward the daily cap', async t => {
  reset('nocost');
  const w = world(t, { limits: { outsideUsdPerDay: 0.05 } });
  assert.match(await run(w, { prompt: 'a' }), /cost unknown/);
  const u = w.p.log.events.findLast(e => e.type === 'usage');
  assert.equal(u.costUSD, null); assert.equal(u.costKnown, false);
  reset();
  assert.match(await run(w, { prompt: 'b' }), /^Refused \(budget\)/, 'held by the cap');
  assert.equal(mock.requests.length, 0);
});

test('no default picture model: the route needs one typed, a :free model and an unpaid plan are refused, nothing is sent', async t => {
  reset();
  assert.equal(PRESETS.openrouter.imageModel, null, 'no default');
  const s = new HubSettings({ file: null });
  s.set({ outsideRoutes: { image: { provider: 'openrouter', model: '' } } });
  assert.equal(s.get('outsideRoutes').image, undefined, 'a picture route with no model is not saved');
  s.set({ outsideRoutes: { image: { provider: 'ollama', model: 'x' } } });
  assert.equal(s.get('outsideRoutes').image, undefined, 'Ollama makes no pictures');
  s.set({ outsideRoutes: { image: { provider: 'openrouter', model: MODEL } } });
  assert.equal(s.get('outsideRoutes').image.model, MODEL);
  await assert.rejects(() => new ProviderClient({ provider: 'openrouter', model: 'm', apiKey: KEY, baseUrl: MOCK }).image({ prompt: 'p' }), e => e.kind === 'no-image', 'a client with no picture model refuses');
  const free = world(t, { model: 'some/model:free' });
  assert.match(await run(free, { prompt: 'x' }), /^Refused \(terms\)/);
  const unpaid = world(t, { terms: 'unknown' });
  assert.match(await run(unpaid, { prompt: 'x' }), /^Refused \(terms\)/);
  assert.equal(mock.requests.length, 0);
});

test('plain failures: a 402 says the account has no credit (and not the provider\'s words), an SVG-only or empty or address-only answer is refused, the picture is not stored', async t => {
  const w = world(t);
  reset('402');
  const out = await run(w, { prompt: 'x' });
  assert.match(out, /^Refused \(no-credit\).*no credit/);
  assert.ok(!out.includes(KEY) && !/out of credit for/.test(out));
  for (const mode of ['svg', 'empty', 'url']) {
    reset(mode);
    assert.match(await run(w, { prompt: 'x' }), /^Refused \(bad-answer\)/, mode);
  }
  assert.equal(mock.requests.length, 1, 'the last mode asked once, no retry and no fetch of the address it named');
  assert.equal(w.p.log.events.filter(e => e.type === 'visual').length, 0);
});

test('the panel offers OpenRouter for pictures, asks for its model (no default), and marks a :free or unpriced one', () => {
  const INFO = { keys: { openrouter: { saved: true, end: 'WXYZ' } }, canProtect: true, priced: { text: [], image: ['gemini-nano-banana-2.1'] },
    providers: { google: { images: true, imageModel: 'gemini-nano-banana-2.1' }, openai: { images: true, imageModel: 'gpt-image-2' }, openrouter: { images: true, imageModel: null }, ollama: { images: false, imageModel: null, local: true } } };
  const PSET = { routePermissions: true, permissionTimeoutSec: 300, retireAt: 60, idleHandoffMin: 60, idleFloorPct: 25, workerRetireAt: 60, workerHandoffFloorPct: 35 };
  const nums = { permissionTimeoutSec: '300', retireAt: '60', idleHandoffMin: '60', idleFloorPct: '25', workerRetireAt: '60', workerHandoffFloorPct: '35' };
  const draft = (mutate) => { const o = outsideDraft(PSET, INFO); mutate?.(o); o.errors = {}; return { o, d: { route: true, nums, errors: o.errors, outside: o } }; };
  const { o, d } = draft(x => { x.routes.image = { provider: 'openrouter', model: '' }; x.terms.openrouter = 'paid'; });
  const html = hubPanel(d);
  const picture = html.slice(html.indexOf('data-ps-job="image"'));
  assert.ok(picture.includes('data-ps-seg="job-image" data-v="openrouter"'), 'OpenRouter is offered for pictures');
  assert.ok(!picture.includes('data-ps-seg="job-image" data-v="ollama"'), 'Ollama still is not');
  assert.match(picture, /Picture model, as the provider writes it \(no default\)/);
  const ch = hubChanges(PSET, d);
  assert.equal(ch.errors['route-image'], 'Needs a model name'); assert.equal(ch.body.outsideRoutes, undefined);
  const typed = draft(x => { x.routes.image = { provider: 'openrouter', model: MODEL }; x.terms.openrouter = 'paid'; });
  assert.deepEqual(outsideChanges(PSET, typed.o).body.outsideRoutes, { image: { provider: 'openrouter', model: MODEL } });
  assert.deepEqual(outsideChanges(PSET, draft(x => { x.routes.image = { provider: 'google', model: '' }; }).o).errors, {}, 'Google keeps its own default');
  assert.match(jobNotes('image', typed.o).join(' '), /OpenRouter's own cost figure is used when it comes back/);
  assert.match(jobNotes('image', draft(x => { x.routes.image = { provider: 'openrouter', model: 'a/b:free' }; x.terms.openrouter = 'paid'; }).o).join(' '), /free models can keep what is sent/);
});

test('the hub tells the panel which providers can make pictures', t => {
  const w = world(t);
  const p = w.offload.info().providers;
  assert.deepEqual([p.google.images, p.openai.images, p.openrouter.images, p.ollama.images], [true, true, true, false]);
  assert.equal(p.openrouter.imageModel, null);
});
