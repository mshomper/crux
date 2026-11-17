// Outside models (expedition 20261117): the provider layer, the keys, the per-project switch, a month summary through the
// hub, the agent tool, usage and plain failures, all against a local mock OpenAI-compatible server on 127.0.0.1 (port 0).
// Nothing leaves this machine. One fixed dummy key; temp folders in the OS temp folder, removed afterwards.
// Tests A to I are the named additions to the success test (test/ADDITIONS.md).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { rotate, readMonthSummary, readIndex } from '../lib/archive.mjs';
import { ProviderClient, ProviderError, PRESETS, estimateCost } from '../lib/providers.mjs';
import { ProviderKeys, Offload } from '../lib/offload.mjs';
import { cruxTools, cruxToolNames } from '../lib/tools.mjs';
import { aggregate } from '../public/usage.js';

const DUMMY_KEY = 'dummy-key-0000-NOT-REAL-1234abcd';
const DAY = 86400e3;

// ---------- the mock server ----------
// mode: ok | rate-limit | hang | echo401 | badjson. requests: what reached it (path, headers, body).
const mock = { mode: 'ok', requests: [] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    let json = null; try { json = JSON.parse(body); } catch { /* not json */ }
    mock.requests.push({ path: req.url, headers: req.headers, body: json });
    if (req.url === '/api/generate') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }   // the native unload always answers
    if (mock.mode === 'hang') return;   // never answers
    if (mock.mode === 'empty') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: '  ' }, finish_reason: 'length' }], usage: { prompt_tokens: 50, completion_tokens: 40 } })); }
    if (mock.mode === 'rate-limit') { res.writeHead(429, { 'retry-after': '7', 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'slow down' } })); }
    if (mock.mode === 'echo401') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `Incorrect key. Request headers were: authorization=${req.headers.authorization}` } })); }
    if (mock.mode === 'badjson') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{ not json'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.endsWith('/chat/completions')) {
      const asked = /Thread: (\S+)/.exec(json?.messages?.[1]?.content || '')?.[1] || 'x';
      return res.end(JSON.stringify({ id: 'c1', model: json.model, choices: [{ index: 0, message: { role: 'assistant', content: `Asked: about ${asked}. Decided: the camera rig.` }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } }));
    }
    if (req.url.endsWith('/images/generations')) return res.end(JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from('PNGDATA').toString('base64') }] }));
    if (req.url.endsWith('/api/generate')) return res.end('{}');
    res.writeHead(404); res.end('{}');
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${server.address().port}/v1/`;
const ROOT = `http://127.0.0.1:${server.address().port}`;
after(() => new Promise(r => { server.closeAllConnections?.(); server.close(r); }));
const reset = (mode = 'ok') => { mock.mode = mode; mock.requests.length = 0; };
const chatRequests = () => mock.requests.filter(r => r.path.endsWith('/chat/completions'));

// a protector that needs no Windows: reversible, and the sealed text does not contain the key
const protector = { scheme: 'test', protect: s => `sealed:${Buffer.from(s).toString('base64').split('').reverse().join('')}`, unprotect: s => Buffer.from(s.slice(7).split('').reverse().join(''), 'base64').toString() };
const keysIn = (dataFolder, saved = true) => { const k = new ProviderKeys({ env: { CRUX_HUB_DATA: dataFolder }, protector }); if (saved) k.save('openai', DUMMY_KEY); return k; };

// ---------- a project with an old month, a hub and an Offload ----------
let n = 0;
const ev = (t, type, data) => ({ id: `e${String(++n).padStart(5, '0')}`, ts: new Date(t).toISOString(), type, ...data });
function oldLog() {
  const t0 = Date.now() - 250 * DAY, out = [];
  for (let i = 0; i < 7; i++) out.push(ev(t0 + i * 3600e3, 'message', { thread: 'big', from: 'you', text: `old chat ${i}: moving the viewer to a new camera rig` }));
  for (let i = 0; i < 4; i++) out.push(ev(Date.now() - 3 * DAY + i * 3600e3, 'message', { thread: 'big', from: 'you', text: `new chat ${i}` }));
  return out;
}
const FREE_VRAM = async () => 16000;
function world(t, { events = oldLog(), switchTo = 'any', keySaved = true, timeoutMs = 2000, provider = { provider: 'openai', model: 'gpt-5-nano', dataTerms: 'paid' }, vramReader = FREE_VRAM } = {}) {
  const root = makeTmp('crux-offload-', t), dir = join(root, 'proj'), data = join(root, 'hubdata');
  mkdirSync(join(dir, '.crux'), { recursive: true }); mkdirSync(data, { recursive: true });
  writeFileSync(join(dir, '.crux', 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const settings = new HubSettings({ file: null });
  if (provider) settings.set({ outsideProvider: provider });
  if (switchTo) settings.setProject(dir, { outsideModels: switchTo });
  const keys = keysIn(data, keySaved);
  const offload = new Offload({ settings, keys, baseUrls: { openai: MOCK, google: MOCK, openrouter: MOCK }, timeoutMs, vramReader });
  const claude = async () => { claude.calls++; throw new Error('Claude must not be called'); };
  claude.calls = 0;
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings, noAgents: true, rotateLogs: true, summariser: claude, offload });
  return { root, dir, crux: join(dir, '.crux'), data, settings, keys, offload, claude, hub, p: hub.project('proj') };
}
const quiet = async fn => { const o = console.error; console.error = () => { }; try { return await fn(); } finally { console.error = o; } };
const summaryFiles = w => existsSync(join(w.crux, 'archive')) ? readdirSync(join(w.crux, 'archive')).filter(f => f.includes('summaries')) : [];
const allText = w => [join(w.crux, 'events.jsonl'), w.keys.file, ...(existsSync(join(w.crux, 'archive')) ? readdirSync(join(w.crux, 'archive')).filter(f => f.endsWith('.json')).map(f => join(w.crux, 'archive', f)) : [])].filter(existsSync).map(f => readFileSync(f, 'utf8')).join('\n');
const agentOf = { name: 'worker-1', role: 'worker', type: 'implementer', thread: 'worker-1' };

