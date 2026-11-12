#!/usr/bin/env node
// A read-only window onto the test hub, for screenshots: http://127.0.0.1:4802/ shows the hub on 4801 with the
// fixture's `overlay` laid over it, so the page draws what a restored hub cannot: an agent that is working, a
// permission card that is still waiting, a line of live activity. No agent runs and nothing reaches the hub but
// reads: every request that would change something is answered here and never passed on.
//   node site-tools/stage/overlay-proxy.mjs      stop it with: node hub/tools/stop-test-hub.mjs 4802
import { createServer, request } from 'node:http';
import { HUB_PORT, PROXY_PORT, PROJECT } from './paths.mjs';
import { overlay } from './fixture.mjs';

const upstream = (req, onRes) => request({ host: '127.0.0.1', port: HUB_PORT, path: req.url, method: 'GET', headers: { ...req.headers, host: `127.0.0.1:${HUB_PORT}` } }, onRes);

createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (req.method !== 'GET') { res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return; }   // never passed on

  if (path === '/api/state') {
    const up = upstream(req, r => {
      const parts = [];
      r.on('data', c => parts.push(c));
      r.on('end', () => {
        const state = JSON.parse(Buffer.concat(parts).toString('utf8'));
        for (const p of state.projects || []) {
          for (const a of p.agents) if (overlay.states[a.name] && a.state !== 'retired') { a.state = overlay.states[a.name]; a.live = a.state !== 'asleep'; }
          p.pendingApprovals = [...overlay.pendingApprovals];
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(state));
      });
    });
    up.on('error', e => res.writeHead(502).end(String(e)));
    return void up.end();
  }

  const up = upstream(req, r => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
    if (path === '/api/stream') {   // the live activity lines, repeated so they stay fresh while the page is open
      const tell = () => { for (const a of overlay.activity) res.write(`data: ${JSON.stringify({ type: 'activity', project: PROJECT, ...a })}\n\n`); };
      const first = setTimeout(tell, 1200), again = setInterval(tell, 8000);
      res.on('close', () => { clearTimeout(first); clearInterval(again); });
    }
  });
  up.on('error', e => { if (!res.headersSent) res.writeHead(502); res.end(String(e)); });
  req.on('close', () => up.destroy());
  up.end();
}).listen(PROXY_PORT, '127.0.0.1', () => console.log(`Overlay on http://127.0.0.1:${PROXY_PORT}/ (reads the test hub on ${HUB_PORT})`));
