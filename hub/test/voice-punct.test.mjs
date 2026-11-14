// Voice: spoken punctuation becomes marks (Matt dictates "comma", "period" out of habit). The inputs below are what
// Parakeet actually wrote for Imogen saying them (measured 2026-11-14), plus Matt's own "Kama".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dictate } from '../lib/voice-punct.mjs';

const d = t => dictate(t).text;

test("Matt's two messages: \"Kama\" was his spoken comma", () => {
  assert.equal(d('Kama, can you speak a response back to me'), 'Can you speak a response back to me');
  assert.equal(d('Thanks for responding, Kama'), 'Thanks for responding,');
  assert.equal(d('Conductor Kama can you speak a response back to me question mark'), 'Conductor, can you speak a response back to me?');
});

test('what Parakeet wrote for each spoken mark becomes the mark, on the word before', () => {
  for (const [heard, want] of [
    ['Conductor Commer, can you speak a response back to me question mark.', 'Conductor, can you speak a response back to me?'],
    ['Thanks for responding, comma conductor period.', 'Thanks for responding, conductor.'],
    ['Send it now exclamation point.', 'Send it now!'],
    ['What is waiting exclamation, Mark?', 'What is waiting!'],
    ['Two things colon the review and the merge period.', 'Two things: the review and the merge.'],
    ['First the review semicolon, then the merge full stop.', 'First the review; then the merge.'],
    ['Start with the title new line, then the second line.', 'Start with the title\nThen the second line.'],
    ['New paragraph here is the next part period.', 'Here is the next part.'],
    ['Write open quote ship it close quote in the notes period.', 'Write "ship it" in the notes.'],
    ['Pick option A Dash the safe one Period.', 'Pick option A — the safe one.'],
    ['Is it done question mark? Good period.', 'Is it done? Good.'],
    ['One more thing new paragraph the second part.', 'One more thing\n\nThe second part.']
  ]) assert.equal(d(heard), want, heard);
});

test('a mark Parakeet already put there is not doubled', () => {
  assert.equal(d('Thanks for responding, comma, Conductor.'), 'Thanks for responding, Conductor.');
  assert.equal(d('Is it done question mark?'), 'Is it done?');
  assert.equal(d('All good. Period.'), 'All good.');
});

test('the words used as words stay', () => {
  for (const s of [
    'Make a comma separated list of the projects.',
    'The period between releases was short.',
    'Put a colon after the title.',
    'The trial period ends Friday.',
    'How long is the grace period?',
    'Add a dash between the numbers.',
    'Which comma do you mean?',
    'Use the semicolon sparingly.',
    'Show me the new line in the log.',
    'Start with this new line, then the second line.',   // "this new line" reads as the words; say it after a word
    'Nothing to change here.'
  ]) assert.deepEqual(dictate(s), { text: s, changed: false }, s);
});

test('the server converts before snapping and keeps what was heard when either changed it', () => {
  const s = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(s, /const said = dictate\(heard\)\.text;\s*const \{ text, snapped \} = snapNames\(said, voiceNames\(\), hubCfg\.voiceAliases\);/);
  assert.match(s, /const changed = text !== heard;/);
  assert.match(s, /\{ voice: true, \.\.\.\(changed \? \{ heard \} : \{\}\) \}/);
});
