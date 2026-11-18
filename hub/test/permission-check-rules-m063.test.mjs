// M062 / M063 (2026-11-18): the code half of the check's new rules.
//  - temp folders handed to a test hub the worker starts (CRUX_HUB_DATA, CRUX_HOME) are recorded as made by that worker;
//  - (Join-Path $env:TEMP 'name') is read as $env:TEMP\name, for the folders the worker made and for the script look-up.
// No model here; the rule TEXT is tested in permission-check.test.mjs and permission-check-inputs.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { makeTmp } from './helpers/tmp.mjs';
import { classify } from '../lib/permission-rules.mjs';
import { scriptsFor, resolveJoinTemp } from '../lib/permission-scripts.mjs';

const rnd = () => randomBytes(4).toString('hex');
const norm = p => String(p).replace(/\\/g, '/').toLowerCase();
const T = n => join(tmpdir(), n);
const bash = { tool: 'Bash', projectDir: 'C:/proj', cwd: 'C:/proj/hub', agent: 'w', level: 'auto' };
const ps = { ...bash, tool: 'PowerShell' };

test('2a: the data and profile folders given to a test hub the worker starts are recorded as made by it', () => {
  const [d, h] = [`m063-d-${rnd()}`, `m063-h-${rnd()}`];
  const c = classify({ ...bash, input: { command: `CRUX_HUB_DATA="$TEMP/${d}" CRUX_HOME="$TEMP/${h}" node server.mjs --port 4805 --no-agents` } });
  assert.deepEqual(c.hubsStarted, [4805], `${c.route} ${c.reasons} ${c.unsure}`);
  assert.deepEqual(c.tempMade.map(norm).sort(), [T(d), T(h)].map(norm).sort());
  // and in PowerShell, with the folders built by Join-Path
  const [d2, h2] = [`m063-d-${rnd()}`, `m063-h-${rnd()}`];
  const p = classify({ ...ps, input: { command: `$env:CRUX_HUB_DATA = Join-Path $env:TEMP '${d2}'; $env:CRUX_HOME = Join-Path $env:TEMP '${h2}'; node server.mjs --port 4806 --no-agents` } });
  assert.deepEqual(p.tempMade.map(norm).sort(), [T(d2), T(h2)].map(norm).sort(), `${p.route} ${p.reasons} ${p.unsure}`);
});

test('2a: the next request may delete what the hub made for it (the hub keeps the record); another temp folder still may not', () => {
  const d = `m063-d-${rnd()}`;
  const start = classify({ ...bash, input: { command: `CRUX_HUB_DATA="$TEMP/${d}" CRUX_HOME="$TEMP/${d}-home" node server.mjs --port 4807 --no-agents` } });
  const del = classify({ ...bash, madeTemp: start.tempMade, input: { command: `rm -rf "$TEMP/${d}" "$TEMP/${d}-home"` } });
  assert.equal(del.route, 'allow', `${del.reasons} ${del.unsure}`);
  assert.deepEqual(del.unsure, []);
  const other = classify({ ...bash, madeTemp: start.tempMade, input: { command: `rm -rf "$TEMP/someone-elses-${rnd()}"` } });
  assert.notEqual(other.route, 'allow', 'a folder it did not make is not its own');
  const without = classify({ ...bash, input: { command: `rm -rf "$TEMP/${d}"` } });
  assert.notEqual(without.route, 'allow', 'with no record, as before');
});

test('2a: a folder that already exists, one outside temp, or one in the live hub\'s place is not recorded', () => {
  const have = basename(makeTmp('m063-have-'));   // exists, and is removed when this file ends
  const c = classify({ ...bash, input: { command: `CRUX_HUB_DATA="$TEMP/${have}" CRUX_HOME="$TEMP/${have}-h" node server.mjs --port 4808 --no-agents` } });
  assert.ok(!c.tempMade.map(norm).includes(norm(T(have))), 'it exists already, so it was not made for this worker');
  assert.ok(c.tempMade.map(norm).includes(norm(T(`${have}-h`))), 'the one that is new is');
  const live = classify({ ...bash, input: { command: 'CRUX_HUB_DATA="$HOME/.crux-hub" CRUX_HOME="$HOME/crux" node server.mjs --port 4809 --no-agents' } });
  assert.equal(live.route, 'human', 'the live hub\'s data stays a hard stop');
  assert.deepEqual(live.tempMade, []);
});

