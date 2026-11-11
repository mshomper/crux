// The hub's own hard stops (R001, R002): these never reach the orchestrator, whatever shape the command takes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { classify, rulesEntry } from '../lib/permission-rules.mjs';

const root = mkdtempSync(join(tmpdir(), 'crux-rules-'));
// The project lives outside the temp folder in real life; here a fake temp folder stands in so both can be told apart.
const projectDir = join(root, 'proj');
const tmp = join(root, 'tmp');
mkdirSync(join(projectDir, 'hub'), { recursive: true });
mkdirSync(tmp, { recursive: true });
writeFileSync(join(projectDir, 'hub', 'package.json'), JSON.stringify({ scripts: { start: 'node server.mjs' } }));
const home = homedir();

const run = (command, tool = 'Bash') => classify({ tool, input: { command }, projectDir, tmp, home });
const human = (command, tool) => { const r = run(command, tool); assert.equal(r.route, 'human', `expected Matt for: ${command} (${r.route}: ${r.unsure.join('; ')})`); return r.reasons; };
const orch = (command, tool) => { const r = run(command, tool); assert.equal(r.route, 'allow', `expected contained for: ${command} (${r.route}: ${[...r.reasons, ...r.unsure].join('; ')})`); };
const unsure = (command, tool) => { const r = run(command, tool); assert.equal(r.route, 'unsure', `expected unsure for: ${command} (${r.route}: ${r.reasons.join('; ')})`); };
const toolRoute = (tool, input) => classify({ tool, input, projectDir, tmp, home });

test('everyday project work may go to the orchestrator', () => {
  for (const c of [
    'npm test', 'npm test --prefix hub', 'npm run lint', 'node --test test/a.test.mjs', 'node scripts/check.mjs',
    'git status', 'git diff --stat', 'git log --oneline -5', 'git add hub/lib/a.mjs', 'git commit -m "Hub: routing"',
    'git switch -c feat/x', 'git checkout feat/x', 'git branch feat/y', 'git stash', 'git reset', 'git reset -- hub/a.mjs',
    'git -C hub status', 'cd hub && npm test', 'ls -la hub', 'mkdir hub/tmp', 'grep -rn "approval" hub/lib',
    'cat hub/package.json | head -5', 'npm test 2>&1 | tail -20', 'echo ok > hub/out.txt',
    'node server.mjs --port 4748 ../proj', 'cd hub && npm start -- --port 4750',
    'git push -u origin feat/permission-routing', 'git push origin feat/x:feat/x', 'git -C hub push origin feat/x',
    'gh pr create --title "Routing" --body "See https://example.com/x"',
    `rm -rf ${join(tmp, 'crux-test-1').replace(/\\/g, '/')}`,
    `git commit -m "$(cat <<'EOF'\nHub: permission routing\n\nCo-Authored-By: x\nEOF\n)"`
  ]) orch(c);
  orch('Get-ChildItem hub | Where-Object { $_.Length -gt 100 } | Select-Object Name', 'PowerShell');
  orch('Set-Location hub; npm test', 'PowerShell');
});

test('git push stays with Matt for main, master, force, deletes and shapes the hub cannot read', () => {
  for (const c of [
    'git push origin main', 'git push origin master', 'git push origin feat/x:main', 'git push origin HEAD:refs/heads/master',
    'git push --force origin feat/x', 'git push -f origin feat/x', 'git push origin feat/x --force-with-lease',
    'git push --force-with-lease=feat/x origin feat/x', 'git push origin +feat/x', 'git push origin +feat/x:feat/x',
    'git push --delete origin feat/x', 'git push origin -d feat/x', 'git push origin :feat/x',
    'git push', 'git push origin', 'git push origin HEAD', 'git push --all origin', 'git push --mirror origin',
    'git push --tags origin', 'git push https://github.com/someone/repo feat/x', 'git push origin feat/x --no-verify',
    'git -C x push origin main', 'git -C ../other push origin feat/x', 'npm test && git push origin main',
    'npm test; git push --force origin feat/x', 'git status || git push origin master',
    'gh pr merge 12', 'gh pr merge --squash'
  ]) human(c);
});

test('merge, history rewrites and branch deletes are hard stops', () => {
  for (const c of [
    'git merge main', 'git reset --hard', 'git reset --hard origin/main', 'git branch -D feat/x', 'git branch -d feat/x',
    'git branch --delete x', 'git branch -f main HEAD~2', 'git checkout -B feat/x', 'git filter-branch', 'git reflog expire --all'
  ]) human(c);
});

