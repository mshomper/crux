// The Expedition module's invariant (plan 2a): until the Lead's final summary, an expedition sends the orchestrator
// nothing (no message, no note, no thread line), opens no card, and notifies neither the phone nor the PC. After the
// final summary the orchestrator gets exactly one message. A new route by which an agent's output reaches the
// orchestrator or the user fails this test. RERUN IT IN EVERY LATER PHASE: extend StubExpedition.run() for what the
// phase adds, and this must still pass. Agents are stubbed: nothing starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recordAgents, stubHub, StubExpedition, quietMark, quietProblems } from './helpers/expedition-stub.mjs';

const sent = recordAgents();
// Phase 2 reruns it at Auto, where requests are judged and can be parked (at Ask they would all wait for an orchestrator).
const fresh = () => { sent.length = 0; const env = stubHub({ level: 'auto' }); const mark = quietMark(env); return { env, mark, ex: new StubExpedition(env) }; };
const summary = (over = {}) => ({ done: [], changed: [], questions: [], decisions_needed: [], blocked_on: [], next_step: '', visuals: [], approvals: [], open_questions: [], ...over });

test('a whole expedition life sends the orchestrator nothing, opens no card and notifies nobody', async () => {
  const { env, mark, ex } = fresh();
  ex.run();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(quietProblems(env, mark, sent), []);
  // It really did a lot: six hub agents, every kind of upward output tried.
  assert.equal(env.p.log.events.filter(e => e.type === 'agent_created' && e.expedition === ex.id).length, 6);
  assert.equal(env.p.log.events.filter(e => e.type === 'summary' && e.expedition === ex.id && e.held).length, 6, 'five members and the Lead asked things; every one was held');
  // Members' summaries went to the Lead, as text.
  const toLead = sent.filter(([name, t]) => name === ex.agents.lead.name && t.startsWith('[Summary from'));
  assert.equal(toLead.length, 5);
  assert.match(toLead[0][1], /Questions \(nobody is available to answer: decide in scope or park them\):\n- Should advisor widen the scope\?/);
  assert.match(toLead[0][1], /Decision numbers named \(decide in scope or park\): D0007/);
  // The held core lesson is parked for the report, not queued for the user.
  const lesson = env.p.log.ofType('expedition_parked').find(e => e.kind === 'lesson');
  assert.match(lesson.text, /software GPU/);
  assert.equal(env.hub.pendingLessons(env.p).length, 0);
  // The Lead's own mid-run summary stayed in its thread.
  assert.equal(sent.filter(([name]) => name === env.orch.name).length, 0);
  // Phase 2: a hard stop, a gatherer's unclear request and a settings-file write were refused or parked, never a card;
  // a read went through. The Lead's message to its builder reached the builder only.
  const answers = await Promise.all(ex.answers);
  assert.deepEqual(answers.map(a => a.behavior), ['deny', 'deny', 'deny', 'deny', 'allow']);
  assert.match(answers[0].message, /^Parked, not allowed:/);
  assert.match(answers[2].message, /^Not allowed: .*settings file/);
  assert.match(answers[3].message, /^Not allowed: Writes into the frozen success test/);
  const parked = env.p.log.ofType('expedition_parked').filter(e => e.kind === 'request');
  assert.equal(parked.length, 2, 'the hard stop and the web fetch; the settings write and the frozen-test write are denied, not parked');
  // Phase 4: the tamper the deny rule missed was found at the loop and put back, and that changed nothing upward.
  assert.deepEqual(env.p.log.ofType('expedition_integrity').map(e => [e.at, e.restored, e.changed]), [['loop', true, ['CHECKLIST.md (changed)']]]);
  assert.equal(readFileSync(ex.ex.path('test/CHECKLIST.md'), 'utf8').includes('weakened'), false, 'test/ is back as it was frozen');
  assert.deepEqual(parked.find(e => e.tool === 'WebFetch').subagent, { id: 'agent-1', type: 'expedition-gatherer' });
  assert.equal(env.hub.approvals.size, 0);
  assert.equal(env.p.log.ofType('permission_answer').filter(e => e.thread === 'orchestrator').length, 0);
  assert.deepEqual(sent.filter(([name, t]) => name === ex.agents.builder.name && t.startsWith('[From the Lead')).map(([, t]) => t.split('\n')[1]), ['Build against the frozen test.']);
  // The gatherers came in as the SDK's task messages and are all counted as ended.
  assert.deepEqual([ex.ex.runningSubagents(), env.p.log.ofType('expedition_subagent').length], [0, 6]);
});

