// Decision 43 A: a decision's pictures go into git with the record, in .decisions/images, listed in its "images" field.
// The copy step (absolute paths and post_visual ids), PNG shrinking without dependencies, the build's .md and page,
// the hub's commit and pick paths, the board field, and the card's pictures button. Everything runs in temp folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { placeImages, placedImages, isPlaced, shrinkPng, decodePng, encodePng, sniffImage, stripJpeg, insideAny, MAX_WIDTH } from '../../crux/scripts/images.mjs';
import { build } from '../../crux/scripts/build.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { pictureList, picturesButton } from '../public/pictures.js';

Agent.prototype.send = function () { this.state = 'working'; };
Agent.prototype.close = function () {};

const git = (cwd, ...args) => String(execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })).trim();
const temp = t => makeTmp('crux-pics-', t);
const record = (id, extra = {}) => ({ id, slug: `d${id}`, title: `Decision ${id}`, status: 'open', date: '2026-11-12', options: [{ key: 'A', name: 'Aye', summary: 'First' }, { key: 'B', name: 'Bee', summary: 'Second' }], recommended: 'A', ...extra });
const writeRecord = (dir, r) => { mkdirSync(dir, { recursive: true }); const f = join(dir, `${String(r.id).padStart(4, '0')}-${r.slug}.json`); writeFileSync(f, JSON.stringify(r, null, 1)); return f; };
const readRecord = (dir, id) => JSON.parse(readFileSync(join(dir, `${String(id).padStart(4, '0')}-d${id}.json`), 'utf8'));

// A solid-colour RGBA picture as PNG bytes.
function solid(w, h, [r, g, b, a = 255]) {
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a; }
  return encodePng(w, h, px);
}

test('PNG: encode and decode round-trip, and a wide picture shrinks to 1600 px keeping its shape and colour', () => {
  const small = solid(30, 20, [10, 200, 90]);
  assert.equal(sniffImage(small), 'png');
  const back = decodePng(small);
  assert.equal(back.width, 30); assert.equal(back.height, 20);
  assert.deepEqual([...back.rgba.subarray(0, 4)], [10, 200, 90, 255]);
  assert.equal(shrinkPng(small), null, 'narrow pictures are left alone');

  const wide = solid(2400, 300, [40, 80, 160]);
  const s = shrinkPng(wide);
  assert.equal(s.width, MAX_WIDTH); assert.equal(s.height, 200);
  const d = decodePng(s.buf);
  assert.equal(d.width, 1600); assert.equal(d.height, 200);
  assert.deepEqual([...d.rgba.subarray(0, 4)], [40, 80, 160, 255]);
  assert.deepEqual([...d.rgba.subarray(d.rgba.length - 4)], [40, 80, 160, 255]);

  // Half black, half white columns average to grey at a 2:1 shrink; see-through pixels do not darken colours.
  const px = Buffer.alloc(3200 * 2 * 4);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 3200; x++) { const o = (y * 3200 + x) * 4; const v = x % 2 ? 255 : 0; px[o] = px[o + 1] = px[o + 2] = v; px[o + 3] = 255; }
  const g = decodePng(shrinkPng(encodePng(3200, 2, px)).buf);
  assert.ok(Math.abs(g.rgba[0] - 128) <= 1, `grey, got ${g.rgba[0]}`);
  const tp = Buffer.alloc(3200 * 4 * 4);
  for (let i = 0; i < tp.length; i += 4) { const red = (i / 4) % 2 === 0; tp[i] = red ? 255 : 0; tp[i + 3] = red ? 255 : 0; }
  const t2 = decodePng(shrinkPng(encodePng(3200, 4, tp)).buf);
  assert.equal(t2.rgba[0], 255, 'colour of the opaque half kept');
  assert.ok(Math.abs(t2.rgba[3] - 128) <= 1, 'half opacity');
});

test('PNG: grey and palette files from other tools decode', () => {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); };
  const png = (w, h, depth, ctype, rows, extra = []) => {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = ctype;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  };
  // 2x1 grey, 8 bit, filter "sub" on the row: 100, then +50.
  const grey = decodePng(png(2, 1, 8, 0, Buffer.from([1, 100, 50])));
  assert.deepEqual([...grey.rgba], [100, 100, 100, 255, 150, 150, 150, 255]);
  // 4x1 palette, 2 bits per pixel, with a see-through entry.
  const plte = chunk('PLTE', Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]));
  const trns = chunk('tRNS', Buffer.from([255, 255, 0]));
  const pal = decodePng(png(4, 1, 2, 3, Buffer.from([0, 0b00011011]), [plte, trns]));
  assert.deepEqual([...pal.rgba], [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 0, 9, 9, 9, 255]);
});

