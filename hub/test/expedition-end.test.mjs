// Phase 5, the end (spec 4.8): the logged steps (report, commit, push, pr, card, summary), each skipped if its event exists,
// so the end never runs twice, a restart between any two steps carries on at the next, and a step cut short does its work
// again harmlessly. Plus the desk (a real git repo and a fake gh), the report's generated part, and the carry-overs M049 1, 4, 5, 6.
// Agents are stubbed (nothing starts); the desk is a recording fake except where the real one is under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { recordAgents, stubHub, StubExpedition, quietMark, quietProblems } from './helpers/expedition-stub.mjs';
import { makeTmp } from './helpers/tmp.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { Expedition, END_STEPS } from '../lib/expedition.mjs';
import { ExpeditionDesk } from '../lib/expedition-desk.mjs';
import { END_WAIT_MS } from '../lib/expedition-end.mjs';
import { GENERATED_MARK, assembleReport, answerLine, proposalsOf, howItRan, howItRanMarkdown } from '../lib/expedition-report.mjs';
import { cardsFor } from '../lib/push.mjs';

const sent = recordAgents();
const FIVE = ['advisor', 'synthesizer', 'skeptic', 'builder', 'verifier'];
const REPORT = '# Report\n\n## Answer\nUse library A: it is faster and smaller.\n\n## Findings\nA table.\n';
const summary = (over = {}) => ({ done: [], changed: [], questions: [], decisions_needed: [], blocked_on: [], next_step: '', visuals: [], approvals: [], open_questions: [], ...over });

// A recording desk. fail: { push: 'message' } makes that step's call reject (a failure the end logs as a result).
function fakeDesk(calls, fail = {}) {
  return {
    reportRel: 'docs/expeditions/x/REPORT.md',
    async commit(msg) { calls.push(['commit', msg]); if (fail.commit) throw new Error(fail.commit); return { commit: 'abc1234', already: false }; },
    async push() { calls.push(['push']); if (fail.push) throw new Error(fail.push); return { ok: true, local: false }; },
    async pr(o) { calls.push(['pr', o.title, o.body]); if (fail.pr) throw new Error(fail.pr); return { url: 'https://github.com/o/r/pull/7', number: 7, draft: true, existed: false }; }
  };
}

// An expedition that has passed and is waiting for its end: members retired, the Lead idle with its report written.
function world({ reason = 'passed', calls = [], fail = {} } = {}) {
  sent.length = 0;
  const env = stubHub({ level: 'auto' });
  const mark = quietMark(env);
  const se = new StubExpedition(env);
  se.run({ stop: false });
  se.ex.stop({ reason, totals: {} });
  for (const r of FIVE) env.hub.retireFinished(env.p, se.agents[r].name, 'hub', 'test');
  se.agents.lead.state = 'idle';
  se.ex.write('REPORT.md', REPORT);
  env.hub.expeditionEnd.deskFactory = () => fakeDesk(calls, fail);
  return { env, se, mark, calls, hub: env.hub, p: env.p, ex: se.ex, id: se.id, end: env.hub.expeditionEnd, lead: se.agents.lead };
}
const count = (p, id, type, f = () => true) => p.log.events.filter(e => e.type === type && e.expedition === id && f(e)).length;
const stepCount = (p, id, step) => count(p, id, 'expedition_step', e => e.step === step);

// A second hub on the same project folder: what a restart is (the log is the only thing that survives).
function restart(env) {
  const hub2 = new Hub({ projects: [env.dir], memory: new Memory(join(env.root, 'home')), agentHome: join(env.root, 'agents-home'), noAgents: true, settings: new HubSettings({ file: null, initial: {} }) });
  hub2.expeditionWatch.stop(); clearInterval(hub2.idleTimer);
  return { hub2, p2: hub2.project('proj') };
}

