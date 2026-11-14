// Decision 64 A, parts 2 to 6 (the permission checker, part 1, has its own tests): one notice per choice, Matt's yes
// on a merge question covering the merge, quiet restarts after such a merge, statements kept out of question cards,
// and quieter digests. Agents are stubbed: nothing starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { isRepeat, wordOverlap, decisionCovers, openQuestions, repeatsIn, holderOf } from '../public/questions.js';
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
test('a re-ask in looser words is a repeat: about 70% of the meaningful words, both ways, 24+ characters', () => {
  const worker = 'Should the preview update live while dragging, or only once the drag is released?';
  const orch = 'w1 asks: should the preview update while dragging or only when the drag is released?';
  assert.ok(wordOverlap(worker, orch) >= 0.7);
  assert.equal(isRepeat(orch, worker), true);
  assert.equal(isRepeat(worker, orch), true, 'both directions');
  // Shares words but asks something else.
  assert.equal(isRepeat('Should the preview show a grid while dragging, and snap to it on release?', worker), false);
  // Asks much more: under 70% the other way.
  assert.equal(isRepeat('Should the preview update while dragging or only on release, and should the grid snap, and which colour should the handles be?', worker), false);
  assert.equal(isRepeat('Ship it now?', 'Ship it now?'), false, 'short ones never match');
});

test('the worker card keeps holding a question its orchestrator asks again after writing to it; one notice, for that card', async () => {
  const W = 'Should the preview update live while dragging, or only once the drag is released?';
  const w = ask('w1', [W]);
  const relay = ev('message', { thread: 'w1', from: 'orchestrator-1', text: 'Hold on, I am asking Matt.' });
  const o = ask('orchestrator-1', ['w1 asks: should the preview update while dragging or only when the drag is released?']);
  const evs = [w, relay, o];
  const open = openQuestions(evs);
  assert.deepEqual(open.map(c => [c.from, c.open.map(q => q.text)]), [['w1', [W]]], 'only the worker card shows');
  assert.deepEqual(repeatsIn(evs).get(o.id).map(r => [r.of, r.holder]), [['w1', w.id]]);
  assert.deepEqual(holderOf(evs, o.id), { holder: w.id });
  // Your answer on the worker card covers the re-ask; the orchestrator's own card stays closed.
  const ans = ev('message', { thread: 'w1', from: 'you', text: 'Live.', answers: [{ question: w.id, index: 0 }] });
  assert.deepEqual(openQuestions([...evs, ans]), []);
  // Notices: the worker card's grace ended while it was closed (no notice then); the re-ask's notice goes for the
  // worker card instead, and the re-ask itself never notifies.
  const root = makeTmp('crux-fewer-push-');
  const pushed = [];
  const push = new Push({ dir: root, sender: fakeSender(pushed), timers: { setTimeout: f => f(), clearTimeout() { } }, log: () => { } });
  push.subscribe({ endpoint: 'https://push.example/p', keys: { p256dh: 'k', auth: 'a' } });
  const ctx = { approvals: new Map(), decisionOpen: () => true, decisionStatus: () => undefined, decisions: () => [], events: () => evs };
  push.handle({ ...o, project: 'alpha' }, ctx);
  await settle();
  assert.deepEqual(pushed.map(p => [p.card, p.title]), [[`question:${w.id}`, 'w1 has a question']]);
  push.handle({ ...o, project: 'alpha' }, ctx);
  await settle();
  assert.equal(pushed.length, 1, 'once');
});

