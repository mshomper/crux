// Pinned threads (decision 39 A): Columns and Conversation run for real on a small stand-in page (fake-dom.mjs),
// with the page's own conversation template. The rules themselves are tested in pins.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, templateFrom, FakeEl } from './fake-dom.mjs';

installDom();
const { Columns } = await import('../public/columns.js');
const TEMPLATE = templateFrom(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), 'conv-tpl');

const pin = t => ({ t, pinned: true }), loose = t => ({ t, pinned: false });
const card = id => `<article class="card approval" data-card="${id}" tabindex="0"><div class="card-head"><h3>x</h3></div></article>`;

// A hub with two projects. trail has three workers (gpx-import retired); other has one.
function setup({ width = 3000, stored = {}, current = 'trail' } = {}) {
  const mem = structuredClone(stored);
  const store = { get: (k, d) => k in mem ? structuredClone(mem[k]) : d, set: (k, v) => { mem[k] = structuredClone(v); } };
  const P = { trail: { name: 'trail', agents: ['route-finder', 'offline-maps', 'elevation-chart', 'gpx-import'] }, other: { name: 'other', agents: ['indexer'] } };
  const S = { current, cards: {} };
  const log = { sends: [], acts: [] };
  const area = new FakeEl('div'); area._connected = true; area.clientWidth = width;
  const winActs = new FakeEl('span'); winActs.className = 'win-acts';
  let cols;
  const host = {
    proj: () => P[S.current], render: () => cols.render(),
    startThread: () => store.get('thread', 'needs'),
    threads: () => ['needs', 'orchestrator', ...P[S.current].agents],
    head: t => ({ title: t, sub: '', chips: [], waiting: 0, retired: t === 'gpx-import' }),
    feed: t => S.cards[t] || `<p class="msg">${t}</p>`,
    railItem: (t, instead, pinned) => `<button class="rail-item" data-rail="${t}" title="${t}: ${pinned ? 'pinned' : 'open, not pinned'}, folded"></button>`,
    ready: () => true,
    act: fn => { const p = fn(); log.acts.push(p); return p; },
    send: (t, text, files) => new Promise(ok => log.sends.push({ t, text, files: files.length, ok })),
    sent: () => { }, focusBox: () => { }, scrolled: () => { }, kbChanged: () => { }, changed: () => cols.render(), action: () => { }
  };
  cols = new Columns({ area, template: TEMPLATE, winActs, host, store, phoneMq: { matches: false, addEventListener() { } }, fineMq: { matches: true } });
  return { cols, area, mem, S, log, P };
}
const shown = area => area.children.filter(e => e.classList.contains('conv')).map(e => e.dataset.col);
const typeInto = (conv, text) => { conv.input.value = text; conv.input.dispatchEvent({ type: 'input' }); };

test('switching projects never changes pins; a project with nothing pinned opens on its orchestrator', () => {
  const three = { cols: [pin('orchestrator'), pin('route-finder'), pin('offline-maps')], kb: 'route-finder', recent: ['route-finder', 'orchestrator', 'offline-maps'] };
  const h = setup({ stored: { columns: { trail: three, other: { cols: [loose('indexer')], kb: 'indexer', recent: ['indexer'] } } } });
  h.cols.render();
  assert.deepEqual(shown(h.area), ['orchestrator', 'route-finder', 'offline-maps']);
  // to the other project: nothing pinned there, so its orchestrator opens in the one column
  h.S.current = 'other'; h.cols.projectOpened(); h.cols.render();
  assert.deepEqual(shown(h.area), ['orchestrator']);
  assert.equal(h.cols.kb, 'orchestrator');
  // and back: all three columns as they were, keyboard where it was, nothing unpinned
  h.S.current = 'trail'; h.cols.projectOpened(); h.cols.render();
  assert.deepEqual(shown(h.area), ['orchestrator', 'route-finder', 'offline-maps']);
  assert.deepEqual(h.mem.columns.trail, three, 'the stored pins are untouched');
  assert.equal(h.cols.kb, 'route-finder');
  // whereas opening a fourth thread at the limit does replace the keyboard column (R008), as decided
  h.cols.open('elevation-chart'); h.cols.render();
  assert.deepEqual(shown(h.area), ['orchestrator', 'elevation-chart', 'offline-maps']);
});

test('stale pins are dropped when the project is drawn, and the cleaned list is written back', () => {
  const h = setup({ stored: { columns: { trail: { cols: [pin('orchestrator'), pin('ghost'), pin('indexer')], kb: 'ghost', recent: ['ghost', 'indexer', 'orchestrator'] } } } });
  h.cols.render();
  assert.deepEqual(shown(h.area), ['orchestrator'], 'a removed agent and another project\'s thread are gone');
  assert.deepEqual(h.mem.columns.trail.cols, [pin('orchestrator')]);
  assert.equal(h.mem.columns.trail.kb, 'orchestrator');
  // a retired agent's pin stays, with its box closed
  const r = setup({ stored: { columns: { trail: { cols: [pin('gpx-import'), pin('route-finder')], kb: 'route-finder' } } } });
  r.cols.render();
  assert.deepEqual(shown(r.area), ['gpx-import', 'route-finder']);
  assert.equal(r.cols.visible('gpx-import').input.disabled, true);
  assert.equal(r.cols.visible('route-finder').input.disabled, false);
});