// ---------- A to I ----------
test('A. a month summary through Hub.summariseSoon on an outside provider: the mock answers, Claude is never called, file and usage name the provider and model', async t => {
  reset();
  const w = world(t);
  assert.equal(w.hub.rotateLogs().length, 1);
  await w.hub.summarising;
  assert.equal(chatRequests().length, 1, 'the mock got the call');
  assert.equal(chatRequests()[0].body.model, 'gpt-5-nano');
  assert.equal(chatRequests()[0].body.max_completion_tokens, 400, 'OpenAI takes max_completion_tokens');
  assert.equal(chatRequests()[0].body.max_tokens, undefined);
  assert.equal(w.claude.calls, 0, 'the Claude fake was never called');
  const ym = Object.keys(readIndex(w.crux).months)[0];
  const s = readMonthSummary(w.crux, ym);
  assert.match(s.threads.big.text, /Asked: about big/);
  assert.equal(s.model, 'gpt-5-nano');
  assert.equal(s.threads.big.model, 'gpt-5-nano');
  assert.equal(s.threads.big.provider, 'openai');
  const u = w.p.log.events.findLast(e => e.type === 'usage' && e.agent === 'month summaries');
  assert.ok(u, 'a usage event');
  assert.deepEqual([u.via, u.provider, u.model, u.agentType], ['outside', 'openai', 'gpt-5-nano', 'summary']);
  assert.deepEqual(u.tokens, { input: 120, output: 30 });
  // 120 in and 30 out at the dated table's 0.05 / 0.40 dollars per million
  assert.ok(Math.abs(u.costUSD - (120 * 0.05 + 30 * 0.40) / 1e6) < 1e-12, `estimated dollars ${u.costUSD}`);
  assert.equal(typeof u.ms, 'number');
});

test('B. switch off (nothing set): the mock gets no request from the month job or the agent tool', async t => {
  reset();
  const w = world(t, { switchTo: null });      // a provider is set up and a key saved, but no project switch
  assert.equal(w.settings.outsideMode(w.dir), 'off');
  w.hub.rotateLogs(); await w.hub.summarising;
  assert.equal(mock.requests.length, 0, 'the month job sent nothing outside');
  assert.equal(w.claude.calls, 1, 'the month job used the Claude path, as before');
  const rt = cruxTools(w.hub, w.p, agentOf).instance._registeredTools;
  assert.ok(!rt.ask_outside_model, 'the tool is not listed');
  assert.ok(!cruxToolNames(agentOf, w.hub, w.p).includes('mcp__crux__ask_outside_model'));
  await assert.rejects(() => w.offload.chat(w.dir, { system: 's', user: 'u' }), e => e instanceof ProviderError && e.kind === 'off');
  assert.equal(mock.requests.length, 0);
});

test('C. the provider fails mid-month (timeout, 429, no key): no summary file, Claude never called, no model name written', async t => {
  for (const [name, mode, opts, kind] of [['timeout', 'hang', { timeoutMs: 150 }, 'timeout'], ['429', 'rate-limit', {}, 'rate-limit'], ['no key', 'ok', { keySaved: false }, 'no-key']]) {
    reset(mode);
    const w = world(t, opts);
    await quiet(async () => { w.hub.rotateLogs(); await w.hub.summarising; });
    assert.deepEqual(summaryFiles(w), [], `${name}: no summary file or partial file`);
    assert.equal(w.claude.calls, 0, `${name}: Claude never called`);
    assert.ok(!w.p.log.events.some(e => e.type === 'usage' && e.agent === 'month summaries'), `${name}: no usage line for a call that did not answer`);
    // the plain error kind the client raised for the same setup
    await assert.rejects(() => w.offload.chat(w.dir, { system: 's', user: 'Thread: big' }), e => e instanceof ProviderError && e.kind === kind, name);
    if (kind === 'rate-limit') await assert.rejects(() => w.offload.chat(w.dir, { system: 's', user: 'u' }), e => e.retryAfterSec === 7 && e.status === 429);
    if (kind === 'no-key') assert.equal(chatRequests().length, 0, 'no key: nothing was sent');
  }
});

