// A fresh install runs an expedition with no manual steps (M053): the hub adds the missing expedition agent files into
// ~/.claude/agents, and on the API-key route the launch panel takes a dollar limit. Folders here are temp folders standing in
// for ~/.claude/agents and ~/crux/hub.json; the real ones are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp } from './helpers/tmp.mjs';
import { recordAgents, stubHub } from './helpers/expedition-stub.mjs';
import { addMissingExpeditionFiles, refreshExpeditionFiles } from '../lib/starter-refresh.mjs';
import { saveDollarCap, readHubConfig } from '../lib/setup.mjs';
import { startDraft, problems, launchBody, panelHtml, typedDollars, dollarsProblem, capUSD } from '../public/expedition-launch.js';
import { family, hueOf, modelLabel, pips } from '../public/models.js';

recordAgents();
const HERE = dirname(fileURLToPath(import.meta.url));
const STARTER = join(HERE, '..', '..', 'agent-types', 'starter');
const fakeStarter = root => {
  const s = join(root, 'starter'); mkdirSync(s, { recursive: true });
  for (const n of ['lead', 'builder', 'skeptic']) writeFileSync(join(s, `expedition-${n}.md`), `NEW ${n}\n`);
  writeFileSync(join(s, 'previous-hashes.json'), '{}');   // not an expedition-*.md: never copied
  return s;
};

// ---------- the files ----------
test('a fresh agents folder gets every expedition file, created if needed, with one plain log line', () => {
  const root = makeTmp('crux-setup-'), dir = join(root, 'home', '.claude', 'agents'), lines = [];
  const r = addMissingExpeditionFiles(dir, { starter: fakeStarter(root), log: l => lines.push(l) });
  assert.deepEqual(r.added.sort(), ['expedition-builder.md', 'expedition-lead.md', 'expedition-skeptic.md']);
  assert.equal(r.failed, null);
  assert.deepEqual(readdirSync(dir).sort(), r.added.sort(), 'only expedition-*.md files are added');
  assert.equal(readFileSync(join(dir, 'expedition-lead.md'), 'utf8'), 'NEW lead\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Added 3 missing expedition agent file\(s\) to .*agents: expedition-builder\.md, expedition-lead\.md, expedition-skeptic\.md\.$/);
});

test('a copy that is already there is never overwritten (edited or not), only the missing ones are added; a second run does nothing', () => {
  const root = makeTmp('crux-setup-'), dir = join(root, 'agents'), lines = [];
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'expedition-lead.md'), 'my own edited lead\n');
  writeFileSync(join(dir, 'expedition-builder.md'), 'OLD builder\n');
  const starter = fakeStarter(root);
  const r = addMissingExpeditionFiles(dir, { starter, log: l => lines.push(l) });
  assert.deepEqual(r.added, ['expedition-skeptic.md']);
  assert.equal(readFileSync(join(dir, 'expedition-lead.md'), 'utf8'), 'my own edited lead\n');
  assert.equal(readFileSync(join(dir, 'expedition-builder.md'), 'utf8'), 'OLD builder\n', 'adding never replaces; the refresh does that, and only for unedited older copies');
  assert.equal(lines.length, 1);
  const again = addMissingExpeditionFiles(dir, { starter, log: l => lines.push(l) });
  assert.deepEqual(again.added, []);
  assert.equal(lines.length, 1, 'nothing added, nothing said');
  // The refresh beside it still never adds.
  const empty = join(root, 'empty'); mkdirSync(empty);
  assert.deepEqual(refreshExpeditionFiles([empty], { starter, log: () => { } }).refreshed, []);
  assert.deepEqual(readdirSync(empty), []);
});

test('a folder that cannot be written is reported in one plain line and does not throw', () => {
  const root = makeTmp('crux-setup-'), blocker = join(root, 'agents-is-a-file'), lines = [];
  writeFileSync(blocker, 'a file where the folder should be');
  const r = addMissingExpeditionFiles(join(blocker, 'nested'), { starter: fakeStarter(root), log: l => lines.push(l) });
  assert.deepEqual(r.added, []);
  assert.ok(r.failed);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Could not add the expedition agent files to .*nested: .*Copy them from agent-types\/starter by hand\.$/);
});

test('the real starter folder: the seven expedition files all go in', () => {
  const dir = join(makeTmp('crux-setup-'), 'agents');
  const r = addMissingExpeditionFiles(dir, { log: () => { } });
  assert.equal(r.added.length, 7);
  for (const f of r.added) assert.equal(readFileSync(join(dir, f), 'utf8'), readFileSync(join(STARTER, f), 'utf8'));
});

test('the installer stages agent-types/starter beside the hub, so the installed app has the files to add', () => {
  const src = readFileSync(join(HERE, '..', '..', 'app', 'scripts', 'stage.mjs'), 'utf8');
  assert.match(src, /'--', 'hub', 'crux', 'agent-types\/starter'/);
  assert.ok(!/SKIP = \[[^\]]*agent-types/.test(src), 'and does not skip it');
});

