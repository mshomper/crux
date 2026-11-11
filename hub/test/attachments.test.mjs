// Decision 23 A: images pasted into threads are files under .crux/attachments/, the log carries only references,
// agents receive real image blocks, and only the hub's own page may read them. All in a temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { Attachments, decodeDataUrl, sniffType, userContent, MAX_BYTES, INLINE_BYTES } from '../lib/attachments.mjs';
import { checkAttachmentRead, checkRequest } from '../lib/access.mjs';

// No SDK: start() hands the agent an inbox that records what it would receive.
Agent.prototype.start = function () { this.inbox = { items: [], push(x) { this.items.push(x); } }; this.q = { stub: true }; };

// A real 1x1 PNG, and the starts of the other accepted types.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'crux-hub-att-'));
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
  assert.throws(() => p.attachments.save(Buffer.from('<svg/>'), '"logo.svg"'), /"logo.svg" is not a PNG, JPEG, GIF or WebP image/);
  assert.throws(() => p.attachments.save(Buffer.alloc(0)), /empty/);
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_BYTES)]);
  assert.throws(() => p.attachments.save(big, '"huge.png"'), /"huge.png" is 10 MB; images must be 10 MB or less/);
  // An upload too big is refused from its length, before decoding.
  assert.throws(() => decodeDataUrl('data:image/png;base64,' + 'A'.repeat(Math.ceil(MAX_BYTES * 4 / 3) + 100)), /images must be 10 MB or less/);
  assert.throws(() => decodeDataUrl('hello'), /did not arrive as a picture/);
  assert.deepEqual(decodeDataUrl('data:image/png;base64,' + PNG.toString('base64')).buf, PNG);
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
  assert.throws(() => hub.fromYou(p, 'orchestrator', 'x', Array(7).fill(a.id)), /Up to 6 images/);
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
