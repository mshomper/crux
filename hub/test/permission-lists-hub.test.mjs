// Plan v3 A10 through the hub: a listed site or package is allowed with no card, an unlisted one becomes a card that
// offers "Always allow", only Matt's page actions change the lists (with a step-up for adding), the downloads record is
// the project's event log, and the settings card and buttons draw what they should.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { Hub } from '../lib/hub.mjs';
import { HubSettings, projectKey } from '../lib/settings.mjs';
import { Memory } from '../lib/memory.mjs';
import { Agent } from '../lib/agent.mjs';
import { stepUpNeed } from '../lib/guard.mjs';
import { listsCard, addBody, freshDraft, listAddButtons, listAddBody } from '../public/lists-card.js';
import { projectCard } from '../public/project-settings.js';

Agent.prototype.send = function () { this.state = 'working'; };
Agent.prototype.close = function () {};

const root = makeTmp('crux-lists-hub-');
const fakeTemp = join(root, 'temp');
mkdirSync(join(fakeTemp, 'crux-quarantine'), { recursive: true });
// os.tmpdir() reads these each time, so the hub's own checker sees a throwaway temp folder.
const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
Object.assign(process.env, { TEMP: fakeTemp, TMP: fakeTemp, TMPDIR: fakeTemp });
test.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

function setup(name) {
  const dir = join(root, name);
  mkdirSync(join(dir, '.crux'), { recursive: true });
  const file = join(root, `${name}-data`, 'settings.json');
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file }), noAgents: true });
  const p = hub.project(name);
  hub.setPermissionMode(p, 'auto');
  const w = hub.startWorker(p, 'reader', 'Read the docs', 'you', 'Read the docs');
  return { hub, p, w, dir, file };
}
const asks = (hub, p, w, tool, input) => hub.requestApproval(p, w, tool, input);
const settled = async pr => Promise.race([pr, new Promise(r => setTimeout(() => r('waiting'), 30))]);

test('a listed page is read with no card; an unlisted one is a card that offers "Always allow this site"', async () => {
  const { hub, p, w } = setup('docs-reader');
  const ok = await settled(asks(hub, p, w, 'WebFetch', { url: 'https://docs.python.org/3/library/os.html', prompt: 'x' }));
  assert.equal(ok.behavior, 'allow', 'a seeded site');
  const before = p.log.ofType('approval').length;
  assert.equal(await settled(asks(hub, p, w, 'WebFetch', { url: 'https://example-news.org/a', prompt: 'x' })), 'waiting');
  const card = p.log.ofType('approval').at(-1);
  assert.equal(p.log.ofType('approval').length, before + 1);
  assert.deepEqual(card.listable, [{ kind: 'site', host: 'example-news.org', access: 'pages', pin: null }]);
  // Matt's click on the card's button is the add action; from then on it is read with no card
  await hub.addToLists(p, { kind: 'site', host: 'example-news.org', access: 'pages', scope: 'all', subdomains: false });
  assert.equal((await settled(asks(hub, p, w, 'WebFetch', { url: 'https://example-news.org/b', prompt: 'x' }))).behavior, 'allow');
  assert.equal((await settled(asks(hub, p, w, 'WebFetch', { url: 'https://www.example-news.org/b', prompt: 'x' }))), 'waiting', 'exact address only when added from the card');
  assert.ok(p.log.ofType('notice').some(n => /added example-news.org to the trusted sites \(pages\)/.test(n.text)));
  for (const a of hub.approvals.values()) a.finish({ behavior: 'deny', message: 'test' }, 'denied');
});

test('lists are stored in hub settings (never a repo file) and kept across a restart', () => {
  const { hub, p, dir, file } = setup('kept');
  hub.addToLists(p, { kind: 'site', host: 'example-data.org', access: 'pages', scope: 'project' });
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(saved.lists.sites.some(s => s.host === 'example-data.org' && s.scope === projectKey(dir) && s.by === 'you'));
  assert.ok(saved.lists.sites.filter(s => s.by === 'seed').length >= 27);
  const hub2 = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file }), noAgents: true });
  const v = hub2.listsView(hub2.project('kept'));
  assert.ok(v.sites.some(s => s.host === 'example-data.org' && s.scopeName === 'kept'));
  assert.equal(v.project, 'kept');
  for (const f of ['.crux-hub.json', '.claude/settings.local.json']) assert.throws(() => readFileSync(join(dir, f)), 'no repo file is written');
});

