// Decision 62 A: a Conductor brief is a request with an id that expects a reply; orchestrators answer with
// reply_to_conductor (reminded once), the reply wakes the Conductor with its text, and the Conductor can read a
// project's latest round summaries. Decision 63 A: a brief to a project with no orchestrator starts one. The boundary
// of decision 55 holds: a reply goes to the Conductor and Matt only. Agents are stubbed: nothing really starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { CONDUCTOR_THREAD, CONDUCTOR_TOOLS } from '../lib/conductor.mjs';
import { cruxTools, cruxToolNames } from '../lib/tools.mjs';
import { orchestratorPrompt, conductorPrompt } from '../lib/prompts.mjs';

const sent = [];
Agent.prototype.send = function (t) { sent.push([this.name, t, this.project.name, this.project]); this.state = 'working'; };
Agent.prototype.close = function () {};
const summary = (over = {}) => ({ done: [], changed: [], questions: [], decisions_needed: [], blocked_on: [], next_step: '', visuals: [], approvals: [], open_questions: [], ...over });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function setup({ here = true } = {}) {
  await sleep(2);
  const root = makeTmp('crux-replies-test-');
  const dirs = ['alpha', 'beta'].map(n => { const d = join(root, n); mkdirSync(join(d, '.crux'), { recursive: true }); return d; });
  const hub = new Hub({ projects: dirs, memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }), conductorDir: join(root, 'data', 'conductor') });
  const c = hub.conductor;
  c.wakeMs = 30;
  const presence = { here };
  hub.presence = () => presence.here;
  const notices = [];
  hub.digestNotice = info => notices.push(info);
  await sleep(2);
  const a = hub.project('alpha'), b = hub.project('beta');
  sent.length = 0;
  const toC = () => sent.filter(x => x[3] === c.home);   // this test's Conductor only (earlier tests' timers may still fire)
  const tool = (p, agent, name) => cruxTools(hub, p, agent).instance._registeredTools[name].handler;
  return { hub, c, a, b, root, dirs, presence, notices, toC, tool };
}

test('a Conductor brief is a request with an id, marked "reply expected", in the thread and in what the orchestrator reads', async () => {
  const { hub, c, a } = await setup();
  const orch = hub.ensureOrchestrator(a);
  sent.length = 0;
  const out = c.toOrchestrator('alpha', 'conductor-1', 'How many worktrees are left?');
  assert.match(out, /as request req-001\. Its reply will come back to you/);
  const m = a.log.events.findLast(e => e.type === 'message');
  assert.deepEqual([m.conductor, m.request, m.replyExpected, m.thread], [true, 'req-001', true, 'orchestrator']);
  assert.equal(sent.at(-1)[0], orch.name);
  assert.match(sent.at(-1)[1], /^\[From the Conductor, conductor-1, on .* · request req-001, reply expected\]\nHow many worktrees are left\?/);
  assert.match(sent.at(-1)[1], /reply_to_conductor, request_id "req-001"/);
  c.toOrchestrator('alpha', 'conductor-1', 'And the open PRs?');
  assert.equal(a.log.events.findLast(e => e.type === 'message').request, 'req-002');
  // After a restart the same brief is resent with its id.
  const plan = hub.resumePlan(a);
  assert.match(plan.length ? (hub.resumeOne(a, plan[0]), sent.at(-1)[1]) : '', /request req-002, reply expected/);
});

