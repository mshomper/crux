// Handoffs that lose nothing and cost little (decisions 16 and 37): Matt's approvals, git state, last instructions,
// open questions, the rolling draft, retiring without waking the agent, the idle handoff, tidy-ups, and workers.
// Agents are stubbed and git is a fake, so nothing starts and nothing reaches GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../lib/agent.mjs';
import { Hub, DRAFT_FRESH_MS } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings, SETTING_DEFAULTS } from '../lib/settings.mjs';
import { RETIRE_MESSAGE, orchestratorPrompt } from '../lib/prompts.mjs';
import { looksLikeInstruction, gitState, prReadiness, tidyUps } from '../lib/handoff-facts.mjs';

const sent = [];
Agent.prototype.send = function (t) { sent.push([this.name, t]); this.state = 'working'; };
Agent.prototype.close = function () {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

let DIR;
function fakeRun(cmd, args, cwd) {
  const a = args.join(' ');
  if (a.startsWith('worktree list')) return `worktree ${DIR}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${DIR}/.claude/worktrees/x\nHEAD def\nbranch refs/heads/feat/x\n\n`;
  if (a === 'status --porcelain') return cwd === DIR ? '' : ' M hub/lib/a.mjs\n?? new.txt\n';
  if (a === 'rev-parse HEAD') return 'abc\n';
  if (a.startsWith('ls-remote')) return 'abc\trefs/heads/main\n';
  if (a.startsWith('pr list')) return JSON.stringify([{ number: 31, title: 'Handoff plus', headRefName: 'feat/x', isDraft: false }, { number: 32, title: 'Other', headRefName: 'feat/y', isDraft: true }]);
  throw new Error(`unexpected ${cmd} ${a}`);
}

function setup(events = [], settings = {}) {
  const root = mkdtempSync(join(tmpdir(), 'crux-hub-test-'));
  const dir = DIR = join(root, 'proj');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  if (events.length) writeFileSync(join(dir, '.crux', 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null, initial: settings }) });
  hub.run = fakeRun;
  return { hub, p: hub.project('proj') };
}
const ago = min => new Date(Date.now() - min * 60000).toISOString();
const ev = (type, min, extra) => ({ id: `${type}-${Math.random()}`, ts: ago(min), type, ...extra });
const summary = (over = {}) => ({ done: [], changed: [], questions: [], decisions_needed: [], blocked_on: [], next_step: '', visuals: [], approvals: [], open_questions: [], ...over });
const NOTES = { in_flight: ['w1 builds the header fix, because Matt asked'], promises: ['merge #31 after the click-test'], risks: ['none'], next_steps: ['Review w1'] };

test('1. approvals and instructions from you are kept whole, with Needs-you answers and noted ones', async () => {
  const { hub, p } = setup();
  const o = hub.ensureOrchestrator(p);
  hub.fromYou(p, 'orchestrator', 'An old OK from before the last handoff');
  await sleep(5);
  p.board.addEntry({ kind: 'handoff', title: 'Handoff from orchestrator-0', summary: 'x', body: 'x', from: 'orchestrator-0', role: 'orchestrator' });
  await sleep(5);
  const long = 'Merge #31 once the combined check passes. ' + 'Keep w1 around until I have reviewed it on main. '.repeat(12);
  hub.fromYou(p, 'orchestrator', long);
  hub.fromYou(p, 'orchestrator', 'what time is it?');
  hub.fromYou(p, 'orchestrator', 'B');
  const w = hub.startWorker(p, 'w1', 'Do a thing', o.name, 'A thing');
  hub.postSummary(p, w, summary({ questions: ['Which colour?'] }));
  const asked = p.log.ofType('summary').at(-1);
  hub.answerQuestions(p, asked.id, [{ index: 0, text: 'Amber' }]);
  hub.postSummary(p, o, summary({ approvals: ['Matt: settings idle window 60 minutes'] }));
  const f = hub.handoffFacts(p, o);
  assert.match(f, /Standing approvals and instructions from \{\{who\}\} \(since handoff H001/);
  assert.doesNotMatch(f, /An old OK/, 'only since the last handoff');
  assert.doesNotMatch(f, /what time is it/, 'a plain question is not an instruction');
  assert.match(f, /\] B$/m, 'a pick typed in chat counts');
  const line = f.split('\n').find(l => l.includes('Merge #31'));
  assert.ok(line.length > 380 && line.length < 470, `kept whole up to about 400 characters (${line.length})`);
  assert.match(f, /answered in Needs you, in w1's thread\] > Which colour\?/);
  assert.match(f, /noted by orchestrator-1\] Matt: settings idle window/);
  assert.match(f, /Earlier ones are in handoff H001/);
  assert.ok(looksLikeInstruction('OK to push it?') && !looksLikeInstruction('how is it going?'));
});

