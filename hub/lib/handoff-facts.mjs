// The facts half of a handoff (decision 16), worked out from the event log, the board and git: plain functions so
// tests can feed them events and a fake command runner. Hub.handoffFacts puts them together.
import { execFileSync } from 'node:child_process';
import { answeredByPicks } from '../public/questions.js';

export const APPROVAL_MAX = 400, APPROVALS_KEPT = 30, INSTRUCTION_MAX = 300, INDEX_LINES_MAX = 150;

const flat = s => String(s ?? '').replace(/\s+/g, ' ').trim();
export const clip = (s, max) => { const t = flat(s); return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t; };
const time = ts => { const d = new Date(ts); return Number.isNaN(+d) ? '' : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`; };

// ---------- 1. Matt's approvals and standing instructions ----------
// Words that approve, decide or instruct. Errs on including: only a plain question with none of them is left out.
const INSTRUCTS = /\b(ok|okay|yes|yep|yeah|no|go|approved?|merge|push|pr|keep|retire|hand ?off|don'?t|do not|never|always|please|settings?|switch|turn|set|use|fine|sure|stop|start|pick|instead|should|must|want|let'?s|only|from now on|later|park|drop|ship)\b/i;
export function looksLikeInstruction(text) {
  const t = flat(text);
  if (!t) return false;
  if (/^(all|all but\b.*|[a-e]|(\d+[a-e]\s*)+)$/i.test(t)) return true;   // a pick typed in chat
  return !t.endsWith('?') || INSTRUCTS.test(t);
}

// Messages from you since `since` (ms): every Needs-you answer, and every message that looks like an instruction.
// threads: which threads count (null = all). mention: also messages in the orchestrator thread that name this word.
// tagged: lines the orchestrator noted itself (post_summary approvals). The newest APPROVALS_KEPT are kept.
export function approvals(events, { since = 0, threads = null, mention = null, tagged = [] } = {}) {
  const named = mention ? new RegExp(`\\b${mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null;
  const out = [];
  for (const e of events) {
    if (e.type !== 'message' || e.from !== 'you' || Date.parse(e.ts) < since) continue;
    const inScope = !threads || threads.includes(e.thread) || (named && e.thread === 'orchestrator' && named.test(e.text || ''));
    if (!inScope) continue;
    const answer = Array.isArray(e.answers) && e.answers.length > 0;
    if (!answer && !looksLikeInstruction(e.text)) continue;
    out.push({ ts: e.ts, thread: e.thread, text: clip(e.text, APPROVAL_MAX), answer });
  }
  for (const t of tagged) out.push({ ts: t.ts, thread: 'orchestrator', text: clip(t.text, APPROVAL_MAX), noted: t.by });
  out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return { kept: out.slice(-APPROVALS_KEPT), dropped: Math.max(0, out.length - APPROVALS_KEPT) };
}

// ---------- 2. git: open PRs, worktrees, the main folder ----------
// run(cmd, args, cwd) -> stdout; throws on failure. The real one has a timeout, so a hung network call cannot hold
// a handoff up for long.
export function realRun(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
const GH = ['gh', 'C:/Program Files/GitHub CLI/gh.exe'];

export function gitState(dir, run = realRun) {
  const state = { worktrees: [], prs: null, main: null, errors: [] };
  let list;
  try { list = run('git', ['worktree', 'list', '--porcelain'], dir); }
  catch (e) { state.errors.push(`not a git folder or git failed (${firstLine(e)})`); return state; }
  for (const block of list.split(/\r?\n\r?\n/).filter(b => b.trim())) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]?.trim();
    if (!path) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim() || (/^detached$/m.test(block) ? '(detached)' : '(none)');
    let dirty = null;
    try { dirty = run('git', ['status', '--porcelain'], path).split(/\r?\n/).filter(Boolean).length; } catch { }
    state.worktrees.push({ path, branch, dirty, main: samePath(path, dir) });
  }
  // The main folder: its branch, clean or not, and whether it matches GitHub's main (read with ls-remote, which
  // changes nothing locally).
  const main = state.worktrees.find(w => w.main) || { path: dir, branch: '(unknown)', dirty: null };
  state.main = { branch: main.branch, dirty: main.dirty, upToDate: null, note: '' };
  try {
    const head = run('git', ['rev-parse', 'HEAD'], dir).trim();
    const remote = run('git', ['ls-remote', 'origin', 'refs/heads/main'], dir).trim().split(/\s+/)[0] || '';
    state.main.upToDate = !!remote && head === remote;
    if (!state.main.upToDate) {
      const behind = /\[(?:ahead \d+, )?behind (\d+)\]/.exec(run('git', ['status', '--porcelain', '--branch'], dir).split(/\r?\n/)[0] || '')?.[1];
      state.main.note = behind ? `behind origin/main by ${behind} as of the last fetch` : 'not at origin/main';
    }
  } catch (e) { state.errors.push(`could not compare with origin/main (${firstLine(e)})`); }
  let failed = false;
  for (const gh of GH) {
    try {
      const out = run(gh, ['pr', 'list', '--state', 'open', '--limit', '30', '--json', 'number,title,headRefName,isDraft'], dir);
      state.prs = JSON.parse(out || '[]').map(x => ({ number: x.number, title: x.title, branch: x.headRefName, draft: !!x.isDraft }));
      break;
    } catch (e) {
      if (e.code === 'ENOENT') continue;   // not on PATH: try the usual install folder
      state.errors.push(`could not list open PRs (${firstLine(e)})`); failed = true; break;
    }
  }
  if (!state.prs && !failed) state.errors.push('GitHub CLI not found, so open PRs are unknown');
  return state;
}
const firstLine = e => clip(String(e?.stderr || e?.message || e).split(/\r?\n/).find(Boolean) || 'error', 120);
const samePath = (a, b) => String(a).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === String(b).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// Does a text name this PR (#31, PR 31, pull request 31) or its branch?
export function namesPR(text, pr) {
  const s = String(text || '');
  const n = pr.number;
  if (new RegExp(`(#|\\bPR\\s*#?|\\bpull request\\s*#?)${n}\\b`, 'i').test(s)) return true;
  return !!pr.branch && s.includes(pr.branch);
}