test('a launch refused for missing files says where they should be and that the hub could not add them', () => {
  const env = stubHub({ level: 'auto' }), root = makeTmp('crux-setup-');
  env.hub.agentHome = join(root, 'no-agents-here');
  const reason = env.hub.launchBlock(env.p);
  assert.match(reason, /^The agent type expedition-lead is not set up: it is not in .*no-agents-here.*\.claude.*agents, and the hub could not add it there when it started/);
  assert.match(reason, /may not be writable\)\. Copy the expedition-\*\.md files from agent-types\/starter into that folder/);
});

// ---------- the dollar limit ----------
const ST = (o = {}) => ({ defaults: { envelope: { hours: 6, percent: 7 }, dollarsPerPercent: null, dollars: null, meterGuard: false, gatherers: 3, roles: {}, ...o }, launch: { ok: true }, budgetNote: '' });
const ctx = (st, o = {}) => ({ level: 'auto', check: 'on', st, family, ...o });
const ids = (d, c) => problems(d, c).filter(p => p.level === 'block').map(p => p.id);
const h = { family, hueOf, modelLabel, pips, modelPicker: () => '', effortPicker: () => '' };

test('typedDollars reads a plain figure and refuses anything that is not a number above 0', () => {
  assert.equal(typedDollars('12'), 12);
  assert.equal(typedDollars('$12.505'), 12.51);
  assert.equal(typedDollars(' 500 '), 500);
  for (const bad of ['', '  ', '0', '-3', 'abc', null, undefined, '1e999999', '1,5', '1,200', '501', '$500.01', '12 dollars']) assert.equal(typedDollars(bad), null, String(bad));
  assert.match(dollarsProblem('1,5'), /plain number above 0/, 'a comma is refused, not read as 15');
  assert.equal(dollarsProblem('501'), 'The dollar limit for one run is at most $500.');
  assert.equal(dollarsProblem('500'), null);
});

test('under an API key with no cap Launch waits for a dollar limit; typing one lets it through and it goes in the envelope', () => {
  const st = ST(), d = startDraft(st, { question: 'Which is faster?' });
  assert.deepEqual(ids(d, ctx(st)), ['cap']);
  assert.equal(problems(d, ctx(st)).find(p => p.id === 'cap').short, 'Type a dollar limit to launch.');
  d.dollars = 'twelve';
  assert.deepEqual(ids(d, ctx(st)), ['badcap']);
  d.dollars = '1,5';
  assert.deepEqual(ids(d, ctx(st)), ['badcap'], 'a comma is refused, never read as 15');
  d.dollars = '501';
  assert.equal(problems(d, ctx(st)).find(p => p.id === 'badcap').short, 'The dollar limit for one run is at most $500.');
  d.dollars = '12';
  assert.deepEqual(ids(d, ctx(st)), []);
  const b = launchBody('demo', d, st);
  assert.equal(b.envelope.dollars, 12);
  assert.equal(b.rememberDollars, true, 'Keep as default starts ticked on the API-key route');
  d.remember = false;
  assert.equal('rememberDollars' in launchBody('demo', d, st), false, 'unticked: this run only');
  // With the plan meters (a plan login) it starts unticked, so nothing is saved unless the user ticks it.
  const plan = ST({ meterGuard: true }), dp = startDraft(plan, { question: 'Q?' });
  dp.dollars = '12';
  assert.equal(dp.remember, false);
  assert.equal('rememberDollars' in launchBody('demo', dp, plan), false);
});

test('with the plan meters the field is optional and never blocks; with a confirmed figure it is not shown and the figure wins', () => {
  const plan = ST({ meterGuard: true }), d = startDraft(plan, { question: 'Q?' });
  assert.deepEqual(ids(d, ctx(plan)), []);
  assert.equal('dollars' in launchBody('demo', d, plan).envelope, false, 'no figure typed, no dollar cap invented');
  assert.match(panelHtml(d, ctx(plan), h), /data-xp-dollars[^>]*placeholder="limit \(optional\)"/);
  const api = ST();
  assert.match(panelHtml(startDraft(api, { question: 'Q?' }), ctx(api), h), /data-xp-dollars[^>]*placeholder="limit"/);
  const fig = ST({ dollarsPerPercent: 2.7, meterGuard: true }), df = startDraft(fig, { question: 'Q?' });
  df.dollars = '999';
  assert.doesNotMatch(panelHtml(df, ctx(fig), h), /data-xp-dollars/);
  assert.equal(launchBody('demo', df, fig).envelope.dollars, 18.9, '7% at 2.7 per 1%');
  assert.equal('rememberDollars' in launchBody('demo', df, fig), false);
  assert.equal(capUSD(df, fig), 18.9);
});

