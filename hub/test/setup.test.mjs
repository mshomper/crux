// The desktop app's first run (decisions 52 and 54): the saved API key, the project folders, and the Claude Code
// download (picked out of Anthropic's package as it streams, checked against the SDK's checksum). Nothing here reaches
// the network: the download is fed a package built in memory. One test starts a throwaway test hub on port 4796.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { Secrets, KEY_SHAPE, keyEnd, checkFolders, saveProjects, readHubConfig, checkKey } from '../lib/setup.mjs';
import { TarPick, ClaudeDownload, resolveClaude, claudeReady, downloadedPath, installedBinary, expected } from '../lib/claude-code.mjs';
import { HUB_DIR } from '../lib/relaunch.mjs';

const temp = p => mkdtempSync(join(tmpdir(), p));
const KEY = 'sk-ant-api03-' + 'a'.repeat(40) + 'WXYZ';

// A tar with the given files, as npm packs them (package/<name>).
function tar(files) {
  const blocks = [];
  for (const [name, data] of Object.entries(files)) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 'utf8');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
const fakeExp = (bin, dir) => ({ sdkDir: join(dir, 'sdk'), sdkVersion: '0.0.1', version: '9.9.9', platform: 'win32-x64', binary: 'claude.exe', checksum: createHash('sha256').update(bin).digest('hex'), size: bin.length, pkg: '@anthropic-ai/claude-agent-sdk-win32-x64', url: 'https://registry.example/pkg.tgz' });
const fakeFetch = body => async () => new Response(new Blob([body]).stream(), { status: 200, headers: { 'content-length': String(body.length) } });
const until = async (f, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await new Promise(r => setTimeout(r, 20)); } return f(); };

test('the tar reader keeps only the named entry, across any chunk boundaries', async () => {
  const bin = Buffer.from('x'.repeat(1300) + 'END');
  const t = tar({ 'package/README.md': Buffer.from('hello'), 'package/claude.exe': bin, 'package/LICENSE.md': Buffer.from('(c)') });
  for (const size of [1, 7, 511, 512, 4096]) {
    const got = [];
    const pick = new TarPick('package/claude.exe', b => got.push(Buffer.from(b)));
    for (let i = 0; i < t.length; i += size) await new Promise((res, rej) => pick.write(t.subarray(i, i + size), e => e ? rej(e) : res()));
    assert.ok(pick.found, `found with ${size}-byte chunks`);
    assert.deepEqual(Buffer.concat(got), bin, `same bytes with ${size}-byte chunks`);
  }
});

