// Decision 46 A: the orchestrator hands a worker on between the floor (35% by default) and the project's mark, at the
// end of the worker's turn, with a one-line reason. The list it judges from, the refusals, the handoff through the
// existing machinery (decision 16), and the floor setting. Agents are stubbed, so nothing starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings, SETTING_DEFAULTS } from '../lib/settings.mjs';
import { cruxToolNames } from '../lib/tools.mjs';
import { orchestratorPrompt } from '../lib/prompts.mjs';
import { hubPanel, hubChanges, projectCard } from '../public/project-settings.js';

const sent = [];
Agent.prototype.send = function (t) { sent.push([this.name, t]); this.state = 'working'; };
Agent.prototype.close = function () {};

const ago = min => new Date(Date.now() - min * 60000).toISOString();
const ev = (type, min, extra) => ({ id: `${type}-${Math.random()}`, ts: ago(min), type, ...extra });
const summary = (over = {}) => ({ done: [], changed: [], questions: [], decisions_needed: [], blocked_on: [], next_step: '', visuals: [], approvals: [], open_questions: [], ...over });
const NOTES = { in_flight: ['the export panel, half built'], promises: ['none'], risks: ['none'], next_steps: ['Finish the export panel'] };

// An orchestrator and worker w1 (Sonnet, effort medium) that ended its last turn at pct% of its context.
function setup({ pct = 45, draft = false, settings = {}, file = null } = {}) {
  const root = makeTmp('crux-hub-test-');
  const dir = join(root, 'proj');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  const events = [
    ev('agent_created', 60, { agent: 'orchestrator-1', role: 'orchestrator', generation: 1, thread: 'orchestrator' }),
    ev('agent_session', 60, { agent: 'orchestrator-1', sessionId: 'o1' }),
    ev('agent_created', 50, { agent: 'w1', role: 'worker', task: 'Build the export panel', goal: 'Export panel', thread: 'w1', model: 'claude-sonnet-5-5', effort: 'medium' }),
    ev('agent_session', 50, { agent: 'w1', sessionId: 's1', model: 'claude-sonnet-5-5' }),
    ...(draft ? [ev('summary', 6, { thread: 'w1', from: 'w1', ...summary({ done: ['Half the panel'], handoff_notes: NOTES }) })] : []),
    ev('agent_busy', 5, { agent: 'w1', busy: false, ...(pct == null ? {} : { contextPct: pct }) })
  ];
  writeFileSync(join(dir, '.crux', 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const s = new HubSettings({ file: file === null ? null : file, initial: settings });
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: s });
  hub.run = () => '';   // no git in the facts
  const p = hub.project('proj');
  const w = p.agents.get('w1');
  w.state = 'idle';
  return { hub, p, w, dir, root };
}
const notices = (p, thread) => p.log.ofType('notice').filter(n => n.thread === thread).map(n => n.text);

test('list_agents: each worker\'s context %, model, effort and whether it can be handed on, plus the marks', () => {
  const { hub, p } = setup({ pct: 42 });
  hub.createAgent(p, { name: 'w2', role: 'worker', task: 'Review', goal: 'Review', settings: { model: 'opus', effort: 'high' } });
  const l = hub.agentList(p);
  assert.equal(l.handoff.automatic_at_pct, 60);
  assert.equal(l.handoff.orchestrator_may_from_pct, 35);
  assert.match(l.handoff.note, /hand off by themselves at 60%.*From 35%/);
  const [w1, w2] = l.workers;
  assert.deepEqual([w1.name, w1.state, w1.goal, w1.context_pct, w1.model, w1.effort], ['w1', 'idle', 'Export panel', 42, 'claude-sonnet-5-5', 'medium']);
  assert.equal(w1.handoff_worker, 'available now');
  assert.match(w1.runs_as, /Sonnet.*effort medium/);
  assert.equal(w2.context_pct, null, 'not reported yet: null');
  assert.match(w2.model, /opus/);
  assert.equal(w2.effort, 'high');
  assert.match(w2.handoff_worker, /not known yet/);
  assert.ok(!l.workers.some(x => x.name === 'orchestrator-1'), 'workers only');
  // Orchestrator-only tool.
  assert.ok(cruxToolNames({ role: 'orchestrator' }).includes('mcp__crux__handoff_worker'));
  assert.ok(!cruxToolNames({ role: 'worker' }).includes('mcp__crux__handoff_worker'));
});

