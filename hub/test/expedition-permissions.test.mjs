// The Expedition module, phase 4 (spec 4.6): what an expedition's agents may do without asking anyone.
//  - scoped pre-approvals: the launch's sites and packages are an overlay on Matt's lists for that expedition's agents only,
//    read back from expedition_started (so it survives a restart and ends at expedition_stopped), through the same gates as his
//    own entries, and never written into his lists;
//  - the gaps the phase 2 tests left: a merge pass or a push to a protected branch never lets an expedition agent through, a
//    paused project denies with no card;
// Agents are stubbed: nothing starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTmp } from './helpers/tmp.mjs';
import { recordAgents, stubHub, StubExpedition, quietMark, quietProblems } from './helpers/expedition-stub.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { PermissionLists, normalizeOverlay, ListsError } from '../lib/permission-lists.mjs';
import { classify } from '../lib/permission-rules.mjs';
import { Expedition } from '../lib/expedition.mjs';
import { CHECK_NAME } from '../lib/permission-check.mjs';

const sent = recordAgents();
const settled = pr => Promise.race([pr, new Promise(r => setTimeout(() => r('waiting'), 30))]);
const PRE = { sites: [{ host: 'docs.example-lib.org' }], packages: [{ eco: 'npm', name: 'zod', baseMajor: 3 }] };

// An expedition (planning or running) with a Lead and a Builder, started with these pre-approvals.
function world({ pre = PRE, gate = false, level = 'auto', question = 'Which of two JSON libraries is faster' } = {}) {
  sent.length = 0;
  const env = stubHub({ level });
  const se = new StubExpedition(env, { question });
  se.ex.write('BRIEF.md', '# q\n'); se.ex.write('test/CHECKLIST.md', '1. a table\n');
  se.ex.start({ preApprovals: pre });
  se.startRole('lead', env.orch.name);
  se.startRole('builder', se.agents.lead.name);
  if (gate) se.ex.gate({ verdict: 'ok' });
  return { env, se, ex: se.ex, hub: env.hub, p: env.p, lead: se.agents.lead, builder: se.agents.builder };
}
const fetchPage = (hub, p, agent, url) => hub.requestApproval(p, agent, 'WebFetch', { url, prompt: 'read it' });

// ---------- scoped pre-approvals ----------
test('the launch\'s pre-approved site is read with no card by that expedition\'s agents only, through the same https-only gate', async () => {
  const { hub, p, lead, builder, env } = world();
  const mark = quietMark(env);
  const listsBefore = JSON.stringify(hub.lists.data);
  assert.equal((await fetchPage(hub, p, lead, 'https://docs.example-lib.org/guide')).behavior, 'allow');
  assert.equal((await fetchPage(hub, p, builder, 'https://docs.example-lib.org/guide/api')).behavior, 'allow', 'any agent of the expedition');
  assert.equal((await fetchPage(hub, p, lead, 'https://api.docs.example-lib.org/x')).behavior, 'allow', 'a subdomain, as for a site Matt adds without narrowing');
  // The same gates as his own entries: https only, a plain host, the exact site.
  for (const url of ['http://docs.example-lib.org/guide', 'https://example-lib.org/', 'https://docs.example-lib.org.evil.example/', 'https://user@docs.example-lib.org/', 'https://docs.example-lib.org:8443/', 'https://docs.example-lib.org/%2e%2e/x', 'https://other.example.org/']) {
    const r = await fetchPage(hub, p, lead, url);
    assert.equal(r.behavior, 'deny', url);
    assert.match(r.message, /^Parked, not allowed/, url);
  }
  // Not a card, not the orchestrator, and not Matt's lists.
  assert.deepEqual(quietProblems(env, mark, sent), []);
  assert.equal(JSON.stringify(hub.lists.data), listsBefore, 'his lists are untouched');
  assert.equal(hub.lists.data.sites.some(s => s.host === 'docs.example-lib.org'), false);
  const allowed = p.log.ofType('permission_answer').filter(a => a.answer === 'allow');
  assert.equal(allowed.length, 0, 'an allow by a list is not a card or an answer line: the request just runs');
});

