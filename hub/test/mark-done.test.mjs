// Marking a finished memo done (Matt's yes, 2026-11-12): a new event, never an edit to the log; off the index, still
// read in full; undo puts it back; superseded or retired wins; the orchestrator's tool refuses what it cannot mark.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventLog } from '../lib/events.mjs';
import { Board } from '../lib/board.mjs';
import { markEntryDone, cruxToolNames } from '../lib/tools.mjs';
import { tidyUps } from '../lib/handoff-facts.mjs';
import { checkRequest } from '../lib/access.mjs';
import { groupBoard, canMarkDone, canUndoDone } from '../public/board.js';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'crux-mark-done-'));
  roots.push(root);
  const dir = join(root, 'proj');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  const board = new Board(dir, new EventLog(dir));
  const memo = (title, extra = {}) => board.addEntry({ kind: 'memo', title, summary: `${title} summary`, body: `${title} body`, from: 'orchestrator-1', ...extra });
  return { dir, board, memo, reload: () => new Board(dir, new EventLog(dir)) };
}

test('marking done appends one entry_status event and never edits what was logged', () => {
  const { dir, board, memo } = setup();
  memo('Build plan');
  const file = join(dir, '.crux', 'events.jsonl');
  const before = readFileSync(file, 'utf8');
  const ev = board.setEntryStatus('m001', 'done', 'orchestrator-1', 'built and merged');
  assert.equal(ev.type, 'entry_status');
  assert.deepEqual({ entryId: ev.entryId, status: ev.status, from: ev.from, note: ev.note }, { entryId: 'M001', status: 'done', from: 'orchestrator-1', note: 'built and merged' });
  const now = readFileSync(file, 'utf8');
  assert.ok(now.startsWith(before), 'earlier lines are untouched');
  assert.equal(now.slice(before.length).trim().split('\n').length, 1, 'exactly one new line');
});

test('after a rebuild a done memo is off the index but read in full, with its status; undo puts it back', () => {
  const { board, memo, reload } = setup();
  memo('Build plan'); memo('Still open');
  board.setEntryStatus('M001', 'done', 'orchestrator-1', 'merged');
  let b = reload();   // rebuilt from the file alone
  assert.doesNotMatch(b.index(), /M001/);
  assert.match(b.index(), /M002 Still open/);
  const r = b.read('M001');
  assert.equal(r.status, 'done');
  assert.equal(r.body, 'Build plan body', 'the whole entry is still there');
  assert.deepEqual({ from: r.done.from, note: r.done.note }, { from: 'orchestrator-1', note: 'merged' });
  b.setEntryStatus('M001', 'active', 'you');
  b = reload();
  assert.equal(b.read('M001').status, 'active');
  assert.equal(b.read('M001').done, undefined);
  assert.match(b.index(), /M001 Build plan/);
});

test('superseded or retired wins over done, whichever came first', () => {
  const { board, memo } = setup();
  memo('Old plan');
  board.setEntryStatus('M001', 'done', 'you');
  memo('New plan', { supersedes: 'M001' });
  assert.equal(board.read('M001').status, 'superseded', 'superseded after being done');
  memo('Third');
  board.retireEntry('M003', 'stale', 'orchestrator-1');
  assert.throws(() => board.setEntryStatus('M003', 'done', 'you'), /already retired/);
});

test('the board refuses unknown ids, superseded entries, other kinds and no-change marks', () => {
  const { board, memo } = setup();
  memo('Old plan'); memo('New plan', { supersedes: 'M001' });
  board.addEntry({ kind: 'requirement', title: 'Rule', summary: 's', body: 'b', from: 'you' });
  assert.throws(() => board.setEntryStatus('M099', 'done', 'you'), /Nothing on the board with id M099/);
  assert.throws(() => board.setEntryStatus('M001', 'done', 'you'), /already superseded/);
  assert.throws(() => board.setEntryStatus('R001', 'done', 'you'), /only memos/);
  assert.throws(() => board.setEntryStatus('M002', 'active', 'you'), /already active/);
  assert.throws(() => board.setEntryStatus('M002', 'gone', 'you'), /Unknown status/);
  board.setEntryStatus('M002', 'done', 'you');
  assert.throws(() => board.setEntryStatus('M002', 'done', 'you'), /already done/);
  assert.equal(board.log.ofType('entry_status').length, 1, 'refusals log nothing');
});

test('mark_entry_done: the orchestrator\'s tool marks a memo and gives plain refusals', () => {
  const { board, memo } = setup();
  memo('Old plan'); memo('New plan', { supersedes: 'M001' });
  assert.match(markEntryDone(board, 'M002', 'orchestrator-1', 'merged in #48'), /^M002 marked done\. .*board_read M002/);
  assert.equal(board.read('M002').done.note, 'merged in #48');
  assert.match(markEntryDone(board, 'M002', 'orchestrator-1'), /^Not marked: M002 is already done/);
  assert.match(markEntryDone(board, 'M001', 'orchestrator-1'), /^Not marked: M001 is already superseded/);
  assert.match(markEntryDone(board, 'X9', 'orchestrator-1'), /^Not marked: Nothing on the board with id X9/);
  assert.ok(cruxToolNames({ role: 'orchestrator' }).includes('mcp__crux__mark_entry_done'), 'the orchestrator has it');
  assert.ok(!cruxToolNames({ role: 'worker' }).includes('mcp__crux__mark_entry_done'), 'workers do not');
});

test('suggested tidy-ups skip memos already done', () => {
  const { board, memo } = setup();
  memo('Merge plan'); memo('Other plan');
  memo('Open loops', { body: 'Done memos: M001 is done. M002 is done too.' });
  assert.deepEqual(tidyUps(board, board.log.events).map(t => t.id), ['M001', 'M002']);
  board.setEntryStatus('M001', 'done', 'orchestrator-1');
  assert.deepEqual(tidyUps(board, board.log.events).map(t => t.id), ['M002']);
});

test('the panel puts done memos in a Done group at the bottom, not in Memos or History', () => {
  const e = (entryId, status, kind = 'memo') => ({ entryId, kind, title: entryId, status, from: 'x' });
  const groups = groupBoard({ decisions: [], entries: [e('M001', 'active'), e('M002', 'done'), e('M003', 'superseded'), e('R001', 'active', 'requirement')] });
  const s = Object.fromEntries(groups.map(g => [g.key, g.items.map(i => i.id)]));
  assert.deepEqual([s.memos, s.history, s.done], [['M001'], ['M003'], ['M002']]);
  assert.equal(groups.at(-1).key, 'done', 'last section');
  assert.ok(!groups.at(-1).open, 'folded by default');
  assert.ok(canMarkDone(e('M001', 'active')) && !canMarkDone(e('R001', 'active', 'requirement')) && !canMarkDone(e('M002', 'done')));
  assert.ok(canUndoDone(e('M002', 'done')) && !canUndoDone(e('M003', 'superseded')));
});

test('the page\'s mark-done call needs same-origin JSON like every change (C001)', () => {
  const json = { 'content-type': 'application/json' };
  assert.equal(checkRequest({ method: 'POST', path: '/api/entry-status', headers: { host: 'localhost:4747', origin: 'http://localhost:4747', ...json } }), null);
  assert.ok(checkRequest({ method: 'POST', path: '/api/entry-status', headers: { host: 'localhost:4747', origin: 'https://evil.example', ...json } }));
  assert.ok(checkRequest({ method: 'POST', path: '/api/entry-status', headers: { host: 'localhost:4747', 'content-type': 'text/plain' } }));
});
