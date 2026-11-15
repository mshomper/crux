// Plan v3, A10 (decision 66 A): the one card that lists everything Matt has told the hub to trust: sites (pages, or
// downloads into a quarantine folder) and approved packages. Opened from the project settings card. Each row says what it
// is, who added it, when and for which project, and has a remove button. Adding is here, or from the "Always allow"
// buttons on a permission card (app.js); both go through the same checked server routes.
//   listsCard(view, d)   the card's HTML (a plain function, so it can be tested without a browser)
//   addBody(kind, d, p)  what the add form sends
//   ListsCard            the pop-up: host: { api(path, body), toast(msg), reload() }
// No new toggles: pages / downloads and the scope are two-choice segments, like the settings card's.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (id, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const help = tip => `<span class="ps-help" title="${esc(tip)}" aria-label="${esc(tip)}" role="img">${ic('help')}</span>`;
const ECO = { npm: 'npm', pip: 'pip', huggingface: 'Hugging Face' };
const when = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); };
const who = e => e.by === 'seed' ? 'Starting list' : `Added by ${e.by}`;

const tip = {
  sites: 'Agents read these pages, or save files from them into a quarantine folder in temp, without asking. Running a downloaded file always comes to you.',
  pages: 'Pages: agents may read these pages. Nothing is saved.',
  downloads: 'Downloads: agents may also save files from this site into the quarantine folder in temp, never over an existing file and never into the project. Moving a file out of it, or running it, comes to you.',
  packages: 'Agents may install these by exact name from the main registry, with install scripts off. A release under 3 days old, or a new major version, still comes to you.',
  open: 'This site serves anyone\'s files, so downloads are limited to the one path shown.',
  add: 'Only you can add to these lists. Adding asks you to confirm it is you.',
  revision: 'A model is approved at one revision (a full 40-character commit). Agents may fetch weights and plain text files of exactly that revision; another revision, or a config file, comes to you.'
};

function siteRow(e, d) {
  const arm = d.arm === e.id;
  const sub = [e.subdomains ? 'and its subdomains' : 'this address only', e.pin ? `only ${e.pin}` : ''].filter(Boolean).join(' · ');
  const access = e.access === 'downloads'
    ? `<span class="pl-tag dl" title="${esc(tip.downloads)}">${ic('download')}Downloads</span>`
    : `<span class="pl-tag" title="${esc(tip.pages)}">${ic('eye')}Pages</span>`;
  const canDl = e.access === 'pages' && (!e.open || e.pin);
  const act = arm
    ? `<span class="pl-confirm"><span class="pl-q">Let agents download from it?</span><button type="button" class="btn primary pl-yes" data-pl-access="downloads" data-id="${esc(e.id)}" title="Allow downloads into the quarantine folder">${ic('check')}Allow</button><button type="button" class="btn ghost pl-no" data-pl-cancel title="Keep it pages only">${ic('x')}Cancel</button></span>`
    : `${canDl ? `<button type="button" class="pl-btn" data-pl-arm="${esc(e.id)}" title="Let agents download files from ${esc(e.host)} into the quarantine folder (asks you to confirm)" aria-label="Allow downloads from ${esc(e.host)}">${ic('download')}</button>` : ''}${e.access === 'downloads' ? `<button type="button" class="pl-btn" data-pl-access="pages" data-id="${esc(e.id)}" title="Back to pages only" aria-label="Back to pages only for ${esc(e.host)}">${ic('eye')}</button>` : ''}`;
  return `<li class="pl-row ${arm ? 'armed' : ''}" data-id="${esc(e.id)}">
    <span class="pl-ico">${ic('globe')}</span>
    <span class="pl-main"><b class="pl-name">${esc(e.host)}</b><span class="pl-sub">${esc(sub)}${e.open && !e.pin ? ` <span class="pl-warn" title="${esc(tip.open)}">${ic('warn')}</span>` : ''}</span></span>
    <span class="pl-acts">${access}${act}<button type="button" class="pl-btn rm" data-pl-remove="${esc(e.id)}" title="Remove ${esc(e.host)} from the list" aria-label="Remove ${esc(e.host)}">${ic('trash')}</button></span>
    <span class="pl-meta">${esc(e.scopeName)} · ${esc(who(e))}${e.at ? ` · ${esc(when(e.at))}` : ''}</span>
  </li>`;
}
function pkgRow(e) {
  const base = e.revision ? ` · revision ${e.revision.slice(0, 12)}` : e.baseMajor != null ? ` · from version ${e.baseMajor}.${e.baseMajor === 0 && e.baseMinor != null ? `${e.baseMinor}.` : ''}x` : '';
  return `<li class="pl-row single" data-id="${esc(e.id)}">
    <span class="pl-ico">${ic('box')}</span>
    <span class="pl-main"><b class="pl-name">${esc(e.name)}</b><span class="pl-sub">${esc(ECO[e.eco] || e.eco)}${esc(base)}</span></span>
    <span class="pl-acts"><button type="button" class="pl-btn rm" data-pl-remove="${esc(e.id)}" title="Remove ${esc(e.name)} from the list" aria-label="Remove ${esc(e.name)}">${ic('trash')}</button></span>
    <span class="pl-meta">${esc(e.scopeName)} · ${esc(who(e))}${e.at ? ` · ${esc(when(e.at))}` : ''}</span>
  </li>`;
}
const seg = (name, value, opts) => `<span class="ps-seg" role="radiogroup" aria-label="${esc(name)}">${opts.map(([v, label, t]) => `<button type="button" role="radio" aria-checked="${value === v}" class="${value === v ? 'on' : ''}" data-pl-seg="${name}" data-v="${v}" title="${esc(t || label)}">${esc(label)}</button>`).join('')}</span>`;
const scopeSeg = (name, v, project) => seg(name, v, [['all', 'Every project', 'Applies in every project'], ['project', 'This project', `Applies in ${project} only`]]);