test('a kept default comes pre-filled in the field, so the user only presses Launch', () => {
  const st = ST({ dollars: 25 }), d = startDraft(st, { question: 'Q?' });
  assert.equal(d.dollars, '25');
  assert.deepEqual(ids(d, ctx(st)), []);
  assert.equal(launchBody('demo', d, st).envelope.dollars, 25);
  assert.equal(startDraft(st, { question: 'Q?', envelope: { dollars: 8 } }).dollars, '8', 'a draft card\'s own figure wins');
});

test('the refusal for Ask is said in plain words beside Launch, and follows the project level', () => {
  const st = ST({ meterGuard: true }), d = startDraft(st, { question: 'Q?' });
  const html = panelHtml(d, ctx(st, { level: 'standard' }), h);
  assert.match(html, /<p class="xp-why" role="status">This project is at Ask\. Raise it to Auto on the project card to launch\.<\/p>/);
  assert.match(html, /data-xp-go disabled/);
  assert.doesNotMatch(panelHtml(d, ctx(st), h), /xp-why/);
});

// ---------- the hub side of the dollar limit ----------
test('saveDollarCap keeps the rest of hub.json and refuses a figure that is not above 0', () => {
  const file = join(makeTmp('crux-setup-'), 'crux', 'hub.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ projects: ['C:/a'], defaults: { expedition: { gatherers: 2, envelope: { hours: 12 } }, worker: { model: 'sonnet' } } }));
  assert.equal(saveDollarCap('15.5', file), 15.5);
  assert.deepEqual(readHubConfig(file), { projects: ['C:/a'], defaults: { expedition: { gatherers: 2, envelope: { hours: 12, dollars: 15.5 } }, worker: { model: 'sonnet' } } });
  for (const bad of [0, -1, 'x', null]) assert.throws(() => saveDollarCap(bad, file), /number above 0/);
  const fresh = join(dirname(file), 'new', 'hub.json');
  saveDollarCap(7, fresh);
  assert.deepEqual(readHubConfig(fresh), { defaults: { expedition: { envelope: { dollars: 7 } } } });
  assert.ok(existsSync(fresh));
  for (const bad of ['1,5', '500.01', '501']) assert.throws(() => saveDollarCap(bad, fresh), /plain number above 0|at most \$500/, bad);
  assert.equal(saveDollarCap(500, fresh), 500);
});

test('a hub.json that cannot be read is never rewritten: Keep as default refuses and the file is untouched', () => {
  const dir = makeTmp('crux-setup-'), file = join(dir, 'hub.json');
  const broken = '{ "projects": ["C:/a", "C:/b"], "defaults": { oops ';
  writeFileSync(file, broken);
  assert.throws(() => saveDollarCap(10, file), /hub\.json could not be read.*dollar limit was not saved/);
  assert.equal(readFileSync(file, 'utf8'), broken);
  writeFileSync(file, '[1,2]');
  assert.throws(() => saveDollarCap(10, file), /is not a JSON object/);
  assert.equal(readFileSync(file, 'utf8'), '[1,2]');
  writeFileSync(file, '');
  assert.equal(saveDollarCap(10, file), 10, 'an empty file holds nothing to lose');
});

test('the hub refuses a figure above $500 or one that is not a plain number, before anything is written; cents are kept', () => {
  const env = stubHub({ level: 'auto' }), { hub, p } = env, before = p.log.events.length;
  for (const [dollars, why] of [[501, /at most \$500/], ['1,5', /plain number above 0/], ['abc', /plain number above 0/], [-4, /plain number above 0/], [0, /plain number above 0/]]) {
    assert.throws(() => hub.launchExpedition(p, { question: 'Q?', envelope: { dollars } }), why, String(dollars));
  }
  assert.equal(p.log.events.length, before, 'nothing written');
  const r = hub.launchExpedition(p, { question: 'Q?', envelope: { dollars: 12.346 } });
  assert.equal(r.dollarCap.dollars, 12.35, 'cent-rounded');
});

test('a launch with a typed limit runs under it; a remembered limit becomes the default for the next one', () => {
  const env = stubHub({ level: 'auto' }), { hub, p } = env;
  hub.usage.available = false;   // the API-key route
  assert.throws(() => hub.launchExpedition(p, { question: 'Q?' }), /Under an API key the plan meters are hidden/);
  const r = hub.launchExpedition(p, { question: 'Q?', envelope: { dollars: 12 } });
  assert.deepEqual([r.dollarCap.dollars, r.dollarCap.source, r.dollarCap.confirmed], [12, 'typed', false]);
  assert.equal(hub.state()[0].expedition.defaults.dollars, null, 'not kept: the next launch starts empty');
  hub.rememberDollarCap(12);
  const view = hub.state()[0].expedition;
  assert.equal(view.defaults.dollars, 12);
  assert.equal(view.defaults.dollarsPerPercent, null, 'still no confirmed per-percent figure');
  assert.equal(hub.dollarCap().source, 'hub.json envelope');
});
