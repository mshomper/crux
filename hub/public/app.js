// Crux hub interface: plain ES module, no build step.
import { LiveMap } from './map.js';
import { initPhone } from './phone.js';
import { EFFORTS, hueOf, modelOf, modelLabel, pips, describe } from './models.js';
import { robot } from './robots.js';
import { hudBoot, openPanel, closePanel } from './hud.js';
import { isYesNo } from './questions.js';
import * as AP from './all-projects.js';
import * as CP from './conductor-view.js';
import { enterAction, insertLineBreak, replyHint, filterHint } from './composer-keys.js';
import { Columns } from './columns.js';
import { growBox } from './conversation.js';
import { patchKeep } from './list-patch.js';
import { IMG_TYPES, fileChip, plainName } from './files.js';
import { ViewportFit, isIOS, noFocusZoom } from './viewport.js';
import { PhoneCheck } from './debug-phone.js';
import { UsageUI } from './usage-ui.js';
import { md } from './markdown.js';
import { retiredView, RETIRED_RECENT_DAYS } from './retired-list.js';
import { SideResizer } from './side-width.js';
import { routeSwitch } from './route-switch.js';
import { picturesButton, installPictures } from './pictures.js';
import { levelChip, LEVELS as LEVEL_INFO, SettingsCards } from './project-settings.js';
import { GuardUI } from './guard.js';
import { briefButton, installBrief } from './brief.js';
import { installKeepScroll } from './keep-scroll.js';
installKeepScroll();   // a pop-up opening or closing leaves the thread where it was (the iPhone sent it to the top)
installPictures();   // decision 43: the pictures button on decision cards opens a gallery
// Decision 50: the brief button on decision cards opens the brief, loaded from the card's own project.
const briefPop = installBrief(document, (project, id) => api(`/api/brief?project=${encodeURIComponent(project)}&id=${encodeURIComponent(id)}`));

// iPhone: no automatic zoom when a box is tapped; two-finger zoom still works there (viewport.js).
{ const m = document.querySelector('meta[name="viewport"]'); m.content = noFocusZoom(m.content, isIOS(navigator.userAgent, navigator.platform, navigator.maxTouchPoints)); }
import { boardView, groupBoard, SECTIONS, canMarkDone, canUndoDone } from './board.js';
const EFFORT_SHORT = { low: 'low', medium: 'medium', high: 'high', xhigh: 'x-high', max: 'max' };
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(4, '0');
const icon = id => `<svg class="icon"><use href="#i-${id}"/></svg>`;

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('crux-hub:' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('crux-hub:' + k, JSON.stringify(v)); } catch { } }
};

const S = {
  projects: [],
  current: store.get('project', null),
  // The open threads and which one has the keyboard live in the columns (columns.js, per project); cols.kb is the
  // thread that used to be "the" current one.
  seen: store.get('seen', {}),
  open: new Set(), // expanded messages, answered approvals and task lines
  activity: {},
  pending: new Set(),
  drafts: store.get('drafts', {}),   // answers typed in Needs you, by "<summary id>:<question place>"
  boardOpen: store.get('board-open', {}),   // board sections you opened or closed, by key
  retiredOpen: store.get('retired-open', false),   // the Retired section of the thread list, folded by default
  retiredOlder: false   // "Show older" in it: for this visit only, so old ones age out again on the next load
};

const proj = () => S.projects.find(p => p.name === S.current) || S.projects[0];
// Phone width, and whether there is a mouse (no keyboard popping up when a thread opens, no focus jumps).
const phoneMq = matchMedia('(max-width: 720px)');
const fineMq = matchMedia('(pointer: fine)');
// A box that is closed or hidden (a retired agent's thread, All projects) is never focused.
const focusIfDesk = el => { if (fineMq.matches && !phoneMq.matches && el && !el.disabled && !el.closest('[hidden]')) el.focus(); };
// The seam between the list and the conversation widens the list on a desk with a mouse (side-width.js).
new SideResizer({ app: $('#app'), grip: $('#side-grip'), canResize: matchMedia('(min-width: 721px) and (pointer: fine)'), onResize: () => placeModelMenu() });
const map = new LiveMap($('#hud'), { open: t => t === 'board' ? ($('#board').hidden = false, render()) : selectThread(t) });

// Decision 36: plan meters in the strip (not on the core) and the usage panel behind them.
const usageUI = new UsageUI($('#hud'), {
  source: () => ({
    rows: [...S.projects, ...(S.cplace ? [{ name: 'Conductor', events: S.cplace.events }] : [])].flatMap(p => p.events.filter(e => e.type === 'usage').map(ev => ({ project: p.name, ev }))),
    bootAt: S.bootAt, multi: S.projects.length > 1
  })
});

// ---------- data ----------
// Decision 47: every change goes through the guard (guard.js): an unpaired device gets "Pair this device", and a big
// change asks "Confirm it's you" before it is sent again. Reads stay plain.
const guardUI = new GuardUI({
  toast: (m, tone) => toast(m, tone), reload: () => load().catch(() => { }),
  changed: paired => { $('#pair-btn').hidden = paired !== false; }
});
async function api(path, body) {
  if (body) return guardUI.post(path, body);
  const res = await fetch(path);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}
$('#pair-btn').addEventListener('click', () => guardUI.openPair());

async function load() {
  const { projects, conductor, retireAt, models, settings, boot, version, build, usage, bootAt, setup } = await api('/api/state');
  // Decisions 52 and 54: the desktop app's first run (no key, no folders or no Claude Code yet) opens the setup
  // screen. Closing it there comes back here for this visit; with no project folder at all there is nothing to show.
  let skipped = false; try { skipped = sessionStorage.getItem('crux-hub:setup-closed') === '1'; } catch { }
  if (setup?.needed && (!projects.length || !skipped)) { location.replace('/setup.html'); return new Promise(() => { }); }
  // The hub now serves different page files (a restart onto new code): reload, so the new page runs (M014+).
  if (S.build && build && build !== S.build) return reloadForUpdate(version);
  S.build ||= build;
  S.version ||= version;
  S.boot = boot;
  S.bootAt = bootAt;
  usageUI.setPlan(usage);
  map.retireAt = retireAt;
  S.retireAt = retireAt;
  S.settings = settings || {};
  S.models = models || [];
  S.projects = projects;
  setConductor(conductor);
  // An open brief whose decision was picked elsewhere loses its pick buttons (decision 50).
  briefPop.sync((pj, id) => projects.find(p => p.name === pj)?.board?.decisions?.find(d => String(d.id) === String(id))?.status);
  S.pending = new Set(projects.flatMap(p => p.pendingApprovals));
  S.hub = null;
  // Drafts for questions that are no longer waiting are let go.
  const live = new Set(projects.flatMap(p => openQuestions(p).flatMap(q => q.open.map(x => draftKey(q.id, x.i)))));
  for (const k of Object.keys(S.drafts)) if (!live.has(k)) delete S.drafts[k];
  store.set('drafts', S.drafts);
  if (!proj()) return render();
  S.current = proj().name;
  render();
  phone.clearSettled(cardWaiting);   // fresh state: notifications for cards settled meanwhile leave the lock screen
}

let refreshTimer;
function refreshSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(load, 250); }

let es = null;
function connect() {
  es?.close();
  es = new EventSource('/api/stream');
  es.onmessage = e => {
    const ev = JSON.parse(e.data);
    // Plan numbers belong to the hub, not a project: the live copy (no project) and the logged one both land here.
    if (ev.type === 'plan_usage') { if (!ev.logged) usageUI.setPlan(ev); return; }
    // The Conductor (decision 55): its state as one event, and its own thread's events under its place name.
    if (ev.type === 'conductor_state') { if (S.conductor) { Object.assign(S.conductor, ev.conductor); S.hub = null; render(); } return; }
    if (ev.project === CP.CONDUCTOR) { if (CP.applyEvent(S.conductor, ev)) { S.hub = null; if (ev.logged && ['agent_created', 'agent_retired', 'agent_session', 'agent_settings'].includes(ev.type)) refreshSoon(); render(); } return; }
    const p = S.projects.find(x => x.name === ev.project);
    if (!p) return;
    S.hub = null;
    if (ev.logged) {
      p.events.push(ev);
      if (ev.type === 'approval') S.pending.add(ev.approval);
      if (ev.type === 'approval_result') S.pending.delete(ev.approval);
      // Agents write decision records straight to .decisions/; a summary is the signal to re-read the board.
      if (['agent_created', 'agent_session', 'agent_settings', 'agent_retired', 'pick', 'entry', 'entry_status', 'summary', 'project_settings'].includes(ev.type)) refreshSoon();
      if (ev.type === 'message' && ev.from !== 'you') delete S.activity[key(p.name, ev.thread)];
      if (['approval_result', 'pick', 'question_dismissed', 'message'].includes(ev.type)) queueMicrotask(() => phone.clearSettled(cardWaiting));
    } else if (ev.type === 'agent_state') {
      const a = p.agents.find(a => a.name === ev.agent);
      if (a) { a.state = ev.state; a.contextPct = ev.contextPct; }
      if (!['working', 'starting'].includes(ev.state)) delete S.activity[key(p.name, ev.thread)];
    } else if (ev.type === 'activity') {
      S.activity[key(p.name, ev.thread)] = `${ev.agent}: ${ev.text}`;
    }
    map.event(p, ev);
    render();
  };
  // Lost the hub: try again every two seconds. During a restart the restart view does the reconnecting.
  es.onopen = () => setLink(true);
  es.onerror = () => { es.close(); setLink(false); if (!S.restarting) setTimeout(() => { if (!S.restarting) { connect(); load().catch(() => { }); } }, 2000); };
}

// M008 3: when the live link drops, an amber light says so and the cards dim, since they may be out of date.
// Shown after a moment, so a quick reconnect does not flicker.
let linkTimer;
function setLink(up) {
  clearTimeout(linkTimer);
  if (up) { $('#link').hidden = true; $('#app').classList.remove('link-lost'); return; }
  linkTimer = setTimeout(() => { if (S.restarting) return; $('#link').hidden = false; $('#app').classList.add('link-lost'); }, 1500);
}

// ---------- restart (M010): the hub menu's Restart, then wait for the new hub and reconnect ----------
function working() { return S.projects.flatMap(p => p.agents.filter(a => ['working', 'starting'].includes(a.state)).map(a => ({ ...a, project: p.name }))); }

// A hub with new page files: keep what you were doing (view, board, the half-typed message), reload, then say so.
function reloadForUpdate(version) {
  try {
    sessionStorage.setItem('crux-hub:updated', version || 'a new version');
    // Every column's half-typed message, by thread (the open columns themselves are kept in local storage).
    const compose = Object.fromEntries(cols.all().filter(c => c.input.value).map(c => [c.thread, c.input.value]));
    sessionStorage.setItem('crux-hub:resume-view', JSON.stringify({ board: !$('#board').hidden, compose, filter: $('#board-filter').value }));
  } catch { }
  location.reload();
  return new Promise(() => { });   // nothing more happens on this page
}
function afterUpdate() {
  let updated = null, view = null;
  try {
    updated = sessionStorage.getItem('crux-hub:updated');
    view = JSON.parse(sessionStorage.getItem('crux-hub:resume-view') || 'null');
    sessionStorage.removeItem('crux-hub:updated'); sessionStorage.removeItem('crux-hub:resume-view');
  } catch { }
  if (view) {
    // A message typed before the update (one box before 0.12, one per column since).
    const typed = typeof view.compose === 'string' ? { [cols.kb]: view.compose } : view.compose || {};
    for (const c of cols.all()) if (typed[c.thread]) { c.input.value = c.compose.text = typed[c.thread]; c.autosize(); }
    if (view.filter) $('#board-filter').value = view.filter;
    if (view.board) { $('#board').hidden = false; render(); }
  }
  if (updated) toast(`Updated to ${updated}`, 'info');
}
function renderHubMenu() {
  const el = $('#hub-menu');
  $('#hub-menu-btn').setAttribute('aria-expanded', String(!!S.hubMenu));
  if (!S.hubMenu) { el.hidden = true; return; }
  // M014: who will be resumed, by name (with the project when there are several).
  const busy = working();
  const multi = S.projects.length > 1;
  const names = busy.map(a => `<b>${esc(a.name)}</b>${multi ? ` <span class="faint">(${esc(a.project)})</span>` : ''}`);
  const list = names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  el.innerHTML = S.hubMenu === 'confirm'
    ? `<div class="hm-confirm"><b>Restart the hub now?</b>
        <p class="faint">${busy.length ? `${list} ${busy.length === 1 ? 'is' : 'are'} working; ${busy.length === 1 ? 'it resumes' : 'they resume'} on ${busy.length === 1 ? 'its' : 'their'} own after the restart${busy.length > 1 ? ', a few seconds apart' : ''}.` : 'No agent is working, so none needs resuming; resting agents wake on their next message.'} The page reconnects by itself.</p>
        <div class="row"><button class="btn primary" data-restart-go>${icon('restart')}Restart</button><button class="btn ghost" data-hub-menu-close>Cancel</button></div></div>`
    : `<button class="hm-item" role="menuitem" data-hub-settings>${icon('hub')}<span><b>Whole hub</b><span class="faint">Who answers requests, the wait, handoff defaults</span></span></button>
       <button class="hm-item" role="menuitem" data-devices>${icon('key')}<span><b>Devices</b><span class="faint">${guardUI.paired ? 'Paired devices, passkeys and notifications' : 'This device is not paired: pair it'}</span></span></button>
       <button class="hm-item" role="menuitem" data-restart>${icon('restart')}<span><b>Restart hub</b><span class="faint">Stops and starts the server; agents resume</span></span></button>
       <button class="hm-item" role="menuitem" data-phone-check>${icon('pulse')}<span><b>${phoneCheck.on ? 'Hide phone check' : 'Phone check'}</b><span class="faint">${phoneCheck.on ? 'Turns the screen numbers off' : 'Live screen numbers, for a screenshot'}</span></span></button>`;
  el.hidden = false;
}
// Phone check (debug-phone.js): off unless ?debug=phone or the menu turns it on; remembered on this device.
const phoneCheck = new PhoneCheck({ version: () => S.version || '' });
if (PhoneCheck.wanted()) phoneCheck.start();
function closeHubMenu() { if (!S.hubMenu) return; S.hubMenu = null; renderHubMenu(); }

