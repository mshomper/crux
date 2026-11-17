#!/usr/bin/env node
// One-time sign-in for hub agents: opens the Claude Code that ships with the Agent SDK.
// Type /login, sign in with your Claude plan, then /exit. Agents then draw from your plan's limits.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
let bin;
try { bin = join(dirname(require.resolve(`${pkg}/package.json`)), process.platform === 'win32' ? 'claude.exe' : 'claude'); } catch { }
if (!bin || !existsSync(bin)) {
  console.error(`Could not find ${pkg}. Run "npm install" in the hub folder first.`);
  process.exit(1);
}

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_)/.test(k)));
// --signin: the hub's Account card opens this in a terminal window ("Sign in as someone else"): it runs Claude Code's own
// sign-in, then waits for Enter so the result can be read. The hub re-reads who is signed in by itself.
if (process.argv.includes('--signin')) {
  console.log('Signing in to Claude Code. A browser tab opens; sign in as the person you want the hub\'s agents to use.');
  console.log('This also switches your other Claude Code sessions on this PC.\n');
  spawn(bin, ['auth', 'login'], { stdio: 'inherit', env }).on('exit', code => {
    console.log(code ? '\nSign-in did not finish. Nothing changed.' : '\nDone. The hub shows the new name in a moment.');
    console.log('Press Enter to close this window.');
    process.stdin.once('data', () => process.exit(code ?? 0)); process.stdin.resume();
  });
} else {
  console.log('Opening Claude Code. Type /login, sign in with your Claude plan, then /exit.\n');
  spawn(bin, [], { stdio: 'inherit', env }).on('exit', code => process.exit(code ?? 0));
}
