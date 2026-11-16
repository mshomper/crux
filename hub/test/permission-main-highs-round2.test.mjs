// Review of PR #89 (final round), the highs found on main: each attack the review ran is a known-answer test.
// - bash \' outside quotes opens no quote; heredoc and here-string bodies taken out are data, their quotes count for nothing;
// - a method named by a quoted string or a variable after the dot ($_.'Kill'(), $_.$m()) is a doubt;
// - more logins: the GitHub CLI Windows file, any /proc/*/environ, Claude's account file, VS Code state, Chrome logins;
// - git fetch or pull that writes a branch (-u, src:dst) is a hard stop; git mv -f onto a manifest is too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { classify } from '../lib/permission-rules.mjs';

const root = makeTmp('crux-main-highs2-');
const project = join(root, 'proj');
const tmp = join(root, 'tmp');
const home = join(root, 'home');
for (const d of [join(project, 'hub'), tmp, home]) mkdirSync(d, { recursive: true });
const D = 'C:/Users/me/Documents', DW = 'C:\\Users\\me\\Documents';

const at = (tool, command, extra = {}) => classify({ tool, input: { command }, projectDir: project, tmp, home, agent: 'builder', ...extra });
const why = r => `${r.route}: ${[...r.reasons, ...r.unsure].join('; ')}`;
const is = (route, tool, c, x) => { const r = at(tool, c, x); assert.equal(r.route, route, `${c}\n  -> ${why(r)}`); return r; };
const allow = (c, tool = 'Bash', x) => is('allow', tool, c, x);
const unsure = (c, tool = 'Bash', x) => is('unsure', tool, c, x);
const human = (c, tool = 'Bash', x) => is('human', tool, c, x);
const notAllow = (c, tool = 'Bash', x) => assert.notEqual(at(tool, c, x).route, 'allow', c);

test('round 2 HIGH 8: a quote escaped outside quotes, or inside a taken-out body, does not hide a marker or the lines after it', () => {
  human(`echo it\\'s '<<B'\nrm -rf ${D}\nB`);
  human(`cat <<A\nit's\nA\necho '<<B'\nrm -rf ${D}\nB`);
  human(`$a = @'\nit's\n'@\nWrite-Output '@'\nRemove-Item -Recurse -Force ${DW}\n'@'`, 'PowerShell');
  // a \' and a \" are plain characters, so the quote after them still opens
  human(`echo a\\"b "c\nrm -rf ${D}\n"`.replace('"c\n', '"c" \n'));
  // two heredocs: the second after one taken out is a doubt (the hub cannot be sure which markers open one)
  notAllow(`cat <<A\nx\nA\ncat <<B\ny\nB`);
  // the normal shapes still work
  allow(`git commit -m "$(cat <<'EOF'\nfix the thing\nEOF\n)"`.replace('git commit', 'echo'));
  allow(`cat <<'EOF'\nhello it's me\nEOF`);
  allow(`echo it\\'s fine`);
  allow(`echo "a \\" b"; ls`);
});

test('round 2 HIGH 9: a method named by a quoted string or a variable is a doubt', () => {
  unsure(`Get-Process | % { $_.'Kill'() }`, 'PowerShell');
  unsure(`Get-Process | % { $_."Kill"() }`, 'PowerShell');
  unsure(`$m='Kill'; Get-Process | % { $_.$m() }`, 'PowerShell');
  unsure(`$m = 'Delete'; [IO.File]::$m('x')`, 'PowerShell');
  // a plain method on a string is not made worse than before (no allow, as the review noted)
  notAllow(`"abc".ToUpper()`, 'PowerShell');
});

test('round 2 MEDIUM and LOW: more logins are secrets', () => {
  for (const c of [
    'cat ~/AppData/Roaming/GitHub CLI/hosts.yml',
    'cat "$HOME/AppData/Roaming/GitHub CLI/hosts.yml"',
    `cat "${home.replace(/\\/g, '/')}/AppData/Roaming/GitHub CLI/hosts.yml"`,
    'cat /proc/$$/environ',
    'cat /proc/$pid/environ',
    'cat /proc/self/environ',
    'cat /proc/1234/environ',
    'cd /proc/self && cat environ',
    'cat ~/.claude.json',
    'cat ~/AppData/Roaming/Code/User/globalStorage/state.vscdb',
    'cat "~/AppData/Local/Google/Chrome/User Data/Default/Login Data"',
  ]) human(c);
  human('Get-Content "$env:APPDATA\\GitHub CLI\\hosts.yml"', 'PowerShell');
  human('Get-Content $HOME\\.claude.json', 'PowerShell');
  // inside a substitution too
  human('echo $(cat ~/.claude.json)');
  human('echo $(cat "$HOME/AppData/Roaming/GitHub CLI/hosts.yml")');
});

test('round 2 item 7: git fetch or pull that writes a branch is a hard stop; git mv -f onto a manifest too', () => {
  for (const c of [
    'git fetch --update-head-ok . HEAD:main',
    'git fetch -u . +HEAD:refs/heads/main',
    'git fetch . HEAD:refs/remotes/origin/main',
    'git fetch origin main:main',
    'git pull -u . HEAD:main',
    'git update-ref refs/heads/main HEAD',
    'git branch -f main HEAD',
    'git mv -f x.json package.json',
    'git mv --force x.json hub/package.json',
    'git mv -f hub/package-lock.json x.json',
    'git mv -k -f x.json package.json',
  ]) human(c);
  allow('git fetch origin');
});