test('C2. a failed month is tried again on the next tick and then written by the provider that answered', async t => {
  reset('rate-limit');
  const w = world(t);
  await quiet(async () => { w.hub.rotateLogs(); await w.hub.summarising; });
  assert.deepEqual(summaryFiles(w), []);
  mock.mode = 'ok';
  w.hub.summariseSoon(); await w.hub.summarising;
  const ym = Object.keys(readIndex(w.crux).months)[0];
  assert.equal(readMonthSummary(w.crux, ym).model, 'gpt-5-nano');
  assert.equal(w.claude.calls, 0);
});

test('D. a mock that never answers: the call ends within the injected timeout', async () => {
  reset('hang');
  const c = new ProviderClient({ provider: 'openai', model: 'gpt-5-nano', apiKey: DUMMY_KEY, baseUrl: MOCK, timeoutMs: 200 });
  const t0 = Date.now();
  await assert.rejects(() => c.chat({ system: 's', user: 'u' }), e => e instanceof ProviderError && e.kind === 'timeout');
  assert.ok(Date.now() - t0 < 2000, `ended in ${Date.now() - t0} ms`);
  assert.equal(mock.requests.length, 1, 'no retry inside the client');
  server.closeAllConnections?.();
});

test('E. key hygiene: the one dummy key is in no event, page view, summary file, key file text or error, even when the mock echoes the header', async t => {
  reset();
  const w = world(t);
  // a good run, then a run where the mock echoes the Authorization header in its error body
  w.hub.rotateLogs(); await w.hub.summarising;
  reset('echo401');
  const errors = [];
  for (const run of [() => w.offload.chat(w.dir, { system: 's', user: 'u' }), () => new ProviderClient({ provider: 'openai', model: 'm', apiKey: DUMMY_KEY, baseUrl: MOCK }).image({ prompt: 'p' })]) {
    try { await run(); assert.fail('should have been refused'); } catch (e) { assert.ok(e instanceof ProviderError); assert.equal(e.kind, 'refused'); errors.push(e.message, e.stack || '', JSON.stringify(e), String(e)); }
  }
  assert.ok(mock.requests.some(r => r.headers.authorization === `Bearer ${DUMMY_KEY}`), 'the key was sent to the mock (it is what the echo returned)');
  const tool = await cruxTools(w.hub, w.p, agentOf).instance._registeredTools.ask_outside_model.handler({ question: 'q' }, {});
  errors.push(tool.content[0].text);
  await quiet(async () => { w.hub.summariseSoon(); await w.hub.summarising; });
  const everything = [allText(w), JSON.stringify(w.p.log.events), JSON.stringify(w.keys.view()), JSON.stringify(w.hub.pageProject(w.p)), JSON.stringify(w.settings.all()), JSON.stringify(w.settings.projects), ...errors].join('\n');
  assert.ok(!everything.includes(DUMMY_KEY), 'the key appears nowhere');
  assert.ok(!/Bearer/.test(errors.join('\n')) && !/Incorrect key/.test(errors.join('\n')), 'no header and no response body in an error');
  assert.equal(readFileSync(w.keys.file, 'utf8').includes(DUMMY_KEY), false);
  assert.ok(w.keys.file.startsWith(w.data) && !w.keys.file.startsWith(w.dir), 'the key file sits in the hub data folder, not the project');
  assert.deepEqual(w.keys.view(), { openai: { saved: true, end: DUMMY_KEY.slice(-4) } }, 'the page sees only the last four');
  assert.equal(JSON.parse(readFileSync(w.keys.file, 'utf8')).openai.end, DUMMY_KEY.slice(-4), 'last 4 beside the key');
  assert.equal(w.keys.get('openai'), DUMMY_KEY, 'and it opens again for a call');
});

