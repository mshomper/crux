// Hub settings you change from the hub page, kept in ~/.crux-hub/settings.json (or CRUX_HUB_DATA), never in a repo.
// Starting values can come from ~/crux/hub.json (and the --retire-at start flag); a change made in the page wins from then on.
//   routePermissions: workers' permission requests go to the orchestrator first (decision 21). On by default.
//   permissionTimeoutSec: how long the orchestrator has to answer before the card comes to you.
//   idleHandoffMin: an orchestrator idle this many minutes hands off (decision 37); 0 turns it off.
//   idleFloorPct: ... but only when above this percent of its context.
//   retireAt: the orchestrator hands off at this percent of its context (decision 10).
// The last three are the hub defaults; each project may set its own (decision 44 B), empty meaning "use the hub default".
//   workerHandoffFloorPct: the orchestrator may hand a worker on from this percent of its context (decision 46 A).
//     Hub-wide only: a project whose own mark is at or below it gets the automatic handoff only.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PRESETS, looksSecret } from './providers.mjs';
import { ollamaAddress } from '../public/ollama-address.js';

//   conductorWakes: projects' summaries and cards wake the Conductor (decision 55). The off switch: false in
//     settings.json (or hub.json) and it wakes only for your messages and its reminders.
//   voice: the voice switch (decision 61 A). Off by default; while off the voice helper does not run.
// permissionTimeoutSec: 5 minutes (decision 64 A), so an orchestrator busy with something else does not hand you a
// card just for being slow. Still set from the hub page (10 seconds to an hour).
export const SETTING_DEFAULTS = { routePermissions: true, permissionTimeoutSec: 300, idleHandoffMin: 60, idleFloorPct: 25, retireAt: 60, workerHandoffFloorPct: 35, workerRetireAt: 60, conductorWakes: true, voice: false };
// Decision 64 A raised the timeout to 5 minutes. A shorter one saved before it is raised once, and the file notes it
// (timeoutRaised: 64), so a value you set after that stays as you set it.
export const TIMEOUT_RAISED = 64;
// Hub-wide numbers with no per-project value, and the range each accepts.
// workerRetireAt: workers hand off by themselves at this percent (decision 46), apart from the orchestrator's mark.
export const HUB_NUMBERS = { workerHandoffFloorPct: { min: 0, max: 100 }, workerRetireAt: { min: 1, max: 100 } };
// The handoff numbers a project may set for itself, with the range each accepts.
export const HANDOFF_NUMBERS = {
  idleHandoffMin: { min: 0, max: 24 * 60 },
  idleFloorPct: { min: 0, max: 100 },
  retireAt: { min: 1, max: 100 }   // what --retire-at accepted before it became a saved setting
};
// Permission levels (decisions 34 and 45). 'standard' is shown as Ask. Trusted is set only from the hub page.
export const LEVELS = ['standard', 'auto', 'trusted'];
// The one-shot permission check per project (decision 66): off (the orchestrator answers, as before), shadow (it runs
// beside the orchestrator and only logs), on (it answers allow, deny or escalate to you; the orchestrator is asked only when it gives no valid answer).
export const CHECK_MODES = ['off', 'shadow', 'on'];
// Outside models per project (expedition 20261117): off (default), local (only a model on this machine), any.
// Kept only here, never read from a repo file.
// Decision 81: which provider and model answer is set per job type, hub-wide: ask (a short question), draft (a long draft),
// image (a picture); see pickOutside below. Agents never choose any of it.
export const OUTSIDE_MODES = ['off', 'local', 'any'];
export const OUTSIDE_JOBS = ['ask', 'draft', 'image'];
const OUTSIDE_PRESETS = ['openai', 'google', 'openrouter', 'ollama'];

