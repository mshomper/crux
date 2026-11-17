// Decision 74 B, step A: the live stream carries an id on every message, and a page that lost the link resumes after
// the last id it saw instead of reading the whole state again. Against a real test hub (its own port, never 4747 or
// 4748; every folder in temp, deleted afterwards).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request, createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp, removeTmp } from './helpers/tmp.mjs';
import { pidsOnPort, stopTree } from '../lib/relaunch.mjs';

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

let port, rport, child, out = '', root;
test.before(async () => {
  do { port = await freePort(); } while (port === 4747 || port === 4748);
  do { rport = await freePort(); } while (rport === 4747 || rport === 4748 || rport === port);
  root = makeTmp('crux-stream-');
  const proj = join(root, 'proj'), data = join(root, 'data'), crux = join(root, 'crux');
  for (const d of [join(proj, '.crux'), join(proj, '.decisions'), crux, join(root, 'home'), data]) mkdirSync(d, { recursive: true });
  writeFileSync(join(proj, '.decisions', '.gitignore'), '*.html\n');
  const old = Array.from({ length: 5 }, (_, i) => JSON.stringify({ id: `old${i}`, ts: new Date(Date.now() - 60000 + i).toISOString(), type: 'message', thread: 'orchestrator', from: 'you', text: `old ${i}` }));
  writeFileSync(join(proj, '.crux', 'events.jsonl'), old.join('\n') + '\n');
  child = spawn(process.execPath, [join(HUB, 'server.mjs'), '--port', String(port), '--remote-port', String(rport), '--no-agents', proj], {
    cwd: HUB, windowsHide: true,
    env: { ...process.env, CRUX_HUB_DATA: data, CRUX_HOME: crux, USERPROFILE: join(root, 'home'), HOME: join(root, 'home'), CRUX_HUB_AGENTS: '0', CRUX_HUB_PORT: '', CRUX_HUB_RESTARTED: '' }
  });
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 100 && !out.includes('Crux hub: http'); i++) await sleep(100);
  assert.ok(out.includes(`Crux hub: http://127.0.0.1:${port}`), `the test hub started:\n${out}`);
});
test.after(async () => {
  assert.notEqual(port, 4747);
  try { child?.kill(); } catch { }
  for (const pid of await pidsOnPort(port)) await stopTree(pid);
  await sleep(500);
  removeTmp(root);
});

// A request as this PC's own page sends it.
function call(method, path, body) {
  return new Promise((ok, bad) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { host: `localhost:${port}`, ...(payload ? { 'content-type': 'application/json', origin: `http://localhost:${port}`, 'content-length': payload.length } : {}) };
    const r = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let t = ''; res.on('data', d => { t += d; }); res.on('end', () => { try { ok({ status: res.statusCode, json: JSON.parse(t) }); } catch { ok({ status: res.statusCode, text: t }); } });
    });
    r.on('error', bad); if (payload) r.write(payload); r.end();
  });
}
// The stream as a page reads it: every message with its id.
function listen(query = '') {
  const got = [];
  let req;
  const done = new Promise(ok => {
    req = request({ host: '127.0.0.1', port, path: `/api/stream${query}`, headers: { host: `localhost:${port}` } }, res => {
      let buf = '';
      res.on('data', d => {
        buf += d;
        for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const id = /^id: (\d+)/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
          if (data) got.push({ id: id ? Number(id) : null, ev: JSON.parse(data) });
        }
      });
      res.on('close', ok);
    });
    req.on('error', () => ok()); req.end();
  });
  return { got, close: () => { req.destroy(); return done; } };
}
const say = text => call('POST', '/api/send', { project: 'proj', thread: 'orchestrator', text });
const texts = got => got.filter(m => m.ev.type === 'message').map(m => m.ev.text);

test('the state says where the stream is, and every message after it carries a rising id', async () => {
  const st = (await call('GET', '/api/state')).json;
  assert.ok(st.stream.boot && Number.isInteger(st.stream.seq));
  const a = listen();
  await sleep(300);
  assert.equal((await say('one')).status, 200);
  await sleep(300);
  assert.equal((await say('two')).status, 200);
  await sleep(400);
  await a.close();
  const ids = a.got.filter(m => m.ev.type === 'message').map(m => m.id);
  assert.deepEqual(texts(a.got).slice(0, 2), ['one', 'two']);
  assert.ok(ids.every(Number.isInteger) && ids[1] > ids[0] && ids[0] > st.stream.seq);
});

test('a page that lost the link resumes after its last id: it gets what it missed, once, and nothing before', async () => {
  const st = (await call('GET', '/api/state')).json;
  const first = listen(`?boot=${st.stream.boot}&last=${st.stream.seq}`);
  await sleep(300);
  await say('before the drop');
  await sleep(300);
  const last = Math.max(...first.got.map(m => m.id || 0));
  await first.close();
  await say('missed one'); await say('missed two');
  await sleep(300);
  const second = listen(`?boot=${st.stream.boot}&last=${last}`);
  await sleep(400);
  await say('live again');
  await sleep(400);
  await second.close();
  assert.deepEqual(texts(second.got), ['missed one', 'missed two', 'live again']);
  assert.ok(second.got.every(m => m.ev.type !== 'resync'));
});

test('a page from before a restart, or with an unknown boot, is told to read the state again', async () => {
  const st = (await call('GET', '/api/state')).json;
  const other = listen(`?boot=not-this-hub&last=1`);
  await sleep(400);
  await other.close();
  assert.equal(other.got[0].ev.type, 'resync');
  assert.ok(other.got[0].id >= st.stream.seq, 'the message carries the stream\'s current id');
});

test('a plain connection with no resume asks for nothing and gets no resync', async () => {
  const plain = listen();
  await sleep(400);
  await plain.close();
  assert.ok(!plain.got.some(m => m.ev.type === 'resync'));
});

test('the state sends recent history only, and Show older brings the rest', async () => {
  for (let i = 0; i < 60; i++) await say(`bulk ${i}`);
  const st = (await call('GET', '/api/state')).json, p = st.projects[0];
  const msgs = p.events.filter(e => e.type === 'message' && e.thread === 'orchestrator');
  assert.ok(msgs.length < 70, `sent ${msgs.length}`);
  assert.ok(p.older.orchestrator > 0);
  const oldest = msgs[0].id;
  const page = (await call('GET', `/api/older?project=proj&thread=orchestrator&before=${oldest}`)).json;
  assert.ok(page.events.length > 0 && page.events.every(e => e.text));
  assert.equal(page.events.length + msgs.length - 0 >= 60, true);
});
