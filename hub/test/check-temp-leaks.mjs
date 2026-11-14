// Guard: do the hub tests leave anything behind in the temp folder?
//
//   node test/check-temp-leaks.mjs            a representative set of files (fast)
//   node test/check-temp-leaks.mjs --all      the whole suite
//   node test/check-temp-leaks.mjs a.test.mjs b.test.mjs   just these files (names inside hub/test)
//
// The tests run with TEMP / TMP / TMPDIR pointed at one fresh folder made here, so anything left in it is a leak from
// this run (and nothing another program is doing in the real temp folder can be mistaken for one). The folder is
// removed at the end. Exit code 0 = clean, 1 = leftovers or failing tests.
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB = join(HERE, '..');

// One file per kind of temp use: in-process hubs, per-test folders, a spawned test hub, a git fixture, a folder at module level.
const REPRESENTATIVE = ['answer-notes', 'decision-brief', 'desktop-notify', 'decisions-desk', 'permission-rules', 'relaunch', 'setup', 'write-guard-http'].map(n => `${n}.test.mjs`);

const args = process.argv.slice(2);
const files = args.includes('--all') ? readdirSync(HERE).filter(f => f.endsWith('.test.mjs')).sort()
  : args.length ? args.filter(a => !a.startsWith('--'))
  : REPRESENTATIVE;

const sandbox = mkdtempSync(join(tmpdir(), 'crux-leakcheck-'));
let code = 0;
try {
  console.log(`running ${files.length} file(s) with the temp folder set to ${sandbox}`);
  const r = spawnSync(process.execPath, ['--test', ...files.map(f => join(HERE, f))], {
    cwd: HUB, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, TEMP: sandbox, TMP: sandbox, TMPDIR: sandbox }
  });
  const tail = String(r.stdout).split('\n').filter(l => /^[#ℹ] (tests|pass|fail|cancelled|skipped)\b/.test(l));
  console.log(tail.join('\n'));
  if (r.status !== 0) { code = 1; console.log(`the tests failed (exit ${r.status}); output tail:\n${String(r.stdout).split('\n').slice(-40).join('\n')}\n${String(r.stderr).slice(-2000)}`); }
  const left = readdirSync(sandbox);
  if (left.length) { code = 1; console.log(`LEFT BEHIND: ${left.length} item(s) in the temp folder:\n  ${left.join('\n  ')}`); }
  else console.log('clean: nothing left in the temp folder');
} finally {
  if (existsSync(sandbox)) { try { rmSync(sandbox, { recursive: true, force: true }); } catch (e) { console.log(`could not remove ${sandbox}: ${e.message}`); code = 1; } }
}
process.exit(code);