test('2. git state: main folder, open PRs with readiness and your approval, worktrees', () => {
  const { hub, p } = setup();
  const o = hub.ensureOrchestrator(p);
  const w = hub.startWorker(p, 'w1', 'Build it', o.name, 'Build it');
  hub.postSummary(p, w, summary({ done: ['Opened PR #31, ready for your click-test'] }));
  hub.fromYou(p, 'orchestrator', 'merge #31 please');
  hub.fromYou(p, 'orchestrator', "don't merge #32 yet");
  const f = hub.handoffFacts(p, o);
  assert.match(f, /Main folder: on main, clean, up to date with GitHub/);
  assert.match(f, /#31 Handoff plus \(feat\/x\): ready per w1's last summary; approved by \{\{who\}\}: yes/);
  assert.match(f, /#32 Other \(feat\/y, draft\): no worker summary names it; approved by \{\{who\}\}: no/);
  assert.match(f, /worktrees[\\/]x on feat\/x, dirty \(2\)/);
  // Not a repo, no GitHub CLI: said plainly, never thrown.
  const g = gitState('C:/nowhere', () => { throw Object.assign(new Error('fatal: not a git repository'), { code: 128 }); });
  assert.match(g.errors[0], /not a git folder/);
  const noGh = gitState(DIR, (cmd, args, cwd) => { if (cmd !== 'git') throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); return fakeRun(cmd, args, cwd); });
  assert.equal(noGh.prs, null);
  assert.match(noGh.errors.join(), /GitHub CLI not found/);
  assert.match(prReadiness({ number: 9, branch: 'feat/z' }, [{ from: 'w2', done: ['pushed feat/z'], blocked_on: ['tests fail'] }]), /not ready per w2/);
});

test('3. each worker shows the orchestrator\'s last instruction next to its last summary', () => {
  const { hub, p } = setup();
  const o = hub.ensureOrchestrator(p);
  const w = hub.startWorker(p, 'w1', 'Build it', o.name, 'Build it');
  hub.postSummary(p, w, summary({ done: ['Built it'], next_step: 'Wait for review' }));
  hub.orchestratorToWorker(p, o, 'w1', 'Fix the header spacing next. ' + 'x'.repeat(400));
  const f = hub.handoffFacts(p, o);
  const line = f.split('\n').find(l => l.startsWith('- w1'));
  assert.match(line, /Last summary \([^)]+\): Wait for review/);
  assert.match(line, /Last instruction from orchestrator-1 \([^)]+\): "Fix the header spacing next\. x+…"/);
  assert.ok(line.length < 600, 'the instruction is cut at about 300 characters');
});