test('the shared start-thread key never brings one project\'s thread into another', () => {
  // the last thread used anywhere was "indexer" in the other project; trail has never been opened on this device
  const h = setup({ stored: { thread: 'indexer' } });
  h.cols.render();
  assert.deepEqual(shown(h.area), ['needs']);
  assert.deepEqual(h.mem.columns.trail.cols, [loose('needs')]);
  // in its own project it is used as before
  const o = setup({ stored: { thread: 'indexer' }, current: 'other' });
  o.cols.render();
  assert.deepEqual(shown(o.area), ['indexer']);
});

test('two columns never share typed text, images or the sending flag', async () => {
  const h = setup({ stored: { columns: { trail: { cols: [pin('route-finder'), loose('offline-maps')], kb: 'route-finder' } } } });
  h.cols.render();
  const rf = h.cols.visible('route-finder'), om = h.cols.visible('offline-maps');
  assert.notEqual(rf, om);
  typeInto(rf, 'for route-finder');
  assert.equal(om.input.value, '');
  rf.addImages([new File(['png'], 'loop.png', { type: 'image/png' })]);
  assert.equal(rf.compose.tray.length, 1);
  assert.equal(om.compose.tray.length, 0);
  assert.equal(om.trayEl.hidden, true);
  // one column sending does not hold up the other
  rf.submit();
  assert.equal(rf.sending, true);
  assert.equal(om.sending, false);
  typeInto(om, 'for offline-maps');
  om.submit();
  assert.deepEqual(h.log.sends.map(s => [s.t, s.text, s.files]), [['route-finder', 'for route-finder', 1], ['offline-maps', 'for offline-maps', 0]]);
  for (const s of h.log.sends) s.ok({});
  await Promise.all(h.log.acts);
  assert.deepEqual([rf.sending, om.sending, rf.input.value, om.input.value, rf.compose.tray.length], [false, false, '', '', 0]);
  // a draft stays with its thread when its column changes thread and back
  typeInto(om, 'half a thought');
  h.cols.open('elevation-chart'); h.cols.render();
  assert.equal(h.cols.visible('elevation-chart').input.value, '');
  h.cols.open('offline-maps'); h.cols.render();
  assert.equal(h.cols.visible('offline-maps').input.value, 'half a thought');
});

test('a notification card drawn in two columns: Needs you\'s copy for a waiting card, the thread\'s once settled', () => {
  const h = setup({ stored: { columns: { trail: { cols: [pin('needs'), pin('offline-maps')], kb: 'offline-maps' } } } });
  h.S.cards = { needs: card('approval:a1'), 'offline-maps': card('approval:a1') };
  h.cols.render();
  assert.equal(h.cols.cardColumn('approval:a1', { waiting: true, thread: 'offline-maps' }), h.cols.visible('needs'));
  assert.equal(h.cols.cardColumn('approval:a1', { waiting: false, thread: 'offline-maps' }), h.cols.visible('offline-maps'));
  assert.equal(h.cols.cardColumn('approval:zz', { waiting: true, thread: 'offline-maps' }), null, 'not on screen: the page opens Needs you by the usual rule');
  // Needs you folded for lack of room: the copy on screen in the thread's column is used
  h.area.clientWidth = 700; h.cols.render();
  assert.deepEqual(shown(h.area), ['offline-maps']);
  assert.equal(h.cols.cardColumn('approval:a1', { waiting: true, thread: 'offline-maps' }), h.cols.visible('offline-maps'));
});

test('a click on a thread already on screen gives it the keyboard and goes to its latest message', () => {
  const h = setup({ stored: { columns: { trail: { cols: [pin('orchestrator'), pin('route-finder')], kb: 'orchestrator' } } } });
  h.cols.render();
  const rf = h.cols.visible('route-finder');
  rf.feed.scrollHeight = 900; rf.feed.clientHeight = 300; rf.feed.scrollTop = 100;   // scrolled up, reading
  h.cols.open('route-finder'); h.cols.render();
  assert.equal(h.cols.kb, 'route-finder');
  assert.equal(rf.feed.scrollTop, 900);
  assert.equal(rf.el.classList.contains('kb'), true);
  assert.equal(h.cols.visible('orchestrator').el.classList.contains('kb'), false);
});

test('a column that is not pinned, folded to the rail, is labelled as open, not pinned', () => {
  const h = setup({ width: 700, stored: { columns: { trail: { cols: [pin('orchestrator'), loose('route-finder')], kb: 'orchestrator', recent: ['orchestrator', 'route-finder'] } } } });
  h.cols.render();
  assert.deepEqual(shown(h.area), ['orchestrator']);
  const rail = h.area.children.find(e => e.classList.contains('pin-rail'));
  assert.match(rail.innerHTML, /route-finder: open, not pinned, folded/);
});

test('the window\'s buttons sit in the right-most column, and follow it', () => {
  const h = setup({ stored: { columns: { trail: { cols: [pin('orchestrator')], kb: 'orchestrator' } } } });
  h.cols.render();
  assert.equal(h.cols.visible('orchestrator').acts.contains(h.cols.winActs), true);
  h.cols.open('route-finder'); h.cols.render();
  assert.equal(h.cols.visible('route-finder').acts.contains(h.cols.winActs), true);
  assert.equal(h.cols.visible('orchestrator').acts.contains(h.cols.winActs), false);
});
