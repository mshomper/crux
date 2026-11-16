// Question cards (M010): questions leave Needs you only when you answer or dismiss them, or when every decision a
// question names is picked (2026-11-16: not when the asker retires, the orchestrator replies, or a newer summary
// comes). One rule for the page, the map and phone pushes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { decisionRefs, answeredByPicks, openQuestions, questionOpen, pageStatus, isYesNo, answerMessage, QUOTE_MAX } from '../public/questions.js';
import { cardsFor, stillOpen } from '../lib/push.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';

Agent.prototype.send = function () { this.state = 'working'; };
Agent.prototype.close = function () { };

let n = 0;
const ev = (type, extra) => ({ id: `${type}-${++n}`, ts: new Date().toISOString(), type, ...extra });
const ask = (from, questions, extra = {}) => ev('summary', { thread: from, from, questions, decisions_needed: [], done: [], changed: [], ...extra });

test('decision numbers named in a question', () => {
  assert.deepEqual(decisionRefs('Which status colour language do you want (decision 31)?'), [31]);
  assert.deepEqual(decisionRefs('See D0031 and D7.'), [7, 31]);
  assert.deepEqual(decisionRefs('Decisions 31, 32 and 33 are open'), [31, 32, 33]);
  assert.deepEqual(decisionRefs('decisions 31 to 33'), [31, 32, 33]);
  assert.deepEqual(decisionRefs('ux-review asked about D0031 to D0033'), [31, 32, 33]);
  assert.deepEqual(decisionRefs('decision 4 or 6?'), [4, 6]);
  assert.deepEqual(decisionRefs('Which port should the test hub use, 4752?'), [], 'a bare number is not a decision');
  assert.deepEqual(decisionRefs('Do we need a decision on this?'), []);
  assert.deepEqual(decisionRefs('decisions 1 to 900'), [], 'a huge range is noise');
});

test('a question is answered by picks only when every decision it names is settled', () => {
  const status = { 31: 'decided', 32: 'open', 33: 'rejected' };
  const st = id => status[id];
  assert.ok(answeredByPicks('Colours (decision 31)?', st));
  assert.ok(!answeredByPicks('Phone start (decision 32)?', st), 'still open');
  assert.ok(!answeredByPicks('Decisions 31 and 32?', st), 'one of them still open');
  assert.ok(answeredByPicks('D0031 or D0033?', st));
  assert.ok(!answeredByPicks('Is D0099 right?', st), 'a decision that does not exist yet is not picked');
  assert.ok(!answeredByPicks('Which port?', st), 'names no decision');
});

test('the ux-review case: three questions on decisions 31 to 33, all picked, leave Needs you', () => {
  const s = ask('ux-review', [
    'Which status colour language do you want (decision 31)? I recommend red for anything waiting on you, everywhere.',
    'On your phone, should the hub open straight on Needs you, or get a bottom bar (decision 32)?',
    'How far should the JARVIS look reach beyond the map (decision 33)?'
  ], { decisions_needed: [31, 32, 33] });
  const open = { 31: 'open', 32: 'open', 33: 'open' };
  assert.equal(openQuestions([s], { decisionStatus: id => open[id] })[0].open.length, 3);
  const picked = { 31: 'decided', 32: 'open', 33: 'decided' };
  const [left] = openQuestions([s], { decisionStatus: id => picked[id] });
  assert.deepEqual(left.open, [{ i: 1, text: s.questions[1] }], 'only the question on the open decision is left');
  assert.equal(left.byPicks, 2);
  assert.deepEqual(openQuestions([s], { decisionStatus: () => 'decided' }), [], 'all picked: the card goes');
});

