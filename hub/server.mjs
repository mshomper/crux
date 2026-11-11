#!/usr/bin/env node
// Crux hub: node server.mjs [--port 4747] [--retire-at 60] [project folders...]
// Projects also come from ~/crux/hub.json ({ "projects": ["C:/path/a", ...] }). Default: the current folder.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, normalize, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Hub } from './lib/hub.mjs';
import { parseQuickPicks } from './lib/quick.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, 2); return v; };
const port = Number(flag('--port', process.env.CRUX_HUB_PORT || 4747));
const retireAt = Number(flag('--retire-at', 60));

let projects = args.map(a => resolve(a));
const cfg = join(homedir(), 'crux', 'hub.json');
if (!projects.length && existsSync(cfg)) {
  try { projects = (JSON.parse(readFileSync(cfg, 'utf8')).projects || []).map(p => resolve(p)); } catch (e) { console.warn(`Could not read ${cfg}: ${e.message}`); }
}
if (!projects.length) projects = [process.cwd()];

const hub = new Hub({ projects, retireAt });

// ---------- http ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const clients = new Set();
hub.on(ev => { const line = `data: ${JSON.stringify(ev)}\n\n`; for (const res of clients) res.write(line); });

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
function serveFile(res, file) {
  if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'Not found' });
  send(res, 200, readFileSync(file), TYPES[extname(file)] || 'application/octet-stream');
}
async function body(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 1e6) throw new Error('Too large'); }
  return s ? JSON.parse(s) : {};
}

const routes = {
  'GET /api/state': () => ({ projects: hub.state(), retireAt: hub.retireAt }),

  'POST /api/send': ({ project, thread, text }) => {
    const p = hub.project(project);
    text = String(text || '').trim();
    if (!text) throw new Error('Empty message');
    const open = p.board.decisions().filter(d => d.status === 'open');
    const picks = parseQuickPicks(text, open);
    if (picks) {
      p.log.append('message', { thread, from: 'you', text });
      return { picked: hub.pickMany(p, picks).map(d => d.id) };
    }
    hub.fromYou(p, thread, text);
    return { ok: true };
  },

  'POST /api/pick': ({ project, picks }) => ({ picked: hub.pickMany(hub.project(project), picks).map(d => d.id) }),
  'POST /api/approval': ({ id, allow, note }) => { hub.answerApproval(id, !!allow, note); return { ok: true }; },
  'POST /api/retire': ({ project }) => { hub.retire(hub.project(project)); return { ok: true }; },
  'POST /api/worker': ({ project, name, task }) => ({ name: hub.startWorker(hub.project(project), name, task).name }),
  'POST /api/entry': ({ project, ...entry }) => ({ entryId: hub.project(project).board.addEntry({ ...entry, from: 'you' }).entryId })
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': hello\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return send(res, 200, await route(req.method === 'POST' ? await body(req) : Object.fromEntries(url.searchParams)));

    // Crux decision pages for each project: /p/<project>/<file>
    const m = /^\/p\/([^/]+)\/([\w.-]+\.html)$/.exec(url.pathname);
    if (m) return serveFile(res, join(hub.project(decodeURIComponent(m[1])).board.decisionsDir, m[2]));

    const pub = join(here, 'public');
    const file = normalize(join(pub, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(pub)) return send(res, 403, { error: 'Forbidden' });
    serveFile(res, file);
  } catch (e) {
    send(res, 400, { error: e.message });
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Crux hub: http://localhost:${port}`);
  console.log(`Projects: ${[...hub.projects.values()].map(p => p.name).join(', ')}`);
  console.log(`Orchestrator hands off at ${retireAt}% context.`);
});

process.on('SIGINT', () => {
  for (const p of hub.projects.values()) for (const a of p.agents.values()) a.close();
  process.exit(0);
});