test('the copy step: absolute paths and hub picture ids land in images/ and the entries are rewritten', t => {
  const root = temp(t), dir = join(root, '.decisions'), att = join(root, '.crux', 'attachments'), shots = join(root, 'shots');
  mkdirSync(att, { recursive: true }); mkdirSync(shots);
  const wide = solid(2000, 100, [1, 2, 3]), small = solid(40, 30, [9, 9, 9]);
  writeFileSync(join(shots, 'Mockup B.png'), wide);
  const id = 'ab'.repeat(16) + '.png';
  writeFileSync(join(att, id), small);
  writeRecord(dir, record(7, { images: [
    { from: join(shots, 'Mockup B.png'), caption: 'Option B on a phone', option: 'B' },
    { from: id, caption: 'The whole question' },
    { file: join(shots, 'Mockup B.png'), caption: 'Option B on a phone', option: 'B' }   // a path in "file": same picture, reused
  ] }));
  writeRecord(dir, record(8));   // no pictures: untouched
  const before8 = readFileSync(join(dir, '0008-d8.json'), 'utf8');
  const { changed, warnings } = placeImages(dir, { attachments: att });
  assert.deepEqual(warnings, []);
  assert.deepEqual(changed, ['0007-d7.json']);
  const r = readRecord(dir, 7);
  assert.deepEqual(r.images, [
    { file: 'images/0007-option-b-on-a-phone.png', caption: 'Option B on a phone', option: 'B' },
    { file: 'images/0007-the-whole-question.png', caption: 'The whole question' },
    { file: 'images/0007-option-b-on-a-phone.png', caption: 'Option B on a phone', option: 'B' }
  ]);
  assert.ok(r.images.every(isPlaced));
  assert.equal(decodePng(readFileSync(join(dir, 'images', '0007-option-b-on-a-phone.png'))).width, 1600, 'shrunk on the way in');
  assert.deepEqual(readFileSync(join(dir, 'images', '0007-the-whole-question.png')), small, 'small pictures copied byte for byte');
  assert.equal(readFileSync(join(dir, '0008-d8.json'), 'utf8'), before8);
  assert.deepEqual(placeImages(dir, { attachments: att }), { changed: [], warnings: [] }, 'running again changes nothing');

  // A different picture with the same caption gets its own name.
  writeFileSync(join(shots, 'other.png'), solid(10, 10, [200, 0, 0]));
  r.images.push({ from: join(shots, 'other.png'), caption: 'Option B on a phone' });
  writeFileSync(join(dir, '0007-d7.json'), JSON.stringify(r));
  placeImages(dir, { attachments: att });
  assert.equal(readRecord(dir, 7).images[3].file, 'images/0007-option-b-on-a-phone-2.png');
});

