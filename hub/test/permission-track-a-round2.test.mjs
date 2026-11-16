// Track A, review round 2 (decision 66): each command the final review ran, as a known-answer test, plus the rules
// added after it (writes into packages folders, fetch into a branch). The principle: what the hub cannot read goes to
// judgment, never straight to allow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { classify } from '../lib/permission-rules.mjs';

const root = makeTmp('crux-track-a-r2-');
const project = join(root, 'proj');
const tmp = join(root, 'tmp');
const home = join(root, 'home');
const fw = p => p.replace(/\\/g, '/');
const P = fw(project), WT = `${P}/.claude/worktrees`;
mkdirSync(join(project, 'hub', 'node_modules', 'pkg'), { recursive: true });
mkdirSync(join(project, '.claude', 'worktrees', 'w1', 'hub'), { recursive: true });
mkdirSync(tmp, { recursive: true });
mkdirSync(home, { recursive: true });
symlinkSync(join(project, 'hub', 'node_modules'), join(project, '.claude', 'worktrees', 'w1', 'hub', 'node_modules'), 'junction');
writeFileSync(join(project, 'val.txt'), 'x');

const at = (tool, command, extra = {}) => classify({ tool, input: { command }, projectDir: project, tmp, home, agent: 'builder', ...extra });
const why = r => `${r.route}: ${[...r.reasons, ...r.unsure].join('; ')}`;
const notAllow = (c, tool = 'Bash', x) => { const r = at(tool, c, x); assert.notEqual(r.route, 'allow', `${c}\n  -> ${why(r)}`); };
const allow = (c, tool = 'Bash', x) => { const r = at(tool, c, x); assert.equal(r.route, 'allow', `${c}\n  -> ${why(r)}`); };
const human = (c, tool = 'Bash', x) => { const r = at(tool, c, x); assert.equal(r.route, 'human', `${c}\n  -> ${why(r)}`); };
const file = (tool, path) => classify({ tool, input: { file_path: path, content: 'x', old_string: 'a', new_string: 'b' }, projectDir: project, tmp, home, agent: 'builder' });

test('round 2 HIGH 1: a # comment inside $( ) makes the substitution unreadable', () => {
  const doc = fw(join(root, 'Documents'));
  for (const c of [
    `echo "$(echo #)" '\nrm -rf ${doc}\n)" #'`,                                       // bash, quoted
    `echo $(echo #) '\nrm -rf ${doc}\n) #'`,                                           // bash, unquoted
  ]) notAllow(c);
  notAllow(`Write-Output "$(Get-Date # )" '\nRemove-Item -Recurse -Force ${doc.replace(/\//g, '\\')}\n)" #'`, 'PowerShell');
  notAllow('Write-Output "$(Get-Date <# x #>)"', 'PowerShell');
  notAllow('echo $(cat val.txt # note\n)');
  // no comment: still read as before
  allow('echo "$(cat val.txt)"');
  allow('echo "$(git log -1 --format=%h)"');
});

test('round 2 HIGH 2: $[ ] is arithmetic; a name or value inside is a doubt', () => {
  notAllow('y=$(cat val.txt); echo $[y]');
  notAllow('echo $[$(cat val.txt)]');
  notAllow('echo "$[y]"');
  allow('echo $[1+2]');
});

