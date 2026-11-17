// The Account card (decision 78 A): the account the agents run on, and the key kept with Windows' per-user protection.
// Only fake keys and temp folders here; the real sign-in and real keys are never touched. Two tests start a throwaway test
// hub (ports 4794 and 4795, --no-agents, data and home in the temp folder); neither switches anything, so nothing restarts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { makeTmp, removeTmp } from './helpers/tmp.mjs';
import { Account, defaultProtector, planName, openSignInWindow, ENV_WINS } from '../lib/account.mjs';
import { Secrets } from '../lib/setup.mjs';
import { HUB_DIR } from '../lib/relaunch.mjs';
import { accountLine, accountCard, switchState } from '../public/account.js';
import { panelHtml, accountBlock } from '../public/usage-ui.js';

const KEY = 'sk-ant-api03-' + 'f'.repeat(40) + 'a1b2';   // obviously fake
const fake = { scheme: 'fake', protect: s => 'sealed:' + [...s].reverse().join(''), unprotect: d => [...d.slice(7)].reverse().join('') };
const win = process.platform === 'win32';

test('the key goes to PowerShell on its standard input, never on the command line; no protector off Windows', () => {
  assert.equal(defaultProtector({ platform: 'linux' }), null);
  assert.equal(defaultProtector({ platform: 'darwin' }), null);
  const calls = [];
  const p = defaultProtector({ platform: 'win32', run: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return 'AAAA'; } });
  assert.equal(p.protect(KEY), 'AAAA');
  assert.equal(calls[0].opts.input, KEY);
  assert.ok(!JSON.stringify(calls[0].args).includes(KEY), 'not in the arguments');
  assert.match(calls[0].args.join(' '), /CurrentUser/);
});

test('Windows really seals and opens a fake key for this user (Windows only)', { skip: !win && 'needs Windows' }, () => {
  const p = defaultProtector();
  const sealed = p.protect(KEY);
  assert.ok(sealed.length > 40 && !sealed.includes(KEY) && !sealed.includes('a1b2'));
  assert.equal(p.unprotect(sealed), KEY);
});

test('who is signed in comes from Claude Code\'s own file, name first, email as the fallback, nothing else read', () => {
  const dir = makeTmp('crux-acct-name-');
  try {
    const env = { CLAUDE_CONFIG_DIR: dir };
    assert.equal(planName(env), null, 'no file: nobody known');
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { displayName: 'Alex Doe', emailAddress: 'alex@example.invalid' }, projects: { x: 1 } }));
    assert.equal(planName(env), 'Alex Doe');
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'sam@example.invalid', extra: 'a much longer file than before so the size changes' } }));
    assert.equal(planName(env), 'sam@example.invalid', 'a changed file is read again');
    writeFileSync(join(dir, '.claude.json'), '{ not json');
    assert.equal(planName(env), null);
  } finally { removeTmp(dir); }
});

