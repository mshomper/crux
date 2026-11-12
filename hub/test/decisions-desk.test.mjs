// Decision 35 A: picks land on a standing docs/decisions branch with one rolling PR, never in the main folder.
// The "GitHub" here is a local bare repo and a fake gh, so nothing leaves this machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { PR_TITLE } from '../lib/decisions-desk.mjs';

Agent.prototype.send = function () { this.state = 'working'; };
Agent.prototype.close = function () {};

const git = (cwd, ...args) => String(execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })).trim();
const record = (id, status = 'open') => ({ id, slug: `d${id}`, title: `Decision ${id}`, status, options: [{ key: 'A', name: 'Aye' }, { key: 'B', name: 'Bee' }], recommended: 'A' });

// A project cloned from a bare "GitHub" repo, with decisions 1 and 2 open on main.
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'crux-desk-'));
  const bare = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', '-b', 'main', seed);
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com']]) git(seed, 'config', k, v);
  mkdirSync(join(seed, '.decisions'));
  writeFileSync(join(seed, '.gitignore'), '.crux/\n');   // as in crux: the chat log stays local
  writeFileSync(join(seed, '.decisions', '0001-d1.json'), JSON.stringify(record(1), null, 1));
  writeFileSync(join(seed, '.decisions', '0002-d2.json'), JSON.stringify(record(2), null, 1));
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'seed'); git(seed, 'remote', 'add', 'origin', bare); git(seed, 'push', '-q', 'origin', 'main');
  const dir = join(root, 'proj');
  git(root, 'clone', '-q', bare, dir);
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com']]) git(dir, 'config', k, v);
  mkdirSync(join(dir, '.crux'), { recursive: true });
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }) });
  const p = hub.project('proj');
  // A fake gh: remembers calls; a PR is "open" once created, until the test merges it.
  const gh = { calls: [], open: false };
  p.desk.gh = async (args) => {
    gh.calls.push(args);
    if (args[1] === 'list') return JSON.stringify(gh.open ? [{ number: 1 }] : []);
    if (args[1] === 'create') { gh.open = true; return 'https://example.invalid/pr/1'; }
    return '';
  };
  p.desk.build = join(root, 'no-build.mjs');   // keep the real Crux build (and its roll-up) out of tests
  return { root, bare, dir, hub, p, gh };
}
const mainFile = (dir, id) => JSON.parse(readFileSync(join(dir, '.decisions', `000${id}-d${id}.json`), 'utf8'));

test('a pick lands in the decisions worktree on docs/decisions, never in the main folder', async () => {
  const { dir, hub, p, bare, gh } = setup();
  const before = readFileSync(join(dir, '.decisions', '0001-d1.json'), 'utf8');
  const [d] = hub.pickMany(p, [{ id: 1, choice: 'B', reason: 'because' }]);
  assert.equal(readFileSync(join(dir, '.decisions', '0001-d1.json'), 'utf8'), before, 'main folder untouched');
  assert.equal(git(dir, 'status', '--porcelain'), '', 'nothing uncommitted in the main folder');
  const wt = join(dir, '.claude', 'worktrees', 'decisions');
  assert.equal(JSON.parse(readFileSync(join(wt, '.decisions', '0001-d1.json'), 'utf8')).chosen, 'B');
  assert.equal(git(wt, 'branch', '--show-current'), 'docs/decisions');
  assert.equal(git(wt, 'log', '-1', '--format=%s'), 'Record pick: D0001 B');
  assert.deepEqual(await d._landed.published, { ok: true });
  assert.equal(git(bare, 'log', '-1', '--format=%s', 'docs/decisions'), 'Record pick: D0001 B', 'pushed');
  const create = gh.calls.find(c => c[1] === 'create');
  assert.ok(create && create.includes(PR_TITLE), 'one rolling PR opened');
  assert.match(create[create.indexOf('--body') + 1], /Record pick: D0001 B/);
});

