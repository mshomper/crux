// The log archive (decision 74 B, step B): a project's event log, split in time.
//
//   .crux/events.jsonl                 the live log: events from the last two to four weeks (decision 2: still the source)
//   .crux/archive/YYYY-MM.jsonl.gz     every event rotated out, by month, as it was written (never edited, never deleted)
//   .crux/archive/index.json           per month: how many events, first and last time, conversation events by thread
//   .crux/snapshot.jsonl               the events the hub still needs at start from before the live log (see buildSnapshot)
//   .crux/rotation.json                present only while a rotation is under way (see rotate)
//
// The hub starts from snapshot plus live log. The snapshot holds ORIGINAL events (some with the bulky fields cut, marked
// `slim`), so everything that reads the in-memory log keeps working as it did; a rotation changes what is in memory only
// by what the archive holds. The archive is the full record: "Show older", search, the permission study and an
// expedition's report read it. Beside a month older than six months sits archive/YYYY-MM.summaries.json: one short
// summary per thread (lib/month-summaries.mjs writes it; "Show older" shows it as a card where the month begins, and
// search matches its text). The raw month is never touched.

import { readFileSync, existsSync, mkdirSync, renameSync, readdirSync, unlinkSync, openSync, fsyncSync, closeSync, writeSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { DISPLAY, countsAsUnread, countsAsTraffic } from '../public/feed-rules.js';
import { openQuestions, legacyClosers } from '../public/questions.js';

const DAY = 86400e3;
export const CUTOFF_MS = 14 * DAY;   // events older than this move to the archive
export const DUE_MS = 28 * DAY;      // a rotation runs when the oldest live event is older than this (so about monthly)
export const KEEP_TAIL = 20;         // messages kept in full for each thread whose agent is still there (they may be undelivered)

// The kinds that go to the archive when they are old. Every other kind is small and carried forever.
export const PRUNABLE = new Set(['message', 'summary', 'approval', 'approval_result', 'permission_answer', 'usage', 'plan_usage', 'agent_busy', 'check_shadow', 'visual', 'notice', 'notice_routed', 'approval_delivered']);

const ts = e => Date.parse(e.ts) || 0;
const monthOf = e => new Date(ts(e)).toISOString().slice(0, 7);

export const pathsOf = dir => ({
  live: join(dir, 'events.jsonl'), snap: join(dir, 'snapshot.jsonl'), snapNext: join(dir, 'snapshot.next.jsonl'),
  journal: join(dir, 'rotation.json'), arch: join(dir, 'archive'), index: join(dir, 'archive', 'index.json')
});

// ---------- files ----------
export function readJsonl(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line */ }
  }
  return out;
}
const jsonl = list => list.map(e => JSON.stringify(e)).join('\n') + (list.length ? '\n' : '');

// A rename that is tried again a few times when Windows says the file is busy (a virus scanner, an indexer, a reader).
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return renameSync(from, to); } catch (e) {
      if (i >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1));
    }
  }
}

// Written whole, then renamed over the old file: a reader or a crash sees the old file or the new one, never half.
export function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameRetry(tmp, file);
}

// The live file as bytes, with each line's events and where its line ends, so a rotation can cut the old lines off the
// front and keep every byte after them exactly as it is (nothing is re-written that could have been appended meanwhile).
function scanLive(file) {
  const raw = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
  const events = [], ends = [];
  let start = 0;
  while (start < raw.length) {
    let nl = raw.indexOf(10, start);
    const end = nl < 0 ? raw.length : nl + 1;
    const line = raw.toString('utf8', start, nl < 0 ? raw.length : nl);
    if (line.trim()) { try { events.push(JSON.parse(line)); ends.push(end); } catch { /* a torn line */ } }
    start = end;
  }
  return { raw, events, ends };
}
// The live file without its first `n` events: bytes from just after the nth line, read again now so anything appended
// since is carried over.
function trimLive(file, ends, n) {
  const now = readFileSync(file);
  writeAtomic(file, now.subarray(n ? ends[n - 1] : 0));
}

