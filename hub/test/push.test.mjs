import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cardsFor, isLooking, stillOpen, payloadOf, Push, QUESTION_GRACE_MS } from '../lib/push.mjs';

const approvalEv = { id: 'e1', type: 'approval', project: 'crux', thread: 'phone-reach', approval: 'ap-1', agent: 'phone-reach', tool: 'Bash', input: { command: 'rm -rf secret-folder' } };
const summaryEv = { id: 'e2', type: 'summary', project: 'crux', thread: 'w1', from: 'w1', questions: ['Which port?'], decisions_needed: [20, 21], done: ['wrote secret.txt'] };

test('an approval, a decision and a question each become a card', () => {
  assert.deepEqual(cardsFor(approvalEv).map(c => c.card), ['approval:ap-1']);
  const cs = cardsFor(summaryEv, { decisionOpen: id => id === 20 });
  assert.deepEqual(cs.map(c => c.card), ['decision:20', 'question:e2']); // 21 is no longer open
  assert.equal(cs[1].delayMs, QUESTION_GRACE_MS);
  for (const type of ['message', 'notice', 'pick', 'entry', 'visual']) assert.deepEqual(cardsFor({ ...summaryEv, type }), []);
  assert.deepEqual(cardsFor({ ...summaryEv, questions: [], decisions_needed: [] }), []);
});

test('the payload is minimal: kind, short title, card id, and a link; never commands or file contents', () => {
  const p = payloadOf(cardsFor(approvalEv)[0]);
  assert.deepEqual(Object.keys(p).sort(), ['body', 'card', 'kind', 'project', 'title', 'url']);
  const all = JSON.stringify([p, ...cardsFor(summaryEv).map(payloadOf)]);
  for (const leak of ['rm -rf', 'secret', 'Which port']) assert.ok(!all.includes(leak), leak);
  assert.equal(p.url, '/?project=crux&card=approval%3Aap-1');
});

test('a card you are looking at on the desktop does not notify', () => {
  const card = cardsFor(approvalEv)[0];
  const now = 1_000_000;
  const at = (o) => [{ project: 'crux', thread: 'needs', visible: true, focused: true, idleMs: 1000, ts: now - 5000, ...o }];
  assert.ok(isLooking(card, at({}), now));
  assert.ok(isLooking(card, at({ thread: 'phone-reach' }), now));
  assert.ok(!isLooking(card, at({ thread: 'orchestrator' }), now), 'another thread');
  assert.ok(!isLooking(card, at({ project: 'other' }), now), 'another project');
  assert.ok(!isLooking(card, at({ focused: false }), now), 'window in the background');
  assert.ok(!isLooking(card, at({ visible: false }), now), 'tab hidden');
  assert.ok(!isLooking(card, at({ idleMs: 3 * 60 * 1000 }), now), 'walked away from a focused window');
  assert.ok(!isLooking(card, at({ ts: now - 60 * 1000 }), now), 'stale report');
  assert.ok(!isLooking(card, [], now));
});

test('a card answered before the push goes out is not sent', () => {
  const approvals = new Map([['ap-1', {}]]);
  const decisionOpen = id => id === 20;
  const events = [summaryEv];
  const [d20, q] = cardsFor(summaryEv, { decisionOpen });
  assert.ok(stillOpen(cardsFor(approvalEv)[0], { approvals, decisionOpen, events }));
  assert.ok(!stillOpen(cardsFor(approvalEv)[0], { approvals: new Map(), decisionOpen, events }));
  assert.ok(stillOpen(d20, { approvals, decisionOpen, events }));
  assert.ok(!stillOpen(d20, { approvals, decisionOpen: () => false, events }));
  assert.ok(stillOpen(q, { approvals, decisionOpen, events: [...events, { type: 'message', thread: 'w1', from: 'w1', text: 'more' }] }));
  assert.ok(!stillOpen(q, { approvals, decisionOpen, events: [...events, { type: 'message', thread: 'w1', from: 'orchestrator-1', text: 'Use 4747' }] }));
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'crux-push-'));
  const sent = [];
  const timers = { queue: [], setTimeout(fn, ms) { this.queue.push({ fn, ms }); }, clearTimeout() { } };
  const sender = {
    generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }),
    sendNotification: async (sub, body) => { if (sub.endpoint.includes('gone')) throw Object.assign(new Error('gone'), { statusCode: 410 }); sent.push({ to: sub.endpoint, body: JSON.parse(body) }); }
  };
  const push = new Push({ dir, sender, timers });
  const sub = ep => ({ endpoint: ep, keys: { p256dh: 'k', auth: 'a' } });
  const ctx = { approvals: new Map([['ap-1', {}]]), decisionOpen: (_p, id) => id === 20, events: () => [summaryEv] };
  return { dir, sent, timers, push, sub, ctx, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const settle = () => new Promise(r => setImmediate(r));

test('pushes go to every device once, questions after a grace period, dropped devices are forgotten', async () => {
  const h = harness();
  try {
    h.push.handle(approvalEv, h.ctx);
    await settle();
    assert.equal(h.sent.length, 0, 'no devices yet');

    h.push.subscribe(h.sub('https://push.example/phone'), 'iPhone');
    h.push.subscribe(h.sub('https://push.example/gone'), 'old phone');
    assert.ok(existsSync(join(h.dir, 'push-subscriptions.json')));
    assert.throws(() => h.push.subscribe({ endpoint: 'http://insecure' }), /subscription/);

    h.push.handle(approvalEv, h.ctx);
    h.push.handle(approvalEv, h.ctx); // the same card twice
    await settle(); await settle();
    assert.deepEqual(h.sent.map(s => s.body.card), ['approval:ap-1']);
    assert.deepEqual(h.push.subs.map(s => s.label), ['iPhone'], 'the 410 device is dropped');

    h.push.handle(summaryEv, h.ctx);
    await settle(); await settle();
    assert.deepEqual(h.sent.map(s => s.body.card), ['approval:ap-1', 'decision:20'], 'question waits');
    assert.equal(h.timers.queue.length, 1);
    h.timers.queue[0].fn();
    await settle(); await settle();
    assert.deepEqual(h.sent.map(s => s.body.card), ['approval:ap-1', 'decision:20', 'question:e2']);
  } finally { h.done(); }
});

test('nothing is pushed while you are using the hub on that view', async () => {
  const h = harness();
  try {
    h.push.subscribe(h.sub('https://push.example/phone'));
    h.push.presence('desk', { project: 'crux', thread: 'needs', visible: true, focused: true, idleMs: 0 });
    h.push.handle(approvalEv, h.ctx);
    await settle();
    assert.equal(h.sent.length, 0);
    h.push.presence('desk', { gone: true });
    h.push.handle(approvalEv, h.ctx);
    await settle(); await settle();
    assert.equal(h.sent.length, 1, 'sent once the page closed');
  } finally { h.done(); }
});

test('VAPID keys are generated once and kept outside the repo', async () => {
  const h = harness();
  try {
    const k = await h.push.keys();
    assert.equal(k.publicKey, 'pub');
    assert.deepEqual(JSON.parse(readFileSync(join(h.dir, 'vapid.json'), 'utf8')), k);
    assert.ok(!h.dir.includes('GitHub'));
  } finally { h.done(); }
});
