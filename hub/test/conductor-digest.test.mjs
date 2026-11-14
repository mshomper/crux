// Decision 60 A: the Conductor is a live contact while you are here (the real cards go up in its chat, with its notes)
// and holds cards for one digest while you are away (on your return, or every 30 minutes at most, with one phone
// notice). Agents and web push are stubbed; the hub and the push routing run for real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { Push, PC_IDLE_MS } from '../lib/push.mjs';
import { CONDUCTOR_THREAD } from '../lib/conductor.mjs';
import * as CP from '../public/conductor-view.js';
import { projectOf } from '../public/all-projects.js';

const sent = [];
Agent.prototype.send = function (t) { sent.push([this.name, t]); this.state = 'working'; };
Agent.prototype.close = function () {};
const summary = (over = {}) => ({ done: [], changed: [], questions: [], decisions_needed: [], blocked_on: [], next_step: '', visuals: [], approvals: [], open_questions: [], ...over });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function setup({ here = true } = {}) {
  await sleep(2);
  const root = mkdtempSync(join(tmpdir(), 'crux-digest-test-'));
  const dirs = ['alpha', 'beta'].map(n => { const d = join(root, n); mkdirSync(join(d, '.crux'), { recursive: true }); return d; });
  const hub = new Hub({ projects: dirs, memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }), conductorDir: join(root, 'data', 'conductor') });
  const c = hub.conductor;
  c.wakeMs = 30;
  const presence = { here };
  hub.presence = () => presence.here;
  const notices = [];
  hub.digestNotice = info => notices.push(info);
  await sleep(2);
  sent.length = 0;
  const a = hub.project('alpha'), b = hub.project('beta');
  const ask = (p, q) => { hub.postSummary(p, hub.ensureOrchestrator(p), summary({ questions: [q] })); return p.log.events.findLast(e => e.type === 'summary').id; };
  const toC = () => sent.filter(([n]) => n.startsWith('conductor'));
  return { hub, c, a, b, root, dirs, presence, notices, ask, toC, cards: () => c.home.log.ofType('cards') };
}

