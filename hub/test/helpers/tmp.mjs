// Shared temp-folder helper for the hub tests.
//
//   makeTmp('crux-thing-')      -> a fresh folder under os.tmpdir(), removed when the test file ends
//   makeTmp('crux-thing-', t)   -> the same, but removed when that one test (t) ends
//   removeTmp(dir)              -> remove one folder now (only if makeTmp made it)
//
// Only folders made here are ever removed; nothing is matched or globbed in the temp folder.
// Removal retries briefly, because on Windows a just-stopped process can still hold a file.
// Stop any spawned server before the folder goes: stop it in the test, or (for a whole file)
// register its stop with after() BEFORE the first makeTmp call.
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const made = new Set();   // made here and not yet removed
const ever = new Set();   // every folder made here: a hub's late timer can write into one after it was removed

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Remove one folder this module made. Returns true when it is gone. `tries` bounds the wait for a lock to clear.
export function removeTmp(dir, tries = 20) {
  if (!made.has(dir)) return false;
  for (let i = 0; i < tries; i++) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked: retry */ }
    if (!existsSync(dir)) { made.delete(dir); return true; }
    if (i < tries - 1) sleep(100 + i * 50);
  }
  return false;
}

// When the test file ends (node:test runs hooks in the order they were registered, and this one is registered first),
// a short try only: a file that runs a spawned hub stops it in its own after() and removes its folder there. Whatever
// is still locked, or was written to again by a late timer in a hub the test left running, is removed for good as the
// process exits, when nothing is left to write and every child has been stopped. Only folders made here, never a glob.
after(() => { for (const d of [...made]) removeTmp(d, 2); });
process.on('exit', () => {
  for (const d of ever) {
    for (let i = 0; i < 10 && existsSync(d); i++) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* locked: retry */ }
      if (existsSync(d) && i < 9) sleep(100 + i * 50);
    }
  }
});

export function makeTmp(prefix, t) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.add(dir); ever.add(dir);
  if (t && typeof t.after === 'function') t.after(() => removeTmp(dir));
  return dir;
}

// Folders still registered (not yet removed): used by the guard test.
export function pendingTmp() { return [...made]; }