test('the download keeps the program only when its checksum matches, in the hub data folder, never half-written', async () => {
  const dir = temp('crux-cc-'), env = { CRUX_HUB_DATA: join(dir, 'data') };
  try {
    const bin = Buffer.from('MZ' + 'claude'.repeat(500));
    const pkg = gzipSync(tar({ 'package/claude.exe': bin }));
    const exp = fakeExp(bin, dir);
    const d = new ClaudeDownload({ env, exp, fetchFn: fakeFetch(pkg) });
    await d.start();
    await until(() => ['done', 'error'].includes(d.state().state));
    assert.equal(d.state().state, 'done', d.state().error);
    assert.equal(d.state().received, pkg.length, 'progress counts the package bytes');
    const dest = downloadedPath(exp, env);
    assert.ok(dest.startsWith(env.CRUX_HUB_DATA) && dest.includes(join('claude-code', '9.9.9')), 'kept per version in the data folder');
    assert.deepEqual(readFileSync(dest), bin);
    assert.equal(resolveClaude({ env, exp }).source, 'downloaded');
    assert.equal(resolveClaude({ env, exp }).path, dest);

    // A package whose program does not match: nothing kept, a plain error.
    const env2 = { CRUX_HUB_DATA: join(dir, 'data2') };
    const bad = new ClaudeDownload({ env: env2, exp, fetchFn: fakeFetch(gzipSync(tar({ 'package/claude.exe': Buffer.from('MZtampered') }))) });
    await bad.start();
    await until(() => bad.state().state === 'error');
    assert.match(bad.state().error, /checksum/);
    assert.ok(!existsSync(downloadedPath(exp, env2)) && !existsSync(downloadedPath(exp, env2) + '.part'));

    // No network: says what to do.
    const off = new ClaudeDownload({ env: env2, exp, fetchFn: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
    await off.start();
    await until(() => off.state().state === 'error');
    assert.match(off.state().error, /internet connection/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a copy already on the PC, or an earlier download, stands in only while the download cannot be reached (decision 54 B)', async () => {
  const dir = temp('crux-cc-fallback-'), env = { CRUX_HUB_DATA: join(dir, 'data'), PATH: '' };
  try {
    const bin = Buffer.from('MZ' + 'new'.repeat(300));
    const exp = fakeExp(bin, dir);
    // An earlier version's download is there; the exact one is not.
    mkdirSync(join(env.CRUX_HUB_DATA, 'claude-code', '9.9.8'), { recursive: true });
    writeFileSync(join(env.CRUX_HUB_DATA, 'claude-code', '9.9.8', 'claude.exe'), 'MZold');
    const cc = resolveClaude({ env, exp });
    assert.equal(cc.source, 'previous');
    assert.equal(claudeReady(cc, { state: 'idle' }), false, 'online: the exact version is needed before Start');
    assert.equal(claudeReady(cc, { state: 'error', offline: false }), false, 'a checksum failure is not "offline"');
    assert.equal(claudeReady(cc, { state: 'error', offline: true }), true, 'offline: the earlier copy stands in');
    assert.equal(claudeReady({ source: null }, { state: 'error', offline: true }), false, 'nothing to stand in');
    assert.equal(claudeReady({ source: 'installed', path: 'x' }, { state: 'idle' }), false);
    // The download that cannot be reached says so.
    const off = new ClaudeDownload({ env, exp, fetchFn: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
    await off.start(); await until(() => off.state().state === 'error');
    assert.equal(off.state().offline, true);
    // Once the exact version is in, earlier ones go.
    const ok = new ClaudeDownload({ env, exp, fetchFn: fakeFetch(gzipSync(tar({ 'package/claude.exe': bin }))) });
    await ok.start(); await until(() => ok.state().state === 'done');
    assert.equal(resolveClaude({ env, exp }).source, 'downloaded');
    assert.ok(!existsSync(join(env.CRUX_HUB_DATA, 'claude-code', '9.9.8')), 'the earlier version was removed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the SDK manifest names the program, its size and checksum, and the package it comes from', () => {
  const exp = expected();
  assert.ok(exp, 'the hub SDK is installed');
  assert.match(exp.checksum, /^[0-9a-f]{64}$/);
  assert.ok(exp.size > 1e7);
  assert.equal(exp.url, `https://registry.npmjs.org/${exp.pkg}/-/${exp.pkg.split('/')[1]}-${exp.sdkVersion}.tgz`);
});

test('an installed Claude Code is found in the usual Windows places, and only when there', () => {
  if (process.platform !== 'win32') return;
  const home = 'C:/Users/u';
  assert.equal(installedBinary({ env: { PATH: '' }, home, exists: f => f.replace(/\\/g, '/') === 'C:/Users/u/.local/bin/claude.exe' }).replace(/\\/g, '/'), 'C:/Users/u/.local/bin/claude.exe');
  assert.equal(installedBinary({ env: { PATH: 'C:/tools' }, home, exists: f => f.replace(/\\/g, '/') === 'C:/tools/claude.exe' }).replace(/\\/g, '/'), 'C:/tools/claude.exe');
  assert.equal(installedBinary({ env: { PATH: 'C:/tools' }, home, exists: () => false }), null);
});

test('the key is shape-checked, kept in secrets.json in the hub data folder, and applied unless the environment has one', () => {
  const dir = temp('crux-key-');
  try {
    const env = { CRUX_HUB_DATA: dir };
    const s = new Secrets({ env });
    assert.throws(() => s.save('hello'), /sk-ant-/);
    assert.ok(KEY_SHAPE.test(KEY));
    s.save(`  ${KEY}\n`);
    assert.equal(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')).anthropicApiKey, KEY);
    assert.ok(!existsSync(join(dir, 'settings.json')), 'never in the hub settings');
    assert.equal(keyEnd(KEY), 'WXYZ');
    const agentEnv = {};
    assert.equal(s.apply(agentEnv), 'saved');
    assert.equal(agentEnv.ANTHROPIC_API_KEY, KEY);
    assert.equal(agentEnv.CRUX_HUB_USE_API_KEY, '1');
    const own = { ANTHROPIC_API_KEY: 'sk-ant-own', CRUX_HUB_USE_API_KEY: '1' };
    assert.equal(s.apply(own), 'environment');
    assert.equal(own.ANTHROPIC_API_KEY, 'sk-ant-own', 'a key set in the environment wins');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('checking the key with Anthropic: refused, accepted, or unchecked when it cannot be reached', async () => {
  assert.equal(await checkKey(KEY, { fetchFn: async () => new Response('{}', { status: 401 }) }), 'refused');
  assert.equal(await checkKey(KEY, { fetchFn: async () => new Response('{}', { status: 200 }) }), 'ok');
  assert.equal(await checkKey(KEY, { fetchFn: async () => { throw new TypeError('fetch failed'); } }), 'unchecked');
});

test('folders must exist and be full paths; saving keeps the rest of hub.json', () => {
  const dir = temp('crux-folders-');
  try {
    const a = join(dir, 'a'); mkdirSync(a);
    const { folders, problems } = checkFolders([a, `"${a}"`, 'relative/path', join(dir, 'missing'), '']);
    assert.deepEqual(folders, [a], 'quotes trimmed, duplicates dropped');
    assert.equal(problems.length, 2);
    assert.match(problems[0], /full path/);
    assert.match(problems[1], /no such folder/);
    const cfg = join(dir, 'home', 'hub.json');
    mkdirSync(join(dir, 'home'));
    writeFileSync(cfg, JSON.stringify({ app: { port: 4791 }, defaults: { worker: { model: 'sonnet' } } }));
    saveProjects(folders, cfg);
    const after = readHubConfig(cfg);
    assert.deepEqual(after.projects, [a.replace(/\\/g, '/')]);
    assert.deepEqual(after.app, { port: 4791 });
    assert.deepEqual(after.defaults, { worker: { model: 'sonnet' } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A throwaway test hub on a port of its own (never 4747), with its data and home in the temp folder.
async function startHub(port, dir, { env = {}, args = [] } = {}) {
  const child = spawn(process.execPath, [join(HUB_DIR, 'server.mjs'), '--port', String(port), '--no-agents', ...args], {
    env: { ...process.env, CRUX_HUB_DATA: join(dir, 'data'), CRUX_HOME: join(dir, 'home'), ANTHROPIC_API_KEY: '', CRUX_HUB_USE_API_KEY: '', CRUX_HUB_BUNDLED: '', ...env }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let err = ''; child.stderr.on('data', c => { err += c; });
  const call = (method, path, { body, extra = {} } = {}) => new Promise((ok, bad) => {
    const host = `localhost:${port}`, payload = body ? JSON.stringify(body) : null;
    const headers = { host, ...(payload ? { 'content-type': 'application/json', origin: `http://${host}`, 'content-length': Buffer.byteLength(payload) } : {}), ...extra };
    const r = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      const parts = []; res.on('data', x => parts.push(x));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { } ok({ status: res.statusCode, json }); });
    });
    r.on('error', bad); if (payload) r.write(payload); r.end();
  });
  let up = false;
  for (let i = 0; i < 75 && !up; i++) { up = (await call('GET', '/api/ping').catch(() => null))?.status === 200; if (!up) await new Promise(r => setTimeout(r, 200)); }
  const stop = async () => { child.kill(); await new Promise(r => child.once('exit', r)); };
  if (!up) { await stop(); throw new Error(`the test hub did not start: ${err}`); }
  return { call, stop };
}

test('a hub run from a clone never takes up a saved key: it stays on its own login', async () => {
  const dir = temp('crux-clone-key-'), port = 4797;
  try {
    mkdirSync(join(dir, 'data')); mkdirSync(join(dir, 'proj'));
    writeFileSync(join(dir, 'data', 'secrets.json'), JSON.stringify({ anthropicApiKey: KEY }));
    const { call, stop } = await startHub(port, dir, { args: [join(dir, 'proj')] });
    try {
      const s = (await call('GET', '/api/setup')).json;
      assert.equal(s.bundled, false);
      assert.equal(s.key.saved, false, 'the saved key was not applied');
      assert.equal(s.needed, false, 'and no setup screen');
      assert.equal((await call('POST', '/api/setup/key', { body: { apiKey: KEY } })).status, 404, 'nor can one be set on it');
    } finally { await stop(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a test hub playing the desktop app starts with no project, asks for setup, and takes the key from this PC only', async () => {
  const dir = temp('crux-setup-hub-'), port = 4796;
  mkdirSync(join(dir, 'home')); writeFileSync(join(dir, 'home', 'hub.json'), '{}');
  const { call, stop } = await startHub(port, dir, { env: { CRUX_HUB_BUNDLED: '1' } });
  try {
    const s = (await call('GET', '/api/setup')).json;
    assert.equal(s.bundled, true);
    assert.equal(s.needed, true);
    assert.deepEqual(s.folders, []);
    assert.equal(s.key.saved, false);
    assert.equal((await call('GET', '/api/state')).json.setup.needed, true, 'the page learns it from the state too');
    assert.equal((await call('POST', '/api/setup/key', { body: { apiKey: 'nope' } })).status, 400);
    const saved = await call('POST', '/api/setup/key', { body: { apiKey: KEY } });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.check, 'unchecked', 'a test hub never calls Anthropic');
    assert.equal(saved.json.setup.key.end, 'WXYZ');
    assert.ok(!JSON.stringify(saved.json).includes(KEY), 'the key never comes back');
    assert.equal(JSON.parse(readFileSync(join(dir, 'data', 'secrets.json'), 'utf8')).anthropicApiKey, KEY);
    // From anywhere but this PC (a request carrying a proxy header, as Tailscale sends): refused.
    const remote = (await call('GET', '/api/setup', { extra: { 'x-forwarded-for': '100.64.0.2' } })).json;
    assert.equal((await call('POST', '/api/setup/key', { body: { apiKey: KEY }, extra: { 'x-forwarded-for': '100.64.0.2' } })).status >= 400, true, 'no key from a remote device');
    assert.equal(remote.local, false);
    assert.equal(remote.key.end, '', 'the last four only to this PC');
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
