// Decision 64 A, part 3: your yes on a card asking "Merge PR #74?" lets exactly that merge through without a second
// card. Strict on purpose (review of 0.21.1): a wrong merge is far worse than one more card, so anything unclear gives
// no pass and the merge card comes as before.
//
// - Granted only by your own answer on that question's card (Needs you, a thread copy or the Conductor's chat copy),
//   which the page marks own: true. Never a reply typed into the thread, the Conductor's suggestion, or an agent.
// - The question asks to merge exactly one PR, written #N, PR N or PR #N, names no other number with # or PR, and has
//   no condition in it (once, after, when, if, until, before, wait).
// - The answer is a plain yes and nothing more (yes, ok, sure, go ahead, do it, merge it, approved; please or thanks).
// - It allows `gh pr merge N` (a bare number), with --merge or --squash after it or neither, optionally after
//   `cd <the project's main folder, or the asker's own worktree> &&` whose git remote is the project's own.
// - Only the agent that asked, once, within 30 minutes. You dismissing that card, or a no, wait or stop from you on it
//   or in that thread afterwards, cancels it.
// The hub logs a merge_pass event when you answer; hub.mjs requestApproval asks findPass before anything else. The
// permission checker (permission-rules.mjs) is not touched.
import { resolve, basename, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

export const PASS_MS = 30 * 60 * 1000;
// Part 4: no restart notice from that project's orchestrator within this long of a merge you approved.
export const RESTART_QUIET_MS = 10 * 60 * 1000;

const flat = s => String(s || '').replace(/\s+/g, ' ').trim();
const CONDITION = /\b(once|after|when|whenever|if|unless|until|before|wait)\b/i;
// Every PR a text names: #N, PR N, PR #N, PRs N, pull request N.
const REFS = /#(\d+)\b|\bPRs?[ \t]*#?(\d+)\b|\bpull[ \t]+requests?[ \t]*#?(\d+)\b/gi;

// Words that turn it into another ask: close or skip it instead, merge something into it, or a choice.
const OTHER_ASK = /\b(skip|skipping|close|closing|instead|rather|abandon|revert|into)\b|\bor should\b|\bor not\b/i;
// The asking sentence opens as a merge ask: "Merge #N", "Merge PR N", "May/Can/Shall/Should I (open and) merge (PR) #N".
const OPENS = /^(?:(?:may|can|shall|should)[ \t]+I[ \t]+(?:open[ \t]+(?:it[ \t]+|the[ \t]+PR[ \t]+)?and[ \t]+)?)?merge[ \t]+(?:PR[ \t]*)?#?\d+\b/i;

// A question asking to merge exactly one PR of this project: returns { number } or null. Its asking sentence (the
// last one ending in "?") opens as a merge ask, and nothing in it asks something else.
export function mergeQuestion(text) {
  const s = flat(text);
  if (!s.includes('?') || !/\bmerg(e|es|ing)\b/i.test(s) || CONDITION.test(s) || OTHER_ASK.test(s)) return null;
  const asking = s.split(/(?<=[.!?])\s+/).filter(x => x.endsWith('?')).at(-1) || '';
  if (!OPENS.test(asking)) return null;
  if (/[\w.-]+\/[\w.-]+#\d+|github\.com\//i.test(s)) return null;   // another repo, or a link
  if (/\bPRs\b|\bpull requests\b/i.test(s)) return null;           // several
  const nums = [...s.matchAll(REFS)].map(m => Number(m[1] || m[2] || m[3]));
  if (!nums.length || new Set(nums).size !== 1) return null;
  // Written as #N, PR N or PR #N (pull request N counts as naming one, but not as the way it is asked).
  if (!/#\d+\b|\bPR[ \t]*#?\d+\b/i.test(s)) return null;
  return { number: nums[0] };
}

// A plain yes and nothing more.
export function isYes(answer) {
  return /^(yes|yep|ok|okay|sure|go|go ahead|do it|merge it|approved)([ ,]+(please|thanks|thank you))?[ .!]*$/i.test(flat(answer));
}
// A no, wait or stop from you: cancels a pass on that card.
const REVOKE = /\b(no|nope|not|wait|stop|hold|don'?t|cancel)\b/i;

// The pass a yes on question `question` gives, or null.
export function passFor(question, answer) {
  const q = mergeQuestion(question);
  return q && isYes(answer) ? q : null;
}

const norm = s => resolve(String(s).replace(/\\/g, '/').replace(/^\/([a-z])\//i, '$1:/')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const absolute = p => /^[a-z]:[\\/]/i.test(p) || /^\/[a-z]\//i.test(p) || p.startsWith('/');

// The command a pass may allow: { number, cd } (cd: the folder it moves into first, or null), or null.
export function mergeCommand(tool, command) {
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  let c = String(command || '').trim(), cd = null;
  // The folder: single-quoted, double-quoted or bare, never with $, a backtick or brackets (no expansion can ride in).
  const m = /^cd[ \t]+(?:"([^"$`()\n]+)"|'([^'\n]+)'|([\w.:/\\~-]+))[ \t]*&&[ \t]*([^\n]*)$/.exec(c);
  if (m) {
    if (tool !== 'Bash') return null;
    cd = m[1] || m[2] || m[3];
    if (!absolute(cd)) return null;
    c = m[4].trim();
  }
  const g = /^gh[ \t]+pr[ \t]+merge[ \t]+(\d{1,6})(?:[ \t]+(?:--merge|--squash))?$/.exec(c);
  return g ? { number: Number(g[1]), cd } : null;
}

// The repo's GitHub remote, for the folder check (tests pass their own).
export function originOf(dir) {
  try { return execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/\.git$/, '').toLowerCase(); }
  catch { return null; }
}

// May the merge run in folder cd? The project's main folder, or the asker's own worktree (.claude/worktrees/<asker>),
// with the same origin remote as the project.
function folderOk(cd, dir, asker, origin) {
  if (!cd) return true;
  const a = norm(cd), main = norm(dir);
  const own = a === main || (dirname(a) === `${main}/.claude/worktrees` && basename(a) === String(asker || '').toLowerCase());
  if (!own) return false;
  const want = origin(dir);
  return !!want && origin(cd) === want;
}

// The pass that lets this request through now, or null: { pass, card, asker, number }.
// events: the project's log; agent: the requesting agent's name.
export function findPass(events, tool, input, { dir, agent, now = Date.now(), origin = originOf } = {}) {
  const cmd = mergeCommand(tool, input?.command);
  if (!cmd) return null;
  const evs = events || [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.type !== 'merge_pass') continue;
    const age = now - Date.parse(e.ts);
    if (age > PASS_MS) break;   // the log runs oldest first
    if (age < 0 || e.asker !== agent || Number(e.number) !== cmd.number) continue;
    const later = evs.slice(i + 1);
    if (later.some(x => x.type === 'permission_answer' && x.pass === e.pass)) continue;   // used
    if (revoked(e, later)) continue;
    if (!folderOk(cmd.cd, dir, e.asker, origin)) return null;
    return { pass: e.pass, card: e.card, asker: e.asker, number: cmd.number };
  }
  return null;
}

// You dismissed that card (or that question), or said no, wait or stop on it or in that thread afterwards.
function revoked(pass, later) {
  const id = String(pass.card).slice('question:'.length);
  return later.some(x => (x.type === 'question_dismissed' && x.question === id && (x.index == null || Number(x.index) === Number(pass.index)))
    || (x.type === 'message' && x.from === 'you' && x.thread === pass.thread && REVOKE.test(String(x.text || ''))));
}

// Part 4: was a merge you approved let through in this project in the last 10 minutes? By a pass, or by your own Allow
// on a merge card.
export function recentApprovedMerge(events, now = Date.now(), ms = RESTART_QUIET_MS) {
  const evs = events || [];
  const fresh = e => { const age = now - Date.parse(e.ts); return age >= 0 && age <= ms; };
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.type === 'permission_answer' && e.pass && e.answer === 'allow' && fresh(e)) return true;
    if (e.type === 'approval_result' && (e.how === 'allowed' || e.how === 'always allowed') && fresh(e)) {
      const req = evs.find(x => x.type === 'approval' && x.approval === e.approval);
      if (/^\s*(?:cd\b[^\n]*?&&\s*)?gh\s+pr\s+merge\b/.test(String(req?.input?.command || ''))) return true;
    }
  }
  return false;
}
