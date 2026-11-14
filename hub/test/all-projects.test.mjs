// All projects (decision 42 A): the cross-project feed, answering a card from another project, the hub-wide pin,
// and the map strip's counter. Neutral demo projects only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, templateFrom, FakeEl } from './fake-dom.mjs';

installDom();
const AP = await import('../public/all-projects.js');
const { Columns } = await import('../public/columns.js');
const pub = f => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const APP = pub('app.js'), HTML = pub('index.html'), MAP = pub('map.js'), CONV = pub('conversation.js'), CSS = pub('all-projects.css');

// ---------- three fake projects ----------
let n = 0;
const ev = (type, body) => ({ id: `e${++n}`, ts: new Date(2026, 10, 12, 9, n).toISOString(), type, ...body });
const agent = (name, role, state, ctx, model = 'claude-sonnet-5-5') => ({ name, role, thread: role === 'orchestrator' ? 'orchestrator' : name, state, contextPct: ctx, model, effort: 'high' });
const decision = (id, status = 'open') => ({ id, title: `Decision ${id}`, status, recommended: 'A', options: [{ key: 'A', name: 'a' }, { key: 'B', name: 'b' }], page: `${id}.html` });
function projects() {
  n = 0;
  const demo = {
    name: 'demo-app', permissionMode: 'auto',
    agents: [agent('orchestrator-3', 'orchestrator', 'working', 42, 'claude-opus-5-5'), agent('test-runner', 'worker', 'idle', 12), agent('ui-polish', 'worker', 'working', 31), agent('docs-pass', 'worker', 'idle', 27), agent('old-job', 'worker', 'retired', 70)],
    events: [
      ev('approval', { thread: 'ui-polish', approval: 'ap-1', agent: 'ui-polish', input: { command: 'git push' } }),
      ev('summary', { thread: 'docs-pass', from: 'docs-pass', questions: ['Install steps first or a tour?', 'Keep the old screenshots?'] }),
      ev('approval', { thread: 'test-runner', approval: 'ap-routed', agent: 'test-runner', routedTo: 'orchestrator-3', input: { command: 'npm test' } })
    ],
    board: { decisions: [decision(12), decision(11, 'decided')] }
  };
  const lab = {
    name: 'lab-notes', permissionMode: 'standard',
    agents: [agent('orchestrator-1', 'orchestrator', 'idle', 55, 'claude-opus-5-5'), agent('data-check', 'worker', 'idle', 22, 'claude-fable-5-2')],
    events: [ev('approval', { thread: 'data-check', approval: 'ap-2', agent: 'data-check', input: { command: 'npm install x' } }), ev('approval', { thread: 'data-check', approval: 'ap-old', agent: 'data-check', input: { command: 'ls' } }), ev('approval_result', { approval: 'ap-old' })],
    board: { decisions: [decision(12)] }   // the same number as demo-app's decision 12: a different decision
  };
  const quiet = { name: 'site-kit', permissionMode: 'auto', agents: [agent('orchestrator-2', 'orchestrator', 'asleep', 9)], events: [], board: { decisions: [] } };
  return [demo, lab, quiet];
}
const PENDING = new Set(['ap-1', 'ap-2', 'ap-routed', 'ap-old']);

test('the cross-project feed: one group per project, totals by kind, what is with the orchestrator left out', () => {
  const v = AP.hubView(projects(), PENDING);
  assert.deepEqual(v.groups.map(g => [g.name, g.count, g.mode]), [['demo-app', 3, 'Auto'], ['lab-notes', 2, 'Ask'], ['site-kit', 0, 'Auto']]);
  assert.equal(v.total, 5);
  assert.deepEqual(v.kinds.map(k => [k[0], k[1]]), [['approval', 2], ['question', 2], ['decision', 2]], 'two questions in one card count as two');
  assert.equal(v.projects, 3);
  assert.equal(v.agents, 7, 'retired agents are not in the list');
  assert.equal(v.working, 2);
  const demo = v.groups[0].waiting;
  assert.deepEqual(demo.approvals.map(e => e.approval), ['ap-1'], 'a request the orchestrator is still answering is not yours yet');
  assert.deepEqual(v.groups[1].waiting.approvals.map(e => e.approval), ['ap-2'], 'an answered request has gone');
  // the same rule as each project's own Needs you
  for (const p of projects()) assert.equal(AP.needsCount(p, PENDING), v.groups.find(g => g.name === p.name).count, p.name);
});

