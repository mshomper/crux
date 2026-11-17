#!/usr/bin/env node
// Claude Code's apiKeyHelper for the Account card's saved key (decision 78 A): prints the key, opened with Windows'
// protection for this user, and nothing else. Claude Code runs it when it needs the key and keeps the answer for a while, so
// the key is never in the environment every agent command inherits. usage: node key-helper.mjs <secrets.json>
import { Secrets } from './setup.mjs';

const key = process.argv[2] ? new Secrets({ file: process.argv[2] }).apiKey : null;
if (!key) { console.error('The hub\'s saved API key could not be opened. Open the Account card and paste it again.'); process.exit(1); }
process.stdout.write(key);