test('the board shows an unmerged pick as decided at once', () => {
  const { dir, hub, p } = setup();
  hub.pickMany(p, [{ id: 2, choice: 'A' }]);
  assert.equal(mainFile(dir, 2).status, 'open', 'main still has it open');
  assert.equal(p.board.decision(2).status, 'decided');
  assert.equal(p.board.decision(2).chosen, 'A');
  assert.equal(p.board.decision(1).status, 'open');
  assert.ok(p.board.pageFile('0002-d2.html').includes(join('worktrees', 'decisions')) || !existsSync(join(p.desk.decisionsDir, '0002-d2.html')));
});

test('one rolling PR: the next pick updates it instead of opening another', async () => {
  const { hub, p, gh, bare } = setup();
  await hub.pickMany(p, [{ id: 1, choice: 'A' }])[0]._landed.published;
  await hub.pickMany(p, [{ id: 2, choice: 'B' }])[0]._landed.published;
  assert.equal(gh.calls.filter(c => c[1] === 'create').length, 1);
  const edit = gh.calls.filter(c => c[1] === 'edit').at(-1);
  assert.ok(edit, 'edited the open PR');
  const body = edit[edit.indexOf('--body') + 1];
  assert.match(body, /Record pick: D0001 A/);
  assert.match(body, /Record pick: D0002 B/);
  assert.equal(git(bare, 'rev-list', '--count', 'main..docs/decisions'), '2');
});

