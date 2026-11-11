// Hub settings you change from the hub page, kept in ~/.crux-hub/settings.json (or CRUX_HUB_DATA), never in a repo.
// Starting values can come from ~/crux/hub.json; a change made in the page wins from then on.
//   routePermissions: workers' permission requests go to the orchestrator first (decision 21). On by default.
//   permissionTimeoutSec: how long the orchestrator has to answer before the card comes to you.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const SETTING_DEFAULTS = { routePermissions: true, permissionTimeoutSec: 120 };

export class HubSettings {
  constructor({ dir = process.env.CRUX_HUB_DATA || join(homedir(), '.crux-hub'), initial = {}, file } = {}) {
    this.file = file === undefined ? join(dir, 'settings.json') : file;   // file: null keeps settings in memory only
    let saved = {};
    if (this.file && existsSync(this.file)) { try { saved = JSON.parse(readFileSync(this.file, 'utf8')); } catch { } }
    this.values = { ...SETTING_DEFAULTS, ...pick(initial), ...pick(saved) };
  }
  get(k) { return this.values[k]; }
  all() { return { ...this.values }; }
  set(changes) {
    const c = pick(changes);
    Object.assign(this.values, c);
    if (this.file) {
      mkdirSync(join(this.file, '..'), { recursive: true });
      let saved = {};
      try { saved = JSON.parse(readFileSync(this.file, 'utf8')); } catch { }
      writeFileSync(this.file, JSON.stringify({ ...saved, ...c }, null, 2));
    }
    return this.all();
  }
}

function pick(o = {}) {
  const out = {};
  if (typeof o.routePermissions === 'boolean') out.routePermissions = o.routePermissions;
  const t = Number(o.permissionTimeoutSec);
  if (o.permissionTimeoutSec != null && Number.isFinite(t) && t >= 10 && t <= 3600) out.permissionTimeoutSec = t;
  return out;
}
