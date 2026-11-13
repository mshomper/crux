#!/usr/bin/env node
// Builds decision pages, Markdown records and the index from .decisions/*.json.
// Usage: node build.mjs [decisions-folder]   (default: ./.decisions)
// Also refreshes the cross-project roll-up (see rollup.mjs).
// Decision 41: only the .json and .md records go into git. The pages (*.html, index.html) are rebuilt locally and
// ignored by a .gitignore inside .decisions, which this script writes whenever it builds a folder named .decisions.
// No dependencies. Needs Node 18 or newer (already present wherever Claude Code runs).
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { rollup } from './rollup.mjs';
import { placeImages, placedImages, imageProblems } from './images.mjs';
import { leadOf, forYouOf } from './brief.mjs';

const FOR_YOU_LABEL = { change: '', setup: 'Setup: ', undo: 'Hard to undo: ' };

const here = dirname(fileURLToPath(import.meta.url));
const tpl = join(here, '..', 'template');

const pad = n => String(n).padStart(4, '0');
const safeJson = v => JSON.stringify(v).replace(/</g, '\\u003c');
const fill = (t, data) => t.replace('/*{{DATA}}*/', () => safeJson(data));
const isRecord = d => typeof d?.id === 'number' && !!d.title && Array.isArray(d.options);
// Caption text for Markdown: one line, with the characters that would start formatting or a link escaped.
const mdText = s => String(s).replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]()<>#|!]/g, '\\$&');
const mtime = f => { try { return statSync(f).mtimeMs; } catch { return -1; } };

// How many pages in the folder git still tracks: 0 or more, or null when git is missing or the folder is not in a repo.
export function trackedPages(dir) {
  try {
    const out = String(execFileSync('git', ['ls-files', '--', '*.html'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, windowsHide: true }));
    return out.split('\n').filter(Boolean).length;
  } catch { return null; }
}

// A .decisions folder ignores its generated pages. Adds the line to an existing .gitignore, never rewrites the others.
// Only for folders named .decisions, so a folder like example/demo-decisions keeps its committed pages. A folder whose
// pages git still tracks is left alone (an ignore line does not untrack them): it says so in one line.
// Returns true if it wrote the line, 'tracked' if it left the folder alone, else false.
export function ensureGitignore(dir) {
  if (basename(resolve(dir)) !== '.decisions') return false;
  const file = join(dir, '.gitignore');
  if (pagesLocal(dir)) return false;
  if (trackedPages(dir) > 0) {
    console.log(`Pages in ${dir} are still committed, so no .gitignore was added. To keep them local (decision 41): git rm --cached "*.html" in that folder, then build again.`);
    return 'tracked';
  }
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const head = cur ? cur + (cur.endsWith('\n') ? '' : '\n') : '# Pages are built locally from the .json records (Crux decision 41)\n';
  writeFileSync(file, head + '*.html\n');
  return true;
}

// True when a record's page is missing or older than its .json, or index.html is missing, older than the newest .json,
// or lists a different set of records (one was added or deleted). Template or script changes do not count.
export function pagesStale(dir) {
  let files;
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return false; }
  let newest = -1;
  const paged = new Set();
  for (const f of files) {
    const t = mtime(join(dir, f));
    const page = mtime(join(dir, f.replace(/\.json$/, '.html')));
    if (page < 0) {
      let rec = null;
      try { rec = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { }
      if (isRecord(rec)) return true;   // a file that is not a record never gets a page, so it never counts as stale
      continue;
    }
    if (page < t) return true;
    newest = Math.max(newest, t);
    paged.add(f.replace(/\.json$/, '.html'));
  }
  const index = join(dir, 'index.html');
  if (newest < 0) return false;
  if (mtime(index) < newest) return true;
  // The board embeds each record's page name ("_file"); compare that list with the records on disk.
  let listed;
  try { listed = new Set([...readFileSync(index, 'utf8').matchAll(/"_file":"([\w.-]+\.html)"/g)].map(m => m[1])); } catch { return true; }
  return listed.size !== paged.size || [...paged].some(p => !listed.has(p));
}

// True when the folder's .gitignore keeps its pages out of git (decision 41 is in place there).
export function pagesLocal(dir) {
  try { return /^\*\.html\s*$/m.test(readFileSync(join(dir, '.gitignore'), 'utf8')); } catch { return false; }
}

// The refresh the hub and the roll-up run before they link to a page. Only where the pages are local (ignored and not
// tracked; without git, the .gitignore alone decides), so a repo that still commits its pages never sees a change in
// git. git is asked only once a folder is stale. Returns true if it rebuilt; throws if the build fails.
export function refreshPages(dir) {
  if (!pagesLocal(dir) || !pagesStale(dir) || trackedPages(dir) > 0) return false;
  build(dir, { pagesOnly: true });
  return true;
}

