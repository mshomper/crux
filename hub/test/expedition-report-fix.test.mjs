// The first full expedition's report (f13ld.mesh, 2026-11-16) showed three faults. One test each:
//  1. the Synthesizer and Skeptic had no spend: the Lead retired them mid-turn, which cut off the result that carries usage;
//  2. the claims check read "not checked" though the Verifier checked the claims: the Verifier's file and the reader named no common heading;
//  3. REPORT.md had two "How it ran" sections: the Lead's empty placeholder and the hub's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordAgents, stubHub, StubExpedition, MODEL } from './helpers/expedition-stub.mjs';
import { howItRan, assembleReport, claimsStatus } from '../lib/expedition-report.mjs';
import { parseAgentFile } from '../lib/agent-types.mjs';
import { refreshExpeditionFiles, hashOf } from '../lib/starter-refresh.mjs';
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { makeTmp } from './helpers/tmp.mjs';

recordAgents();
const STARTER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent-types', 'starter');
const resultOf = cost => ({ type: 'result', subtype: 'success', is_error: false, modelUsage: { [MODEL.sonnet]: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost } } });

test('bug 1: a member the Lead retires mid-turn keeps its usage: it closes when its result is in, and the report and the watchdog count it', async () => {
  const env = stubHub(), se = new StubExpedition(env);
  se.ex.write('BRIEF.md', 'q');
  se.ex.start({ envelope: { dollars: 5 } });
  const lead = se.startRole('lead', env.orch.name);
  const skeptic = se.startRole('skeptic', lead.name);
  skeptic.q = { getContextUsage: async () => ({ percentage: 5 }) };   // a live query, in its turn
  skeptic.state = 'working';
  env.hub.leadRetire(env.p, lead, skeptic.name, 'objections are in');
  assert.notEqual(skeptic.state, 'retired', 'still finishing its turn');
  assert.ok(skeptic.q, 'its query is not closed before its result');
  assert.equal(env.p.log.ofType('agent_retired').filter(e => e.agent === skeptic.name).length, 0);
  await skeptic.onMessage(resultOf(0.25), skeptic.q);
  const u = env.p.log.ofType('usage').filter(e => e.agent === skeptic.name);
  assert.equal(u.length, 1, 'its usage is logged');
  assert.equal(u[0].expeditionRole, 'skeptic');
  assert.equal(skeptic.state, 'retired', 'and it retires once the result is in');
  const row = howItRan(env.p.log.events, se.id).rows.find(r => r.role === 'skeptic');
  assert.equal(row.turns, 1);
  assert.ok(row.costUSD > 0 && row.tokens.output === 50);
  // The watchdog's spend counts it too.
  assert.ok(Math.abs(env.hub.expeditionWatch.trackOf(env.p, se.id).settledUSD - u[0].costUSD) < 1e-9);
});

test('bug 1: a retire that waited for the result still posts the "retired as finished" line in the thread', async () => {
  const env = stubHub(), se = new StubExpedition(env);
  se.ex.write('BRIEF.md', 'q'); se.ex.start({});
  const lead = se.startRole('lead', env.orch.name), syn = se.startRole('synthesizer', lead.name);
  syn.q = { getContextUsage: async () => ({ percentage: 5 }) }; syn.state = 'working';
  const said = () => env.p.log.ofType('notice').filter(e => e.thread === syn.thread && /retired .* as finished: done/.test(e.text));
  env.hub.leadRetire(env.p, lead, syn.name, 'done');
  assert.equal(said().length, 0, 'not before it happens');
  await syn.onMessage(resultOf(0.1), syn.q);
  assert.equal(said().length, 1);
});

test('a member whose result never comes is still closed after a cap, with the same line', async () => {
  const env = stubHub(), se = new StubExpedition(env);
  se.ex.write('BRIEF.md', 'q'); se.ex.start({});
  const lead = se.startRole('lead', env.orch.name), syn = se.startRole('synthesizer', lead.name);
  syn.q = {}; syn.state = 'working';
  env.hub.leadRetire(env.p, lead, syn.name, 'enough');
  assert.ok(syn.finishTimer, 'a fallback timer is set');
  env.hub.finishRetire(env.p, syn);   // what the timer does
  assert.equal(syn.state, 'retired');
  assert.equal(env.p.log.ofType('notice').filter(e => /retired .* as finished: enough/.test(e.text)).length, 1);
  assert.equal(syn.finishWhenIdle, null);
});

