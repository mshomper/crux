// Decision 80: the two outside jobs on Google (make_image and draft_with_outside_model), the per-project switch on the project
// card, and the hub's provider panel. Everything runs against a local mock server on 127.0.0.1 (port 0); nothing leaves this
// machine. One fixed dummy key; temp folders in the OS temp folder, removed afterwards.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { ProviderClient, ProviderError, findImage, IMAGE_PRICES } from '../lib/providers.mjs';
import { ProviderKeys, Offload, draftOutside, DRAFT_MAX_SOURCE } from '../lib/offload.mjs';
import { cruxTools, cruxToolNames } from '../lib/tools.mjs';
import { settingsNeed } from '../lib/guard.mjs';
import { projectCard, projectChanges, hubPanel, hubChanges, OUTSIDE_CHOICES } from '../public/project-settings.js';

const DUMMY_KEY = 'dummy-key-0000-NOT-REAL-5678wxyz';
// a real 1x1 PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ---------- the mock server ----------
// mode: ok | rate-limit | noimage | length. requests: what reached it.
const mock = { mode: 'ok', requests: [] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    let json = null; try { json = JSON.parse(body); } catch { /* not json */ }
    mock.requests.push({ path: req.url, headers: req.headers, body: json });
    if (mock.mode === 'rate-limit') { res.writeHead(429, { 'retry-after': '9', 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `no billing for key ${req.headers['x-goog-api-key']}` } })); }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.endsWith('/interactions')) {
      if (mock.mode === 'noimage') return res.end(JSON.stringify({ id: 'i1', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'I cannot draw that.' }] }] }));
      return res.end(JSON.stringify({ id: 'i1', status: 'completed', steps: [{ type: 'user_input', content: [{ type: 'text', text: 'x' }] }, { type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: PNG_B64 }] }],
        usage: { total_input_tokens: 20, total_output_tokens: 1120, total_tokens: 1140 } }));
    }
    if (req.url.endsWith('/chat/completions')) {
      return res.end(JSON.stringify({ id: 'c1', model: json.model, choices: [{ index: 0, message: { role: 'assistant', content: '## Done\nPlanting went ahead.\n## Next\nWater the beds.' }, finish_reason: mock.mode === 'length' ? 'length' : 'stop' }], usage: { prompt_tokens: 400, completion_tokens: 80 } }));
    }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${server.address().port}/v1/`;
after(() => new Promise(r => { server.closeAllConnections?.(); server.close(r); }));
const reset = (mode = 'ok') => { mock.mode = mode; mock.requests.length = 0; };

const protector = { scheme: 'test', protect: s => `sealed:${Buffer.from(s).toString('base64').split('').reverse().join('')}`, unprotect: s => Buffer.from(s.slice(7).split('').reverse().join(''), 'base64').toString() };
const agentOf = { name: 'worker-1', role: 'worker', type: 'implementer', thread: 'worker-1' };

function world(t, { mode = 'any', terms = 'paid', keySaved = true, limits = {} } = {}) {
  const root = makeTmp('crux-outside-jobs-', t), dir = join(root, 'proj'), data = join(root, 'hubdata');
  mkdirSync(join(dir, '.crux'), { recursive: true }); mkdirSync(data, { recursive: true });
  const settings = new HubSettings({ file: null });
  settings.set({ outsideProvider: { provider: 'google', model: 'gemini-3.5-flash-lite', dataTerms: terms } });
  if (mode) settings.setProject(dir, { outsideModels: mode, ...limits });
  const keys = new ProviderKeys({ env: { CRUX_HUB_DATA: data }, protector });
  if (keySaved) keys.save('google', DUMMY_KEY);
  const offload = new Offload({ settings, keys, baseUrls: { google: MOCK }, timeoutMs: 2000 });
  const claude = async () => { claude.calls++; throw new Error('Claude must not be called'); };
  claude.calls = 0;
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings, noAgents: true, rotateLogs: false, summariser: claude, offload });
  return { root, dir, settings, keys, offload, claude, hub, p: hub.project('proj') };
}
const tools = w => cruxTools(w.hub, w.p, agentOf).instance._registeredTools;
const run = async (w, name, args) => (await tools(w)[name].handler(args, {})).content[0].text;

test('make_image: Google gets the documented request, the picture is saved like post_visual, model and cost are logged', async t => {
  reset();
  const w = world(t);
  assert.ok(cruxToolNames(agentOf, w.hub, w.p).includes('mcp__crux__make_image'));
  const out = await run(w, 'make_image', { prompt: 'A flat illustration of a sailboat', aspect_ratio: '16:9' });
  const r = mock.requests.at(-1);
  assert.equal(r.path, '/interactions');
  assert.equal(r.headers['x-goog-api-key'], DUMMY_KEY);
  assert.equal(r.headers.authorization, undefined, 'Google picture route takes the key header, not a Bearer');
  assert.deepEqual(r.body, { model: 'gemini-nano-banana-2.1', input: 'A flat illustration of a sailboat', response_format: { type: 'image', aspect_ratio: '16:9' } });
  const v = w.p.log.events.findLast(e => e.type === 'visual');
  assert.ok(v && /^[0-9a-f]{32}\.png$/.test(v.visual), `visual id ${v?.visual}`);
  assert.deepEqual([v.kind, v.thread, v.from], ['image', 'worker-1', 'worker-1']);
  assert.match(v.caption, /sailboat.*google gemini-nano-banana-2\.1/);
  assert.ok(existsSync(w.p.attachments.path(v.visual)), 'the PNG is in the project\'s attachments');
  assert.match(out, new RegExp(`visual ${v.visual}`));
  const u = w.p.log.events.findLast(e => e.type === 'usage');
  assert.deepEqual([u.via, u.provider, u.model, u.purpose, u.agent], ['outside', 'google', 'gemini-nano-banana-2.1', 'make_image', 'worker-1']);
  // 20 input and 1120 output image tokens at 1.50 and 30.00 dollars per million
  assert.ok(Math.abs(u.costUSD - (20 * 1.5 + 1120 * 30) / 1e6) < 1e-9, `cost ${u.costUSD}`);
  assert.equal(u.estimated, true);
  assert.equal(w.claude.calls, 0);
  assert.ok(!readFileSync(join(w.dir, '.crux', 'events.jsonl'), 'utf8').includes(DUMMY_KEY));
});

test('make_image needs Any: not listed in Off or Local only, and refused plainly with nothing sent when the switch changes', async t => {
  reset();
  const off = world(t, { mode: null });
  assert.ok(!tools(off).make_image && !tools(off).draft_with_outside_model);
  const local = world(t, { mode: 'local' });
  assert.ok(!tools(local).make_image, 'not listed at Local only');
  assert.ok(tools(local).draft_with_outside_model, 'the draft tool is');
  assert.ok(!cruxToolNames(agentOf, local.hub, local.p).includes('mcp__crux__make_image'));
  assert.match(await draftOutside(local.offload, local.p, agentOf, { instructions: 'x' }), /^Refused \(refused\)|^Refused \(network\)|^Refused \(off\)/);   // Google is not on this computer, so Local only does not reach it
  const any = world(t);
  const rt = tools(any);
  any.settings.setProject(any.dir, { outsideModels: 'local' });   // turned down after the agent started
  reset();
  assert.match((await rt.make_image.handler({ prompt: 'x' }, {})).content[0].text, /^Refused \(off\)|^Refused \(needs-any\)/);
  any.settings.setProject(any.dir, { outsideModels: 'off' });
  assert.match((await rt.make_image.handler({ prompt: 'x' }, {})).content[0].text, /^Refused \(off\)/);
  assert.equal(mock.requests.length, 0);
});

test('make_image: unpaid terms, a missing key, no picture in the answer, a rate limit and a bad ratio all fail plainly, with no Claude fallback and no key in the words', async t => {
  reset();
  const terms = world(t, { terms: 'free' });
  assert.match(await run(terms, 'make_image', { prompt: 'x' }), /^Refused \(terms\)/);
  const nokey = world(t, { keySaved: false });
  assert.match(await run(nokey, 'make_image', { prompt: 'x' }), /^Refused \(no-key\)/);
  assert.equal(mock.requests.length, 0, 'neither reached the mock');
  const w = world(t);
  reset('noimage');
  assert.match(await run(w, 'make_image', { prompt: 'x' }), /^Refused \(bad-answer\)/);
  reset('rate-limit');
  const rl = await run(w, 'make_image', { prompt: 'x' });
  assert.match(rl, /^Refused \(rate-limit\).*Retry after 9 s/);
  assert.ok(!rl.includes(DUMMY_KEY) && !/billing/i.test(rl), 'the provider\'s own words are not passed on');
  assert.equal(w.p.log.events.filter(e => e.type === 'visual').length, 0);
  assert.equal(w.claude.calls, 0);
  reset();
  assert.ok(tools(w).make_image.inputSchema.shape.aspect_ratio.safeParse('7:5').success === false);
  assert.match(await run(w, 'make_image', { prompt: 'a key sk-abcdefghijklmnopqrstuvwxyz1234' }), /^Refused \(secret\)/);
  assert.equal(mock.requests.length, 0);
});

test('findImage reads the Interactions shape and the older inlineData shape, and never an address', () => {
  assert.deepEqual(findImage({ steps: [{ type: 'model_output', content: [{ type: 'image', data: PNG_B64, mime_type: 'image/jpeg' }] }] }), { b64: PNG_B64, mime: 'image/jpeg' });
  assert.deepEqual(findImage({ candidates: [{ content: { parts: [{ text: 'x' }, { inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }] }), { b64: PNG_B64, mime: 'image/png' });
  assert.equal(findImage({ steps: [{ content: [{ type: 'image', uri: 'http://evil.example/x.png' }] }] }), null);
  assert.equal(findImage({ steps: [{ content: [{ type: 'text', text: 'no' }] }] }), null);
  assert.ok(IMAGE_PRICES['gemini-nano-banana-2.1'].perImage > 0);
});

test('the picture call has its own timeout and a Google client with no picture model refuses as no-image', async () => {
  reset();
  const c = new ProviderClient({ provider: 'google', model: 'm', apiKey: DUMMY_KEY, baseUrl: MOCK, imageModel: 'gemini-3.1-flash-image' });
  const img = await c.image({ prompt: 'x' });
  assert.equal(mock.requests.at(-1).body.model, 'gemini-3.1-flash-image');
  assert.equal(img.costUSD > 0, true);
  const noUsage = new ProviderClient({ provider: 'google', model: 'm', apiKey: DUMMY_KEY, baseUrl: MOCK, imageModel: 'some-new-model' });
  const r = await noUsage.image({ prompt: 'x' });
  assert.equal(r.costUSD, null, 'a model not in the table has an unknown cost, not a guess');
  await assert.rejects(() => new ProviderClient({ provider: 'openrouter', model: 'm', apiKey: DUMMY_KEY, baseUrl: MOCK }).image({ prompt: 'x' }), e => e instanceof ProviderError && e.kind === 'no-image');
});

test('draft_with_outside_model: instructions and source reach Google through the hub, a long answer comes back labelled, usage names the model', async t => {
  reset();
  const w = world(t);
  const fields = Object.keys(tools(w).draft_with_outside_model.inputSchema.shape).sort();
  assert.deepEqual(fields, ['instructions', 'source']);
  const out = await run(w, 'draft_with_outside_model', { instructions: 'Write a short update with headings.', source: 'Seeds ordered. 12 volunteers.' });
  const r = mock.requests.at(-1);
  assert.equal(r.path, '/v1/chat/completions');
  assert.equal(r.headers.authorization, `Bearer ${DUMMY_KEY}`);
  assert.equal(r.body.model, 'gemini-3.5-flash-lite');
  assert.equal(r.body.max_tokens, 3500);
  assert.match(r.body.messages[0].content, /Use only facts in the source text/);
  assert.match(r.body.messages[1].content, /Instructions:\nWrite a short update[\s\S]*Source text:\nSeeds ordered/);
  assert.match(out, /^Untrusted draft from an outside model \(google, gemini-3\.5-flash-lite\)/);
  assert.match(out, /## Next\nWater the beds\./);
  const u = w.p.log.events.findLast(e => e.type === 'usage');
  assert.deepEqual([u.via, u.provider, u.model, u.purpose], ['outside', 'google', 'gemini-3.5-flash-lite', 'draft_with_outside_model']);
  assert.ok(Math.abs(u.costUSD - (400 * 0.30 + 80 * 2.50) / 1e6) < 1e-12);
  reset('length');
  assert.match(await run(w, 'draft_with_outside_model', { instructions: 'x' }), /stopped at the length limit/);
  assert.equal(w.claude.calls, 0);
});

test('draft_with_outside_model: the size cap, a key in the text, the switch, the project\'s data setting, the allowance and a provider failure', async t => {
  reset();
  const w = world(t);
  const big = await draftOutside(w.offload, w.p, agentOf, { instructions: 'x', source: 'y'.repeat(DRAFT_MAX_SOURCE + 1) });
  assert.match(big, /^Refused \(too-big\)/);
  assert.ok(tools(w).draft_with_outside_model.inputSchema.shape.source.safeParse('y'.repeat(DRAFT_MAX_SOURCE + 1)).success === false, 'the tool\'s own schema caps it too');
  assert.match(await run(w, 'draft_with_outside_model', { instructions: 'x', source: 'token AIzaSyA1234567890abcdefghijklmnopqrstuv' }), /^Refused \(secret\)/);
  assert.equal(mock.requests.length, 0, 'neither was sent');
  // the data setting: Any with a provider not marked paid sends nothing
  const free = world(t, { terms: 'unknown' });
  assert.match(await run(free, 'draft_with_outside_model', { instructions: 'x', source: 'private-ish text' }), /^Refused \(terms\)/);
  // switch off after the agent started
  const rt = tools(w);
  w.settings.setProject(w.dir, { outsideModels: 'off' });
  assert.match((await rt.draft_with_outside_model.handler({ instructions: 'x' }, {})).content[0].text, /^Refused \(off\)/);
  assert.equal(mock.requests.length, 0);
  // a provider failure: plain words, nothing falls back
  const f = world(t); reset('rate-limit');
  const out = await run(f, 'draft_with_outside_model', { instructions: 'x', source: 's' });
  assert.match(out, /^Refused \(rate-limit\)/);
  assert.ok(!out.includes(DUMMY_KEY));
  assert.equal(f.claude.calls, 0);
  assert.equal(mock.requests.length, 1, 'one attempt, no retry');
});

test('the allowance counts pictures and drafts together: calls an hour and dollars a day', async t => {
  reset();
  const w = world(t, { limits: { outsideCallsPerHour: 2 } });
  await run(w, 'make_image', { prompt: 'a' });
  await run(w, 'draft_with_outside_model', { instructions: 'b' });
  reset();
  assert.match(await run(w, 'draft_with_outside_model', { instructions: 'c' }), /^Refused \(budget\)/);
  assert.match(await run(w, 'make_image', { prompt: 'd' }), /^Refused \(budget\)/);
  assert.equal(mock.requests.length, 0);
  const d = world(t, { limits: { outsideUsdPerDay: 0.01 } });
  reset();
  await run(d, 'make_image', { prompt: 'a' });   // about 0.0336 dollars
  assert.match(await run(d, 'make_image', { prompt: 'b' }), /^Refused \(budget\)/);
});

test('the project card has an Outside models control (Off by default); Done sends only a change; the hub panel carries the provider', () => {
  const base = { name: 'garden', permissionMode: 'auto', ownHandoff: {}, permissionCheck: 'off', paused: false };
  const d = (p, over = {}) => ({ level: p.permissionMode, connectors: false, check: 'off', outside: p.outsideModels || 'off', paused: false, nums: { retireAt: '', idleHandoffMin: '', idleFloorPct: '' }, errors: {}, alwaysOpen: false, ...over });
  const html = projectCard(base, { retireAt: 60, idleHandoffMin: 60, idleFloorPct: 25 }, d(base));
  assert.match(html, /sec-head">Outside models </);
  for (const [v, label] of OUTSIDE_CHOICES) assert.ok(html.includes(`data-ps-seg="outside" data-v="${v}">${label}</button>`), label);
  assert.ok(/class="on" data-ps-seg="outside" data-v="off"/.test(html), 'off is chosen by default');
  assert.deepEqual(projectChanges(base, d(base)).body, {});
  assert.deepEqual(projectChanges(base, d(base, { outside: 'any' })).body, { outsideModels: 'any' });
  assert.deepEqual(projectChanges({ ...base, outsideModels: 'any' }, d({ ...base, outsideModels: 'any' }, { outside: 'off' })).body, { outsideModels: 'off' });
  // the hub panel: nothing sent until touched, then one object
  const nums = { permissionTimeoutSec: '300', retireAt: '60', idleHandoffMin: '60', idleFloorPct: '25', workerRetireAt: '60', workerHandoffFloorPct: '35' };
  const settings = { routePermissions: true, permissionTimeoutSec: 300, retireAt: 60, idleHandoffMin: 60, idleFloorPct: 25, workerRetireAt: 60, workerHandoffFloorPct: 35 };
  const hd = (over = {}) => ({ route: true, nums, errors: {}, provider: 'google', model: 'gemini-3.5-flash-lite', terms: 'unknown', touched: false, ...over });
  assert.match(hubPanel(hd()), /sec-head">Outside provider /);
  assert.deepEqual(hubChanges(settings, hd()).body, {});
  assert.deepEqual(hubChanges(settings, hd({ terms: 'paid', touched: true })).body, { outsideProvider: { provider: 'google', model: 'gemini-3.5-flash-lite', dataTerms: 'paid' } });
  assert.equal(hubChanges(settings, hd({ model: ' ', touched: true })).errors.model, 'Needs a model name');
  const saved = { ...settings, outsideProvider: { provider: 'google', model: 'gemini-3.5-flash-lite', dataTerms: 'paid' } };
  assert.deepEqual(hubChanges(saved, hd({ terms: 'paid' })).body, {}, 'matches what is saved: nothing sent');
});

test('turning outside models on needs the step-up; turning them down, or the same, does not; a changed provider is a whole-hub change', t => {
  const w = world(t, { mode: null });
  assert.equal(settingsNeed({ project: 'proj', outsideModels: 'off' }, w.hub), null);
  const on = settingsNeed({ project: 'proj', outsideModels: 'any' }, w.hub);
  assert.match(on.scope, /outside/);
  assert.match(on.why, /outside models/);
  w.hub.setOutsideMode(w.p, 'any');
  assert.equal(settingsNeed({ project: 'proj', outsideModels: 'any' }, w.hub), null);
  assert.equal(settingsNeed({ project: 'proj', outsideModels: 'local' }, w.hub), null, 'down from Any');
  assert.equal(settingsNeed({ project: 'proj', outsideModels: 'off' }, w.hub), null);
  const prov = settingsNeed({ outsideProvider: { provider: 'openai', model: 'gpt-5-nano', dataTerms: 'paid' } }, w.hub);
  assert.match(prov.scope, /hub/);
  assert.equal(settingsNeed({ outsideProvider: { provider: 'google', model: 'gemini-3.5-flash-lite', dataTerms: 'paid' } }, w.hub), null, 'unchanged');
});

test('Hub.setOutsideMode: kept in hub settings, noted in the orchestrator thread, logged once, and shown on the page', t => {
  const w = world(t, { mode: null });
  assert.equal(w.hub.outsideMode(w.p), 'off');
  assert.equal(w.hub.setOutsideMode(w.p, 'any'), 'any');
  assert.equal(w.hub.setOutsideMode(w.p, 'nonsense'), 'any', 'an unknown value changes nothing');
  assert.equal(w.settings.outsideMode(w.dir), 'any');
  const ps = w.p.log.events.filter(e => e.type === 'project_settings' && e.outsideModels);
  assert.deepEqual(ps.map(e => [e.outsideModels, e.was]), [['any', 'off']]);
  w.hub.setOutsideMode(w.p, 'any');
  assert.equal(w.p.log.events.filter(e => e.type === 'project_settings' && e.outsideModels).length, 1, 'no second line for no change');
  assert.equal(w.hub.pageProject(w.p).outsideModels, 'any');
  assert.ok(!existsSync(join(w.dir, '.crux-hub.json')), 'nothing is written into the repo');
});
