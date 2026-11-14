// Decision 64 A, parts 2 to 6 (the permission checker, part 1, has its own tests): one notice per choice, Matt's yes
// on a merge question covering the merge, quiet restarts after such a merge, statements kept out of question cards,
// and quieter digests. Agents are stubbed: nothing starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { isRepeat, decisionCovers, openQuestions, repeatsIn } from '../public/questions.js';
import { mergeQuestion, isYes, mergeCommand, findPass, recentApprovedMerge, PASS_MS, RESTART_QUIET_MS } from '../lib/merge-pass.mjs';
import { Push, cardsFor } from '../lib/push.mjs';
import { makeRestartHub } from '../lib/guard.mjs';
import { summaryReply } from '../lib/tools.mjs';
import { conductorPrompt } from '../lib/prompts.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';

const sent = [];
Agent.prototype.send = function (t) { sent.push([this.name, t]); this.state = 'working'; };
Agent.prototype.close = function () { };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };
const summary = (over = {}) => ({ done: [], changed: [], questions: [], decisions_needed: [], blocked_on: [], next_step: '', visuals: [], approvals: [], open_questions: [], ...over });
const fakeSender = pushed => ({ generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }), sendNotification: async (_s, b) => { pushed.push(JSON.parse(b)); } });
let n = 0;
const ev = (type, extra) => ({ id: `${type}-${++n}`, ts: new Date().toISOString(), type, ...extra });
const ask = (from, questions, extra = {}) => ev('summary', { thread: from === 'orchestrator-1' ? 'orchestrator' : from, from, questions, decisions_needed: [], ...extra });

// A decision record like the hub's, for the question rules.
const D59 = { id: 59, status: 'open', title: 'How is the All projects column laid out now that the Conductor talks there?',
  options: [{ key: 'A', name: 'Rows fill the column, chat below' }, { key: 'B', name: 'Chat fills the column, rows on top' }] };

function hubWith({ conductor = false, decisions = [] } = {}) {
  const root = makeTmp('crux-fewer-notices-');
  const dirs = ['alpha', 'beta'].map(name => { const d = join(root, name); mkdirSync(join(d, '.crux'), { recursive: true }); return d; });
  if (decisions.length) {
    mkdirSync(join(dirs[0], '.decisions'), { recursive: true });
    for (const d of decisions) writeFileSync(join(dirs[0], '.decisions', `${String(d.id).padStart(4, '0')}-d.json`), JSON.stringify({ slug: 'd', ...d }));
  }
  const hub = new Hub({ projects: dirs, memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }), ...(conductor ? { conductorDir: join(root, 'data', 'conductor') } : {}) });
  sent.length = 0;
  return { hub, root, a: hub.project('alpha'), b: hub.project('beta') };
}

// ---------- part 2: one notice per choice ----------
test('a repeat only when the words are the same (or contained) and every number, letter and name is in the held one', () => {
  const held = 'Should the preview update live while dragging, or only once the drag is released?';
  assert.equal(isRepeat('should the preview update live while dragging or only once the drag is released', held), true, 'equal once cleaned');
  assert.equal(isRepeat('Should the preview update live while dragging', held), true, 'contained');
  // Looser words are no longer a repeat (the 70% rule is gone).
  assert.equal(isRepeat('w1 asks: should the preview update while dragging or only when the drag is released?', held), false);
  // Contained, but a number or name the held one does not have.
  assert.equal(isRepeat('Should I merge PR 6', 'Should I merge PR 63 now, after the review?'), false, '6 is not 63');
  assert.equal(isRepeat('Ship version 0.22.1 with the lens picker today?', 'Ship version 0.22.0 with the lens picker today?'), false);
  assert.equal(isRepeat('Keep option A for the map strip height?', 'Keep option B for the map strip height?'), false);
  assert.equal(isRepeat('Should map-core own the strip height setting?', 'Should map-hud own the strip height setting?'), false);
  assert.equal(isRepeat('Should I merge PR #63 now, or wait for #64 and merge both?', 'Should I merge PR #63 now?'), false, 'never the longer one');
  assert.equal(isRepeat('Ship it now?', 'Ship it now?'), false, 'short ones never match');
});