test('F. the image call goes to the images route and returns the base64 picture', async () => {
  reset();
  const c = new ProviderClient({ provider: 'openai', model: 'gpt-5-nano', apiKey: DUMMY_KEY, baseUrl: MOCK });
  const img = await c.image({ prompt: 'a small red cube', size: '1024x1024' });
  assert.equal(Buffer.from(img.b64, 'base64').toString(), 'PNGDATA');
  const r = mock.requests.at(-1);
  assert.ok(r.path.endsWith('/images/generations'));
  assert.deepEqual([r.body.prompt, r.body.size, r.body.model], ['a small red cube', '1024x1024', 'gpt-image-2']);
  assert.equal(r.body.response_format, undefined, 'OpenAI image models always answer base64 and reject the field');
  const g = new ProviderClient({ provider: 'google', model: 'gemini-3.5-flash-lite', apiKey: DUMMY_KEY, baseUrl: MOCK });
  await g.image({ prompt: 'x' });
  assert.equal(mock.requests.at(-1).body.response_format, 'b64_json');
  await assert.rejects(() => new ProviderClient({ provider: 'ollama', model: 'm', baseUrl: MOCK }).image({ prompt: 'x' }), e => e.kind === 'refused', 'Ollama has no image route');
});

test('G. the agent tool takes a question and short context only, and the request reaches the mock from the hub process', async t => {
  reset();
  const w = world(t);
  const rt = cruxTools(w.hub, w.p, agentOf).instance._registeredTools;
  assert.ok(rt.ask_outside_model && cruxToolNames(agentOf, w.hub, w.p).includes('mcp__crux__ask_outside_model'));
  const fields = Object.keys(rt.ask_outside_model.inputSchema?.shape || rt.ask_outside_model.inputSchema || {}).sort();
  assert.deepEqual(fields, ['context', 'question']);
  for (const bad of ['url', 'baseUrl', 'provider', 'model', 'key', 'apiKey']) assert.ok(!fields.includes(bad), bad);
  const out = (await rt.ask_outside_model.handler({ question: 'What colour is the sky?', context: 'a short note', url: 'http://evil.example/', model: 'x', provider: 'google' }, {})).content[0].text;
  assert.equal(chatRequests().length, 1);
  const sent = chatRequests()[0];
  assert.equal(sent.body.model, 'gpt-5-nano', 'the hub setup chose the model; the extra fields were ignored');
  assert.match(sent.body.messages[1].content, /What colour is the sky\?/);
  assert.match(sent.body.messages[1].content, /a short note/);
  assert.match(out, /^Untrusted text from an outside model \(openai, gpt-5-nano\)/);
  const u = w.p.log.events.findLast(e => e.type === 'usage' && e.agent === 'worker-1');
  assert.deepEqual([u.via, u.provider, u.model], ['outside', 'openai', 'gpt-5-nano']);
  // the Conductor never gets it
  assert.ok(!cruxTools(w.hub, w.p, { name: 'conductor', role: 'conductor', thread: 'conductor' }).instance._registeredTools.ask_outside_model);
  assert.ok(!cruxToolNames({ role: 'conductor' }, w.hub, w.p).includes('mcp__crux__ask_outside_model'));
  // a long question is capped by the tool's own schema
  assert.ok(rt.ask_outside_model.inputSchema.shape.question.safeParse('x'.repeat(2001)).success === false);
});

test('H. package.json has exactly the three dependencies, and the new modules import only node: modules and relative files', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@anthropic-ai/claude-agent-sdk', 'web-push', 'zod']);
  for (const f of ['providers.mjs', 'offload.mjs']) {
    const src = readFileSync(new URL(`../lib/${f}`, import.meta.url), 'utf8');
    const specs = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]|import\(['"]([^'"]+)['"]\)/gm)].map(m => m[1] || m[2]);
    for (const s of specs) assert.ok(s.startsWith('node:') || s.startsWith('./') || s.startsWith('../'), `${f} imports ${s}`);
  }
});

test('I. the switch turned off after an agent started: the tool refuses plainly and nothing is sent', async t => {
  reset();
  const w = world(t);
  const rt = cruxTools(w.hub, w.p, agentOf).instance._registeredTools;   // listed: the switch was on at start
  assert.ok(rt.ask_outside_model);
  w.settings.setProject(w.dir, { outsideModels: 'off' });
  const out = (await rt.ask_outside_model.handler({ question: 'hello?' }, {})).content[0].text;
  assert.match(out, /^Refused \(off\)/);
  assert.equal(mock.requests.length, 0);
});

// ---------- the rest of checklist items 3 to 9 ----------
test('the switch has three values, is off by default, and is kept only in hub settings', () => {
  const s = new HubSettings({ file: null });
  assert.equal(s.outsideMode('/x/proj'), 'off');
  for (const m of ['local', 'any', 'off']) { s.setProject('/x/proj', { outsideModels: m }); assert.equal(s.outsideMode('/x/proj'), m); }
  s.setProject('/x/proj', { outsideModels: 'everything' });
  assert.equal(s.outsideMode('/x/proj'), 'off', 'a value that is not one of the three is ignored');
  s.set({ outsideProvider: { provider: 'nowhere', model: 'm' } });
  assert.equal(s.get('outsideProvider'), undefined, 'only a preset can be chosen');
});

