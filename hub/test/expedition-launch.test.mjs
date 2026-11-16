// The Expedition module, phase 5 front end: the launch panel's logic and the two thread cards (public/expedition-launch.js,
// public/expedition-cards.js). Plain functions, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startDraft, problems, launchBody, testItems, testFiles, teamTotals, estimateUSD, panelHtml, GATHERER_LIMIT, ROLE_LIST } from '../public/expedition-launch.js';
import { draftCard, finishedCard, draftBody, draftSeed, proposalSeed, closedOf, endProgress } from '../public/expedition-cards.js';
import { family, hueOf, modelLabel, pips } from '../public/models.js';

const ST = { defaults: { envelope: { hours: 6, percent: 7 }, dollarsPerPercent: 2.7, gatherers: 3, roles: { verifier: { model: 'claude-opus-5-5', effort: 'high' }, builder: { model: 'claude-sonnet-5-5', effort: 'medium' }, lead: { model: 'claude-opus-5-5', effort: 'medium' } } }, launch: { ok: true }, budgetNote: '' };
const ctx = (o = {}) => ({ level: 'auto', check: 'on', st: ST, family, ...o });
const ready = () => { const d = startDraft(ST, { question: 'Which is faster?' }); d.success.push({ text: 'Both parse the sample', judge: 'checklist', command: '' }); d.sites.push({ host: 'docs.example.org', access: 'pages' }); return d; };
const h = { family, hueOf, modelLabel, pips, modelPicker: () => '', effortPicker: () => '' };

test('the draft starts from the hub defaults: 6 h, 7%, 3 gatherers, seven roles', () => {
  const d = startDraft(ST);
  assert.equal(d.hours, 6); assert.equal(d.percent, 7); assert.equal(d.gatherers, 3);
  assert.deepEqual(Object.keys(d.roles), ROLE_LIST.map(r => r.key));
  assert.equal(d.roles.verifier.model, 'claude-opus-5-5');
  assert.equal(d.roles.gatherer.model, 'haiku', 'a role the hub did not send falls back to the built-in');
  assert.equal(startDraft(ST, { gatherers: 9 }).gatherers, GATHERER_LIMIT, 'the limit is fixed at 4');
  assert.equal(startDraft(ST, { gatherers: 0 }).gatherers, 1);
});

test('agents at most: the six hub roles plus up to N gatherers, split by model', () => {
  const t = teamTotals(startDraft(null), family);
  assert.equal(t.total, 9, 'three gatherers: the mockup\'s nine');
  assert.deepEqual(t.by, { opus: 3, fable: 1, haiku: 3, sonnet: 2 });
});

test('Launch is blocked, with a reason, for each refusal the hub makes; warnings never block', () => {
  assert.deepEqual(problems(ready(), ctx()).filter(p => p.level === 'block'), []);
  const ids = (d, c) => problems(d, c).filter(p => p.level === 'block').map(p => p.id);
  assert.ok(ids(ready(), ctx({ level: 'standard' })).includes('ask'));
  assert.ok(ids(ready(), ctx({ running: true })).includes('running'));
  const empty = startDraft(ST);
  assert.deepEqual(ids(empty, ctx()), ['question'], 'the question alone is enough to start: no test, sites or packages needed');
  const one = startDraft(ST, { question: 'Q?' });
  assert.deepEqual(ids(one, ctx()), [], 'nothing else blocks');
  const same = ready(); same.roles.verifier.model = same.roles.builder.model;
  assert.ok(ids(same, ctx()).includes('same'), 'Verifier on the Builder\'s model');
  const noFig = { ...ST, defaults: { ...ST.defaults, dollarsPerPercent: null }, budgetNote: 'Held by time only.' };
  assert.equal(problems(ready(), ctx({ st: noFig })).some(p => p.id === 'dollars'), false, 'a default launch is not nagged about the dollar figure');
  const touched = ready(); touched.touched = true;
  const warn = problems(touched, ctx({ check: 'off', st: noFig }));
  assert.deepEqual(warn.filter(p => p.level === 'block'), []);
  assert.ok(warn.some(p => p.id === 'check') && warn.some(p => p.id === 'dollars' && p.text === 'Held by time only.'));
  assert.ok(ids(ready(), ctx({ st: { ...ST, launch: { ok: false, reason: 'Nope.' } } })).includes('hub'), 'the hub\'s own reason shows');
  assert.ok(problems({ ...ready(), sites: [] }, ctx()).some(p => p.id === 'web'), 'at Auto, gatherers need named sites');
});

