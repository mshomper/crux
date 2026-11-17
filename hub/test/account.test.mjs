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
import { Account, defaultProtector, planName, planId, openSignInWindow, watchSignIn, ENV_WINS } from '../lib/account.mjs';
import { Hub } from '../lib/hub.mjs';
import { createServer } from 'node:net';
import { Secrets } from '../lib/setup.mjs';
import { HUB_DIR, pidsOnPort, stopTree, dataDir } from '../lib/relaunch.mjs';
import { stepUpNeed, PURPOSES } from '../lib/guard.mjs';
import { readdirSync, statSync } from 'node:fs';
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
    // two people can share a display name: the id tells them apart, and the page only gets a short hash of it
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { displayName: 'Alex Doe', accountUuid: 'uuid-1', emailAddress: 'a1@example.invalid' } }));
    const one = planId(env);
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { displayName: 'Alex Doe', accountUuid: 'uuid-2', emailAddress: 'a2@example.invalid', pad: 'x' } }));
    assert.notEqual(planId(env), one); assert.equal(planName(env), 'Alex Doe');
    assert.match(planId(env), /^[0-9a-f]{12}$/); assert.ok(!planId(env).includes('uuid'));
    writeFileSync(join(dir, '.claude.json'), '{ not json');
    assert.equal(planName(env), null); assert.equal(planId(env), null);
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
    // chosen: the saved key is used, from memory; it is NOT put in the environment agents inherit (review of #140)
    t.a.chooseKey(); assert.equal(t.a.mode, 'key');
    t = mk({ PATH: 'x' });
    assert.equal(t.a.applyAtStart(), 'saved');
    assert.deepEqual(t.env, { PATH: 'x' }, 'the environment is untouched: no key, no switch');
    assert.equal(t.a.currentKey(), KEY);
    const v = t.a.view();
    assert.deepEqual([v.mode, v.source, v.keyEnd, v.envLocked, v.problem], ['key', 'saved', 'a1b2', false, '']);
    assert.ok(!JSON.stringify(v).includes(KEY) && !JSON.stringify(v).includes('ffff'), 'the page only ever gets the last four');
    // Claude Code reads it through apiKeyHelper: a quoted command with forward slashes, only while the saved key is in use
    const cmd = t.a.helperCommand({ node: 'C:\\Program Files\\nodejs\\node.exe', hubDir: 'C:\\Crux Hub\\hub' });
    assert.equal(cmd, `"C:/Program Files/nodejs/node.exe" "C:/Crux Hub/hub/lib/key-helper.mjs" "${t.secrets.file.replace(/\\/g, '/')}"`);
    assert.ok(!cmd.includes('ffff'), 'the command carries no key');
    // plan chosen: the next start does not use the key, and there is no helper
    t.a.choosePlan(); t = mk({ PATH: 'x' }); assert.equal(t.a.applyAtStart(), null); assert.equal(t.a.currentKey(), ''); assert.equal(t.a.helperCommand({ hubDir: 'x' }), null);
    // an environment key wins, and the card cannot switch under it
    t = mk({ ANTHROPIC_API_KEY: 'sk-ant-env-' + 'e'.repeat(30) + 'ZZZZ', CRUX_HUB_USE_API_KEY: '1' });
    assert.equal(t.a.applyAtStart(), 'environment');
    assert.match(t.env.ANTHROPIC_API_KEY, /^sk-ant-env-/, 'the saved key did not replace it');
    assert.deepEqual([t.a.view().envLocked, t.a.view().keyEnd], [true, 'ZZZZ']);
    assert.equal(t.a.useSaved(), 'environment', 'not even from the desktop setup path'); assert.equal(t.a.helperCommand({ hubDir: 'x' }), null);
    assert.throws(() => t.a.choosePlan(), e => e.message === ENV_WINS);
    assert.throws(() => t.a.chooseKey(KEY), e => e.message === ENV_WINS);
    // a key set without the switch is not used for agents; the saved one is, from memory, and the environment is left alone
    t = mk({ ANTHROPIC_API_KEY: 'sk-ant-env-' + 'e'.repeat(30) + 'ZZZZ' }); t.a.setMode('key');
    assert.equal(t.a.applyAtStart(), 'saved'); assert.match(t.env.ANTHROPIC_API_KEY, /^sk-ant-env-/); assert.equal(t.env.CRUX_HUB_USE_API_KEY, undefined);
    assert.equal(t.a.currentKey(), KEY);
    // a saved key that cannot be opened: plain words on the card, one line logged, the plan sign-in carries on
    const bad = new Secrets({ env: {}, file: join(dir, 'bad.json'), protector: { protect: s => 'sealed:' + s, unprotect: () => { throw new Error('PowerShell said something long'); } } });
    bad.save(KEY);
    const warns = []; const warn = console.warn; console.warn = m => warns.push(m);
    const ab = new Account({ env: {}, secrets: bad, file: join(dir, 'bad-a.json') }); ab.setMode('key');
    try { assert.equal(ab.applyAtStart(), null); } finally { console.warn = warn; }
    assert.match(ab.view().problem, /could not be opened.*Paste it again/); assert.equal(ab.view().mode, 'plan'); assert.equal(warns.length, 1);
    assert.ok(!JSON.stringify(ab.view()).includes('PowerShell said'));
    // an old key in the clear is saved protected at start
    const old = new Secrets({ env: {}, file: join(dir, 'old.json'), protector: fake }); writeFileSync(join(dir, 'old.json'), JSON.stringify({ anthropicApiKey: KEY }));
    assert.equal(old.isClear, true);
    const ao = new Account({ env: {}, secrets: old, file: join(dir, 'old-a.json') }); ao.setMode('key'); assert.equal(ao.applyAtStart(), 'saved');
    assert.equal(old.isClear, false); assert.ok(!readFileSync(join(dir, 'old.json'), 'utf8').includes(KEY)); assert.equal(old.apiKey, KEY);
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

