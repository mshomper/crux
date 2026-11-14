// Decision 58 A: PC notices from the desktop app, with the phone as backup. The PC gets the card while it is in use
// (input in the last 5 minutes, not locked); the phone gets it when the PC is idle, locked or asleep, and also when
// the card still waits 3 minutes after a PC notice. One test starts a throwaway test hub on port 4798.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp, removeTmp } from './helpers/tmp.mjs';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { Push, PC_IDLE_MS, PHONE_FOLLOWUP_MS } from '../lib/push.mjs';
import { HUB_DIR } from '../lib/relaunch.mjs';
import { openCardUrl, READY_FLAG } from '../public/open-card.js';

const approvalEv = { id: 'e1', type: 'approval', project: 'crux', thread: 'w1', approval: 'ap-1', agent: 'w1', tool: 'Bash', input: { command: 'rm -rf secret-folder' } };
const settle = () => new Promise(r => setImmediate(r));

const raiseEv = { id: 'r1', type: 'project_settings', project: 'crux', permissionMode: 'trusted', was: 'auto', raised: true, by: 'you', thread: 'orchestrator' };

function harness({ phone = true, dir = makeTmp('crux-desk-') } = {}) {
  const phoneSent = [], desk = [], logged = [];
  const timers = { queue: [], setTimeout(fn, ms) { this.queue.push({ fn, ms }); }, clearTimeout() { }, run(ms) { for (const t of this.queue.splice(0)) if (t.ms === ms) t.fn(); else this.queue.push(t); } };
  const sender = { generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }), sendNotification: async (_s, body) => { phoneSent.push(JSON.parse(body)); } };
  const push = new Push({ dir, sender, timers, log: s => logged.push(s) });
  if (phone) push.subscribe({ endpoint: 'https://push.example/phone', keys: { p256dh: 'k', auth: 'a' } }, 'iPhone');
  const approvals = new Map([['ap-1', {}]]);
  const ctx = { approvals, decisionOpen: () => false, events: () => [] };
  const listener = push.desktopAttach('desk-app-1', (event, data) => desk.push({ event, ...data }));
  return { push, timers, phoneSent, desk, logged, approvals, ctx, listener, dir, done: () => removeTmp(dir) };
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

test('a raise to Trusted: the phone at once, the PC too while in use, no 3-minute follow-up; looking keeps it off the PC only', async () => {
  const h = harness();
  try {
    h.push.desktopPresence('desk-app-1', { idleMs: 0 });
    h.push.handle(raiseEv, h.ctx); await settle();
    assert.deepEqual(h.phoneSent.map(p => p.card), ['level:r1'], 'decision 45: seen at once on the phone');
    assert.deepEqual(h.desk.map(d => [d.event, d.card]), [['notify', 'level:r1']]);
    assert.equal(h.timers.queue.length, 0, 'no follow-up: the phone already has it');
  } finally { h.done(); }
  const k = harness();
  try {
    k.push.desktopPresence('desk-app-1', { idleMs: 0 });
    k.push.presence('page', { project: 'crux', thread: 'orchestrator', visible: true, focused: true, idleMs: 0 });
    k.push.handle(raiseEv, k.ctx); await settle();
    assert.deepEqual(k.phoneSent.map(p => p.card), ['level:r1'], 'the phone even while you look at it');
    assert.equal(k.desk.length, 0, 'not the PC you are already looking at');
  } finally { k.done(); }
});

