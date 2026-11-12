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
import { checkRequest, checkAttachmentRead, extraHosts } from './lib/access.mjs';
import { decodeDataUrl, MAX_BYTES } from './lib/attachments.mjs';
import { Push } from './lib/push.mjs';
import { MODELS, EFFORTS } from './lib/agent-types.mjs';
import { HubSettings } from './lib/settings.mjs';
import { launchSpec, saveLaunch, startDetached, logFile, testHubWithoutAgents, pageBuild } from './lib/relaunch.mjs';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
// Changes with every start, so a page waiting through a restart knows when the new hub is up.
const BOOT = randomUUID();
// The hub's version, and a fingerprint of the page's own files: an open page that reconnects to a hub whose page
// files differ reloads itself, so a restart onto new code never leaves the old page running.
const VERSION = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version;
const BUILD = pageBuild(join(here, 'public'));
const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, 2); return v; };
const port = Number(flag('--port', process.env.CRUX_HUB_PORT || 4747));
const retireAt = Number(flag('--retire-at', 60));
// Test hubs (--no-agents, or hub data in a temp folder) log messages but start no real agents.
const noAgents = testHubWithoutAgents({ args, env: process.env });
if (args.includes('--no-agents')) args.splice(args.indexOf('--no-agents'), 1);

let projects = args.map(a => resolve(a));
const cfg = join(homedir(), 'crux', 'hub.json');
// hub.json may also hold { "defaults": { "worker": { "model": "sonnet", "effort": "medium" }, "orchestrator": {...} } }.
let hubCfg = {};
if (existsSync(cfg)) {
  try { hubCfg = JSON.parse(readFileSync(cfg, 'utf8')); } catch (e) { console.warn(`Could not read ${cfg}: ${e.message}`); }
}
if (!projects.length) projects = (hubCfg.projects || []).map(p => resolve(p));
if (!projects.length) projects = [process.cwd()];

// Hub settings (decision 21: routePermissions, permissionTimeoutSec) start from hub.json and are saved in ~/.crux-hub.
const settings = new HubSettings({ initial: hubCfg });
const hub = new Hub({ projects, retireAt, defaults: hubCfg.defaults, settings, noAgents });
if (noAgents) console.log('Test hub: agents do not start here (set CRUX_HUB_AGENTS=1 to let them).');
hub.usage.start();   // decision 36: the plan meters, asked of any live agent every few minutes

// Phone notifications (decision 19): a card that needs you becomes a push to every subscribed phone.
const push = new Push();
const decisionStatus = (project, id) => { try { return hub.project(project).board.decision(id)?.status; } catch { return undefined; } };
const decisionOpen = (project, id) => ['open', 'found'].includes(decisionStatus(project, id));
hub.on(ev => { if (ev.logged) push.handle(ev, { approvals: hub.approvals, decisionOpen, decisionStatus, events: name => hub.project(name).log.events }); });
const hosts = extraHosts();

// The folders the Crux roll-up scans (same rule as crux/scripts/rollup.mjs): every project's Crux pages under
// them are served at /files/..., so the all-projects page, boards and decision pages all open from the hub.
const crux = process.env.CRUX_HOME || join(homedir(), 'crux');
let roots = [join(homedir(), 'Documents', 'GitHub')];
try { const c = JSON.parse(readFileSync(join(crux, 'config.json'), 'utf8')); if (Array.isArray(c.roots) && c.roots.length) roots = c.roots; } catch { }
roots = roots.map(r => resolve(r)).filter(r => existsSync(r));
const slash = s => s.replace(/\\/g, '/');
// file:///C:/.../GitHub/my-project/.decisions/0002-x.html  ->  /files/0/my-project/.decisions/0002-x.html
function hubUrl(fileUrl) {
  let path;
  try { path = slash(decodeURIComponent(new URL(fileUrl).pathname)).replace(/^\/([A-Za-z]:)/, '$1'); } catch { return fileUrl; }
  const i = roots.findIndex(r => path.toLowerCase().startsWith(slash(r).toLowerCase() + '/'));
  return i < 0 ? fileUrl : `/files/${i}/${path.slice(slash(roots[i]).length + 1).split('/').map(encodeURIComponent).join('/')}`;
}

