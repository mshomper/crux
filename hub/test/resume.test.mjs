// M014: after a restart, agents that were mid-turn, or had a message they never acted on, resume on their own,
// in every project, a few seconds apart. Agents are stubbed: nothing here starts Claude Code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../lib/agent.mjs';
import { Hub, RESUME_GAP_MS } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { pageBuild } from '../lib/relaunch.mjs';

const sent = [];
Agent.prototype.send = function (t) { sent.push([this.project.name, this.name, t]); };
Agent.prototype.close = function () { };

const ago = min => new Date(Date.now() - min * 60000).toISOString();
let n = 0;
const ev = (type, min, extra) => ({ id: `${type}-${++n}`, ts: ago(min), type, ...extra });
function project(root, name, events) {
  const dir = join(root, name);
  mkdirSync(join(dir, '.crux'), { recursive: true });
  writeFileSync(join(dir, '.crux', 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}
const created = (agent, role = 'worker', min = 120) => ev('agent_created', min, { agent, role, thread: role === 'orchestrator' ? 'orchestrator' : agent, generation: role === 'orchestrator' ? 1 : 0 });

test('each turn\'s start and end are logged, but not while the hub is stopping', () => {
  const root = mkdtempSync(join(tmpdir(), 'crux-resume-'));
  const hub = new Hub({ projects: [project(root, 'p', [created('w1')])], memory: new Memory(join(root, 'home')) });
  const p = hub.project('p'), w = p.agents.get('w1');
  w.setState('starting'); w.setState('working'); w.setState('idle'); w.setState('asleep');
  assert.deepEqual(p.log.ofType('agent_busy').map(e => e.busy), [true, false], 'one event per change, not per state');
  w.setState('working');
  hub.stopping = true;
  w.setState('asleep');   // the hub shutting down cuts the turn; it is not finished
  assert.deepEqual(p.log.ofType('agent_busy').map(e => e.busy), [true, false, true]);
});

test('who resumes: mid-turn agents and unread messages, in every project; resting agents stay asleep', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sent.length = 0;
  const root = mkdtempSync(join(tmpdir(), 'crux-resume-'));
  const a = project(root, 'lab', [
    created('orchestrator-1', 'orchestrator'),
    created('busy'), ev('agent_busy', 30, { agent: 'busy', busy: true }),
    created('resting'), ev('agent_busy', 40, { agent: 'resting', busy: true }), ev('agent_busy', 39, { agent: 'resting', busy: false }),
    created('briefed'), ev('message', 2, { thread: 'briefed', from: 'orchestrator-1', text: 'Next: tidy the README.' }),
    created('stale'), ev('agent_busy', 30 * 60, { agent: 'stale', busy: true }),   // 30 hours ago: too old
    created('gone'), ev('agent_busy', 20, { agent: 'gone', busy: true }), ev('agent_retired', 10, { agent: 'gone', thread: 'gone' }),
    ev('agent_busy', 5, { agent: 'orchestrator-1', busy: true })
  ]);
  const b = project(root, 'crux', [created('orchestrator-1', 'orchestrator'), ev('message', 3, { thread: 'orchestrator', from: 'you', text: 'Status?' })]);
  const hub = new Hub({ projects: [a, b], memory: new Memory(join(root, 'home')), noAgents: false });

  t.mock.timers.tick(0);   // the hub plans once its listeners are attached
  assert.deepEqual(hub.resumed.map(r => [r.project, r.agent, r.why]), [
    ['lab', 'busy', 'working'], ['lab', 'briefed', 'message'], ['lab', 'orchestrator-1', 'working'],
    ['crux', 'orchestrator-1', 'message']
  ], 'workers first, then each orchestrator; resting, stale and retired agents stay asleep');
  assert.equal(sent.length, 1, 'the first starts at once');
  t.mock.timers.tick(RESUME_GAP_MS);
  assert.equal(sent.length, 2, 'the next one a few seconds later');
  t.mock.timers.tick(RESUME_GAP_MS * 3);
  assert.deepEqual(sent.map(s => s.slice(0, 2)), [['lab', 'busy'], ['lab', 'briefed'], ['lab', 'orchestrator-1'], ['crux', 'orchestrator-1']]);
  assert.match(sent[0][2], /The hub restarted while you were working[\s\S]*Carry on where you left off/);
  assert.equal(sent[1][2], '[From the orchestrator, orchestrator-1]\nNext: tidy the README.', 'a brief that never reached its worker is sent again as a brief');
  assert.equal(sent[3][2], 'Status?');
  const lab = hub.project('lab');
  assert.ok(lab.log.ofType('notice').some(x => x.thread === 'busy' && /restarted while busy was working; it was asked to carry on/.test(x.text)));
  assert.ok(lab.log.ofType('notice').some(x => x.thread === 'briefed' && /before the message from orchestrator-1/.test(x.text)));
  const stale = lab.log.ofType('agent_busy').filter(e => e.agent === 'stale').at(-1);
  assert.deepEqual([stale.busy, stale.stale], [false, true], 'a turn too old to resume is closed, so it is not picked up later');
});

test('a message the agent already acted on is not resent; neither is one to a worker that has retired', () => {
  const root = mkdtempSync(join(tmpdir(), 'crux-resume-'));
  const hub = new Hub({ projects: [project(root, 'p', [
    created('w1'), ev('message', 10, { thread: 'w1', from: 'orchestrator-1', text: 'Go' }), ev('message', 9, { thread: 'w1', from: 'w1', text: 'On it' }),
    created('w2'), ev('message', 5, { thread: 'w2', from: 'you', text: 'Hi' }), ev('agent_retired', 4, { agent: 'w2', thread: 'w2' })
  ])], memory: new Memory(join(root, 'home')) });
  assert.deepEqual(hub.resumePlan(hub.project('p')), []);
});

test('the page fingerprint changes when any page file does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crux-build-'));
  mkdirSync(join(dir, 'icons'));
  writeFileSync(join(dir, 'app.js'), 'one');
  writeFileSync(join(dir, 'icons', 'a.svg'), '<svg/>');
  const first = pageBuild(dir);
  assert.match(first, /^[0-9a-f]{12}$/);
  assert.equal(pageBuild(dir), first, 'the same files, the same fingerprint');
  writeFileSync(join(dir, 'icons', 'a.svg'), '<svg />');
  assert.notEqual(pageBuild(dir), first);
  assert.equal(pageBuild(join(dir, 'missing')), 'unknown');
});
