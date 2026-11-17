// Expedition team analyzer. Plain Node, no packages. Reads <project>/.crux/events.jsonl once, read-only, and the
// expedition folders under <project>/.crux/expeditions/, and writes numbers only (no message text) to
// ./bench-out/results.json (relative to the current folder), or to the file in env ANALYZE_RESULTS.
// Usage: node analyze.mjs [project folder]   (default: found by walking up from the current folder)
// It reads the live log only: usage older than about a month moves to the archive and is not read.
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

function findProject() {
  if (process.argv[2]) return resolve(process.argv[2]);
  let d = resolve(process.cwd());
  for (;;) {
    if (existsSync(join(d, '.crux', 'events.jsonl'))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error('cannot find <project>/.crux/events.jsonl above the current folder; pass the project folder');
}
const project = findProject();
const logFile = join(project, '.crux', 'events.jsonl');
const expRoot = join(project, '.crux', 'expeditions');
const outFile = process.env.ANALYZE_RESULTS ? resolve(process.env.ANALYZE_RESULTS) : join(process.cwd(), 'bench-out', 'results.json');

// Read the log once (the live hub appends to it; a torn last line is skipped).
const events = [];
for (const l of readFileSync(logFile, 'utf8').split('\n')) {
  if (!l.trim()) continue;
  try { events.push(JSON.parse(l)); } catch { /* torn or partial line */ }
}

const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
const r6 = x => Math.round(x * 1e6) / 1e6;
const r2 = x => Math.round(x * 100) / 100;
const ROLE_KEYS = ['lead', 'advisor', 'synthesizer', 'skeptic', 'builder', 'verifier'];
const HAIKU = /haiku/i;
const T = e => Date.parse(e.ts) || 0;

// ---- one expedition ----
// Roles follow hub/lib/expedition-report.mjs howItRan (reimplemented: that file is not reachable from the worktree copy),
// except that usage is counted up to the moment the hub wrote "How it ran" (the expedition_step "report" event; the stop
// if there is none) and time at work is counted from start to stop. Rows with no expedition role are the permission check
// (logCheckUsage in hub/lib/hub.mjs), reported as role "check".
function analyseExpedition(id) {
  const mine = events.filter(e => e.expedition === id);
  const started = mine.find(e => e.type === 'expedition_started') || null;
  const stopped = mine.findLast(e => e.type === 'expedition_stopped') || null;
  const reportStep = mine.findLast(e => e.type === 'expedition_step' && e.step === 'report') || null;
  const cut = reportStep ? T(reportStep) : stopped ? T(stopped) : Infinity;
  const stopT = stopped ? T(stopped) : null;
  const roleOf = new Map(mine.filter(e => e.type === 'agent_created').map(e => [e.agent, e.expeditionRole]));
  const rows = new Map();
  const row = role => {
    if (!rows.has(role)) rows.set(role, { agents: new Set(), turns: 0, workMs: 0, tokensIn: 0, tokensOut: 0, usd: 0 });
    return rows.get(role);
  };
  const byModel = {};
  let gathererUsd = 0, gathererTok = 0;
  const haikuFrames = [];   // { t, usd, tok } from the Lead's usage frames
  for (const e of mine.filter(e => e.type === 'usage' && T(e) <= cut)) {
    const role = e.expeditionRole || roleOf.get(e.agent) || 'check';
    const r = row(role);
    r.agents.add(e.agent);
    const models = Object.entries(e.models || {});
    if (models.length) r.turns++;
    for (const [name, m] of models) {
      r.tokensIn += num(m.input) + num(m.cacheRead) + num(m.cacheCreation); r.tokensOut += num(m.output);
      byModel[name] = (byModel[name] || 0) + num(m.cost);
      if (role === 'lead' && HAIKU.test(name)) {
        const tok = num(m.input) + num(m.output) + num(m.cacheRead) + num(m.cacheCreation);
        gathererUsd += num(m.cost); gathererTok += tok; haikuFrames.push({ t: T(e), usd: num(m.cost), tok });
      }
    }
    r.usd += num(e.costUSD);
  }
  // Time at work: agent_busy marks between start and stop (a turn still open at the stop counts up to it).
  const names = new Set(roleOf.keys());
  let end = stopT ?? 0;
  if (!stopped) for (const e of events) end = Math.max(end, T(e));
  const t0 = started ? T(started) : 0;
  const openSince = new Map();
  for (const e of events) {
    if (e.type !== 'agent_busy' || !names.has(e.agent)) continue;
    const t = T(e);
    if (t < t0 || t > end) continue;
    const role = roleOf.get(e.agent);
    if (e.busy) { if (!openSince.has(e.agent)) openSince.set(e.agent, t); continue; }
    if (openSince.has(e.agent)) { const r = row(role); r.workMs += Math.max(0, t - openSince.get(e.agent)); openSince.delete(e.agent); r.agents.add(e.agent); }
  }
  for (const [agent, t] of openSince) { const r = row(roleOf.get(agent)); r.workMs += Math.max(0, end - t); r.agents.add(agent); }

  const roles = {};
  let totalUsd = 0;
  for (const k of [...ROLE_KEYS, ...[...rows.keys()].filter(k => !ROLE_KEYS.includes(k)).sort()]) {
    const r = rows.get(k);
    if (!r) { roles[k] = { agents: 0, turns: 0, tokensIn: 0, tokensOut: 0, usd: 0, minutes: 0 }; continue; }
    roles[k] = { agents: r.agents.size, turns: r.turns, tokensIn: r.tokensIn, tokensOut: r.tokensOut, usd: r6(r.usd), minutes: r2(r.workMs / 60000) };
    totalUsd += r.usd;
  }
  for (const k of Object.keys(roles)) {
    roles[k].shareOfTotal = totalUsd > 0 ? r6(roles[k].usd / totalUsd) : 0;
    roles[k].usdPerTurn = roles[k].turns ? r6(roles[k].usd / roles[k].turns) : 0;
  }

  // ---- gatherers, from expedition_subagent events ----
  const sub = mine.filter(e => e.type === 'expedition_subagent' && T(e) <= cut);
  const begun = new Map(), perRun = [], roundStarts = [];
  let completed = 0, failed = 0, active = 0, maxAtOnce = 0, lastCallTokens = 0, runs = 0;
  for (const e of sub) {
    if (e.phase === 'started') {
      if (active === 0) roundStarts.push(T(e));
      begun.set(e.taskId, { t: T(e), n: runs, round: roundStarts.length });
      runs++; active++; maxAtOnce = Math.max(maxAtOnce, active);
    } else if (e.phase === 'ended') {
      active = Math.max(0, active - 1);
      if (e.status === 'completed') completed++; else failed++;
      const t = num(e.tokens); lastCallTokens += t;
      const b = begun.get(e.taskId);
      perRun.push({ order: b ? b.n + 1 : null, round: b ? b.round : null, tokens: t, ...(e.toolUses != null ? { toolUses: num(e.toolUses) } : {}), ...(b ? { seconds: Math.round((T(e) - b.t) / 1000) } : {}) });
    }
  }
  perRun.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  const measured = haikuFrames.length > 0;
  let gUsd = gathererUsd, gTok = gathererTok;
  if (!measured) { gTok = lastCallTokens; gUsd = (lastCallTokens * 0.8 * 1 + lastCallTokens * 0.2 * 5) / 1e6; }   // fallback: Haiku 4.5 prices
  // By round: Haiku usage frames between one round's first start and the next round's first start.
  const byRound = roundStarts.map((s, i) => {
    const nxt = roundStarts[i + 1] ?? Infinity;
    const fr = haikuFrames.filter(f => f.t >= s && f.t < nxt);
    const rr = perRun.filter(r => r.round === i + 1);
    return { round: i + 1, runs: rr.length, usd: r6(fr.reduce((a, f) => a + f.usd, 0)), tokens: fr.reduce((a, f) => a + f.tok, 0), lastCallTokens: rr.reduce((a, r) => a + r.tokens, 0), seconds: rr.reduce((a, r) => a + (r.seconds || 0), 0) };
  });
  const lead = roles.lead;
  const gatherers = {
    runs, completed, failed, maxAtOnce, tokens: gTok, usd: r6(gUsd), usdEstimated: !measured,
    usdBasis: measured
      ? "Haiku entries in the Lead's usage; upper bound, includes the Lead's own small housekeeping calls"
      : 'estimated from the subagents\' reported tokens at assumed Haiku prices (no Haiku usage frames in the log)',
    leadOwnUsd: r6(Math.max(0, (lead?.usd || 0) - gUsd)),
    lastCallTokens,
    usdPerRun: runs ? r6(gUsd / runs) : 0,
    byRound,
    perRun
  };
  if (totalUsd > 0) gatherers.shareOfTotal = r6(gUsd / totalUsd);

  // ---- notes and report ----
  const dir = join(expRoot, id);
  const files = existsSync(dir) ? readdirSync(dir).filter(f => /^notes-.*\.md$/.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) : [];
  const noteUrls = new Set();
  const notes = files.map(f => {
    const txt = readFileSync(join(dir, f), 'utf8');
    const urls = urlsOf(txt);
    urls.forEach(u => noteUrls.add(u));
    // Items: bullet or numbered lines outside the Gaps section. "not opened" beats "opened".
    let inGaps = false, opened = 0, notOpened = 0, gaps = 0;
    for (const l of txt.split(/\r?\n/)) {
      if (/^#{1,6}\s/.test(l)) inGaps = /^#{1,6}\s*(\d+[.)]?\s*)?gaps?\b/i.test(l);
      if (!/^\s*(?:[-*]|\d+[.)])\s+/.test(l)) continue;
      if (inGaps) { gaps++; continue; }
      if (/not\s+opened/i.test(l)) notOpened++;
      else if (/\bopened\b/i.test(l)) opened++;
    }
    const out = { file: f, bytes: statSync(join(dir, f)).size, links: urls.size, opened, notOpened, gaps };
    // A note may end with "Searches used: N [of M]. Pages opened: P [of Q]" (or "Fetches: P").
    const sm = txt.match(/searches used:?\s*(\d+)/i);
    const pm = txt.match(/pages opened:?\s*(\d+)/i) || txt.match(/\bfetches:?\s*(\d+)/i);
    if (sm) out.searches = Number(sm[1]);
    if (pm) out.pagesOpened = Number(pm[1]);
    return out;
  });
  let reportSources = null;
  const rep = join(dir, 'REPORT.md');
  if (existsSync(rep)) {
    const t = readFileSync(rep, 'utf8');
    const m = t.match(/^#{1,6}\s*(?:\d+[.)]?\s*)?sources\b[^\n]*\n([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im);
    if (m) { const listed = urlsOf(m[1]); reportSources = { listed: listed.size, fromNotes: [...listed].filter(u => noteUrls.has(u)).length }; }
  }

  return {
    id,
    status: stopped ? 'finished' : 'running',
    stopReason: stopped?.reason || null,
    elapsedMin: started && stopped ? r2((stopT - t0) / 60000) : 0,
    loops: mine.filter(e => e.type === 'expedition_loop').length,
    decisions: mine.filter(e => e.type === 'expedition_decision').length,
    parked: mine.filter(e => e.type === 'expedition_parked' && e.kind !== 'lesson').length,
    envelope: started?.envelope ? { hours: started.envelope.hours ?? null, percent: started.envelope.percent ?? null, dollars: started.envelope.dollars ?? null, gatherers: started.envelope.gatherers ?? null } : null,
    roles,
    totalUsd: r6(totalUsd),
    byModel: Object.fromEntries(Object.entries(byModel).sort().map(([k, v]) => [k, r6(v)])),
    gatherers,
    notes,
    reportSources
  };
}

function urlsOf(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/https?:\/\/[^\s)<>\]"'`]+/g)) out.add(m[0].replace(/[.,;:!?*_]+$/, '').replace(/\/+$/, ''));
  return out;
}

const ids = [...new Set(events.filter(e => e.expedition && /^expedition_/.test(e.type)).map(e => e.expedition))];
const expeditions = ids.map(analyseExpedition).sort((a, b) => (a.id < b.id ? -1 : 1));

// ---- what-if ----
// Measured basis: the finished expeditions pooled. Cost per search = gatherer dollars per run / searches per run, where the
// searches per run are the average of the notes that state "Searches used". Reading cost: bytes per search from the notes
// themselves, ~4 characters per token, read once each by the Lead (Opus), Synthesizer (Opus), Skeptic (Sonnet) and Verifier
// (Opus) at the input prices in notes-4.md (Opus 5.5 $4 per M tokens, Sonnet 5.5 $2 per M).
const fin = expeditions.filter(e => e.status === 'finished' && e.gatherers.runs > 0);
const poolUsd = fin.reduce((s, e) => s + e.gatherers.usd, 0), poolRuns = fin.reduce((s, e) => s + e.gatherers.runs, 0);
const counted = fin.flatMap(e => e.notes.filter(n => n.searches != null && n.links > 0));
const avgSearches = counted.length ? counted.reduce((s, n) => s + n.searches, 0) / counted.length : 8;
const usdPerRun = poolRuns ? poolUsd / poolRuns : 0;
const usdPerSearch = usdPerRun / avgSearches;
const finNotes = fin.flatMap(e => e.notes.filter(n => n.links > 0));
const avgNoteBytes = finNotes.length ? finNotes.reduce((s, n) => s + n.bytes, 0) / finNotes.length : 0;
const bytesPerSearch = avgNoteBytes / avgSearches;
const READ_USD_PER_TOKEN = (3 * 4 + 1 * 2) / 1e6;   // three Opus readers at $4 per M, one Sonnet reader at $2 per M
const base = { atOnce: 3, searches: avgSearches, rounds: 4 / 3, runs: poolRuns / fin.length };   // what the finished expedition ran: 3 at once plus 1 gap run
const finOne = fin.find(e => e.id === '20261116-what-is-the-best-way-for-the-crux-hub-to') || fin[0];
const baseRuns = finOne ? finOne.gatherers.runs : base.runs;
const envelopeUsd = 63;   // 7% of the week x $9 per percent: the hub's documented example figure, see assumptions
const row = (atOnce, searches, rounds, runs) => {
  const dSearches = Math.max(0, runs * searches - baseRuns * avgSearches);
  const gathererUsd = dSearches * usdPerSearch;
  const downstreamUsd = (dSearches * bytesPerSearch / 4) * READ_USD_PER_TOKEN;
  const addedUsd = gathererUsd + downstreamUsd;
  return { atOnce, searches: r2(searches), rounds: r2(rounds), gathererRuns: runs, gathererUsd: r2(gathererUsd), downstreamUsd: r2(downstreamUsd), addedUsd: r2(addedUsd), envelopeShare: r6(addedUsd / envelopeUsd) };
};
const whatIf = [{ ...row(3, avgSearches, 4 / 3, baseRuns), note: 'the setting the finished expedition ran (3 at once plus 1 gap run, 4.5 searches used on average); the baseline' }];
whatIf[0].addedUsd = 0; whatIf[0].gathererUsd = 0; whatIf[0].downstreamUsd = 0; whatIf[0].envelopeShare = 0;
for (const atOnce of [3, 4, 6, 8]) for (const searches of [8, 12, 16, 24]) for (const rounds of [2, 3]) whatIf.push(row(atOnce, searches, rounds, atOnce * rounds));

const results = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  source: { events: '.crux/events.jsonl', eventsRead: events.length },
  expeditions,
  whatIf,
  whatIfBasis: { baselineRuns: baseRuns, avgSearchesUsedPerRun: r2(avgSearches), notesWithSearchCount: counted.length, usdPerRun: r6(usdPerRun), usdPerSearch: r6(usdPerSearch), avgNoteBytes: Math.round(avgNoteBytes), bytesPerSearch: Math.round(bytesPerSearch), readUsdPerMillionTokens: 14, finishedExpeditionsCovered: fin.length },
  assumptions: {
    envelopeUsd,
    whatIf: `Baseline = what the finished expedition actually ran: 3 gatherers at once plus 1 gap run (${baseRuns} runs), each using about ${r2(avgSearches)} of the 8 searches allowed. Every other row is a full setting (at once x rounds runs, each using ALL of its searches), so it is an upper bound next to the baseline. Gatherer dollars = extra searches x $${r6(usdPerSearch)} per search, which is the measured Haiku spend per run ($${r6(usdPerRun)}) divided by ${r2(avgSearches)} searches; it is linear in searches, but real cost per gatherer grows faster than its search count because each call re-reads the gatherer's growing context, so these are lower bounds on that part. Reading dollars (downstream) = the extra note text (${Math.round(bytesPerSearch)} bytes per search measured from the notes, about 4 characters per token) read once each by the Lead, Synthesizer and Verifier (Opus, $4 per M input tokens) and the Skeptic (Sonnet, $2 per M), prices from notes-4.md; caching, longer re-reads and output are ignored. Time saved is not modelled. The envelope is $${envelopeUsd}: 7% of the week at $9 per percent. The hub's hub.json has no dollars-per-percent figure and the log's expedition_started envelope has dollars null, so $9 is the hub's documented example figure (hub.mjs), not a measured one. It covers ${fin.length} finished expedition${fin.length === 1 ? '' : 's'}.`,
    gatherers: "Gatherers are Haiku subagents inside the Lead, so the log has no per-subagent dollar frame. Their dollars are the Haiku entries of the Lead's usage frames (measured, but an upper bound: it also counts the Lead's own small Haiku housekeeping calls); the Lead's own spend is the rest of its row. tokens = all Haiku tokens in those frames including cache reads; lastCallTokens = the sum of the tokens each subagent reported when it ended, which is much smaller. Tool uses are not logged. Seconds per run are from the started and ended events. Rounds are found from the events (a run that starts while none is running begins a new round). Observed gatherers used about " + r2(avgSearches) + " of the 8 searches allowed. Notes counts come from the text of each notes file: items marked not opened versus opened, and the lines under its Gaps heading. Usage is counted up to the moment the hub wrote How it ran, so it matches that table to the cent."
  },
  handRun: { handRun: true, source: 'spec Appendix A (hand-run reference expedition, not in any log)', agentRuns: 10, subagentTokens: 1100000, tokensAreLeadEstimates: true, minutes: 50, gatherers: 3, buildLoops: 2, successTestItems: 18 }
};
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(`wrote ${outFile}: ${expeditions.length} expeditions, ${whatIf.length} what-if rows`);