test('after the PR merges, the branch catches up with main by fast-forward and starts a fresh PR', async () => {
  const { hub, p, gh, bare, dir } = setup();
  await hub.pickMany(p, [{ id: 1, choice: 'A' }])[0]._landed.published;
  // "Merge" on GitHub: main takes the branch; the PR closes.
  const wt = p.desk.dir;
  git(wt, 'push', '-q', 'origin', 'docs/decisions:main');
  gh.open = false;
  await hub.pickMany(p, [{ id: 2, choice: 'B' }])[0]._landed.published;
  assert.equal(git(bare, 'rev-list', '--count', 'main..docs/decisions'), '1', 'only the new pick is waiting');
  const create = gh.calls.filter(c => c[1] === 'create').at(-1);
  const body = create[create.indexOf('--body') + 1];
  assert.match(body, /D0002 B/);
  assert.doesNotMatch(body, /D0001/);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('merged with a merge commit, as GitHub does: the next pick fast-forwards and its PR holds only new picks', async () => {
  const { hub, p, gh, bare, root } = setup();
  await hub.pickMany(p, [{ id: 1, choice: 'A' }])[0]._landed.published;
  // Elsewhere, someone merges the PR with a merge commit (main also gained another commit first).
  const other = join(root, 'other');
  git(root, 'clone', '-q', bare, other);
  for (const [k, v] of [['user.name', 'Merger'], ['user.email', 'm@example.com']]) git(other, 'config', k, v);
  writeFileSync(join(other, 'README.md'), 'x'); git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'unrelated work on main');
  git(other, 'fetch', '-q', 'origin');
  git(other, 'merge', '--no-ff', '-q', '-m', 'Merge pull request #1 from docs/decisions', 'origin/docs/decisions');
  git(other, 'push', '-q', 'origin', 'main');
  gh.open = false;
  const before = gh.calls.filter(c => c[1] === 'create').length;
  await hub.pickMany(p, [{ id: 2, choice: 'B' }])[0]._landed.published;
  assert.equal(git(bare, 'merge-base', '--is-ancestor', 'main', 'docs/decisions') === '', true, 'docs/decisions now sits on top of main (fast-forward, no force)');
  assert.equal(git(bare, 'rev-list', '--count', 'main..docs/decisions'), '1', 'only the new pick is unmerged');
  const create = gh.calls.filter(c => c[1] === 'create');
  assert.equal(create.length, before + 1, 'a fresh PR');
  const body = create.at(-1)[create.at(-1).indexOf('--body') + 1];
  assert.match(body, /D0002 B/);
  assert.doesNotMatch(body, /D0001/, 'no already-merged picks in it');
});

test('offline or no gh: the commit stays, a notice says so once, and the next pick retries', async () => {
  const { hub, p, gh, bare, dir } = setup();
  git(dir, 'remote', 'set-url', 'origin', join(dir, '..', 'nowhere.git'));
  const r1 = await hub.pickMany(p, [{ id: 1, choice: 'A' }])[0]._landed.published;
  assert.equal(r1.ok, false);
  assert.equal(git(p.desk.dir, 'log', '-1', '--format=%s'), 'Record pick: D0001 A', 'kept locally');
  const notices = () => p.log.ofType('notice').filter(n => n.thread === 'orchestrator' && /not yet on GitHub/.test(n.text));
  assert.equal(notices().length, 1);
  await hub.pickMany(p, [{ id: 2, choice: 'A' }])[0]._landed.published;
  assert.equal(notices().length, 1, 'no repeat while it keeps failing');
  git(dir, 'remote', 'set-url', 'origin', bare);
  p.desk.gh = async () => { throw new Error('gh: command not found'); };
  const r3 = await p.desk.publish();
  assert.equal(r3.ok, false, 'pushed, but no gh for the PR');
  assert.equal(git(bare, 'rev-list', '--count', 'main..docs/decisions'), '2', 'both picks reached the remote');
});

test('the orchestrator writes drafts in the worktree; the main folder is refused; drafts are committed when its turn ends', async () => {
  const { dir, hub, p } = setup();
  const orch = hub.ensureOrchestrator(p);
  const main = join(dir, '.decisions', '0003-new.json');
  const wtFile = join(p.desk.decisionsDir, '0003-new.json');
  const refused = hub.autoAnswer(p, orch, 'Write', { file_path: main, content: '{}' });
  assert.equal(refused.behavior, 'deny');
  assert.match(refused.message, /decisions worktree/);
  assert.equal(hub.autoAnswer(p, orch, 'Write', { file_path: wtFile, content: '{}' }).behavior, 'allow');
  assert.ok(p.desk.ready(), 'the worktree exists before it writes');
  writeFileSync(wtFile, JSON.stringify(record(3), null, 1));
  orch.state = 'idle';
  hub.onIdle(p, orch);
  assert.equal(git(p.desk.dir, 'log', '-1', '--format=%s'), `Record drafts from ${orch.name}`);
  assert.equal(git(dir, 'status', '--porcelain'), '', 'main folder still clean');
  assert.equal(p.board.decision(3).title, 'Decision 3');
  assert.match(orch.options().systemPrompt.append, /worktrees[\\/]+decisions/);
});

test('a test hub commits picks locally and never pushes them or opens a PR', async () => {
  const { hub, p, gh, bare } = setup();
  p.desk.local = true;   // what a test hub (noAgents) sets
  const r = await hub.pickMany(p, [{ id: 1, choice: 'A' }])[0]._landed.published;
  assert.deepEqual(r, { ok: false, local: true });
  assert.equal(git(p.desk.dir, 'log', '-1', '--format=%s'), 'Record pick: D0001 A', 'committed locally');
  assert.equal(execFileSync('git', ['branch', '--list', 'docs/decisions'], { cwd: bare }).toString().trim(), '', 'nothing pushed');
  assert.equal(gh.calls.length, 0, 'no PR calls');
  await hub.pickMany(p, [{ id: 2, choice: 'A' }])[0]._landed.published;
  assert.equal(p.log.ofType('notice').filter(n => /Test hub: decision records/.test(n.text)).length, 1, 'said once');
});

test('a project that is not a git repo keeps its records in place', () => {
  const root = mkdtempSync(join(tmpdir(), 'crux-desk-plain-'));
  const dir = join(root, 'plain');
  mkdirSync(join(dir, '.decisions'), { recursive: true });
  writeFileSync(join(dir, '.decisions', '0001-d1.json'), JSON.stringify(record(1), null, 1));
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }) });
  const p = hub.project('plain');
  p.board.rebuild = () => {};
  hub.pickMany(p, [{ id: 1, choice: 'A' }]);
  assert.equal(mainFile(dir, 1).chosen, 'A');
  assert.ok(!existsSync(join(dir, '.claude')));
});
