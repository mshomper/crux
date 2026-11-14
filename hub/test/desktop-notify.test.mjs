// Decision 58 A: PC notices from the desktop app, with the phone as backup. The PC gets the card while it is in use
// (input in the last 5 minutes, not locked); the phone gets it when the PC is idle, locked or asleep, and also when
// the card still waits 3 minutes after a PC notice. One test starts a throwaway test hub on port 4798.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { Push, PC_IDLE_MS, PHONE_FOLLOWUP_MS } from '../lib/push.mjs';
import { HUB_DIR } from '../lib/relaunch.mjs';

const approvalEv = { id: 'e1', type: 'approval', project: 'crux', thread: 'w1', approval: 'ap-1', agent: 'w1', tool: 'Bash', input: { command: 'rm -rf secret-folder' } };
const settle = () => new Promise(r => setImmediate(r));

function harness({ phone = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'crux-desk-'));
  const phoneSent = [], desk = [];
  const timers = { queue: [], setTimeout(fn, ms) { this.queue.push({ fn, ms }); }, clearTimeout() { }, run(ms) { for (const t of this.queue.splice(0)) if (t.ms === ms) t.fn(); else this.queue.push(t); } };
  const sender = { generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }), sendNotification: async (_s, body) => { phoneSent.push(JSON.parse(body)); } };
  const push = new Push({ dir, sender, timers });
  if (phone) push.subscribe({ endpoint: 'https://push.example/phone', keys: { p256dh: 'k', auth: 'a' } }, 'iPhone');
  const approvals = new Map([['ap-1', {}]]);
  const ctx = { approvals, decisionOpen: () => false, events: () => [] };
  push.desktopAttach('desk-app-1', (event, data) => desk.push({ event, ...data }));
  return { push, timers, phoneSent, desk, approvals, ctx, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('PC in use: the notice goes to the PC only, and to the phone 3 minutes later if the card still waits', async () => {
  const h = harness();
  try {
    h.push.desktopPresence('desk-app-1', { idleMs: 20 * 1000, locked: false });
    h.push.handle(approvalEv, h.ctx);
    await settle();
    assert.deepEqual(h.desk.map(d => [d.event, d.card]), [['notify', 'approval:ap-1']]);
    assert.equal(h.desk[0].title, 'w1 is waiting for Allow');
    assert.ok(!JSON.stringify(h.desk).includes('secret-folder'), 'the same few words as a phone push, no command text');
    assert.equal(h.phoneSent.length, 0, 'not the phone while you are at the PC');
    assert.equal(h.timers.queue[0].ms, PHONE_FOLLOWUP_MS);
    h.timers.run(PHONE_FOLLOWUP_MS); await settle();
    assert.deepEqual(h.phoneSent.map(p => p.card), ['approval:ap-1'], 'still waiting after 3 minutes: the phone too');
  } finally { h.done(); }
});

test('a card settled before the 3 minutes: no phone, and the PC notice is taken down', async () => {
  const h = harness();
  try {
    h.push.desktopPresence('desk-app-1', { idleMs: 0 });
    h.push.handle(approvalEv, h.ctx);
    h.approvals.delete('ap-1');
    h.push.handle({ id: 'e2', type: 'approval_result', project: 'crux', approval: 'ap-1', allow: true }, h.ctx);
    assert.deepEqual(h.desk.map(d => [d.event, d.card]), [['notify', 'approval:ap-1'], ['clear', 'approval:ap-1']]);
    h.timers.run(PHONE_FOLLOWUP_MS); await settle();
    assert.equal(h.phoneSent.length, 0);
  } finally { h.done(); }
});

test('PC idle 5+ minutes, locked, or silent (asleep): the phone only', async () => {
  for (const [why, setup] of [
    ['idle', h => h.push.desktopPresence('desk-app-1', { idleMs: PC_IDLE_MS + 1000 })],
    ['locked', h => h.push.desktopPresence('desk-app-1', { idleMs: 0, locked: true })],
    ['Windows notices switched off', h => h.push.desktopPresence('desk-app-1', { idleMs: 0, notices: false })],
    ['asleep', h => h.push.desktopPresence('desk-app-1', { idleMs: 0 }, Date.now() - 10 * 60 * 1000)],
    ['no report yet', () => { }]
  ]) {
    const h = harness();
    try {
      setup(h);
      h.push.handle(approvalEv, h.ctx); await settle();
      assert.equal(h.desk.length, 0, `${why}: no PC notice`);
      assert.deepEqual(h.phoneSent.map(p => p.card), ['approval:ap-1'], `${why}: the phone`);
    } finally { h.done(); }
  }
});

test('with no phone set up the PC gets the notice even when idle; a card you are looking at is not sent anywhere', async () => {
  const h = harness({ phone: false });
  try {
    h.push.desktopPresence('desk-app-1', { idleMs: PC_IDLE_MS * 3 });
    h.push.handle(approvalEv, h.ctx); await settle();
    assert.deepEqual(h.desk.map(d => d.card), ['approval:ap-1']);
    assert.equal(h.timers.queue.length, 0, 'no phone to follow up on');
  } finally { h.done(); }
  const k = harness();
  try {
    k.push.desktopPresence('desk-app-1', { idleMs: 0 });
    k.push.presence('page', { project: 'crux', thread: 'w1', visible: true, focused: true, idleMs: 0 });
    k.push.handle(approvalEv, k.ctx); await settle();
    assert.equal(k.desk.length + k.phoneSent.length, 0);
  } finally { k.done(); }
});

test('the desktop stream and its reports are for this PC only; a raise to Trusted reaches the app', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crux-desk-hub-')), port = 4798;
  mkdirSync(join(dir, 'proj'));
  const child = spawn(process.execPath, [join(HUB_DIR, 'server.mjs'), '--port', String(port), '--no-agents', join(dir, 'proj')], {
    env: { ...process.env, CRUX_HUB_DATA: join(dir, 'data'), CRUX_HOME: join(dir, 'home'), CRUX_HUB_GUARD: 'off' }, stdio: ['ignore', 'ignore', 'pipe']
  });
  const req = (method, path, { body, extra = {}, onData } = {}) => new Promise((ok, bad) => {
    const host = `localhost:${port}`, payload = body ? JSON.stringify(body) : null;
    const headers = { host, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...extra };
    const r = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      if (onData) { res.on('data', c => onData(String(c))); return ok({ status: res.statusCode, close: () => r.destroy() }); }
      const parts = []; res.on('data', x => parts.push(x));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { } ok({ status: res.statusCode, json }); });
    });
    r.on('error', bad); if (payload) r.write(payload); r.end();
  });
  try {
    let up = false;
    for (let i = 0; i < 75 && !up; i++) { up = (await req('GET', '/api/ping').catch(() => null))?.status === 200; if (!up) await new Promise(r => setTimeout(r, 200)); }
    assert.ok(up, 'test hub started');
    const remote = { 'x-forwarded-for': '100.64.0.2' };
    assert.equal((await req('GET', '/api/desktop/stream?client=desk-app-1', { extra: remote })).status, 403, 'not from the phone');
    assert.equal((await req('POST', '/api/desktop/presence', { body: { client: 'desk-app-1', idleMs: 0 }, extra: remote })).status, 403);
    let got = '';
    const stream = await req('GET', '/api/desktop/stream?client=desk-app-1', { onData: c => { got += c; } });
    assert.equal(stream.status, 200);
    const rep = await req('POST', '/api/desktop/presence', { body: { client: 'desk-app-1', idleMs: 1000, locked: false } });
    assert.deepEqual(rep.json, { known: true, inUse: true });
    assert.equal((await req('POST', '/api/settings', { body: { project: 'proj', permissionMode: 'trusted' } })).status, 200);
    for (let i = 0; i < 50 && !got.includes('event: notify'); i++) await new Promise(r => setTimeout(r, 100));
    assert.match(got, /event: notify\ndata: \{[^\n]*"kind":"level"[^\n]*"title":"proj was raised to Trusted"/);
    stream.close();
  } finally {
    child.kill();
    await new Promise(r => child.once('exit', r));
    rmSync(dir, { recursive: true, force: true });
  }
});