test('refusals: below the floor, mid-turn, the orchestrator, an unknown name, no reason', () => {
  const low = setup({ pct: 20 });
  assert.match(low.hub.handoffWorker(low.p, 'w1', 'orchestrator-1', 'heavy'), /w1 is at 20% of its context, below the 35% floor/);

  const busy = setup({ pct: 50 });
  busy.w.state = 'working';
  assert.match(busy.hub.handoffWorker(busy.p, 'w1', 'orchestrator-1', 'heavy'), /middle of a turn\. Call handoff_worker again when its turn ends/);
  busy.w.state = 'starting';
  assert.match(busy.hub.handoffWorker(busy.p, 'w1', 'orchestrator-1', 'heavy'), /middle of a turn/);

  const { hub, p, w } = setup({ pct: 50 });
  for (const n of ['orchestrator', 'orchestrator-1']) assert.match(hub.handoffWorker(p, n, 'orchestrator-1', 'heavy'), /That is the orchestrator/);
  assert.match(hub.handoffWorker(p, 'nobody', 'orchestrator-1', 'heavy'), /No worker called nobody/);
  assert.match(hub.handoffWorker(p, 'w1', 'orchestrator-1', '  '), /Give a one-line reason/);

  // None of these touched anything.
  for (const x of [low, busy, { p, w }]) {
    assert.equal(x.w.retiring, undefined);
    assert.ok(!x.p.agents.has('w1-2'), 'no successor');
    assert.equal(x.p.log.ofType('worker_handoff').length, 0);
  }
  assert.equal(p.orchestrator().state === 'retired', false);
});

test('a project whose own mark is at or below the floor: the tool is not available there', () => {
  for (const mark of [35, 30]) {
    const { hub, p, w, dir } = setup({ pct: 50 });
    hub.settings.setProject(dir, { retireAt: mark });
    const said = hub.handoffWorker(p, 'w1', 'orchestrator-1', 'heavy');
    assert.match(said, new RegExp(`Not available in proj: its hand-off mark \\(${mark}%\\) is at or below the hub's floor for early handoffs \\(35%\\)`));
    assert.equal(w.retiring, undefined);
    const l = hub.agentList(p);
    assert.match(l.handoff.note, /Not available in proj/);
    assert.match(l.workers[0].handoff_worker, /Not available in proj/);
  }
  const { hub, p, dir } = setup({ pct: 50 });
  hub.settings.setProject(dir, { retireAt: 36 });
  assert.equal(hub.agentList(p).workers[0].handoff_worker, 'available now', 'a mark just above the floor');
});

