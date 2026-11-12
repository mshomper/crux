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
    e.preventDefault();
    let list = [];
    try { list = JSON.parse(b.dataset.pictures); } catch { }
    gallery.open(list.filter(p => typeof p?.src === 'string' && p.src.startsWith('/p/')), b.dataset.picturesTitle || '', 0, b);
  });
  return gallery;
}
