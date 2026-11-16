// Decision 66: the settings card's "Permission check: off / shadow / on" control and the pause switch, and over HTTP
// (a real test hub on its own port, never 4747 or 4748; --no-agents --test-pair; every folder in temp, deleted
// afterwards) that turning the check on needs the step-up while shadow, off and pausing need only the cookie.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request, createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp, removeTmp } from './helpers/tmp.mjs';
import { pidsOnPort, stopTree } from '../lib/relaunch.mjs';
import { projectCard, projectChanges, levelChip, CHECK_CHOICES } from '../public/project-settings.js';

const base = { name: 'garden', permissionMode: 'auto', ownHandoff: {}, permissionCheck: 'off', paused: false };
const draft = (p, over = {}) => ({ level: p.permissionMode, connectors: false, check: p.permissionCheck || 'off', paused: !!p.paused, nums: { retireAt: '', idleHandoffMin: '', idleFloorPct: '' }, errors: {}, alwaysOpen: false, ...over });
const hubNums = { retireAt: 60, idleHandoffMin: 60, idleFloorPct: 25 };

test('the card has one Permission check control (Off / Shadow / On) and the pause switch', () => {
  const html = projectCard(base, hubNums, draft(base));
  assert.match(html, /sec-head">Permission check </);
  for (const [v, label] of CHECK_CHOICES) assert.ok(html.includes(`data-ps-seg="check" data-v="${v}">${label}</button>`), label);
  assert.deepEqual(CHECK_CHOICES.map(([v]) => v), ['off', 'shadow', 'on']);
  assert.match(html, /data-ps-seg="check" data-v="off"[^>]*>Off/, 'off is shown');
  assert.ok(/class="on" data-ps-seg="check" data-v="off"/.test(html), 'default off is the chosen one');
  assert.match(html, /sec-head">Pause work in this project </);
  assert.ok(html.includes('data-ps-seg="paused" data-v="0">Running') && html.includes('data-ps-seg="paused" data-v="1">Paused'));
  assert.match(html, /Running: nothing is held/);
  const on = projectCard({ ...base, permissionCheck: 'on', paused: true }, hubNums, draft({ ...base, permissionCheck: 'on', paused: true }));
  assert.ok(/class="on" data-ps-seg="check" data-v="on"/.test(on));
  assert.match(on, /Turning it on needs Windows Hello or Face ID/);
  assert.match(on, /Paused: new requests wait for you/);
});

test('Done sends only what changed: the check mode and the pause', () => {
  assert.deepEqual(projectChanges(base, draft(base)).body, {});
  assert.deepEqual(projectChanges(base, draft(base, { check: 'shadow' })).body, { permissionCheck: 'shadow' });
  assert.deepEqual(projectChanges(base, draft(base, { check: 'on', paused: true })).body, { permissionCheck: 'on', paused: true });
  assert.deepEqual(projectChanges({ ...base, permissionCheck: 'on', paused: true }, draft({ ...base, permissionCheck: 'on', paused: true }, { check: 'off', paused: false })).body, { permissionCheck: 'off', paused: false });
});

test('a paused project shows a mark on its level chip', () => {
  assert.doesNotMatch(levelChip(base), /lv-conn/);
  assert.match(levelChip({ ...base, paused: true }), /lv-conn.*i-pause/);
  assert.match(levelChip({ ...base, paused: true }), /Work is paused/);
});

// ---------- over HTTP ----------
const HUB = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
let port, rport, child, out = '', root;

function call(method, path, body, remote = false) {
  return new Promise((ok, bad) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const host = remote ? 'pc.tail1234.ts.net' : `localhost:${port}`;   // the PC itself, or the phone's way in (tailscale serve)
    const headers = { host, ...(remote ? { 'x-forwarded-for': '100.101.102.103', 'x-forwarded-proto': 'https' } : {}), ...(payload ? { 'content-type': 'application/json', origin: `${remote ? 'https' : 'http'}://${host}`, 'content-length': payload.length } : {}) };
    const r = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      const parts = [];
      res.on('data', x => parts.push(x));
      res.on('end', () => { const text = Buffer.concat(parts).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { } ok({ status: res.statusCode, headers: res.headers, json, text }); });
    });
    r.on('error', bad);
    if (payload) r.write(payload);
    r.end();
  });
}

test('over HTTP: on needs a step-up; shadow, off and pause go through with the cookie; none can come from a repo file', async (t) => {
  do { port = await freePort(); } while (port === 4747 || port === 4748);
  do { rport = await freePort(); } while (rport === 4747 || rport === 4748 || rport === port);
  root = makeTmp('crux-check-http-');
  const proj = join(root, 'proj'), data = join(root, 'data'), crux = join(root, 'crux');
  for (const d of [join(proj, '.crux'), join(root, 'home'), crux, data]) mkdirSync(d, { recursive: true });
  child = spawn(process.execPath, [join(HUB, 'server.mjs'), '--port', String(port), '--remote-port', String(rport), '--no-agents', '--test-pair', proj], {
    cwd: HUB, windowsHide: true,
    env: { ...process.env, CRUX_HUB_DATA: data, CRUX_HOME: crux, USERPROFILE: join(root, 'home'), HOME: join(root, 'home'), CRUX_HUB_AGENTS: '0', CRUX_HUB_PORT: '', CRUX_HUB_RESTARTED: '' }
  });
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  t.after(async () => {
    assert.notEqual(port, 4747); assert.notEqual(port, 4748);
    try { child.kill(); } catch { }
    for (const pid of await pidsOnPort(port)) await stopTree(pid);
    await sleep(400);
    removeTmp(root);
  });
  for (let i = 0; i < 100 && !out.includes('Crux hub: http'); i++) await sleep(100);
  assert.ok(out.includes(`Crux hub: http://127.0.0.1:${port}`), `the test hub started:\n${out}`);
  const state = async () => (await call('GET', '/api/state')).json.projects[0];
  assert.deepEqual([(await state()).permissionCheck, (await state()).paused], ['off', false], 'off and running by default');

  const on = await call('POST', '/api/settings', { project: 'proj', permissionCheck: 'on' });
  assert.equal(on.status, 403, on.text);
  assert.match(on.json.stepUp.why, /permission check answer requests for proj/i);
  assert.equal((await state()).permissionCheck, 'off', 'refused: still off');

  const shadow = await call('POST', '/api/settings', { project: 'proj', permissionCheck: 'shadow' });
  assert.equal(shadow.status, 200, shadow.text);
  assert.equal(shadow.json.permissionCheck, 'shadow');
  assert.equal((await state()).permissionCheck, 'shadow');
  assert.equal((await call('POST', '/api/settings', { project: 'proj', paused: true })).json.paused, true);
  assert.equal((await state()).paused, true);
  assert.equal((await call('POST', '/api/settings', { project: 'proj', paused: false })).json.paused, false);
  assert.equal((await call('POST', '/api/settings', { project: 'proj', permissionCheck: 'off' })).json.permissionCheck, 'off');
  // from a device that is not paired nothing changes at all
  assert.equal((await call('POST', '/api/settings', { project: 'proj', permissionCheck: 'shadow' }, true)).status, 401);
});
