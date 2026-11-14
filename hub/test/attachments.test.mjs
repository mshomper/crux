// Decision 23 A: images pasted into threads are files under .crux/attachments/, the log carries only references,
// agents receive real image blocks, and only the hub's own page may read them. All in a temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { Attachments, decodeDataUrl, sniffType, userContent, servedHeaders, cleanName, MAX_BYTES, MAX_DOC_BYTES, INLINE_BYTES, TEXT_EXTS, NAME_MAX } from '../lib/attachments.mjs';
import { checkAttachmentRead, checkRequest } from '../lib/access.mjs';

// No SDK: start() hands the agent an inbox that records what it would receive.
Agent.prototype.start = function () { this.inbox = { items: [], push(x) { this.items.push(x); } }; this.q = { stub: true }; };

// A real 1x1 PNG, and the starts of the other accepted types.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

function setup() {
  const root = makeTmp('crux-hub-att-');
  const dir = join(root, 'proj');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'crux')), agentHome: join(root, 'home') });
  return { hub, p: hub.project('proj'), root, dir };
}

test('types are read from the bytes, not the name', () => {
  assert.equal(sniffType(PNG), 'image/png');
  assert.equal(sniffType(JPEG), 'image/jpeg');
  assert.equal(sniffType(GIF), 'image/gif');
  assert.equal(sniffType(WEBP), 'image/webp');
  assert.equal(sniffType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffType(Buffer.from('%PDF-1.7')), null);
});

test('storage: content-hash names under .crux/attachments, stored once', () => {
  const { p, dir } = setup();
  const a = p.attachments.save(PNG);
  assert.match(a.id, /^[a-f0-9]{32}\.png$/);
  assert.deepEqual(a, { id: a.id, type: 'image/png', size: PNG.length });
  assert.ok(existsSync(join(dir, '.crux', 'attachments', a.id)));
  assert.deepEqual(readFileSync(join(dir, '.crux', 'attachments', a.id)), PNG);
  assert.equal(p.attachments.save(Buffer.from(PNG)).id, a.id, 'same bytes, same file');
  assert.equal(readdirSync(join(dir, '.crux', 'attachments')).length, 1);
  assert.equal(p.attachments.save(JPEG).id.endsWith('.jpg'), true);
  assert.equal(p.attachments.save(GIF).id.endsWith('.gif'), true);
  assert.equal(p.attachments.save(WEBP).id.endsWith('.webp'), true);
});

test('wrong type and oversize are refused with plain words', () => {
  const { p } = setup();
  assert.throws(() => p.attachments.save(Buffer.from('<svg/>'), 'logo.svg'), /"logo.svg" is an SVG picture, which can't be attached; save it as PNG/);
  assert.throws(() => p.attachments.save(Buffer.alloc(0)), /empty/);
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_BYTES)]);
  assert.throws(() => p.attachments.save(big, 'huge.png'), /"huge.png" is 10 MB; images must be 10 MB or less/);
  // An upload too big for any kind is refused from its length, before decoding.
  assert.throws(() => decodeDataUrl('data:application/pdf;base64,' + 'A'.repeat(Math.ceil(MAX_DOC_BYTES * 4 / 3) + 100)), /PDFs and text files must be 25 MB or less, images 10 MB/);
  assert.throws(() => decodeDataUrl('hello'), /did not arrive in one piece/);
  assert.deepEqual(decodeDataUrl('data:image/png;base64,' + PNG.toString('base64')).buf, PNG);
});

// ---------- documents: PDFs and text-type files ----------
const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
const CSV = Buffer.from('part,load_N,ok\nstem,2300,yes\ncup,1800,yes\n');