export function listsCard(view, d) {
  const sites = view.sites || [], pkgs = view.packages || [];
  const f = d.form;
  return `<header class="ps-head">${ic('shield')}<h2 id="ps-title">Trusted sites and packages</h2>
    <button type="button" class="ps-x" data-ps-close aria-label="Close" title="Close">${ic('x')}</button></header>
  <div class="ps-body pl-body">
    ${d.error ? `<p class="pl-error" role="alert">${ic('warn')}<span>${esc(d.error)}</span></p>` : ''}
    <section class="ps-sec"><h3 class="ps-sec-head">Sites <span class="ps-n">${sites.length}</span> ${help(tip.sites)}</h3>
      ${sites.length ? `<ul class="pl-list">${sites.map(e => siteRow(e, d)).join('')}</ul>` : '<p class="pl-empty">No sites yet. Pages not on this list come to the orchestrator first.</p>'}
      <details class="pl-add" ${d.open.site ? 'open' : ''} data-pl-fold="site"><summary>${ic('plus')}<span>Add a site</span>${help(tip.add)}</summary>
        <div class="pl-form">
          <label class="pl-field"><span>Site</span><input type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="fda.gov" data-pl-in="site.host" value="${esc(f.site.host)}"></label>
          <div class="pl-field"><span>Agents may</span>${seg('site.access', f.site.access, [['pages', 'Read pages', tip.pages], ['downloads', 'Also download', tip.downloads]])}</div>
          ${f.site.access === 'downloads' ? `<label class="pl-field"><span>Only this path ${help(tip.open)}</span><input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="/owner/repo (needed for sites that serve anyone's files)" data-pl-in="site.pin" value="${esc(f.site.pin)}"></label>` : ''}
          <div class="pl-field"><span>Where</span>${scopeSeg('site.scope', f.site.scope, view.project)}</div>
          <button type="button" class="btn primary pl-submit" data-pl-add="site" ${d.busy ? 'disabled' : ''}>${ic('plus')}Add site</button>
        </div></details></section>
    <section class="ps-sec ps-last"><h3 class="ps-sec-head">Packages <span class="ps-n">${pkgs.length}</span> ${help(tip.packages)}</h3>
      ${pkgs.length ? `<ul class="pl-list">${pkgs.map(pkgRow).join('')}</ul>` : '<p class="pl-empty">No packages yet. Installs come to the orchestrator first.</p>'}
      <details class="pl-add" ${d.open.pkg ? 'open' : ''} data-pl-fold="pkg"><summary>${ic('plus')}<span>Add a package</span>${help(tip.add)}</summary>
        <div class="pl-form">
          <div class="pl-field"><span>From</span>${seg('pkg.eco', f.pkg.eco, [['npm', 'npm', 'JavaScript packages from the npm registry'], ['pip', 'pip', 'Python packages from PyPI, installed only in the project\'s .venv'], ['huggingface', 'Hugging Face', 'Models by name, with a pinned revision, safetensors files only']])}</div>
          <label class="pl-field"><span>Exact name</span><input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${f.pkg.eco === 'huggingface' ? 'organisation/model' : f.pkg.eco === 'pip' ? 'requests' : 'zod'}" data-pl-in="pkg.name" value="${esc(f.pkg.name)}"></label>
          ${f.pkg.eco === 'huggingface' ? `<label class="pl-field"><span>Revision ${help(tip.revision)}</span><input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="the full 40-character commit" data-pl-in="pkg.revision" value="${esc(f.pkg.revision)}"></label>` : ''}
          <div class="pl-field"><span>Where</span>${scopeSeg('pkg.scope', f.pkg.scope, view.project)}</div>
          <button type="button" class="btn primary pl-submit" data-pl-add="pkg" ${d.busy ? 'disabled' : ''}>${ic('plus')}Add package</button>
        </div></details></section>
  </div>
  <footer class="ps-foot"><p class="ps-note">Saved on this computer, not in the repo. A release under ${esc(view.minAgeDays ?? 3)} days old or a new major version always comes to you.</p></footer>`;
}

