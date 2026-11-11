// Enter sends; Alt+Enter and Shift+Enter make a new line (Matt, 2026-11-11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { enterAction, insertLineBreak } from '../public/composer-keys.js';

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