test('the copy step: pictures that cannot be placed are marked skipped and reported once per record', t => {
  const root = temp(t), dir = join(root, '.decisions');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'notes.txt'), 'not a picture');
  writeFileSync(join(root, 'big.png'), solid(400, 400, [0, 0, 0]));
  writeFileSync(join(root, 'mock.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeRecord(dir, record(3, { images: [
    { from: join(root, 'gone.png'), caption: 'gone' },
    { from: join(root, 'notes.txt'), caption: 'text' },
    { from: join(root, 'big.png'), caption: 'big' },
    { from: join(root, 'mock.svg'), caption: 'drawing' },
    { from: 'cd'.repeat(16) + '.png', caption: 'hub id, no store' }
  ] }));
  const first = placeImages(dir, { maxBytes: 100 });
  assert.deepEqual(first.changed, ['0003-d3.json']);
  assert.equal(first.warnings.length, 2, 'one notice for the record, one for the id waiting for the hub');
  assert.match(first.warnings[0], /^D0003: 4 pictures were left out: gone\.png \(not found\); notes\.txt \(not a PNG, JPEG, GIF or WebP picture; save it as PNG\); big\.png \(.* after shrinking, over the 100 bytes limit\); mock\.svg \(an SVG drawing; take a PNG screenshot of it and list that\)/);
  assert.match(first.warnings[1], /hub picture id waits for the hub/);
  const imgs = readRecord(dir, 3).images;
  assert.deepEqual(imgs.map(i => i.missing || null), ['not found', null, null, null, null], 'a missing file is noted, not skipped');
  assert.deepEqual(imgs.map(i => !!i.skipped), [false, true, true, true, false], 'the hub id is not marked: the hub can still copy it');
  assert.equal(existsSync(join(dir, 'images')), false);
  // The next run (the next commit) says nothing new about either.
  const again = placeImages(dir, { maxBytes: 100 });
  assert.deepEqual(again.changed, []);
  assert.equal(again.warnings.length, 1);
  assert.match(again.warnings[0], /hub picture id/);
  // The missing file turns up: the next run places it, with no note left.
  writeFileSync(join(root, 'gone.png'), solid(5, 5, [1, 1, 1]));
  placeImages(dir, { maxBytes: 100 });
  assert.deepEqual(readRecord(dir, 3).images[0], { file: 'images/0003-gone.png', caption: 'gone' });
  // A refused one is tried again only once its note is removed.
  writeFileSync(join(root, 'notes.txt'), solid(5, 5, [2, 2, 2]));
  placeImages(dir);
  assert.ok(readRecord(dir, 3).images[1].skipped, 'still skipped while the note stays');
  const r = readRecord(dir, 3);
  delete r.images[1].skipped;
  writeFileSync(join(dir, '0003-d3.json'), JSON.stringify(r));
  placeImages(dir);
  assert.equal(readRecord(dir, 3).images[1].file, 'images/0003-text.png');
});

test('the copy step: only the project folder (real paths) and the hub picture folder; no ../, symlink or junction escapes', t => {
  const root = temp(t), project = join(root, 'proj'), dir = join(project, '.decisions'), outside = join(root, 'elsewhere');
  mkdirSync(outside, { recursive: true }); mkdirSync(join(project, 'shots'), { recursive: true });
  writeFileSync(join(outside, 'secret.png'), solid(4, 4, [9, 0, 0]));
  writeFileSync(join(project, 'shots', 'ok.png'), solid(4, 4, [0, 9, 0]));
  const link = join(project, 'linked');
  symlinkSync(outside, link, 'junction');   // a junction on Windows, a directory link elsewhere
  const att = join(project, '.crux', 'attachments'); mkdirSync(att, { recursive: true });
  writeRecord(dir, record(9, { images: [
    { from: join(outside, 'secret.png'), caption: 'absolute outside' },
    { from: '../../elsewhere/secret.png', caption: 'relative escape' },
    { from: join(link, 'secret.png'), caption: 'through a junction' },
    { file: join(outside, 'secret.png'), caption: 'file fallback outside' },
    { visual: join(outside, 'secret.png'), caption: 'visual fallback outside' },
    { from: '../shots/ok.png', caption: 'inside' }
  ] }));
  const { warnings } = placeImages(dir, { attachments: att, roots: [project] });
  const imgs = readRecord(dir, 9).images;
  assert.deepEqual(imgs.slice(0, 5).map(i => i.skipped), Array(5).fill('outside the project folder; post it with post_visual, or save it inside the project, and list that'));
  assert.equal(imgs[5].file, 'images/0009-inside.png');
  assert.match(warnings[0], /^D0009: 5 pictures were left out/);
  assert.deepEqual(readdirSync(join(dir, 'images')), ['0009-inside.png'], 'nothing from outside was copied');
  assert.equal(insideAny(join(link, 'secret.png'), [project]), false);
  assert.equal(insideAny(join(project, 'shots', 'ok.png'), [project]), true);
  // A post_visual id is read from the hub's folder only.
  writeFileSync(join(att, 'ef'.repeat(16) + '.png'), solid(3, 3, [5, 5, 5]));
  writeRecord(dir, record(10, { images: [{ from: 'ef'.repeat(16) + '.png', caption: 'hub' }] }));
  placeImages(dir, { attachments: att, roots: [project] });
  assert.equal(readRecord(dir, 10).images[0].file, 'images/0010-hub.png');
});

