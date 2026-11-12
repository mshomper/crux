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

test('index.html is rebuilt when a record is deleted or added, even if every page is newer than its record', t => {
  const d = decisionsIn(temp(t), [record(1), record(2), record(3)]);
  ensureGitignore(d);
  refreshPages(d);
  rmSync(join(d, '0003-d3.json'));
  assert.equal(pagesStale(d), true, 'a deleted record');
  refreshPages(d);
  assert.doesNotMatch(readFileSync(join(d, 'index.html'), 'utf8'), /0003-d3\.html/);
  assert.equal(pagesStale(d), false);
  writeFileSync(join(d, '0003-d3.json'), JSON.stringify(record(3)));
  age(join(d, '0003-d3.json'), 120);   // an added record whose old page is still on disk, all older than index.html
  assert.equal(pagesStale(d), true, 'an added record');
});

test('a repo that still commits its pages is left alone: no .gitignore, no refresh, one line saying so', t => {
  const root = temp(t);
  git(root, 'init', '-q', '-b', 'main');
  const d = decisionsIn(root, [record(1)]);
  writeFileSync(join(d, '0001-d1.html'), 'old page');
  git(root, 'add', '.'); git(root, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'seed');
  const said = []; const log = console.log; console.log = s => said.push(s);
  try { assert.equal(ensureGitignore(d), 'tracked'); } finally { console.log = log; }
  assert.equal(existsSync(join(d, '.gitignore')), false);
  assert.equal(said.length, 1); assert.match(said[0], /still committed/);
  writeFileSync(join(d, '.gitignore'), '*.html\n');   // ignored by hand, but the pages are still tracked
  age(join(d, '0001-d1.html'), 60);
  assert.equal(refreshPages(d), false);
  assert.equal(readFileSync(join(d, '0001-d1.html'), 'utf8'), 'old page', 'the tracked page is not rewritten');
  git(root, 'rm', '-q', '--cached', '.decisions/0001-d1.html');
  assert.equal(refreshPages(d), true, 'once untracked, the refresh runs');
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

// The real build runs in these tests; point its roll-up at the test's temp folder, never at ~/crux.
function quietRollup(t, root) {
  const env = { home: process.env.CRUX_HOME, roots: process.env.CRUX_ROOTS };
  process.env.CRUX_HOME = join(root, 'crux-home'); process.env.CRUX_ROOTS = join(root, 'no-roots');
  t.after(() => { for (const [k, v] of [['CRUX_HOME', env.home], ['CRUX_ROOTS', env.roots]]) v === undefined ? delete process.env[k] : process.env[k] = v; });
}

test('drafts catch up with main before they are committed, so the records branch picks up the untracked pages', t => {
  const root = temp(t);
  quietRollup(t, root);
  const bare = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', '-b', 'main', seed);
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com']]) git(seed, 'config', k, v);
  const sd = decisionsIn(seed, [record(1)]);
  writeFileSync(join(sd, '0001-d1.html'), 'committed page');   // before decision 41: pages tracked on main
  writeFileSync(join(seed, '.gitignore'), '.crux/\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'seed'); git(seed, 'remote', 'add', 'origin', bare); git(seed, 'push', '-q', 'origin', 'main');
  const dir = join(root, 'proj');
  git(root, 'clone', '-q', bare, dir);
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com']]) git(dir, 'config', k, v);
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }), noAgents: true });
  const p = hub.project('proj');
  p.desk.local = true;
  const log = console.log; console.log = () => {};   // the "pages still committed" line
  try { p.desk.ensure(); } finally { console.log = log; }
  const wt = p.desk.dir;
  const before = git(wt, 'rev-parse', 'HEAD');
  // Main untracks its pages (this pull request merging).
  git(seed, 'rm', '-q', '--cached', '.decisions/0001-d1.html');
  writeFileSync(join(sd, '.gitignore'), '*.html\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'Untrack pages'); git(seed, 'push', '-q', 'origin', 'main');
  // The orchestrator drafts a record and its build rewrites the still-tracked page.
  writeFileSync(join(wt, '.decisions', '0002-d2.json'), JSON.stringify(record(2), null, 1));
  writeFileSync(join(wt, '.decisions', '0001-d1.html'), 'rewritten by a build');
  assert.ok(p.desk.commitPending('Record drafts'));
  assert.equal(git(wt, 'log', '-1', '--format=%s'), 'Record drafts');
  git(wt, 'merge-base', '--is-ancestor', before, 'HEAD');           // throws if the branch was rewritten
  git(wt, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD');    // throws if it did not catch up
  const tracked = git(wt, 'ls-files', '.decisions').split('\n');
  assert.ok(tracked.includes('.decisions/0002-d2.json') && tracked.includes('.decisions/.gitignore'), tracked.join(', '));
  assert.ok(!tracked.some(f => f.endsWith('.html')), 'no page tracked on the records branch');
  assert.ok(existsSync(join(wt, '.decisions', '0001-d1.html')) && existsSync(join(wt, '.decisions', '0002-d2.html')), 'pages rebuilt on disk');
});

test('the records worktree carries the .gitignore and commits the records, never the pages', t => {
  const root = temp(t);
  quietRollup(t, root);
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
