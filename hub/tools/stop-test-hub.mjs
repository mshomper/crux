#!/usr/bin/env node
// Stop a test hub: whatever listens on the given port, and the processes it started. Refuses 4747 and 4748, the hub
// Matt uses (4748 is its phone port).
//   node hub/tools/stop-test-hub.mjs <port>
// The permission rules treat this as contained (R005), unlike Stop-Process, taskkill or kill, which could hit 4747.
import { pidsOnPort, stopTree } from '../lib/relaunch.mjs';

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0 || port > 65535) { console.error('Usage: node hub/tools/stop-test-hub.mjs <port>'); process.exit(2); }
if (port === 4747 || port === 4748) { console.error(`Refusing to stop the hub on port ${port} (the live hub). Use a test hub port.`); process.exit(2); }

const pids = await pidsOnPort(port);
if (!pids.length) { console.log(`Nothing is listening on port ${port}.`); process.exit(0); }
let failed = 0;
for (const pid of pids) {
  const ok = await stopTree(pid);
  if (!ok) failed++;
  console.log(`${ok ? 'Stopped' : 'Could not stop'} process ${pid} (port ${port})`);
}
process.exit(failed ? 1 : 0);