test('only you close a question: your reply or a dismissal; the orchestrator, a retirement or a newer summary never do', () => {
  const s = ask('w1', ['Which port?']);
  assert.equal(openQuestions([s]).length, 1);
  assert.equal(openQuestions([s, ev('message', { thread: 'w1', from: 'w1', text: 'still waiting' })]).length, 1, 'its own message');
  assert.equal(openQuestions([s, ev('message', { thread: 'w1', from: 'you', text: '4752' })]).length, 1, 'a plain message of yours is not an answer either');
  assert.equal(openQuestions([s, ev('message', { thread: 'w1', from: 'you', text: '4752', answers: [{ question: s.id, index: 0 }] })]).length, 0, 'an explicit answer is');
  // Cause 1 (2026-11-16): the orchestrator writing into the worker's thread used to close the card.
  assert.equal(openQuestions([s, ev('message', { thread: 'w1', from: 'orchestrator-1', text: '4752' })]).length, 1, 'the orchestrator replied: still waits on you');
  // Cause 2: the asker retiring used to close the card.
  assert.equal(openQuestions([s, ev('agent_retired', { agent: 'w1', thread: 'w1' })]).length, 1, 'the asker retired: still waits on you');
  assert.equal(openQuestions([s, ev('question_dismissed', { question: s.id, by: 'you' })]).length, 0, 'dismissed');
  assert.equal(openQuestions([s, ev('question_dismissed', { question: 'other' })]).length, 1);
  // A successor orchestrator writing into the shared thread never closes its predecessor's question.
  const o = ask('orchestrator-8', ['After the restart, will you set the check to Shadow?'], { thread: 'orchestrator' });
  const succ = ev('message', { thread: 'orchestrator', from: 'orchestrator-9', text: 'Hello, I took over.' });
  assert.equal(openQuestions([o, ev('agent_retired', { agent: 'orchestrator-8', thread: 'orchestrator' }), succ]).length, 1);
  assert.ok(questionOpen([s], s.id) && !questionOpen([s], 'nope'));
});

test('cause 3: a newer summary from the same agent never closes an older card; a repeat of the same words is one card', () => {
  const s = ask('w1', ['Which port should the test hub use, 4752 or 4760?', 'Go ahead with the strip?']);
  const s2 = ask('w1', ['And the host?']);
  assert.deepEqual(openQuestions([s, s2]).map(q => q.id), [s2.id, s.id], 'both cards wait, newest first');
  assert.deepEqual(openQuestions([s, ev('question_dismissed', { question: s.id }), s2]).map(q => q.id), [s2.id], 'dismissing the old one is yours to do');
  // The same question asked again in the newer summary: the newer card holds it, the older keeps the other one.
  const again = ask('w1', ['Which port should the test hub use, 4752 or 4760?']);
  const cards = openQuestions([s, again]);
  assert.deepEqual(cards.map(c => [c.id, c.open.map(q => q.i)]), [[again.id, [0]], [s.id, [1]]]);
  // You answer the older card's other question: it stays one by one, the newer card is untouched.
  const ans = ev('message', { thread: 'w1', from: 'you', text: 'x', answers: [{ question: s.id, index: 1 }] });
  assert.deepEqual(openQuestions([s, again, ans]).map(c => c.id), [again.id]);
  // A newer summary with no questions asks nothing new and closes nothing.
  assert.equal(openQuestions([s, ev('summary', { thread: 'w1', from: 'w1', questions: [], done: ['x'] })]).length, 1);
});

test('several cards of one thread show the newest first; other threads keep their place', () => {
  const a1 = ask('w1', ['First question for you?']), b1 = ask('w2', ['Other agent asks this?']), a2 = ask('w1', ['Second question for you?']);
  assert.deepEqual(openQuestions([a1, b1, a2]).map(c => c.id), [a2.id, a1.id, b1.id]);
});