export class HubSettings {
  constructor({ dir = process.env.CRUX_HUB_DATA || join(homedir(), '.crux-hub'), initial = {}, file } = {}) {
    this.file = file === undefined ? join(dir, 'settings.json') : file;   // file: null keeps settings in memory only
    let saved = {};
    if (this.file && existsSync(this.file)) { try { saved = JSON.parse(readFileSync(this.file, 'utf8')); } catch { } }
    this.values = { ...SETTING_DEFAULTS, ...pick(initial), ...pick(saved) };
    // An Ollama address saved on a route before it had a setting of its own becomes the hub's one address (never over a saved one,
    // not even an empty one: that was chosen).
    if (this.values.outsideOllamaAddress === undefined) {
      const old = Object.values(this.values.outsideRoutes || {}).find(r => r.provider === 'ollama' && r.baseUrl);
      if (old) this.values.outsideOllamaAddress = old.baseUrl;
    }
    // Per project, keyed by its folder: { permissionMode: 'standard' | 'auto' | 'trusted', connectors: bool,
    // idleHandoffMin, idleFloorPct, retireAt } (decisions 34, 44 and 45). A number left out uses the hub default.
    this.projects = saved.projects && typeof saved.projects === 'object' ? saved.projects : {};
    // Routing guide 9.1: the effort levels each model was seen to accept, filled from the SDK's first refusal (lib/agent-types.mjs).
    this.effortCeilings = saved.effortCeilings && typeof saved.effortCeilings === 'object' ? saved.effortCeilings : {};
    // Plan v3 A10: Matt's trusted sites and approved packages (lib/permission-lists.mjs). Here, never in a repo file;
    // null until the first start seeds it.
    this.lists = saved.lists && typeof saved.lists === 'object' ? saved.lists : null;
    // Decision 64 A: a timeout under 5 minutes saved before it is raised once (see TIMEOUT_RAISED).
    // timeoutRaisedFrom: the old value, so the hub can say so once in each orchestrator thread (hub.mjs). A failed
    // write never stops the hub from starting: the raise then simply holds for this run.
    const savedTimeout = pick(saved).permissionTimeoutSec;
    this.timeoutRaisedFrom = null;
    if (this.file && saved.timeoutRaised !== TIMEOUT_RAISED && savedTimeout != null && savedTimeout < SETTING_DEFAULTS.permissionTimeoutSec) {
      this.values.permissionTimeoutSec = SETTING_DEFAULTS.permissionTimeoutSec;
      this.timeoutRaisedFrom = savedTimeout;
      try { this.save({ permissionTimeoutSec: this.values.permissionTimeoutSec, timeoutRaised: TIMEOUT_RAISED }); }
      catch (e) { console.warn(`Hub settings: could not save the raised permission wait (${e.message}); it holds for this run.`); }
    }
  }
  get(k) { return this.values[k]; }
  all() { return { ...this.values }; }
  set(changes) {
    const c = pick(changes);
    Object.assign(this.values, c);
    this.save(c);
    return this.all();
  }
  project(dir) { return this.projects[projectKey(dir)] || null; }
  // The project's outside-models switch: 'off' when unset or anything else.
  outsideLimits(dir) { const p = this.project(dir) || {}; return { callsPerHour: p.outsideCallsPerHour ?? 30, usdPerDay: p.outsideUsdPerDay ?? 0.50 }; }
  outsideSummaries(dir) { return this.project(dir)?.outsideSummaries === true; }
  outsideMode(dir) { const m = this.project(dir)?.outsideModels; return OUTSIDE_MODES.includes(m) ? m : 'off'; }
  // A handoff number for one project: its own when set, else the hub default.
  projectNumber(dir, k) {
    const own = this.project(dir)?.[k];
    return typeof own === 'number' && Number.isFinite(own) ? own : this.values[k];
  }
  // changes: { permissionMode, connectors, idleHandoffMin, idleFloorPct, retireAt }. A number given as null or ''
  // clears the project's own value (back to the hub default); a value out of range is ignored.
  setProject(dir, changes = {}) {
    const k = projectKey(dir);
    const cur = { ...(this.projects[k] || {}) };
    let changed = false;
    if (LEVELS.includes(changes.permissionMode)) { cur.permissionMode = changes.permissionMode; changed = true; }
    if (typeof changes.connectors === 'boolean') { cur.connectors = changes.connectors; changed = true; }   // claude.ai connectors on or off
    // Decision 66: the one-shot permission check (off, shadow, on) and the pause switch. Kept only here, in hub
    // settings: never read from a file in the repo, so a cloned repo cannot turn the check on or off.
    if (CHECK_MODES.includes(changes.permissionCheck)) { cur.permissionCheck = changes.permissionCheck; changed = true; }
    if (typeof changes.paused === 'boolean') { cur.paused = changes.paused; changed = true; }
    if (OUTSIDE_MODES.includes(changes.outsideModels)) { cur.outsideModels = changes.outsideModels; changed = true; }
    // Month summaries stay on Claude unless this separate opt-in is set (default off): archived chat does not go outside
    // just because a project allows outside jobs. No box on the card; set in hub settings.
    if (typeof changes.outsideSummaries === 'boolean') { cur.outsideSummaries = changes.outsideSummaries; changed = true; }
    // the agent tool's allowance per project: calls per hour and estimated dollars per day (null clears to the default)
    for (const n of ['outsideCallsPerHour', 'outsideUsdPerDay']) {
      if (!(n in changes)) continue;
      const v = changes[n];
      if (v === null || v === '') { if (n in cur) { delete cur[n]; changed = true; } continue; }
      if (Number.isFinite(Number(v)) && Number(v) >= 0) { cur[n] = Number(v); changed = true; }
    }
    for (const [n, range] of Object.entries(HANDOFF_NUMBERS)) {
      if (!(n in changes)) continue;
      const v = changes[n];
      if (v === null || v === '') { if (n in cur) { delete cur[n]; changed = true; } continue; }
      const num = Number(v);
      if (Number.isFinite(num) && num >= range.min && num <= range.max) { cur[n] = num; changed = true; }
    }
    if (!changed) return this.project(dir);
    this.projects[k] = cur;
    this.save({ projects: this.projects });
    return this.projects[k];
  }
  setLists(lists) { this.lists = lists; this.save({ lists }); }
  // Every file this version writes carries timeoutRaised, so only a timeout saved before decision 64 A is raised.
  save(c) {
    if (!this.file) return;
    mkdirSync(join(this.file, '..'), { recursive: true });
    let saved = {};
    try { saved = JSON.parse(readFileSync(this.file, 'utf8')); } catch { }
    if ('outsideRoutes' in c) {
      // The older single setting is replaced by the routes, not kept beside them. Its plan terms were read from it at load, so
      // they are written now with the routes (this.values already holds them): dropping it must not lose "paid".
      delete saved.outsideProvider;
      if (!('outsideTerms' in c) && this.values.outsideTerms) saved.outsideTerms = this.values.outsideTerms;
      // Likewise an Ollama address that was read from an old route: the routes saved now carry none, so it is written on its own.
      if (!('outsideOllamaAddress' in c) && this.values.outsideOllamaAddress !== undefined) saved.outsideOllamaAddress = this.values.outsideOllamaAddress;
    }
    writeFileSync(this.file, JSON.stringify({ ...saved, ...c, timeoutRaised: TIMEOUT_RAISED }, null, 2));
  }
}

