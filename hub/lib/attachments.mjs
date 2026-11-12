// Attachments in threads (decision 23 A): files under <project>/.crux/attachments/, named by a hash of their bytes.
// Message events carry only { id, type, size, name? } for each file, never the file itself, so the append-only log
// (decision 2) stays lean. The same file attached twice is stored once.
// Images (PNG, JPEG, GIF, WebP) reach agents as image blocks. Documents (PDF and text-type files) reach them as a
// saved path and the original name; their contents are never put in the prompt.
// What a file is comes from its bytes as well as its name. The stored name is always <hash>.<ext> with an extension
// the hub picks from the detected kind (png, jpg, gif, webp, pdf, txt), never the uploaded name.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const DOC_TYPES = { 'application/pdf': 'pdf', 'text/plain': 'txt' };
export const MAX_BYTES = 10 * 1024 * 1024;          // what the hub accepts per image
export const MAX_DOC_BYTES = 25 * 1024 * 1024;      // per PDF or text file
export const MAX_UPLOAD = MAX_DOC_BYTES;            // the largest file of any kind
export const MAX_PER_MESSAGE = 6;                   // images and documents together
export const NAME_MAX = 120;                        // characters of the original name kept for display
// The model takes images up to 5 MB once base64-encoded (about 3.75 MB of file). Bigger ones are not sent inline;
// the agent is told the file's path, and Claude Code's Read tool shrinks the image for it.
export const INLINE_BYTES = Math.floor(5 * 1024 * 1024 * 3 / 4);

// Text-type files, by name. The bytes must also be text (UTF-8, or UTF-16 with a byte-order mark, no NUL bytes).
// The page keeps the same list (public/conversation.js); a test checks the two agree.
export const TEXT_EXTS = ['txt', 'md', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'log', 'ini', 'toml', 'cfg',
  'js', 'mjs', 'ts', 'py', 'html', 'css', 'sh', 'ps1', 'bat', 'c', 'cpp', 'h', 'rs', 'go', 'java', 'm', 'sql'];
// Office files are refused with a hint at what to export instead.
const OFFICE = {
  docx: 'a Word file; export it to PDF first', doc: 'a Word file; export it to PDF first',
  xlsx: 'an Excel file; save it as CSV or PDF first', xls: 'an Excel file; save it as CSV or PDF first',
  pptx: 'a PowerPoint file; export it to PDF first', ppt: 'a PowerPoint file; export it to PDF first'
};
export const ACCEPTED = 'images (PNG, JPEG, GIF, WebP), PDFs, or text files (.txt, .md, .csv, .json, code and the like)';

