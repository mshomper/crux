// Phone pushes for permission requests (decisions 19 and 21): only when a card becomes Matt's. A request with the
// orchestrator buzzes nothing; escalate, the timeout, a hard stop, routing off or no orchestrator do. A notification
// for a card settled afterwards is cleared with the next push. The hub runs for real; agents and web push are stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { Push, settledCard } from '../lib/push.mjs';

Agent.prototype.send = function () { this.state = 'working'; };
Agent.prototype.close = function () { this.q = null; };

function setup({ orchestrator = true, settings = {} } = {}) {
  const root = makeTmp('crux-push-route-');
  const dir = join(root, 'proj');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null, initial: settings }) });
  const p = hub.project('proj');
  p.board.addEntry({ kind: 'requirement', title: 'Orchestrator permission rules (test)', summary: 'rules', body: 'The orchestrator may ALLOW project work.', from: 'you' });
  const orch = orchestrator ? hub.ensureOrchestrator(p) : null;
  const w = hub.startWorker(p, 'builder', 'Build it', 'you', 'Build it');
  const pushed = [];
  const sender = { generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }), sendNotification: async (_s, body) => { pushed.push(JSON.parse(body)); } };
  const push = new Push({ dir: join(root, 'data'), sender, timers: { setTimeout() { }, clearTimeout() { } } });
  push.subscribe({ endpoint: 'https://push.example/phone', keys: { p256dh: 'k', auth: 'a' } }, 'iPhone');
  // As in server.mjs: every logged event goes to the push side, with the live approvals.
  hub.on(ev => { if (ev.logged) push.handle(ev, { approvals: hub.approvals, decisionOpen: () => false, events: () => p.log.events }); });
  const ask = command => hub.requestApproval(p, w, 'Bash', { command, description: 'a step' });
  const last = type => p.log.ofType(type).at(-1);
  return { hub, p, orch, w, pushed, ask, last };
}
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };

test('routed to the orchestrator and answered in time: no push, ever', async () => {
  const { hub, p, orch, pushed, ask, last } = setup();
  const pending = ask('npm run build');
  await settle();
  assert.equal(pushed.length, 0, 'none when it is created');
  hub.answerPermission(p, orch, last('approval').approval, 'allow', 'project work');
  await pending; await settle();
  assert.equal(pushed.length, 0, 'none after it is answered');
});

test('the orchestrator escalates: one push', async () => {
  const { hub, p, orch, pushed, ask, last } = setup();
  ask('node scripts/migrate.mjs');
  const id = last('approval').approval;
  await settle();
  assert.equal(pushed.length, 0);
  hub.answerPermission(p, orch, id, 'escalate', 'Matt should look');
  await settle();
  assert.deepEqual(pushed.map(x => x.card), [`approval:${id}`]);
});

test('no answer within two minutes: one push, at the timeout and not before', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { pushed, ask, last } = setup();
  ask('npm run build');
  const id = last('approval').approval;
  t.mock.timers.tick(119_000);
  await settle();
  assert.equal(pushed.length, 0);
  t.mock.timers.tick(1_000);
  await settle();
  assert.deepEqual(pushed.map(x => x.card), [`approval:${id}`]);
});

test('a hard stop: pushed straight away', async () => {
  const { pushed, ask, last } = setup();
  ask('git push origin main');
  assert.equal(last('approval').routedTo, null);
  await settle();
  assert.deepEqual(pushed.map(x => x.card), [`approval:${last('approval').approval}`]);
});

test('routing switched off, or no orchestrator: pushed straight away', async () => {
  for (const opts of [{ settings: { routePermissions: false } }, { orchestrator: false }]) {
    const { pushed, ask } = setup(opts);
    ask('npm run build');
    await settle();
    assert.equal(pushed.length, 1, JSON.stringify(opts));
  }
});

test('a notification for a card settled afterwards is cleared from the phone with the next push', async () => {
  const { hub, pushed, ask, last } = setup();
  ask('git push origin main');
  const first = last('approval').approval;
  await settle();
  hub.answerApproval(first, false, 'not now');   // answered on the PC
  await settle();
  assert.equal(pushed.length, 1, 'clearing never sends a push of its own');
  ask('git push origin main --tags');
  await settle();
  assert.deepEqual(pushed[1].close, [`approval:${first}`]);
  ask('git push origin feat/x --force');
  await settle();
  assert.equal(pushed[2].close, undefined, 'cleared once');
});

test('which events settle a card', () => {
  assert.equal(settledCard({ type: 'approval_result', approval: 'a1' }), 'approval:a1');
  assert.equal(settledCard({ type: 'pick', decision: 41 }), 'decision:41');
  assert.equal(settledCard({ type: 'question_dismissed', question: 'q1' }), 'question:q1');
  assert.equal(settledCard({ type: 'question_dismissed', question: 'q1', index: 0 }), null, 'one row of several: the card stays');
  assert.equal(settledCard({ type: 'message' }), null);
});