test('R004: local git steps that are fine on an unpushed branch go to the orchestrator; contained ones are allowed', () => {
  for (const c of ['git rebase main', 'git rebase -i HEAD~3', 'git reset HEAD~1', 'git commit --amend -m x', 'git tag -d v1', 'git -c core.sshCommand=x status']) unsure(c);
  for (const c of ['git clean -fd', 'git stash drop', 'git rm hub/a.mjs', 'git worktree add .claude/worktrees/w1 -b feat/w1', 'git worktree remove .claude/worktrees/w1',
    'gh pr list', 'gh pr view 3']) orch(c);
});

test('git push with no branch named reads the checked-out branch', () => {
  const repo = (branch) => {
    const d = join(root, `repo-${branch.replace(/\//g, '-')}`);
    mkdirSync(join(d, '.git'), { recursive: true });
    writeFileSync(join(d, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
    return d;
  };
  const at = (dir, command) => classify({ tool: 'Bash', input: { command }, projectDir: dir, tmp, home }).route;
  const feat = repo('feat/routing'), main = repo('main');
  for (const c of ['git push', 'git push origin', 'git push -u origin HEAD']) {
    assert.equal(at(feat, c), 'allow', c);
    assert.equal(at(main, c), 'human', c);
  }
  // a worktree: .git is a file pointing at the real git folder
  const wt = join(root, 'wt');
  mkdirSync(join(root, 'wtgit'), { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(root, 'wtgit', 'HEAD'), 'ref: refs/heads/master\n');
  writeFileSync(join(wt, '.git'), `gitdir: ${join(root, 'wtgit')}\n`);
  assert.equal(at(wt, 'git push'), 'human');
});

test('installs, dependency changes and network commands are hard stops', () => {
  for (const c of [
    'npm install', 'npm i web-push', 'npm ci', 'npm uninstall zod', 'npx something', 'pip install x', 'python -m pip install x',
    'winget install x', 'cd hub && npm install x', 'npm publish', 'npm view zod',
    'curl https://example.com', 'wget http://x', 'Invoke-WebRequest https://x', 'iwr https://x', 'ssh host', 'scp a host:b',
    'git fetch', 'git pull', 'git clone https://github.com/x/y', 'git remote add evil https://x', 'node -e "fetch(\'https://x\')"',
    'node fetch.mjs https://example.com'
  ]) human(c);
  assert.equal(toolRoute('Edit', { file_path: join(projectDir, 'hub', 'package.json'), old_string: 'a', new_string: 'b' }).route, 'human');
  assert.equal(toolRoute('Write', { file_path: join(projectDir, 'package-lock.json'), content: '{}' }).route, 'human');
  assert.equal(toolRoute('WebFetch', { url: 'https://example.com' }).route, 'unsure', 'reading docs is allowed, but the hub cannot tell docs apart');
});

test('paths outside the project folder, including ../ and home, are hard stops', () => {
  for (const c of [
    'cat ../secret.txt', 'ls ..', 'cat hub/../../other/file', 'echo x > ../evil.txt', 'echo x>../evil.txt', 'cp a.txt ../../x',
    'cd .. && ls', 'cd ../other; npm test', 'cat ~/.claude/settings.json', 'ls ~/crux', `cat ${home.replace(/\\/g, '/')}/x.txt`,
    'cat /c/Windows/win.ini', 'cat C:\\Windows\\win.ini', 'type "C:\\Program Files\\x"', 'cat /etc/passwd', 'git -C ../other status',
    'node -e "require(\'fs\').writeFileSync(\'C:/x.txt\', 1)"', 'cat \\\\server\\share\\x'
  ]) human(c);
  assert.equal(toolRoute('Read', { file_path: join(projectDir, '..', 'x.txt') }).route, 'human');
  assert.equal(toolRoute('Edit', { file_path: join(home, '.claude', 'settings.json') }).route, 'human');
  assert.equal(toolRoute('Write', { file_path: join(projectDir, 'hub', '..', '..', 'x.mjs') }).route, 'human');
  assert.equal(toolRoute('Edit', { file_path: join(projectDir, 'hub', 'lib', 'a.mjs') }).route, 'allow');
  assert.equal(toolRoute('Write', { file_path: join(tmp, 'proj', 'x.json') }).route, 'allow');
  assert.equal(toolRoute('Write', { file_path: join(projectDir, '.claude', 'worktrees', 'w1', 'hub', 'a.mjs') }).route, 'allow');
  assert.equal(toolRoute('Glob', { pattern: 'C:/Users/**/*.md' }).route, 'human');
});

test('deleting outside the project or a temp folder is a hard stop; inside is contained (R004)', () => {
  for (const c of ['rm ../a.mjs', 'rm -rf ~/crux/x', `rm -rf "${home.replace(/\\/g, '/')}/x"`, 'del ..\\a.mjs', 'rm -rf .', 'rm -rf *']) human(c);
  human('Remove-Item ../hub/a.mjs', 'PowerShell');
  human('Get-ChildItem C:\\ | ForEach-Object { Remove-Item $_ }', 'PowerShell');
  for (const c of ['rm hub/a.mjs', 'rm -rf hub/tmp', 'del hub\\a.mjs', 'find . -name "*.log" -delete', `rm -rf "${join(tmp, 'x')}"`, 'rm -rf .claude/worktrees/w1']) orch(c);
  orch('Remove-Item hub/a.mjs', 'PowerShell');
  for (const c of ['rm -rf $HOME/x', 'rm']) unsure(c);
});

test('anything touching port 4747 or stopping processes is a hard stop', () => {
  for (const c of [
    'node server.mjs', 'node hub/server.mjs --port 4747', 'cd hub && npm start', 'npm start --prefix hub',
    'curl localhost:4747/api/state', 'Stop-Process -Id 1234', 'taskkill /PID 1234 /F', 'kill 1234', 'netstat -ano | findstr 4747',
    'CRUX_HUB_PORT=4747 node x.mjs'
  ]) human(c);
});

test('secrets, and unreadable shapes that name a hard-stop action, go to Matt', () => {
  for (const c of [
    'cat .env', 'cat hub/.env.local', 'cat ~/.ssh/id_rsa', 'cat .npmrc', 'echo $ANTHROPIC_API_KEY', 'printenv', 'env',
    'bash -c "git push origin main"', 'eval "git push"', 'echo `git push`', 'echo $(git push origin main)',
    'node -e "require(\'child_process\').execSync(\'git push\')"',
    'node - <<\'EOF\'\nrequire("child_process").execSync("git push origin main")\nEOF', 'sh -c "npm install x"'
  ]) human(c);
  human('Invoke-Expression "git push"', 'PowerShell');
  human('& "C:\\tools\\x.exe"', 'PowerShell');
  human('Get-ChildItem Env:', 'PowerShell');
  human('$x = "git"; & $x push', 'PowerShell');
});

test('requests the hub cannot classify are unsure: they go to the orchestrator in auto mode', () => {
  for (const c of ['sh -c "x"', 'powershell -Command "x"', 'cat file | xargs rm', 'sudo ls', 'unknowntool --do-it', './node_modules/.bin/x',
    'python -c "import subprocess"', 'node -e "require(\'child_process\').execSync(\'ls\')"', 'echo $(date)', '', 'python -m http.server']) unsure(c);
});

test('tools: known reading tools are contained; unknown ones are unsure', () => {
  assert.equal(toolRoute('WebSearch', { query: 'node test runner' }).route, 'allow');
  assert.equal(toolRoute('TodoWrite', {}).route, 'allow');
  assert.equal(toolRoute('mcp__other__thing', {}).route, 'unsure');
  assert.equal(toolRoute('SomethingNew', {}).route, 'unsure');
  assert.equal(toolRoute('Edit', { file_path: join(projectDir, '.claude', 'settings.local.json') }).route, 'human');
  assert.equal(toolRoute('Edit', { file_path: join(projectDir, '.git', 'config') }).route, 'human');
  assert.equal(toolRoute('Write', { file_path: join(projectDir, '.crux', 'events.jsonl') }).route, 'human');
});

test('every hard stop says why in plain words', () => {
  assert.match(human('git push origin main').join(' '), /main/);
  assert.match(human('git push --force origin feat/x').join(' '), /Force/);
  assert.match(human('npm i x').join(' '), /packages/);
  assert.match(human('cat ../x').join(' '), /outside the project/);
});

test('the rules entry is the newest active "permission rules" requirement', () => {
  const board = { entries: () => [
    { entryId: 'R001', kind: 'requirement', status: 'superseded', title: 'Orchestrator permission rules (D0021 A)' },
    { entryId: 'R002', kind: 'requirement', status: 'active', title: 'Orchestrator permission rules (D0021 A, D0022 A)' },
    { entryId: 'R003', kind: 'requirement', status: 'active', title: 'Something else' }
  ] };
  assert.equal(rulesEntry(board).entryId, 'R002');
  assert.equal(rulesEntry({ entries: () => [] }), null);
});
