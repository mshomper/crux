// Outside models (expedition 20261117): one client over OpenAI-compatible chat APIs, plus an image call.
//
// The hub makes every call; an agent never gets a URL, a key or a network. Provider addresses come only from the presets
// below (Ollama's may be set in hub settings, and only to this machine). The client does not retry: a failure is a
// ProviderError with a kind, a status and a short fixed message, never the response body or a header (a provider's error
// can echo the Authorization header). The answer names the provider and model that really gave it. A key is held in the
// client only; it is never put in process.env.
//
// chat() returns the same shape as permission-check.mjs apiCall, plus provider and model:
//   { text, via: 'outside', provider, model, tokens, costUSD, estimated, modelUsage, ms }
// Node's built-in fetch and node: modules only; no package.
import { execFile } from 'node:child_process';

// The outside price table is its own: it never borrows permission-check's listCost. List prices in dollars per million
// tokens (input, output); from = the date the price took effect or was first read, until = the last day it holds (null: no
// end known), seen = the day it was read. After `until` the price is not used: the cost is unknown, never a stale number.
// Read 2026-11-17 from the providers' own pricing pages (OpenAI: expedition notes-4; Gemini: notes-1). A model not listed costs null (unknown); OpenRouter answers with its own cost.
export const PRICES_DATED = '2026-11-17';
const P = (input, output, until = null) => ({ input, output, from: '2026-11-17', until, seen: '2026-11-17' });
export const PRICES = {
  'gpt-5-nano': P(0.05, 0.40),
  'gpt-5-mini': P(0.25, 2.00),
  'gpt-5.4-nano': P(0.20, 1.25),
  'gpt-5.4-mini': P(0.75, 4.50),
  'gpt-4o-mini': P(0.15, 0.60),
  'gpt-4.1-mini': P(0.40, 1.60),
  'gemini-3.5-flash-lite': P(0.30, 2.50),
  'gemini-3.8-flash': P(0.75, 3.75, '2026-12-31'),   // 1.50 / 7.50 from 2027-01-01
  'gemini-3.1-flash-lite': P(0.25, 1.50)
};

// Image prices (read 2026-11-17 from ai.google.dev/gemini-api/docs/pricing, Standard tier, paid only: the page lists the free
// tier as "Not available" for every Google image model). perImage: dollars for a 1K image; inPerM / outPerM: dollars per million
// input tokens and per million output image tokens. When Google's answer carries token counts the cost is counted from them,
// else the 1K per-image price is used (an estimate either way). OpenAI's image price is not in the table: unknown (null).
export const IMAGE_PRICES = {
  'gemini-nano-banana-2.1': { perImage: 0.0336, inPerM: 1.50, outPerM: 30.00 },
  'gemini-3.1-flash-lite-image': { perImage: 0.0336, inPerM: 0.25, outPerM: 30.00 },
  'gemini-3.1-flash-image': { perImage: 0.067, inPerM: 0.50, outPerM: 60.00 },
  'gemini-2.5-flash-image': { perImage: 0.039, inPerM: 0.30, outPerM: 30.00 }
};
// What an outside call counts as against the daily dollar cap when its real cost is unknown (a model not in a price table, a
// price that has ended, OpenAI pictures): never 0, so the cap still holds. A picture counts at least 5 cents, or the dearest
// listed picture price; text counts its tokens at the dearest listed text price (flat 1 cent when the counts are missing).
export function fallbackCostUSD(purpose, tokens = null) {
  if (purpose === 'make_image') return Math.max(0.05, ...Object.values(IMAGE_PRICES).map(p => p.perImage));
  const input = Number(tokens?.input) || 0, output = Number(tokens?.output) || 0;
  if (!input && !output) return 0.01;
  const top = Object.values(PRICES);
  return (input * Math.max(...top.map(p => p.input)) + output * Math.max(...top.map(p => p.output))) / 1e6;
}

