#!/usr/bin/env node
// Run by the installer (installer-hooks.nsh) with the app's own Node, before an update replaces this folder's files
// and before an uninstall removes them: stops the hub only if it was started from this install folder. A hub run
// from a clone (hubDir in hub.json, or any other folder) is never touched. After an update the app starts the hub
// again by itself, the usual way.
//   <install>\runtime\node\node.exe <install>\runtime\stop-bundled-hub.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, pidsOnPort, stopTree, waitFor, ping } from './hub/lib/relaunch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hubDir = resolve(here, 'hub');
const inside = (p, dir) => { const r = relative(dir, resolve(p)); return !!r && !r.startsWith('..') && !isAbsolute(r); };

let stopped = 0;
let names = [];
try { names = readdirSync(dataDir()).filter(n => /^launch-\d+\.json$/.test(n)); } catch { }
for (const name of names) {
  let spec;
  try { spec = JSON.parse(readFileSync(join(dataDir(), name), 'utf8')); } catch { continue; }
  const script = (spec.args || []).map(String).find(a => /server\.mjs$/.test(a));
  if (!script || !inside(resolve(String(spec.cwd || ''), script), hubDir)) continue;
  const port = Number(spec.port || name.match(/\d+/)[0]);
  if (!await ping(port)) continue;
  for (const pid of await pidsOnPort(port)) if (await stopTree(pid)) stopped++;
  await waitFor(async () => !(await pidsOnPort(port)).length, { timeoutMs: 10000 });
  console.log(`Stopped the hub on port ${port} (started from this install).`);
}
if (!stopped) console.log('No hub from this install was running.');
