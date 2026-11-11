import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRequest, hostName, allowedHost, extraHosts } from '../lib/access.mjs';

const TS = 'pc-name.tail1234.ts.net';
const json = { 'content-type': 'application/json' };

test('host names are read without port or trailing dot', () => {
  assert.equal(hostName('localhost:4747'), 'localhost');
  assert.equal(hostName('[::1]:4747'), '[::1]');
  assert.equal(hostName(`${TS.toUpperCase()}.`), TS);
  assert.equal(hostName(''), '');
});

test('this machine and Tailscale names are allowed; anything else is not', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]', TS]) assert.ok(allowedHost(h), h);
  for (const h of ['', 'evil.com', 'ts.net', 'evil.ts.net.evil.com', '192.168.1.20', 'pc-name', '0.0.0.0']) assert.ok(!allowedHost(h), h);
  assert.ok(allowedHost('pc-name', ['pc-name']));
  assert.deepEqual(extraHosts({ CRUX_HUB_HOSTS: ' PC-Name , other ' }), ['pc-name', 'other']);
});

test('pages load on localhost and through tailscale serve', () => {
  assert.equal(checkRequest({ method: 'GET', path: '/', headers: { host: 'localhost:4747' } }), null);
  assert.equal(checkRequest({ method: 'GET', path: '/api/stream', headers: { host: TS } }), null);
  assert.equal(checkRequest({ method: 'GET', path: '/sw.js', headers: { host: `${TS}:443` } }), null);
});

test('DNS rebinding is refused: a foreign Host never gets in, not even for reads', () => {
  assert.match(checkRequest({ method: 'GET', path: '/api/state', headers: { host: 'attacker.example:4747' } }), /not this hub/);
  assert.match(checkRequest({ method: 'GET', path: '/', headers: {} }), /not this hub/);
});

test('the hub page may post from either address', () => {
  assert.equal(checkRequest({ method: 'POST', path: '/api/approval', headers: { host: TS, origin: `https://${TS}`, ...json } }), null);
  assert.equal(checkRequest({ method: 'POST', path: '/api/approval', headers: { host: 'localhost:4747', origin: 'http://localhost:4747', ...json } }), null);
  // tailscale serve may pass the Host on or rewrite it to the loopback address: both work
  assert.equal(checkRequest({ method: 'POST', path: '/api/send', headers: { host: '127.0.0.1:4747', origin: `https://${TS}`, 'content-type': 'application/json; charset=utf-8' } }), null);
  // tools on this machine (no Origin) still work
  assert.equal(checkRequest({ method: 'POST', path: '/api/send', headers: { host: 'localhost:4747', ...json } }), null);
});

test('other sites cannot change anything (CSRF)', () => {
  assert.match(checkRequest({ method: 'POST', path: '/api/approval', headers: { host: 'localhost:4747', origin: 'https://evil.example', ...json } }), /may not change/);
  assert.match(checkRequest({ method: 'POST', path: '/api/approval', headers: { host: 'localhost:4747', origin: 'null', ...json } }), /origin/i);
  assert.match(checkRequest({ method: 'POST', path: '/api/approval', headers: { host: 'localhost:4747', origin: 'file://', ...json } }), /may not change/);
  // a plain form post (no JSON) is refused even without an Origin header
  assert.match(checkRequest({ method: 'POST', path: '/api/approval', headers: { host: 'localhost:4747', 'content-type': 'text/plain' } }), /JSON/);
  assert.match(checkRequest({ method: 'POST', path: '/api/approval', headers: { host: 'localhost:4747', 'sec-fetch-site': 'cross-site', ...json } }), /Cross-site/);
});

test('the ping stays open to Crux pages opened as files', () => {
  assert.equal(checkRequest({ method: 'GET', path: '/api/ping', headers: { host: 'localhost:4747', origin: 'null' } }), null);
});
