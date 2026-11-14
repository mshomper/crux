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
import { CONDUCTOR, CONDUCTOR_THREAD, CONDUCTOR_TOOLS, CONDUCTOR_DENIED, conductorToolNames, isNoOutputNudge } from '../lib/conductor.mjs';
import { orchestratorPrompt, conductorPrompt } from '../lib/prompts.mjs';
import { robot, conductorBot } from '../public/robots.js';
import * as CP from '../public/conductor-view.js';
import { composerHint } from '../public/composer-keys.js';
import * as AP from '../public/all-projects.js';
import { isRepeat, openQuestions, repeatsIn } from '../public/questions.js';

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
  hub.postSummary(a, orch, summary({ done: ['x'], questions: ['Merge the lens picker today?'] }));
  hub.postSummary(b, hub.ensureOrchestrator(b), summary({ questions: ['Ship it?'] }));
  hub.approvals.set('ap1', { p: b });   // a permission card really waiting (the wake checks it still is)
  b.log.append('approval', { thread: 'w1', approval: 'ap1', agent: 'w1', tool: 'Bash', input: {}, routedTo: null });
  sent.length = 0;
  await sleep(80);
  const wakes = sent.filter(([n]) => n === 'conductor-1');
  assert.equal(wakes.length, 1);
  assert.match(wakes[0][1], /\[Hub: new cards for/);
  assert.match(wakes[0][1], /alpha · question:\S+ · question from orchestrator-1: Merge the lens picker today\?/);
  assert.match(wakes[0][1], /beta · question:\S+ · question from orchestrator-1: Ship it\?/);
  assert.match(wakes[0][1], /beta · approval:ap1 · permission: w1 wants to use Bash/);
  // One cards event in its chat: by project in the hub's order, then permission cards before questions.
  const cards = c.home.log.ofType('cards');
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].items.map(i => `${i.project} ${i.card.split(':')[0]}`), ['alpha question', 'beta approval', 'beta question']);
  assert.equal(cards[0].thread, CONDUCTOR_THREAD);
  assert.equal(cards[0].digest, undefined);
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