// ---------- http ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };
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
// Uploads carry an image as base64 text (about 4/3 of its size); everything else stays small.
const BODY_LIMIT = { '/api/attach': Math.ceil(MAX_BYTES * 4 / 3) + 64 * 1024 };
async function body(req, limit = 1e6) {
  const parts = []; let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error(limit > 1e6 ? `Images must be ${MAX_BYTES / 1024 / 1024} MB or less.` : 'Too large');
    parts.push(c);
  }
  const s = Buffer.concat(parts).toString('utf8');
  return s ? JSON.parse(s) : {};
}

const routes = {
  'GET /api/state': () => ({ projects: hub.state(), retireAt: hub.retireAt, models: MODELS, efforts: EFFORTS, settings: hub.settings.all(), boot: BOOT, testHub: hub.noAgents, version: VERSION, build: BUILD, resumed: hub.resumed, usage: hub.usage.view(), bootAt: hub.bootAt }),
  // Restart from the hub's own menu: answer first, then hand over to a fresh hub started the same way (M010).
  'POST /api/restart': () => { setTimeout(restart, 200); return { ok: true, boot: BOOT, log: logFile(port) }; },
  // The off switch for decision 21: false sends every permission request to you.
  // Per repo (decision 34): { project, permissionMode: 'auto' | 'standard' }.
  // Decision 37: { idleHandoffMin, idleFloorPct }, the idle handoff's window (0 = off) and context floor.
  'POST /api/settings': ({ routePermissions, project, permissionMode, connectors, idleHandoffMin, idleFloorPct }) => {
    if (idleHandoffMin != null || idleFloorPct != null) hub.settings.set({ idleHandoffMin, idleFloorPct });
    if (project && permissionMode) hub.setPermissionMode(hub.project(project), permissionMode);
    if (project && typeof connectors === 'boolean') hub.setConnectors(hub.project(project), connectors);   // Matt's claude.ai connectors
    const p = project ? hub.project(project) : null;
    return { settings: typeof routePermissions === 'boolean' ? hub.setRouting(routePermissions) : hub.settings.all(), permissionMode: p ? hub.permissionMode(p) : undefined, connectors: p ? hub.connectorsOn(p) : undefined };
  },

  // One image from the composer, as a data URL. Stored by content hash; returns { id, type, size } (decision 23).
  'POST /api/attach': ({ project, data, name }) => {
    const { buf } = decodeDataUrl(data);
    return hub.project(project).attachments.save(buf, name ? `"${String(name).slice(0, 80)}"` : undefined);
  },

  'POST /api/send': ({ project, thread, text, attachments }) => {
    const p = hub.project(project);
    text = String(text || '').trim();
    const ids = Array.isArray(attachments) ? attachments.map(String) : [];
    if (ids.length) { hub.fromYou(p, thread, text, ids); return { ok: true }; }   // images never count as decision picks
    if (!text) throw new Error('Empty message');
    if (/^\/(login|logout)\b/i.test(text)) {
      p.log.append('message', { thread, from: 'you', text });
      hub.notice(p, thread, 'Agents run headless, so signing in happens in a terminal, not here. Stop the hub, run "npm run login" in the hub folder, type /login there, then start the hub again.');
      return { ok: true };
    }
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
  'POST /api/approval': ({ id, allow, note, always }) => { hub.answerApproval(id, !!allow, note, !!always); return { ok: true }; },
  'POST /api/retire-finished': ({ project, agent }) => ({ result: hub.retireFinished(hub.project(project), agent) }),
  'POST /api/retire': ({ project, agent }) => { const p = hub.project(project); hub.retire(p, agent || p.orchestrator()); return { ok: true }; },
  'POST /api/dismiss': ({ project, question, index }) => hub.dismissQuestion(hub.project(project), String(question || ''), 'you', index ?? null),
  // Answers typed in Needs you: { question: summary event id, answers: [{ index, text }] }.
  'POST /api/answer': ({ project, question, answers }) => hub.answerQuestions(hub.project(project), String(question || ''), answers),
  'POST /api/lessons': ({ project, ids, accept }) => ({ answered: hub.answerLessons(hub.project(project), ids || [], !!accept) }),
  'POST /api/worker': ({ project, name, task, type, model, effort }) => ({ name: hub.startWorker(hub.project(project), name, task, 'you', '', { type: type || undefined, model: model || undefined, effort: effort || undefined }).name }),
  // Change an agent's model, effort or type. Only the keys sent change; an empty value means the default.
  'POST /api/agent-settings': ({ project, agent, ...changes }) => {
    const pick = Object.fromEntries(['type', 'model', 'effort'].filter(k => k in changes).map(k => [k, changes[k] || null]));
    return hub.setAgentSettings(hub.project(project), agent, pick);
  },
  // Phone notifications
  'GET /api/push/key': async () => ({ publicKey: (await push.keys()).publicKey }),
  'POST /api/push/status': ({ endpoint }) => ({ subscribed: push.has(endpoint), devices: push.subs.length }),
  'POST /api/push/subscribe': ({ subscription, label }) => ({ devices: push.subscribe(subscription, label) }),
  'POST /api/push/unsubscribe': ({ endpoint }) => ({ removed: push.unsubscribe(endpoint) }),
  'POST /api/push/test': async () => ({ sent: await push.send({ kind: 'test', title: 'Crux Hub', body: 'Notifications reach this device.', card: '', url: '/' }) }),
  // Where an open hub page is and whether you are using it, so cards you are looking at do not buzz your phone.
  'POST /api/presence': ({ client, ...info }) => { push.presence(String(client || ''), info); return { ok: true }; },
  'POST /api/entry': ({ project, ...entry }) => ({ entryId: hub.project(project).board.addEntry({ ...entry, from: 'you' }).entryId })
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Only this machine and the tailnet address get in, and only the hub's own pages may change anything.
  const refused = checkRequest({ method: req.method, path: url.pathname, headers: req.headers }, { extra: hosts });
  if (refused) return send(res, 403, { error: refused });
  try {
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': hello\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return send(res, 200, await route(req.method === 'POST' ? await body(req, BODY_LIMIT[url.pathname]) : Object.fromEntries(url.searchParams)));

    // Images in threads: /att/<project>/<hash>.<ext>, for the hub's own page only (decision 23).
    const at = /^\/att\/([^/]+)\/([a-f0-9]{32}\.(?:png|jpg|gif|webp))$/.exec(url.pathname);
    if (at) {
      const no = checkAttachmentRead(req.headers, { extra: hosts });
      if (no) return send(res, 403, { error: no });
      const store = hub.project(decodeURIComponent(at[1])).attachments;
      if (!store.has(at[2])) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, {
        'content-type': TYPES['.' + (at[2].endsWith('.jpg') ? 'jpg' : at[2].split('.').pop())],
        'cache-control': 'private, max-age=31536000, immutable',   // the name is the content's hash
        'cross-origin-resource-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox"
      });
      return res.end(store.read(at[2]));
    }

    // Crux decision pages for each project: /p/<project>/<file>
    const m = /^\/p\/([^/]+)\/([\w.-]+\.html)$/.exec(url.pathname);
    if (m) return serveFile(res, hub.project(decodeURIComponent(m[1])).board.pageFile(m[2]));   // unmerged picks first (decision 35)

    // Pages ask this to know the hub is running, so they can show a link back to it (they may be opened as files).
    if (url.pathname === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ hub: true, boot: BOOT, version: VERSION, build: BUILD }));
    }

    // The all-projects page, with its links pointed at the hub instead of files.
    if (url.pathname === '/all') {
      const file = join(crux, 'index.html');
      if (!existsSync(file)) return send(res, 404, 'No all-projects page yet: it appears after your first Crux decision.', 'text/plain; charset=utf-8');
      const html = readFileSync(file, 'utf8').replace(/file:\/\/\/[^"'\\\s)<>]+/g, hubUrl);
      return send(res, 200, html, TYPES['.html']);
    }

    // Any project's Crux pages under the roll-up folders: only .html files inside a .decisions folder.
    const f = /^\/files\/(\d+)\/(.+)$/.exec(url.pathname);
    if (f) {
      const root = roots[Number(f[1])];
      const rel = decodeURIComponent(f[2]);
      const file = root && normalize(join(root, rel));
      if (!file || !file.startsWith(root + (root.endsWith('\\') ? '' : '\\')) && !file.startsWith(root + '/')) return send(res, 403, { error: 'Forbidden' });
      if (!/[\\/]\.decisions[\\/][\w.-]+\.html$/.test(file)) return send(res, 403, { error: 'Only Crux pages are served here' });
      return serveFile(res, file);
    }

    // Visuals agents posted: /media/<project>/<file>. Pages run sandboxed, away from the hub's own origin.
    const v = /^\/media\/([^/]+)\/([\w.-]+)$/.exec(url.pathname);
    if (v) {
      const file = hub.memory.mediaPath(decodeURIComponent(v[1]), v[2]);
      if (!existsSync(file)) return send(res, 404, { error: 'Not found' });
      const headers = { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' };
      if (extname(file).toLowerCase() === '.html') headers['content-security-policy'] = 'sandbox allow-scripts';
      res.writeHead(200, headers);
      return res.end(readFileSync(file));
    }

    const pub = join(here, 'public');
    const file = normalize(join(pub, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(pub)) return send(res, 403, { error: 'Forbidden' });
    serveFile(res, file);
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

// A hub started by a restart may find the old one still letting go of the port: it waits up to 20 seconds.
// Any other start fails at once, so two hubs never end up on one port.
const waitForPort = process.env.CRUX_HUB_RESTARTED === '1';
const firstTry = Date.now();
server.on('error', e => {
  if (server.listening) return console.warn(`Server: ${e.message}`);
  if (e.code === 'EADDRINUSE' && waitForPort && Date.now() - firstTry < 20000) return void setTimeout(() => server.listen(port, '127.0.0.1'), 300);
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use: is the hub running already?` : `Could not start: ${e.message}`);
  process.exit(1);
});
server.on('listening', () => {
  console.log(`Crux hub: http://localhost:${port}  (phone: tailscale serve --bg ${port}, see README)`);
  console.log(`Projects: ${[...hub.projects.values()].map(p => p.name).join(', ')}`);
  console.log(`Orchestrator hands off at ${retireAt}% context.`);
  saveLaunch(launchSpec({ port }));   // so the restart script can start it the same way
});
server.listen(port, '127.0.0.1');

// The hub is going down: agents' turns are cut, not finished, so they stay marked busy and resume at the next
// start (M014).
function stopAgents() { hub.stopping = true; for (const p of hub.projects.values()) for (const a of p.agents.values()) a.close(); }

// Stop taking requests, close the pages' live streams (they reconnect to the new hub) and the agents (they resume
// on their own when the new hub starts, M014), start the new hub detached with no window, then leave.
let restarting = false;
function restart() {
  if (restarting) return;
  restarting = true;
  console.log('Restarting...');
  server.close();
  for (const res of clients) { try { res.end(); } catch { } }
  clients.clear();
  stopAgents();
  try { startDetached(launchSpec({ port })); }
  catch (e) { console.error(`Could not start the new hub: ${e.message}`); restarting = false; hub.stopping = false; server.listen(port, '127.0.0.1'); return; }
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', () => { stopAgents(); process.exit(0); });