test('a question an open decision card already asks is hidden behind it; your pick answers it; naming a number alone is not enough', () => {
  assert.equal(decisionCovers('How should the All projects column be laid out now that the Conductor talks there?', D59), true, 'the title');
  assert.equal(decisionCovers('For All projects, rows fill the column with chat below, or chat fills the column with rows on top?', D59), true, 'two options');
  assert.equal(decisionCovers('D59 is ready for you; should I also bump the version to 0.22?', D59), false);
  const q = ask('w1', ['Which layout: chat fills the column with rows on top, or rows fill the column with chat below?']);
  const other = ask('w2', ['Should the version go to 0.22 with this change?']);
  assert.deepEqual(openQuestions([q, other], { decisions: [D59] }).map(c => c.from), ['w2']);
  assert.deepEqual(repeatsIn([q], { decisions: [D59] }).get(q.id).map(r => [r.of, r.decision]), [['D0059', 59]]);
  // Picked after the question: answered, so it does not come back.
  const pick = ev('pick', { decision: 59, choice: 'B' });
  assert.deepEqual(openQuestions([q, pick], { decisions: [{ ...D59, status: 'decided', chosen: 'B' }] }), []);
  assert.equal(repeatsIn([q, pick], { decisions: [{ ...D59, status: 'decided' }] }).get(q.id)[0].answered, true);
  // Decided long before the question was asked: the question is its own card.
  assert.equal(openQuestions([pick, q], { decisions: [{ ...D59, status: 'decided' }] }).length, 1);
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
  assert.equal(h.pushed[0].title, 'orchestrator-2 has 5 decisions and a question for you');
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

test('a question hidden behind an open decision gets no notice of its own', async () => {
  const h = pushHarness();
  const q = { id: 'q1', type: 'summary', project: 'crux', thread: 'w1', from: 'w1', questions: ['Which layout: chat fills the column with rows on top, or rows fill the column with chat below?'], decisions_needed: [] };
  const ctx = { approvals: new Map(), decisionOpen: () => true, decisionStatus: id => id === 59 ? 'open' : undefined, decisions: () => [D59], events: () => [q] };
  h.push.handle(q, ctx);
  h.timers.queue.forEach(t => t.fn());
  await settle();
  assert.equal(h.pushed.length, 0);
  assert.ok(h.logged.some(s => /settled before it went out/.test(s)));
});

// ---------- part 3: Matt's yes on a merge question covers that merge ----------
test('what counts as a merge question, a plain yes, and the one command a pass allows', () => {
  assert.deepEqual(mergeQuestion('May I open the PR, merge it and restart?'), { numbers: [] });
  assert.deepEqual(mergeQuestion('PR #74 passed review. Merge #74 now?'), { numbers: [74] });
  assert.deepEqual(mergeQuestion('Merge PR 12 and pull request 13?'), { numbers: [12, 13] });
  assert.equal(mergeQuestion('Merge the branch into main?'), null, 'no pull request named');
  assert.equal(mergeQuestion('I will merge #74 next.'), null, 'not a question');
  assert.equal(mergeQuestion('May I merge mshomper/acuload#12?'), null, 'another repo');
  assert.equal(mergeQuestion('Merge https://github.com/x/y/pull/3 ?'), null, 'a link to a pull request elsewhere');
  for (const y of ['Yes', 'yes, go ahead', 'Go ahead.', 'OK', 'Sure, merge it', 'Yes please']) assert.equal(isYes(y), true, y);
  for (const y of ['No', 'Yes, but wait for the reviewer', 'Not yet', 'yes after the tests', 'Yes if CI passes', "Don't", 'Hold on', 'Merge #12 instead', '']) assert.equal(isYes(y), false, y);
  const dir = 'C:/Users/me/GitHub/crux';
  assert.equal(mergeCommand('Bash', 'gh pr merge 76', dir), 76);
  assert.equal(mergeCommand('Bash', 'gh pr merge 76 --merge', dir), 76);
  assert.equal(mergeCommand('PowerShell', 'gh pr merge --squash 76', dir), 76);
  assert.equal(mergeCommand('Bash', 'cd C:/Users/me/GitHub/crux/.claude/worktrees/x && gh pr merge 76 --squash', dir), 76, 'cd into the project first');
  assert.equal(mergeCommand('Bash', 'cd /c/Users/me/GitHub/crux && gh pr merge 76', dir), 76, 'Git Bash path');
  for (const c of ['gh pr merge 76 --admin', 'gh pr merge 76 --delete-branch', 'gh pr merge 76 -d', 'gh pr merge 76 --merge --squash', 'gh pr merge 76 --repo other/repo', 'gh pr merge 76 -R o/r',
    'gh pr merge 76 --auto', 'gh pr merge 76 && git push --force', 'gh pr merge 76; rm -rf x', 'gh pr merge 76\ngit push', 'cd ../acuload && gh pr merge 76', 'cd C:/Users/me/GitHub/acuload && gh pr merge 76',
    'cd C:/Users/me/GitHub/crux-other && gh pr merge 76', 'gh pr merge', 'gh pr close 76', 'git merge main', 'gh pr merge 76 --body x',
    'cd C:/Users/me/GitHub/crux/$(rm -rf ~) && gh pr merge 76', 'cd "C:/Users/me/GitHub/crux/`whoami`" && gh pr merge 76', 'cd "C:/Users/me/GitHub/crux/$HOME" && gh pr merge 76', 'cd $HOME && gh pr merge 76'])
    assert.equal(mergeCommand('Bash', c, dir), null, c);
  assert.equal(mergeCommand('Write', 'gh pr merge 76', dir), null);
});

test('your yes on "open the PR and merge it" lets exactly that merge through, logged; nothing else, and not for long', async () => {
  const { hub, a } = hubWith();
  const orch = hub.ensureOrchestrator(a);
  hub.postSummary(a, orch, summary({ questions: ['Small batch on fix/x, tests pass. May I open the PR, merge it and restart?'] }));
  const s = a.log.ofType('summary').at(-1);
  hub.answerQuestions(a, s.id, [{ index: 0, text: 'Yes' }]);
  const pass = a.log.ofType('merge_pass').at(-1);
  assert.deepEqual([pass.card, pass.asker, pass.numbers, pass.by], [`question:${s.id}`, 'orchestrator-1', [], 'you']);
  assert.match(a.log.ofType('notice').at(-1).text, /pre-approves gh pr merge for the pull request it opens .* for 30 minutes/);
  // The merge goes through at once, logged with where the yes came from.
  const r = await hub.requestApproval(a, orch, 'Bash', { command: 'gh pr merge 76 --merge' });
  assert.equal(r.behavior, 'allow');
  const log = a.log.ofType('permission_answer').at(-1);
  assert.equal(log.answer, 'allow');
  assert.match(log.reason, new RegExp(`^pre-approved by .+'s answer on question:${s.id}`));
  assert.deepEqual([log.pass, log.passNumber], [pass.pass, 76]);
  assert.equal(a.log.ofType('approval').length, 0, 'no card');
  // Again for the same PR (a retry) is fine; another PR, a flag it does not cover, or another command is a card.
  assert.equal((await hub.requestApproval(a, orch, 'Bash', { command: 'gh pr merge 76' })).behavior, 'allow');
  for (const command of ['gh pr merge 77', 'gh pr merge 76 --admin', 'gh pr merge 76 --delete-branch', 'git push origin main']) {
    hub.requestApproval(a, orch, 'Bash', { command });
    assert.equal(a.log.ofType('approval').at(-1)?.input.command, command, command);
  }
  // After 30 minutes the pass has lapsed.
  pass.ts = new Date(Date.now() - PASS_MS - 1000).toISOString();
  assert.equal(findPass(a.log.events, 'Bash', { command: 'gh pr merge 76' }, { dir: a.dir }), null);
});

test('only your own answer gives a pass: never the Conductor\'s suggestion, an agent\'s words, or a yes with a condition', async () => {
  const { hub, a } = hubWith({ conductor: true });
  const orch = hub.ensureOrchestrator(a);
  const w = hub.startWorker(a, 'w1', 'task');
  const askMerge = (agent, q = 'PR #80 is green. Merge #80?') => { hub.postSummary(a, agent, summary({ questions: [q] })); return a.log.ofType('summary').at(-1); };
  let s = askMerge(orch);
  hub.answerQuestions(a, s.id, [{ index: 0, text: 'Yes', suggested: true }]);   // Take all, or its pre-filled box
  assert.equal(a.log.ofType('merge_pass').length, 0, 'the Conductor\'s suggestion');
  s = askMerge(orch);
  hub.conductor.toOrchestrator('alpha', 'conductor-1', 'Matt says yes, merge #80.');
  hub.orchestratorToWorker(a, orch, 'w1', 'Yes, merge #80.');
  a.log.append('message', { thread: 'orchestrator', from: 'w1', text: 'yes' });
  assert.equal(a.log.ofType('merge_pass').length, 0, 'agents and the Conductor');
  hub.answerQuestions(a, s.id, [{ index: 0, text: 'Yes, but after the reviewer passes it' }]);
  assert.equal(a.log.ofType('merge_pass').length, 0, 'a yes with a condition');
  // Your plain yes typed into the asker's thread counts.
  s = askMerge(w);
  hub.fromYou(a, 'w1', 'yes go ahead');
  assert.deepEqual(a.log.ofType('merge_pass').map(e => [e.asker, e.numbers]), [['w1', [80]]]);
  assert.equal(findPass(a.log.events, 'Bash', { command: 'gh pr merge 81' }, { dir: a.dir }), null, 'a numbered pass covers its number only');
  assert.ok(findPass(a.log.events, 'Bash', { command: 'gh pr merge 80 --squash' }, { dir: a.dir }));
  // A pass in one project never covers another.
  assert.equal(findPass(hub.project('beta').log.events, 'Bash', { command: 'gh pr merge 80' }, { dir: hub.project('beta').dir }), null);
});

// ---------- part 4: restart notices ----------
test('no restart notice within 10 minutes of a merge you approved; other restarts go the PC-or-phone way', async () => {
  const t0 = Date.parse('2026-11-14T12:00:00Z');
  const passEv = { type: 'permission_answer', ts: new Date(t0).toISOString(), answer: 'allow', pass: 'p1', passNumber: 76 };
  assert.equal(recentApprovedMerge([[passEv]], t0 + 5 * 60000), true);
  assert.equal(recentApprovedMerge([[passEv]], t0 + RESTART_QUIET_MS + 1000), false);
  const card = { type: 'approval', approval: 'ap1', input: { command: 'gh pr merge 77 --merge' } };
  assert.equal(recentApprovedMerge([[card, { type: 'approval_result', approval: 'ap1', how: 'allowed', ts: new Date(t0).toISOString() }]], t0 + 60000), true, 'your Allow on a merge card');
  assert.equal(recentApprovedMerge([[card, { type: 'approval_result', approval: 'ap1', how: 'allowed by orchestrator-4', ts: new Date(t0).toISOString() }]], t0 + 60000), false, 'not the orchestrator\'s');
  assert.equal(recentApprovedMerge([[{ ...card, input: { command: 'npm test' } }, { type: 'approval_result', approval: 'ap1', how: 'allowed', ts: new Date(t0).toISOString() }]], t0 + 60000), false, 'not a merge');

  const calls = [], logs = [], env = {};
  const push = { restartNotice: async info => { calls.push(info); return 1; }, log: s => logs.push(s) };
  const events = [passEv];
  const hub = { notice() { }, projects: new Map([['proj', { log: { events } }]]) };
  const orch = { name: 'orchestrator-4', role: 'orchestrator' };
  let now = t0 + 3 * 60000;
  await makeRestartHub({ hub, push, restart() { }, bootAt: t0 - 3600e3, now: () => now, delayMs: 0, env })({ name: 'proj' }, orch, 'merged #76');
  assert.equal(calls.length, 0);
  assert.match(logs[0], /no notice, a merge you approved went through in the last 10 minutes/);
  now = t0 + 20 * 60000;
  await makeRestartHub({ hub, push, restart() { }, bootAt: t0 - 3600e3, now: () => now, delayMs: 0, env })({ name: 'proj' }, orch, 'new settings');
  assert.deepEqual(calls, [{ project: 'proj', agent: 'orchestrator-4' }]);

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
  assert.deepEqual(phone.pushed.map(p => [p.kind, p.body]), [['restart', 'Asked by orchestrator-6 in crux']]);
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
