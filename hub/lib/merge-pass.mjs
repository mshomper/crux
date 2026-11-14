// Decision 64 A, part 3: your yes on a question like "May I open the PR, merge it and restart?" or "Merge #74?" lets
// exactly that merge through without a second card. The hub logs a merge_pass event when you answer (never on an
// agent's or the Conductor's words), and the permission request path (hub.mjs requestApproval) asks findPass before
// anything else. The permission checker (permission-rules.mjs) is not touched: this is a hook in front of it.
//
// What a pass allows: `gh pr merge N`, with --merge or --squash or neither, optionally after `cd <a folder inside the
// project> &&`. Nothing else: never --admin, --auto, --delete-branch, --repo, a body or subject, a second command, or a
// merge in another repo. In that project only, for 30 minutes after your answer. A question that names PR numbers
// allows those; one that names none ("open the PR and merge it") allows the first PR merged under it, and then that one.
import { resolve } from 'node:path';

export const PASS_MS = 30 * 60 * 1000;
// Part 4: no restart notice within this long of a merge you approved.
export const RESTART_QUIET_MS = 10 * 60 * 1000;

const flat = s => String(s || '').replace(/\s+/g, ' ').trim();

// A question asking to merge a pull request in this project: it asks (a "?"), names merging and a pull request (by
// number or as "the PR"). One that points at another repo (owner/repo#12, a pull request link) is never a pass: the
// hub cannot be sure the merge stays in this project. Returns { numbers } (empty when it names none), or null.
export function mergeQuestion(text) {
  const s = flat(text);
  if (!s.includes('?') || !/\bmerg(e|es|ing)\b/i.test(s) || !/\b(PRs?|pull requests?)\b|#\d+/i.test(s)) return null;
  if (/[\w.-]+\/[\w.-]+#\d+|github\.com\/[\w.-]+\/[\w.-]+\/pull/i.test(s)) return null;
  const numbers = [...s.matchAll(/(?:#|\bPR\s*#?|\bpull request\s*#?)(\d{1,6})\b/gi)].map(m => Number(m[1]));
  return { numbers: [...new Set(numbers)] };
}

// A plain yes: it opens with yes (or go ahead, ok, sure, do it, merge it...) and adds no condition. Anything with a
// no, a wait or a "but" in it is not a yes here; the merge card then comes as before.
export function isYes(answer) {
  const a = flat(answer).toLowerCase();
  if (!a || a.length > 160) return false;
  if (/\b(no|not|nope|don'?t|dont|do not|never|wait|hold|stop|but|unless|until|later|instead|cancel|if|once|when|after|first)\b|n't\b/.test(a)) return false;
  return /^(yes|yep|yeah|yup|y|ok|okay|sure|go ahead|go for it|go|do it|approved?|lgtm|please do|merge it|merge|fine|alright|all right|absolutely|definitely)\b/.test(a);
}

// The pass a yes gives, or null: { numbers } from the question.
export function passFor(question, answer) {
  const q = mergeQuestion(question);
  return q && isYes(answer) ? q : null;
}

// Is this path inside the project folder? Git Bash paths (/c/Users/...) count as C:/Users/...; relative paths never
// do (the shell's folder is not known here).
function inside(path, dir) {
  if (!dir) return false;
  let p = String(path || '').replace(/\\/g, '/');
  p = p.replace(/^\/([a-z])\//i, '$1:/');
  if (!/^[a-z]:\//i.test(p) && !p.startsWith('/')) return false;
  const norm = s => resolve(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const a = norm(p), b = norm(dir);
  return a === b || a.startsWith(b + '/');
}

// The PR number a command merges, when it is exactly a merge a pass may allow; else null.
export function mergeCommand(tool, command, projectDir) {
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  let c = String(command || '').trim();
  // The folder: single-quoted (literal), double-quoted or bare, never with $, a backtick or brackets in it (no
  // expansion or command substitution can ride in).
  const cd = /^cd[ \t]+(?:"([^"$`()\n]+)"|'([^'\n]+)'|([\w.:/\\~-]+))[ \t]*&&[ \t]*([^\n]*)$/.exec(c);
  if (cd) {
    if (tool !== 'Bash' || !inside(cd[1] || cd[2] || cd[3], projectDir)) return null;
    c = cd[4].trim();
  }
  const m = /^gh[ \t]+pr[ \t]+merge[ \t]+(?:(--merge|--squash)[ \t]+)?#?(\d{1,6})(?:[ \t]+(--merge|--squash))?$/.exec(c);
  if (!m || (m[1] && m[3])) return null;
  return Number(m[2]);
}

// The pass that lets this request through now, or null: { pass, card, asker, number }. events: the project's log.
// A numbered pass allows its numbers; an unnumbered one allows any PR until its first use, then only that one.
export function findPass(events, tool, input, { dir, now = Date.now() } = {}) {
  const n = mergeCommand(tool, input?.command, dir);
  if (n == null) return null;
  const evs = events || [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.type !== 'merge_pass') continue;
    const age = now - Date.parse(e.ts);
    if (!(age >= 0 && age <= PASS_MS)) { if (age > PASS_MS) break; continue; }   // the log runs oldest first
    const nums = Array.isArray(e.numbers) ? e.numbers.map(Number) : [];
    const bound = nums.length ? null : evs.find(x => x.type === 'permission_answer' && x.pass === e.pass && x.passNumber != null)?.passNumber;
    if (nums.length ? nums.includes(n) : bound == null || Number(bound) === n) return { pass: e.pass, card: e.card, asker: e.asker, number: n };
  }
  return null;
}

// Part 4: was a merge you approved let through in the last 10 minutes, in any of these logs? By a pass, or by your
// Allow on a merge card.
export function recentApprovedMerge(logs, now = Date.now(), ms = RESTART_QUIET_MS) {
  for (const evs of logs) {
    const fresh = e => { const age = now - Date.parse(e.ts); return age >= 0 && age <= ms; };
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e.type === 'permission_answer' && e.pass && e.answer === 'allow' && fresh(e)) return true;
      if (e.type === 'approval_result' && (e.how === 'allowed' || e.how === 'always allowed') && fresh(e)) {
        const req = evs.find(x => x.type === 'approval' && x.approval === e.approval);
        if (/^\s*(?:cd\b[^\n]*?&&\s*)?gh\s+pr\s+merge\b/.test(String(req?.input?.command || ''))) return true;
      }
    }
  }
  return false;
}
