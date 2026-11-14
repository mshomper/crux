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
import { decodeDataUrl, servedHeaders, MAX_UPLOAD } from './lib/attachments.mjs';
import { Push } from './lib/push.mjs';
import { MODELS, EFFORTS } from './lib/agent-types.mjs';
import { HubSettings, projectKey } from './lib/settings.mjs';
import { launchSpec, saveLaunch, startDetached, logFile, testHubWithoutAgents, testHubFolderError, testPairError, pageBuild, inTemp, dataDir } from './lib/relaunch.mjs';
import { isBundled, Secrets, KEY_SHAPE, keyEnd, checkKey, checkFolders, saveProjects, readHubConfig, pickFolder } from './lib/setup.mjs';
import { expected as claudeExpected, resolveClaude, claudeReady, ClaudeDownload } from './lib/claude-code.mjs';
import { CONDUCTOR } from './lib/conductor.mjs';
import { Guard, GuardError, OPEN_POSTS, NOT_PAIRED, stepUpNeed, scopeHas, projectScope, guardOff, fromThisPC, addressOf, cleanLabel, makeAlert, pairAlert, dropUnbackedTrusted, makeRestartHub, pcRedirect } from './lib/guard.mjs';
import { randomUUID } from 'node:crypto';
import { refreshPages } from '../crux/scripts/build.mjs';

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
// The phone's port (Matt, 2026-11-12): tailscale serve points here (`tailscale serve --bg 4748`), and nothing that
// arrives on it is ever taken as this PC. 4748 for the live hub; test hubs only when given --remote-port.
const remotePortArg = flag('--remote-port', process.env.CRUX_HUB_REMOTE_PORT || (port === 4747 ? '4748' : ''));
const remotePort = remotePortArg && Number(remotePortArg) !== port ? Number(remotePortArg) : null;
// Test hubs (--no-agents, or hub data in a temp folder) log messages but start no real agents.
const noAgents = testHubWithoutAgents({ args, env: process.env });
if (args.includes('--no-agents')) args.splice(args.indexOf('--no-agents'), 1);
// Decision 47: --test-pair starts a test hub with one fake paired device. The live hub never starts with it.
const testPair = args.includes('--test-pair');
if (testPair) args.splice(args.indexOf('--test-pair'), 1);
const pairError = testPairError({ wanted: testPair, noAgents, port, env: process.env });
if (pairError) { console.error(pairError); process.exit(1); }

// Decisions 52 and 54: a hub that came with the desktop app (its build step leaves bundled.json here) has a first-run
// screen for the API key, the project folders and Claude Code, and never takes its own folder as a project.
// CRUX_HUB_BUNDLED=1 plays the part on a test hub only (tests and screenshots).
const BUNDLED = isBundled(here) || (noAgents && process.env.CRUX_HUB_BUNDLED === '1');
const cfg = join(process.env.CRUX_HOME || join(homedir(), 'crux'), 'hub.json');
// A test hub never falls back to ~/crux/hub.json or the current folder: that loads real projects. A throwaway
// hub.json in the temp folder is fine (the desktop app's first-run rehearsal).
const tempHome = inTemp(process.env.CRUX_HOME) && existsSync(cfg);
const folderError = testHubFolderError({ noAgents, folders: args, tempHome });
if (folderError) { console.error(folderError); process.exit(1); }
let projects = args.map(a => resolve(a));
// hub.json may also hold { "defaults": { "worker": { "model": "sonnet", "effort": "medium" }, "orchestrator": {...} } }.
let hubCfg = {};
if (existsSync(cfg)) {
  try { hubCfg = JSON.parse(readFileSync(cfg, 'utf8').replace(/^﻿/, '')); } catch (e) { console.warn(`Could not read ${cfg}: ${e.message}`); }
}
if (!projects.length && (!noAgents || tempHome)) projects = (hubCfg.projects || []).map(p => resolve(p)).filter(p => existsSync(p) || !BUNDLED);
if (!projects.length && !BUNDLED) projects = [process.cwd()];
// The saved API key (setup screen) becomes the agents' key, unless one is already set in the environment. Only on
// the desktop app's own hub: a hub run from a clone never switches from its login to a key someone saved.
const secrets = new Secrets();
let keySource = BUNDLED ? secrets.apply() : null;

