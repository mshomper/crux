// Pictures that travel with a decision record (decision 43 A). They live in .decisions/images/NNNN-name.png and are
// listed in the record's "images" field: [{ "file": "images/0043-card.png", "caption": "...", "option": "A" }].
// Agents name a picture with "from": an absolute file path, or the id post_visual returned (a file in the hub's
// .crux/attachments, decision 23). placeImages() copies it in, shrinks PNGs wider than 1600 px, and rewrites the
// entry to its "file". Run by the build script and by the hub before it commits records.
// No dependencies: PNGs are decoded and re-encoded with Node's own zlib. Other kinds are copied as they are.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute, basename, extname } from 'node:path';
import { inflateSync, deflateSync } from 'node:zlib';

export const IMAGE_DIR = 'images';
export const MAX_WIDTH = 1600;                    // wider PNGs are shrunk to this
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;   // anything bigger after shrinking is left out, with a warning
const PLACED = /^images\/[\w.-]+\.(png|jpg|gif|webp)$/;
const ATTACHMENT = /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/;
const pad = n => String(n).padStart(4, '0');
const kb = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

// What kind of picture the bytes are: 'png', 'jpg', 'gif', 'webp', or null.
export function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// An entry that is already in place: { file: "images/..." } and nothing left to copy.
export const isPlaced = img => !!img && typeof img === 'object' && !img.from && PLACED.test(String(img.file || ''));

// The pictures of a record that are in place, as { file, caption, option }: what pages, cards and the .md show.
export function placedImages(d) {
  return (Array.isArray(d?.images) ? d.images : []).filter(isPlaced)
    .map(i => ({ file: i.file, caption: String(i.caption || ''), ...(i.option ? { option: String(i.option) } : {}) }));
}

// Where a not-yet-placed entry's picture comes from: "from", else a "file" or "visual" that is not an images/ name.
function sourceOf(img) {
  if (!img || typeof img !== 'object') return null;
  const s = img.from ?? (PLACED.test(String(img.file || '')) ? null : img.file ?? img.visual);
  return s ? String(s).trim() : null;
}

// A short file-name part from the caption or the source name.
function slugOf(img, src) {
  const base = img.caption || basename(src, extname(src));
  let s = String(base).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > 40) { const cut = s.slice(0, 41).lastIndexOf('-'); s = s.slice(0, cut > 12 ? cut : 40).replace(/-+$/, ''); }   // whole words
  return s || 'picture';
}

// Copy the pictures named in every record of a folder into its images/ folder and rewrite those entries.
// attachments: the hub's .crux/attachments folder, for post_visual ids (or a function giving it, asked only when a
// record names one). Returns { changed: [record files], warnings }.
export function placeImages(dir, { attachments: att = null, maxWidth = MAX_WIDTH, maxBytes = MAX_IMAGE_BYTES } = {}) {
  dir = resolve(dir);
  let asked = false, folder = null;
  const attachmentsDir = () => { if (typeof att !== 'function') return att; if (!asked) { asked = true; folder = att(); } return folder; };
  const changed = [], warnings = [];
  let files;
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { return { changed, warnings }; }
  for (const f of files) {
    let d;
    try { d = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(d?.images) || typeof d.id !== 'number' || !d.images.some(i => sourceOf(i))) continue;
    let dirty = false;
    d.images = d.images.map(img => {
      const src = sourceOf(img);
      if (!src) return img;
      const where = `D${pad(d.id)}`;
      const hubId = ATTACHMENT.test(src), store = hubId ? attachmentsDir() : null;
      const file = hubId ? (store && join(store, src)) : isAbsolute(src) ? src : resolve(dir, src);
      if (!file || !existsSync(file) || !statSync(file).isFile()) {
        warnings.push(`${where}: the picture ${src} was not found${hubId && !store ? ' (a hub picture id; the hub copies those in when it commits the record)' : ''}, so it is not in the record yet.`);
        return img;
      }
      let buf = readFileSync(file);
      const kind = sniffImage(buf);
      if (!kind) { warnings.push(`${where}: ${basename(file)} is not a PNG, JPEG, GIF or WebP picture, so it was left out. Save it as PNG.`); return img; }
      if (kind === 'png') {
        try { const s = shrinkPng(buf, maxWidth); if (s) buf = s.buf; }
        catch (e) { warnings.push(`${where}: ${basename(file)} could not be shrunk (${e.message}); copied as it is.`); }
      }
      if (buf.length > maxBytes) {
        warnings.push(`${where}: ${basename(file)} is ${kb(buf.length)} after shrinking, over the ${kb(maxBytes)} limit for record pictures, so it was left out.`);
        return img;
      }
      const name = freeName(join(dir, IMAGE_DIR), `${pad(d.id)}-${slugOf(img, file)}`, kind === 'jpg' ? 'jpg' : kind, buf);
      mkdirSync(join(dir, IMAGE_DIR), { recursive: true });
      if (!existsSync(join(dir, IMAGE_DIR, name))) writeFileSync(join(dir, IMAGE_DIR, name), buf);
      const { from, visual, file: _f, ...rest } = img;
      dirty = true;
      return { file: `${IMAGE_DIR}/${name}`, caption: String(img.caption || ''), ...(img.option ? { option: String(img.option) } : {}), ...rest };
    });
    if (dirty) { writeFileSync(join(dir, f), JSON.stringify(d, null, 1) + '\n'); changed.push(f); }
  }
  return { changed, warnings };
}