test('PDFs are known by their header, text by its bytes and name', () => {
  const { p, dir } = setup();
  const pdf = p.attachments.save(PDF, 'Report Q3.pdf');
  assert.match(pdf.id, /^[a-f0-9]{32}\.pdf$/);
  assert.deepEqual(pdf, { id: pdf.id, type: 'application/pdf', size: PDF.length, name: 'Report Q3.pdf' });
  // A PDF with the wrong name is still a PDF: the bytes decide.
  assert.equal(p.attachments.save(PDF, 'scan.bin').type, 'application/pdf');
  const csv = p.attachments.save(CSV, 'loads.csv');
  assert.match(csv.id, /^[a-f0-9]{32}\.txt$/, 'text is stored as .txt, whatever its name');
  assert.equal(csv.type, 'text/plain');
  assert.deepEqual(readFileSync(join(dir, '.crux', 'attachments', csv.id)), CSV);
  for (const ext of TEXT_EXTS) assert.equal(p.attachments.save(Buffer.from(`hello ${ext} é ✓\n`), `x.${ext}`).type, 'text/plain', ext);
  // Upper-case extensions count too.
  assert.equal(p.attachments.save(CSV, 'LOADS.CSV').type, 'text/plain');
});

test('an HTML file is kept as plain text, never as a page', () => {
  const { p } = setup();
  const html = Buffer.from('<!doctype html><script>alert(document.cookie)</script><svg onload="alert(1)"></svg>');
  const ref = p.attachments.save(html, 'evil.html');
  assert.match(ref.id, /\.txt$/);
  assert.equal(ref.type, 'text/plain');
  const h = servedHeaders(ref.id);
  assert.equal(h['content-type'], 'text/plain; charset=utf-8');
  assert.equal(h['content-disposition'], 'attachment');
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.match(h['content-security-policy'], /sandbox/);
  assert.match(h['content-security-policy'], /default-src 'none'/);
});

test('served headers: images show, documents download, never html or svg', () => {
  const { p } = setup();
  const ids = [p.attachments.save(PNG).id, p.attachments.save(JPEG).id, p.attachments.save(PDF, 'a.pdf').id, p.attachments.save(CSV, 'a.csv').id];
  const [png, jpg, pdf, txt] = ids.map(servedHeaders);
  assert.equal(png['content-type'], 'image/png'); assert.ok(!png['content-disposition']);
  assert.equal(jpg['content-type'], 'image/jpeg'); assert.ok(!jpg['content-disposition']);
  assert.equal(pdf['content-type'], 'application/pdf'); assert.equal(pdf['content-disposition'], 'attachment');
  assert.equal(txt['content-type'], 'text/plain; charset=utf-8'); assert.equal(txt['content-disposition'], 'attachment');
  for (const h of [png, jpg, pdf, txt]) {
    assert.equal(h['x-content-type-options'], 'nosniff');
    assert.equal(h['cross-origin-resource-policy'], 'same-origin');
    assert.doesNotMatch(h['content-type'], /html|svg/);
  }
  // No stored id can ever be html or svg: the id rule only knows the hub's own extensions.
  for (const ext of ['html', 'htm', 'svg', 'xml', 'csv', 'js']) assert.ok(!Attachments.validId('a'.repeat(32) + '.' + ext), ext);
});

