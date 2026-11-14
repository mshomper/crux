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
  hub.postSummary(a, orch, summary({ done: ['x'] }));
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

test('a worker\'s routine summary, a routed request and its own events do not wake it', async () => {
  const { hub, c, a } = await setup();
  hub.ensureOrchestrator(a);
  const w = hub.startWorker(a, 'w1', 'task');
  hub.postSummary(a, w, summary({ done: ['did it'] }));
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
  assert.equal(sent.filter(([n]) => n === 'conductor-1').length, 2);
  assert.match(sent.at(-1)[1], /alpha: orchestrator-1/);
});

test('message_agent reaches the project\'s orchestrator only, marked as from the Conductor', async () => {
  const { hub, c, a } = await setup();
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