const EXTS = [...Object.values(IMAGE_TYPES), ...Object.values(DOC_TYPES)];
const ID = new RegExp(`^[a-f0-9]{32}\\.(${EXTS.join('|')})$`);
const TYPE_OF_EXT = Object.fromEntries([...Object.entries(IMAGE_TYPES), ...Object.entries(DOC_TYPES)].map(([t, e]) => [e, t]));
const mb = n => (n / 1024 / 1024).toFixed(1).replace(/\.0$/, '');
const sizeText = n => n >= 1048576 ? `${mb(n)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const extOf = name => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };

export const isImageType = type => type in IMAGE_TYPES;
// The short word an agent and the page use for a kind of file.
export const kindWord = type => type === 'application/pdf' ? 'PDF' : type === 'text/plain' ? 'text' : 'image';

// What the bytes are, from their first few bytes; the declared type is not trusted.
export function sniffType(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
export const isPdf = buf => buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-';

// Is this text? Returns the UTF-8 bytes to store (UTF-16 is turned into UTF-8 so agents can read it), or a reason.
export function textBytes(buf) {
  const bom16 = buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
  if (bom16) {
    let s;
    try { s = new TextDecoder(buf[0] === 0xff ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(buf); } catch { return { why: 'binary' }; }
    if (s.includes('\u0000')) return { why: 'binary' };
    return { buf: Buffer.from(s, 'utf8') };
  }
  if (buf.includes(0)) return { why: 'binary' };
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return { why: 'encoding' }; }
  return { buf };
}

// The original file name, as display text only: no folders, no control characters, a sensible length (the end,
// with its extension, is kept). Null when nothing is left.
export function cleanName(name) {
  let s = String(name ?? '').split(/[\\/]/).pop();
  s = s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').trim();
  if (!s) return null;
  if (s.length > NAME_MAX) { const tail = s.slice(-24); s = s.slice(0, NAME_MAX - 25) + '…' + tail; }
  return s;
}

// "data:application/pdf;base64,...." -> Buffer. Size is checked from the text length before decoding.
export function decodeDataUrl(dataUrl) {
  const m = /^data:([\w/+.-]*)(;[^,]*)?;base64,/.exec(String(dataUrl || '').slice(0, 200));
  if (!m) throw new Error('The file did not arrive in one piece; attach it again.');
  const b64 = String(dataUrl).slice(m[0].length);
  if (b64.length * 3 / 4 > MAX_UPLOAD + 3) throw new Error(`That file is about ${mb(b64.length * 3 / 4)} MB; PDFs and text files must be ${mb(MAX_DOC_BYTES)} MB or less, images ${mb(MAX_BYTES)} MB.`);
  return { declared: m[1], buf: Buffer.from(b64, 'base64') };
}

export function checkImage(buf, name = 'That file') {
  if (!buf?.length) throw new Error(`${name} is empty.`);
  if (buf.length > MAX_BYTES) throw new Error(`${name} is ${mb(buf.length)} MB; images must be ${mb(MAX_BYTES)} MB or less.`);
  const type = sniffType(buf);
  if (!type) throw new Error(`${name} is not a PNG, JPEG, GIF or WebP image.`);
  return type;
}

// What an upload is, from its bytes and its name. Returns { type, buf } (buf is what to store), or throws a
// plain-words reason. label: how the file is named in that reason.
export function classify(buf, name, label = name ? `"${cleanName(name)}"` : 'That file') {
  if (!buf?.length) throw new Error(`${label} is empty.`);
  const ext = extOf(cleanName(name));
  const image = sniffType(buf);
  if (image) {
    if (buf.length > MAX_BYTES) throw new Error(`${label} is ${mb(buf.length)} MB; images must be ${mb(MAX_BYTES)} MB or less.`);
    return { type: image, buf };
  }
  const big = () => { if (buf.length > MAX_DOC_BYTES) throw new Error(`${label} is ${mb(buf.length)} MB; PDFs and text files must be ${mb(MAX_DOC_BYTES)} MB or less.`); };
  if (OFFICE[ext]) throw new Error(`${label} is ${OFFICE[ext]}, then attach that.`);
  if (isPdf(buf)) { big(); return { type: 'application/pdf', buf }; }
  if (ext === 'svg') throw new Error(`${label} is an SVG picture, which can't be attached; save it as PNG first.`);
  if (TEXT_EXTS.includes(ext)) {
    big();
    const t = textBytes(buf);
    if (t.why === 'binary') throw new Error(`${label} is not really a text file (it holds binary data), so it can't be attached.`);
    if (t.why === 'encoding') throw new Error(`${label} is not saved as UTF-8 text. Save it again as UTF-8 (in Excel: "CSV UTF-8"), then attach it.`);
    return { type: 'text/plain', buf: t.buf };
  }
  throw new Error(`${label} can't be attached. Attach ${ACCEPTED}.`);
}

// Headers for reading an attachment back from /att/. Images show in the hub's own page; documents always download
// (never shown as a page in the hub's origin), as plain text or PDF, with sniffing off and a sandbox on top.
export function servedHeaders(id) {
  const ext = String(id).split('.').pop();
  const type = TYPE_OF_EXT[ext];
  const h = {
    'content-type': type === 'text/plain' ? 'text/plain; charset=utf-8' : type,
    'cache-control': 'private, max-age=31536000, immutable',   // the name is the content's hash
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox"
  };
  if (!isImageType(type)) h['content-disposition'] = 'attachment';
  return h;
}

