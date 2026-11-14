// The memory board: every agent reads its index before starting (decision 0011).
// Decisions come from the Crux records in .decisions/*.json (Crux keeps writing them).
// Requirements, conventions, memos and handoffs are typed entries built from the event log
// (decision 0009): same lifecycle idea, superseded rather than deleted. A finished memo can be marked done: it leaves
// the index and stays readable in full.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { refreshPages } from '../../crux/scripts/build.mjs';
import { placeImages, placedImages } from '../../crux/scripts/images.mjs';
import { leadOf, briefData } from '../../crux/scripts/brief.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BUILD = resolve(here, '../../crux/scripts/build.mjs');
export const ENTRY_KINDS = ['requirement', 'convention', 'memo', 'handoff'];
const PREFIX = { requirement: 'R', convention: 'C', memo: 'M', handoff: 'H' };
export const DONE_KINDS = ['memo'];   // entries that can be marked done (and back)

export class Board {
  // desk: the project's DecisionsDesk (decision 35). Records are read from the main folder and from the desk's
  // worktree (unmerged picks and drafts, which win); picks are written only through the desk.
  constructor(projectDir, log, { desk = null } = {}) {
    this.dir = projectDir;
    this.decisionsDir = join(projectDir, '.decisions');
    this.log = log;
    this.desk = desk;
  }

