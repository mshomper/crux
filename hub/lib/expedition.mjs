// The Expedition module (decisions 68 to 72), phase 1: ids, the .crux/expeditions/<id>/ layout, files, the event kinds
// and the state read back from them. Nothing here starts an agent or a timer; the hub, the watchdog (phase 3) and the
// end sequence (phase 5) use it. Private to the project like events.jsonl (kept out of git); the report is copied onto
// the branch at the end.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync, lstatSync, readlinkSync, rmSync, cpSync, renameSync } from 'node:fs';
import { join, posix, basename } from 'node:path';
import { normalizeOverlay } from './permission-lists.mjs';

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
// Spec lesson 9: a subagent once created a stray scheduled task. No expedition agent (the Lead, the five hub roles, and
// the gatherers inside the Lead) gets scheduling or trigger tools; settings files are denied on write (hub.mjs).
export const DISALLOWED_TOOLS = ['CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'ScheduleWakeup'];
// The gatherer allowance (decision 75 A): at most GATHERER_LIMIT at once, one second round, GATHERER_RUNS gatherer runs in all
// (a reader run, sent with only a page list, counts too). The hub enforces the at-once limit and the total on the Lead's Agent
// calls (Expedition.gathererBlock). The per-gatherer limits (searches, page opens, at least two opened) are in the agent file and
// the Lead's brief; the hub counts a gatherer's calls and logs them (expedition_subagent ended, searches and opens).
export const GATHERER_LIMIT = 4;
export const GATHERER_RUNS = 8;
export const GATHERER_ROUND1 = { searches: 8, opens: 6, minOpened: 2 };
export const GATHERER_TYPE = 'expedition-gatherer';
export const GATHERER_CALL_TTL_MS = 2 * 60 * 1000;   // an allowed call whose task has not started by then is given up (never counts)
// One sentence for every place that states the rule, so the numbers read the same everywhere.
export const gathererRule = (atOnce = GATHERER_LIMIT) => `Gatherers (Agent tool, type ${GATHERER_TYPE}): at most ${atOnce} at once, and one second round, ${GATHERER_RUNS} gatherer runs in all (the hub refuses a ${GATHERER_RUNS + 1}th). Round 1: up to ${GATHERER_ROUND1.searches} web searches and ${GATHERER_ROUND1.opens} page opens each, and at least ${GATHERER_ROUND1.minOpened} pages actually opened; notes cite only pages opened. Round 2: each gatherer gets a list of pages (the gaps round 1 flagged) to read, not open-ended searching. A reader run (a page list to read, no searching) is allowed and counts inside the ${GATHERER_RUNS}. One cap covers every run, round 1, round 2 or reader: ${GATHERER_ROUND1.searches} searches and ${GATHERER_ROUND1.opens} opens, so a page list holds at most ${GATHERER_ROUND1.opens} pages. "At least ${GATHERER_ROUND1.minOpened} opened" is the gatherer's own rule, not checked by the hub.`;
export const defaultRoles = () => Object.fromEntries(Object.entries(ROLES).map(([r, x]) => [r, { type: x.type, model: x.model, effort: x.effort }]));

// Spec 4.4: 6 hours and 7% of the plan, by default. dollars: the cap the watchdog enforces (null until Matt confirms the
// figure, decision 69); the plan percentage stays on record next to it.
export const DEFAULT_ENVELOPE = { hours: 6, percent: 7, dollars: null };

// ---------- the event kinds (spec 4.3, plus the plan's three) ----------
// expedition_integrity (phase 4): the frozen test/ no longer matched its hash at a loop or the finish, and was restored.
// expedition_finished (phase 5): the one finished card (spec 4.8 step 3), logged by the end's card step.
export const EVENT_KINDS = ['expedition_started', 'expedition_gate', 'expedition_decision', 'expedition_parked', 'expedition_loop', 'expedition_stopped', 'expedition_note', 'expedition_step', 'expedition_subagent', 'expedition_integrity', 'expedition_finished'];
export const STOP_REASONS = ['passed', 'time', 'budget', 'no-progress', 'Matt'];
// The end (spec 4.8), as logged steps: each is skipped if its event exists, so the end never runs twice.
export const END_STEPS = ['report', 'commit', 'push', 'pr', 'card', 'summary'];

// ---------- the runnable part of a success test: test/run.json (settled in phase 5; written into the Lead's and Verifier's files) ----------
//   { "checks": [ { "name": "the benchmark runs", "command": "node bench.mjs", "cwd": ".", "timeout": 60 } ] }
// name: what the item is called in the verdict (defaults to the command); command: one shell command, run by the Verifier in its
// scratch copy; cwd: a folder inside the build worktree or the copy, never absolute or "..", default "."; timeout: seconds
// (default 120, at most 3600). The spec's single form, { "command", "cwd", "timeout" }, is read as one check. Items that cannot
// run here belong in CHECKLIST.md, marked "(not run here: the user pastes the results)".
export const RUN_JSON_SHAPE = '{ "checks": [ { "name": "...", "command": "...", "cwd": ".", "timeout": 60 } ] }';
export function runChecks(textOrObject) {
  let j = textOrObject;
  if (typeof j === 'string') { try { j = JSON.parse(j); } catch { return { checks: [], problem: `run.json is not valid JSON. Its shape is ${RUN_JSON_SHAPE}.` }; } }
  const list = Array.isArray(j?.checks) ? j.checks : j && typeof j.command === 'string' ? [j] : null;
  if (!list || !list.length) return { checks: [], problem: `run.json needs at least one check: ${RUN_JSON_SHAPE}.` };
  const checks = [];
  for (const [i, c] of list.entries()) {
    const command = typeof c?.command === 'string' ? c.command.trim() : '';
    if (!command) return { checks: [], problem: `run.json check ${i + 1} has no "command".` };
    const cwd = c.cwd == null || c.cwd === '' ? '.' : String(c.cwd).replace(/\\/g, '/');
    if (/^([A-Za-z]:|\/)/.test(cwd) || cwd.split('/').includes('..')) return { checks: [], problem: `run.json check ${i + 1}: "cwd" is a folder inside the build (like "." or "bench"), never absolute or "..".` };
    const timeout = c.timeout == null ? 120 : Number(c.timeout);
    if (!(timeout > 0 && timeout <= 3600)) return { checks: [], problem: `run.json check ${i + 1}: "timeout" is a number of seconds, up to 3600.` };
    checks.push({ name: String(c.name || command).trim().slice(0, 120), command, cwd, timeout });
  }
  return { checks, problem: null };
}
export const runJsonProblem = text => runChecks(text).problem;

export const ID_PATTERN =/^\d{8}-[a-z0-9]+(-[a-z0-9]+)*$/;
const pad2 = n => String(n).padStart(2, '0');
const SLUG_MAX = 30;   // the id appears twice in the deepest paths (worktree folder and docs/expeditions/<id>), so it stays short
const TITLE_FILLER = new Set('which what how the of a an is are for should we do does to in on and or be can could would'.split(' '));
const sha = data => createHash('sha256').update(data).digest('hex');
const text = (v, what) => { const s = String(v ?? '').trim(); if (!s) throw new Error(`${what} is needed.`); return s; };

// The files an agent may write by name; test/ holds anything under it. The rest (and the frozen copy, which lives in .crux/expeditions/.frozen/) are the hub's.
const FIXED = ['BRIEF.md', 'PLAN.md', 'DECISIONS.md', 'synthesis.md', 'skeptic.md', 'REPORT.md', 'verify/VERDICT.md'];
const NOTES = /^notes-[A-Za-z0-9][\w-]*\.md$/;

// ---------- the freeze (spec 4.5) ----------
// Every entry under dir as { rel (forward slashes, sorted), file, link }. A link (a symlink or a Windows junction) is an
// entry of its own and is never followed, so a planted link cannot make test/ hash like something it is not.
// Running a test leaves caches beside it (Python's bytecode, pytest's and npm's folders). They are not part of the test, so
// they are left out of the hash, the diff and the stored copy: a run must never look like tampering. The Verifier also runs
// a scratch copy (verify/run-N/), so this is the second line for a run that happens in test/ anyway.
export const IGNORED_NAMES = ['__pycache__', '.pytest_cache', 'node_modules'];
export const ignoredName = name => IGNORED_NAMES.includes(name) || /\.pyc$/i.test(name);
function tree(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d)) {
      if (ignoredName(name)) continue;
      const f = join(d, name), r = rel ? `${rel}/${name}` : name, st = lstatSync(f);
      if (st.isSymbolicLink()) out.push({ rel: r, file: f, link: readlinkSync(f) });
      else if (st.isDirectory()) walk(f, r);
      else out.push({ rel: r, file: f, link: null });
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}
const rootLink = dir => { try { return lstatSync(dir).isSymbolicLink() ? readlinkSync(dir) : null; } catch { return null; } };
const bytesOf = e => (e.link != null ? Buffer.from(`link:${e.link}`) : readFileSync(e.file));
// Sorted paths plus bytes, SHA-256: for regular files the same hash the gate always logged. prefix: 'test/' for both test/
// and its frozen copy, so the two hash alike when they hold the same files.
function treeHash(dir, prefix = 'test/') {
  const h = createHash('sha256');
  const top = rootLink(dir);
  if (top != null) return h.update(`root-link:${top}`).digest('hex');
  for (const e of tree(dir)) h.update(prefix + e.rel).update('\0').update(bytesOf(e)).update('\0');
  return h.digest('hex');
}
// Which names differ between two folders: changed, added or removed, for the log and the Lead's message.
function treeDiff(frozen, now) {
  const fp = dir => new Map(rootLink(dir) != null ? [['(the test folder itself is a link)', 'x']] : tree(dir).map(e => [e.rel, sha(bytesOf(e))]));
  const a = fp(frozen), b = fp(now), out = [];
  for (const [k, v] of b) out.push(!a.has(k) ? `${k} (added)` : a.get(k) !== v ? `${k} (changed)` : null);
  for (const k of a.keys()) if (!b.has(k)) out.push(`${k} (removed)`);
  return out.filter(Boolean).sort();
}