test('refused: binary renamed .txt, Office files, SVG, unknown kinds, oversize PDFs, non-UTF-8 text', () => {
  const { p } = setup();
  const binary = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]);   // the start of a .exe
  assert.throws(() => p.attachments.save(binary, 'notes.txt'), /"notes.txt" is not really a text file \(it holds binary data\)/);
  // PNG bytes named .txt are an image (the bytes decide); a zip named .txt is binary.
  assert.equal(p.attachments.save(PNG, 'shot.txt').type, 'image/png');
  const zip = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(20)]);
  assert.throws(() => p.attachments.save(zip, 'report.txt'), /not really a text file/);
  assert.throws(() => p.attachments.save(zip, 'report.docx'), /"report.docx" is a Word file; export it to PDF first/);
  assert.throws(() => p.attachments.save(zip, 'loads.xlsx'), /"loads.xlsx" is an Excel file; save it as CSV or PDF first/);
  assert.throws(() => p.attachments.save(zip, 'deck.pptx'), /"deck.pptx" is a PowerPoint file; export it to PDF first/);
  assert.throws(() => p.attachments.save(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'logo.svg'), /SVG picture/);
  assert.throws(() => p.attachments.save(zip, 'archive.zip'), /"archive.zip" can't be attached\. Attach images \(PNG, JPEG, GIF, WebP\), PDFs, or text files/);
  assert.throws(() => p.attachments.save(Buffer.from('plain words'), 'README'), /can't be attached/, 'text with no known extension');
  assert.throws(() => p.attachments.save(Buffer.from('plain words')), /"?That file"? can't be attached/);
  const bigPdf = Buffer.concat([PDF, Buffer.alloc(MAX_DOC_BYTES)]);
  assert.throws(() => p.attachments.save(bigPdf, 'big.pdf'), /"big.pdf" is 25 MB; PDFs and text files must be 25 MB or less/);
  const latin1 = Buffer.from('name,city\nJos\xe9,M\xfcnchen\n', 'latin1');
  assert.throws(() => p.attachments.save(latin1, 'excel.csv'), /not saved as UTF-8 text.*CSV UTF-8/);
  // A text file a little over 10 MB is fine: the image limit is not the document limit.
  assert.equal(p.attachments.save(Buffer.alloc(MAX_BYTES + 10, 'a'), 'big.log').type, 'text/plain');
});

test('UTF-16 text with a byte-order mark is accepted and stored as UTF-8', () => {
  const { p } = setup();
  const words = 'part,load\nstem,2300 N ✓\n';
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(words, 'utf16le')]);
  const be = Buffer.from(le); be.swap16();   // FE FF, then big-endian
  for (const [buf, name] of [[le, 'le.csv'], [be, 'be.txt']]) {
    const ref = p.attachments.save(buf, name);
    assert.equal(ref.type, 'text/plain', name);
    assert.equal(p.attachments.read(ref.id).toString('utf8'), words, name);
  }
  // UTF-16 without a byte-order mark has NUL bytes: refused as binary.
  assert.throws(() => p.attachments.save(Buffer.from(words, 'utf16le'), 'nobom.txt'), /binary/);
});

test('original names are display text only: no folders, no control characters, a sensible length', () => {
  assert.equal(cleanName('C:\\Users\\me\\Desktop\\loads.csv'), 'loads.csv');
  assert.equal(cleanName('../../etc/passwd.txt'), 'passwd.txt');
  assert.equal(cleanName('a\u0000b\nc\u202e.txt'), 'abc.txt');
  assert.equal(cleanName('   spaced    out .md '), 'spaced out .md');
  assert.equal(cleanName('...hidden.txt'), 'hidden.txt');
  assert.equal(cleanName(''), null);
  assert.equal(cleanName('///'), null);
  assert.equal(cleanName(undefined), null);
  const long = 'x'.repeat(300) + '-final-report.pdf';
  const c = cleanName(long);
  assert.equal(c.length, NAME_MAX);
  assert.ok(c.endsWith('-final-report.pdf'), 'the end and its extension are kept');
  assert.ok(c.includes('…'));
  // The stored path never uses the name.
  const { p } = setup();
  const ref = p.attachments.save(CSV, '..\\..\\events.jsonl.csv');
  assert.equal(ref.name, 'events.jsonl.csv');
  assert.match(p.attachments.path(ref.id), /attachments[\\/][a-f0-9]{32}\.txt$/);
});

