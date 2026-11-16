// The Expedition module (decisions 68 to 72), phase 1: ids, the .crux/expeditions/<id>/ layout, files, the event kinds
// and the state read back from them. Nothing here starts an agent or a timer; the hub, the watchdog (phase 3) and the
// end sequence (phase 5) use it. Private to the project like events.jsonl (kept out of git); the report is copied onto
// the branch at the end.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

// ---------- roles (spec section 3) ----------
// runs: 'hub' = its own hub agent under the Lead (thread, station, usage and permission requests of its own);
// 'subagent' = a Claude Code subagent inside the Lead (decision 68 C). One line to change if Matt moves a role.
export const ROLES = {
  lead: { type: 'expedition-lead', model: 'opus', effort: 'medium', runs: 'hub', label: 'Lead' },
  advisor: { type: 'expedition-advisor', model: 'fable', effort: 'medium', runs: 'hub', label: 'Advisor' },
  gatherer: { type: 'expedition-gatherer', model: 'haiku', effort: 'low', runs: 'subagent', label: 'Gatherer' },
  synthesizer: { type: 'expedition-synthesizer', model: 'opus', effort: 'medium', runs: 'hub', label: 'Synthesizer' },
  skeptic: { type: 'expedition-skeptic', model: 'sonnet', effort: 'high', runs: 'hub', label: 'Skeptic' },
  builder: { type: 'expedition-builder', model: 'sonnet', effort: 'medium', runs: 'hub', label: 'Builder' },
  verifier: { type: 'expedition-verifier', model: 'opus', effort: 'high', runs: 'hub', label: 'Verifier' }
};
export const HUB_ROLES = Object.keys(ROLES).filter(r => ROLES[r].runs === 'hub');
export const roleOfType = type => Object.keys(ROLES).find(r => ROLES[r].type === type) || null;
export const defaultRoles = () => Object.fromEntries(Object.entries(ROLES).map(([r, x]) => [r, { type: x.type, model: x.model, effort: x.effort }]));

// Spec 4.4: 6 hours and 7% of the plan, by default. dollars: the cap the watchdog enforces (null until Matt confirms the
// figure, decision 69); the plan percentage stays on record next to it.
export const DEFAULT_ENVELOPE = { hours: 6, percent: 7, dollars: null };

// ---------- the event kinds (spec 4.3, plus the plan's three) ----------
export const EVENT_KINDS = ['expedition_started', 'expedition_gate', 'expedition_decision', 'expedition_parked', 'expedition_loop', 'expedition_stopped', 'expedition_note', 'expedition_step', 'expedition_subagent'];
export const STOP_REASONS = ['passed', 'time', 'budget', 'no-progress', 'Matt'];
// The end (spec 4.8), as logged steps: each is skipped if its event exists, so the end never runs twice.
export const END_STEPS = ['report', 'commit', 'push', 'pr', 'card', 'summary'];

export const ID_PATTERN = /^\d{8}-[a-z0-9]+(-[a-z0-9]+)*$/;
const pad2 = n => String(n).padStart(2, '0');
const sha = data => createHash('sha256').update(data).digest('hex');
const text = (v, what) => { const s = String(v ?? '').trim(); if (!s) throw new Error(`${what} is needed.`); return s; };

// The files an agent may write by name; test/ holds anything under it. frozen/ and the rest are the hub's.
const FIXED = ['BRIEF.md', 'PLAN.md', 'DECISIONS.md', 'synthesis.md', 'skeptic.md', 'REPORT.md', 'verify/VERDICT.md'];
const NOTES = /^notes-[A-Za-z0-9][\w-]*\.md$/;

export class Expedition {
  constructor(project, id) {
    if (!ID_PATTERN.test(String(id))) throw new Error(`"${id}" is not an expedition id (YYYYMMDD-slug).`);
    this.project = project;
    this.id = id;
    this.root = join(project.dir, '.crux', 'expeditions', id);
    this.cache = null;
  }

