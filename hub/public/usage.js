// Usage numbers (decision 36): what an agent's results add up to, and where the plan's limits stand.
// Plain functions, shared by the hub (lib/usage.mjs) and the page (usage-ui.js), so both read the same shapes.
//
// Two sources, kept apart:
//   per result  - the SDK's modelUsage: running totals per model for one query (so we log the difference, never
//                 the total: adding totals up counts the early turns again and again)
//   plan limits - the experimental usage call and the rate_limit events: percent used and reset time per window
import { family } from './models.js';

export const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheCreation'];
const ZERO = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 });
const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);

// ---------- per-result accounting ----------
// The SDK's modelUsage (one entry per model id, running totals) in the shape the log keeps.
export function totalsOf(modelUsage = {}) {
  const out = {};
  for (const [model, u] of Object.entries(modelUsage || {})) {
    out[model] = { input: num(u?.inputTokens), output: num(u?.outputTokens), cacheRead: num(u?.cacheReadInputTokens), cacheCreation: num(u?.cacheCreationInputTokens), cost: num(u?.costUSD) };
  }
  return out;
}

// What one result added: current totals minus the totals we had before. A model whose totals went down was
// reset (a /clear, or a session that did not carry its totals over): its current totals are all new.
// Models with nothing new are left out.
export function diffTotals(prev, cur) {
  const delta = {};
  let reset = false;
  for (const [model, c] of Object.entries(cur || {})) {
    const p = prev?.[model];
    const down = p && (c.cost < p.cost - 1e-12 || TOKEN_KEYS.some(k => c[k] < p[k]));
    if (down) reset = true;
    const base = !p || down ? ZERO() : p;
    const d = { cost: Math.max(0, c.cost - base.cost) };
    for (const k of TOKEN_KEYS) d[k] = Math.max(0, c[k] - base[k]);
    if (d.cost > 1e-12 || TOKEN_KEYS.some(k => d[k] > 0)) delta[model] = d;
  }
  return { delta, reset };
}

export const sumCost = models => Object.values(models || {}).reduce((s, m) => s + num(m.cost), 0);

// Totals by model and by agent from the usage events of every project (rows: { project, ev }), for events
// at or after `since` (a time in ms). Estimates: the SDK's own price list, not a bill.
export function aggregate(rows, { since = 0 } = {}) {
  const models = {}, agents = {};
  const total = ZERO();
  for (const { project, ev } of rows) {
    if (ev.type !== 'usage' || Date.parse(ev.ts) < since) continue;
    const a = agents[`${project}\u0000${ev.agent}`] ||= { project, agent: ev.agent, ...ZERO(), models: {} };
    for (const [id, d] of Object.entries(ev.models || {})) {
      const m = models[id] ||= ZERO();
      for (const k of [...TOKEN_KEYS, 'cost']) { m[k] += num(d[k]); a[k] += num(d[k]); total[k] += num(d[k]); }
      a.models[id] = (a.models[id] || 0) + num(d.cost);
    }
  }
  for (const a of Object.values(agents)) a.model = Object.entries(a.models).sort((x, y) => y[1] - x[1])[0]?.[0] || null;
  const fable = Object.entries(models).filter(([id]) => family(id) === 'fable').reduce((s, [, m]) => s + m.cost, 0);
  const fableTokens = Object.entries(models).filter(([id]) => family(id) === 'fable').reduce((s, [, m]) => s + m.input + m.output, 0);
  return {
    models: Object.entries(models).map(([id, m]) => ({ id, ...m })).sort((x, y) => y.cost - x.cost || y.output - x.output),
    agents: Object.values(agents).sort((x, y) => y.cost - x.cost || y.output - x.output),
    total,
    fable: { cost: fable, share: total.cost > 0 ? fable / total.cost : 0, tokenShare: total.input + total.output > 0 ? fableTokens / (total.input + total.output) : 0 }
  };
}

// ---------- plan windows ----------
const round1 = x => Math.round(x * 10) / 10;
const pct = u => (u == null || !Number.isFinite(Number(u)) ? null : Math.min(100, Math.max(0, round1(Number(u)))));
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// The usage call's answer as the hub keeps it, or null when plan limits do not apply (an API key, or the call gave
// nothing usable). Windows: the 5-hour and 7-day ones. Models: every per-model weekly window the account has
// (the server's model_scoped list, for example "Fable"), plus the older Opus and Sonnet weekly windows.
export function normalizePlan(resp, asOf = new Date().toISOString()) {
  const rl = resp?.rate_limits;
  if (!resp || resp.rate_limits_available === false || !rl || typeof rl !== 'object') return null;
  const win = (key, label, w) => (w && pct(w.utilization) != null ? { key, label, pct: pct(w.utilization), resetsAt: w.resets_at || null } : null);
  const windows = { five_hour: win('five_hour', '5-hour', rl.five_hour), seven_day: win('seven_day', '7-day', rl.seven_day) };
  const models = [];
  const add = (label, w) => {
    const id = slug(label);
    if (!id || !w || pct(w.utilization) == null || models.some(m => m.key === id)) return;
    models.push({ key: id, label, pct: pct(w.utilization), resetsAt: w.resets_at || null });
  };
  for (const m of Array.isArray(rl.model_scoped) ? rl.model_scoped : []) add(m?.display_name, m);
  add('Opus', rl.seven_day_opus);
  add('Sonnet', rl.seven_day_sonnet);
  if (!windows.five_hour && !windows.seven_day && !models.length) return null;
  const ex = rl.extra_usage;
  return {
    subscription: resp.subscription_type || null,
    windows, models,
    extra: ex?.is_enabled && pct(ex.utilization) != null ? { pct: pct(ex.utilization) } : null,
    statuses: {},
    asOf
  };
}