test('cards that come while it works go up at once; its notes on them come at the end of its turn, not a second wake', async () => {
  const { hub, c, a } = await setup();
  c.fromYou('Brief me');   // now working
  hub.postSummary(a, hub.ensureOrchestrator(a), summary({ questions: ['Which lens picker ships first?'] }));
  await sleep(80);
  assert.equal(sent.filter(([n]) => n === 'conductor-1').length, 1);   // still only your message
  assert.equal(c.home.log.ofType('cards').length, 1);                   // the card is in its chat already
  const holder = c.holder();
  holder.state = 'idle';
  hub.onIdle(c.home, holder);
  assert.equal(sent.filter(([n]) => n === 'conductor-1').length, 2);
  assert.match(sent.at(-1)[1], /\[Hub: new cards for/);
  assert.match(sent.at(-1)[1], /alpha · question:\S+ · question from orchestrator-1: Which lens picker ships first\?/);
});

test('hard cap: at most 6 automatic wakes an hour; cards still go up, your message and a due reminder still wake it', async () => {
  const { hub, c, a } = await setup();
  const orch = hub.ensureOrchestrator(a);
  for (let i = 0; i < 6; i++) c.home.log.append('wake', { thread: CONDUCTOR_THREAD, agent: 'conductor-1', text: 'x', auto: true });
  sent.length = 0;
  hub.postSummary(a, orch, summary({ questions: ['Seventh?'] }));
  await sleep(80);
  assert.equal(sent.filter(([n]) => n.startsWith('conductor')).length, 0);   // no turn for its notes past the cap
  assert.equal(c.home.log.ofType('cards').length, 1);                         // the card is in its chat all the same
  assert.equal(c.pending.length, 0);
  c.fromYou('Anything new?');   // yours always goes
  assert.equal(sent.at(-1)[1], 'Anything new?');
  c.holder().state = 'idle';
  c.setReminder(new Date(Date.now() + 1000).toISOString(), 'Stretch', 'conductor-1');
  assert.equal(c.dueReminders(Date.now() + 5000), 1);
  assert.match(sent.at(-1)[1], /Reminder rem-001 is due/);
  // A wake an hour old no longer counts.
  assert.equal(c.autoWakes(Date.now() + 61 * 60000).length, 0);
});

test('a summary answering a Conductor brief still brings its question to you: anything that asks you is never skipped', async () => {
  const { hub, c, a } = await setup();
  const orch = hub.ensureOrchestrator(a);
  assert.equal(c.toOrchestrator('alpha', 'conductor-1', 'Matt asks for a frost warning.'), "Sent to alpha's orchestrator.");
  hub.postSummary(a, orch, summary({ done: ['scoped it'], questions: ['Red or amber for the frost warning?'] }));
  await sleep(80);
  assert.equal(c.home.log.ofType('cards').length, 1);   // the card is in the chat, so the digest and its notice cover it too
  assert.equal(sent.filter(([n]) => n.startsWith('conductor')).length, 1);
  // A summary that asks nothing still wakes nothing.
  hub.postSummary(a, orch, summary({ done: ['shipped it'] }));
  await sleep(80);
  assert.equal(c.home.log.ofType('cards').length, 1);
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
  assert.match(p, /For a wake that needs nothing,\s+call stay_quiet and write nothing else: no reply and no post_summary/);
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

test('a question lives in one card: a repeat is hidden while the first card is open, and comes back when it closes', async () => {
  const { hub, a } = await setup();
  const orch = hub.ensureOrchestrator(a);
  const w = hub.startWorker(a, 'w1', 'task');
  const Q = 'Should the preview update while dragging, or only on release?';
  hub.postSummary(a, w, summary({ questions: [Q] }));
  // The orchestrator repeats it (case and punctuation differ) and asks one of its own: nothing is dropped from the log.
  hub.postSummary(a, orch, summary({ questions: ['should the preview update while dragging or only on release', 'Ship the lens picker on Friday or wait?'] }));
  assert.equal(a.log.events.findLast(e => e.type === 'summary').questions.length, 2);
  const open = () => openQuestions(a.log.events).map(q => [q.from, q.open.map(x => x.text)]);
  assert.deepEqual(open(), [['w1', [Q]], ['orchestrator-1', ['Ship the lens picker on Friday or wait?']]]);
  const note = repeatsIn(a.log.events).get(a.log.events.findLast(e => e.type === 'summary').id);
  assert.deepEqual(note.map(r => [r.i, r.of]), [[0, 'w1']]);   // the "also in w1's card" note
  // The worker's card closes without your answer (its orchestrator writes to it): the repeat shows again by itself.
  hub.orchestratorToWorker(a, orch, 'w1', 'Hold on, I am asking Matt.');
  assert.deepEqual(open(), [['orchestrator-1', ['should the preview update while dragging or only on release', 'Ship the lens picker on Friday or wait?']]]);
  // The Conductor's own summary is never hidden against a project's cards (its prompt keeps it from re-asking).
  const { hub: h2, c } = await setup();
  const cd = { name: 'conductor-1', thread: CONDUCTOR_THREAD, role: 'conductor' };
  h2.postSummary(c.home, cd, summary({ questions: [Q, 'Pause beta tonight?'], decisions_needed: [4] }));
  const mine = c.home.log.events.findLast(e => e.type === 'summary');
  assert.equal(mine.questions.length, 2);
  assert.deepEqual(mine.decisions_needed, []);   // decisions are the projects' cards, never the Conductor's
});

test('once you answer or dismiss the first card, its repeat counts as answered; closed without you, it comes back', async () => {
  const Q = 'Should the preview update while dragging, or only on release?';
  const askBoth = async () => {
    const s = await setup();
    const orch = s.hub.ensureOrchestrator(s.a), w = s.hub.startWorker(s.a, 'w1', 'task');
    s.hub.postSummary(s.a, w, summary({ questions: [Q] }));
    s.hub.postSummary(s.a, orch, summary({ questions: [Q] }));
    const workerCard = s.a.log.events.find(e => e.type === 'summary' && e.from === 'w1');
    s.a.log.events.findLast(e => e.type === 'summary').ts = workerCard.ts;   // both in the same millisecond: order still decides
    assert.deepEqual(openQuestions(s.a.log.events).map(q => q.from), ['w1']);
    return { ...s, orch, w, workerCard };
  };
  // You answer w1's card in Needs you: the orchestrator's repeat does not come back.
  let s = await askBoth();
  s.hub.answerQuestions(s.a, s.workerCard.id, [{ index: 0, text: 'Only on release.' }]);
  assert.deepEqual(openQuestions(s.a.log.events), []);
  assert.equal([...repeatsIn(s.a.log.events).values()][0][0].answered, true);   // the "answered in w1's card" note
  // You dismiss w1's card: the same.
  s = await askBoth();
  s.hub.dismissQuestion(s.a, s.workerCard.id);
  assert.deepEqual(openQuestions(s.a.log.events), []);
  // You reply in w1's thread: the same.
  s = await askBoth();
  s.hub.fromYou(s.a, 'w1', 'Only on release.');
  assert.deepEqual(openQuestions(s.a.log.events), []);
  // w1's card closes without you (a newer summary from w1 that asks nothing new): the repeat comes back.
  s = await askBoth();
  s.hub.postSummary(s.a, s.w, summary({ questions: ['Which lens is the default?'] }));
  assert.deepEqual(openQuestions(s.a.log.events).map(q => [q.from, q.open.map(x => x.text)]).sort(), [['orchestrator-1', [Q]], ['w1', ['Which lens is the default?']]]);
  // w1 hands off without you: the repeat comes back too.
  s = await askBoth();
  s.hub.finishRetire(s.a, s.w);
  assert.deepEqual(openQuestions(s.a.log.events).map(q => q.from), ['orchestrator-1']);
});

test('only a real repeat is hidden: never the longer question, never a short exact one; a retired holder lets it back', async () => {
  const merge = 'Should I merge PR #63 now?';
  assert.equal(isRepeat('should i merge pr 63 now', merge), true);   // equal once cleaned (24+ characters)
  assert.equal(isRepeat('Should I merge PR #63 now, or wait for #64 and merge both?', merge), false);   // asks more: stays
  assert.equal(isRepeat('merge pr 63 now', 'Should I merge PR #63 now, or wait for #64 and merge both?'), false);   // under 24 cleaned
  assert.equal(isRepeat('Ship it?', 'Ship it?'), false);   // short exact matches are too common
  const { hub, a } = await setup();
  const orch = hub.ensureOrchestrator(a);
  const w = hub.startWorker(a, 'w1', 'task');
  hub.postSummary(a, w, summary({ questions: [merge] }));
  hub.postSummary(a, orch, summary({ questions: ['Should I merge PR #63 now, or wait for #64 and merge both?'] }));
  assert.equal(openQuestions(a.log.events).length, 2);   // the longer one is its own card
  hub.postSummary(a, orch, summary({ questions: ['Should I merge PR #63 now?'] }));
  assert.equal(openQuestions(a.log.events).length, 1);   // the same one is hidden behind w1's card
  hub.finishRetire(a, w);   // w1 retires unanswered: its card goes, the orchestrator's repeat shows
  assert.deepEqual(openQuestions(a.log.events).map(q => q.from), ['orchestrator-1']);
});

test('All projects: Waiting starts folded, phone and desk alike (decision 60: the cards are in the chat); a tap opens it', () => {
  const fold = {};
  assert.equal(CP.waitingOpen(fold, 2), false);         // something waits: still folded, its red count shows on the row
  fold.waiting = true;                                  // your tap
  assert.equal(CP.waitingOpen(fold, 2), true);
  CP.foldAfterSend(fold);
  assert.equal(CP.waitingOpen(fold, 2), false);         // after your message: folded, the reply lands in view
  fold.waiting = true;
  assert.equal(CP.waitingOpen(fold, 0), false);         // nothing waits: closed, and your choice is forgotten
  assert.equal(CP.waitingOpen(fold, 1), false);         // the next card leaves it folded
});

test('after a restart your unread message and an unread Conductor brief are both resent, oldest first', async () => {
  const { hub, c, a } = await setup();
  const orch = hub.ensureOrchestrator(a);
  orch.sessionId = 's1';
  c.toOrchestrator('alpha', 'conductor-1', 'Matt asks for a frost warning.');
  hub.fromYou(a, 'orchestrator', 'And check the build.');
  const plan = hub.resumePlan(a);
  assert.deepEqual(plan.map(r => r.message.from), ['conductor-1', 'you']);
  sent.length = 0;
  for (const r of plan) hub.resumeOne(a, r);
  assert.match(sent[0][1], /^\[From the Conductor, conductor-1/);
  assert.equal(sent[1][1], 'And check the build.');
});

test('one card per decision, and a pick takes every copy away at once', async () => {
  // Two summaries in a thread name D0004: its card is drawn once, under the latest.
  const evs = [{ id: 's1', type: 'summary', decisions_needed: [4, 7] }, { id: 's2', type: 'summary', decisions_needed: [4, 4] }];
  const once = AP.decisionCardsOnce(evs);
  assert.deepEqual(once(evs[0]), [7]);
  assert.deepEqual(once(evs[1]), [4]);
  // A decision read twice (main folder and worktree copy) is still one waiting card.
  const p = { board: { decisions: [{ id: 4, status: 'open', options: [{ key: 'A' }, { key: 'B' }] }, { id: 4, status: 'open' }, { id: 5, status: 'decided' }] }, events: [] };
  assert.deepEqual(AP.openDecisions(p).map(d => d.id), [4]);
  // The pick shows in the page's own state before the hub answers: nothing waits for it any more, in any view.
  assert.equal(AP.applyPick(p, 4, 'B'), true);
  assert.equal(p.board.decisions[0].status, 'decided');
  assert.equal(p.board.decisions[0].chosen, 'B');
  assert.deepEqual(AP.openDecisions(p), []);
  assert.equal(AP.waiting(p, new Set()).decisions.length, 0);
  assert.equal(AP.applyPick(p, 4, 'A'), false);   // already decided: nothing to do
});

test('no wake for cards you settled before it came: no turn, no reply; one still waiting wakes it with that line only', async () => {
  const { hub, c, a, b } = await setup();
  const orch = hub.ensureOrchestrator(a);
  hub.postSummary(a, orch, summary({ questions: ['Merge the lens picker today?'] }));
  hub.approvals.set('ap7', { p: b });
  b.log.append('approval', { thread: 'w1', approval: 'ap7', agent: 'w1', tool: 'Bash', input: {}, routedTo: null });
  // Within the batching window you answer the question and the permission card.
  hub.fromYou(a, 'orchestrator', 'Yes, merge it.');
  hub.approvals.delete('ap7');
  await sleep(80);
  assert.equal(sent.filter(([n]) => n.startsWith('conductor')).length, 0);   // no turn at all
  assert.equal(c.pending.length, 0);
  assert.ok(c.home.log.events.some(e => e.type === 'wake_taken' && e.skipped === 2));
  assert.equal(c.home.log.events.some(e => e.type === 'wake'), false);
  // Nothing comes back after a restart either.
  const { root } = { root: join(a.dir, '..') };
  const again = new Hub({ projects: [a.dir, b.dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }), conductorDir: join(root, 'data', 'conductor') });
  assert.equal(again.conductor.pending.length, 0);
  // Two lines, one settled: the wake carries only the one still waiting.
  hub.postSummary(b, hub.ensureOrchestrator(b), summary({ questions: ['Pause beta tonight?'] }));
  hub.postSummary(a, orch, summary({ questions: ['Ship the lens picker on Friday or wait?'] }));
  hub.dismissQuestion(a, a.log.events.findLast(e => e.type === 'summary').id);
  await sleep(80);
  const wakes = sent.filter(([n]) => n === 'conductor-1');
  assert.equal(wakes.length, 1);
  assert.match(wakes[0][1], /beta · question:\S+ · question from orchestrator-1: Pause beta tonight\?/);
  assert.doesNotMatch(wakes[0][1], /alpha/);
  assert.deepEqual(c.home.log.ofType('cards').flatMap(e => e.items.map(i => i.project)), ['beta']);   // nor in its chat
});

test('a worker question its orchestrator answers within the window wakes nothing either', async () => {
  const { hub, c, a } = await setup();
  const orch = hub.ensureOrchestrator(a);
  const w = hub.startWorker(a, 'w1', 'task');
  hub.postSummary(a, w, summary({ questions: ['Use the cyan or the violet focus ring?'] }));
  assert.equal(c.pending.length, 1);
  a.log.append('message', { thread: w.thread, from: orch.name, text: 'Cyan.' });
  await sleep(80);
  assert.equal(sent.filter(([n]) => n.startsWith('conductor')).length, 0);
  assert.equal(c.pending.length, 0);
});

// The registered handler of one of its board tools (the MCP server's own table; the SDK exposes no other way in).
const toolHandler = (c, agent, name) => c.tools(agent).instance._registeredTools[name].handler;

test('quiet turns: stay_quiet and post_summary end its turn with no Claude Code follow-up; only for the Conductor', async () => {
  const { hub, c, a } = await setup();
  c.fromYou('[Hub: updates since you last heard]\n- alpha: a card');
  const k = c.holder();
  const o = k.queryOptions();
  assert.deepEqual(o.env.CLAUDE_CODE_TERMINAL_MCP_TOOLS.split(','), ['mcp__crux__post_summary', 'mcp__crux__stay_quiet']);   // not note_cards (decision 60 review)
  assert.ok(o.env.PATH || o.env.Path, 'the clean environment is kept underneath');
  assert.ok(o.allowedTools.includes('mcp__crux__stay_quiet'));
  assert.equal(c.decide('mcp__crux__stay_quiet', {}, k).behavior, 'allow');
  assert.equal(hub.ensureOrchestrator(a).queryOptions().env.CLAUDE_CODE_TERMINAL_MCP_TOOLS, undefined);
  // stay_quiet shows nothing in its thread, and counts as having acted on your message (no re-delivery after a restart).
  const shown = () => c.home.log.events.filter(e => e.thread === CONDUCTOR_THREAD).length;
  const before = shown();
  const r = await toolHandler(c, k, 'stay_quiet')({}, {});
  assert.match(r.content[0].text, /quietly/);
  assert.equal(shown(), before);
  assert.ok(c.home.log.events.some(e => e.type === 'quiet' && e.agent === k.name));
  assert.equal(c.resume(), null);
});

test('if Claude Code still asks for visible output, the reply stays out of its thread and no summary is posted', async () => {
  const { c } = await setup();
  c.fromYou('[Hub: updates since you last heard]\n- alpha: a card');
  const k = c.holder();
  const q = { getContextUsage: async () => ({ percentage: 12 }) };
  const said = () => c.home.log.events.filter(e => e.type === 'message' && e.from === k.name).map(e => e.text);
  const nudge = { type: 'user', isSynthetic: true, parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: '[Your previous response had no visible output. Please continue and produce a user-visible response.]' }] } };
  assert.equal(isNoOutputNudge(nudge), true);
  assert.equal(isNoOutputNudge({ ...nudge, isSynthetic: false }), false);   // your own words are never taken for it
  await k.onMessage({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } }, q);
  await k.onMessage(nudge, q);
  await k.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'Nothing is waiting in alpha.' }] } }, q);
  const r = await toolHandler(c, k, 'post_summary')(summary({ done: ['Nothing is waiting'] }), {});
  assert.match(r.content[0].text, /Not posted/);
  assert.deepEqual(said(), []);
  assert.equal(c.home.log.events.some(e => e.type === 'summary'), false);
  // The next turn speaks as usual.
  await k.onMessage({ type: 'result', subtype: 'success', result: '' }, q);
  assert.equal(k.quietTurn, false);
  await k.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'Two cards wait in beta.' }] } }, q);
  assert.deepEqual(said(), ['Two cards wait in beta.']);
});

test('the prompt tells it to stay quiet, even where its own earlier turns replied', () => {
  const p = conductorPrompt({ generation: 1, projects: ['alpha'] });
  assert.match(p, /call stay_quiet and write nothing else/);
  assert.match(p, /earlier\s+turns in this thread did reply/);
});