test('the overlay is that expedition\'s alone: a plain worker, another expedition and the orchestrator\'s project lists do not get it', async () => {
  const { hub, p, env } = world();
  const other = new StubExpedition(env, { question: 'Which sort is stable and fast' });
  other.ex.write('BRIEF.md', 'q'); other.ex.write('test/CHECKLIST.md', '1'); other.ex.start();   // no pre-approvals
  other.startRole('lead', env.orch.name);
  const plain = hub.startWorker(p, 'plain', 'Read docs', env.orch.name, 'Read docs');
  const url = 'https://docs.example-lib.org/guide';
  const r = await fetchPage(hub, p, other.agents.lead, url);
  assert.match(r.message, /^Parked, not allowed/, 'another expedition without it');
  assert.equal(await settled(fetchPage(hub, p, plain, url)), 'waiting', 'a plain worker\'s request is a card, as before');
  assert.equal(p.log.ofType('approval').length, 1);
  for (const a of hub.approvals.values()) a.finish({ behavior: 'deny', message: 'test' }, 'denied');
  assert.equal(hub.expeditionOverlay(p, plain), null);
  assert.deepEqual(hub.expeditionOverlay(p, other.agents.lead), { sites: [], packages: [] });
  assert.equal(hub.expeditionOverlay(p, env.orch), null);
});

test('it lasts from the start to expedition_stopped, and is rebuilt from the log after a restart', async () => {
  const { hub, p, ex, lead, env, se } = world({ gate: true });
  const url = 'https://docs.example-lib.org/guide';
  assert.equal((await fetchPage(hub, p, lead, url)).behavior, 'allow', 'while it is running');
  // A restart: a new hub over the same folder reads it back from expedition_started.
  const hub2 = new Hub({ projects: [env.dir], memory: new Memory(join(env.root, 'home')), agentHome: join(env.root, 'agents-home'), noAgents: true, settings: new HubSettings({ file: null }) });
  const p2 = hub2.project('proj');
  hub2.setPermissionMode(p2, 'auto', 'you');
  const lead2 = p2.agents.get(lead.name);
  assert.equal(lead2.expedition, se.id);
  assert.equal((await fetchPage(hub2, p2, lead2, url)).behavior, 'allow', 'after a restart');
  assert.equal(hub2.lists.data.sites.some(s => s.host === 'docs.example-lib.org'), false, 'and still not in his lists');
  // It ends at expedition_stopped: the Lead writing up gets the page parked like anyone else.
  ex.stop({ reason: 'passed' });
  const r = await fetchPage(hub, p, lead, url);
  assert.match(r.message, /^Parked, not allowed/, 'after the stop');
  assert.equal(hub.expeditionOverlay(p, lead), null);
  // A restart after the stop agrees: the stop is in the log, so there is no overlay to rebuild.
  const hub3 = new Hub({ projects: [env.dir], memory: new Memory(join(env.root, 'home')), agentHome: join(env.root, 'agents-home'), noAgents: true, settings: new HubSettings({ file: null }) });
  const p3 = hub3.project('proj');
  hub3.setPermissionMode(p3, 'auto', 'you');
  assert.equal(hub3.expeditionOverlay(p3, p3.agents.get(lead.name)), null);
  assert.match((await fetchPage(hub3, p3, p3.agents.get(lead.name), url)).message, /^Parked, not allowed/);
});