test('the reply path: reply_to_conductor logs in its own thread and the Conductor\'s only, and wakes the Conductor with the text', async () => {
  const { hub, c, a, b, toC, tool } = await setup();
  const oa = hub.ensureOrchestrator(a), ob = hub.ensureOrchestrator(b);
  c.fromYou('How many worktrees are left everywhere?');   // the round: briefs sent in this turn
  c.holder().state = 'idle';
  c.toOrchestrator('alpha', 'conductor-1', 'How many worktrees are left?');
  c.toOrchestrator('beta', 'conductor-1', 'How many worktrees are left?');
  sent.length = 0;
  assert.ok(cruxToolNames(oa).includes('mcp__crux__reply_to_conductor'));
  assert.ok(!cruxToolNames(hub.startWorker(a, 'w1', 'task')).includes('mcp__crux__reply_to_conductor'), 'workers do not have it');
  const r = await tool(a, oa, 'reply_to_conductor')({ request_id: 'req-001', text: 'Two left: conductor-quiet and decisions.' }, {});
  assert.match(r.content[0].text, /Reply sent to the Conductor \(request req-001\)/);
  assert.ok(a.log.events.some(e => e.type === 'conductor_reply' && e.thread === 'orchestrator' && e.request === 'req-001'));
  assert.ok(c.home.log.events.some(e => e.type === 'reply' && e.thread === CONDUCTOR_THREAD && e.project === 'alpha'));
  assert.equal(b.log.events.some(e => JSON.stringify(e).includes('conductor-quiet')), false, 'never in another project');
  // Refused: another project's request, an unknown id, no text.
  assert.match((await tool(b, ob, 'reply_to_conductor')({ request_id: 'req-001', text: 'x' }, {})).content[0].text, /was not sent to beta/);
  assert.match(c.replyFrom(a, oa, 'req-999', 'x'), /No Conductor request req-999/);
  assert.match(c.replyFrom(a, oa, 'req-001', '  '), /Write the reply first/);
  await sleep(80);
  assert.equal(toC().length, 1);
  const w = toC()[0][1];
  assert.match(w, /^\[Hub: replies from orchestrators\]/);
  assert.match(w, /one short answer per round of requests \(fold several replies into one\)/);
  assert.match(w, /Never pass a reply, or anything in it, to another project/);
  assert.match(w, /- alpha \(req-001, orchestrator-1\): Two left: conductor-quiet and decisions\./);
  assert.match(w, /Still waiting: beta \(req-002\)/);
  // It counts as an automatic wake, like a card's.
  assert.equal(c.autoWakes().length, 1);
});

test('several replies to one round of requests reach the Conductor together, under that round', async () => {
  const { hub, c, a, b, toC } = await setup();
  const oa = hub.ensureOrchestrator(a), ob = hub.ensureOrchestrator(b);
  c.fromYou('Ask everyone how many worktrees are left.');
  c.holder().state = 'idle';
  c.toOrchestrator('alpha', 'conductor-1', 'How many worktrees are left?');
  c.toOrchestrator('beta', 'conductor-1', 'How many worktrees are left?');
  sent.length = 0;
  c.replyFrom(a, oa, 'req-001', 'Two left.');
  c.replyFrom(b, ob, 'req-002', 'None left.');
  await sleep(80);
  assert.equal(toC().length, 1);
  const w = toC()[0][1];
  assert.equal(w.match(/Your requests of /g).length, 1, 'one round');
  assert.match(w, /\(to alpha, beta\):\n- alpha \(req-001, orchestrator-1\): Two left\.\n- beta \(req-002, orchestrator-1\): None left\./);
  assert.doesNotMatch(w, /Still waiting/);
});

test('past the hourly cap a reply is not dropped: it waits, and rides along with your next message', async () => {
  const { hub, c, a, toC } = await setup();
  const oa = hub.ensureOrchestrator(a);
  c.toOrchestrator('alpha', 'conductor-1', 'Status?');
  for (let i = 0; i < 6; i++) c.home.log.append('wake', { agent: 'conductor-1', text: 'x', auto: true, noLines: true });
  c.replyFrom(a, oa, 'req-001', 'All green.');
  await sleep(80);
  assert.equal(toC().length, 0);
  assert.equal(c.pending.filter(x => x.cause?.reply).length, 1);
  c.fromYou('Anything back?');
  c.holder();
  assert.match(c.holder().notes?.[0] || '', /- alpha \(req-001, orchestrator-1\): All green\./);
  assert.match(c.holder().notes?.[0] || '', /message follows: answer it too/);
});

