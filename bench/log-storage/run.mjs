// Event-log storage benchmark for the Crux hub (expedition: how should the hub store and load its event log?).
// Plain Node, no packages. Run: node run.mjs [projectDir]   (cwd = where bench-out/ is written, or set BENCH_OUT)
// It reads <project>/.crux/events.jsonl READ-ONLY (once, into bench-out/events.copy.jsonl) and works only on the copy.
// Results: BENCH_RESULTS if set, else <bench-out>/results.json. Nothing from the log's text is written to the results.
import { openSync, readSync, closeSync, fstatSync, existsSync, mkdirSync, readFileSync, writeFileSync, writeSync,
  appendFileSync, statSync, readdirSync, renameSync, rmSync, createReadStream } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync, createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { constants as bufConstants } from 'node:buffer';

// The synthetic log (~200 MB) needs more heap than the default; re-run once with a bigger one.
if (!process.env.BENCH_CHILD) {
  const r = spawnSync(process.execPath, ['--max-old-space-size=12288', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, BENCH_CHILD: '1' } });
  process.exit(r.status ?? 1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.env.BENCH_OUT || join(process.cwd(), 'bench-out'));
const RESULTS = process.env.BENCH_RESULTS ? resolve(process.env.BENCH_RESULTS) : join(OUT, 'results.json');
const DAY = 86400000;
const N_RECENT = 50;                                  // last N messages per thread
const RECENT = [['message', N_RECENT], ['summary', 20], ['notice', 20], ['visual', 20]];
const LIVE_DAYS = 14;
const PHONE_FACTOR = 4, PHONE_BYTES_PER_S = 2e6;     // judgment; see assumptions.phone
// The ten types for which app.js (line ~175) calls refreshSoon(), i.e. re-fetches the whole state.
const REFRESH_TYPES = ['agent_created', 'agent_session', 'agent_settings', 'agent_retired', 'pick', 'entry', 'entry_status', 'summary', 'project_settings', 'lesson_result'];
// Long-lived records: they rebuild the board, agents and cards, so they go in the snapshot and are never archived.
const LONG = new Set(['entry', 'entry_status', 'entry_retired', 'pick', 'agent_created', 'agent_session', 'agent_settings', 'agent_retired',
  'project_settings', 'lesson_proposed', 'lesson_result', 'lesson', 'handoff_qa', 'summary', 'question_dismissed', 'merge_pass',
  'expedition_draft', 'expedition_started', 'expedition_draft_closed', 'expedition_decision', 'expedition_gate', 'expedition_parked']);
const QUERIES = ['worktree', 'approval'];

const now = () => performance.now();
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const log = (...a) => console.log(...a);
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// ---------- 1. the copy (read-only on the original) ----------
function findProject() {
  const arg = process.argv[2] || process.env.BENCH_PROJECT;
  if (arg) return resolve(arg);
  for (const start of [process.cwd(), HERE]) {
    let d = resolve(start);
    for (;;) {
      if (existsSync(join(d, '.crux', 'events.jsonl'))) return d;
      const up = dirname(d); if (up === d) break; d = up;
    }
  }
  throw new Error('cannot find <project>/.crux/events.jsonl; pass the project folder as an argument');
}
mkdirSync(OUT, { recursive: true });
const copyFile = join(OUT, 'events.copy.jsonl');
const synthFile = join(OUT, 'events.synth.jsonl');
if (!existsSync(copyFile)) {
  const original = join(findProject(), '.crux', 'events.jsonl');
  const fd = openSync(original, 'r');                  // read-only
  const size = fstatSync(fd).size;
  const buf = Buffer.alloc(size);
  let got = 0; while (got < size) { const n = readSync(fd, buf, got, size - got, got); if (!n) break; got += n; }
  closeSync(fd);
  const cut = buf.lastIndexOf(10, got - 1) + 1;        // cut at the last newline
  writeFileSync(copyFile, buf.subarray(0, cut));
  log(`copied ${cut} bytes of the log to bench-out/events.copy.jsonl`);
}