// Where a record's pictures may come from (decision 43): the project folder (the folder above .decisions) and, in a
// worktree, the main checkout git points at, which holds the other worktrees too. Plus the hub's picture store
// (decision 23) for post_visual ids, <main checkout>/.crux/attachments, or null when there is none.
export function picturePlaces(dir) {
  const own = dirname(resolve(dir)), roots = [own];
  try {
    const common = String(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, windowsHide: true })).trim();
    if (basename(common) === '.git') roots.push(dirname(common));
  } catch { }
  const attachments = roots.map(r => join(r, '.crux', 'attachments')).find(a => existsSync(a)) || null;
  return { roots, attachments };
}

// Build one folder. pagesOnly writes just the pages and index.html (the refresh after a pull): no .md, no .gitignore,
// no pictures copied. A full build first copies pictures records name by path or hub id into images/ (decision 43).
// Returns { count, problems }.
export function build(dir, { pagesOnly = false, attachments, roots } = {}) {
  dir = resolve(dir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const problems = [];
  if (!pagesOnly) {
    let places = null;
    const where = () => (places ||= picturePlaces(dir));   // git is asked only when a record names a picture
    // Pictures left out or still waiting are listed below with each record (imageProblems), every build.
    placeImages(dir, { attachments: attachments === undefined ? () => where().attachments : attachments, roots: roots ?? (() => where().roots) });
  }
  const css = readFileSync(join(tpl, 'shared.css'), 'utf8');
  const pageTpl = readFileSync(join(tpl, 'page.html'), 'utf8').replace('/*{{CSS}}*/', css);
  const indexTpl = readFileSync(join(tpl, 'index.html'), 'utf8').replace('/*{{CSS}}*/', css);

  const decisions = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!isRecord(d)) throw new Error('needs id (number), title and options');
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
    if (!pagesOnly) problems.push(...imageProblems(d, dir, d._file.replace(/\.html$/, '.json')));
  }

  if (!pagesOnly) ensureGitignore(dir);
  for (const d of decisions) {
    writeFileSync(join(dir, d._file), fill(pageTpl, { ...d, _links: links, _images: placedImages(d) }));
    if (!pagesOnly) writeFileSync(join(dir, d._file.replace(/\.html$/, '.md')), markdown(d));
  }
  writeFileSync(join(dir, 'index.html'), fill(indexTpl, decisions.map(({ sketch, ...d }) => ({ ...d, options: d.options.map(({ sketch, ...o }) => o) }))));
  return { count: decisions.length, problems };
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
  // Decision 50: the brief written for the human comes first, so GitHub and a phone open on the answer.
  const lead = leadOf(d), forYou = forYouOf(d);
  if (lead || forYou.length) {
    L.push(`## In short`, '');
    if (lead) L.push(lead, '');
    if (forYou.length) { L.push('For you:', ''); for (const x of forYou) L.push(`- ${FOR_YOU_LABEL[x.kind]}${x.text}`); L.push(''); }
  }
  if (d.status === 'decided' && chosen) {
    L.push(`## Decision`, '', `**${d.chosen}: ${chosen.name}.** ${chosen.summary || ''}`);
    if (d.reason) L.push('', `Reason: ${d.reason}`);
    L.push('');
  }
  L.push(`## Context`, '', d.context || '', '');
  // Decision 43: pictures as relative links, so GitHub and a phone show them. Shared ones here, the rest per option.
  const pics = placedImages(d), keys = new Set(d.options.map(o => o.key));
  const pic = i => [`![${mdText(i.caption || 'Picture')}](${i.file.split('/').map(encodeURIComponent).join('/')})`, ...(i.caption ? ['', `*${mdText(i.caption)}*`] : []), ''];
  const shared = pics.filter(i => !keys.has(i.option));
  if (shared.length) { L.push(`## Pictures`, ''); for (const i of shared) L.push(...pic(i)); }
  L.push(`## Options`, '');
  for (const o of d.options) {
    L.push(`### ${o.key}: ${o.name}${o.key === d.chosen ? ' (chosen)' : ''}${o.key === d.recommended ? ' (recommended)' : ''}`, '', o.summary || '');
    const own = pics.filter(i => i.option === o.key);
    if (own.length) { L.push(''); for (const i of own) L.push(...pic(i)); }
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

// Run as a script: build the folder, then refresh the cross-project roll-up (skipped quietly if no project folder is found).
// The skill folder is usually a link, so compare real paths: Node gives import.meta.url as the resolved one.
const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };
const same = (x, y) => process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
if (process.argv[1] && same(real(process.argv[1]), real(fileURLToPath(import.meta.url)))) {
  const dir = resolve(process.argv[2] || '.decisions');
  const { count, problems } = build(dir);
  console.log(`Built ${count} decision(s) and index.html in ${dir}`);
  if (problems.length) { console.log('Problems to fix:'); for (const p of problems) console.log(`- ${p}`); process.exitCode = 1; }
  try { rollup(); } catch (e) { console.log(`Roll-up failed: ${e.message}`); }
}