  // ---------- decisions (Crux records) ----------
  readDir(dir) {
    if (!dir || !existsSync(dir)) return [];
    return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
      try {
        const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        d._file = f;
        return d;
      } catch { return null; }
    }).filter(d => d && Number.isFinite(Number(d.id)));
  }

  decisions() {
    const byId = new Map();
    for (const d of this.readDir(this.decisionsDir)) byId.set(Number(d.id), d);
    if (this.desk?.ready()) for (const d of this.readDir(this.desk.decisionsDir)) byId.set(Number(d.id), { ...d, _pending: true });
    return [...byId.values()].sort((a, b) => a.id - b.id);
  }

  decision(id) { return this.decisions().find(d => d.id === Number(id)); }

  // Decision 41: the pages are built locally, not pulled from git, so after a pull they can be missing or older than
  // their records. Rebuild them (pages only, never the .md or anything git tracks) wherever the board reads records.
  freshPages() {
    const dirs = [this.decisionsDir];
    if (this.desk?.ready()) dirs.push(this.desk.decisionsDir);
    for (const d of dirs) {
      if (!existsSync(d)) continue;
      try { refreshPages(d); } catch (e) { console.warn('Crux page refresh failed:', e.message); }
    }
  }

  // A decision page to serve: the worktree's copy when it has one, else the main folder's. Stale pages are rebuilt
  // first; if a page still cannot be had, its .md record is served instead.
  pageFile(name) {
    this.freshPages();
    const file = this.desk?.page(name) || join(this.decisionsDir, name);
    if (existsSync(file) || name === 'index.html') return file;
    const md = name.replace(/\.html$/, '.md');
    return this.desk?.page(md) || (existsSync(join(this.decisionsDir, md)) ? join(this.decisionsDir, md) : file);
  }

  // Writes only the user's fields (status, chosen, reason, decided_on), then rebuilds the pages: through the desk's
  // worktree and branch when the project is a git repo (never into the main folder), else in place.
  pick(id, choice, reason) {
    const d = this.decision(id);
    if (!d) throw new Error(`No decision ${id}`);
    if (!['open', 'found'].includes(d.status)) throw new Error(`Decision ${id} is ${d.status}, not open`);
    if (d.status === 'found') {
      d.status = choice === 'reject' ? 'rejected' : 'decided';
    } else {
      if (!d.options.some(o => o.key === choice)) throw new Error(`Decision ${id} has no option ${choice}`);
      d.status = 'decided';
      d.chosen = choice;
    }
    d.reason = reason || d.reason || '';
    d.decided_on = new Date().toISOString().slice(0, 10);
    const name = d._file;
    delete d._file; delete d._pending;
    if (this.desk?.usable()) {
      d._landed = this.desk.record({ [name]: d }, `Record pick: D${String(d.id).padStart(4, '0')} ${d.chosen || d.status}`);
      return d;
    }
    writeFileSync(join(this.decisionsDir, name), JSON.stringify(d, null, 1) + '\n');
    try { placeImages(this.decisionsDir, { attachments: join(this.dir, '.crux', 'attachments'), roots: [this.dir] }); }   // decision 43
    catch (e) { console.warn('Copying decision pictures failed:', e.message); }
    this.rebuild();
    return d;
  }

  // A record picture to serve (decision 43): the worktree's copy first, else the main folder's. Names only, no folders.
  imageFile(name) {
    if (!/^[\w.-]+\.(png|jpg|gif|webp)$/.test(String(name)) || String(name).startsWith('.')) return null;
    const f = this.desk?.image(name) || join(this.decisionsDir, 'images', name);
    return existsSync(f) ? f : null;
  }

  rebuild() {
    if (!existsSync(BUILD) || !existsSync(this.decisionsDir)) return;
    try { execFileSync(process.execPath, [BUILD, this.decisionsDir], { stdio: 'ignore', timeout: 30000 }); }
    catch (e) { console.warn('Crux build failed:', e.message); }
  }

  // ---------- typed entries from the event log ----------
  entries() {
    const byId = new Map();
    for (const ev of this.log.ofType('entry')) {
      byId.set(ev.entryId, { ...ev, status: 'active' });
      if (ev.supersedes && byId.has(ev.supersedes)) byId.get(ev.supersedes).status = 'superseded';
    }
    for (const ev of this.log.ofType('entry_retired')) {
      if (byId.has(ev.entryId)) byId.get(ev.entryId).status = 'retired';
    }
    // Marked done, or back to active (Matt's yes, 2026-11-12): only between those two, so superseded or retired wins.
    // The newest event counts. A done entry leaves the index but is still read in full.
    for (const ev of this.log.ofType('entry_status')) {
      const e = byId.get(ev.entryId);
      if (!e || !['active', 'done'].includes(e.status) || !['active', 'done'].includes(ev.status)) continue;
      e.status = ev.status;
      if (ev.status === 'done') e.done = { from: ev.from, ts: ev.ts, ...(ev.note ? { note: ev.note } : {}) };
      else delete e.done;
    }
    // Questions the next holder asked at a handoff are kept with it (decision 16).
    for (const ev of this.log.ofType('handoff_qa')) {
      const h = byId.get(ev.entryId);
      if (h) (h.qa ||= []).push({ from: ev.from, q: ev.q, a: ev.a });
    }
    return [...byId.values()];
  }

  addEntry({ kind, title, summary, body, supersedes, from, ...extra }) {
    if (!ENTRY_KINDS.includes(kind)) throw new Error(`Unknown entry kind ${kind}`);
    const n = this.log.ofType('entry').filter(e => e.kind === kind).length + 1;
    const entryId = `${PREFIX[kind]}${String(n).padStart(3, '0')}`;
    return this.log.append('entry', { entryId, kind, title, summary, body, supersedes: supersedes || null, from, ...extra });
  }

  // The orchestrator role's latest handoff (workers' handoffs are read by their own successors). The Conductor's
  // board (in the hub's own state folder, decision 55) asks for role 'conductor'.
  latestHandoff(role = 'orchestrator') {
    return this.entries().filter(e => e.kind === 'handoff' && e.status === 'active' && (e.role || 'orchestrator') === role).at(-1) || null;
  }

  retireEntry(entryId, why, from) {
    const e = this.entries().find(x => x.entryId.toUpperCase() === String(entryId).toUpperCase());
    if (!e || e.status !== 'active' || e.kind === 'handoff') return null;
    return this.log.append('entry_retired', { entryId: e.entryId, why, from });
  }

  // Mark an entry done, or back to active: a new event, never an edit to the log. Memos only for now. Throws a plain
  // reason for anything it refuses (unknown id, superseded or retired, not a memo, no change).
  setEntryStatus(entryId, status, from, note = '') {
    if (!['done', 'active'].includes(status)) throw new Error(`Unknown status ${status}`);
    const e = this.entries().find(x => x.entryId.toUpperCase() === String(entryId || '').trim().toUpperCase());
    if (!e) throw new Error(`Nothing on the board with id ${entryId}.`);
    if (!DONE_KINDS.includes(e.kind)) throw new Error(`${e.entryId} is a ${e.kind}; only memos can be marked done.`);
    if (!['active', 'done'].includes(e.status)) throw new Error(`${e.entryId} is already ${e.status}, so it is off the active list.`);
    if (e.status === status) throw new Error(`${e.entryId} is already ${status}.`);
    const n = String(note || '').trim().slice(0, 300);
    return this.log.append('entry_status', { entryId: e.entryId, status, from, ...(n ? { note: n } : {}) });
  }

  // One line per active item: the start-up reading for every agent.
  index() {
    const lines = [];
    const ds = this.decisions();
    const active = ds.filter(d => ['decided', 'open', 'found', 'parked'].includes(d.status));
    if (active.length) {
      lines.push('## Decisions');
      for (const d of active) {
        const pick = d.status === 'decided' ? ` -> ${d.chosen ? d.chosen + ': ' + (d.options.find(o => o.key === d.chosen)?.name || '') : 'confirmed'}` : '';
        lines.push(`- D${String(d.id).padStart(4, '0')} [${d.status}] ${d.title}${pick}`);
      }
    }
    const es = this.entries().filter(e => e.status === 'active');
    for (const kind of ENTRY_KINDS) {
      const of = es.filter(e => e.kind === kind);
      if (kind === 'handoff') continue; // only the latest handoff is read, separately
      if (!of.length) continue;
      lines.push(`## ${kind[0].toUpperCase() + kind.slice(1)}s`);
      for (const e of of) lines.push(`- ${e.entryId} ${e.title}: ${e.summary || ''}`);
    }
    return lines.length ? lines.join('\n') : '(The board is empty so far.)';
  }

  read(id) {
    const m = /^D?0*(\d+)$/i.exec(id);
    if (m && /^D|^\d/i.test(id)) {
      const d = this.decision(m[1]);
      if (d) return d;
    }
    return this.entries().find(e => e.entryId.toUpperCase() === String(id).toUpperCase()) || null;
  }

  // A decision's brief for the card's pop-up (decision 50): plain data, sketches as pictures. Null for an unknown id.
  brief(id) {
    const d = this.decision(id);
    return d ? { ...briefData(d), page: `${String(d.id).padStart(4, '0')}-${d.slug}.html` } : null;
  }

  // What the interface shows in the board panel.
  snapshot() {
    return {
      decisions: this.decisions().map(d => ({
        id: d.id, slug: d.slug, title: d.title, status: d.status, chosen: d.chosen, recommended: d.recommended,
        confidence: d.confidence, context: d.context, recommendation: d.recommendation,
        lead: leadOf(d),   // decision 50: the card opens on the written answer; the rest of the brief loads on request
        options: (d.options || []).map(o => ({ key: o.key, name: o.name, summary: o.summary })),
        images: placedImages(d),   // decision 43: { file: "images/...", caption, option? }, served at /p/<project>/images/
        page: `${String(d.id).padStart(4, '0')}-${d.slug}.html`
      })),
      entries: this.entries()
    };
  }
}
