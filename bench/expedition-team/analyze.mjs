// Expedition team analyzer. Plain Node, no packages. Reads <project>/.crux/events.jsonl once, read-only, and the
// expedition folders under <project>/.crux/expeditions/, and writes numbers only (no message text) to
// bench-out/results.json next to this tool's expedition folder, or to the file in env ANALYZE_RESULTS.
// Usage: node analyze.mjs [project folder]   (default: found by walking up from this file or the current folder)
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
function findProject() {
  if (process.argv[2]) return resolve(process.argv[2]);
  for (const start of [process.cwd(), here]) {
    let d = resolve(start);
    for (;;) {
      if (existsSync(join(d, '.crux', 'events.jsonl'))) return d;
      const up = dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  throw new Error('cannot find <project>/.crux/events.jsonl');
}
const project = findProject();
const logFile = join(project, '.crux', 'events.jsonl');
const expRoot = join(project, '.crux', 'expeditions');
const outFile = process.env.ANALYZE_RESULTS ? resolve(process.env.ANALYZE_RESULTS)
  : join(existsSync(join(here, '..', 'BRIEF.md')) ? join(here, '..') : process.cwd(), 'bench-out', 'results.json');

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
// Assumed dollars per 1% of the week when the log gives no dollar cap (the hub's own documented example is 9).
const DOLLARS_PER_PERCENT = 9;

// ---- roles: same logic as hub/lib/expedition-report.mjs howItRan (reimplemented: that file is not reachable from the worktree copy) ----
function analyseExpedition(id) {
  const mine = events.filter(e => e.expedition === id);
  const started = mine.find(e => e.type === 'expedition_started') || null;
  const stopped = mine.findLast(e => e.type === 'expedition_stopped') || null;
  const roleOf = new Map(mine.filter(e => e.type === 'agent_created').map(e => [e.agent, e.expeditionRole]));
  const rows = new Map();
  const row = role => {
    if (!rows.has(role)) rows.set(role, { agents: new Set(), turns: 0, workMs: 0, tokensIn: 0, tokensOut: 0, usd: 0 });
    return rows.get(role);
  };
  let gathererUsd = 0, gathererTok = 0, gathererTurnsSeen = 0;
  for (const e of mine.filter(e => e.type === 'usage')) {
    const role = e.expeditionRole || roleOf.get(e.agent) || 'unknown';
    const r = row(role);
    r.agents.add(e.agent);
    const models = Object.values(e.models || {});
    if (models.length) r.turns++;
    for (const m of models) { r.tokensIn += num(m.input) + num(m.cacheRead) + num(m.cacheCreation); r.tokensOut += num(m.output); }
    r.usd += num(e.costUSD);
    // Gatherers are Haiku subagents inside the Lead: their dollars show up as the Haiku share of the Lead's usage.
    if (role === 'lead') for (const [model, m] of Object.entries(e.models || {})) if (HAIKU.test(model)) {
      gathererUsd += num(m.cost); gathererTok += num(m.input) + num(m.output) + num(m.cacheRead) + num(m.cacheCreation); gathererTurnsSeen++;
    }
  }
  const names = new Set(roleOf.keys());
  let end = stopped ? Date.parse(stopped.ts) : 0;
  if (!stopped) for (const e of events) end = Math.max(end, Date.parse(e.ts) || 0);
  const openSince = new Map();
  for (const e of events) {
    if (e.type !== 'agent_busy' || !names.has(e.agent)) continue;
    const role = roleOf.get(e.agent), t = Date.parse(e.ts);
    if (e.busy) { if (!openSince.has(e.agent)) openSince.set(e.agent, t); continue; }
    if (openSince.has(e.agent)) { const r = row(role); r.workMs += Math.max(0, t - openSince.get(e.agent)); openSince.delete(e.agent); r.agents.add(e.agent); }
  }
  for (const [agent, t] of openSince) { const r = row(roleOf.get(agent)); r.workMs += Math.max(0, end - t); r.agents.add(agent); }

  const roles = {};
  let totalUsd = 0;
  for (const k of [...ROLE_KEYS, ...[...rows.keys()].filter(k => !ROLE_KEYS.includes(k))]) {
    const r = rows.get(k);
    if (!r && ROLE_KEYS.includes(k)) { roles[k] = { agents: 0, turns: 0, tokensIn: 0, tokensOut: 0, usd: 0, minutes: 0 }; continue; }
    if (!r) continue;
    roles[k] = { agents: r.agents.size, turns: r.turns, tokensIn: r.tokensIn, tokensOut: r.tokensOut, usd: r6(r.usd), minutes: r2(r.workMs / 60000) };
    totalUsd += r.usd;
  }
  for (const k of Object.keys(roles)) {
    roles[k].shareOfTotal = totalUsd > 0 ? r6(roles[k].usd / totalUsd) : 0;
    roles[k].usdPerTurn = roles[k].turns ? r6(roles[k].usd / roles[k].turns) : 0;
  }

  // ---- gatherers, from expedition_subagent events ----
  const sub = mine.filter(e => e.type === 'expedition_subagent');
  const begun = new Map(), perRun = [];
  let completed = 0, failed = 0, atOnce = 0, maxAtOnce = 0, tokens = 0;
  for (const e of sub) {
    if (e.phase === 'started') { begun.set(e.taskId, Date.parse(e.ts)); atOnce++; maxAtOnce = Math.max(maxAtOnce, atOnce); }
    else if (e.phase === 'ended') {
      atOnce = Math.max(0, atOnce - 1);
      const ok = e.status === 'completed';
      if (ok) completed++; else failed++;
      const t = num(e.tokens); tokens += t;
      const run = { tokens: t };
      if (e.toolUses != null) run.toolUses = num(e.toolUses);
      if (begun.has(e.taskId)) run.minutes = r2((Date.parse(e.ts) - begun.get(e.taskId)) / 60000);
      perRun.push(run);
    }
  }
  const runs = sub.filter(e => e.phase === 'started').length;
  // Per-run dollars are not logged; the Haiku dollars in the Lead's usage frames are the measured total.
  const measured = gathererTurnsSeen > 0;
  let gUsd = gathererUsd;
  const haikuPrice = { in: 1, out: 5 };   // assumed $/M tokens, used only if no Haiku usage frames exist
  if (!measured) gUsd = (tokens * 0.8 * haikuPrice.in + tokens * 0.2 * haikuPrice.out) / 1e6;
  const lead = roles.lead;
  const gatherers = {
    runs, completed, failed, maxAtOnce, tokens, usd: r6(gUsd), usdEstimated: !measured,
    loggedTokensAllKinds: gathererTok,   // Haiku tokens incl. cache, from the Lead's usage frames
    usdPerRun: runs ? r6(gUsd / runs) : 0,
    perRun
  };
  if (lead && measured) { gatherers.leadOwnUsd = r6(Math.max(0, lead.usd - gUsd)); gatherers.shareOfTotal = totalUsd > 0 ? r6(gUsd / totalUsd) : 0; }

  // ---- notes and report ----
  const dir = join(expRoot, id);
  const files = existsSync(dir) ? readdirSync(dir).filter(f => /^notes-.*\.md$/.test(f)).sort() : [];
  const noteUrls = new Set();
  const notes = files.map(f => {
    const txt = readFileSync(join(dir, f), 'utf8');
    const urls = urlsOf(txt);
    urls.forEach(u => noteUrls.add(u));
    // Items: bullet or numbered lines outside the Gaps section. "not opened" beats "opened".
    const lines = txt.split(/\r?\n/);
    let inGaps = false, opened = 0, notOpened = 0, gaps = 0;
    for (const l of lines) {
      if (/^#{1,6}\s/.test(l)) inGaps = /^#{1,6}\s*(\d+[.)]?\s*)?gaps?\b/i.test(l);
      const item = /^\s*(?:[-*]|\d+[.)])\s+/.test(l);
      if (!item) continue;
      if (inGaps) { gaps++; continue; }
      if (/not\s+opened/i.test(l)) notOpened++;
      else if (/\bopened\b/i.test(l)) opened++;
    }
    const sm = txt.match(/Searches used:\s*(\d+)/i);
    const out = { file: f, links: urls.size, opened, notOpened, gaps };
    if (sm) out.searches = Number(sm[1]);
    return out;
  });
  let reportSources = null;
  const rep = join(dir, 'REPORT.md');
  if (existsSync(rep)) {
    const t = readFileSync(rep, 'utf8');
    const m = t.match(/^#{1,6}\s*(?:\d+[.)]?\s*)?sources\b[^\n]*\n([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im);
    if (m) { const listed = urlsOf(m[1]); reportSources = { listed: listed.size, fromNotes: [...listed].filter(u => noteUrls.has(u)).length }; }
  }

  const stoppedOk = !!stopped;
  return {
    id,
    status: stoppedOk ? 'finished' : 'running',
    stopReason: stopped?.reason || null,
    elapsedMin: started && stopped ? r2((Date.parse(stopped.ts) - Date.parse(started.ts)) / 60000) : 0,
    loops: mine.filter(e => e.type === 'expedition_loop').length,
    decisions: mine.filter(e => e.type === 'expedition_decision').length,
    parked: mine.filter(e => e.type === 'expedition_parked' && e.kind !== 'lesson').length,
    envelope: started?.envelope ? { hours: started.envelope.hours ?? null, percent: started.envelope.percent ?? null, dollars: started.envelope.dollars ?? null, gatherers: started.envelope.gatherers ?? null } : null,
    roles,
    totalUsd: r6(totalUsd),
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

// ---- what-if: scale the measured gatherer spend ----
// Cost basis: the finished expeditions' gatherers pooled. Dollars per search when the notes count searches, else per run x searches/8.
const fin = expeditions.filter(e => e.status === 'finished' && e.gatherers.runs > 0);
const poolUsd = fin.reduce((s, e) => s + e.gatherers.usd, 0), poolRuns = fin.reduce((s, e) => s + e.gatherers.runs, 0);
// Only some notes files state "Searches used: N", so the average per counted file stands in for every run.
const counted = fin.flatMap(e => e.notes.filter(n => n.searches > 0));
const avgSearches = counted.length ? counted.reduce((s, n) => s + n.searches, 0) / counted.length : 0;
const searchesCountable = avgSearches > 0;
const perRun = poolRuns ? poolUsd / poolRuns : 0;
// Cost also has a fixed part (instructions, final write-up); it is spread over the searches. Without a count: per run / 8.
const perSearch = searchesCountable ? perRun / avgSearches : perRun / 8;
const BASE = { atOnce: 3, searches: 8, rounds: 2 };
const cost = c => c.atOnce * c.rounds * c.searches * perSearch;
const baseUsd = cost(BASE);
const capOf = e => (e.envelope?.dollars ?? (e.envelope?.percent != null ? e.envelope.percent * DOLLARS_PER_PERCENT : null));
const capsKnown = fin.map(capOf).filter(c => c > 0);
const capUsd = capsKnown.length ? capsKnown.reduce((a, b) => a + b, 0) / capsKnown.length : 3 * DOLLARS_PER_PERCENT;
const grid = [];
for (const atOnce of [3, 4, 6, 8]) for (const searches of [8, 12, 16, 24]) for (const rounds of [2, 3]) grid.push({ atOnce, searches, rounds });
const whatIf = grid.map(c => {
  const total = cost(c), added = total - baseUsd;
  return { atOnce: c.atOnce, searches: c.searches, rounds: c.rounds, gathererRuns: c.atOnce * c.rounds, totalUsd: r2(total), addedUsd: r2(Math.max(0, added)), envelopeShare: r6(Math.max(0, added) / capUsd) };
});

const results = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  source: { events: '.crux/events.jsonl', eventsRead: events.length },
  expeditions,
  whatIf,
  whatIfBasis: { baseline: BASE, baselineUsd: r2(baseUsd), usdPerSearch: r6(perSearch), usdPerRun: r6(perRun), searchesCountable, avgSearchesUsedPerRun: r2(avgSearches), notesWithSearchCount: counted.length, capUsd: r2(capUsd), capFromLog: capsKnown.length > 0 },
  assumptions: {
    whatIf: `Cost of one gatherer search is the finished expeditions' measured Haiku spend (the Haiku share of the Lead's usage frames) ${searchesCountable ? `the average number of searches the notes files that state it report ("Searches used: N", ${r2(avgSearches)} per run of the 8 allowed, ${counted.length} files)` : 'their runs, then scaled by searches/8'}. Added dollars = (at once x rounds x searches - 3 x 2 x 8) x that cost, i.e. the default is 3 at once, 8 searches, 2 rounds, and every gatherer is assumed to use all of its searches (the measured gatherers used fewer than the 8 allowed, so these are upper bounds). It assumes cost grows in proportion to searches, ignores the extra Lead and Synthesizer reading that more notes cause (so it is a lower bound) and ignores any saving in wall-clock time. The envelope share divides by the dollar cap: ${capsKnown.length ? 'from the log' : `percent of the week x $${DOLLARS_PER_PERCENT} per percent (the hub's documented example figure, not a measured one), averaged over the finished expeditions`}, about $${r2(capUsd)}.`,
    gatherers: 'Gatherers are Haiku subagents inside the Lead. The log has no per-subagent dollar frame, so their dollars are the Haiku part of the Lead\'s usage frames (measured, not estimated); the Lead\'s own spend is the rest of its row. "tokens" is what each subagent reported when it ended; loggedTokensAllKinds counts all Haiku tokens including cache reads, so the two differ. Tool uses are not logged. Minutes per run are from the started and ended events. Notes counts come from the text of each notes file: items marked "not opened" versus "opened", and the lines under its Gaps heading.'
  },
  handRun: { handRun: true, source: 'spec Appendix A (hand-run reference expedition, not in any log)', agentRuns: 10, subagentTokens: 1100000, tokensAreLeadEstimates: true, minutes: 50, gatherers: 3, buildLoops: 2, successTestItems: 18 }
};
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(`wrote ${outFile}: ${expeditions.length} expeditions, ${whatIf.length} what-if rows`);
