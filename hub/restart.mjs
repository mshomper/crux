#!/usr/bin/env node
// Restart the Crux hub: stop whatever listens on its port, start the hub again with no window, the way it was last
// started, wait until it answers, then open it. Double-click "Restart Crux Hub.vbs" to run this with no console.
//   node restart.mjs [--port 4747] [--no-open]
// Exit code 0 when the hub is back, 1 when it is not (the .vbs then says so, with where the log is).
import { DEFAULT_PORT, pidsOnPort, stopTree, readLaunch, startDetached, ping, waitFor, openApp, logFile } from './lib/relaunch.mjs';

const args = process.argv.slice(2);
const i = args.indexOf('--port');
const port = Number(i >= 0 ? args[i + 1] : process.env.CRUX_HUB_PORT || DEFAULT_PORT);
const open = !args.includes('--no-open');
const say = s => console.log(`[restart ${port}] ${s}`);

if (!Number.isInteger(port) || port <= 0 || port > 65535) { say('Give a port number, like --port 4747.'); process.exit(1); }

const pids = await pidsOnPort(port);
for (const pid of pids) say(`${await stopTree(pid) ? 'Stopped' : 'Could not stop'} process ${pid}`);
if (pids.length && !await waitFor(async () => !(await pidsOnPort(port)).length, { timeoutMs: 10000 })) say('The port is still taken; trying anyway.');

const spec = readLaunch(port);
say(`Starting: ${spec.node} ${spec.args.join(' ')}  (in ${spec.cwd})`);
startDetached(spec);
const boot = await waitFor(() => ping(port), { timeoutMs: 45000, everyMs: 400 });
if (!boot) { say(`The hub did not answer. Its log: ${logFile(port)}`); process.exit(1); }
say('The hub is back.');
if (open) openApp(`http://localhost:${port}/`);
