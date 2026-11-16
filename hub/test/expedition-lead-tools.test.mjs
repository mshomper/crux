// The Lead's structured tools (plan section 2, item 9; Matt, 2026-11-16): expedition_decide, expedition_park,
// expedition_close_gate, expedition_loop_result, expedition_finish. Each is the Expedition class's own method for the
// calling Lead's expedition, so the log, DECISIONS.md and the report come from the hub, not from lines the Lead writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordAgents, stubHub, StubExpedition, quietMark, quietProblems } from './helpers/expedition-stub.mjs';
import { cruxTools, cruxToolNames } from '../lib/tools.mjs';

const sent = recordAgents();
const TOOLS = ['expedition_decide', 'expedition_park', 'expedition_close_gate', 'expedition_loop_result', 'expedition_finish'];

// One expedition that has started (planning), with a Lead and a Builder, and the tools as the Lead gets them.
function world() {
  sent.length = 0;
  const env = stubHub({ level: 'auto' });
  const ex = new StubExpedition(env, { question: 'Which of two JSON libraries is faster' });
  ex.ex.write('BRIEF.md', '# q\n'); ex.ex.write('test/CHECKLIST.md', '1. a table\n');
  ex.ex.start();
  ex.startRole('lead', env.orch.name);
  ex.startRole('builder', ex.agents.lead.name);
  const rt = cruxTools(env.hub, env.p, ex.agents.lead).instance._registeredTools;
  const call = async (name, args) => (await rt[name].handler(args, {})).content[0].text;
  return { env, ex, rt, call, lead: ex.agents.lead, p: env.p, hub: env.hub };
}

test('only the Lead has the structured tools, and they are in its allowed list', () => {
  const { env, ex, rt, lead } = world();
  for (const n of TOOLS) { assert.ok(rt[n], n); assert.ok(cruxToolNames(lead).includes(`mcp__crux__${n}`), n); }
  for (const a of [ex.agents.builder, env.orch]) {
    const t = cruxTools(env.hub, env.p, a).instance._registeredTools;
    for (const n of TOOLS) assert.ok(!t[n], `${a.name} has no ${n}`);
    for (const n of TOOLS) assert.ok(!cruxToolNames(a).includes(`mcp__crux__${n}`), n);
  }
});

test('expedition_decide numbers the decision, writes the DECISIONS.md line and logs the event, for the Lead or a named maker', async () => {
  const { ex, call, p } = world();
  assert.equal(await call('expedition_decide', { text: 'Use the 1 MB sample', reason: 'it is inside the brief' }), 'Logged as decision 1.');
  assert.equal(await call('expedition_decide', { text: 'Keep item 3', reason: 'the reference ties the numbers', maker: 'exp-advisor' }), 'Logged as decision 2.');
  assert.equal(ex.ex.read('DECISIONS.md'), '1. Use the 1 MB sample. Reason: it is inside the brief. By: exp-lead.\n2. Keep item 3. Reason: the reference ties the numbers. By: exp-advisor.\n');
  const evs = p.log.ofType('expedition_decision');
  assert.deepEqual(evs.map(e => [e.number, e.maker, e.expedition]), [[1, 'exp-lead', ex.id], [2, 'exp-advisor', ex.id]]);
  // A missing reason is refused in plain words, and nothing is logged.
  assert.match(await call('expedition_decide', { text: 'x', reason: '  ' }), /^Not logged: The reason is needed/);
  assert.equal(p.log.ofType('expedition_decision').length, 2);
});

test('expedition_park logs what was parked and why', async () => {
  const { ex, call, p } = world();
  assert.equal(await call('expedition_park', { text: 'Compare a third library', reason: 'outside the brief' }), 'Parked; it is listed in the report.');
  const e = p.log.ofType('expedition_parked').at(-1);
  assert.deepEqual([e.text, e.reason, e.maker, e.expedition], ['Compare a third library', 'outside the brief', 'exp-lead', ex.id]);
  assert.match(await call('expedition_park', { text: '', reason: 'x' }), /^Not parked: What was parked is needed/);
});

test('expedition_close_gate freezes the test once: the hash is logged, the phase moves to running, a second gate is refused', async () => {
  const { ex, call, p } = world();
  assert.equal(ex.ex.state().phase, 'planning');
  const said = await call('expedition_close_gate', { verdict: 'approve with changes', amendments: ['3. results tied to a reference'] });
  const g = p.log.ofType('expedition_gate').at(-1);
  assert.match(g.testHash, /^[0-9a-f]{64}$/);
  assert.equal(g.testHash, ex.ex.testHash());
  assert.deepEqual([g.verdict, g.amendments, g.expedition], ['approve with changes', ['3. results tied to a reference'], ex.id]);
  assert.equal(said, `Gate closed. The success test is frozen (hash ${g.testHash.slice(0, 12)}); building and verifying can start.`);
  assert.equal(ex.ex.state().phase, 'running');
  assert.match(await call('expedition_close_gate', { verdict: 'again' }), /^Gate not closed: .*is running; this needs it to be planning/);
  assert.equal(p.log.ofType('expedition_gate').length, 1);
});