test('local allows only the Ollama provider on this machine; the keyless call frees the GPU afterwards', async t => {
  reset();
  const w = world(t, { switchTo: 'local' });                                  // provider is openai: not local
  assert.equal(w.offload.plan(w.dir), null);
  await assert.rejects(() => w.offload.chat(w.dir, { system: 's', user: 'u' }), e => e.kind === 'off');
  assert.equal(mock.requests.length, 0);
  w.settings.set({ outsideProvider: { provider: 'ollama', model: 'gemma3:4b', baseUrl: ROOT + '/v1' } });
  assert.equal(w.settings.get('outsideProvider').dataTerms, 'unknown', 'dataTerms defaults to unknown');
  const r = await w.offload.chat(w.dir, { system: 's', user: 'Thread: big' });
  assert.equal(r.provider, 'ollama'); assert.equal(r.costUSD, 0);
  assert.equal(mock.requests[0].headers.authorization, undefined, 'no key for a local model');
  assert.equal(mock.requests[0].body.max_tokens, 300);
  const free = mock.requests.find(q => q.path === '/api/generate');
  assert.deepEqual(free.body, { model: 'gemma3:4b', keep_alive: 0 }, 'the native route frees the GPU');
  // an address that is not on this machine is refused by the client itself
  assert.throws(() => new ProviderClient({ provider: 'ollama', model: 'm', baseUrl: 'https://example.com/v1' }), e => e.kind === 'refused');
  // and a failing free-up never fails the job
  const flaky = new ProviderClient({ provider: 'ollama', model: 'm', baseUrl: MOCK, vramReader: FREE_VRAM, fetchFn: async (u, o) => { if (String(u).endsWith('/api/generate')) throw new Error('down'); return fetch(u, o); } });
  assert.equal((await flaky.chat({ system: 's', user: 'u' })).provider, 'ollama');
});

test('OpenRouter asks for no data collection and uses the cost it reports; Google uses max_tokens; unknown models cost null', async () => {
  reset();
  const or = new ProviderClient({ provider: 'openrouter', model: 'some/model', apiKey: DUMMY_KEY, baseUrl: MOCK });
  await or.chat({ system: 's', user: 'u' });
  assert.deepEqual(mock.requests.at(-1).body.provider, { data_collection: 'deny' });
  const g = new ProviderClient({ provider: 'google', model: 'gemini-3.5-flash-lite', apiKey: DUMMY_KEY, baseUrl: MOCK });
  const r = await g.chat({ system: 's', user: 'u', maxTokens: 77 });
  assert.equal(mock.requests.at(-1).body.max_tokens, 77);
  assert.ok(Math.abs(r.costUSD - (120 * 0.30 + 30 * 2.50) / 1e6) < 1e-12);
  assert.equal(r.estimated, true);
  assert.deepEqual(Object.keys(PRESETS).sort(), ['google', 'ollama', 'openai', 'openrouter']);
});

test('a 429 says rate-limit with the Retry-After seconds, a bad answer says bad-answer, a missing key says no-key before anything is sent', async () => {
  reset('rate-limit');
  const c = new ProviderClient({ provider: 'openai', model: 'm', apiKey: DUMMY_KEY, baseUrl: MOCK });
  await assert.rejects(() => c.chat({ system: 's', user: 'u' }), e => e.kind === 'rate-limit' && e.retryAfterSec === 7 && e.status === 429 && !/slow down/.test(e.message));
  assert.equal(mock.requests.length, 1, 'no retry');
  reset('badjson');
  await assert.rejects(() => c.chat({ system: 's', user: 'u' }), e => e.kind === 'bad-answer');
  reset();
  await assert.rejects(() => new ProviderClient({ provider: 'openai', model: 'm', baseUrl: MOCK }).chat({ system: 's', user: 'u' }), e => e.kind === 'no-key');
  assert.equal(mock.requests.length, 0);
  await assert.rejects(() => new ProviderClient({ provider: 'openai', model: 'm', apiKey: DUMMY_KEY, baseUrl: 'http://127.0.0.1:1/v1/' }).chat({ system: 's', user: 'u' }), e => e.kind === 'network');
});

test('tool failures are plain refusals that name the error kind, and the agent carries on itself', async t => {
  reset('rate-limit');
  const w = world(t);
  const rt = cruxTools(w.hub, w.p, agentOf).instance._registeredTools;
  const out = (await rt.ask_outside_model.handler({ question: 'q' }, {})).content[0].text;
  assert.match(out, /^Refused \(rate-limit\).*Retry after 7 s/);
  assert.equal(w.claude.calls, 0);
  assert.ok(!w.p.log.events.some(e => e.type === 'usage' && e.via === 'outside'), 'a refused call is not a usage line');
});

