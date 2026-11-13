// Decision 50 B: a decision card's brief. The card gets a brief button (drawn icon, hover label); it opens a pop-up
// that reads like an article: the answer first, what changes for you, each option with its pictures beside it, the
// scores side by side, why, and the background folded at the end. Pick or close at its foot. Records written before
// decision 50 have no brief: the same layout is built from their fields, opening with the recommendation.
// The brief loads on request from /api/brief (the board's state stays small). Kept to this module, like pictures.js,
// so the card code (app.js decisionCard) only adds briefButton() to its foot.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = id => `<svg class="icon"><use href="#i-${id}"/></svg>`;
const pad = n => String(n).padStart(4, '0');
const SAFE_IMG = /^images\/[\w-][\w.-]*\.(png|jpg|gif|webp)$/;
const SAFE_SKETCH = /^data:image\/svg\+xml;charset=utf-8,[^"'<>\s]*$/;
const KIND = { schematic: 'Schematic', screenshot: 'Screenshot', mockup: 'Mockup', chart: 'Chart' };
const FOR_YOU = { change: ['eye', ''], setup: ['setup', 'Setup: '], undo: ['warn', 'Hard to undo: '] };
const CONF = { strong: 'strong', lean: 'lean', 'toss-up': 'toss-up' };

// The button for a card's foot. The project rides along, so it is right in All projects too.
export function briefButton(projectName, d) {
  if (!d || !(d.options || []).length) return '';
  const label = `Read the brief for D${pad(d.id)}`;
  return `<button type="button" class="btn brief-btn" data-brief="${esc(d.id)}" data-brief-pj="${esc(projectName)}" data-brief-title="${esc(d.title || '')}" title="${esc(label)}" aria-label="${esc(label)}">${icon('brief')}</button>`;
}

const dots = n => `<span class="bf-dots" aria-label="${n} of 3">${[1, 2, 3].map(k => `<i class="${k <= n ? 'on' : ''}"></i>`).join('')}</span>`;

// The pop-up's parts for one brief: { head, body, foot }, as HTML. Plain function, so tests run it.
export function briefHtml(projectName, b) {
  const pj = encodeURIComponent(projectName);
  const opts = b.options || [], keys = new Set(opts.map(o => o.key));
  const open = b.status === 'open', found = b.status === 'found', decided = b.status === 'decided' && b.chosen;
  const rec = opts.find(o => o.key === b.recommended);
  const pics = (b.images || []).filter(i => SAFE_IMG.test(String(i?.file || '')));
  const src = i => `/p/${pj}/${i.file}`;
  const fig = i => `<figure class="bf-fig"><button type="button" class="bf-shot" data-view="${esc(src(i))}" data-view-name="${esc(i.file.split('/').pop())}" data-view-cap="${esc(i.caption || '')}" title="Open the picture full size" aria-label="Open the picture full size"><img src="${esc(src(i))}" alt="${esc(i.caption || 'Picture')}" loading="lazy"></button>
    ${i.caption || i.kind ? `<figcaption>${i.kind ? `<b>${KIND[i.kind]}</b>` : ''}${esc(i.caption || '')}</figcaption>` : ''}</figure>`;
  const sketch = o => SAFE_SKETCH.test(o.sketch || '') ? `<figure class="bf-fig"><img class="bf-sketch" src="${esc(o.sketch)}" alt="Sketch of option ${esc(o.key)}"><figcaption><b>Sketch</b></figcaption></figure>` : '';

  const head = `<span class="bf-k"><i>// </i>Brief · D${pad(b.id)}</span>${open || found ? '<span class="chip bf-call">Your call</span>' : `<span class="chip ${esc(b.status)}">${esc(b.status)}${decided ? ' · ' + esc(b.chosen) : ''}</span>`}
    <span class="spacer"></span>
    ${b.page ? `<a class="btn ghost icon-only" href="/p/${pj}/${esc(b.page)}" target="_blank" rel="noopener" title="Open the full record page" aria-label="Open the full record page">${icon('page')}</a>` : ''}
    <button type="button" class="btn ghost icon-only" data-brief-close title="Close" aria-label="Close">${icon('x')}</button>`;

  let body = `<h2 class="bf-title">${esc(b.title)}</h2><p class="bf-meta">${[b.date, b.mode && `${b.mode} mode`].filter(Boolean).map(esc).join(' · ')}</p>`;
  if (decided) { const co = opts.find(o => o.key === b.chosen); body += `<p class="bf-picked">${icon('check')}<span>You picked <b>${esc(b.chosen)}${co ? ': ' + esc(co.name) : ''}</b>.${b.reason ? ' ' + esc(b.reason) : ''}</span></p>`; }
  if (b.written) body += `<p class="bf-lead">${esc(b.lead)}</p>`;
  else {
    if (rec) body += `<p class="bf-lead built"><b>Recommended: ${esc(rec.key)}, ${esc(rec.name)}</b>${b.confidence ? ` (${esc(CONF[b.confidence] || b.confidence)})` : ''}. ${esc(b.recommendation)}</p>`;
    body += `<p class="bf-note">${icon('help')}<span>No brief was written for this decision, so this is laid out from its record.</span></p>`;
  }
  if ((b.for_you || []).length) body += `<section class="bf-sec"><div class="bf-sk">What changes for you</div><ul class="bf-for">${b.for_you.map(x => { const [ic, pre] = FOR_YOU[x.kind] || FOR_YOU.change; return `<li class="${esc(x.kind)}">${icon(ic)}<span>${pre ? `<b>${pre}</b>` : ''}${esc(x.text)}</span></li>`; }).join('')}</ul></section>`;
  const shared = pics.filter(i => !keys.has(i.option));
  if (shared.length) body += `<section class="bf-sec"><div class="bf-sk">Pictures</div><div class="bf-figs wide">${shared.map(fig).join('')}</div></section>`;
  body += `<section class="bf-sec"><div class="bf-sk">The options</div>${opts.map(o => {
    const own = pics.filter(i => i.option === o.key), figs = own.length ? own.map(fig).join('') : sketch(o);
    const isRec = o.key === b.recommended, isCh = decided && o.key === b.chosen;
    return `<article class="bf-opt ${isRec ? 'rec' : ''} ${isCh ? 'chosen' : ''}">
      <div class="bf-ohead"><span class="bf-hex">${esc(o.key)}</span><h3>${esc(o.name)}</h3>${isRec ? `<span class="chip rec">${icon('star')}recommended${b.confidence ? ' · ' + esc(CONF[b.confidence] || b.confidence) : ''}</span>` : ''}${isCh ? `<span class="chip decided">${icon('check')}chosen</span>` : ''}</div>
      <div class="bf-obody ${figs ? '' : 'nofig'}">${figs ? `<div class="bf-figs">${figs}</div>` : ''}
        <div class="bf-otext">${o.summary ? `<p>${esc(o.summary)}</p>` : ''}
          ${(o.pros || []).length || (o.cons || []).length ? `<ul class="bf-pc">${(o.pros || []).map(p => `<li class="pro">${icon('check')}<span>${esc(p)}</span></li>`).join('')}${(o.cons || []).map(c => `<li class="con">${icon('minus')}<span>${esc(c)}</span></li>`).join('')}</ul>` : ''}
          ${o.effort ? `<p class="bf-eff"><b>Work</b>${esc(o.effort)}</p>` : ''}</div></div>
    </article>`;
  }).join('')}</section>`;
  const crit = (b.criteria || []).filter(c => opts.some(o => c.scores?.[o.key]));
  if (crit.length) body += `<section class="bf-sec"><div class="bf-sk">Side by side</div><table class="bf-cmp"><thead><tr><th></th>${opts.map(o => `<th class="s ${o.key === b.recommended ? 'rec' : ''}">${esc(o.key)}</th>`).join('')}</tr></thead>
    <tbody>${crit.map(c => `<tr><td>${esc(c.name)}${c.note ? `<span class="bf-cnote">${esc(c.note)}</span>` : ''}</td>${opts.map(o => `<td class="s">${c.scores[o.key] ? dots(c.scores[o.key]) : ''}</td>`).join('')}</tr>`).join('')}</tbody></table></section>`;
  const why = b.written && b.recommendation;
  if (why || b.change_mind) body += `<section class="bf-sec"><div class="bf-sk">${rec ? `Why ${esc(rec.key)}` : 'Why'}</div>${why ? `<p class="bf-why">${esc(b.recommendation)}</p>` : ''}${b.change_mind ? `<p class="bf-flip">${icon('warn')}<span>What would change this: ${esc(b.change_mind)}</span></p>` : ''}</section>`;
  if (b.context) body += `<details class="bf-bg"><summary>${icon('chev')}<span>Background and history</span>${(b.depends_on || []).length ? `<span class="bf-refs">${b.depends_on.map(n => 'D' + pad(n)).join(' · ')}</span>` : ''}</summary><p>${esc(b.context)}</p></details>`;

  const others = opts.filter(o => o.key !== b.recommended);
  const foot = open
    ? `${rec ? `<button type="button" class="btn primary" data-pick="${esc(b.id)}" data-choice="${esc(rec.key)}">${icon('check')}Take ${esc(rec.key)}</button>` : ''}
      ${others.map(o => `<button type="button" class="btn bf-alt" data-pick="${esc(b.id)}" data-choice="${esc(o.key)}" title="Pick ${esc(o.key)}: ${esc(o.name)}" aria-label="Pick ${esc(o.key)}: ${esc(o.name)}"><span class="bf-hex">${esc(o.key)}</span><span class="bf-alt-name">${esc(o.name)}</span></button>`).join('')}
      <span class="spacer"></span><button type="button" class="btn ghost" data-brief-close>Close</button>`
    : found
      ? `<button type="button" class="btn good" data-pick="${esc(b.id)}" data-choice="confirm">${icon('check')}Confirm</button><button type="button" class="btn" data-pick="${esc(b.id)}" data-choice="reject">${icon('x')}Reject</button><span class="spacer"></span><button type="button" class="btn ghost" data-brief-close>Close</button>`
      : `<span class="spacer"></span><button type="button" class="btn ghost" data-brief-close>Close</button>`;
  return { head, body, foot };
}

// The pop-up: one dialog for the page, made on first use. load(project, id) returns the brief (a promise).
export class Brief {
  constructor(doc = document, load) { this.doc = doc; this.load = load; this.el = null; this.asked = 0; }

  build() {
    const d = this.doc.createElement('dialog');
    d.className = 'brief-pop';
    d.setAttribute('aria-label', 'Decision brief');
    d.innerHTML = `<header class="bf-head"></header><div class="bf-body" tabindex="-1"></div><footer class="bf-foot"></footer>`;
    d.addEventListener('click', e => {
      if (e.target === d || e.target.closest('[data-brief-close]')) return d.close();   // the backdrop, the X, Close
      // A pick: the pop-up closes and the hub's own pick handler (app.js) takes the click from here.
      if (e.target.closest('[data-pick]')) d.close();
    });
    d.addEventListener('close', () => { this.asked++; this.opener?.focus?.({ preventScroll: true }); });
    this.doc.body.appendChild(d);
    this.el = d;
  }

  async open(projectName, id, title = '', opener = null) {
    if (!this.el) this.build();
    const ask = ++this.asked, d = this.el, q = s => d.querySelector(s);
    this.opener = opener;
    d.dataset.pj = projectName;   // picks go to the card's own project (all-projects.js projectOf)
    q('.bf-head').innerHTML = `<span class="bf-k"><i>// </i>Brief · D${pad(id)}</span><span class="spacer"></span><button type="button" class="btn ghost icon-only" data-brief-close title="Close" aria-label="Close">${icon('x')}</button>`;
    q('.bf-body').innerHTML = `<h2 class="bf-title">${esc(title)}</h2><p class="bf-wait">Loading the brief…</p>`;
    q('.bf-foot').innerHTML = `<span class="spacer"></span><button type="button" class="btn ghost" data-brief-close>Close</button>`;
    if (!d.open) d.showModal();
    q('[data-brief-close]').focus({ preventScroll: true });
    let b;
    try { b = await this.load(projectName, id); }
    catch (e) { if (ask === this.asked) q('.bf-body').innerHTML = `<h2 class="bf-title">${esc(title)}</h2><p class="bf-wait">${icon('warn')}The brief could not be loaded: ${esc(e.message)}</p>`; return; }
    if (ask !== this.asked || !d.open) return;   // closed, or another brief asked for since
    const h = briefHtml(projectName, b);
    q('.bf-head').innerHTML = h.head; q('.bf-body').innerHTML = h.body; q('.bf-foot').innerHTML = h.foot;
    q('.bf-body').scrollTop = 0;
    (q('.bf-foot .btn.primary') || q('.bf-head [data-brief-close]')).focus({ preventScroll: true });
  }
}

// One listener for every brief button, wherever the card is (a column, Needs you, All projects, the board's panel).
export function installBrief(doc = document, load) {
  const brief = new Brief(doc, load);
  doc.addEventListener('click', e => {
    const b = e.target.closest?.('[data-brief]');
    if (!b) return;
    e.preventDefault();
    brief.open(b.dataset.briefPj || '', b.dataset.brief, b.dataset.briefTitle || '', b);
  });
  return brief;
}