test('round 2 HIGH 3: a variable set by Get-Item counts only if its name appears nowhere else', () => {
  const j = `${WT}/w1/hub/node_modules`.replace(/\//g, '\\');
  const out = fw(join(root, 'x.txt')).replace(/\//g, '\\');
  allow(`$i = Get-Item "${j}" -Force; $i.Delete()`, 'PowerShell');
  allow(`$i = Get-Item "${j}"; if ($i.LinkType -eq 'Junction') { $i.Delete() }`, 'PowerShell');
  for (const c of [
    `$i = Get-Item "${j}"; Get-Item "${out}" -ov i | Out-Null; $i.Delete()`,
    `$i = Get-Item "${j}"; Get-Item "${out}" -OutVar i | Out-Null; $i.Delete()`,
    `$i = Get-Item "${j}"; Get-ChildItem "${fw(join(root, 'Documents'))}" -ov i; $i.Delete()`,
    `$i = Get-Item "${j}"; Get-Item "${out}" | Tee-Object -Variable i | Out-Null; $i.Delete()`,
    `$i = Get-Item "${j}"; Set-Variable i (Get-Item "${out}"); $i.Delete()`,
    `$i = Get-Item "${j}"; sv i (Get-Item "${out}"); $i.Delete()`,
    `$i = Get-Item "${j}"; New-Variable -Name i -Value (Get-Item "${out}") -Force; $i.Delete()`,
    `$i = Get-Item "${j}"; foreach ($i in Get-ChildItem "${out}") { }; $i.Delete()`,
    `$i, $k = Get-Item "${j}", (Get-Item "${out}"); $i.Delete()`,
    `$i = Get-Item "${j}"; Get-Item "${out}" -pv i | Out-Null; $i.Delete()`,
  ]) notAllow(c, 'PowerShell');
});

test('round 2 HIGH 4: with a tracked port, every Stop-Process is fed by Get-NetTCPConnection -LocalPort on a tracked port', () => {
  const started = { hubs: [4791] };
  allow('Get-NetTCPConnection -LocalPort 4791 | % { Stop-Process -Id $_.OwningProcess }', 'PowerShell', started);
  allow('Get-NetTCPConnection -LocalPort 4791 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }', 'PowerShell', started);
  const good = 'Get-NetTCPConnection -LocalPort 4791 | % { Stop-Process -Id $_.OwningProcess }';
  for (const c of [
    `${good}; Get-NetTCPConnection | % { Stop-Process -Id $_.OwningProcess -Force }`,
    `${good}; Get-NetTCPConnection -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`,
    `${good}; Get-NetTCPConnection -RemotePort 4747 | % { Stop-Process -Id $_.OwningProcess -Force }`,
    `${good}; Get-NetTCPConnection -OwningProcess 18236 | % { Stop-Process -Id $_.OwningProcess -Force }`,
    `${good}; Get-NetUDPEndpoint | % { Stop-Process -Id $_.OwningProcess -Force }`,
    `${good}; Get-Content pid.txt | % { Stop-Process -Id $_ }`,
    `${good}; $p = 18236; Stop-Process -Id $p`,
    `${good}; Stop-Process -Id 18236`,
  ]) notAllow(c, 'PowerShell', started);
});

test('round 2 HIGH 5: any kill token in an inline script is a doubt, even next to the allowed shape', () => {
  const started = { hubs: [4791] };
  const shape = `import('./hub/lib/relaunch.mjs').then(async m => { for (const p of await m.pidsOnPort(4791)) await m.stopTree(p) })`;
  allow(`node -e "${shape}"`, 'Bash', started);
  for (const c of [
    `node -e "process['kill'](18236)"`,
    `node -e "const {kill} = process; kill(18236)"`,
    `node -e "${shape}; process['kill'](18236)"`,
    `node -e "Reflect.apply(process.kill, process, [18236])"`,
    `node -e "process['ki'+'ll'](18236)"`,
    `node -e "process.kill(18236)"`,
  ]) notAllow(c, 'Bash', started);
});

test('round 2 item 6: a write into any node_modules or .venv folder is a hard stop', () => {
  human('cp evil.mjs node_modules/dep/index.js');
  human(`cp evil.mjs ${P}/hub/node_modules/pkg/index.js`);
  human(`cp evil.mjs ${WT}/w1/hub/node_modules/pkg/index.js`);                       // through the worktree's junction
  human(`echo x > ${P}/hub/node_modules/pkg/index.js`);
  human(`echo x | tee ${P}/hub/node_modules/pkg/index.js`);
  human(`mv evil.mjs ${P}/hub/node_modules/pkg/index.js`);
  human(`Copy-Item evil.mjs ${P}\\hub\\node_modules\\pkg\\index.js`, 'PowerShell');
  human(`Set-Content ${P}\\hub\\node_modules\\pkg\\index.js x`, 'PowerShell');
  human(`cp evil.py ${P}/.venv/Lib/site-packages/x.py`);
  for (const t of ['Write', 'Edit', 'MultiEdit']) {
    assert.equal(file(t, `${P}/hub/node_modules/x/index.js`).route, 'human', `${t} into node_modules`);
    assert.equal(file(t, `${P}/.venv/Lib/site-packages/x.py`).route, 'human', `${t} into .venv`);
    assert.equal(file(t, `${WT}/w1/hub/node_modules/x/index.js`).route, 'human', `${t} through the junction`);
  }
  // the project's own files still write freely
  assert.equal(file('Write', `${P}/hub/lib/a.mjs`).route, 'allow');
  allow('cp a.mjs hub/lib/b.mjs');
  // reading in them is fine
  allow(`cat ${P}/hub/node_modules/pkg/index.js`);
});

test('round 2 item 7: git fetch or pull into a branch is a hard stop; update-ref and branch -f stay stops', () => {
  for (const c of [
    'git fetch --update-head-ok . HEAD:main',
    'git fetch -u . +HEAD:refs/heads/main',
    'git fetch . HEAD:refs/remotes/origin/main',
    'git fetch origin main:main',
    'git fetch origin +refs/heads/*:refs/remotes/origin/*',
    'git pull -u . HEAD:main',
    'git pull --update-head-ok origin main',
    'git update-ref refs/heads/main HEAD',
    'git update-ref refs/remotes/origin/main HEAD',
    'git branch -f main HEAD',
    'git branch -f origin/main HEAD',
  ]) human(c);
  allow('git fetch origin');
  allow('git fetch origin main');
});

test('round 2 LOW: an unquoted $( ) as a grep pattern is a doubt; %VAR% in a PATH entry is a doubt', () => {
  notAllow('grep -e $(cat val.txt) -r src');
  notAllow('grep -r -e $(cat val.txt) src');
  allow('grep -e "$(cat val.txt)" -r src');
  notAllow('$env:Path = "%USERPROFILE%\\.cargo\\bin;$env:Path"', 'PowerShell');
  notAllow('$env:Path = "%ProgramFiles%\\nodejs;$env:Path"', 'PowerShell');
});