async function restartHub() {
  closeHubMenu();
  const old = S.boot;
  const r = await api('/api/restart', {});
  S.restarting = true;
  es?.close();
  showRestarting('Restarting the hub…', 'This page reconnects by itself.');
  const started = Date.now();
  let warned = false;
  while (S.restarting) {
    await new Promise(ok => setTimeout(ok, 700));
    const boot = await fetch('/api/ping', { cache: 'no-store' }).then(x => x.ok ? x.json() : null).then(j => j?.boot).catch(() => null);
    if (boot && boot !== (old || r.boot)) break;
    if (!warned && Date.now() - started > 45000) {
      warned = true;
      showRestarting('The hub has not come back yet', `Still trying. If it stays away, double-click Restart Crux Hub; what the hub printed is in ${r.log || 'hub-4747.log'}.`, true);
    }
  }
  S.restarting = false;
  await load().catch(() => { });
  connect();
  showRestarting('Back', '', false, true);
  setTimeout(() => { if (!S.restarting) $('#restarting').hidden = true; }, 900);
}
function showRestarting(title, sub, warn = false, done = false) {
  const el = $('#restarting');
  $('#rs-title').textContent = title;
  $('#rs-sub').textContent = sub;
  el.classList.toggle('warn', warn);
  el.classList.toggle('done', done);
  el.hidden = false;
}
$('#rs-close').addEventListener('click', () => { $('#restarting').hidden = true; });
$('#hub-menu-btn').addEventListener('click', () => { S.hubMenu = S.hubMenu ? null : 'menu'; renderHubMenu(); $('#hub-menu .hm-item')?.focus(); });
$('#hub-menu').addEventListener('click', e => {
  if (e.target.closest('[data-hub-settings]')) { closeHubMenu(); settingsCards.openHub(); }
  else if (e.target.closest('[data-devices]')) { closeHubMenu(); guardUI.paired ? guardUI.openDevices() : guardUI.openPair(); }
  else if (e.target.closest('[data-restart]')) { S.hubMenu = 'confirm'; renderHubMenu(); $('#hub-menu [data-restart-go]')?.focus(); }
  else if (e.target.closest('[data-restart-go]')) act(restartHub);
  else if (e.target.closest('[data-phone-check]')) { phoneCheck.toggle(); closeHubMenu(); }
  else if (e.target.closest('[data-hub-menu-close]')) closeHubMenu();
});
const key = (p, t) => `${p}::${t}`;

