// tools/permission-study.mjs --check (decision 66, plan B7 step 3): the shadow lines against the real answers.
// A made-up log in the hub's own event shapes (lib/hub.mjs runShadow, logAnswer, logCheckUsage).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { compareShadow, checkSection, main, parseArgs } from '../tools/permission-study.mjs';

let n = 0;
const ev = (type, data) => ({ id: `e${++n}`, ts: new Date(Date.parse('2026-11-16T10:00:00Z') + n * 1000).toISOString(), type, ...data });
const shadow = (approval, answer, reason = 'r', extra = {}) => ev('check_shadow', { approval, worker: 'w1', tool: 'Bash', command: `cmd for ${approval}`, valid: answer !== null, answer, reason, model: 'claude-sonnet-5-5', ...extra });
const real = (approval, answer, by = 'orchestrator-3', reason = 'real') => ev('permission_answer', { thread: 'orchestrator', approval, worker: 'w1', tool: 'Bash', command: 'x', answer, reason, by });
const used = (approval, list) => ev('usage', { agent: 'permission check', agentType: 'check', role: 'check', approval, shadow: true, models: { 'claude-sonnet-5-5': { input: 40, output: 10, cacheRead: 800, cacheCreation: 0, cost: 0.004 } }, costUSD: 0.004, listUSD: list });

function log() {
  n = 0;
  return [
    shadow('a1', 'allow'), real('a1', 'allow'), used('a1', 0.002),
    shadow('a2', 'allow'), real('a2', 'allow'),
    shadow('a3', 'escalate'), real('a3', 'timeout', 'hub'),                    // a timeout came to you: the same as escalate
    shadow('a4', 'deny', 'uses sed -i'), real('a4', 'allow', 'orchestrator-3', 'fine for a test file'),   // the check was stricter
    shadow('a5', 'allow', 'looks like a read', { command: 'node tools/x.mjs --out C:\\Users\\someone\\notes.txt' }), real('a5', 'escalate', 'orchestrator-3', 'writes outside the project'),   // the dangerous way
    ev('approval_result', { approval: 'a5', how: 'denied' }),
    shadow('a6', 'consult', 'needs the goal'), real('a6', 'allow'),
    shadow('a7', null, 'overloaded', { valid: false }),
    shadow('a8', 'allow'),                                                     // no real answer yet
    shadow('a9', 'allow', 'ok', { downgraded: false }), real('a9', 'deny', 'you', 'No'),
    ev('permission_answer', { thread: 'orchestrator', approval: 'z1', worker: 'w1', tool: 'Bash', command: 'y', answer: 'allow', reason: 'ok', by: 'permission check' })   // not a real answer
  ];
}

test('shadow lines are compared with the real answer for the same request', () => {
  const c = compareShadow(log());
  assert.equal(c.total, 9);
  assert.deepEqual(c.agree, { allow: 2, deny: 0, escalate: 1 });
  assert.equal(c.consult, 1, 'an old consult line is not a disagreement');
  assert.equal(c.invalid, 1);
  assert.equal(c.pending, 1);
  assert.deepEqual(c.disagree.map(d => [d.approval, d.check, d.real, d.allowedByCheckOnly]), [['a4', 'deny', 'allow', false], ['a5', 'allow', 'escalate', true], ['a9', 'allow', 'deny', true]]);
  const a5 = c.disagree.find(d => d.approval === 'a5');
  assert.equal(a5.outcome, 'denied');
  assert.equal(a5.realBy, 'orchestrator-3');
  assert.equal(c.usage.calls, 1);
  assert.equal(c.usage.list, 0.002);
});

test('the section lists every disagreement in full, the dangerous direction first, and the plain counts', () => {
  const t = checkSection('demo', log());
  assert.match(t, /## demo: the permission check in shadow mode/);
  assert.match(t, /Requests the check read \| 9/);
  assert.match(t, /Said the same as the real answer \| 3 of 6 \(50%\): 2 allow, 0 deny, 1 escalate/);
  assert.match(t, /Disagreed with the real answer \| 3, of which \*\*2 where the check would have allowed and the real answer did not\*\*/);
  assert.match(t, /Said allow, deny, escalate \(to you\) \| 5, 1, 1 \(escalate is 11% of the lines/);
  assert.match(t, /Old lines that passed the request back \("consult", the layered check\) \| 1 \(11%\)/);
  assert.match(t, /No valid answer .*\| 1/);
  assert.ok(t.indexOf('CHECK WOULD HAVE ALLOWED') < t.indexOf('Check was stricter'), 'the worrying ones first');
  assert.ok(t.includes('node tools/x.mjs --out C:\\Users\\someone\\notes.txt'), 'the whole command');
  assert.match(t, /Check said \*\*allow\*\*: looks like a read/);
  assert.match(t, /Real answer \*\*escalate\*\* by orchestrator-3: writes outside the project \(card ended: denied\)/);
  assert.match(t, /Real answer \*\*deny\*\* by you: No/);
  assert.match(t, /Request a5/);
  assert.match(t, /Cost of the check's calls/);
});

test('with no shadow lines it says how to start; with only agreements there is no disagreement list', () => {
  n = 0;
  assert.match(checkSection('demo', [ev('message', {})]), /No `check_shadow` lines yet/);
  n = 0;
  const t = checkSection('demo', [shadow('b1', 'allow'), real('b1', 'allow')]);
  assert.match(t, /1 of 1 \(100%\)/);
  assert.doesNotMatch(t, /Every disagreement/);
});

test('a window by time leaves earlier lines out', () => {
  const evs = log();
  const c = compareShadow(evs, { sinceMs: Date.parse(evs[10].ts) });
  assert.ok(c.total < 9);
});

test('--check on the command line writes the section into the report; the orchestrator counts ignore the check', async () => {
  const root = makeTmp('crux-check-study-');
  const dir = join(root, 'demo');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  const base = [ev('agent_created', { agent: 'orchestrator-3', role: 'orchestrator', thread: 'orchestrator' }), ...log()];
  writeFileSync(join(dir, '.crux', 'events.jsonl'), base.map(e => JSON.stringify(e)).join('\n') + '\n');
  assert.equal(parseArgs(['--check', dir]).check, true);
  const outFile = join(root, 'report.md');
  const lines = [];
  assert.equal(await main([dir, '--check', '--out', outFile], l => lines.push(l)), 0);
  const md = readFileSync(outFile, 'utf8');
  assert.match(md, /the permission check in shadow mode/);
  assert.match(md, /CHECK WOULD HAVE ALLOWED/);
  assert.ok(lines.some(l => /Permission check \(shadow\): 9 read, 3 disagreements, 1 consults/.test(l)));
  assert.doesNotMatch(md, /orchestrator permission check/i);
  await main([dir, '--out', outFile], () => { });
  assert.doesNotMatch(readFileSync(outFile, 'utf8'), /shadow mode/, 'without --check there is no such section');
});