// ---------- 2. the synthetic long log ----------
function scanFile(file) {                               // events, bytes, first and last timestamp without parsing the whole file
  const fd = openSync(file, 'r'); const size = fstatSync(fd).size;
  const chunk = Buffer.alloc(8 << 20); let pos = 0, events = 0, firstLine = null, tailStart = 0;
  while (pos < size) {
    const n = readSync(fd, chunk, 0, chunk.length, pos);
    for (let i = 0; i < n; i++) if (chunk[i] === 10) { events++; if (firstLine === null) firstLine = pos + i; tailStart = pos + i + 1; }
    pos += n;
  }
  const head = Buffer.alloc(Math.min(size, 8192)); readSync(fd, head, 0, head.length, 0);
  // the last line: walk back from the end
  const back = Math.min(size, 1 << 20); const tail = Buffer.alloc(back); readSync(fd, tail, 0, back, size - back); closeSync(fd);
  const lines = tail.toString('utf8').split('\n').filter(l => l.trim());
  const first = JSON.parse(head.toString('utf8').split('\n')[0]);
  const last = JSON.parse(lines.at(-1));
  return { bytes: size, events, firstTs: first.ts, lastTs: last.ts };
}
const REF_FIELDS = ['id', 'approval', 'entryId', 'request'];
function buildSynth(copyInfo) {
  const lines = readFileSync(copyFile, 'utf8').split('\n').filter(l => l.trim());
  const objs = lines.map(l => JSON.parse(l));
  const t0 = Date.parse(copyInfo.firstTs), span = Date.parse(copyInfo.lastTs) - t0 + 1000;
  const fd = openSync(synthFile, 'w'); let pass = 0, last = t0;
  while ((last - t0) / DAY < 90 || pass < 2) {
    const parts = [];
    for (let k = 0; k < objs.length; k++) {
      if (pass === 0) { parts.push(lines[k]); continue; }
      const o = { ...objs[k] };
      for (const f of REF_FIELDS) if (typeof o[f] === 'string') o[f] = `${o[f]}~p${pass}`;
      o.ts = new Date(Date.parse(o.ts) + pass * span).toISOString();
      parts.push(JSON.stringify(o));
    }
    writeSync(fd, parts.join('\n') + '\n');
    last = Date.parse(objs.at(-1).ts) + pass * span; pass++;
  }
  closeSync(fd);
  log(`built bench-out/events.synth.jsonl from ${pass} passes`);
}
const copyInfo = scanFile(copyFile);
if (!existsSync(synthFile)) buildSynth(copyInfo);
const synthInfo = scanFile(synthFile);
const measuredDays = (Date.parse(synthInfo.lastTs) - Date.parse(synthInfo.firstTs)) / DAY;
const realDays = (Date.parse(copyInfo.lastTs) - Date.parse(copyInfo.firstTs)) / DAY;
log(`copy: ${copyInfo.events} events, ${round(realDays)} days; synth: ${synthInfo.events} events, ${round(measuredDays)} days, ${round(synthInfo.bytes / 1e6, 1)} MB`);

// ---------- shared folds (what the page needs, rebuilt from long-lived events) ----------
const parseLines = txt => { const a = []; for (const l of txt.split('\n')) { if (!l.trim()) continue; try { a.push(JSON.parse(l)); } catch { /* torn last line */ } } return a; };
function foldState(longEvents) {
  const entries = new Map(), agents = new Map(), picks = []; let settings = null;
  for (const e of longEvents) {
    switch (e.type) {
      case 'entry': entries.set(e.entryId, { entryId: e.entryId, kind: e.kind, title: e.title, summary: e.summary, body: e.body, from: e.from, supersedes: e.supersedes, status: 'active', ts: e.ts }); break;
      case 'entry_status': { const x = entries.get(e.entryId); if (x) x.status = e.status; break; }
      case 'entry_retired': { const x = entries.get(e.entryId); if (x) x.status = 'retired'; break; }
      case 'agent_created': agents.set(e.agent, { name: e.agent, role: e.role, thread: e.thread, task: e.task, goal: e.goal, type: e.agentType, model: e.model, effort: e.effort, retired: false }); break;
      case 'agent_session': { const a = agents.get(e.agent); if (a) a.sessionId = e.sessionId; break; }
      case 'agent_settings': { const a = agents.get(e.agent); if (a) Object.assign(a, { model: e.model ?? a.model, effort: e.effort ?? a.effort }); break; }
      case 'agent_retired': { const a = agents.get(e.agent); if (a) a.retired = true; break; }
      case 'pick': picks.push({ decision: e.decision, choice: e.choice, title: e.title }); break;
      case 'project_settings': settings = e; break;
    }
  }
  return { agents: [...agents.values()], entries: [...entries.values()], picks, settings };
}
// Index a server would keep in memory (updated on every append): recent events per thread and type, open approvals.
function buildIndex(events) {
  const longs = [], recent = new Map(), open = new Map(); const want = new Set(RECENT.map(r => r[0]));
  for (const e of events) {
    if (LONG.has(e.type)) longs.push(e);
    if (want.has(e.type)) { const t = e.thread || ''; let m = recent.get(t); if (!m) recent.set(t, m = {}); (m[e.type] ||= []).push(e); }
    else if (e.type === 'approval') open.set(e.approval, e);
    else if (e.type === 'approval_result') open.delete(e.approval);
  }
  return { state: foldState(longs), recent, open };
}
function payloadFrom(state, recentByThread, open) {  // recentByThread: Map thread -> { type: [events] }
  const threads = {};
  for (const [t, m] of recentByThread) { const o = {}; for (const [type, n] of RECENT) if (m[type]?.length) o[type] = m[type].slice(-n); threads[t] = o; }
  return { name: 'project', agents: state.agents, board: { entries: state.entries }, picks: state.picks, settings: state.settings, threads, openApprovals: [...open.values()] };
}
const lastMsgIds = threads => { const m = new Map(); for (const [t, o] of Object.entries(threads)) if (o.message?.length) m.set(t, o.message.slice(-N_RECENT).map(e => e.id)); return m; };
const sameIds = (a, b) => a.size === b.size && [...a].every(([t, ids]) => { const o = b.get(t); return o && o.length === ids.length && o.every((x, i) => x === ids[i]); });

