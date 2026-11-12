// Enter sends; Alt+Enter and Shift+Enter make a new line (Matt, 2026-11-11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { enterAction, insertLineBreak, composerHint } from '../public/composer-keys.js';

test('a narrow column beside others gets the short hint: who you are writing to, nothing more', () => {
  assert.equal(composerHint({ thread: 'orchestrator', compact: true }), 'Message the orchestrator');
  assert.equal(composerHint({ thread: 'needs', compact: true }), 'Message the orchestrator', 'Needs you sends to the orchestrator');
  assert.equal(composerHint({ thread: 'route-finder', compact: true }), 'Message route-finder');
  assert.equal(composerHint({ thread: 'route-finder', compact: true, retired: true }), 'This agent has retired.');
  assert.equal(composerHint({ thread: 'route-finder', compact: true, narrow: true }), 'Message', 'the phone form wins');
  assert.match(composerHint({ thread: 'route-finder' }), /Alt\+Enter/, 'a single wide column keeps the full hint');
});

const key = (k, mods = {}) => ({ key: k, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...mods });

test('which keys send and which start a new line', () => {
  assert.equal(enterAction(key('Enter')), 'send');
  assert.equal(enterAction(key('Enter', { altKey: true })), 'newline', 'Alt+Enter: we insert the line, browsers add nothing');
  assert.equal(enterAction(key('Enter', { shiftKey: true })), 'native', 'Shift+Enter: the browser adds the line, as before');
  assert.equal(enterAction(key('Enter', { altKey: true, shiftKey: true })), 'newline');
  assert.equal(enterAction(key('Enter', { ctrlKey: true })), 'native');
  assert.equal(enterAction(key('a')), 'native');
});

test('the line break goes where the cursor is, replacing a selection', () => {
  const box = { value: 'hello world', selectionStart: 5, selectionEnd: 6, events: [], dispatchEvent(e) { this.events.push(e.type); } };
  insertLineBreak(box);
  assert.equal(box.value, 'hello\nworld');
  assert.deepEqual([box.selectionStart, box.selectionEnd], [6, 6]);
  assert.deepEqual(box.events, ['input'], 'the box hears an input event, so it grows');
  const end = { value: 'ab', selectionStart: 2, selectionEnd: 2 };
  insertLineBreak(end);
  assert.equal(end.value, 'ab\n');
});
