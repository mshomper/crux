// Crux hub interface: plain ES module, no build step.
import { LiveMap } from './map.js';
import { initPhone } from './phone.js';
import { EFFORTS, hueOf, modelOf, modelLabel, pips, describe } from './models.js';
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
  pending: new Set()
};

const proj = () => S.projects.find(p => p.name === S.current) || S.projects[0];
const map = new LiveMap($('#hud'), { open: t => t === 'board' ? ($('#board').hidden = false, render()) : selectThread(t) });

// ---------- data ----------
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

async function load() {
  const { projects, retireAt, models, settings } = await api('/api/state');
  map.retireAt = retireAt;
  S.settings = settings || {};
  S.models = models || [];
  S.projects = projects;
  S.pending = new Set(projects.flatMap(p => p.pendingApprovals));
  if (!proj()) return render();
  S.current = proj().name;
  render();
}

let refreshTimer;
function refreshSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(load, 250); }

function connect() {
  const es = new EventSource('/api/stream');
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
  es.onerror = () => { es.close(); setTimeout(() => { connect(); load(); }, 2000); };
}
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
// The latest summary in each thread that asked something, until someone other than the asker replies there.
function openQuestions(p) {
  const out = [];
  for (const t of new Set(p.events.map(e => e.thread).filter(Boolean))) {
    const evs = p.events.filter(e => e.thread === t);
    const lastAsk = evs.findLastIndex(e => e.type === 'summary' && e.questions?.length);
    if (lastAsk < 0) continue;
    const asker = evs[lastAsk].from;
    if (evs.slice(lastAsk + 1).some(e => e.type === 'message' && e.from !== asker)) continue; // you or the orchestrator replied
    out.push(evs[lastAsk]);
  }
  return out;
}
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
function questionCard(ev) {
  const p = proj();
  const vis = (ev.visuals || []).map(id => p.events.find(e => e.type === 'visual' && e.visual === id)).filter(Boolean);
  return `<article class="card question" data-card="question:${esc(ev.id)}">
    <div class="card-head">${icon('inbox')}<h3>${esc(ev.from)} asks</h3><span class="time">${timeOf(ev.ts)}</span></div>
    ${vis.map(v => visualEl(p, v, true)).join('')}
    <ul>${ev.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ul>
    <button class="btn" data-thread="${esc(ev.thread)}">Answer in ${ev.thread === 'orchestrator' ? 'the orchestrator thread' : esc(ev.thread)}</button>
  </article>`;
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
  $('#projects').innerHTML = `<div class="proj-switch"><div class="proj-row">${head}${modeSwitch(cur)}</div>${menu}</div>`;
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

function lastLine(p, t) {
  const ev = threadEvents(p, t).filter(e => ['message', 'summary', 'notice', 'pick'].includes(e.type)).at(-1);
  if (!ev) return '';
  if (ev.type === 'summary') return `Summary: ${(ev.done || [])[0] || ev.next_step || 'posted'}`;
  if (ev.type === 'pick') return `Picked D${pad(ev.decision)} ${ev.label}`;
  return `${ev.from === 'you' ? 'You: ' : ''}${ev.text}`;
}
function unread(p, t) { return threadEvents(p, t).length > (S.seen[key(p.name, t)] || 0); }

// An agent's icon carries a ring in its model's hue (decision 20); no ring until its model is known.
function threadButton({ id, name, ava, avaClass = '', last, right, agent = null }) {
  const hue = agent ? hueOf(modelOf(agent)) : null;
  const ring = hue ? ` ring" style="--mh:${hue}" title="${esc(describe(agent))}` : '';
  return `<button class="thread ${S.thread === id ? 'on' : ''}" data-thread="${esc(id)}">
    <span class="ava ${avaClass}${ring}">${icon(ava)}</span>
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
      <span class="oname">${esc(o.name)}${o.key === d.recommended ? `<span class="chip open">${icon('star')}recommended${d.confidence ? ' · ' + esc(d.confidence) : ''}</span>` : ''}</span>
      <span class="osum">${esc(o.summary || '')}</span>
    </button>`).join('');
  const foot = open
    ? `${d.recommended ? `<button class="btn primary" data-pick="${d.id}" data-choice="${d.recommended}">${icon('check')}Take ${esc(d.recommended)}</button>` : ''}<span class="faint">or reply "${d.id}${esc(d.recommended || 'A')}"</span>`
    : found
      ? `<button class="btn good" data-pick="${d.id}" data-choice="confirm">${icon('check')}Confirm</button><button class="btn" data-pick="${d.id}" data-choice="reject">${icon('x')}Reject</button>`
      : `<span class="chip ${esc(d.status)}">${esc(d.status)}${d.chosen ? ' · ' + esc(d.chosen) : ''}</span>`;
  return `<article class="card decision ${open || found ? '' : 'done'}" data-card="decision:${d.id}">
    <div class="card-head"><h3>D${pad(d.id)} · ${esc(d.title)}</h3><span class="chip ${esc(d.status)}">${esc(d.status)}</span></div>
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
  return `<article class="card approval ${live ? '' : 'answered'}" data-card="approval:${esc(ev.approval)}" ${live ? '' : `data-expand="${esc(ev.approval)}"`}>
    <div class="card-head">${icon('shield')}<h3>${esc(ev.agent)} wants to ${plain ? esc(plain[0].toLowerCase() + plain.slice(1)) : `use ${esc(ev.title || ev.tool)}`}</h3></div>
    ${tags ? `<div class="tags">${tags}</div>` : ''}
    ${routeNote}
    ${why ? `<p class="muted why">Why: ${esc(why)}</p>` : (!plain && ev.description ? `<p class="muted">${esc(ev.description)}</p>` : '')}
    ${plain ? `<div class="raw">${fold('cmd:' + ev.approval, raw, String(input).length > 120 || String(input).includes('\n'))}</div>` : raw}
    <div class="row">${live
      ? `<button class="btn primary" data-approve="${ev.approval}">${icon('check')}Allow</button>${ev.always ? `<button class="btn" data-approve="${ev.approval}" data-always title="Saved to this project's Claude Code settings, where you can remove it">${icon('check')}Always allow</button>` : ''}<button class="btn" data-deny="${ev.approval}">${icon('x')}Deny</button>${ev.always ? `<span class="faint always-rule">Always: ${esc(ev.always.join('; '))}</span>` : ''}`
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
  const body = you ? `<p>${esc(ev.text).replace(/\n/g, '<br>')}</p>` : md(ev.text);
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
  const inner = `${a.type ? `<span class="mtype">${esc(a.type)}</span>` : ''}<span class="mname">${esc(fam)}${ver.length ? `<span class="mver"> ${esc(ver.join(' '))}</span>` : ''}</span><span class="msep">·</span><span class="meff">${esc(eff)}</span>${pips(a.effort)}`;
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
function renderFeed() {
  const p = proj();
  const feed = $('#feed');
  if (!p) { feed.innerHTML = `<div class="empty"><h2>No projects</h2><p>Start the hub with a project folder: <code>node server.mjs C:/path/to/project</code></p></div>`; return; }
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;

  if (S.thread === 'needs') {
    const ds = openDecisions(p), aps = pendingApprovals(p), qs = openQuestions(p);
    const withRec = ds.filter(d => d.status === 'open' && d.recommended);
    let html = '';
    if (withRec.length > 1) html += `<div class="batch"><strong>${withRec.length} decisions have a recommendation.</strong><button class="btn primary" data-take-all>${icon('check')}Take all ${withRec.length}</button><span class="faint">or reply "all but 4A"</span></div>`;
    const ls = pendingLessons(p);
    const routed = withOrchestrator(p);
    html += aps.map(approvalCard).join('') + qs.map(questionCard).join('') + (ls.length ? lessonsCard(ls) : '') + ds.map(d => decisionCard(p, d)).join('');
    // Requests the orchestrator is answering: not yours to act on, shown so you can watch or step in.
    if (routed.length) html += `<div class="side-label routed-label">With the orchestrator</div>` + routed.map(approvalCard).join('');
    feed.innerHTML = html || `<div class="empty"><h2>Nothing waiting on you</h2><p>Decisions, questions and permission requests from your agents show up here.</p></div>`;
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
    feed.innerHTML = html || (S.thread === 'orchestrator'
      ? `<div class="empty"><h2>Talk to the orchestrator</h2><p>It reads the memory board, starts agents, answers their questions and brings decisions to you. Say what you want done on ${esc(p.name)}.</p></div>`
      : `<div class="empty"><p>No messages yet.</p></div>`);
    S.seen[key(p.name, S.thread)] = evs.length;
    store.set('seen', S.seen);
  }
  if (atBottom || S.justSwitched) feed.scrollTop = feed.scrollHeight;
  S.justSwitched = false;
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
  $('#input').placeholder = retired ? 'This agent has retired.' : t === 'needs' || t === 'orchestrator'
    ? `Message the orchestrator. Short replies like "all" or "4A 7B" pick decisions.`
    : `Message ${t} directly.`;
  const act = p && S.activity[key(p.name, t === 'needs' ? 'orchestrator' : t)];
  $('#activity').textContent = act || '';
  $('#activity').classList.toggle('on', !!act);
}

function renderBoard() {
  const p = proj();
  if ($('#board').hidden || !p) return;
  const ds = p.board.decisions, es = p.board.entries;
  const group = (label, items) => items.length ? `<h3>${label}</h3>${items.join('')}` : '';
  const dItem = d => `<a class="bitem" href="/p/${encodeURIComponent(p.name)}/${esc(d.page)}" target="_blank" rel="noopener">
    <div class="bt"><span>D${pad(d.id)}</span><span>${esc(d.title)}</span></div>
    <div class="bs">${d.chosen ? `Picked ${esc(d.chosen)}: ${esc(d.options.find(o => o.key === d.chosen)?.name || '')}` : esc(d.status)}</div></a>`;
  const eItem = e => `<div class="bitem"><details><summary><div class="bt"><span>${esc(e.entryId)}</span><span>${esc(e.title)}</span></div>
    <div class="bs">${esc(e.summary || '')} <span class="faint">· ${esc(e.from)}</span></div></summary><div class="bbody">${esc(e.body || '')}</div></details></div>`;
  const live = es.filter(e => e.status === 'active');
  const handoff = live.filter(e => e.kind === 'handoff').at(-1);
  $('#board-body').innerHTML = (ds.length ? `<a class="bitem board-page" href="/p/${encodeURIComponent(p.name)}/index.html" target="_blank" rel="noopener"><div class="bt"><span>${icon('page')}</span><span>Open this project's Crux board</span></div></a>` : '') +
    group('Waiting for your call', ds.filter(d => d.status === 'open' || d.status === 'found').map(dItem)) +
    group('Requirements', live.filter(e => e.kind === 'requirement').map(eItem)) +
    group('Decided', ds.filter(d => d.status === 'decided').map(dItem)) +
    group('Conventions', live.filter(e => e.kind === 'convention').map(eItem)) +
    group('Memos', live.filter(e => e.kind === 'memo').map(eItem)) +
    group('Latest handoff', handoff ? [eItem(handoff)] : []) +
    group('Parked', ds.filter(d => d.status === 'parked').map(dItem)) +
    group('History', ds.filter(d => ['superseded', 'rejected'].includes(d.status)).map(dItem)) ||
    `<p class="faint">The board is empty. Decisions from Crux and entries your agents post will collect here.</p>`;
}

function render() {
  renderProjects(); renderThreads(); renderHead(); renderFeed(); renderBoard(); renderModelMenu();
  map.update(proj(), pendingForYou(proj()));
  $('#app').classList.toggle('with-board', !$('#board').hidden);
  $('#open-board').classList.toggle('on', !$('#board').hidden);
}

// ---------- actions ----------
async function act(fn) { try { await fn(); } catch (e) { alert(e.message); } }

function selectThread(t) {
  S.thread = t; S.justSwitched = true; S.mmenu = null; store.set('thread', t);
  $('#app').classList.remove('show-side');
  render();
  phone.viewChanged();
  $('#input').focus();
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
  if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2400); }
}
const phone = initPhone({ button: $('#phone-alerts'), view: () => ({ project: S.current, thread: S.thread }), openCard });

