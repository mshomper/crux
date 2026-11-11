// R005 follow-ups: agents' own temp folders, path and system variables, powershell -Command, and the per-project
// Auto / Ask switch (page beats the repo file beats the default).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classify } from '../lib/permission-rules.mjs';
import { HubSettings, projectKey } from '../lib/settings.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';

// Matt's machine, as in the card he got from f13ld.lab. Paths are only compared, never touched.
const HOME = 'C:\\Users\\mshom';
const TEMP = 'C:\\Users\\mshom\\AppData\\Local\\Temp';
const LAB = 'C:\\Users\\mshom\\Documents\\GitHub\\f13ld.lab';
const at = (tool, input, extra = {}) => classify({ tool, input, projectDir: LAB, tmp: TEMP, home: HOME, ...extra });
const bash = (command, extra) => at('Bash', { command }, extra).route;
const ps = (command, extra) => at('PowerShell', { command }, extra).route;

test('writes and edits in the system temp folder are contained, in every way of writing its path', () => {
  assert.equal(at('Write', { file_path: 'C:\\Users\\mshom\\AppData\\Local\\Temp\\lab-tidy\\mockup-c-e.svg', content: '<svg/>' }).route, 'allow');
  assert.equal(at('Edit', { file_path: 'C:\\Users\\mshom\\AppData\\Local\\Temp\\lab-tidy\\mockup-c-e.svg' }).route, 'allow');
  for (const c of [
    'echo x > /c/Users/mshom/AppData/Local/Temp/lab-tidy/mockup-c-e.svg', 'mkdir -p "$TEMP/lab-tidy"', 'cp a.svg "$TMP/lab-tidy/"',
    'touch /tmp/lab-tidy/x', 'mkdir -p "${TEMP}/lab-tidy"'
  ]) assert.equal(bash(c), 'allow', c);
  assert.equal(ps('New-Item -ItemType Directory "$env:TEMP\\lab-tidy"'), 'allow');
  assert.equal(ps('Set-Content -Path "$env:TEMP\\lab-tidy\\a.txt" -Value 1'), 'allow');
});

test('deleting temp folders: the agent\'s own are contained, others go to the orchestrator, temp itself is a hard stop', () => {
  const me = { agent: 'lab-tidy' };
  assert.equal(bash('rm -rf /c/Users/mshom/AppData/Local/Temp/lab-tidy', me), 'allow', 'its name is in the folder name');
  assert.equal(bash('rm -rf "$TEMP/crux-lab-tidy-shots"', me), 'allow');
  assert.equal(ps('Remove-Item -Recurse "$env:TEMP\\lab-tidy"', me), 'allow');
  assert.equal(bash('rm -rf /c/Users/mshom/AppData/Local/Temp/someone-else', me), 'unsure');
  assert.equal(bash('rm -rf /c/Users/mshom/AppData/Local/Temp/someone-else', { agent: 'lab-tidy', madeTemp: [join(TEMP, 'someone-else')] }), 'allow', 'one it made earlier');
  assert.equal(bash('rm -rf /c/Users/mshom/AppData/Local/Temp', me), 'human');
  assert.equal(bash('rm -rf "$TEMP"', me), 'human');
});

test('a temp folder an agent creates becomes its own to delete later (tracked by the hub)', async () => {
  Agent.prototype.send = function () { this.state = 'working'; };
  Agent.prototype.close = function () {};
  const root = mkdtempSync(join(tmpdir(), 'crux-temp-own-'));
  const dir = join(root, 'proj');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  writeFileSync(join(dir, '.crux-hub.json'), '{ "permissions": "auto" }');
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }) });
  const p = hub.project('proj');
  const w = hub.startWorker(p, 'builder', 'Build', 'you', 'Build');
  const fresh = join(tmpdir(), `crux-fresh-${Date.now()}`).replace(/\\/g, '/');
  hub.requestApproval(p, w, 'Bash', { command: `rm -rf "${fresh}"` });   // not its own yet: becomes a card
  assert.equal(p.log.ofType('approval').length, 1, 'not its own yet');
  assert.equal((await hub.requestApproval(p, w, 'Bash', { command: `mkdir -p "${fresh}/out"` })).behavior, 'allow');
  assert.equal((await hub.requestApproval(p, w, 'Bash', { command: `rm -rf "${fresh}"` })).behavior, 'allow', 'it made it');
}, { timeout: 2000 });

test('the exact command from the log: reading a shortcut and the hub\'s port is not a hard stop', () => {
  const cmd = String.raw`strings "$APPDATA/Microsoft/Windows/Start Menu/Programs/Startup/Crux Hub server.lnk" 2>/dev/null | head -20; echo ---; powershell -NoProfile -Command "\$s=(New-Object -ComObject WScript.Shell).CreateShortcut(\"\$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Crux Hub server.lnk\"); \$s.TargetPath; \$s.Arguments; \$s.WorkingDirectory; \$s.WindowStyle"; echo ---; powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 4747 -State Listen | Select-Object OwningProcess"`;
  const r = at('Bash', { command: cmd });
  assert.equal(r.route, 'allow', `${r.reasons.join('; ')} ${r.unsure.join('; ')}`);
  assert.equal(bash('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Select-Object ProcessId,ParentProcessId,CommandLine | Format-List"'), 'allow');
  assert.equal(ps('$c = Get-Command gh -ErrorAction SilentlyContinue; Test-Path "C:\\Program Files\\GitHub CLI\\gh.exe"; Test-Path "$env:LOCALAPPDATA\\GitHubDesktop"'), 'allow');
});