test('agents: the orchestrator first, then those waiting on you, then working ones, then the rest', () => {
  const [demo] = projects();
  assert.deepEqual(AP.rosterOf(demo, PENDING).map(a => a.name), ['orchestrator-3', 'ui-polish', 'docs-pass', 'test-runner']);
  assert.equal(AP.threadWaiting(demo, 'docs-pass', PENDING), 1, 'one question card, as a column\'s red count has always counted');
  assert.equal(AP.threadWaiting(demo, 'ui-polish', PENDING), 1);
  assert.equal(AP.threadWaiting(demo, 'test-runner', PENDING), 0, 'with the orchestrator, not yours');
});

test('a card answered from All projects goes to its own project, never the one on screen', () => {
  const ps = projects(), current = ps[0];
  // the column as app.js draws it: each group marked data-pj, the real card markup inside
  const feed = new FakeEl('section');
  feed.innerHTML = `<section class="hub-group" data-pj="lab-notes"><article class="card decision" data-card="decision:12" tabindex="0">
      <div class="options"><button class="opt" data-pick="12" data-choice="A"><span class="key">A</span></button></div></article>
    <article class="card question" data-card="question:e9"><textarea class="qbox" data-q="e9" data-answer="e9:0"></textarea><button class="btn primary" data-send-answers="e9">Send</button><button class="btn ghost qx" data-dismiss="e9" data-index="0">x</button></article></section>
    <section class="hub-group" data-pj="demo-app"><article class="card decision" data-card="decision:12"><button class="opt" data-pick="12" data-choice="B">B</button></article></section>`;
  const [labPick, demoPick] = feed.querySelectorAll('[data-pick]');
  assert.equal(AP.projectOf(labPick, ps, current).name, 'lab-notes', 'decision 12 of lab-notes, picked while demo-app is on screen');
  assert.equal(AP.projectOf(demoPick, ps, current).name, 'demo-app');
  for (const sel of ['.qbox', '[data-send-answers]', '[data-dismiss]']) assert.equal(AP.projectOf(feed.querySelector(sel), ps, current).name, 'lab-notes', sel);
  // anywhere else (a project's own Needs you, a thread) it is the project on screen
  const plain = new FakeEl('article'); plain.innerHTML = '<button data-pick="4" data-choice="A">A</button>';
  assert.equal(AP.projectOf(plain.querySelector('[data-pick]'), ps, current), current);
  // a group naming a project the hub no longer runs falls back to the one on screen
  const gone = new FakeEl('section'); gone.innerHTML = '<div data-pj="removed"><button data-pick="1">A</button></div>';
  assert.equal(AP.projectOf(gone.querySelector('[data-pick]'), ps, current), current);
});