  // YYYYMMDD-slug from the question's words; a second one on the same day with the same slug gets -2, -3.
  static makeId(source, { date = new Date(), taken = [] } = {}) {
    const day = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
    const slug = String(source ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'expedition';
    let id = `${day}-${slug}`, n = 2;
    while (taken.includes(id)) id = `${day}-${slug}-${n++}`;
    return id;
  }

  // Every expedition the log knows, oldest first, each as { id, phase }; for the handoff facts and the map.
  static all(project) {
    const ids = [...new Set(project.log.events.filter(e => e.type === 'expedition_started' && e.expedition).map(e => e.expedition))];
    return ids.map(id => ({ id, phase: new Expedition(project, id).state().phase }));
  }

  // A project may override a role's model; the Verifier must never run on the Builder's (spec section 3). null when fine.
  static rolesProblem(roles) {
    const b = roles?.builder?.model, v = roles?.verifier?.model;
    return b && v && b === v ? `The Verifier and the Builder both run on ${b}. The Verifier must be a different model from the Builder, so change one of them.` : null;
  }

  // ---------- files ----------
  // A path inside this expedition's folder, or a throw: only the layout's own names, no .., no absolute paths.
  path(rel) {
    const clean = posix.normalize(String(rel ?? '').replace(/\\/g, '/'));
    const ok = FIXED.includes(clean) || NOTES.test(clean) || (clean.startsWith('test/') && clean.length > 5 && !clean.split('/').includes('..'));
    if (!ok || clean.startsWith('/') || /^[A-Za-z]:/.test(clean)) throw new Error(`"${rel}" is not a file of an expedition.`);
    return join(this.root, ...clean.split('/'));
  }
  init() {
    for (const d of ['', 'test', 'verify']) mkdirSync(join(this.root, d), { recursive: true });
    return this;
  }
  exists(rel) { return existsSync(this.path(rel)); }
  read(rel) { try { return readFileSync(this.path(rel), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  write(rel, body) { const f = this.path(rel); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, String(body ?? '')); return f; }
  append(rel, body) { const f = this.path(rel); mkdirSync(join(f, '..'), { recursive: true }); appendFileSync(f, String(body ?? '')); return f; }
  // Every file of this expedition, as paths relative to its folder with forward slashes, sorted.
  files() {
    const out = [];
    const walk = dir => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const f = join(dir, name);
        if (statSync(f).isDirectory()) walk(f); else out.push(f.slice(this.root.length + 1).replace(/\\/g, '/'));
      }
    };
    walk(this.root);
    return out.sort();
  }
  testFiles() { return this.files().filter(f => f.startsWith('test/')); }

  // The hash the freeze logs (spec 4.5): sorted paths plus bytes of everything under test/, SHA-256.
  testHash() {
    const files = this.testFiles();
    if (!files.length) throw new Error('The success test is empty: put CHECKLIST.md or run.json in test/ first.');
    const h = createHash('sha256');
    for (const f of files) h.update(f).update('\0').update(readFileSync(join(this.root, ...f.split('/')))).update('\0');
    return h.digest('hex');
  }
  briefHash() { return sha(text(this.read('BRIEF.md'), 'BRIEF.md')); }

  // The build target (spec 4.2): a worktree on its own branch.
  get branch() { return `expedition/${this.id}`; }
  get worktree() { return join(this.project.dir, '.claude', 'worktrees', `exp-${this.id}`); }

  // ---------- events: every one carries expedition: <id> ----------
  record(kind, data = {}) {
    if (!EVENT_KINDS.includes(kind)) throw new Error(`Unknown expedition event ${kind}.`);
    const ev = this.project.log.append(kind, { ...data, expedition: this.id });
    return ev;
  }
  need(...phases) {
    const p = this.state().phase;
    if (!phases.includes(p)) throw new Error(`Expedition ${this.id} is ${p}; this needs it to be ${phases.join(' or ')}.`);
  }

  // Launch: records the brief's hash, the envelope, the roles and the plan-meter readings at the start (spec 4.3).
  start({ envelope = {}, roles = {}, planStart = null } = {}) {
    this.need('new');
    const merged = Object.fromEntries(Object.entries(defaultRoles()).map(([r, d]) => [r, { ...d, ...(roles[r] || {}) }]));
    const problem = Expedition.rolesProblem(merged);
    if (problem) throw new Error(problem);
    return this.record('expedition_started', { briefHash: this.briefHash(), envelope: { ...DEFAULT_ENVELOPE, ...envelope }, roles: merged, planStart, branch: this.branch });
  }

  // The plan gate closes: the Advisor's verdict, the amendments to the test, and the hash that freezes it (spec 4.5).
  // Amendments are possible only before this; a second gate is refused.
  gate({ verdict, amendments = [] } = {}) {
    this.need('planning');
    return this.record('expedition_gate', { verdict: text(verdict, 'The Advisor\'s verdict'), amendments: [].concat(amendments).map(String).filter(Boolean), testHash: this.testHash() });
  }

  // One decision on Matt's behalf: one numbered line in DECISIONS.md and one event (spec 6).
  decide({ text: what, reason, maker }) {
    this.need('planning', 'running', 'stopped', 'ended');
    const n = this.state().decisions.length + 1;
    const line = `${n}. ${text(what, 'The decision')}. Reason: ${text(reason, 'The reason')}. By: ${text(maker, 'Who made it')}.`;
    this.append('DECISIONS.md', `${line}\n`);
    return this.record('expedition_decision', { number: n, text: String(what).trim(), reason: String(reason).trim(), maker: String(maker).trim() });
  }

  // Something outside the brief, or an escalation that would have been a card (spec 4.6). kind 'lesson': a core lesson held for the report.
  park({ text: what, reason, maker = null, kind = 'parked', ...rest }) {
    this.need('planning', 'running', 'stopped', 'ended');
    return this.record('expedition_parked', { text: text(what, 'What was parked'), reason: text(reason, 'The reason'), ...(maker ? { maker } : {}), ...(kind !== 'parked' ? { kind } : {}), ...rest });
  }

  // A build-verify loop ended (spec 4.3): its number, the items passing, and whether that is progress.
  loop({ number, passing, progress }) {
    this.need('running');
    if (!Number.isInteger(number) || number < 1) throw new Error('A loop has a number from 1.');
    if (!Number.isInteger(passing) || passing < 0) throw new Error('A loop reports how many items pass.');
    return this.record('expedition_loop', { number, passing, progress: !!progress });
  }

  // The end: why, and the totals at that moment (the watchdog's, phase 3).
  stop({ reason, totals = {} }) {
    this.need('planning', 'running');
    if (!STOP_REASONS.includes(reason)) throw new Error(`A stop reason is one of ${STOP_REASONS.join(', ')}.`);
    return this.record('expedition_stopped', { reason, totals });
  }

  // The 90% note (phase 3): logged, so a restart does not send it twice.
  note(note, data = {}) {
    this.need('running');
    return this.record('expedition_note', { note: text(note, 'The note'), ...data });
  }

  // One end step (phase 5). Idempotent: null when this step is already in the log.
  step(step, data = {}) {
    if (!END_STEPS.includes(step)) throw new Error(`An end step is one of ${END_STEPS.join(', ')}.`);
    this.need('stopped');
    if (this.state().steps.has(step)) return null;
    return this.record('expedition_step', { step, ...data });
  }

  // A subagent (gatherer) started or ended inside the Lead (phase 2 writes these from the SDK's task messages).
  subagent({ phase, subagentType, taskId, tokens = null }) {
    if (!['started', 'ended'].includes(phase)) throw new Error('A subagent event is started or ended.');
    return this.record('expedition_subagent', { phase, subagentType: text(subagentType, 'The subagent type'), taskId: text(taskId, 'The task id'), ...(tokens != null ? { tokens } : {}) });
  }

  // ---------- state, rebuilt from the log ----------
  // phase: new (no start event), planning (started, gate open), running (gate closed, test frozen), stopped (end
  // sequence under way) or ended (the Lead's one summary sent).
  state() {
    const events = this.project.log.events;
    if (this.cache?.n === events.length) return this.cache.s;
    const mine = events.filter(e => e.expedition === this.id);
    const of = type => mine.filter(e => e.type === type);
    const s = {
      started: of('expedition_started')[0] || null, gate: of('expedition_gate')[0] || null, stopped: of('expedition_stopped')[0] || null,
      decisions: of('expedition_decision'), parked: of('expedition_parked'), loops: of('expedition_loop'), notes: of('expedition_note'), subagents: of('expedition_subagent'),
      steps: new Set(of('expedition_step').map(e => e.step))
    };
    s.phase = !s.started ? 'new' : s.steps.has('summary') ? 'ended' : s.stopped ? 'stopped' : s.gate ? 'running' : 'planning';
    this.cache = { n: events.length, s };
    return s;
  }
  hasStep(step) { return this.state().steps.has(step); }
  // The Lead's one summary may go to the orchestrator once the report, branch and card are done (phase 5 order), and only once.
  summaryDue() { const s = this.state(); return s.phase === 'stopped' && s.steps.has('card'); }
  // Gatherers running right now, from the started/ended events (a count for the map's badge).
  runningSubagents() {
    const open = new Set();
    for (const e of this.state().subagents) { if (e.phase === 'started') open.add(e.taskId); else open.delete(e.taskId); }
    return open.size;
  }
}