// ---------- helpers ----------
// What waits for you: the rules live in all-projects.js (shared by Needs you and All projects, decision 42).
const openDecisions = p => AP.openDecisions(p);
const escalation = (p, id) => AP.escalation(p, id);
const withOrchestrator = p => AP.withOrchestrator(p, S.pending);
const pendingApprovals = p => AP.pendingApprovals(p, S.pending);
function pendingForYou(p) { return new Set(p ? pendingApprovals(p).map(e => e.approval) : []); }
const openQuestions = p => AP.openQuestions(p);
const pendingLessons = p => AP.pendingLessons(p);
// The project a card or row belongs to (All projects marks each group with data-pj); else the current one.
const projectOf = el => AP.projectOf(el, S.cplace ? [...S.projects, S.cplace] : S.projects, proj());
// The Conductor's state from /api/state (lib/conductor.mjs view()), and its place shaped like a project for the shared
// card and message drawing (its events, its one agent, no decisions).
function setConductor(c) {
  S.conductor = c || null;
  S.cplace = c ? CP.placeOf(c) : null;
}
function lessonsCard(ls) {
  return `<article class="card lessons">
    <div class="card-head">${icon('star')}<h3>${ls.length === 1 ? 'A lesson' : `${ls.length} lessons`} for your core profile</h3></div>
    <p class="muted">Agents noticed these about how you work. Added lessons go to every agent on every project.</p>
    <ul class="lesson-list">${ls.map(l => `<li><span class="ltext">${esc(l.text)} <span class="faint">· ${esc(l.from)}</span></span>
      <span class="row"><button class="btn" data-lesson="${esc(l.lesson)}" data-accept="1">${icon('check')}Add</button><button class="btn" data-lesson="${esc(l.lesson)}" data-accept="0">${icon('x')}Skip</button></span></li>`).join('')}</ul>
    ${ls.length > 1 ? `<div class="row"><button class="btn primary" data-lesson="${ls.map(l => esc(l.lesson)).join(',')}" data-accept="1">${icon('check')}Add all ${ls.length}</button></div>` : ''}
  </article>`;
}
// Images in threads (decision 23): stored in the project's attachments, read from /att/.
const attSrc = (p, id) => `/att/${encodeURIComponent(p.name)}/${encodeURIComponent(id)}`;
const sizeOf = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
function shotActs(src, name) {
  return `<span class="shot-acts"><button class="btn ghost icon-only" data-copy-img="${esc(src)}" aria-label="Copy image" title="Copy image">${icon('copy')}</button><a class="btn ghost icon-only" href="${esc(src)}" download="${esc(name)}" aria-label="Download image" title="Download image">${icon('download')}</a></span>`;
}
function shotsEl(p, list, caption = '') {
  return `<div class="shots ${list.length === 1 ? 'single' : ''}">${list.map((a, i) => {
    const src = attSrc(p, a.id);
    return `<button class="shot" data-view="${esc(src)}" data-view-name="crux-${esc(a.id)}" data-view-cap="${esc(caption || `Image ${i + 1} of ${list.length} · ${sizeOf(a.size)}`)}" aria-label="Open image ${i + 1}" title="Open larger"><img src="${src}" alt="" loading="lazy"></button>`;
  }).join('')}</div>`;
}
function visualEl(p, ev, compact) {
  if (ev.attachment) {   // a screenshot in the attachments store: open larger, copy, download
    const src = attSrc(p, ev.attachment.id), cap = ev.caption || 'Visual';
    return `<figure class="visual ${compact ? 'compact' : ''}"><button class="shot vis-shot" data-view="${esc(src)}" data-view-name="crux-${esc(ev.attachment.id)}" data-view-cap="${esc(cap)}" title="Open larger"><img class="vis-img" src="${src}" alt="${esc(cap)}" loading="lazy"></button>
      <figcaption><span>${esc(ev.caption || '')}</span>${shotActs(src, `crux-${ev.attachment.id}`)}</figcaption></figure>`;
  }
  const src = `/media/${encodeURIComponent(p.name)}/${encodeURIComponent(ev.visual)}`;
  const view = ev.kind === 'page'
    ? `<iframe class="vis-page" src="${src}" sandbox="allow-scripts" title="${esc(ev.caption || 'Visual')}" loading="lazy"></iframe>`
    : `<img class="vis-img" src="${src}" alt="${esc(ev.caption || 'Visual')}" loading="lazy">`;
  return `<figure class="visual ${compact ? 'compact' : ''}">${view}<figcaption>${esc(ev.caption || '')}<a href="${src}" target="_blank" rel="noopener" class="row">${icon('page')}Open</a></figcaption></figure>`;
}
// A round summary's questions, each answerable here (M010): its own row and reply box, Yes and No where the
// question is plainly yes or no. Send answers posts every filled box to the agent's thread as one message.
// ev.open: the questions still waiting; ev.byPicks: how many your picks answered. Dismiss (a row, or the card)
// takes it out of Needs you without telling the agent; the summary stays in its thread.
// Drafts live in S.drafts, so the list can redraw while you type.
const draftKey = (id, i) => `${id}:${i}`;
function filledAnswers(ev) { return ev.open.map(q => ({ index: q.i, text: (S.drafts[draftKey(ev.id, q.i)] || '').trim() })).filter(a => a.text); }
function questionCard(ev, p = proj()) {
  const vis = (ev.visuals || []).map(id => p.events.find(e => e.type === 'visual' && e.visual === id)).filter(Boolean);
  const where = ev.thread === 'orchestrator' ? 'the orchestrator thread' : ev.thread;
  const filled = filledAnswers(ev).length;
  const rows = ev.open.map(q => {
    const k = draftKey(ev.id, q.i), draft = S.drafts[k] || '';
    const yn = isYesNo(q.text) ? ['Yes', 'No'].map(w => `<button class="qquick ${draft === w ? 'on' : ''}" data-quick="${esc(k)}" data-word="${w}" aria-pressed="${draft === w}">${w}</button>`).join('') : '';
    return `<div class="qrow">
      <p class="qtext">${esc(q.text)}</p>
      <div class="qreply">${yn}<textarea class="qbox" rows="1" enterkeyhint="send"data-answer="${esc(k)}" data-q="${esc(ev.id)}" aria-label="Your answer" placeholder="${replyHint({ narrow: phoneMq.matches, several: ev.open.length > 1 })}">${esc(draft)}</textarea>
        <button class="btn ghost icon-only qx" data-dismiss="${esc(ev.id)}" data-index="${q.i}" aria-label="Dismiss this question" title="Dismiss this question: it leaves Needs you, and ${esc(ev.from)} is not told">${icon('x')}</button></div>
    </div>`;
  }).join('');
  return `<article class="card question" data-card="question:${esc(ev.id)}" tabindex="0">
    <div class="card-head">${icon('inbox')}<h3>${esc(ev.from)} asks</h3><span class="keys">Enter to answer</span><span class="time">${timeOf(ev.ts)}</span></div>
    ${vis.map(v => visualEl(p, v, true)).join('')}
    <div class="qrows">${rows}</div>
    ${ev.byPicks ? `<p class="faint q-done">${ev.byPicks === 1 ? 'One more question was' : `${ev.byPicks} more questions were`} answered by your picks.</p>` : ''}
    <div class="row qfoot"><button class="btn primary" data-send-answers="${esc(ev.id)}" ${filled ? '' : 'disabled'} title="Send every filled answer to ${esc(ev.from)} as one message">${icon('send')}<span class="qcount">${sendLabel(filled, ev.open.length)}</span></button>
      <button class="btn ghost" data-thread="${esc(ev.thread)}" title="Open ${esc(where)}">Open thread</button>
      <span class="spacer"></span>${ev.open.length > 1 ? `<button class="btn ghost qall" data-dismiss="${esc(ev.id)}" aria-label="Dismiss all" title="Dismiss all: take the whole card out of Needs you. The agent is not told.">${icon('x')}<span class="lbl">Dismiss all</span></button>` : ''}</div>
  </article>`;
}
const sendLabel = (n, of) => !n ? 'Send answers' : n === 1 && of === 1 ? 'Send answer' : `Send ${n} answer${n === 1 ? '' : 's'}`;
// p: the project the card belongs to (projectOf), so answers from All projects reach the right agent.
function sendAnswers(id, p = proj()) {
  const ev = openQuestions(p).find(q => q.id === id);
  if (!ev || S.sending) return;
  const answers = filledAnswers(ev);
  if (!answers.length) return;
  S.sending = true;
  act(async () => {
    try {
      await api('/api/answer', { project: p.name, question: id, answers });
      for (const a of answers) delete S.drafts[draftKey(id, a.index)];
      store.set('drafts', S.drafts);
    } finally { S.sending = false; }
  });
}
// Typing in a reply box: keep the draft, grow the box, and light the card's Send button, without a redraw.
function draftChanged(box) {
  S.drafts[box.dataset.answer] = box.value;
  if (!box.value) delete S.drafts[box.dataset.answer];
  store.set('drafts', S.drafts);
  growBox(box, 140);
  const ev = openQuestions(projectOf(box)).find(q => q.id === box.dataset.q);
  const btn = box.closest('.card')?.querySelector('[data-send-answers]');
  if (ev && btn) { const n = filledAnswers(ev).length; btn.disabled = !n; btn.querySelector('.qcount').textContent = sendLabel(n, ev.open.length); }
  for (const b of box.closest('.qrow')?.querySelectorAll('.qquick') || []) { const on = box.value === b.dataset.word; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
}
// (Text boxes grow with their text without the list moving: growBox, in conversation.js.)
function threadEvents(p, t) {
  const agentThread = new Map(p.agents.map(a => [a.name, a.thread]));
  return p.events.filter(e => e.thread === t || (e.type === 'entry' && agentThread.get(e.from) === t));
}
function orchestrator(p) { return p.agents.find(a => a.role === 'orchestrator' && a.state !== 'retired'); }
function timeOf(ts) { const d = new Date(ts); return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

// Agents' messages are markdown (markdown.js): lists and tables may follow a text line directly.

// ---------- render: sidebar ----------
// Everything in a project that waits for you: decisions, permission cards, questions, profile lessons (one card).
// Everything that waits for you, in every project (All projects, decision 42): worked out once per render and shared
// by the hub row, the column, its header, the map counter and each project's counts. render() starts it afresh.
const hub = () => S.hub || (S.hub = AP.hubView(S.projects, S.pending));
const needsCount = p => hub().groups.find(g => g.p === p)?.count ?? AP.needsCount(p, S.pending);
const hubTotal = () => hub().total;
// What waits for you in one thread (a column's red count, decision 39): its permission cards and questions, and the
// open decisions its round summaries asked for. Needs you counts everything in the project; All projects, every project.
function waitingIn(p, t) {
  if (t === AP.HUB_THREAD) return hubTotal() + (S.conductor?.waiting || 0);
  if (!p) return 0;
  if (t === 'needs') return needsCount(p);
  return AP.threadWaiting(p, t, S.pending);
}
// The HUD frame's boot readout (decision 33), once, when the hub opens.
function bootReadout() {
  const p = proj(), live = p ? p.agents.filter(a => a.state !== 'retired') : [];
  hudBoot({ project: p?.name, agents: live.length, working: live.filter(a => ['working', 'starting'].includes(a.state)).length, waiting: p ? needsCount(p) : 0 });
}

// One row however many projects there are: the current one, a count when it needs you, a dot when another does.
function renderProjects() {
  renderHubSwitches();
  const cur = proj();
  if (!cur) { $('#projects').innerHTML = ''; return; }
  const multi = S.projects.length > 1;
  const elsewhere = S.projects.filter(p => p !== cur && needsCount(p) > 0);
  const n = needsCount(cur);
  const head = `<button class="proj-current" ${multi ? `data-proj-toggle aria-haspopup="listbox" aria-expanded="${S.projMenu ? 'true' : 'false'}"` : 'disabled'} title="${multi ? 'Switch project' : esc(cur.dir)}">
    ${icon('projects')}<span class="pname">${esc(cur.name)}</span>
    ${n ? `<span class="pbadge" title="${n} waiting here">${n}</span>` : ''}
    ${elsewhere.length ? `<span class="pdot" title="${elsewhere.map(p => esc(p.name)).join(', ')} need${elsewhere.length === 1 ? 's' : ''} you"></span>` : ''}
    ${multi ? icon('chevron') : ''}</button>`;
  const menu = multi && S.projMenu ? `<div class="proj-menu" role="listbox" aria-label="Projects">${S.projects.map(p => {
    const k = needsCount(p);
    return `<button role="option" aria-selected="${p === cur}" data-project="${esc(p.name)}" class="pitem ${p === cur ? 'on' : ''}" title="${esc(p.dir)}">
      <span class="pname">${esc(p.name)}</span><span class="pmode ${esc(p.permissionMode)}">${modeWord(p)}</span><span class="pcount ${k ? 'hot' : ''}">${k ? `${k} waiting` : 'All clear'}</span></button>`;
  }).join('')}</div>` : '';
  // Decision 44 B: the level chip replaces the Ask/Auto and connector switches; it opens the project's settings card.
  $('#projects').innerHTML = `<div class="proj-switch"><div class="proj-row">${head}${levelChip(cur)}</div>${menu}</div>`;
}

// Decision 21's switch, one for the whole hub, under the hub's name (route-switch.js); amber mark when off.
function renderHubSwitches() {
  const r = routeSwitch({ on: S.settings?.routePermissions !== false, rules: proj()?.permissionRules });
  $('#hub-switches').innerHTML = `<button class="mode-switch route ${r.on ? 'auto' : 'off'}" role="switch" aria-checked="${r.on}" data-route-toggle title="${esc(r.tip)}" aria-label="${esc(r.tip)}">
    <i class="mode-knob"></i>${icon('shield')}<span class="rw">${esc(r.word)}</span>${r.warn ? `<span class="amber-mark">${icon('warn')}</span>` : ''}</button>`;
}

// Which permission level applies here (decisions 34 and 45): Ask, Auto or Trusted, set on the project's settings
// card (project-settings.js), which also holds connectors and the handoff numbers (decision 44 B).
const modeWord = p => (LEVEL_INFO[p.permissionMode] || LEVEL_INFO.standard).word;
const settingsCards = new SettingsCards({
  api, reload: () => load(), toast: m => toast(m),
  hubSettings: () => S.settings || {},
  sideRect: () => $('#side')?.getBoundingClientRect()
});

function lastLine(p, t) {
  const ev = threadEvents(p, t).filter(e => ['message', 'summary', 'notice', 'pick'].includes(e.type)).at(-1);
  if (!ev) return '';
  if (ev.type === 'summary') return `Summary: ${(ev.done || [])[0] || ev.next_step || 'posted'}`;
  if (ev.type === 'pick') return `Picked D${pad(ev.decision)} ${ev.label}`;
  return `${ev.from === 'you' ? 'You: ' : ''}${ev.from === 'you' ? String(ev.text || '').replace(/^> /gm, '') : ev.text}`;
}
function unread(p, t) { return threadEvents(p, t).length > (S.seen[key(p.name, t)] || 0); }

// An agent's icon carries a ring in its model's hue (decision 20); no ring until its model is known.
// Decision 39: each row also carries a pin (shown on hover or keyboard focus, lit while pinned). The row is a
// wrapper holding two sibling buttons, the row itself and its pin, so no button sits inside another.
const avaHtml = ({ ava, avaClass = '', agent = null }) => {
  const hue = agent ? hueOf(modelOf(agent)) : null;
  const ring = hue ? ` ring" style="--mh:${hue}" title="${esc(describe(agent))}` : '';
  return `<span class="ava ${avaClass}${ring}">${agent ? robot(agent) : icon(ava)}</span>`;
};
function threadButton({ id, name, ava, avaClass = '', last, right, agent = null }) {
  const pinned = cols.isPinned(id);
  const tip = pinned ? `Unpin ${name}: close its column` : `Pin ${name}: open it as a column beside the current one`;
  return `<div class="thread-row ${pinned ? 'pinned' : ''}"><button class="thread ${cols.kb === id ? 'on' : ''}" data-thread="${esc(id)}">
    ${avaHtml({ ava, avaClass, agent })}
    <span class="name">${esc(name)}</span>${right}
    <span class="last">${esc(last)}</span></button><button type="button" class="row-pin" data-row-pin="${esc(id)}" aria-pressed="${pinned}" aria-label="${esc(tip)}" title="${esc(tip)}">${icon('pin')}</button></div>`;
}
// A thread's avatar as the rail shows it, with its red count; a click shows it in place of the column named.
// A column that is not pinned can fold too (the keyboard went elsewhere): it is labelled as open, not pinned.
function railItem(t, instead, pinned = true) {
  const p = proj(), n = waitingIn(p, t);
  const agent = t === 'orchestrator' ? orchestrator(p) : p?.agents.find(a => a.thread === t);
  const label = { needs: 'Needs you', orchestrator: 'the orchestrator', [AP.HUB_THREAD]: 'All projects' };
  const name = t === 'orchestrator' ? 'The orchestrator' : label[t] || t;
  const where = label[instead] || instead;
  const ava = t === 'needs' || t === AP.HUB_THREAD ? avaHtml({ ava: t === 'needs' ? 'inbox' : 'projects', avaClass: n ? 'needs' : 'hub' }) : avaHtml({ ava: t === 'orchestrator' ? 'orch' : 'agent', avaClass: t === 'orchestrator' ? 'orch' : '', agent });
  const tip = `${name}: ${pinned ? 'pinned' : 'open, not pinned'}, folded for lack of room.${n ? ` ${n} waiting for your call.` : ''} Click to show it in place of ${where}.`;
  return `<button type="button" class="rail-item" data-rail="${esc(t)}" aria-label="${esc(tip)}" title="${esc(tip)}">${ava}${n ? `<span class="colbadge">${n}</span>` : ''}</button>`;
}

// The hub-wide row above the project switcher (decision 42): All projects, with everything that waits in every
// project. Shown when the hub runs more than one project; with one, Needs you already is everything.
function renderHubThreads() {
  const n = S.projects.length, total = hubTotal();
  const el = $('#hub-threads');
  el.hidden = n < 2;
  // With a Conductor (decision 55) the row wears its robot with the halo and its latest line, like an orchestrator's.
  const c = S.conductor, all = total + (c?.waiting || 0);
  el.innerHTML = n < 2 ? '' : threadButton({ id: AP.HUB_THREAD, name: 'All projects', ava: 'projects', avaClass: all ? 'needs' : 'hub', agent: c ? CP.agentOf(c) : null,
    last: c && CP.threadItems(c).length ? CP.lastLine(c) : `${total ? `${total} waiting` : 'Nothing waiting'} · ${n} projects`, right: all ? `<span class="badge" title="${all} waiting for your call across ${n} projects">${all}</span>` : '' });
}

function renderThreads() {
  renderHubThreads();
  const p = proj();
  if (!p) { const l = $('#threads'); l.innerHTML = ''; delete l.dataset.html; return; }
  const needs = needsCount(p);
  const orch = orchestrator(p);
  const workers = p.agents.filter(a => a.role === 'worker');
  const active = workers.filter(a => a.state !== 'retired');
  // A thread on screen in a column is being read: no unread dot for it.
  const dot = (a, t) => `<span class="dot ${!cols.visible(t) && unread(p, t) ? 'unread' : a?.state || ''}"></span>`;
  let html = threadButton({ id: 'needs', name: 'Needs you', ava: 'inbox', avaClass: needs ? 'needs' : '', last: needs ? `${needs} waiting for your call` : 'Nothing waiting', right: needs ? `<span class="badge">${needs}</span>` : '' });
  html += threadButton({ id: 'orchestrator', name: orch ? `Orchestrator · ${orch.name.replace('orchestrator-', '#')}` : 'Orchestrator', ava: 'orch', avaClass: 'orch', last: lastLine(p, 'orchestrator') || 'Starts when you send a message', right: dot(orch, 'orchestrator'), agent: orch });
  if (active.length) html += `<div class="side-label">Agents</div>` + active.map(a => threadButton({ id: a.thread, name: a.name, ava: 'agent', last: lastLine(p, a.thread) || goalOf(a), right: dot(a, a.thread), agent: a })).join('');
  html += retiredSection(p, workers);
  // Redrawn on every update (an agent's state, its activity): only the rows that changed are swapped, so the list
  // never jumps to its top on the phone, and the row you were looking at stays put (list-patch.js).
  const list = $('#threads');
  if (list.dataset.html !== html) { list.dataset.html = html; patchKeep(list, html); }
}

// Retired workers (read-only threads): one folded row, "Retired (N)" with N the recent ones; compact rows inside,
// the older ones behind "Show older (M)" (retired-list.js). The open thread is never hidden: the section opens for it.
function retiredSection(p, workers) {
  const cur = cols.kb;
  const rv = retiredView(workers, p.events, { showOlder: S.retiredOlder, current: cur });
  if (!rv.any) return '';
  if (rv.holdsCurrent && !S.retiredOpen && S.retiredAutoFor !== cur) { S.retiredOpen = true; store.set('retired-open', true); }
  S.retiredAutoFor = rv.holdsCurrent ? cur : null;   // once opened for this thread, closing it again is yours
  const open = S.retiredOpen;
  const tip = `${open ? 'Fold' : 'Show'} retired agents. They are read-only; older than ${RETIRED_RECENT_DAYS} days sit behind Show older.`;
  const head = `<button class="side-label retired-head ${open ? 'open' : ''} ${!open && rv.holdsCurrent ? 'holds' : ''}" data-retired-toggle aria-expanded="${open}" title="${esc(tip)}">${icon('chevron')}<span class="rk">Retired (${rv.count})</span></button>`;
  if (!open) return head;
  const row = a => `<button class="thread mini ${cur === a.thread ? 'on' : ''}" data-thread="${esc(a.thread)}" title="${esc(a.name)}">
    <span class="ava gone">${robot(a, { size: 16, cls: 'calm' })}</span><span class="name">${esc(a.name)}</span></button>`;
  const more = rv.olderCount ? `<button class="thread mini more" data-retired-older aria-expanded="${S.retiredOlder}" title="Retired more than ${RETIRED_RECENT_DAYS} days ago">
    <span class="ava">${icon('chevron')}</span><span class="name">${S.retiredOlder ? 'Hide older' : 'Show older'} (${rv.olderCount})</span></button>` : '';
  return head + `<div class="retired-list">${rv.shown.map(row).join('')}${more}</div>`;
}

// ---------- render: cards ----------
function decisionCard(p, d) {
  if (!d) return '';
  const open = d.status === 'open', found = d.status === 'found';
  const opts = (d.options || []).map(o => `
    <button class="opt ${o.key === d.recommended ? 'rec' : ''} ${o.key === d.chosen ? 'chosen' : ''}" data-pick="${d.id}" data-choice="${o.key}" ${open ? '' : 'disabled'}>
      <span class="key">${esc(o.key)}</span>
      <span class="oname">${esc(o.name)}${o.key === d.recommended ? `<span class="chip rec">${icon('star')}recommended${d.confidence ? ' · ' + esc(d.confidence) : ''}</span>` : ''}</span>
      <span class="osum">${esc(o.summary || '')}</span>
    </button>`).join('');
  const foot = open
    ? `${d.recommended ? `<button class="btn primary" data-pick="${d.id}" data-choice="${d.recommended}">${icon('check')}Take ${esc(d.recommended)}</button>` : ''}<span class="faint">or reply "${d.id}${esc(d.recommended || 'A')}"</span>`
    : found
      ? `<button class="btn good" data-pick="${d.id}" data-choice="confirm">${icon('check')}Confirm</button><button class="btn" data-pick="${d.id}" data-choice="reject">${icon('x')}Reject</button>`
      : `<span class="chip ${esc(d.status)}">${esc(d.status)}${d.chosen ? ' · ' + esc(d.chosen) : ''}</span>`;
  const keys = open ? (d.options || []).map(o => o.key).join(' ') : found ? 'Y confirm · N reject' : '';
  return `<article class="card decision ${open || found ? '' : 'done'}" data-card="decision:${d.id}" ${open || found ? 'tabindex="0"' : ''}>
    <div class="card-head"><h3>D${pad(d.id)} · ${esc(d.title)}</h3>${keys ? `<span class="keys">${open ? `Keys ${esc(keys)}` : keys}</span>` : ''}<span class="chip ${esc(d.status)}">${esc(d.status)}</span></div>
    ${d.lead ? `<p class="lead-line">${esc(d.lead)}</p>` : d.context ? `<p class="ctx">${esc(d.context)}</p>` : ''}
    ${found ? '' : `<div class="options">${opts}</div>`}
    <div class="foot">${foot}<span class="spacer"></span>${briefButton(p.name, d)}${picturesButton(p.name, d)}<a href="/p/${encodeURIComponent(p.name)}/${esc(d.page)}" target="_blank" rel="noopener" class="row">${icon('page')}Full page</a></div>
  </article>`;
}

// The agent's own one-line description of a request (the Bash or PowerShell description, or the SDK's), else ''.
function approvalHeadline(ev) { return String(ev.input?.description || ev.description || '').trim().split('\n')[0].slice(0, 160); }

function approvalCard(ev, p = proj()) {
  const live = S.pending.has(ev.approval);
  const result = p.events.find(e => e.type === 'approval_result' && e.approval === ev.approval);
  const input = ev.input?.command || ev.input?.file_path || JSON.stringify(ev.input, null, 1);
  // Plain words first: the agent's own description leads when it gave one; then what the hub reads in the command
  // (its own check on that description), the tags, and the command itself.
  const plain = ev.summary?.plain;
  const desc = approvalHeadline(ev);
  const hubReads = desc && plain && plain.toLowerCase() !== desc.toLowerCase() ? plain : '';
  if (!live && !S.open.has(ev.approval)) {
    // Answered: one line. Click to see it again.
    const what = desc || plain || String(input).split('\n')[0];
    return `<button class="mini-approval" data-expand="${esc(ev.approval)}">${icon('shield')}<span class="what">${esc(ev.agent)} · ${esc(what)}</span><span class="chip">${esc(result ? result.how : 'expired')}</span></button>`;
  }
  // Why it is with you (decision 21): a hard stop the hub found, the orchestrator escalating, or no answer in time.
  const esc8 = escalation(p, ev.approval);
  const routeNote = esc8 ? `<p class="route-note">${icon('orch')}${esc8.by === 'hub' ? esc(esc8.reason) : `${esc(esc8.by)} sent it to you: ${esc(esc8.reason)}`}</p>`
    : ev.stops?.length ? '' : ev.routedTo && live ? `<p class="route-note">${icon('orch')}With ${esc(ev.routedTo)} for now; answering it here overrides it.</p>` : '';
  // A hard stop the hub found goes straight under the headline, so the agent's own words never come first alone.
  const stopNote = !esc8 && ev.stops?.length ? `<p class="route-note stop">${icon('shield')}<span><b>Always yours${ev.rules ? ` under ${esc(ev.rules)}` : ''}:</b> ${esc(ev.stops.join('; '))}</span></p>` : '';
  const tags = (ev.summary?.tags || []).map(t => `<span class="tag ${esc(t.level)}">${esc(t.text)}</span>`).join('');
  const raw = `<pre>${esc(input)}</pre>`;
  return `<article class="card approval ${live ? '' : 'answered'}" data-card="approval:${esc(ev.approval)}" ${live ? 'tabindex="0"' : `data-expand="${esc(ev.approval)}"`}>
    <div class="card-head">${icon('shield')}<h3>${desc ? `${esc(ev.agent)}: ${esc(desc)}` : `${esc(ev.agent)} wants to ${plain ? esc(plain[0].toLowerCase() + plain.slice(1)) : `use ${esc(ev.title || ev.tool)}`}`}</h3>${live ? '<span class="keys">A allow · D deny</span>' : ''}</div>
    ${stopNote}
    ${hubReads ? `<p class="muted why">The hub reads: ${esc(hubReads)}</p>` : ''}
    ${tags ? `<div class="tags">${tags}</div>` : ''}
    ${routeNote}
    ${plain ? `<div class="raw">${fold('cmd:' + ev.approval, raw, String(input).length > 120 || String(input).includes('\n'))}</div>` : raw}
    <div class="row">${live
      // M008 10: Allow and Deny side by side; Always allow is a quieter text button that says which rule it saves.
      ? `<button class="btn primary" data-approve="${ev.approval}">${icon('check')}Allow</button><button class="btn deny" data-deny="${ev.approval}">${icon('x')}Deny</button>${ev.always ? `<button class="always-btn" data-approve="${ev.approval}" data-always title="Allows this now, and saves the rule to this project's Claude Code settings (.claude/settings.local.json), where you can remove it">Always allow <span class="always-rule">${esc(ev.always.join('; '))}</span></button>` : ''}`
      : `<span class="chip">${esc(result ? result.how : 'expired')}</span>`}</div>
  </article>`;
}

// One audit line per answer to a worker's permission request (decision 21): worker, tool, command, answer, reason.
const ANSWER = { allow: ['allowed', 'good'], deny: ['denied', 'bad'], escalate: ['sent to you', 'warn'], timeout: ['no answer, sent to you', 'warn'] };
function permLine(ev) {
  const [word, tone] = ANSWER[ev.answer] || [ev.answer, ''];
  const who = ev.by === 'you' ? 'You' : '';
  const open = S.open.has('perm:' + ev.id);
  return `<button class="perm-line ${tone} ${open ? 'open' : ''}" data-expand="perm:${esc(ev.id)}" title="${esc(`${ev.worker} · ${ev.tool}: ${ev.command}\n${ev.reason}`)}">
    ${icon('shield')}<span class="pl-who">${esc(ev.worker)}</span><span class="pl-tool">${esc(ev.tool)}</span>
    <code class="pl-cmd">${esc(ev.command)}</code>
    <span class="pl-ans">${who ? `${who} ` : ''}${esc(word)}</span><span class="pl-why">${esc(ev.reason)}</span>
    <span class="time">${timeOf(ev.ts)}</span></button>`;
}

function summaryCard(p, ev) {
  const sec = (label, xs) => xs?.length ? `<dt>${label}</dt><dd><ul>${xs.map(x => `<li>${esc(x)}</li>`).join('')}</ul></dd>` : '';
  const decisions = (ev.decisions_needed || []).map(id => p.board.decisions.find(d => d.id === Number(id))).filter(Boolean);
  return `<article class="card summary">
    <div class="card-head">${icon('check')}<h3>${esc(ev.from)} finished a round</h3><span class="time">${timeOf(ev.ts)}</span></div>
    ${fold(ev.id, `<dl>${sec('Done', ev.done)}${sec('Changed', ev.changed)}${sec('Questions', ev.questions)}${sec('Blocked on', ev.blocked_on)}${ev.next_step ? `<dt>Next step</dt><dd>${esc(ev.next_step)}</dd>` : ''}</dl>`,
      isTall([ev.done, ev.changed, ev.questions, ev.blocked_on, ev.next_step].flat().filter(Boolean).join('\n'), 700))}
  </article>${decisions.map(d => decisionCard(p, d)).join('')}`;
}

// Long text is folded to a few lines; briefs between agents fold harder. S.open remembers what you expanded.
function fold(id, html, tall) {
  if (!tall) return html;
  const open = S.open.has(id);
  return `<div class="fold ${open ? 'open' : ''}">${html}</div><button class="more" data-expand="${esc(id)}">${open ? 'Show less' : 'Show all'}</button>`;
}
function isTall(text, limit) { const s = String(text || ''); return s.length > limit || s.split('\n').length > limit / 60; }

function messageEl(p, ev, t) {
  const you = ev.from === 'you';
  const relay = !you && t !== 'orchestrator' && /^orchestrator-/.test(ev.from);
  // Your words as typed; "> " lines (a question quoted by an answer from Needs you) show as a quote.
  const body = you ? `<p>${String(ev.text || '').split('\n').map(l => /^> /.test(l) ? `<span class="yq">${esc(l.slice(2))}</span>` : esc(l)).join('<br>').replace(/<\/span><br>/g, '</span>')}</p>` : md(ev.text);
  // A brief that started a worker says what it was started as.
  const runs = 'model' in ev || 'effort' in ev ? modelChip({ type: ev.agentType, model: ev.model, effort: ev.effort, modelSeen: t !== 'orchestrator' && p.agents.find(a => a.thread === ev.thread)?.modelSeen }, { mini: true }) : '';
  // Images as thumbnails; PDFs and text files as file chips that download on click.
  const imgs = (ev.attachments || []).filter(a => IMG_TYPES[a.type]), docs = (ev.attachments || []).filter(a => !IMG_TYPES[a.type]);
  const shots = (imgs.length ? shotsEl(p, imgs) : '') + (docs.length ? `<div class="fchips sent">${docs.map(a => fileChip({ name: a.name, size: a.size, type: a.type, href: attSrc(p, a.id) })).join('')}</div>` : '');
  return `<div class="msg ${you ? 'you' : ''} ${relay ? 'relay' : ''}">
    <span class="who">${you ? 'You' : esc(ev.from)}${relay ? ` → ${esc(ev.thread)}` : ''} · ${timeOf(ev.ts)}${runs ? ` · started as ${runs}` : ''}</span>
    ${shots}${ev.text || !shots ? `<div class="bubble">${fold(ev.id, body, isTall(ev.text, relay ? 240 : 900))}</div>` : ''}</div>`;
}

// What a worker is for, in one line: its goal, else the first line of its task.
function goalOf(a) {
  if (a?.goal) return a.goal;
  const first = String(a?.task || '').split(/\n|(?<=\.)\s/)[0];
  return first.length > 90 ? first.slice(0, 88) + '…' : first;
}

// ---------- model and effort (decision 20) ----------
// "Opus 5.5 · high" and five pips in the model's hue. A button opens the menu; in a brief it is just a label.
function modelChip(a, { button = false, mini = false } = {}) {
  const id = modelOf(a), hue = hueOf(id);
  const eff = a.effort ? EFFORT_SHORT[a.effort] : 'default';
  const open = S.mmenu === a.name;
  const [fam, ...ver] = modelLabel(id).split(' ');   // the version and the effort word drop out at phone width
  const inner = `${robot(a, { size: 18, cls: mini ? 'calm' : '' })}${a.type ? `<span class="mtype">${esc(a.type)}</span>` : ''}<span class="mname">${esc(fam)}${ver.length ? `<span class="mver"> ${esc(ver.join(' '))}</span>` : ''}</span><span class="msep">·</span><span class="meff">${esc(eff)}</span>${pips(a.effort)}`;
  const cls = `mchip ${mini ? 'mini' : ''} ${hue ? '' : 'nohue'} ${a.restartPending ? 'pending' : ''}`;
  const style = hue ? ` style="--mh:${hue}"` : '';
  const tip = `${describe(a)}${a.restartPending ? '. The change applies once it finishes what it is doing' : ''}`;
  return button
    ? `<button class="${cls}"${style} data-mchip="${esc(a.name)}" aria-haspopup="dialog" aria-expanded="${open}" title="${esc(tip)}. Change model or effort">${inner}${icon('chevron')}</button>`
    : `<span class="${cls}"${style} title="${esc(tip)}">${inner}</span>`;
}

// Radio rows, shared by the chip's menu and the new-agent form. value '' is Claude Code's default.
function modelPicker(name, value) {
  const opts = [{ id: '', label: 'Default' }, ...S.models];
  if (value && !opts.some(m => m.id === value)) opts.push({ id: value, label: modelLabel(value) });
  return `<div class="seg mseg" role="radiogroup" aria-label="Model">${opts.map(m => {
    const hue = m.id ? hueOf(m.id) : null;
    return `<label class="segopt ${hue ? '' : 'nohue'}" ${hue ? `style="--mh:${hue}"` : ''} title="${m.id ? esc(m.label) : 'Claude Code’s own default model'}">
      <input type="radio" name="${name}" value="${esc(m.id)}" ${value === m.id ? 'checked' : ''}><span><i class="mdot"></i>${esc(m.id ? m.label.split(' ')[0] : 'Default')}</span></label>`;
  }).join('')}</div>`;
}
function effortPicker(name, value, hue) {
  const opts = ['', ...EFFORTS];
  return `<div class="seg eseg ${hue ? '' : 'nohue'}" role="radiogroup" aria-label="Effort" ${hue ? `style="--mh:${hue}"` : ''}>${opts.map(e => `
    <label class="segopt" title="${e ? `Effort: ${EFFORT_SHORT[e]}` : 'Claude Code’s own default effort'}">
      <input type="radio" name="${name}" value="${e}" ${value === e ? 'checked' : ''}><span>${pips(e || null)}<em>${e ? EFFORT_SHORT[e] : 'default'}</em></span></label>`).join('')}</div>`;
}
function typeOptions(p, value) {
  const types = p?.types || [];
  return `<option value="">${types.length ? 'None' : 'None set up yet'}</option>` + types.map(t =>
    `<option value="${esc(t.name)}" ${t.name === value ? 'selected' : ''}>${esc(t.name)}${t.model || t.effort ? ` · ${esc([t.model && modelLabel(t.model), t.effort && EFFORT_SHORT[t.effort]].filter(Boolean).join(', '))}` : ''}</option>`).join('');
}
const TYPE_TIP = 'Agent types are Claude Code agent files: ~/.claude/agents for every project, or this project’s .claude/agents';

// The chip's menu: change model, effort or type in place. Every change applies at once; Escape or a click outside closes it.
function renderModelMenu() {
  const el = $('#mmenu'), p = proj();
  const a = S.mmenu && p?.agents.find(x => x.name === S.mmenu && x.state !== 'retired');
  if (!a) { el.hidden = true; el.dataset.html = ''; S.mmenu = null; return; }
  const hue = hueOf(modelOf(a));
  const live = a.live || ['working', 'starting', 'idle'].includes(a.state);
  const html = `<div class="mm-head"><b>${esc(a.role === 'orchestrator' ? 'Orchestrator' : a.name)}</b><span class="faint">${esc(describe(a))}</span>
      <button class="mm-x" data-mm-close aria-label="Close">${icon('x')}</button></div>
    <div class="mm-row"><span class="flabel">Model</span>${modelPicker('mm-model', a.model || '')}</div>
    <div class="mm-row"><span class="flabel">Effort</span>${effortPicker('mm-effort', a.effort || '', hue)}</div>
    <label class="mm-row" title="${esc(TYPE_TIP)}"><span class="flabel">Type</span><select name="mm-type">${typeOptions(p, a.type)}</select></label>
    <p class="mm-note faint">${live ? 'Model and effort switch right away. A new type restarts it when it is free; it keeps the conversation.' : 'Applies when it next starts.'}</p>`;
  if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
  el.hidden = false;
  placeModelMenu();
}
function placeModelMenu() {
  const el = $('#mmenu'), chip = document.querySelector(`[data-mchip="${CSS.escape(S.mmenu || '')}"]`);
  if (el.hidden || !chip) return;
  const r = chip.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
  const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
  const below = r.bottom + 6 + h <= innerHeight - 8;
  el.style.left = left + 'px';
  el.style.top = (below ? r.bottom + 6 : Math.max(8, r.top - 6 - h)) + 'px';
}
function closeModelMenu() { if (!S.mmenu) return; const n = S.mmenu; S.mmenu = null; cols.render(); renderModelMenu(); document.querySelector(`[data-mchip="${CSS.escape(n)}"]`)?.focus(); }

// ---------- render: one conversation (a column; conversation.js draws it, these say what is in it) ----------
// The list for thread t, as HTML. Seeing a thread's list in a column marks it read.
// The count bar (M008 1): what is waiting, by kind; each count jumps to its first card.
function countBar(total, kinds) {
  return total ? `<div class="countbar" role="navigation" aria-label="Waiting for you"><span class="cb-total"><b>${total}</b> waiting</span>${kinds.map(([k, n, one, many]) => `<button class="cb-chip" data-jump="${k}" title="Go to the first ${one}">${n} ${n === 1 ? one : many}</button>`).join('')}</div>` : '';
}

// ---------- All projects (decision 42 A) ----------
// Every project's waiting cards, grouped by project and answerable in place, then every orchestrator and agent.
// Each group carries data-pj (not data-project, which switches project on a click), so an answer from a card goes to
// that project (projectOf) and a row or "Open thread" opens the thread in its own project.
function hubHead(g, meta = '') {
  return `<div class="hub-head"><span class="hub-k">${icon('projects')}<b>${esc(g.name)}</b></span><span class="hub-mode" title="${g.mode === 'Auto' ? 'Auto: contained work runs without asking' : 'Ask: anything beyond reading goes to the orchestrator or to you'}">${g.mode}</span>
    <span class="hub-line"></span>${meta ? `<span class="hub-meta">${meta}</span>` : g.count ? `<span class="colbadge" title="${g.count} waiting for your call in ${esc(g.name)}">${g.count}</span>` : ''}
    <button type="button" class="btn ghost icon-only hub-go" data-project="${esc(g.name)}" aria-label="Open ${esc(g.name)}" title="Open ${esc(g.name)}: its threads, board and live map">${icon('chevron')}</button></div>`;
}
// One agent: its robot in its model's hue, name, state, model chip, context ring and red count. A click opens its thread.
function agentRow(p, a) {
  const n = waitingIn(p, a.thread), hue = hueOf(modelOf(a));
  const name = a.role === 'orchestrator' ? `Orchestrator · ${a.name.replace('orchestrator-', '#')}` : a.name;
  return `<button type="button" class="hub-agent ${n ? 'asks' : ''}" data-thread="${esc(a.thread)}" title="Open ${esc(name)} in ${esc(p.name)}">
    <span class="ava${hue ? ' ring' : ''}"${hue ? ` style="--mh:${hue}"` : ''}>${robot(a, { size: 24, needs: n > 0 })}</span>
    <span class="ha-l1"><b class="ha-name">${esc(name)}</b><span class="dot ${esc(a.state)}" title="${esc(a.state)}"></span><span class="chip ${esc(a.state)}">${esc(a.state)}</span>${modelChip(a, { mini: true })}</span>
    <span class="ha-l2">${esc(lastLine(p, a.thread) || goalOf(a))}</span>
    ${AP.contextRing(a, { hue, retireAt: p.retireAt || S.retireAt || 60 })}${n ? `<span class="colbadge" title="${n} waiting for your call">${n}</span>` : ''}</button>`;
}
// The Conductor's thread (decision 55), pinned at the top of All projects: its latest few items, the earlier ones
// folded, and its lesson card. The message box at the column's foot writes to it.
function conductorSection() {
  const c = S.conductor, place = S.cplace;
  if (!c) return '';
  const a = CP.agentOf(c), hue = hueOf(modelOf(a));
  const items = CP.threadItems(c), open = S.open.has('conductor-earlier');
  const { shown, hidden } = CP.shownItems(items, open);
  const item = ev => {
    switch (ev.type) {
      case 'message': return messageEl(place, ev, CP.CONDUCTOR_THREAD);
      case 'summary': return summaryCard(place, ev);
      case 'notice': return `<div class="notice">${esc(ev.text)}</div>`;
      case 'visual': return `<div class="msg"><span class="who">${esc(ev.from)} · ${timeOf(ev.ts)}</span>${visualEl(place, ev)}</div>`;
      case 'lesson_proposed': return `<div class="notice">${esc(ev.from)} proposed a lesson for your core profile (below)</div>`;
      case 'reminder': return `<div class="notice">${icon('clock')}Reminder set for ${esc(new Date(ev.at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}: ${esc(ev.text)}</div>`;
      case 'wake': return `<div class="notice cd-wake" title="${esc(ev.text)}">${esc(CP.wakeLine(ev))} · ${timeOf(ev.ts)}</div>`;
      default: return '';
    }
  };
  const lessons = pendingLessons(place);
  const state = c.name ? `${esc(c.state)}${c.contextPct != null ? ` · ${c.contextPct}%` : ''}` : 'asleep';
  return `<section class="hub-conductor" data-pj="${CP.CONDUCTOR}">
    <div class="hub-head cd-head"><span class="hub-k"><span class="ava${hue ? ' ring' : ''}"${hue ? ` style="--mh:${hue}"` : ''}>${robot(a, { size: 22, needs: c.waiting > 0 })}</span><b>Conductor</b></span>
      <span class="hub-line"></span><span class="hub-meta">${state}</span>${c.waiting ? `<span class="colbadge" title="${c.waiting} waiting for your call from the Conductor">${c.waiting}</span>` : ''}</div>
    ${hidden ? `<button class="more cd-earlier" data-expand="conductor-earlier">Show earlier (${hidden})</button>` : open && items.length > CP.SHOWN ? `<button class="more cd-earlier" data-expand="conductor-earlier">Show fewer</button>` : ''}
    <div class="cd-feed">${shown.map(item).join('') || `<div class="cd-empty"><p>Ask what waits for you across projects, or ask for something in another project: the Conductor passes it to that project's orchestrator.</p></div>`}</div>
    ${lessons.length ? lessonsCard(lessons) : ''}
  </section>`;
}

function hubFeed() {
  const v = hub();
  const cards = ({ p, waiting: w }) => w.approvals.map(ev => approvalCard(ev, p)).join('') + w.questions.map(ev => questionCard(ev, p)).join('')
    + (w.lessons.length ? lessonsCard(w.lessons) : '') + w.decisions.map(d => decisionCard(p, d)).join('');
  let html = conductorSection() + countBar(v.total, v.kinds);
  html += v.groups.filter(g => g.count).map(g => `<section class="hub-group" data-pj="${esc(g.name)}">${hubHead(g)}${cards(g)}</section>`).join('');
  if (!v.total) html += `<div class="hub-clear">${icon('check')}<span>Nothing waiting in any project</span></div>`;
  html += `<div class="side-label hub-roster-k">Agents · every project</div>`;
  html += v.groups.map(g => `<section class="hub-group" data-pj="${esc(g.name)}">${hubHead(g, `${g.agents.length} agent${g.agents.length === 1 ? '' : 's'} · ${g.working} working`)}
    <div class="hub-agents">${g.agents.map(a => agentRow(g.p, a)).join('') || '<p class="faint hub-none">No agents yet</p>'}</div></section>`).join('');
  return html;
}

function feedFor(t) {
  const p = proj();
  if (!p) return `<div class="empty"><h2>No projects</h2><p>Start the hub with a project folder: <code>node server.mjs C:/path/to/project</code></p></div>`;
  if (t === AP.HUB_THREAD) { const v = hub(); return v.html ??= hubFeed(); }   // drawn once per render, however many asks
  if (t === 'needs') {
    const ds = openDecisions(p), aps = pendingApprovals(p), qs = openQuestions(p);
    const withRec = ds.filter(d => d.status === 'open' && d.recommended);
    let html = '';
    if (withRec.length > 1) html += `<div class="batch"><strong>${withRec.length} decisions have a recommendation.</strong><button class="btn primary" data-take-all>${icon('check')}Take all ${withRec.length}</button><span class="faint">or reply "all but 4A"</span></div>`;
    const ls = pendingLessons(p);
    const routed = withOrchestrator(p);
    const nq = qs.reduce((n, q) => n + q.open.length, 0);
    const kinds = [['approval', aps.length, 'permission', 'permissions'], ['question', nq, 'question', 'questions'], ['lessons', ls.length ? 1 : 0, 'lesson card', 'lesson cards'], ['decision', ds.length, 'decision', 'decisions']].filter(k => k[1]);
    html = countBar(aps.length + qs.length + (ls.length ? 1 : 0) + ds.length, kinds) + html;
    html += aps.map(ev => approvalCard(ev, p)).join('') + qs.map(ev => questionCard(ev, p)).join('') + (ls.length ? lessonsCard(ls) : '') + ds.map(d => decisionCard(p, d)).join('');
    // Requests the orchestrator is answering: not yours to act on, shown so you can watch or step in.
    if (routed.length) html += `<div class="side-label routed-label">With the orchestrator</div>` + routed.map(ev => approvalCard(ev, p)).join('');
    return html || `<div class="empty"><h2>Nothing waiting on you</h2><p>Decisions, questions and permission requests from your agents show up here.</p></div>`;
  } else {
    const evs = threadEvents(p, t);
    const html = evs.map(ev => {
      switch (ev.type) {
        case 'message': return messageEl(p, ev, t);
        case 'summary': return summaryCard(p, ev);
        case 'notice': return `<div class="notice">${esc(ev.text)}</div>`;
        case 'pick': return `<div class="notice">You picked D${pad(ev.decision)} · ${esc(ev.label)}</div>`;
        case 'approval': return approvalCard(ev, p);
        case 'entry': return `<div class="notice">${esc(ev.from)} posted ${esc(ev.entryId)} to the board: ${esc(ev.title)}</div>`;
        case 'visual': return `<div class="msg"><span class="who">${esc(ev.from)} · ${timeOf(ev.ts)}</span>${visualEl(p, ev)}</div>`;
        case 'lesson': return `<div class="notice">${esc(ev.from)} added a lesson to the ${esc(ev.pack)} pack: ${esc(ev.text)}</div>`;
        case 'lesson_proposed': return `<div class="notice">${esc(ev.from)} proposed a lesson for your core profile (in Needs you)</div>`;
        case 'permission_answer': return permLine(ev);
        case 'approval_escalated': return `<div class="notice">Permission request sent to you: ${esc(ev.reason)}</div>`;
        case 'handoff_qa': return '';
        case 'project_settings': return levelUndo(p, ev);
        default: return '';
      }
    }).join('');
    if (S.seen[key(p.name, t)] !== evs.length) { S.seen[key(p.name, t)] = evs.length; store.set('seen', S.seen); }
    return html || (t === 'orchestrator'
      ? `<div class="empty"><h2>Talk to the orchestrator</h2><p>It reads the memory board, starts agents, answers their questions and brings decisions to you. Say what you want done on ${esc(p.name)}.</p></div>`
      : `<div class="empty"><p>No messages yet.</p></div>`);
  }
}

// Decision 47: the latest raise to Trusted, while the project is still Trusted, carries an Undo (back to the level it
// was raised from). The notice beside it says what changed; lowering needs only this device's cookie.
function levelUndo(p, ev) {
  if (ev.permissionMode !== 'trusted' || !ev.raised || p.permissionMode !== 'trusted') return '';
  const last = p.events.findLast(e => e.type === 'project_settings' && e.permissionMode);
  if (last !== ev) return '';
  const back = (LEVEL_INFO[ev.was] || LEVEL_INFO.auto).word;
  return `<div class="notice">Raised to Trusted at ${timeOf(ev.ts)}. Not you?<button class="btn ghost level-undo" data-level-undo="${esc(ev.id)}" title="Lower ${esc(p.name)} back to ${esc(back)}">${icon('undo')}Undo: back to ${esc(back)}</button></div>`;
}
function undoLevel(p, id, ask = true) {
  const ev = p?.events.find(e => e.id === id && e.type === 'project_settings');
  if (!ev || p.permissionMode !== 'trusted') return toast(`${p?.name || 'The project'} is not at Trusted now.`, 'info');
  const back = ['standard', 'auto'].includes(ev.was) ? ev.was : 'auto';
  return act(async () => {
    if (ask && !await hubConfirm({ k: 'Undo', title: `Lower ${p.name} back to ${LEVEL_INFO[back].word}?`, body: 'Installs and the open web come back to you; everything else stays as it is.', ok: `Back to ${LEVEL_INFO[back].word}` })) return;
    await api('/api/settings', { project: p.name, permissionMode: back });
    await load();
  });
}

// Quick replies built from what is really open (M008 9): "all" when several decisions have a recommendation,
// then each open decision's recommended pick ("42A"). A chip adds its words to the box; Enter sends.
function quickReplies(p) {
  const rec = openDecisions(p).filter(d => d.status === 'open' && d.recommended);
  return [...(rec.length > 1 ? [{ text: 'all', tip: `Take all ${rec.length} recommendations` }] : []),
    ...rec.slice(0, 6).map(d => ({ text: `${d.id}${d.recommended}`, tip: `D${pad(d.id)}: take ${d.recommended}, ${d.options.find(o => o.key === d.recommended)?.name || ''}` }))];
}
// What a column's header and message box show for thread t: title, the line under it, which buttons apply,
// whether the box is closed (a retired agent), the working line, the quick picks and the red count.
function headFor(t) {
  const p = proj();
  if (t === AP.HUB_THREAD) {   // All projects (decision 42): read from the top, red count = everything
    const v = hub(), c = S.conductor;
    const counts = `<span>${v.projects} project${v.projects === 1 ? '' : 's'} · ${v.agents} agents · ${v.working} working</span>`;
    // Decision 55: the Conductor's thread sits at the top, so the header shows it as an orchestrator's would, and the
    // message box writes to it. Without a Conductor (an older hub) the column has no box, as before.
    if (!c) return { title: 'All projects', sub: counts, retired: false, retire: false, finish: false, chips: [], activity: '', noBox: true, top: true, waiting: v.total };
    const a = CP.agentOf(c);
    const sub = `<span class="chip ${esc(a.state)}">${c.name ? `${esc(c.name)} · ` : 'Conductor · '}${esc(a.state)}</span>${c.name ? modelChip(a) : ''}${c.contextPct != null ? `<span>${c.contextPct}% context</span>` : ''}${counts}`;
    return { title: 'All projects', sub, retired: false, retire: !!c.name && !c.retiring, finish: false, chips: [], activity: c.activity || '', top: true, waiting: v.total + (c.waiting || 0) };
  }
  let title = 'Needs you', sub = '';
  if (p && t === 'orchestrator') {
    const o = orchestrator(p);
    title = 'Orchestrator';
    sub = o ? `<span class="chip ${esc(o.state)}">${esc(o.name)} · ${esc(o.state)}</span>${modelChip(o, { button: true })}${o.contextPct != null ? `<span>${o.contextPct}% context</span>` : ''}` : '<span>No one holds the role yet</span>';
  } else if (p && t !== 'needs') {
    const a = p.agents.find(a => a.thread === t);
    title = t;
    const full = S.open.has('task:' + t);
    sub = a ? `<span class="chip ${esc(a.state)}">${esc(a.state)}</span>${modelChip(a, { button: a.state !== 'retired' })}${a.contextPct != null ? `<span>${a.contextPct}% context</span>` : ''}${a.task ? `<button class="task-line ${full ? 'open' : ''}" data-expand="task:${esc(t)}" title="${full ? 'Show less' : 'Show the full task'}">${esc(full ? a.task : goalOf(a))}</button>` : ''}` : '';
  } else if (p) {
    sub = `<span>${esc(p.name)}</span>`;
  }
  const a = p?.agents.find(a => a.thread === t && a.state !== 'retired') || p?.agents.find(a => a.thread === t);
  // A retired agent's thread, or one with no agent at all (never a usable box: nobody would read it).
  const retired = !!(a && a.state === 'retired' && t !== 'orchestrator') || !!(p && !a && t !== 'needs' && t !== 'orchestrator');
  return {
    title, sub, retired,
    retire: !!(p && (t === 'orchestrator' ? orchestrator(p) : a && a.state !== 'retired' && !a.retiring)),
    finish: !!(p && t !== 'orchestrator' && t !== 'needs' && a && a.role === 'worker' && a.state !== 'retired' && !a.retiring),
    // Quick replies only where a message goes to the orchestrator.
    chips: p && !retired && (t === 'needs' || t === 'orchestrator') ? quickReplies(p) : [],
    activity: (p && S.activity[key(p.name, t === 'needs' ? 'orchestrator' : t)]) || '',
    waiting: waitingIn(p, t)
  };
}

// The board panel (M008 B): sections with counts that open and close, what waits for you open by default,
// one filter over everything. Only the section list scrolls, with a slim HUD scrollbar. Grouping is in board.js.
function renderBoard() {
  const p = proj();
  if ($('#board').hidden || !p) return;
  const filter = $('#board-filter').value;
  const view = boardView(p.board, { filter, open: S.boardOpen });
  const total = groupBoard(p.board).reduce((n, s) => n + s.items.length, 0);
  const shown = view.reduce((n, s) => n + s.items.length, 0);
  $('#board-total').textContent = filter.trim() ? `${shown} of ${total}` : `${total} item${total === 1 ? '' : 's'}`;
  const item = it => {
    if (it.type === 'decision') {
      const d = it.d, waiting = d.status === 'open' || d.status === 'found';
      const line = d.chosen ? `Picked ${esc(d.chosen)}: ${esc(d.options.find(o => o.key === d.chosen)?.name || '')}`
        : waiting ? `${d.status === 'found' ? 'Found in the code: confirm or reject' : `Open${d.recommended ? ` · recommended ${esc(d.recommended)}` : ''}`}` : esc(d.status);
      return `<button class="bitem ${waiting ? 'hot' : ''}" data-open-decision="${esc(d.id)}" title="Open this decision here">
        <span class="bid">${it.id}</span><span class="bt">${esc(it.title)}</span><span class="bs">${line}</span></button>`;
    }
    const e = it.e, k = `entry:${e.entryId}`, open = S.open.has(k);
    // A check on each active memo marks it done; a done one gets an undo icon (each asks first, see the click handler).
    const mark = canMarkDone(e) ? `<button class="bmark" data-entry-status="done" data-entry="${esc(e.entryId)}" title="Mark done" aria-label="Mark ${esc(e.entryId)} done">${icon('check')}</button>`
      : canUndoDone(e) ? `<button class="bmark" data-entry-status="active" data-entry="${esc(e.entryId)}" title="Undo: back to the active list" aria-label="Put ${esc(e.entryId)} back on the active list">${icon('undo')}</button>` : '';
    const done = e.done ? ` · done by ${esc(e.done.from)}${e.done.note ? `: ${esc(e.done.note)}` : ''}` : e.status !== 'active' ? ` · ${esc(e.status)}` : '';
    return `<div class="bitem entry ${open ? 'open' : ''} ${mark ? 'markable' : ''}"><button class="bhead" data-expand="${esc(k)}" aria-expanded="${open}">
        <span class="bid">${esc(e.entryId)}</span><span class="bt">${esc(e.title)}</span>
        <span class="bs">${esc(e.summary || '')}<span class="faint"> · ${esc(e.from)}${done}</span></span></button>${mark}
      ${open ? `<div class="bbody">${esc(e.body || '')}</div>` : ''}</div>`;
  };
  const html = view.map(s => `<section class="bsec ${s.isOpen ? 'open' : ''} ${s.hot ? 'hot' : ''}" data-sec="${s.key}">
      <button class="bsec-head" data-board-sec="${s.key}" aria-expanded="${s.isOpen}" ${filter.trim() ? 'disabled' : ''}>${icon('chevron')}<span class="bsec-k">${esc(s.label)}</span>
        <span class="bsec-n">${filter.trim() && s.items.length !== s.total ? `${s.items.length}/${s.total}` : s.total}</span></button>
      ${s.isOpen ? `${s.note ? `<p class="bsec-note faint">${esc(s.note)}</p>` : ''}<div class="bsec-items">${s.items.map(item).join('')}</div>` : ''}
    </section>`).join('');
  const empty = filter.trim() ? `<p class="board-empty faint">Nothing on the board matches “${esc(filter.trim())}”.</p>`
    : `<p class="board-empty faint">The board is empty. Decisions from Crux and entries your agents post collect here.</p>`;
  const foot = p.board.decisions.length ? `<a class="board-page" href="/p/${encodeURIComponent(p.name)}/index.html" target="_blank" rel="noopener">${icon('page')}Full Crux board for ${esc(p.name)}${icon('external')}</a>` : '';
  const out = (html || empty) + foot;
  const body = $('#board-body');
  if (body.dataset.html !== out) { body.dataset.html = out; patchKeep(body, out); }
}

function render() {
  S.hub = null;   // the state may have changed: every project's counts are worked out again, once, for this render
  // The board first: whether it is open decides the width the columns share.
  $('#app').classList.toggle('with-board', !$('#board').hidden);
  $('#open-board').classList.toggle('on', !$('#board').hidden);
  $('#board-filter').placeholder = filterHint({ narrow: phoneMq.matches });
  renderProjects(); cols.render(); renderThreads(); renderBoard(); renderModelMenu();
  // Decision 42: the strip's Needs you counter counts every project and opens All projects (more than one project).
  // The You station's popover lists every project's permission requests then (each answered by its id).
  const v = hub();
  map.retireAt = proj()?.retireAt || S.retireAt;   // decision 44 B: each project's own handoff mark
  map.update(proj(), pendingForYou(proj()), { total: v.total, projects: v.projects, approvals: v.groups.flatMap(g => g.waiting.approvals.map(ev => ({ ...ev, project: g.name }))) });
  usageUI.draw();
}

// ---------- actions ----------
async function act(fn) { try { await fn(); } catch (e) { toast(e.message); } }

// Hub-styled pop-ups (M008 3) instead of the browser's: a confirm with a way out, and a short message.
function hubConfirm({ k = 'Confirm', title, body = '', ok = 'OK' }) {
  const d = $('#confirm');
  $('#confirm-k').textContent = k; $('#confirm-title').textContent = title; $('#confirm-body').textContent = body; $('#confirm-ok').textContent = ok;
  d.returnValue = '';
  d.showModal();
  $('#confirm-ok').focus();
  return new Promise(res => d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }));
}
$('#confirm').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close('cancel'); });   // a click outside
let toastTimer;
function toast(msg, tone = 'warn') {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  el.classList.toggle('info', tone === 'info');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}
$('#toast').addEventListener('click', () => { $('#toast').hidden = true; });

// Every project switch comes through here (the project menu, a row or Open thread in All projects, a notification):
// that project's columns come back, the menus close and, on a phone, the list makes way for the conversation.
function switchProject(name) {
  if (!name || name === S.current || !S.projects.some(p => p.name === name)) return false;
  S.current = name; store.set('project', name);
  openProject();
  return true;
}
function openProject() {
  S.projMenu = false; closeHubMenu();
  cols.projectOpened(); S.mmenu = null;
  $('#app').classList.remove('show-side');
  render();
  phone.viewChanged();
  focusIfDesk(cols.kbConv()?.input);
}

// Open a thread (a row in the list, the map, a card's "Open thread", a new agent): the rule is in pins.js. With
// nothing pinned it replaces the one conversation, as always; beside pinned columns it opens a new one, up to three.
function selectThread(t) {
  cols.open(t); S.mmenu = null;
  $('#app').classList.remove('show-side');
  render();
  phone.viewChanged();
  focusIfDesk(cols.kbConv()?.input);   // on a phone, opening a thread does not pop the keyboard up
}

// A thread in a given project (a row or "Open thread" in All projects, decision 42): switch to that project the way
// the project menu does (its pins come back; All projects stays pinned everywhere), then open the thread.
function openThreadIn(p, t) {
  if (p && t !== AP.HUB_THREAD) switchProject(p.name);
  selectThread(t);
}

// Open the card a notification points at (card = "approval:<id>", "decision:<n>" or "question:<event id>").
// Waiting cards are in Needs you; one already answered is shown in its own thread instead. With columns the same
// card can be drawn twice (in Needs you and in its own thread): a column already on screen that holds it is used
// (Needs you first), so the layout does not change; otherwise Needs you (or the card's thread) opens by the usual
// rule. The lock-on goes to the copy in that one column only.
function openCard(project, card, { undo = false } = {}) {
  switchProject(project);
  const [kind, id] = [card.slice(0, card.indexOf(':')), card.slice(card.indexOf(':') + 1)];
  if (kind === 'devices') return guardUI.openDevices();   // decision 47: a change to the devices or push devices
  const p = proj();
  if (!p) return;
  // A level raised to Trusted or dropped at start, or the hub restarting (push.mjs, guard.mjs): the notice is in the
  // project's orchestrator thread. Undo on the notification lowers the level again (after a confirm).
  if (kind === 'level' || kind === 'notice') {
    $('#app').classList.remove('show-side');
    openThreadIn(p, 'orchestrator');
    if (kind === 'level' && undo) undoLevel(p, id);
    return;
  }
  const waiting = kind === 'approval' ? pendingApprovals(p).some(e => e.approval === id)
    : kind === 'decision' ? openDecisions(p).some(d => d.id === Number(id))
      : openQuestions(p).some(e => e.id === id);
  const ev = kind === 'approval' ? p.events.find(e => e.type === 'approval' && e.approval === id) : kind === 'question' ? p.events.find(e => e.id === id) : null;
  if (kind === 'approval' && ev) S.open.add(id);
  const target = waiting || !ev ? 'needs' : ev.thread;
  $('#app').classList.remove('show-side');
  render();
  const onScreen = cols.cardColumn(card, { waiting, thread: waiting ? ev?.thread : target });
  if (onScreen) { cols.focus(onScreen.thread); renderThreads(); }
  else { cols.open(target); render(); }
  phone.viewChanged();
  const conv = onScreen || cols.kbConv();
  const el = conv?.findCard(card, p.name);
  if (el) { el.scrollIntoView({ block: 'center' }); lockOn(el); }
}
// A brief cyan lock-on around a card you were sent to.
function lockOn(el) {
  el.classList.remove('flash');
  void el.offsetWidth;   // restart the animation
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2400);
}
// Phone alerts skip a card you are looking at (lib/push.mjs). With columns, "looking at" is the column that has the
// keyboard: the server takes one viewed thread, and a column you are not using may well go unread.
const phone = initPhone({ button: $('#phone-alerts'), view: () => ({ project: S.current, thread: cols.kb }), openCard, post: (path, body) => guardUI.post(path, body) });

// ---------- the columns (decision 39 A): what each conversation draws and does comes from here ----------
const cols = new Columns({
  area: $('#cols'), template: $('#conv-tpl'), winActs: $('#win-acts'), store, phoneMq, fineMq,
  host: {
    proj, render,
    startThread: () => store.get('thread', 'needs'),
    head: headFor, feed: feedFor, railItem,
    // This project's threads: columns for any other thread are dropped (columns.js prune).
    threads: () => { const p = proj(); return p ? ['needs', AP.HUB_THREAD, 'orchestrator', ...p.agents.map(a => a.thread)] : null; },
    ready: () => !!proj(),
    act,
    focusBox: focusIfDesk,
    scrolled: () => placeModelMenu(),
    // The keyboard moved to another column: the list's light follows, and the hub hears which thread you look at.
    kbChanged: () => { renderThreads(); phone.viewChanged(); },
    // Pins and columns changed: redraw; a rail click also puts the keyboard in the column it opened.
    changed: (fromRail = false) => { render(); phone.viewChanged(); if (fromRail) focusIfDesk(cols.kbConv()?.input); },
    action: (name, c) => columnAction(name, c),
    // A message from a column: its files first (images, PDFs, text), then the text. Needs you writes to the
    // orchestrator. Each file's original name goes along as display text; a pasted screenshot's "image.png" does not.
    send: async (t, text, files) => {
      // All projects' box writes to the Conductor (decision 55), in its own place.
      if (t === AP.HUB_THREAD) {
        const attachments = [];
        for (const f of files) { const name = plainName(f.name); const r = await api('/api/attach', { project: CP.CONDUCTOR, data: await asDataUrl(f), ...(name ? { name } : {}) }); attachments.push(r.name ? { id: r.id, name: r.name } : r.id); }
        return api('/api/send', { project: CP.CONDUCTOR, thread: CP.CONDUCTOR_THREAD, text, ...(attachments.length ? { attachments } : {}) });
      }
      const project = proj().name, attachments = [];
      for (const f of files) {
        const name = plainName(f.name);
        const r = await api('/api/attach', { project, data: await asDataUrl(f), ...(name ? { name } : {}) });
        attachments.push(r.name ? { id: r.id, name: r.name } : r.id);
      }
      return api('/api/send', { project, thread: t === 'needs' ? 'orchestrator' : t, text, ...(attachments.length ? { attachments } : {}) });
    },
    // After a message from Needs you the orchestrator's chat opens, as before, unless Needs you is pinned (it stays).
    sent: (c, r) => { if (r.picked) load(); else if (c.thread === 'needs' && !cols.isPinned('needs')) selectThread('orchestrator'); }
  }
});
// Does the card a phone notification points at still wait for you, in any project? (Tags are card ids.)
function cardWaiting(tag) {
  const [kind, id] = [tag.slice(0, tag.indexOf(':')), tag.slice(tag.indexOf(':') + 1)];
  return S.projects.some(p => kind === 'approval' ? pendingApprovals(p).some(e => e.approval === id)
    : kind === 'decision' ? openDecisions(p).some(d => d.id === Number(id))
      : kind === 'question' ? openQuestions(p).some(q => q.id === id) : true);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.projects.length) phone.clearSettled(cardWaiting); });

// The project menu and the model menu close on a click anywhere else, or Escape.
document.addEventListener('pointerdown', e => {
  if (S.projMenu && !e.target.closest('.proj-switch')) { S.projMenu = false; renderProjects(); }
  if (S.mmenu && !e.target.closest('#mmenu, [data-mchip]')) closeModelMenu();
  if (S.hubMenu && !e.target.closest('.hub-menu-wrap')) closeHubMenu();
});
addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (S.mmenu) return closeModelMenu();
  if (S.hubMenu) { closeHubMenu(); return $('#hub-menu-btn').focus(); }
  if (S.projMenu) { S.projMenu = false; renderProjects(); return $('[data-proj-toggle]')?.focus(); }
  if (!$('#board').hidden && !document.querySelector('dialog[open]')) setBoard(false);   // Escape closes the board too
});
addEventListener('resize', () => { placeModelMenu(); for (const c of cols.all()) c.autosize(); });

// Phones and tablets: the hub fills the visible part of the screen, so the composer stays above the keyboard
// (viewport.js). A conversation you were reading at its latest message stays there as the keyboard opens.
if (matchMedia('(pointer: coarse)').matches) new ViewportFit(document.documentElement, {
  // Follow only when the visible height or the keyboard changed; Safari nudging the view while you type does not
  // move the list (phone pass 2).
  onChange: (now, was) => {
    const c = cols.kbConv();
    if ((now.height !== was.height || now.keyboard !== was.keyboard) && c && c.atBottom && !c.top) c.feed.scrollTop = c.feed.scrollHeight;
    placeModelMenu();
  }
}).start();

// On a phone the notifications bell lives beside the hub menu above the thread list (set up once), which leaves
// the conversation header room for the thread's name. On a desk it sits with the window's buttons in the
// right-most column's header (columns.js).
function placeBell() {
  const bell = $('#phone-alerts');
  if (phoneMq.matches) $('.side-head').insertBefore(bell, $('.hub-menu-wrap'));
  else $('#win-acts').insertBefore(bell, $('#open-board'));
}
placeBell();
phoneMq.addEventListener('change', () => { placeBell(); render(); });

// A change in the model menu applies at once.
$('#mmenu').addEventListener('change', e => {
  const field = { 'mm-model': 'model', 'mm-effort': 'effort', 'mm-type': 'type' }[e.target.name];
  if (!field || !S.mmenu) return;
  const agent = S.mmenu;
  act(async () => { await api('/api/agent-settings', { project: proj().name, agent, [field]: e.target.value }); await load(); });
});
$('#hud').addEventListener('click', () => closeModelMenu(), true);   // the map opening over it
$('#mmenu').addEventListener('click', e => { if (e.target.closest('[data-mm-close]')) closeModelMenu(); });

document.addEventListener('click', e => {
  const ex = e.target.closest('[data-expand]');
  if (ex && !e.target.closest('a, [data-approve], [data-deny]')) {
    const id = ex.dataset.expand;
    S.open.has(id) ? S.open.delete(id) : S.open.add(id);
    return render();
  }
  const mc = e.target.closest('[data-mchip]');
  if (mc) { S.mmenu = S.mmenu === mc.dataset.mchip ? null : mc.dataset.mchip; cols.render(); renderModelMenu(); $('#mmenu input:checked')?.focus(); return; }
  // The pin on a thread row (decision 39): pin opens it as a column beside the current one; unpin closes its column.
  const rp = e.target.closest('[data-row-pin]');
  if (rp) { const id = rp.dataset.rowPin; cols.isPinned(id) ? cols.unpin(id) : cols.pin(id); render(); phone.viewChanged(); return document.querySelector(`[data-row-pin="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }); }
  // A thread opens in its own project: a row or "Open thread" in All projects switches to that project first.
  const t = e.target.closest('[data-thread]'); if (t) return openThreadIn(projectOf(t), t.dataset.thread);
  if (e.target.closest('[data-retired-toggle]')) { S.retiredOpen = !S.retiredOpen; store.set('retired-open', S.retiredOpen); return renderThreads(); }
  if (e.target.closest('[data-retired-older]')) { S.retiredOlder = !S.retiredOlder; return renderThreads(); }
  if (e.target.closest('[data-proj-toggle]')) { S.projMenu = !S.projMenu; return renderProjects(); }
  if (e.target.closest('[data-route-toggle]')) return toggleRouting();
  if (e.target.closest('[data-settings-open]')) { S.projMenu = false; renderProjects(); return settingsCards.openProject(proj()); }
  // A project opens on its orchestrator's chat (Matt, 2026-11-11), unless threads are pinned there: switching projects
  // never changes pins, so those columns come back as they were (columns.js).
  const pj = e.target.closest('[data-project]'); if (pj) { S.projMenu = false; S.current = pj.dataset.project; store.set('project', S.current); return openProject(); }
  // A decision on the board opens as a card here, in a HUD panel, not on another page (M008 12).
  const od = e.target.closest('[data-open-decision]');
  if (od) { const p = proj(); return openPanel(decisionCard(p, p.board.decisions.find(d => String(d.id) === od.dataset.openDecision)), `Decision ${od.dataset.openDecision}`); }
  const pick = e.target.closest('[data-pick]');
  if (pick && !pick.disabled) closePanel();
  // Every answer goes to the card's own project (projectOf): from All projects too, without switching (decision 42).
  if (pick && !pick.disabled) return act(() => api('/api/pick', { project: projectOf(pick).name, picks: [{ id: Number(pick.dataset.pick), choice: pick.dataset.choice }] }).then(load));
  if (e.target.closest('[data-take-all]')) {
    const picks = openDecisions(proj()).filter(d => d.status === 'open' && d.recommended).map(d => ({ id: d.id, choice: d.recommended }));
    return act(() => api('/api/pick', { project: proj().name, picks }).then(load));
  }
  const jump = e.target.closest('[data-jump]');
  if (jump) {
    const el = jump.closest('.feed')?.querySelector(`.card.${CSS.escape(jump.dataset.jump)}`);
    if (el) { el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); lockOn(el); }
    return;
  }
  // Mark a memo done (asks first, with a plain way out), or undo it from the Done group (no ask: undo is harmless).
  const markBtn = e.target.closest('[data-entry-status]');
  if (markBtn) {
    const id = markBtn.dataset.entry, status = markBtn.dataset.entryStatus, project = proj().name;
    return act(async () => {
      if (status === 'done' && !await hubConfirm({ k: 'Board', title: `Mark ${id} done?`, body: 'It leaves the active list and goes to Done at the bottom of the board. Nothing is deleted; you can undo it there.', ok: 'Mark done' })) return;
      await api('/api/entry-status', { project, id, status });
      await load();
    });
  }
  const bs = e.target.closest('[data-board-sec]');
  if (bs && !bs.disabled) {
    const k = bs.dataset.boardSec, def = !!SECTIONS.find(s => s.key === k)?.open;
    S.boardOpen[k] = !(S.boardOpen[k] ?? def);
    store.set('board-open', S.boardOpen);
    return renderBoard();
  }
  const dq = e.target.closest('[data-dismiss]');
  if (dq) return act(() => api('/api/dismiss', { project: projectOf(dq).name, question: dq.dataset.dismiss, ...('index' in dq.dataset ? { index: Number(dq.dataset.index) } : {}) }));
  const qq = e.target.closest('[data-quick]');
  if (qq) {
    const box = [...document.querySelectorAll('.qbox')].find(x => x.dataset.answer === qq.dataset.quick);
    if (box) { box.value = box.value === qq.dataset.word ? '' : qq.dataset.word; draftChanged(box); focusIfDesk(box); }   // a thumb on Yes needs no keyboard
    return;
  }
  const sa = e.target.closest('[data-send-answers]');
  if (sa && !sa.disabled) return sendAnswers(sa.dataset.sendAnswers, projectOf(sa));
  const ls = e.target.closest('[data-lesson]');
  if (ls) return act(() => api('/api/lessons', { project: projectOf(ls).name, ids: ls.dataset.lesson.split(','), accept: ls.dataset.accept === '1' }));
  const lu = e.target.closest('[data-level-undo]'); if (lu) return undoLevel(proj(), lu.dataset.levelUndo);
  const ap = e.target.closest('[data-approve]'); if (ap) return act(() => api('/api/approval', { id: ap.dataset.approve, allow: true, always: 'always' in ap.dataset }));
  const dn = e.target.closest('[data-deny]'); if (dn) return act(() => api('/api/approval', { id: dn.dataset.deny, allow: false }));
});

// ---------- files in the composer (decision 23) ----------
// Images, PDFs and text files: paste, drop or pick; each column keeps its own tray (conversation.js). They upload
// when you send.
const asDataUrl = f => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => fail(new Error(`Could not read ${plainName(f.name) ? `"${f.name}"` : 'the file'}.`)); r.readAsDataURL(f); });
// Drag and drop anywhere on the page: the files go to the column they are dropped on, else the keyboard column.
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
const dropTarget = e => { const c = cols.convAt(e.target) || cols.kbConv(); return c && !c.input.disabled ? c : null; };
// The drop veil shows only when the keyboard column's box can take files (not in a retired agent's thread).
addEventListener('dragenter', e => { if (!hasFiles(e) || !cols.kbConv() || cols.kbConv().input.disabled) return; e.preventDefault(); dragDepth++; $('#drop-veil').hidden = false; });
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('#drop-veil').hidden = true; } });
addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('#drop-veil').hidden = true;
  const c = dropTarget(e);
  if (c) { c.addFiles([...e.dataTransfer.files]); c.input.focus(); }
});

