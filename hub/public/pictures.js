// Decision 43: a decision card's pictures. The card gets a small pictures button (drawn icon, hover label, count);
// it opens a gallery you page through, with captions and an exit. Kept to this one module so the card code
// (app.js decisionCard) only adds picturesButton() to its foot.
// A record lists its pictures as { file: "images/NNNN-name.png", caption, option? }; the hub serves them at
// /p/<project>/images/<name>.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = id => `<svg class="icon"><use href="#i-${id}"/></svg>`;
const SAFE = /^images\/[\w-][\w.-]*\.(png|jpg|gif|webp)$/;

// The gallery's list for a decision: { src, caption, option } for each picture in place.
export function pictureList(projectName, d) {
  return (Array.isArray(d?.images) ? d.images : []).filter(i => SAFE.test(String(i?.file || '')))
    .map(i => ({ src: `/p/${encodeURIComponent(projectName)}/${i.file}`, caption: String(i.caption || ''), ...(i.option ? { option: String(i.option) } : {}) }));
}

// The button for a card's foot, or '' when the decision has no pictures. The list rides along on the button.
export function picturesButton(projectName, d) {
  const list = pictureList(projectName, d);
  if (!list.length) return '';
  const label = `${list.length === 1 ? 'Picture' : `${list.length} pictures`} for D${String(d.id).padStart(4, '0')}`;
  return `<button type="button" class="btn ghost pics-btn" data-pictures="${esc(JSON.stringify(list))}" data-pictures-title="${esc(`D${String(d.id).padStart(4, '0')} · ${d.title || ''}`)}" title="${esc(label)}" aria-label="${esc(label)}">${icon('image')}<span class="pics-n">${list.length}</span></button>`;
}

// A question card's pictures (the ones its summary listed): a wrapping grid of thumbnails, two to a row on a phone,
// never a sideways row. Tapping one opens the gallery at that picture. items: { src, caption } for a picture,
// { href, caption } for a page (opens in its own tab). The sources are the hub's own: /att/, /media/ or /p/.
export function thumbGrid(items, title = '') {
  const pics = items.filter(i => i.src), list = JSON.stringify(pics.map(i => ({ src: i.src, caption: i.caption || '' })));
  let n = -1;
  const tiles = items.map(i => i.src
    ? `<button type="button" class="qthumb" data-pic-i="${++n}" title="${esc(i.caption || 'Open larger')}" aria-label="${esc(`Open picture: ${i.caption || n + 1}`)}"><img src="${esc(i.src)}" alt="${esc(i.caption || '')}" loading="lazy"><span class="qcap">${esc(i.caption || '')}</span></button>`
    : `<a class="qthumb page" href="${esc(i.href)}" target="_blank" rel="noopener" title="Open this page in a new tab">${icon('page')}<span class="qcap">${esc(i.caption || 'Page')}</span></a>`).join('');
  return items.length ? `<div class="qpics" data-pictures="${esc(list)}" data-pictures-title="${esc(title)}">${tiles}</div>` : '';
}

// The thumbnails for the visuals a summary listed (post_visual ids), found among the project's events. An id with no
// visual event still shows when it has the shape of a stored screenshot (32 hex digits and an image extension).
// A picture its agent posted in the same round (same thread, after the thread's previous summary, before this one)
// shows too, even when the summary forgot to list it: the question is about what was just shown.
export function summaryPictureItems(projectName, summary, events) {
  const base = encodeURIComponent(projectName), evs = events || [];
  const at = evs.findIndex(e => e?.id && e.id === summary?.id);
  let from = -1;
  for (let i = at - 1; at > 0 && i >= 0; i--) if (evs[i]?.type === 'summary' && evs[i].thread === summary.thread) { from = i; break; }
  const round = at > 0 ? evs.slice(from + 1, at).filter(e => e?.type === 'visual' && e.thread === summary.thread).map(e => e.visual) : [];
  const ids = [...new Set([...(Array.isArray(summary?.visuals) ? summary.visuals : []), ...round])];
  return ids.map(id => {
    const v = (events || []).find(e => e?.type === 'visual' && e.visual === id);
    const shot = v?.attachment?.id || (!v && /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/.test(String(id)) ? id : '');
    if (shot) return { src: `/att/${base}/${encodeURIComponent(shot)}`, caption: v?.caption || '' };
    if (!v) return null;
    const src = `/media/${base}/${encodeURIComponent(v.visual)}`;
    return v.kind === 'page' ? { href: src, caption: v.caption || '' } : { src, caption: v.caption || '' };
  }).filter(Boolean);
}

