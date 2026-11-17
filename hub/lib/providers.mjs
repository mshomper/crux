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
// Read 2026-11-17 from the providers' own pages where they could be opened (Gemini) and from third-party listings otherwise
// (OpenAI: see the expedition notes). A model not listed costs null (unknown); OpenRouter answers with its own cost.
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

export const PRESETS = {
  openai: { baseUrl: 'https://api.openai.com/v1/', needsKey: true, tokenField: 'max_completion_tokens', imageModel: 'gpt-image-2', local: false, timeoutMs: 30000 },
  google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', needsKey: true, tokenField: 'max_tokens', imageModel: 'gemini-3.1-flash-image', local: false, timeoutMs: 30000 },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1/', needsKey: true, tokenField: 'max_tokens', imageModel: null, local: false, timeoutMs: 30000 },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1/', needsKey: false, tokenField: 'max_tokens', imageModel: null, local: true, timeoutMs: 120000 }
};

// Fixed words per kind: what the page, the log and a tool answer say. No provider text goes in.
export const ERROR_MESSAGES = {
  timeout: 'The outside model did not answer in time.',
  'rate-limit': 'The outside model is rate-limited right now.',
  'no-key': 'No key is saved for the outside model.',
  refused: 'The outside model refused the request.',
  'bad-answer': 'The outside model gave an answer the hub could not read.',
  off: 'Outside models are off for this project.',
  network: 'The outside model could not be reached.',
  busy: 'The graphics card is busy or its free memory could not be read, so the local model was not started.',
  terms: 'This provider is not marked as one that keeps your text private, so it was not used.',
  budget: 'This project has used its allowance for outside calls for now.'
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
  async post(path, body, signal) {
    if (this.preset.needsKey && !this.apiKey) throw this.fail('no-key');
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    let res, json;
    try {
      res = await this.fetchFn(new URL(path, this.baseUrl), { method: 'POST', headers, body: JSON.stringify(body), signal: sig });
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
    if (s === 401 || s === 403) return this.fail('refused', { status: s });
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

  async chat({ system, user, signal, maxTokens = 300 }) {
    const started = Date.now();
    await this.guardGpu();
    try {
      const body = { model: this.model, messages: [...(system ? [{ role: 'system', content: String(system) }] : []), { role: 'user', content: String(user ?? '') }], [this.preset.tokenField]: maxTokens };
      if (this.provider === 'openrouter') body.provider = { data_collection: 'deny' };   // no provider that keeps prompts
      const j = await this.post('chat/completions', body, signal);
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

  // One image: { b64 (base64) or url, model, provider, costUSD: null, ms }. Ollama has no image route.
  async image({ prompt, size = '1024x1024', signal }) {
    const started = Date.now();
    const model = this.imageModel;
    if (!model) throw this.fail('refused');
    const body = { model, prompt: String(prompt ?? ''), n: 1, size };
    if (this.provider !== 'openai') body.response_format = 'b64_json';   // OpenAI's image models always answer base64 and reject the field
    const j = await this.post('images/generations', body, signal);
    const d = j?.data?.[0];
    if (!d || (typeof d.b64_json !== 'string' && typeof d.url !== 'string')) throw this.fail('bad-answer');
    return { b64: d.b64_json || null, url: d.b64_json ? null : d.url, via: 'outside', provider: this.provider, model, costUSD: null, estimated: false, ms: Date.now() - started };
  }
}