test('one-time cutover: summaries before the question_rules event keep the old closing rules, later ones never age out', () => {
  const cut = ev('question_rules', { version: 2 });
  const Q = n => `Old question number ${n}, go ahead with it?`;
  // Asked before the cutover: each old rule still closes it.
  const o1 = ask('w1', [Q(1)]), o2 = ask('w2', [Q(2)]), o3 = ask('w3', [Q(3)]), o4 = ask('w4', [Q(4)]), o5 = ask('w4', [Q(5)]);
  const log = [o1, o2, o3, o4, o5, cut];
  const withAfter = (...more) => [o1, o2, o3, o4, o5, cut, ...more].filter(Boolean);
  assert.deepEqual(openQuestions(log).map(c => c.id).sort(), [o1.id, o2.id, o3.id, o5.id].sort(), 'before anything closes them: o4 was replaced by o5');
  // The old rules at work on the backlog (events after the cutover included): the orchestrator wrote into w1's thread, w2's asker retired.
  const closed = withAfter(ev('message', { thread: 'w1', from: 'orchestrator-1', text: 'Done.' }), ev('agent_retired', { agent: 'w2', thread: 'w2' }), ev('message', { thread: 'w3', from: 'you', text: 'ok' }));
  assert.deepEqual(openQuestions(closed).map(c => c.id), [o5.id], 'o1, o2, o3 closed the old way; o4 was replaced by o5 (newer asking summary); o5 waits');
  // Asked after the cutover: none of that closes it, now or later.
  const n1 = ask('w1', ['New question number one, go ahead with it?']), n2 = ask('w2', ['New question number two, go ahead with it?']);
  const after = [cut, n1, n2, ev('message', { thread: 'w1', from: 'orchestrator-1', text: 'Done.' }), ev('agent_retired', { agent: 'w2', thread: 'w2' }), ev('message', { thread: 'w1', from: 'you', text: 'ok' })];
  assert.deepEqual(openQuestions(after).map(c => c.id).sort(), [n1.id, n2.id].sort());
  // An old (pre-cutover) summary is still replaced by a newer asking summary in its thread: that is its old rule.
  const n3 = ask('w4', ['New question about w4, go ahead with it?']);
  assert.deepEqual(openQuestions([...log, n3]).map(c => c.id).filter(id => id === o5.id || id === n3.id), [n3.id]);
  // No cutover logged: every summary follows the new rules.
  assert.equal(openQuestions([o1, ev('message', { thread: 'w1', from: 'orchestrator-1', text: 'x' })]).length, 1);
});

test('the page reads decision status from its board snapshot', () => {
  const st = pageStatus({ board: { decisions: [{ id: 31, status: 'decided' }, { id: 32, status: 'open' }] } });
  assert.equal(st(31), 'decided');
  assert.equal(st('32'), 'open');
  assert.equal(st(40), undefined);
  assert.equal(pageStatus(null)(1), undefined);
});

test('a phone notification for a question is not sent once it is dismissed or picks answered it; the asker retiring does not cancel it', () => {
  const s = { ...ask('w1', ['Colours (decision 31)?']), project: 'crux' };
  const [card] = cardsFor(s);
  const base = { approvals: new Map(), decisionOpen: () => true, decisionStatus: () => 'open' };
  assert.ok(stillOpen(card, { ...base, events: [s] }));
  assert.ok(!stillOpen(card, { ...base, events: [s, ev('question_dismissed', { question: s.id })] }));
  assert.ok(stillOpen(card, { ...base, events: [s, ev('agent_retired', { agent: 'w1' })] }), 'the asker retired: still waiting on you');
  assert.ok(!stillOpen(card, { ...base, decisionStatus: () => 'decided', events: [s] }));
});

function hubWithWorker() {
  const root = makeTmp('crux-hub-q-');
  const dir = join(root, 'proj');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')) });
  return { hub, p: hub.project('proj') };
}
const summary = questions => ({ done: [], changed: [], questions, decisions_needed: [], blocked_on: [], next_step: '' });