test('2b: (Join-Path $env:TEMP \'name\') is read as $env:TEMP\\name', () => {
  assert.equal(resolveJoinTemp("Remove-Item -Recurse (Join-Path $env:TEMP 'foo')"), 'Remove-Item -Recurse $env:TEMP\\foo');
  assert.equal(resolveJoinTemp('node (Join-Path $env:TMP "a\\b.mjs") x'), 'node $env:TMP\\a\\b.mjs x');
  assert.equal(resolveJoinTemp("(Join-Path -Path $env:TEMP -ChildPath 'foo')"), '$env:TEMP\\foo');
  assert.equal(resolveJoinTemp("( join-path ${env:temp} 'foo' )"), '${env:temp}\\foo');
  // anything but two plain words is left as written
  for (const s of ["(Join-Path $env:TEMP $x)", "(Join-Path $env:TEMP 'a b')", "(Join-Path $env:TEMP '..\\x')", "(Join-Path $env:TEMP 'C:\\x')", "(Join-Path $env:TEMP '\\x')", "(Join-Path $env:TEMP \"a$x\")", "(Join-Path $HOME 'foo')", "(Join-Path $env:TEMP 'foo' 'bar')", "$t = Join-Path $env:TEMP 'foo'"]) assert.equal(resolveJoinTemp(s), s, s);
});

test('2b: a delete written with Join-Path is matched against the folders the worker made', () => {
  const mine = `m063-mine-${rnd()}`;
  const made = [T(mine)];
  for (const cmd of [`Remove-Item -Recurse -Force (Join-Path $env:TEMP '${mine}')`, `Remove-Item -Recurse -Force $env:TEMP\\${mine}`, `$t = Join-Path $env:TEMP '${mine}'; Remove-Item -Recurse -Force $t`, `Remove-Item -Recurse -Force (Join-Path $env:TEMP '${mine}\\out')`]) {
    const c = classify({ ...ps, madeTemp: made, input: { command: cmd } });
    assert.equal(c.route, 'allow', `${cmd}: ${c.reasons} ${c.unsure}`);
  }
  const other = classify({ ...ps, madeTemp: made, input: { command: `Remove-Item -Recurse -Force (Join-Path $env:TEMP 'not-mine-${rnd()}')` } });
  assert.notEqual(other.route, 'allow', 'a folder it did not make');
  assert.match(other.unsure.join(' '), /not this agent's own/);
  const whole = classify({ ...ps, madeTemp: made, input: { command: 'Remove-Item -Recurse -Force $env:TEMP' } });
  assert.equal(whole.route, 'human', 'the whole temp folder stays a hard stop');
  const up = classify({ ...ps, madeTemp: made, input: { command: `Remove-Item -Recurse -Force (Join-Path $env:TEMP '..\\x')` } });
  assert.notEqual(up.route, 'allow', 'a way out of temp is not resolved');
});

test('2b: the script look-up finds a script named with Join-Path under temp, as it does for $env:TEMP\\name', async () => {
  const dirMade = makeTmp('m063-s-');
  const name = basename(dirMade);
  writeFileSync(join(dirMade, 'shot.mjs'), 'console.log(1)');
  const git = async () => ({ code: 1, out: '' });   // nothing is committed
  const a = await scriptsFor(`node (Join-Path $env:TEMP '${name}\\shot.mjs') out`, { cwd: 'C:/proj', projectDir: 'C:/proj', shell: 'powershell', git });
  const b = await scriptsFor(`node $env:TEMP\\${name}\\shot.mjs out`, { cwd: 'C:/proj', projectDir: 'C:/proj', shell: 'powershell', git });
  assert.deepEqual(a.scripts.map(s => [norm(s.path), s.kind]), b.scripts.map(s => [norm(s.path), s.kind]));
  assert.equal(a.scripts.length, 1);
  assert.equal(a.scripts[0].kind, 'uncommitted', 'found, so its text can be shown');
  assert.equal(a.unread, b.unread);
  const miss = await scriptsFor(`node (Join-Path $env:TEMP 'm063-none-${rnd()}\\x.mjs')`, { cwd: 'C:/proj', projectDir: 'C:/proj', shell: 'powershell', git });
  assert.equal(miss.scripts[0].kind, 'missing', 'a script that is not there is "missing" (a doubt), not built at run time');
});