test('launchExpedition carries the launch\'s pre-approvals into expedition_started, checked like Matt\'s own adds, and refuses a bad one before anything is written', () => {
  sent.length = 0;
  const { hub, p, root } = stubHub({ level: 'auto' });
  const listsBefore = JSON.stringify(hub.lists.data);
  for (const [pre, why] of [
    [{ sites: [{ host: 'https://docs.example-lib.org/' }] }, /Pre-approved site .*site's name/],
    [{ sites: [{ host: 'docs.example-lib.org', access: 'everything' }] }, /Pre-approved site .*Pages or downloads/],
    [{ sites: [{ host: 'gitlab.com', access: 'downloads' }] }, /Pre-approved site "gitlab.com": gitlab.com serves anyone's files: pin downloads/],
    [{ sites: [{ host: 'x.example.org', pin: '/a/../b', access: 'downloads' }] }, /pinned path/],
    [{ packages: [{ eco: 'npm', name: 'zod@1.0.0' }] }, /Pre-approved package .*plain package name/],
    [{ packages: [{ eco: 'cargo', name: 'serde' }] }, /Pre-approved package .*npm, pip or Hugging Face/],
    [{ packages: [{ eco: 'huggingface', name: 'acme/model' }] }, /Pre-approved package .*40-character commit/]
  ]) {
    assert.throws(() => hub.launchExpedition(p, { brief: 'q', preApprovals: pre }), why, JSON.stringify(pre));
  }
  assert.equal(Expedition.all(p).length, 0, 'a refusal writes nothing');
  assert.equal(p.log.ofType('agent_created').filter(e => e.expedition).length, 0);
  // A good one: stored normalised in the start event, with the same defaults a site added by hand gets.
  const r = hub.launchExpedition(p, { brief: 'Compare two libraries.', test: { 'CHECKLIST.md': '1. a table\n' }, preApprovals: { sites: [{ host: 'DOCS.Example-Lib.org' }, { host: 'docs.example-lib.org' }, { host: 'github.com', access: 'downloads', pin: '/Owner/Repo/' }], packages: [{ eco: 'npm', name: 'zod', baseMajor: 3 }, { eco: 'pip', name: 'Some_Pkg' }] } });
  assert.deepEqual(r.expedition.preApprovals, {
    sites: [{ host: 'docs.example-lib.org', access: 'pages', pin: null, subdomains: true }, { host: 'github.com', access: 'downloads', pin: '/owner/repo', subdomains: false }],
    packages: [{ eco: 'npm', name: 'zod', baseMajor: 3, baseMinor: null }, { eco: 'pip', name: 'some-pkg', baseMajor: null, baseMinor: null }]
  });
  assert.equal(JSON.stringify(hub.lists.data), listsBefore, 'the launch never touches his lists');
  // No pre-approvals at all is the normal case: an empty overlay.
  const bare = world({ pre: null });
  assert.deepEqual(bare.ex.state().started.preApprovals, { sites: [], packages: [] });
  void root;
});

test('reading the start event back never trusts a bad entry: it is dropped, not an error and not an allow', () => {
  assert.deepEqual(normalizeOverlay({ sites: [{ host: 'ok.example.org' }, { host: 'not a host' }, 'x', null], packages: [{ eco: 'npm', name: 'zod' }, { eco: 'npm', name: '../x' }] }),
    { sites: [{ host: 'ok.example.org', access: 'pages', pin: null, subdomains: true }], packages: [{ eco: 'npm', name: 'zod', baseMajor: null, baseMinor: null }] });
  assert.deepEqual(normalizeOverlay(undefined), { sites: [], packages: [] });
  assert.deepEqual(normalizeOverlay('everything'), { sites: [], packages: [] });
  assert.deepEqual(normalizeOverlay({ sites: 'x', packages: { a: 1 } }), { sites: [], packages: [] });
  assert.throws(() => normalizeOverlay({ sites: [{ host: 'bad host' }] }, { strict: true }), ListsError);
});

// ---------- the same gates on packages (age, major version, --ignore-scripts) ----------
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false', ...a], { cwd, stdio: 'ignore' });
const NOW = Date.parse('2026-11-15T12:00:00Z');
const days = n => NOW - n * 86400000;
const REG = {
  'npm:zod': { latest: '3.23.8', versions: { '3.22.0': { at: days(300) }, '3.23.8': { at: days(10) }, '4.0.0': { at: days(20) } } },
  'npm:fresh': { latest: '1.0.1', versions: { '1.0.1': { at: NOW - 3600000 } } }
};
const BEFORE = '--before=2026-11-10';

// A project that is a repository with origin/main, as npm install is settled only against main's lockfile.
function repo(root, name) {
  const dir = join(root, name), remote = join(root, `${name}-remote`);
  mkdirSync(dir, { recursive: true }); mkdirSync(remote);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'a', dependencies: { zod: '^3.22.0' } }));
  writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', remote); git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'update-ref', '-d', 'refs/remotes/origin/main'); git(dir, 'fetch', '-q', 'origin');
  git(dir, 'switch', '-q', '-c', 'feat/x');
  return dir;
}