test('a site narrowed to one project is not trusted in another', async () => {
  const a = setup('proj-a'), b = setup('proj-b');
  const settings = new HubSettings({ file: null });
  const hub = new Hub({ projects: [a.dir, b.dir], memory: new Memory(join(root, 'home')), settings, noAgents: true });
  const pa = hub.project('proj-a'), pb = hub.project('proj-b');
  hub.setPermissionMode(pa, 'auto'); hub.setPermissionMode(pb, 'auto');
  const wa = hub.startWorker(pa, 'x', 'g', 'you', 'g'), wb = hub.startWorker(pb, 'x', 'g', 'you', 'g');
  await hub.addToLists(pa, { kind: 'site', host: 'only-a.example.org', scope: 'project' });
  assert.equal((await settled(asks(hub, pa, wa, 'WebFetch', { url: 'https://only-a.example.org/', prompt: 'x' }))).behavior, 'allow');
  assert.equal(await settled(asks(hub, pb, wb, 'WebFetch', { url: 'https://only-a.example.org/', prompt: 'x' })), 'waiting');
  assert.equal(hub.listsView(pb).sites.find(s => s.host === 'only-a.example.org').scopeName, 'proj-a');
  for (const x of hub.approvals.values()) x.finish({ behavior: 'deny', message: 'test' }, 'denied');
});

test('downloads: the record is the project\'s log, so running the file stays a stop for every agent and after a restart', async () => {
  const { hub, p, w, dir, file } = setup('fetcher');
  await hub.addToLists(p, { kind: 'site', host: 'example-data.org', access: 'downloads', scope: 'all' });
  const got = await settled(asks(hub, p, w, 'Bash', { command: 'curl -sS -o /tmp/crux-quarantine/tool.sh https://example-data.org/tool.sh' }));
  assert.equal(got.behavior, 'allow');
  const rec = p.log.ofType('download');
  assert.equal(rec.length, 1);
  assert.match(rec[0].path, /crux-quarantine\/tool\.sh$/);
  assert.equal(rec[0].host, 'example-data.org');
  assert.equal(rec[0].agent, 'reader');
  // a second worker, and a fresh hub reading the same log, both find running it a stop
  const w2 = hub.startWorker(p, 'other', 'Another job', 'you', 'Another job');
  assert.equal(await settled(asks(hub, p, w2, 'Bash', { command: 'bash /tmp/crux-quarantine/tool.sh' })), 'waiting');
  const card = p.log.ofType('approval').at(-1);
  assert.equal(card.routedTo, null, 'a hard stop: it comes to Matt');
  assert.ok(card.stops.some(s => /downloaded/.test(s)), card.stops.join('; '));
  for (const a of hub.approvals.values()) a.finish({ behavior: 'deny', message: 'test' }, 'denied');
  const hub2 = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file }), noAgents: true });
  const p2 = hub2.project('fetcher');
  hub2.setPermissionMode(p2, 'auto');
  const w3 = hub2.startWorker(p2, 'third', 'Third', 'you', 'Third');
  assert.equal(await settled(hub2.requestApproval(p2, w3, 'Bash', { command: 'node /tmp/crux-quarantine/tool.sh' })), 'waiting');
  assert.ok(p2.log.ofType('approval').at(-1).stops.some(s => /downloaded/.test(s)));
  for (const a of hub2.approvals.values()) a.finish({ behavior: 'deny', message: 'test' }, 'denied');
});

test('the one-line audit entry of a single allow offers the same buttons', () => {
  const { hub, p, w } = setup('audit');
  const a = { p, agent: w, toolName: 'Bash', input: { command: 'npm install zod --ignore-scripts' } };
  hub.logAnswer(a, 'id1', 'allow', 'fits the goal', 'orchestrator-1');
  hub.logAnswer({ ...a, input: { command: 'npm install zod' } }, 'id2', 'deny', 'no scripts', 'orchestrator-1');
  hub.logAnswer({ ...a, input: { command: 'ls' } }, 'id3', 'allow', 'read', 'orchestrator-1');
  const [x, y, z] = p.log.ofType('permission_answer').slice(-3);
  assert.deepEqual(x.listable, [{ kind: 'package', eco: 'npm', name: 'zod' }]);
  assert.equal(y.listable, undefined, 'a denial offers nothing');
  assert.equal(z.listable, undefined, 'a plain read offers nothing');
});

