// The Conductor (decision 55 A): one hub-wide agent in the hub's state folder, woken on demand and batched, with read
// tools over every project, message_agent to orchestrators only, and no file, shell, agent, permission, merge or push
// tools, enforced in its tool list and its permission callback. Agents are stubbed: nothing starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { CONDUCTOR, CONDUCTOR_THREAD, CONDUCTOR_TOOLS, CONDUCTOR_DENIED, conductorToolNames } from '../lib/conductor.mjs';
import { orchestratorPrompt, conductorPrompt } from '../lib/prompts.mjs';
import { robot, conductorBot } from '../public/robots.js';
import * as CP from '../public/conductor-view.js';
import { composerHint } from '../public/composer-keys.js';

const sent = [];
Agent.prototype.send = function (t) { sent.push([this.name, t]); this.state = 'working'; };
Agent.prototype.close = function () {};
const summary = (over = {}) => ({ done: [], changed: [], questions: [], decisions_needed: [], blocked_on: [], next_step: '', visuals: [], approvals: [], open_questions: [], ...over });

async function setup({ projects = ['alpha', 'beta'], settings = {} } = {}) {
  await sleep(2);   // earlier hubs' start-up timers (resume after a restart) fire before this one is built
  const root = mkdtempSync(join(tmpdir(), 'crux-conductor-test-'));
  const dirs = projects.map(n => { const d = join(root, n); mkdirSync(join(d, '.crux'), { recursive: true }); return d; });
  const hub = new Hub({ projects: dirs, memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null, initial: settings }), conductorDir: join(root, 'data', 'conductor') });
  hub.conductor.wakeMs = 30;
  await sleep(2);   // and this hub's own, before the test writes anything
  sent.length = 0;
  return { hub, c: hub.conductor, root, a: hub.project('alpha'), b: hub.project(projects[1] || 'alpha') };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('lives in the hub state folder, not in a project; no Conductor unless asked for', async () => {
  const { hub, c, root } = await setup();
  c.fromYou('What waits for me?');
  assert.ok(existsSync(join(root, 'data', 'conductor', '.crux', 'events.jsonl')));
  assert.equal(hub.project('alpha').log.events.some(e => e.thread === CONDUCTOR_THREAD), false);
  assert.equal(new Hub({ projects: [], memory: new Memory(join(root, 'home2')), settings: new HubSettings({ file: null }) }).conductor, null);
});

test('your message starts conductor-1 in its own thread and reaches it at once', async () => {
  const { c } = await setup();
  c.fromYou('Brief me');
  const a = c.holder();
  assert.equal(a.name, 'conductor-1');
  assert.equal(a.role, 'conductor');
  assert.equal(a.thread, CONDUCTOR_THREAD);
  assert.deepEqual(sent.at(-1), ['conductor-1', 'Brief me']);
});

