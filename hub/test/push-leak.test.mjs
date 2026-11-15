// Only the live hub (port 4747) may use the real ~/.crux-hub (its push key and the phones' subscriptions). A hub on any
// other port with no CRUX_HUB_DATA of its own gets a throwaway folder, so it can never push to a phone or write the
// real settings. Everything here is stubs or a fake home in the temp folder: the real ~/.crux-hub is never touched,
// and no hub is started on 4747.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeTmp, removeTmp } from './helpers/tmp.mjs';
import { isolateNonLiveData, dataDir, inTemp } from '../lib/relaunch.mjs';

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

test('another port with no data folder gets a fresh folder, and the env now points at it', () => {
  const env = {}, made = [];
  const dir = isolateNonLiveData({ port: 4791, env, tmp: 'T', make: p => { made.push(p); return p + 'abc'; } });
  assert.equal(dir, env.CRUX_HUB_DATA);
  assert.ok(made[0].includes('crux-hub-data-'));
  assert.notEqual(dataDir(env), join(homedir(), '.crux-hub'), 'the default folder is no longer the real one');
});

test('a port that is not a number is treated as not live', () => {
  const env = {};
  assert.ok(isolateNonLiveData({ port: NaN, env, make: p => p + 'z' }));
  assert.ok(env.CRUX_HUB_DATA);
});

test('the live hub (4747) keeps the real folder when it has no data folder of its own', () => {
  const env = {};
  assert.equal(isolateNonLiveData({ port: 4747, env, make: () => { throw new Error('must not make a folder'); } }), '');
  assert.equal(env.CRUX_HUB_DATA, undefined);
  assert.equal(dataDir(env), join(homedir(), '.crux-hub'), 'npm start, the app and restart_hub all find it');
});

test('a hub given its own data folder keeps it, on any port', () => {
  for (const port of [4747, 4791]) {
    const env = { CRUX_HUB_DATA: '/somewhere/data' };
    assert.equal(isolateNonLiveData({ port, env, make: () => { throw new Error('no'); } }), '');
    assert.equal(env.CRUX_HUB_DATA, '/somewhere/data');
  }
});

test('the folder the helper makes really exists, inside the given temp folder', () => {
  const root = makeTmp('crux-push-leak-');
  try {
    const env = {};
    const dir = isolateNonLiveData({ port: 4791, env, tmp: root });
    assert.ok(inTemp(dir, root) && existsSync(dir));
  } finally { removeTmp(root); }
});

test('server.mjs asks for the isolation before it builds Push, settings, secrets or the guard', () => {
  const src = readFileSync(join(HUB, 'server.mjs'), 'utf8');
  const at = src.indexOf('isolateNonLiveData({ port })');
  assert.ok(at > 0);
  for (const s of ['new Secrets()', 'new HubSettings(', 'new Push()', 'new Guard(']) assert.ok(src.indexOf(s) > at, s);
});

test('a real hub on another port with no CRUX_HUB_DATA never touches the (fake) home folder', async () => {
  const root = makeTmp('crux-push-leak-http-');
  const port = await freePort();
  assert.notEqual(port, 4747);
  const home = join(root, 'home'), real = join(home, '.crux-hub'), proj = join(root, 'proj');
  for (const d of [real, join(proj, '.crux'), join(root, 'crux')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(real, 'settings.json'), '{"retireAt":42}');
  const env = { ...process.env, CRUX_HOME: join(root, 'crux'), USERPROFILE: home, HOME: home, CRUX_HUB_PORT: '', CRUX_HUB_RESTARTED: '', CRUX_HUB_AGENTS: '0' };
  delete env.CRUX_HUB_DATA;
  let out = '';
  const child = spawn(process.execPath, [join(HUB, 'server.mjs'), '--port', String(port), '--no-agents', proj], { cwd: HUB, windowsHide: true, env });
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  try {
    for (let i = 0; i < 100 && !out.includes('Crux hub: http'); i++) await sleep(100);
    assert.ok(out.includes(`Crux hub: http://127.0.0.1:${port}`), `the hub started:\n${out}`);
    assert.match(out, /not the live hub: its data folder is /);
    const own = /its data folder is (.+?) \(/.exec(out)?.[1];
    assert.ok(own && inTemp(own, tmpdir()) && !own.startsWith(home), 'a fresh folder in the temp folder');
    assert.deepEqual(readdirSync(real), ['settings.json'], 'nothing new in the home folder');
    assert.equal(readFileSync(join(real, 'settings.json'), 'utf8'), '{"retireAt":42}', 'and the settings are unchanged');
  } finally {
    try { child.kill(); } catch { }
    await sleep(300);
    // A killed hub cannot run its own clean-up; remove the throwaway data folder it announced (checked to be in temp).
    const own = /its data folder is (.+?) \(/.exec(out)?.[1];
    if (own && inTemp(own, tmpdir()) && own.includes('crux-hub-data-')) rmSync(own, { recursive: true, force: true });
    removeTmp(root);
  }
});