test('outside usage keeps its dollars in the totals and has nothing to do with the plan meters', async t => {
  reset();
  const w = world(t);
  const rt = cruxTools(w.hub, w.p, agentOf).instance._registeredTools;
  await rt.ask_outside_model.handler({ question: 'q' }, {});
  const rows = w.p.log.events.map(ev => ({ project: 'proj', ev }));
  const agg = aggregate(rows);
  const row = agg.models.find(m => m.id === 'gpt-5-nano');
  assert.ok(row && row.cost > 0 && row.input === 120 && row.output === 30, 'their dollars and tokens are counted');
  // the plan meters come from plan_usage events (the SDK's usage call and rate_limit events), never from usage events
  assert.ok(!w.p.log.events.some(e => e.type === 'plan_usage'), 'an outside call writes no plan figure');
  assert.equal(w.p.log.events.findLast(e => e.via === 'outside').type, 'usage');
});

test('a partial month written for one provider is not reused after the switch changes provider', async t => {
  reset();
  const events = oldLog();
  // in time order, after the seven old 'big' events and before the new ones
  for (let i = 0; i < 6; i++) events.splice(7 + i, 0, ev(Date.now() - 250 * DAY + (20 + i) * 3600e3, 'message', { thread: 'other', from: 'you', text: `other ${i}` }));
  const w = world(t, { events });
  let calls = 0;
  const flaky = async arg => { if (++calls === 2) throw new Error('flaky');   // the second thread fails, the first is kept
 return { text: `Asked: ${arg.user.length}`, modelUsage: { 'm-a': { inputTokens: 1, outputTokens: 1, costUSD: 0 } }, via: 'outside', provider: 'a', model: 'm-a' }; };
  const { summariseDue } = await import('../lib/month-summaries.mjs');
  rotate(w.crux, { now: Date.now(), cutoff: Date.now() - 14 * DAY });
  const first = await quiet(() => summariseDue(w.crux, { summarise: flaky, source: 'a:m-a', log: () => { } }));
  assert.ok(first[0]?.error, 'the second thread failed');
  const partial = readdirSync(join(w.crux, 'archive')).find(f => f.includes('partial'));
  assert.ok(partial, 'the thread that answered is kept');
  assert.equal(JSON.parse(readFileSync(join(w.crux, 'archive', partial), 'utf8')).source, 'a:m-a');
  const seen = [];
  const other = async arg => { seen.push(arg.user.match(/Thread: (\S+)/)[1]); return { text: 'Asked: b', modelUsage: { 'm-b': { inputTokens: 1, outputTokens: 1, costUSD: 0 } }, via: 'outside', provider: 'b', model: 'm-b' }; };
  await summariseDue(w.crux, { summarise: other, source: 'b:m-b', log: () => { } });
  assert.deepEqual(seen.sort(), ['big', 'other'], 'both threads redone by the new provider');
  const ym = Object.keys(readIndex(w.crux).months)[0];
  const s = readMonthSummary(w.crux, ym);
  assert.equal(s.model, 'm-b');
  assert.ok(Object.values(s.threads).every(x => x.model === 'm-b'), 'no thread keeps a model that did not answer it');
});

// ---------- the Skeptic's findings ----------
const LOCAL = { provider: 'ollama', model: 'gemma3:4b', baseUrl: ROOT + '/v1' };

test('S1. Ollama: keep_alive is never sent on /v1, and the native unload follows a success and a failure', async t => {
  reset();
  const w = world(t, { switchTo: 'local', provider: LOCAL });
  await w.offload.chat(w.dir, { system: 's', user: 'u' });
  assert.ok(!mock.requests.some(r => r.path.endsWith('/chat/completions') && r.body && 'keep_alive' in r.body), 'no keep_alive on /v1');
  assert.deepEqual(mock.requests.filter(r => r.path === '/api/generate').map(r => r.body), [{ model: 'gemma3:4b', keep_alive: 0 }], 'unloaded after a success');
  reset('rate-limit');
  await assert.rejects(() => w.offload.chat(w.dir, { system: 's', user: 'u' }), e => e.kind === 'rate-limit');
  assert.equal(mock.requests.filter(r => r.path === '/api/generate').length, 1, 'and after a failure');
  reset('hang');
  const slow = new Offload({ settings: w.settings, keys: w.keys, timeoutMs: 150, vramReader: FREE_VRAM });
  await assert.rejects(() => slow.chat(w.dir, { system: 's', user: 'u' }), e => e.kind === 'timeout');
  assert.equal(mock.requests.filter(r => r.path === '/api/generate').length, 1, 'and after a timeout');
  server.closeAllConnections?.();
});

