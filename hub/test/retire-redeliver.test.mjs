// Retiring a finished worker, and delivering messages that a hub restart cut off. Agents are stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';

const sent = [];
Agent.prototype.send = function (t) { sent.push([this.name, t]); this.state = 'working'; };
Agent.prototype.close = function () {};

function setup(events = []) {
  const root = mkdtempSync(join(tmpdir(), 'crux-hub-test-'));
  const dir = join(root, 'proj');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  if (events.length) writeFileSync(join(dir, '.crux', 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')) });
  return { hub, p: hub.project('proj') };
}
const ago = min => new Date(Date.now() - min * 60000).toISOString();
const ev = (type, min, extra) => ({ id: `${type}-${Math.random()}`, ts: ago(min), type, ...extra });

test('a finished worker retires with no successor', () => {
  const { hub, p } = setup();
  hub.startWorker(p, 'done-worker', 'Do a thing', 'orchestrator-1', 'A thing');
  const before = p.agents.size;
  assert.equal(hub.retireFinished(p, 'done-worker', 'orchestrator-1', 'merged'), 'done-worker retired.');
  assert.equal(p.agents.get('done-worker').state, 'retired');
  assert.equal(p.agents.size, before, 'no successor was created');
  assert.ok(p.log.ofType('notice').some(n => /orchestrator-1 retired done-worker as finished: merged/.test(n.text)));
  assert.match(hub.retireFinished(p, 'done-worker'), /already retired/);
  assert.throws(() => hub.retireFinished(p, 'nobody'), /No worker/);
});

test('a worker waiting on a permission card is not retired out from under it', () => {
  const { hub, p } = setup();
  const w = hub.startWorker(p, 'busy', 'Do a thing');
  hub.requestApproval(p, w, 'Bash', { command: 'npm install x' });
  assert.match(hub.retireFinished(p, 'busy'), /permission card/);
  assert.notEqual(w.state, 'retired');
});

test('a message cut off by a restart is delivered again, once, with a note', async () => {
  sent.length = 0;
  const { hub, p } = setup([
    ev('agent_created', 30, { agent: 'orchestrator-1', role: 'orchestrator', generation: 1, thread: 'orchestrator' }),
    ev('message', 20, { thread: 'orchestrator', from: 'orchestrator-1', text: 'Hi' }),
    ev('message', 2, { thread: 'orchestrator', from: 'you', text: 'retire phone-reach please' })
  ]);
  // The hub redelivers on a timer after start-up; under a busy parallel test run a fixed 5 ms was not always enough.
  for (let i = 0; i < 200 && !sent.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(sent, [['orchestrator-1', 'retire phone-reach please']]);
  assert.ok(p.log.ofType('notice').some(n => /restarted before your message/.test(n.text)));
});

test('answered, old, or quick-pick messages are not delivered again', async () => {
  sent.length = 0;
  setup([
    ev('agent_created', 60, { agent: 'orchestrator-1', role: 'orchestrator', generation: 1, thread: 'orchestrator' }),
    ev('message', 5, { thread: 'orchestrator', from: 'you', text: 'answered one' }),
    ev('message', 4, { thread: 'orchestrator', from: 'orchestrator-1', text: 'done' }),
    ev('agent_created', 26 * 60, { agent: 'w1', role: 'worker', thread: 'w1' }),
    ev('message', 25 * 60, { thread: 'w1', from: 'you', text: 'too old' }),   // older than the 24-hour resume window (M014)
    ev('agent_created', 60, { agent: 'w2', role: 'worker', thread: 'w2' }),
    ev('message', 3, { thread: 'w2', from: 'you', text: 'all' }),
    ev('pick', 3, { decision: 1, thread: 'orchestrator' })
  ]);
  await new Promise(r => setTimeout(r, 200));   // long enough for the start-up timer to have run, even under load
  assert.deepEqual(sent, []);
});