const monthFile = (dir, ym) => join(pathsOf(dir).arch, `${ym}.jsonl.gz`);
export function readMonth(dir, ym) {
  const f = monthFile(dir, ym);
  if (!existsSync(f)) return [];
  const out = [];
  for (const line of gunzipSync(readFileSync(f)).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}
export function readIndex(dir) {
  try { const j = JSON.parse(readFileSync(pathsOf(dir).index, 'utf8')); if (j && j.months) return j; } catch { /* none yet */ }
  return { version: 1, months: {} };
}
export const archiveMonths = dir => Object.keys(readIndex(dir).months).sort();

// A month's summaries: { version, month, events, at, model, threads: { thread: { text, events, plain? } } } or null.
// `events` is the month's event count in index.json when it was written: a month a later rotation rewrote differs.
export const summariesFile = (dir, ym) => join(pathsOf(dir).arch, `${ym}.summaries.json`);
export function readMonthSummary(dir, ym) {
  try { const j = JSON.parse(readFileSync(summariesFile(dir, ym), 'utf8')); if (j && j.threads && typeof j.threads === 'object') return j; } catch { /* none, or torn */ }
  return null;
}

export function readSnapshot(dir) {
  const f = pathsOf(dir).snap;
  const all = readJsonl(f);
  const head = all[0]?.type === 'snapshot_header' ? all[0] : null;
  return { header: head || { type: 'snapshot_header', version: 1, carried: { counts: {}, traffic: {} } }, events: head ? all.slice(1) : all };
}

// ---------- what the snapshot keeps ----------
// `all`: the events older than the cutoff, in log order (the previous snapshot's first). Returns the events to carry
// (originals; some cut down and marked `slim`) and the unread and traffic counts of what is left out, added to
// `prevCarried`, so the page's counts come out the same.
//
// The rule is tight on purpose and exact where the page works things out from the log:
//  - every kind not in PRUNABLE stays (agents, board entries, picks, settings, downloads, expeditions, lessons, dismissals ...);
//  - summaries: the latest of each thread and each agent, and the latest with handoff notes, in full; every summary that
//    asked something or named a decision, in full while its card is open, otherwise cut to what the question logic reads;
//  - messages: those that settle a question (`answers`), those that closed a legacy summary, and the last KEEP_TAIL of each
//    thread whose agent is still there (they may be unread);
//  - permission requests nobody answered; each agent's last busy mark; each live agent's last usage totals; the last plan reading;
//  - a picture beside a kept summary, and whatever a kept event names (an approval a notice points to, a picture a summary lists).
const SLIM = {
  message: ['id', 'ts', 'type', 'thread', 'from', 'to', 'conductor', 'answers'],
  summary: ['id', 'ts', 'type', 'thread', 'from', 'outcome', 'questions', 'decisions_needed', 'visuals']
};
const slimOf = e => { const s = {}; for (const k of SLIM[e.type]) if (e[k] !== undefined) s[k] = e[k]; s.slim = true; return s; };
const hasNotes = n => !!n && JSON.stringify(n).length > 4;
const asks = e => !!(e.questions?.length || e.decisions_needed?.length);

// The strings in an event that could be another event's id (its own id is not a reference).
function refsOf(e) {
  const out = [];
  const add = s => { if (typeof s === 'string' && s.length >= 8 && s !== e.id) out.push(s); };
  for (const v of Object.values(e)) {
    if (typeof v === 'string') add(v);
    else if (Array.isArray(v)) { for (const x of v) { if (typeof x === 'string') add(x); else if (x && typeof x === 'object') for (const y of Object.values(x)) add(y); } }
    else if (v && typeof v === 'object') for (const y of Object.values(v)) add(y);
  }
  return out;
}

export function buildSnapshot(all, prevCarried = {}) {
  const full = new Set(), slim = new Set();
  // who is still there: a thread or agent whose last creation is after its last retirement
  const createdAt = new Map(), retiredAt = new Map(), threadCreated = new Map(), threadRetired = new Map();
  all.forEach((e, i) => {
    if (e.type === 'agent_created') { createdAt.set(e.agent, i); if (e.thread) threadCreated.set(e.thread, i); }
    if (e.type === 'agent_retired') { retiredAt.set(e.agent, i); if (e.thread) threadRetired.set(e.thread, i); }
  });
  const agentAlive = n => createdAt.has(n) && (createdAt.get(n) > (retiredAt.get(n) ?? -1));
  const threadAlive = t => threadCreated.has(t) && (threadCreated.get(t) > (threadRetired.get(t) ?? -1));

  for (const e of all) if (!PRUNABLE.has(e.type)) full.add(e);

  // summaries
  const lastBy = (f, pick) => { const m = new Map(); for (const e of all) if (e.type === 'summary' && pick(e)) m.set(f(e), e); return m; };
  for (const e of lastBy(e => e.thread || '-', () => true).values()) full.add(e);
  for (const e of lastBy(e => e.from || '-', () => true).values()) full.add(e);
  for (const e of lastBy(e => e.from || '-', e => hasNotes(e.handoff_notes)).values()) full.add(e);
  const open = new Set(openQuestions(all, {}).map(c => c.id));
  for (const e of all) if (e.type === 'summary' && !full.has(e)) { if (open.has(e.id)) full.add(e); else if (asks(e)) slim.add(e); }

  // messages
  for (const p of legacyClosers(all)) { const e = all[p - 1]; if (e?.type === 'message' && !full.has(e)) slim.add(e); }
  const tails = new Map();
  for (const e of all) {
    if (e.type !== 'message') continue;
    if (Array.isArray(e.answers) && e.answers.length) { if (!full.has(e)) slim.add(e); }
    if (e.thread && threadAlive(e.thread)) { if (!tails.has(e.thread)) tails.set(e.thread, []); tails.get(e.thread).push(e); }
  }
  for (const list of tails.values()) for (const e of list.slice(-KEEP_TAIL)) { full.add(e); slim.delete(e); }

  // permission requests nobody answered
  const answered = new Set(all.filter(e => e.type === 'approval_result').map(e => e.approval));
  for (const e of all) if (e.type === 'approval' && !answered.has(e.approval)) full.add(e);

  // telemetry the hub reads the latest of
  const lastBusy = new Map(), lastBusyCtx = new Map(), lastUsage = new Map();   // lastBusyCtx: the last busy mark that has a context number (the idle handoff reads it after a restart)
  let lastPlan = null;
  for (const e of all) {
    if (e.type === 'agent_busy') { lastBusy.set(e.agent, e); if (e.contextPct != null) lastBusyCtx.set(e.agent, e); }
    else if (e.type === 'usage' && agentAlive(e.agent)) lastUsage.set(`${e.agent}\u0000${e.sessionId}`, e);
    else if (e.type === 'plan_usage' && e.plan) lastPlan = e;
  }
  for (const e of lastBusy.values()) full.add(e);
  for (const e of lastBusyCtx.values()) full.add(e);
  for (const e of lastUsage.values()) full.add(e);
  if (lastPlan) full.add(lastPlan);

  // a picture sent in the round of a kept summary
  const pending = new Map();
  for (const e of all) {
    if (e.type === 'visual' && e.thread) { if (!pending.has(e.thread)) pending.set(e.thread, []); pending.get(e.thread).push(e); }
    else if (e.type === 'summary' && e.thread) { if (full.has(e) || slim.has(e)) for (const v of pending.get(e.thread) || []) full.add(v); pending.delete(e.thread); }
  }

  // whatever a kept event names: an approval a notice points to, a picture a summary lists
  const byKey = new Map();
  for (const e of all) if (PRUNABLE.has(e.type)) for (const k of [e.id, e.approval, e.visual]) if (typeof k === 'string') { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(e); }
  // (named by a full event only; one already cut down stays cut down: a dismissal names the summary it dismissed, and the
  // cut-down copy is all the question logic needs of it)
  for (const e of [...full]) for (const r of refsOf(e)) for (const t of byKey.get(r) || []) if (!full.has(t) && !slim.has(t)) full.add(t);

  const out = [], dropped = { counts: {}, traffic: {} };
  for (const e of all) {
    if (full.has(e)) out.push(e.type === 'agent_created' && !agentAlive(e.agent) && e.task && e.task.length > 300 ? { ...e, task: e.task.slice(0, 300) } : e);
    else if (slim.has(e)) out.push(slimOf(e));
    else if (e.thread) { if (countsAsUnread(e)) dropped.counts[e.thread] = (dropped.counts[e.thread] || 0) + 1; if (countsAsTraffic(e)) dropped.traffic[e.thread] = (dropped.traffic[e.thread] || 0) + 1; }
  }
  const add = (a = {}, b = {}) => { const r = { ...a }; for (const [k, v] of Object.entries(b)) r[k] = (r[k] || 0) + v; return r; };
  return { events: out, carried: { counts: add(prevCarried.counts, dropped.counts), traffic: add(prevCarried.traffic, dropped.traffic) } };
}

// ---------- rotation ----------
// What the archive's index says about a month's events: how many, the first and last time, and the conversation events by thread.
function monthStats(events) {
  const display = {};
  for (const e of events) if (DISPLAY.has(e.type) && e.thread) display[e.thread] = (display[e.thread] || 0) + 1;
  return { events: events.length, first: events[0]?.ts, last: events.at(-1)?.ts, display };
}

// Moves the live log's events older than the cutoff into the archive. Safe at every step, in this order:
//   1. rotation.json says a rotation started (its id, the cutoff);
//   2. each month's archive is rewritten with the new events added (to a temp file, then renamed; adding is by event id,
//      so doing it twice changes nothing), and the index with it;
//   3. the new snapshot is written whole as snapshot.next.jsonl, carrying the rotation's id;
//   4. snapshot.next.jsonl is renamed over snapshot.jsonl;
//   5. the live log is rewritten without the old events (temp file, then renamed);
//   6. rotation.json is removed.
// Nothing leaves the live log until the archive and the snapshot are on disk. recover() finishes or redoes a rotation
// that a crash cut short; the hub calls it before it reads a log. Returns null when nothing is old, else a summary.
// (crashAfter and onStep are for tests: stop after a step, or do something between steps.)
export function rotate(dir, { now = Date.now(), cutoff = now - CUTOFF_MS, crashAfter = null, onStep = null } = {}) {
  const P = pathsOf(dir);
  if (existsSync(P.journal)) recover(dir);   // an earlier rotation that stopped part-way is finished first, never done twice
  const { events: live, ends } = scanLive(P.live);
  let n = 0;
  while (n < live.length && ts(live[n]) < cutoff) n++;
  if (!n) return null;
  const old = live.slice(0, n);
  mkdirSync(P.arch, { recursive: true });
  const id = randomUUID();
  const stop = step => { onStep?.(step); if (crashAfter === step) throw new Error(`crash after step ${step} (test)`); };
  writeAtomic(P.journal, JSON.stringify({ id, cutoff, count: n, at: new Date(now).toISOString() }));
  stop(1);
  // 2: the archive
  const byMonth = new Map();
  for (const e of old) { const m = monthOf(e); if (!byMonth.has(m)) byMonth.set(m, []); byMonth.get(m).push(e); }
  const index = readIndex(dir);
  for (const [m, evs] of byMonth) {
    const have = readMonth(dir, m), ids = new Set(have.map(e => e.id));
    const merged = [...have, ...evs.filter(e => !ids.has(e.id))];
    writeAtomic(monthFile(dir, m), gzipSync(Buffer.from(jsonl(merged)), { level: 9 }));
    index.months[m] = monthStats(merged);
  }
  writeAtomic(P.index, JSON.stringify(index));
  stop(2);
  // 3: the snapshot
  // the old snapshot's events first, then the old live ones; an event in both is the original (the snapshot's copy may be slim)
  const prev = readSnapshot(dir), byId = new Map();
  for (const e of prev.events) byId.set(e.id, e);
  for (const e of old) byId.set(e.id, e);
  const all = [...byId.values()];
  const built = buildSnapshot(all, prev.header.carried);
  const header = { type: 'snapshot_header', version: 1, rotationId: id, upTo: new Date(cutoff).toISOString(), carried: built.carried, rotatedAt: new Date(now).toISOString() };
  writeAtomic(P.snapNext, jsonl([header, ...built.events]));
  stop(3);
  renameRetry(P.snapNext, P.snap);
  stop(4);
  // 5: the live log without the old events: its bytes after them, read again now, so anything another process appended
  // since this rotation read the file (an old hub still shutting down) comes along
  trimLive(P.live, ends, n);
  stop(5);
  unlinkSync(P.journal);
  return { archived: n, months: [...byMonth.keys()], snapshotEvents: built.events.length, slim: built.events.filter(e => e.slim).length, liveEvents: live.length - n };
}

// Finishes or redoes a rotation a crash cut short. Called before a log is read. Returns what it did, or null.
export function recover(dir) {
  const P = pathsOf(dir);
  for (const f of existsSync(dir) ? readdirSync(dir) : []) if (f.endsWith('.tmp')) { try { unlinkSync(join(dir, f)); } catch { } }   // a half-written file: never the log
  if (existsSync(P.arch)) for (const f of readdirSync(P.arch)) if (f.endsWith('.tmp')) { try { unlinkSync(join(P.arch, f)); } catch { } }
  if (!existsSync(P.journal)) { try { unlinkSync(P.snapNext); } catch { } return null; }
  let j;
  try { j = JSON.parse(readFileSync(P.journal, 'utf8')); } catch { try { unlinkSync(P.journal); } catch { } return { redone: false }; }
  if (existsSync(P.snapNext)) {
    // the snapshot was complete (the archive was written before it): take it, and cut the live log
    const head = readJsonl(P.snapNext)[0];
    if (head?.rotationId === j.id) renameRetry(P.snapNext, P.snap);
    else try { unlinkSync(P.snapNext); } catch { }
  }
  const done = readSnapshot(dir).header.rotationId === j.id;
  if (done) {
    const { events: live, ends } = scanLive(P.live);
    let n = 0;
    while (n < live.length && ts(live[n]) < j.cutoff) n++;
    if (n) trimLive(P.live, ends, n);
    unlinkSync(P.journal);
    return { finished: true };
  }
  unlinkSync(P.journal);   // before the snapshot was complete: nothing was cut from the live log, so do it again from the start
  const r = rotate(dir, { cutoff: j.cutoff });
  return { redone: true, ...r };
}

// ---------- reading ----------
// The events the hub starts from: the snapshot's, then the live log's (an event in both, from a rotation caught in the
// middle, is the live one). Also what was left out of the snapshot, as counts.
// repair: false reads what is there and changes nothing (a test hub on a real folder, or the off switch). A recovery that
// fails does not stop the hub: it starts from the snapshot and the live file as they are, and says so.
export function loadEvents(dir, { repair = true } = {}) {
  if (repair) { try { recover(dir); } catch (e) { console.error(`Log archive: could not finish an unfinished rotation in ${dir}: ${e.message}. Starting from the snapshot and the live log as they are.`); } }
  const P = pathsOf(dir);
  const snap = readSnapshot(dir), live = readJsonl(P.live), liveIds = new Set(live.map(e => e.id));
  const before = snap.events.filter(e => !liveIds.has(e.id));
  return { events: [...before, ...live], snapshotCount: before.length, carried: snap.header.carried || { counts: {}, traffic: {} } };
}

// Is a rotation due: is the oldest live event older than DUE_MS?
export function isDue(dir, now = Date.now()) {
  const f = pathsOf(dir).live;
  if (!existsSync(f)) return false;
  const fd = openSync(f, 'r');   // the first line only (however long it is): this runs at every start and every few hours
  try {
    const parts = [], buf = Buffer.alloc(65536);
    for (let pos = 0, total = 0; total < 64 * 1048576;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      const nl = buf.subarray(0, n).indexOf(10);
      if (nl >= 0) { parts.push(Buffer.from(buf.subarray(0, nl))); break; }
      parts.push(Buffer.from(buf.subarray(0, n))); pos += n; total += n;
    }
    const first = JSON.parse(Buffer.concat(parts).toString('utf8'));
    return now - ts(first) > DUE_MS;
  } catch { return false; } finally { closeSync(fd); }
}
export const hasJournal = dir => existsSync(pathsOf(dir).journal);

// Archived conversation events of a thread, `n` of them just before an event (ts, id), oldest first, skipping ids the
// page already has (`exclude`). left: how many more of the thread are further back (from the index, exact inside the
// month being read). Months are read newest to oldest from the one the event is in.
const cache = new Map();   // month file -> { mtime, events }, the last few read
function monthCached(dir, ym) {
  const f = monthFile(dir, ym);
  if (!existsSync(f)) return [];
  const st = statSync(f), stamp = `${st.mtimeMs}:${st.size}`;   // a rewritten month differs
  const hit = cache.get(f);
  if (hit && hit.stamp === stamp) return hit.events;
  const events = readMonth(dir, ym);
  cache.set(f, { stamp, events });
  if (cache.size > 3) cache.delete(cache.keys().next().value);
  return events;
}
export function archivedPage(dir, { thread, before, exclude = new Set(), n = 150, threadOf = e => e.thread }) {
  const index = readIndex(dir), months = Object.keys(index.months).sort();
  const beforeMonth = before ? monthOf(before) : '9999-99';
  const take = [];
  let k = months.length - 1;
  while (k >= 0 && months[k] > beforeMonth) k--;
  let left = 0;
  const cards = [];
  for (; k >= 0 && take.length < n; k--) {
    const month = monthCached(dir, months[k]);
    const mine = month.filter(e => DISPLAY.has(e.type) && e.type !== 'entry' && threadOf(e) === thread);
    const list = mine.filter(e => !exclude.has(e.id) && (!before || ts(e) < ts(before) || (ts(e) === ts(before) && e.id !== before.id)));
    const room = n - take.length;
    take.unshift(...list.slice(-room));
    if (list.length > room) left += list.length - room;
    // The month's summary of this thread: one folded card where the month begins (just before its first item), once that
    // item is on the page.
    else if (list.length && list[0] === mine[0]) {
      const s = readMonthSummary(dir, months[k])?.threads?.[thread];
      if (s?.text) cards.push({ id: `month-summary:${months[k]}:${thread}`, ts: new Date(ts(mine[0]) - 1).toISOString(), type: 'month_summary', thread, month: months[k], text: s.text, items: s.events ?? mine.length });
    }
  }
  for (; k >= 0; k--) left += index.months[months[k]].display[thread] || 0;
  return { events: cards.length ? [...cards, ...take].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)) : take, left };
}