test('the agent gets each file\'s saved path, name and kind, never the contents', () => {
  const { hub, p } = setup();
  const img = p.attachments.save(PNG, 'chart.png'), pdf = p.attachments.save(PDF, 'Report Q3.pdf'), csv = p.attachments.save(CSV, 'loads.csv');
  hub.fromYou(p, 'orchestrator', 'Check these', [{ id: img.id, name: img.name }, { id: pdf.id, name: pdf.name }, { id: csv.id, name: 'loads.csv' }]);
  const ev = p.log.events.findLast(e => e.type === 'message' && e.from === 'you');
  assert.deepEqual(ev.attachments.map(a => [a.type, a.name]), [['image/png', 'chart.png'], ['application/pdf', 'Report Q3.pdf'], ['text/plain', 'loads.csv']]);
  const content = p.orchestrator().inbox.items.at(-1).message.content;
  assert.deepEqual(content.map(b => b.type), ['image', 'text'], 'only the image is a block');
  const t = content[1].text;
  assert.match(t, /^\[An image is attached above; 2 files are attached, not shown here; open them from the path with Read\. Saved in /);
  assert.ok(t.includes(`Image 1 "chart.png": ${p.attachments.path(img.id)}`));
  assert.ok(t.includes(`PDF "Report Q3.pdf" (1 KB): ${p.attachments.path(pdf.id)}`));
  assert.ok(t.includes(`Text file "loads.csv" (1 KB): ${p.attachments.path(csv.id)}`));
  assert.ok(!t.includes('stem,2300'), 'the CSV is not pasted in');
  assert.ok(!t.includes('%PDF'), 'nor the PDF');
  assert.match(t, /Check these$/);
  // A document alone: no image blocks, one text block.
  const only = userContent('', [p.attachments.ref(pdf.id, 'a.pdf')], p.attachments);
  assert.equal(only.length, 1);
  assert.match(only[0].text, /^\[A file is attached, not shown here; open it from the path with Read\./);
  // The event log never holds the contents either.
  const line = readFileSync(join(p.dir, '.crux', 'events.jsonl'), 'utf8');
  assert.ok(!line.includes('stem,2300') && !line.includes('%PDF'));
});

test('at most 6 attachments per message, images and documents together', () => {
  const { hub, p } = setup();
  const docs = [0, 1, 2, 3].map(i => p.attachments.save(Buffer.from(`row ${i}\n`), `f${i}.csv`));
  const imgs = [p.attachments.save(PNG), p.attachments.save(JPEG), p.attachments.save(GIF)];
  const six = [...docs.map(d => ({ id: d.id, name: d.name })), imgs[0].id, imgs[1].id];
  hub.fromYou(p, 'orchestrator', 'six', six);
  assert.equal(p.log.events.findLast(e => e.type === 'message' && e.from === 'you').attachments.length, 6);
  assert.throws(() => hub.fromYou(p, 'orchestrator', 'seven', [...six, imgs[2].id]), /Up to 6 attachments per message/);
});

test('ids are checked, so a path cannot escape the folder', () => {
  const { p } = setup();
  for (const bad of ['../events.jsonl', '..\\x.png', 'abc.png', 'a'.repeat(32) + '.svg', 'a'.repeat(32) + '.png/../../x']) {
    assert.ok(!Attachments.validId(bad), bad);
    assert.throws(() => p.attachments.path(bad));
  }
  assert.throws(() => p.attachments.ref('a'.repeat(32) + '.png'), /missing/);
});

test('the message event carries ids, type and size only, never image data', () => {
  const { hub, p, dir } = setup();
  const a = p.attachments.save(PNG);
  hub.fromYou(p, 'orchestrator', 'What is wrong here?', [a.id]);
  const ev = p.log.events.findLast(e => e.type === 'message' && e.from === 'you');
  assert.deepEqual(ev.attachments, [{ id: a.id, type: 'image/png', size: PNG.length }]);
  const line = readFileSync(join(dir, '.crux', 'events.jsonl'), 'utf8');
  assert.ok(!line.includes(PNG.toString('base64')), 'no base64 in the log');
  assert.ok(!line.includes('base64'));
  // A plain message keeps its old shape.
  hub.fromYou(p, 'orchestrator', 'No pictures');
  assert.ok(!('attachments' in p.log.events.findLast(e => e.type === 'message' && e.from === 'you')));
  assert.throws(() => hub.fromYou(p, 'orchestrator', 'x', ['f'.repeat(32) + '.png']), /missing/);
  assert.throws(() => hub.fromYou(p, 'orchestrator', 'x', Array(7).fill(a.id)), /Up to 6 attachments/);
});

test('the agent receives image content blocks, then the text', () => {
  const { hub, p } = setup();
  const a = p.attachments.save(PNG), j = p.attachments.save(JPEG);
  hub.fromYou(p, 'orchestrator', 'Compare these', [a.id, j.id]);
  const orch = p.orchestrator();
  const msg = orch.inbox.items.at(-1);
  assert.equal(msg.type, 'user');
  assert.equal(msg.message.role, 'user');
  const [b1, b2, t] = msg.message.content;
  assert.deepEqual(b1, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } });
  assert.equal(b2.source.media_type, 'image/jpeg');
  assert.equal(t.type, 'text');
  assert.match(t.text, /2 images are attached above/);
  assert.match(t.text, /Compare these$/);
  // Without images the content stays a string, as before.
  assert.equal(orch.userMessage('Hello').message.content, 'Hello');
  // An image with no words still reaches the agent.
  assert.equal(orch.userMessage('', [p.attachments.ref(a.id)]).message.content[0].type, 'image');
});