// The project menu and the model menu close on a click anywhere else, or Escape.
document.addEventListener('pointerdown', e => {
  if (S.projMenu && !e.target.closest('.proj-switch')) { S.projMenu = false; renderProjects(); }
  if (S.mmenu && !e.target.closest('#mmenu, [data-mchip]')) closeModelMenu();
});
addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (S.mmenu) return closeModelMenu();
  if (S.projMenu) { S.projMenu = false; renderProjects(); $('[data-proj-toggle]')?.focus(); }
});
addEventListener('resize', () => { placeModelMenu(); autosize(); });
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
  if (e.target.closest('[data-mode-toggle]')) {
    const p = proj();
    return act(async () => { await api('/api/settings', { project: p.name, permissionMode: p.permissionMode === 'auto' ? 'standard' : 'auto' }); await load(); });
  }
  const pj = e.target.closest('[data-project]'); if (pj) { S.projMenu = false; S.current = pj.dataset.project; store.set('project', S.current); return selectThread('needs'); }
  const pick = e.target.closest('[data-pick]');
  if (pick && !pick.disabled) return act(() => api('/api/pick', { project: proj().name, picks: [{ id: Number(pick.dataset.pick), choice: pick.dataset.choice }] }).then(load));
  if (e.target.closest('[data-take-all]')) {
    const picks = openDecisions(proj()).filter(d => d.status === 'open' && d.recommended).map(d => ({ id: d.id, choice: d.recommended }));
    return act(() => api('/api/pick', { project: proj().name, picks }).then(load));
  }
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

