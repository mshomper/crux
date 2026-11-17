#!/usr/bin/env node
// Stages two demo projects (a trail planner and a trail journal), builds Crux's all-projects roll-up from them with the
// real roll-up script, and shoots it into site/img/crux-all.png (1440 x 1000). Everything is written under the temp
// folder and removed again; nothing real is read. The roll-up prints the folders it scanned, so the shot replaces
// that path with a neutral "~/Projects".
//   node site-tools/stage/crux-all.mjs
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const worktree = resolve(here, '../..');
const root = join(tmpdir(), 'crux-all-demo');
const projects = join(root, 'Projects'), home = join(root, 'crux-home');
rmSync(root, { recursive: true, force: true });

const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const opt = (key, name, summary = '') => ({ source: 'claude', key, name, summary, pros: [], cons: [], effort: 'Small' });
const rec = (id, slug, title, o) => ({ id, slug, title, date: day(10), mode: 'full', lenses: [], status: 'open', context: '', depends_on: [], conflicts: [], options: [], criteria: [], recommended: null, recommendation: '', confidence: 'lean', chosen: null, reason: '', decided_on: null, superseded_by: null, challenge: null, settles: [], ...o });
const decided = (n, extra) => ({ status: 'decided', chosen: extra.chosen, decided_on: day(n), ...extra });

const planner = [
  rec(1, 'trail-map-drawing', 'Where should the trail map be drawn?', decided(9, { lenses: ['architecture'], options: [opt('A', 'Vector tiles in the browser'), opt('B', 'Pictures from a server')], chosen: 'A', recommended: 'A', reason: 'Smooth zoom matters most when reading contours on a small screen.' })),
  rec(2, 'distances-in-miles', 'Distances are stored in miles', decided(9, { lenses: ['data-model'], options: [opt('A', 'Miles'), opt('B', 'Kilometres')], chosen: 'B', holding_up: 'strained', deliberate: 'yes', strain: 'Decision 0004 saves routes as GPX, which is metric, so every save and load now converts miles back and forth.' })),
  rec(3, 'walking-time', 'How should the planner estimate walking time?', { lenses: ['research', 'architecture'], deep: true, options: [opt('A', 'Flat speed'), opt('B', "Tobler's hiking function")], recommended: 'B', recommendation: "Leaning: Tobler's hiking function", confidence: 'lean' }),
  rec(4, 'route-format', 'How are planned routes saved and shared?', decided(3, { lenses: ['data-model', 'ui'], deep: true, options: [opt('A', 'Our own file'), opt('B', 'GPX file')], chosen: 'B', recommended: 'B', reason: 'Friends load routes on their watches, so the file has to be GPX.', settles: [{ key: 'distance unit', value: 'kilometres' }] })),
  rec(5, 'offline-maps', 'Should maps be kept for areas with no signal?', { lenses: ['data-model'], status: 'parked', revisit: { date: '2027-03-01', trigger: 'when the first user asks for it' } })
];
const journal = [
  rec(1, 'journal-unit', 'Which unit does the journal use for distance?', decided(5, { lenses: ['data-model'], options: [opt('A', 'Miles'), opt('B', 'Kilometres')], chosen: 'A', recommended: 'A', reason: 'Matches the guidebooks.', settles: [{ key: 'distance unit', value: 'miles' }] }))
];
for (const [name, list] of [['trail-planner', planner], ['trail-journal', journal]]) {
  const dir = join(projects, name, '.decisions');
  mkdirSync(dir, { recursive: true });
  for (const d of list) writeFileSync(join(dir, `${String(d.id).padStart(4, '0')}-${d.slug}.json`), JSON.stringify(d, null, 1) + '\n');
}
mkdirSync(home, { recursive: true });

const env = { ...process.env, CRUX_HOME: home, CRUX_ROOTS: projects };
const r1 = spawnSync(process.execPath, [join(worktree, 'crux', 'scripts', 'rollup.mjs')], { env, stdio: 'inherit' });
const page = join(home, 'index.html');
if (r1.status || !existsSync(page)) { console.error('The roll-up was not built.'); process.exit(1); }

// The roll-up's header names the scanned folder: show a neutral one.
const neutral = `(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let n; (n = w.nextNode());) n.nodeValue = n.nodeValue.split(${JSON.stringify(projects)}).join('~/Projects'); })()`;
const out = join(worktree, 'site', 'img', 'crux-all.png');
const r2 = spawnSync(process.execPath, [join(worktree, 'site-tools', 'shoot.mjs'), '--root', home, '--url', 'index.html', '--w', '1440', '--h', '1000', '--view', '--wait', '1500', '--eval', neutral, '--out', out], { stdio: 'inherit' });
rmSync(root, { recursive: true, force: true });
process.exit(r2.status || 0);