test('updates are batched: several summaries and cards within the window wake it once', async () => {
  const { hub, c, a, b } = await setup();
  const orch = hub.ensureOrchestrator(a);
  hub.postSummary(a, orch, summary({ done: ['x'], decisions_needed: [4] }));
  hub.postSummary(b, hub.ensureOrchestrator(b), summary({ questions: ['Ship it?'] }));
  b.log.append('approval', { thread: 'w1', approval: 'ap1', agent: 'w1', tool: 'Bash', input: {}, routedTo: null });
  sent.length = 0;
  await sleep(80);
  const wakes = sent.filter(([n]) => n === 'conductor-1');
  assert.equal(wakes.length, 1);
  assert.match(wakes[0][1], /\[Hub: updates/);
  assert.match(wakes[0][1], /alpha: orchestrator-1 posted a round summary/);
  assert.match(wakes[0][1], /beta: .*1 question/);
  assert.match(wakes[0][1], /beta: a permission card from w1/);
});

test('routine summaries (worker or orchestrator), a routed request and its own events do not wake it', async () => {
  const { hub, c, a } = await setup();
  const orch = hub.ensureOrchestrator(a);
  const w = hub.startWorker(a, 'w1', 'task');
  hub.postSummary(a, w, summary({ done: ['did it'] }));
  hub.postSummary(a, orch, summary({ done: ['w1 is on it'], next_step: 'review' }));
  a.log.append('approval', { thread: 'w1', approval: 'ap2', agent: 'w1', tool: 'Bash', input: {}, routedTo: 'orchestrator-1' });
  c.home.log.append('summary', { thread: CONDUCTOR_THREAD, from: 'conductor-1', ...summary() });
  await sleep(80);
  assert.equal(sent.filter(([n]) => n.startsWith('conductor')).length, 0);
});

test('no wakes from projects with the switch off, or with a single project', async () => {
  for (const opts of [{ settings: { conductorWakes: false } }, { projects: ['alpha'] }]) {
    const { hub, a } = await setup(opts);
    hub.postSummary(a, hub.ensureOrchestrator(a), summary({ questions: ['?'] }));
    await sleep(80);
    assert.equal(sent.filter(([n]) => n.startsWith('conductor')).length, 0);
  }
});

test('updates that land while it works ride on its next turn, not a second wake', async () => {
  const { hub, c, a } = await setup();
  c.fromYou('Brief me');   // now working
  hub.postSummary(a, hub.ensureOrchestrator(a), summary({ questions: ['?'] }));
  await sleep(80);
  assert.equal(sent.filter(([n]) => n === 'conductor-1').length, 1);   // still only your message
  const holder = c.holder();
  holder.state = 'idle';
  hub.onIdle(c.home, holder);
  await sleep(80);   // one batching window after its turn
  assert.equal(sent.filter(([n]) => n === 'conductor-1').length, 2);
  assert.match(sent.at(-1)[1], /alpha: orchestrator-1/);
});

test('hard cap: at most 6 automatic wakes an hour; your message and a due reminder still wake it', async () => {
  const { hub, c, a } = await setup();
  const orch = hub.ensureOrchestrator(a);
  for (let i = 0; i < 6; i++) c.home.log.append('wake', { thread: CONDUCTOR_THREAD, agent: 'conductor-1', text: 'x', auto: true });
  sent.length = 0;
  hub.postSummary(a, orch, summary({ questions: ['Seventh?'] }));
  await sleep(80);
  assert.equal(sent.filter(([n]) => n.startsWith('conductor')).length, 0);   // held back
  assert.equal(c.pending.length, 1);
  c.fromYou('Anything new?');   // yours always goes, and the held update rides along with it
  assert.equal(sent.at(-1)[1], 'Anything new?');
  assert.match(c.holder().notes?.[0] || '', /alpha: orchestrator-1 posted a round summary, 1 question/);
  c.holder().state = 'idle';
  c.setReminder(new Date(Date.now() + 1000).toISOString(), 'Stretch', 'conductor-1');
  assert.equal(c.dueReminders(Date.now() + 5000), 1);
  assert.match(sent.at(-1)[1], /Reminder rem-001 is due/);
  // A wake an hour old no longer counts.
  assert.equal(c.autoWakes(Date.now() + 61 * 60000).length, 0);
});

test('no back-and-forth: the orchestrator\'s answer to a Conductor brief does not wake it, even with a question', async () => {
  const { hub, c, a } = await setup();
  const orch = hub.ensureOrchestrator(a);
  assert.equal(c.toOrchestrator('alpha', 'conductor-1', 'Matt asks for a frost warning.'), "Sent to alpha's orchestrator.");
  hub.postSummary(a, orch, summary({ done: ['scoped it'], questions: ['Red or amber?'] }));
  await sleep(80);
  assert.equal(sent.filter(([n]) => n.startsWith('conductor')).length, 0);
  assert.equal(c.pending.length, 0);
  // Only the first summary after the brief is its answer: the next one with a question wakes it again.
  hub.postSummary(a, orch, summary({ questions: ['Ship the warning?'] }));
  await sleep(80);
  assert.equal(sent.filter(([n]) => n.startsWith('conductor')).length, 1);
  sent.length = 0;
  c.holder().state = 'idle';
  // After your own message to that orchestrator, its next summary with a question wakes it again.
  hub.fromYou(a, 'orchestrator', 'Also check the calendar.');
  hub.postSummary(a, orch, summary({ questions: ['Which calendar?'] }));
  await sleep(80);
  assert.equal(sent.filter(([n]) => n.startsWith('conductor')).length, 1);
});

test('an old brief does not silence a project: a first summary more than 30 minutes later wakes it', async () => {
  const { hub, c, a } = await setup();
  const orch = hub.ensureOrchestrator(a);
  c.toOrchestrator('alpha', 'conductor-1', 'Matt asks for a frost warning.');
  const brief = a.log.events.findLast(e => e.conductor);
  brief.ts = new Date(Date.now() - 5 * 3600e3).toISOString();   // the brief was at 09:00, the question at 14:00
  hub.postSummary(a, orch, summary({ questions: ['Worker w1 is done: merge it?'] }));
  await sleep(80);
  assert.equal(sent.filter(([n]) => n.startsWith('conductor')).length, 1);
});

test('a Conductor brief never counts as your answer: the orchestrator\'s question stays in Needs you', async () => {
  const { hub, c, a } = await setup();
  const orch = hub.ensureOrchestrator(a);
  hub.postSummary(a, orch, summary({ questions: ['Merge #12?'] }));
  const open = () => c.needsYou(a).items.filter(i => i.kind === 'question').length;
  assert.equal(open(), 1);
  c.toOrchestrator('alpha', 'conductor-1', 'Matt is away today.');
  assert.equal(open(), 1);
  hub.fromYou(a, 'orchestrator', 'Yes, merge it.');
  assert.equal(open(), 0);
});

test('briefing a project with no orchestrator starts none: it is refused, and the Conductor is told why', async () => {
  const { c, b } = await setup();
  const out = c.toOrchestrator('beta', 'conductor-1', 'Please look.');
  assert.match(out, /beta has no orchestrator running, and the Conductor cannot start one\. Nothing was sent/);
  assert.equal(b.orchestrator(), null);
  assert.equal(b.log.events.some(e => e.type === 'message'), false);
});

test('waiting update lines survive a restart; due reminders are done only once delivered', async () => {
  const { hub, c, a, root } = await setup();
  hub.postSummary(a, hub.ensureOrchestrator(a), summary({ questions: ['?'] }));
  assert.equal(c.pending.length, 1);
  clearTimeout(c.timer); c.timer = null;   // "restart" before the window ends
  const again = new Hub({ projects: [a.dir, join(root, 'beta')], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }), conductorDir: join(root, 'data', 'conductor') });
  assert.deepEqual(again.conductor.pending.map(x => x.line), ['- alpha: orchestrator-1 posted a round summary, 1 question']);
  clearTimeout(again.conductor.timer);
  // A reminder due while the Conductor is mid-turn waits, still not done, until its turn ends.
  c.fromYou('Working on it');
  c.pending = [];
  c.setReminder(new Date(Date.now() + 1000).toISOString(), 'Call back', 'conductor-1');
  c.dueReminders(Date.now() + 5000);
  assert.equal(c.reminders().length, 1);
  const h = c.holder(); h.state = 'idle';
  hub.onIdle(c.home, h);
  assert.match(sent.at(-1)[1], /Reminder rem-001 is due/);
  assert.equal(c.reminders().length, 0);
});

