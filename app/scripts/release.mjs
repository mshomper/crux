#!/usr/bin/env node
// Build a release of the desktop app: the installer, its updater signature and latest.json (decision 52 A).
//   npm run release            (in app/)
// Output in app/release/CruxHub-<version>/: CruxHub_<version>_x64-setup.exe, its .sig, and latest.json. Upload all
// three to a GitHub release tagged v<version> (gh release create v<version> app/release/CruxHub-<version>/*);
// installed apps read latest.json from the newest release and offer "Install update <version>" in the tray.
//
// The updater signature uses the private key in %USERPROFILE%\.tauri\crux-hub-updater.key (no password), or
// TAURI_SIGNING_PRIVATE_KEY. It never goes into the repo. Lose it and installed apps can never update again.
//
// Code signing (decision 53 C: unsigned for now). When a certificate or signing service is chosen, it goes in
// tauri.conf.json as bundle.windows.signCommand, for example "signCommand": "<tool> sign ... %1"; nothing else here
// changes.
//
// Extra arguments go to `tauri build` (for a rehearsal: --config <file>). CRUX_RELEASE_BASE_URL replaces the GitHub
// download address in latest.json (for a rehearsal against a local server).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const conf = JSON.parse(readFileSync(join(app, 'src-tauri', 'tauri.conf.json'), 'utf8'));
// A rehearsal passes --config <file> (its own name, identifier and version): read those the way tauri merges them.
const args = process.argv.slice(2);
args.forEach((a, i) => { if (a === '--config' && args[i + 1]) Object.assign(conf, JSON.parse(readFileSync(resolve(app, args[i + 1]), 'utf8')), { plugins: conf.plugins }); });
const version = conf.version;
const say = s => console.log(`[release] ${s}`);
const fail = s => { console.error(`[release] ${s}`); process.exit(1); };

const env = { ...process.env };
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const key = join(homedir(), '.tauri', 'crux-hub-updater.key');
  if (!existsSync(key)) fail(`No updater key: ${key} is missing (and TAURI_SIGNING_PRIVATE_KEY is not set).`);
  env.TAURI_SIGNING_PRIVATE_KEY = key;
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';

const extra = args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
const build = spawnSync(`npx tauri build ${extra}`.trim(), { cwd: app, env, stdio: 'inherit', shell: true });
if (build.status !== 0) fail('tauri build failed.');

const nsis = join(app, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const built = join(nsis, `${conf.productName}_${version}_x64-setup.exe`);
if (!existsSync(built) || !existsSync(`${built}.sig`)) fail(`Missing ${built} or its .sig.`);

const product = conf.productName.replace(/\s+/g, '');   // no spaces: GitHub renames assets that have them
const out = join(app, 'release', `${product}-${version}`);
mkdirSync(out, { recursive: true });
const name = `${product}_${version}_x64-setup.exe`;
copyFileSync(built, join(out, name));
copyFileSync(`${built}.sig`, join(out, `${name}.sig`));
const base = (env.CRUX_RELEASE_BASE_URL || `https://github.com/mshomper/crux/releases/download/v${version}`).replace(/\/+$/, '');
writeFileSync(join(out, 'latest.json'), JSON.stringify({
  version,
  notes: `Crux Hub ${version}`,
  pub_date: new Date().toISOString(),
  platforms: { 'windows-x86_64': { signature: readFileSync(`${built}.sig`, 'utf8').trim(), url: `${base}/${name}` } }
}, null, 2) + '\n');
say(`${name}: ${(statSync(join(out, name)).size / 1048576).toFixed(1)} MB`);
say(`Ready in ${out}: the installer, its .sig and latest.json.`);