test('the end runs the steps in order, once each, and builds the report, the card and the Lead\'s go-ahead', async () => {
  const W = world();
  const did = await W.end.run(W.p, W.id);
  assert.deepEqual(did, ['report', 'commit', 'push', 'pr', 'card']);
  assert.deepEqual(W.calls.map(c => c[0]), ['commit', 'push', 'pr']);
  assert.match(W.calls[0][1], /^Expedition .*: Use library A: it is faster and smaller\.$/);
  for (const s of END_STEPS.filter(s => s !== 'summary')) assert.equal(stepCount(W.p, W.id, s), 1, s);
  assert.equal(stepCount(W.p, W.id, 'summary'), 0, 'the summary is the Lead\'s, not the end\'s');
  // The report: what the Lead wrote, then the hub's part, once.
  const md = W.ex.read('REPORT.md');
  assert.ok(md.startsWith(REPORT.trimEnd()));
  assert.equal(md.split(GENERATED_MARK).length, 2);
  assert.match(md, /## Claims check\n\nClaims not checked: verify\/VERDICT\.md has no claims or corrections section/);
  assert.match(md, /## Parked, as proposed next expeditions\n\n1\. Compare a third library \(why parked: outside the brief\)/);
  assert.match(md, /## Requests that were not allowed\n\n- Bash: git push --force origin main/);
  assert.match(md, /## Core lessons held for you\n\n- Always say which result came from a software GPU/);
  assert.match(md, /## How it ran/);
  // The card.
  const f = W.ex.state().finished;
  assert.deepEqual([f.answer, f.stopReason, f.loops, f.passing, f.decisions, f.parked, f.lessons, f.claimsChecked, f.pushed, f.problem], ['Use library A: it is faster and smaller.', 'passed', 2, 3, 2, 1, 1, false, true, null]);
  assert.deepEqual([f.branch, f.pr, f.thread, f.commit], [`expedition/${W.id}`, { url: 'https://github.com/o/r/pull/7', number: 7, draft: true }, 'orchestrator', 'abc1234']);
  assert.equal(f.title, 'Expedition finished: Use library A: it is faster and smaller.');
  // The Lead is told it may send its one summary, once; the orchestrator got nothing.
  assert.equal(W.ex.summaryDue(), true);
  assert.equal(sent.filter(([n, t]) => n === W.lead.name && t.startsWith('[From the hub] The end is done')).length, 1);
  assert.equal(sent.filter(([n]) => n === W.env.orch.name).length, 0);
  // The finished card notifies once, with no part of the report in it (C001).
  await new Promise(r => setImmediate(r));
  assert.equal(W.env.pushed.length + W.env.desk.length, 1);
  assert.doesNotMatch(JSON.stringify([W.env.pushed, W.env.desk]), /library A/);
  assert.deepEqual(quietProblems(W.env, W.mark, sent), []);
});

test('run twice: every step once, every desk call once, no second card', async () => {
  const W = world();
  await W.end.run(W.p, W.id);
  assert.deepEqual(await W.end.run(W.p, W.id), []);
  const [a, b] = [W.end.begin(W.p, W.id), W.end.begin(W.p, W.id)];
  await Promise.all([a, b]);
  assert.equal(count(W.p, W.id, 'expedition_finished'), 1);
  assert.deepEqual(W.calls.map(c => c[0]), ['commit', 'push', 'pr']);
  assert.equal(sent.filter(([, t]) => t.startsWith('[From the hub] The end is done')).length, 1);
  assert.equal(W.ex.read('REPORT.md').split(GENERATED_MARK).length, 2, 'the report\'s generated part is not doubled');
});

// The acceptance test: a crash (an exception out of the sequence) before or after any step, then a restart (a new hub on
// the same folder) and the end run again: each step is logged once and the work behind it is done once.
for (const step of ['report', 'commit', 'push', 'pr', 'card']) {
  for (const when of ['before', 'after']) {
    test(`forced restart ${when} the ${step} step: the end carries on and every step is done once`, async () => {
      const W = world();
      W.end.hook = (w, s) => { if (w === when && s === step) throw new Error(`crash ${when} ${step}`); };
      const warn = console.warn; console.warn = () => { };
      await assert.rejects(W.end.run(W.p, W.id), /crash/);
      console.warn = warn;
      assert.equal(W.ex.state().phase, 'stopped');
      const { hub2, p2 } = restart(W.env);
      hub2.expeditionEnd.deskFactory = () => fakeDesk(W.calls);
      assert.equal(hub2.expeditionOf(p2, W.id).state().phase, 'stopped', 'the log says where it was');
      await hub2.expeditionEnd.run(p2, W.id);
      await hub2.expeditionEnd.run(p2, W.id);   // and a third time for good measure
      for (const s of END_STEPS.filter(s => s !== 'summary')) assert.equal(stepCount(p2, W.id, s), 1, `${s} logged once`);
      assert.equal(count(p2, W.id, 'expedition_finished'), 1, 'one finished card');
      assert.deepEqual(W.calls.map(c => c[0]), ['commit', 'push', 'pr'], 'each desk operation once');
      assert.equal(hub2.expeditionOf(p2, W.id).summaryDue(), true);
      assert.equal(count(p2, W.id, 'expedition_note', e => e.kind === 'summary-go'), 1, 'the Lead is told once');
    });
  }
}

test('a desk failure is a result, not a crash: the step logs ok:false, the end goes on, the card says what is missing', async () => {
  const W = world({ fail: { push: 'could not resolve host github.com' } });
  await W.end.run(W.p, W.id);
  assert.deepEqual([W.ex.stepEvent('commit').ok, W.ex.stepEvent('push').ok, W.ex.stepEvent('push').error, W.ex.stepEvent('pr').ok, W.ex.stepEvent('pr').skipped], [true, false, 'could not resolve host github.com', false, true]);
  const f = W.ex.state().finished;
  assert.deepEqual([f.pushed, f.pr], [false, null]);
  assert.match(f.problem, /^Not pushed: could not resolve host github\.com\. The commit is on expedition\/.* push it yourself\.$/);
  assert.deepEqual(W.calls.map(c => c[0]), ['commit', 'push'], 'no pull request without a push');
  assert.equal(W.ex.summaryDue(), true, 'the sequence is finite: the Lead may still report');
  const C = world({ fail: { commit: 'not a git repository' } });
  await C.end.run(C.p, C.id);
  assert.match(C.ex.state().finished.problem, /^The branch was not made: not a git repository\./);
  assert.deepEqual(C.calls.map(c => c[0]), ['commit']);
});

test('nothing merges: the desk has no merge, the pull request is a draft, and the end never calls one', async () => {
  const W = world();
  await W.end.run(W.p, W.id);
  assert.equal(typeof ExpeditionDesk.prototype.merge, 'undefined');
  assert.ok(W.calls.every(c => !/merge/i.test(c.join(' ')) || c[0] === 'pr'), 'the only mention is the report\'s own words');
  assert.match(W.calls.find(c => c[0] === 'pr')[2], /The expedition never merges/);
});

// ---------- when is it time ----------
test('due: a Lead\'s own stop waits for report_ready and the end of the Lead\'s turn; a hub stop waits for the end of the final turn', () => {
  const W = world();
  assert.equal(W.end.due(W.p, W.id), null, 'passed, but the Lead has not said the report is ready');
  W.ex.note('report ready', { kind: 'report-ready' });
  W.lead.state = 'working';
  assert.equal(W.end.due(W.p, W.id), null, 'ready, but its turn is still going');
  W.lead.state = 'idle';
  assert.equal(W.end.due(W.p, W.id), 'report ready');
  // A hub stop: its final message must have been sent and that turn must have ended.
  const H = world({ reason: 'time' });
  assert.equal(H.end.due(H.p, H.id), null, 'the stop sequence has not sent its final message yet');
  H.ex.note('final', { kind: 'final', reason: 'time' });
  assert.equal(H.end.due(H.p, H.id), null, 'sent, but no turn has ended since');
  H.p.log.append('agent_busy', { agent: H.lead.name, busy: true });
  assert.equal(H.end.due(H.p, H.id), null, 'the final turn is running (the log says so, as after a restart)');
  H.p.log.append('agent_busy', { agent: H.lead.name, busy: false });
  assert.equal(H.end.due(H.p, H.id), 'final turn over');
  // Nobody answers for an hour: the hub ends it anyway. No Lead left: the files are all there is.
  const S = world();
  assert.equal(S.end.due(S.p, S.id, Date.parse(S.ex.state().stopped.ts) + END_WAIT_MS - 1000), null);
  assert.equal(S.end.due(S.p, S.id, Date.parse(S.ex.state().stopped.ts) + END_WAIT_MS + 1000), 'stale');
  S.hub.finishRetire(S.p, S.lead);
  assert.equal(S.end.due(S.p, S.id), 'no lead');
});

test('the watchdog\'s check starts the end that is due; the Lead\'s turn ending does the same', async () => {
  const W = world();
  W.ex.note('report ready', { kind: 'report-ready' });
  W.hub.expeditionWatch.check();
  assert.equal(W.end.running.size, 1);
  await W.end.settled();
  assert.equal(W.ex.hasStep('card'), true);
  const V = world();
  V.ex.note('report ready', { kind: 'report-ready' });
  V.hub.onIdle(V.p, V.lead);
  await V.end.settled();
  assert.equal(V.ex.hasStep('card'), true);
  // Not due: nothing starts.
  const N = world();
  N.hub.expeditionWatch.check();
  assert.equal(N.end.running.size, 0);
});

// ---------- the summary, and everyone retires ----------
test('the Lead sends its one summary: the orchestrator gets exactly one message; then every expedition agent retires, the Lead too', async () => {
  const W = world();
  W.ex.note('report ready', { kind: 'report-ready' });
  await W.end.run(W.p, W.id);
  assert.equal(W.hub.upwardOf(W.p, W.lead).to, 'orchestrator');
  W.hub.postSummary(W.p, W.lead, summary({ done: ['Report written'], next_step: 'Read it' }));
  assert.equal(sent.filter(([n]) => n === W.env.orch.name).length, 1);
  assert.equal(W.ex.state().phase, 'ended');
  // Still live: the Lead's turn is not over (the post_summary call is inside it).
  W.lead.state = 'working';
  assert.deepEqual(W.end.consider(W.p, W.id), []);
  assert.notEqual(W.lead.state, 'retired');
  W.lead.state = 'idle';
  W.hub.onIdle(W.p, W.lead);
  assert.equal([...W.p.agents.values()].filter(a => a.expedition === W.id && a.state !== 'retired').length, 0, 'every expedition agent is retired');
  assert.deepEqual(W.end.consider(W.p, W.id), [], 'and nothing more happens');
  assert.equal(sent.filter(([n]) => n === W.env.orch.name).length, 1, 'still the one message');
});

test('a Lead that ends its turn without sending the summary has it posted by the hub, once', async () => {
  const W = world();
  W.ex.note('report ready', { kind: 'report-ready' });
  await W.end.run(W.p, W.id);
  W.lead.state = 'idle';
  assert.deepEqual(W.end.consider(W.p, W.id), [], 'its turn after the go-ahead has not ended yet');
  W.p.log.append('agent_busy', { agent: W.lead.name, busy: true });
  W.p.log.append('agent_busy', { agent: W.lead.name, busy: false });
  assert.deepEqual(W.end.consider(W.p, W.id).map(d => d.did), ['summary']);
  const to = sent.filter(([n]) => n === W.env.orch.name);
  assert.equal(to.length, 1);
  assert.match(to[0][1], /^\[Summary from lead exp-lead\]\nDone:\n- Expedition finished \(passed\): Use library A/);
  assert.match(to[0][1], /Posted by the hub: the Lead did not send its own/);
  assert.equal(W.ex.state().phase, 'ended');
  assert.deepEqual(W.end.consider(W.p, W.id).map(d => d.did), ['retire']);
  assert.deepEqual(W.end.consider(W.p, W.id), []);
  assert.equal(sent.filter(([n]) => n === W.env.orch.name).length, 1);
});

test('the invariant holds through the real end: the orchestrator hears once, at the end; one finished card; no question card', async () => {
  const W = world();
  W.ex.note('report ready', { kind: 'report-ready' });
  await W.end.run(W.p, W.id);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(quietProblems(W.env, W.mark, sent), []);
  W.hub.postSummary(W.p, W.lead, summary({ done: ['x'] }));
  assert.deepEqual(quietProblems(W.env, W.mark, sent.filter(([n]) => n !== W.env.orch.name)), []);
});

// ---------- M049 carry-overs ----------
test('M049 6: a hub stop checks test/ at the finish too, restores it, and the report says so', async () => {
  const W = world({ reason: 'Matt' });
  writeFileSync(join(W.ex.root, 'test', 'CHECKLIST.md'), '1. Everything passes (weakened).\n');
  await W.end.run(W.p, W.id);
  const i = W.p.log.ofType('expedition_integrity').filter(e => e.at === 'finish');
  assert.deepEqual(i.map(e => [e.restored, e.changed]), [[true, ['CHECKLIST.md (changed)']]]);
  assert.equal(readFileSync(join(W.ex.root, 'test', 'CHECKLIST.md'), 'utf8').includes('weakened'), false);
  assert.equal(W.ex.stepEvent('report').integrity, 'restored');
  assert.match(W.ex.read('REPORT.md'), /Test integrity: test\/ was found changed after the freeze 2 times/);
  assert.match(W.ex.read('REPORT.md'), /- at the finish: CHECKLIST\.md \(changed\); restored from the stored copy\./);
});

test('the report\'s how-it-ran lists tampered loops and each integrity event, one line each', () => {
  const W = world();
  W.p.log.append('expedition_loop', { expedition: W.id, number: 3, passing: 3, progress: false, tampered: true });
  const r = howItRan(W.p.log.events, W.id);
  assert.deepEqual(r.integrity.map(i => [i.at, i.restored, i.changed]), [['loop', true, ['CHECKLIST.md (changed)']]]);
  assert.equal(r.loops.at(-1).tampered, true);
  const md = howItRanMarkdown(r);
  assert.match(md, /3 \(3 passing, test\/ was changed: a Verifier FAIL\)/);
  assert.match(md, /Test integrity: test\/ was found changed after the freeze 1 time; 1 loop was counted as a Verifier FAIL because of it\.\n- at the loop: CHECKLIST\.md \(changed\); restored from the stored copy\./);
  assert.match(md, /upper-bound estimate that each result replaces \(memo M046\)/);
});

test('M049 5: after a restart a hub stop with no final message yet leaves its agents asleep (the watchdog\'s message wakes the Lead); once sent, a Lead that was working resumes', () => {
  const W = world({ reason: 'time' });
  W.p.log.append('agent_busy', { agent: W.lead.name, busy: true });
  const { hub2, p2 } = restart(W.env);
  assert.deepEqual(hub2.resumePlan(p2).map(r => r.agent), [], 'no resume message: it would be a second message after the final one');
  W.ex.note('final', { kind: 'final', reason: 'time' });
  const { hub2: hub3, p2: p3 } = restart(W.env);
  assert.ok(hub3.resumePlan(p3).some(r => r.agent === W.lead.name), 'the final message was sent: the interrupted turn resumes as any other');
  // An ordinary, plain agent is never held back.
  const plain = hub3.startWorker(p3, 'plain', 'Build it', 'you', 'x');
  p3.log.append('agent_busy', { agent: plain.name, busy: true });
  assert.ok(hub3.resumePlan(p3).some(r => r.agent === 'plain'));
});

test('M049 1: after the summary the expedition stays current (state, handoff facts) until every agent has retired, then it is a past one', async () => {
  const W = world();
  W.ex.note('report ready', { kind: 'report-ready' });
  await W.end.run(W.p, W.id);
  W.hub.postSummary(W.p, W.lead, summary({ done: ['x'] }));
  assert.equal(W.ex.state().phase, 'ended');
  const view = () => W.hub.state()[0].expedition;
  assert.deepEqual([view().current.id, view().current.phase, view().current.liveAgents, view().current.lead], [W.id, 'ended', 1, W.lead.name]);
  assert.deepEqual(view().current.steps, ['report', 'commit', 'push', 'pr', 'card', 'summary']);
  assert.equal(view().past.length, 1, 'it is also in the past list');
  assert.match(W.hub.handoffFacts(W.p, W.env.orch).text ?? JSON.stringify(W.hub.handoffFacts(W.p, W.env.orch)), /expedition .* ended, 1 agent still retiring/);
  W.lead.state = 'idle';
  W.hub.onIdle(W.p, W.lead);
  assert.equal(view().current, null);
  assert.deepEqual(view().past.map(x => [x.id, x.answer, x.stopReason, x.pr.number, x.pushed, x.loops, x.passing]), [[W.id, 'Use library A: it is faster and smaller.', 'passed', 7, true, 2, 3]]);
});

// ---------- the report's own functions ----------
test('the report: the Lead\'s text is kept, the generated part is cut and replaced (never doubled), claims are read from the verdict', () => {
  const W = world();
  const base = { events: W.p.log.events, id: W.id, question: 'Which is faster?', hubStop: false };
  const a = assembleReport({ ...base, leadText: REPORT, claims: 'not checked' });
  const b = assembleReport({ ...base, leadText: a, claims: 'checked' });
  assert.equal(b.split(GENERATED_MARK).length, 2);
  assert.match(b, /The Verifier's claims pass ran/);
  assert.doesNotMatch(b, /Claims not checked/);
  assert.ok(b.startsWith(REPORT.trimEnd()));
  const none = assembleReport({ ...base, leadText: null, claims: 'not checked', hubStop: true });
  assert.match(none, /^# Report\n\n<!-- hub-generated/);
  assert.match(none, /The Lead did not write REPORT\.md/);
  assert.match(none, /Claims not checked: the hub stopped the expedition before the Verifier finished its claims pass/);
  assert.equal(answerLine('# R\n\n## 1. Answer\n\n**Adopt GPU marching cubes first.**\n'), 'Adopt GPU marching cubes first.');
  assert.equal(answerLine('# R\n## Answer\n## Findings\nx'), null);
  assert.equal(answerLine('no heading'), null);
  assert.match(proposalsOf(W.p.log.events, W.id, 'Which is faster?')[0].brief, /^Follow-up to expedition .* \("Which is faster\?"\)\.\n\nQuestion: Compare a third library\n\nWhy it was parked there: outside the brief/);
  assert.deepEqual(proposalsOf(W.p.log.events, W.id).map(x => x.text), ['Compare a third library'], 'a refused request and a held lesson are not proposals');
});

test('the finished card is a notice with no part of the report: kind, a short title and the card id only', () => {
  const [c] = cardsFor({ type: 'expedition_finished', project: 'proj', expedition: '20261116-x', answer: 'secret answer', title: 'Expedition finished: secret answer' });
  assert.deepEqual(c, { kind: 'expedition', card: 'expedition:20261116-x', project: 'proj', thread: 'orchestrator', title: 'Expedition finished', body: 'proj' });
  assert.deepEqual(cardsFor({ type: 'expedition_step', project: 'proj', expedition: 'x', step: 'card' }), []);
});

// ---------- the real desk, on a real git repo with a bare remote and a fake gh ----------
function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function repoWithRemote() {
  const root = makeTmp('crux-desk-');
  const remote = join(root, 'remote.git'), dir = join(root, 'proj');
  mkdirSync(remote); git(['init', '-q', '--bare', '-b', 'main'], remote);
  mkdirSync(dir); git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 't@example.com'], dir); git(['config', 'user.name', 'Test'], dir);
  writeFileSync(join(dir, 'README.md'), '# proj\n'); mkdirSync(join(dir, '.crux'));
  git(['add', 'README.md'], dir); git(['commit', '-q', '-m', 'start'], dir);
  git(['remote', 'add', 'origin', remote], dir); git(['push', '-q', '-u', 'origin', 'main'], dir);
  return { root, remote, dir };
}

test('the desk: a worktree on expedition/<id>, the report and the build in one commit, a push, a DRAFT pull request, all safe to repeat, no merge', async () => {
  const { remote, dir } = repoWithRemote();
  const p = { dir, name: 'proj', log: { events: [] } };
  const ex = new Expedition(p, '20261116-which-is-faster').init();
  ex.write('REPORT.md', REPORT);
  const gh = []; let open = [];
  const fakeGh = async args => {
    gh.push(args);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(open);
    if (args[0] === 'pr' && args[1] === 'create') { open = [{ number: 12, url: 'https://github.com/o/r/pull/12', isDraft: true }]; return 'https://github.com/o/r/pull/12\n'; }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const desk = new ExpeditionDesk({ ex, gh: fakeGh });
  const first = await desk.commit('Expedition x: answer');
  assert.equal(first.already, false);
  assert.ok(existsSync(join(ex.worktree, 'docs', 'expeditions', ex.id, 'REPORT.md')), 'the report is on the branch');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], ex.worktree), `expedition/${ex.id}`);
  assert.equal(git(['branch', '--show-current'], dir), 'main', 'the main folder is untouched (C005)');
  assert.equal(git(['status', '--porcelain'], dir).includes('docs/expeditions'), false);
  // The Builder's work in the worktree goes in the same commit when there is more to commit.
  writeFileSync(join(ex.worktree, 'bench.mjs'), 'console.log(1)\n');
  const second = await desk.commit('Expedition x: answer, build');
  assert.equal(second.already, false);
  assert.match(git(['show', '--stat', '--format=%s', 'HEAD'], ex.worktree), /bench\.mjs/);
  const third = await desk.commit('again');
  assert.deepEqual([third.already, third.commit], [true, second.commit], 'nothing new: the commit that is there');
  assert.deepEqual(await desk.push(), { ok: true, local: false });
  assert.deepEqual(await desk.push(), { ok: true, local: false }, 'a push of the same commits is a no-op');
  assert.equal(git(['rev-parse', `expedition/${ex.id}`], remote), git(['rev-parse', 'HEAD'], ex.worktree), 'the branch is on the remote');
  const pr1 = await desk.pr({ title: 'T', body: 'B' });
  assert.deepEqual([pr1.url, pr1.number, pr1.draft, pr1.existed], ['https://github.com/o/r/pull/12', 12, true, false]);
  const pr2 = await desk.pr({ title: 'T', body: 'B' });
  assert.equal(pr2.existed, true, 'a second call finds the pull request by its branch');
  const creates = gh.filter(a => a[1] === 'create');
  assert.equal(creates.length, 1);
  assert.ok(creates[0].includes('--draft') && creates[0].includes(`expedition/${ex.id}`) && creates[0][creates[0].indexOf('--base') + 1] === 'main');
  assert.ok(gh.every(a => !a.includes('merge')), 'gh is never asked to merge');
  // A test hub commits but never pushes or opens a pull request.
  const local = new ExpeditionDesk({ ex, gh: fakeGh, local: true });
  assert.deepEqual(await local.push(), { ok: false, local: true });
  assert.deepEqual(await local.pr({ title: 'T', body: 'B' }), { ok: false, local: true });
});

test('the desk: a project that is not a git repository says so, so the end logs it and goes on', async () => {
  const root = makeTmp('crux-desk-');
  const p = { dir: root, name: 'proj', log: { events: [] } };
  const ex = new Expedition(p, '20261116-x').init();
  ex.write('REPORT.md', REPORT);
  await assert.rejects(new ExpeditionDesk({ ex }).commit('m'), /not a git repository/);
});

test('a test hub never pushes: the hub\'s own desk is local on a test hub unless CRUX_HUB_EXPEDITION_PUSH=1; the end then logs push and PR as local', async () => {
  const W = world();
  W.end.deskFactory = null;   // the desk as the hub makes it
  assert.equal(W.end.deskFor(W.p, W.ex).local, true);
  process.env.CRUX_HUB_EXPEDITION_PUSH = '1';
  try { assert.equal(W.end.deskFor(W.p, W.ex).local, false); } finally { delete process.env.CRUX_HUB_EXPEDITION_PUSH; }
  // The step results a local desk leaves: commit (fails here: the stub project is no git repo), then nothing pushed, no pull request.
  await W.end.run(W.p, W.id);
  assert.deepEqual([W.ex.stepEvent('commit').ok, W.ex.stepEvent('push').ok, W.ex.stepEvent('pr').ok], [false, false, false]);
  assert.match(W.ex.state().finished.problem, /^The branch was not made: the project is not a git repository/);
});