// ---------- measuring helpers ----------
function timeOpen(fn, rep) {   // fn() -> { serverMs, pageMs, raw, gz }
  const s = [], p = []; let last;
  for (let i = 0; i < rep; i++) { last = fn(); s.push(last.serverMs); p.push(last.pageMs); }
  return { serverMs: median(s), pageMs: median(p), totalMs: median(s.map((x, i) => x + p[i])), raw: last.raw, gz: last.gz };
}
function deltaCost(ev) {       // one event over the stream: stringify on the server, parse on the page
  const n = 3000; let s;
  const t0 = now(); for (let i = 0; i < n; i++) s = JSON.stringify(ev); const t1 = now();
  for (let i = 0; i < n; i++) JSON.parse(s); const t2 = now();
  return { serverMs: (t1 - t0) / n, pageMs: (t2 - t1) / n, bytes: Buffer.byteLength(s) };
}
function appendCost(append) { const t = []; for (let i = 0; i < 300; i++) { const a = now(); append(i); t.push(now() - a); } return median(t); }
const phoneOf = (open, delta, sent, deltaSent) => ({
  firstOpenMs: round(open.serverMs + open.pageMs * PHONE_FACTOR + sent / PHONE_BYTES_PER_S * 1000),
  perUpdateMs: round(delta.serverMs + delta.pageMs * PHONE_FACTOR + deltaSent / PHONE_BYTES_PER_S * 1000, 4)
});
function dirSize(dir) { let n = 0; for (const f of readdirSync(dir, { withFileTypes: true })) n += f.isDirectory() ? dirSize(join(dir, f.name)) : statSync(join(dir, f.name)).size; return n; }
const gzLen = raw => gzipSync(raw, { level: 6 }).length;

// ---------- the options, one dataset at a time ----------
async function runDataset(label, file, info, rep) {
  const tag = label;
  const cutoff = new Date(Date.parse(info.lastTs) - LIVE_DAYS * DAY).toISOString();
  const res = {};
  let refIds = null, lastMsg = null;

  // ---- current: whole log in memory, the whole state JSON at each open and each refresh
  {
    let events, startMs = [];
    for (let i = 0; i < rep; i++) { events = null; const t = now(); events = parseLines(readFileSync(file, 'utf8')); startMs.push(now() - t); }
    const open = () => {
      const t0 = now(); const st = foldState(events.filter(e => LONG.has(e.type)));
      const raw = JSON.stringify({ name: 'project', agents: st.agents, board: { decisions: [], entries: st.entries }, events }); const t1 = now();
      JSON.parse(raw); const t2 = now(); return { serverMs: t1 - t0, pageMs: t2 - t1, raw: raw.length };
    };
    const first = timeOpen(open, rep), upd = timeOpen(open, Math.max(2, rep - 1));
    const st = foldState(events.filter(e => LONG.has(e.type)));
    const rawStr = JSON.stringify({ name: 'project', agents: st.agents, board: { decisions: [], entries: st.entries }, events });
    const rawBytes = Buffer.byteLength(rawStr); const gz = gzLen(rawStr);
    refIds = (() => { const idx = buildIndex(events); return lastMsgIds(Object.fromEntries([...idx.recent].map(([t, m]) => [t, { message: m.message }]))); })();
    lastMsg = events.findLast(e => e.type === 'message');
    const d = deltaCost(lastMsg);
    res.current = {
      startMs: median(startMs), firstOpenMs: first.totalMs, perUpdateMs: upd.totalMs, diskBytes: info.bytes, transferBytes: rawBytes, transferGzipBytes: gz,
      eventsStored: events.length, sameAsCurrent: true, appendMs: 0,
      phone: phoneOf(first, d, rawBytes, rawBytes)    // today: no compression, so raw bytes are sent at open and again on each refresh
    };
    res.current.phone.perUpdateMs = round(upd.serverMs + upd.pageMs * PHONE_FACTOR + rawBytes / PHONE_BYTES_PER_S * 1000);
    res.current.appendMs = appendCost(i => appendFileSync(join(OUT, `scratch-append-${tag}.jsonl`), JSON.stringify({ ...lastMsg, id: `x${i}` }) + '\n'));
    rmSync(join(OUT, `scratch-append-${tag}.jsonl`), { force: true });
    if (label === 'synth') {   // search over the archived part, in memory
      res.currentSearch = QUERIES.map(q => { const ms = [], hits = []; for (let i = 0; i < rep; i++) { const t = now(); let h = 0; const ql = q.toLowerCase(); for (const e of events) if (e.type === 'message' && e.ts < cutoff && typeof e.text === 'string' && e.text.toLowerCase().includes(ql)) h++; ms.push(now() - t); hits.push(h); } return { option: 'current', query: q, ms: round(median(ms)), hits: hits[0] }; });
    }
    events = null;
  }

  // ---- loadless: storage unchanged, page gets board + recent per thread, gzip, one delta per update
  {
    let events, idx; const startMs = [];
    for (let i = 0; i < rep; i++) { events = idx = null; const t = now(); events = parseLines(readFileSync(file, 'utf8')); idx = buildIndex(events); startMs.push(now() - t); }
    res.loadless = finishMemoryOption({ startMs, idx, rep, lastMsg, refIds, diskBytes: info.bytes, eventsStored: events.length, appendFile: join(OUT, `scratch-append-${tag}.jsonl`) });
    events = idx = null;
  }

  // ---- files: snapshot + live 14 days + monthly gzip archives
  {
    const dir = join(OUT, `files-${tag}`); rmSync(dir, { recursive: true, force: true }); mkdirSync(join(dir, 'archive'), { recursive: true });
    const b0 = now(); const counts = writeFilesLayout(file, dir, cutoff); const buildMs = now() - b0;
    const readAll = () => { const snap = parseLines(readFileSync(join(dir, 'snapshot.jsonl'), 'utf8')); const live = parseLines(readFileSync(join(dir, 'live.jsonl'), 'utf8')); return snap.concat(live); };
    let events, idx; const startMs = [];
    for (let i = 0; i < rep; i++) { events = idx = null; const t = now(); events = readAll(); idx = buildIndex(events); startMs.push(now() - t); }
    // events readable back through this option's own read path: snapshot + live + every archive
    let stored = events.length;
    for (const f of readdirSync(join(dir, 'archive'))) stored += gunzipSync(readFileSync(join(dir, 'archive', f))).toString('utf8').split('\n').filter(l => l.trim()).length;
    res.files = finishMemoryOption({ startMs, idx, rep, lastMsg, refIds, diskBytes: dirSize(dir), eventsStored: stored, appendFile: join(OUT, `scratch-append-${tag}.jsonl`) });
    res.files.layout = { ...counts, buildMs: round(buildMs, 0), snapshotBytes: statSync(join(dir, 'snapshot.jsonl')).size, liveBytes: statSync(join(dir, 'live.jsonl')).size, archiveBytes: dirSize(join(dir, 'archive')), archives: readdirSync(join(dir, 'archive')).length };
    events = idx = null;
  }

  // ---- sqlite
  if (sqlite) res.sqlite = await runSqlite(label, file, info, rep, lastMsg, refIds, cutoff);
  return { res, cutoff };
}