test('a PowerShell failure is reported in plain words, not as PowerShell\'s own message', () => {
  const p = defaultProtector({ platform: 'win32', run: () => { throw new Error('Cannot find type [Security.Cryptography.ProtectedData] ... at line 1 char 99'); } });
  assert.throws(() => p.protect(KEY), e => /Windows could not protect the key/.test(e.message) && !/line 1/.test(e.message));
  assert.throws(() => p.unprotect('AAAA'), e => /Windows could not open the saved key/.test(e.message) && !/line 1/.test(e.message));
});

test('from a phone, switching the account or pasting a key asks for the step-up; the PC does not', () => {
  const need = body => stepUpNeed('POST /api/account', body, {});
  assert.deepEqual([need({ mode: 'plan' }).purpose, need({ mode: 'plan' }).scope], ['account', 'account;plan']);
  assert.equal(need({ mode: 'key', apiKey: KEY }).scope, 'account;key;new');
  assert.equal(need({ mode: 'key' }).scope, 'account;key');
  assert.ok(PURPOSES.has('account'));
  assert.ok(!JSON.stringify(need({ mode: 'key', apiKey: KEY })).includes('ffff'), 'the key is not part of what the confirmation names');
  assert.equal(stepUpNeed('POST /api/profile/create', {}, {}), null, 'unrelated routes are as before');
});

test('the hub watches for a new signed-in name by itself (card closed or not), once, and gives up after a while', () => {
  let name = 'Alex Doe', t = 0, ticks = null, cleared = 0;
  const timers = { setInterval: fn => { ticks = fn; return { unref() { } }; }, clearInterval: () => { cleared++; } };
  const seen = [];
  watchSignIn({ read: () => name, onChange: (n, b) => seen.push([n, b]), now: () => t, timers, everyMs: 3000, forMs: 60000 });
  ticks(); assert.deepEqual(seen, [], 'same person: nothing');
  name = null; ticks(); assert.deepEqual(seen, [], 'nobody readable for a moment: nothing');
  name = 'Sam Roe'; ticks(); assert.deepEqual(seen, [['Sam Roe', 'Alex Doe']]); assert.ok(cleared >= 1, 'it stops itself');
  // a baseline that could not be read is replaced by the first person that can, never counted as a change
  const seen2 = []; let who = null; ticks = null;
  watchSignIn({ read: () => who, onChange: (n, b) => seen2.push([n, b]), now: () => t, timers, forMs: 60000 });
  ticks(); who = 'idA'; ticks(); assert.deepEqual(seen2, [], 'nobody, then the same person as before: no restart');
  who = 'idB'; ticks(); assert.deepEqual(seen2, [['idB', 'idA']]);
  let late = 0; ticks = null; t = 0;
  watchSignIn({ read: () => name, onChange: () => late++, now: () => t, timers, forMs: 60000 });
  t = 61000; name = 'Someone Else'; ticks(); assert.equal(late, 0, 'after the time is up it does not act');
});