test('overlay packages go through the same gates as Matt\'s own: age, major version, --ignore-scripts, the exact name', async () => {
  const root = makeTmp('crux-expedition-pkgs-');
  const dir = repo(root, 'proj'), tmp = join(root, 'tmp'), home = join(root, 'home');
  mkdirSync(tmp, { recursive: true }); mkdirSync(home, { recursive: true });
  const make = async () => { const l = new PermissionLists({ settings: new HubSettings({ file: null }), fetcher: async (e, n) => REG[`${e}:${n}`] || null, now: () => NOW, home }); await Promise.all(['zod', 'fresh'].map(n => l.prime('npm', n))); return l; };
  const viaOverlay = await make(), viaHis = await make();
  const overlay = { sites: [], packages: [{ eco: 'npm', name: 'zod', baseMajor: 3 }, { eco: 'npm', name: 'fresh', baseMajor: 1 }] };
  viaHis.addPackage({ eco: 'npm', name: 'zod', baseMajor: 3 }); viaHis.addPackage({ eco: 'npm', name: 'fresh', baseMajor: 1 });
  const ask = (lists, ov, command) => classify({ tool: 'Bash', input: { command }, projectDir: dir, cwd: dir, tmp, home, level: 'auto', lists: lists.forProject(dir, ov) });
  const same = [`npm install zod --ignore-scripts ${BEFORE}`, `npm install zod@3.23.8 --ignore-scripts ${BEFORE}`, 'npm install zod --ignore-scripts', `npm install zod ${BEFORE}`, `npm install zod@4.0.0 --ignore-scripts ${BEFORE}`,
    `npm install fresh --ignore-scripts ${BEFORE}`, `npm install evil --ignore-scripts ${BEFORE}`, `npm install zod evil --ignore-scripts ${BEFORE}`, `npm install zod --registry https://evil.example --ignore-scripts ${BEFORE}`];
  for (const c of same) {
    const a = ask(viaOverlay, overlay, c), b = ask(viaHis, null, c);
    assert.deepEqual([a.route, a.reasons, a.unsure], [b.route, b.reasons, b.unsure], `an overlay entry is judged exactly like his own: ${c}`);
  }
  // And what those answers are: allowed only for the listed package, an old enough release, the same major, scripts off.
  assert.equal(ask(viaOverlay, overlay, `npm install zod --ignore-scripts ${BEFORE}`).route, 'allow');
  assert.equal(ask(viaOverlay, overlay, `npm install zod@3.23.8 --ignore-scripts ${BEFORE}`).route, 'allow');
  assert.equal(ask(viaOverlay, null, `npm install zod --ignore-scripts ${BEFORE}`).route !== 'allow', true, 'without the overlay (any other agent) it is not');
  assert.notEqual(ask(viaOverlay, overlay, `npm install zod ${BEFORE}`).route, 'allow', 'scripts on');
  assert.notEqual(ask(viaOverlay, overlay, 'npm install zod --ignore-scripts').route, 'allow', 'no --before');
  assert.match(ask(viaOverlay, overlay, `npm install zod@4.0.0 --ignore-scripts ${BEFORE}`).reasons.join(' '), /major version jump/);
  assert.match(ask(viaOverlay, overlay, `npm install fresh --ignore-scripts ${BEFORE}`).reasons.join(' '), /under the 3-day wait/);
  assert.notEqual(ask(viaOverlay, overlay, `npm install evil --ignore-scripts ${BEFORE}`).route, 'allow');
  // The overlay never enters the lists object it was read next to.
  assert.deepEqual(viaOverlay.data.packages, [], 'not saved');
  // The registry is asked for an overlay package before the install is judged (the answer is not remembered yet), and for nothing else.
  const asked = [];
  const cold = new PermissionLists({ settings: new HubSettings({ file: null }), fetcher: async (e, n) => { asked.push(`${e}:${n}`); return REG[`${e}:${n}`] || null; }, now: () => NOW, home });
  assert.equal(cold.warm('Bash', { command: 'npm install zod --ignore-scripts' }, dir), null, 'a request with no overlay is as before: not on his list, no waiting');
  assert.equal(cold.warm('Bash', { command: 'npm install evil --ignore-scripts' }, dir, 5000, overlay), null, 'a package the overlay does not name');
  assert.deepEqual(asked, []);
  await cold.warm('Bash', { command: 'npm install zod --ignore-scripts' }, dir, 5000, overlay);
  assert.deepEqual(asked, ['npm:zod'], 'it waits for the registry, once');
  assert.ok(cold.cache.get('npm:zod'));
});

