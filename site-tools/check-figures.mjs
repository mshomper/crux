// Checks that every picture on the page loads by itself when a reader scrolls to it: no clicks, nothing forced.
// Serves site/ over http (no cache), opens it at 1440 and 390 wide, scrolls down a screen at a time like a
// reader, and lists any picture that is on the page but did not load.  node check-figures.mjs
// (With scripts off, check by eye instead: node shoot.mjs --root ../site --url index.html --noscript --slice 2600 ...)
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const walk = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let y = 0; y < document.documentElement.scrollHeight; y += Math.round(innerHeight * 0.8)) { scrollTo(0, y); await sleep(350); }
  await sleep(1500);
  const shown = i => { const b = i.getBoundingClientRect(); return i.offsetParent !== null || b.width > 0; };
  const rows = [...document.images].filter(shown).map(i => ({ file: (i.currentSrc || i.src).split('/').pop(), loaded: i.complete && i.naturalWidth > 0, lazy: i.loading === 'lazy' }));
  const bad = rows.filter(r => !r.loaded);
  return rows.length + ' pictures, ' + bad.length + ' not loaded' + (bad.length ? ': ' + bad.map(r => r.file).join(', ') : '');
})()`;
for (const [w, h, dpr] of [[1440, 900, 1], [390, 844, 2]]) {
  console.log(`--- ${w} wide`);
  const args = [join(here, 'shoot.mjs'), '--root', join(here, '..', 'site'), '--url', 'index.html', '--w', String(w), '--h', String(h), '--dpr', String(dpr), '--view', '--wait', '1500', '--print', walk, '--out', join(here, 'shots', `check-${w}.png`)];
  spawnSync(process.execPath, args, { stdio: 'inherit' });
}
