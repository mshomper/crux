#!/usr/bin/env node
// Builds decision pages, Markdown records and the index from .decisions/*.json.
// Usage: node build.mjs [decisions-folder]   (default: ./.decisions)
// Also refreshes the cross-project roll-up (see rollup.mjs).
// No dependencies. Needs Node 18 or newer (already present wherever Claude Code runs).
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollup } from './rollup.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tpl = join(here, '..', 'template');
const dir = resolve(process.argv[2] || '.decisions');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const css = readFileSync(join(tpl, 'shared.css'), 'utf8');
const pageTpl = readFileSync(join(tpl, 'page.html'), 'utf8').replace('/*{{CSS}}*/', css);
const indexTpl = readFileSync(join(tpl, 'index.html'), 'utf8').replace('/*{{CSS}}*/', css);

const pad = n => String(n).padStart(4, '0');
const safeJson = v => JSON.stringify(v).replace(/</g, '\\u003c');
const fill = (t, data) => t.replace('/*{{DATA}}*/', () => safeJson(data));

const problems = [];
const decisions = [];
for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
  try {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (typeof d.id !== 'number' || !d.title || !Array.isArray(d.options)) throw new Error('needs id (number), title and options');
    d._file = f.replace(/\.json$/, '.html');
    decisions.push(d);
  } catch (e) {
    problems.push(`${f}: ${e.message}`);
  }
}

const links = Object.fromEntries(decisions.map(d => [d.id, d._file]));
const seen = new Map();
for (const d of decisions) {
  if (seen.has(d.id)) problems.push(`Number ${pad(d.id)} is used twice: ${seen.get(d.id)} and ${d._file}`);
  seen.set(d.id, d._file);
  for (const n of [...(d.depends_on || []), ...(d.conflicts || [])]) if (!links[n]) problems.push(`${d._file} refers to missing decision ${pad(n)}`);
  if (d.status === 'decided' && !d.options.some(o => o.key === d.chosen)) problems.push(`${d._file} is decided but its chosen option "${d.chosen}" does not exist`);
}

function markdown(d) {
  const chosen = d.options.find(o => o.key === d.chosen);
  const L = [];
  L.push(`# ${pad(d.id)} ${d.title}`, '');
  L.push(`- Status: ${d.status}${d.superseded_by ? ` (replaced by ${pad(d.superseded_by)})` : ''}`);
  L.push(`- Date: ${d.date}${d.decided_on ? `, decided ${d.decided_on}` : ''}`);
  if (d.lenses?.length) L.push(`- Lenses: ${d.lenses.join(', ')}`);
  if (d.depends_on?.length) L.push(`- Builds on: ${d.depends_on.map(pad).join(', ')}`);
  if (d.status === 'parked' && d.revisit) L.push(`- Revisit: ${[d.revisit.date && `on ${d.revisit.date}`, d.revisit.trigger && d.revisit.trigger].filter(Boolean).join(', or ')}`);
  if (d.deliberate) L.push(`- Deliberate: ${d.deliberate}`);
  if (d.holding_up) L.push(`- Holding up: ${d.holding_up}${d.strain ? `. ${d.strain}` : ''}`);
  if (d.open_item) L.push(`- Open item in the repo's own log`);
  if (d.log_refs?.length) L.push(`- In the repo's log: ${d.log_refs.map(r => `${r.file} ${r.entry || ''}`.trim()).join('; ')}`);
  if (d.settles?.length) L.push(`- Settles: ${d.settles.map(x => `${x.key} = ${x.value}`).join('; ')}`);
  L.push('');
  if (d.status === 'decided' && chosen) {
    L.push(`## Decision`, '', `**${d.chosen}: ${chosen.name}.** ${chosen.summary || ''}`);
    if (d.reason) L.push('', `Reason: ${d.reason}`);
    L.push('');
  }
  L.push(`## Context`, '', d.context || '', '', `## Options`, '');
  for (const o of d.options) {
    L.push(`### ${o.key}: ${o.name}${o.key === d.chosen ? ' (chosen)' : ''}${o.key === d.recommended ? ' (recommended)' : ''}`, '', o.summary || '');
    for (const p of o.pros || []) L.push(`- Pro: ${p}`);
    for (const c of o.cons || []) L.push(`- Con: ${c}`);
    if (o.effort) L.push(`- Effort: ${o.effort}`);
    for (const a of o.assumptions || []) L.push(`- Assumes: ${a}`);
    for (const r of o.risks || []) L.push(`- Risk: ${r}`);
    for (const e of o.estimates || []) L.push(`- Estimate, ${e.what}: ${e.value}${e.basis ? ` (basis: ${e.basis})` : ''}`);
    L.push('');
  }
  if (d.ruled_out?.length) { L.push(`## Ruled out`, ''); for (const r of d.ruled_out) L.push(`- ${r.option} (${r.by})`); L.push(''); }
  if (d.evidence?.length) {
    L.push(`## Evidence`, '');
    for (const e of d.evidence) L.push(`- ${e.claim} [${(e.options || []).join(', ')}] ${e.judgment || !e.url ? "(Claude's judgment)" : `([${e.source || e.url}](${e.url}))`}`);
    L.push('');
  }
  if (d.recommended) L.push(`## Recommendation`, '', `${d.recommended} (${d.confidence || 'no confidence given'}). ${d.recommendation || ''}`, '');
  if (d.change_mind) L.push(`What would change this: ${d.change_mind}`, '');
  if (d.brief && d.status === 'decided') {
    const b = d.brief;
    L.push(`## Build brief`, '');
    if (b.files?.length) { L.push('Files:'); for (const f of b.files) L.push(`- \`${f.path}\`: ${f.change}`); L.push(''); }
    if (b.steps?.length) { L.push('Steps:'); b.steps.forEach((s, i) => L.push(`${i + 1}. ${s}`)); L.push(''); }
    for (const [t, k] of [['Done when', 'done_when'], ['Validation', 'validation'], ['Avoid', 'avoid']]) {
      if (b[k]?.length) { L.push(`${t}:`); for (const x of b[k]) L.push(`- ${x}`); L.push(''); }
    }
  }
  if (d.challenge) L.push(`## Case against the pick`, '', d.challenge, '');
  return L.join('\n');
}

for (const d of decisions) {
  writeFileSync(join(dir, d._file), fill(pageTpl, { ...d, _links: links }));
  writeFileSync(join(dir, d._file.replace(/\.html$/, '.md')), markdown(d));
}
writeFileSync(join(dir, 'index.html'), fill(indexTpl, decisions.map(({ sketch, ...d }) => ({ ...d, options: d.options.map(({ sketch, ...o }) => o) }))));

console.log(`Built ${decisions.length} decision(s) and index.html in ${dir}`);
if (problems.length) { console.log('Problems to fix:'); for (const p of problems) console.log(`- ${p}`); process.exitCode = 1; }

// Refresh the cross-project roll-up (skipped quietly if no project folder is found).
try { rollup(); } catch (e) { console.log(`Roll-up failed: ${e.message}`); }
