#!/usr/bin/env node
// Permission study: how much of each orchestrator's work and context goes to answering workers' permission
// requests (decision 21). Read-only: it reads <project>/.crux/events.jsonl and writes one Markdown report.
// Nothing is sent anywhere and no file in the project is changed.
//
//   node tools/permission-study.mjs [project folders...] [--days 30] [--out report.md] [--examples] [--reclassify]
//
// With no folders it uses ~/crux/hub.json's projects (CRUX_HOME moves ~/crux), else the current folder.
// --days     only events from the last N days (default: everything in the log)
// --out      where to write the report (default: permission-study-<date>.md in the current folder)
// --examples include a few shortened sample commands per request kind. Off by default: commands can carry
//            paths and project details, and the report may be shared.
// --reclassify  also run every logged request through today's permission checker (run it on the hub's own PC)
// --check    also compare the one-shot permission check's shadow lines (check_shadow) with the real answers; every
//            disagreement is listed in full (decision 66)
// --level    the permission level for --reclassify: standard, auto or trusted (default: the project's own)
// --home     the home folder commands were written for, when reading a log copied from another machine
//
// How turns are counted. A permission request reaches the orchestrator as a message the log does not keep, so
// the study works from the orchestrator's turns instead: each turn runs from agent_busy true to agent_busy false.
// A turn is "permission only" when, between the end of its previous turn and its own end, nothing else could
// have woken it: no message in its thread from you or a worker, no summary, no pick, no handoff question, only
// permission requests routed to it. Its usage events (cost and tokens) and its change in context % are then
// put down to permission requests. Turns with permission answers and something else are "mixed": counted
// separately, as an upper bound.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ---------- reading ----------

export function readEvents(projectDir) {
  const file = join(projectDir, '.crux', 'events.jsonl');
  if (!existsSync(file)) return null;
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line */ }
  }
  return out;
}

export function projectsFromHubJson(home = process.env.CRUX_HOME || join(homedir(), 'crux')) {
  const f = join(home, 'hub.json');
  if (!existsSync(f)) return [];
  try { return (JSON.parse(readFileSync(f, 'utf8')).projects || []).filter(p => typeof p === 'string'); } catch { return []; }
}

// ---------- request kinds ----------

