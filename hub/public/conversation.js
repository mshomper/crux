// One open conversation (decision 39 A): a column with its own header, message list, working line, quick picks and
// message box. There is one per open thread; with nothing pinned there is exactly one, as the hub always had.
// It owns its page parts, its scroll position, its redraw cache, its sending flag, and the typed text and images of
// its thread (kept by the columns, so a draft stays with its thread). What to draw comes from app.js (host).
import { enterAction, insertLineBreak, composerHint } from './composer-keys.js';
import { esc, sizeOf, checkFile, fileChip, MAX_FILES, ACCEPT } from './files.js';
import { patchList, anchorOf, backTo } from './list-patch.js';

const icon = id => `<svg class="icon"><use href="#i-${id}"/></svg>`;

// Files in the message box (decision 23): images, PDFs and text files; paste, drop or pick. They upload when you
// send. Images show as thumbnails, documents as file chips (files.js).

// The list is redrawn only when what it shows changed. Live updates (an agent's activity line, its state) arrive
// many times a minute; rebuilding every message and image for each made the list jump while you typed (phone pass 2).
// When it did change, only the changed messages are swapped (list-patch.js): a whole rebuild sent the iPhone to the
// top of the thread whenever an update arrived (0.17.2).
export function setFeed(feed, html, where = '') {
  const key = `${where}::${html}`;
  if (feed._shown === key) { delete feed.dataset.rebuilt; return false; }
  feed._shown = key;
  patchList(feed, html);
  feed.dataset.rebuilt = '1';
  return true;
}

// A text box grows and shrinks with its text without the list moving (phone pass 2). Measuring collapses the box
// for an instant, which can pull the list's scroll position; it is put back before the screen paints. The list
// only follows when the box really changed height (a line added or removed) and you were at the latest message.
export function growBox(box, max) {
  const feed = box.closest('.conv')?.querySelector('.feed') || { scrollTop: 0, scrollHeight: 0, clientHeight: 0, contains: () => false };
  const top = feed.scrollTop, atBottom = feed.scrollHeight - top - feed.clientHeight < 2;
  const was = box.style.height;
  box.style.height = 'auto';
  const h = Math.min(box.scrollHeight + 2, max) + 'px';
  box.style.height = h;
  box.style.overflowY = box.scrollHeight > max ? 'auto' : 'hidden';
  feed.scrollTop = atBottom && h !== was && !feed.contains(box) ? feed.scrollHeight : top;
  return h !== was;
}

export class Conversation {
  // host: what app.js knows (see Columns); compose: { text, tray } for this thread.
  constructor({ project, thread, template, host, compose }) {
    Object.assign(this, { project, thread, host, compose });
    this.el = template.content.firstElementChild.cloneNode(true);
    this.el.dataset.col = thread;   // not data-thread: that mark means "click to open this thread" across the page
    const q = s => this.el.querySelector(s);
    this.head = q('.main-head'); this.title = q('.c-title'); this.sub = q('.c-sub'); this.badge = q('.c-badge'); this.acts = q('.head-actions');
    this.pinBtn = q('.c-pin'); this.closeBtn = q('.c-close'); this.retireBtn = q('.c-retire'); this.finishBtn = q('.c-retire-finished');
    this.feed = q('.feed'); this.activity = q('.activity');
    this.form = q('.composer'); this.quick = q('.quick'); this.trayEl = q('.tray'); this.errEl = q('.attach-error');
    this.input = q('.c-input'); this.attachBtn = q('.attach'); this.file = q('.c-file');
    this.micBtn = q('.c-mic'); this.voiceBtn = q('.c-voice'); this.voiceLineEl = q('.voice-line');   // voice (decision 61 A)
    this.file.setAttribute('accept', ACCEPT);
    this.sending = false;
    this.justOpened = true;     // the first draw scrolls to the latest message (Needs you: to the top)
    this.top = thread === 'needs';   // reads from the top (the head can say so too: All projects)
    this.atBottom = true;       // following the latest message
    this.saved = null;          // scroll position kept while the column is folded or moved
    this.subHtml = null;
    this.errTimer = 0;
    this.input.value = compose.text || '';
    this.wire();
    this.renderTray();
  }