test('at start: the environment wins; a saved key is used only when API key is chosen; a restart does not carry it over', () => {
  const dir = makeTmp('crux-acct-');
  try {
    const mk = env => { const secrets = new Secrets({ env: { CRUX_HUB_DATA: dir }, protector: fake }); return { env, secrets, a: new Account({ env, secrets, file: join(dir, 'account.json'), platform: 'win32' }) }; };   // always a file of its own: never the real data folder
    // nothing chosen: plan, even with a key saved (a clone never takes up a saved key on its own)
    let t = mk({ PATH: 'x' }); t.secrets.save(KEY);
    assert.equal(t.a.applyAtStart(), null); assert.equal(t.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(t.a.view().mode, 'plan'); assert.equal(t.a.view().savedEnd, 'a1b2');
    // chosen: the same two variables the environment route sets
    t.a.chooseKey(); assert.equal(t.a.mode, 'key');
    t = mk({ PATH: 'x' });
    assert.equal(t.a.applyAtStart(), 'saved');
    assert.equal(t.env.ANTHROPIC_API_KEY, KEY); assert.equal(t.env.CRUX_HUB_USE_API_KEY, '1');
    const v = t.a.view();
    assert.deepEqual([v.mode, v.source, v.keyEnd, v.envLocked], ['key', 'saved', 'a1b2', false]);
    assert.ok(!JSON.stringify(v).includes(KEY) && !JSON.stringify(v).includes('ffff'), 'the page only ever gets the last four');
    // the next hub starts from what this one started with: without the key it added
    const next = t.a.restartEnv(); assert.equal(next.ANTHROPIC_API_KEY, undefined); assert.equal(next.CRUX_HUB_USE_API_KEY, undefined); assert.equal(next.PATH, 'x');
    // plan chosen: the next start does not use the key
    t.a.choosePlan(); t = mk({ PATH: 'x' }); assert.equal(t.a.applyAtStart(), null); assert.equal(t.env.ANTHROPIC_API_KEY, undefined);
    // an environment key wins, and the card cannot switch under it
    t = mk({ ANTHROPIC_API_KEY: 'sk-ant-env-' + 'e'.repeat(30) + 'ZZZZ', CRUX_HUB_USE_API_KEY: '1' });
    assert.equal(t.a.applyAtStart(), 'environment');
    assert.match(t.env.ANTHROPIC_API_KEY, /^sk-ant-env-/, 'the saved key did not replace it');
    assert.deepEqual([t.a.view().envLocked, t.a.view().keyEnd], [true, 'ZZZZ']);
    assert.throws(() => t.a.choosePlan(), e => e.message === ENV_WINS);
    assert.throws(() => t.a.chooseKey(KEY), e => e.message === ENV_WINS);
    // a key set without the switch is not used, and is put back as it was after a restart
    t = mk({ ANTHROPIC_API_KEY: 'sk-ant-env-' + 'e'.repeat(30) + 'ZZZZ' }); t.a.setMode('key');
    assert.equal(t.a.applyAtStart(), 'saved'); assert.equal(t.env.ANTHROPIC_API_KEY, KEY);
    assert.match(t.a.restartEnv().ANTHROPIC_API_KEY, /^sk-ant-env-/); assert.equal(t.a.restartEnv().CRUX_HUB_USE_API_KEY, undefined);
    // the desktop app: a key saved on its setup screen counts as chosen while nothing was chosen
    mkdirSync(join(dir, 'b')); const s2 = new Secrets({ env: {}, file: join(dir, 'b', 's.json'), protector: fake }); s2.save(KEY);
    const e2 = {}; assert.equal(new Account({ env: e2, secrets: s2, file: join(dir, 'b', 'a.json') }).applyAtStart({ bundled: true }), 'saved');
    // no key saved: nothing to switch to; a paste is shape-checked and kept protected
    const s3 = new Secrets({ env: {}, file: join(dir, 'c.json'), protector: fake });
    const a3 = new Account({ env: {}, secrets: s3, file: join(dir, 'c-a.json') });
    assert.throws(() => a3.chooseKey(''), /Paste your API key/);
    assert.throws(() => a3.chooseKey('nope'), /sk-ant-/);
    a3.chooseKey(KEY); assert.equal(a3.mode, 'key'); assert.equal(s3.savedEnd, 'a1b2');
    assert.ok(!readFileSync(join(dir, 'c.json'), 'utf8').includes(KEY));
  } finally { removeTmp(dir); }
});

test('where a key cannot be protected the card says so, and saving is refused', () => {
  const dir = makeTmp('crux-acct-np-');
  try {
    const secrets = new Secrets({ env: {}, file: join(dir, 's.json'), protector: null });
    const a = new Account({ env: {}, secrets, file: join(dir, 'a.json'), platform: 'linux' });
    assert.equal(a.view().canProtect, false);
    assert.throws(() => a.chooseKey(KEY), /cannot protect a saved key/);
    assert.equal(a.mode, null, 'nothing was chosen');
    const html = accountCard({ ...a.view(), mode: 'plan' }, { pick: 'key', key: KEY });
    assert.match(html, /cannot protect a saved key/); assert.match(html, /environment/);
    assert.ok(!html.includes('data-ac-key'), 'no field to paste into');
    assert.equal(switchState({ mode: 'plan', canProtect: false }, { pick: 'key', key: KEY }).ok, false);
  } finally { removeTmp(dir); }
});

test('Sign in as someone else opens a terminal window on Windows, and says what to run elsewhere', () => {
  assert.equal(openSignInWindow({ platform: 'linux', hubDir: '/x', spawnFn: () => { throw new Error('no'); } }), false);
  const calls = [];
  assert.equal(openSignInWindow({ platform: 'win32', hubDir: 'C:\\Crux Hub\\hub', node: 'C:\\node\\node.exe', spawnFn: (c, a, o) => { calls.push({ c, a, o }); return { unref() { } }; } }), true);
  assert.equal(calls[0].c, 'cmd.exe');
  assert.match(calls[0].a.join(' '), /login\.mjs" --signin/);
  assert.match(calls[0].a.join(' '), /Crux Hub/);
  assert.equal(calls[0].o.windowsVerbatimArguments, true);
});

test('the card and the panel: the line that says what is in use, the buttons that apply, and never a whole key', () => {
  const plan = { mode: 'plan', source: null, envLocked: false, keyEnd: '', savedEnd: '', planName: 'Alex Doe', canProtect: true };
  const key = { mode: 'key', source: 'saved', envLocked: false, keyEnd: 'a1b2', savedEnd: 'a1b2', planName: 'Alex Doe', canProtect: true };
  assert.equal(accountLine(plan), 'Plan sign-in: Alex Doe');
  assert.equal(accountLine({ mode: 'plan' }), 'Plan sign-in');
  assert.equal(accountLine(key), 'API key ending ...a1b2');
  // Switch: nothing to do until the choice differs, or a key is pasted
  assert.equal(switchState(plan, { pick: 'plan', key: '' }).ok, false);
  assert.equal(switchState(plan, { pick: 'key', key: '' }).ok, false, 'no key saved and none pasted');
  assert.equal(switchState(plan, { pick: 'key', key: KEY }).ok, true);
  assert.equal(switchState({ ...plan, savedEnd: 'a1b2' }, { pick: 'key', key: '' }).ok, true, 'a saved key can be used again');
  assert.equal(switchState(key, { pick: 'plan', key: '' }).ok, true);
  assert.deepEqual([switchState(key, { pick: 'key', key: '' }).ok, switchState(key, { pick: 'key', key: KEY }).word], [false, 'Replace key']);
  assert.equal(switchState({ ...key, envLocked: true }, { pick: 'plan', key: '' }).ok, false);
  const html = accountCard(plan, { pick: 'key', key: '' });
  for (const s of ['Plan sign-in', 'API key', 'Switching restarts the hub', 'Cancel', 'protected storage for your user, not in any project folder']) assert.ok(html.includes(s) || html.includes(s.replace("'", '&#39;')), s);
  assert.match(accountCard(plan, { pick: 'plan' }), /Sign in as someone else/);
  assert.match(accountCard(plan, { pick: 'plan' }), /other Claude Code sessions on this PC/);
  assert.match(accountCard({ ...plan, envLocked: true, mode: 'key', keyEnd: 'ZZZZ' }, { pick: 'key' }), /environment variables/);
  assert.ok(!accountCard(key, { pick: 'key', key: KEY }).includes(KEY), 'a typed key is not drawn back into the card');
  // the panel: plan limits for a plan, tokens and dollars only for a key
  const planSnap = { subscription: 'max', asOf: new Date().toISOString(), models: [], windows: [{ key: 'five_hour', pct: 40, resetsAt: new Date(Date.now() + 3600e3).toISOString() }] };
  assert.match(panelHtml({ plan: planSnap, rows: [], account: plan }), /Plan limits/);
  assert.match(panelHtml({ plan: planSnap, rows: [], account: plan }), /Plan sign-in: Alex Doe/);
  const kp = panelHtml({ plan: planSnap, rows: [], account: key });
  assert.ok(!/Plan limits/.test(kp), 'an old plan snapshot is ignored for a key'); assert.match(kp, /API key ending \.\.\.a1b2/); assert.match(kp, /Estimated spend/);
  assert.match(kp, /How to switch outside the app/); assert.match(accountBlock(key), /data-up-account/);
});

// ---------- the hub itself ----------
async function startHub(port, dir, env = {}) {
  mkdirSync(join(dir, 'proj'), { recursive: true }); mkdirSync(join(dir, 'cfg'), { recursive: true });
  writeFileSync(join(dir, 'cfg', '.claude.json'), JSON.stringify({ oauthAccount: { displayName: 'Alex Doe', emailAddress: 'alex@example.invalid' } }));
  const child = spawn(process.execPath, [join(HUB_DIR, 'server.mjs'), '--port', String(port), '--no-agents', join(dir, 'proj')], {
    env: { ...process.env, CRUX_HUB_DATA: join(dir, 'data'), CRUX_HOME: join(dir, 'home'), CLAUDE_CONFIG_DIR: join(dir, 'cfg'), ANTHROPIC_API_KEY: '', CRUX_HUB_USE_API_KEY: '', CRUX_HUB_BUNDLED: '', ...env }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let err = ''; child.stderr.on('data', c => { err += c; });
  const call = (method, path, body) => new Promise((ok, bad) => {
    const host = `localhost:${port}`, payload = body ? JSON.stringify(body) : null;
    const headers = { host, ...(payload ? { 'content-type': 'application/json', origin: `http://${host}`, 'content-length': Buffer.byteLength(payload) } : {}) };
    const r = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      const parts = []; res.on('data', x => parts.push(x));
      res.on('end', () => { const text = Buffer.concat(parts).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { } ok({ status: res.statusCode, json, text }); });
    });
    r.on('error', bad); if (payload) r.write(payload); r.end();
  });
  let up = false;
  for (let i = 0; i < 75 && !up; i++) { up = (await call('GET', '/api/ping').catch(() => null))?.status === 200; if (!up) await new Promise(r => setTimeout(r, 200)); }
  const stop = async () => { child.kill(); await new Promise(r => child.once('exit', r)); };
  if (!up) { await stop(); throw new Error(`the test hub did not start: ${err}`); }
  return { call, stop };
}

test('a test hub on a plan sign-in: the page learns who, refuses bad keys, and opens no sign-in window', async () => {
  const dir = makeTmp('crux-acct-hub-'), port = 4794;
  const { call, stop } = await startHub(port, dir);
  try {
    const a = (await call('GET', '/api/account')).json;
    assert.deepEqual([a.mode, a.planName, a.envLocked, a.keyEnd], ['plan', 'Alex Doe', false, '']);
    assert.equal((await call('GET', '/api/state')).json.account.planName, 'Alex Doe', 'the state carries it too');
    // refused before anything is saved or restarted
    const bad = await call('POST', '/api/account', { mode: 'key', apiKey: 'nope' });
    assert.equal(bad.status, 400); assert.match(bad.json.error, /sk-ant-/);
    assert.equal((await call('POST', '/api/account', { mode: 'key' })).status, 400, 'no key saved and none pasted');
    assert.equal((await call('POST', '/api/account', { mode: 'other' })).status, 400);
    const si = await call('POST', '/api/account/signin', {});
    assert.deepEqual([si.status, si.json.opened, si.json.test], [200, false, true]);
    assert.ok(!(await call('GET', '/api/state')).text.includes('sk-ant'), 'no key anywhere in the state');
  } finally { await stop(); removeTmp(dir); }
});

test('a test hub whose key is in the environment: the environment wins and the card cannot switch under it', async () => {
  const dir = makeTmp('crux-acct-env-'), port = 4795;
  const { call, stop } = await startHub(port, dir, { ANTHROPIC_API_KEY: 'sk-ant-fake-' + 'e'.repeat(30) + 'ZZZZ', CRUX_HUB_USE_API_KEY: '1' });
  try {
    const a = (await call('GET', '/api/account')).json;
    assert.deepEqual([a.mode, a.source, a.envLocked, a.keyEnd], ['key', 'environment', true, 'ZZZZ']);
    const r = await call('POST', '/api/account', { mode: 'plan' });
    assert.equal(r.status, 400); assert.equal(r.json.error, ENV_WINS);
    assert.ok(!(await call('GET', '/api/state')).text.includes('eeeeee'), 'only the last four characters');
  } finally { await stop(); removeTmp(dir); }
});
