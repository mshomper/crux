// Routine commands the classifier used to send to the orchestrator as "unsure" (R005): variables the command sets
// itself, scripts in temp or the project, read-only property access, rmdir of a junction, a rebase of an unpushed
// branch, and temp subfolders the agent made. The hard stops stay hard stops.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classify } from '../lib/permission-rules.mjs';

// Matt's machine, as in the real cards. Paths are only compared, never touched.
const HOME = 'C:\\Users\\mshom';
const TEMP = 'C:\\Users\\mshom\\AppData\\Local\\Temp';
const CRUX = 'C:\\Users\\mshom\\Documents\\GitHub\\crux';
const WT = `${CRUX}\\.claude\\worktrees\\permission-tune`;
const at = (tool, command, extra = {}) => classify({ tool, input: { command }, projectDir: WT, tmp: TEMP, home: HOME, ...extra });
const ps = (c, x) => at('PowerShell', c, x);
const sh = (c, x) => at('Bash', c, x);
const why = r => `${r.route}: ${[...r.reasons, ...r.unsure].join('; ')}`;
const allow = r => assert.equal(r.route, 'allow', why(r));

test('PowerShell variables set in the command are filled in before paths are judged', () => {
  allow(ps(String.raw`$o='C:\Users\mshom\AppData\Local\Temp\crux-usage-shots'; node "$o\shot.mjs" 'http://127.0.0.1:4755/' "$o\desk-calm.png" 1440 900`));
  allow(ps(String.raw`$env:CRUX_HUB_DATA = 'C:\Users\mshom\AppData\Local\Temp\x\data'; node server.mjs --port 4755 --no-agents C:\Users\mshom\AppData\Local\Temp\x\demo`));
  allow(ps(String.raw`$t = "$env:TEMP\crux-x"; $f = "$t\a.txt"; Get-Content $f`));
});

test('bash variables and loops over fixed lists are filled in too', () => {
  allow(sh('sh "C:/Users/mshom/AppData/Local/Temp/crux-model-robots/shoot.sh" a b; T="C:/Users/mshom/AppData/Local/Temp/crux-hud-frame" && mkdir -p "$T/demo" && node "$T/seed.mjs" 4755 "$T/demo"'));
  allow(sh('export T=/c/Users/mshom/AppData/Local/Temp/crux-x; ls "$T"'));
  allow(sh('for n in a b c; do node "$TEMP/crux-x/run.mjs" $n; done'));
  allow(sh('for f in one two; do rm -rf "/c/Users/mshom/AppData/Local/Temp/crux-x/$f"; done', { madeTemp: [join(TEMP, 'crux-x')] }));
  allow(ps(String.raw`foreach ($n in 'a','b') { node "$env:TEMP\crux-x\run.mjs" $n }`));
});

test('read-only cmdlets and their properties are fine', () => {
  allow(ps('(Invoke-WebRequest -UseBasicParsing http://localhost:4752/api/ping).Content ; (Get-Item C:\\Users\\mshom\\Documents\\GitHub\\crux\\hub\\node_modules).LinkType ; Test-Path x ; Start-Sleep 2'));
  allow(ps('(Invoke-WebRequest http://localhost:4752/api/ping -Method GET).StatusCode | Out-Null; Get-Item x | Select-Object Name | Format-List'));
  allow(ps(String.raw`Get-Content C:\Users\mshom\AppData\Local\Temp\claude\tasks\b1.output -Tail 40`));
  assert.notEqual(ps('(Invoke-WebRequest -Method POST http://localhost:4747/api/x).Content').route, 'allow', 'a POST to the hub is never fine');
  assert.equal(ps('(Invoke-WebRequest -Method POST -Body x http://localhost/api/x).Content').route, 'human', 'localhost with no port');
  assert.equal(ps('(Get-Item x).Delete()').route, 'unsure', 'a method is not a property');
});

test('scripts in the project, a worktree or temp are contained; elsewhere they are not', () => {
  allow(sh('bash scripts/shoot.sh a b'));
  allow(sh('bash /c/Users/mshom/AppData/Local/Temp/x/run.sh --flag'));
  allow(ps(String.raw`pwsh -File C:\Users\mshom\AppData\Local\Temp\x\run.ps1 -Name a`));
  assert.equal(sh('sh /c/Users/mshom/Desktop/run.sh').route, 'unsure');
  assert.equal(sh('bash -c "echo hi"').route, 'unsure');
  assert.equal(sh('sh scripts/run.sh /c/Users/mshom/Desktop/out').route, 'unsure', 'an argument outside');
  assert.equal(ps(String.raw`pwsh -File C:\Users\mshom\Desktop\run.ps1`).route, 'unsure');
  assert.notEqual(sh('node /c/Users/mshom/Desktop/a.mjs').route, 'allow');
});

test('cmd /c rmdir without /s, on a junction in the project', () => {
  allow(ps(String.raw`cmd /c rmdir "${WT}\hub\node_modules"`));
  allow(ps(String.raw`Remove-Item "${WT}\hub\node_modules"`));
  assert.equal(ps(String.raw`cmd /c rmdir /s /q "${WT}\hub\node_modules"`).route, 'unsure', 'recursive stays with the orchestrator');
  assert.equal(ps(String.raw`cmd /c rmdir C:\Users\mshom\Desktop\x`).route, 'human');
  assert.equal(ps(String.raw`cmd /c rmdir "${WT}"`).route, 'human', 'not the project folder itself');
});