test('away: cards are held, no wake and no cards in the chat; your return posts one digest and asks for its notes', async () => {
  const { c, a, b, presence, notices, ask, toC, cards } = await setup({ here: false });
  ask(a, 'Retry failed uploads three times before showing the error?');
  ask(b, 'Use the cyan or the violet focus ring here?');
  await sleep(80);
  assert.equal(cards().length, 0);
  assert.equal(toC().length, 0);
  assert.equal(c.holding(), true);
  assert.equal(c.view({ events: false }).held, 2);
  presence.here = true;
  c.presenceReport();   // the desktop app or a page reported in
  assert.equal(cards().length, 1);
  assert.equal(cards()[0].digest, 'return');
  assert.deepEqual(cards()[0].items.map(i => i.project), ['alpha', 'beta']);
  assert.equal(c.holding(), false);
  assert.equal(toC().length, 1);
  assert.match(toC()[0][1], /^\[Hub: digest after time away for/);
  assert.match(toC()[0][1], /Add intro/);
  assert.equal(notices.length, 0, 'no phone notice when you are back');
  // A report while nothing is held does nothing.
  c.presenceReport();
  assert.equal(cards().length, 1);
});

test('digest timing: one digest 30 minutes (here: 100 ms) after the oldest held card, with one notice; the next not sooner', async () => {
  const { c, a, b, notices, ask, cards } = await setup({ here: false });
  c.digestMs = 100;
  ask(a, 'Retry failed uploads three times before showing the error?');
  await sleep(20);
  ask(b, 'Use the cyan or the violet focus ring here?');
  await sleep(50);
  assert.equal(cards().length, 0, 'not before the window');
  await sleep(90);
  assert.equal(cards().length, 1);
  assert.equal(cards()[0].digest, 'away');
  assert.equal(cards()[0].items.length, 2);
  assert.deepEqual(notices.map(n => [n.count, n.projects]), [[2, 2]], 'one notice for the digest');
  // A card after that digest waits a full window from the digest, not just from itself.
  ask(a, 'Ship the lens picker on Friday or wait for the review?');
  await sleep(60);
  assert.equal(cards().length, 1);
  await sleep(120);
  assert.equal(cards().length, 2);
  assert.equal(notices.length, 2);
});

test('settled while you were away: those cards drop out of the digest; with none left there is no digest and no turn', async () => {
  const { hub, c, a, b, presence, ask, toC, cards } = await setup({ here: false });
  const q1 = ask(a, 'Retry failed uploads three times before showing the error?');
  ask(b, 'Use the cyan or the violet focus ring here?');
  await sleep(80);
  hub.dismissQuestion(a, q1);
  presence.here = true;
  c.presenceReport();
  assert.deepEqual(cards()[0].items.map(i => i.project), ['beta']);
  assert.doesNotMatch(toC()[0][1], /alpha/);
  // Away again; both settle before you return: nothing at all.
  presence.here = false;
  const s = await setup({ here: false });
  const x = s.ask(s.a, 'Retry failed uploads three times before showing the error?');
  const y = s.ask(s.b, 'Use the cyan or the violet focus ring here?');
  await sleep(80);
  s.hub.dismissQuestion(s.a, x);
  s.hub.fromYou(s.b, 'orchestrator', 'Cyan.');
  s.presence.here = true;
  s.c.presenceReport();
  assert.equal(s.cards().length, 0);
  assert.equal(s.toC().length, 0);
  assert.ok(s.c.home.log.events.some(e => e.type === 'wake_taken'));
  assert.ok(y);
});

test('your message while cards are held: the digest goes up above it, and its notes ride along with your message', async () => {
  const { c, a, ask, toC, cards } = await setup({ here: false });
  ask(a, 'Retry failed uploads three times before showing the error?');
  await sleep(80);
  c.fromYou('Morning. What happened?');
  assert.equal(cards().length, 1);
  assert.equal(cards()[0].digest, 'return');
  const evs = c.home.log.events, ci = evs.findIndex(e => e.type === 'cards'), mi = evs.findIndex(e => e.type === 'message' && e.from === 'you');
  assert.ok(ci < mi, 'cards first, then your message');
  assert.equal(toC().length, 1);
  assert.equal(toC()[0][1], 'Morning. What happened?');
  assert.match(c.holder().notes?.[0] || '', /\[Hub: digest after time away/);
});

test('a due reminder still wakes it while you are away, and leaves the held cards held (also after a restart)', async () => {
  const { c, a, root, dirs, ask, toC, cards } = await setup({ here: false });
  ask(a, 'Retry failed uploads three times before showing the error?');
  await sleep(80);
  c.setReminder(new Date(Date.now() + 1000).toISOString(), 'Stretch', 'conductor-1');
  assert.equal(c.dueReminders(Date.now() + 5000), 1);
  assert.match(toC().at(-1)[1], /Reminder rem-001 is due/);
  assert.equal(cards().length, 0);
  assert.equal(c.holding(), true);
  assert.equal(c.pending.filter(x => !x.reminder).length, 1);
  c.stop();
  const again = new Hub({ projects: dirs, memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }), conductorDir: join(root, 'data', 'conductor') });
  assert.equal(again.conductor.pending.length, 1, 'the held line survives the reminder wake and a restart');
  again.conductor.stop();
});

test('note_cards: notes attach to the cards in its chat; unknown cards are ignored; it answers nothing', async () => {
  const { hub, c, a, b, ask, cards } = await setup();
  const q = ask(a, 'Retry failed uploads three times before showing the error?');
  hub.approvals.set('ap1', { p: b });
  b.log.append('approval', { thread: 'w1', approval: 'ap1', agent: 'w1', tool: 'Bash', input: { command: 'npm test', description: 'Run the tests' }, routedTo: null });
  await sleep(80);
  assert.equal(cards().length, 1);
  const k = c.holder();
  const handler = c.tools(k).instance._registeredTools.note_cards.handler;
  const r = await handler({ intro: 'atlas is drawing tiles', items: [
    { project: 'alpha', card: `question:${q}`, summary: 'Failed uploads: retry or stop?', recommend: 'Retry 3 times', fill: 'Retry 3 times, then show the error.' },
    { project: 'beta', card: 'approval:ap1', summary: 'Run the tests', recommend: 'Allow', fill: 'allow' },
    { project: 'beta', card: 'decision:99', summary: 'not in the chat', recommend: 'A' }
  ] }, {});
  assert.match(r.content[0].text, /Noted 2 cards/);
  const notes = CP.cardNotes(c.home.log.events, cards()[0].id);
  assert.equal(notes.intro, 'atlas is drawing tiles');
  assert.equal(notes.items.get(`alpha|question:${q}`).fill, 'Retry 3 times, then show the error.');
  assert.equal(notes.items.size, 2);
  // Nothing answered: the question still waits and the permission card is still with you.
  assert.equal(c.cardWaiting({ project: 'alpha', card: `question:${q}` }), true);
  assert.equal(hub.approvals.has('ap1'), true);
  assert.equal(a.log.events.some(e => e.type === 'message' && e.from === 'you'), false);
});