test('only open cards hold repeats: never a question you settled in an earlier round, never a closed worker card', () => {
  const Q = 'Should the preview update live while dragging, or only once the drag is released?';
  // You answered w1 an hour ago; the orchestrator asks the same today: a new round, so it shows.
  const w = ask('w1', [Q]);
  const ans = ev('message', { thread: 'w1', from: 'you', text: 'Live.', answers: [{ question: w.id, index: 0 }] });
  const o = ask('orchestrator-1', [Q]);
  assert.deepEqual(openQuestions([w, ans, o]).map(c => c.from), ['orchestrator-1']);
  // Dismissed in an earlier round: the same.
  const dis = ev('question_dismissed', { question: w.id });
  assert.deepEqual(openQuestions([w, dis, o]).map(c => c.from), ['orchestrator-1']);
  // Asked while w1's card was open, then you answered w1: your answer covers it.
  assert.deepEqual(openQuestions([w, o, ans]), []);
  // The orchestrator already answered w1's card: that stale card never comes back, and never hides the re-ask.
  const relay = ev('message', { thread: 'w1', from: 'orchestrator-1', text: 'Hold on, I am asking Matt.' });
  assert.deepEqual(openQuestions([w, relay, o]).map(c => [c.from, c.open.length]), [['orchestrator-1', 1]]);
});

test('a re-ask after the worker card closed shows, but no second notice when the worker card\'s already went', async () => {
  const Q = 'Should the preview update live while dragging, or only once the drag is released?';
  const w = ask('w1', [Q]);
  const relay = ev('message', { thread: 'w1', from: 'orchestrator-1', text: 'Hold on, I am asking Matt.' });
  const o = ask('orchestrator-1', [Q]);
  const evs = [w];
  const h = pushHarness();
  const ctx = { approvals: new Map(), decisionOpen: () => true, decisionStatus: () => undefined, decisions: () => [], events: () => evs };
  h.push.handle({ ...w, project: 'alpha' }, ctx);
  h.timers.queue.shift().fn();
  await settle();
  assert.deepEqual(h.pushed.map(p => p.card), [`question:${w.id}`]);
  evs.push(relay, o);
  h.push.handle({ ...o, project: 'alpha' }, ctx);
  h.timers.queue.shift().fn();
  await settle();
  assert.equal(h.pushed.length, 1, 'the re-ask shows, with no second notice');
  assert.ok(h.logged.some(s => new RegExp(`asked before in question:${w.id}, whose notice already went`).test(s)));
  // Had w1's notice not gone (you were looking at it), the re-ask notifies.
  const g = pushHarness();
  g.push.handle({ ...o, project: 'alpha' }, ctx);
  g.timers.queue.shift().fn();
  await settle();
  assert.deepEqual(g.pushed.map(p => p.card), [`question:${o.id}`]);
});

test('a question is hidden behind a decision only when it asks nothing more, the decision is open, and (for notices) notified', async () => {
  assert.equal(decisionCovers('How is the All projects column laid out now that the Conductor talks there?', D59), true, 'the title, nothing more');
  assert.equal(decisionCovers('Rows fill the column with chat below, or chat fills the column with rows on top?', D59), true, 'two options, nothing more');
  assert.equal(decisionCovers('How is the All projects column laid out, and should the map strip shrink on phones?', D59), false, 'asks more');
  assert.equal(decisionCovers('Chat fills the column with rows on top, or rows fill the column with chat below, for v0.22?', D59), false, 'a version the decision does not have');
  assert.equal(decisionCovers('D59 is ready for you; should I also bump the version to 0.22?', D59), false, 'a number alone');
  const q = ask('w1', ['Rows fill the column with chat below, or chat fills the column with rows on top?']);
  assert.deepEqual(openQuestions([q], { decisions: [D59] }), [], 'the page: behind the open decision card');
  assert.deepEqual(repeatsIn([q], { decisions: [D59] }).get(q.id).map(r => [r.of, r.decision]), [['D0059', 59]]);
  assert.equal(openQuestions([q], { decisions: [D59], decisionNotified: () => false }).length, 1, 'the server: not while the decision never notified');
  const pick = ev('pick', { decision: 59, choice: 'B' });
  assert.equal(openQuestions([q, pick], { decisions: [{ ...D59, status: 'decided' }] }).length, 1, 'only while open: picked, the question shows again');
  // Notices: a question behind a decision that never notified gets its own; behind one that did, none.
  const h = pushHarness();
  const qa = { ...q, project: 'crux' };
  const ctx = { approvals: new Map(), decisionOpen: () => true, decisionStatus: id => id === 59 ? 'open' : undefined, decisions: () => [D59], events: () => [q] };
  h.push.handle(qa, ctx);
  h.timers.queue.shift().fn();
  await settle();
  assert.deepEqual(h.pushed.map(p => p.card), [`question:${q.id}`]);
  const g = pushHarness();
  g.push.handle({ id: 'sD', type: 'summary', project: 'crux', thread: 'orchestrator', from: 'orchestrator-1', decisions_needed: [59] }, ctx);
  await settle();
  g.push.handle(qa, ctx);
  g.timers.queue.shift().fn();
  await settle();
  assert.deepEqual(g.pushed.map(p => p.card), ['decision:59']);
});