test('S2. the GPU guard: low or unreadable free memory refuses as busy, the month stays for the next tick, the mock gets no call', async t => {
  for (const reader of [async () => 3000, async () => null, async () => { throw new Error('no nvidia-smi'); }]) {
    reset();
    const w = world(t, { switchTo: 'local', provider: LOCAL, vramReader: reader });
    await quiet(async () => { w.hub.rotateLogs(); await w.hub.summarising; });
    assert.equal(mock.requests.length, 0, 'nothing reached the mock, not even an unload');
    assert.deepEqual(summaryFiles(w), []);
    assert.equal(w.claude.calls, 0);
    await assert.rejects(() => w.offload.chat(w.dir, { system: 's', user: 'u' }), e => e.kind === 'busy');
  }
  // the threshold is configurable
  reset();
  const w = world(t, { switchTo: 'local', provider: { ...LOCAL, minFreeMB: 2000 }, vramReader: async () => 3000 });
  assert.equal((await w.offload.chat(w.dir, { system: 's', user: 'u' })).provider, 'ollama');
  reset();
  const w2 = world(t, { switchTo: 'local', provider: LOCAL, vramReader: async () => 11999 });
  await assert.rejects(() => w2.offload.chat(w2.dir, { system: 's', user: 'u' }), e => e.kind === 'busy', 'the default is 12000 MB');
});

test('S3. local refuses a model tag that ends in -cloud or :cloud', async t => {
  for (const model of ['gpt-oss:120b-cloud', 'qwen3:cloud']) {
    reset();
    const w = world(t, { switchTo: 'local', provider: { ...LOCAL, model } });
    await assert.rejects(() => w.offload.chat(w.dir, { system: 's', user: 'u' }), e => e.kind === 'refused', model);
    assert.equal(mock.requests.length, 0);
  }
});

test('S4. any needs the provider marked paid: unknown and free are refused as terms, and so is an OpenRouter :free model', async t => {
  for (const dataTerms of ['unknown', 'free', undefined]) {
    reset();
    const w = world(t, { provider: { provider: 'openai', model: 'gpt-5-nano', dataTerms } });
    await assert.rejects(() => w.offload.chat(w.dir, { system: 's', user: 'u' }), e => e.kind === 'terms', String(dataTerms));
    assert.equal(mock.requests.length, 0);
  }
  reset();
  const w = world(t, { provider: { provider: 'openrouter', model: 'meta/llama-x:free', dataTerms: 'paid' } });
  await assert.rejects(() => w.offload.chat(w.dir, { system: 's', user: 'u' }), e => e.kind === 'terms');
  assert.equal(mock.requests.length, 0);
  w.keys.save('openrouter', DUMMY_KEY);
  w.settings.set({ outsideProvider: { provider: 'openrouter', model: 'meta/llama-x', dataTerms: 'paid' } });
  assert.equal((await w.offload.chat(w.dir, { system: 's', user: 'u' })).provider, 'openrouter');
});

test('S5. the agent tool has an allowance: the N+1th call in an hour is refused as budget, and so is spending past the day\'s dollars', async t => {
  reset();
  const w = world(t);
  w.settings.setProject(w.dir, { outsideCallsPerHour: 3 });
  const rt = cruxTools(w.hub, w.p, agentOf).instance._registeredTools;
  const outs = [];
  for (let i = 0; i < 4; i++) outs.push((await rt.ask_outside_model.handler({ question: `q${i}` }, {})).content[0].text);
  assert.equal(chatRequests().length, 3, 'the mock saw N');
  assert.ok(outs.slice(0, 3).every(o => /^Untrusted/.test(o)));
  assert.match(outs[3], /^Refused \(budget\)/);
  assert.deepEqual(w.settings.outsideLimits('/other'), { callsPerHour: 30, usdPerDay: 0.5 }, 'defaults: 30 an hour, 50 cents a day');
  reset();
  const w2 = world(t);
  w2.settings.setProject(w2.dir, { outsideUsdPerDay: 0.00001 });   // one call costs about 0.000018
  const rt2 = cruxTools(w2.hub, w2.p, agentOf).instance._registeredTools;
  assert.match((await rt2.ask_outside_model.handler({ question: 'a' }, {})).content[0].text, /^Untrusted/);
  assert.match((await rt2.ask_outside_model.handler({ question: 'b' }, {})).content[0].text, /^Refused \(budget\)/);
  assert.equal(chatRequests().length, 1);
});