// Hub settings (decision 21: routePermissions, permissionTimeoutSec; decision 44 B: the handoff defaults) start from
// hub.json and the --retire-at flag, and are saved in ~/.crux-hub; a change made in the page wins from then on.
const settings = new HubSettings({ initial: { ...hubCfg, retireAt } });
// Decision 55: the Conductor keeps its log and handoffs in the hub's own state folder, next to settings.json.
const hub = new Hub({ projects, defaults: hubCfg.defaults, settings, noAgents, conductorDir: join(dataDir(), 'conductor') });
if (noAgents) console.log('Test hub: agents do not start here (set CRUX_HUB_AGENTS=1 to let them).');
// Decision 54 B: the Claude Code the agents run. A clone's SDK finds its own; the desktop app's hub uses the copy the
// setup screen downloaded, or one installed on the PC when that is missing.
const claudeExp = claudeExpected();
const claudeDownload = new ClaudeDownload({ exp: claudeExp });
hub.claudeCode = () => resolveClaude({ exp: claudeExp }).path;
// What the setup screen shows. The key itself never leaves this process; only whether one is saved and, to this PC,
// its last four characters.
function setupState(local) {
  const cc = resolveClaude({ exp: claudeExp });
  const download = claudeDownload.state();
  const ccReady = claudeReady(cc, download);
  const hasKey = !!(process.env.ANTHROPIC_API_KEY && process.env.CRUX_HUB_USE_API_KEY === '1');
  const folders = [...hub.projects.values()].map(p => p.dir);
  return {
    bundled: BUNDLED, local, testHub: hub.noAgents, needed: BUNDLED && (!hasKey || !folders.length || !ccReady),
    key: { saved: hasKey, from: hasKey ? (keySource === 'environment' ? 'environment' : 'saved') : null, end: local && hasKey ? keyEnd(process.env.ANTHROPIC_API_KEY) : '' },
    folders, configFolders: (readHubConfig(cfg).projects || []),
    claude: { source: cc.source, ready: ccReady, fallback: cc.source === 'previous' || cc.source === 'installed', version: claudeExp?.version || null, path: local ? cc.path : null, sizeMB: claudeExp ? Math.round(claudeExp.size / 1048576) : null, download }
  };
}
let picking = false;   // one Windows folder picker at a time
const pcOnly = ctx => {
  if (!BUNDLED) throw new GuardError('Setup belongs to the desktop app\'s own hub.', 404);
  if (!ctx.local) throw new GuardError('Setup is done on the PC the hub runs on.', 403);
};
hub.usage.start();   // decision 36: the plan meters, asked of any live agent every few minutes

// Phone notifications (decision 19): a card that needs you becomes a push to every subscribed phone.
const push = new Push();
const decisionStatus = (project, id) => { try { return hub.project(project).board.decision(id)?.status; } catch { return undefined; } };
const decisionOpen = (project, id) => ['open', 'found'].includes(decisionStatus(project, id));
// The Conductor's own thread (decision 55) sends no phone notifications in this build; projects' cards still do.
hub.on(ev => { if (ev.logged && ev.project !== CONDUCTOR) push.handle(ev, { approvals: hub.approvals, decisionOpen, decisionStatus, events: name => hub.project(name).log.events }); });
const hosts = extraHosts();

// The write guard (decision 47 B): paired devices, their passkeys, and alerts on any change to those or to the push
// devices. A pairing code is shown only when this process runs in a window (stdout is a TTY), never in a log file.
// This PC itself needs no pairing and no step-up (Matt, 2026-11-12); remote devices (the phone) do. A file named
// guard-off in this folder, or CRUX_HUB_GUARD=off, switches the whole guard off (read at start).
const guard = new Guard({ port, interactive: !!process.stdout.isTTY, off: guardOff({ env: process.env, hubDir: here }) });
const alert = makeAlert({ hub, push });
push.onDropped = subs => { for (const s of subs) alert({ title: `Notifications stopped: ${s.label || 'a device'}`, note: `${s.label || 'A device'} stopped getting the hub's notifications: its browser dropped the subscription.` }); };
if (testPair) guard.testPair();
// Anything an agent wrote (decision pages and their pictures, the roll-up, posted visuals) runs, if at all, in a
// sandbox with no origin of its own, so its scripts can never call the hub as you (decision 47 review). Links that
// open a new tab still work; that tab stays sandboxed too. Thread attachments keep their stricter rule (no scripts).
const AGENT_CONTENT = { 'content-security-policy': 'sandbox allow-scripts allow-popups', 'x-content-type-options': 'nosniff' };
// A project left at Trusted with no raise on record (from this PC or a paired device) drops to Auto now, with a note
// and a push. Not with the guard off.
if (!guard.off) dropUnbackedTrusted({ hub, guard, push });
// restart_hub, the orchestrator's own way to restart (no HTTP; its curl to /api/restart is a hard stop).
hub.restartHub = makeRestartHub({ hub, push, restart: () => restart(), bootAt: hub.bootAt });
// After a settings change: a raise to Trusted keeps its signed step-up, or a plain record when it came from this PC;
// a lower level lets it go.
const AFTER = {
  'POST /api/settings': ({ project, permissionMode }, { stepUp, device }) => {
    if (!project) return;
    const p = hub.project(project), key = projectKey(p.dir);
    if (hub.permissionMode(p) !== 'trusted') guard.clearRaise(key);
    else if (stepUp?.ok && stepUp.proof && scopeHas(stepUp.proof.scope, 'trusted')) guard.recordRaise(key, stepUp.proof);
    else if (device?.local && permissionMode === 'trusted') guard.recordRaise(key, { local: true, at: new Date().toISOString(), purpose: 'project', scope: `${projectScope(p.dir)};trusted` });
  }
};

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
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json', '.md': 'text/plain; charset=utf-8' };
const clients = new Set();
hub.on(ev => { const line = `data: ${JSON.stringify(ev)}\n\n`; for (const res of clients) res.write(line); });

