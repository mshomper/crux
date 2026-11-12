// Shoots the site for review into site-tools/shots (not committed).
//   node shoot-site.mjs            whole page at 1440 and 390 wide, in slices that are easy to read
//   node shoot-site.mjs share      the 1200 x 630 sharing picture, written to site/img/share.png
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'site');
const run = (...a) => spawnSync(process.execPath, [join(here, 'shoot.mjs'), '--root', root, ...a], { stdio: 'inherit' });
// pictures further down load only when scrolled to; ask for them all, and open the folded parts, before a full-page shot
const ready = "document.querySelectorAll('img').forEach(i=>{i.loading='eager'});document.querySelectorAll('details').forEach(d=>{d.open=true});Promise.all([...document.images].map(i=>i.decode().catch(()=>{})))";

if (process.argv[2] === 'share') {
  run('--url', 'index.html', '--w', '1200', '--h', '630', '--view', '--wait', '3500', '--out', join(root, 'img', 'share.png'));
} else {
  run('--url', 'index.html', '--w', '1440', '--wait', '3500', '--eval', ready, '--slice', '2600', '--out', join(here, 'shots', 'desktop.png'));
  run('--url', 'index.html', '--w', '390', '--h', '844', '--dpr', '2', '--wait', '3500', '--eval', ready, '--slice', '3000', '--out', join(here, 'shots', 'phone.png'));
  // the larger view, opened from the Needs you picture, then closed again with Escape's own path (close())
  const open = "document.querySelector('a.zoom[href*=needs-you]').click();new Promise(r=>setTimeout(r,900))";
  run('--url', 'index.html', '--w', '1440', '--h', '900', '--view', '--wait', '2500', '--eval', open, '--out', join(here, 'shots', 'zoom-desktop.png'));
  run('--url', 'index.html', '--w', '390', '--h', '844', '--dpr', '2', '--view', '--wait', '2500', '--eval', open, '--out', join(here, 'shots', 'zoom-phone.png'));
}
