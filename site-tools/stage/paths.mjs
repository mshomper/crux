// Where the staged demo lives (all under the system temp folder) and which ports the test hub uses.
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT = 'trailhead';
export const HUB_PORT = 4801;      // the test hub (never 4747)
export const PROXY_PORT = 4802;    // overlay-proxy.mjs, the address the screenshots are taken from
export const root = join(tmpdir(), 'crux-page-demo');
export const dirs = { home: join(root, 'home'), crux: join(root, 'crux-home'), data: join(root, 'hub-data'), project: join(root, PROJECT) };
export const worktree = resolve(here, '../..');
export const server = join(worktree, 'hub', 'server.mjs');
export const shoot = join(worktree, 'site-tools', 'shoot.mjs');
export const imgDir = join(worktree, 'site', 'img');
// The hub reads everything it would read from the home folder from the demo "home" instead.
export const env = { CRUX_HOME: dirs.crux, CRUX_HUB_DATA: dirs.data, USERPROFILE: dirs.home, HOME: dirs.home, CRUX_HUB_AGENTS: '0' };