// ---------- the larger view: copy and download ----------
const viewer = $('#viewer');
function openViewer(src, name, cap) {
  $('#viewer-img').src = src;
  $('#viewer-img').alt = cap || '';
  $('#viewer-cap').textContent = cap || '';
  $('#viewer-save').href = src;
  $('#viewer-save').download = name || 'image';
  $('#viewer-copy').dataset.copyImg = src;
  viewer.showModal();
}
$('#viewer-close').addEventListener('click', () => viewer.close());
viewer.addEventListener('click', e => { if (e.target === viewer) viewer.close(); });   // a click on the backdrop
viewer.addEventListener('close', () => { $('#viewer-img').removeAttribute('src'); });
// The clipboard takes PNG everywhere, so other types are redrawn as PNG first. The ClipboardItem gets a promise
// so Safari keeps the click as the gesture that allowed it.
async function pngBlob(src) {
  const blob = await (await fetch(src)).blob();
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  return new Promise((ok, fail) => c.toBlob(b => b ? ok(b) : fail(new Error('Could not copy the image.')), 'image/png'));
}
async function copyImage(btn) {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('This browser cannot copy images; use download instead.');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob(btn.dataset.copyImg) })]);
    btn.classList.add('done'); btn.title = 'Copied';
    setTimeout(() => { btn.classList.remove('done'); btn.title = 'Copy image'; }, 1600);
  } catch (e) { toast(e.message || 'Could not copy the image.'); }
}
document.addEventListener('click', e => {
  const cp = e.target.closest('[data-copy-img]'); if (cp) { e.preventDefault(); return copyImage(cp); }
  const v = e.target.closest('[data-view]'); if (v) return openViewer(v.dataset.view, v.dataset.viewName, v.dataset.viewCap);
});

