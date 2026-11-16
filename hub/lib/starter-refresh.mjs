// Keeps the expedition agent files a person copied into ~/.claude/agents (or a project's .claude/agents) up to date.
// Only expedition-*.md, and only a copy that is still exactly an earlier shipped version (listed by hash in
// agent-types/starter/previous-hashes.json): that copy was not edited, so it is replaced by the current file. An edited copy
// is left alone and one line says so. A file that is not installed is not added. Line endings do not count as an edit.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const STARTER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent-types', 'starter');
export const hashOf = text => createHash('sha256').update(String(text).replace(/\r/g, '')).digest('hex').slice(0, 16);

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