test('S6. prices: a known model is estimated, an unlisted one costs null and is not estimated, an ended price is not used, OpenRouter credits are not called dollars', async t => {
  reset();
  const c = (model, provider = 'openai') => new ProviderClient({ provider, model, apiKey: DUMMY_KEY, baseUrl: MOCK });
  const known = await c('gpt-5-nano').chat({ system: 's', user: 'u' });
  assert.deepEqual([known.estimated, typeof known.costUSD], [true, 'number']);
  const unknown = await c('brand-new-model').chat({ system: 's', user: 'u' });
  assert.deepEqual([unknown.costUSD, unknown.estimated], [null, false]);
  assert.equal(unknown.modelUsage['brand-new-model'].costUSD, 0, 'the totals count nothing for it, and the event says unknown');
  assert.equal(estimateCost({ provider: 'google', model: 'gemini-3.8-flash', input: 1e6, output: 0, today: '2026-12-31' }).costUSD, 0.75);
  assert.equal(estimateCost({ provider: 'google', model: 'gemini-3.8-flash', input: 1e6, output: 0, today: '2027-01-02' }).costUSD, null, 'the end date has passed: unknown, not a stale price');
  assert.deepEqual(estimateCost({ provider: 'openrouter', model: 'x/y', input: 1, output: 1, reported: 0.0123 }), { costUSD: 0.0123, estimated: false, unit: 'credits' });
  const w = world(t, { provider: { provider: 'openai', model: 'brand-new-model', dataTerms: 'paid' } });
  const rt = cruxTools(w.hub, w.p, agentOf).instance._registeredTools;
  await rt.ask_outside_model.handler({ question: 'q' }, {});
  const u = w.p.log.events.findLast(e => e.type === 'usage' && e.via === 'outside');
  assert.deepEqual([u.costUSD, u.costKnown, u.estimated], [null, false, false]);
  const k = world(t);
  await cruxTools(k.hub, k.p, agentOf).instance._registeredTools.ask_outside_model.handler({ question: 'q' }, {});
  const ku = k.p.log.events.findLast(e => e.type === 'usage' && e.via === 'outside');
  assert.deepEqual([ku.costKnown, ku.estimated, ku.costUnit], [true, true, 'usd']);
});

test('S7. an empty answer is bad-answer, its usage is still logged, and the token field name follows the preset', async t => {
  reset('empty');
  const w = world(t);
  const rt = cruxTools(w.hub, w.p, agentOf).instance._registeredTools;
  const out = (await rt.ask_outside_model.handler({ question: 'q' }, {})).content[0].text;
  assert.match(out, /^Refused \(bad-answer\)/);
  const u = w.p.log.events.findLast(e => e.type === 'usage' && e.via === 'outside');
  assert.ok(u && u.tokens.input === 50 && u.tokens.output === 40, 'the billed tokens are in the log');
  await assert.rejects(() => w.offload.chat(w.dir, { system: 's', user: 'u' }), e => e.kind === 'bad-answer' && !!e.modelUsage);
  reset();
  for (const [provider, field] of [['openai', 'max_completion_tokens'], ['google', 'max_tokens'], ['openrouter', 'max_tokens']]) {
    await new ProviderClient({ provider, model: 'm', apiKey: DUMMY_KEY, baseUrl: MOCK }).chat({ system: 's', user: 'u', maxTokens: 55 });
    const b = mock.requests.at(-1).body;
    assert.equal(b[field], 55, provider);
    assert.equal(Object.keys(b).filter(k => /max_/.test(k)).length, 1, `${provider}: only one cap field`);
  }
});

test('S8. rate-limit, timeout, busy and network failures do not count toward the two-failure park', async t => {
  const { summariseDue, monthsDue } = await import('../lib/month-summaries.mjs');
  for (const kind of ['rate-limit', 'timeout', 'busy', 'network']) {
    reset();
    const w = world(t);
    rotate(w.crux, { now: Date.now(), cutoff: Date.now() - 14 * DAY });
    const failures = new Map(); let calls = 0;
    const soft = async () => { calls++; throw new ProviderError(kind); };
    for (let i = 0; i < 4; i++) await summariseDue(w.crux, { summarise: soft, failures, log: () => { } });
    assert.equal(calls, 4, `${kind}: never parked`);
    assert.equal(monthsDue(w.crux).length, 1);
  }
  const w = world(t);
  rotate(w.crux, { now: Date.now(), cutoff: Date.now() - 14 * DAY });
  const failures = new Map(); let calls = 0;
  for (let i = 0; i < 4; i++) await summariseDue(w.crux, { summarise: async () => { calls++; throw new ProviderError('bad-answer'); }, failures, log: () => { } });
  assert.equal(calls, 2, 'a bad answer still parks the month after two');
});

test('S9. timeouts per preset (hosted 30 s, Ollama 120 s, overridable) and a key never goes into process.env', async t => {
  assert.equal(new ProviderClient({ provider: 'openai', model: 'm' }).timeoutMs, 30000);
  assert.equal(new ProviderClient({ provider: 'google', model: 'm' }).timeoutMs, 30000);
  assert.equal(new ProviderClient({ provider: 'ollama', model: 'm' }).timeoutMs, 120000);
  assert.equal(new ProviderClient({ provider: 'ollama', model: 'm', timeoutMs: 50 }).timeoutMs, 50);
  reset();
  const w = world(t);
  await w.offload.chat(w.dir, { system: 's', user: 'u' });
  assert.ok(!Object.values(process.env).some(v => String(v).includes(DUMMY_KEY)), 'the key is not in the environment');
});