test('bug 2: the Verifier\'s file names the heading the hub\'s reader looks for, and the reader is tolerant', () => {
  const t = parseAgentFile(readFileSync(join(STARTER, 'expedition-verifier.md'), 'utf8'), 'expedition-verifier.md');
  assert.match(t.prompt, /## Claims check/);
  assert.match(t.prompt, /No corrections\./);
  const shaped = '# Verdict\n\n| 1 | PASS |\n\n## Claims check\n\nChecked: 31 claims, 2 corrections.\nC1: a | b | c\n';
  assert.equal(claimsStatus(shaped), 'checked');
  for (const h of ['## Claims and corrections', '### 3. Corrections', '# Claims', '## Fact check', '#### Claim check']) assert.equal(claimsStatus(`# V\n\n${h}\n\nx\n`), 'checked', h);
  assert.equal(claimsStatus('# Verdict\n\nthe claims pass is in VERIFY-2.md\n'), 'not checked', 'prose alone is not a section');
  assert.equal(claimsStatus('# Verdict (final, run 3)\n\n| item | verdict |\n'), 'not checked');
  assert.equal(claimsStatus(null), 'not checked');
});

test('bug 3: one "How it ran": the Lead is told not to write it, and a placeholder it writes anyway is replaced by the hub\'s', () => {
  const lead = parseAgentFile(readFileSync(join(STARTER, 'expedition-lead.md'), 'utf8'), 'expedition-lead.md');
  assert.match(lead.prompt, /Do not write a "how it ran" section/);
  const env = stubHub(), se = new StubExpedition(env);
  se.ex.write('BRIEF.md', 'q'); se.ex.start({});
  se.startRole('lead', env.orch.name); se.usage('lead');
  const leadText = '# Report\n\n## 1. Answer\n\nYes.\n\n## 6. Parked\n\nNone.\n\n## 7. How it ran (generated by the hub from its logs)\n\n(placeholder)\n\n### a sub-part\n\nx\n\n## 8. Sources\n\n- one\n';
  const md = assembleReport({ leadText, events: env.p.log.events, id: se.id, claims: 'checked', hubStop: false });
  const headings = md.split('\n').filter(l => /^#{1,6}\s.*how it ran/i.test(l));
  assert.deepEqual(headings, ['## How it ran'], 'only the hub\'s heading');
  assert.ok(!md.includes('placeholder') && !md.includes('a sub-part'));
  assert.ok(md.includes('## 8. Sources') && md.includes('## 6. Parked') && md.indexOf('## 8. Sources') < md.indexOf('## How it ran'));
  assert.match(md, /\| Lead \(incl\. gatherers\) \|/, 'the hub\'s table is there');
});

// ---------- the installed copies follow the hub ----------
test('start-up refresh: an unedited older copy is replaced, an edited one is kept with one line, a missing one is not added', () => {
  const prev = JSON.parse(readFileSync(join(STARTER, 'previous-hashes.json'), 'utf8'));
  const dir = join(makeTmp('crux-refresh-'), 'agents'); mkdirSync(dir, { recursive: true });
  const current = f => readFileSync(join(STARTER, f), 'utf8');
  // Stand-ins for the shipped older versions: the real hashes cannot be reproduced from text here, so a fake starter is used.
  const starter = join(dir, '..', 'starter'); mkdirSync(starter);
  writeFileSync(join(starter, 'expedition-lead.md'), 'NEW lead\n');
  writeFileSync(join(starter, 'expedition-verifier.md'), 'NEW verifier\n');
  writeFileSync(join(starter, 'expedition-skeptic.md'), 'NEW skeptic\n');
  writeFileSync(join(starter, 'previous-hashes.json'), JSON.stringify({ 'expedition-lead.md': [hashOf('OLD lead\n')], 'expedition-verifier.md': [hashOf('OLD verifier\n')] }));
  writeFileSync(join(dir, 'expedition-lead.md'), 'OLD lead\r\n');          // unedited (CRLF is not an edit)
  writeFileSync(join(dir, 'expedition-verifier.md'), 'OLD verifier\nplus my own line\n');   // edited
  const lines = [];
  const r = refreshExpeditionFiles([dir], { starter, log: l => lines.push(l) });
  assert.equal(readFileSync(join(dir, 'expedition-lead.md'), 'utf8'), 'NEW lead\n');
  assert.equal(readFileSync(join(dir, 'expedition-verifier.md'), 'utf8'), 'OLD verifier\nplus my own line\n');
  assert.ok(!existsSync(join(dir, 'expedition-skeptic.md')), 'not installed, not added');
  assert.equal(r.refreshed.length, 1); assert.equal(r.kept.length, 1);
  assert.equal(lines.filter(l => /was edited/.test(l)).length, 1);
  // Run again: nothing left to do.
  assert.deepEqual(refreshExpeditionFiles([dir], { starter, log: () => { } }).refreshed, []);
  // The shipped history really lists the previous Lead and Verifier (what Matt's installed copies are).
  assert.ok(prev['expedition-lead.md'].length && prev['expedition-verifier.md'].length);
  assert.ok(!prev['expedition-lead.md'].includes(hashOf(current('expedition-lead.md'))), 'the current file is not its own history');
  // The versions before decision 75 (PR 127) are listed, so those installed copies are refreshed.
  assert.ok(prev['expedition-lead.md'].includes('86e88e6c9d35b66d'));
  assert.ok(prev['expedition-gatherer.md'].includes('8d9024bd6a95be17'));   // later edits add the text before them to each list (the standing line, 0.34.0)
  // Every entry is a list of 16-character hashes of a file that exists, and none is the file's own current text.
  for (const [f, list] of Object.entries(prev)) {
    assert.ok(existsSync(join(STARTER, f)), `${f} is a starter file`);
    for (const h of list) assert.match(h, /^[0-9a-f]{16}$/, f);
    assert.ok(!list.includes(hashOf(current(f))), `${f}: the current text is not in its own history`);
  }
});