// stem.ext, or stem-2.ext and so on; a file already there with the same bytes is reused.
function freeName(folder, stem, ext, buf) {
  for (let n = 1; ; n++) {
    const name = `${stem}${n > 1 ? '-' + n : ''}.${ext}`;
    const p = join(folder, name);
    if (!existsSync(p)) return name;
    try { if (readFileSync(p).equals(buf)) return name; } catch { }
  }
}

// Records whose pictures are missing or not copied in yet, one line each (the build script's problem list).
export function imageProblems(d, dir, file) {
  const out = [];
  for (const img of Array.isArray(d?.images) ? d.images : []) {
    if (isPlaced(img)) { if (!existsSync(join(dir, img.file))) out.push(`${file} lists ${img.file}, which is missing`); }
    else if (sourceOf(img)) out.push(`${file} lists a picture not copied in yet: ${sourceOf(img)}`);
    else out.push(`${file} has a picture entry without a file`);
  }
  return out;
}

// ---------- PNG shrinking (Node's zlib only) ----------

const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }

// Decode a PNG into 8-bit RGBA. Returns { width, height, rgba }, or null for interlaced files (copied as they are).
export function decodePng(buf) {
  if (sniffImage(buf) !== 'png') throw new Error('not a PNG');
  let pos = 8, ihdr = null, plte = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], ctype: data[9], interlace: data[12] };
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!ihdr) throw new Error('no header');
  const { w, h, depth, ctype, interlace } = ihdr;
  if (interlace) return null;
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!chans || ![1, 2, 4, 8, 16].includes(depth)) throw new Error('unsupported colour type');
  const bits = chans * depth, stride = Math.ceil(w * bits / 8), bpp = Math.max(1, bits >> 3);
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < h * (stride + 1)) throw new Error('image data cut short');
  // Undo the per-row filters in place, into rows of `stride` bytes.
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)], src = y * (stride + 1) + 1, out = y * stride, up = out - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[out + x - bpp] : 0, b = y ? px[up + x] : 0, c = y && x >= bpp ? px[up + x - bpp] : 0;
      let v = raw[src + x];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[out + x] = v & 0xff;
    }
  }
  // Samples to RGBA8.
  const rgba = Buffer.alloc(w * h * 4), max = (1 << Math.min(depth, 8)) - 1;
  const sample = (row, i) => {   // the i-th sample of a row, at its own depth (16-bit gives the high byte)
    if (depth === 8) return px[row + i];
    if (depth === 16) return px[row + i * 2];
    const per = 8 / depth, byte = px[row + Math.floor(i / per)], shift = 8 - depth * (i % per + 1);
    return (byte >> shift) & max;
  };
  const sample16 = (row, i) => depth === 16 ? px.readUInt16BE(row + i * 2) : sample(row, i);
  const toByte = v => depth >= 8 ? v : Math.round(v * 255 / max);
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (ctype === 3) {
        const i = sample(row, x);
        rgba[o] = plte?.[i * 3] ?? 0; rgba[o + 1] = plte?.[i * 3 + 1] ?? 0; rgba[o + 2] = plte?.[i * 3 + 2] ?? 0;
        rgba[o + 3] = trns && i < trns.length ? trns[i] : 255;
      } else if (ctype === 0 || ctype === 4) {
        const g = toByte(sample(row, x * chans));
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
        rgba[o + 3] = ctype === 4 ? sample(row, x * 2 + 1) : trns && trns.length >= 2 && sample16(row, x) === trns.readUInt16BE(0) ? 0 : 255;
      } else {
        rgba[o] = sample(row, x * chans); rgba[o + 1] = sample(row, x * chans + 1); rgba[o + 2] = sample(row, x * chans + 2);
        if (ctype === 6) rgba[o + 3] = sample(row, x * 4 + 3);
        else rgba[o + 3] = trns && trns.length >= 6 && sample16(row, x * 3) === trns.readUInt16BE(0) && sample16(row, x * 3 + 1) === trns.readUInt16BE(2) && sample16(row, x * 3 + 2) === trns.readUInt16BE(4) ? 0 : 255;
      }
    }
  }
  return { width: w, height: h, rgba };
}

