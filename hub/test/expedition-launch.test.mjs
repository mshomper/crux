// Phase 5, launch and state (decisions 63, 69 to 72): a launch that is one plain ask, every refusal before anything is written,
// the dollar cap from the one confirmed figure, the thread draft, the Stop, the state the page reads, proposed next
// expeditions, the role-folder write rule (M049 7) and package baselines (M049 8). Agents are stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { recordAgents, stubHub, StubExpedition } from './helpers/expedition-stub.mjs';
import { cruxTools, cruxToolNames } from '../lib/tools.mjs';
import { classify } from '../lib/permission-rules.mjs';
import { runChecks } from '../lib/expedition.mjs';
import { stepUpNeed } from '../lib/guard.mjs';

const sent = recordAgents();
const summary = (over = {}) => ({ done: [], changed: [], questions: [], decisions_needed: [], blocked_on: [], next_step: '', visuals: [], approvals: [], open_questions: [], ...over });
const Q = 'Which of two JSON libraries is faster for X?';
const world = (opts = {}) => { sent.length = 0; const env = stubHub({ level: 'auto', watch: { stopWaitMs: 20 }, ...opts }); return { ...env, view: () => env.hub.state()[0].expedition }; };
const expDir = p => join(p.dir, '.crux', 'expeditions');
const snap = p => ({ events: p.log.events.length, dirs: existsSync(expDir(p)) ? readdirSync(expDir(p)).join(',') : '' });
const tools = (env, agent) => { const rt = cruxTools(env.hub, env.p, agent).instance._registeredTools; return { rt, call: async (name, args) => (await rt[name].handler(args, {})).content[0].text }; };

