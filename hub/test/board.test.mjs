// The board panel's sections and filter (M008 B).
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupBoard, matches, boardView } from '../public/board.js';

const d = (id, status, title, extra = {}) => ({ id, status, title, options: [{ key: 'A', name: 'Red is your call' }], ...extra });
const e = (entryId, kind, title, status = 'active', extra = {}) => ({ entryId, kind, title, status, summary: '', from: 'orchestrator-1', ...extra });
const board = {
  decisions: [d(31, 'decided', 'Status colours', { chosen: 'A' }), d(32, 'open', 'Phone start screen', { recommended: 'A' }), d(5, 'rejected', 'Session registry'), d(40, 'parked', 'Tauri tray')],
  entries: [e('R005', 'requirement', 'Agent permission rules', 'active', { summary: 'Auto mode per repo' }), e('R004', 'requirement', 'Old rules', 'superseded'),
    e('C002', 'convention', 'Keep workers until reviewed'), e('M008', 'memo', 'UX review backlog'), e('H001', 'handoff', 'Handoff from orchestrator-1'), e('H002', 'handoff', 'Handoff from orchestrator-2')]
};

test('entries fall into sections; nothing is dropped, superseded ones go to History', () => {
  const s = Object.fromEntries(groupBoard(board).map(x => [x.key, x.items.map(i => i.id)]));
  assert.deepEqual(s, {
    waiting: ['D0032'], requirements: ['R005'], conventions: ['C002'], decided: ['D0031'], memos: ['M008'],
    handoffs: ['H002', 'H001'], parked: ['D0040'], history: ['D0005', 'R004'], done: []
  });
});

test('what waits for you is open by default, the rest folded; your choices are kept', () => {
  const v = boardView(board);
  assert.deepEqual(v.filter(s => s.isOpen).map(s => s.key), ['waiting']);
  assert.equal(v.find(s => s.key === 'handoffs').total, 2, 'folded sections still show their count');
  const mine = boardView(board, { open: { waiting: false, memos: true } });
  assert.deepEqual(mine.filter(s => s.isOpen).map(s => s.key), ['memos']);
  assert.ok(!boardView({ decisions: [], entries: [] }).length, 'empty sections are not shown');
});

test('the filter finds ids in any form and words anywhere, and opens the sections it matches', () => {
  const item = id => groupBoard(board).flatMap(s => s.items).find(i => i.id === id);
  for (const f of ['D0031', 'd31', '31', 'colours', 'red is your']) assert.ok(matches(item('D0031'), f), f);
  for (const f of ['R5', 'r005', 'auto mode']) assert.ok(matches(item('R005'), f), f);
  assert.ok(!matches(item('R005'), 'd5'), 'a letter must match');
  assert.ok(!matches(item('D0031'), 'colours phone'), 'every word must match');
  const v = boardView(board, { filter: 'phone', open: { waiting: false } });
  assert.deepEqual(v.map(s => [s.key, s.items.map(i => i.id), s.isOpen]), [['waiting', ['D0032'], true]]);
  assert.deepEqual(boardView(board, { filter: 'nothing like this' }), []);
});
