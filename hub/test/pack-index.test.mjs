// Which pack a project folder loads: the packs index may list globs with a note in brackets, as people write it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { Memory } from '../lib/memory.mjs';

function home(index, packs) {
  const root = makeTmp('crux-packs-');
  const dir = join(root, 'profile', 'packs');
  mkdirSync(dir, { recursive: true });
  if (index) writeFileSync(join(dir, '_index.md'), index);
  for (const p of packs) writeFileSync(join(dir, `${p}.md`), `# ${p}\n`);
  return new Memory(root);
}

const TABLE = `# Project packs: index

| Pack | Project folders it applies to | Covers |
|---|---|---|
| \`demo.md\` | \`demo.lab\`, \`demo.synth\`, \`demo.*\` (alpha, beta, gamma) | The demo suite |
| \`tool.md\` | \`Tool\` (including \`mockup/\`) | A tool |
| \`game.md\` | \`Game\` and its \`Game-*\` worktrees | A game |
| \`notes.md\` | \`notes\` | Notes |
`;

test('a table row with a glob and a note in brackets', () => {
  const m = home(TABLE, ['demo', 'tool', 'game', 'notes', 'other']);
  assert.equal(m.packName('demo.lab'), 'demo', 'listed by name');
  assert.equal(m.packName('demo.alpha'), 'demo', 'matched by the demo.* glob');
  assert.equal(m.packName('demo.lab-wt'), 'demo');
  assert.equal(m.packName('demo'), 'demo', 'the bare name falls back to its own pack file');
  assert.equal(m.packName('alpha'), null, 'words in the bracketed note are not folder names');
  assert.equal(m.packName('Tool'), 'tool', 'a note after a single name');
  assert.equal(m.packName('Game'), 'game', 'own pack file');
  assert.equal(m.packName('Game-wt'), null, 'free text is not read as a glob');
  assert.equal(m.packName('notes'), 'notes');
  assert.equal(m.packName('other'), 'other', 'not in the index: a pack named like the folder');
  assert.equal(m.packName('nothing'), null);
});

test('a bullet line with a glob, and no index at all', () => {
  assert.equal(home('- demo.md: demo.lab, demo.*\n', ['demo']).packName('demo.beta'), 'demo');
  assert.equal(home(null, ['demo']).packName('demo.beta'), null, 'no index: no glob, and no hardcoded pack names');
  assert.equal(home(null, ['demo']).packName('demo'), 'demo');
});