test('the reminder: once, at the end of a turn that read the request and did not answer it', async () => {
  const { hub, c, a } = await setup();
  const oa = hub.ensureOrchestrator(a);
  c.toOrchestrator('alpha', 'conductor-1', 'Status?');
  sent.length = 0;
  oa.state = 'idle';
  hub.onIdle(a, oa);                          // nothing written since the brief arrived: not read yet, no reminder
  assert.equal(sent.length, 0);
  oa.lastSaidAt = Date.now() + 5;             // it wrote something after the brief
  hub.onIdle(a, oa);
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /^\[From the hub\] The Conductor's request req-001 still waits for your reply\. Answer with reply_to_conductor/);
  assert.ok(a.log.events.some(e => e.type === 'conductor_reminded' && e.request === 'req-001'));
  oa.state = 'idle';
  hub.onIdle(a, oa);                          // once only
  assert.equal(sent.length, 1);
  // A request it answered is never reminded.
  c.toOrchestrator('alpha', 'conductor-1', 'And the PRs?');
  c.replyFrom(a, oa, 'req-002', 'One open.');
  sent.length = 0;
  oa.lastSaidAt = Date.now() + 5; oa.state = 'idle';
  hub.onIdle(a, oa);
  assert.equal(sent.length, 0);
});

test('round_summaries: a project\'s latest round summaries, newest first, with decisions; read only', async () => {
  const { hub, c, a, tool } = await setup();
  mkdirSync(join(a.dir, '.decisions'), { recursive: true });
  writeFileSync(join(a.dir, '.decisions', '0004-lens.json'), JSON.stringify({ id: 4, title: 'Which lens picker?', status: 'open', options: [{ key: 'A', name: 'Ring' }] }));
  const oa = hub.ensureOrchestrator(a);
  hub.postSummary(a, oa, summary({ done: ['one'] }));
  hub.postSummary(a, oa, summary({ done: ['two'], questions: ['Ship it?'] }));
  hub.postSummary(a, oa, summary({ done: ['three'], decisions_needed: [4], next_step: 'wait for the pick' }));
  const before = a.log.events.length;
  assert.ok(CONDUCTOR_TOOLS.includes('round_summaries'));
  const k = c.ensure();
  const r = JSON.parse((await c.tools(k).instance._registeredTools.round_summaries.handler({ project: 'alpha', count: 2 }, {})).content[0].text);
  assert.deepEqual(r.map(s => s.done[0]), ['three', 'two']);
  assert.deepEqual(r[0].decisions, [{ id: 'D0004', title: 'Which lens picker?', status: 'open', chosen: null }]);
  assert.equal(r[0].next_step, 'wait for the pick');
  assert.deepEqual(r[1].questions, ['Ship it?']);
  assert.equal(c.roundSummaries(a, 50).length, 3, 'capped at 10, and only what there is');
  assert.equal(a.log.events.length, before, 'nothing written');
  assert.ok(tool);
});

