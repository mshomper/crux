// A question card carries the pictures of its summary (and of its round), drawn as thumbnails in a wrapping grid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openQuestions } from '../public/questions.js';
import { summaryPictureItems, thumbGrid } from '../public/pictures.js';

let n = 0;
const ev = (type, extra) => ({ id: `${type}-${++n}`, ts: new Date().toISOString(), type, ...extra });
const shot = (thread, id, caption) => ev('visual', { thread, from: thread, visual: id, kind: 'image', attachment: { id }, caption });
const ids = ['a'.repeat(32) + '.png', 'b'.repeat(32) + '.png', 'c'.repeat(32) + '.png', 'd'.repeat(32) + '.png'];

test('a question card made from a summary with visuals carries them, and its thumbnails open full size', () => {
  const log = ids.map((id, i) => shot('w1', id, `Still ${i + 1}`));
  log.push(ev('summary', { thread: 'w1', from: 'w1', questions: ['Do the screens look right?'], visuals: ids }));
  const [card] = openQuestions(log);
  assert.deepEqual(card.visuals, ids);
  const items = summaryPictureItems('demo', card, log);
  assert.equal(items.length, 4);
  assert.equal(items[0].src, `/att/demo/${ids[0]}`);
  assert.equal(items[2].caption, 'Still 3');
  const html = thumbGrid(items, 'w1');
  assert.equal((html.match(/class="qthumb"/g) || []).length, 4);
  assert.match(html, /data-pic-i="3"/);
});

test('a picture posted in the same round shows even when the summary did not list it; an earlier round\'s does not', () => {
  const log = [shot('orchestrator', ids[0], 'Old'), ev('summary', { thread: 'orchestrator', from: 'orchestrator', questions: [], visuals: [] }),
    shot('orchestrator', ids[1], 'New'), shot('w1', ids[2], 'Another thread')];
  log.push(ev('summary', { thread: 'orchestrator', from: 'orchestrator', questions: ['Which one?'], visuals: [] }));
  const [card] = openQuestions(log);
  assert.deepEqual(summaryPictureItems('demo', card, log).map(i => i.caption), ['New']);
});

test('pages open in a tab, unknown ids vanish, and a listed screenshot with no event still shows', () => {
  const log = [ev('visual', { thread: 'w1', visual: 'page.html', kind: 'page', caption: 'Mock' })];
  const s = ev('summary', { thread: 'w1', from: 'w1', questions: ['Ok?'], visuals: ['page.html', 'nope', ids[3]] });
  log.push(s);
  const items = summaryPictureItems('my proj', s, log);
  assert.deepEqual(items, [{ href: '/media/my%20proj/page.html', caption: 'Mock' }, { src: `/att/my%20proj/${ids[3]}`, caption: '' }]);
  assert.equal(thumbGrid([], ''), '');
});

test('the question card draws that grid, and the grid is a wrapping two-column grid on a phone', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const pics = thumbGrid\(summaryPictureItems\(p\.name, ev, p\.events\)/);
  assert.match(app, /<article class="card question"[\s\S]*?\$\{pics\}[\s\S]*?class="qrows"/);
  const css = readFileSync(new URL('../public/pictures.css', import.meta.url), 'utf8');
  assert.match(css, /\.qpics\{display:grid;/);
  assert.match(css, /max-width:520px\)\{\.qpics\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(css.match(/\.qpics\{[^}]*\}/)[0], /overflow-x|nowrap/);
});
