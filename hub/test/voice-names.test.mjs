// Voice (decision 61 A): near-miss project and agent names in a transcript snap to known ones, and nothing else does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapNames } from '../lib/voice-names.mjs';

const NAMES = ['crux', 'BrightLoad', 'BrightLign', 'Ebb', 'Harborstone', 'w1nd.lab', 'w1nd.synth', 'bone-lab', 'research', 'orchestrator-6', 'orchestrator-2', 'voice-build', 'Conductor'];
const snap = (t, aliases) => snapNames(t, NAMES, aliases);

test('split and misspelt names snap back, keeping the rest as said', () => {
  assert.equal(snap('Ask the bright load orchestrator to start.').text, 'Ask the BrightLoad orchestrator to start.');
  assert.equal(snap('What is Harbor stone doing?').text, 'What is Harborstone doing?');
  assert.equal(snap('Has voice build finished?').text, 'Has voice-build finished?');
  assert.equal(snap('Send the bone lab orchestrator a note.').text, 'Send the bone-lab orchestrator a note.');
  assert.equal(snap('Check Brightlode today.').text, 'Check BrightLoad today.');
});

test('sound-alikes the recogniser writes: a doubled c, a silent g', () => {
  assert.equal(snapNames('Ask the Accumesh team.', ['AcuMesh']).text, 'Ask the AcuMesh team.');
  assert.equal(snapNames('Open Desine now.', ['Design']).text, 'Open Design now.');
  assert.equal(snapNames('Is Brightline waiting?', ['BrightLign']).text, 'Is BrightLign waiting?');
});

test('a name written with digits for letters snaps from how it is said', () => {
  assert.equal(snap('Tell the wind lab orchestrator to rerun it.').text, 'Tell the w1nd.lab orchestrator to rerun it.');
  assert.equal(snap('What changed in wind synth?').text, 'What changed in w1nd.synth?');
});

test('a name ending in a number needs the number heard, as digits or a word', () => {
  assert.equal(snap('What did orchestrator six say?').text, 'What did orchestrator-6 say?');
  assert.equal(snap('What did orchestrator 2 say?').text, 'What did orchestrator-2 say?');
  assert.equal(snap('Ask the orchestrator first.').text, 'Ask the orchestrator first.');
});

test('what was heard is listed for each snap; an exact match with the same spelling is no snap', () => {
  const r = snap('Ask bright load and crux.');
  assert.deepEqual(r.snapped, [{ from: 'bright load', to: 'BrightLoad' }]);
  assert.deepEqual(snap('Ask crux.').snapped, []);
});

test('short names only when heard exactly; ordinary words stay', () => {
  assert.equal(snap('Show me everything in ebb.').text, 'Show me everything in Ebb.');
  assert.equal(snap('The tide will ebbs and flow.').text, 'The tide will ebbs and flow.');
  assert.equal(snap('Pick option A on decision 61.').text, 'Pick option A on decision 61.');
  assert.equal(snap('How much of my weekly plan have I used?').text, 'How much of my weekly plan have I used?');
  assert.equal(snap('Approve the permission card, but only for this folder.').text, 'Approve the permission card, but only for this folder.');
});

test('two names that fit equally well leave the words alone', () => {
  assert.equal(snapNames('Open bright loa.', ['BrightLoad', 'BrightLoan'], {}).text, 'Open bright loa.');
  assert.equal(snapNames('Open bright loa.', ['BrightLoad'], {}).text, 'Open BrightLoad.');
});

test('aliases from hub.json cover names no ear will get', () => {
  assert.equal(snap('Open the field lab.', { 'field lab': 'w1nd.lab' }).text, 'Open the w1nd.lab.');
});
