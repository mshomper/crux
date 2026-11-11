// The memory board: every agent reads its index before starting (decision 0011).
// Decisions come from the Crux records in .decisions/*.json (Crux keeps writing them).
// Requirements, conventions, memos and handoffs are typed entries built from the event log
// (decision 0009): same lifecycle idea, superseded rather than deleted.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BUILD = resolve(here, '../../crux/scripts/build.mjs');
export const ENTRY_KINDS = ['requirement', 'convention', 'memo', 'handoff'];
const PREFIX = { requirement: 'R', convention: 'C', memo: 'M', handoff: 'H' };

export class Board {
  constructor(projectDir, log) {
    this.dir = projectDir;
    this.decisionsDir = join(projectDir, '.decisions');
    this.log = log;
  }

  // ---------- decisions (Crux records) ----------
  decisions() {
    if (!existsSync(this.decisionsDir)) return [];
    return readdirSync(this.decisionsDir).filter(f => f.endsWith('.json')).map(f => {
      try {
        const d = JSON.parse(readFileSync(join(this.decisionsDir, f), 'utf8'));
        d._file = f;
        return d;
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => a.id - b.id);
  }

  decision(id) { return this.decisions().find(d => d.id === Number(id)); }

  // Writes only the human's fields (status, chosen, reason, decided_on), then rebuilds the pages.
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
    const file = join(this.decisionsDir, d._file);
    delete d._file;
    writeFileSync(file, JSON.stringify(d, null, 1) + '\n');
    this.rebuild();
    return d;
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

  // The orchestrator role's latest handoff (workers' handoffs are read by their own successors).
  latestHandoff() {
    return this.entries().filter(e => e.kind === 'handoff' && e.status === 'active' && (e.role || 'orchestrator') === 'orchestrator').at(-1) || null;
  }

  retireEntry(entryId, why, from) {
    const e = this.entries().find(x => x.entryId.toUpperCase() === String(entryId).toUpperCase());
    if (!e || e.status !== 'active' || e.kind === 'handoff') return null;
    return this.log.append('entry_retired', { entryId: e.entryId, why, from });
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

  // What the interface shows in the board panel.
  snapshot() {
    return {
      decisions: this.decisions().map(d => ({
        id: d.id, slug: d.slug, title: d.title, status: d.status, chosen: d.chosen, recommended: d.recommended,
        confidence: d.confidence, context: d.context, recommendation: d.recommendation,
        options: (d.options || []).map(o => ({ key: o.key, name: o.name, summary: o.summary })),
        page: `${String(d.id).padStart(4, '0')}-${d.slug}.html`
      })),
      entries: this.entries()
    };
  }
}
