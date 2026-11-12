// Test hubs start no real agents unless a test asks for one (orchestrator, 2026-11-11).
// Agent.start is stubbed here so that a broken guard would show up as a failed test, never as a real agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { testHubWithoutAgents } from '../lib/relaunch.mjs';

let started = 0;
Agent.prototype.start = function () { started++; this.q = { close() { } }; this.inbox = { push() { } }; };

test('which hubs count as test hubs', () => {
  const tmp = join(tmpdir());
  assert.equal(testHubWithoutAgents({ args: ['--no-agents'], env: {} }), true, 'the flag');
  assert.equal(testHubWithoutAgents({ args: [], env: { CRUX_HUB_DATA: join(tmp, 'hub-ui-test', 'data') } }), true, 'data in the temp folder');
  assert.equal(testHubWithoutAgents({ args: [], env: { CRUX_HUB_DATA: join(tmp, 'x').toUpperCase() } }), true, 'any letter case');
  assert.equal(testHubWithoutAgents({ args: [], env: {} }), false, 'Matt\'s hub: no flag, data in ~/.crux-hub');
  assert.equal(testHubWithoutAgents({ args: [], env: { CRUX_HUB_DATA: join(homedir(), '.crux-hub') } }), false);
  assert.equal(testHubWithoutAgents({ args: [], env: { CRUX_HUB_DATA: tmp + '-other' } }), false, 'a folder that only starts like the temp folder');
  assert.equal(testHubWithoutAgents({ args: ['--no-agents'], env: { CRUX_HUB_AGENTS: '1' } }), false, 'a test that asks for real agents gets them');
});

test('in a test hub a message is kept but no agent starts, with one note in the thread', () => {
  const root = mkdtempSync(join(tmpdir(), 'crux-hub-noagents-'));
  const dir = join(root, 'proj');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), noAgents: true });
  const p = hub.project('proj');
  started = 0;
  const w = hub.startWorker(p, 'w1', 'Do a thing');
  hub.fromYou(p, 'w1', 'Hello?');
  hub.fromYou(p, 'orchestrator', 'Anyone there?');
  assert.equal(started, 0, 'no Claude Code process');
  assert.equal(w.q, null);
  assert.ok(p.log.ofType('message').some(m => m.from === 'you' && m.text === 'Hello?'), 'the message is logged');
  const notes = p.log.ofType('notice').filter(n => /Test hub: .* does not start here/.test(n.text));
  assert.deepEqual(notes.map(n => n.thread).sort(), ['orchestrator', 'w1'], 'one note per agent, not per message');

  const real = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')) });
  real.fromYou(real.project('proj'), 'w1', 'Now?');
  assert.equal(started, 1, 'an ordinary hub starts the agent');
});