// The "Always allow this site / package" buttons for a request's listable offers (lib/permission-lists.mjs suggest()),
// on Matt's permission cards and on the one-line audit entries of single allows. Adding asks him to confirm it is him.
export function listAddButtons(items, cls = 'always-btn list-add') {
  return (items || []).slice(0, 3).map(it => {
    const site = it.kind === 'site';
    const what = site ? `${it.host}${it.pin || ''}` : it.name;
    const label = site ? (it.access === 'downloads' ? 'Always allow downloads from this site' : 'Always allow this site') : 'Always allow this package';
    const t = site
      ? `Adds ${what} to your trusted sites for every project (${it.access === 'downloads' ? 'downloads into a quarantine folder in temp; running a file still comes to you' : 'pages only'}). Asks you to confirm it is you. Remove it any time on the project's settings card.`
      : `Adds ${what} (${ECO[it.eco] || it.eco}) to this project's approved packages: exact name, main registry, install scripts off. A release under 3 days old or a new major version still comes to you. Asks you to confirm it is you.`;
    return `<button type="button" class="${cls}" data-list-add="${esc(JSON.stringify(it))}" title="${esc(t)}" aria-label="${esc(`${label}: ${what}`)}">${ic('check')}<span>${label}</span> <span class="always-rule">${esc(what)}</span></button>`;
  }).join('');
}
// The request the page sends for one such offer.
export const listAddBody = (project, it) => it.kind === 'site'
  ? { project, kind: 'site', host: it.host, access: it.access, pin: it.pin || '', scope: 'all', subdomains: false }
  : { project, kind: 'package', eco: it.eco, name: it.name, scope: 'project', ...(it.revision ? { revision: it.revision } : {}) };

// What the add form sends for the project p. kind: 'site' | 'pkg'.
export function addBody(kind, d, project) {
  const f = d.form[kind];
  if (kind === 'site') return { project, kind: 'site', host: String(f.host).trim(), access: f.access, pin: f.access === 'downloads' ? String(f.pin).trim() : '', scope: f.scope };
  return { project, kind: 'package', eco: f.eco, name: String(f.name).trim(), scope: f.scope, ...(f.eco === 'huggingface' ? { revision: String(f.revision || '').trim() } : {}) };
}
export const freshDraft = () => ({ arm: null, error: '', busy: false, open: { site: false, pkg: false }, form: { site: { host: '', access: 'pages', pin: '', scope: 'all' }, pkg: { eco: 'npm', name: '', revision: '', scope: 'all' } } });