// Every event of the log, archive and live (the snapshot's are copies of archived ones): for the permission study.
export function readAllEvents(dir, { repair = true } = {}) {
  if (repair) recover(dir);
  const seen = new Set(), out = [];
  const push = list => { for (const e of list) if (!seen.has(e.id)) { seen.add(e.id); out.push(e); } };
  for (const m of archiveMonths(dir)) push(readMonth(dir, m));
  push(readJsonl(pathsOf(dir).live));
  return out;
}

// Events from `sinceTs` on, archive and live, oldest first: an expedition's report reads its own span.
export function readSince(dir, sinceTs) {
  const seen = new Set(), out = [];
  const firstMonth = new Date(sinceTs).toISOString().slice(0, 7);
  for (const m of archiveMonths(dir)) if (m >= firstMonth) for (const e of readMonth(dir, m)) if (ts(e) >= sinceTs && !seen.has(e.id)) { seen.add(e.id); out.push(e); }
  for (const e of readJsonl(pathsOf(dir).live)) if (!seen.has(e.id)) { seen.add(e.id); out.push(e); }
  return out;
}

// Search chat and summaries: archive months newest first, then the live log. Words must all appear (any case), in the
// text of a message or notice, a summary's lines, or a question. Returns up to `limit` hits, newest first.
const textOf = e => [e.text, e.questions, e.done, e.changed, e.next_step, e.command, e.reason].flat(2).filter(x => typeof x === 'string').join(' ');
export function searchLog(dir, query, { limit = 50, thread = null } = {}) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = [];
  const test = e => { if (thread && e.thread !== thread) return; const t = textOf(e); if (!t) return; const low = t.toLowerCase(); if (words.every(w => low.includes(w))) hits.push({ id: e.id, ts: e.ts, type: e.type, thread: e.thread, from: e.from, snippet: t.slice(Math.max(0, low.indexOf(words[0]) - 60), low.indexOf(words[0]) + 140) }); };
  const live = readJsonl(pathsOf(dir).live);
  for (let i = live.length - 1; i >= 0 && hits.length < limit; i--) test(live[i]);
  const months = archiveMonths(dir);
  for (let k = months.length - 1; k >= 0 && hits.length < limit; k--) {
    // a month's summaries match too (one hit per thread, listed before that month's own lines)
    const sums = readMonthSummary(dir, months[k]);
    for (const [t, s] of Object.entries(sums?.threads || {})) if (s?.text && (!thread || t === thread) && words.every(w => s.text.toLowerCase().includes(w))) { const low = s.text.toLowerCase(); hits.push({ id: `month-summary:${months[k]}:${t}`, ts: sums.at || `${months[k]}-01T00:00:00.000Z`, type: 'month_summary', thread: t, from: null, snippet: s.text.slice(Math.max(0, low.indexOf(words[0]) - 60), low.indexOf(words[0]) + 140) }); }
    const evs = readMonth(dir, months[k]); for (let i = evs.length - 1; i >= 0 && hits.length < limit; i--) test(evs[i]); }
  return hits.slice(0, limit);
}