test('answers go out as one message: each question quoted, then the answer', () => {
  assert.equal(answerMessage([{ question: 'Small batch as v0.35.1. Go ahead?', answer: 'Yes, go ahead' }]), '> Small batch as v0.35.1. Go ahead?\nYes, go ahead');
  assert.equal(answerMessage([
    { question: 'Port 4752 or 4760?', answer: '4752' },
    { question: 'Skip this one?', answer: '   ' },
    { question: 'Keep the strip\n124 px tall?', answer: 'Yes.\nBut 96 on a phone.' }
  ]), '> Port 4752 or 4760?\n4752\n\n> Keep the strip 124 px tall?\nYes.\nBut 96 on a phone.', 'empty answers are left out; the quote is one line');
  const long = answerMessage([{ question: 'x'.repeat(500), answer: 'ok' }]);
  assert.equal(long.split('\n')[0].length, 2 + QUOTE_MAX, 'a long question is shortened in the quote');
  assert.ok(long.split('\n')[0].endsWith('…'));
});

test('Yes and No buttons only where the question is plainly yes or no', () => {
  for (const q of ['Should the map strip stay 124 px tall on a laptop?', 'Small batch as v0.35.1, all tests pass. Go ahead?', 'Want me to open the PR?', 'Is it OK to restart the test hub?', 'Ready to merge?'])
    assert.ok(isYesNo(q), q);
  for (const q of ['Should the test hub use port 4752 or 4760?', 'Which status colour language do you want (decision 31)?', 'How far should the JARVIS look reach?', 'Please check the screenshots.', ''])
    assert.ok(!isYesNo(q), q);
});

test('answered questions leave Needs you one by one; the rest of the card stays', () => {
  const s = ask('w1', ['Port 4752 or 4760?', 'Go ahead?', 'Keep the strip?']);
  const answer = (...index) => ev('message', { thread: 'w1', from: 'you', text: 'x', answers: index.map(i => ({ question: s.id, index: i })) });
  assert.deepEqual(openQuestions([s, answer(0, 2)])[0].open.map(q => q.i), [1], 'answers name their questions');
  assert.deepEqual(openQuestions([s, answer(0), answer(1, 2)]), [], 'all answered: the card goes');
  assert.deepEqual(openQuestions([s, ev('question_dismissed', { question: s.id, index: 1 })])[0].open.map(q => q.i), [0, 2], 'dismiss one');
  assert.equal(openQuestions([s, ev('message', { thread: 'w1', from: 'you', text: 'plain reply' })]).length, 1, 'a plain reply does not answer the card');
  assert.equal(openQuestions([s, ev('message', { thread: 'w1', from: 'you', text: 'x', answers: [{ question: 'older', index: 0 }] })])[0].open.length, 3, 'answers to another summary change nothing here');
});

test('Send answers: one message to the asker\'s thread, read by the agent, and those questions are answered', () => {
  const { hub, p } = hubWithWorker();
  const got = [];
  const w = hub.startWorker(p, 'lab-tidy', 'Tidy');
  w.send = t => got.push(t);
  hub.postSummary(p, w, summary(['Small batch as v0.35.1. Go ahead?', 'Port 4752 or 4760?', 'Bump the version?']));
  const s = p.log.ofType('summary').at(-1);
  const r = hub.answerQuestions(p, s.id, [{ index: 0, text: 'Yes, go ahead' }, { index: 2, text: ' No ' }, { index: 1, text: '' }]);
  assert.deepEqual(r.answered, [0, 2]);
  const m = p.log.ofType('message').at(-1);
  assert.deepEqual([m.thread, m.from], ['lab-tidy', 'you']);
  assert.equal(m.text, '> Small batch as v0.35.1. Go ahead?\nYes, go ahead\n\n> Bump the version?\nNo');
  assert.deepEqual(m.answers, [{ question: s.id, index: 0 }, { question: s.id, index: 2 }]);
  assert.deepEqual(got, [m.text], 'the agent receives it like any message');
  assert.deepEqual(openQuestions(p.log.events)[0].open.map(q => q.i), [1], 'the unanswered one stays');
  assert.throws(() => hub.answerQuestions(p, s.id, [{ index: 1, text: '  ' }]), /Type an answer/);
  assert.throws(() => hub.answerQuestions(p, s.id, [{ index: 9, text: 'x' }]), /Type an answer/, 'no such question');
  hub.dismissQuestion(p, s.id, 'you', 1);
  hub.dismissQuestion(p, s.id, 'you', 1);
  assert.equal(p.log.ofType('question_dismissed').length, 1, 'dismissing one question twice logs once');
  assert.deepEqual(openQuestions(p.log.events), []);
  assert.throws(() => hub.dismissQuestion(p, s.id, 'you', 7), /No such question/);
});