test('the answer path: your answer from a chat card is yours in that project; the Conductor\'s own words never count', async () => {
  const { hub, c, a, ask } = await setup();
  const q = ask(a, 'PR #12 passed review and its tests. OK to merge it?');
  await sleep(80);
  // A card in the chat sits in its project's section (data-pj), so the page sends the answer to that project.
  const el = { closest: sel => sel === '[data-pj]' ? { dataset: { pj: 'alpha' } } : null };
  assert.equal(projectOf(el, [{ name: 'alpha' }, { name: 'beta' }], { name: 'beta' }).name, 'alpha');
  // The Conductor writing "yes" to the orchestrator does not settle it.
  c.toOrchestrator('alpha', 'conductor-1', 'Matt says yes, merge it.');
  assert.equal(c.cardWaiting({ project: 'alpha', card: `question:${q}` }), true);
  // Your tap (the same call as Needs you: /api/answer with that project) does, and it is logged as yours there.
  hub.answerQuestions(a, q, [{ index: 0, text: 'Yes' }]);
  const m = a.log.events.findLast(e => e.type === 'message' && e.from === 'you');
  assert.equal(m.thread, 'orchestrator');
  assert.deepEqual(m.answers.map(x => x.question), [q]);
  assert.equal(c.cardWaiting({ project: 'alpha', card: `question:${q}` }), false, 'gone from Needs you and the chat alike');
});

test('Take all recommendations: what it sends, card by card (page rules)', () => {
  const ev = { items: [
    { project: 'alpha', card: 'decision:1' }, { project: 'alpha', card: 'decision:2' }, { project: 'beta', card: 'question:s1' },
    { project: 'beta', card: 'question:s2' }, { project: 'beta', card: 'approval:ap1' }, { project: 'beta', card: 'approval:ap2' }, { project: 'beta', card: 'question:s3' }
  ] };
  const notes = { items: new Map([
    ['alpha|decision:1', { fill: 'B' }], ['alpha|decision:2', { fill: '' }], ['beta|question:s1', { fill: 'Retry 3 times' }],
    ['beta|question:s2', { fill: 'Yes' }], ['beta|approval:ap1', { fill: 'allow' }], ['beta|approval:ap2', { fill: 'allow' }], ['beta|question:s3', { fill: 'Yes' }]
  ]) };
  const look = it => ({
    'decision:1': { kind: 'decision', status: 'open', options: ['A', 'B'], recommended: 'A' },
    'decision:2': { kind: 'decision', status: 'open', options: ['A', 'B'], recommended: 'A' },
    'question:s1': { kind: 'question', open: [{ i: 0 }] },
    'question:s2': { kind: 'question', open: [{ i: 0 }, { i: 1 }] },        // several rows: answered on the card
    'approval:ap1': { kind: 'approval', stops: [] },
    'approval:ap2': { kind: 'approval', stops: ['push to main'] },           // a hard stop takes its own tap
    'question:s3': null                                                      // settled meanwhile
  })[it.card];
  assert.deepEqual(CP.recommendedActions(ev, notes, look), [
    { project: 'alpha', kind: 'decision', id: 1, choice: 'B' },
    { project: 'alpha', kind: 'decision', id: 2, choice: 'A' },              // no letter from it: the record's own
    { project: 'beta', kind: 'question', id: 's1', index: 0, text: 'Retry 3 times' },
    { project: 'beta', kind: 'approval', id: 'ap1', allow: true }
  ]);
  assert.equal(CP.digestLine(1, 1), '1 needs you, from 1 project.');
  assert.equal(CP.digestLine(4, 3), '4 need you, from 3 projects.');
  assert.equal(CP.lastLine({ events: [{ type: 'cards', thread: CONDUCTOR_THREAD, digest: 'return', items: [{}, {}] }] }), 'Digest: 2 cards for you');
});