test('only Matt adds: the add action needs a fresh step-up, removing does not, downloads are a separate confirmed step', () => {
  const { hub } = setup('guarded');
  const add = stepUpNeed('POST /api/lists/add', { project: 'guarded', kind: 'site', host: 'example.org', access: 'pages', scope: 'all' }, hub);
  assert.equal(add.purpose, 'lists');
  assert.match(add.why, /Add example.org to your trusted sites/);
  const dl = stepUpNeed('POST /api/lists/add', { project: 'guarded', kind: 'site', host: 'example.org', access: 'downloads', scope: 'all' }, hub);
  assert.notEqual(dl.scope, add.scope, 'a confirmation for pages cannot be reused for downloads');
  const pk = stepUpNeed('POST /api/lists/add', { project: 'guarded', kind: 'package', eco: 'npm', name: 'zod', scope: 'project' }, hub);
  assert.match(pk.why, /Add zod to your approved packages/);
  assert.notEqual(stepUpNeed('POST /api/lists/add', { kind: 'package', eco: 'npm', name: 'zod', scope: 'all' }, hub).scope, pk.scope, 'scope is part of what was confirmed');
  assert.equal(stepUpNeed('POST /api/lists/access', { id: 's1', access: 'downloads' }, hub).purpose, 'lists');
  assert.equal(stepUpNeed('POST /api/lists/access', { id: 's1', access: 'pages' }, hub), null);
  assert.equal(stepUpNeed('POST /api/lists/remove', { id: 's1' }, hub), null);
  // and no agent tool reaches the lists: the board tools and the orchestrator's tools do not mention them
  for (const f of ['tools.mjs', 'conductor.mjs']) assert.ok(!/addToLists|PermissionLists|lists\.add/.test(readFileSync(new URL(`../lib/${f}`, import.meta.url), 'utf8')), `${f} has no way to add`);
});

test('removing, and turning a site from pages to downloads, are noted in the thread; a seed can be removed', async () => {
  const { hub, p } = setup('tidy');
  const e = await hub.addToLists(p, { kind: 'site', host: 'example-data.org', access: 'pages', scope: 'all' });
  hub.setListAccess(p, e.id, 'downloads');
  assert.ok(p.log.ofType('notice').some(n => /allowed downloads from example-data.org/.test(n.text)));
  const seed = hub.listsView(p).sites.find(s => s.host === 'fda.gov');
  hub.removeFromLists(p, seed.id);
  assert.ok(!hub.listsView(p).sites.some(s => s.host === 'fda.gov'));
  assert.ok(p.log.ofType('notice').some(n => /removed fda.gov from the trusted sites/.test(n.text)));
  assert.throws(() => hub.removeFromLists(p, seed.id), /not on the list/);
  await assert.rejects(() => hub.addToLists(p, { kind: 'site', host: 'https://evil.example/x' }), /just the site/);
  await assert.rejects(() => hub.addToLists(p, { kind: 'package', eco: 'npm', name: 'a@b' }), /plain package name/);
  await assert.rejects(() => hub.addToLists(p, { kind: 'nothing' }), /site or a package/);
});

