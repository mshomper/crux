#!/usr/bin/env node
// One-time sign-in for hub agents: opens the Claude Code that ships with the Agent SDK.
// Type /login, sign in with your Claude plan, then /exit. Agents then draw from your plan's limits.
//   --signin          the hub's Account card opens this in a terminal window ("Sign in as someone else"): it runs Claude Code's
//                     own sign-in, and the window stays open until Enter, whatever happens, so the result can be read.
//   --claude <path>   the Claude Code to run (the desktop app downloads its own at first run); else the SDK's.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const signin = process.argv.includes('--signin');
const given = process.argv.includes('--claude') ? process.argv[process.argv.indexOf('--claude') + 1] : null;
const require = createRequire(import.meta.url);
const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
let bin = given && existsSync(given) ? given : null;
if (!bin) { try { bin = join(dirname(require.resolve(`${pkg}/package.json`)), process.platform === 'win32' ? 'claude.exe' : 'claude'); } catch { } }

// In the Account card's window an error must not close the window before it can be read.
function stop(code, lines) {
  for (const l of lines) console.log(l);
  if (!signin) process.exit(code);
  console.log('Press Enter to close this window.');
  process.stdin.once('data', () => process.exit(code)); process.stdin.resume();
}

if (!bin || !existsSync(bin)) {
  stop(1, [`Could not find Claude Code${given ? ` at ${given}` : ` (${pkg})`}. ${given ? 'Open the hub once so it can download it, or' : 'Run "npm install" in the hub folder, or'} install Claude Code and run "claude auth login" yourself.`]);
} else {
  // the sign-in window keeps CLAUDE_CONFIG_DIR, so it signs in where the hub's agents look
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_)/.test(k) || (signin && k === 'CLAUDE_CONFIG_DIR')));
  if (signin) {
    console.log('Signing in to Claude Code. A browser tab opens; sign in as the person you want the hub\'s agents to use.');
    console.log('This also switches your other Claude Code sessions on this PC.\n');
    const child = spawn(bin, ['auth', 'login'], { stdio: 'inherit', env });
    child.on('error', e => stop(1, [`\nClaude Code could not start (${e.code || e.message}). Nothing changed.`]));
    child.on('exit', code => stop(code || 0, [code ? '\nSign-in did not finish. Nothing changed.' : '\nDone. The hub restarts in a moment so its agents use the new sign-in.']));
  } else {
    console.log('Opening Claude Code. Type /login, sign in with your Claude plan, then /exit.\n');
    spawn(bin, [], { stdio: 'inherit', env }).on('exit', code => process.exit(code ?? 0));
  }
}