// The gallery: one dialog for the page, made on first use.
export class Gallery {
  constructor(doc = document) { this.doc = doc; this.list = []; this.at = 0; this.el = null; }

  build() {
    const d = this.doc.createElement('dialog');
    d.className = 'viewer gallery';
    d.setAttribute('aria-label', 'Pictures');
    d.innerHTML = `<div class="viewer-bar">
        <span class="viewer-cap gal-title"></span>
        <span class="gal-count" aria-live="polite"></span>
        <button type="button" class="btn ghost icon-only" data-gal="close" aria-label="Close" title="Close">${icon('x')}</button>
      </div>
      <div class="gal-stage">
        <button type="button" class="gal-nav prev" data-gal="prev" aria-label="Previous picture" title="Previous picture">${icon('back')}</button>
        <img class="gal-img" alt="">
        <button type="button" class="gal-nav next" data-gal="next" aria-label="Next picture" title="Next picture">${icon('back')}</button>
      </div>
      <div class="gal-foot"><span class="gal-opt"></span><span class="gal-cap"></span></div>`;
    d.addEventListener('click', e => {
      const b = e.target.closest('[data-gal]');
      if (b) return b.dataset.gal === 'close' ? d.close() : this.go(b.dataset.gal === 'next' ? 1 : -1);
      if (e.target === d) d.close();   // a click on the backdrop
    });
    d.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight') { e.preventDefault(); this.go(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(-1); }
    });
    // A swipe across the picture pages too.
    let x0 = null;
    d.addEventListener('pointerdown', e => { if (e.target.closest('.gal-stage') && !e.target.closest('button')) x0 = e.clientX; });
    d.addEventListener('pointerup', e => { if (x0 == null) return; const dx = e.clientX - x0; x0 = null; if (Math.abs(dx) > 40) this.go(dx < 0 ? 1 : -1); });
    d.addEventListener('close', () => { d.querySelector('.gal-img').removeAttribute('src'); this.opener?.focus?.({ preventScroll: true }); });
    this.doc.body.appendChild(d);
    this.el = d;
  }

  open(list, title = '', start = 0, opener = null) {
    if (!list?.length) return;
    if (!this.el) this.build();
    Object.assign(this, { list, at: Math.max(0, Math.min(start, list.length - 1)), opener });
    this.el.querySelector('.gal-title').textContent = title;
    this.el.classList.toggle('single', list.length === 1);
    this.show();
    if (!this.el.open) this.el.showModal();
    this.el.querySelector(list.length > 1 ? '[data-gal="next"]' : '[data-gal="close"]').focus({ preventScroll: true });
  }

  go(step) {
    if (this.list.length < 2) return;
    this.at = (this.at + step + this.list.length) % this.list.length;
    this.show();
  }

  show() {
    const p = this.list[this.at], q = s => this.el.querySelector(s);
    q('.gal-img').src = p.src;
    q('.gal-img').alt = p.caption || `Picture ${this.at + 1}`;
    q('.gal-cap').textContent = p.caption || '';
    q('.gal-opt').textContent = p.option ? `Option ${p.option}` : '';
    q('.gal-opt').hidden = !p.option;
    q('.gal-count').textContent = this.list.length > 1 ? `${this.at + 1} of ${this.list.length}` : '';
  }
}

// One listener for every pictures button, wherever the card is (a column, Needs you, the board's panel).
export function installPictures(doc = document) {
  const gallery = new Gallery(doc);
  doc.addEventListener('click', e => {
    const b = e.target.closest?.('[data-pictures]');
    if (!b) return;
    const tile = e.target.closest('[data-pic-i]');   // a question card's thumbnail: open at that one
    if (b.classList.contains('qpics') && !tile) return;   // the gaps and page links do nothing here
    e.preventDefault();
    let list = [];
    try { list = JSON.parse(b.dataset.pictures); } catch { }
    gallery.open(list.filter(p => typeof p?.src === 'string' && /^\/(p|att|media)\//.test(p.src)), b.dataset.picturesTitle || '', Number(tile?.dataset.picI) || 0, tile || b);
  });
  return gallery;
}