test('4. questions the orchestrator asked that are still unanswered, and quick calls it tagged', () => {
  const { hub, p } = setup();
  const o = hub.ensureOrchestrator(p);
  hub.postSummary(p, o, summary({ questions: ['Merge #31 now?', 'Retire w1 too?'], open_questions: ['Which of A or B for the strip?'] }));
  const asked = p.log.ofType('summary').at(-1);
  hub.answerQuestions(p, asked.id, [{ index: 0, text: 'Yes' }]);
  const f = hub.handoffFacts(p, o);
  const block = f.split('Questions still waiting on {{who}}:')[1].split('\n').filter(l => l.startsWith('- '));
  assert.ok(!block.some(l => l.includes('Merge #31 now?')), 'answered from Needs you');
  assert.ok(block.some(l => l.startsWith('- Retire w1 too?')));
  assert.ok(block.some(l => /Which of A or B for the strip\? \(put in chat/.test(l)));
});

test('5. the judgement may run to 700 words', () => {
  assert.match(RETIRE_MESSAGE('orchestrator'), /under 700 words/);
  assert.doesNotMatch(RETIRE_MESSAGE('orchestrator'), /400 words/);
});

test('6. handoff_notes in a summary become the rolling draft; the orchestrator is told to fill it', () => {
  const { hub, p } = setup();
  const o = hub.ensureOrchestrator(p);
  assert.equal(hub.draftFor(p, o), null);
  hub.postSummary(p, o, summary({ handoff_notes: NOTES }));
  hub.postSummary(p, o, summary({ done: ['a round without notes'] }));
  assert.deepEqual(hub.draftFor(p, o).handoff_notes, NOTES, 'the newest notes stay the draft');
  const prompt = orchestratorPrompt({ project: 'x', generation: 1, index: '' });
  assert.match(prompt, /handoff_notes/);
  assert.match(prompt, /open_questions/);
});

test('7. a fresh draft: the handoff is published without waking the agent', () => {
  sent.length = 0;
  const { hub, p } = setup([
    ev('agent_created', 30, { agent: 'orchestrator-1', role: 'orchestrator', generation: 1, thread: 'orchestrator' }),
    ev('agent_session', 30, { agent: 'orchestrator-1', sessionId: 's1' }),
    ev('summary', 12, { thread: 'orchestrator', from: 'orchestrator-1', ...summary({ handoff_notes: NOTES }) }),
    ev('agent_busy', 11, { agent: 'orchestrator-1', busy: false, contextPct: 61 })
  ]);
  const o = p.orchestrator();
  assert.equal(hub.retire(p, o), 'draft');
  assert.ok(!sent.some(([n]) => n === 'orchestrator-1'), 'the old agent was not sent anything');
  const h = p.board.latestHandoff();
  assert.match(h.body, /rolling handoff draft of .*the agent was not woken/);
  assert.match(h.body, /w1 builds the header fix/);
  assert.match(h.body, /### Facts \(from the hub\)/);
  assert.equal(h.fromDraft, p.log.ofType('summary')[0].id);
  const succ = p.orchestrator();
  assert.equal(succ.name, 'orchestrator-2', 'asked: a successor starts, with the overlap');
  assert.equal(o.retiring, 'overlap');
  clearTimeout(o.overlapTimer);
});

test('7. Hand off pressed long after the last turn: from the draft, and no cold questions to the old holder', () => {
  sent.length = 0;
  const { hub, p } = setup([
    ev('agent_created', 600, { agent: 'orchestrator-1', role: 'orchestrator', generation: 1, thread: 'orchestrator' }),
    ev('agent_session', 600, { agent: 'orchestrator-1', sessionId: 's1' }),
    ev('summary', 500, { thread: 'orchestrator', from: 'orchestrator-1', ...summary({ handoff_notes: NOTES }) }),
    ev('agent_busy', 495, { agent: 'orchestrator-1', busy: false, contextPct: 12 })
  ]);
  assert.equal(hub.retire(p, p.orchestrator()), 'draft');
  assert.equal(p.agents.get('orchestrator-1').state, 'retired');
  assert.equal(p.orchestrator(), null);
  assert.equal(sent.length, 0);
});

test('7. a stale draft: the agent writes the handoff as before', () => {
  sent.length = 0;
  const { hub, p } = setup([
    ev('agent_created', 300, { agent: 'orchestrator-1', role: 'orchestrator', generation: 1, thread: 'orchestrator' }),
    ev('agent_session', 300, { agent: 'orchestrator-1', sessionId: 's1' }),
    ev('summary', 200, { thread: 'orchestrator', from: 'orchestrator-1', ...summary({ handoff_notes: NOTES }) }),
    ev('agent_busy', 200 - DRAFT_FRESH_MS / 60000 - 10, { agent: 'orchestrator-1', busy: false, contextPct: 61 })
  ]);
  assert.equal(hub.freshDraft(p, p.orchestrator()), null);
  assert.equal(hub.retire(p, p.orchestrator()), 'writing');
  assert.match(sent.at(-1)[1], /Call write_handoff now/);
  clearTimeout(p.agents.get('orchestrator-1').retireTimer);
});

test('7 and 8. an idle handoff from a fresh draft retires at once: no successor, no overlap, until the next message', () => {
  sent.length = 0;
  const { hub, p } = setup([
    ev('agent_created', 200, { agent: 'orchestrator-1', role: 'orchestrator', generation: 1, thread: 'orchestrator' }),
    ev('agent_session', 200, { agent: 'orchestrator-1', sessionId: 's1' }),
    ev('summary', 75, { thread: 'orchestrator', from: 'orchestrator-1', ...summary({ handoff_notes: NOTES }) }),
    ev('agent_busy', 70, { agent: 'orchestrator-1', busy: false, contextPct: 40 })
  ]);
  const o = p.agents.get('orchestrator-1');
  assert.equal(o.contextPct, 40, 'the context size comes back from the log after a restart');
  assert.deepEqual(hub.idleCheck(), ['proj']);
  assert.equal(o.state, 'retired');
  assert.equal(p.orchestrator(), null, 'no successor yet');
  assert.equal(sent.length, 0, 'nobody was woken');
  assert.ok(p.log.ofType('notice').some(n => /idle for 70 minutes at 40% of its context/.test(n.text)));
  assert.ok(p.log.ofType('notice').some(n => /next orchestrator starts from it with your next message/.test(n.text)));
  hub.fromYou(p, 'orchestrator', 'Morning');
  const next = p.orchestrator();
  assert.equal(next.name, 'orchestrator-2');
  assert.equal(next.predecessor, null, 'no ask_predecessor overlap');
});

test('8. the idle handoff waits for the window and the floor, and both are settings', () => {
  const evs = (idleMin, pct) => [
    ev('agent_created', 300, { agent: 'orchestrator-1', role: 'orchestrator', generation: 1, thread: 'orchestrator' }),
    ev('agent_session', 300, { agent: 'orchestrator-1', sessionId: 's1' }),
    ev('agent_busy', idleMin, { agent: 'orchestrator-1', busy: false, contextPct: pct })
  ];
  assert.equal(SETTING_DEFAULTS.idleHandoffMin, 60);
  assert.equal(SETTING_DEFAULTS.idleFloorPct, 25);
  assert.deepEqual(setup(evs(45, 50)).hub.idleCheck(), [], 'not idle long enough');
  assert.deepEqual(setup(evs(90, 20)).hub.idleCheck(), [], 'below the floor');
  assert.deepEqual(setup(evs(90, 50), { idleHandoffMin: 0 }).hub.idleCheck(), [], '0 turns it off');
  const low = setup(evs(90, 15), { idleFloorPct: 10 });
  assert.deepEqual(low.hub.idleCheck(), ['proj'], 'a lower floor');
  const o = low.p.agents.get('orchestrator-1');
  assert.equal(o.retiring, 'writing', 'no draft: it is woken to write the handoff, as before');
  clearTimeout(o.retireTimer);
  const { hub } = setup(evs(90, 50), { idleHandoffMin: 120 });
  assert.deepEqual(hub.idleCheck(), [], 'a longer window');
  hub.settings.set({ idleHandoffMin: 'x', idleFloorPct: 200 });
  assert.equal(hub.settings.get('idleHandoffMin'), 120, 'bad values are ignored');
  assert.equal(hub.settings.get('idleFloorPct'), 25);
});

test('8. a turn\'s end logs its context size', () => {
  const { hub, p } = setup();
  const o = hub.ensureOrchestrator(p);
  o.contextPct = 33; o.busyLogged = true;
  o.setState('idle');
  assert.equal(p.log.ofType('agent_busy').at(-1).contextPct, 33);
});

test('9. memos that later text calls done are suggested tidy-ups; a long index gets a note', () => {
  const { hub, p } = setup();
  const o = hub.ensureOrchestrator(p);
  p.board.addEntry({ kind: 'memo', title: 'Merge plan', summary: 's', body: 'Merge #10 and #11.', from: 'orchestrator-1' });
  p.board.addEntry({ kind: 'memo', title: 'Still open', summary: 's', body: 'Ideas.', from: 'orchestrator-1' });
  p.board.addEntry({ kind: 'memo', title: 'Open loops', summary: 's', body: 'In flight: M002 stays.\nDone memos that can be retired: M001 (merge plan, done).', from: 'orchestrator-1' });
  const t = tidyUps(p.board, p.log.events);
  assert.deepEqual(t.map(x => x.id), ['M001']);
  assert.match(t[0].why, /M003: "Done memos that can be retired: M001/);
  let f = hub.handoffFacts(p, o);
  assert.match(f, /Suggested tidy-ups .*\n- M001 Merge plan\./);
  assert.doesNotMatch(f, /Board index:/);
  for (let i = 0; i < 150; i++) p.board.addEntry({ kind: 'memo', title: `m${i}`, summary: 's', body: 'b', from: 'x' });
  f = hub.handoffFacts(p, o);
  assert.match(f, /Board index: \d+ lines, over 150/);
});

test('10. a worker\'s handoff facts have the same shape: approvals for it, last instruction, git', () => {
  const { hub, p } = setup();
  const o = hub.ensureOrchestrator(p);
  const w = hub.startWorker(p, 'w1', 'Build it', o.name, 'Build it');
  hub.fromYou(p, 'w1', 'Keep the header at 44 px');
  hub.fromYou(p, 'orchestrator', 'OK for w1 to push its branch');
  hub.fromYou(p, 'orchestrator', 'merge the other one');
  hub.orchestratorToWorker(p, o, 'w1', 'Push feat/x and open the PR.');
  hub.postSummary(p, w, summary({ done: ['Built it'], questions: ['Ready?'] }));
  const f = hub.handoffFacts(p, w);
  assert.match(f, /Task goal: Build it/);
  assert.match(f, /Last summary \([^)]+\): done Built it; changed nothing; asked Ready\?/);
  assert.match(f, /Last instruction from orchestrator-1 \([^)]+\): "Push feat\/x and open the PR\."/);
  assert.match(f, /\] Keep the header at 44 px/);
  assert.match(f, /\] OK for w1 to push its branch/);
  assert.doesNotMatch(f, /merge the other one/, 'only what concerns this worker');
  assert.match(f, /Git:\n- Main folder/);
  assert.match(f, /Questions still waiting on \{\{who\}\}:\n- Ready\?/);
});