$('#attach').addEventListener('click', () => $('#file-pick').click());
$('#file-pick').addEventListener('change', e => { addImages([...e.target.files]); e.target.value = ''; });
$('#tray').addEventListener('click', e => {
  const x = e.target.closest('[data-untray]'); if (!x) return;
  const [t] = tray.splice(Number(x.dataset.untray), 1);
  if (t) URL.revokeObjectURL(t.url);
  renderTray(); $('#input').focus();
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
  } catch (e) { alert(e.message || 'Could not copy the image.'); }
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
$('#input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); } });
function autosize() {
  const i = $('#input');
  i.style.height = 'auto';
  i.style.height = Math.min(i.scrollHeight + 2, 200) + 'px';
  i.style.overflowY = i.scrollHeight > 200 ? 'auto' : 'hidden';
}
$('#input').addEventListener('input', autosize);

$('#route-perms').addEventListener('click', () => act(async () => {
  const on = S.settings?.routePermissions !== false;
  const { settings } = await api('/api/settings', { routePermissions: !on });
  S.settings = settings; render();
}));
$('#open-board').addEventListener('click', () => { $('#board').hidden = !$('#board').hidden; render(); });
$('#close-board').addEventListener('click', () => { $('#board').hidden = true; render(); });
$('#back').addEventListener('click', () => $('#app').classList.add('show-side'));
$('#retire-finished').addEventListener('click', () => {
  const t = S.thread;
  if (confirm(`Retire ${t}? Use this when its job is done: it stops and moves to Retired, with no replacement.`))
    act(async () => { const r = await api('/api/retire-finished', { project: proj().name, agent: t }); if (!/retired\.$/.test(r.result)) alert(r.result); });
});
$('#retire').addEventListener('click', () => {
  const t = S.thread, orch = t === 'orchestrator';
  if (confirm(orch ? 'Hand the orchestrator role to a new agent? The current one writes a handoff first, and the new one can ask it questions before it retires.'
    : `Hand ${t}'s task to a fresh agent? It writes a handoff first, and the new one can ask it questions before it retires.`))
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

if (matchMedia('(max-width: 720px)').matches) $('#app').classList.add('show-side');
load().then(() => { phone.openFromLocation(); phone.viewChanged(); connect(); });
