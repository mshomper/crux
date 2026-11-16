// A card held because you are looking at it is not dropped: 3 minutes on, if it still waits and you are gone, the phone
// gets it (decision 58 stays: PC first, phone as backup). Every notice decision is also reported (notice_routed), by
// card id only (C001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTmp, removeTmp } from './helpers/tmp.mjs';
import { Push, PHONE_FOLLOWUP_MS } from '../lib/push.mjs';

const approvalEv = { id: 'e1', type: 'approval', project: 'crux', thread: 'w1', approval: 'ap-1', agent: 'w1', tool: 'Bash', input: { command: 'gh pr merge 99 --merge' } };
const settle = () => new Promise(r => setImmediate(r));
const looking = { project: 'crux', thread: 'needs', visible: true, focused: true, idleMs: 0 };

function harness() {
  const dir = makeTmp('crux-rearm-');
  const phoneSent = [], routed = [];
  const timers = { queue: [], setTimeout(fn, ms) { this.queue.push({ fn, ms }); }, clearTimeout() { }, run(ms) { for (const t of this.queue.splice(0)) if (t.ms === ms) t.fn(); else this.queue.push(t); } };
  const sender = { generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }), sendNotification: async (_s, body) => { phoneSent.push(JSON.parse(body)); } };
  const push = new Push({ dir, sender, timers, log: () => { } });
  push.subscribe({ endpoint: 'https://push.example/phone', keys: { p256dh: 'k', auth: 'a' } }, 'iPhone');
  push.onRouted = r => routed.push(r);
  const approvals = new Map([['ap-1', {}]]);
  return { push, timers, phoneSent, routed, approvals, ctx: { approvals, decisionOpen: () => false, events: () => [] }, done: () => removeTmp(dir) };
}

test('held while you look, still waiting 3 minutes later with nobody looking: the phone gets it', async () => {
  const h = harness();
  try {
    h.push.presence('page', looking);
    h.push.handle(approvalEv, h.ctx); await settle();
    assert.equal(h.phoneSent.length, 0, 'held while you look');
    assert.equal(h.timers.queue[0]?.ms, PHONE_FOLLOWUP_MS, 'a 3-minute check is set');
    h.push.presence('page', { gone: true });   // you walked away
    h.timers.run(PHONE_FOLLOWUP_MS); await settle();
    assert.deepEqual(h.phoneSent.map(p => p.card), ['approval:ap-1']);
    assert.deepEqual(h.routed.map(r => [r.card, r.to]), [['approval:ap-1', 'held'], ['approval:ap-1', 'phone']]);
    assert.ok(h.routed.every(r => Object.keys(r).sort().join() === 'card,project,reason,to'), 'id, destination and a fixed reason only');
    assert.ok(!JSON.stringify(h.routed).includes('gh pr merge'), 'no command text');
  } finally { h.done(); }
});

test('still looking at the 3-minute check: it waits another 3 minutes instead of being dropped', async () => {
  const h = harness();
  try {
    h.push.presence('page', looking);
    h.push.handle(approvalEv, h.ctx); await settle();
    h.timers.run(PHONE_FOLLOWUP_MS); await settle();
    assert.equal(h.phoneSent.length, 0);
    assert.equal(h.timers.queue[0]?.ms, PHONE_FOLLOWUP_MS, 'checked again later');
    h.push.presence('page', { gone: true });
    h.timers.run(PHONE_FOLLOWUP_MS); await settle();
    assert.deepEqual(h.phoneSent.map(p => p.card), ['approval:ap-1']);
  } finally { h.done(); }
});

test('answered while it was held: nothing is sent, and the check says so', async () => {
  const h = harness();
  try {
    h.push.presence('page', looking);
    h.push.handle(approvalEv, h.ctx); await settle();
    h.approvals.delete('ap-1');
    h.push.presence('page', { gone: true });
    h.timers.run(PHONE_FOLLOWUP_MS); await settle();
    assert.equal(h.phoneSent.length, 0);
    assert.deepEqual(h.routed.map(r => r.to), ['held', 'skipped']);
  } finally { h.done(); }
});

test('with no phone set up, a held card sets no check', async () => {
  const h = harness();
  try {
    h.push.subs.length = 0;
    h.push.desktopAttach('d', () => { });
    h.push.presence('page', looking);
    h.push.handle(approvalEv, h.ctx); await settle();
    assert.equal(h.timers.queue.length, 0);
  } finally { h.done(); }
});
