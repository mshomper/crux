// PDFs and text files in threads (hub 0.12.1): the page's quick check before upload, the file chip it draws, and the
// page's words. The hub's own check by bytes is in attachments.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkFile, fileChip, nameParts, kindLabel, ACCEPT, TEXT_EXTS as PAGE_EXTS, MAX_FILES } from '../public/files.js';
import { TEXT_EXTS, MAX_PER_MESSAGE } from '../lib/attachments.mjs';

const file = (name, type = '', size = 100) => ({ name, type, size });
const MB = 1024 * 1024;

test('the page and the hub accept the same text files and the same count', () => {
  assert.deepEqual(PAGE_EXTS, TEXT_EXTS);
  assert.equal(MAX_FILES, MAX_PER_MESSAGE);
  for (const e of ['.pdf', '.csv', '.md', '.json', '.py', '.m', 'image/png', 'application/pdf']) assert.ok(ACCEPT.split(',').includes(e), e);
  assert.ok(!ACCEPT.includes('svg') && !ACCEPT.includes('docx'));
});

test('the quick check: images, PDFs and text files in; the rest out, in plain words', () => {
  assert.deepEqual(checkFile(file('shot.png', 'image/png')), { kind: 'image' });
  assert.deepEqual(checkFile(file('Report.PDF', '')), { kind: 'pdf' });
  assert.deepEqual(checkFile(file('loads.csv', 'application/vnd.ms-excel')), { kind: 'text' }, 'Windows calls CSV an Excel type');
  assert.deepEqual(checkFile(file('notes.md', '')), { kind: 'text' });
  assert.deepEqual(checkFile(file('page.html', 'text/html')), { kind: 'text' }, 'HTML is accepted as text');
  assert.match(checkFile(file('a.docx')).error, /"a.docx" is a Word file; export it to PDF first/);
  assert.match(checkFile(file('a.xlsx')).error, /Excel file; save it as CSV or PDF/);
  assert.match(checkFile(file('a.pptx')).error, /PowerPoint file; export it to PDF/);
  assert.match(checkFile(file('logo.svg', 'image/svg+xml')).error, /SVG picture/);
  assert.match(checkFile(file('tool.exe')).error, /can't be attached\. Attach images \(PNG, JPEG, GIF, WebP\), PDFs, or text files/);
  assert.match(checkFile(file('big.pdf', 'application/pdf', 26 * MB)).error, /"big.pdf" is 26\.0 MB; PDFs and text files must be 25 MB or less/);
  assert.match(checkFile(file('big.png', 'image/png', 11 * MB)).error, /images must be 10 MB or less/);
  assert.deepEqual(checkFile(file('eleven.log', '', 11 * MB)), { kind: 'text' }, 'documents have their own, larger limit');
  assert.match(checkFile(file('empty.txt', '', 0)).error, /empty/);
  assert.match(checkFile(file('image.png', 'image/gif', 11 * MB)).error, /^That file is/, 'a pasted screenshot has no useful name');
});

test('a long name is cut in the middle and keeps its extension', () => {
  assert.deepEqual(nameParts('short.csv'), { head: 'short.csv', tail: '' });
  const { head, tail } = nameParts('quarterly-implant-load-report-final.pdf');
  assert.equal(head + tail, 'quarterly-implant-load-report-final.pdf');
  assert.ok(tail.endsWith('.pdf') && tail.length >= 8);
  assert.equal(kindLabel('loads.csv', 'text/plain'), 'CSV');
  assert.equal(kindLabel('x.bin', 'application/pdf'), 'PDF');
  assert.equal(kindLabel('', 'text/plain'), 'TEXT');
});

test('file chips: drawn icon, escaped name, size; tray chips have a remove mark, sent ones download', () => {
  const tray = fileChip({ name: '<b>x</b>.csv', size: 2048, type: 'text/plain', remove: 3 });
  assert.match(tray, /<svg class="icon ficon"[^>]*><use href="#i-file-text"\/><\/svg>/);
  assert.ok(!tray.includes('<b>'), 'names are escaped');
  assert.match(tray, /data-untray="3"/);
  assert.match(tray, /CSV · 2 KB/);
  assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(tray), 'no emoji');
  const sent = fileChip({ name: 'Report Q3.pdf', size: 3 * MB, type: 'application/pdf', href: '/att/demo/abc.pdf' });
  assert.match(sent, /^<a class="fchip pdf" href="\/att\/demo\/abc.pdf" download="Report Q3.pdf"/);
  assert.match(sent, /#i-file-pdf/);
  assert.match(sent, /PDF · 3\.0 MB/);
  assert.ok(!sent.includes('data-untray'));
  // While sending, no remove mark.
  assert.ok(!fileChip({ name: 'a.txt', size: 1, type: 'text/plain', remove: 0, busy: true }).includes('data-untray'));
});

test('the page says files, not only images, and draws both file icons', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /Drop images, PDFs or text files to attach/);
  assert.ok(!/Drop images to attach/.test(html));
  assert.match(html, /aria-label="Attach files"/);
  assert.match(html, /<symbol id="i-file-text"/);
  assert.match(html, /<symbol id="i-file-pdf"/);
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.ok(!/\.tray\{[^}]*flex-wrap:wrap/.test(css), 'the tray does not wrap its thumbnails');
  assert.match(css, /\.fhead\{[^}]*text-overflow:ellipsis/);
});