// ---------- merging stays blocked, whatever is on the log ----------
test('a merge pass or a push to a protected branch never lets an expedition agent through; the check is never asked; a plain worker\'s pass still works', async () => {
  const { hub, p, builder, lead, env } = world({ gate: true });
  const mark = quietMark(env);
  let asked = 0;
  hub.checkerMade = { run: async () => { asked++; return { valid: true, answer: 'allow', reason: 'x' }; } };
  hub.settings.setProject(p.dir, { permissionCheck: 'on' });
  const plain = hub.startWorker(p, 'plain', 'Do a thing', env.orch.name, 'Do a thing');
  const pass = (asker, n) => p.log.append('merge_pass', { pass: `pass-${asker}-${n}`, card: `question:${asker}`, asker, number: n, thread: asker });
  for (const a of [builder, lead, plain]) { pass(a.name, 12); pass(a.name, 13); }
  const commands = ['gh pr merge 12 --squash', 'gh pr merge 13 --merge --delete-branch', 'gh pr merge 12 --admin', 'git merge feature/x', 'git merge --no-ff origin/main',
    'git push origin main', 'git push origin HEAD:main', 'git push origin HEAD:refs/heads/main', 'git push origin +feat/x:main', 'git push --force origin feat/x', 'git push --force-with-lease origin feat/x', 'git push origin :feat/x', 'git push --delete origin feat/x',
    'git branch -D feat/x', 'git reset --hard origin/main', 'git push origin main && git merge feature/x'];
  const answersBefore = p.log.ofType('permission_answer').length;
  for (const agent of [builder, lead]) {
    for (const command of commands) {
      const r = await hub.requestApproval(p, agent, 'Bash', { command });
      assert.equal(r.behavior, 'deny', `${agent.name}: ${command}`);
      assert.match(r.message, /^Parked, not allowed/, `${agent.name}: ${command}`);
    }
  }
  const mine = p.log.ofType('permission_answer').slice(answersBefore);
  assert.equal(mine.length, commands.length * 2);
  assert.ok(mine.every(a => a.answer === 'deny' && a.pass === undefined && a.expedition === env.p.log.ofType('expedition_started')[0].expedition), 'every one a deny, none by a pass');
  assert.equal(asked, 0, 'hard stops never reach the check');
  assert.equal(hub.approvals.size, 0);
  assert.equal(p.log.ofType('approval').length, 0);
  assert.deepEqual(quietProblems(env, mark, sent), []);
  // Control, last (a pass-allowed merge is logged in the orchestrator's thread): the same pass does let a plain worker's merge through.
  assert.equal((await hub.requestApproval(p, plain, 'Bash', { command: 'gh pr merge 12 --squash' })).behavior, 'allow');
});