// One key per project folder, however it was typed: forward slashes, lower case, no trailing slash.
export const projectKey = dir => String(dir).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// One job's route: { provider, model, baseUrl? (Ollama), minFreeMB? }. A picture route's model may be empty (the provider's own
// picture model is used); a text route's may not. A provider with no picture model cannot take the picture job.
function pickRoute(job, r) {
  if (!r || typeof r !== 'object' || !OUTSIDE_PRESETS.includes(r.provider)) return null;
  const model = typeof r.model === 'string' ? r.model.trim().slice(0, 120) : '';
  if (looksSecret(model)) return null;   // a key pasted into a model box is never kept: it would sit in plain text and go to the page
  // A picture route needs a provider that makes pictures, and a model: the provider's own default when it has one, else the one
  // typed (OpenRouter has no default picture model). A text route always needs its model.
  if (job === 'image' ? !PRESETS[r.provider].images || (!model && !PRESETS[r.provider].imageModel) : !model) return null;
  // Ollama's address (decision 82 A): this PC, or one of the owner's Tailscale machines; any other address is refused here,
  // so a route with one is not saved (the hub checks again at every call). Kept as the address the hub calls.
  let baseUrl = null;
  if (r.provider === 'ollama' && typeof r.baseUrl === 'string' && r.baseUrl.trim()) {
    const a = ollamaAddress(r.baseUrl);
    if (!a.ok) return null;
    baseUrl = a.base;
  }
  return {
    provider: r.provider, model: model || null,
    ...(baseUrl ? { baseUrl } : {}),
    ...(Number.isFinite(Number(r.minFreeMB)) && r.minFreeMB !== null && r.minFreeMB !== '' && Number(r.minFreeMB) >= 0 ? { minFreeMB: Number(r.minFreeMB) } : {})
  };
}

