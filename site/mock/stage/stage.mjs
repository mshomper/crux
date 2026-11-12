#!/usr/bin/env node
// Stages a fictional project for Crux Hub screenshots. No dependencies; writes only under the system temp folder.
//   node site/mock/stage/stage.mjs
// Makes <temp>/crux-page-demo/ with:
//   home/                 stands in for the home folder, so the hub reads no real settings or agent types
//   crux-home/profile/    a tiny profile: the hub calls the user Alex
//   hub-data/             empty; a hub whose data folder is in temp is a test hub and starts no agents
//   trailhead/            the demo project: .crux/events.jsonl and .decisions/*.json (from fixture.mjs)
// Then prints the environment variables and the command that starts a test hub on port 4801.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROJECT, profileCore, decisions, events } from './fixture.mjs';

const PORT = 4801;
const root = join(tmpdir(), 'crux-page-demo');
const dirs = { home: join(root, 'home'), crux: join(root, 'crux-home'), data: join(root, 'hub-data'), project: join(root, PROJECT) };

rmSync(root, { recursive: true, force: true });   // only ever this script's own folder in temp
for (const d of [dirs.home, join(dirs.crux, 'profile'), dirs.data, join(dirs.project, '.crux'), join(dirs.project, '.decisions')]) mkdirSync(d, { recursive: true });

writeFileSync(join(dirs.crux, 'profile', 'core.md'), profileCore);

const now = Date.now();
const today = new Date(now).toISOString().slice(0, 10);
for (const d of decisions) {
  const { decided, ...rec } = d;
  rec.date = today;
  if (decided) Object.assign(rec, { status: 'decided', chosen: decided, decided_on: today });
  writeFileSync(join(dirs.project, '.decisions', `${String(rec.id).padStart(4, '0')}-${rec.slug}.json`), JSON.stringify(rec, null, 1) + '\n');
}

// Oldest first; events sharing a minute keep their order, one second apart.
const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => b.e.ago - a.e.ago || a.i - b.i);
const lines = sorted.map(({ e: { ago, ...ev } }, n) => JSON.stringify({ id: randomUUID(), ts: new Date(now - ago * 60000 + n * 1000).toISOString(), ...ev }));
writeFileSync(join(dirs.project, '.crux', 'events.jsonl'), lines.join('\n') + '\n');

const server = resolve(dirname(fileURLToPath(import.meta.url)), '../../../hub/server.mjs');
const env = { CRUX_HOME: dirs.crux, CRUX_HUB_DATA: dirs.data, USERPROFILE: dirs.home, HOME: dirs.home, CRUX_HUB_AGENTS: '0' };
console.log(`Staged ${lines.length} events and ${decisions.length} decisions in ${root}\n`);
console.log('Environment variables:');
for (const [k, v] of Object.entries(env)) console.log(`  ${k}=${v}`);
console.log('\nStart the test hub (bash):');
console.log(`  ${Object.entries(env).map(([k, v]) => `${k}="${v}"`).join(' ')} node "${server}" --port ${PORT} --no-agents "${dirs.project}"`);
console.log(`\nStop it:  node hub/tools/stop-test-hub.mjs ${PORT}`);