export class ListsCard {
  constructor(host) {
    this.host = host;
    this.el = document.createElement('dialog');
    this.el.className = 'pset plist';
    this.el.setAttribute('aria-labelledby', 'ps-title');
    document.body.append(this.el);
    this.el.addEventListener('pointerdown', e => { this.downOutside = e.target === this.el; });
    this.el.addEventListener('click', e => this.click(e));
    this.el.addEventListener('input', e => this.input(e));
    this.el.addEventListener('toggle', e => { const k = e.target.dataset?.plFold; if (k && this.d) this.d.open[k] = e.target.open; }, true);
    this.el.addEventListener('close', () => { this.d = null; this.opener?.focus?.({ preventScroll: true }); });
    this.el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches?.('[data-pl-in]') && !this.d?.busy) { e.preventDefault(); this.add(e.target.closest('details')?.dataset.plFold || 'site'); } });
  }
  get open() { return this.el.open; }
  async show(p) {
    this.p = p; this.d = freshDraft(); this.view = null;
    this.opener = document.activeElement;
    try { this.view = await this.host.api(`/api/lists?project=${encodeURIComponent(p.name)}`); } catch (e) { this.host.toast(e.message || 'Could not read the lists.'); return; }
    this.render();
    if (!this.el.open) this.el.showModal();
    this.el.querySelector('.ps-x')?.focus({ preventScroll: true });
  }
  render() {
    if (!this.d || !this.view) return;
    const keep = this.el.querySelector('.ps-body')?.scrollTop || 0;
    this.el.innerHTML = listsCard(this.view, this.d);
    const body = this.el.querySelector('.ps-body'); if (body) body.scrollTop = keep;
  }
  close() { if (this.el.open) this.el.close(); }
  async send(path, body) {
    try { this.view = await this.host.api(path, body); this.d.error = ''; return true; }
    catch (e) { this.d.error = e.message || 'That did not work.'; return false; }
    finally { this.render(); }
  }
  click(e) {
    if (e.target === this.el) { const out = this.downOutside; this.downOutside = false; return out ? this.close() : undefined; }
    if (e.target.closest('[data-ps-close]')) return this.close();
    const sg = e.target.closest('[data-pl-seg]');
    if (sg) { const [k, f] = sg.dataset.plSeg.split('.'); this.d.form[k === 'site' ? 'site' : 'pkg'][f] = sg.dataset.v; this.d.error = ''; this.render(); return; }
    const add = e.target.closest('[data-pl-add]'); if (add) return this.add(add.dataset.plAdd);
    const arm = e.target.closest('[data-pl-arm]'); if (arm) { this.d.arm = arm.dataset.plArm; this.render(); return; }
    if (e.target.closest('[data-pl-cancel]')) { this.d.arm = null; this.render(); return; }
    const ac = e.target.closest('[data-pl-access]'); if (ac) { this.d.arm = null; return this.send('/api/lists/access', { project: this.p.name, id: ac.dataset.id, access: ac.dataset.plAccess }); }
    const rm = e.target.closest('[data-pl-remove]'); if (rm) { this.d.arm = null; return this.send('/api/lists/remove', { project: this.p.name, id: rm.dataset.plRemove }); }
  }
  input(e) {
    const k = e.target.dataset?.plIn;
    if (!k) return;
    const [a, f] = k.split('.');
    this.d.form[a === 'site' ? 'site' : 'pkg'][f] = e.target.value;
    if (this.d.error) { this.d.error = ''; this.el.querySelector('.pl-error')?.remove(); }
  }
  async add(kind) {
    const f = this.d.form[kind];
    if (!String(kind === 'site' ? f.host : f.name).trim()) { this.d.error = kind === 'site' ? 'Type the site\'s name, like fda.gov.' : 'Type the package\'s exact name.'; this.render(); return; }
    this.d.busy = true; this.render();
    const ok = await this.send('/api/lists/add', addBody(kind, this.d, this.p.name));
    this.d.busy = false;
    if (ok) { this.d.form[kind] = freshDraft().form[kind]; this.d.open[kind] = false; this.host.toast(`Added to your ${kind === 'site' ? 'trusted sites' : 'approved packages'}.`, 'info'); }
    this.render();
  }
}