function finishMemoryOption({ startMs, idx, rep, lastMsg, refIds, diskBytes, eventsStored, appendFile }) {
  const open = () => {
    const t0 = now(); const raw = JSON.stringify(payloadFrom(idx.state, idx.recent, idx.open)); const gz = gzipSync(raw, { level: 6 }); const t1 = now();
    JSON.parse(raw); const t2 = now(); return { serverMs: t1 - t0, pageMs: t2 - t1, raw: Buffer.byteLength(raw), gz: gz.length };
  };
  const first = timeOpen(open, rep * 2);
  const d = deltaCost(lastMsg);
  const payload = payloadFrom(idx.state, idx.recent, idx.open);
  const same = sameIds(lastMsgIds(payload.threads), refIds);
  const appendMs = appendCost(i => appendFileSync(appendFile, JSON.stringify({ ...lastMsg, id: `x${i}` }) + '\n'));
  rmSync(appendFile, { force: true });
  return {
    startMs: median(startMs), firstOpenMs: first.totalMs, perUpdateMs: d.serverMs + d.pageMs, diskBytes, transferBytes: first.raw, transferGzipBytes: first.gz,
    eventsStored, sameAsCurrent: same, appendMs, phone: phoneOf(first, d, first.gz, d.bytes), deltaBytes: d.bytes
  };
}

function writeFilesLayout(file, dir, cutoff) {
  const snap = [], live = [], arch = new Map(); let nSnap = 0, nLive = 0, nArch = 0, nTail = 0;
  const parsed = [];
  for (const l of readFileSync(file, 'utf8').split('\n')) { if (!l.trim()) continue; try { parsed.push([JSON.parse(l), l]); } catch { /* skip */ } }
  // The last N messages of every thread stay in the snapshot even when older than the live window, so a quiet thread still opens with its recent chat without reading an archive.
  const tailKeep = new Set(); const perThread = new Map();
  for (let i = parsed.length - 1; i >= 0; i--) { const e = parsed[i][0]; if (e.type !== 'message') continue; const t = e.thread || ''; const n = perThread.get(t) || 0; if (n < N_RECENT) { perThread.set(t, n + 1); tailKeep.add(i); } }
  for (let i = 0; i < parsed.length; i++) {
    const [e, l] = parsed[i];
    if (LONG.has(e.type)) { snap.push(l); nSnap++; }
    else if (e.ts < cutoff && tailKeep.has(i)) { snap.push(l); nTail++; }
    else if (e.ts >= cutoff) { live.push(l); nLive++; }
    else { const m = e.ts.slice(0, 7); let a = arch.get(m); if (!a) arch.set(m, a = []); a.push(l); nArch++; }
  }
  writeFileSync(join(dir, 'snapshot.jsonl.tmp'), snap.join('\n') + '\n'); renameSync(join(dir, 'snapshot.jsonl.tmp'), join(dir, 'snapshot.jsonl'));   // temp + rename
  writeFileSync(join(dir, 'live.jsonl'), live.length ? live.join('\n') + '\n' : '');
  for (const [m, a] of arch) writeFileSync(join(dir, 'archive', `${m}.jsonl.gz`), gzipSync(a.join('\n') + '\n', { level: 6 }));
  return { snapshotEvents: nSnap, snapshotOldMessageTail: nTail, liveEvents: nLive, archivedEvents: nArch };
}