function pushHarness(dir = makeTmp('crux-fewer-push-')) {
  const pushed = [], logged = [], timers = { queue: [], setTimeout(fn, ms) { this.queue.push({ fn, ms }); }, clearTimeout() { } };
  const push = new Push({ dir, sender: fakeSender(pushed), timers, log: s => logged.push(s) });
  push.subscribe({ endpoint: 'https://push.example/p', keys: { p256dh: 'k', auth: 'a' } });
  return { dir, push, pushed, logged, timers };
}

test('one phone notice per summary, however many cards it carries', async () => {
  const h = pushHarness();
  const s = { id: 's5', type: 'summary', project: 'life', thread: 'orchestrator', from: 'orchestrator-2', questions: ['Which day for the dentist?', 'Book the table for four?'], decisions_needed: [10, 11, 12, 13, 14] };
  const ctx = { approvals: new Map(), decisionOpen: () => true, decisionStatus: () => 'open', decisions: () => [], events: () => [s] };
  h.push.handle(s, ctx);
  await settle();
  assert.equal(h.pushed.length, 1);
  assert.equal(h.pushed[0].title, 'life v2 has 5 decisions and a question for you');
  assert.equal(h.pushed[0].card, 'decision:10');
  assert.equal(h.timers.queue.length, 0);
  // A later summary naming D12 again notifies nothing.
  h.push.handle({ ...s, id: 's6', questions: [], decisions_needed: [12] }, ctx);
  await settle();
  assert.equal(h.pushed.length, 1);
});

test('a decision notified once is never notified again, even after a restart; the same number in another project still is', async () => {
  const dir = makeTmp('crux-fewer-push-');
  const ctx = { approvals: new Map(), decisionOpen: () => true, decisionStatus: () => 'open', decisions: () => [], events: () => [] };
  const first = pushHarness(dir);
  first.push.handle({ id: 's1', type: 'summary', project: 'crux', thread: 'orchestrator', from: 'orchestrator-4', decisions_needed: [60] }, ctx);
  await settle();
  assert.equal(first.pushed.length, 1);
  const again = pushHarness(dir);   // the hub restarted: a fresh Push on the same data folder
  again.push.handle({ id: 's2', type: 'summary', project: 'crux', thread: 'orchestrator', from: 'orchestrator-5', decisions_needed: [60] }, ctx);
  await settle();
  assert.equal(again.pushed.length, 0, 'D60 is not sent again');
  again.push.handle({ id: 's3', type: 'summary', project: 'life', thread: 'orchestrator', from: 'orchestrator-1', decisions_needed: [60] }, ctx);
  await settle();
  assert.deepEqual(again.pushed.map(p => [p.project, p.card]), [['life', 'decision:60']]);
});

test('a decision that comes back (parked then reopened, challenged, or its number reused) can notify again', async () => {
  const h = pushHarness();
  const events = [], decisions = [{ id: 7, status: 'open', title: 'Which map?', date: '2026-11-14' }];
  const ctx = { approvals: new Map(), decisionOpen: () => true, decisionStatus: () => 'open', decisions: () => decisions, events: () => events };
  const ask7 = id => h.push.handle({ id, type: 'summary', project: 'crux', thread: 'orchestrator', from: 'orchestrator-1', decisions_needed: [7] }, ctx);
  ask7('s1'); await settle();
  ask7('s2'); await settle();
  assert.equal(h.pushed.length, 1, 'the same decision, still waiting: once');
  events.push({ type: 'pick', decision: 7, choice: 'parked' });   // parked, then back
  ask7('s3'); await settle();
  assert.equal(h.pushed.length, 2);
  decisions[0] = { ...decisions[0], challenge: { by: 'w1', why: 'new data' } };   // challenged
  ask7('s4'); await settle();
  assert.equal(h.pushed.length, 3);
  decisions[0] = { id: 7, status: 'open', title: 'Which font?', date: '2026-11-20' };   // the number used again after a clear
  ask7('s5'); await settle();
  assert.equal(h.pushed.length, 4);
});