function send(res, code, body, type = 'application/json', extra = {}) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
function serveFile(res, file, extra = {}) {
  if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'Not found' });
  send(res, 200, readFileSync(file), TYPES[extname(file)] || 'application/octet-stream', extra);
}
// Uploads carry a file as base64 text (about 4/3 of its size); everything else stays small.
const BODY_LIMIT = { '/api/attach': Math.ceil(MAX_UPLOAD * 4 / 3) + 64 * 1024 };
async function body(req, limit = 1e6) {
  const parts = []; let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error(limit > 1e6 ? `Attachments must be ${MAX_UPLOAD / 1024 / 1024} MB or less (images 10 MB).` : 'Too large');
    parts.push(c);
  }
  const s = Buffer.concat(parts).toString('utf8');
  return s ? JSON.parse(s) : {};
}

const routes = {
  // conductor (decision 55): the hub-wide agent's state and its thread's events (lib/conductor.mjs view()), or null.
  'GET /api/state': () => ({ projects: hub.state(), conductor: hub.conductor?.view() || null, retireAt: hub.retireAt, models: MODELS, efforts: EFFORTS, settings: hub.settings.all(), boot: BOOT, testHub: hub.noAgents, version: VERSION, build: BUILD, resumed: hub.resumed, usage: hub.usage.view(), bootAt: hub.bootAt, setup: { needed: setupState(false).needed } }),
  // Decision 50: one decision's brief, for the card's pop-up (read only, like the state).
  'GET /api/brief': ({ project, id }) => {
    const b = hub.project(String(project || '')).board.brief(id);
    if (!b) throw new Error(`No decision ${id}`);
    return b;
  },
  // ---------- decisions 52 and 54: the desktop app's first run (PC only, desktop app's hub only) ----------
  'GET /api/setup': (_, { local }) => setupState(local),
  // The API key: shape-checked, then asked of Anthropic (a free list of models; a test hub never calls out), then kept
  // in ~/.crux-hub/secrets.json. Never logged and never sent back.
  'POST /api/setup/key': async ({ apiKey }, ctx) => {
    pcOnly(ctx);
    const k = String(apiKey || '').trim();
    if (!KEY_SHAPE.test(k)) throw new Error('That does not look like an Anthropic API key. It starts with sk-ant- (copy it from console.anthropic.com, API keys).');
    const check = hub.noAgents ? 'unchecked' : await checkKey(k);
    if (check === 'refused') throw new Error('Anthropic did not accept this key. Check that it was copied whole and is still active in console.anthropic.com.');
    secrets.save(k);
    process.env.ANTHROPIC_API_KEY = k;
    process.env.CRUX_HUB_USE_API_KEY = '1';
    keySource = 'saved';
    return { check, setup: setupState(true) };
  },
  // Download the exact Claude Code this hub's SDK expects; the page follows its progress through GET /api/setup.
  'POST /api/setup/claude': async (_, ctx) => { pcOnly(ctx); await claudeDownload.start(); return setupState(true); },
  // The Windows folder picker, on this PC's screen.
  'POST /api/setup/browse': async (_, ctx) => {
    pcOnly(ctx);
    if (picking) throw new Error('The folder picker is already open: look for it in front of the app window.');
    picking = true;
    try { return { path: await pickFolder() }; } finally { picking = false; }
  },
  // The project folders: saved into hub.json, then the hub restarts to load them (the page reconnects by itself).
  'POST /api/setup/folders': ({ folders }, ctx) => {
    pcOnly(ctx);
    const { folders: ok, problems } = checkFolders(folders);
    if (problems.length) throw new Error(problems.join('\n'));
    if (!ok.length) throw new Error('Add at least one project folder.');
    saveProjects(ok, cfg);
    setTimeout(restart, 300);
    return { saved: ok, restarting: true };
  },
  // Restart from the hub's own menu: answer first, then hand over to a fresh hub started the same way (M010).
  'POST /api/restart': () => { setTimeout(restart, 200); return { ok: true, boot: BOOT, log: logFile(port) }; },
  // The off switch for decision 21: false sends every permission request to you.
  // Whole hub (decision 44 B): { permissionTimeoutSec, idleHandoffMin, idleFloorPct, retireAt } (the hub defaults).
  // Per project, with { project }: { permissionMode: 'standard' | 'auto' | 'trusted', connectors, handoff:
  // { idleHandoffMin, idleFloorPct, retireAt } } where null means "use the hub default" (decisions 34, 44, 45).
  // Trusted is set only here, from the hub page (same-origin JSON, C001), never from a repo's .crux-hub.json.
  // workerHandoffFloorPct (decision 46 A) is hub-wide only.
  'POST /api/settings': ({ routePermissions, project, permissionMode, connectors, handoff, permissionTimeoutSec, idleHandoffMin, idleFloorPct, retireAt: ra, workerHandoffFloorPct }) => {
    const p = project ? hub.project(project) : null;
    if (!p) {
      const hubWide = Object.fromEntries(Object.entries({ permissionTimeoutSec, idleHandoffMin, idleFloorPct, retireAt: ra, workerHandoffFloorPct }).filter(([, v]) => v != null));
      if (Object.keys(hubWide).length) hub.settings.set(hubWide);
    }
    if (p && permissionMode) hub.setPermissionMode(p, permissionMode);
    if (p && typeof connectors === 'boolean') hub.setConnectors(p, connectors);   // Matt's claude.ai connectors
    if (p && handoff && typeof handoff === 'object') hub.setHandoffNumbers(p, handoff);
    return {
      settings: typeof routePermissions === 'boolean' ? hub.setRouting(routePermissions) : hub.settings.all(),
      permissionMode: p ? hub.permissionMode(p) : undefined, connectors: p ? hub.connectorsOn(p) : undefined,
      handoff: p ? hub.handoffNumbers(p) : undefined, ownHandoff: p ? hub.ownHandoffNumbers(p) : undefined
    };
  },

  // One file from the composer (an image, a PDF or a text file), as a data URL. Stored by content hash; returns
  // { id, type, size, name? } (decision 23). The name is display text only, never part of the stored path.
  'POST /api/attach': ({ project, data, name }) => {
    const { buf } = decodeDataUrl(data);
    return hub.place(project).attachments.save(buf, name == null ? undefined : String(name).slice(0, 1000));
  },

  // project "~conductor" writes to the Conductor (decision 55): text and attachments only, no picks or sign-in notes.
  'POST /api/send': ({ project, thread, text, attachments }) => {
    const p = hub.place(project);
    text = String(text || '').trim();
    // Each attachment as an id, or { id, name } with the original file name for display.
    const ids = Array.isArray(attachments) ? attachments.map(a => a && typeof a === 'object' ? { id: String(a.id || ''), name: a.name == null ? undefined : String(a.name).slice(0, 1000) } : String(a)) : [];
    if (ids.length) { hub.fromYou(p, thread, text, ids); return { ok: true }; }   // attachments never count as decision picks
    if (!text) throw new Error('Empty message');
    if (p.hubWide) { hub.fromYou(p, 'conductor', text); return { ok: true }; }
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
  // The orchestrator's handoff, a worker's, or (project "~conductor") the Conductor's.
  'POST /api/retire': ({ project, agent }) => { const p = hub.place(project); hub.retire(p, p.hubWide ? p.orchestrator() : agent || p.orchestrator()); return { ok: true }; },
  'POST /api/dismiss': ({ project, question, index }) => hub.dismissQuestion(hub.place(project), String(question || ''), 'you', index ?? null),
  // Answers typed in Needs you: { question: summary event id, answers: [{ index, text }] }.
  'POST /api/answer': ({ project, question, answers }) => hub.answerQuestions(hub.place(project), String(question || ''), answers),
  'POST /api/lessons': ({ project, ids, accept }) => ({ answered: hub.answerLessons(hub.place(project), ids || [], !!accept) }),
  'POST /api/worker': ({ project, name, task, type, model, effort }) => ({ name: hub.startWorker(hub.project(project), name, task, 'you', '', { type: type || undefined, model: model || undefined, effort: effort || undefined }).name }),
  // Change an agent's model, effort or type. Only the keys sent change; an empty value means the default.
  'POST /api/agent-settings': ({ project, agent, ...changes }) => {
    const pick = Object.fromEntries(['type', 'model', 'effort'].filter(k => k in changes).map(k => [k, changes[k] || null]));
    return hub.setAgentSettings(hub.project(project), agent, pick);
  },
  // Phone notifications
  'GET /api/push/key': async () => ({ publicKey: (await push.keys()).publicKey }),
  'POST /api/push/status': ({ endpoint }) => ({ subscribed: push.has(endpoint), devices: push.subs.length }),
  // Adding a push device needs Windows Hello or Face ID (decision 47); any change to the list is told everywhere,
  // before a removal so the device leaving hears it too.
  'POST /api/push/subscribe': async ({ subscription, label }, { device }) => {
    const fresh = !push.has(subscription?.endpoint);
    const devices = push.subscribe(subscription, label);
    if (fresh) await alert({ title: `Notifications on: ${cleanLabel(label)}`, note: `${cleanLabel(label)} now gets the hub's notifications (added from ${device.label}, confirmed with its passkey).` });
    return { devices };
  },
  'POST /api/push/unsubscribe': async ({ endpoint }, { device }) => {
    const s = push.subs.find(x => x.endpoint === endpoint);
    if (s) await alert({ title: `Notifications off: ${s.label || 'a device'}`, note: `${s.label || 'A device'} no longer gets the hub's notifications (turned off from ${device.label}).` });
    return { removed: push.unsubscribe(endpoint) };
  },
  'POST /api/push/remove': async ({ id }, { device }) => {
    const s = push.byId(id);
    if (!s) throw new GuardError('That device does not get notifications.', 404);
    await alert({ title: `Notifications off: ${s.label || 'a device'}`, note: `${s.label || 'A device'} no longer gets the hub's notifications (removed from ${device.label}).` });
    return { removed: push.unsubscribe(s.endpoint) };
  },
  'POST /api/push/test': async () => ({ sent: await push.send({ kind: 'test', title: 'Crux Hub', body: 'Notifications reach this device.', card: '', url: '/' }) }),
  // Where an open hub page is and whether you are using it, so cards you are looking at do not buzz your phone.
  'POST /api/presence': ({ client, ...info }) => { push.presence(String(client || ''), info); return { ok: true }; },
  // Decision 58: the desktop app's report, every 30 s: how long since the PC's last input, and whether it is locked.
  'POST /api/desktop/presence': ({ client, idleMs, locked, notices }, { local }) => {
    if (!local) throw new GuardError('Only the desktop app on this PC reports here.', 403);
    return { known: push.desktopPresence(String(client || ''), { idleMs, locked, notices }), inUse: push.pcInUse() };
  },
  'POST /api/entry': ({ project, ...entry }) => ({ entryId: hub.project(project).board.addEntry({ ...entry, from: 'you' }).entryId }),
  // Mark a memo done, or back to active, from the board panel: a new event in the log, never an edit.
  'POST /api/entry-status': ({ project, id, status }) => ({ entryId: hub.project(project).board.setEntryStatus(String(id || ''), status === 'active' ? 'active' : 'done', 'you').entryId }),

  // ---------- decision 47: pairing, step-up and the device list ----------
  // Whether this device is paired, whether the hub has a window to show a code in, and the PC's own address. Never a code.
  'GET /api/auth/status': (_, { req, local }) => guard.status(req.headers, { local }),
  'GET /api/devices': (_, { req, local }) => ({ devices: guard.list(req.headers, { local }), push: push.list() }),
  // The three steps open to a device with no cookie: a fresh code for the first device (into the hub's window only;
  // nothing once a device is paired), check a code and get the passkey options, and hand in the new passkey (which
  // sets the cookie).
  'POST /api/pair/code': () => guard.askForCode(),
  'POST /api/pair/options': ({ code, label, startOver }, { req }) => guard.pairOptions({ headers: req.headers, code, label, startOver: startOver === true }),
  'POST /api/pair/finish': async ({ credential }, ctx) => {
    const r = guard.pairFinish({ headers: ctx.req.headers, credential });
    ctx.headers['set-cookie'] = r.cookie;
    await alert(pairAlert(r));
    return { ok: true, device: { id: r.device.id, label: r.device.label } };
  },
  // A paired device, after its step-up: a one-time code to type on the new device.
  'POST /api/pair/issue': (_, { device }) => guard.issueCode(device),
  'POST /api/auth/challenge': ({ purpose, scope }, { req, device }) => guard.challenge({ headers: req.headers, device, purpose, scope }),
  // This PC's first big change: the options to set up its passkey (Windows Hello), bound to that change. PC only.
  'POST /api/pc/enroll': ({ purpose, scope }, { req, device }) => guard.pcEnrollOptions({ headers: req.headers, device, purpose, scope }),
  'POST /api/devices/remove': async ({ id }, ctx) => {
    const d = guard.remove(id);
    const you = d === ctx.device;
    if (you) ctx.headers['set-cookie'] = guard.clearCookie(addressOf(ctx.req.headers, port).secure);
    await alert({ title: `Device unpaired: ${d.label}`, note: `${d.label} (${d.rpId || 'test'}) was unpaired from the hub, with its passkey, from ${you ? 'itself' : ctx.device.label}.` });
    return { removed: d.id, you };
  }
};

// One handler for both listeners: the PC port and the phone's port (remotePort). Which port a request reached is the
// socket's own, which no client can fake.
async function handle(req, res) {
  // A full address in the request line (GET http://localhost:4791/... as a proxy is sent) is never one of the hub's
  // pages: refused, so no proxy trick can reach it (review of PR #51).
  if (!String(req.url || '').startsWith('/')) return send(res, 400, { error: 'Requests must name a path on this hub' });
  const url = new URL(req.url, 'http://localhost');
  // Only this machine (on the port it reached) and the tailnet address get in, and only the hub's own pages may change anything.
  const refused = checkRequest({ method: req.method, path: url.pathname, headers: req.headers }, { extra: hosts, port: req.socket.localPort });
  if (refused) return send(res, 403, { error: refused });
  // This PC itself (Matt, 2026-11-12): loopback, the PC port, no proxy headers, the PC's own Host and Origin.
  const local = fromThisPC(req, { pcPort: port, remotePort });
  try {
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': hello\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    // Decision 58: the desktop app's notices. This PC only; it carries the same few words as a phone push.
    if (url.pathname === '/api/desktop/stream' && req.method === 'GET') {
      if (!local) return send(res, 403, { error: 'The desktop stream is for the app on this PC.' });
      const client = String(url.searchParams.get('client') || '').slice(0, 64);
      if (!/^[\w-]{8,64}$/.test(client)) return send(res, 400, { error: 'Give a client id.' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': hello\n\n');
      push.desktopAttach(client, (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { push.desktopDetach(client); clearInterval(ping); });
      return;
    }
    const key = `${req.method} ${url.pathname}`;
    const route = routes[key];
    if (route) {
      // Decision 47: every change needs a paired device's cookie (checked before the body is read), except the three
      // steps of pairing. The few big changes also need a fresh step-up, made for exactly that change.
      const ctx = { req, local, device: null, stepUp: null, headers: {} };
      if (req.method === 'POST' && !OPEN_POSTS.has(url.pathname)) {
        ctx.device = guard.deviceFor(req.headers, { local });
        if (!ctx.device) return send(res, 401, { error: NOT_PAIRED, pair: true });
      }
      const input = req.method === 'POST' ? await body(req, BODY_LIMIT[url.pathname]) : Object.fromEntries(url.searchParams);
      // Big changes ask for Face ID or Windows Hello, from the phone and from this PC alike (Matt, 2026-11-12). Not with
      // the guard off; and showing a code to pair the phone needs none on the PC. A PC with no passkey yet sets one up
      // with that same prompt (no code); where Windows Hello is not available it goes ahead, with a push.
      let need = ctx.device && !ctx.device.off ? stepUpNeed(key, input, hub) : null;
      if (need && ctx.device.local && key === 'POST /api/pair/issue') need = null;
      if (need && ctx.device.local && !guard.pcHasPasskey()) need = { ...need, enroll: true };
      if (need) {
        ctx.stepUp = guard.verifyStepUp({ headers: req.headers, device: ctx.device, stepUp: input.stepUp, need });
        if (!ctx.stepUp.ok) return send(res, 403, { error: ctx.stepUp.error, stepUp: need });
        if (ctx.stepUp.fallback) alert({ title: 'Big change on the PC without Windows Hello', note: `${need.why} was made on this PC without Windows Hello: the browser has none to offer and this PC has no passkey yet.` });
        if (ctx.stepUp.enrolled) alert({ title: 'Windows Hello set up for big changes on the PC', note: `This PC set up its passkey (${ctx.stepUp.holder.rpId}) for big changes, with: ${need.why}.` });
      }
      const out = await route(input, ctx);
      AFTER[key]?.(input, ctx);
      return send(res, 200, out, 'application/json', ctx.headers);
    }

    // Attachments in threads: /att/<project>/<hash>.<ext>, for the hub's own page only (decision 23). Images show;
    // PDFs and text files always download, as PDF or plain text, never as a page in the hub's origin.
    const at = /^\/att\/([^/]+)\/([a-f0-9]{32}\.[a-z]{3,4})$/.exec(url.pathname);
    if (at) {
      const no = checkAttachmentRead(req.headers, { extra: hosts });
      if (no) return send(res, 403, { error: no });
      const store = hub.place(decodeURIComponent(at[1])).attachments;
      if (!store.has(at[2])) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, servedHeaders(at[2]));
      return res.end(store.read(at[2]));
    }

    // Crux decision pages for each project: /p/<project>/<file>
    const m = /^\/p\/([^/]+)\/([\w.-]+\.html)$/.exec(url.pathname);
    if (m) return serveFile(res, hub.project(decodeURIComponent(m[1])).board.pageFile(m[2]), AGENT_CONTENT);   // unmerged picks first (decision 35)
    // Their pictures (decision 43): /p/<project>/images/<file>, the cards' galleries and the pages' relative links.
    const im = /^\/p\/([^/]+)\/images\/([\w-][\w.-]*\.(?:png|jpg|gif|webp))$/.exec(url.pathname);
    if (im) {
      const file = hub.project(decodeURIComponent(im[1])).board.imageFile(im[2]);
      if (!file) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'content-type': TYPES[extname(file)], 'cache-control': 'no-cache', 'cross-origin-resource-policy': 'same-origin', ...AGENT_CONTENT });
      return res.end(readFileSync(file));
    }

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
      return send(res, 200, html, TYPES['.html'], AGENT_CONTENT);
    }

    // Any project's Crux pages under the roll-up folders: only .html and .md files inside a .decisions folder, and the
    // pictures in its images folder (decision 43).
    const f = /^\/files\/(\d+)\/(.+)$/.exec(url.pathname);
    if (f) {
      const root = roots[Number(f[1])];
      const rel = decodeURIComponent(f[2]);
      const file = root && normalize(join(root, rel));
      if (!file || !file.startsWith(root + (root.endsWith('\\') ? '' : '\\')) && !file.startsWith(root + '/')) return send(res, 403, { error: 'Forbidden' });
      if (!/[\\/]\.decisions[\\/]([\w.-]+\.(html|md)|images[\\/][\w-][\w.-]*\.(png|jpg|gif|webp))$/.test(file)) return send(res, 403, { error: 'Only Crux pages are served here' });
      // Decision 41: pages are built locally; rebuild a folder's stale ones first, and serve the .md if a page is missing.
      if (file.endsWith('.html')) {
        try { refreshPages(dirname(file)); } catch (e) { console.warn('Crux page refresh failed:', e.message); }
        const md = file.replace(/\.html$/, '.md');
        if (!existsSync(file) && existsSync(md)) return serveFile(res, md, AGENT_CONTENT);
      }
      return serveFile(res, file, AGENT_CONTENT);
    }

    // Visuals agents posted: /media/<project>/<file>. Pages and SVG pictures run sandboxed, away from the hub's origin.
    const v = /^\/media\/([^/]+)\/([\w.-]+)$/.exec(url.pathname);
    if (v) {
      const file = hub.memory.mediaPath(decodeURIComponent(v[1]), v[2]);
      if (!existsSync(file)) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store', ...AGENT_CONTENT });
      return res.end(readFileSync(file));
    }

    // On this PC the live hub lives at crux.localhost: a page load at plain localhost:4747 moves there, so the
    // device cookie is set, and sent, only on that name (decision 47 review).
    const moveTo = req.socket.localPort === port && pcRedirect({ method: req.method, path: url.pathname, url: req.url, host: req.headers.host, port });
    if (moveTo) { res.writeHead(302, { location: moveTo, 'cache-control': 'no-store' }); return res.end(); }

    const pub = join(here, 'public');
    const file = normalize(join(pub, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(pub)) return send(res, 403, { error: 'Forbidden' });
    // A test hub started with --test-pair hands its fake device's cookie to whoever opens the page.
    if (guard.testToken && (url.pathname === '/' || url.pathname === '/index.html') && !guard.deviceFor(req.headers, { local })) res.setHeader('set-cookie', guard.cookie(guard.testToken, addressOf(req.headers, port).secure));
    serveFile(res, file);
  } catch (e) {
    if (!res.headersSent) send(res, e instanceof GuardError ? e.status : 400, { error: e.message });
  }
}
const server = createServer(handle);
const remoteServer = remotePort ? createServer(handle) : null;