test('memory limits: sizes checked before reading, pixel counts before decoding, unpacking capped by the header', t => {
  const root = temp(t), dir = join(root, '.decisions');
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); };
  const png = (w, h, idat, interlace = 0) => {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[12] = interlace;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
  };
  // A header claiming 30000 x 30000 pixels is refused before anything is unpacked.
  const huge = png(30000, 30000, deflateSync(Buffer.alloc(10)));
  assert.throws(() => decodePng(huge), /megapixels, over the 25 megapixel limit/);
  // Data that unpacks to far more than a 2000 x 2 picture holds stops at the header's size.
  const bomb = png(2000, 2, deflateSync(Buffer.alloc(20 * 1024 * 1024)));
  assert.ok(bomb.length < 100 * 1024);
  assert.throws(() => decodePng(bomb), /image data larger than its header says/);
  writeFileSync(join(root, 'huge.png'), huge);
  writeFileSync(join(root, 'bomb.png'), bomb);
  writeFileSync(join(root, 'interlaced.png'), png(2000, 10, deflateSync(Buffer.alloc(10)), 1));
  // A JPEG over the limit is refused from its size on disk.
  writeFileSync(join(root, 'big.jpg'), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5000)]));
  writeRecord(dir, record(11, { images: [{ from: join(root, 'huge.png') }, { from: join(root, 'bomb.png') }, { from: join(root, 'interlaced.png') }, { from: join(root, 'big.jpg') }] }));
  placeImages(dir, { maxBytes: 4096 });
  const why = readRecord(dir, 11).images.map(i => i.skipped);
  assert.match(why[0], /900 megapixels, too many to shrink here/);
  assert.match(why[1], /could not be shrunk: image data larger than its header says/);
  assert.match(why[2], /an interlaced PNG 2000 px wide, which cannot be shrunk here/);
  assert.match(why[3], /^5 KB, over the 4 KB limit$/);
});

test('privacy: JPEG metadata segments and PNG text chunks are stripped on the way in', t => {
  const root = temp(t), dir = join(root, '.decisions');
  const seg = (m, body) => { const b = Buffer.from(body, 'latin1'); const h = Buffer.from([0xff, m, 0, 0]); h.writeUInt16BE(b.length + 2, 2); return Buffer.concat([h, b]); };
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, 'JFIF\0\x01\x01'), seg(0xe1, 'Exif\0\0GPS 51.5N camera-owner'), seg(0xfe, 'a comment'), seg(0xdb, 'QTABLE'), seg(0xee, 'Adobe'),
    Buffer.from([0xff, 0xda, 0, 4, 1, 2]), Buffer.from('SCANDATA', 'latin1'), Buffer.from([0xff, 0xd9])]);
  const clean = stripJpeg(jpeg);
  const s = clean.toString('latin1');
  assert.ok(!s.includes('Exif') && !s.includes('GPS') && !s.includes('a comment'));
  for (const kept of ['JFIF', 'QTABLE', 'Adobe', 'SCANDATA']) assert.ok(s.includes(kept), kept);
  // A PNG with a text chunk (as some tools write the author or the software).
  const base = solid(6, 4, [3, 3, 3]);
  const text = (() => { const d = Buffer.from('Author\0Somebody Real', 'latin1'); const l = Buffer.alloc(4); l.writeUInt32BE(d.length); return Buffer.concat([l, Buffer.from('tEXt'), d, Buffer.alloc(4)]); })();
  const tagged = Buffer.concat([base.subarray(0, 33), text, base.subarray(33)]);
  writeFileSync(join(root, 'photo.jpg'), jpeg);
  writeFileSync(join(root, 'tagged.png'), tagged);
  writeRecord(dir, record(12, { images: [{ from: join(root, 'photo.jpg'), caption: 'photo' }, { from: join(root, 'tagged.png'), caption: 'tagged' }] }));
  placeImages(dir);
  assert.ok(!readFileSync(join(dir, 'images', '0012-photo.jpg')).toString('latin1').includes('Exif'));
  const png = readFileSync(join(dir, 'images', '0012-tagged.png'));
  assert.ok(!png.toString('latin1').includes('Somebody Real'));
  assert.deepEqual(decodePng(png).rgba, decodePng(base).rgba, 'the picture itself unchanged');
});

test('the record field: placedImages keeps only pictures in place, with file, caption and option', () => {
  assert.deepEqual(placedImages({ images: [
    { file: 'images/0001-a.png', caption: 'A', option: 'A', extra: 1 },
    { file: 'images/../secret.png', caption: 'escape' },
    { file: 'C:/x.png' },
    { from: '/tmp/x.png', file: 'images/0001-b.png' },
    { file: 'images/0001-c.jpg' }
  ] }), [{ file: 'images/0001-a.png', caption: 'A', option: 'A' }, { file: 'images/0001-c.jpg', caption: '' }]);
  assert.deepEqual(placedImages({}), []);
  assert.deepEqual(placedImages({ images: 'nope' }), []);
});