test('a grouped notice comes down only when every card in it is settled', async () => {
  const h = pushHarness();
  const pc = [];
  h.push.desktopAttach('pc', (e, d) => pc.push([e, d.card]));
  h.push.desktopPresence('pc', { idleMs: 1000, locked: false });
  const ctx = { approvals: new Map(), decisionOpen: () => true, decisionStatus: () => 'open', decisions: () => [], events: () => [] };
  h.push.handle({ id: 's1', type: 'summary', project: 'crux', thread: 'orchestrator', from: 'orchestrator-1', decisions_needed: [3, 4] }, ctx);
  assert.deepEqual(pc, [['notify', 'decision:3']]);
  h.push.handle({ type: 'pick', project: 'crux', decision: 3 }, ctx);
  assert.equal(pc.length, 1, 'D4 still waits: the notice stays');
  h.push.handle({ type: 'pick', project: 'crux', decision: 4 }, ctx);
  assert.deepEqual(pc.at(-1), ['clear', 'decision:3']);
});

test('a question line with no question mark that opens like a question or a request still becomes a card', () => {
  const { hub, a } = hubWith();
  const w = hub.startWorker(a, 'w1', 'task');
  hub.postSummary(a, w, summary({ questions: ['Please pick the strip height', 'Which lens ships first', 'Should I keep the old icon', 'Tests pass on my side'] }));
  const s = a.log.ofType('summary').at(-1);
  assert.deepEqual(s.questions, ['Please pick the strip height', 'Which lens ships first', 'Should I keep the old icon']);
  assert.deepEqual(s.notes, ['Tests pass on my side']);
});

// ---------- part 3: Matt's yes on a merge question covers that merge ----------
test('a merge question names exactly one PR and no condition; the answer is a plain yes; the command is bare', () => {
  assert.deepEqual(mergeQuestion('PR #74 passed review. Merge #74 now?'), { number: 74 });
  assert.deepEqual(mergeQuestion('May I merge PR 74?'), { number: 74 });
  assert.deepEqual(mergeQuestion('Merge PR #74 and restart the hub?'), { number: 74 });
  for (const q of ['May I open the PR, merge it and restart?', 'Merge PRs 74 and 75?', 'Merge PR 75? (it closes #74)', 'Merge #75 and #74?',
    'Merge PR 74 once CI passes?', 'Merge PR 74 after the review?', 'Merge PR 74 when ready?', 'Merge PR 74 if the tests pass?', 'Merge PR 74 before lunch?',
    'Wait, merge PR 74?', 'Merge PR 74 until tonight?', 'Merge the branch into main?', 'I will merge #74 next.', 'May I merge mshomper/acuload#12?',
    'Merge https://github.com/x/y/pull/3 ?', 'Merge pull request 74?',
    // It must open as a merge ask, and ask nothing else (final review).
    'Close PR #77 instead of merging it?', 'Should I skip merging PR #74?', 'Abandon PR #74 rather than merge it?', 'Should I merge main into PR #74?',
    'Is PR #74 safe to merge, or should I close it?', 'Merge PR #74 or not?', 'Should I revert PR #74 and merge it again?', 'OK to merge PR #74?', 'PR #74: merge it?'])
    assert.equal(mergeQuestion(q), null, q);
  assert.deepEqual(mergeQuestion('May I open and merge PR #76?'), { number: 76 });
  assert.deepEqual(mergeQuestion('Can I merge #76 now?'), { number: 76 });
  assert.deepEqual(mergeQuestion('Tests pass. Shall I merge PR 76 and restart?'), { number: 76 });
  for (const y of ['Yes', 'yes.', 'Yep!', 'OK', 'okay', 'Sure', 'go', 'Go ahead.', 'do it', 'Merge it', 'approved', 'Yes please', 'yes, thanks']) assert.equal(isYes(y), true, y);
  for (const y of ['No', 'Yes, but wait for the reviewer', 'yes go ahead and restart too', 'Yes, merge 75 as well', 'Not yet', 'yes after the tests', 'Yeah', 'Sure, merge it and #75', '']) assert.equal(isYes(y), false, y);
  assert.deepEqual(mergeCommand('Bash', 'gh pr merge 74'), { number: 74, cd: null });
  assert.deepEqual(mergeCommand('Bash', 'gh pr merge 74 --merge'), { number: 74, cd: null });
  assert.deepEqual(mergeCommand('PowerShell', 'gh pr merge 74 --squash'), { number: 74, cd: null });
  assert.deepEqual(mergeCommand('Bash', 'cd C:/x/crux && gh pr merge 74'), { number: 74, cd: 'C:/x/crux' });
  // '#74' is a shell comment: "gh pr merge #74" merges the current branch's PR, so it is never a pass.
  for (const c of ['gh pr merge #74', 'gh pr merge 75 #74', 'gh pr merge --squash 74', 'gh pr merge 74 --admin', 'gh pr merge 74 --delete-branch', 'gh pr merge 74 -d',
    'gh pr merge 74 --merge --squash', 'gh pr merge 74 --repo o/r', 'gh pr merge 74 -R o/r', 'gh pr merge 74 --auto', 'gh pr merge 74 && git push --force',
    'gh pr merge 74; rm -rf x', 'gh pr merge 74\ngit push', 'cd ../acuload && gh pr merge 74', 'cd C:/x/crux/$(rm -rf ~) && gh pr merge 74',
    'cd "C:/x/crux/`whoami`" && gh pr merge 74', 'cd $HOME && gh pr merge 74', 'gh pr merge', 'gh pr close 74', 'gh pr merge 74 --body x'])
    assert.equal(mergeCommand('Bash', c), null, c);
  assert.equal(mergeCommand('Write', 'gh pr merge 74'), null);
});