// An event's reset time is in seconds since 1970; the usage call's is an ISO time.
const isoFromSeconds = s => (Number.isFinite(Number(s)) && Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null);

// A streamed rate_limit_event's info. status: allowed, allowed_warning or rejected, for rateLimitType. Its
// unifiedWindows carry utilization as a fraction of 1 (0.53 is 53 percent), unlike the usage call's 0 to 100.
export function readRateLimit(info) {
  if (!info || typeof info !== 'object') return null;
  const statuses = {}, windows = {};
  const type = info.rateLimitType;
  if (type && info.status) statuses[type] = info.status;
  for (const [key, w] of Object.entries(info.unifiedWindows || {})) {
    if (w?.status) statuses[key] = w.status;
    if (Number.isFinite(Number(w?.utilization))) windows[key] = { pct: pct(Number(w.utilization) * 100), resetsAt: isoFromSeconds(w.resetsAt) };
  }
  if (type && !windows[type] && Number.isFinite(Number(info.utilization)) && Number(info.utilization) <= 1) windows[type] = { pct: pct(Number(info.utilization) * 100), resetsAt: isoFromSeconds(info.resetsAt) };
  return { statuses, windows };
}

// An event's numbers laid over the last snapshot: percent and reset time for windows we already show, and the status of any.
export function applyRateLimit(plan, read, asOf = new Date().toISOString()) {
  if (!plan || !read) return plan;
  const next = { ...plan, windows: { ...plan.windows }, models: plan.models.map(m => ({ ...m })), statuses: { ...plan.statuses, ...read.statuses }, asOf };
  for (const [key, w] of Object.entries(read.windows)) {
    if (w.pct == null) continue;
    if (next.windows[key]) next.windows[key] = { ...next.windows[key], pct: w.pct, resetsAt: w.resetsAt || next.windows[key].resetsAt };
    else for (const m of next.models) if (key === `seven_day_${m.key}`) { m.pct = w.pct; m.resetsAt = w.resetsAt || m.resetsAt; }
  }
  return next;
}

// Worth writing to the log: a window or model appears or goes, moves two points or more, resets (a new reset
// time), or its status changes. Anything smaller is kept in memory only.
export function planChanged(a, b) {
  if (!a || !b) return !!a !== !!b;
  const keys = p => [...['five_hour', 'seven_day'].filter(k => p.windows[k]), ...p.models.map(m => 'm:' + m.key)];
  const get = (p, k) => (k.startsWith('m:') ? p.models.find(m => 'm:' + m.key === k) : p.windows[k]);
  const ka = keys(a), kb = keys(b);
  if (ka.length !== kb.length || ka.some(k => !kb.includes(k))) return true;
  for (const k of ka) {
    const x = get(a, k), y = get(b, k);
    if (Math.abs(x.pct - y.pct) >= 2 || (x.resetsAt || '') !== (y.resetsAt || '')) return true;
  }
  const sa = a.statuses || {}, sb = b.statuses || {};
  return [...new Set([...Object.keys(sa), ...Object.keys(sb)])].some(k => (sa[k] || 'allowed') !== (sb[k] || 'allowed'));
}

// Decision 31: red only when something is blocked (rejected); amber for a warning (allowed_warning, or 80% and up).
export function meterTone(percent, status = 'allowed') {
  if (status === 'rejected') return 'red';
  if (status === 'allowed_warning' || Number(percent) >= 80) return 'amber';
  return 'ok';
}

// The meters the strip shows, in order: 5-hour, 7-day, then each per-model window (Fable first). Each has its
// tone. A window the plan does not have right now (the 5-hour one when nothing has run for hours) shows as idle.
export function meterList(plan) {
  if (!plan) return [];
  const st = plan.statuses || {};
  const out = [];
  for (const [key, label] of [['five_hour', '5h'], ['seven_day', '7d']]) {
    const w = plan.windows[key];
    out.push(w ? { key, label, full: w.label, pct: w.pct, resetsAt: w.resetsAt, tone: meterTone(w.pct, st[key]), idle: false } : { key, label, full: key === 'five_hour' ? '5-hour' : '7-day', pct: null, resetsAt: null, tone: 'ok', idle: true });
  }
  const models = [...plan.models].sort((x, y) => (y.key === 'fable') - (x.key === 'fable'));
  for (const m of models) out.push({ key: m.key, label: m.label, full: `${m.label} (7-day)`, pct: m.pct, resetsAt: m.resetsAt, tone: meterTone(m.pct, st[`seven_day_${m.key}`] || st[m.key]), idle: false, model: m.key });
  return out;
}

// ---------- words ----------
export function fmtTokens(n) {
  n = num(n);
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${n < 1e4 ? (n / 1e3).toFixed(1) : Math.round(n / 1e3)}k`.replace('.0k', 'k');
  return `${n < 1e7 ? (n / 1e6).toFixed(1) : Math.round(n / 1e6)}M`.replace('.0M', 'M');
}
export function fmtCost(c) {
  c = num(c);
  return c > 0 && c < 0.01 ? '<$0.01' : `$${c.toFixed(c >= 100 ? 0 : 2)}`;
}
// Time left until a reset, as short as it can be: "42m", "3h 10m", "2d 4h".
export function fmtLeft(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const m = Math.round((t - now) / 60000);
  if (m <= 0) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 && h < 10 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