test('the red count and the cards come from the whole log, not the latest 400 events', async () => {
  const { hub, c } = await setup();
  hub.postSummary(c.home, { name: 'conductor-1', thread: CONDUCTOR_THREAD, role: 'conductor' }, summary({ questions: ['Pause beta tonight?'] }));
  hub.proposeLesson(c.home, { name: 'conductor-1', thread: CONDUCTOR_THREAD }, 'core', 'Brief before 9');
  for (let i = 0; i < 450; i++) c.home.log.append('usage', { agent: 'conductor-1', models: {} });
  const v = c.view();
  assert.equal(v.events.some(e => e.type === 'summary'), false);   // out of the window
  assert.equal(v.questions.length, 1);
  assert.equal(v.lessons.length, 1);
  assert.equal(v.waiting, 2);
  assert.ok(v.olderEvents > 0);
  // Answering one of its questions from its card marks just that one.
  hub.answerQuestions(c.home, v.questions[0].id, [{ index: 0, text: 'Yes' }]);
  assert.equal(c.view().questions.length, 0);
});

test('message_agent reaches the project\'s orchestrator only, marked as from the Conductor', async () => {
  const { hub, c, a } = await setup();
  hub.ensureOrchestrator(a);
  c.fromYou('Ask alpha to look at the build');
  const out = c.toOrchestrator('alpha', 'conductor-1', 'Please look at the build.');
  assert.equal(out, "Sent to alpha's orchestrator.");
  const [to, msg] = sent.at(-1);
  assert.equal(to, 'orchestrator-1');
  assert.match(msg, /^\[From the Conductor, conductor-1, on/);
  assert.ok(a.log.events.some(e => e.type === 'message' && e.thread === 'orchestrator' && e.from === 'conductor-1' && e.conductor));
  assert.ok(c.home.log.events.some(e => e.type === 'notice' && /sent a brief to alpha/.test(e.text)));
  assert.throws(() => c.toOrchestrator('gamma', 'conductor-1', 'x'), /No project called "gamma"/);
  // The tool takes a project, never an agent name: there is no way to address a worker.
  assert.ok(!CONDUCTOR_TOOLS.some(n => /worker|start|retire|permission|merge|push|restart/.test(n)));
});

test('enforced: no built-in tools, nothing from disk, and the permission callback refuses all but its own', async () => {
  const { c } = await setup();
  c.fromYou('hi');
  const a = c.holder();
  const o = a.options();
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.strictMcpConfig, true);
  assert.deepEqual(o.allowedTools, conductorToolNames(a));
  for (const t of ['Bash', 'PowerShell', 'Edit', 'Write', 'Read', 'Task', 'Agent', 'WebFetch']) assert.ok(CONDUCTOR_DENIED.includes(t), t);
  for (const t of ['Bash', 'PowerShell', 'Edit', 'Write', 'mcp__crux__start_worker', 'mcp__crux__answer_permission', 'mcp__crux__restart_hub', 'mcp__claude_ai_Gmail__send'])
    assert.equal(c.decide(t, {}, a).behavior, 'deny', t);
  assert.equal(c.decide('mcp__crux__needs_you', { project: 'alpha' }, a).behavior, 'allow');
  assert.ok(!conductorToolNames(a).some(n => /start_worker|retire_worker|handoff_worker|answer_permission|restart_hub|set_agent_settings/.test(n)));
});