  wire() {
    const { host } = this;
    this.form.addEventListener('submit', e => { e.preventDefault(); this.submit(); });
    // Enter sends; Alt+Enter and Shift+Enter start a new line (composer-keys.js).
    this.input.addEventListener('keydown', e => {
      const what = enterAction(e);
      if (what === 'native') return;
      e.preventDefault();
      if (what === 'newline') insertLineBreak(e.target);
      else this.form.requestSubmit();
    });
    this.input.addEventListener('input', () => { this.compose.text = this.input.value; this.autosize(); });
    this.input.addEventListener('paste', e => {
      if (this.input.disabled) return;
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) return;
      if (!e.clipboardData.types.includes('text/plain')) e.preventDefault();   // a bare screenshot: no file name text
      this.addFiles(files);
    });
    // Quick replies add their words to the box; Enter sends.
    this.quick.addEventListener('click', e => {
      const c = e.target.closest('[data-quick-text]'); if (!c) return;
      const box = this.input, words = box.value.trim().split(/\s+/).filter(Boolean);
      const w = c.dataset.quickText;
      box.value = (w === 'all' ? ['all'] : words.includes(w) ? words.filter(x => x !== w) : [...words.filter(x => x !== 'all'), w]).join(' ');
      this.compose.text = box.value;
      this.autosize(); host.focusBox(box);
    });
    this.attachBtn.addEventListener('click', () => this.file.click());
    this.micBtn.addEventListener('click', () => host.mic?.(this));
    this.voiceLineEl.querySelector('.vl-cancel').addEventListener('click', () => host.micCancel?.());
    this.file.addEventListener('change', e => { this.addFiles([...e.target.files]); e.target.value = ''; });
    this.trayEl.addEventListener('click', e => {
      const x = e.target.closest('[data-untray]'); if (!x) return;
      const [t] = this.compose.tray.splice(Number(x.dataset.untray), 1);
      if (t?.url) URL.revokeObjectURL(t.url);
      this.renderTray(); host.focusBox(this.input);
    });
    // A touch, wheel or key in the list is you scrolling: a late put-back (settle) then leaves the list to you.
    // So is the list moving by itself somewhere we did not put it (a fling still gliding after the finger lifted).
    // A jump to the very top is not: that is the iPhone's reset, which the late put-back is there to undo.
    this.touched = 0;
    this.wrote = null;          // where settle last put the list
    for (const t of ['touchstart', 'pointerdown', 'wheel', 'keydown']) this.feed.addEventListener(t, () => { this.touched++; }, { passive: true });
    this.feed.addEventListener('scroll', () => {
      const f = this.feed;
      if (this.wrote !== null && f.scrollTop > 1 && Math.abs(f.scrollTop - this.wrote) > 1) this.touched++;
      this.atBottom = f.scrollHeight - f.scrollTop - f.clientHeight < 80;
      host.scrolled(this);
    }, { passive: true });
    // The column you click or type in has the keyboard.
    this.el.addEventListener('pointerdown', () => host.focused(this));
    this.el.addEventListener('focusin', () => host.focused(this));
    this.head.addEventListener('click', e => {
      const b = e.target.closest('[data-c]');
      if (b && !b.disabled) host.action(b.dataset.c, this);
    });
  }

  autosize() { growBox(this.input, 200); }

  // ---------- drawing ----------
  // o: { kb, pinned, multi, narrow (a narrow column beside others), phone, fine }
  render(o) {
    const h = this.host.head(this.thread);   // { title, sub, retire, finish, retired, activity, chips, waiting, noBox, top }
    this.el.classList.toggle('kb', !!o.kb);
    // A list with no one to write to (All projects, decision 42) has no message box; one that reads from the top
    // (Needs you, All projects) opens at its top and stays where you are as cards come and go.
    this.form.hidden = !!h.noBox;
    this.activity.hidden = !!h.noBox;
    this.top = h.top ?? this.thread === 'needs';
    this.title.textContent = h.title;
    if (this.subHtml !== h.sub) { this.subHtml = h.sub; this.sub.innerHTML = h.sub; }
    this.retireBtn.hidden = !h.retire;
    this.finishBtn.hidden = !h.finish;
    // No box to write in (a retired agent, or All projects): drops, pastes and focus never land in it.
    this.input.disabled = !!h.retired || !!h.noBox;
    this.attachBtn.disabled = !!h.retired || !!h.noBox;
    // The hint fits its box on one line (M008 9, phone pass): one word on a phone, the thread's name in a narrow column.
    this.input.placeholder = composerHint({ thread: this.thread, retired: !!h.retired, narrow: o.phone, fine: o.fine, compact: o.narrow });
    this.renderPin(o);
    this.renderVoice(h.voice);
    // A red count in a column's header when a card waits for you in that thread (decision 31), beside other columns.
    const n = o.multi ? h.waiting : 0;
    this.badge.hidden = !n;
    if (n) { this.badge.textContent = n; this.badge.title = `${n} waiting for your call in this thread`; }
    this.renderQuick(h.chips || []);
    this.activity.textContent = h.activity || '';
    this.activity.classList.toggle('on', !!h.activity);
    this.renderFeed();
  }

  renderPin({ pinned, multi }) {
    const b = this.pinBtn;
    b.classList.toggle('on', !!pinned);
    b.setAttribute('aria-pressed', String(!!pinned));
    const tip = pinned ? (multi ? 'Unpin: close this column' : 'Unpin')
      : multi ? 'Pin: keep this column open' : 'Pin: keep this thread open; the next thread you open goes beside it';
    b.title = tip; b.setAttribute('aria-label', tip);
    // A column that is not pinned, beside others, can be closed.
    this.closeBtn.hidden = !!pinned || !multi;
  }

  // Voice (decision 61 A), in the Conductor's column only. v: { on, state, tip, rec, line: { text, cancel, tone } }
  // from app.js, or nothing. The switch is lit cyan when on, with an amber mark on a problem; the mic is red while
  // it is open. Also called by itself every quarter second while recording, for the clock.
  renderVoice(v) {
    this.micBtn.hidden = !v; this.voiceBtn.hidden = !v; this.voiceLineEl.hidden = true;
    if (!v) return;
    const b = this.voiceBtn;
    b.classList.toggle('on', !!v.on);
    b.classList.toggle('warn', v.state === 'problem' || !!v.setupError);
    b.setAttribute('aria-pressed', String(!!v.on));
    if (b.title !== v.tip) { b.title = v.tip; b.setAttribute('aria-label', v.tip.split('\n')[0]); }
    const m = this.micBtn;
    m.classList.toggle('rec', v.rec === 'recording');
    m.classList.toggle('busy', v.rec === 'opening' || v.rec === 'sending');
    m.classList.toggle('speaking', !!v.speaking);
    m.classList.toggle('dim', !v.on || v.state !== 'ready');
    const tip = v.rec === 'recording' ? 'Send: closes the mic and sends what you said' : 'Talk: tap, say it, tap again to send';
    if (m.title !== tip) { m.title = tip; m.setAttribute('aria-label', v.rec === 'recording' ? 'Send what you said' : 'Talk'); }
    const line = v.line || { text: '' };
    this.voiceLineEl.hidden = !line.text;
    this.voiceLineEl.dataset.tone = line.tone || '';
    this.voiceLineEl.querySelector('.vl-text').textContent = line.text;
    this.voiceLineEl.querySelector('.vl-cancel').hidden = !line.cancel;
  }

  renderQuick(chips) {
    const html = chips.map(c => `<button type="button" class="qchip" data-quick-text="${esc(c.text)}" title="${esc(c.tip)}">${esc(c.text)}</button>`).join('');
    if (this.quick.dataset.html !== html) { this.quick.dataset.html = html; this.quick.innerHTML = chips.length ? `<span class="hud-k">Quick</span>${html}` : ''; }
    this.quick.hidden = !chips.length;
  }

  renderFeed() {
    const feed = this.feed, needs = this.top;
    let atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    const saved = this.saved; this.saved = null;
    if (saved) atBottom = saved.bottom;
    // Reading further up (or anywhere in a list read from the top, past its very top): the item at the top of the
    // screen is noted, so the list can be put back exactly there after the redraw. A list not laid out (hidden) is left.
    const following = !needs && atBottom;
    const hold = !this.justOpened && !saved && !following && feed.clientHeight > 0
      ? (needs && feed.scrollTop < 2 ? { el: null, off: 0, top: 0 } : anchorOf(feed)) : null;
    // A card you are answering from the keyboard, or a reply box you are typing in, keeps its focus (M008 14).
    const active = document.activeElement, mine = active && feed.contains(active);
    const focusedCard = mine && active.matches('.card[data-card]') ? active.dataset.card : null;
    const typing = mine && active.matches('.qbox') ? { k: active.dataset.answer, a: active.selectionStart, b: active.selectionEnd } : null;
    const rebuilt = setFeed(feed, this.host.feed(this.thread), `${this.project}::${this.thread}`);
    if (rebuilt) {
      for (const box of feed.querySelectorAll('.qbox')) if (box.value) growBox(box, 140);
      const box = typing && [...feed.querySelectorAll('.qbox')].find(x => x.dataset.answer === typing.k);
      if (box) { box.focus({ preventScroll: true }); box.setSelectionRange(typing.a, typing.b); }
      const card = focusedCard && [...feed.querySelectorAll('.card[data-card]')].find(c => c.dataset.card === focusedCard);
      card?.focus({ preventScroll: true });
    }
    // Needs you reads from the top: it opens there and stays where you are as cards come and go (M008 1).
    // Conversations open at their latest message and follow new ones while you are at the bottom.
    // A thread just opened (or clicked again in the list) goes to its latest message, Needs you to its top; a column
    // back from the rail, or moved, is where you left it.
    // An update that changed the list keeps you where you were: on the latest message (followed, also once its
    // pictures have loaded), or on the item you were reading. The browser is not trusted to do it (the iPhone does not).
    if (this.justOpened) feed.scrollTop = needs ? 0 : feed.scrollHeight;
    else if (saved) feed.scrollTop = saved.bottom && !needs ? feed.scrollHeight : saved.top;
    else if (following) this.settle(() => { if (feed.scrollTop < feed.scrollHeight - feed.clientHeight - 1) feed.scrollTop = feed.scrollHeight; }, rebuilt);
    else if (hold && rebuilt) this.settle(() => backTo(feed, hold), true);
    this.justOpened = false;
  }

  // Do it now, and (when `later`) once more on the next frame and a moment after, unless you have touched the list
  // in between: the iPhone can still move a list once the new part is laid out or its pictures arrive.
  settle(fn, later) {
    const put = () => { fn(); this.wrote = this.feed.scrollTop; };
    put();
    if (!later) return;
    const at = this.touched, again = () => { if (this.touched === at && this.feed.isConnected) put(); };
    globalThis.requestAnimationFrame?.(again);
    setTimeout(again, 250);
  }

  // Before the column leaves the page (folded) or is moved: remember where the list was.
  keepScroll() {
    if (this.saved || !this.el.isConnected) return;
    const f = this.feed;
    this.saved = { top: f.scrollTop, bottom: f.scrollHeight - f.scrollTop - f.clientHeight < 80 };
  }
  detach() { if (!this.el.isConnected) return; this.keepScroll(); this.el.remove(); }
  destroy() { clearTimeout(this.errTimer); this.el.remove(); }

  // The card with this id; in All projects (cards grouped under data-pj, decision 42) only the given project's copy,
  // since two projects can each have a decision 12.
  findCard(card, project) {
    return [...this.feed.querySelectorAll('[data-card]')].find(x => x.dataset.card === card && (!project || (x.closest('[data-pj]')?.dataset.pj ?? project) === project)) || null;
  }

  // ---------- attachments ----------
  attachError(msg) {
    this.errEl.textContent = msg; this.errEl.hidden = !msg;
    clearTimeout(this.errTimer);
    if (msg) this.errTimer = setTimeout(() => { this.errEl.hidden = true; }, 7000);
  }
  // Images in one row of thumbnails that shrink to fit; documents as file chips in an even grid below them.
  renderTray(busy = false) {
    const tray = this.compose.tray;
    this.trayEl.hidden = !tray.length;
    const thumbs = [], chips = [];
    tray.forEach((t, i) => {
      if (t.kind === 'image') thumbs.push(`<div class="tthumb ${busy ? 'busy' : ''}"><img src="${t.url}" alt="${esc(t.file.name || 'Pasted image')}"><span class="tsize">${sizeOf(t.file.size)}</span>
      ${busy ? '' : `<button type="button" class="tx" data-untray="${i}" aria-label="Remove image" title="Remove">${icon('x')}</button>`}</div>`);
      else chips.push(fileChip({ name: t.file.name, size: t.file.size, type: t.kind === 'pdf' ? 'application/pdf' : 'text/plain', remove: i, busy }));
    });
    this.trayEl.classList.toggle('has-docs', chips.length > 0);
    this.trayEl.innerHTML = (thumbs.length ? `<div class="tshots">${thumbs.join('')}</div>` : '') + (chips.length ? `<div class="fchips">${chips.join('')}</div>` : '');
  }
  addFiles(files) {
    const errs = [], tray = this.compose.tray;
    for (const f of files) {
      const c = checkFile(f);
      if (c.error) { errs.push(c.error); continue; }
      if (tray.length >= MAX_FILES) { errs.push(`Up to ${MAX_FILES} attachments per message.`); break; }
      tray.push({ file: f, kind: c.kind, url: c.kind === 'image' ? URL.createObjectURL(f) : '' });
    }
    this.attachError(errs.join(' '));
    this.renderTray();
  }
  clearTray() { for (const t of this.compose.tray.splice(0)) if (t.url) URL.revokeObjectURL(t.url); this.renderTray(); }

  // ---------- sending ----------
  submit() {
    const text = this.input.value.trim(), tray = this.compose.tray;
    if ((!text && !tray.length) || this.sending || !this.host.ready()) return;
    const files = tray.map(t => t.file);
    this.sending = true;
    this.host.act(async () => {
      try {
        if (files.length) this.renderTray(true);
        const r = await this.host.send(this.thread, text, files);
        this.input.value = ''; this.compose.text = ''; this.autosize(); this.clearTray(); this.attachError('');
        this.host.sent(this, r);
      } catch (err) { this.renderTray(); throw err; }
      finally { this.sending = false; }
    });
  }
}