test('expedition_close_gate refuses an empty verdict and an empty test, and logs nothing', async () => {
  const { ex, call, p } = world();
  assert.match(await call('expedition_close_gate', { verdict: ' ' }), /^Gate not closed: .*verdict is needed/);
  // An empty success test cannot be frozen.
  const fresh = world();
  const { rmSync } = await import('node:fs');
  rmSync(fresh.ex.ex.path('test/CHECKLIST.md'));
  assert.match(await fresh.call('expedition_close_gate', { verdict: 'ok' }), /^Gate not closed: The success test is empty/);
  assert.equal(p.log.ofType('expedition_gate').length + fresh.p.log.ofType('expedition_gate').length, 0);
  void ex;
});

test('expedition_loop_result numbers the loop and judges progress itself; two loops in a row with none says to finish', async () => {
  const { ex, call, p } = world();
  assert.match(await call('expedition_loop_result', { passing: 1 }), /^Not logged: .*is planning; this needs it to be running/, 'not before the gate');
  await call('expedition_close_gate', { verdict: 'ok' });
  assert.equal(await call('expedition_loop_result', { passing: 0 }), 'Loop 1: 0 passing, no progress.', 'nothing passing is not progress');
  assert.equal(await call('expedition_loop_result', { passing: 3 }), 'Loop 2: 3 passing, progress.');
  assert.equal(await call('expedition_loop_result', { passing: 3 }), 'Loop 3: 3 passing, no progress.');
  assert.match(await call('expedition_loop_result', { passing: 2 }), /^Loop 4: 2 passing, no progress\. Two loops in a row made no progress: call expedition_finish with reason no-progress/);
  assert.deepEqual(p.log.ofType('expedition_loop').map(e => [e.number, e.passing, e.progress, e.expedition]), [[1, 0, false, ex.id], [2, 3, true, ex.id], [3, 3, false, ex.id], [4, 2, false, ex.id]]);
});

test('expedition_finish stops the expedition with the hub\'s own totals; only passed or no-progress are the Lead\'s to give', async () => {
  const { ex, call, rt, p } = world();
  ex.usage('lead', { cost: 0.25 }); ex.usage('builder', { cost: 0.5 });
  await call('expedition_close_gate', { verdict: 'ok' });
  assert.equal(rt.expedition_finish.inputSchema.shape.reason.safeParse('time').success, false, 'time, budget and Matt come from the hub');
  assert.equal(rt.expedition_finish.inputSchema.shape.reason.safeParse('passed').success, true);
  assert.equal(await call('expedition_finish', { reason: 'passed' }), 'Stopped (passed). Write the report now.');
  const s = p.log.ofType('expedition_stopped').at(-1);
  assert.deepEqual([s.reason, s.expedition], ['passed', ex.id]);
  assert.equal(s.totals.costUSD, 0.75);
  assert.equal(ex.ex.state().phase, 'stopped');
  assert.match(await call('expedition_finish', { reason: 'no-progress' }), /^Not finished: .*is stopped; this needs it to be planning or running/);
  assert.equal(p.log.ofType('expedition_stopped').length, 1);
});

test('each Lead\'s tools act on its own expedition only', async () => {
  const { env, ex, call, p } = world();
  const other = new StubExpedition(env, { question: 'A different question' });
  other.ex.write('BRIEF.md', 'q'); other.ex.write('test/CHECKLIST.md', '1'); other.ex.start();
  other.startRole('lead', env.orch.name);
  const call2 = async (name, args) => (await cruxTools(env.hub, p, other.agents.lead).instance._registeredTools[name].handler(args, {})).content[0].text;
  await call('expedition_decide', { text: 'mine', reason: 'r' });
  await call2('expedition_decide', { text: 'theirs', reason: 'r' });
  await call2('expedition_close_gate', { verdict: 'ok' });
  assert.deepEqual(ex.ex.state().decisions.map(d => d.text), ['mine']);
  assert.deepEqual(other.ex.state().decisions.map(d => d.text), ['theirs']);
  assert.equal(ex.ex.state().phase, 'planning');
  assert.equal(other.ex.state().phase, 'running');
});

test('the tools keep the invariant: a whole life through them sends the orchestrator nothing and opens no card', async () => {
  sent.length = 0;
  const env = stubHub({ level: 'auto' });
  const mark = quietMark(env);
  const ex = new StubExpedition(env, { question: 'Through the tools' });
  ex.ex.write('BRIEF.md', 'q'); ex.ex.write('test/CHECKLIST.md', '1. a\n2. b\n'); ex.ex.start();
  const lead = ex.startRole('lead', env.orch.name);
  const t = cruxTools(env.hub, env.p, lead).instance._registeredTools;
  const call = async (n, a) => (await t[n].handler(a, {})).content[0].text;
  ex.startRole('advisor', lead.name);
  await call('expedition_decide', { text: 'd', reason: 'r' });
  await call('expedition_close_gate', { verdict: 'ok' });
  await call('expedition_park', { text: 'p', reason: 'outside' });
  await call('expedition_loop_result', { passing: 2 });
  await call('expedition_finish', { reason: 'passed' });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(quietProblems(env, mark, sent), []);
});