test('reads every project: needs you in order, overview, board, agents; never the private section', async () => {
  const { hub, c, a, b } = await setup();
  hub.postSummary(b, hub.ensureOrchestrator(b), summary({ questions: ['Which colour?'] }));
  b.log.append('approval', { thread: 'w1', approval: 'ap9', agent: 'w1', tool: 'Bash', input: { description: 'Run the tests' }, routedTo: null, summary: { plain: 'Run the tests' } });
  hub.approvals.set('ap9', { p: b });
  const n = c.needsYou(b);
  assert.equal(n.count, 2);
  assert.deepEqual(n.items.map(i => i.kind), ['permission', 'question']);
  const o = c.overview();
  assert.deepEqual(o.projects.map(p => p.name), ['alpha', 'beta']);
  assert.equal(o.projects[1].waiting.total, 2);
  assert.equal(c.agents(a).length, 0);
  assert.match(c.profile('private'), /never reads the private section/);
});

test('reminders across days: set, listed, due ones wake it at once and are done', async () => {
  const { c } = await setup();
  assert.match(c.setReminder('2000-01-01T09:00Z', 'old', 'conductor-1'), /passed/);
  assert.match(c.setReminder(new Date(Date.now() + 864e5).toISOString(), 'Back up the updater key', 'conductor-1'), /Reminder rem-001 set/);
  assert.equal(c.reminders().length, 1);
  sent.length = 0;
  assert.equal(c.dueReminders(Date.now() + 2 * 864e5), 1);
  assert.match(sent.at(-1)[1], /Reminder rem-001 is due .*Back up the updater key/);
  assert.equal(c.reminders().length, 0);
});

