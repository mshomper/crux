// Stale question cards (M010): questions leave Needs you when answered, dismissed, when the agent that asked
// retires, or when every decision a question names is picked. One rule for the page, the map and phone pushes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
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

test('replies, dismissals and retirement close a question; the asker talking on does not', () => {
  const s = ask('w1', ['Which port?']);
  assert.equal(openQuestions([s]).length, 1);
  assert.equal(openQuestions([s, ev('message', { thread: 'w1', from: 'w1', text: 'still waiting' })]).length, 1, 'its own message');
  assert.equal(openQuestions([s, ev('message', { thread: 'w1', from: 'you', text: '4752' })]).length, 0, 'you replied');
  assert.equal(openQuestions([s, ev('message', { thread: 'w1', from: 'orchestrator-1', text: '4752' })]).length, 0, 'the orchestrator replied');
  assert.equal(openQuestions([s, ev('question_dismissed', { question: s.id, by: 'you' })]).length, 0, 'dismissed');
  assert.equal(openQuestions([s, ev('agent_retired', { agent: 'w1', thread: 'w1' })]).length, 0, 'the asker retired');
  assert.equal(openQuestions([s, ev('agent_retired', { agent: 'w2', thread: 'w2' })]).length, 1, 'someone else retiring changes nothing');
  assert.equal(openQuestions([s, ev('question_dismissed', { question: 'other' })]).length, 1);
  // A newer question in the same thread is a fresh card, even after the old one was dismissed.
  const s2 = ask('w1', ['And the host?']);
  assert.deepEqual(openQuestions([s, ev('question_dismissed', { question: s.id }), s2]).map(q => q.id), [s2.id]);
  assert.ok(questionOpen([s], s.id) && !questionOpen([s], 'nope'));
});

test('the page reads decision status from its board snapshot', () => {
  const st = pageStatus({ board: { decisions: [{ id: 31, status: 'decided' }, { id: 32, status: 'open' }] } });
  assert.equal(st(31), 'decided');
  assert.equal(st('32'), 'open');
  assert.equal(st(40), undefined);
  assert.equal(pageStatus(null)(1), undefined);
});

test('a phone notification for a question is not sent once it is dismissed, its asker retired, or picks answered it', () => {
  const s = { ...ask('w1', ['Colours (decision 31)?']), project: 'crux' };
  const [card] = cardsFor(s);
  const base = { approvals: new Map(), decisionOpen: () => true, decisionStatus: () => 'open' };
  assert.ok(stillOpen(card, { ...base, events: [s] }));
  assert.ok(!stillOpen(card, { ...base, events: [s, ev('question_dismissed', { question: s.id })] }));
  assert.ok(!stillOpen(card, { ...base, events: [s, ev('agent_retired', { agent: 'w1' })] }));
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
  assert.equal(openQuestions([s, ev('message', { thread: 'w1', from: 'you', text: 'plain reply' })]).length, 0, 'a plain reply still answers the card');
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

  // Retiring the worker takes its next question out too.
  hub.postSummary(p, w, { done: [], changed: [], questions: ['One more?'], decisions_needed: [], blocked_on: [], next_step: '' });
  assert.equal(openQuestions(p.log.events).length, 1);
  hub.retireFinished(p, 'w1');
  assert.equal(openQuestions(p.log.events).length, 0);
});