// Merge-ready per the newest worker summary that names the PR.
export function prReadiness(pr, summaries) {
  const s = [...summaries].reverse().find(x => namesPR(summaryText(x), pr));
  if (!s) return 'no worker summary names it';
  const text = summaryText(s);
  if (s.blocked_on?.length || /\bnot (yet )?ready\b|\bwip\b|\bdraft\b/i.test(text)) return `not ready per ${s.from}'s last summary naming it`;
  if (s.questions?.length) return `waiting on questions in ${s.from}'s last summary naming it`;
  return /\bready\b|\bopened\b|\bfor review\b|\bclick-?test|\bmergeable\b/i.test(text) ? `ready per ${s.from}'s last summary` : `named in ${s.from}'s last summary, readiness unclear`;
}
const summaryText = s => [...(s.done || []), ...(s.changed || []), s.next_step || '', ...(s.questions || []), ...(s.blocked_on || [])].join('\n');

// Approved by you: a message of yours, or an approval the orchestrator noted, that names the PR with an approving word.
const APPROVES = /\b(merge|ok|okay|go ahead|approved?|yes|ship it|lgtm)\b/i, HOLDS = /\b(don'?t|do not|not yet|hold|wait|no)\b/i;
export function prApproved(pr, events, tagged = []) {
  const said = events.filter(e => e.type === 'message' && e.from === 'you').map(e => e.text).concat(tagged.map(t => t.text));
  return said.some(t => namesPR(t, pr) && APPROVES.test(t) && !HOLDS.test(t));
}

export function gitLines(g, { summaries = [], events = [], tagged = [] } = {}) {
  const lines = ['Git:'];
  if (g.main) {
    const clean = g.main.dirty == null ? 'clean state unknown' : g.main.dirty ? `NOT clean (${g.main.dirty} changed files)` : 'clean';
    const up = g.main.upToDate == null ? 'up to date unknown' : g.main.upToDate ? 'up to date with GitHub' : g.main.note;
    lines.push(`- Main folder: on ${g.main.branch}, ${clean}, ${up}`);
  }
  if (g.prs) lines.push(`- Open PRs:${g.prs.length ? '' : ' none'}`, ...g.prs.map(pr => `  - #${pr.number} ${clip(pr.title, 90)} (${pr.branch}${pr.draft ? ', draft' : ''}): ${prReadiness(pr, summaries)}; approved by {{who}}: ${prApproved(pr, events, tagged) ? 'yes' : 'no'}`));
  const wts = g.worktrees.filter(w => !w.main);
  lines.push(`- Worktrees:${wts.length ? '' : ' none'}`, ...wts.map(w => `  - ${w.path} on ${w.branch}, ${w.dirty == null ? 'state unknown' : w.dirty ? `dirty (${w.dirty})` : 'clean'}`));
  for (const e of g.errors) lines.push(`- (${e})`);
  return lines;
}

// ---------- 4. questions still waiting ----------
// The newest orchestrator summary that asked something: its questions not answered from Needs you, dismissed, or
// settled by picks. Plus the open_questions the newest summary that carried them listed (quick calls put in chat).
export function unansweredQuestions(events, { thread = 'orchestrator', decisionStatus = () => undefined } = {}) {
  const sums = events.filter(e => e.type === 'summary' && e.thread === thread);
  const last = sums.filter(e => e.questions?.length).at(-1);
  const out = [];
  if (last) {
    const gone = new Set(), after = events.slice(events.indexOf(last) + 1);
    let dismissedAll = false, typedAfter = false;
    for (const e of after) {
      if (e.type === 'question_dismissed' && e.question === last.id) e.index == null ? (dismissedAll = true) : gone.add(Number(e.index));
      if (e.type === 'message' && e.from === 'you' && e.thread === thread) {
        if (Array.isArray(e.answers)) for (const a of e.answers) if (a.question === last.id) gone.add(Number(a.index));
        if (!e.answers?.length) typedAfter = true;
      }
    }
    if (!dismissedAll) last.questions.forEach((q, i) => {
      if (gone.has(i) || answeredByPicks(q, decisionStatus)) return;
      out.push(`${clip(q, 300)} (asked ${time(last.ts)} by ${last.from}${typedAfter ? '; {{who}} wrote in the thread after it, so check those messages above' : ''})`);
    });
  }
  const tagged = sums.filter(e => Array.isArray(e.open_questions)).at(-1);
  for (const q of tagged?.open_questions || []) if (flat(q) && !/^none$/i.test(flat(q))) out.push(`${clip(q, 300)} (put in chat; listed open by ${tagged.from} at ${time(tagged.ts)})`);
  return out;
}

// ---------- 9. board tidy-ups ----------
// Active memos that later text calls done, merged, built, retired or superseded: one sentence naming the memo and
// one of those words, in a later entry, handoff or round summary. Suggestions only; retiring needs your OK. Memos
// already marked done (or superseded, or retired) are not active, so they are never suggested again.
const DONE =/\b(done|built|merged|superseded|supersedes|replaced?|replaces|retired?|finished|complete[d]?|obsolete|no longer needed|can be retired)\b/i;
export function tidyUps(board, events) {
  const memos = board.entries().filter(e => e.kind === 'memo' && e.status === 'active');
  if (!memos.length) return [];
  // Later means later in the log (timestamps can tie).
  const texts = [], at = new Map();
  events.forEach((e, i) => {
    if (e.type === 'entry') { at.set(e.entryId, i); texts.push({ i, id: e.entryId, from: e.entryId, text: [e.title, e.summary, e.body].join('\n') }); }
    else if (e.type === 'summary') texts.push({ i, from: `${e.from}'s summary`, text: [...(e.done || []), e.next_step || '', ...Object.values(e.handoff_notes || {}).flat()].join('\n') });
  });
  const out = [];
  for (const m of memos) {
    const id = new RegExp(`\\b${m.entryId}\\b`, 'i');
    for (const t of texts) {
      if (t.id === m.entryId || t.i <= (at.get(m.entryId) ?? -1)) continue;
      const hit = String(t.text).split(/(?<=[.!?])\s+|\n/).find(s => id.test(s) && DONE.test(s));
      if (hit) { out.push({ id: m.entryId, title: m.title, why: `${t.from}: "${clip(hit, 160)}"` }); break; }
    }
  }
  return out;
}
