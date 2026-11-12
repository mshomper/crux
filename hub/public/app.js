// Crux hub interface: plain ES module, no build step.
import { LiveMap } from './map.js';
import { initPhone } from './phone.js';
import { EFFORTS, hueOf, modelOf, modelLabel, pips, describe } from './models.js';
import { robot } from './robots.js';
import { hudBoot, openPanel, closePanel } from './hud.js';
import { openQuestions as askedOpen, pageStatus, isYesNo } from './questions.js';
import { enterAction, insertLineBreak, composerHint, replyHint, filterHint } from './composer-keys.js';
import { ViewportFit, isIOS, noFocusZoom } from './viewport.js';
import { PhoneCheck } from './debug-phone.js';

// iPhone: no automatic zoom when a box is tapped; two-finger zoom still works there (viewport.js).
{ const m = document.querySelector('meta[name="viewport"]'); m.content = noFocusZoom(m.content, isIOS(navigator.userAgent, navigator.platform, navigator.maxTouchPoints)); }
import { boardView, groupBoard, SECTIONS } from './board.js';
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
  thread: store.get('thread', 'needs'),
  seen: store.get('seen', {}),
  open: new Set(), // expanded messages, answered approvals and task lines
  activity: {},
  pending: new Set(),
  drafts: store.get('drafts', {}),   // answers typed in Needs you, by "<summary id>:<question place>"
  boardOpen: store.get('board-open', {})   // board sections you opened or closed, by key
};

const proj = () => S.projects.find(p => p.name === S.current) || S.projects[0];
// Phone width, and whether there is a mouse (no keyboard popping up when a thread opens, no focus jumps).
const phoneMq = matchMedia('(max-width: 720px)');
const fineMq = matchMedia('(pointer: fine)');
const focusIfDesk = el => { if (fineMq.matches && !phoneMq.matches) el?.focus(); };
const map = new LiveMap($('#hud'), { open: t => t === 'board' ? ($('#board').hidden = false, render()) : selectThread(t) });

// ---------- data ----------
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

async function load() {
  const { projects, retireAt, models, settings, boot, version, build } = await api('/api/state');
  // The hub now serves different page files (a restart onto new code): reload, so the new page runs (M014+).
  if (S.build && build && build !== S.build) return reloadForUpdate(version);
  S.build ||= build;
  S.version ||= version;
  S.boot = boot;
  map.retireAt = retireAt;
  S.settings = settings || {};
  S.models = models || [];
  S.projects = projects;
  S.pending = new Set(projects.flatMap(p => p.pendingApprovals));
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
    const p = S.projects.find(x => x.name === ev.project);
    if (!p) return;
    if (ev.logged) {
      p.events.push(ev);
      if (ev.type === 'approval') S.pending.add(ev.approval);
      if (ev.type === 'approval_result') S.pending.delete(ev.approval);
      // Agents write decision records straight to .decisions/; a summary is the signal to re-read the board.
      if (['agent_created', 'agent_session', 'agent_settings', 'agent_retired', 'pick', 'entry', 'summary', 'project_settings'].includes(ev.type)) refreshSoon();
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
    sessionStorage.setItem('crux-hub:resume-view', JSON.stringify({ board: !$('#board').hidden, compose: $('#input').value, filter: $('#board-filter').value }));
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
    if (view.compose) { $('#input').value = view.compose; autosize(); }
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
    : `<button class="hm-item" role="menuitem" data-restart>${icon('restart')}<span><b>Restart hub</b><span class="faint">Stops and starts the server; agents resume</span></span></button>
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
$('#hub-menu-btn').addEventListener('click', () => { S.hubMenu = S.hubMenu ? null : 'menu'; renderHubMenu(); $('#hub-menu [data-restart]')?.focus(); });
$('#hub-menu').addEventListener('click', e => {
  if (e.target.closest('[data-restart]')) { S.hubMenu = 'confirm'; renderHubMenu(); $('#hub-menu [data-restart-go]')?.focus(); }
  else if (e.target.closest('[data-restart-go]')) act(restartHub);
  else if (e.target.closest('[data-phone-check]')) { phoneCheck.toggle(); closeHubMenu(); }
  else if (e.target.closest('[data-hub-menu-close]')) closeHubMenu();
});
const key = (p, t) => `${p}::${t}`;

// ---------- helpers ----------
function openDecisions(p) { return p.board.decisions.filter(d => d.status === 'open' || d.status === 'found'); }
// Permission requests still waiting. Those with the orchestrator (decision 21) wait on it, not on you, until it
// escalates or runs out of time; you can still answer them, which overrides it.
function waitingApprovals(p) {
  const done = new Set(p.events.filter(e => e.type === 'approval_result').map(e => e.approval));
  return p.events.filter(e => e.type === 'approval' && !done.has(e.approval) && S.pending.has(e.approval));
}
function escalation(p, id) { return p.events.findLast(e => e.type === 'approval_escalated' && e.approval === id); }
function withOrchestrator(p) { return waitingApprovals(p).filter(e => e.routedTo && !escalation(p, e.approval)); }
function pendingApprovals(p) { return waitingApprovals(p).filter(e => !e.routedTo || escalation(p, e.approval)); }
function pendingForYou(p) { return new Set(p ? pendingApprovals(p).map(e => e.approval) : []); }
// Questions agents asked that still wait on you; the rule lives in questions.js, shared with the map and the server.
function openQuestions(p) { return askedOpen(p.events, { decisionStatus: pageStatus(p) }); }
// Lessons about you that an agent wants added to the core profile, until you add or skip them.
function pendingLessons(p) {
  const done = new Set(p.events.filter(e => e.type === 'lesson_result').map(e => e.lesson));
  return p.events.filter(e => e.type === 'lesson_proposed' && !done.has(e.lesson));
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
function questionCard(ev) {
  const p = proj();
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
function sendAnswers(id) {
  const p = proj(), ev = openQuestions(p).find(q => q.id === id);
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
  const ev = openQuestions(proj()).find(q => q.id === box.dataset.q);
  const btn = box.closest('.card')?.querySelector('[data-send-answers]');
  if (ev && btn) { const n = filledAnswers(ev).length; btn.disabled = !n; btn.querySelector('.qcount').textContent = sendLabel(n, ev.open.length); }
  for (const b of box.closest('.qrow')?.querySelectorAll('.qquick') || []) { const on = box.value === b.dataset.word; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
}
// A text box grows and shrinks with its text without the list moving (phone pass 2). Measuring collapses the box
// for an instant, which can pull the list's scroll position; it is put back before the screen paints. The list
// only follows when the box really changed height (a line added or removed) and you were at the latest message.
function growBox(box, max) {
  const feed = $('#feed');
  const top = feed.scrollTop, atBottom = feed.scrollHeight - top - feed.clientHeight < 2;
  const was = box.style.height;
  box.style.height = 'auto';
  const h = Math.min(box.scrollHeight + 2, max) + 'px';
  box.style.height = h;
  box.style.overflowY = box.scrollHeight > max ? 'auto' : 'hidden';
  feed.scrollTop = atBottom && h !== was && !feed.contains(box) ? feed.scrollHeight : top;
  return h !== was;
}
function threadEvents(p, t) {
  const agentThread = new Map(p.agents.map(a => [a.name, a.thread]));
  return p.events.filter(e => e.thread === t || (e.type === 'entry' && agentThread.get(e.from) === t));
}
function orchestrator(p) { return p.agents.find(a => a.role === 'orchestrator' && a.state !== 'retired'); }
function timeOf(ts) { const d = new Date(ts); return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

function md(src) {
  const blocks = String(src).split(/```/);
  return blocks.map((b, i) => {
    if (i % 2) return `<pre><code>${esc(b.replace(/^\w*\n/, ''))}</code></pre>`;
    return b.trim().split(/\n{2,}/).map(par => {
      const lines = par.split('\n');
      const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
      // A markdown table: rows of | cells |, the second row being the --- separator. Cells wrap; the table never scrolls sideways.
      if (lines.length >= 2 && lines.every(l => /^\s*\|.*\|\s*$/.test(l)) && /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[1])) {
        const cells = l => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => inline(c.trim().replace(/\\\|/g, '|')));
        const [head, , ...rows] = lines;
        return `<table class="md-table"><thead><tr>${cells(head).map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${cells(r).map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      }
      if (lines.every(l => /^\s*[-*] /.test(l))) return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`;
      if (lines.every(l => /^\s*\d+[.)] /.test(l))) return `<ol>${lines.map(l => `<li>${inline(l.replace(/^\s*\d+[.)] /, ''))}</li>`).join('')}</ol>`;
      if (/^#{1,4} /.test(par)) return `<p><strong>${inline(par.replace(/^#+ /, ''))}</strong></p>`;
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    }).join('');
  }).join('');
}

