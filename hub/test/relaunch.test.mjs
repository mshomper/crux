// One-click restart (M010): how a hub is started again the same way, detached and with no window, and how the
// restart script finds what holds the port. Nothing here starts or stops a real hub; that is checked by hand
// on a test hub (port 4752), never on 4747.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { testHubFolderError, launchSpec, saveLaunch, readLaunch, startDetached, listeningPids, openApp, launchFile, logFile, HUB_DIR } from '../lib/relaunch.mjs';

const tempData = () => ({ CRUX_HUB_DATA: mkdtempSync(join(tmpdir(), 'crux-hub-data-')) });

test('a hub is started again with the same node, flags, script, projects and folder', () => {
  const spec = launchSpec({ port: 4752, execPath: 'C:/node/node.exe', execArgv: ['--no-warnings'], argv: ['C:/node/node.exe', 'C:/hub/server.mjs', '--port', '4752', 'C:/proj'], cwd: 'C:/hub' });
  assert.deepEqual(spec, { port: 4752, node: 'C:/node/node.exe', args: ['--no-warnings', 'C:/hub/server.mjs', '--port', '4752', 'C:/proj'], cwd: 'C:/hub' });
  const env = tempData();
  saveLaunch(spec, env);
  assert.ok(existsSync(launchFile(4752, env)));
  assert.ok(launchFile(4752, env).startsWith(env.CRUX_HUB_DATA), 'kept in the hub data folder, outside the repo');
  assert.deepEqual(readLaunch(4752, env), spec);
  assert.ok(!existsSync(launchFile(4747, env)), 'one file per port, so a test hub never replaces the main one');
});

test('a test hub refuses to start without project folders, and a normal start is unchanged', async () => {
  assert.match(testHubFolderError({ noAgents: true, folders: [] }), /refused/);
  assert.equal(testHubFolderError({ noAgents: true, folders: ['C:/tmp/p'] }), '');
  assert.equal(testHubFolderError({ noAgents: false, folders: [] }), '', 'the live hub still falls back to hub.json');
  // The real script, in a temp data folder (a test hub), with no folders: it exits at once, before any port or log.
  const home = mkdtempSync(join(tmpdir(), 'crux-guard-'));
  try {
    const r = spawnSync(process.execPath, [join(HUB_DIR, 'server.mjs'), '--port', '4799', '--no-agents'], { env: { ...process.env, CRUX_HUB_DATA: join(home, 'data'), CRUX_HOME: join(home, 'home') }, encoding: 'utf8', timeout: 20000 });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Test hub refused/);
    assert.ok(!existsSync(join(home, 'data')), 'nothing written');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('with nothing saved, the script starts node server.mjs in the hub folder', () => {
  const env = tempData();
  const plain = readLaunch(4747, env);
  assert.deepEqual(plain.args, [join(HUB_DIR, 'server.mjs')]);
  assert.equal(plain.cwd, HUB_DIR);
  assert.deepEqual(readLaunch(4752, env).args.slice(1), ['--port', '4752'], 'another port is passed on');
});

test('the new hub runs detached, with no window, output to a log, and told to wait for the port', () => {
  const env = { ...tempData(), PATH: process.env.PATH };
  const calls = [];
  const fake = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() { this.unrefd = true; } }; };
  const child = startDetached({ port: 4752, node: 'node', args: ['server.mjs'], cwd: 'C:/hub' }, { env, spawnFn: fake });
  const [{ cmd, args, opts }] = calls;
  assert.equal(cmd, 'node');
  assert.deepEqual(args, ['server.mjs']);
  assert.equal(opts.cwd, 'C:/hub');
  assert.equal(opts.detached, true);
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.env.CRUX_HUB_RESTARTED, '1');
  assert.equal(opts.env.PATH, process.env.PATH, 'same environment otherwise');
  assert.equal(opts.stdio[0], 'ignore');
  assert.equal(typeof opts.stdio[1], 'number', 'output goes to the log file');
  assert.ok(existsSync(logFile(4752, env)));
  assert.ok(child.unrefd, 'this process may exit without waiting for it');
});

test('what listens on a port, from netstat, in any Windows language', () => {
  const netstat = [
    'Active Connections', '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:4747         0.0.0.0:0              LISTENING       2820',
    '  TCP    127.0.0.1:4752         0.0.0.0:0              ABHÖREN         9100',
    '  TCP    [::1]:4752             [::]:0                 LISTENING       9100',
    '  TCP    127.0.0.1:4752         127.0.0.1:55012        ESTABLISHED     9100',
    '  TCP    127.0.0.1:55012        127.0.0.1:4752         ESTABLISHED     7777',
    '  TCP    0.0.0.0:47520          0.0.0.0:0              LISTENING       5555',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       0'
  ].join('\r\n');
  assert.deepEqual(listeningPids(netstat, 4752), [9100]);
  assert.deepEqual(listeningPids(netstat, 4747), [2820]);
  assert.deepEqual(listeningPids(netstat, 4800), []);
  assert.deepEqual(listeningPids(netstat, 135), [], 'pid 0 is the system, never stopped');
});

test('the app opens in the default browser', () => {
  const calls = [];
  openApp('http://localhost:4747/', { spawnFn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() { } }; } });
  const [{ cmd, args, opts }] = calls;
  if (process.platform === 'win32') {
    assert.equal(cmd, 'cmd.exe');
    assert.deepEqual(args, ['/d', '/c', 'start', '', 'http://localhost:4747/'], 'an empty title, then the address');
  } else assert.deepEqual(args, ['http://localhost:4747/']);
  assert.equal(opts.windowsHide, true);
});

test('the restart script and its no-window launcher are in the hub folder', () => {
  const vbs = readFileSync(join(HUB_DIR, 'Restart Crux Hub.vbs'), 'utf8');
  assert.match(vbs, /sh\.Run\("node """ & here & "\\restart\.mjs""" & extra, 0, True\)/, 'runs restart.mjs hidden (window style 0) and waits');
  assert.match(readFileSync(join(HUB_DIR, 'restart.mjs'), 'utf8'), /pidsOnPort[\s\S]*stopTree[\s\S]*readLaunch[\s\S]*startDetached[\s\S]*openApp/);
});