// ---------- a launch is one plain ask ----------
test('a launch with only a question runs to a closed gate: the Lead drafts the success test while planning and the gate freezes it', async () => {
  const env = world();
  const { hub, p } = env;
  const r = hub.launchExpedition(p, { question: Q });
  const ex = hub.expeditionOf(p, r.id), lead = p.agents.get(r.lead);
  assert.equal(ex.read('BRIEF.md'), `${Q}\n`, 'the ask is the brief');
  assert.deepEqual(ex.testFiles(), [], 'no test came with it');
  assert.equal(ex.state().started.question, Q);
  assert.equal(ex.state().phase, 'planning');
  assert.match(sent.find(([n]) => n === lead.name)[1], /No success test came with the launch, only the question\. While you plan, draft it yourself in test\//);
  // The gate cannot close on nothing, and says why in the Lead's words.
  const { call } = tools(env, lead);
  assert.match(await call('expedition_close_gate', { verdict: 'approve' }), /^Gate not closed: The success test is empty: put CHECKLIST\.md or run\.json in test\/ first\./);
  assert.equal(ex.state().phase, 'planning');
  // The Lead writes its test where the permission rule lets it (the expedition's own folder under .crux), then closes the gate.
  const mine = name => join(ex.root, 'test', name);
  assert.equal((await hub.requestApproval(p, lead, 'Write', { file_path: mine('CHECKLIST.md'), content: '1. A table (read)\n' })).behavior, 'allow');
  assert.equal((await hub.requestApproval(p, lead, 'Write', { file_path: mine('run.json'), content: '{}' })).behavior, 'allow');
  ex.write('test/CHECKLIST.md', '1. A table exists (judged by reading it).\n2. The benchmark runs (judged by running it).\n');
  ex.write('test/run.json', JSON.stringify({ checks: [{ name: 'the benchmark runs', command: 'node bench.mjs', cwd: '.', timeout: 60 }] }));
  assert.match(await call('expedition_close_gate', { verdict: 'approve with changes', amendments: ['2. judged by running it'] }), /^Gate closed\. The hub logged the test's hash/);
  assert.equal(ex.state().phase, 'running');
  assert.match(ex.state().gate.testHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(readdirSync(ex.frozenDir).sort(), ['CHECKLIST.md', 'run.json'], 'the stored copy is made');
  // Frozen as before: a plain write into test/ is refused from here.
  const after = await hub.requestApproval(p, lead, 'Write', { file_path: mine('CHECKLIST.md'), content: 'x' });
  assert.equal(after.behavior, 'deny');
  assert.match(after.message, /frozen success test/);
  // The same launch with a test keeps today's behaviour: the test is in test/ and the Lead is told to keep it.
  const e2 = world();
  const r2 = e2.hub.launchExpedition(e2.p, { question: Q, test: { 'CHECKLIST.md': '1. a table\n' } });
  assert.deepEqual(e2.hub.expeditionOf(e2.p, r2.id).testFiles(), ['test/CHECKLIST.md']);
  assert.match(sent.filter(([n]) => n === r2.lead).at(-1)[1], /The success test came with the launch: it is in test\/ \(CHECKLIST\.md\)\. Keep it/);
});

test('every refusal is written before anything: no folder, no event, no agent', () => {
  const cases = [
    [{}, /ask is empty/],
    [{ question: '  ' }, /ask is empty/],
    [{ question: Q, preApprovals: { packages: [{ eco: 'npm', name: 'Bad Name' }] } }, /Pre-approved package/],
    [{ question: Q, preApprovals: { sites: [{ host: 'https://x.org/y' }] } }, /Pre-approved site/],
    [{ question: Q, test: { 'run.json': '{not json' } }, /run\.json is not valid JSON/],
    [{ question: Q, test: { 'run.json': '{"checks":[{"name":"x"}]}' } }, /check 1 has no "command"/],
    [{ question: Q, test: { 'run.json': '{"checks":[{"command":"x","cwd":"../up"}]}' } }, /never absolute or "\.\."/],
    [{ question: Q, test: { 'run.json': '{"checks":[{"command":"x","timeout":99999}]}' } }, /"timeout" is a number of seconds/],
    [{ question: Q, test: { '../CHECKLIST.md': 'x' } }, /not a name for a success-test file/],
    [{ question: Q, test: { 'BRIEF.md': 'x' } }, /not a name for a success-test file/],
    [{ question: Q, roles: { builder: { effort: 'enormous' } } }, /Builder's effort must be one of/],
    [{ question: Q, roles: { verifier: { model: 'sonnet' } } }, /Verifier and the Builder both run on/]
  ];
  for (const [input, why] of cases) {
    const env = world();
    const before = snap(env.p), agents = env.p.agents.size;
    assert.throws(() => env.hub.launchExpedition(env.p, input), why, JSON.stringify(input));
    assert.deepEqual([snap(env.p), env.p.agents.size], [before, agents], `nothing written for ${JSON.stringify(input)}`);
  }
  // Situations: at Ask, one already running, no agent types, an API key with no dollar cap.
  const ask = world({ level: 'standard' }), b1 = snap(ask.p);
  assert.throws(() => ask.hub.launchExpedition(ask.p, { question: Q }), /project is at Ask/);
  assert.deepEqual(snap(ask.p), b1);
  const one = world();
  one.hub.launchExpedition(one.p, { question: Q });
  const b2 = snap(one.p);
  assert.throws(() => one.hub.launchExpedition(one.p, { question: 'Another?' }), /still planning: one expedition runs per project at a time/);
  assert.deepEqual(snap(one.p), b2);
  const key = world(), b3 = snap(key.p);
  key.hub.usage.available = false;
  assert.throws(() => key.hub.launchExpedition(key.p, { question: Q }), /Under an API key the plan meters are hidden.*dollar cap/);
  assert.deepEqual(snap(key.p), b3);
  assert.ok(key.hub.launchExpedition(key.p, { question: Q, envelope: { dollars: 4 } }).id, 'a dollar figure makes it allowed');
});

test('run.json: the checks shape, with the spec\'s single form read as one check; the problems are in plain words', () => {
  assert.deepEqual(runChecks('{"checks":[{"name":"runs","command":"node bench.mjs","cwd":"bench","timeout":30},{"command":"npm test"}]}').checks,
    [{ name: 'runs', command: 'node bench.mjs', cwd: 'bench', timeout: 30 }, { name: 'npm test', command: 'npm test', cwd: '.', timeout: 120 }]);
  assert.deepEqual(runChecks({ command: 'node bench.mjs', cwd: '.', timeout: 60 }).checks, [{ name: 'node bench.mjs', command: 'node bench.mjs', cwd: '.', timeout: 60 }]);
  assert.match(runChecks('{"checks":[]}').problem, /needs at least one check/);
  assert.match(runChecks('[]').problem, /needs at least one check/);
  assert.match(runChecks('{"checks":[{"command":"x","cwd":"C:/x"}]}').problem, /never absolute/);
});

// ---------- the dollar cap (decision 69 C) ----------
test('the cap comes from the one confirmed dollars-per-percent figure; with none there is no cap and no invented figure', () => {
  const none = world();
  assert.deepEqual([none.view().defaults.dollarsPerPercent, none.view().defaults.dollars], [null, null]);
  assert.match(none.view().budgetNote, /^No dollars-per-percent figure is confirmed yet, so there is no dollar cap: this run is held by the time limit and the 7-day meter \(up 7 points\)\. Set defaults\.expedition\.dollarsPerPercent in hub\.json/);
  const r0 = none.hub.launchExpedition(none.p, { question: Q });
  assert.equal(r0.expedition.envelope.dollars, null);
  assert.deepEqual([r0.dollarCap.confirmed, r0.dollarCap.dollars], [false, null]);
  // A figure the user typed with none confirmed stands (it is theirs).
  const typed = world();
  assert.equal(typed.hub.launchExpedition(typed.p, { question: Q, envelope: { dollars: 20 } }).expedition.envelope.dollars, 20);
  // With the figure: percent x figure, shown beside the percent; a figure a page sends along does not win.
  const sure = world();
  sure.hub.defaults = { expedition: { dollarsPerPercent: 9 } };
  assert.deepEqual([sure.view().defaults.dollarsPerPercent, sure.view().defaults.dollars], [9, 63]);
  assert.match(sure.view().budgetNote, /^7% of the week is about \$63 \(at \$9 per 1%, the figure in hub\.json\)\. The run stops at that dollar figure or when the 7-day meter rises 7 points, whichever comes first\.$/);
  const r = sure.hub.launchExpedition(sure.p, { question: Q, envelope: { percent: 5, dollars: 1 } });
  assert.deepEqual([r.expedition.envelope.percent, r.expedition.envelope.dollars, r.dollarCap.confirmed, r.dollarCap.dollars], [5, 45, true, 45]);
  assert.match(sure.hub.expeditionOf(sure.p, r.id).state().started.envelope.dollars + '', /^45$/);
  // Under an API key the meter guard is not there, and the note says only the dollars and the time hold.
  const key = world();
  key.hub.defaults = { expedition: { dollarsPerPercent: 9 } }; key.hub.usage.available = false;
  assert.equal(key.view().defaults.meterGuard, false);
  const k = key.hub.launchExpedition(key.p, { question: Q });
  assert.equal(k.dollarCap.dollars, 63);
});

test('defaults from hub.json (envelope, gatherers, role picks) and the built-ins; the launch\'s own picks win', () => {
  const env = world();
  const built = env.view().defaults;
  assert.deepEqual(built.envelope, { hours: 6, percent: 7 });
  assert.deepEqual([built.gatherers, built.gathererLimit], [3, 4]);
  assert.deepEqual(Object.keys(built.roles), ['lead', 'advisor', 'gatherer', 'synthesizer', 'skeptic', 'builder', 'verifier']);
  assert.deepEqual([built.roles.gatherer.runs, built.roles.lead.runs, built.roles.builder.model, built.roles.verifier.effort, built.roles.builder.installed], ['subagent', 'hub', 'claude-sonnet-5-5', 'high', true]);
  env.hub.defaults = { expedition: { envelope: { hours: 3, percent: 4 }, gatherers: 2, roles: { builder: { model: 'haiku', effort: 'low' } } } };
  const d = env.view().defaults;
  assert.deepEqual([d.envelope, d.gatherers, d.roles.builder.model, d.roles.builder.effort], [{ hours: 3, percent: 4 }, 2, 'claude-haiku-5-5', 'low']);
  const r = env.hub.launchExpedition(env.p, { question: Q, roles: { builder: { model: 'fable' } }, envelope: { hours: 1 } });
  const s = env.hub.expeditionOf(env.p, r.id).state().started;
  assert.deepEqual([s.envelope.hours, s.envelope.percent, s.envelope.gatherers, s.roles.builder.model, s.roles.builder.effort], [1, 4, 2, 'claude-fable-5-2', 'low']);
});

// ---------- the state the page reads ----------
test('hub.state() carries expedition per project: whether a launch would work, what is running, past ones', () => {
  const env = world();
  assert.deepEqual([env.view().launch, env.view().current, env.view().past, env.view().drafts, env.view().proposals], [{ ok: true, reason: null }, null, [], [], []]);
  const r = env.hub.launchExpedition(env.p, { question: Q, brief: 'More scope.\nOut: licences.' });
  const v = env.view();
  assert.equal(v.launch.ok, false);
  assert.match(v.launch.reason, /still planning: one expedition runs per project at a time/);
  assert.deepEqual([v.current.id, v.current.name, v.current.phase, v.current.stopReason, v.current.lead, v.current.liveAgents, v.current.steps, v.current.branch, v.current.pr], [r.id, Q, 'planning', null, r.lead, 1, [], `expedition/${r.id}`, null]);
  assert.equal(v.current.envelope.hours, 6);
  assert.equal(v.current.roles.builder.type, 'expedition-builder');
  const ask = world({ level: 'standard' });
  assert.deepEqual([ask.view().launch.ok, /project is at Ask/.test(ask.view().launch.reason)], [false, true]);
  // The state is JSON the page can take as it is.
  assert.doesNotThrow(() => JSON.stringify(env.hub.state()));
});

// ---------- Stop (M049 2) ----------
test('stopExpedition: the running one when no id is given, reason Matt; none running is said plainly; a stopped one is "already"', async () => {
  const env = world();
  assert.throws(() => env.hub.stopExpedition(env.p), /No expedition is running in proj/);
  const r = env.hub.launchExpedition(env.p, { question: Q });
  const out = env.hub.stopExpedition(env.p);
  await env.hub.expeditionWatch.settled();
  assert.deepEqual([out.did, out.reason, out.expedition], ['stop', 'Matt', r.id]);
  assert.equal(env.hub.expeditionOf(env.p, r.id).state().stopped.reason, 'Matt');
  assert.equal(env.hub.stopExpedition(env.p, r.id).did, 'already');
  assert.throws(() => env.hub.stopExpedition(env.p, r.id, 'passed'), /Lead's to log/);
  assert.throws(() => env.hub.stopExpedition(env.p, '20261116-nothing'), /No expedition 20261116-nothing/);
});

// ---------- the thread draft (decision 70 A) ----------
test('draft_expedition: one card in the orchestrator\'s thread; Launch closes it; Dismiss closes it; a closed draft cannot launch', async () => {
  const env = world();
  const { rt, call } = tools(env, env.orch);
  assert.ok(rt.draft_expedition && cruxToolNames(env.orch).includes('mcp__crux__draft_expedition'));
  const said = await call('draft_expedition', { question: Q });
  assert.match(said, /^Drafted: the card is in your thread with Launch and Edit\. Tell the user it is there, and stop/);
  const withTest = await call('draft_expedition', { question: 'Is B smaller?', brief: 'Size only.', test_files: [{ name: 'CHECKLIST.md', content: '1. a table (read)\n' }], hours: 2, percent: 3, gatherers: 2, sites: [{ host: 'docs.example-lib.org' }], packages: [{ eco: 'npm', name: 'zod', baseMajor: 3 }] });
  assert.match(withTest, /^Drafted/);
  const drafts = env.view().drafts;
  assert.equal(drafts.length, 2);
  assert.deepEqual([drafts[0].question, drafts[0].brief, drafts[0].test, drafts[0].from], [Q, Q, {}, env.orch.name]);
  assert.deepEqual([drafts[1].brief, drafts[1].test, drafts[1].envelope, drafts[1].gatherers, drafts[1].preApprovals.packages[0].baseMajor], ['Size only.', { 'CHECKLIST.md': '1. a table (read)\n' }, { hours: 2, percent: 3 }, 2, 3], 'Edit can read the test back as the same files');
  const ev = env.p.log.ofType('expedition_draft');
  assert.deepEqual(ev.map(e => [e.thread, e.from]), [['orchestrator', env.orch.name], ['orchestrator', env.orch.name]]);
  // An orchestrator never starts the Lead: it has no start for it and the hub refuses it.
  assert.throws(() => env.hub.startWorker(env.p, 'x', 't', env.orch.name, 'g', { expedition: 'nope', expeditionRole: 'lead' }), /Not an expedition agent/);
  // A draft that could never launch is refused to the orchestrator, and logs nothing.
  const n = env.p.log.events.length;
  assert.match(await call('draft_expedition', { question: Q, packages: [{ eco: 'npm', name: 'Bad Name' }] }), /^Not drafted: Pre-approved package/);
  assert.match(await call('draft_expedition', { question: Q, test_files: [{ name: 'run.json', content: 'oops' }] }), /^Not drafted: run\.json is not valid JSON/);
  assert.equal(env.p.log.events.length, n);
  // Launch from the card.
  const d = drafts[0];
  const r = env.hub.launchExpedition(env.p, { draft: d.id, question: d.question, brief: d.brief, test: d.test });
  assert.deepEqual(env.p.log.ofType('expedition_draft_closed').map(e => [e.draft, e.status, e.expedition]), [[d.id, 'launched', r.id]]);
  assert.deepEqual(env.view().drafts.map(x => x.id), [drafts[1].id], 'the launched one leaves the list');
  // Dismiss the other; then it cannot be launched.
  assert.deepEqual(env.hub.dismissExpeditionDraft(env.p, drafts[1].id), { ok: true });
  assert.deepEqual(env.hub.dismissExpeditionDraft(env.p, drafts[1].id), { ok: true }, 'twice is fine');
  assert.deepEqual(env.view().drafts, []);
  env.hub.stopExpedition(env.p); await env.hub.expeditionWatch.settled();
  env.hub.finishRetire(env.p, env.p.agents.get(r.lead));
  env.p.log.append('expedition_step', { expedition: r.id, step: 'summary' });   // ended: another may launch
  assert.throws(() => env.hub.launchExpedition(env.p, { draft: drafts[1].id, question: 'Is B smaller?' }), /already launched or dismissed/);
  assert.throws(() => env.hub.launchExpedition(env.p, { draft: 'nope', question: 'x' }), /no longer here/);
  assert.throws(() => env.hub.dismissExpeditionDraft(env.p, 'nope'), /no longer here/);
});

test('a plain worker has no draft tool, and the Lead has the report-ready tool only', () => {
  const env = world();
  const w = env.hub.startWorker(env.p, 'plain', 'Build', 'you', 'x');
  assert.equal(tools(env, w).rt.draft_expedition, undefined);
  const r = env.hub.launchExpedition(env.p, { question: Q });
  const lead = env.p.agents.get(r.lead);
  assert.equal(tools(env, lead).rt.draft_expedition, undefined, 'the Lead does not draft');
  assert.ok(tools(env, lead).rt.expedition_report_ready && cruxToolNames(lead).includes('mcp__crux__expedition_report_ready'));
  assert.equal(tools(env, env.orch).rt.expedition_report_ready, undefined);
});

test('expedition_report_ready: only after a stop, only with a report, recorded once', async () => {
  const env = world();
  const r = env.hub.launchExpedition(env.p, { question: Q });
  const ex = env.hub.expeditionOf(env.p, r.id), { call } = tools(env, env.p.agents.get(r.lead));
  assert.match(await call('expedition_report_ready', {}), /^Not recorded: The expedition is planning: the end starts after it has stopped/);
  ex.stop({ reason: 'passed', totals: {} });
  assert.match(await call('expedition_report_ready', {}), /^Not recorded: REPORT\.md is not there yet/);
  ex.write('REPORT.md', '# R\n');
  assert.match(await call('expedition_report_ready', {}), /^Recorded\. End your turn now/);
  await call('expedition_report_ready', {});
  assert.equal(env.p.log.ofType('expedition_note').filter(e => e.kind === 'report-ready').length, 1);
  assert.equal(ex.state().reserveNote, null, 'the end\'s notes are not the 90% note');
  assert.equal(env.hub.expeditionWatch.trackOf(env.p, r.id).reserve, null, 'nor does the watchdog read them as it');
});

// ---------- proposed next expeditions ----------
test('parked items become proposed next expeditions with a brief each; Launch from one removes it from the list', async () => {
  const env = world();
  const se = new StubExpedition(env);
  se.run();   // through the card step
  env.hub.postSummary(env.p, se.agents.lead, summary({ done: ['x'] }));
  for (const a of [...env.p.agents.values()]) if (a.expedition === se.id) env.hub.finishRetire(env.p, a);
  const props = env.view().proposals;
  assert.equal(props.length, 1, 'the refused request and the held lesson are not proposals');
  assert.deepEqual([props[0].expedition, props[0].text, props[0].reason], [se.id, 'Compare a third library', 'outside the brief']);
  assert.match(props[0].brief, /^Follow-up to expedition .*\n\nQuestion: Compare a third library\n\nWhy it was parked there: outside the brief/);
  assert.equal(env.view().current, null);
  assert.equal(env.view().past[0].id, se.id);
  assert.throws(() => env.hub.launchExpedition(env.p, { question: 'x', proposal: { expedition: se.id, parked: 'nope' } }), /proposed expedition is no longer here/);
  const r = env.hub.launchExpedition(env.p, { question: props[0].question, brief: props[0].brief, proposal: { expedition: se.id, parked: props[0].id } });
  assert.deepEqual(env.hub.expeditionOf(env.p, r.id).state().started.origin, { expedition: se.id, parked: props[0].id });
  assert.deepEqual(env.view().proposals, [], 'launched: it leaves the list');
});

test('M049 1: the Conductor still lists an ended expedition while one of its agents lives, and stops when the last has retired', () => {
  const env = world({ conductor: true });
  const se = new StubExpedition(env);
  se.run();
  env.hub.postSummary(env.p, se.agents.lead, summary({ done: ['x'] }));
  const listed = () => env.hub.conductor.agents(env.p).filter(a => a.role === 'expedition').map(a => [a.name, a.state]);
  assert.deepEqual(listed(), [[`expedition ${se.id}`, 'retiring']]);
  env.hub.finishRetire(env.p, se.agents.lead);
  assert.deepEqual(listed(), []);
});

// ---------- M049 7: the role folders under .crux ----------
test('M049 7: an expedition agent writes its own outputs under its expedition folder (verify/run-N/, notes, synthesis); the rest of .crux, BRIEF.md and other expeditions stay stops', async () => {
  const env = world();
  const se = new StubExpedition(env);
  se.run({ stop: false });
  const { p, hub } = env, root = se.ex.root;
  const ask = (agent, file) => hub.requestApproval(p, agent, 'Write', { file_path: file, content: 'x' });
  for (const [role, f] of [['verifier', join(root, 'verify', 'run-1', 'out.txt')], ['verifier', join(root, 'verify', 'VERDICT.md')], ['builder', join(root, 'notes-9.md')], ['synthesizer', join(root, 'synthesis.md')], ['lead', join(root, 'REPORT.md')]]) {
    assert.equal((await ask(se.agents[role], f)).behavior, 'allow', `${role}: ${f}`);
  }
  for (const f of [join(p.dir, '.crux', 'events.jsonl'), join(p.dir, '.crux', 'expeditions', 'other-expedition', 'notes-1.md'), join(root, 'BRIEF.md'), join(p.dir, '.crux', 'expeditions', '.frozen', se.id, 'CHECKLIST.md')]) {
    assert.equal((await ask(se.agents.verifier, f)).behavior, 'deny', f);
  }
  // At classify level: the folder is an option only for the asking agent's own expedition, and only when the hub passes it.
  const input = { file_path: join(root, 'verify', 'run-1', 'x.txt'), content: 'x' };
  assert.equal(classify({ tool: 'Write', input, projectDir: p.dir, expeditionRoot: root }).route, 'allow');
  assert.equal(classify({ tool: 'Write', input, projectDir: p.dir }).route, 'human', 'a plain agent still stops at the hub\'s own folder');
  assert.equal(classify({ tool: 'Write', input, projectDir: p.dir, expeditionRoot: join(p.dir, '.crux', 'expeditions', 'someone-else') }).route, 'human');
  assert.equal(classify({ tool: 'Write', input: { file_path: join(root, '..', 'x.txt'), content: 'x' }, projectDir: p.dir, expeditionRoot: root }).route, 'human');
  assert.equal(classify({ tool: 'Bash', input: { command: `echo hi > "${join(root, 'verify', 'run-1', 'o.txt').replace(/\\/g, '/')}"` }, projectDir: p.dir, expeditionRoot: root }).route, 'allow', 'a plain shell redirect there too');
});

// ---------- M049 8: package baselines from the launch panel ----------
test('M049 8: a pre-approved package\'s baseline version may come as numbers, numeric strings or the version seen; a bad one is refused before anything is written', () => {
  const env = world();
  const r = env.hub.launchExpedition(env.p, { question: Q, preApprovals: { packages: [{ eco: 'npm', name: 'zod', baseMajor: '3', baseMinor: '22' }, { eco: 'pip', name: 'Some_Pkg', version: '4.2.1' }, { eco: 'npm', name: 'left-pad' }, { eco: 'npm', name: 'abc', baseMajor: 'x' }] } });
  assert.deepEqual(env.hub.expeditionOf(env.p, r.id).state().started.preApprovals.packages.map(x => [x.name, x.baseMajor, x.baseMinor]), [['zod', 3, 22], ['some-pkg', 4, 2], ['left-pad', null, null], ['abc', null, null]]);
});

// ---------- the write guard (decision 48) ----------
test('a launch needs the step-up only when it pre-approves sites or packages (in the body, or in the draft its Launch sends)', async () => {
  const env = world();
  assert.equal(stepUpNeed('POST /api/expedition', { project: 'proj', question: Q }, env.hub), null);
  assert.equal(stepUpNeed('POST /api/expedition', { project: 'proj', question: Q, preApprovals: { sites: [], packages: [] } }, env.hub), null);
  const need = stepUpNeed('POST /api/expedition', { project: 'proj', question: Q, preApprovals: { sites: [{ host: 'docs.example-lib.org' }] } }, env.hub);
  assert.deepEqual([need.purpose, need.scope], ['lists', 'lists;expedition;proj']);
  const { call } = tools(env, env.orch);
  await call('draft_expedition', { question: Q, packages: [{ eco: 'npm', name: 'zod' }] });
  await call('draft_expedition', { question: 'Plain?' });
  const [withPre, plain] = env.view().drafts;
  assert.equal(stepUpNeed('POST /api/expedition', { project: 'proj', draft: withPre.id }, env.hub).purpose, 'lists');
  assert.equal(stepUpNeed('POST /api/expedition', { project: 'proj', draft: plain.id }, env.hub), null);
  assert.equal(stepUpNeed('POST /api/expedition/stop', { project: 'proj' }, env.hub), null, 'Stop is never held back');
  assert.equal(stepUpNeed('POST /api/expedition/dismiss', { project: 'proj', draft: plain.id }, env.hub), null);
});