// ---------- render: sidebar ----------
// Everything in a project that waits for you: decisions, permission cards, questions, profile lessons (one card).
function needsCount(p) { return openDecisions(p).length + pendingApprovals(p).length + openQuestions(p).length + (pendingLessons(p).length ? 1 : 0); }
// The HUD frame's boot readout (decision 33), once, when the hub opens.
function bootReadout() {
  const p = proj(), live = p ? p.agents.filter(a => a.state !== 'retired') : [];
  hudBoot({ project: p?.name, agents: live.length, working: live.filter(a => ['working', 'starting'].includes(a.state)).length, waiting: p ? needsCount(p) : 0 });
}

// One row however many projects there are: the current one, a count when it needs you, a dot when another does.
function renderProjects() {
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
      <span class="pname">${esc(p.name)}</span><span class="pmode">${modeWord(p)}</span><span class="pcount ${k ? 'hot' : ''}">${k ? `${k} waiting` : 'All clear'}</span></button>`;
  }).join('')}</div>` : '';
  $('#projects').innerHTML = `<div class="proj-switch"><div class="proj-row">${head}${modeSwitch(cur)}${connSwitch(cur)}</div>${menu}</div>`;
}

// Which permission rules apply here (decision 34): Auto lets contained work run and asks only about the rest;
// Ask sends everything that is not a plain read through the orchestrator or to you.
const modeWord = p => p.permissionMode === 'auto' ? 'Auto' : 'Ask';
function modeSwitch(p) {
  const auto = p.permissionMode === 'auto';
  const tip = auto
    ? `Auto: work that stays in ${p.name} or a temp folder runs without asking. Hard stops still come to you. Click to switch to Ask.`
    : `Ask: anything beyond reading goes to the orchestrator or to you. Click to switch to Auto.`;
  return `<button class="mode-switch ${auto ? 'auto' : ''}" role="switch" aria-checked="${auto}" data-mode-toggle title="${esc(tip)}" aria-label="${esc(tip)}"><i class="mode-knob"></i>${modeWord(p)}</button>`;
}
// Your claude.ai connectors (mail, calendar, drive) for this project's agents: off unless you turn them on.
function connSwitch(p) {
  const on = !!p.connectors;
  const tip = on
    ? `Connectors on: agents in ${p.name} can see your mail, calendar and drive tools. Reads go to the orchestrator; sends, shares, changes and deletes always come to you. Click to turn them off.`
    : `Connectors off: agents in ${p.name} cannot see your mail, calendar or drive. Click to turn them on.`;
  return `<button class="mode-switch conn ${on ? 'auto' : ''}" role="switch" aria-checked="${on}" data-conn-toggle title="${esc(tip)}" aria-label="${esc(tip)}"><i class="mode-knob"></i>${icon('plug')}</button>`;
}

