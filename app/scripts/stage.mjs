#!/usr/bin/env node
// Build step for the installer (decision 52 A, as amended by 54 B): fills app/staging/runtime/ with what the
// installed app runs, and Tauri bundles that folder as resources (tauri.conf.json, bundle.resources). The folder is
// git-ignored and rebuilt from scratch each time: no node_modules or Anthropic file ever goes into the repo.
//
//   runtime/node/node.exe          the Node that runs this script (the build PC's), with a licence note
//   runtime/hub/                   the hub's tracked files (no tests, no Windows shortcuts for clones) + bundled.json
//   runtime/hub/node_modules/      npm ci from hub/package-lock.json, without optional packages: the Agent SDK's
//                                  330 MB Claude Code program is one of those, and is downloaded at first run instead
//   runtime/crux/                  the Crux scripts and templates the hub builds decision pages with
//   runtime/stop-bundled-hub.mjs   what the installer runs to stop this hub before replacing or removing its files
//   runtime/THIRD-PARTY.md         what is inside and under which terms
//
// Run by `tauri build` (build.beforeBuildCommand), or by hand: node scripts/stage.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '..');
const staging = join(app, 'staging');
const out = join(staging, 'runtime');
const say = s => console.log(`[stage] ${s}`);
const fail = s => { console.error(`[stage] ${s}`); process.exit(1); };

const appVersion = JSON.parse(readFileSync(join(app, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
rmSync(staging, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. The hub and the Crux scripts: the files git tracks or would track (new ones not yet committed included), so
// nothing git ignores (node_modules, logs, a guard-off file) comes along.
const SKIP = [/^hub\/test\//, /^hub\/Crux Hub\.cmd$/, /^hub\/Restart Crux Hub\.vbs$/, /^crux\/lenses\//, /^crux\/SKILL\.md$/, /(^|\/)guard-off$/];
const tracked = execFileSync('git', ['-C', repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'hub', 'crux'], { encoding: 'utf8' }).split('\0').filter(Boolean);
let files = 0;
for (const f of tracked) {
  if (SKIP.some(r => r.test(f))) continue;
  const src = join(repo, f);
  if (!existsSync(src)) continue;   // deleted in the working tree
  mkdirSync(dirname(join(out, f)), { recursive: true });
  copyFileSync(src, join(out, f));
  files++;
}
say(`${files} hub and Crux files`);

// 2. The hub's packages, exactly as its lock file pins them, with no optional packages (so no claude.exe).
const ci = spawnSync('npm ci --omit=optional --omit=dev --no-audit --no-fund --loglevel=error', { cwd: join(out, 'hub'), stdio: 'inherit', shell: true });
if (ci.status !== 0) fail('npm ci failed in the staged hub.');
const anthropic = join(out, 'hub', 'node_modules', '@anthropic-ai');
const platformPkgs = existsSync(anthropic) ? readdirSync(anthropic).filter(n => /^claude-agent-sdk-(win32|darwin|linux)/.test(n)) : [];
if (platformPkgs.length) fail(`Claude Code's program got into the bundle (${platformPkgs.join(', ')}); it must be downloaded at first run instead.`);
writeFileSync(join(out, 'hub', 'bundled.json'), JSON.stringify({ bundled: true, app: appVersion, node: process.version, staged: new Date().toISOString() }, null, 1) + '\n');

// 3. Node itself.
mkdirSync(join(out, 'node'), { recursive: true });
copyFileSync(process.execPath, join(out, 'node', 'node.exe'));
const nodeLicence = join(dirname(process.execPath), 'LICENSE');
if (existsSync(nodeLicence)) copyFileSync(nodeLicence, join(out, 'node', 'LICENSE'));

// 4. The stop script the installer hooks run.
copyFileSync(join(app, 'scripts', 'stop-bundled-hub.mjs'), join(out, 'stop-bundled-hub.mjs'));

// 5. What is inside.
const sdk = JSON.parse(readFileSync(join(anthropic, 'claude-agent-sdk', 'package.json'), 'utf8'));
writeFileSync(join(out, 'THIRD-PARTY.md'), `# What this folder holds

- **Crux Hub** (hub/, crux/): MIT licence, https://github.com/mshomper/crux
- **Node.js ${process.version}** (node/node.exe): MIT licence, Copyright OpenJS Foundation and other contributors. Full licence, including the projects Node.js is built from: https://github.com/nodejs/node/blob/${process.version}/LICENSE
- **Packages in hub/node_modules**: each under its own licence, in its own folder.
- **Claude Agent SDK ${sdk.version}** (hub/node_modules/@anthropic-ai/claude-agent-sdk): © Anthropic PBC, all rights reserved; used under Anthropic's terms, https://code.claude.com/docs/en/legal-and-compliance
- **Claude Code** is not in this folder. On first run the setup screen downloads version ${sdk.claudeCodeVersion} from Anthropic's own package and checks it; it is kept in your .crux-hub folder. Its use is under Anthropic's terms, with your own API key.
`);

// Size, for the record.
const size = d => readdirSync(d).reduce((n, name) => { const f = join(d, name); const s = statSync(f); return n + (s.isDirectory() ? size(f) : s.size); }, 0);
say(`runtime/ is ${(size(out) / 1048576).toFixed(1)} MB (Node ${process.version}, Agent SDK ${sdk.version}, Claude Code ${sdk.claudeCodeVersion} downloaded at first run)`);