test('after the final summary the orchestrator gets exactly one message, once, and still no card', async () => {
  const { env, mark, ex } = fresh();
  ex.run();
  assert.equal(ex.ex.summaryDue(), true, 'the card step is logged: the Lead may send its one summary');
  assert.equal(env.hub.upwardOf(env.p, ex.agents.lead).to, 'orchestrator');
  ex.finalSummary();
  const to = sent.filter(([name]) => name === env.orch.name);
  assert.equal(to.length, 1);
  assert.match(to[0][1], /^\[Summary from lead exp-lead\]\nDone:\n- Report written, branch pushed, draft PR opened/);
  assert.equal(env.p.log.ofType('expedition_step').filter(e => e.step === 'card').length, 1, 'one finished card');
  assert.equal(env.p.log.ofType('expedition_step').filter(e => e.step === 'summary').length, 1);
  assert.equal(ex.ex.state().phase, 'ended');
  // A second summary from the Lead is not sent: the one allowed is used.
  assert.equal(env.hub.upwardOf(env.p, ex.agents.lead).to, 'none');
  ex.finalSummary();
  assert.equal(sent.filter(([name]) => name === env.orch.name).length, 1);
  // Still no card or notice anywhere, and the only change in the orchestrator's thread is that one summary's own.
  await new Promise(r => setImmediate(r));
  const problems = quietProblems(env, mark, sent.filter(([name]) => name !== env.orch.name));
  assert.deepEqual(problems, []);
});

// Phase 3: the watchdog's own stop (a limit, or the user's Stop) interrupts, retires and sends the Lead a final message. None
// of that may reach the orchestrator or open a card, and after the end there is still exactly one summary.
for (const reason of ['time', 'Matt']) {
  test(`the watchdog's ${reason} stop is quiet: interrupt, retirements and the Lead's final message reach no one upward, and the end is still one summary`, async () => {
    const clock = { t: Date.now() }, pending = [];
    const timers = { setTimeout: (fn, ms) => { const h = { fn, ms, on: true }; pending.push(h); return h; }, clearTimeout: h => { if (h) h.on = false; }, setInterval: () => ({ unref() { } }), clearInterval() { } };
    sent.length = 0;
    const env = stubHub({ level: 'auto', watch: { now: () => clock.t, timers } });
    const mark = quietMark(env);
    const ex = new StubExpedition(env);
    ex.run({ stop: false });
    const wd = env.hub.expeditionWatch;
    clock.t = Date.parse(ex.ex.state().started.ts) + 7 * 3600 * 1000;
    if (reason === 'time') assert.deepEqual(wd.check(clock.t).map(d => d.did), ['stop']);
    else wd.stopNow(env.p, ex.id, 'Matt', clock.t);
    await new Promise(r => setImmediate(r));
    for (const h of pending.filter(x => x.on && x.ms === 60000)) { h.on = false; h.fn(); }   // the members the stub left "working" never answer: the fallback closes them
    await wd.settled();
    assert.equal(ex.ex.state().stopped.reason, reason);
    assert.equal(ex.ex.state().phase, 'stopped');
    assert.deepEqual(['advisor', 'synthesizer', 'skeptic', 'builder', 'verifier'].map(r => ex.agents[r].state), Array(5).fill('retired'));
    assert.notEqual(ex.agents.lead.state, 'retired');
    assert.equal(sent.filter(([name, t]) => name === ex.agents.lead.name && t.startsWith('[From the hub] The expedition has stopped')).length, 1);
    assert.deepEqual(quietProblems(env, mark, sent), []);
    // The end: the report and steps, then the Lead's one summary: the orchestrator gets exactly one message.
    ex.finish();
    ex.finalSummary();
    assert.equal(sent.filter(([name]) => name === env.orch.name).length, 1);
    assert.equal(ex.ex.state().phase, 'ended');
  });
}

test('the check can fail: a plain worker that asks a question trips it', async () => {
  const { env, mark } = fresh();
  const w = env.hub.startWorker(env.p, 'plain', 'Build it', env.orch.name, 'Build it');
  env.hub.postSummary(env.p, w, summary({ done: ['x'], questions: ['Which way should it go?'] }));
  const bad = quietProblems(env, mark, sent);
  assert.ok(bad.some(x => /the orchestrator was sent/.test(x)), bad.join('; '));
  assert.ok(bad.some(x => /carry questions/.test(x)), bad.join('; '));
  assert.ok(bad.some(x => /Needs you holds an open question/.test(x)), bad.join('; '));
});

test('a Lead\'s summary before the end is held even when it asks, and a member whose Lead is gone reaches no one', () => {
  const { env, mark, ex } = fresh();
  ex.run();
  const { hub, p } = env;
  // A member after the Lead has retired: nowhere to go (none), still no card.
  hub.finishRetire(p, ex.agents.lead);
  const w = hub.startWorker(p, 'late', 'Late', 'hub', 'Late', { type: 'expedition-builder', expedition: ex.id, expeditionRole: 'builder' });
  hub.postSummary(p, w, summary({ done: ['x'], questions: ['Anything?'] }));
  assert.equal(hub.upwardOf(p, w).to, 'none');
  assert.deepEqual(quietProblems(env, mark, sent), []);
});