function lastLine(p, t) {
  const ev = threadEvents(p, t).filter(e => ['message', 'summary', 'notice', 'pick'].includes(e.type)).at(-1);
  if (!ev) return '';
  if (ev.type === 'summary') return `Summary: ${(ev.done || [])[0] || ev.next_step || 'posted'}`;
  if (ev.type === 'pick') return `Picked D${pad(ev.decision)} ${ev.label}`;
  return `${ev.from === 'you' ? 'You: ' : ''}${ev.from === 'you' ? String(ev.text || '').replace(/^> /gm, '') : ev.text}`;
}
function unread(p, t) { return threadEvents(p, t).length > (S.seen[key(p.name, t)] || 0); }

// An agent's icon carries a ring in its model's hue (decision 20); no ring until its model is known.
function threadButton({ id, name, ava, avaClass = '', last, right, agent = null }) {
  const hue = agent ? hueOf(modelOf(agent)) : null;
  const ring = hue ? ` ring" style="--mh:${hue}" title="${esc(describe(agent))}` : '';
  return `<button class="thread ${S.thread === id ? 'on' : ''}" data-thread="${esc(id)}">
    <span class="ava ${avaClass}${ring}">${agent ? robot(agent) : icon(ava)}</span>
    <span class="name">${esc(name)}</span>${right}
    <span class="last">${esc(last)}</span></button>`;
}