// (Each column's message box sends its own message: conversation.js, with host.send above.)
// Answering from the keyboard (M008 14), on a focused card: arrow keys (or J and K) move between cards in its list;
// a decision's option letter picks it, Y and N confirm or reject a found one; A allows and D denies a permission
// request; Enter goes to a question's first reply box.
$('#cols').addEventListener('keydown', e => {
  const card = e.target;
  if (!card.matches?.('.feed .card[data-card]') || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const cards = [...card.closest('.feed').querySelectorAll('.card[tabindex]')];
  const move = d => { e.preventDefault(); const next = cards[cards.indexOf(card) + d]; if (next) { next.focus(); next.scrollIntoView({ block: 'nearest' }); } };
  if (k === 'ArrowDown' || k === 'j') return move(1);
  if (k === 'ArrowUp' || k === 'k') return move(-1);
  const kind = card.dataset.card.split(':')[0];
  const press = sel => { const b = card.querySelector(sel); if (b && !b.disabled) { e.preventDefault(); b.click(); } };
  if (kind === 'decision' && /^[a-z]$/.test(k)) {
    if (card.querySelector('[data-choice="confirm"]')) return k === 'y' ? press('[data-choice="confirm"]') : k === 'n' ? press('[data-choice="reject"]') : undefined;
    return press(`.opt[data-choice="${k.toUpperCase()}"]`);
  }
  if (kind === 'approval') return k === 'a' ? press('.btn[data-approve]:not([data-always])') : k === 'd' ? press('[data-deny]') : undefined;
  if (kind === 'question' && k === 'Enter') { e.preventDefault(); card.querySelector('.qbox')?.focus(); }
});

// Reply boxes in Needs you: the same keys as the composer; Enter sends the card's filled answers together.
$('#cols').addEventListener('input', e => { if (e.target.matches('.qbox')) draftChanged(e.target); });
$('#cols').addEventListener('keydown', e => {
  if (!e.target.matches('.qbox')) return;
  const what = enterAction(e);
  if (what === 'native') return;
  e.preventDefault();
  if (what === 'newline') insertLineBreak(e.target);
  else sendAnswers(e.target.dataset.q, projectOf(e.target));
});

function toggleRouting() {
  return act(async () => {
    const on = S.settings?.routePermissions !== false;
    const { settings } = await api('/api/settings', { routePermissions: !on });
    S.settings = settings; render();
  });
}
function setBoard(open) {
  $('#board').hidden = !open;
  render();
  if (open && !matchMedia('(pointer: coarse)').matches) $('#board-filter').focus({ preventScroll: true });
  if (!open) $('#open-board').focus({ preventScroll: true });
}
$('#open-board').addEventListener('click', () => setBoard($('#board').hidden));
$('#close-board').addEventListener('click', () => setBoard(false));
$('#board-filter').addEventListener('input', () => renderBoard());
$('#board-filter').addEventListener('keydown', e => { if (e.key === 'Escape' && e.target.value) { e.stopPropagation(); e.target.value = ''; renderBoard(); } });
// A column header's own buttons (pin and close are handled by the columns): Back on a phone, Retire and Hand off
// act on that column's thread.
async function columnAction(name, c) {
  const t = c.thread;
  if (name === 'back') return $('#app').classList.add('show-side');
  if (name === 'retire-finished') {
    if (await hubConfirm({ k: 'Retire', title: `Retire ${t}?`, body: 'Use this when its job is done: it stops and moves to Retired, with no replacement.', ok: 'Retire' }))
      act(async () => { const r = await api('/api/retire-finished', { project: proj().name, agent: t }); if (!/retired\.$/.test(r.result)) toast(r.result); });
  }
  if (name === 'retire' && t === AP.HUB_THREAD) {
    if (await hubConfirm({ k: 'Hand off', title: 'Hand the Conductor role to a new agent?', body: 'The current Conductor writes a handoff first, and the new one can ask it questions before it retires.', ok: 'Hand off' }))
      act(() => api('/api/retire', { project: CP.CONDUCTOR }));
    return;
  }
  if (name === 'retire') {
    const orch = t === 'orchestrator';
    if (await hubConfirm({ k: 'Hand off', title: orch ? 'Hand the orchestrator role to a new agent?' : `Hand ${t}'s task to a fresh agent?`,
      body: `${orch ? 'The current holder' : 'It'} writes a handoff first, and the new one can ask it questions before it retires.`, ok: 'Hand off' }))
      act(() => api('/api/retire', { project: proj().name, agent: orch ? undefined : t }));
  }
}
// New agent: a type fills in its model and effort; either can then be changed.
function fillAgentPickers(model = '', effort = '') {
  $('#agent-model').innerHTML = modelPicker('model', model);
  $('#agent-effort').innerHTML = effortPicker('effort', effort, hueOf(model));
}
$('#new-agent').addEventListener('click', () => {
  $('#agent-type').innerHTML = typeOptions(proj(), '');
  $('#agent-type').closest('label').title = TYPE_TIP;
  $('#agent-type-desc').textContent = '';
  fillAgentPickers();
  $('#agent-dialog').showModal();
});
$('#agent-type').addEventListener('change', e => {
  const t = (proj()?.types || []).find(x => x.name === e.target.value);
  $('#agent-type-desc').textContent = t?.description || '';
  fillAgentPickers(t?.model || '', t?.effort || '');
});
$('#agent-model').addEventListener('change', e => {
  const eff = $('#agent-effort input:checked')?.value || '';
  $('#agent-effort').innerHTML = effortPicker('effort', eff, hueOf(e.target.value));
});
$('#agent-form').addEventListener('submit', e => {
  if (e.submitter?.value !== 'ok') return;
  const f = new FormData(e.target);
  act(async () => {
    const r = await api('/api/worker', { project: proj().name, name: f.get('name'), task: f.get('task'), type: f.get('type') || '', model: f.get('model') || '', effort: f.get('effort') || '' });
    await load(); selectThread(r.name);
  });
  e.target.reset();
});

// Decision 32: on a phone the hub opens on Needs you when something waits, else on the thread list; Back shows
// the list. A notification tap opens its card instead (openFromLocation).
const phoneStart = matchMedia('(max-width: 720px)').matches;
function startView() {
  if (!phoneStart || new URLSearchParams(location.search).has('card')) return;
  const p = proj();
  if (p && needsCount(p)) { cols.open('needs'); $('#app').classList.remove('show-side'); render(); }
  else $('#app').classList.add('show-side');
}
// ?usagepanel opens the usage panel on load (for screenshots and click-tests); ?usagepanel=session starts on the session totals.
const openUsage = new URLSearchParams(location.search).get('usagepanel');   // read first: opening a card rewrites the address
// ?settings opens the current project's settings card on load, ?settings=always with the always-to-you list open,
// ?settings=hub the Whole hub panel (decision 44 B; for screenshots and click-tests).
const openSettings = new URLSearchParams(location.search).get('settings');
load().then(() => {
  startView(); afterUpdate(); phone.openFromLocation(); phone.viewChanged(); connect(); bootReadout();
  // Decision 47: an unpaired device sees "Pair this device" once the page has drawn (it has an exit; reading works).
  guardUI.check().then(st => { if (st && !st.paired) guardUI.openPair(); });
  if (openUsage !== null) { if (openUsage === 'session') usageUI.range = 'session'; usageUI.open(); }
  if (openSettings === 'hub') settingsCards.openHub();
  else if (openSettings !== null && proj()) settingsCards.openProject(proj(), { alwaysOpen: openSettings === 'always' });
})
  .catch(() => { if (phoneStart) $('#app').classList.add('show-side'); connect(); });