// ---------- sqlite ----------
let sqlite = null, sqliteErr = null, fts5 = false;
try {
  sqlite = await import('node:sqlite');
  const probe = new sqlite.DatabaseSync(':memory:');
  try { probe.exec('CREATE VIRTUAL TABLE t USING fts5(x)'); fts5 = true; } catch { fts5 = false; }
  probe.close();
} catch (e) { sqliteErr = String(e.message || e); sqlite = null; }

const SCHEMA = `CREATE TABLE events (seq INTEGER PRIMARY KEY, id TEXT, ts TEXT NOT NULL, type TEXT NOT NULL, thread TEXT NOT NULL DEFAULT '', ref TEXT, json TEXT NOT NULL);`;
const INDEXES = `CREATE INDEX idx_ts ON events(ts); CREATE INDEX idx_thread_ts ON events(thread, ts); CREATE INDEX idx_thread_type_seq ON events(thread, type, seq); CREATE INDEX idx_type_ref ON events(type, ref);`;
const FTS = fts5 ? `CREATE VIRTUAL TABLE msg_fts USING fts5(text);` : `CREATE TABLE msg_fts (rowid INTEGER PRIMARY KEY, text TEXT);`;

function buildSqlite(file, dbFile) {
  for (const s of ['', '-wal', '-shm']) rmSync(dbFile + s, { force: true });
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;'); db.exec(SCHEMA); db.exec(FTS);
  const ins = db.prepare('INSERT INTO events (id, ts, type, thread, ref, json) VALUES (?,?,?,?,?,?)');
  const insF = db.prepare('INSERT INTO msg_fts (rowid, text) VALUES (?,?)');
  db.exec('BEGIN');
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    const r = ins.run(e.id ?? null, e.ts, e.type, e.thread || '', e.approval ?? e.entryId ?? null, l);
    if (e.type === 'message' && typeof e.text === 'string') insF.run(r.lastInsertRowid, e.text);
  }
  db.exec('COMMIT'); db.exec(INDEXES);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}
const LONG_LIST = [...LONG].map(t => `'${t}'`).join(',');
const BOARD_LIST = [...LONG].filter(t => t !== 'summary').map(t => `'${t}'`).join(',');

async function runSqlite(label, file, info, rep, lastMsg, refIds, cutoff) {
  const dbFile = join(OUT, `sqlite-${label}.db`);
  const b0 = now(); buildSqlite(file, dbFile); const buildMs = now() - b0;
  const openDb = () => {
    const db = new sqlite.DatabaseSync(dbFile); db.exec('PRAGMA journal_mode=WAL');
    // Server start: open, read the long-lived records that rebuild the board and agents (summaries are fetched per thread on demand), list the threads.
    const state = foldState(db.prepare(`SELECT json FROM events WHERE type IN (${BOARD_LIST}) ORDER BY seq`).all().map(r => JSON.parse(r.json)));
    const threads = db.prepare(`SELECT DISTINCT thread FROM events WHERE type IN (${RECENT.map(r => `'${r[0]}'`).join(',')})`).all().map(r => r.thread);
    const q = db.prepare('SELECT json FROM events WHERE thread = ? AND type = ? ORDER BY seq DESC LIMIT ?');
    const qOpen = db.prepare(`SELECT json FROM events a WHERE a.type='approval' AND NOT EXISTS (SELECT 1 FROM events r WHERE r.type='approval_result' AND r.ref = a.ref)`);
    return { db, state, threads, q, qOpen };
  };
  const startMs = []; let h;
  for (let i = 0; i < rep; i++) { if (h) h.db.close(); const t = now(); h = openDb(); startMs.push(now() - t); }
  const getPayload = () => {
    const recent = new Map();
    for (const t of h.threads) { const m = {}; for (const [type, n] of RECENT) { const rows = h.q.all(t, type, n); if (rows.length) m[type] = rows.map(r => JSON.parse(r.json)).reverse(); } recent.set(t, m); }
    const open = new Map(h.qOpen.all().map(r => { const e = JSON.parse(r.json); return [e.approval, e]; }));
    return payloadFrom(h.state, recent, open);
  };
  const open = () => {
    const t0 = now(); const raw = JSON.stringify(getPayload()); const gz = gzipSync(raw, { level: 6 }); const t1 = now();
    JSON.parse(raw); const t2 = now(); return { serverMs: t1 - t0, pageMs: t2 - t1, raw: Buffer.byteLength(raw), gz: gz.length };
  };
  const first = timeOpen(open, rep * 2);
  const d = deltaCost(lastMsg);
  const same = sameIds(lastMsgIds(getPayload().threads), refIds);
  const eventsStored = h.db.prepare('SELECT count(*) AS n FROM events').get().n;
  h.db.close();
  const disk = ['', '-wal', '-shm'].reduce((n, s) => n + (existsSync(dbFile + s) ? statSync(dbFile + s).size : 0), 0);
  // one write per event (autocommit, WAL, synchronous=NORMAL) into a scratch database with the same shape
  const sFile = join(OUT, `scratch-sqlite-${label}.db`); for (const s of ['', '-wal', '-shm']) rmSync(sFile + s, { force: true });
  const sdb = new sqlite.DatabaseSync(sFile); sdb.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;'); sdb.exec(SCHEMA); sdb.exec(INDEXES);
  const sins = sdb.prepare('INSERT INTO events (id, ts, type, thread, ref, json) VALUES (?,?,?,?,?,?)'); const sj = JSON.stringify(lastMsg);
  const appendMs = appendCost(i => sins.run(`x${i}`, lastMsg.ts, lastMsg.type, lastMsg.thread || '', null, sj));
  sdb.close(); for (const s of ['', '-wal', '-shm']) rmSync(sFile + s, { force: true });
  const out = {
    startMs: median(startMs), firstOpenMs: first.totalMs, perUpdateMs: d.serverMs + d.pageMs, diskBytes: disk, transferBytes: first.raw, transferGzipBytes: first.gz,
    eventsStored, sameAsCurrent: same, appendMs, phone: phoneOf(first, d, first.gz, d.bytes), deltaBytes: d.bytes, buildMs: round(buildMs, 0)
  };
  if (label === 'synth') out.search = await searchSqlite(dbFile, cutoff, rep);
  return out;
}

