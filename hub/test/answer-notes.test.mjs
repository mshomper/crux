// Answering a worker's questions from Needs you leaves one line in the orchestrator thread, and a note the
// orchestrator reads with its next message, so it does not ask them again. Not for the orchestrator's own questions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { questionGist, answerNote, GIST_MAX, NOTE_MAX } from '../public/questions.js';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';

const realSend = Agent.prototype.send;
const got = [];
Agent.prototype.send = function (t) { got.push([this.name, this.withNotes(t)]); this.state = 'working'; };
Agent.prototype.close = function () { };

function setup() {
  const root = makeTmp('crux-answer-notes-');
  const dir = join(root, 'proj');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')) });
  const p = hub.project('proj');
  const orch = hub.ensureOrchestrator(p);
  got.length = 0;
  return { hub, p, orch };
}
const summary = questions => ({ done: [], changed: [], questions, decisions_needed: [], blocked_on: [], next_step: '' });

test('a question shrinks to the sentence that asks, cut at a word', () => {
  assert.equal(questionGist('The strip is 124 px. Should I hide it while the keyboard is open?'), 'Should I hide it while the keyboard is open?');
  assert.equal(questionGist('Port 4752 or 4760?'), 'Port 4752 or 4760?');
  assert.equal(questionGist('Bump the version'), 'Bump the version', 'no question mark: kept as it is');
  const long = questionGist('How far should the HUD frame reach across the hub, given the map strip, the cards, the board panel and the phone layout?');
  assert.ok(long.length <= GIST_MAX, long);
  assert.match(long, /…\?$/, 'cut, and still reads as a question');
  assert.doesNotMatch(long, /\s…/, 'cut at a word, not mid-space');
});

test('the note lists each question with its answer, one line, capped', () => {
  assert.equal(answerNote('You', 'map-core', [{ question: 'How far does the HUD reach?', answer: 'Full HUD' }, { question: 'How often should the boot sequence play?', answer: 'once a day' }]),
    'You answered map-core: How far does the HUD reach? Full HUD; How often should the boot sequence play? once a day');
  assert.equal(answerNote('You', 'w1', [{ question: 'Bump the version', answer: 'Yes\nto 0.9' }, { question: 'Skip?', answer: '  ' }]), 'You answered w1: Bump the version: Yes to 0.9', 'one line; empty answers left out');
  const many = answerNote('You', 'w1', Array.from({ length: 8 }, (_, i) => ({ question: `Question number ${i} about something fairly long?`, answer: 'a reasonably long answer that goes on' })));
  assert.ok(many.length <= NOTE_MAX && many.endsWith('…'), many);
});

test('answering a worker: a line in the orchestrator thread, and the orchestrator reads the note with its next message', () => {
  const { hub, p, orch } = setup();
  const w = hub.startWorker(p, 'map-core', 'HUD frame');
  hub.postSummary(p, w, summary(['How far does the HUD reach?', 'Port 4752 or 4760?']));
  const s = p.log.ofType('summary').at(-1);
  got.length = 0;
  hub.answerQuestions(p, s.id, [{ index: 0, text: 'Full HUD' }]);
  const note = p.log.ofType('notice').at(-1);
  assert.equal(note.thread, 'orchestrator');
  assert.equal(note.text, 'You answered map-core: How far does the HUD reach? Full HUD');
  assert.deepEqual(got.map(g => g[0]), ['map-core'], 'the orchestrator is not woken for it');
  hub.fromYou(p, 'orchestrator', 'What next?');
  const [to, text] = got.at(-1);
  assert.equal(to, orch.name);
  // {{Who}} becomes the name from the profile when the real send builds the message (userMessage personalizes).
  assert.match(text, /^\[Hub note\] \{\{Who\}\} answered map-core: How far does the HUD reach\? Full HUD\. map-core has the answers; these questions are settled, so don't ask them again\.\n\nWhat next\?$/);
  hub.fromYou(p, 'orchestrator', 'And then?');
  assert.equal(got.at(-1)[1], 'And then?', 'the note rides once');
});

test("the orchestrator's own questions: no extra line, no note", () => {
  const { hub, p, orch } = setup();
  hub.postSummary(p, orch, summary(['Merge #23 now?']));
  const s = p.log.ofType('summary').at(-1);
  const notices = p.log.ofType('notice').length;
  hub.answerQuestions(p, s.id, [{ index: 0, text: 'Yes' }]);
  assert.equal(p.log.ofType('notice').length, notices);
  assert.deepEqual(orch.notes || [], []);
  assert.equal(p.log.ofType('message').at(-1).thread, 'orchestrator', 'the answer itself goes to its thread, as before');
});

test('withNotes leaves a message alone when there is nothing queued', () => {
  const a = Object.create(Agent.prototype);
  assert.equal(a.withNotes('hello'), 'hello');
  a.noteForNextTurn('one'); a.noteForNextTurn('two');
  assert.equal(a.withNotes('hello'), 'one\ntwo\n\nhello');
  assert.equal(a.withNotes('hello'), 'hello');
  assert.equal(typeof realSend, 'function');
});
