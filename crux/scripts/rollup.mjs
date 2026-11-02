#!/usr/bin/env node
// Cross-project roll-up: gathers every repo's .decisions/ into one page and a conventions list.
// Runs automatically at the end of build.mjs; can also be run on its own:  node rollup.mjs
// Folders scanned: "roots" in ~/crux/config.json, else ~/Documents/GitHub.
// Folders skipped: "ignore" in the same file (folder names, or full paths).
// Output: ~/crux/index.html and ~/crux/conventions.md
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tpl = join(here, '..', 'template');
const STALE_DAYS = 14;

export function rollup({ quiet = false } = {}) {
  const home = process.env.CRUX_HOME || join(homedir(), 'crux');
  const cfgPath = join(home, 'config.json');
  let roots = [join(homedir(), 'Documents', 'GitHub')];
  let ignore = [];
  if (process.env.CRUX_ROOTS) roots = process.env.CRUX_ROOTS.split(/[;,]/).filter(Boolean);
  else if (existsSync(cfgPath)) {
    try { const c = JSON.parse(readFileSync(cfgPath, 'utf8')); if (Array.isArray(c.roots) && c.roots.length) roots = c.roots; if (Array.isArray(c.ignore)) ignore = c.ignore; }
    catch (e) { console.log(`Roll-up: could not read ${cfgPath} (${e.message}); using the default folder.`); }
  }
  roots = roots.map(r => resolve(r)).filter(r => existsSync(r));
  if (!roots.length) { if (!quiet) console.log('Roll-up skipped: no project folder found. Add "roots" to ~/crux/config.json.'); return; }

  // Find .decisions folders up to three levels below each root.
  const found = [];
  const skip = new Set(['node_modules', 'dist', 'build', '.git']);
  const low = s => process.platform === 'win32' ? s.toLowerCase() : s;
  const ignoreNames = new Set(ignore.filter(i => !/[\\/]/.test(i)).map(low));
  const ignorePaths = ignore.filter(i => /[\\/]/.test(i)).map(i => low(resolve(i)));
  const ignored = (full, name) => ignoreNames.has(low(name)) || ignorePaths.some(p => low(full) === p || low(full).startsWith(p + (process.platform === 'win32' ? '\\' : '/')));
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || ignored(join(dir, e.name), e.name)) continue;
      if (e.name === '.decisions') { found.push(join(dir, e.name)); continue; }
      if (depth < 3 && !skip.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);

  const today = new Date();
  const all = [];
  for (const d of found) {
    const project = basename(dirname(d));
    for (const f of readdirSync(d).filter(f => f.endsWith('.json'))) {
      try {
        const x = JSON.parse(readFileSync(join(d, f), 'utf8'));
        if (typeof x.id !== 'number' || !x.title) continue;
        const page = join(d, f.replace(/\.json$/, '.html'));
        const ageDays = x.date ? Math.floor((today - new Date(x.date)) / 864e5) : 0;
        all.push({
          project, id: x.id, title: x.title, status: x.status, date: x.date, decided_on: x.decided_on,
          lenses: x.lenses || [], deep: !!x.deep, reason: x.reason,
          chosen: x.chosen, chosenName: (x.options || []).find(o => o.key === x.chosen)?.name || null,
          optionCount: (x.options || []).length,
          revisit: x.revisit || null,
          deliberate: x.deliberate || null, holding_up: x.holding_up || null, strain: x.strain || null, open_item: !!x.open_item,
          recommendedName: (x.options || []).find(o => o.key === x.recommended)?.name || null,
          stale: (x.status === 'open' || x.status === 'found') && ageDays > STALE_DAYS, ageDays,
          settles: x.status === 'decided' ? (x.settles || []) : [],
          url: pathToFileURL(page).href,
          projectIndex: pathToFileURL(join(d, 'index.html')).href
        });
      } catch { /* skip unreadable file */ }
    }
  }

  // Conventions and conflicts: same key settled with different values by active decisions.
  const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const byKey = new Map();
  for (const d of all) for (const s of d.settles) {
    const k = norm(s.key); if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, { key: s.key.trim(), entries: [] });
    byKey.get(k).entries.push({ project: d.project, id: d.id, title: d.title, value: String(s.value ?? '').trim(), url: d.url });
  }
  const conventions = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  const conflicts = conventions.filter(c => new Set(c.entries.map(e => norm(e.value))).size > 1);

  mkdirSync(home, { recursive: true });
  const css = readFileSync(join(tpl, 'shared.css'), 'utf8');
  const page = readFileSync(join(tpl, 'rollup.html'), 'utf8').replace('/*{{CSS}}*/', css)
    .replace('/*{{DATA}}*/', () => JSON.stringify({ built: today.toISOString().slice(0, 16).replace('T', ' '), roots, staleDays: STALE_DAYS, decisions: all, conflicts }).replace(/</g, '\\u003c'));
  writeFileSync(join(home, 'index.html'), page);

  const md = ['# Crux conventions across projects', '', `Built ${today.toISOString().slice(0, 10)}. Reuse these keys when a decision settles the same question.`, ''];
  if (conflicts.length) {
    md.push('## Conflicts', '');
    for (const c of conflicts) md.push(`- **${c.key}**: ${c.entries.map(e => `${e.project} ${String(e.id).padStart(4, '0')} says "${e.value}"`).join('; ')}`);
    md.push('');
  }
  md.push('## Settled', '');
  for (const c of conventions) md.push(`- **${c.key}**: ${c.entries.map(e => `"${e.value}" (${e.project} ${String(e.id).padStart(4, '0')})`).join(', ')}`);
  writeFileSync(join(home, 'conventions.md'), md.join('\n') + '\n');

  const todayIso = today.toISOString().slice(0, 10);
  for (const d of all) if (d.status === 'parked' && d.revisit?.date && d.revisit.date <= todayIso) d.status = 'open', d.revisitDue = true;
  const pending = all.filter(d => d.status === 'open' || d.status === 'found').length;
  if (!quiet || conflicts.length) console.log(`Roll-up: ${found.length} project(s), ${pending} waiting for a call, ${conflicts.length} conflict(s) -> ${join(home, 'index.html')}`);
  for (const c of conflicts) console.log(`- Conflict on "${c.key}": ${c.entries.map(e => `${e.project} says "${e.value}"`).join(' vs ')}`);
}

const same = (x, y) => process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
if (process.argv[1] && same(resolve(process.argv[1]), fileURLToPath(import.meta.url))) rollup();