// ---------- search over the archived part of the synthetic log ----------
async function searchSqlite(dbFile, cutoff, rep) {
  const db = new sqlite.DatabaseSync(dbFile); const rows = [];
  for (const q of QUERIES) {
    const run = (name, fn) => { const ms = [], hits = []; for (let i = 0; i < rep; i++) { const t = now(); hits.push(fn()); ms.push(now() - t); } rows.push({ option: name, query: q, ms: round(median(ms)), hits: hits[0] }); };
    if (fts5) { const st = db.prepare('SELECT count(*) AS n FROM msg_fts f JOIN events e ON e.seq = f.rowid WHERE msg_fts MATCH ? AND e.ts < ?'); run('sqlite (FTS5 MATCH)', () => st.get(`${q}*`, cutoff).n); }
    const st2 = db.prepare('SELECT count(*) AS n FROM msg_fts f JOIN events e ON e.seq = f.rowid WHERE f.text LIKE ? AND e.ts < ?'); run('sqlite (LIKE scan)', () => st2.get(`%${q}%`, cutoff).n);
  }
  db.close(); return rows;
}
async function searchFiles(dir, cutoff, rep) {
  const rows = [];
  for (const q of QUERIES) {
    const ql = q.toLowerCase(); const ms = [], hits = [];
    for (let i = 0; i < rep; i++) {
      const t = now(); let h = 0;
      const sources = [join(dir, 'snapshot.jsonl'), ...readdirSync(join(dir, 'archive')).map(f => join(dir, 'archive', f))];   // snapshot holds old messages kept as per-thread tails
      for (const f of sources) {
        const raw = createReadStream(f);
        const rl = createInterface({ input: f.endsWith('.gz') ? raw.pipe(createGunzip()) : raw, crlfDelay: Infinity });
        for await (const line of rl) {
          if (!line.toLowerCase().includes(ql)) continue;   // cheap pre-filter on the raw line, then check the message text itself
          const e = JSON.parse(line); if (e.type === 'message' && e.ts < cutoff && typeof e.text === 'string' && e.text.toLowerCase().includes(ql)) h++;
        }
      }
      ms.push(now() - t); hits.push(h);
    }
    rows.push({ option: 'files', query: q, ms: round(median(ms)), hits: hits[0] });
  }
  return rows;
}

// ---------- run ----------
const realRep = 5, synthRep = 3;
log('measuring the real copy ...');
const real = await runDataset('real', copyFile, copyInfo, realRep);
log('measuring the synthetic log ...');
const synth = await runDataset('synth', synthFile, synthInfo, synthRep);
const search = [...synth.res.currentSearch, ...await searchFiles(join(OUT, 'files-synth'), synth.cutoff, synthRep), ...(synth.res.sqlite?.search || [])];
if (synth.res.sqlite) delete synth.res.sqlite.search;
delete synth.res.currentSearch;

function payloadParts(file) {   // where the bytes of the loadless payload go (sizes only)
  const idx = buildIndex(parseLines(readFileSync(file, 'utf8'))); const p = payloadFrom(idx.state, idx.recent, idx.open);
  const size = x => Buffer.byteLength(JSON.stringify(x));
  const perType = {}; for (const o of Object.values(p.threads)) for (const [t, a] of Object.entries(o)) perType[t] = (perType[t] || 0) + size(a);
  return { agents: size(p.agents), entries: size(p.board), picks: size(p.picks), openApprovals: size(p.openApprovals), threads: Object.keys(p.threads).length, ...Object.fromEntries(Object.entries(perType).map(([k, v]) => [`threads.${k}`, v])) };
}