// A project whose git remote the tests set (no real git): the main folder and its worktrees share it.
const origins = dir => (/acuload/i.test(dir) ? 'github.com/me/acuload' : 'github.com/me/alpha');
const askMerge = (hub, a, agent, q = 'PR #80 is green. Merge #80?') => { hub.postSummary(a, agent, summary({ questions: [q] })); return a.log.ofType('summary').at(-1); };

test('your own yes on that card lets exactly that merge through, once, by the asker only, logged', async () => {
  const { hub, a } = hubWith();
  hub.gitOrigin = origins;
  const orch = hub.ensureOrchestrator(a);
  const w = hub.startWorker(a, 'w1', 'task');
  const s = askMerge(hub, a, orch, 'Small batch on fix/x, tests pass. May I merge PR #76 and restart?');
  hub.answerQuestions(a, s.id, [{ index: 0, text: 'Yes', own: true }]);
  const pass = a.log.ofType('merge_pass').at(-1);
  assert.deepEqual([pass.card, pass.asker, pass.number, pass.by], [`question:${s.id}`, 'orchestrator-1', 76, 'you']);
  assert.match(a.log.ofType('notice').at(-1).text, /pre-approves gh pr merge 76 .*once, by orchestrator-1 only, for 30 minutes/);
  // Another agent cannot use it.
  hub.requestApproval(a, w, 'Bash', { command: 'gh pr merge 76' });
  assert.equal(a.log.ofType('approval').at(-1)?.agent, 'w1', 'w1 gets a card');
  // The asker, in the project's main folder: through at once, logged with where the yes came from.
  const r = await hub.requestApproval(a, orch, 'Bash', { command: `cd ${a.dir.replace(/\\/g, '/')} && gh pr merge 76 --merge` });
  assert.equal(r.behavior, 'allow');
  const log = a.log.ofType('permission_answer').at(-1);
  assert.match(log.reason, new RegExp(`^pre-approved by .+'s answer on question:${s.id}`));
  assert.deepEqual([log.pass, log.passNumber, log.answer], [pass.pass, 76, 'allow']);
  // Once only; another PR, flag or command is a card.
  for (const command of ['gh pr merge 76', 'gh pr merge 77', 'gh pr merge 76 --admin', 'git push origin main']) {
    hub.requestApproval(a, orch, 'Bash', { command });
    assert.equal(a.log.ofType('approval').at(-1)?.input.command, command, command);
  }
});