// A hub started by a restart may find the old one still letting go of the port: it waits up to 20 seconds.
// Any other start fails at once, so two hubs never end up on one port.
const waitForPort = process.env.CRUX_HUB_RESTARTED === '1';
const firstTry = Date.now();
// The phone's port: if it is taken, the hub still runs for the PC; the phone cannot reach it until it is free.
remoteServer?.on('error', e => {
  if (remoteServer.listening) return console.warn(`Phone port: ${e.message}`);
  if (e.code === 'EADDRINUSE' && Date.now() - firstTry < 20000) return void setTimeout(() => remoteServer.listen(remotePort, '127.0.0.1'), 300);
  console.warn(`The phone's port ${remotePort} is not available (${e.code || e.message}); the phone cannot reach the hub until it is.`);
});
remoteServer?.listen(remotePort, '127.0.0.1');
server.on('error', e => {
  if (server.listening) return console.warn(`Server: ${e.message}`);
  if (e.code === 'EADDRINUSE' && waitForPort && Date.now() - firstTry < 20000) return void setTimeout(() => server.listen(port, '127.0.0.1'), 300);
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use: is the hub running already?` : `Could not start: ${e.message}`);
  process.exit(1);
});
server.on('listening', () => {
  // A test hub is shown at 127.0.0.1: the live hub's device cookie belongs to localhost, and browsers send a host's
  // cookies to every port on it, so a test hub opened at 127.0.0.1 never receives it (decision 47).
  console.log(port === 4747 ? `Crux hub: ${guard.pcUrl}` : `Crux hub: http://127.0.0.1:${port}  (a test hub; this PC's page: http://localhost:${port})`);
  if (remotePort) console.log(`Phone port: ${remotePort}. Point Tailscale at it once: tailscale serve reset, then tailscale serve --bg ${remotePort} (see README). Nothing on it is taken as this PC.`);
  console.log(`Projects: ${[...hub.projects.values()].map(p => p.name).join(', ')}`);
  console.log(`Orchestrator hands off at ${hub.retireAt}% context (hub default; projects may set their own).`);
  saveLaunch(launchSpec({ port }));   // so the restart script can start it the same way
  // Decision 47 as amended (Matt, 2026-11-12): this PC needs no pairing; remote devices pair with a code from Devices.
  const paired = guard.paired();
  if (guard.off) console.log('Write guard: OFF (a guard-off file in the hub folder, or CRUX_HUB_GUARD=off). Changes are taken as before decision 47.');
  else if (guard.testToken) console.log('Test hub: one fake device is paired (--test-pair); the page gets its cookie.');
  else console.log(`This PC makes changes with no pairing. Remote devices (the phone) pair with a code from Devices in the hub menu on this PC.${paired.length ? ` Paired: ${paired.map(d => `${d.label} (${d.rpId})`).join(', ')}.` : ''}`);
});
server.listen(port, '127.0.0.1');

// The hub is going down: agents' turns are cut, not finished, so they stay marked busy and resume at the next
// start (M014).
function stopAgents() { hub.stopping = true; for (const p of [...hub.projects.values(), ...(hub.conductor ? [hub.conductor.home] : [])]) for (const a of p.agents.values()) a.close(); }

// Stop taking requests, close the pages' live streams (they reconnect to the new hub) and the agents (they resume
// on their own when the new hub starts, M014), start the new hub detached with no window, then leave.
let restarting = false;
function restart() {
  if (restarting) return;
  restarting = true;
  console.log('Restarting...');
  server.close();
  remoteServer?.close();
  for (const res of clients) { try { res.end(); } catch { } }
  clients.clear();
  stopAgents();
  try { startDetached(launchSpec({ port })); }
  catch (e) { console.error(`Could not start the new hub: ${e.message}`); restarting = false; hub.stopping = false; server.listen(port, '127.0.0.1'); remoteServer?.listen(remotePort, '127.0.0.1'); return; }
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', () => { stopAgents(); process.exit(0); });
