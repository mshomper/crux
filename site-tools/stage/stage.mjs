#!/usr/bin/env node
// Stages a fictional project for Crux Hub screenshots. No dependencies; writes only under the system temp folder.
//   node site-tools/stage/stage.mjs          then start-hub.mjs, overlay-proxy.mjs and shots.mjs
// Makes <temp>/crux-page-demo/ with:
//   home/                 stands in for the home folder: demo agent types in .claude/agents, nothing real is read
//   crux-home/profile/    a tiny profile: the hub calls the user Alex
//   hub-data/             empty; a hub whose data folder is in temp is a test hub and starts no agents
//   trailhead/            the demo project: .crux/events.jsonl, .decisions/*.json, .crux-hub.json (from fixture.mjs)
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { root, dirs, env, server, HUB_PORT, PROXY_PORT } from './paths.mjs';
import { profileCore, agentTypes, projectHubJson, decisions, events } from './fixture.mjs';

rmSync(root, { recursive: true, force: true });   // only ever this script's own folder in temp
const agentsDir = join(dirs.home, '.claude', 'agents');
for (const d of [agentsDir, join(dirs.crux, 'profile'), dirs.data, join(dirs.project, '.crux'), join(dirs.project, '.decisions')]) mkdirSync(d, { recursive: true });

writeFileSync(join(dirs.crux, 'profile', 'core.md'), profileCore);
for (const [name, text] of Object.entries(agentTypes)) writeFileSync(join(agentsDir, `${name}.md`), text);
writeFileSync(join(dirs.project, '.crux-hub.json'), JSON.stringify(projectHubJson, null, 1) + '\n');

const now = Date.now();
const today = new Date(now).toISOString().slice(0, 10);
for (const d of decisions) {
  const { decided, ...rec } = d;
  rec.date = today;
  if (decided) Object.assign(rec, { status: 'decided', chosen: decided, decided_on: today });
  writeFileSync(join(dirs.project, '.decisions', `${String(rec.id).padStart(4, '0')}-${rec.slug}.json`), JSON.stringify(rec, null, 1) + '\n');
}

// Oldest first. "{{t:N}}" in any text becomes the time N minutes ago, written the way the hub writes times.
const stamp = ago => new Date(now - ago * 60000).toISOString();
const fill = v => typeof v === 'string' ? v.replace(/\{\{t:(\d+)\}\}/g, (_, n) => stamp(Number(n)).slice(0, 16).replace('T', ' ') + ' UTC') : v;
const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => b.e.ago - a.e.ago || a.i - b.i);
const lines = sorted.map(({ e: { ago, ...ev } }) => JSON.stringify({ id: randomUUID(), ts: stamp(ago), ...Object.fromEntries(Object.entries(ev).map(([k, v]) => [k, fill(v)])) }));
writeFileSync(join(dirs.project, '.crux', 'events.jsonl'), lines.join('\n') + '\n');

console.log(`Staged ${lines.length} events, ${decisions.length} decisions and ${Object.keys(agentTypes).length} agent types in ${root}\n`);
console.log('The test hub runs with these environment variables (start-hub.mjs sets them):');
for (const [k, v] of Object.entries(env)) console.log(`  ${k}=${v}`);
console.log(`and this command:\n  node "${server}" --port ${HUB_PORT} --no-agents "${dirs.project}"\n`);
console.log('Next:');
console.log('  node site-tools/stage/start-hub.mjs       (keeps running: the test hub)');
console.log(`  node site-tools/stage/overlay-proxy.mjs   (keeps running: http://127.0.0.1:${PROXY_PORT}/)`);
console.log('  node site-tools/stage/shots.mjs           (all screenshots, or name some: shots.mjs hub-hero phone-list)');
console.log(`Stop:  node hub/tools/stop-test-hub.mjs ${PROXY_PORT}   and   node hub/tools/stop-test-hub.mjs ${HUB_PORT}`);