// What looks like a key or a password: known key shapes, and the "password: ..." / "password=..." form (a password, secret,
// token or key given as a value). Plain sentences ("the password is required") do not match. Not a scanner, only a catch for
// the plain mistake: used on text sent outside (offload.mjs) and on model names saved in settings (settings.mjs).
const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAIza[0-9A-Za-z_-]{30,}|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\b(?:password|passwd|pwd|passphrase|secret|api[_ -]?key|(?:access[_ -]?|auth[_ -]?)?token)\b["']?\s*[:=]\s*["']?[^\s"']{6,}/i;
export const looksSecret = s => SECRET.test(String(s || ''));

// Aspect ratios the make_image tool accepts. The docs show "1:1" and "16:9"; the rest are the usual ones and Google refuses
// one the model does not take (a plain 'refused').
export const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];

export const PRESETS = {
  openai: { baseUrl: 'https://api.openai.com/v1/', needsKey: true, tokenField: 'max_completion_tokens', imageModel: 'gpt-image-2', imageStyle: 'openai', images: true, local: false, timeoutMs: 30000 },
  // Google's token-cap field name is unconfirmed (the compatibility page does not say); max_tokens is the guess, and the live check settles it.
  // Images go through Google's documented Interactions route (POST <v1beta>/interactions, header x-goog-api-key), not the compatibility address.
  google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', needsKey: true, tokenField: 'max_tokens', imageModel: 'gemini-nano-banana-2.1', imageStyle: 'google', images: true, local: false, timeoutMs: 30000 },
  // Pictures through OpenRouter's own image route (POST <base>images, documented at openrouter.ai/docs): one request shape for
  // every image model it carries (Gemini family, image-only models). `images` says the provider can make pictures; there is
  // deliberately no default picture model (imageModel null): the owner types the one to use, as OpenRouter writes it.
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1/', needsKey: true, tokenField: 'max_tokens', imageModel: null, imageStyle: 'openrouter', images: true, local: false, timeoutMs: 30000 },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1/', needsKey: false, tokenField: 'max_tokens', imageModel: null, local: true, timeoutMs: 120000 }
};

// Fixed words per kind: what the page, the log and a tool answer say. No provider text goes in.
export const ERROR_MESSAGES = {
  timeout: 'The outside model did not answer in time.',
  'rate-limit': 'The outside model is rate-limited right now.',
  'no-key': 'No key is saved for the outside model.',
  refused: 'The outside model refused the request.',
  'key-rejected': 'The provider did not accept the saved key.',
  'no-credit': 'The provider says the account has no credit for this call. Add credit on its site.',
  'unknown-model':'The provider does not know that model name.',
  'no-route': 'No outside provider is set for this kind of job in the Whole hub panel.',
  'local-only':'This project is set to Local only, and the hub\'s provider is not on this computer.',
  'bad-answer': 'The outside model gave an answer the hub could not read.',
  off: 'Outside models are off for this project.',
  network: 'The outside model could not be reached.',
  busy: 'The graphics card is busy or its free memory could not be read, so the local model was not started.',
  terms: 'This provider is not marked as one that keeps your text private, so it was not used.',
  budget: 'This project has used its allowance for outside calls for now.',
  'needs-any': 'Pictures need this project\'s outside-model setting to be Any (not Off or Local only).',
  'no-image': 'The outside provider chosen for the hub has no picture model.',
  secret: 'The text looks like it holds a key or password, so it was not sent.',
  'too-big': 'The text is over the size limit for an outside draft.'
};
// Kinds that are about the moment, not about the request: a month job that fails with one tries again without counting it
// against the two-failure park.
export const SOFT_KINDS = ['rate-limit', 'timeout', 'busy', 'network'];

export class ProviderError extends Error {
  constructor(kind, { status = null, retryAfterSec = null, provider = null, model = null } = {}) {
    super(ERROR_MESSAGES[kind] || ERROR_MESSAGES.network);
    this.name = 'ProviderError';
    Object.assign(this, { kind, status, retryAfterSec, provider, model });
  }
}

export const isLoopbackUrl = url => {
  try { return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(url).hostname); } catch { return false; }
};

