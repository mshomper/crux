#!/usr/bin/env node
// Takes the staged Hub screenshots into site/img/, one shoot.mjs run each. Needs start-hub.mjs and
// overlay-proxy.mjs running.   node site-tools/stage/shots.mjs            all of them
//                              node site-tools/stage/shots.mjs hub-hero   only the ones named
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { shoot, imgDir, PROXY_PORT } from './paths.mjs';

const base = `http://127.0.0.1:${PROXY_PORT}`;
const DESK = { w: 1440, h: 900 }, PHONE = { w: 390, h: 844, dpr: 2 };
// Steps run in the page before the shot: click things in order, with a pause after each.
const steps = (...xs) => `(async () => { const z = ms => new Promise(r => setTimeout(r, ms)); ${xs.map(x => `${x}; await z(350);`).join(' ')} await z(900); })()`;
const click = sel => `document.querySelector(${JSON.stringify(sel)}).click()`;
const thread = t => click(`[data-thread="${t}"]`);
const section = k => `(b => { if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); })(document.querySelector('[data-board-sec="${k}"]'))`;
// The robot lab's sample captions name the hub's owner; the demo user is Alex.
const noNames = `(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let n; (n = w.nextNode());) n.nodeValue = n.nodeValue.replace(/waits on Matt/g, 'waits on you').replace(/Matt picked/g, 'You picked').replace(/before Matt click-tests it/g, 'before you try it').replace(/Matt/g, 'Alex'); })()`;

const SHOTS = {
  'hub-hero': { ...DESK, wait: 5000, eval: steps(thread('orchestrator')) },
  'hub-needs-you': { ...DESK, wait: 4500 },
  'hub-board': { ...DESK, wait: 4500, eval: steps(thread('orchestrator'), click('#open-board'), section('requirements'), section('decided'), section('memos')) },
  'hub-map': { ...DESK, wait: 4500, eval: steps(thread('orchestrator'), click('.hud-open'), 'await z(1500)') },
  'hub-models': { ...DESK, wait: 4500, eval: steps(thread('elevation'), click('[data-mchip="elevation"]')) },
  'hub-handoff': { ...DESK, wait: 4500, eval: steps(thread('orchestrator'), click('#open-board'), section('handoffs'), click('[data-expand="entry:H001"]'), `document.querySelector('[data-sec="handoffs"]').scrollIntoView({ block: 'start' })`) },
  'hub-permissions': { ...DESK, wait: 4500, eval: steps(thread('orchestrator'), `document.querySelector('.perm-line').scrollIntoView({ block: 'center' })`) },
  'phone-needs-you': { ...PHONE, wait: 4500 },
  'phone-thread': { ...PHONE, wait: 4500, eval: steps(thread('orchestrator')) },
  'phone-list': { ...PHONE, wait: 4500, eval: steps(click('#back')) },
  'hub-needs-you-tall': { w: 1440, h: 1560, wait: 4500 },   // an extra: every waiting card in one tall shot
  'hub-robots': { w: 1440, h: 534, wait: 1500, path: '/lab/robots-lab.html', eval: noNames }
};

const want = process.argv.slice(2);
let failed = 0;
for (const [name, s] of Object.entries(SHOTS)) {
  if (want.length && !want.includes(name)) continue;
  const args = [shoot, '--url', base + (s.path || '/'), '--w', String(s.w), '--h', String(s.h), '--view', '--wait', String(s.wait), '--out', join(imgDir, `${name}.png`)];
  if (s.dpr) args.push('--dpr', String(s.dpr));
  if (s.eval) args.push('--eval', s.eval);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  if (r.status) failed++;
}
process.exit(failed ? 1 : 0);