// Outside routing (decision 81): outsideRoutes { ask, draft, image } (a job with no entry is not set up) and outsideTerms
// { provider: 'paid' | 'free' | 'unknown' } (what the user knows of each provider's terms for their key: 'paid' means it does
// not train on what is sent; Any mode sends nothing to a provider unless 'paid'). The older single `outsideProvider`
// { provider, model, dataTerms, ... } is read once as all three jobs on that provider, so a setup made before decision 81
// keeps working; it is ignored whenever outsideRoutes is present.
function pickOutside(o) {
  const out = {};
  let routes = null, terms = null;
  if (o.outsideRoutes && typeof o.outsideRoutes === 'object') {
    routes = {};
    for (const job of OUTSIDE_JOBS) { const r = pickRoute(job, o.outsideRoutes[job]); if (r) routes[job] = r; }
  } else if (o.outsideProvider && typeof o.outsideProvider === 'object') {
    const op = o.outsideProvider;
    routes = {};
    for (const job of OUTSIDE_JOBS) { const r = pickRoute(job, job === 'image' ? { ...op, model: null } : op); if (r) routes[job] = r; }
    if (OUTSIDE_PRESETS.includes(op.provider)) terms = { [op.provider]: ['paid', 'free', 'unknown'].includes(op.dataTerms) ? op.dataTerms : 'unknown' };
  }
  if (o.outsideTerms && typeof o.outsideTerms === 'object') {
    terms = { ...(terms || {}) };
    for (const p of OUTSIDE_PRESETS) if (['paid', 'free', 'unknown'].includes(o.outsideTerms[p])) terms[p] = o.outsideTerms[p];
  }
  if (routes) out.outsideRoutes = routes;
  if (terms) out.outsideTerms = terms;
  // One Ollama address for the whole hub, read by every Ollama route and kept whether or not a job uses Ollama (decision 82 A):
  // empty means this PC's default; else this PC on another port, or one of the owner's Tailscale machines. Any other address is
  // not saved. Kept as the address the hub calls.
  if (typeof o.outsideOllamaAddress === 'string') {
    const t = o.outsideOllamaAddress.trim();
    if (!t) out.outsideOllamaAddress = '';
    else { const a = ollamaAddress(t); if (a.ok) out.outsideOllamaAddress = a.base; }
  }
  return out;
}

function pick(o = {}) {
  const out = {};
  if (typeof o.routePermissions === 'boolean') out.routePermissions = o.routePermissions;
  if (typeof o.conductorWakes === 'boolean') out.conductorWakes = o.conductorWakes;
  if (typeof o.voice === 'boolean') out.voice = o.voice;
  Object.assign(out, pickOutside(o));
  const t = Number(o.permissionTimeoutSec);
  if (o.permissionTimeoutSec != null && o.permissionTimeoutSec !== '' && Number.isFinite(t) && t >= 10 && t <= 3600) out.permissionTimeoutSec = t;
  for (const [n, range] of Object.entries(HUB_NUMBERS)) {   // out of range or not a number: ignored, the saved or default stays
    const v = Number(o[n]);
    if (o[n] != null && o[n] !== '' && Number.isFinite(v) && v >= range.min && v <= range.max) out[n] = v;
  }
  for (const [n, range] of Object.entries(HANDOFF_NUMBERS)) {
    if (o[n] == null || o[n] === '') continue;
    const v = Number(o[n]);
    if (Number.isFinite(v) && v >= range.min && v <= range.max) out[n] = v;
    // retireAt (once the --retire-at flag): never silently back to 60. Out of range keeps the nearest allowed value.
    else if (n === 'retireAt' && Number.isFinite(v)) {
      out[n] = Math.min(range.max, Math.max(range.min, v));
      console.warn(`Hub settings: retireAt ${v} is outside ${range.min} to ${range.max}; using ${out[n]}.`);
    } else if (n === 'retireAt') console.warn(`Hub settings: retireAt "${o[n]}" is not a number; keeping ${SETTING_DEFAULTS.retireAt} unless a saved value says otherwise.`);
  }
  return out;
}