// ---------- results ----------
const NAMES = {
  current: 'Current way: whole log in memory, full state JSON at open and at every refresh',
  loadless: 'Load less (decision 74 A): same storage, page gets board + last 50 messages per thread, gzip, one event per update',
  files: 'Plain files: snapshot + 14 days live + monthly gzip archives',
  sqlite: 'node:sqlite: one database file, indexes, FTS5 over message text'
};
const ENGINE = { current: 'jsonl', loadless: 'jsonl', files: 'jsonl', sqlite: 'node:sqlite' };
// Year projection: two-point line through the measured real copy and the measured synthetic log, extended to 365 days, never below the synthetic figure.
const extrap = (a, b) => Math.max(b, b + (b - a) / (measuredDays - realDays) * (365 - measuredDays));
const options = Object.keys(real.res).map(key => {
  const r = real.res[key], s = synth.res[key];
  const strip = o => { const { phone, layout, ...rest } = o; return rest; };
  return {
    key, name: NAMES[key], engine: ENGINE[key],
    startMs: round(r.startMs), firstOpenMs: round(r.firstOpenMs), perUpdateMs: round(r.perUpdateMs, 4), diskBytes: r.diskBytes,
    transferBytes: r.transferBytes, transferGzipBytes: r.transferGzipBytes, eventsStored: r.eventsStored, sameAsCurrent: r.sameAsCurrent, appendMs: round(r.appendMs, 4),
    phone: r.phone,
    year: {
      diskBytes: Math.round(extrap(r.diskBytes, s.diskBytes)), transferGzipBytes: Math.round(extrap(r.transferGzipBytes, s.transferGzipBytes)),
      firstOpenMs: round(extrap(r.firstOpenMs, s.firstOpenMs)), startMs: round(extrap(r.startMs, s.startMs)),
      phoneFirstOpenMs: round(extrap(r.phone.firstOpenMs, s.phone.firstOpenMs))
    },
    synth: { ...Object.fromEntries(Object.entries(strip(s)).map(([k, v]) => [k, typeof v === 'number' ? round(v, 4) : v])), phone: s.phone },
    ...(r.layout ? { layout: { real: r.layout, synth: s.layout } } : {}),
    ...(key === 'sqlite' ? { sqliteVersion: process.versions.sqlite, buildMs: { real: r.buildMs, synth: s.buildMs } } : {})
  };
});

// by type and refresh rate on the real copy
const byType = {}; let refresh = 0;
for (const l of readFileSync(copyFile, 'utf8').split('\n')) { if (!l.trim()) continue; let e; try { e = JSON.parse(l); } catch { continue; } const b = (byType[e.type] ||= { count: 0, bytes: 0 }); b.count++; b.bytes += Buffer.byteLength(l); if (REFRESH_TYPES.includes(e.type)) refresh++; }