test('the folder: main folder or the asker\'s own worktree, with the project\'s own remote; never elsewhere', () => {
  const dir = 'C:/x/alpha';
  const evs = [{ type: 'merge_pass', ts: new Date().toISOString(), pass: 'p1', card: 'question:s1', asker: 'w1', thread: 'w1', index: 0, number: 9 }];
  const find = (command, origin = origins) => findPass(evs, 'Bash', { command }, { dir, agent: 'w1', origin });
  assert.ok(find('gh pr merge 9'));
  assert.ok(find('cd C:/x/alpha && gh pr merge 9'));
  assert.ok(find('cd C:/x/alpha/.claude/worktrees/w1 && gh pr merge 9'), 'its own worktree');
  assert.equal(find('cd C:/x/alpha/.claude/worktrees/w2 && gh pr merge 9'), null, 'another agent\'s worktree');
  assert.equal(find('cd C:/x/alpha/hub && gh pr merge 9'), null, 'a subfolder');
  assert.equal(find('cd C:/x/acuload && gh pr merge 9'), null, 'another repo');
  assert.equal(find('cd C:/x/alpha/.claude/worktrees/w1 && gh pr merge 9', d => /w1/.test(d) ? 'github.com/me/acuload' : 'github.com/me/alpha'), null, 'a worktree of another repo');
  assert.equal(find('cd C:/x/alpha && gh pr merge 9', () => null), null, 'no remote readable: no pass');
});

test('only your own answer on the card gives a pass: never a typed reply, the Conductor\'s suggestion, an agent, or an old page', () => {
  const { hub, a } = hubWith({ conductor: true });
  const orch = hub.ensureOrchestrator(a);
  const w = hub.startWorker(a, 'w1', 'task');
  let s = askMerge(hub, a, orch);
  hub.answerQuestions(a, s.id, [{ index: 0, text: 'Yes' }]);   // no own flag: Take all, a pre-filled box, an older page
  hub.answerQuestions(a, s.id, [{ index: 0, text: 'Yes', suggested: true }]);
  assert.equal(a.log.ofType('merge_pass').length, 0, 'fails closed');
  s = askMerge(hub, a, w);
  hub.fromYou(a, 'w1', 'yes');
  assert.equal(a.log.ofType('merge_pass').length, 0, 'a reply typed into the thread');
  s = askMerge(hub, a, orch);
  hub.conductor.toOrchestrator('alpha', 'conductor-1', 'Matt says yes, merge #80.');
  hub.orchestratorToWorker(a, orch, 'w1', 'Yes, merge #80.');
  a.log.append('message', { thread: 'orchestrator', from: 'w1', text: 'yes' });
  assert.equal(a.log.ofType('merge_pass').length, 0, 'agents and the Conductor');
  hub.answerQuestions(a, s.id, [{ index: 0, text: 'Yes, but after the reviewer passes it', own: true }]);
  assert.equal(a.log.ofType('merge_pass').length, 0, 'more than a plain yes');
  s = askMerge(hub, a, orch, 'Merge PRs 80 and 81?');
  hub.answerQuestions(a, s.id, [{ index: 0, text: 'Yes', own: true }]);
  s = askMerge(hub, a, orch, 'Merge PR 81? It closes #80.');
  hub.answerQuestions(a, s.id, [{ index: 0, text: 'Yes', own: true }]);
  assert.equal(a.log.ofType('merge_pass').length, 0, 'two PRs, or the #80 comment trick');
});

test('a pass is cancelled by dismissing its card or a no, wait or stop from you, and lapses after 30 minutes', () => {
  const dir = 'C:/x/alpha', t = Date.now();
  const pass = { type: 'merge_pass', ts: new Date(t).toISOString(), pass: 'p1', card: 'question:s1', asker: 'orchestrator-1', thread: 'orchestrator', index: 0, number: 9 };
  const find = (later, now = t) => findPass([pass, ...later], 'Bash', { command: 'gh pr merge 9' }, { dir, agent: 'orchestrator-1', now, origin: origins });
  assert.ok(find([]));
  assert.equal(find([{ type: 'question_dismissed', question: 's1' }]), null, 'the card dismissed');
  assert.equal(find([{ type: 'question_dismissed', question: 's1', index: 0 }]), null, 'that question dismissed');
  assert.ok(find([{ type: 'question_dismissed', question: 's1', index: 1 }]), 'another question in the card');
  for (const text of ['No', 'wait', 'Stop, not yet', "don't merge"]) assert.equal(find([{ type: 'message', thread: 'orchestrator', from: 'you', text }]), null, text);
  assert.ok(find([{ type: 'message', thread: 'w1', from: 'you', text: 'wait' }]), 'another thread');
  assert.ok(find([{ type: 'message', thread: 'orchestrator', from: 'orchestrator-1', text: 'wait' }]), 'not yours');
  assert.equal(find([], t + PASS_MS + 1000), null, 'lapsed');
  assert.equal(findPass([pass], 'Bash', { command: 'gh pr merge 9' }, { dir, agent: 'w1', origin: origins }), null, 'not the asker');
});

