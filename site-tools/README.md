# Site tools

Helpers for building and checking the public page in `../site/`. Nothing here is uploaded.

**Publishing:** upload the contents of `site/` as they are to the web host (crux.notarobot-eng.com). Plain files, relative links, no build step, nothing loaded from other servers.

| File | What it does |
| --- | --- |
| `shoot.mjs` | Takes a PNG of a page with headless Edge or Chrome. No dependencies. |
| `shoot-site.mjs` | Shoots the whole page at 1440 and 390 wide into `shots/` (not committed). `node shoot-site.mjs share` rewrites `site/img/share.png`, the picture shown when the link is shared. |
| `fetch-fonts.mjs` | Downloads Inter and JetBrains Mono (SIL Open Font Licence) from their GitHub repositories into `site/fonts/`. Already run; the files are committed. |
| `serve-site.mjs` | Serves `site/` on `http://127.0.0.1:4810/` (this machine only) so the page and its live swarm can be opened in a browser. Opening `index.html` from the folder does not work because the scripts are ES modules. |
| `stage/crux-all.mjs` | Builds the all-projects roll-up from two made-up projects with the real roll-up script and shoots `site/img/crux-all.png`, with a neutral folder path. |
| `stage/` | Stages a demo Hub (a made-up hiking-trail planner, user "Alex") on a spare port with no agents, and takes the Hub screenshots in `site/img/`. See the notes at the top of `stage/stage.mjs` and `stage/shots.mjs`. The working and waiting states in those shots are staged by `stage/overlay-proxy.mjs`; no agent ran. |

`site/js/core/` is a copy of the Hub's live-map drawing code (`hub/public/map-*.js`, `models.js`), unchanged, so the hero draws the same swarm core as the Hub. To re-copy after the Hub's map changes: copy `map-core`, `map-gl`, `map-hud`, `map-layout`, `map-particles` and `models` from `hub/public/`. `site/js/hero.js` sets the page's own particle budget (30,000 on a desktop, 10,000 on a phone, against the Hub's 60,000 and 10,000) on the core's budget object, so the copies stay untouched.