function renderThreads() {
  const p = proj();
  if (!p) { $('#threads').innerHTML = ''; return; }
  const needs = needsCount(p);
  const orch = orchestrator(p);
  const workers = p.agents.filter(a => a.role === 'worker');
  const active = workers.filter(a => a.state !== 'retired'), retired = workers.filter(a => a.state === 'retired');
  const dot = (a, t) => `<span class="dot ${S.thread !== t && unread(p, t) ? 'unread' : a?.state || ''}"></span>`;
  let html = threadButton({ id: 'needs', name: 'Needs you', ava: 'inbox', avaClass: needs ? 'needs' : '', last: needs ? `${needs} waiting for your call` : 'Nothing waiting', right: needs ? `<span class="badge">${needs}</span>` : '' });
  html += threadButton({ id: 'orchestrator', name: orch ? `Orchestrator · ${orch.name.replace('orchestrator-', '#')}` : 'Orchestrator', ava: 'orch', avaClass: 'orch', last: lastLine(p, 'orchestrator') || 'Starts when you send a message', right: dot(orch, 'orchestrator'), agent: orch });
  if (active.length) html += `<div class="side-label">Agents</div>` + active.map(a => threadButton({ id: a.thread, name: a.name, ava: 'agent', last: lastLine(p, a.thread) || goalOf(a), right: dot(a, a.thread), agent: a })).join('');
  if (retired.length) html += `<div class="side-label">Retired</div>` + retired.map(a => threadButton({ id: a.thread, name: a.name, ava: 'agent', avaClass: 'gone', last: lastLine(p, a.thread), right: '', agent: a })).join('');
  $('#threads').innerHTML = html;
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
    ${d.context ? `<p class="ctx">${esc(d.context)}</p>` : ''}
    ${found ? '' : `<div class="options">${opts}</div>`}
    <div class="foot">${foot}<span class="spacer"></span><a href="/p/${encodeURIComponent(p.name)}/${esc(d.page)}" target="_blank" rel="noopener" class="row">${icon('page')}Full page</a></div>
  </article>`;
}

function approvalCard(ev) {
  const live = S.pending.has(ev.approval);
  const p = proj();
  const result = p.events.find(e => e.type === 'approval_result' && e.approval === ev.approval);
  const input = ev.input?.command || ev.input?.file_path || JSON.stringify(ev.input, null, 1);
  // Plain words first: what it will do (the hub reads the command), what it touches, and the agent's own reason.
  const plain = ev.summary?.plain;
  const why = ev.input?.description && ev.input.description !== plain && !String(input).startsWith(ev.input.description.replace(/…$/, '')) ? ev.input.description : '';
  if (!live && !S.open.has(ev.approval)) {
    // Answered: one line. Click to see it again.
    const what = plain || ev.input?.description || ev.description || String(input).split('\n')[0];
    return `<button class="mini-approval" data-expand="${esc(ev.approval)}">${icon('shield')}<span class="what">${esc(ev.agent)} · ${esc(what)}</span><span class="chip">${esc(result ? result.how : 'expired')}</span></button>`;
  }
  // Why it is with you (decision 21): a hard stop the hub found, the orchestrator escalating, or no answer in time.
  const esc8 = escalation(p, ev.approval);
  const routeNote = esc8 ? `<p class="route-note">${icon('orch')}${esc8.by === 'hub' ? esc(esc8.reason) : `${esc(esc8.by)} sent it to you: ${esc(esc8.reason)}`}</p>`
    : ev.stops?.length ? `<p class="route-note stop">${icon('shield')}Always yours${ev.rules ? ` under ${esc(ev.rules)}` : ''}: ${esc(ev.stops.join('; '))}</p>`
    : ev.routedTo && live ? `<p class="route-note">${icon('orch')}With ${esc(ev.routedTo)} for now; answering it here overrides it.</p>` : '';
  const tags = (ev.summary?.tags || []).map(t => `<span class="tag ${esc(t.level)}">${esc(t.text)}</span>`).join('');
  const raw = `<pre>${esc(input)}</pre>`;
  return `<article class="card approval ${live ? '' : 'answered'}" data-card="approval:${esc(ev.approval)}" ${live ? 'tabindex="0"' : `data-expand="${esc(ev.approval)}"`}>
    <div class="card-head">${icon('shield')}<h3>${esc(ev.agent)} wants to ${plain ? esc(plain[0].toLowerCase() + plain.slice(1)) : `use ${esc(ev.title || ev.tool)}`}</h3>${live ? '<span class="keys">A allow · D deny</span>' : ''}</div>
    ${tags ? `<div class="tags">${tags}</div>` : ''}
    ${routeNote}
    ${why ? `<p class="muted why">Why: ${esc(why)}</p>` : (!plain && ev.description ? `<p class="muted">${esc(ev.description)}</p>` : '')}
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

function messageEl(p, ev) {
  const you = ev.from === 'you';
  const relay = !you && S.thread !== 'orchestrator' && /^orchestrator-/.test(ev.from);
  // Your words as typed; "> " lines (a question quoted by an answer from Needs you) show as a quote.
  const body = you ? `<p>${String(ev.text || '').split('\n').map(l => /^> /.test(l) ? `<span class="yq">${esc(l.slice(2))}</span>` : esc(l)).join('<br>').replace(/<\/span><br>/g, '</span>')}</p>` : md(ev.text);
  // A brief that started a worker says what it was started as.
  const runs = 'model' in ev || 'effort' in ev ? modelChip({ type: ev.agentType, model: ev.model, effort: ev.effort, modelSeen: S.thread !== 'orchestrator' && p.agents.find(a => a.thread === ev.thread)?.modelSeen }, { mini: true }) : '';
  const shots = ev.attachments?.length ? shotsEl(p, ev.attachments) : '';
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
function closeModelMenu() { if (!S.mmenu) return; const n = S.mmenu; S.mmenu = null; renderHead(); renderModelMenu(); document.querySelector(`[data-mchip="${CSS.escape(n)}"]`)?.focus(); }

// ---------- render: main ----------
// The list is redrawn only when what it shows changed. Live updates (an agent's activity line, its state) arrive
// many times a minute; rebuilding every message and image for each made the list jump while you typed (phone pass 2).
function setFeed(feed, html) {
  const key = `${S.current}::${S.thread}::${html}`;
  if (feed._shown === key) { delete feed.dataset.rebuilt; return false; }
  feed._shown = key;
  feed.innerHTML = html;
  feed.dataset.rebuilt = '1';
  return true;
}
function renderFeed() {
  const p = proj();
  const feed = $('#feed');
  if (!p) { setFeed(feed, `<div class="empty"><h2>No projects</h2><p>Start the hub with a project folder: <code>node server.mjs C:/path/to/project</code></p></div>`); return; }
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  // A card you are answering from the keyboard keeps its focus through the redraw (M008 14).
  const focusedCard = document.activeElement?.matches?.('#feed .card[data-card]') ? document.activeElement.dataset.card : null;
  if (focusedCard) queueMicrotask(() => [...feed.querySelectorAll('.card[data-card]')].find(c => c.dataset.card === focusedCard)?.focus({ preventScroll: true }));

  if (S.thread === 'needs') {
    // A reply box being typed in keeps its focus and cursor through the redraw.
    const typing = document.activeElement?.matches?.('.qbox') ? { k: document.activeElement.dataset.answer, a: document.activeElement.selectionStart, b: document.activeElement.selectionEnd } : null;
    queueMicrotask(() => {
      if (!feed.dataset.rebuilt) return;   // nothing was redrawn: the boxes are the same ones, untouched
      for (const box of feed.querySelectorAll('.qbox')) if (box.value) growBox(box, 140);
      const box = typing && [...feed.querySelectorAll('.qbox')].find(x => x.dataset.answer === typing.k);
      if (box) { box.focus({ preventScroll: true }); box.setSelectionRange(typing.a, typing.b); }
    });
    const ds = openDecisions(p), aps = pendingApprovals(p), qs = openQuestions(p);
    const withRec = ds.filter(d => d.status === 'open' && d.recommended);
    let html = '';
    if (withRec.length > 1) html += `<div class="batch"><strong>${withRec.length} decisions have a recommendation.</strong><button class="btn primary" data-take-all>${icon('check')}Take all ${withRec.length}</button><span class="faint">or reply "all but 4A"</span></div>`;
    const ls = pendingLessons(p);
    const routed = withOrchestrator(p);
    // The count bar (M008 1): what is waiting, by kind; each count jumps to its first card.
    const nq = qs.reduce((n, q) => n + q.open.length, 0);
    const kinds = [['approval', aps.length, 'permission', 'permissions'], ['question', nq, 'question', 'questions'], ['lessons', ls.length ? 1 : 0, 'lesson card', 'lesson cards'], ['decision', ds.length, 'decision', 'decisions']].filter(k => k[1]);
    const total = aps.length + qs.length + (ls.length ? 1 : 0) + ds.length;
    if (total) html = `<div class="countbar" role="navigation" aria-label="Waiting for you"><span class="cb-total"><b>${total}</b> waiting</span>${kinds.map(([k, n, one, many]) => `<button class="cb-chip" data-jump="${k}" title="Go to the first ${one}">${n} ${n === 1 ? one : many}</button>`).join('')}</div>` + html;
    html += aps.map(approvalCard).join('') + qs.map(questionCard).join('') + (ls.length ? lessonsCard(ls) : '') + ds.map(d => decisionCard(p, d)).join('');
    // Requests the orchestrator is answering: not yours to act on, shown so you can watch or step in.
    if (routed.length) html += `<div class="side-label routed-label">With the orchestrator</div>` + routed.map(approvalCard).join('');
    setFeed(feed, html || `<div class="empty"><h2>Nothing waiting on you</h2><p>Decisions, questions and permission requests from your agents show up here.</p></div>`);
  } else {
    const evs = threadEvents(p, S.thread);
    const html = evs.map(ev => {
      switch (ev.type) {
        case 'message': return messageEl(p, ev);
        case 'summary': return summaryCard(p, ev);
        case 'notice': return `<div class="notice">${esc(ev.text)}</div>`;
        case 'pick': return `<div class="notice">You picked D${pad(ev.decision)} · ${esc(ev.label)}</div>`;
        case 'approval': return approvalCard(ev);
        case 'entry': return `<div class="notice">${esc(ev.from)} posted ${esc(ev.entryId)} to the board: ${esc(ev.title)}</div>`;
        case 'visual': return `<div class="msg"><span class="who">${esc(ev.from)} · ${timeOf(ev.ts)}</span>${visualEl(p, ev)}</div>`;
        case 'lesson': return `<div class="notice">${esc(ev.from)} added a lesson to the ${esc(ev.pack)} pack: ${esc(ev.text)}</div>`;
        case 'lesson_proposed': return `<div class="notice">${esc(ev.from)} proposed a lesson for your core profile (in Needs you)</div>`;
        case 'permission_answer': return permLine(ev);
        case 'approval_escalated': return `<div class="notice">Permission request sent to you: ${esc(ev.reason)}</div>`;
        case 'handoff_qa': return '';
        default: return '';
      }
    }).join('');
    setFeed(feed, html || (S.thread === 'orchestrator'
      ? `<div class="empty"><h2>Talk to the orchestrator</h2><p>It reads the memory board, starts agents, answers their questions and brings decisions to you. Say what you want done on ${esc(p.name)}.</p></div>`
      : `<div class="empty"><p>No messages yet.</p></div>`));
    S.seen[key(p.name, S.thread)] = evs.length;
    store.set('seen', S.seen);
  }
  // Needs you reads from the top: it opens there and stays where you are as cards come and go (M008 1).
  // Conversations open at their latest message and follow new ones while you are at the bottom.
  if (S.thread === 'needs') { if (S.justSwitched) feed.scrollTop = 0; }
  else if (atBottom || S.justSwitched) feed.scrollTop = feed.scrollHeight;
  S.justSwitched = false;
}

// Quick replies built from what is really open (M008 9): "all" when several decisions have a recommendation,
// then each open decision's recommended pick ("42A"). A chip adds its words to the box; Enter sends.
function quickReplies(p) {
  const rec = openDecisions(p).filter(d => d.status === 'open' && d.recommended);
  return [...(rec.length > 1 ? [{ text: 'all', tip: `Take all ${rec.length} recommendations` }] : []),
    ...rec.slice(0, 6).map(d => ({ text: `${d.id}${d.recommended}`, tip: `D${pad(d.id)}: take ${d.recommended}, ${d.options.find(o => o.key === d.recommended)?.name || ''}` }))];
}
function renderQuick(p, t, retired) {
  const el = $('#quick');
  const chips = p && !retired && (t === 'needs' || t === 'orchestrator') ? quickReplies(p) : [];
  const html = chips.map(c => `<button type="button" class="qchip" data-quick-text="${esc(c.text)}" title="${esc(c.tip)}">${esc(c.text)}</button>`).join('');
  if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = chips.length ? `<span class="hud-k">Quick</span>${html}` : ''; }
  el.hidden = !chips.length;
}

function renderHead() {
  const p = proj();
  const t = S.thread;
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
  $('#thread-title').textContent = title;
  $('#thread-sub').innerHTML = sub;
  const a = p?.agents.find(a => a.thread === t && a.state !== 'retired') || p?.agents.find(a => a.thread === t);
  $('#retire').hidden = !(p && (t === 'orchestrator' ? orchestrator(p) : a && a.state !== 'retired' && !a.retiring));
  $('#retire-finished').hidden = !(p && t !== 'orchestrator' && t !== 'needs' && a && a.role === 'worker' && a.state !== 'retired' && !a.retiring);
  // The off switch for decision 21, beside the orchestrator it applies to.
  const rp = $('#route-perms'), on = S.settings?.routePermissions !== false;
  rp.hidden = !(p && t === 'orchestrator');
  rp.classList.toggle('on', on);
  rp.setAttribute('aria-pressed', String(on));
  const rules = p?.permissionRules;
  rp.title = on
    ? `The orchestrator answers workers' permission requests${rules ? ` under ${rules}` : ' (no rules on the board yet, so they all come to you)'}; hard stops still come to you. Click to answer every request yourself.`
    : 'Every permission request comes to you. Click to let the orchestrator answer them within the board\'s rules.';
  rp.setAttribute('aria-label', rp.title);
  const retired = a && a.state === 'retired' && t !== 'orchestrator';
  $('#input').disabled = !!retired;
  $('#attach').disabled = !!retired;
  // The hint fits its box on one line (M008 9, phone pass): on a phone one word, since the header says who you are
  // writing to and the quick-reply chips above the box show the short picks (composer-keys.js).
  $('#input').placeholder = composerHint({ thread: t, retired: !!retired, narrow: phoneMq.matches, fine: fineMq.matches });
  $('#board-filter').placeholder = filterHint({ narrow: phoneMq.matches });
  renderQuick(p, t, retired);
  const act = p && S.activity[key(p.name, t === 'needs' ? 'orchestrator' : t)];
  $('#activity').textContent = act || '';
  $('#activity').classList.toggle('on', !!act);
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
    return `<div class="bitem entry ${open ? 'open' : ''}"><button class="bhead" data-expand="${esc(k)}" aria-expanded="${open}">
        <span class="bid">${esc(e.entryId)}</span><span class="bt">${esc(e.title)}</span>
        <span class="bs">${esc(e.summary || '')}<span class="faint"> · ${esc(e.from)}${e.status !== 'active' ? ` · ${esc(e.status)}` : ''}</span></span></button>
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
  if (body.dataset.html !== out) { body.dataset.html = out; body.innerHTML = out; }
}

function render() {
  renderProjects(); renderThreads(); renderHead(); renderFeed(); renderBoard(); renderModelMenu();
  map.update(proj(), pendingForYou(proj()));
  $('#app').classList.toggle('with-board', !$('#board').hidden);
  $('#open-board').classList.toggle('on', !$('#board').hidden);
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

function selectThread(t) {
  S.thread = t; S.justSwitched = true; S.mmenu = null; store.set('thread', t);
  $('#app').classList.remove('show-side');
  render();
  phone.viewChanged();
  focusIfDesk($('#input'));   // on a phone, opening a thread does not pop the keyboard up
}

// Open the card a notification points at (card = "approval:<id>", "decision:<n>" or "question:<event id>").
// Waiting cards are in Needs you; one already answered is shown in its own thread instead.
function openCard(project, card) {
  if (project && S.projects.some(p => p.name === project)) { S.current = project; store.set('project', project); }
  const p = proj();
  if (!p) return;
  const [kind, id] = [card.slice(0, card.indexOf(':')), card.slice(card.indexOf(':') + 1)];
  const waiting = kind === 'approval' ? pendingApprovals(p).some(e => e.approval === id)
    : kind === 'decision' ? openDecisions(p).some(d => d.id === Number(id))
      : openQuestions(p).some(e => e.id === id);
  const ev = kind === 'approval' ? p.events.find(e => e.type === 'approval' && e.approval === id) : kind === 'question' ? p.events.find(e => e.id === id) : null;
  if (kind === 'approval' && ev) S.open.add(id);
  S.thread = waiting || !ev ? 'needs' : ev.thread;
  store.set('thread', S.thread);
  $('#app').classList.remove('show-side');
  render();
  phone.viewChanged();
  const el = [...document.querySelectorAll('[data-card]')].find(x => x.dataset.card === card);
  if (el) { el.scrollIntoView({ block: 'center' }); lockOn(el); }
}
// A brief cyan lock-on around a card you were sent to.
function lockOn(el) {
  el.classList.remove('flash');
  void el.offsetWidth;   // restart the animation
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2400);
}
const phone = initPhone({ button: $('#phone-alerts'), view: () => ({ project: S.current, thread: S.thread }), openCard });
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
addEventListener('resize', () => { placeModelMenu(); autosize(); });

// Phones and tablets: the hub fills the visible part of the screen, so the composer stays above the keyboard
// (viewport.js). A conversation you were reading at its latest message stays there as the keyboard opens.
let feedAtBottom = true;
$('#feed').addEventListener('scroll', () => { const f = $('#feed'); feedAtBottom = f.scrollHeight - f.scrollTop - f.clientHeight < 80; }, { passive: true });
if (matchMedia('(pointer: coarse)').matches) new ViewportFit(document.documentElement, {
  // Follow only when the visible height or the keyboard changed; Safari nudging the view while you type does not
  // move the list (phone pass 2).
  onChange: (now, was) => {
    if ((now.height !== was.height || now.keyboard !== was.keyboard) && feedAtBottom && S.thread !== 'needs') $('#feed').scrollTop = $('#feed').scrollHeight;
    placeModelMenu();
  }
}).start();

// On a phone the notifications bell lives beside the hub menu above the thread list (set up once), which leaves
// the conversation header room for the thread's name.
function placeBell() {
  const bell = $('#phone-alerts');
  if (phoneMq.matches) $('.side-head').insertBefore(bell, $('.hub-menu-wrap'));
  else $('.head-actions').insertBefore(bell, $('#open-board'));
}
placeBell();
phoneMq.addEventListener('change', () => { placeBell(); render(); });
$('#feed').addEventListener('scroll', () => placeModelMenu(), { passive: true });

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
  if (mc) { S.mmenu = S.mmenu === mc.dataset.mchip ? null : mc.dataset.mchip; renderHead(); renderModelMenu(); $('#mmenu input:checked')?.focus(); return; }
  const t = e.target.closest('[data-thread]'); if (t) return selectThread(t.dataset.thread);
  if (e.target.closest('[data-proj-toggle]')) { S.projMenu = !S.projMenu; return renderProjects(); }
  if (e.target.closest('[data-conn-toggle]')) {
    const p = proj();
    return act(async () => { await api('/api/settings', { project: p.name, connectors: !p.connectors }); await load(); });
  }
  if (e.target.closest('[data-mode-toggle]')) {
    const p = proj();
    return act(async () => { await api('/api/settings', { project: p.name, permissionMode: p.permissionMode === 'auto' ? 'standard' : 'auto' }); await load(); });
  }
  const pj = e.target.closest('[data-project]'); if (pj) { S.projMenu = false; S.current = pj.dataset.project; store.set('project', S.current); return selectThread('needs'); }
  // A decision on the board opens as a card here, in a HUD panel, not on another page (M008 12).
  const od = e.target.closest('[data-open-decision]');
  if (od) { const p = proj(); return openPanel(decisionCard(p, p.board.decisions.find(d => String(d.id) === od.dataset.openDecision)), `Decision ${od.dataset.openDecision}`); }
  const pick = e.target.closest('[data-pick]');
  if (pick && !pick.disabled) closePanel();
  if (pick && !pick.disabled) return act(() => api('/api/pick', { project: proj().name, picks: [{ id: Number(pick.dataset.pick), choice: pick.dataset.choice }] }).then(load));
  if (e.target.closest('[data-take-all]')) {
    const picks = openDecisions(proj()).filter(d => d.status === 'open' && d.recommended).map(d => ({ id: d.id, choice: d.recommended }));
    return act(() => api('/api/pick', { project: proj().name, picks }).then(load));
  }
  const jump = e.target.closest('[data-jump]');
  if (jump) {
    const el = document.querySelector(`#feed .card.${CSS.escape(jump.dataset.jump)}`);
    if (el) { el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); lockOn(el); }
    return;
  }
  const bs = e.target.closest('[data-board-sec]');
  if (bs && !bs.disabled) {
    const k = bs.dataset.boardSec, def = !!SECTIONS.find(s => s.key === k)?.open;
    S.boardOpen[k] = !(S.boardOpen[k] ?? def);
    store.set('board-open', S.boardOpen);
    return renderBoard();
  }
  const dq = e.target.closest('[data-dismiss]');
  if (dq) return act(() => api('/api/dismiss', { project: proj().name, question: dq.dataset.dismiss, ...('index' in dq.dataset ? { index: Number(dq.dataset.index) } : {}) }));
  const qq = e.target.closest('[data-quick]');
  if (qq) {
    const box = [...document.querySelectorAll('.qbox')].find(x => x.dataset.answer === qq.dataset.quick);
    if (box) { box.value = box.value === qq.dataset.word ? '' : qq.dataset.word; draftChanged(box); focusIfDesk(box); }   // a thumb on Yes needs no keyboard
    return;
  }
  const sa = e.target.closest('[data-send-answers]');
  if (sa && !sa.disabled) return sendAnswers(sa.dataset.sendAnswers);
  const ls = e.target.closest('[data-lesson]');
  if (ls) return act(() => api('/api/lessons', { project: proj().name, ids: ls.dataset.lesson.split(','), accept: ls.dataset.accept === '1' }));
  const ap = e.target.closest('[data-approve]'); if (ap) return act(() => api('/api/approval', { id: ap.dataset.approve, allow: true, always: 'always' in ap.dataset }));
  const dn = e.target.closest('[data-deny]'); if (dn) return act(() => api('/api/approval', { id: dn.dataset.deny, allow: false }));
});