// ---------- part 4: restart notices ----------
test('no restart notice within 10 minutes of a merge you approved; other restarts go the PC-or-phone way', async () => {
  const t0 = Date.parse('2026-11-14T12:00:00Z');
  const passEv = { type: 'permission_answer', ts: new Date(t0).toISOString(), answer: 'allow', pass: 'p1', passNumber: 76 };
  assert.equal(recentApprovedMerge([passEv], t0 + 5 * 60000), true);
  assert.equal(recentApprovedMerge([passEv], t0 + RESTART_QUIET_MS + 1000), false);
  const card = { type: 'approval', approval: 'ap1', input: { command: 'gh pr merge 77 --merge' } };
  assert.equal(recentApprovedMerge([card, { type: 'approval_result', approval: 'ap1', how: 'allowed', ts: new Date(t0).toISOString() }], t0 + 60000), true, 'your Allow on a merge card');
  assert.equal(recentApprovedMerge([card, { type: 'approval_result', approval: 'ap1', how: 'allowed by orchestrator-4', ts: new Date(t0).toISOString() }], t0 + 60000), false, 'not the orchestrator\'s');
  assert.equal(recentApprovedMerge([{ ...card, input: { command: 'npm test' } }, { type: 'approval_result', approval: 'ap1', how: 'allowed', ts: new Date(t0).toISOString() }], t0 + 60000), false, 'not a merge');

  const calls = [], logs = [], env = {};
  const push = { restartNotice: async info => { calls.push(info); return 1; }, log: s => logs.push(s) };
  const proj = { name: 'proj', log: { events: [passEv] } }, other = { name: 'other', log: { events: [] } };
  const hub = { notice() { } };
  const orch = { name: 'orchestrator-4', role: 'orchestrator' };
  let now = t0 + 3 * 60000;
  await makeRestartHub({ hub, push, restart() { }, bootAt: t0 - 3600e3, now: () => now, delayMs: 0, env })(proj, orch, 'merged #76');
  assert.equal(calls.length, 0);
  assert.match(logs[0], /no notice, a merge you approved in proj went through in the last 10 minutes/);
  // Another project's orchestrator restarting in that window still notifies: the quiet is for the merge's own project.
  await makeRestartHub({ hub, push, restart() { }, bootAt: t0 - 3600e3, now: () => now, delayMs: 0, env })(other, orch, 'new settings');
  assert.deepEqual(calls, [{ project: 'other', agent: 'orchestrator-4' }]);
  now = t0 + 20 * 60000;
  await makeRestartHub({ hub, push, restart() { }, bootAt: t0 - 3600e3, now: () => now, delayMs: 0, env })(proj, orch, 'new settings');
  assert.equal(calls.length, 2, 'past 10 minutes it notifies');

  // The routing: the PC while it is in use (no phone follow-up), else the phone; none while you look at that thread.
  const h = pushHarness();
  const pc = [];
  h.push.desktopAttach('pc', (e, d) => pc.push([e, d.card, d.title]));
  h.push.desktopPresence('pc', { idleMs: 1000, locked: false });
  await h.push.restartNotice({ project: 'crux', agent: 'orchestrator-6' }, {});
  assert.deepEqual(pc, [['notify', 'notice:restart', 'The hub is restarting']]);
  assert.equal(h.pushed.length, 0);
  assert.equal(h.timers.queue.length, 0, 'no 3-minute phone follow-up');
  const phone = pushHarness();
  await phone.push.restartNotice({ project: 'crux', agent: 'orchestrator-6' }, {});
  assert.deepEqual(phone.pushed.map(p => [p.kind, p.body]), [['restart', 'Asked by crux v6']]);
  const looking = pushHarness();
  looking.push.presence('page', { project: 'crux', thread: 'orchestrator', visible: true, focused: true, idleMs: 0 });
  await looking.push.restartNotice({ project: 'crux', agent: 'orchestrator-6' }, {});
  assert.equal(looking.pushed.length, 0);
});