test('path and system variables are fine; secret-looking ones and dumping the environment are hard stops', () => {
  for (const c of ['echo $APPDATA', 'ls "$USERPROFILE/Documents"', 'echo $PATH', 'echo %COMPUTERNAME%', 'ls "$HOME"', 'echo $USERNAME $OS']) assert.equal(bash(c), 'allow', c);
  assert.equal(ps('Write-Output $env:APPDATA; $env:ProgramFiles; $env:LOCALAPPDATA'), 'allow');
  for (const c of ['echo $GITHUB_TOKEN', 'echo $ANTHROPIC_API_KEY', 'echo %NPM_AUTH%', 'printenv', 'env', 'echo $DB_PASSWORD']) assert.equal(bash(c), 'human', c);
  assert.equal(ps('Write-Output $env:GITHUB_TOKEN'), 'human');
  assert.equal(ps('Get-ChildItem env:'), 'human');
  assert.equal(bash('echo $SOME_THING'), 'unsure', 'a variable it does not know is for the orchestrator');
});

test('a shortcut that is saved writes a file: outside the project it is a hard stop', () => {
  const save = String.raw`$s=(New-Object -ComObject WScript.Shell).CreateShortcut("C:\Users\mshom\Desktop\evil.lnk"); $s.TargetPath="C:\x.exe"; $s.Save()`;
  assert.equal(ps(save), 'human');
  const inside = String.raw`$s=(New-Object -ComObject WScript.Shell).CreateShortcut("C:\Users\mshom\Documents\GitHub\f13ld.lab\x.lnk"); $s.Save()`;
  assert.notEqual(ps(inside), 'human');
  assert.equal(bash(String.raw`powershell -Command "\$s=(New-Object -ComObject WScript.Shell).CreateShortcut(\"\$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\x.lnk\"); \$s.Save()"`), 'human');
});

test('easy cases the hub now classifies itself: cygpath, env prefixes, test-hub POSTs, headless screenshots into temp', () => {
  assert.equal(bash('cygpath -w /c/Users/mshom/AppData/Local/Temp/x'), 'allow');
  assert.equal(bash('CRUX_HUB_DATA=/c/Users/mshom/AppData/Local/Temp/crux-x/data node server.mjs --port 4748 /c/Users/mshom/AppData/Local/Temp/crux-x/proj'), 'allow');
  assert.equal(bash('cd hub && CRUX_HUB_DATA="$TEMP/crux-x" node server.mjs --port 4750 "$TEMP/crux-x/proj"'), 'allow');
  assert.equal(bash('CRUX_HUB_DATA=/c/Users/mshom/AppData/Local/Temp/x node server.mjs'), 'human', 'no port: it would be 4747');
  assert.equal(bash('CRUX_HUB_PORT=4747 node server.mjs --port 4748'), 'human');
  assert.equal(bash('curl -s -X POST -H "content-type: application/json" -H "origin: http://localhost:4748" -d \'{"project":"proj","permissionMode":"auto"}\' localhost:4748/api/settings'), 'allow');
  assert.equal(bash('curl -s -X POST -H "origin: http://localhost:4747" -d \'{}\' localhost:4747/api/settings'), 'human');
  assert.equal(bash('curl -s -X POST -d x localhost/api'), 'human', 'no port named');
  assert.equal(bash('"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu --user-data-dir="C:/Users/mshom/AppData/Local/Temp/crux-x/edge" --window-size=1280,720 --screenshot="C:/Users/mshom/AppData/Local/Temp/crux-x/ask.png" "http://localhost:4748/"'), 'allow');
  assert.equal(bash('"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --screenshot="C:/Users/mshom/AppData/Local/Temp/crux-x/a.png" "file:///C:/Users/mshom/AppData/Local/Temp/crux-x/mock.html"'), 'allow');
  assert.equal(bash('"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --screenshot="C:/Users/mshom/Desktop/a.png" "http://localhost:4748/"'), 'human', 'a screenshot written outside');
});

test('Auto / Ask per project: the page beats the repo file, which beats the default', () => {
  Agent.prototype.send = function () { this.state = 'working'; };
  const root = mkdtempSync(join(tmpdir(), 'crux-mode-'));
  const dir = join(root, 'proj');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  const file = join(root, 'data', 'settings.json');
  const mk = () => new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file }) });
  let hub = mk(), p = hub.project('proj');
  assert.equal(hub.permissionMode(p), 'standard', 'default: Ask');
  writeFileSync(join(dir, '.crux-hub.json'), '{ "permissions": "auto" }');
  assert.equal(hub.permissionMode(p), 'auto', 'the repo file is the starting value');
  hub.setPermissionMode(p, 'standard');
  assert.equal(hub.permissionMode(p), 'standard', 'the page wins over the file');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.projects[projectKey(dir)].permissionMode, 'standard', 'kept in hub settings, keyed by project folder');
  hub = mk(); p = hub.project('proj');
  assert.equal(hub.permissionMode(p), 'standard', 'and it survives a restart');
  hub.setPermissionMode(p, 'auto');
  const ev = p.log.ofType('project_settings').at(-1);
  assert.equal(ev.permissionMode, 'auto');
  assert.equal(ev.thread, 'orchestrator');
  assert.ok(p.log.ofType('notice').some(n => n.thread === 'orchestrator' && /Auto/.test(n.text)), 'shown in the orchestrator thread');
  assert.equal(hub.state()[0].permissionMode, 'auto', 'the page sees the mode');
  assert.equal(projectKey('C:\\A\\B\\'), projectKey('c:/a/b'));
});
