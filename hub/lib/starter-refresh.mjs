// Keeps the expedition agent files a person copied into ~/.claude/agents (or a project's .claude/agents) up to date.
// Only expedition-*.md, and only a copy that is still exactly an earlier shipped version (listed by hash in
// agent-types/starter/previous-hashes.json): that copy was not edited, so it is replaced by the current file. An edited copy
// is left alone and one line says so. refreshExpeditionFiles never adds a file; addMissingExpeditionFiles (below) puts a file
// that is missing from ~/.claude/agents there, so a fresh install needs no copying by hand. Line endings do not count as an edit.
// WHEN YOU EDIT an expedition-*.md in agent-types/starter, add the hashOf() of its text on main BEFORE the edit to
// previous-hashes.json (git show origin/main:agent-types/starter/<file>), or installed copies are never refreshed (PR 127 missed it).
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const STARTER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent-types', 'starter');
export const hashOf = text => createHash('sha256').update(String(text).replace(/\r/g, '')).digest('hex').slice(0, 16);

// A fresh install has none of the expedition files, so the hub adds any that are missing from the one folder every project
// reads (~/.claude/agents). A file that is there, edited or not, is never touched. Returns { added: [names], failed: string|null }.
export function addMissingExpeditionFiles(dir, { starter = STARTER, log = console.log } = {}) {
  const out = { added: [], failed: null };
  try {
    const current = readdirSync(starter).filter(f => /^expedition-.*\.md$/.test(f));
    const missing = current.filter(f => !existsSync(join(dir, f)));
    if (!missing.length) return out;
    mkdirSync(dir, { recursive: true });
    for (const f of missing) { writeFileSync(join(dir, f), readFileSync(join(starter, f), 'utf8'), { flag: 'wx' }); out.added.push(f); }
  } catch (e) {
    out.failed = e?.message || String(e);
    log(`Could not add the expedition agent files to ${dir}: ${out.failed}. Copy them from agent-types/starter by hand.`);
  }
  if (out.added.length) log(`Added ${out.added.length} missing expedition agent file(s) to ${dir}: ${out.added.join(', ')}.`);
  return out;
}

// dirs: the .claude/agents folders to look in. Returns { refreshed: [paths], kept: [paths] }.
export function refreshExpeditionFiles(dirs, { starter = STARTER, log = console.log } = {}) {
  const out = { refreshed: [], kept: [] };
  let previous = {};
  try { previous = JSON.parse(readFileSync(join(starter, 'previous-hashes.json'), 'utf8')); } catch { /* none shipped */ }
  const current = readdirSync(starter).filter(f => /^expedition-.*\.md$/.test(f));
  for (const dir of dirs) {
    for (const f of current) {
      const file = join(dir, f);
      if (!existsSync(file)) continue;
      const have = readFileSync(file, 'utf8'), want = readFileSync(join(starter, f), 'utf8');
      const h = hashOf(have);
      if (h === hashOf(want)) continue;
      if ((previous[f] || []).includes(h)) { writeFileSync(file, want); out.refreshed.push(file); }
      else { out.kept.push(file); log(`Agent file ${file} differs from this hub's ${f} and was edited, so it was left as it is.`); }
    }
  }
  if (out.refreshed.length) log(`Updated ${out.refreshed.length} expedition agent file(s) to this hub's version: ${out.refreshed.map(p => p.split(/[\\/]/).pop()).join(', ')}.`);
  return out;
}
