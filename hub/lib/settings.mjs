// Hub settings you change from the hub page, kept in ~/.crux-hub/settings.json (or CRUX_HUB_DATA), never in a repo.
// Starting values can come from ~/crux/hub.json (and the --retire-at start flag); a change made in the page wins from then on.
//   routePermissions: workers' permission requests go to the orchestrator first (decision 21). On by default.
//   permissionTimeoutSec: how long the orchestrator has to answer before the card comes to you.
//   idleHandoffMin: an orchestrator idle this many minutes hands off (decision 37); 0 turns it off.
//   idleFloorPct: ... but only when above this percent of its context.
//   retireAt: the orchestrator hands off at this percent of its context (decision 10).
// The last three are the hub defaults; each project may set its own (decision 44 B), empty meaning "use the hub default".
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const SETTING_DEFAULTS = { routePermissions: true, permissionTimeoutSec: 120, idleHandoffMin: 60, idleFloorPct: 25, retireAt: 60 };
// The handoff numbers a project may set for itself, with the range each accepts.
export const HANDOFF_NUMBERS = {
  idleHandoffMin: { min: 0, max: 24 * 60 },
  idleFloorPct: { min: 0, max: 100 },
  retireAt: { min: 10, max: 95 }
};
// Permission levels (decisions 34 and 45). 'standard' is shown as Ask. Trusted is set only from the hub page.
export const LEVELS = ['standard', 'auto', 'trusted'];

export class HubSettings {
  constructor({ dir = process.env.CRUX_HUB_DATA || join(homedir(), '.crux-hub'), initial = {}, file } = {}) {
    this.file = file === undefined ? join(dir, 'settings.json') : file;   // file: null keeps settings in memory only
    let saved = {};
    if (this.file && existsSync(this.file)) { try { saved = JSON.parse(readFileSync(this.file, 'utf8')); } catch { } }
    this.values = { ...SETTING_DEFAULTS, ...pick(initial), ...pick(saved) };
    // Per project, keyed by its folder: { permissionMode: 'standard' | 'auto' | 'trusted', connectors: bool,
    // idleHandoffMin, idleFloorPct, retireAt } (decisions 34, 44 and 45). A number left out uses the hub default.
    this.projects = saved.projects && typeof saved.projects === 'object' ? saved.projects : {};
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
  save(c) {
    if (!this.file) return;
    mkdirSync(join(this.file, '..'), { recursive: true });
    let saved = {};
    try { saved = JSON.parse(readFileSync(this.file, 'utf8')); } catch { }
    writeFileSync(this.file, JSON.stringify({ ...saved, ...c }, null, 2));
  }
}

// One key per project folder, however it was typed: forward slashes, lower case, no trailing slash.
export const projectKey = dir => String(dir).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function pick(o = {}) {
  const out = {};
  if (typeof o.routePermissions === 'boolean') out.routePermissions = o.routePermissions;
  const t = Number(o.permissionTimeoutSec);
  if (o.permissionTimeoutSec != null && o.permissionTimeoutSec !== '' && Number.isFinite(t) && t >= 10 && t <= 3600) out.permissionTimeoutSec = t;
  for (const [n, range] of Object.entries(HANDOFF_NUMBERS)) {
    const v = Number(o[n]);
    if (o[n] != null && o[n] !== '' && Number.isFinite(v) && v >= range.min && v <= range.max) out[n] = v;
  }
  return out;
}
