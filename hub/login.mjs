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
console.log('Opening Claude Code. Type /login, sign in with your Claude plan, then /exit.\n');
spawn(bin, [], { stdio: 'inherit', env }).on('exit', code => process.exit(code ?? 0));