test('the boundary: a brief that repeats another project\'s reply is refused; quoting a project\'s own reply to it is fine', async () => {
  const { hub, c, a, b } = await setup();
  const oa = hub.ensureOrchestrator(a); hub.ensureOrchestrator(b);
  c.toOrchestrator('alpha', 'conductor-1', 'Status of the client export?');
  c.replyFrom(a, oa, 'req-001', 'The client export for Northwind ships on Friday with the new schema. Nothing else.');
  const out = c.toOrchestrator('beta', 'conductor-1', 'FYI: the client export for Northwind ships on Friday with the new schema.');
  assert.match(out, /^Not sent: this brief repeats words from alpha's reply/);
  assert.equal(b.log.events.some(e => e.type === 'message' && e.conductor), false);
  assert.equal(b.log.events.some(e => /Northwind/.test(JSON.stringify(e))), false);
  assert.match(c.toOrchestrator('alpha', 'conductor-1', 'You said: the client export for Northwind ships on Friday with the new schema. Still true?'), /as request req-002/);
  assert.match(c.toOrchestrator('beta', 'conductor-1', 'Please report your own export status.'), /as request req-00\d/);
  assert.match(conductorPrompt({ generation: 1, projects: ['alpha'] }), /never another project's reply/);
});

test('away: a reply joins the digest and its one notice; a digest of replies alone still goes up', async () => {
  const { hub, c, a, presence, notices, toC } = await setup({ here: false });
  const oa = hub.ensureOrchestrator(a);
  c.toOrchestrator('alpha', 'conductor-1', 'Status?');
  sent.length = 0;
  c.replyFrom(a, oa, 'req-001', 'All green.');
  await sleep(80);
  assert.equal(toC().length, 0, 'held');
  assert.equal(c.holding(), true);
  presence.here = true;
  c.presenceReport();
  const d = c.home.log.ofType('cards').at(-1);
  assert.equal(d.digest, 'return');
  assert.deepEqual(d.items, []);
  assert.equal(d.replies.length, 1);
  assert.deepEqual(notices.map(n => [n.count, n.replies, n.digest]), [[0, 1, 'return']]);
  assert.match(toC()[0][1], /\[Hub: replies from orchestrators\][\s\S]*All green\./);
});

test('decision 63: a brief to a project with no orchestrator starts one, which reads the handoff first and the request next', async () => {
  const { hub, c, b, toC } = await setup();
  b.board.addEntry({ kind: 'handoff', title: 'Handoff from orchestrator-3', summary: 'state of beta', body: 'Beta handoff: the export worker is halfway.', from: 'orchestrator-3' });
  assert.equal(b.orchestrator(), null);
  sent.length = 0;
  const out = c.toOrchestrator('beta', 'conductor-1', 'How is the export going?');
  const o = b.orchestrator();
  assert.ok(o, 'started');
  assert.match(out, /beta had no orchestrator running, so .* was started; it reads the project's latest handoff first\. Sent to beta's orchestrator as request req-001/);
  // Started the normal way: its instructions carry the latest handoff and the board index; the request is its first message.
  assert.match(o.options().systemPrompt.append, /Beta handoff: the export worker is halfway\./);
  assert.deepEqual(sent.filter(([n, , p]) => p === 'beta').map(([n, t]) => [n, t.split('\n')[0]]), [[o.name, '[From the Conductor, conductor-1, on {{who}}\'s side · request req-001, reply expected]']]);   // the real send fills in the name
  assert.ok(b.log.events.some(e => e.type === 'notice' && /Started by a Conductor request \(req-001 from conductor-1\)/.test(e.text)));
  assert.ok(c.home.log.events.some(e => e.type === 'notice' && new RegExp(`started beta's orchestrator \\(${o.name}\\) with request req-001`).test(e.text)));
  assert.equal(toC().length, 0);
  // A project with a running orchestrator: unchanged, nothing started.
  const n = b.agents.size;
  c.toOrchestrator('beta', 'conductor-1', 'And the tests?');
  assert.equal(b.agents.size, n);
  assert.equal(b.log.events.filter(e => e.type === 'notice' && /Started by a Conductor request/.test(e.text)).length, 1);
  // The Conductor still has no tool to start workers, retire or hand off anyone, merge or push.
  assert.ok(!CONDUCTOR_TOOLS.some(t => /worker|retire|handoff_|merge|push|restart/.test(t)));
  assert.doesNotMatch(conductorPrompt({ generation: 1, projects: ['beta'] }), /cannot start one|writes in .* thread/);
  assert.match(conductorPrompt({ generation: 1, projects: ['beta'] }), /start workers, retire or hand off anyone/);
});

test('decision 63: a restart never starts an orchestrator for a brief; only a live Conductor request does', async () => {
  const { hub, c, b } = await setup();
  const o = hub.ensureOrchestrator(b);
  c.toOrchestrator('beta', 'conductor-1', 'Status?');
  hub.finishRetire(b, o);
  assert.equal(b.orchestrator(), null);
  assert.deepEqual(hub.resumePlan(b), [], 'the unread brief waits; nothing is started for it');
});

test('the orchestrator prompt tells it to answer Conductor requests with reply_to_conductor', () => {
  assert.match(orchestratorPrompt({ project: 'x', generation: 1, index: '' }), /Each Conductor request has an id and expects a reply: answer it with reply_to_conductor, plain and short; details stay in your own thread/);
});