// Encode 8-bit RGBA as a PNG: RGB when nothing is see-through, each row with the filter that packs best.
export function encodePng(width, height, rgba) {
  let alpha = false;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { alpha = true; break; }
  const ch = alpha ? 4 : 3, stride = width * ch;
  const rows = Buffer.alloc(height * stride);
  for (let i = 0, o = 0; i < rgba.length; i += 4) { rows[o++] = rgba[i]; rows[o++] = rgba[i + 1]; rows[o++] = rgba[i + 2]; if (alpha) rows[o++] = rgba[i + 3]; }
  const out = Buffer.alloc(height * (stride + 1)), cand = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const cur = y * stride, up = cur - stride;
    let best = 0, bestSum = Infinity;
    for (let ft = 0; ft < 5; ft++) {
      const c = cand[ft];
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const v = rows[cur + x], a = x >= ch ? rows[cur + x - ch] : 0, b = y ? rows[up + x] : 0, cc = y && x >= ch ? rows[up + x - ch] : 0;
        let pred = 0;
        if (ft === 1) pred = a; else if (ft === 2) pred = b; else if (ft === 3) pred = (a + b) >> 1;
        else if (ft === 4) { const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc; }
        const r = (v - pred) & 0xff;
        c[x] = r; sum += r < 128 ? r : 256 - r;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) { bestSum = sum; best = ft; }
    }
    // The best filter's bytes may have been cut short by the early exit: recompute that row in full.
    const c = cand[best];
    for (let x = 0; x < stride; x++) {
      const v = rows[cur + x], a = x >= ch ? rows[cur + x - ch] : 0, b = y ? rows[up + x] : 0, cc = y && x >= ch ? rows[up + x - ch] : 0;
      let pred = 0;
      if (best === 1) pred = a; else if (best === 2) pred = b; else if (best === 3) pred = (a + b) >> 1;
      else if (best === 4) { const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc; }
      c[x] = (v - pred) & 0xff;
    }
    out[y * (stride + 1)] = best;
    c.copy(out, y * (stride + 1) + 1);
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Each output pixel's source pixels and their share (area averaging, for shrinking only).
function spans(src, dst) {
  const s = src / dst, list = [];
  for (let o = 0; o < dst; o++) {
    const a = o * s, b = Math.min(src, a + s), idx = [], wt = [];
    for (let i = Math.floor(a); i < b; i++) { const w = Math.min(b, i + 1) - Math.max(a, i); if (w > 1e-9) { idx.push(i); wt.push(w / (b - a)); } }
    list.push([idx, wt]);
  }
  return list;
}

// Shrink RGBA8 to the given size by averaging areas, with colours weighted by their opacity.
export function shrinkRgba(w, h, rgba, ow, oh) {
  const hs = spans(w, ow), vs = spans(h, oh);
  const tmp = new Float32Array(ow * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < ow; x++) {
      const [idx, wt] = hs[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < idx.length; k++) {
        const i = (y * w + idx[k]) * 4, al = rgba[i + 3] * wt[k];
        r += rgba[i] * al; g += rgba[i + 1] * al; b += rgba[i + 2] * al; a += al;
      }
      const o = (y * ow + x) * 4;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
    }
  }
  const out = Buffer.alloc(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    const [idx, wt] = vs[y];
    for (let x = 0; x < ow; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < idx.length; k++) {
        const i = (idx[k] * ow + x) * 4, f = wt[k];
        r += tmp[i] * f; g += tmp[i + 1] * f; b += tmp[i + 2] * f; a += tmp[i + 3] * f;
      }
      const o = (y * ow + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round(a);
    }
  }
  return out;
}

// A PNG wider than maxWidth, shrunk to it: { buf, width, height }. Null when it is narrow enough or interlaced.
export function shrinkPng(buf, maxWidth = MAX_WIDTH) {
  if (buf.length < 24 || buf.readUInt32BE(16) <= maxWidth) return null;
  const img = decodePng(buf);
  if (!img) return null;
  const ow = maxWidth, oh = Math.max(1, Math.round(img.height * maxWidth / img.width));
  return { buf: encodePng(ow, oh, shrinkRgba(img.width, img.height, img.rgba, ow, oh)), width: ow, height: oh };
}