// A short, stable label for what a request was, so repeats group together: "Bash: git push · worktree".
// Most requests are small scripts, so the label names the first command in them that does real work: it skips
// variable assignments, cd, control words (if, foreach, for, do), the call operator &, .NET calls and helpers
// that only filter or print (grep, Select-Object, echo, Test-Path). For tools with subcommands the subcommand is
// kept; for node and python only the script's file name, never its path. After the dot: where it works, the
// furthest out of temp, worktree, project, another repo, home or system (see whereOf).
const SUBCOMMANDS = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'node', 'python', 'python3', 'py', 'pip', 'uv', 'cargo', 'go', 'gh', 'docker', 'winget', 'choco', 'tailscale', 'rustup']);
const CONTROL = /^(if|elseif|else|foreach|for|while|until|do|done|then|fi|try|catch|finally|switch|function|param|begin|process|end|return|exit|break|continue|in|esac|case|time|!)$/i;
const HELPERS = new Set(['cd', 'set-location', 'pushd', 'popd', 'echo', 'printf', 'write-host', 'write-output', 'test-path', 'join-path', 'split-path', 'out-null', 'out-string', 'select-object', 'select-string', 'where-object', 'foreach-object', 'sort-object', 'measure-object', 'format-table', 'format-list', 'grep', 'tr', 'wc', 'head', 'tail', 'sort', 'uniq', 'cut', 'sed', 'awk', 'xargs', 'tee', 'sleep', 'start-sleep', 'get-date', 'true', 'false', 'test', 'cat', 'ls', 'dir', 'get-item', 'get-childitem', 'get-content', 'resolve-path', 'basename', 'dirname', 'date', 'pwd', 'get-location', 'new-object', 'add-type', 'clear', 'cls', 'type']);
const unq = w => String(w || '').replace(/^[("'`]+|[)"'`]+$/g, '');
const LOOPS = /^(for|foreach|while|until|case|switch|function|param)$/i;   // a segment that opens a loop names no program
const WRAPPERS = new Set(['timeout', 'nohup', 'env', 'time', 'sudo', 'call']);
function programOf(seg) {
  // Words, keeping a quoted path ("C:\Program Files\x.exe") together.
  let words = (seg.trim().match(/"[^"]*"|'[^']*'|\S+/g) || []);
  let called = false;   // after the call operator &, a quoted first word is a program; without it, just a string
  while (words.length) {
    const w = unq(words[0]);
    if (LOOPS.test(w)) return null;
    if (w === '&' || w === '.') { called = true; words.shift(); continue; }
    if (!w || CONTROL.test(w) || /^\(+$/.test(words[0])) { words.shift(); continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) { words.shift(); continue; }            // VAR=value prefix
    if (WRAPPERS.has(w.toLowerCase())) { words.shift(); while (words.length && /^(-\S+|\d+[smh]?)$/.test(words[0])) words.shift(); continue; }
    break;
  }
  if (!words.length) return null;
  const first = unq(words[0]);
  if (/^["']/.test(words[0]) && !called && !/[\\/]/.test(first)) return null;           // a bare string PowerShell prints
  if (/^\$/.test(first) || /^\[/.test(words[0].replace(/^\(+/, ''))) return null;           // a variable, an assignment or a .NET call
  const raw = first.replace(/^\$\{?env:[\w()]+\}?/i, '');
  const prog = raw.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
  if (!prog || /^[\d.]+$/.test(prog)) return null;
  if (/\.(m?js|cjs|sh|py)$/.test(prog)) return { prog: `script .${prog.split('.').pop()}`, sub: '' };
  let sub = '';
  const rest = words.slice(1).map(unq);
  if (/^(node|python|python3|py)$/.test(prog)) {
    if (rest.includes('--test')) sub = '--test';
    else { const f = rest.find(x => !x.startsWith('-') && /\.(m?js|cjs|py)$/i.test(x)); sub = f ? f.replace(/^.*[\\/]/, '') : (rest.some(x => x === '-e' || x === '-c') ? '-e' : ''); }
  } else if (prog === 'cmd') sub = (rest.find(x => x && !/^\/\/?[ck]$/i.test(x)) || '').replace(/^["']/, '').split(/\s+/)[0].toLowerCase();
  else if (SUBCOMMANDS.has(prog)) sub = rest.find(x => x && !x.startsWith('-') && !/[\\/=$]/.test(x)) || '';
  return { prog, sub };
}

// Where a command works, judged from the paths it names: the furthest out wins.
const WHERE = ['', 'temp', 'worktree', 'project', 'another repo', 'home', 'system'];
export function whereOf(text, { projectDir = '', home = homedir() } = {}) {
  const nm = p => String(p).replace(/^\/([a-z])\//i, '$1:/').replace(/\\/g, '/').replace(/^\$env:USERPROFILE|^\$HOME|^~/i, home.replace(/\\/g, '/')).toLowerCase();
  const proj = nm(projectDir).replace(/\/+$/, '');
  const h = nm(home).replace(/\/+$/, '');
  // The project as named in commands: its own path, or <home>/Documents/GitHub/<its folder name> (so a log read
  // from another machine or a mounted copy still knows its own repo).
  const name = proj.split('/').pop();
  const projAt = [proj, name ? `${h}/documents/github/${name}` : ''].filter(Boolean);
  const under = (p, base, sub = '') => p === base + sub || p.startsWith(base + sub + '/');
  let rank = 0;
  const bump = w => { rank = Math.max(rank, WHERE.indexOf(w)); };
  const t = String(text || '');
  if (/\$env:TEMP|\$TEMP\b|%TEMP%|\bmktemp\b|\/tmp\/|AppData[\\/]Local[\\/]Temp/i.test(t)) bump('temp');
  for (const m of t.matchAll(/(?:(?<![\w/])[A-Za-z]:[\\/]|\/[a-z]\/|~[\\/]|\$env:USERPROFILE[\\/]|\$HOME\/)[^\s"';|&<>`)]*/g)) {
    const p = nm(m[0]);
    if (/appdata\/local\/temp/.test(p) || p.startsWith('/tmp')) bump('temp');
    else if (projAt.some(b => under(p, b, '/.claude/worktrees'))) bump('worktree');
    else if (projAt.some(b => under(p, b))) bump('project');
    else if (p.startsWith(h + '/documents/github/')) bump('another repo');
    else if (p.startsWith(h + '/') || p === h) bump('home');
    else bump('system');
  }
  return WHERE[rank];
}

export function requestKind(tool, command = '', ctx = {}) {
  const c = String(command || '').trim();
  const where = whereOf(c, ctx);
  const tag = where ? ` · ${where}` : '';
  if (/^(Bash|PowerShell)$/.test(tool)) {
    const segments = c.split(/\s*(?:&&|\|\||;|\||\r?\n|\{|\}|\$\(|\(\s*(?=[A-Za-z]))\s*/).map(x => x.trim()).filter(Boolean);
    const progs = segments.map(programOf).filter(Boolean);
    const main = progs.find(p => !HELPERS.has(p.prog));
    const dotnet = /\[[\w.]+\]::|\[[\w.]+,/.test(c);
    if (!main && dotnet) return `${tool}: .NET call${tag}`;
    const pick = main || progs[0];
    if (!pick) return `${tool}: (variables only)${tag}`;
    return `${tool}: ${pick.prog}${pick.sub ? ' ' + pick.sub : ''}${tag}`;
  }
  if (tool === 'WebFetch') { try { return `WebFetch: ${new URL(c).host}`; } catch { return 'WebFetch'; } }
  if (tool === 'WebSearch') return 'WebSearch';
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) {
    const ext = (c.match(/\.([a-z0-9]{1,6})$/i) || [])[1];
    return `${tool}${ext ? ` .${ext.toLowerCase()}` : ''}${tag}`;
  }
  if (tool.startsWith('mcp__')) return `Connector/MCP: ${tool.split('__')[1] || tool}`;
  return `${tool}${tag}`;
}

// ---------- analysis ----------

const usageCost = ev => typeof ev.costUSD === 'number' ? ev.costUSD : Object.values(ev.models || {}).reduce((s, m) => s + (m.cost || 0), 0);
const usageTokens = ev => {
  const t = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  for (const m of Object.values(ev.models || {})) for (const k of Object.keys(t)) t[k] += m[k] || 0;
  return t;
};
const ms = ts => Date.parse(ts);

export function analyze(events, { sinceMs = -Infinity, graceMs = 15000, projectDir = '', home } = {}) {
  const ctx = { projectDir, ...(home ? { home } : {}) };
  const evs = events.filter(e => e && e.ts && ms(e.ts) >= sinceMs).sort((a, b) => ms(a.ts) - ms(b.ts));

  // Orchestrators: every agent created with role orchestrator, in order (one per handoff generation).
  const orchList = evs.filter(e => e.type === 'agent_created' && e.role === 'orchestrator').map(e => ({ name: e.agent, thread: e.thread, created: ms(e.ts) }));
  const orchNames = new Set(orchList.map(o => o.name));
  // Logs that start before the window may lack agent_created: names seen answering permissions count too.
  for (const e of evs) if (e.type === 'permission_answer' && e.by && !['hub', 'you', 'permission check'].includes(e.by) && !orchNames.has(e.by)) { orchNames.add(e.by); orchList.push({ name: e.by, thread: 'orchestrator', created: ms(e.ts) }); }
  const orchThreads = new Set(['orchestrator', ...orchList.map(o => o.thread).filter(Boolean)]);

  // ---- requests and answers ----
  const approvals = new Map();     // id -> approval event
  for (const e of evs) if (e.type === 'approval') approvals.set(e.approval, e);
  const routed = [...approvals.values()].filter(a => a.routedTo);
  const toYouDirect = [...approvals.values()].filter(a => !a.routedTo);
  const answers = evs.filter(e => e.type === 'permission_answer');
  const firstAnswer = new Map();
  for (const a of answers) if (a.approval && !firstAnswer.has(a.approval)) firstAnswer.set(a.approval, a);
  const results = new Map();
  for (const e of evs) if (e.type === 'approval_result') results.set(e.approval, e);
  const escalated = new Set(evs.filter(e => e.type === 'approval_escalated').map(e => e.approval));

  const byOrch = answers.filter(a => orchNames.has(a.by));
  const count = (list, ans) => list.filter(a => a.answer === ans).length;
  const hubAnswered = answers.filter(a => a.by === 'hub' && a.answer === 'allow' && !a.approval).length;   // passes and auto-mode own requests
  const youPreempted = answers.filter(a => a.by === 'you').length;
  const timeouts = answers.filter(a => a.answer === 'timeout').length;

  // What you did with the ones the orchestrator escalated or let time out.
  const escalatedOutcome = { allowed: 0, alwaysAllowed: 0, denied: 0, cancelled: 0, open: 0 };
  for (const id of escalated) {
    const how = results.get(id)?.how;
    if (!how) escalatedOutcome.open++;
    else if (how === 'always allowed') escalatedOutcome.alwaysAllowed++;
    else if (how === 'allowed') escalatedOutcome.allowed++;
    else if (how === 'denied') escalatedOutcome.denied++;
    else escalatedOutcome.cancelled++;
  }

  // Answer time: request to the orchestrator's answer.
  const waits = [];
  for (const a of byOrch) { const req = approvals.get(a.approval); if (req) waits.push((ms(a.ts) - ms(req.ts)) / 1000); }
  waits.sort((x, y) => x - y);
  const median = l => l.length ? l[Math.floor(l.length / 2)] : null;

  // ---- orchestrator turns ----
  const turns = [];
  const open = new Map();
  for (const e of evs) {
    if (e.type !== 'agent_busy' || !orchNames.has(e.agent)) continue;
    if (e.busy) { if (!open.has(e.agent)) open.set(e.agent, ms(e.ts)); }
    else if (open.has(e.agent)) {
      turns.push({ agent: e.agent, start: open.get(e.agent), end: ms(e.ts), contextPct: typeof e.contextPct === 'number' ? e.contextPct : null, stale: !!e.stale });
      open.delete(e.agent);
    }
  }
  turns.sort((a, b) => a.start - b.start);

  // What woke each turn: events between the previous turn's end (same agent) and this turn's end.
  const lastEnd = new Map();
  const ctxPrev = new Map();
  const isOtherTrigger = e =>
    (e.type === 'message' && orchThreads.has(e.thread) && !orchNames.has(e.from)) ||
    (e.type === 'summary') || (e.type === 'pick') || (e.type === 'handoff_qa') ||
    (e.type === 'lesson_result') || (e.type === 'question_dismissed') || (e.type === 'brief_delivered' && orchNames.has(e.agent));
  for (const t of turns) {
    const from = lastEnd.get(t.agent) ?? t.start - 60_000;   // first turn: the minute before it
    const window = evs.filter(e => { const x = ms(e.ts); return x > from && x <= t.end; });
    t.permAnswers = window.filter(e => e.type === 'permission_answer' && e.by === t.agent).length;
    t.permRequests = window.filter(e => e.type === 'approval' && e.routedTo === t.agent).length;
    t.other = window.filter(isOtherTrigger).length;
    t.kind = (t.permAnswers || t.permRequests) ? (t.other ? 'mixed' : 'permission') : 'other';
    // Usage: the agent's usage events inside the turn, or just after it ends.
    t.usage = evs.filter(e => e.type === 'usage' && e.agent === t.agent && !e.baseline && ms(e.ts) >= t.start && ms(e.ts) <= t.end + graceMs);
    t.cost = t.usage.reduce((s, u) => s + usageCost(u), 0);
    t.tokens = t.usage.reduce((s, u) => { const k = usageTokens(u); for (const x in s) s[x] += k[x]; return s; }, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    const prev = ctxPrev.get(t.agent);
    t.ctxDelta = t.contextPct != null && prev != null ? t.contextPct - prev : null;
    if (t.contextPct != null) ctxPrev.set(t.agent, t.contextPct);
    lastEnd.set(t.agent, t.end);
  }
  const sum = (l, f) => l.reduce((s, x) => s + f(x), 0);
  const permTurns = turns.filter(t => t.kind === 'permission');
  const mixedTurns = turns.filter(t => t.kind === 'mixed');
  const allOrchUsage = evs.filter(e => e.type === 'usage' && orchNames.has(e.agent) && !e.baseline);
  const orchCost = sum(allOrchUsage, usageCost);
  const permCost = sum(permTurns, t => t.cost);
  const mixedCost = sum(mixedTurns, t => t.cost);
  const ctxRises = turns.filter(t => t.ctxDelta != null && t.ctxDelta > 0);
  const permCtx = sum(permTurns.filter(t => t.ctxDelta > 0), t => t.ctxDelta);
  const allCtx = sum(ctxRises, t => t.ctxDelta);
  const ctxAtAnswer = permTurns.map(t => t.contextPct).filter(x => x != null).sort((a, b) => a - b);

  // Handoffs: successors after the first orchestrator in the window; share put down to permission context.
  const handoffs = Math.max(0, orchList.filter(o => o.created >= sinceMs).length - (evs.some(e => e.type === 'agent_created' && e.role === 'orchestrator') ? 1 : 0));
  const handoffShare = allCtx > 0 ? permCtx / allCtx : 0;

  // ---- request kinds ----
  const kinds = new Map();
  const kindOf = id => { const a = approvals.get(id); return a ? requestKind(a.tool, a.input?.command || a.input?.file_path || a.input?.notebook_path || a.input?.url || a.input?.query || '', ctx) : null; };
  for (const a of routed) {
    const k = kindOf(a.approval);
    if (!kinds.has(k)) kinds.set(k, { kind: k, total: 0, allow: 0, deny: 0, escalate: 0, timeout: 0, you: 0, examples: [] });
    const row = kinds.get(k);
    row.total++;
    const ans = firstAnswer.get(a.approval);
    if (!ans) continue;
    if (ans.by === 'you') row.you++;
    else if (ans.answer in row) row[ans.answer]++;
    const cmd = String(a.input?.command || a.input?.file_path || a.input?.url || '').replace(/\s+/g, ' ');
    if (row.examples.length < 2 && cmd) row.examples.push(cmd.length > 90 ? cmd.slice(0, 87) + '...' : cmd);
  }
  const kindRows = [...kinds.values()].sort((a, b) => b.total - a.total);
  const ruleCandidates = kindRows.filter(r => r.total >= 3 && r.allow === r.total);

  // Per-day volume.
  const days = new Map();
  for (const a of routed) { const d = a.ts.slice(0, 10); days.set(d, (days.get(d) || 0) + 1); }
  const spanDays = evs.length ? Math.max(1, (ms(evs.at(-1).ts) - ms(evs[0].ts)) / 86_400_000) : 0;

  return {
    span: evs.length ? { from: evs[0].ts, to: evs.at(-1).ts, days: spanDays } : null,
    orchestrators: orchList.length,
    requests: {
      total: approvals.size, routed: routed.length, toYouDirect: toYouDirect.length,
      orchAllow: count(byOrch, 'allow'), orchDeny: count(byOrch, 'deny'), orchEscalate: count(byOrch, 'escalate'),
      timeouts, youPreempted, hubAnswered, perDay: spanDays ? routed.length / spanDays : 0, busiestDays: [...days.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
      medianWaitSec: median(waits)
    },
    escalatedOutcome,
    turns: {
      total: turns.length, permission: permTurns.length, mixed: mixedTurns.length,
      orchCost, permCost, mixedCost,
      permTokens: permTurns.reduce((s, t) => { for (const x in s) s[x] += t.tokens[x]; return s; }, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }),
      avgPermTurnCost: permTurns.length ? permCost / permTurns.length : 0,
      permCtx, allCtx, handoffs, handoffShare,
      avgCtxPerPermTurn: permTurns.filter(t => t.ctxDelta != null).length ? sum(permTurns.filter(t => t.ctxDelta != null), t => t.ctxDelta) / permTurns.filter(t => t.ctxDelta != null).length : null,
      ctxAtAnswerMedian: median(ctxAtAnswer)
    },
    kinds: kindRows, ruleCandidates
  };
}

// ---------- re-classifying with today's rules (--reclassify) ----------
// Runs every logged request through the hub's current checker (lib/permission-rules.mjs, the same call routeFor
// makes), to show which would still reach the orchestrator or you today, and why. Run it on the machine the hub
// runs on: the checker reads real Windows paths. What the log does not keep is left at its default: the folder
// each command ran in (decision 64 A), and temp folders or downloads made by earlier commands.
export function levelOf(events, projectDir) {
  const set = [...events].reverse().find(e => e.type === 'project_settings' && e.permissionMode);
  if (set) return set.permissionMode === 'standard' ? 'standard' : set.permissionMode;
  try { return ['auto', 'trusted'].includes(JSON.parse(readFileSync(join(projectDir, '.crux-hub.json'), 'utf8')).permissions) ? 'auto' : 'standard'; } catch { return 'standard'; }
}

export function reclassify(events, { classify, readOnly = () => false, projectDir, level = 'standard', sinceMs = -Infinity }) {
  const autoLike = level !== 'standard';
  const res = new Map();
  for (const e of events) if (e.type === 'approval_result') res.set(e.approval, e.how);
  const rows = [];
  for (const a of events) {
    if (a.type !== 'approval' || !(Date.parse(a.ts) >= sinceMs)) continue;
    const input = a.input || {};
    const cmd = String(input.command || '');
    let now, why = [];
    if (/^(Bash|PowerShell)$/.test(a.tool) && readOnly(a.tool, cmd)) now = 'hub';
    else {
      let c;
      try { c = classify({ tool: a.tool, input, projectDir, agent: a.agent || '', level }); }
      catch (err) { c = { route: 'error', reasons: [String(err.message || err)], unsure: [] }; }
      if (c.route === 'human') { now = 'you'; why = c.reasons; }
      else if (c.route === 'allow') now = autoLike ? 'hub' : 'orchestrator';
      else if (c.route === 'unsure') { now = 'orchestrator'; why = c.unsure; }
      else { now = 'error'; why = c.reasons; }
    }
    rows.push({ id: a.approval, tool: a.tool, then: a.routedTo ? 'orchestrator' : 'you', now, why, how: res.get(a.approval) || null });
  }
  const tally = (list, key) => list.reduce((m, r) => (m[r[key]] = (m[r[key]] || 0) + 1, m), {});
  const reasonCount = list => {
    const m = new Map();
    for (const r of list) for (const w of new Set(r.why.map(x => String(x).replace(/(?<![\w/])[A-Za-z]:[\\/][^\s,;)'"]*/g, '<path>').replace(/\/[a-z]\/[^\s,;)'"]*/gi, '<path>').replace(/\d{3,}/g, '#').slice(0, 140))))
      m.set(w, (m.get(w) || 0) + 1);
    return [...m.entries()].sort((x, y) => y[1] - x[1]);
  };
  const wasOrch = rows.filter(r => r.then === 'orchestrator');
  const wasYou = rows.filter(r => r.then === 'you');
  return {
    level, total: rows.length,
    orchestratorThen: wasOrch.length, orchestratorNow: tally(wasOrch, 'now'),
    youThen: wasYou.length, youNow: tally(wasYou, 'now'),
    stillOrchestratorWhy: reasonCount(wasOrch.filter(r => r.now === 'orchestrator')),
    stillYouWhy: reasonCount(wasYou.filter(r => r.now === 'you')),
    youAllowedStill: wasYou.filter(r => r.now === 'you' && /allowed/.test(r.how || '')).length,
    errors: rows.filter(r => r.now === 'error').length
  };
}

export function reclassifySection(rc) {
  const line = (label, t) => `| ${label} | ${['hub', 'orchestrator', 'you', 'error'].map(k => t[k] || 0).join(' | ')} |`;
  const out = ['### Today\'s rules on the same requests', '',
    `Every logged request run through the hub's current checker at the project's level (${rc.level}). The log does not keep the folder each command ran in, or temp folders made earlier, so a few would fare better in real use.`, '',
    '| Went to | Now: settled by the hub | Now: orchestrator | Now: you | Could not check |', '|---|---|---|---|---|',
    line(`The orchestrator (${rc.orchestratorThen})`, rc.orchestratorNow),
    line(`You (${rc.youThen})`, rc.youNow), ''];
  if (rc.stillOrchestratorWhy.length) {
    out.push('**Why the checker still sends these to the orchestrator** (most common first; one request can have several):', '');
    for (const [w, c] of rc.stillOrchestratorWhy.slice(0, 15)) out.push(`- ${c} × ${w}`);
    out.push('');
  }
  if (rc.stillYouWhy.length) {
    out.push(`**Hard stops that would still come to you** (${rc.youAllowedStill} of them you allowed last time):`, '');
    for (const [w, c] of rc.stillYouWhy.slice(0, 15)) out.push(`- ${c} × ${w}`);
    out.push('');
  }
  return out.join('\n');
}

// ---------- report ----------

const usd = x => x >= 100 ? `$${x.toFixed(0)}` : x >= 1 ? `$${x.toFixed(2)}` : `$${x.toFixed(3)}`;
const pct = (a, b) => b ? `${Math.round((a / b) * 100)}%` : 'n/a';
const n = x => Number.isInteger(x) ? String(x) : x.toFixed(1);
const tok = x => x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${Math.round(x / 1e3)}K` : String(x);

export function projectSection(name, r, { examples = false } = {}) {
  if (!r.span) return `## ${name}\n\nNo events in this period.\n`;
  const q = r.requests, t = r.turns, o = r.escalatedOutcome;
  const lines = [];
  lines.push(`## ${name}`, '');
  lines.push(`${r.span.from.slice(0, 10)} to ${r.span.to.slice(0, 10)} (${n(r.span.days)} day${r.span.days === 1 ? '' : 's'}), ${r.orchestrators} orchestrator${r.orchestrators === 1 ? '' : 's'}.`, '');

  lines.push('### Headline', '');
  lines.push('| Measure | Value |', '|---|---|');
  lines.push(`| Requests sent to the orchestrator | ${q.routed} (${n(q.perDay)} a day) |`);
  lines.push(`| Orchestrator turns spent only on permission requests | ${t.permission} of ${t.total} turns (${pct(t.permission, t.total)}) |`);
  lines.push(`| Estimated cost of those turns | ${usd(t.permCost)} of ${usd(t.orchCost)} orchestrator spend (${pct(t.permCost, t.orchCost)}) |`);
  lines.push(`| Plus turns mixing permissions with other work | ${t.mixed} turn${t.mixed === 1 ? '' : 's'}, ${usd(t.mixedCost)} (upper bound, not all permission work) |`);
  lines.push(`| Context those turns added | ${n(t.permCtx)} points of ${n(t.allCtx)} total rise (${pct(t.permCtx, t.allCtx)}) |`);
  lines.push(`| Orchestrator handoffs in the period | ${t.handoffs}; about ${n(t.handoffs * t.handoffShare)} put down to permission context |`);
  lines.push('');

  lines.push('### Who answered', '');
  lines.push('| | Count |', '|---|---|');
  lines.push(`| Orchestrator allowed | ${q.orchAllow} |`);
  lines.push(`| Orchestrator denied | ${q.orchDeny} |`);
  lines.push(`| Orchestrator escalated to you | ${q.orchEscalate} |`);
  lines.push(`| Timed out and came to you | ${q.timeouts} |`);
  lines.push(`| You answered before the orchestrator did | ${q.youPreempted} |`);
  lines.push(`| Came straight to you (hard stops, routing off) | ${q.toYouDirect} |`);
  lines.push(`| Settled by the hub with no orchestrator (passes, its own requests in Auto) | ${q.hubAnswered} |`);
  if (q.medianWaitSec != null) lines.push(`| Median time from request to orchestrator answer | ${n(q.medianWaitSec)} s |`);
  lines.push('');

  const escTotal = o.allowed + o.alwaysAllowed + o.denied + o.cancelled + o.open;
  if (escTotal) {
    lines.push('### What you did with escalated and timed-out requests', '');
    lines.push(`Allowed ${o.allowed}, always allowed ${o.alwaysAllowed}, denied ${o.denied}, cancelled ${o.cancelled}, still open or lost to a restart ${o.open}.`);
    lines.push(`${o.allowed + o.alwaysAllowed} of ${escTotal} ended in yes. A high share means the board's rules are stricter than you are.`, '');
  }

  lines.push('### Per permission-only turn', '');
  lines.push(`Average cost ${usd(t.avgPermTurnCost)}. ${t.avgCtxPerPermTurn != null ? `Average context added ${n(t.avgCtxPerPermTurn)} points. ` : ''}${t.ctxAtAnswerMedian != null ? `Median orchestrator context when answering: ${n(t.ctxAtAnswerMedian)}%.` : ''}`);
  const tk = t.permTokens;
  lines.push(`Tokens across those turns: ${tok(tk.input)} input, ${tok(tk.cacheRead)} read from cache, ${tok(tk.cacheCreation)} written to cache, ${tok(tk.output)} output.`, '');

  if (r.kinds.length) {
    lines.push('### Kinds of request (most frequent first)', '');
    lines.push(`| Kind | Total | Allowed | Denied | Escalated | Timed out | You |${examples ? ' Example |' : ''}`);
    lines.push(`|---|---|---|---|---|---|---|${examples ? '---|' : ''}`);
    for (const k of r.kinds.slice(0, 20)) lines.push(`| ${k.kind} | ${k.total} | ${k.allow} | ${k.deny} | ${k.escalate} | ${k.timeout} | ${k.you} |${examples ? ` ${k.examples.map(x => '`' + x.replace(/`/g, "'").replace(/\|/g, '/') + '`').join('<br>')} |` : ''}`);
    lines.push('');
  }

  if (r.ruleCandidates.length) {
    lines.push('### Candidates for a rule (no model needed)', '');
    lines.push('Every one of these was allowed by the orchestrator, at least 3 times, never denied or escalated. A rule on the board (or in `permission-rules.mjs`) would settle them without waking it. Check each before adding it: a kind can hide riskier commands.', '');
    for (const k of r.ruleCandidates) lines.push(`- ${k.kind}: ${k.total} requests`);
    lines.push('');
  }
  return lines.join('\n');
}

export function report(sections, { since, generated = new Date().toISOString() } = {}) {
  const totals = sections.filter(s => s.r.span).reduce((a, { r }) => {
    a.routed += r.requests.routed; a.permTurns += r.turns.permission; a.turns += r.turns.total;
    a.permCost += r.turns.permCost; a.orchCost += r.turns.orchCost; a.mixedCost += r.turns.mixedCost; a.candidates += r.ruleCandidates.length;
    return a;
  }, { routed: 0, permTurns: 0, turns: 0, permCost: 0, orchCost: 0, mixedCost: 0, candidates: 0 });
  const verdict = totals.orchCost === 0 ? 'No orchestrator spend in this period.'
    : totals.permCost / totals.orchCost < 0.05 ? 'Permission answers are under 5% of orchestrator spend: a decision model is not worth building yet. Rule candidates below may still save some turns.'
    : totals.permCost / totals.orchCost < 0.15 ? 'Permission answers are a noticeable share of orchestrator spend. Start with the rule candidates; then a decision step in shadow mode is worth trying.'
    : 'Permission answers are a large share of orchestrator spend. Rule candidates first, then a decision step in shadow mode, are both worth doing.';
  const out = [
    '# Permission study', '',
    `Generated ${generated.slice(0, 16).replace('T', ' ')} UTC${since ? `, events since ${since}` : ''}. Read-only: from each project's .crux/events.jsonl. Costs are the hub's own estimates from list prices, not a bill.`, '',
    '## All projects', '',
    '| Measure | Value |', '|---|---|',
    `| Requests sent to orchestrators | ${totals.routed} |`,
    `| Orchestrator turns spent only on permissions | ${totals.permTurns} of ${totals.turns} (${pct(totals.permTurns, totals.turns)}) |`,
    `| Their estimated cost | ${usd(totals.permCost)} of ${usd(totals.orchCost)} orchestrator spend (${pct(totals.permCost, totals.orchCost)}) |`,
    `| Mixed turns (upper bound) | ${usd(totals.mixedCost)} |`,
    `| Request kinds that look ready for a rule | ${totals.candidates} |`, '',
    `**Reading:** ${verdict}`, '',
    '**How to read the numbers.** "Permission-only" turns are orchestrator turns where nothing but permission requests could have woken it, so their cost and context are fair to put down to permissions. "Mixed" turns also had a message, summary or pick, so their cost is shown only as an upper bound. Handoffs put down to permissions are an estimate: that share of the context rise, times the handoffs seen.', '',
    ...sections.map(s => s.text)
  ];
  return out.join('\n');
}

// ---------- the permission check in shadow mode (decision 66, plan B7 step 3) ----------
// Each `check_shadow` line is what the one-shot check said about a request the orchestrator was also sent. This puts
// it beside the real answer (the `permission_answer` for the same approval from the orchestrator, you, or the hub's
// timeout). "Consult" is not a disagreement: it means the check would have handed the request to the orchestrator.
// Every disagreement is listed in full, with the whole command, so you can read them all; the allows both sides gave
// are a count here (the weekly list of 10 is in the orchestrator thread). Read-only, like the rest of this tool.
const WORD = { allow: 'allow', deny: 'deny', escalate: 'escalate', timeout: 'escalate' };   // a timeout came to you, as an escalation does
export function compareShadow(events, { sinceMs = -Infinity } = {}) {
  const evs = events.filter(e => !(Date.parse(e.ts) < sinceMs));
  const real = new Map(), results = new Map();
  for (const e of evs) {
    if (e.type === 'permission_answer' && e.approval && e.by !== 'permission check' && !real.has(e.approval)) real.set(e.approval, e);
    if (e.type === 'approval_result' && e.approval) results.set(e.approval, e.how);
  }
  const out = { total: 0, invalid: 0, consult: 0, pending: 0, modelAllowed: 0, downgraded: 0, agree: { allow: 0, deny: 0, escalate: 0 }, disagree: [], usage: { calls: 0, cost: 0, list: 0, cacheRead: 0, input: 0 } };
  for (const e of evs) {
    if (e.type === 'usage' && e.shadow && e.agent === 'permission check') {
      const m = Object.values(e.models || {})[0] || {};
      out.usage.calls++; out.usage.cost += Number(e.costUSD) || 0; out.usage.list += Number(e.listUSD) || 0; out.usage.cacheRead += m.cacheRead || 0; out.usage.input += (m.input || 0) + (m.cacheCreation || 0);
    }
    if (e.type !== 'check_shadow') continue;
    out.total++;
    if (!e.valid) { out.invalid++; continue; }
    // What the model itself said, before the hub's own rule (an allow on a script not fully seen becomes a consult).
    // Lines from before this was logged have only `answer`.
    if ((e.rawAnswer || e.answer) === 'allow') out.modelAllowed++;
    if (e.downgraded) out.downgraded++;
    const r = real.get(e.approval);
    const row = (check, modelSaid) => ({ ts: e.ts, approval: e.approval, worker: e.worker, tool: e.tool, command: e.command, check, modelSaid, checkReason: e.reason, downgraded: !!e.downgraded,
      real: r.answer, realBy: r.by, realReason: r.reason, outcome: results.get(e.approval) || null, allowedByCheckOnly: modelSaid === 'allow' });
    if (e.answer === 'consult') {
      out.consult++;
      // The model said allow and the hub's rule held it back: if the real answer was not an allow, that is the
      // dangerous direction too, so it is listed (it counts as a consult above, and here as a disagreement).
      if (e.downgraded && r && (WORD[r.answer] || r.answer) !== 'allow') out.disagree.push(row('consult', 'allow'));
      continue;
    }
    if (!r) { out.pending++; continue; }
    const theirs = WORD[r.answer] || r.answer;
    if (theirs === e.answer) { out.agree[e.answer]++; continue; }
    out.disagree.push(row(e.answer, e.rawAnswer || e.answer));
  }
  return out;
}

// ---------- what the M051 fixes would change, replayed offline ----------
// No model is asked: each logged shadow line keeps what the model said then (rawAnswer), and the hub's own rules are re-applied
// to the logged command text. It cannot see the files (the workers' worktrees are gone), so it takes the stated shape of each fix:
//   1. a `node --test` run of test files (and nothing else that is unread) is no longer held back: the model's allow stands;
//   2. a hard stop that came only from the hub's rule modules (imported) is gone: the line falls back to what the model said;
//   3. a command that names another hub project's folder is a consult (never an allow; the orchestrator decides).
// The model's own consults stay consults (they may fall once it is sent whole test files; that needs a live replay).
export function replayShadow(events, { parseCommand, otherDirs = [], sinceMs = -Infinity } = {}) {
  const roots = otherDirs.map(d => String(d).toLowerCase().replace(/[\\/]+/g, '/').replace(/\/+$/, '')).filter(Boolean);
  const names = text => { const t = String(text).toLowerCase().replace(/[\\/]+/g, '/').replace(/(^|[^a-z0-9])\/([a-z])\//g, '$1$2:/'); return roots.some(r => { for (let i = t.indexOf(r); i >= 0; i = t.indexOf(r, i + 1)) if (!/[a-z0-9]/.test(t[i - 1] || '') && !/[\w.-]/.test(t[i + r.length] || '')) return true; return false; }); };
  // Would today's reader hold this command back? Only a command whose text was logged in full can be judged (the log keeps 400
  // characters; a longer one is cut mid-word and reads as "a quote that is never closed", so it stays held back here).
  const seen = (cmd, tool) => {
    try {
      if (String(cmd).length >= 399) return false;
      const p = parseCommand(cmd, { shell: /PowerShell/i.test(tool) ? 'powershell' : 'bash' });
      return !p.unread.length && !p.inline.length && !p.runners.length && p.files.every(f => /\.test\.(m|c)?js$/i.test(f.path));
    } catch { return false; }
  };
  const testRun = seen;
  const out = { total: 0, before: { consult: 0, allow: 0, escalate: 0, deny: 0 }, after: { consult: 0, allow: 0, escalate: 0, deny: 0 }, testRuns: 0, ruleModuleStops: 0, otherProject: 0 };
  for (const e of events) {
    if (e.type !== 'check_shadow' || !e.valid || Date.parse(e.ts) < sinceMs) continue;
    out.total++;
    out.before[e.answer]++;
    const raw = e.rawAnswer || e.answer;
    let now = e.answer;
    if (e.scanStops?.length && e.scanStops.every(s => /^permission-(rules|lists|scripts|check)\.mjs \(imported\)/.test(s))) {
      out.ruleModuleStops++;
      now = raw === 'allow' && e.unread && !testRun(e.command, e.tool) ? 'consult' : raw;
    } else if (e.downgraded && raw === 'allow' && testRun(e.command, e.tool)) { out.testRuns++; now = 'allow'; }
    if (names(e.command) && !(e.scanStops?.length)) { if (now !== 'consult') out.otherProject++; now = 'consult'; }
    out.after[now]++;
  }
  return out;
}

export function checkSection(name, events, { sinceMs = -Infinity, replay = null } = {}) {
  const c = compareShadow(events, { sinceMs });
  const lines = [`## ${name}: the permission check in shadow mode`, ''];
  if (!c.total) return lines.concat('No `check_shadow` lines yet. Put the project in shadow mode on its settings card (Permission check: Shadow) and run this again after a few days.', '').join('\n');
  const agreed = c.agree.allow + c.agree.deny + c.agree.escalate;
  const judged = agreed + c.disagree.length;
  const dangerous = c.disagree.filter(d => d.allowedByCheckOnly);
  lines.push('| | Count |', '|---|---|');
  lines.push(`| Requests the check read | ${c.total} |`);
  lines.push(`| Said the same as the real answer | ${agreed} of ${judged} (${pct(agreed, judged)}): ${c.agree.allow} allow, ${c.agree.deny} deny, ${c.agree.escalate} escalate |`);
  lines.push(`| Disagreed with the real answer | ${c.disagree.length}, of which **${dangerous.length} where the check would have allowed and the real answer did not** |`);
  lines.push(`| The model itself said allow (before the rule that holds back unread scripts) | ${c.modelAllowed}; the rule turned ${c.downgraded} of them into consult |`);
  lines.push(`| Said consult (the orchestrator would decide) | ${c.consult} (${pct(c.consult, c.total)}; the bar is 10% or less) |`);
  lines.push(`| No valid answer (bad reply, timeout, error) | ${c.invalid} |`);
  lines.push(`| Real answer not in yet | ${c.pending} |`);
  if (c.usage.calls) lines.push(`| Cost of the check's calls | ${usd(c.usage.list)} at list price over ${c.usage.calls} calls (${usd(c.usage.list / c.usage.calls)} each); ${pct(c.usage.cacheRead, c.usage.cacheRead + c.usage.input)} of input read from cache |`);
  lines.push('', 'Agreement is not evidence of safety on its own (a check that always allows agrees with an orchestrator that allows 97%). Read every disagreement below, and the weekly list of allows both sides gave.', '');
  if (replay) {
    const r = replayShadow(events, { ...replay, sinceMs });
    const share = x => `${x.consult} (${pct(x.consult, r.total)})`;
    lines.push('### What the three fixes would change (offline replay, no model asked)', '',
      'The model\'s logged answers are kept as they were; only the hub\'s own rules are re-applied to the logged command text. A floor, not a forecast: the model\'s own consults may fall once it is sent whole test files, which only a live replay can show.', '',
      '| | Before | After the fixes |', '|---|---|---|',
      `| Consult | ${share(r.before)} | ${share(r.after)} |`,
      `| Allow | ${r.before.allow} | ${r.after.allow} |`,
      `| Escalate | ${r.before.escalate} | ${r.after.escalate} |`,
      `| Deny | ${r.before.deny} | ${r.after.deny} |`, '',
      `- Held-back lines now read as seen (test files only, or no script at all) so the model's allow stands: ${r.testRuns}`,
      `- Escalations caused only by the hub's own rule modules, now back to what the model said: ${r.ruleModuleStops}`,
      `- Commands naming another hub project's folder, now a consult (the orchestrator decides): ${r.otherProject}`, '');
  }
  if (c.disagree.length) {
    lines.push('### Every disagreement, in full', '');
    for (const d of c.disagree.sort((a, b) => Number(b.allowedByCheckOnly) - Number(a.allowedByCheckOnly) || String(a.ts).localeCompare(b.ts))) {
      lines.push(`#### ${d.allowedByCheckOnly ? 'CHECK WOULD HAVE ALLOWED' : 'Check was stricter'}: ${d.worker} · ${d.tool} · ${String(d.ts).slice(0, 16).replace('T', ' ')} UTC`, '');
      lines.push('```', String(d.command), '```', '');
      lines.push(`- Check said **${d.check}**${d.downgraded ? ' (the model said allow; turned into consult because a script was not fully seen)' : ''}: ${d.checkReason}`);
      lines.push(`- Real answer **${d.real}** by ${d.realBy}: ${d.realReason}${d.outcome ? ` (card ended: ${d.outcome})` : ''}`);
      lines.push(`- Request ${d.approval}`, '');
    }
  }
  return lines.join('\n');
}

// ---------- command line ----------

export function parseArgs(argv) {
  const opts = { dirs: [], days: null, out: null, examples: false, reclassify: false, check: false, level: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') opts.days = Number(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--examples') opts.examples = true;
    else if (a === '--home') opts.home = argv[++i];
    else if (a === '--reclassify') opts.reclassify = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--level') opts.level = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts.dirs.push(a);
  }
  return opts;
}

export async function main(argv = process.argv.slice(2), log = console.log, deps = {}) {
  const opts = parseArgs(argv);
  if (opts.help) { log('node tools/permission-study.mjs [project folders...] [--days 30] [--out report.md] [--examples] [--reclassify] [--check] [--level auto]'); return 0; }
  let dirs = opts.dirs.length ? opts.dirs : projectsFromHubJson();
  if (!dirs.length) dirs = [process.cwd()];
  const sinceMs = opts.days ? Date.now() - opts.days * 86_400_000 : -Infinity;
  const sections = [];
  for (const d of dirs) {
    const dir = resolve(d);
    const events = readEvents(dir);
    if (!events) { log(`Skipped ${dir}: no .crux/events.jsonl`); continue; }
    const r = analyze(events, { sinceMs, projectDir: dir, ...(opts.home ? { home: opts.home } : {}) });
    let text = projectSection(basename(dir), r, { examples: opts.examples });
    if (opts.reclassify) {
      const { classify } = deps.classify ? deps : await import('../lib/permission-rules.mjs');
      const { CommandPolicy } = deps.CommandPolicy ? deps : await import('../lib/permissions.mjs');
      const rc = reclassify(events, { classify, readOnly: (t, c) => CommandPolicy.readOnly(t, c), projectDir: dir, level: opts.level || levelOf(events, dir), sinceMs });
      text += '\n' + reclassifySection(rc);
      r.reclassified = rc;
      log(`Re-checked ${rc.total} requests with today's rules (${rc.level})`);
    }
    if (opts.check) {
      const { parseCommand } = deps.parseCommand ? deps : await import('../lib/permission-scripts.mjs');
      text += '\n' + checkSection(basename(dir), events, { sinceMs, replay: { parseCommand, otherDirs: dirs.map(x => resolve(x)).filter(x => x !== dir) } });
      const c = compareShadow(events, { sinceMs });
      log(`Permission check (shadow): ${c.total} read, ${c.disagree.length} disagreements, ${c.consult} consults`);
    }
    sections.push({ name: basename(dir), r, text });
    log(`Read ${basename(dir)}: ${events.length} events, ${r.requests.routed} requests to the orchestrator`);
  }
  if (!sections.length) { log('No project logs found. Give project folders, or run it from a project folder.'); return 1; }
  const md = report(sections, { since: opts.days ? new Date(sinceMs).toISOString().slice(0, 10) : null });
  const out = resolve(opts.out || `permission-study-${new Date().toISOString().slice(0, 10)}.md`);
  writeFileSync(out, md);
  log(`Wrote ${out}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(code => { process.exitCode = code; });