// ---------- notices (push.mjs) ----------
function pushWith() {
  const root = mkdtempSync(join(tmpdir(), 'crux-digest-push-'));
  const pushed = [], logged = [];
  const sender = { generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }), sendNotification: async (_s, body) => { pushed.push(JSON.parse(body)); } };
  const push = new Push({ dir: join(root, 'data'), sender, timers: { setTimeout: (f) => f(), clearTimeout() { } }, log: s => logged.push(s) });
  push.subscribe({ endpoint: 'https://push.example/phone', keys: { p256dh: 'k', auth: 'a' } }, 'iPhone');
  const ctx = { approvals: new Set(['ap1']), decisionOpen: () => true, decisionStatus: () => 'open', events: () => [{ type: 'summary', id: 's1', thread: 'orchestrator', from: 'orchestrator-1', questions: ['Retry three times before showing the error?'] }] };
  return { push, pushed, logged, ctx };
}
const flushAsync = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };

test('presence: here while the PC is in use or a page shows with recent input; away otherwise; every report tells the hub', () => {
  const { push } = pushWith();
  let reports = 0;
  push.onPresence = () => reports++;
  const now = Date.now();
  assert.equal(push.present(now), false, 'nothing reported: away');
  push.presence('phone', { project: 'alpha', thread: 'all', visible: true, focused: true, idleMs: 0 }, now);
  assert.equal(push.present(now), true);
  assert.equal(push.present(now + 60 * 1000), false, 'a page that stopped reporting is stale');
  push.presence('phone', { visible: true, focused: true, idleMs: PC_IDLE_MS + 1 }, now);
  assert.equal(push.present(now), false, 'showing but idle 5+ minutes');
  push.presence('phone', { visible: false, focused: false, idleMs: 0 }, now);
  assert.equal(push.present(now), false, 'hidden');
  const d = push.desktopAttach('pc', () => { });
  push.desktopPresence('pc', { idleMs: 1000, locked: false }, now);
  assert.equal(push.present(now), true, 'the PC in use');
  push.desktopPresence('pc', { idleMs: 1000, locked: true }, now);
  assert.equal(push.present(now), false, 'locked');
  push.desktopDetach('pc', d);
  assert.equal(reports, 5);   // three page reports, two from the desktop app
});

test('notices while away: questions and decisions wait for the digest, permission requests still go at once; one notice per digest', async () => {
  const { push, pushed, logged, ctx } = pushWith();
  push.holdForDigest = () => true;   // the Conductor is on and you are away
  push.handle({ type: 'summary', id: 's1', project: 'alpha', thread: 'orchestrator', from: 'orchestrator-1', questions: ['Retry three times before showing the error?'], decisions_needed: [3], logged: true }, ctx);
  push.handle({ type: 'approval', approval: 'ap1', project: 'beta', thread: 'w1', agent: 'w1', tool: 'Bash', routedTo: null, logged: true }, ctx);
  await flushAsync();
  assert.deepEqual(pushed.map(x => x.card), ['approval:ap1']);
  assert.equal(logged.filter(s => /held for the Conductor's digest/.test(s)).length, 2);
  push.digest({ id: 'ev9', count: 3, projects: 2 }, ctx);
  await flushAsync();
  assert.equal(pushed.length, 2);
  assert.equal(pushed[1].card, 'digest:ev9');
  assert.equal(pushed[1].title, '3 cards need you');
  assert.match(pushed[1].url, /card=digest%3Aev9/);
  // Back here: cards go as decision 58 has them.
  push.holdForDigest = () => false;
  push.handle({ type: 'summary', id: 's2', project: 'alpha', thread: 'orchestrator', from: 'orchestrator-1', decisions_needed: [4], logged: true }, ctx);
  await flushAsync();
  assert.equal(pushed.at(-1).card, 'decision:4');
});