test('same handoff rules as an orchestrator: threshold, successor conductor-2, its own facts and handoff', async () => {
  const { hub, c } = await setup();
  c.fromYou('Brief me');
  const a = c.holder();
  a.sessionId = 's1'; a.state = 'idle'; a.contextPct = 70;
  hub.onIdle(c.home, a);
  assert.equal(a.retiring, 'writing');
  assert.match(sent.at(-1)[1], /take over the Conductor role/);
  hub.writeHandoff(c.home, a, { in_flight: ['none'], promises: ['none'], risks: ['none'], next_steps: ['Brief Matt at 9'] });
  const h = c.home.board.latestHandoff('conductor');
  assert.ok(h && /Messages from/.test(h.body) && /Reminders still waiting/.test(h.body));
  assert.equal(c.home.board.latestHandoff(), null);   // never mistaken for an orchestrator's
  a.state = 'idle';
  hub.onIdle(c.home, a);   // handoff written: the successor starts
  assert.equal(c.holder().name, 'conductor-2');
  assert.match(sent.at(-1)[1], /hold the Conductor role, taking over from conductor-1/);
  hub.finishRetire(c.home, a);   // ends the overlap (and its timer)
  assert.equal(a.state, 'retired');
});

test('idle handoff covers the Conductor too', async () => {
  const { hub, c } = await setup({ settings: { idleHandoffMin: 1, idleFloorPct: 10 } });
  c.fromYou('hi');
  const a = c.holder();
  a.sessionId = 's1'; a.state = 'idle'; a.contextPct = 40;
  c.home.log.append('agent_busy', { agent: a.name, busy: false, contextPct: 40 });
  assert.deepEqual(hub.idleCheck(Date.now() + 5 * 60000), [CONDUCTOR]);
  assert.equal(a.retiring, 'writing');
  hub.finishRetire(c.home, a);   // stops its handoff timer
});

test('the page view carries the fields the map reads', async () => {
  const { c } = await setup();
  const v = c.view();
  for (const k of ['state', 'contextPct', 'model', 'effort', 'retireAt', 'thread', 'activity', 'waiting', 'events']) assert.ok(k in v, k);
  assert.equal(v.state, 'asleep');
  assert.equal(v.thread, CONDUCTOR_THREAD);
  assert.equal('events' in c.view({ events: false }), false);
});