test('the success test round-trips through the files the hub wants: CHECKLIST.md and run.json', () => {
  const items = [{ text: 'A table compares speed', judge: 'checklist', command: '' }, { text: 'Speed on our hardware', judge: 'outside', command: '' }, { text: 'Parse time is measured', judge: 'command', command: 'node bench.mjs' }, { text: '  ', judge: 'checklist', command: '' }];
  const files = testFiles(items);
  assert.match(files['CHECKLIST.md'], /^1\. A table compares speed\n2\. Speed on our hardware \(not run here/);
  assert.deepEqual(JSON.parse(files['run.json']).checks, [{ name: 'Parse time is measured', command: 'node bench.mjs' }]);
  assert.deepEqual(testItems(files).map(t => [t.text, t.judge, t.command]), [['A table compares speed', 'checklist', ''], ['Speed on our hardware', 'outside', ''], ['Parse time is measured', 'command', 'node bench.mjs']]);
  assert.deepEqual(testFiles([{ text: 'only', judge: 'checklist', command: '' }]), { 'CHECKLIST.md': '1. only\n' }, 'no run.json without a command item');
  assert.deepEqual(testItems({}), []);
});

test('launchBody matches the hub\'s route: brief, question, test files, envelope with a dollar cap, roles, pre-approvals', () => {
  const d = ready(); d.success.push({ text: 'Fast enough', judge: 'command', command: 'npm test' }); d.packages.push({ eco: 'npm', name: 'fastjson-demo' }); d.gatherers = 4;
  const b = launchBody('demo-app', d, ST);
  assert.equal(b.project, 'demo-app');
  assert.equal(b.brief, 'Which is faster?', 'the brief is the question alone');
  const bare = launchBody('p', startDraft(ST, { question: 'Q?' }), ST);
  assert.equal('test' in bare, false, 'no items written: only the question goes, the team writes the test while it plans');
  assert.equal(bare.brief, 'Q?');
  assert.deepEqual(bare.preApprovals, { sites: [], packages: [] });
  assert.equal(b.question, 'Which is faster?');
  assert.deepEqual(Object.keys(b.test).sort(), ['CHECKLIST.md', 'run.json']);
  assert.deepEqual(b.envelope, { hours: 6, percent: 7, dollars: 18.9 });
  assert.equal(b.gatherers, 4);
  assert.deepEqual(Object.keys(b.roles), ROLE_LIST.map(r => r.key));
  assert.deepEqual(b.preApprovals, { sites: [{ host: 'docs.example.org', access: 'pages' }], packages: [{ eco: 'npm', name: 'fastjson-demo' }] });
  assert.equal('dollars' in launchBody('p', d, { defaults: {} }).envelope, false, 'no figure, no dollar cap sent');
  assert.equal(estimateUSD(7, ST), 18.9);
});

test('the panel draws the seven roles, the stepper, the envelope, the fixed line, and nothing red or a slider', () => {
  const html = panelHtml(ready(), ctx({ project: 'demo-app' }), h);
  for (const r of ROLE_LIST) assert.ok(html.includes(`data-role="${r.key}"`), r.key);
  assert.match(html, /9 agents at most/);
  assert.match(html, /Ends at one branch and a draft PR\. It never merges\./);
  assert.match(html, /data-xp-step="1"/);
  assert.doesNotMatch(html, /type="range"|<emoji|#f2727a|var\(--hud-red\)/);
  assert.match(html, /data-xp-cancel/, 'a way out that acts on nothing');
});

test('Launch is disabled in the panel while the question is empty, with the reason as its hover text', () => {
  const html = panelHtml(startDraft(ST), ctx({ project: 'p' }), h);
  assert.match(html, /data-xp-go disabled title="[^"]*Write the question first/);
  assert.doesNotMatch(panelHtml(ready(), ctx({ project: 'p' }), h), /data-xp-go disabled/);
});

const DRAFT = { id: 'd1', type: 'expedition_draft', thread: 'orchestrator', question: 'Which of two libraries is faster <b>?', brief: '# Question', test: { 'CHECKLIST.md': '1. a\n2. b\n3. c (not run here: x)\n', 'run.json': JSON.stringify({ checks: [{ name: 'n', command: 'c' }] }) }, envelope: { hours: 6, percent: 7 }, roles: {}, gatherers: 3, preApprovals: { sites: [{ host: 'a.org' }], packages: [] } };

test('the draft card: brief, test count, envelope, team strip, Launch / Edit; closed states have neither button', () => {
  const open = draftCard(DRAFT, null, ST);
  assert.match(open, /Which of two libraries is faster &lt;b&gt;\?/, 'escaped');
  assert.match(open, /4 success test items/); assert.match(open, /6 h/); assert.match(open, /about \$19 of the week/); assert.match(open, /default · 9 agents at most/);
  assert.match(open, /data-xdraft-launch="d1"/); assert.match(open, /data-xdraft-edit="d1"/); assert.match(open, /data-xdraft-dismiss="d1"/);
  const done = draftCard(DRAFT, { status: 'launched' }, ST);
  assert.doesNotMatch(done, /data-xdraft-launch|data-xdraft-edit/);
  assert.match(done, /Launched/);
  assert.match(draftCard(DRAFT, { status: 'dismissed' }, ST), /Nothing started/);
  assert.equal(closedOf([{ type: 'expedition_draft_closed', draft: 'd1', status: 'dismissed' }], 'd1').status, 'dismissed');
  assert.equal(closedOf([], 'd1'), null);
});

test('a draft\'s Launch sends the draft as written with its id; Edit and a proposal seed the panel', () => {
  const b = draftBody('demo-app', DRAFT);
  assert.equal(b.draft, 'd1'); assert.equal(b.brief, '# Question'); assert.equal(b.project, 'demo-app');
  const d = startDraft(ST, draftSeed(DRAFT));
  assert.equal(d.question, DRAFT.question); assert.equal(d.success.length, 4); assert.equal(d.sites[0].host, 'a.org');
  const s = proposalSeed({ id: 'p1', expedition: 'E', question: 'Q?', brief: 'B' });
  assert.deepEqual(s.proposal, { expedition: 'E', parked: 'p1' });
  const pd = startDraft(ST, proposalSeed({ id: 'p1', expedition: 'E', question: 'Q?', reason: 'Parked: outside the brief' }));
  assert.match(panelHtml(pd, ctx({ project: 'p' }), h), /class="xp-reason">Parked: outside the brief/, 'the reason shows quietly under the box');
  assert.equal('reason' in launchBody('p', pd, ST), false, 'and is never sent');
});

test('the finished card: answer, stop reason, counts, PR link, amber marks for unchecked claims and a problem, Launch per proposal', () => {
  const ev = { type: 'expedition_finished', expedition: 'E', title: 'It is faster', answer: 'It is faster', stopReason: 'passed', loops: 2, passing: 17, decisions: 9, parked: 3, lessons: 0, claimsChecked: false, branch: 'expedition/E', pr: { url: 'https://github.com/x/y/pull/1', number: 1, draft: true }, pushed: true, problem: 'The PR was not opened.', reportPath: '.crux/expeditions/E/REPORT.md' };
  const html = finishedCard(ev, [{ id: 'p1', expedition: 'E', question: 'Next?' }]);
  assert.match(html, /The test passed/); assert.match(html, /17 passing/); assert.match(html, /Draft PR #1/); assert.match(html, /rel="noopener"/);
  assert.equal((html.match(/class="xc-warn"/g) || []).length, 2, 'claims not checked and the problem, each behind an amber mark');
  assert.match(html, /Claims not checked/);
  assert.match(html, /<h3 class="xc-answer">It is faster<\/h3>/);
  const dup = finishedCard({ ...ev, title: 'Expedition finished: It is faster', answer: 'A longer answer text' }, []);
  assert.match(dup, /<h3 class="xc-answer">It is faster<\/h3>/, 'the prefix is stripped');
  assert.doesNotMatch(dup, /A longer answer text/, 'the answer is shown once');
  assert.match(html, /data-xprop-launch="p1"/);
  assert.doesNotMatch(finishedCard({ ...ev, claimsChecked: true, problem: null }, []), /xc-warn|xc-next/);
  assert.match(finishedCard({ ...ev, stopReason: 'Matt' }, []), /You stopped it/);
});

test('the cluster carries the end-progress line while the end runs, and no Stop-worthy line before', async () => {
  const { expeditionCluster, clusterCaption } = await import('../public/expedition-map.js');
  const T = Date.parse('2026-11-16T08:00:00Z'), at = ms => new Date(T + ms).toISOString();
  const ID = '20261116-json-bench';
  const ev = (...x) => x.map((e, i) => ({ id: `e${i}`, ts: at(0), expedition: ID, ...e }));
  const base = [{ type: 'expedition_started', envelope: { hours: 6 } }, { type: 'expedition_stopped', reason: 'Matt', ts: at(3600e3) }];
  const p = events => ({ agents: [], events: ev(...events) });
  assert.equal(expeditionCluster(p(base), T + 4000e3).ending, '');
  const c = expeditionCluster(p([...base, { type: 'expedition_step', step: 'report' }]), T + 4000e3);
  assert.equal(c.ending, 'ending: committing it (1 of 6 done)');
  assert.match(clusterCaption(c).line, /ending: committing it/);
});

test('the end-progress line follows the logged steps', () => {
  const evs = [{ type: 'expedition_step', expedition: 'E', step: 'report' }, { type: 'expedition_step', expedition: 'E', step: 'commit' }];
  assert.equal(endProgress(evs, 'E'), 'ending: pushing the branch (2 of 6 done)');
  assert.equal(endProgress([], 'E'), '');
});