// ---------- Auto's script gate for an expedition's agents (decision 67, kept by decision 73) ----------
test('an expedition agent at Auto: a script that is not committed goes to the check on the spot with no card (On), and is read beside, tagged with the expedition, at Shadow', async () => {
  const { hub, p, builder, env } = world({ gate: true });
  writeFileSync(join(p.dir, 'bench.mjs'), 'console.log("bench")');
  writeFileSync(join(p.dir, 'done.mjs'), 'console.log("done")');
  hub.checkGit = async (args) => {   // done.mjs is tracked and clean; bench.mjs is not tracked
    const name = args.at(-1);
    if (args[0] === 'ls-files') return { code: name === 'done.mjs' ? 0 : 1, out: '' };
    if (args[0] === 'status') return { code: 0, out: '' };
    if (args[0] === 'merge-base') return { code: 0, out: 'abc\n' };
    if (args[0] === 'diff') return { code: 0, out: '' };
    return { code: 1, out: '' };
  };
  const asked = [];
  hub.checkerMade = { run: async req => { asked.push(req.tool); return { valid: true, answer: 'deny', reason: 'it writes outside the project', model: 'claude-sonnet-5-5' }; } };
  const mark = quietMark(env);
  hub.settings.setProject(p.dir, { permissionCheck: 'on' });
  const r = await hub.requestApproval(p, builder, 'Bash', { command: 'node bench.mjs' });
  assert.equal(r.behavior, 'deny', 'the check judged it');
  assert.match(r.message, /permission check declined: it writes outside the project/);
  assert.equal(asked.length, 1);
  const line = p.log.ofType('permission_answer').at(-1);
  assert.deepEqual([line.by, line.answer, line.thread, line.expedition === builder.expedition], [CHECK_NAME, 'deny', builder.thread, true], 'in the agent\'s own thread, tagged');
  assert.equal(p.log.ofType('approval').length, 0, 'no card, no waiting entry');
  // a committed, unchanged script goes at once, the check not asked
  assert.equal((await hub.requestApproval(p, builder, 'Bash', { command: 'node done.mjs' })).behavior, 'allow');
  assert.equal(asked.length, 1);
  assert.deepEqual(quietProblems(env, mark, sent), []);
  // Shadow: allowed at once as today, the check reads it beside and writes check_shadow (no thread, tagged with the expedition)
  hub.settings.setProject(p.dir, { permissionCheck: 'shadow' });
  const s = await hub.requestApproval(p, builder, 'Bash', { command: 'node bench.mjs' });
  assert.equal(s.behavior, 'allow');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(asked.length, 2, 'the check ran beside');
  const real = p.log.ofType('permission_answer').at(-1);
  assert.deepEqual([real.by, real.answer, real.thread, real.expedition === builder.expedition], ['hub', 'allow', builder.thread, true], 'the real answer is in the agent\'s thread, never the orchestrator\'s');
  const shadow = p.log.ofType('check_shadow').at(-1);
  assert.equal(shadow.answer, 'deny');
  assert.deepEqual([shadow.thread, shadow.expedition === builder.expedition], [undefined, true], 'the shadow line is in no thread (never the orchestrator\'s), tagged with the expedition');
  assert.deepEqual(quietProblems(env, mark, sent), []);
});

// ---------- pause ----------
test('paused: every kind of expedition request is denied "wait" with no card, no parked line and no check, a write to the frozen test included', async () => {
  const { hub, p, ex, builder, lead, env } = world({ gate: true });
  const mark = quietMark(env);
  let asked = 0;
  hub.checkerMade = { run: async () => { asked++; return { valid: true, answer: 'allow', reason: 'x' }; } };
  hub.settings.setProject(p.dir, { permissionCheck: 'on' });
  hub.setPaused(p, true, 'you');
  const parked = p.log.ofType('expedition_parked').length;
  for (const [agent, tool, input] of [[builder, 'Bash', { command: 'node bench.mjs' }], [builder, 'Bash', { command: 'git push origin main' }], [lead, 'WebFetch', { url: 'https://docs.example-lib.org/guide', prompt: 'x' }],
    [builder, 'Write', { file_path: join(ex.testDir, 'CHECKLIST.md'), content: 'x' }], [builder, 'Edit', { file_path: join(p.dir, 'src', 'a.js'), old_string: 'a', new_string: 'b' }]]) {
    const r = await hub.requestApproval(p, agent, tool, input);
    assert.equal(r.behavior, 'deny', `${tool} ${JSON.stringify(input).slice(0, 50)}`);
    assert.match(r.message, /paused/);
  }
  assert.equal(p.log.ofType('expedition_parked').length, parked, 'not parked');
  assert.equal(asked, 0);
  assert.equal(hub.approvals.size, 0);
  assert.equal(p.log.ofType('approval').length, 0);
  assert.deepEqual(p.log.ofType('permission_answer').slice(-5).map(a => [a.answer, a.reason]), Array(5).fill(['deny', 'paused, wait']));
  // (The pause itself, Matt's act, notes the orchestrator: that is not the expedition's doing, so only the expedition's own traces are checked.)
  assert.equal(p.log.events.filter(e => ['approval', 'approval_escalated'].includes(e.type)).length, 0);
  assert.equal(p.log.ofType('permission_answer').filter(a => a.thread === 'orchestrator').length, 0, 'nothing of the expedition\'s in the orchestrator\'s thread');
  void mark;
  // Resumed: the same request is judged again (and the pre-approved page is read).
  hub.setPaused(p, false, 'you');
  assert.equal((await hub.requestApproval(p, lead, 'WebFetch', { url: 'https://docs.example-lib.org/guide', prompt: 'x' })).behavior, 'allow');
});
