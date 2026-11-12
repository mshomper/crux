// Stopping processes (R005): a filter that pins them to the agent's own temp folder or to a port other than 4747 is
// contained; a filter on some other temp path goes to the orchestrator; by name, by PID, or with no filter, or
// anything that could be the hub on 4747, is a hard stop. Plus the helper that stops a test hub by port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { classify } from '../lib/permission-rules.mjs';

const HOME = 'C:\\Users\\mshom';
const TEMP = 'C:\\Users\\mshom\\AppData\\Local\\Temp';
const CRUX = 'C:\\Users\\mshom\\Documents\\GitHub\\crux';
const WT = `${CRUX}\\.claude\\worktrees\\permission-stop`;
const at = (tool, command, extra = {}) => classify({ tool, input: { command }, projectDir: WT, tmp: TEMP, home: HOME, agent: 'phone-agent', ...extra });
const ps = (c, x) => at('PowerShell', c, x);
const sh = (c, x) => at('Bash', c, x);
const mine = { madeTemp: [join(TEMP, 'crux-phone')] };
const why = r => `${r.route}: ${[...r.reasons, ...r.unsure].join('; ')}`;

// The exact command from Matt's card.
const CARD = `Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*crux-phone*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "stopped $($_.ProcessId) $($_.Name)" }; "checked"`;

test('the exact command from the card: filtered to a temp folder this agent made, it is contained', () => {
  const r = ps(CARD, mine);
  assert.equal(r.route, 'allow', why(r));
  assert.equal(ps(CARD).route, 'unsure', 'a bare name the hub cannot tie to this agent: for the orchestrator');
});

test('contained: a filter on the agent\'s own temp folder or on a port other than 4747', () => {
  const own = (c, x = mine) => { const r = ps(c, x); assert.equal(r.route, 'allow', `${c}\n${why(r)}`); };
  own(String.raw`Get-Process | Where-Object { $_.Path -like '*\Temp\crux-phone\*' } | ForEach-Object { Stop-Process -Id $_.Id }`);
  own(String.raw`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$env:TEMP\crux-phone*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
  own(String.raw`Get-CimInstance Win32_Process -Filter "CommandLine like '%\Temp\crux-phone\%'" | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`);
  own(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*phone-agent-x*' } | ForEach-Object { Stop-Process -Id $_.ProcessId }`, {});   // the agent's name is in it
  own('Get-NetTCPConnection -LocalPort 4752 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }', {});
  own('Get-NetTCPConnection -LocalPort 4752,4753 | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ }', {});
  own(String.raw`node hub/tools/stop-test-hub.mjs 4752`, {});
  assert.equal(sh('node hub/tools/stop-test-hub.mjs 4756').route, 'allow');
  assert.equal(sh(`node -e "import('./hub/lib/relaunch.mjs').then(async m => { for (const p of await m.pidsOnPort(4752)) await m.stopTree(p) })"`).route, 'allow');
});

test('unsure: a filter that clearly excludes the hub but is not this agent\'s own temp folder', () => {
  const r = ps(String.raw`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*\Temp\someone-else\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId }`, mine);
  assert.equal(r.route, 'unsure', why(r));
  assert.equal(ps(String.raw`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*\Temp\crux-phone\*' -and $_.CommandLine -like '*\Temp\other\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId }`, mine).route, 'unsure');
});

test('hard stops: unfiltered, by name, by PID, the hub\'s own port or folder', () => {
  const human = (t, c, x = mine) => { const r = at(t, c, x); assert.equal(r.route, 'human', `${c}\n${why(r)}`); };
  for (const c of [
    'Stop-Process -Name node -Force', 'Get-Process node | Stop-Process', 'Get-Process -Name node | Stop-Process -Force', 'Stop-Process -Id 1234',
    'taskkill /IM node.exe /F', 'taskkill /PID 1234 /F', 'taskkill /F /IM msedge.exe',
    'Get-NetTCPConnection -LocalPort 4747 | ForEach-Object { Stop-Process -Id $_.OwningProcess }',
    'Get-NetTCPConnection -LocalPort 4752,4747 | ForEach-Object { Stop-Process -Id $_.OwningProcess }',
    'Get-NetTCPConnection -LocalPort 4752 | ForEach-Object { Stop-Process -Name node }',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*4747*' } | ForEach-Object { Stop-Process -Id $_.ProcessId }`,
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*server.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId }`,
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*node*' } | ForEach-Object { Stop-Process -Id $_.ProcessId }`,
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*crux*' } | ForEach-Object { Stop-Process -Id $_.ProcessId }`,
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*\\GitHub\\crux\\hub\\server.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId }`,
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*crux-phone*' -or $_.Name -eq 'node.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId }`,
    String.raw`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*\Temp\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId }`,
    'Get-NetTCPConnection -LocalPort 4752 | ForEach-Object { Stop-Process -Id 1234 }'
  ]) human('PowerShell', c);
  for (const c of ['kill 1234', 'kill -9 1234', 'killall node', 'pkill node', 'pkill -f server.mjs', 'taskkill /IM node.exe', 'node hub/tools/stop-test-hub.mjs 4747',
    'node hub/tools/stop-test-hub.mjs', 'node hub/restart.mjs', `node -e "import('./hub/lib/relaunch.mjs').then(async m => { for (const p of await m.pidsOnPort(4747)) await m.stopTree(p) })"`]) human('Bash', c);
  assert.equal(sh('node hub/restart.mjs --port 4752 --no-open').route, 'allow', 'restarting a test hub is fine');
});

test('hub/tools/stop-test-hub.mjs stops only the port it is given and refuses 4747', async () => {
  const tool = join(fileURLToPath(new URL('../tools/stop-test-hub.mjs', import.meta.url)));
  const refused = (() => { try { execFileSync(process.execPath, [tool, '4747'], { stdio: 'pipe' }); return false; } catch (e) { return e.status === 2; } })();
  assert.ok(refused, 'refuses 4747 without looking at what listens there');
  const free = await new Promise(r => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${free}, '127.0.0.1'); setInterval(() => {}, 1000)`], { stdio: 'ignore' });
  const up = async () => new Promise(r => { const s = createServer(); s.once('error', () => r(true)); s.once('listening', () => s.close(() => r(false))); s.listen(free, '127.0.0.1'); });
  for (let i = 0; i < 40 && !(await up()); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(await up(), 'the stand-in hub is listening');
  const out = execFileSync(process.execPath, [tool, String(free)], { encoding: 'utf8' });
  assert.match(out, /Stopped process/);
  for (let i = 0; i < 40 && await up(); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(!(await up()), 'the port is free again');
  child.kill();
}, { timeout: 20000 });