// ---------- part 5: a "question" with no question mark ----------
test('a question line with no question mark is a plain line in the summary, not a card, and the agent is told', () => {
  const { hub, a } = hubWith();
  const orch = hub.ensureOrchestrator(a);
  const w = hub.startWorker(a, 'w1', 'task');
  const r = hub.postSummary(a, w, summary({ questions: ["Tell me when you've finished listening", 'Keep the 124 px strip?'] }));
  const s = a.log.ofType('summary').at(-1);
  assert.deepEqual(s.questions, ['Keep the 124 px strip?']);
  assert.deepEqual(s.notes, ["Tell me when you've finished listening"]);
  assert.deepEqual(r.notes, s.notes);
  assert.match(sent.at(-1)[1], /Notes:\n- Tell me when you've finished listening/, 'the orchestrator sees it as a note');
  assert.match(summaryReply(r), /^Summary posted\. One line under questions had no question mark, so it shows as a plain line in your summary, not as a question card: "Tell me when you've finished listening"\. Put status lines in done or next_step/);
  assert.equal(summaryReply({ notes: [] }), 'Summary posted.');
  hub.postSummary(a, w, summary({ questions: ['A test card, please ignore'] }));
  const only = a.log.ofType('summary').at(-1);
  assert.deepEqual(only.questions, []);
  assert.deepEqual(cardsFor({ ...only, project: 'alpha' }), [], 'no notice');
  assert.equal(openQuestions(a.log.events).some(c => c.id === only.id), false, 'no card');
  assert.ok(orch);
});

// ---------- part 6: quieter digests ----------
test('a return digest keeps the same 30-minute floor as an away digest; one with only already-notified cards sends no notice', async () => {
  const { hub, a } = hubWith({ conductor: true });
  const c = hub.conductor;
  c.wakeMs = 20; c.digestMs = 150;
  const presence = { here: false };
  hub.presence = () => presence.here;
  const notices = [];
  hub.digestNotice = info => notices.push(info);
  const askA = q => hub.postSummary(a, hub.ensureOrchestrator(a), summary({ questions: [q] }));
  askA('Retry failed uploads three times before showing the error?');
  presence.here = true; c.presenceReport();   // the first return: no digest before, so at once
  assert.equal(notices.length, 1);
  presence.here = false;
  askA('Ship the lens picker on Friday or wait for the review?');
  await sleep(40);
  presence.here = true; c.presenceReport();   // back again, well within 150 ms of the last digest
  assert.equal(notices.length, 1, 'no second digest yet');
  assert.equal(c.holding(), true, 'held for the floor');
  await sleep(160);
  assert.equal(notices.length, 2, 'it goes up at the floor');
  assert.equal(c.home.log.ofType('cards').at(-1).digest, 'return');

  // push.digest: every card in it already notified on its own (a permission card), no replies: no notice.
  const h = pushHarness();
  const ctx = { approvals: new Map([['ap1', {}]]), decisionOpen: () => true, decisionStatus: () => 'open', decisions: () => [], events: () => [] };
  h.push.handle({ type: 'approval', approval: 'ap1', project: 'beta', thread: 'w1', agent: 'w1', tool: 'Bash', routedTo: null }, ctx);
  await settle();
  h.push.digest({ id: 'd1', count: 1, projects: 1, items: [{ project: 'beta', card: 'approval:ap1' }] }, ctx);
  await settle();
  assert.deepEqual(h.pushed.map(p => p.card), ['approval:ap1']);
  assert.ok(h.logged.some(s => /digest:d1: no notice, every card in it was already notified/.test(s)));
  // A digest with a decision in it counts that decision as notified.
  h.push.digest({ id: 'd2', count: 1, projects: 1, items: [{ project: 'beta', card: 'decision:9' }] }, ctx);
  await settle();
  h.push.handle({ id: 's9', type: 'summary', project: 'beta', thread: 'orchestrator', from: 'orchestrator-1', decisions_needed: [9] }, ctx);
  await settle();
  assert.deepEqual(h.pushed.map(p => p.card), ['approval:ap1', 'digest:d2']);
});

test('the Conductor is told to stay silent about cards in Needs you and never to repeat a list', () => {
  const p = conductorPrompt({ projects: ['alpha'], reminders: [], core: '', conventions: '' });
  assert.match(p, /While \{\{who\}\} is here, the hub keeps new cards out of your thread/);
  assert.match(p, /never post again a list of cards \{\{who\}\}\s+has already been shown/);
});