// Estimated dollars for one call: { costUSD, estimated, unit }.
//  - OpenRouter's own figure when it sent one: recorded as reported credits (estimated false, unit 'credits'), not labelled USD;
//  - 0 for a model on this machine (estimated true);
//  - the dated price table (estimated true) while the entry holds;
//  - else costUSD null (unknown), estimated false.
export function estimateCost({ provider, model, input, output, reported = null, today = new Date().toISOString().slice(0, 10) }) {
  if (Number.isFinite(reported)) return { costUSD: reported, estimated: false, unit: 'credits' };
  if (PRESETS[provider]?.local) return { costUSD: 0, estimated: true, unit: 'usd' };
  const p = PRICES[String(model).replace(/^[^/]+\//, '')] || PRICES[model];
  if (!p || today < p.from || (p.until && today > p.until)) return { costUSD: null, estimated: false, unit: 'usd' };
  return { costUSD: (input * p.input + output * p.output) / 1e6, estimated: true, unit: 'usd' };
}

// Free graphics memory in MB through nvidia-smi, or null when it cannot be read. Injectable: tests pass their own reader.
export function nvidiaFreeMB({ run = execFile } = {}) {
  return new Promise(resolve => {
    try {
      run('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { timeout: 5000, windowsHide: true }, (err, out) => {
        if (err) return resolve(null);
        const nums = String(out).split(/\r?\n/).map(s => Number(s.trim())).filter(Number.isFinite);
        resolve(nums.length ? Math.max(...nums) : null);
      });
    } catch { resolve(null); }
  });
}

export class ProviderClient {
  // provider: a preset name. apiKey: given by the hub (ProviderKeys), never by an agent. baseUrl: tests and Ollama only.
  // timeoutMs: how long one call may take (the preset's own when left out: hosted 30 s, Ollama 120 s).
  // freeGpu: after every Ollama job, ask it to unload the model. vramReader / minFreeMB: the guard for a local model.
  constructor({ provider, model, apiKey = null, baseUrl = null, imageModel = null, timeoutMs = null, freeGpu = true, fetchFn = globalThis.fetch, vramReader = nvidiaFreeMB, minFreeMB = 12000 } = {}) {
    const preset = PRESETS[provider];
    if (!preset) throw new ProviderError('refused', { provider, model });
    this.preset = preset;
    this.provider = provider;
    this.model = model;
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || preset.baseUrl).replace(/\/?$/, '/');
    this.imageModel = imageModel || preset.imageModel;
    this.timeoutMs = timeoutMs || preset.timeoutMs;
    this.freeGpu = freeGpu;
    this.fetchFn = fetchFn;
    this.vramReader = vramReader;
    this.minFreeMB = minFreeMB;
    // the loopback rule is the client's own, so no caller can get around it
    if (preset.local && !isLoopbackUrl(this.baseUrl)) throw new ProviderError('refused', { provider, model });
  }

  fail(kind, extra = {}) { return new ProviderError(kind, { provider: this.provider, model: this.model, ...extra }); }

  // One POST, JSON in and out. Throws ProviderError only; the key and the response text never reach its message.
  // base: another base address (Google's picture route); keyHeader: send the key as that header instead of a Bearer token;
  // timeoutMs: this call's own limit (a long draft or a picture takes longer than a one-line answer).
  async post(path, body, signal, { base = this.baseUrl, keyHeader = null, timeoutMs = this.timeoutMs } = {}) {
    if (this.preset.needsKey && !this.apiKey) throw this.fail('no-key');
    const timeout = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) { if (keyHeader) headers[keyHeader] = this.apiKey; else headers.authorization = `Bearer ${this.apiKey}`; }
    let res, json;
    try {
      res = await this.fetchFn(new URL(path, base), { method: 'POST', headers, body: JSON.stringify(body), signal: sig });
      if (!res.ok) { await res.body?.cancel?.().catch(() => { }); throw this.statusError(res); }
      json = await res.json();
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (timeout.aborted) throw this.fail('timeout');
      if (signal?.aborted) throw this.fail('network');
      if (res?.ok) throw this.fail('bad-answer', { status: res.status });
      throw this.fail('network');
    }
    return json;
  }

  statusError(res) {
    const s = res.status;
    if (s === 429) {
      const ra = Number(res.headers?.get?.('retry-after'));
      return this.fail('rate-limit', { status: s, retryAfterSec: Number.isFinite(ra) && ra >= 0 ? ra : null });
    }
    if (s === 401 || s === 403) return this.fail('key-rejected', { status: s });
    if (s === 404) return this.fail('unknown-model', { status: s });
    if (s === 402) return this.fail('no-credit', { status: s });
    if (s >= 500) return this.fail('network', { status: s });
    return this.fail('refused', { status: s });
  }

  // A local model must not start on a busy card: free memory under the threshold, or unreadable, refuses as 'busy'.
  async guardGpu() {
    if (!this.preset.local) return;
    let free = null;
    try { free = await this.vramReader(); } catch { /* unreadable */ }
    if (!Number.isFinite(free) || free < this.minFreeMB) throw this.fail('busy');
  }

  async chat({ system, user, signal, maxTokens = 300, timeoutMs }) {
    const started = Date.now();
    await this.guardGpu();
    try {
      const body = { model: this.model, messages: [...(system ? [{ role: 'system', content: String(system) }] : []), { role: 'user', content: String(user ?? '') }], [this.preset.tokenField]: maxTokens };
      if (this.provider === 'openrouter') { body.provider = { data_collection: 'deny' }; body.usage = { include: true }; }   // no provider that keeps prompts; and its own cost figure back in usage.cost
      const j = await this.post('chat/completions', body, signal, timeoutMs ? { timeoutMs } : {});
      const content = j?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw this.fail('bad-answer');
      const u = j.usage || {};
      const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0, output = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
      const cost = estimateCost({ provider: this.provider, model: this.model, input, output, reported: typeof u.cost === 'number' ? u.cost : null });
      const tokens = { input, output, cacheRead: 0, cacheCreation: 0 };
      const used = {
        via: 'outside', provider: this.provider, model: this.model, tokens, costUSD: cost.costUSD, estimated: cost.estimated, costUnit: cost.unit,
        modelUsage: { [this.model]: { inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost.costUSD ?? 0 } }, ms: Date.now() - started
      };
      // an empty answer was still billed: the error carries the usage so the caller can log it
      if (!content.trim()) throw Object.assign(this.fail('bad-answer'), used);
      return { text: content, stopReason: j.choices[0].finish_reason || null, ...used };
    } finally {
      // after every job on a local model, success or not: free the card
      if (this.provider === 'ollama' && this.freeGpu) await this.unload();
    }
  }

  // Ollama only: the native route takes keep_alive; /v1/chat/completions does not document it, so it is never sent there.
  // Best effort: a failure never fails the job.
  async unload() {
    try {
      const url = new URL('/api/generate', this.baseUrl);
      await this.fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: this.model, keep_alive: 0 }), signal: AbortSignal.timeout(5000) }).then(r => r.body?.cancel?.());
    } catch { /* the model unloads by itself after its idle time */ }
  }

  // One image: { b64 (base64), mime, model, provider, tokens, costUSD, estimated, costUnit, modelUsage, ms }. Ollama has no image
  // route. Google: the Interactions route; the picture's bytes are read from the answer wherever it puts an image block.
  async image(args) {
    try { return await this.imageCall(args); }
    catch (e) { if (e instanceof ProviderError && this.imageModel) e.model = this.imageModel; throw e; }   // a failure names the picture model, not the text one
  }

  async imageCall({ prompt, size = '1024x1024', aspectRatio = '1:1', signal, timeoutMs = 90000 }) {
    const started = Date.now();
    const model = this.imageModel;
    if (!model) throw this.fail('no-image');
    let b64, mime = 'image/png', usage = null;
    if (this.preset.imageStyle === 'google') {
      const j = await this.post('interactions', { model, input: String(prompt ?? ''), response_format: { type: 'image', aspect_ratio: aspectRatio } }, signal,
        { base: new URL('..', this.baseUrl).href, keyHeader: 'x-goog-api-key', timeoutMs });
      if (j?.status && j.status !== 'completed') throw this.fail('bad-answer');
      const img = findImage(j);
      if (!img) throw this.fail('bad-answer');
      ({ b64, mime } = img); usage = j.usage || null;
    } else if (this.preset.imageStyle === 'openrouter') {
      // OpenRouter's image route: POST <base>images { model, prompt, n, aspect_ratio, output_format } answers
      // { data: [{ b64_json, media_type }], usage: { ..., cost } }. The same request serves its Gemini-family and its image-only
      // models. PNG is asked for (a model that can only answer SVG is refused below: the thread stores raster pictures only), and
      // the provider is told not to keep the prompt, as for text. An address in the answer is never fetched.
      const j = await this.post('images', { model, prompt: String(prompt ?? ''), n: 1, aspect_ratio: aspectRatio, output_format: 'png', provider: { data_collection: 'deny' } }, signal, { timeoutMs });
      const d = j?.data?.[0];
      if (!d || typeof d.b64_json !== 'string' || !d.b64_json) throw this.fail('bad-answer');
      mime = typeof d.media_type === 'string' ? d.media_type.toLowerCase() : 'image/png';
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) throw this.fail('bad-answer');
      b64 = d.b64_json; usage = j.usage || null;
    } else {
      const body = { model, prompt: String(prompt ?? ''), n: 1, size };
      const j = await this.post('images/generations', body, signal, { timeoutMs });   // OpenAI's image models always answer base64 and reject response_format
      const d = j?.data?.[0];
      if (!d || typeof d.b64_json !== 'string') throw this.fail('bad-answer');   // never fetch an address the provider names
      b64 = d.b64_json;
    }
    const input = Number(usage?.total_input_tokens ?? usage?.prompt_tokens ?? 0) || 0, output = Number(usage?.total_output_tokens ?? usage?.completion_tokens ?? 0) || 0;
    const ip = PRICES_FOR_IMAGES(model);
    let costUSD = null, estimated = false, costUnit = 'usd';
    if (ip) { costUSD = output > 0 ? (input * ip.inPerM + output * ip.outPerM) / 1e6 : ip.perImage; estimated = true; }
    // OpenRouter's own figure for the call (usage.cost) when it comes back: recorded as reported credits, like its text answers.
    // Without it the cost stays unknown (null), and the caps count the picture at the fallback rate (fallbackCostUSD).
    if (this.provider === 'openrouter' && Number.isFinite(usage?.cost)) { costUSD = usage.cost; estimated = false; costUnit = 'credits'; }
    return {
      b64, mime, via: 'outside', provider: this.provider, model, tokens: { input, output, cacheRead: 0, cacheCreation: 0 }, costUSD, estimated, costUnit,
      modelUsage: { [model]: { inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: costUSD ?? 0 } }, ms: Date.now() - started
    };
  }
}

const PRICES_FOR_IMAGES = model => IMAGE_PRICES[model] || null;

// The first image block in a Google answer: { b64, mime }. Looks where the Interactions answer puts it (steps, model_output,
// content blocks with type "image" and base64 "data") and where the older generateContent answer does (inlineData), so a
// small change of shape on Google's side does not break a call. Depth is limited; an address ("uri") is never followed.
export function findImage(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 7) return null;
  if (Array.isArray(node)) { for (const x of node) { const f = findImage(x, depth + 1); if (f) return f; } return null; }
  const inl = node.inlineData || node.inline_data;
  if (inl && typeof inl.data === 'string' && /^image\//.test(inl.mimeType || inl.mime_type || '')) return { b64: inl.data, mime: inl.mimeType || inl.mime_type };
  if (node.type === 'image' && typeof node.data === 'string' && node.data.length > 16) return { b64: node.data, mime: /^image\//.test(node.mime_type || '') ? node.mime_type : 'image/png' };
  for (const k of ['steps', 'content', 'parts', 'candidates', 'outputs', 'output']) { const f = findImage(node[k], depth + 1); if (f) return f; }
  return null;
}