test('the hub logs the question-rules cutover once per log, on first start, and a restart keeps it', () => {
  const root = makeTmp('crux-hub-cut-');
  const dir = join(root, 'proj');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  // An old log: a question asked before this version ever started.
  const old = { id: 'old-1', ts: '2026-11-16T01:00:00.000Z', type: 'summary', thread: 'w1', from: 'w1', questions: ['Old question, go ahead with it?'], decisions_needed: [] };
  writeFileSync(join(dir, '.crux', 'events.jsonl'), JSON.stringify(old) + '\n');
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')) });
  const p = hub.project('proj');
  const marks = () => p.log.ofType('question_rules');
  assert.equal(marks().length, 1);
  assert.equal(p.log.events.indexOf(marks()[0]), 1, 'logged after the old events');
  assert.deepEqual(openQuestions(p.log.events).map(c => c.id), ['old-1'], 'a still-open old card stays open (nothing closed it)');
  hub.postSummary(p, hub.startWorker(p, 'w1', 'x'), summary(['New question, go ahead with it?']));
  hub.fromYou(p, 'w1', 'plain chat');   // a plain message closes the old card by its old rule, not the new one
  assert.deepEqual(openQuestions(p.log.events).map(c => c.questions[0]), ['New question, go ahead with it?']);
  const again = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')) });
  assert.equal(again.project('proj').log.ofType('question_rules').length, 1, 'a restart logs no second one');
  hub.markQuestionRules(p);
  assert.equal(marks().length, 1);
});

test('Dismiss logs one event with no thread; an unknown question is refused', () => {
  const { hub, p } = hubWithWorker();
  const w = hub.startWorker(p, 'w1', 'Do a thing');
  hub.postSummary(p, w, { done: [], changed: [], questions: ['Which port?'], decisions_needed: [], blocked_on: [], next_step: '' });
  const s = p.log.ofType('summary').at(-1);
  assert.equal(openQuestions(p.log.events).length, 1);
  hub.dismissQuestion(p, s.id);
  hub.dismissQuestion(p, s.id);
  const d = p.log.ofType('question_dismissed');
  assert.equal(d.length, 1, 'dismissing twice logs once');
  assert.deepEqual([d[0].question, d[0].asker, d[0].by, 'thread' in d[0]], [s.id, 'w1', 'you', false]);
  assert.equal(openQuestions(p.log.events).length, 0);
  assert.throws(() => hub.dismissQuestion(p, 'not-a-question'), /no longer here/);

  // Retiring the worker leaves its question on Needs you (Matt, 2026-11-16); you can still answer it, and the answer
  // goes to the orchestrator thread because the retired agent has no box to read it.
  hub.postSummary(p, w, { done: [], changed: [], questions: ['One more?'], decisions_needed: [], blocked_on: [], next_step: '' });
  assert.equal(openQuestions(p.log.events).length, 1);
  hub.retireFinished(p, 'w1');
  assert.equal(openQuestions(p.log.events).length, 1, 'retired: the question still waits');
  const q = p.log.ofType('summary').at(-1);
  const r = hub.answerQuestions(p, q.id, [{ index: 0, text: 'Yes' }]);
  assert.equal(r.thread, 'orchestrator');
  const m = p.log.ofType('message').at(-1);
  assert.deepEqual([m.thread, m.from], ['orchestrator', 'you']);
  assert.match(m.text, /w1 has retired/);
  assert.match(m.text, /> One more\?\nYes/);
  assert.equal(openQuestions(p.log.events).length, 0, 'answered by you: it leaves');
});
