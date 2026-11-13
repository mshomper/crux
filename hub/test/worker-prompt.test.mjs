import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerPrompt } from '../lib/prompts.mjs';

const base = { project: 'p', name: 'w1', task: 't' };

test('every worker is told post_summary must carry the results', () => {
  const p = workerPrompt(base);
  assert.match(p, /only way your results reach the orchestrator/);
  assert.match(p, /not seen/);
  assert.match(p, /Never run checkout, switch or reset in the main project folder/);
  assert.match(p, /git show origin\/<branch>/);
  assert.match(p, /\.claude\/worktrees\//);
  assert.doesNotMatch(p, /REVIEW REPORT/);
});

test('reviewer types are told to list findings in the summary', () => {
  for (const type of [{ name: 'reviewer', description: '' }, { name: 'auditor', description: 'Reviews a change' }]) {
    const p = workerPrompt({ ...base, type });
    assert.match(p, /REVIEW REPORT/);
    assert.match(p, /HIGH \/ MEDIUM \/ LOW, file:line/);
    assert.match(p, /"no findings" line/);
  }
  assert.doesNotMatch(workerPrompt({ ...base, type: { name: 'quick-fix', description: 'Small fixes' } }), /REVIEW REPORT/);
});