test('the build: the .md shows pictures by relative link, per option and shared; the page gets them; problems listed', t => {
  const root = temp(t), dir = join(root, '.decisions');
  writeFileSync(join(root, 'shot.png'), solid(20, 10, [5, 5, 5]));
  writeRecord(dir, record(5, { images: [
    { from: join(root, 'shot.png'), caption: 'Layout [draft] *one*', option: 'B' },
    { from: join(root, 'shot.png'), caption: 'Both side by side' },
    { file: 'images/0005-missing.png', caption: 'lost' }
  ] }));
  const { problems } = build(dir, { attachments: null });
  assert.deepEqual(problems, ['0005-d5.json lists images/0005-missing.png, which is missing']);
  const md = readFileSync(join(dir, '0005-d5.md'), 'utf8');
  assert.match(md, /## Pictures\n\n!\[Both side by side\]\(images\/0005-both-side-by-side\.png\)\n\n\*Both side by side\*/);
  const b = md.indexOf('### B: Bee');
  assert.ok(b > md.indexOf('## Pictures'));
  assert.ok(md.indexOf('![Layout \\[draft\\] \\*one\\*](images/0005-layout-draft-one.png)') > b, 'option picture under its option, caption escaped');
  const page = readFileSync(join(dir, '0005-d5.html'), 'utf8');
  assert.match(page, /"_images":\[\{"file":"images\/0005-layout-draft-one.png"/);
  assert.match(page, /<h2>Pictures<\/h2>/);
});

test('git: the .decisions .gitignore keeps pages out but never catches pictures', t => {
  const root = temp(t);
  git(root, 'init', '-q');
  const dir = join(root, '.decisions');
  writeRecord(dir, record(1));
  build(dir, { attachments: null });
  mkdirSync(join(dir, 'images')); writeFileSync(join(dir, 'images', '0001-a.png'), solid(2, 2, [0, 0, 0]));
  const ignored = f => { try { git(root, 'check-ignore', '-q', f); return true; } catch { return false; } };
  assert.equal(ignored('.decisions/0001-d1.html'), true);
  assert.equal(ignored('.decisions/images/0001-a.png'), false);
  assert.equal(ignored('.decisions/0001-d1.md'), false);
});

// A project cloned from a bare "GitHub" repo, as in decisions-desk.test.mjs.
function project(t) {
  const root = temp(t);
  const bare = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = join(root, 'seed');
  git(root, 'init', '-q', '-b', 'main', seed);
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com']]) git(seed, 'config', k, v);
  writeFileSync(join(seed, '.gitignore'), '.crux/\n');
  writeRecord(join(seed, '.decisions'), record(1));
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'seed'); git(seed, 'remote', 'add', 'origin', bare); git(seed, 'push', '-q', 'origin', 'main');
  const dir = join(root, 'proj');
  git(root, 'clone', '-q', bare, dir);
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com']]) git(dir, 'config', k, v);
  mkdirSync(join(dir, '.crux'), { recursive: true });
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }) });
  const p = hub.project('proj');
  p.desk.local = true;                          // commit, never push
  p.desk.build = join(root, 'no-build.mjs');    // the real build (and its roll-up) stays out of hub tests
  return { root, dir, hub, p };
}