// ---------- the card and the buttons ----------
test('the settings card lists everything with who, when, scope and a remove button; no emoji, no script', () => {
  const view = {
    project: 'garden-planner', minAgeDays: 3,
    sites: [
      { id: 's1', host: 'fda.gov', subdomains: true, access: 'pages', pin: null, scope: 'all', scopeName: 'Every project', by: 'seed', at: '2026-11-15T10:00:00Z', open: false },
      { id: 's2', host: 'github.com', subdomains: false, access: 'pages', pin: null, scope: 'all', scopeName: 'Every project', by: 'seed', at: '2026-11-15T10:00:00Z', open: true },
      { id: 's3', host: 'example-data.org', subdomains: true, access: 'downloads', pin: null, scope: 'k', scopeName: 'garden-planner', by: 'you', at: '2026-11-15T11:00:00Z', open: false },
      { id: 's4', host: '<img src=x onerror=alert(1)>', subdomains: false, access: 'pages', pin: '/o/r', scope: 'all', scopeName: 'Every project', by: 'you', at: '2026-11-15T11:00:00Z', open: false }
    ],
    packages: [{ id: 'p1', eco: 'npm', name: 'zod', baseMajor: 3, scope: 'all', scopeName: 'Every project', by: 'you', at: '2026-11-15T12:00:00Z' }]
  };
  const html = listsCard(view, freshDraft());
  for (const t of ['fda.gov', 'github.com', 'example-data.org', 'zod', 'Every project', 'garden-planner', 'Starting list', 'Added by you', 'Pages', 'Downloads', 'from version 3.x', 'Add a site', 'Add a package']) assert.ok(html.includes(t), t);
  assert.equal([...html.matchAll(/data-pl-remove="/g)].length, 5, 'a remove button on every row');
  assert.equal([...html.matchAll(/data-pl-arm="/g)].length, 2, 'fda.gov (pages) may take downloads; github.com (open, unpinned) may not; the pinned one may');
  assert.ok(!html.includes('<img src=x'), 'host names are escaped');
  assert.ok(!/<script/i.test(html));
  assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(html), 'no emoji');
  assert.ok(html.includes('class="pl-warn"'), 'an open site shows the amber mark');
  assert.ok(html.includes('title="'), 'icons carry hover labels');
  const armed = listsCard(view, { ...freshDraft(), arm: 's1' });
  assert.match(armed, /Let agents download from it\?/);
  assert.ok(armed.includes('data-pl-access="downloads" data-id="s1"'), 'turning pages into downloads is its own confirm');
  const err = listsCard(view, { ...freshDraft(), error: 'example.org is already on the list.' });
  assert.match(err, /role="alert"[^>]*>.*already on the list/s);
});
test('the add forms send exactly what the server checks', () => {
  const d = freshDraft();
  d.form.site = { host: ' fda.gov ', access: 'pages', pin: '/ignored', scope: 'project' };
  assert.deepEqual(addBody('site', d, 'p'), { project: 'p', kind: 'site', host: 'fda.gov', access: 'pages', pin: '', scope: 'project' });
  d.form.site = { host: 'github.com', access: 'downloads', pin: ' /owner/repo ', scope: 'all' };
  assert.deepEqual(addBody('site', d, 'p'), { project: 'p', kind: 'site', host: 'github.com', access: 'downloads', pin: '/owner/repo', scope: 'all' });
  d.form.pkg = { eco: 'pip', name: ' requests ', scope: 'all' };
  assert.deepEqual(addBody('pkg', d, 'p'), { project: 'p', kind: 'package', eco: 'pip', name: 'requests', scope: 'all' });
  const pinned = listsCard({ project: 'p', sites: [], packages: [] }, { ...d, form: { ...d.form, site: { ...d.form.site, access: 'downloads' } } });
  assert.match(pinned, /data-pl-in="site.pin"/);
  assert.ok(!listsCard({ project: 'p', sites: [], packages: [] }, freshDraft()).includes('data-pl-in="site.pin"'), 'the path box shows only for downloads');
});
test('"Always allow this site / package" buttons say what they save, and send a narrow add', () => {
  const html = listAddButtons([{ kind: 'site', host: 'docs.python.org', access: 'pages', pin: null }, { kind: 'package', eco: 'npm', name: 'zod' }, { kind: 'site', host: 'github.com', access: 'downloads', pin: '/o/r' }]);
  assert.match(html, /Always allow this site/);
  assert.match(html, /Always allow this package/);
  assert.match(html, /Always allow downloads from this site/);
  assert.match(html, /github\.com\/o\/r/);
  assert.ok(html.includes('data-list-add="'));
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(html));
  assert.equal(listAddButtons([]), '');
  assert.deepEqual(listAddBody('p', { kind: 'site', host: 'docs.python.org', access: 'pages', pin: null }), { project: 'p', kind: 'site', host: 'docs.python.org', access: 'pages', pin: '', scope: 'all', subdomains: false });
  assert.deepEqual(listAddBody('p', { kind: 'package', eco: 'npm', name: 'zod' }), { project: 'p', kind: 'package', eco: 'npm', name: 'zod', scope: 'project' });
});
test('the project settings card opens the lists card; nothing else about it changes', () => {
  const html = projectCard({ name: 'p', permissionMode: 'auto', connectors: false, ownHandoff: {} }, { retireAt: 60, idleHandoffMin: 60, idleFloorPct: 25 }, { level: 'auto', connectors: false, nums: {}, errors: {}, alwaysOpen: false });
  assert.ok(html.includes('data-ps-lists'));
  assert.match(html, /Trusted sites and packages/);
  assert.ok(!/ps-seg/.test(html.split('data-ps-lists')[1].split('When the orchestrator hands off')[0]), 'no new toggle');
});
