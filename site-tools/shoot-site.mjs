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
  // The card is the page's top as it loads at 1200 x 630, with two changes made in the page before the shot: the hero's
  // drawing is replaced by a crop of img/hub-map.png (the Hub's own map: the swarm core with its satellites, so the card
  // matches the Hub as it looks now), and the lead is cut to its first sentence so no text runs off the bottom.
  const card = "document.querySelectorAll('.hero-core canvas,.hero-core .callout').forEach(e=>e.remove());" +
    "const c=document.querySelector('.hero-core');c.style.cssText+=';background:url(img/hub-map.png) -368px -166px/1325px 828px no-repeat;-webkit-mask-image:radial-gradient(circle at 50% 50%,#000 55%,transparent 78%);mask-image:radial-gradient(circle at 50% 50%,#000 55%,transparent 78%)';" +
    "const l=document.querySelector('.hero .lead');l.textContent=l.textContent.split('. ')[0]+'.';" +
    "document.querySelectorAll('.hero .fine,.hero .cta').forEach(e=>e.remove());new Promise(r=>setTimeout(r,1500))";
  run('--url', 'index.html', '--w', '1200', '--h', '630', '--view', '--wait', '3500', '--eval', card, '--out', join(root, 'img', 'share.png'));
} else {
  run('--url', 'index.html', '--w', '1440', '--wait', '3500', '--eval', ready, '--slice', '2600', '--out', join(here, 'shots', 'desktop.png'));
  run('--url', 'index.html', '--w', '390', '--h', '844', '--dpr', '2', '--wait', '3500', '--eval', ready, '--slice', '3000', '--out', join(here, 'shots', 'phone.png'));
  // the larger view, opened from the Needs you picture, then closed again with Escape's own path (close())
  const open = "document.querySelector('a.zoom[href*=needs-you]').click();new Promise(r=>setTimeout(r,900))";
  run('--url', 'index.html', '--w', '1440', '--h', '900', '--view', '--wait', '2500', '--eval', open, '--out', join(here, 'shots', 'zoom-desktop.png'));
  run('--url', 'index.html', '--w', '390', '--h', '844', '--dpr', '2', '--view', '--wait', '2500', '--eval', open, '--out', join(here, 'shots', 'zoom-phone.png'));
}