export class Attachments {
  constructor(projectDir) { this.dir = join(projectDir, '.crux', 'attachments'); }

  static validId(id) { return ID.test(String(id || '')); }

  // Save an upload; returns the reference a message event carries. name: the original file name (display only).
  // imageOnly: for post_visual screenshots, which must be images. label: how errors name the file.
  save(buf, name, { imageOnly = false, label } = {}) {
    const clean = cleanName(name);
    const { type, buf: bytes } = imageOnly ? { type: checkImage(buf, label || (clean ? `"${clean}"` : undefined)), buf } : classify(buf, name, label || (clean ? `"${clean}"` : 'That file'));
    const ext = IMAGE_TYPES[type] || DOC_TYPES[type];
    const id = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${ext}`;
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, id);
    if (!existsSync(file)) writeFileSync(file, bytes);
    return { id, type, size: bytes.length, ...(clean && !imageOnly ? { name: clean } : {}) };
  }

  path(id) {
    if (!Attachments.validId(id)) throw new Error('Not an attachment id');
    return join(this.dir, id);
  }
  has(id) { return Attachments.validId(id) && existsSync(join(this.dir, id)); }
  read(id) { return readFileSync(this.path(id)); }

  // The stored reference for an id the page sent back, checked against the file itself. The name is display text.
  ref(id, name) {
    if (!this.has(id)) throw new Error('An attached file is missing; attach it again.');
    const clean = cleanName(name);
    return { id, type: TYPE_OF_EXT[id.split('.').pop()], size: statSync(this.path(id)).size, ...(clean ? { name: clean } : {}) };
  }
}

// The content of the user message an agent receives: image blocks the model sees, then the text. With no
// attachments it stays a plain string, as before. Every attachment gets a line with its saved path and original
// name; documents are only pointed at, never pasted in. Images too big to send inline are pointed at too.
export function userContent(text, refs = [], store) {
  if (!refs?.length) return text;
  const blocks = [], lines = [];
  const images = refs.filter(r => isImageType(r.type)), docs = refs.filter(r => !isImageType(r.type));
  let shown = 0;
  images.forEach((r, i) => {
    const file = store.path(r.id), label = `Image ${i + 1}${r.name ? ` "${r.name}"` : ''}`;
    if (!existsSync(file)) { lines.push(`${label} is missing from ${file}.`); return; }
    if (r.size > INLINE_BYTES) { lines.push(`${label} is too large to show inline (${mb(r.size)} MB); open it with Read: ${file}`); return; }
    blocks.push({ type: 'image', source: { type: 'base64', media_type: r.type, data: readFileSync(file).toString('base64') } });
    shown++;
    lines.push(`${label}: ${file}`);
  });
  docs.forEach(r => {
    const file = store.path(r.id), kind = r.type === 'application/pdf' ? 'PDF' : 'text file';
    const label = `${kind[0].toUpperCase()}${kind.slice(1)}${r.name ? ` "${r.name}"` : ''} (${sizeText(r.size)})`;
    lines.push(existsSync(file) ? `${label}: ${file}` : `${label} is missing from ${file}.`);
  });
  const parts = [];
  if (images.length) parts.push(`${images.length === 1 ? 'An image is' : `${images.length} images are`} attached${shown ? ' above' : ''}`);
  if (docs.length) parts.push(`${docs.length === 1 ? 'a file is' : `${docs.length} files are`} attached, not shown here; open ${docs.length === 1 ? 'it' : 'them'} from the path with Read`);
  const head = `[${parts.join('; ').replace(/^a/, 'A')}. Saved in ${store.dir}]`;
  blocks.push({ type: 'text', text: [head, ...lines, text].filter(Boolean).join('\n') });
  return blocks;
}
