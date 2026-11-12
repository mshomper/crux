// A picture link with class "zoom" opens its picture larger, over the page, instead of leaving it.
// Closes with a tap anywhere, the close mark, or Escape; focus goes back to the picture that opened it.
// Without this script the link simply opens the picture file. At phone width a link may name a
// phone-shaped picture to show instead (data-phone).
class ZoomBox {
  constructor() {
    this.box = document.createElement('dialog');
    this.box.className = 'zoom-box';
    this.box.setAttribute('aria-label', 'Larger picture');
    this.box.innerHTML = `
      <div class="bar"><p></p><a target="_blank" rel="noopener">Open the file</a>
        <button type="button" autofocus title="Close" aria-label="Close"><svg class="icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="pane"><img alt=""></div>`;
    document.body.append(this.box);
    this.img = this.box.querySelector('img');
    this.note = this.box.querySelector('p');
    this.file = this.box.querySelector('a');
    this.box.querySelector('.pane').addEventListener('click', () => this.box.close());
    this.box.querySelector('button').addEventListener('click', () => this.box.close());
    this.box.addEventListener('close', () => { this.img.removeAttribute('src'); this.from?.focus(); });
    document.addEventListener('click', e => {
      const a = e.target.closest?.('a.zoom');
      if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;   // a new tab, when asked for, stays a new tab
      e.preventDefault();
      this.open(a);
    });
  }

  open(a) {
    const phone = matchMedia('(max-width:860px)').matches;
    const src = (phone && a.dataset.phone) || a.getAttribute('href');
    const shown = a.querySelector('img');
    this.from = a;
    this.img.src = src;
    this.img.alt = shown?.alt || '';
    this.note.textContent = a.closest('figure')?.querySelector('figcaption')?.lastChild?.textContent?.trim() || '';
    this.file.href = src;
    this.box.showModal();
    this.box.querySelector('.pane').scrollTop = 0;
  }
}

if (typeof HTMLDialogElement === 'function') new ZoomBox();
