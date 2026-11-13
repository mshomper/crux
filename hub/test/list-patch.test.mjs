// An update arriving never sends a list to its top (Matt's iPhone, 0.17.2): a redraw keeps the items that did not
// change and swaps only the rest, and a column puts the item you were reading back where it was on screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, templateFrom, FakeEl } from './fake-dom.mjs';
import { patchList, patchKeep, anchorOf, backTo } from '../public/list-patch.js';

installDom();
const { Conversation } = await import('../public/conversation.js');
const pub = f => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const msg = (i, text = `m${i}`) => `<div class="msg" data-i="${i}"><span class="who">a</span><p>${text}</p></div>`;
const thread = n => Array.from({ length: n }, (_, i) => msg(i)).join('');

test('a new message is added at the end; every message already there is the same element as before', () => {
  const list = new FakeEl('section');
  patchList(list, thread(5));
  const before = list.children;
  const r = patchList(list, thread(6));
  assert.deepEqual(r, { kept: 5, added: 1, removed: 0 });
  assert.equal(list.children.length, 6);
  before.forEach((el, i) => assert.equal(list.children[i], el, `message ${i} kept, not rebuilt`));
  assert.equal(list.children[5].dataset.i, '5');
});

test('a card that changed in the middle is the only one swapped; one answered is the only one taken out', () => {
  const list = new FakeEl('section');
  patchList(list, thread(5));
  const was = list.children;
  const r = patchList(list, [msg(0), msg(1), msg(2, 'picked'), msg(3), msg(4)].join(''));
  assert.deepEqual(r, { kept: 4, added: 1, removed: 1 });
  assert.notEqual(list.children[2], was[2]);
  for (const i of [0, 1, 3, 4]) assert.equal(list.children[i], was[i]);
  const r2 = patchList(list, [msg(0), msg(1), msg(3), msg(4)].join(''));
  assert.deepEqual(r2, { kept: 4, added: 0, removed: 1 });
  assert.deepEqual(list.children.map(e => e.dataset.i), ['0', '1', '3', '4']);
  assert.equal(patchList(list, '').removed, 4, 'an emptied list empties');
});

// A list on screen: items 100 px high stacked from y = 0, the list's own top edge at 50 on screen.
function screen(n, top) {
  const list = { scrollTop: top, clientHeight: 400, children: [], getBoundingClientRect: () => ({ top: 50 }) };
  Object.defineProperty(list, 'scrollHeight', { get: () => list.children.length * 100 });
  const item = () => { const el = { parentElement: list, getBoundingClientRect() { const y = 50 + list.children.indexOf(el) * 100 - list.scrollTop; return { top: y, bottom: y + 100, height: 100 }; } }; return el; };
  for (let i = 0; i < n; i++) list.children.push(item());
  return { list, item };
}

test('the item you were reading goes back where it was, after the iPhone sent the list to its top', () => {
  const { list, item } = screen(30, 1240);
  const a = anchorOf(list);
  assert.equal(a.el, list.children[12]);
  assert.equal(a.off, -40, 'item 12 starts 40 px above the list\'s top edge');
  list.children.push(item(), item());   // two summaries arrive at the end
  list.scrollTop = 0;                   // what the iPhone did
  assert.equal(backTo(list, a), true);
  assert.equal(list.scrollTop, 1240);
  assert.equal(backTo(list, a), false, 'nothing to do once it is there');
});

test('a card taken out above you leaves what you read in place; one past the end lands at the end', () => {
  const { list } = screen(30, 1240);
  const a = anchorOf(list);
  list.children.splice(2, 1);           // a card above was answered
  backTo(list, a);
  assert.equal(list.scrollTop, 1140, 'the list moves up by the card that went, so the item you read stays put on screen');
  const gone = { el: { parentElement: null }, off: 0, top: 9000 };
  backTo(list, gone);
  assert.equal(list.scrollTop, 29 * 100 - 400, 'never past the end');
});

// The column itself: an update redraws the list, the iPhone resets it, and the column puts it back.
function column(thread = 'route-finder') {
  const TEMPLATE = templateFrom(pub('index.html'), 'conv-tpl');
  const S = { html: '' };
  const host = { head: t => ({ title: t, sub: '', chips: [], waiting: 0 }), feed: () => S.html, scrolled() { }, focused() { }, action() { }, focusBox() { } };
  const c = new Conversation({ project: 'p', thread, template: TEMPLATE, host, compose: { text: '', tray: [] } });
  const feed = c.feed;
  c.el._connected = true;               // on the page
  feed.clientHeight = 800;
  const ins = feed.insertBefore.bind(feed);
  feed.insertBefore = (el, ref) => { const r = ins(el, ref); feed.scrollHeight = feed.children.length * 100; feed.scrollTop = 0; return r; };   // the iPhone
  const draw = html => { S.html = html; c.render({}); };
  return { c, feed, draw };
}

