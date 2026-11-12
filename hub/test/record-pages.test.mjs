// Decision 41 A: only the .json and .md records go into git. The pages (*.html, index.html) are built locally, kept out
// of git by a .gitignore inside .decisions, and rebuilt by the hub when a pull leaves them missing or stale.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ensureGitignore, pagesStale, refreshPages } from '../../crux/scripts/build.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';

Agent.prototype.send = function () { this.state = 'working'; };
Agent.prototype.close = function () {};

const git = (cwd, ...args) => String(execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })).trim();
const record = (id, status = 'open') => ({ id, slug: `d${id}`, title: `Decision ${id}`, status, options: [{ key: 'A', name: 'Aye' }, { key: 'B', name: 'Bee' }], recommended: 'A' });
const temp = t => { const d = mkdtempSync(join(tmpdir(), 'crux-pages-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const decisionsIn = (root, records) => {
  const d = join(root, '.decisions'); mkdirSync(d, { recursive: true });
  for (const r of records) writeFileSync(join(d, `${String(r.id).padStart(4, '0')}-${r.slug}.json`), JSON.stringify(r, null, 1));
  return d;
};
const age = (file, s) => { const t = new Date(Date.now() - s * 1000); utimesSync(file, t, t); };

test('the .gitignore: written in a .decisions folder, other lines kept, never twice, never in other folders', t => {
  const root = temp(t);
  const d = decisionsIn(root, []);
  assert.equal(ensureGitignore(d), true);
  assert.match(readFileSync(join(d, '.gitignore'), 'utf8'), /^\*\.html$/m);
  assert.equal(ensureGitignore(d), false, 'already there');
  const other = join(root, 'b', '.decisions'); mkdirSync(other, { recursive: true });
  writeFileSync(join(other, '.gitignore'), 'notes.txt');
  ensureGitignore(other);
  assert.equal(readFileSync(join(other, '.gitignore'), 'utf8'), 'notes.txt\n*.html\n', 'the existing line stays');
  const demo = join(root, 'demo-decisions'); mkdirSync(demo);
  assert.equal(ensureGitignore(demo), false);
  assert.equal(existsSync(join(demo, '.gitignore')), false, 'an example folder keeps its committed pages');
});

test('refreshPages rebuilds missing or stale pages where they are local, and leaves fresh ones alone', t => {
  const d = decisionsIn(temp(t), [record(1), record(2)]);
  assert.equal(refreshPages(d), false, 'no .gitignore: a repo that still commits its pages is never touched');
  assert.equal(existsSync(join(d, '0001-d1.html')), false);
  ensureGitignore(d);
  assert.equal(pagesStale(d), true, 'pages missing');
  assert.equal(refreshPages(d), true);
  for (const f of ['0001-d1.html', '0002-d2.html', 'index.html']) assert.ok(existsSync(join(d, f)), f);
  assert.equal(existsSync(join(d, '0001-d1.md')), false, 'the refresh writes pages only, never the committed .md');
  assert.equal(pagesStale(d), false);
  assert.equal(refreshPages(d), false, 'fresh pages are not rebuilt');
  for (const f of ['0001-d1.html', '0002-d2.html', 'index.html']) age(join(d, f), 60);   // a pull brings a newer record
  assert.equal(pagesStale(d), true, 'a record newer than its page');
  refreshPages(d);
  assert.ok(statSync(join(d, '0002-d2.html')).mtimeMs >= statSync(join(d, '0002-d2.json')).mtimeMs);
  writeFileSync(join(d, 'notes.json'), '{"not":"a record"}');
  assert.equal(pagesStale(d), false, 'a .json that is not a record never counts as a missing page');
});

test('the hub rebuilds stale pages on load and before it serves one; a page it cannot build falls back to the .md', t => {
  const root = temp(t);
  const dir = join(root, 'proj');
  const d = decisionsIn(dir, [record(1), { id: 2, slug: 'd2', title: 'No options yet', status: 'open' }]);
  ensureGitignore(d);
  writeFileSync(join(d, '0002-d2.md'), '# 0002 No options yet\n');
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }) });
  const p = hub.project('proj');
  assert.ok(existsSync(join(d, '0001-d1.html')), 'built when the project loaded');
  rmSync(join(d, '0001-d1.html'));
  assert.equal(p.board.pageFile('0001-d1.html'), join(d, '0001-d1.html'));
  assert.ok(existsSync(join(d, '0001-d1.html')), 'rebuilt before serving');
  assert.equal(p.board.pageFile('0002-d2.html'), join(d, '0002-d2.md'), 'the .md record when there is no page');
});

test('the records worktree carries the .gitignore and commits the records, never the pages', t => {
  const root = temp(t);
  // The real build runs here; point its roll-up at this temp folder, never at ~/crux.
  const env = { home: process.env.CRUX_HOME, roots: process.env.CRUX_ROOTS };
  process.env.CRUX_HOME = join(root, 'crux-home'); process.env.CRUX_ROOTS = join(root, 'no-roots');
  t.after(() => { for (const [k, v] of [['CRUX_HOME', env.home], ['CRUX_ROOTS', env.roots]]) v === undefined ? delete process.env[k] : process.env[k] = v; });
  const bare = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  const dir = join(root, 'proj');
  git(root, 'init', '-q', '-b', 'main', dir);
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com']]) git(dir, 'config', k, v);
  decisionsIn(dir, [record(1)]);
  writeFileSync(join(dir, '.gitignore'), '.crux/\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'seed'); git(dir, 'remote', 'add', 'origin', bare); git(dir, 'push', '-q', 'origin', 'main');
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }), noAgents: true });
  const p = hub.project('proj');
  p.desk.local = true;
  hub.pickMany(p, [{ id: 1, choice: 'B' }]);
  const wt = p.desk.dir;
  assert.match(readFileSync(join(wt, '.decisions', '.gitignore'), 'utf8'), /^\*\.html$/m);
  const tracked = git(wt, 'ls-files', '.decisions').split('\n');
  assert.ok(tracked.includes('.decisions/.gitignore') && tracked.includes('.decisions/0001-d1.json'), tracked.join(', '));
  assert.ok(!tracked.some(f => f.endsWith('.html')), 'no page committed');
  assert.ok(existsSync(join(wt, '.decisions', '0001-d1.html')), 'the page is on disk for the hub to serve');
  assert.equal(git(dir, 'status', '--porcelain'), '', 'main folder untouched');
});
