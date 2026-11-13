// Decision 50 B: a short brief written into the record (lead, for_you, picture kinds). The shared helpers, the build's
// .md and page, the board's card field and brief, the pop-up's HTML (written and laid out from older records), and
// the card's brief button. Everything runs in temp folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { leadOf, forYouOf, sketchUri, briefData } from '../../crux/scripts/brief.mjs';
import { placedImages } from '../../crux/scripts/images.mjs';
import { build } from '../../crux/scripts/build.mjs';
import { Board } from '../lib/board.mjs';
import { briefButton, briefHtml, Brief } from '../public/brief.js';

const temp = t => { const d = mkdtempSync(join(tmpdir(), 'crux-brief-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const record = (id, extra = {}) => ({ id, slug: `d${id}`, title: `Decision ${id}`, status: 'open', date: '2026-11-12', mode: 'full', context: 'History for later sessions.',
  options: [{ key: 'A', name: 'Aye', summary: 'First', pros: ['Quick'], cons: ['Drifts'], effort: 'Small' }, { key: 'B', name: 'Bee', summary: 'Second' }],
  recommended: 'A', confidence: 'lean', recommendation: 'A is quicker.', ...extra });
const writeRecord = (dir, r) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${String(r.id).padStart(4, '0')}-${r.slug}.json`), JSON.stringify(r, null, 1)); };
const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('the fields: lead trimmed to one line; for_you as { text, kind }, strings allowed, unknown kinds become changes', () => {
  assert.equal(leadOf({ lead: '  Pick one.\n I recommend A. ' }), 'Pick one. I recommend A.');
  assert.equal(leadOf({}), '');
  assert.equal(leadOf({ lead: 42 }), '');
  assert.deepEqual(forYouOf({ for_you: ['You see one page.', { text: 'Run the installer', kind: 'setup' }, { text: 'Others read it', kind: 'undo' }, { text: 'x', kind: 'odd' }, '', { kind: 'setup' }, null] }), [
    { text: 'You see one page.', kind: 'change' }, { text: 'Run the installer', kind: 'setup' }, { text: 'Others read it', kind: 'undo' }, { text: 'x', kind: 'change' }]);
  assert.deepEqual(forYouOf({ for_you: 'nope' }), []);
  assert.equal(forYouOf({ for_you: Array(9).fill('a') }).length, 6, 'at most six lines');
});

test('pictures keep a known kind only', () => {
  assert.deepEqual(placedImages({ images: [{ file: 'images/0001-a.png', caption: 'A', option: 'B', kind: 'schematic' }, { file: 'images/0001-b.png', kind: 'selfie' }] }),
    [{ file: 'images/0001-a.png', caption: 'A', option: 'B', kind: 'schematic' }, { file: 'images/0001-b.png', caption: '' }]);
});

test('sketches become pictures: colours swapped in, a namespace added, nothing that could break out of an attribute', () => {
  const uri = sketchUri(`<svg viewBox='0 0 320 180'><rect fill='var(--accent)' stroke='currentColor'/><text fill="var(--unknown, red)">it's (big)</text></svg>`);
  assert.match(uri, /^data:image\/svg\+xml;charset=utf-8,/);
  assert.doesNotMatch(uri, /['"<>()\s]/);
  const svg = decodeURIComponent(uri.split(',')[1]);
  assert.match(svg, /^<svg font-family="Segoe UI, system-ui, sans-serif" xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox/);
  assert.match(svg, /fill='#8ea8ff' stroke='#e7eaf0'/);
  assert.match(svg, /fill="#a2aab7"/);
  assert.equal(sketchUri('<script>alert(1)</script>'), '');
  assert.equal(sketchUri(null), '');
  assert.equal(sketchUri('<svg>' + 'x'.repeat(40001) + '</svg>'), '', 'oversized sketches are left out');
});

test('the build: "In short" leads the .md, with setup and hard-to-undo lines marked; older records are unchanged', t => {
  const dir = join(temp(t), '.decisions');
  writeRecord(dir, record(1, { lead: 'Pick a store. I recommend A.', for_you: ['One page to look at', { text: 'Nothing to install', kind: 'setup' }, { text: 'Reports will read it', kind: 'undo' }] }));
  writeRecord(dir, record(2));
  build(dir, { attachments: null });
  const md = readFileSync(join(dir, '0001-d1.md'), 'utf8');
  assert.match(md, /## In short\n\nPick a store\. I recommend A\.\n\nFor you:\n\n- One page to look at\n- Setup: Nothing to install\n- Hard to undo: Reports will read it\n/);
  assert.ok(md.indexOf('## In short') < md.indexOf('## Context'));
  assert.doesNotMatch(readFileSync(join(dir, '0002-d2.md'), 'utf8'), /In short/);
  const page = readFileSync(join(dir, '0001-d1.html'), 'utf8');
  assert.match(page, /"lead":"Pick a store\. I recommend A\."/);
  assert.match(page, /class="lead"/);
});

test('the board: the card gets the lead; the brief carries everything the pop-up shows, or null', t => {
  const root = temp(t), dir = join(root, '.decisions');
  writeRecord(dir, record(3, { lead: 'Pick A.', for_you: [{ text: 'Set it up', kind: 'setup' }], change_mind: 'If B gets cheaper.',
    criteria: [{ name: 'Speed', scores: { A: 3, B: 1, C: 9 } }], images: [{ file: 'images/0003-a.png', caption: 'A drawn', option: 'A', kind: 'schematic' }],
    options: [{ key: 'A', name: 'Aye', summary: 'First', sketch: "<svg viewBox='0 0 1 1'></svg>" }, { key: 'B', name: 'Bee' }] }));
  writeRecord(dir, record(4));
  const board = new Board(root, { ofType: () => [] });
  const snap = board.snapshot().decisions;
  assert.equal(snap.find(d => d.id === 3).lead, 'Pick A.');
  assert.equal(snap.find(d => d.id === 4).lead, '');
  const b = board.brief(3);
  assert.equal(b.written, true);
  assert.deepEqual(b.for_you, [{ text: 'Set it up', kind: 'setup' }]);
  assert.deepEqual(b.criteria, [{ name: 'Speed', note: '', scores: { A: 3, B: 1 } }]);
  assert.deepEqual(b.images, [{ file: 'images/0003-a.png', caption: 'A drawn', option: 'A', kind: 'schematic' }]);
  assert.match(b.options[0].sketch, /^data:image\/svg\+xml/);
  assert.equal(b.options[1].sketch, '');
  assert.equal(b.page, '0003-d3.html');
  assert.equal(board.brief(4).written, false);
  assert.equal(board.brief(99), null);
});

test('the pop-up, written: answer first, for you, pictures beside their option, scores, why, background folded; pick or close', () => {
  const b = { ...briefData(record(7, { lead: 'Pick a <store>.', for_you: ['See one page', { text: 'Others read it', kind: 'undo' }], change_mind: 'If B gets cheaper.',
    criteria: [{ name: 'Speed', scores: { A: 3, B: 1 } }], depends_on: [4], images: [{ file: 'images/0007-a.png', caption: 'A on a phone', option: 'A', kind: 'mockup' }, { file: 'images/0007-all.png', caption: 'Both' }, { file: '../x.png' }] })), page: '0007-d7.html' };
  const { head, body, foot } = briefHtml('my proj', b);
  assert.match(head, /Brief · D0007/);
  assert.match(head, /Your call/);
  assert.match(head, /href="\/p\/my%20proj\/0007-d7\.html"[^>]*title="Open the full record page"/);
  assert.match(head, /data-brief-close title="Close" aria-label="Close"/);
  assert.match(body, /<p class="bf-lead">Pick a &lt;store&gt;\.<\/p>/);
  assert.ok(body.indexOf('bf-lead') < body.indexOf('What changes for you'));
  assert.match(body, /<li class="undo">.*Hard to undo: .*Others read it/);
  assert.match(body, /<div class="bf-sk">Pictures<\/div>.*0007-all\.png/s, 'a shared picture before the options');
  const a = body.indexOf('<h3>Aye</h3>'), bee = body.indexOf('<h3>Bee</h3>');
  const pic = body.indexOf('/p/my%20proj/images/0007-a.png');
  assert.ok(a < pic && pic < bee, 'the option picture sits in its own option');
  assert.match(body, /<b>Mockup<\/b>A on a phone/);
  assert.doesNotMatch(body, /\.\.\/x\.png/, 'unsafe picture names are left out');
  assert.match(body, /data-view="\/p\/my%20proj\/images\/0007-a\.png"/, 'pictures open full size in the viewer');
  assert.match(body, /Side by side.*Speed/s);
  assert.match(body, /Why A.*A is quicker\..*What would change this: If B gets cheaper\./s);
  assert.match(body, /<details class="bf-bg"><summary>.*Background and history.*D0004.*History for later sessions\./s);
  assert.doesNotMatch(body, /No brief was written/);
  assert.match(foot, /data-pick="7" data-choice="A">.*Take A/);
  assert.match(foot, /data-pick="7" data-choice="B" title="Pick B: Bee"/);
  assert.match(foot, /data-brief-close>Close</);
});

test('the pop-up, from an older record: opens with the recommendation, says no brief was written; decided ones show the pick and only Close', () => {
  const old = briefHtml('p', briefData(record(8)));
  assert.match(old.body, /<p class="bf-lead built"><b>Recommended: A, Aye<\/b> \(lean\)\. A is quicker\.<\/p>/);
  assert.match(old.body, /No brief was written for this decision/);
  assert.doesNotMatch(old.body, /What changes for you/);
  assert.equal((old.body.match(/A is quicker\./g) || []).length, 1, 'the recommendation is not repeated under Why');
  const done = briefHtml('p', briefData(record(9, { status: 'decided', chosen: 'B', reason: 'Cheaper.' })));
  assert.match(done.head, /chip decided">decided · B/);
  assert.match(done.body, /You picked <b>B: Bee<\/b>\. Cheaper\./);
  assert.doesNotMatch(done.foot, /data-pick/);
  assert.match(done.foot, /data-brief-close>Close</);
  const found = briefHtml('p', briefData(record(10, { status: 'found' })));
  assert.match(found.foot, /data-choice="confirm".*data-choice="reject".*Close/s);
});

test('the pop-up: an unsafe sketch is never put in the page', () => {
  const b = briefData(record(11));
  b.options[0].sketch = 'javascript:alert(1)';
  b.options[1].sketch = 'data:image/svg+xml;charset=utf-8,%3Csvg%3E" onerror="x';
  const { body } = briefHtml('p', b);
  assert.doesNotMatch(body, /javascript:|onerror/);
});

test('the card: a brief button on every decision with options, escaped, and the lead in place of the cut background', () => {
  assert.match(briefButton('p', { id: 1, status: 'found', options: [] }), /data-brief="1"/, 'findings without options get one too');
  assert.equal(briefButton('p', null), '');
  const html = briefButton('my "proj"', { id: 12, title: 'Where <do> they live?', options: [{ key: 'A' }] });
  assert.match(html, /data-brief="12" data-brief-pj="my &quot;proj&quot;" data-brief-title="Where &lt;do&gt; they live\?"/);
  assert.match(html, /title="Read the brief for D0012" aria-label="Read the brief for D0012"><svg class="icon"><use href="#i-brief"\/><\/svg><\/button>/);
  const card = /function decisionCard\([\s\S]*?\n\}/.exec(APP)[0];
  assert.match(card, /briefButton\(p\.name, d\)\}\$\{picturesButton\(p\.name, d\)\}/);
  assert.match(card, /d\.lead \? `<p class="lead-line">\$\{esc\(d\.lead\)\}<\/p>` : d\.context/);
  assert.match(APP, /installBrief\(document, \(project, id\) => api\(`\/api\/brief\?project=\$\{encodeURIComponent\(project\)\}&id=\$\{encodeURIComponent\(id\)\}`\)\)/);
});

test('stray entries: null options and criteria are skipped; a sketch the brief cannot show gets a hover note', () => {
  const b = briefData(record(12, { options: [null, { key: 'A', name: 'Aye', sketch: '<svg>' + 'x'.repeat(40001) + '</svg>' }, 'odd', { key: 'B', name: 'Bee' }], criteria: [null, { name: 'Speed', scores: null }] }));
  assert.deepEqual(b.options.map(o => o.key), ['A', 'B']);
  assert.equal(b.options[0].sketch_dropped, true);
  assert.equal(b.options[1].sketch_dropped, undefined);
  assert.deepEqual(b.criteria, [{ name: 'Speed', note: '', scores: {} }]);
  const { body } = briefHtml('p', b);
  assert.match(body, /<h3>Aye<\/h3>.*class="bf-mark" title="This option's sketch is too large to show here; the full record page has it\."/s);
  assert.equal((body.match(/bf-mark/g) || []).length, 1);
});

test('a finding without options: no options section, Confirm and Reject at the foot', () => {
  const { body, foot } = briefHtml('p', briefData(record(13, { status: 'found', options: [] })));
  assert.doesNotMatch(body, /The options/);
  assert.match(foot, /data-choice="confirm".*data-choice="reject"/s);
});

test('picked elsewhere while open: the brief keeps only Close and says what the decision is now', () => {
  // A tiny stand-in for the dialog: the parts sync() touches.
  const foot = { innerHTML: '<button data-pick="7" data-choice="A">Take A</button>' };
  let chip = { replaced: null, replaceWith(x) { this.replaced = x; } };
  const el = { open: true, querySelector: s => s === '.bf-foot' ? foot : s === '.bf-head .bf-call' ? chip : null };
  const pop = new Brief({ createElement: () => ({}) }, null);
  pop.el = el;
  pop.shown = { project: 'p', id: '7', status: 'open' };
  pop.sync(() => 'open');
  assert.match(foot.innerHTML, /data-pick/, 'unchanged while it is still open');
  pop.sync(() => 'decided');
  assert.doesNotMatch(foot.innerHTML, /data-pick/);
  assert.match(foot.innerHTML, /Already decided: picked somewhere else while this was open\..*data-brief-close>Close</s);
  assert.deepEqual(chip.replaced, { className: 'chip decided', textContent: 'decided' });
  foot.innerHTML = 'x'; pop.sync(() => 'superseded');
  assert.equal(foot.innerHTML, 'x', 'only once');
});