// where the current way stops: V8's longest string
let limitTest = 'not tested';
try { 'x'.repeat(bufConstants.MAX_STRING_LENGTH + 1); limitTest = 'repeat above the limit did not throw'; } catch (e) { limitTest = `'x'.repeat(MAX_STRING_LENGTH + 1) throws ${e.name}`; }
const bytesPerDay = synthInfo.bytes / measuredDays;
const currentOpt = options.find(o => o.key === 'current');
const stateBytesPerDay = currentOpt.synth.transferBytes / measuredDays;
const results = {
  node: process.version, sqliteVersion: sqlite ? process.versions.sqlite : undefined, fts5,
  ...(sqliteErr ? { sqliteUnavailable: sqliteErr } : {}),
  source: { bytes: copyInfo.bytes, events: copyInfo.events, firstTs: copyInfo.firstTs, lastTs: copyInfo.lastTs },
  synthetic: { bytes: synthInfo.bytes, events: synthInfo.events, firstTs: synthInfo.firstTs, lastTs: synthInfo.lastTs },
  byType, refreshesPerDay: round(refresh / realDays, 1), cpus: undefined,
  options, search,
  year: { measuredDays: round(measuredDays, 1), days: 365, eventsPerDay: Math.round(synthInfo.events / measuredDays), bytesPerDay: Math.round(bytesPerDay) },
  currentBreaks: {
    maxStringLength: bufConstants.MAX_STRING_LENGTH, test: limitTest,
    note: 'readFileSync(utf8) and JSON.stringify(state) each build one string; both fail above this many characters (bytes for plain ASCII; chat is mostly ASCII, so bytes is a close upper estimate of characters). Today state() stringifies every project plus the Conductor in one string.',
    bytesPerDay: Math.round(bytesPerDay), daysUntilLogFileExceedsLimit: Math.round(bufConstants.MAX_STRING_LENGTH / bytesPerDay),
    stateBytesPerDay: Math.round(stateBytesPerDay), daysUntilStateStringExceedsLimit: Math.round(bufConstants.MAX_STRING_LENGTH / stateBytesPerDay)
  },
  searchNotes: 'Queries run over the archived part (older than 14 days) of the synthetic log, message text only, case-insensitive. files and current and LIKE scan for the substring, so a word inside a longer word counts; FTS5 MATCH uses the word (prefix form, query*) so a hit needs the word to start at a token boundary (unicode61 tokenizer splits on punctuation and underscores). Hit counts can therefore differ slightly. current scans events already in memory (load time excluded); files stream-gunzips every monthly archive each time; the sqlite LIKE row scans the message-text table without the full-text index. The synthetic log repeats the same text, so hits are multiples of the real count; times show scan cost, not realistic hit density.',
  notes: {
    snapshotTypes: [...LONG].join(', '),
    snapshotTail: `plus, for files, the last ${N_RECENT} messages of every thread even when older than 14 days (so quiet threads open without reading an archive); they are not duplicated in the archives.`,
    payloadPartsBytesReal: payloadParts(copyFile),
    snapshotWhy:'long-lived records that rebuild the board, agent list, picks, settings, summaries and cards; small, read at every start, never archived.',
    payloadRule: `board (entries rebuilt from entry events) + agents (latest per agent) + picks + latest project settings + per thread the last ${N_RECENT} messages, last 20 summaries, notices and visuals + every approval with no result yet. Older chat is fetched on demand (not measured). Decisions from .decisions/*.json are not in the stand-in board for any option.`,
    currentShape: 'Stand-in for GET /api/state: { name, agents, board, events: every event } for this one project; the real response also carries every other project and the Conductor, so current is a lower bound.',
    sqliteStart: 'sqlite startMs = open the file, read the long-lived records except summaries, list threads. files startMs = read snapshot + live file, parse, build the per-thread index. loadless startMs = read + parse the whole log + index.',
    gzipTime: 'firstOpenMs for loadless, files and sqlite includes server gzip; current is sent uncompressed today so has none. Browser gunzip is not timed.'
  },
  assumptions: {
    phone: `Estimate from a substitute environment (this PC), not a phone. Server work (build, stringify, gzip) is taken as measured here; the page-side JSON.parse is multiplied by ${PHONE_FACTOR} (research notes cite V8 benchmarks with phones 3-6x slower than a desktop; no phone-speed memo exists on the Crux board, so ${PHONE_FACTOR}x is Claude's judgment); transfer = bytes sent / ${PHONE_BYTES_PER_S / 1e6} MB/s (Claude's judgment for Tailscale to a phone; tailscale serve does not compress). Current sends raw JSON, as the hub does today; the other options send gzip.`,
    year: `Measured on the synthetic log (${round(measuredDays, 1)} days = the real ${round(realDays, 1)}-day copy repeated with shifted timestamps and fresh ids) and on the real copy; the year figure extends a straight line through those two measurements to 365 days (never below the synthetic figure). It assumes the next year looks like the first five days of heavy use (${Math.round(synthInfo.events / measuredDays)} events and ${round(bytesPerDay / 1e6, 2)} MB a day), repeated text compresses better than real new text might, the synthetic log reuses the same thread and agent names every pass (new ids only), so per-thread recent payloads stay bounded while entries and other id-keyed records grow (a real year would also add new threads), and nothing is pruned except by the option's own rules.`
  }
};
delete results.cpus;
writeFileSync(RESULTS, JSON.stringify(results, null, 1));
log(`\nwrote ${RESULTS}`);

// ---------- table ----------
const f = (n, d = 0) => typeof n === 'number' ? n.toLocaleString('en', { maximumFractionDigits: d }) : String(n);
log(`node ${process.version}, sqlite ${process.versions.sqlite}, fts5 ${fts5}; real ${f(copyInfo.events)} events / ${f(copyInfo.bytes / 1e6, 1)} MB; synth ${round(measuredDays, 1)} days / ${f(synthInfo.bytes / 1e6, 1)} MB`);
log('option    startMs  openMs  updMs     disk MB  gzip KB  raw KB   phone open  year open  year disk MB  same');
for (const o of options) log(`${o.key.padEnd(9)} ${f(o.startMs).padStart(7)} ${f(o.firstOpenMs, 1).padStart(7)} ${f(o.perUpdateMs, 3).padStart(7)} ${f(o.diskBytes / 1e6, 1).padStart(10)} ${f(o.transferGzipBytes / 1e3).padStart(8)} ${f(o.transferBytes / 1e3).padStart(8)} ${f(o.phone.firstOpenMs).padStart(11)} ${f(o.year.firstOpenMs).padStart(10)} ${f(o.year.diskBytes / 1e6, 0).padStart(13)}  ${o.sameAsCurrent}`);
log('synthetic log:'); for (const o of options) log(`${o.key.padEnd(9)} start ${f(o.synth.startMs)} ms, open ${f(o.synth.firstOpenMs, 1)} ms, disk ${f(o.synth.diskBytes / 1e6, 1)} MB, gzip ${f(o.synth.transferGzipBytes / 1e3)} KB, stored ${f(o.synth.eventsStored)}/${f(synthInfo.events)}, same ${o.synth.sameAsCurrent}`);
log('search (archived part of synth):'); for (const s of search) log(`  ${s.option.padEnd(22)} "${s.query}" ${f(s.ms, 1)} ms, ${s.hits} hits`);
log(`current breaks: V8 max string ${f(bufConstants.MAX_STRING_LENGTH)} chars = ${results.currentBreaks.daysUntilLogFileExceedsLimit} days of log, ${results.currentBreaks.daysUntilStateStringExceedsLimit} days of state JSON`);
log(`refreshes/day ${results.refreshesPerDay}`);