test('an image too big to send inline points the agent at the file instead', () => {
  const { p } = setup();
  const big = Buffer.concat([PNG, Buffer.alloc(INLINE_BYTES)]);
  const ref = p.attachments.save(big);
  const content = userContent('See this', [ref], p.attachments);
  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /too large to show inline/);
  assert.ok(content[0].text.includes(p.attachments.path(ref.id)));
});

test('a restart re-delivers your images too', () => {
  const { hub, p } = setup();
  const a = p.attachments.save(PNG);
  p.log.append('message', { thread: 'orchestrator', from: 'you', text: 'Look', attachments: [p.attachments.ref(a.id)] });
  hub.redeliver(p);
  assert.equal(p.orchestrator().inbox.items.at(-1).message.content[0].type, 'image');
});

test('post_visual screenshots use the same store; pages stay sandboxed in media', () => {
  const { hub, p, root } = setup();
  const agent = hub.ensureOrchestrator(p);
  const png = join(root, 'shot.png'); writeFileSync(png, PNG);
  const ev = hub.postVisual(p, agent, png, 'The thread');
  assert.equal(ev.kind, 'image');
  assert.deepEqual(ev.attachment, { id: ev.visual, type: 'image/png', size: PNG.length });
  assert.ok(p.attachments.has(ev.visual));
  const html = join(root, 'page.html'); writeFileSync(html, '<p>hi</p>');
  const pe = hub.postVisual(p, agent, html, 'A page');
  assert.equal(pe.kind, 'page');
  assert.ok(!pe.attachment);
  const fake = join(root, 'fake.png'); writeFileSync(fake, 'not really');
  assert.throws(() => hub.postVisual(p, agent, fake, 'x'), /not a PNG/);
});

test('only the hub’s own page may read images', () => {
  const host = 'localhost:4747', ts = 'pc.tail1.ts.net';
  // The hub's own page, on this machine and through tailscale serve.
  assert.equal(checkAttachmentRead({ host, 'sec-fetch-site': 'same-origin' }), null);
  assert.equal(checkAttachmentRead({ host: ts, 'sec-fetch-site': 'same-origin' }), null);
  assert.equal(checkAttachmentRead({ host, origin: 'http://localhost:4747' }), null);
  assert.equal(checkAttachmentRead({ host }), null, 'opened directly (no fetch metadata)');
  // Other sites, and the sandboxed visual pages (origin null), are refused.
  assert.ok(checkAttachmentRead({ host, 'sec-fetch-site': 'cross-site' }));
  assert.ok(checkAttachmentRead({ host, 'sec-fetch-site': 'same-site' }));
  assert.ok(checkAttachmentRead({ host, origin: 'https://evil.example' }));
  assert.ok(checkAttachmentRead({ host, origin: 'null' }));
  assert.ok(checkAttachmentRead({ host, origin: `https://${ts}` }), 'another hub address is a different origin');
  // And the Host rule still applies first (DNS rebinding).
  assert.ok(checkRequest({ method: 'GET', path: '/att/proj/x.png', headers: { host: 'evil.example' } }));
  // Uploads are changes: JSON from the hub's own origin only.
  assert.ok(checkRequest({ method: 'POST', path: '/api/attach', headers: { host, origin: 'https://evil.example', 'content-type': 'application/json' } }));
  assert.ok(checkRequest({ method: 'POST', path: '/api/attach', headers: { host, 'content-type': 'multipart/form-data' } }));
  assert.equal(checkRequest({ method: 'POST', path: '/api/attach', headers: { host, origin: 'http://localhost:4747', 'content-type': 'application/json' } }), null);
});
