# Site tools

Helpers for building and checking the public page in `../site/`. Nothing here is uploaded.

**Publishing:** upload the contents of `site/` as they are to the web host (crux.notarobot-eng.com). Plain files, relative links, no build step, nothing loaded from other servers.

| File | What it does |
| --- | --- |
| `shoot.mjs` | Takes a PNG of a page with headless Edge or Chrome. No dependencies. |
| `shoot-site.mjs` | Shoots the whole page at 1440 and 390 wide into `shots/` (not committed). `node shoot-site.mjs share` rewrites `site/img/share.png`, the picture shown when the link is shared. |
| `fetch-fonts.mjs` | Downloads Inter and JetBrains Mono (SIL Open Font Licence) from their GitHub repositories into `site/fonts/`. Already run; the files are committed. |
| `stage/` | Stages a demo Hub (a made-up hiking-trail planner, user "Alex") on a spare port with no agents, and takes the Hub screenshots in `site/img/`. See the notes at the top of `stage/stage.mjs` and `stage/shots.mjs`. The working and waiting states in those shots are staged by `stage/overlay-proxy.mjs`; no agent ran. |

`site/js/core/` is a copy of the Hub's live-map drawing code (`hub/public/map-*.js`, `models.js`), unchanged, so the hero draws the same sphere as the Hub.