test('a handoff from a fresh draft: same model and effort, the handoff, the reason in both threads', () => {
  sent.length = 0;
  const { hub, p, w } = setup({ pct: 48, draft: true });
  const said = hub.handoffWorker(p, 'w1', 'orchestrator-1', 'half the task left; the next step needs no history');
  assert.match(said, /^Handed on: handoff H\d+ was written from w1's rolling draft/);
  const line = 'orchestrator-1 hands w1\'s task to a fresh agent at 48% of its context: half the task left; the next step needs no history';
  assert.ok(notices(p, 'w1').includes(line), 'the reason in the worker\'s thread');
  assert.ok(notices(p, 'orchestrator').includes(line), 'and in the orchestrator\'s');
  assert.deepEqual(p.log.ofType('worker_handoff').map(e => [e.agent, e.by, e.contextPct]), [['w1', 'orchestrator-1', 48]]);
  const succ = p.agents.get('w1-2');
  assert.ok(succ, 'a successor started');
  assert.deepEqual([succ.role, succ.predecessor, succ.task, succ.goal, succ.model, succ.effort, succ.type], ['worker', 'w1', 'Build the export panel', 'Export panel', 'claude-sonnet-5-5', 'medium', null]);
  assert.equal(succ.handoffEntry, w.leftHandoff);
  const h = p.board.read(w.leftHandoff);
  assert.match(h.body, /the export panel, half built/);
  assert.match(h.body, /### Facts \(from the hub\)\nTask goal: Export panel/);
  assert.equal(w.retiring, 'overlap', 'the old one stays for up to three questions (decision 16)');
  assert.ok(sent.some(([n, t]) => n === 'w1-2' && /taking over from w1/.test(t)));
  assert.ok(!sent.some(([n]) => n === 'w1'), 'the old one was not woken');
  assert.match(hub.handoffWorker(p, 'w1', 'orchestrator-1', 'again'), /already handing off/);
  clearTimeout(w.overlapTimer);
});

test('a handoff with no draft: the worker writes it, then the successor starts (the 60% path)', () => {
  sent.length = 0;
  const { hub, p, w } = setup({ pct: 40 });
  assert.match(hub.handoffWorker(p, 'w1', 'orchestrator-1', 'context heavy, review done'), /w1 is writing its handoff now/);
  assert.equal(w.retiring, 'writing');
  assert.match(sent.at(-1)[1], /Call write_handoff now/);
  assert.match(hub.writeHandoff(p, w, { in_flight: ['x'], promises: ['none'], risks: ['none'], next_steps: ['y'] }), /Handoff H\d+ posted/);
  w.state = 'idle';
  hub.onIdle(p, w);
  const succ = p.agents.get('w1-2');
  assert.deepEqual([succ.model, succ.effort, succ.handoffEntry], ['claude-sonnet-5-5', 'medium', w.leftHandoff]);
  clearTimeout(w.overlapTimer); clearTimeout(w.retireTimer);
});

test('the automatic handoff at the mark stays as it was', () => {
  const { hub, p, w } = setup({ pct: 61 });
  w.contextPct = 61;
  hub.onIdle(p, w);
  assert.equal(w.retiring, 'writing');
  assert.equal(p.log.ofType('worker_handoff').length, 0, 'not logged as the orchestrator\'s call');
  clearTimeout(w.retireTimer);
});

test('the floor: 35% by default, saved like the other numbers, bad values fall back', () => {
  assert.equal(SETTING_DEFAULTS.workerHandoffFloorPct, 35);
  const root = makeTmp('crux-hub-test-');
  const file = join(root, 'settings.json');
  const s = new HubSettings({ file });
  assert.equal(s.get('workerHandoffFloorPct'), 35);
  s.set({ workerHandoffFloorPct: 45 });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).workerHandoffFloorPct, 45, 'saved');
  assert.equal(new HubSettings({ file }).get('workerHandoffFloorPct'), 45, 'and read back after a restart');
  s.set({ workerHandoffFloorPct: 'x' }); s.set({ workerHandoffFloorPct: 101 }); s.set({ workerHandoffFloorPct: -1 }); s.set({ workerHandoffFloorPct: '' });
  assert.equal(s.get('workerHandoffFloorPct'), 45, 'ignored: the saved value stays');
  writeFileSync(file, JSON.stringify({ workerHandoffFloorPct: 'lots' }));
  assert.equal(new HubSettings({ file }).get('workerHandoffFloorPct'), 35, 'a bad saved value: the default');
  // A project with no number of its own does not get one.
  s.setProject('C:/a', { workerHandoffFloorPct: 10 });
  assert.equal(s.project('C:/a'), null, 'hub-wide only');

  // The hub reads it live.
  const { hub, p } = setup({ pct: 45, settings: { workerHandoffFloorPct: 50 } });
  assert.match(hub.handoffWorker(p, 'w1', 'orchestrator-1', 'heavy'), /at 45% of its context, below the 50% floor/);
  hub.settings.set({ workerHandoffFloorPct: 40 });
  assert.equal(hub.agentList(p).workers[0].handoff_worker, 'available now');
});

test('the Whole hub panel has the floor box with hover help; the project card does not', () => {
  const nums = { permissionTimeoutSec: '120', retireAt: '60', idleHandoffMin: '60', idleFloorPct: '25', workerHandoffFloorPct: '35' };
  const html = hubPanel({ route: true, nums, errors: {} });
  assert.match(html, /When the orchestrator may hand a worker on/);
  assert.match(html, /data-ps-num="workerHandoffFloorPct" value="35"/);
  assert.match(html, /title="The orchestrator may hand a worker&#39;s task to a fresh agent once/);
  const s = { routePermissions: true, permissionTimeoutSec: 120, retireAt: 60, idleHandoffMin: 60, idleFloorPct: 25, workerHandoffFloorPct: 35 };
  assert.deepEqual(hubChanges(s, { route: true, nums: { ...nums, workerHandoffFloorPct: '40' } }).body, { workerHandoffFloorPct: 40 });
  assert.deepEqual(hubChanges(s, { route: true, nums: { ...nums, workerHandoffFloorPct: '' } }).errors, { workerHandoffFloorPct: 'Needs a number' });
  assert.deepEqual(hubChanges(s, { route: true, nums: { ...nums, workerHandoffFloorPct: '120' } }).errors, { workerHandoffFloorPct: 'Between 0 and 100' });
  const card = projectCard({ name: 'g', permissionMode: 'auto', ownHandoff: {} }, { retireAt: 60, idleHandoffMin: 60, idleFloorPct: 25 }, { level: 'auto', connectors: false, nums: {}, errors: {} });
  assert.doesNotMatch(card, /workerHandoffFloorPct/);
});

test('the orchestrator is told when to use it', () => {
  const prompt = orchestratorPrompt({ project: 'x', generation: 1, index: '' });
  assert.match(prompt, /handoff_worker \(decision 46\) only from the floor in list_agents \(35% by\s+default\)/);
  assert.match(prompt, /Not in a review-fix loop/);
  assert.match(prompt, /Always give the one-line reason/);
});
