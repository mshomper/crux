// Images in threads (decision 23 A): files under <project>/.crux/attachments/, named by a hash of their bytes.
// Message events carry only { id, type, size } for each image, never the image itself, so the append-only log
// (decision 2) stays lean. The same file pasted twice is stored once.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const MAX_BYTES = 10 * 1024 * 1024;          // what the hub accepts per image
export const MAX_PER_MESSAGE = 6;
// The model takes images up to 5 MB once base64-encoded (about 3.75 MB of file). Bigger ones are not sent inline;
// the agent is told the file's path, and Claude Code's Read tool shrinks the image for it.
export const INLINE_BYTES = Math.floor(5 * 1024 * 1024 * 3 / 4);

const ID = /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/;
const TYPE_OF_EXT = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([t, e]) => [e, t]));
const mb = n => (n / 1024 / 1024).toFixed(1).replace(/\.0$/, '');

// What the bytes are, from their first few bytes; the declared type is not trusted.
export function sniffType(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// "data:image/png;base64,...." -> Buffer. Size is checked from the text length before decoding.
export function decodeDataUrl(dataUrl) {
  const m = /^data:([\w/+.-]*)(;[^,]*)?;base64,/.exec(String(dataUrl || '').slice(0, 200));
  if (!m) throw new Error('The image did not arrive as a picture file.');
  const b64 = String(dataUrl).slice(m[0].length);
  if (b64.length * 3 / 4 > MAX_BYTES + 3) throw new Error(`That image is about ${mb(b64.length * 3 / 4)} MB; images must be ${mb(MAX_BYTES)} MB or less.`);
  return { declared: m[1], buf: Buffer.from(b64, 'base64') };
}

export function checkImage(buf, name = 'That file') {
  if (!buf?.length) throw new Error(`${name} is empty.`);
  if (buf.length > MAX_BYTES) throw new Error(`${name} is ${mb(buf.length)} MB; images must be ${mb(MAX_BYTES)} MB or less.`);
  const type = sniffType(buf);
  if (!type) throw new Error(`${name} is not a PNG, JPEG, GIF or WebP image.`);
  return type;
}

export class Attachments {
  constructor(projectDir) { this.dir = join(projectDir, '.crux', 'attachments'); }

  static validId(id) { return ID.test(String(id || '')); }

  // Save an image; returns the reference a message event carries.
  save(buf, name) {
    const type = checkImage(buf, name);
    const id = `${createHash('sha256').update(buf).digest('hex').slice(0, 32)}.${IMAGE_TYPES[type]}`;
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, id);
    if (!existsSync(file)) writeFileSync(file, buf);
    return { id, type, size: buf.length };
  }

  path(id) {
    if (!Attachments.validId(id)) throw new Error('Not an attachment id');
    return join(this.dir, id);
  }
  has(id) { return Attachments.validId(id) && existsSync(join(this.dir, id)); }
  read(id) { return readFileSync(this.path(id)); }

  // The stored reference for an id the page sent back, checked against the file itself.
  ref(id) {
    if (!this.has(id)) throw new Error('An attached image is missing; attach it again.');
    return { id, type: TYPE_OF_EXT[id.split('.').pop()], size: statSync(this.path(id)).size };
  }
}

// The content of the user message an agent receives: image blocks the model sees, then the text. With no images
// it stays a plain string, as before. Images too big to send inline become a line pointing at the file.
export function userContent(text, refs = [], store) {
  if (!refs?.length) return text;
  const blocks = [], notes = [];
  refs.forEach((r, i) => {
    const file = store.path(r.id);
    if (!existsSync(file)) { notes.push(`Image ${i + 1} is missing from ${file}.`); return; }
    if (r.size > INLINE_BYTES) { notes.push(`Image ${i + 1} is too large to show inline (${mb(r.size)} MB); open it with Read: ${file}`); return; }
    blocks.push({ type: 'image', source: { type: 'base64', media_type: r.type, data: readFileSync(file).toString('base64') } });
  });
  const head = `[${refs.length === 1 ? 'An image is' : `${refs.length} images are`} attached${blocks.length ? ' above' : ''}. Saved in ${store.dir}]`;
  blocks.push({ type: 'text', text: [head, ...notes, text].filter(Boolean).join('\n') });
  return blocks;
}