// ---------- images in the composer (decision 23) ----------
// Paste, drop or pick; each shows as a thumbnail with a remove button. They upload when you send.
const IMG_TYPES = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP' };
const MAX_IMG = 10 * 1024 * 1024, MAX_IMGS = 6;
const tray = [];   // { file, url }
let errTimer;
function attachError(msg) {
  const el = $('#attach-error');
  el.textContent = msg; el.hidden = !msg;
  clearTimeout(errTimer);
  if (msg) errTimer = setTimeout(() => { el.hidden = true; }, 7000);
}
function renderTray(busy = false) {
  const el = $('#tray');
  el.hidden = !tray.length;
  el.innerHTML = tray.map((t, i) => `<div class="tthumb ${busy ? 'busy' : ''}"><img src="${t.url}" alt="${esc(t.file.name || 'Pasted image')}"><span class="tsize">${sizeOf(t.file.size)}</span>
    ${busy ? '' : `<button type="button" class="tx" data-untray="${i}" aria-label="Remove image" title="Remove">${icon('x')}</button>`}</div>`).join('');
}
function addImages(files) {
  const errs = [];
  for (const f of files) {
    const name = f.name && !/^image\.\w+$/.test(f.name) ? `"${f.name}"` : 'That image';
    if (!IMG_TYPES[f.type]) { errs.push(`${name} is not a PNG, JPEG, GIF or WebP image.`); continue; }
    if (f.size > MAX_IMG) { errs.push(`${name} is ${(f.size / 1048576).toFixed(1)} MB; images must be 10 MB or less.`); continue; }
    if (tray.length >= MAX_IMGS) { errs.push(`Up to ${MAX_IMGS} images per message.`); break; }
    tray.push({ file: f, url: URL.createObjectURL(f) });
  }
  attachError(errs.join(' '));
  renderTray();
}
function clearTray() { for (const t of tray.splice(0)) URL.revokeObjectURL(t.url); renderTray(); }
const asDataUrl = f => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => fail(new Error('Could not read the image.')); r.readAsDataURL(f); });

