// Attachments on the page (decision 23): what the message box takes, and how a document is drawn as a file chip.
// The hub checks every file again by its bytes (lib/attachments.mjs); this is the quick check before upload, so a
// wrong file is refused at once in plain words. The text list matches the hub's (a test checks).

export const IMG_TYPES = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP' };
export const TEXT_EXTS = ['txt', 'md', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'log', 'ini', 'toml', 'cfg',
  'js', 'mjs', 'ts', 'py', 'html', 'css', 'sh', 'ps1', 'bat', 'c', 'cpp', 'h', 'rs', 'go', 'java', 'm', 'sql'];
export const MAX_IMG = 10 * 1024 * 1024, MAX_DOC = 25 * 1024 * 1024, MAX_FILES = 6;
// What the attach button's file picker offers.
export const ACCEPT = [...Object.keys(IMG_TYPES), 'application/pdf', '.pdf', ...TEXT_EXTS.map(e => '.' + e)].join(',');
const OFFICE = {
  docx: 'a Word file; export it to PDF first', doc: 'a Word file; export it to PDF first',
  xlsx: 'an Excel file; save it as CSV or PDF first', xls: 'an Excel file; save it as CSV or PDF first',
  pptx: 'a PowerPoint file; export it to PDF first', ppt: 'a PowerPoint file; export it to PDF first'
};

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const sizeOf = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
export const extOf = name => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
// A pasted screenshot is called "image.png" by the browser: that name says nothing, so it is not kept.
export const plainName = name => name && !/^image\.\w+$/i.test(name) ? name : '';
const mb = n => (n / 1048576).toFixed(1);

// A file picked, pasted or dropped: { kind: 'image' | 'pdf' | 'text' }, or { error } in plain words.
export function checkFile(f) {
  const ext = extOf(f.name), name = plainName(f.name) ? `"${f.name}"` : 'That file';
  if (IMG_TYPES[f.type]) {
    if (f.size > MAX_IMG) return { error: `${name} is ${mb(f.size)} MB; images must be 10 MB or less.` };
    return { kind: 'image' };
  }
  if (OFFICE[ext]) return { error: `${name} is ${OFFICE[ext]}, then attach that.` };
  if (ext === 'svg' || f.type === 'image/svg+xml') return { error: `${name} is an SVG picture, which can't be attached; save it as PNG first.` };
  const kind = ext === 'pdf' || f.type === 'application/pdf' ? 'pdf' : TEXT_EXTS.includes(ext) ? 'text' : null;
  if (!kind) return { error: `${name} can't be attached. Attach images (PNG, JPEG, GIF, WebP), PDFs, or text files (.txt, .md, .csv, .json, code and the like).` };
  if (!f.size) return { error: `${name} is empty.` };
  if (f.size > MAX_DOC) return { error: `${name} is ${mb(f.size)} MB; PDFs and text files must be 25 MB or less.` };
  return { kind };
}

// A long name is cut in the middle: the start shrinks with an ellipsis, the end (with its extension) always shows.
export function nameParts(name) {
  const s = String(name || '');
  const ext = extOf(s), keep = Math.min(s.length, Math.max(8, ext.length + 6));
  if (s.length <= 16) return { head: s, tail: '' };
  return { head: s.slice(0, s.length - keep), tail: s.slice(s.length - keep) };
}

// The short label under a file's name: its extension (PDF, CSV, MD), else what it is.
export function kindLabel(name, type) {
  const ext = extOf(name);
  if (type === 'application/pdf' || ext === 'pdf') return 'PDF';
  return TEXT_EXTS.includes(ext) ? ext.toUpperCase() : 'TEXT';
}

// A document as a compact chip: a drawn file icon, the name (cut in the middle when long), kind and size.
// href: a sent file, which downloads on click. remove: its index in the tray, for the remove mark.
export function fileChip({ name, size, type, href = '', remove = null, busy = false }) {
  const pdf = type === 'application/pdf' || extOf(name) === 'pdf';
  const label = name || (pdf ? 'document.pdf' : 'text.txt');
  const { head, tail } = nameParts(label);
  const inner = `<svg class="icon ficon" aria-hidden="true"><use href="#i-file-${pdf ? 'pdf' : 'text'}"/></svg>`
    + `<span class="fmeta"><span class="fname"><span class="fhead">${esc(head)}</span>${tail ? `<span class="ftail">${esc(tail)}</span>` : ''}</span>`
    + `<span class="fsize">${kindLabel(label, type)} · ${sizeOf(size || 0)}</span></span>`;
  const cls = `fchip ${pdf ? 'pdf' : 'text'}${busy ? ' busy' : ''}`;
  if (href) return `<a class="${cls}" href="${esc(href)}" download="${esc(label)}" title="Download ${esc(label)}">${inner}</a>`;
  const x = remove == null || busy ? '' : `<button type="button" class="tx" data-untray="${remove}" aria-label="Remove ${esc(label)}" title="Remove">`
    + `<svg class="icon"><use href="#i-x"/></svg></button>`;
  return `<div class="${cls}" title="${esc(label)}">${inner}${x}</div>`;
}