test('reading halfway up a thread: messages, summaries and state changes arriving keep you where you were', () => {
  const { c, feed, draw } = column();
  draw(thread(40));                     // opens at the latest message
  assert.equal(feed.scrollTop, 4000);
  feed.scrollTop = 1500; c.atBottom = false;
  for (const n of [41, 42, 43]) { draw(thread(n)); assert.equal(feed.scrollTop, 1500, `still at 1500 after update ${n}`); }
  draw(thread(43));                     // a state change that leaves the list as it is: nothing redrawn, nothing moved
  assert.equal(feed.scrollTop, 1500);
});

test('at the latest message, new ones are followed', () => {
  const { feed, draw } = column();
  draw(thread(40));
  feed.scrollTop = feed.scrollHeight - feed.clientHeight;
  draw(thread(41));
  assert.equal(feed.scrollTop, feed.scrollHeight);
});

test('Needs you and All projects (read from the top) stay where you are as cards come and go, and at the top stay at the top', () => {
  const { feed, draw } = column('needs');
  draw(thread(30));
  assert.equal(feed.scrollTop, 0, 'opens at its top');
  draw(thread(31));
  assert.equal(feed.scrollTop, 0);
  feed.scrollTop = 900;
  draw(thread(32));
  assert.equal(feed.scrollTop, 900);
});

const later = () => new Promise(r => setTimeout(r, 300));   // past the late put-backs (next frame, 250 ms)
const glide = (feed, to) => { feed.scrollTop = to; feed.dispatchEvent({ type: 'scroll' }); };

test('a fling still gliding when an update lands is left alone by the late put-backs; an iPhone reset is undone', async () => {
  const { c, feed, draw } = column();
  draw(thread(40));
  feed.scrollTop = 1500; c.atBottom = false;
  draw(thread(41));
  assert.equal(feed.scrollTop, 1500, 'put back at once');
  glide(feed, 1720);                    // the list keeps gliding after the finger lifted: no touch event, only scrolls
  await later();
  assert.equal(feed.scrollTop, 1720, 'the glide is not yanked back');
  draw(thread(42));
  glide(feed, 0);                       // whereas the iPhone sending it to its top after the redraw
  await later();
  assert.equal(feed.scrollTop, 1720, 'is undone by the late put-back');
});

test('at the latest message, a reader who flicks up just as a message arrives is not pulled back down', async () => {
  const { feed, draw } = column();
  draw(thread(40));
  feed.scrollTop = feed.scrollHeight - feed.clientHeight;
  draw(thread(41));
  assert.equal(feed.scrollTop, feed.scrollHeight, 'followed at once');
  glide(feed, 2600);                    // flicked up
  await later();
  assert.equal(feed.scrollTop, 2600);
});

test('the thread list and the board keep the row you were looking at when a row is added above it', () => {
  const rows = new FakeEl('nav');       // the page stand-in, given a screen: rows 100 px high, the list's top edge at 50
  rows.clientHeight = 400; rows.scrollTop = 0; rows._connected = true;
  Object.defineProperty(rows, 'scrollHeight', { get: () => rows.children.length * 100 });
  rows.getBoundingClientRect = () => ({ top: 50 });
  const place = () => rows.children.forEach((el, i) => { el.getBoundingClientRect = () => { const y = 50 + i * 100 - rows.scrollTop; return { top: y, bottom: y + 100, height: 100 }; }; });
  const ins = rows.insertBefore.bind(rows);
  rows.insertBefore = (el, ref) => { const r = ins(el, ref); place(); return r; };
  patchKeep(rows, thread(20)); place();
  rows.scrollTop = 640;
  const seen = rows.children[6];
  patchKeep(rows, msg('new') + thread(20));   // a row added at the top
  assert.equal(rows.children[7], seen);
  assert.equal(rows.scrollTop, 740, 'the list moves down by the new row, so the row you saw stays put on screen');
  rows.scrollTop = 0;
  patchKeep(rows, msg('newer') + msg('new') + thread(20));
  assert.equal(rows.scrollTop, 0, 'at its top it stays at its top');
});

test('every list that updates on its own changes in place: columns, the thread list and the board', () => {
  const conv = pub('conversation.js'), app = pub('app.js');
  assert.match(conv, /patchList\(feed, html\)/);
  assert.doesNotMatch(conv, /feed\.innerHTML =/);
  assert.match(app, /patchKeep\(list, html\)/, 'the thread list, with the row you see kept in place');
  assert.match(app, /patchKeep\(body, out\)/, 'the board, the same');
  assert.doesNotMatch(app, /\$\('#threads'\)\.innerHTML = html/);
});