$('#quick').addEventListener('click', e => {
  const c = e.target.closest('[data-quick-text]'); if (!c) return;
  const box = $('#input'), words = box.value.trim().split(/\s+/).filter(Boolean);
  const w = c.dataset.quickText;
  box.value = (w === 'all' ? ['all'] : words.includes(w) ? words.filter(x => x !== w) : [...words.filter(x => x !== 'all'), w]).join(' ');
  autosize(); focusIfDesk(box);
});
$('#attach').addEventListener('click', () => $('#file-pick').click());
$('#file-pick').addEventListener('change', e => { addImages([...e.target.files]); e.target.value = ''; });
$('#tray').addEventListener('click', e => {
  const x = e.target.closest('[data-untray]'); if (!x) return;
  const [t] = tray.splice(Number(x.dataset.untray), 1);
  if (t) URL.revokeObjectURL(t.url);
  renderTray(); focusIfDesk($('#input'));
});
$('#input').addEventListener('paste', e => {
  if ($('#input').disabled) return;
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  if (!e.clipboardData.types.includes('text/plain')) e.preventDefault();   // a bare screenshot: no file name text
  addImages(files);
});
// Drag and drop anywhere on the page.
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', e => { if (!hasFiles(e) || $('#input').disabled) return; e.preventDefault(); dragDepth++; $('#drop-veil').hidden = false; });
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('#drop-veil').hidden = true; } });
addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('#drop-veil').hidden = true;
  if (!$('#input').disabled) { addImages([...e.dataTransfer.files]); $('#input').focus(); }
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

