// The mid-turn context warning: when an agent passes its mark + 15 points (at most 85%) during a turn, the hub sends one
// message; the end-of-turn handoff still follows. Agents are stubbed, so nothing starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';

const sent = [];
Agent.prototype.send = function (t) { sent.push([this.name, t]); this.state = 'working'; };
Agent.prototype.close = function () {};

const ev = (type, extra) => ({ id: `${type}-${Math.random()}`, ts: new Date(Date.now() - 60000).toISOString(), type, ...extra });

function setup() {
  const root = makeTmp('crux-hub-test-');
  const dir = join(root, 'proj');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  const events = [
    ev('agent_created', { agent: 'orchestrator-1', role: 'orchestrator', generation: 1, thread: 'orchestrator' }),
    ev('agent_created', { agent: 'w1', role: 'worker', task: 'Build', goal: 'Build', thread: 'w1' })
  ];
  writeFileSync(join(dir, '.crux', 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null, initial: {} }) });
  hub.run = () => '';
  const p = hub.project('proj');
  const w = p.agents.get('w1'), o = p.agents.get('orchestrator-1');
  for (const a of [w, o]) { a.state = 'working'; a.inTurn = true; }
  sent.length = 0;
  return { hub, p, w, o };
}
// A stand-in for the live query: getContextUsage answers with the given percentage.
const qAt = pct => ({ getContextUsage: async () => ({ percentage: pct }) });
const read = async (a, pct) => { a.q = qAt(pct); a.lastCtxRead = 0; await a.checkContextMidTurn(a.q); };

test('a worker is warned once when it passes its mark + 15 (75%), not below, not twice', async () => {
  const { w } = setup();
  await read(w, 74);
  assert.equal(sent.length, 0, 'below the level: nothing');
  await read(w, 76);
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /^\[From the hub\] You are at 76% of your context\. Finish the step you're on.*hands your task on after it\.$/);
  await read(w, 80);
  assert.equal(sent.length, 1, 'once per turn');
});

test('the next turn warns again; an orchestrator gets "the role" and its project mark + 15, capped at 85%', async () => {
  const { hub, p, w, o } = setup();
  await read(w, 80);
  w.warnedThisTurn = false;   // what a result does
  await read(w, 80);
  assert.equal(sent.length, 2);
  hub.setHandoffNumbers(p, { retireAt: 80 });
  assert.equal(hub.warnLevelFor(p, o), 85, 'capped');
  await read(o, 84);
  assert.equal(sent.length, 2);
  await read(o, 85);
  assert.match(sent[2][1], /hands the role on after it/);
});

test('no warning for a closing expedition member, a retiring agent, or the Conductor', async () => {
  const { hub, p, w } = setup();
  w.expedition = 'x';
  hub.expeditionClosing = () => true;
  await read(w, 90);
  assert.equal(sent.length, 0);
  hub.expeditionClosing = () => false;
  await read(w, 90);
  assert.equal(sent.length, 1, 'an open expedition is warned');
  w.warnedThisTurn = false; w.retiring = 'writing';
  await read(w, 90);
  assert.equal(sent.length, 1);
  const c = { role: 'conductor', contextPct: 99, name: 'c', send() { sent.push(['c']); } };
  assert.equal(hub.midTurnWarn(p, c), false);
});

test('reads are throttled, and the end-of-turn handoff still follows', async () => {
  const { hub, w, p } = setup();
  let calls = 0;
  w.q = { getContextUsage: async () => { calls++; return { percentage: 10 }; } };
  await w.checkContextMidTurn(w.q);
  await w.checkContextMidTurn(w.q);
  assert.equal(calls, 1, 'second read inside 20 s is skipped');
  await read(w, 80);
  assert.equal(sent.length, 1);
  const retired = [];
  hub.retire = (_p, a, o) => retired.push([a.name, o.reason]);
  w.state = 'idle'; w.contextPct = 80;
  w.warnedThisTurn = false;
  hub.onIdle(p, w);
  assert.deepEqual(retired, [['w1', 'threshold']]);
});