export class Expedition {
  constructor(project, id) {
    if (!ID_PATTERN.test(String(id))) throw new Error(`"${id}" is not an expedition id (YYYYMMDD-slug).`);
    this.project = project;
    this.id = id;
    this.root = join(project.dir, '.crux', 'expeditions', id);
    this.cache = null;
  }

  // The short title (4 to 5 words, written by the orchestrator) or, when it is missing or too long, the first 5 meaningful
  // words of the question (filler like which/what/the/of dropped). Always plain words, never empty.
  static shortTitle(title, question = '') {
    const words = s => String(s ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const t = words(title);
    if (t.length >= 2 && t.length <= 6 && t.join(' ').length <= 48) return t.join(' ');
    const q = words(question).filter(w => !TITLE_FILLER.has(w.toLowerCase().replace(/[^a-z']/g, '')));
    const pick = (q.length ? q : words(question)).slice(0, 5).join(' ').replace(/[?!.,;:]+$/, '');
    return pick || 'Expedition';
  }

  // YYYYMMDD-slug from the short title (about 30 characters, cut at a word boundary; a title that is one long word is cut
  // hard); a second one on the same day with the same slug gets -2, -3. Older, longer ids stay as they are.
  static makeId(source, { date = new Date(), taken = [] } = {}) {
    const day = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
    let slug = String(source ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (slug.length > SLUG_MAX) { const cut = slug.slice(0, SLUG_MAX + 1).lastIndexOf('-'); slug = slug.slice(0, cut > 0 ? cut : SLUG_MAX); }
    slug = slug.replace(/-+$/, '') || 'expedition';
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
    if (!this.testFiles().length) throw new Error('The success test is empty: put CHECKLIST.md or run.json in test/ first.');
    return treeHash(this.testDir);
  }
  get testDir() { return join(this.root, 'test'); }
  // The copy kept at the gate, outside the worktree (spec 4.5). Only the hub writes it; the Track A rule denies plain
  // writes there and the hash check below is what really guards test/.
  // Kept outside the expedition's own folder, so that one rm of that folder cannot take test/ and its copy together.
  get frozenRoot() { return join(this.project.dir, '.crux', 'expeditions', '.frozen'); }
  get frozenDir() { return join(this.frozenRoot, this.id); }
  // Copy test/ to the frozen copy (replacing any earlier one) and return the hash both now have. Throws if the copy differs.
  freeze() {
    const want = this.testHash();
    rmSync(this.frozenDir, { recursive: true, force: true });
    cpSync(this.testDir, this.frozenDir, { recursive: true, verbatimSymlinks: true, filter: src => !ignoredName(basename(src)) });
    if (treeHash(this.frozenDir) !== want) throw new Error('The frozen copy of test/ does not match test/, so the gate stays open: try again.');
    return want;
  }
  // Compare test/ with the hash the gate logged (phase 4; called at each loop and at the finish). If it differs, restore
  // test/ from the frozen copy, log expedition_integrity, and say what happened; the caller tells the Lead it counts as a
  // Verifier FAIL. If the frozen copy itself no longer matches the hash, nothing can be restored and that is said too.
  // -> { checked: false } before the gate; { checked: true, ok: true }; { checked: true, ok: false, restored, changed, why }
  checkFrozen(at) {
    const gate = this.state().gate;
    if (!gate) return { checked: false };
    const want = gate.testHash, found = treeHash(this.testDir);
    if (found === want) return { checked: true, ok: true };
    const changed = treeDiff(this.frozenDir, this.testDir);
    let restored = false, why = null;
    if (treeHash(this.frozenDir) !== want) why = 'the frozen copy itself no longer matches the logged hash';
    else {
      // Copy the good files to a folder beside test/ first, then swap it in by renames: if anything holds a file open (so
      // that test/ cannot be moved), test/ is left exactly as found, never half-deleted, and the swap is tried again next time.
      const fresh = join(this.root, `.test-restore-${process.pid}`), old = join(this.root, `.test-old-${process.pid}`);
      let moved = false;
      try {
        rmSync(fresh, { recursive: true, force: true }); rmSync(old, { recursive: true, force: true });
        cpSync(this.frozenDir, fresh, { recursive: true, verbatimSymlinks: true });
        if (treeHash(fresh) !== want) throw new Error('the copy made for the swap does not match the logged hash');
        if (existsSync(this.testDir) || rootLink(this.testDir) != null) { renameSync(this.testDir, old); moved = true; }
        renameSync(fresh, this.testDir);
        restored = treeHash(this.testDir) === want;
        if (!restored) why = 'test/ still differs after the swap';
      } catch (e) {
        why = `${e?.message || String(e)}; test/ was left as found`;
        if (moved && !existsSync(this.testDir)) { try { renameSync(old, this.testDir); } catch { /* the old one stays beside it */ } }
      }
      // .test-old goes only while test/ exists: if both renames failed in a row it is the only copy of what was found.
      for (const d of existsSync(this.testDir) ? [fresh, old] : [fresh]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort: a leftover is harmless */ } }
    }
    this.record('expedition_integrity', { at, restored, changed: changed.slice(0, 20), changedCount: changed.length, expectedHash: want, foundHash: found, ...(why ? { why } : {}) });
    return { checked: true, ok: false, restored, changed, why };
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
  // preApprovals (phase 4; the launch panel fills it in phase 5): { sites: [{ host, access, pin, subdomains }], packages:
  // [{ eco, name, baseMajor, baseMinor, revision }] } for this expedition's agents only. Checked with the same rules as
  // Matt's own lists and stored in the start event, which is where the hub reads it back (it survives a restart and ends
  // at expedition_stopped); never written to his settings.
  // Phase 5: question (the one line the sidebar and the card name it by) and origin ({ expedition, parked } when it was
  // launched from a proposed next expedition, so that proposal leaves the list).
  start({ envelope = {}, roles = {}, planStart = null, preApprovals = null, question = '', title = '', origin = null } = {}) {
    this.need('new');
    const merged = Object.fromEntries(Object.entries(defaultRoles()).map(([r, d]) => [r, { ...d, ...(roles[r] || {}) }]));
    const problem = Expedition.rolesProblem(merged);
    if (problem) throw new Error(problem);
    const pre = normalizeOverlay(preApprovals, { strict: true });
    const q = String(question ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return this.record('expedition_started', { briefHash: this.briefHash(), envelope: { ...DEFAULT_ENVELOPE, ...envelope }, roles: merged, planStart, branch: this.branch, preApprovals: pre, ...(q ? { question: q } : {}), ...(title ? { title: String(title).slice(0, 60) } : {}), ...(origin ? { origin } : {}) });
  }

  // The plan gate closes: the Advisor's verdict, the amendments to the test, and the hash that freezes it (spec 4.5).
  // Amendments are possible only before this; a second gate is refused.
  // Phase 4: closing it also keeps the copy of test/ outside the worktree and the expedition's folder (.crux/expeditions/.frozen/<id>), the reference for every later check.
  gate({ verdict, amendments = [] } = {}) {
    this.need('planning');
    const said = text(verdict, 'The Advisor\'s verdict');
    return this.record('expedition_gate', { verdict: said, amendments: [].concat(amendments).map(String).filter(Boolean), testHash: this.freeze() });
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
  // tampered (phase 4): test/ no longer matched its hash when the loop was logged; the loop is a Verifier FAIL and counts
  // for no progress (and its passing figure is left out of the best so far).
  loop({ number, passing, progress, tampered = false }) {
    this.need('running');
    if (!Number.isInteger(number) || number < 1) throw new Error('A loop has a number from 1.');
    if (!Number.isInteger(passing) || passing < 0) throw new Error('A loop reports how many items pass.');
    return this.record('expedition_loop', { number, passing, progress: !!progress, ...(tampered ? { tampered: true } : {}) });
  }

  // The end: why, and the totals at that moment (the watchdog's, phase 3).
  stop({ reason, totals = {} }) {
    this.need('planning', 'running');
    if (!STOP_REASONS.includes(reason)) throw new Error(`A stop reason is one of ${STOP_REASONS.join(', ')}.`);
    return this.record('expedition_stopped', { reason, totals });
  }

  // The watchdog's two notes (phase 3), logged before they are sent, so a restart never sends one twice:
  // kind 'reserve' (the 90% note: stop building, check claims, write up) and kind 'final' (the Lead's final turn after a
  // time, budget or user stop). A note with no kind is the reserve note (the phase 1 stub wrote it that way).
  note(note, data = {}) {
    this.need('planning', 'running', 'stopped');
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
  // status (ended only): how the task ended, as the SDK says it: completed, failed or stopped. agent: the SDK's id for it when known.
  // searches, opens (ended only): the gatherer's web searches and page opens the hub counted (decision 75).
  subagent({ phase, subagentType, taskId, tokens = null, status = null, agent = null, searches = null, opens = null }) {
    if (!['started', 'ended'].includes(phase)) throw new Error('A subagent event is started or ended.');
    return this.record('expedition_subagent', { phase, subagentType: text(subagentType, 'The subagent type'), taskId: text(taskId, 'The task id'), ...(tokens != null ? { tokens } : {}), ...(status ? { status } : {}), ...(agent ? { agent } : {}), ...(searches != null ? { searches, opens: opens ?? 0 } : {}) });
  }

  // ---------- state, rebuilt from the log ----------
  // phase: new (no start event), planning (started, gate open), running (gate closed, test frozen), stopped (end
  // sequence under way) or ended (the Lead's one summary sent).
  state() {
    const events = this.project.log.events;
    if (this.cache?.n === events.length && this.cache.loads === this.project.log.loads) return this.cache.s;
    const mine = events.filter(e => e.expedition === this.id);
    const of = type => mine.filter(e => e.type === type);
    const s = {
      started: of('expedition_started')[0] || null, gate: of('expedition_gate')[0] || null, stopped: of('expedition_stopped')[0] || null,
      decisions: of('expedition_decision'), parked: of('expedition_parked'), loops: of('expedition_loop'), notes: of('expedition_note'), subagents: of('expedition_subagent'), integrity: of('expedition_integrity'),
      steps: new Set(of('expedition_step').map(e => e.step))
    };
    s.stepEvents = new Map(of('expedition_step').map(e => [e.step, e]));
    s.reserveNote = s.notes.find(e => (e.kind || 'reserve') === 'reserve') || null;
    s.finalNote = s.notes.find(e => e.kind === 'final') || null;
    // Phase 5: the Lead said its report is done (expedition_report_ready), and the hub told it the end is done and its one
    // summary may go (logged before it is sent, so a restart never sends it twice).
    s.reportReadyNote = s.notes.find(e => e.kind === 'report-ready') || null;
    s.summaryGoNote = s.notes.find(e => e.kind === 'summary-go') || null;
    s.finished = of('expedition_finished')[0] || null;
    s.phase = !s.started ? 'new' : s.steps.has('summary') ? 'ended' : s.stopped ? 'stopped' : s.gate ? 'running' : 'planning';
    this.cache = { n: events.length, loads: this.project.log.loads, s };
    return s;
  }
  hasStep(step) { return this.state().steps.has(step); }
  // The logged event of one end step (its data: commit hash, push result, pull request), or null.
  stepEvent(step) { return this.state().stepEvents.get(step) || null; }
  // The Lead's one summary may go to the orchestrator once the report, branch and card are done (phase 5 order), and only once.
  summaryDue() { const s = this.state(); return s.phase === 'stopped' && s.steps.has('card'); }
  // A gatherer run the hub let through (the Lead's Agent call), logged at the call, before the SDK says the task started.
  // Idempotent by a non-empty tool call id; an empty one gets a generated id so it counts as its own run. Returns the id used, or
  // null for a repeat.
  gathererCall(toolUseId) {
    let id = String(toolUseId || '');
    if (id && this.state().notes.some(e => e.kind === 'gatherer-call' && e.toolUseId === id)) return null;
    if (!id) id = `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.record('expedition_note', { note: 'gatherer run allowed', kind: 'gatherer-call', toolUseId: id });
    return id;
  }
  // The calls let through that no task has started for and that have not expired, oldest first. Tasks are matched to calls by
  // order (the SDK's task id is not the call's id), so the first N live calls are the N started tasks.
  pendingCalls(now = Date.now()) {
    const s = this.state();
    const expired = new Set(s.notes.filter(e => e.kind === 'gatherer-expired').map(e => e.toolUseId));
    const seen = new Set(), live = [];
    for (const e of s.notes) if (e.kind === 'gatherer-call' && !seen.has(e.toolUseId)) { seen.add(e.toolUseId); if (!expired.has(e.toolUseId)) live.push(e); }
    const started = new Set(s.subagents.filter(e => e.phase === 'started' && e.subagentType === GATHERER_TYPE).map(e => e.taskId)).size;
    return live.slice(started).filter(e => now - (Date.parse(e.ts) || 0) < GATHERER_CALL_TTL_MS);
  }
  // Log the expiry of pending calls: all of them (the Lead's turn ended or its query restarted: nothing will start now), or only
  // the ones older than the time limit. The count above already ignores a stale call; this makes it a logged fact.
  gathererExpire({ all = false, now = Date.now() } = {}) {
    const s = this.state();
    const expired = new Set(s.notes.filter(e => e.kind === 'gatherer-expired').map(e => e.toolUseId));
    const fresh = new Set(this.pendingCalls(now).map(e => e.toolUseId));
    const started = new Set(s.subagents.filter(e => e.phase === 'started' && e.subagentType === GATHERER_TYPE).map(e => e.taskId)).size;
    const seen = new Set(), live = [];
    for (const e of s.notes) if (e.kind === 'gatherer-call' && !seen.has(e.toolUseId)) { seen.add(e.toolUseId); if (!expired.has(e.toolUseId)) live.push(e); }
    let n = 0;
    for (const e of live.slice(started)) if (all || !fresh.has(e.toolUseId)) { this.record('expedition_note', { note: 'gatherer run never started', kind: 'gatherer-expired', toolUseId: e.toolUseId }); n++; }
    return n;
  }
  // Gatherer runs so far: tasks started, plus calls still waiting to start (an expired call that never started does not count).
  gathererRuns(now = Date.now()) {
    const started = new Set(this.state().subagents.filter(e => e.phase === 'started' && e.subagentType === GATHERER_TYPE).map(e => e.taskId)).size;
    const pending = this.pendingCalls(now).length, running = this.runningSubagents(GATHERER_TYPE);
    return { started, pending, running, total: started + pending };
  }
  // Plain-words reason the Lead's next gatherer run is refused, or null. atOnce: this expedition's launch pick, at most GATHERER_LIMIT.
  gathererBlock(toolUseId, atOnce = GATHERER_LIMIT, now = Date.now()) {
    const id = String(toolUseId || '');
    if (id && this.state().notes.some(e => e.kind === 'gatherer-call' && e.toolUseId === id)) return null;   // a repeat of a call already let through
    this.gathererExpire({ now });
    const r = this.gathererRuns(now);
    if (r.total >= GATHERER_RUNS) return `This expedition has used all ${GATHERER_RUNS} gatherer runs it is allowed (${GATHERER_LIMIT} at once plus one second round). Work from the notes you have, give the Synthesizer what exists, and say in the report which gaps stayed open.`;
    const limit = Math.min(GATHERER_LIMIT, Math.max(1, Math.round(Number(atOnce)) || GATHERER_LIMIT));
    if (r.running + r.pending >= limit) return `${r.running + r.pending} gatherers are already running and ${limit} is the most at once. Wait for one to finish, then send the next (${GATHERER_RUNS - r.total} of ${GATHERER_RUNS} runs left).`;
    return null;
  }
  // Gatherers running right now, from the started/ended events (a count for the map's badge). type: only that subagent type.
  runningSubagents(type = null) {
    const open = new Map();
    for (const e of this.state().subagents) { if (e.phase === 'started') open.set(e.taskId, e); else open.delete(e.taskId); }
    return type ? [...open.values()].filter(e => e.subagentType === type).length : open.size;
  }
}