$('#composer').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('#input').value.trim();
  if ((!text && !tray.length) || !proj() || S.sending) return;
  const thread = S.thread === 'needs' ? 'orchestrator' : S.thread;
  const project = proj().name;
  const files = tray.map(t => t.file);
  S.sending = true;
  act(async () => {
    try {
      const attachments = [];
      if (files.length) {
        renderTray(true);
        for (const f of files) attachments.push((await api('/api/attach', { project, data: await asDataUrl(f), name: f.name })).id);
      }
      const r = await api('/api/send', { project, thread, text, ...(attachments.length ? { attachments } : {}) });
      $('#input').value = ''; autosize(); clearTray(); attachError('');
      if (r.picked) load();
      else if (S.thread === 'needs') selectThread('orchestrator');
    } catch (err) { renderTray(); throw err; }
    finally { S.sending = false; }
  });
});
// Answering from the keyboard (M008 14), on a focused card: arrow keys (or J and K) move between cards; a
// decision's option letter picks it, Y and N confirm or reject a found one; A allows and D denies a permission
// request; Enter goes to a question's first reply box.
$('#feed').addEventListener('keydown', e => {
  const card = e.target;
  if (!card.matches?.('.card[data-card]') || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const cards = [...$('#feed').querySelectorAll('.card[tabindex]')];
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
$('#feed').addEventListener('input', e => { if (e.target.matches('.qbox')) draftChanged(e.target); });
$('#feed').addEventListener('keydown', e => {
  if (!e.target.matches('.qbox')) return;
  const what = enterAction(e);
  if (what === 'native') return;
  e.preventDefault();
  if (what === 'newline') insertLineBreak(e.target);
  else sendAnswers(e.target.dataset.q);
});

// Enter sends; Alt+Enter and Shift+Enter start a new line (composer-keys.js).
$('#input').addEventListener('keydown', e => {
  const what = enterAction(e);
  if (what === 'native') return;
  e.preventDefault();
  if (what === 'newline') insertLineBreak(e.target);
  else $('#composer').requestSubmit();
});
function autosize() { growBox($('#input'), 200); }
$('#input').addEventListener('input', autosize);

$('#route-perms').addEventListener('click', () => act(async () => {
  const on = S.settings?.routePermissions !== false;
  const { settings } = await api('/api/settings', { routePermissions: !on });
  S.settings = settings; render();
}));
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
$('#back').addEventListener('click', () => $('#app').classList.add('show-side'));
$('#retire-finished').addEventListener('click', async () => {
  const t = S.thread;
  if (await hubConfirm({ k: 'Retire', title: `Retire ${t}?`, body: 'Use this when its job is done: it stops and moves to Retired, with no replacement.', ok: 'Retire' }))
    act(async () => { const r = await api('/api/retire-finished', { project: proj().name, agent: t }); if (!/retired\.$/.test(r.result)) toast(r.result); });
});
$('#retire').addEventListener('click', async () => {
  const t = S.thread, orch = t === 'orchestrator';
  if (await hubConfirm({ k: 'Hand off', title: orch ? 'Hand the orchestrator role to a new agent?' : `Hand ${t}'s task to a fresh agent?`,
    body: `${orch ? 'The current holder' : 'It'} writes a handoff first, and the new one can ask it questions before it retires.`, ok: 'Hand off' }))
    act(() => api('/api/retire', { project: proj().name, agent: orch ? undefined : t }));
});
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
  if (p && needsCount(p)) { S.thread = 'needs'; S.justSwitched = true; store.set('thread', 'needs'); $('#app').classList.remove('show-side'); render(); }
  else $('#app').classList.add('show-side');
}
load().then(() => { startView(); afterUpdate(); phone.openFromLocation(); phone.viewChanged(); connect(); bootReadout(); })
  .catch(() => { if (phoneStart) $('#app').classList.add('show-side'); connect(); });