test('temp subfolders this agent made are its own to delete, whatever their name', () => {
  const root = mkdtempSync(join(tmpdir(), 'crux-tune-'));
  const tmp = join(root, 'tmp');
  mkdirSync(join(tmp, 'shared'), { recursive: true });
  const p = (c, x) => classify({ tool: 'Bash', input: { command: c }, projectDir: join(root, 'proj'), tmp, home: HOME, ...x });
  const sub = join(tmp, 'shared', 'shots').replace(/\\/g, '/');
  assert.equal(p(`rm -rf "${sub}"`, { agent: 'builder' }).route, 'unsure', 'not made by this agent');
  const made = p(`mkdir -p "${sub}"`, { agent: 'builder' });
  assert.equal(made.route, 'allow');
  assert.deepEqual(made.tempMade.map(x => x.replace(/\\/g, '/')), [sub], 'the folder is reported so the hub can remember it');
  assert.equal(p(`rm -rf "${sub}"`, { agent: 'builder', madeTemp: made.tempMade }).route, 'allow', 'made earlier this session');
  assert.equal(p(`rm -rf "${join(tmp, 'shared').replace(/\\/g, '/')}"`, { agent: 'builder', madeTemp: made.tempMade }).route, 'unsure', 'its parent is not its own');
  assert.equal(p(`mkdir -p "${sub}/a" && rm -rf "${sub}/a"`, { agent: 'builder' }).route, 'allow', 'made and removed in one command');
  assert.equal(p(`rm -rf "${tmp.replace(/\\/g, '/')}"`, { agent: 'builder', madeTemp: made.tempMade }).route, 'human', 'temp itself');
});

test('git rebase: contained on an unpushed branch, unsure on a pushed one, main or a detached HEAD', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crux-rebase-'));
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'feat/x');
  writeFileSync(join(dir, 'a.txt'), '1');
  git('add', '.'); git('commit', '-q', '-m', 'one');
  const rebase = c => classify({ tool: 'Bash', input: { command: c }, projectDir: dir, tmp: join(dir, 'tmp'), home: HOME });
  allow(rebase('git rebase origin/main'));                       // no upstream
  git('update-ref', 'refs/remotes/origin/feat/x', 'HEAD');       // pushed
  assert.equal(rebase('git rebase origin/main').route, 'unsure', 'HEAD is already on origin');
  writeFileSync(join(dir, 'a.txt'), '2'); git('commit', '-qam', 'two');
  allow(rebase('git rebase origin/main'));                       // upstream does not contain HEAD
  assert.equal(rebase('git rebase -i HEAD~2').route, 'unsure');
  assert.equal(rebase('git rebase --exec "npm test" origin/main').route, 'unsure');
  git('switch', '-q', '-c', 'main');
  assert.equal(rebase('git rebase origin/main').route, 'unsure', 'main');
  assert.equal(rebase('git filter-branch x').route, 'human', 'other history rewrites stay hard stops');
});

test('negatives: the hard stops and the unreadable still trip', () => {
  assert.equal(sh('rm -rf /c/Users/mshom/Documents/other').route, 'human');
  assert.equal(sh('curl -s -X POST -d x localhost:4747/api/settings').route, 'human');
  assert.equal(sh('git push --force origin feat/x').route, 'human');
  assert.equal(sh('git push origin main').route, 'human');
  assert.equal(ps(String.raw`Remove-Item -Recurse C:\Users\mshom\Desktop\x`).route, 'human');
  // a variable that resolves outside the allowed roots is judged by where it points
  assert.equal(ps(String.raw`$o='C:\Users\mshom\Desktop'; Remove-Item -Recurse "$o\x"`).route, 'human');
  assert.equal(ps(String.raw`$o='C:\Users\mshom\Desktop'; Set-Content "$o\x.txt" 1`).route, 'human');
  assert.notEqual(ps(String.raw`$o='C:\Users\mshom\Desktop'; node "$o\a.mjs"`).route, 'allow');
  assert.equal(sh('T=/c/Windows; rm -rf "$T/x"').route, 'human');
  assert.equal(sh('for d in /c/Windows /c/Users/mshom/Desktop; do rm -rf "$d/x"; done').route, 'human', 'one value outside is enough');
  assert.equal(ps(String.raw`$env:PORT = 4747; node server.mjs`).route, 'human');
  assert.equal(sh('PORT=4747; node server.mjs --port $PORT').route, 'human');
  // values the hub cannot read stay unread
  assert.notEqual(sh('X=$(cat f); node "$X/a.mjs"').route, 'allow');
  assert.equal(ps(String.raw`$t = $env:GITHUB_TOKEN; Write-Output $t`).route, 'human');
  // a variable whose value is only known at run time makes any path built from it unresolvable
  assert.equal(ps('$o = Get-Date; node "$o\\x.mjs"').route, 'unsure');
  assert.equal(ps('$o = (Get-Date).ToString(); Get-Content "$o\\x.txt"').route, 'unsure');
  assert.equal(sh('X=$(date); node "$X/x.mjs"').route, 'unsure');
  assert.equal(ps(String.raw`$o = Get-ChildItem C:\ | Select -First 1; Remove-Item -Recurse $o`).route, 'human');
  assert.equal(ps('$o = Get-Date; Remove-Item -Recurse "$o\\x"').route, 'human');
  assert.equal(ps('$o = Get-Date; Remove-Item -Recurse -Force $o').route, 'human');
  assert.equal(ps('$o = Get-Date; Copy-Item -Recurse x $o').route, 'human');
  assert.equal(sh('X=$(date); rm -rf "$X/x"').route, 'human');
  assert.equal(ps('$o = Get-Date; Remove-Item "$o\\x"').route, 'unsure', 'not recursive: for the orchestrator');
  assert.equal(sh('for f in *.txt; do rm "$f"; done').route, 'unsure', 'a glob is not a fixed list');
});