test('with the saved key set up for agents, Claude Code must report apiKeyHelper or the card says so', () => {
  const hub = { apiKeyHelper: '"node" "x"', keyProblem: '' };
  Hub.prototype.noteKeySource.call(hub, 'apiKeyHelper'); assert.equal(hub.keyProblem, '');
  Hub.prototype.noteKeySource.call(hub, 'none'); assert.match(hub.keyProblem, /not using the saved key \(it reports "none"\)/);
  Hub.prototype.noteKeySource.call(hub, undefined); assert.match(hub.keyProblem, /not using/, 'a missing report changes nothing');
  Hub.prototype.noteKeySource.call(hub, 'apiKeyHelper'); assert.equal(hub.keyProblem, '', 'and it clears when it is right again');
  const plain = { apiKeyHelper: null, keyProblem: '' }; Hub.prototype.noteKeySource.call(plain, 'oauth'); assert.equal(plain.keyProblem, '', 'no helper, nothing to check');
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

// The reviewer's known-answer test (#140): a fake key saved on this Windows user's protection, a REAL restart through the
// route, and then the hub reports it uses the saved key, is not locked, and the key's middle appears in no file of the hub.
test('a saved fake key survives a real restart through POST /api/account and is written nowhere in the clear (Windows only)', { skip: !win && 'needs Windows' }, async () => {
  // a free port picked now: the restarted hub is stopped by what listens on it, never on a port someone else may be using
  const port = await new Promise((ok, bad) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); s.on('error', bad); });
  const dir = makeTmp('crux-acct-known-'), data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const MID = 'm1ddl3'.repeat(7);                       // the key's middle: 42 characters no file may hold
  const FAKE = `sk-ant-api03-${MID}f4k3`;
  new Secrets({ env: { CRUX_HUB_DATA: data } }).save(FAKE);   // real Windows protection, into the temp data folder
  const { call, stop } = await startHub(port, dir);
  try {
    const before = (await call('GET', '/api/account')).json;
    assert.deepEqual([before.mode, before.savedEnd], ['plan', 'f4k3']);
    const bootOf = async () => (await call('GET', '/api/ping').catch(() => ({}))).json?.boot;
    const old = await bootOf();
    const r = await call('POST', '/api/account', { mode: 'key' });
    assert.equal(r.status, 200, r.text); assert.equal(r.json.restarting, true);
    let now = old; for (let i = 0; i < 80 && (!now || now === old); i++) { await new Promise(ok => setTimeout(ok, 250)); now = await bootOf(); }
    assert.ok(now && now !== old, 'the hub came back');
    const a = (await call('GET', '/api/account')).json;
    assert.deepEqual([a.mode, a.source, a.envLocked, a.keyEnd, a.problem], ['key', 'saved', false, 'f4k3', '']);
    assert.ok(!(await call('GET', '/api/state')).text.includes(MID), 'not on the page');
    // nowhere in the data folder (settings, secrets, account, launch file, hub log) or in a project's event log
    const files = d => readdirSync(d).flatMap(n => { const f = join(d, n); return statSync(f).isDirectory() ? files(f) : [f]; });
    for (const f of [...files(data), ...files(join(dir, 'proj'))]) assert.ok(!readFileSync(f).toString('latin1').includes(MID), `the key is in ${f}`);
    assert.ok(files(data).some(f => f.endsWith(`hub-${port}.log`)), 'the restarted hub\'s log was checked too');
  } finally {
    await Promise.race([stop().catch(() => { }), new Promise(ok => setTimeout(ok, 2000))]);   // the first hub already left by itself
    for (const pid of await pidsOnPort(port)) await stopTree(pid);   // the restarted hub runs detached: stop it, the port is a test one
    await new Promise(ok => setTimeout(ok, 500));
    removeTmp(dir);
  }
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