test('the page sends every answer to the card\'s project', () => {
  // A pick goes through sendPicks (shown at once in every view, then sent), to the card's own project.
  assert.match(APP, /sendPicks\(projectOf\(pick\), \[/);
  assert.match(APP, /function sendPicks\(p, picks\) \{[\s\S]*?api\('\/api\/pick', \{ project: p\.name/);
  assert.match(APP, /api\('\/api\/dismiss', \{ project: projectOf\(dq\)\.name/);
  assert.match(APP, /api\('\/api\/lessons', \{ project: projectOf\(ls\)\.name/);
  // (the third argument: the Conductor's pre-fill, only for its chat copy of the card, decision 60)
  assert.match(APP, /sendAnswers\(sa\.dataset\.sendAnswers, projectOf\(sa\), chatSuggestAt\(sa, projectOf\(sa\)/);
  assert.match(APP, /sendAnswers\(e\.target\.dataset\.q, projectOf\(e\.target\), chatSuggestAt\(e\.target, projectOf\(e\.target\)/);
  assert.match(APP, /function sendAnswers\(id, p = proj\(\), suggest = null\) \{\s*const ev = openQuestions\(p\)/);
  assert.match(APP, /api\('\/api\/answer', \{ project: p\.name/);
  // permission answers go by request id, which is unique across the hub
  assert.match(APP, /api\('\/api\/approval', \{ id: ap\.dataset\.approve/);
  // cards are drawn with their own project's data, not the one on screen
  // (the cards are drawn by hubCards, shared by both layouts of the column: with and without the Conductor)
  const hub = /const hubCards = [^\n]*\n[^\n]*/.exec(APP)[0] + /function hubFeed\(\)[\s\S]*?\n\}/.exec(APP)[0];
  assert.match(hub, /approvalCard\(ev, p\)/);
  assert.match(hub, /questionCard\(ev, p\)/);
  assert.match(hub, /decisionCard\(p, d\)/);
  assert.match(hub, /data-pj="\$\{esc\(g\.name\)\}"/);
  assert.doesNotMatch(hub, /class="hub-group" data-project=/, 'data-project switches project on any click inside');
  // a decision's pictures (decision 43) come from the card's own project, so they are right in All projects too
  assert.match(/function decisionCard\([\s\S]*?\n\}/.exec(APP)[0], /picturesButton\(p\.name, d\)/);
  // .map(approvalCard) would pass the list index as the project
  assert.doesNotMatch(APP, /\.map\((approvalCard|questionCard)\)/);
});

test('a row or Open thread in All projects opens the thread in its own project', () => {
  assert.match(APP, /const t = e\.target\.closest\('\[data-thread\]'\); if \(t\) return openThreadIn\(projectOf\(t\), t\.dataset\.thread\);/);
  const fn = /function openThreadIn\([\s\S]*?\n\}/.exec(APP)[0];
  assert.match(fn, /if \(p && t !== AP\.HUB_THREAD\) switchProject\(p\.name\);/);
  assert.match(fn, /selectThread\(t\)/);
  assert.match(/function switchProject\([\s\S]*?\n\}/.exec(APP)[0], /S\.current = name; store\.set\('project', name\);\s*openProject\(\);/);
});

test('a notification finds the right project\'s copy of a card in All projects', () => {
  const feed = new FakeEl('section');
  feed.innerHTML = '<section data-pj="demo-app"><article data-card="decision:12" id-x="demo"></article></section><section data-pj="lab-notes"><article data-card="decision:12" id-x="lab"></article></section>';
  // Conversation.findCard's rule, run on the same markup
  const find = (card, project) => [...feed.querySelectorAll('[data-card]')].find(x => x.dataset.card === card && (!project || (x.closest('[data-pj]')?.dataset.pj ?? project) === project));
  assert.equal(find('decision:12', 'lab-notes').getAttribute('id-x'), 'lab');
  assert.equal(find('decision:12', 'demo-app').getAttribute('id-x'), 'demo');
  assert.match(CONV, /findCard\(card, project\) \{\s*return \[\.\.\.this\.feed\.querySelectorAll\('\[data-card\]'\)\]\.find\(x => x\.dataset\.card === card && \(!project \|\| \(x\.closest\('\[data-pj\]'\)\?\.dataset\.pj \?\? project\) === project\)\)/);
  assert.match(APP, /conv\?\.findCard\(card, p\.name\)/);
});

// ---------- the hub-wide pin, on the real Columns ----------
const TEMPLATE = templateFrom(HTML, 'conv-tpl');
function setup(stored = {}) {
  const mem = structuredClone(stored);
  const store = { get: (k, d) => k in mem ? structuredClone(mem[k]) : d, set: (k, v) => { mem[k] = structuredClone(v); } };
  const P = { 'demo-app': ['ui-polish', 'docs-pass'], 'lab-notes': ['data-check'] };
  const S = { current: 'demo-app' };
  const area = new FakeEl('div'); area._connected = true; area.clientWidth = 3000;
  const winActs = new FakeEl('span');
  let cols;
  const host = {
    proj: () => ({ name: S.current }), render: () => cols.render(), startThread: () => 'needs',
    threads: () => ['needs', 'orchestrator', ...P[S.current]],   // All projects is valid everywhere without being listed
    head: t => t === 'all' ? { title: 'All projects', sub: '', chips: [], waiting: 5, noBox: true, top: true } : { title: t, sub: '', chips: [], waiting: 0 },
    feed: t => `<p class="msg">${t}</p>`, railItem: t => `<button data-rail="${t}"></button>`,
    ready: () => true, act: fn => fn(), send: async () => ({}), sent() { }, focusBox() { }, scrolled() { }, kbChanged() { }, changed: () => cols.render(), action() { }
  };
  cols = new Columns({ area, template: TEMPLATE, winActs, host, store, phoneMq: { matches: false, addEventListener() { } }, fineMq: { matches: true } });
  const shown = () => area.children.filter(e => e.classList.contains('conv')).map(e => e.dataset.col);
  const go = p => { S.current = p; cols.projectOpened(); cols.render(); };
  return { cols, mem, S, shown, go };
}

test('All projects pinned in one project stays pinned in every project; unpinned anywhere, gone everywhere', () => {
  const h = setup();
  h.cols.render();
  h.cols.open('ui-polish'); h.cols.pin('all'); h.cols.render();
  assert.deepEqual(h.shown(), ['ui-polish', 'all']);
  assert.equal(h.mem['hub-pinned'], true);
  h.go('lab-notes');
  assert.deepEqual(h.shown(), ['orchestrator', 'all'], 'there too, beside that project\'s orchestrator');
  assert.equal(h.cols.isPinned('all'), true);
  h.cols.unpin('all'); h.cols.render();
  assert.deepEqual(h.shown(), ['orchestrator']);
  assert.equal(h.mem['hub-pinned'], false);
  h.go('demo-app');
  assert.deepEqual(h.shown(), ['orchestrator'], 'unpinned in lab-notes, so gone in demo-app too; with nothing pinned it opens on its orchestrator');
  assert.equal(h.cols.isPinned('all'), false);
});

test('catching up the hub-wide pin never unpins or closes another project\'s columns: the extra folds to the rail', () => {
  const three = { cols: [{ t: 'orchestrator', pinned: true }, { t: 'data-check', pinned: true }, { t: 'needs', pinned: true }], kb: 'data-check', recent: ['data-check', 'orchestrator', 'needs'] };
  const h = setup({ columns: { 'lab-notes': three } });
  h.cols.render();
  h.cols.pin('all'); h.cols.render();
  h.go('lab-notes');
  const s = h.mem.columns['lab-notes'];
  assert.deepEqual(s.cols.filter(c => c.pinned).map(c => c.t).sort(), ['all', 'data-check', 'needs', 'orchestrator'], 'all four pinned, none lost');
  assert.equal(s.kb, 'data-check', 'the keyboard stays where it was');
  assert.equal(h.shown().length, 3, 'three columns fit');
  assert.ok(h.shown().includes('all') && h.shown().includes('data-check'));
  const rail = h.cols.rail.isConnected !== false && h.cols.area.children.includes(h.cols.rail);
  assert.ok(rail, 'the least recently used column waits on the rail');
  // stored and read back (a reload), the fourth column is kept, not cut at three
  const again = setup({ columns: h.mem.columns, 'hub-pinned': true });
  again.S.current = 'lab-notes'; again.cols.render();
  assert.equal(again.mem.columns['lab-notes'].cols.length, 4);
  // unpinning All projects there closes only its own column
  again.cols.unpin('all'); again.cols.render();
  assert.deepEqual(again.mem.columns['lab-notes'].cols.map(c => [c.t, c.pinned]), [['orchestrator', true], ['data-check', true], ['needs', true]]);
});

test('the pin rules with the extra thread', async () => {
  const P = await import('../public/pins.js');
  const pinned = t => ({ t, pinned: true }), X = { extra: 'all' };
  const s3 = { cols: [pinned('a'), pinned('b'), pinned('c')], kb: 'b', recent: ['b', 'a', 'c'] };
  const s4 = P.pin(s3, 'all', X);
  assert.deepEqual(s4.cols.map(c => c.t), ['a', 'b', 'all', 'c'], 'beside the keyboard column, nothing removed');
  assert.ok(s4.cols.every(c => c.pinned));
  assert.equal(s4.kb, 'b');
  // without the option the old rule still applies (the keyboard column gives up its place)
  assert.equal(P.pin(s3, 'all').cols.length, 3);
  // a fourth own thread opened with All projects there: the keyboard column is replaced as before (R010), never All projects
  const kbAll = { ...s4, kb: 'all', recent: ['all', 'b', 'a', 'c'] };
  const opened = P.open(kbAll, 'd', 3, X);
  assert.ok(opened.cols.some(c => c.t === 'all' && c.pinned), 'All projects keeps its pin');
  assert.equal(opened.cols.length, 4);
  assert.ok(!opened.cols.some(c => c.t === 'b'), 'the most recently used other column gave up its place');
  // normalize keeps three plus All projects; prune keeps it too
  assert.equal(P.normalize(s4, 'needs', X).cols.length, 4);
  assert.equal(P.normalize(s4).cols.length, 3, 'without the option, three as before');
  assert.equal(P.prune({ ...s4, cols: [...s4.cols, pinned('gone')] }, new Set(['a', 'b', 'c', 'all']), 'needs', X).cols.length, 4);
  // three fit and the fourth folds
  assert.equal(P.fit(3000, 4), 3);
  assert.equal(P.layout(s4, 3).folded.length, 1);
});

test('phone alerts: All projects with the keyboard counts as looking at every project', async () => {
  const { isLooking } = await import('../lib/push.mjs');
  const now = 1e9, card = { project: 'lab-notes', thread: 'data-check', card: 'approval:ap-2' };
  const look = (thread, extra = {}) => isLooking(card, [{ project: 'demo-app', thread, visible: true, focused: true, idleMs: 0, ts: now, ...extra }], now);
  assert.equal(look('all'), true, 'the card is on screen in All projects, from another project');
  assert.equal(look('needs'), false, 'another project\'s Needs you does not show it');
  assert.equal(look('all', { focused: false }), false, 'a page in the background is not looking');
  assert.equal(look('all', { idleMs: 3 * 60 * 1000 }), false, 'walked away');
  assert.match(APP, /view: \(\) => \(\{ project: S\.current, thread: cols\.kb \}\)/, 'the page reports the keyboard column, All projects included');
});

test('every project\'s counts are worked out once per render and shared', () => {
  assert.equal(APP.split('AP.hubView(').length, 2, 'one place builds the hub view');
  assert.match(APP, /const hub = \(\) => S\.hub \|\| \(S\.hub = AP\.hubView\(S\.projects, S\.pending\)\);/);
  assert.match(APP, /function render\(\) \{\s*S\.hub = null;/);
  assert.match(APP, /const needsCount = p => hub\(\)\.groups\.find\(g => g\.p === p\)\?\.count/);
  assert.match(APP, /return v\.html \?\?= hubFeed\(\);/, 'the column is drawn once per render');
  for (const at of [/S\.pending = new Set\([^\n]*\n\s*S\.hub = null;/, /if \(!p\) return;\s*S\.hub = null;/]) assert.match(APP, at, 'a state change starts it afresh');
});

test('the You station matches the counter: the hub total, its link opening All projects', () => {
  const NEEDS = pub('map-needs.js');
  assert.match(MAP, /const you = this\.multi \? this\.hub\.total : needs;/);
  assert.match(MAP, /thread: this\.multi \? 'all' : 'needs'/);
  assert.match(MAP, /this\.needsPop\.set\(project, pending, needs, this\.multi \? \{ approvals: this\.hub\.approvals \|\| \[\], total: this\.hub\.total \} : null\)/);
  assert.match(NEEDS, /this\.openThread\(this\.multi \? 'all' : 'needs'\)/);
  assert.match(NEEDS, /const approvals = hub \? hub\.approvals :/);
  assert.match(NEEDS, /in \$\{this\.multi \? 'All projects' : 'Needs you'\}/);
  assert.match(APP, /approvals: v\.groups\.flatMap\(g => g\.waiting\.approvals\.map\(ev => \(\{ \.\.\.ev, project: g\.name \}\)\)\)/);
});

test('switching project from All projects or a notification goes through openProject', () => {
  const sw = /function switchProject\([\s\S]*?\n\}/.exec(APP)[0];
  assert.match(sw, /openProject\(\);/);
  assert.match(/function openThreadIn\([\s\S]*?\n\}/.exec(APP)[0], /switchProject\(p\.name\)/);
  assert.match(/function openCard\([\s\S]*?\n\}/.exec(APP)[0], /^function openCard\(project, card(, [^)]*)?\) \{\s*switchProject\(project\);/);
  const op = /function openProject\(\) \{[\s\S]*?\n\}/.exec(APP)[0];
  assert.match(op, /S\.projMenu = false; closeHubMenu\(\);/, 'menus close');
  assert.match(op, /classList\.remove\('show-side'\)/, 'the phone list makes way');
});

test('All projects has no message box and reads from the top; it is never pruned as a stale thread', () => {
  const h = setup({ columns: { 'demo-app': { cols: [{ t: 'all', pinned: true }, { t: 'docs-pass', pinned: false }], kb: 'all', recent: ['all', 'docs-pass'] } }, 'hub-pinned': true });
  h.cols.render();
  assert.deepEqual(h.shown(), ['all', 'docs-pass']);
  const c = h.cols.visible('all');
  assert.equal(c.form.hidden, true, 'no one to write to');
  assert.equal(c.input.disabled, true, 'drops and pastes never attach to the hidden box');
  assert.equal(c.attachBtn.disabled, true);
  assert.match(APP, /const focusIfDesk = el => \{ if \(fineMq\.matches && !phoneMq\.matches && el && !el\.disabled && !el\.closest\('\[hidden\]'\)\) el\.focus\(\); \};/, 'a hidden box is never focused');
  assert.match(APP, /const dropTarget = e => \{ const c = cols\.convAt\(e\.target\) \|\| cols\.kbConv\(\); return c && !c\.input\.disabled \? c : null; \};/);
  assert.equal(c.activity.hidden, true);
  assert.equal(c.top, true);
  assert.equal(h.cols.visible('docs-pass').form.hidden, false);
  assert.equal(c.badge.hidden, false, 'its red count beside other columns');
  assert.equal(c.badge.textContent, '5');
});

test('the page: the hub-wide row, the renamed roll-up link, the map counter', () => {
  assert.match(HTML, /<nav id="hub-threads" class="hub-threads" aria-label="Every project" hidden><\/nav>\s*<nav id="projects"/, 'above the project switcher');
  assert.match(HTML, /id="all-projects"[^>]*>.*All decisions/, 'the roll-up page is All decisions now');
  assert.doesNotMatch(HTML, />All projects</);
  assert.match(HTML, /<link rel="stylesheet" href="all-projects\.css">/);
  const row = /function renderHubThreads\(\)[\s\S]*?\n\}/.exec(APP)[0];
  assert.match(row, /el\.hidden = n < 2/, 'only when the hub runs more than one project');
  assert.match(row, /id: AP\.HUB_THREAD, name: 'All projects'/);
  // the strip's counter: the hub total, opening All projects
  // (decision 57 C: the total also counts what the Conductor waits on, as the All projects row does)
  assert.match(APP, /map\.update\(proj\(\), pendingForYou\(proj\(\)\), \{\s*total: v\.total \+ \(c\?\.waiting \|\| 0\), projects: v\.projects, approvals:/);
  assert.match(MAP, /if \(e\.target\.closest\('\[data-needs\]'\)\) return this\.go\(this\.multi \? 'all' : 'needs'\);/);
  assert.match(MAP, /const multi = this\.multi, count = multi \? this\.hub\.total : needs;/);
  // phone: still opens on the project's Needs you (decision 32)
  assert.match(APP, /if \(p && needsCount\(p\)\) \{ cols\.open\('needs'\);/);
});

test('the context ring: model hue, the hand-off mark on the orchestrator only, gold over the last stretch', () => {
  const w = AP.contextRing({ role: 'worker', contextPct: 31 }, { hue: '#38d9ec', retireAt: 60 });
  assert.match(w, /stroke="#38d9ec"/);
  assert.doesNotMatch(w, /class="tick"/);
  assert.match(w, /<title>31% of context used<\/title>/);
  const o = AP.contextRing({ role: 'orchestrator', contextPct: 42 }, { hue: '#b47cff', retireAt: 60 });
  assert.match(o, /class="tick"/);
  assert.match(o, /hands off at 60%/);
  assert.doesNotMatch(o, /near/);
  const due = AP.contextRing({ role: 'orchestrator', contextPct: 55 }, { hue: '#b47cff', retireAt: 60 });
  assert.match(due, /ctx-ring near/);
  assert.match(due, /stroke="#f5c96a"/);
  const none = AP.contextRing({ role: 'worker', contextPct: null }, { hue: '#38d9ec' });
  assert.doesNotMatch(none, /class="arc"/);
  assert.match(none, /Context not reported yet/);
});

test('house rules in the styles: red only for your call, no sideways scroll, one line per agent', () => {
  const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of noComments.split('}')) {
    if (/hud-red|--bad|242,114,122/.test(rule)) assert.match(rule.slice(0, rule.indexOf('{')), /\.asks/, `red outside a waiting-on-you mark: ${rule.trim().slice(0, 80)}`);
  }
  assert.doesNotMatch(noComments, /overflow-x:\s*(auto|scroll)/);
  assert.match(noComments, /\.ha-l2\{[^}]*white-space:nowrap;overflow:hidden;text-overflow:ellipsis/);
  assert.match(noComments, /@media \(max-width:720px\)\{[\s\S]*\.hub-agent\{min-height:56px/);
});