test('prompts: the boundary rule in the Conductor\'s, and one line in the orchestrator\'s', async () => {
  const p = conductorPrompt({ generation: 1, projects: ['alpha'] });
  assert.match(p, /Never carry code, data or details from one project into another/);
  assert.match(p, /Never read or repeat \{\{who\}\}'s private profile section/);
  assert.match(p, /Employer and personal projects stay apart/);
  assert.match(p, /Never relay an OK to push, open a PR or merge/);
  assert.match(p, /For a wake that needs nothing,\s+end the turn at once: no reply and no post_summary/);
  assert.match(orchestratorPrompt({ project: 'x', generation: 1, index: '' }), /OK to push, open a PR or merge counts only when \{\{who\}\} gives it in this project's thread or in Needs you, never relayed by the Conductor/);
  assert.match(orchestratorPrompt({ project: 'x', generation: 1, index: '' }), /\[From the Conductor" comes from the hub-wide agent.*\n.*request from \{\{who\}\}'s side, within your rules/);
});

test('icon: the halo of nodes, the model hue kept on the helmet, readable at 15 px', async () => {
  const svg = robot({ role: 'conductor', model: 'claude-opus-5-5', state: 'idle' }, { size: 15 });
  assert.match(svg, /class="bot bot-opus st-idle conductor"/);
  assert.match(svg, /<ellipse cx="24" cy="8.400" rx="16"/);
  assert.equal((svg.match(/<circle class="g"/g) || []).length, 4);
  assert.match(svg, /translate\(3.600 10\) scale\(.85\)/);
  assert.doesNotMatch(svg, /class="crown"/);
  assert.equal(conductorBot({ role: 'worker', model: 'claude-sonnet-5-5' }, { size: 26 }).includes('<ellipse'), true);
  assert.match(robot({ role: 'orchestrator' }), /class="crown"/);   // the orchestrator keeps its crown
});

test('page helpers: thread items fold to the latest six, live events update it, the box says Conductor', async () => {
  const c = { name: 'conductor-1', state: 'idle', events: [] };
  for (let i = 0; i < 9; i++) c.events.push({ type: 'message', thread: CONDUCTOR_THREAD, from: i % 2 ? 'you' : 'conductor-1', text: `m${i}` });
  c.events.push({ type: 'usage', thread: CONDUCTOR_THREAD });
  const items = CP.threadItems(c);
  assert.equal(items.length, 9);
  assert.deepEqual(CP.shownItems(items).hidden, 3);
  assert.equal(CP.shownItems(items, true).hidden, 0);
  // A phone shows the last two, so the waiting cards are on the first screen (decision 32).
  assert.deepEqual(CP.shownItems(items, false, CP.SHOWN_PHONE).shown.map(e => e.text), ['m7', 'm8']);
  assert.equal(CP.shownItems(items, false, CP.SHOWN_PHONE).hidden, 7);
  assert.equal(CP.applyEvent(c, { project: CONDUCTOR, type: 'agent_state', agent: 'conductor-1', state: 'working', contextPct: 12 }), true);
  assert.equal(c.state, 'working');
  assert.equal(CP.applyEvent(c, { project: 'alpha', type: 'agent_state' }), false);
  assert.equal(CP.lastLine(c), 'm8');
  assert.match(CP.wakeLine({ text: '[Hub: updates]\n- alpha: x\n- beta: y\n- Reminder rem-001 is due: z' }), /Woken by 2 updates from alpha, beta and 1 reminder due/);
  assert.match(composerHint({ thread: 'all' }), /^Message the Conductor/);
  assert.equal(CP.placeOf(c).agents[0].role, 'conductor');
});

test('its model and effort change like an orchestrator\'s, logged the same way, kept across a restart and a handoff; never a type', async () => {
  const { hub, c, root, a } = await setup();
  c.fromYou('hi');
  const h = c.holder();
  h.state = 'idle';
  const r = await hub.setAgentSettings(hub.place(CONDUCTOR), 'orchestrator', { model: 'sonnet', effort: 'medium' });
  assert.equal(r.changed, true);
  assert.equal(h.model, 'claude-sonnet-5-5');
  assert.equal(h.effort, 'medium');
  assert.ok(c.home.log.events.some(e => e.type === 'agent_settings' && e.agent === 'conductor-1' && e.model === 'claude-sonnet-5-5' && e.thread === CONDUCTOR_THREAD));
  assert.ok(c.home.log.events.some(e => e.type === 'notice' && /You set conductor-1 to .*Sonnet 5.5 · effort medium/.test(e.text)));
  await assert.rejects(hub.setAgentSettings(hub.place(CONDUCTOR), 'orchestrator', { type: 'reviewer' }), /The Conductor has no agent type/);
  assert.equal((await hub.setAgentSettings(hub.place(CONDUCTOR), 'orchestrator', { type: null })).changed, false);   // "none" is a no-op
  assert.equal(h.type, null);
  assert.equal(c.view().model, 'claude-sonnet-5-5');
  // After a restart: read back from the log.
  const again = new Hub({ projects: [a.dir, join(root, 'beta')], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }), conductorDir: join(root, 'data', 'conductor') });
  assert.equal(again.conductor.holder().model, 'claude-sonnet-5-5');
  assert.equal(again.conductor.holder().effort, 'medium');
  // After a handoff: the successor keeps them.
  h.sessionId = 's1'; h.contextPct = 80;
  hub.onIdle(c.home, h);
  hub.writeHandoff(c.home, h, { in_flight: ['none'], promises: ['none'], risks: ['none'], next_steps: ['none'] });
  hub.onIdle(c.home, h);
  assert.equal(c.holder().name, 'conductor-2');
  assert.equal(c.holder().model, 'claude-sonnet-5-5');
  assert.equal(c.holder().effort, 'medium');
  hub.finishRetire(c.home, h);
});

test('after a restart a brief the orchestrator never acted on is delivered again, marked as from the Conductor; it never starts one', async () => {
  const { hub, c, a } = await setup();
  const orch = hub.ensureOrchestrator(a);
  c.toOrchestrator('alpha', 'conductor-1', 'Please tidy old worktrees.');
  const plan = hub.resumePlan(a);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].why, 'message');
  assert.equal(plan[0].message.from, 'conductor-1');
  sent.length = 0;
  hub.resumeOne(a, plan[0]);
  assert.equal(sent.at(-1)[0], 'orchestrator-1');
  assert.match(sent.at(-1)[1], /^\[From the Conductor, conductor-1, on /);
  // With no one holding the role, the brief waits: no orchestrator is started for it.
  hub.finishRetire(a, orch);
  assert.deepEqual(hub.resumePlan(a), []);
});
