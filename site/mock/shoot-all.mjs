// Shoots every look at desktop and phone width into ./shots. Usage: node shoot-all.mjs [a b c] [--tops]
// --tops adds a first-screen shot of each (what you see before scrolling).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), tops = args.includes('--tops');
const looks = args.filter(a => /^[abc]$/.test(a));
const run = (...a) => spawnSync(process.execPath, [join(here, 'shoot.mjs'), ...a], { stdio: 'inherit' });
for (const k of looks.length ? looks : ['a', 'b', 'c']) {
  const url = `index.html?look=${k}`, out = n => join(here, 'shots', `look-${k}-${n}.png`);
  run('--url', url, '--w', '1440', '--wait', '3500', '--out', out('desktop'));
  run('--url', url, '--w', '390', '--h', '844', '--dpr', '2', '--wait', '3500', '--out', out('phone'));
  run('--url', `phones.html?look=${k}`, '--w', '2104', '--h', '890', '--view', '--wait', '4500', '--out', out('phone-screens'));
  if (tops) {
    run('--url', url, '--w', '1440', '--h', '900', '--view', '--wait', '3500', '--out', out('desktop-top'));
    run('--url', url, '--w', '390', '--h', '844', '--dpr', '2', '--view', '--wait', '3500', '--out', out('phone-top'));
  }
}