test('the hub: an orchestrator draft naming a post_visual picture and an absolute path commits both pictures', t => {
  const { root, dir, p } = project(t);
  const visual = p.attachments.save(solid(1800, 90, [20, 40, 60]), undefined, { imageOnly: true });   // as post_visual stores it
  p.desk.ensure();
  // A worker's worktree inside the project holds a mockup; a file outside the project is refused.
  const shots = join(dir, '.claude', 'worktrees', 'some-worker', 'shots'); mkdirSync(shots, { recursive: true });
  writeFileSync(join(shots, 'mock.png'), solid(50, 20, [1, 1, 1]));
  writeFileSync(join(root, 'outside.png'), solid(50, 20, [1, 1, 1]));
  const notices = []; p.desk.notice = s => { if (s.startsWith('Decision pictures')) notices.push(s); };
  writeRecord(p.desk.decisionsDir, record(2, { images: [{ from: visual.id, caption: 'Card mockup', option: 'A' }, { from: join(shots, 'mock.png'), caption: 'Gallery' }, { from: join(root, 'outside.png'), caption: 'Outside' }] }));
  const res = p.desk.commitPending('Record drafts from orchestrator');
  assert.ok(res?.commit);
  const wt = p.desk.dir;
  const files = git(wt, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort();
  assert.ok(files.includes('.decisions/images/0002-card-mockup.png'), files.join(', '));
  assert.ok(files.includes('.decisions/images/0002-gallery.png'));
  assert.ok(files.includes('.decisions/0002-d2.json'));
  assert.equal(decodePng(readFileSync(join(p.desk.decisionsDir, 'images', '0002-card-mockup.png'))).width, 1600);
  assert.equal(git(dir, 'status', '--porcelain'), '', 'main folder untouched');
  assert.equal(notices.length, 1, notices.join('\n'));
  assert.match(notices[0], /^Decision pictures: D0002: a picture was left out: outside\.png \(outside the project folder/);
  // The next draft commit does not repeat it.
  writeRecord(p.desk.decisionsDir, record(3));
  p.desk.commitPending('More drafts');
  assert.equal(notices.length, 1);
  // The board hands the pictures to the card, and the hub serves them from the worktree.
  const d = p.board.snapshot().decisions.find(x => x.id === 2);
  assert.deepEqual(d.images, [{ file: 'images/0002-card-mockup.png', caption: 'Card mockup', option: 'A' }, { file: 'images/0002-gallery.png', caption: 'Gallery' }]);
  assert.ok(p.board.imageFile('0002-gallery.png').includes(join('worktrees', 'decisions')));
  assert.equal(p.board.imageFile('../0002-d2.json'), null);
  assert.equal(p.board.imageFile('nope.png'), null);
});

test('the hub: a pick copies pictures a record still names, onto the same commit', t => {
  const { dir, hub, p } = project(t);
  p.desk.ensure();
  const shots = join(dir, '.claude', 'worktrees', 'w', 'shots'); mkdirSync(shots, { recursive: true });
  writeFileSync(join(shots, 'b.png'), solid(30, 30, [0, 90, 0]));
  writeRecord(p.desk.decisionsDir, record(4, { images: [{ from: join(shots, 'b.png'), caption: 'Option B', option: 'B' }] }));
  hub.pickMany(p, [{ id: 4, choice: 'B' }]);
  const wt = p.desk.dir;
  assert.equal(git(wt, 'log', '-1', '--format=%s'), 'Record pick: D0004 B');
  assert.ok(git(wt, 'show', '--name-only', '--format=', 'HEAD').split('\n').includes('.decisions/images/0004-option-b.png'));
  const r = readRecord(p.desk.decisionsDir, 4);
  assert.equal(r.chosen, 'B');
  assert.deepEqual(r.images, [{ file: 'images/0004-option-b.png', caption: 'Option B', option: 'B' }]);
});

test('the card: a pictures button only when there are pictures, with the gallery list on it, escaped', () => {
  assert.equal(picturesButton('crux', { id: 1, title: 'x', images: [] }), '');
  assert.equal(picturesButton('crux', { id: 1, title: 'x' }), '');
  const d = { id: 43, title: 'Where do "pictures" live?', images: [
    { file: 'images/0043-a.png', caption: 'A <b>card</b>', option: 'A' },
    { file: 'images/../../x.png', caption: 'bad' },
    { file: 'images/0043-b.webp', caption: '' }
  ] };
  assert.deepEqual(pictureList('my proj', d), [
    { src: '/p/my%20proj/images/0043-a.png', caption: 'A <b>card</b>', option: 'A' },
    { src: '/p/my%20proj/images/0043-b.webp', caption: '' }
  ]);
  const html = picturesButton('my proj', d);
  assert.match(html, /class="btn ghost pics-btn"/);
  assert.match(html, /title="2 pictures for D0043"/);
  assert.match(html, /<use href="#i-image"\/>/, 'a drawn icon');
  assert.ok(!html.includes('<b>'), 'captions escaped');
  const list = JSON.parse(html.match(/data-pictures="([^"]*)"/)[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
  assert.equal(list.length, 2);
  assert.match(picturesButton('p', { id: 2, images: [{ file: 'images/0002-a.png' }] }), /title="Picture for D0002"/);
});

test('the card hooks in with one call in decisionCard, and the page loads the gallery styles', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /\$\{picturesButton\(p\.name, d\)\}<a href=/);
  assert.match(app, /installPictures\(\)/);
  assert.match(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), /<link rel="stylesheet" href="pictures.css">/);
});
