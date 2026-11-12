#!/usr/bin/env node
// Starts the test hub for the screenshots, with its environment pointed at the staged demo folders (stage.mjs).
// A test hub: its data folder is in temp, --no-agents is passed and CRUX_HUB_AGENTS is not 1, so no agent starts.
//   node site-tools/stage/start-hub.mjs      stop it with: node hub/tools/stop-test-hub.mjs 4801
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirs, env, server, worktree, HUB_PORT } from './paths.mjs';

if (!existsSync(dirs.project)) { console.error('Nothing staged yet: run node site-tools/stage/stage.mjs first.'); process.exit(1); }
if (HUB_PORT === 4747) { console.error('Never port 4747.'); process.exit(1); }
const child = spawn(process.execPath, [server, '--port', String(HUB_PORT), '--no-agents', dirs.project], { cwd: worktree, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true });
child.on('exit', code => process.exit(code ?? 0));