test('the 3-minute follow-up survives a hub restart: a card still waiting goes to the phone, a settled one does not', async () => {
  const h = harness();
  try {
    h.push.desktopPresence('desk-app-1', { idleMs: 0 });
    h.push.handle(approvalEv, h.ctx); await settle();
    h.push.handle({ ...approvalEv, id: 'e3', approval: 'ap-2' }, { ...h.ctx, approvals: new Map([['ap-2', {}]]) }); await settle();
    assert.equal(h.desk.length, 2);
    // The hub restarts before the 3 minutes are up: a new Push on the same data folder.
    const again = harness({ dir: h.dir });
    again.push.resume({ ...again.ctx, approvals: new Map([['ap-1', {}]]) }, Date.now() + 60 * 1000);
    assert.equal(again.timers.queue.length, 2);
    assert.ok(again.timers.queue.every(t => t.ms > 0 && t.ms <= PHONE_FOLLOWUP_MS - 60 * 1000), 'at the time still due');
    for (const t of again.timers.queue.splice(0)) t.fn();
    await settle();
    assert.deepEqual(again.phoneSent.map(p => p.card), ['approval:ap-1'], 'ap-2 was settled across the restart');
    assert.equal(again.push.follow.size, 0, 'nothing left due');
    const third = harness({ dir: h.dir });
    third.push.resume(third.ctx);
    assert.equal(third.timers.queue.length, 0, 'a follow-up runs once, not again after the next restart');
  } finally { h.done(); }
});

test('a notice click opens the card in the open page with a message, never from another frame or origin', () => {
  const win = { location: { origin: 'http://crux.localhost:4747' } };
  const msg = (over = {}) => ({ source: win, origin: win.location.origin, data: { type: 'open-card', url: '/?project=crux&card=question%3Aq1' }, ...over });
  assert.equal(openCardUrl(msg(), win), '/?project=crux&card=question%3Aq1');
  assert.equal(openCardUrl(msg({ source: {} }), win), null, 'another frame');
  assert.equal(openCardUrl(msg({ origin: 'http://evil.example' }), win), null, 'another origin');
  assert.equal(openCardUrl(msg({ data: { type: 'other', url: '/' } }), win), null);
  assert.equal(openCardUrl(msg({ data: { type: 'open-card', url: 42 } }), win), null);
  assert.equal(READY_FLAG, 'cruxOpenCard', 'the flag the app checks before posting (main.rs open_card_script)');
});

test('a refused notice sends the card to the phone at once; a late close of an old stream keeps the new one; one log line per card', async () => {
  const h = harness();
  try {
    h.push.desktopPresence('desk-app-1', { idleMs: 0 });
    h.push.handle(approvalEv, h.ctx); await settle();
    assert.equal(h.push.desktopFailed('approval:ap-1'), true);
    await settle();
    assert.deepEqual(h.phoneSent.map(p => p.card), ['approval:ap-1']);
    h.timers.run(PHONE_FOLLOWUP_MS); await settle();
    assert.equal(h.phoneSent.length, 1, 'not twice');
    assert.equal(h.push.desktopFailed('approval:nope'), false);
    assert.ok(h.logged.some(l => l.startsWith('approval:ap-1 (crux): PC')), h.logged.join(' | '));
    // The app reconnects with the same client id; the earlier stream's close comes late.
    const fresh = h.push.desktopAttach('desk-app-1', () => { });
    h.push.desktopDetach('desk-app-1', h.listener);
    assert.equal(h.push.desktops.get('desk-app-1'), fresh, 'the live listener stays');
    h.push.desktopDetach('desk-app-1', fresh);
    assert.equal(h.push.desktops.size, 0);
  } finally { h.done(); }
  const k = harness();
  try {
    k.push.desktopPresence('desk-app-1', { idleMs: 0 });
    k.push.presence('page', { project: 'crux', thread: 'w1', visible: true, focused: true, idleMs: 0 });
    k.push.handle(approvalEv, k.ctx); await settle();
    assert.deepEqual(k.logged, ['approval:ap-1 (crux): held, you are looking at it in an open hub page']);
  } finally { k.done(); }
});

test('the desktop stream and its reports are for this PC only; a raise to Trusted reaches the app', async () => {
  const dir = makeTmp('crux-desk-hub-'), port = 4798;
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
    assert.equal((await req('POST', '/api/desktop/failed', { body: { card: 'approval:x' }, extra: remote })).status, 403);
    for (const site of ['cross-site', 'same-site', 'same-origin'])
      assert.equal((await req('GET', '/api/desktop/stream?client=desk-app-1', { extra: { 'sec-fetch-site': site } })).status, 403, `a web page in a browser (${site})`);
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
    removeTmp(dir);   // the hub is stopped first, so its files are free
  }
});
