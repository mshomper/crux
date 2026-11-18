// The outside-model part of the Whole hub panel (decision 81 A): a key box per provider that needs one, and a provider and
// model for each kind of job (short question, long draft, picture). Plain functions return HTML strings, so they can be
// tested without a browser; project-settings.js puts them in the panel and calls outsideClick / outsideInput for them.
//
// What the page knows of a key: whether one is saved and its last four characters (info.keys). A key typed here lives in the
// draft (d.typed) until Save sends it in one same-origin request and drops it; it is never echoed back, and closing the panel
// drops the draft. Keys are saved when you press Save; the routes and plans are saved with Done, like the other settings.
// Nothing is shown as chosen until it is saved: an unset job reads "Not set".
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (id, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const help = tip => `<span class="ps-help" title="${esc(tip)}" aria-label="${esc(tip)}" role="img">${ic('help')}</span>`;

export const PROVIDERS = [['google', 'Google'], ['openai', 'OpenAI'], ['openrouter', 'OpenRouter'], ['ollama', 'Ollama']];
export const KEYED = ['google', 'openai', 'openrouter'];
export const NAME = Object.fromEntries(PROVIDERS);
export const TERMS = [['unknown', 'Not sure'], ['free', 'Free plan'], ['paid', 'Paid plan']];
export const TERMS_TIP = 'Paid plan: the provider does not train on or keep what the hub sends. Not sure or Free plan: projects set to Any send nothing to it. Google\'s picture models are paid only.';
export const JOBS = [
  { k: 'ask', label: 'Short questions', tip: 'Quick one-line answers an agent asks for, such as a label or a rewording (the ask_outside_model tool).' },
  { k: 'draft', label: 'Long drafts', tip: 'A report, a document section or a summary written from text the agent passes in (the draft_with_outside_model tool).' },
  { k: 'image', label: 'Pictures', tip: 'One picture from a prompt (the make_image tool). It costs real money, a few cents each, and only projects set to Any can use it.' }
];
const DEFAULT_PICTURE_MODELS = { google: 'gemini-nano-banana-2.1', openai: 'gpt-image-2' };

const canPictures = (p, info) => (info?.providers?.[p] ? !!info.providers[p].imageModel : p in DEFAULT_PICTURE_MODELS);
export const pictureModel = (p, info) => info?.providers?.[p]?.imageModel || DEFAULT_PICTURE_MODELS[p] || '';

// The draft the panel works on. settings: the hub settings the page holds; info: what /api/state sent (keys, price table).
export function outsideDraft(settings = {}, info = null) {
  const routes = {};
  for (const j of JOBS) { const r = settings.outsideRoutes?.[j.k]; routes[j.k] = { provider: r?.provider || '', model: r?.model || '' }; }
  const terms = {};
  for (const p of KEYED) terms[p] = settings.outsideTerms?.[p] || 'unknown';
  return { routes, terms, info: info || null, typed: {}, replacing: {}, busy: {}, keyErr: {}, warnOpen: {}, touched: false };
}

// The amber-mark notes for one job: why it will refuse, or why its dollars are only an estimate. [] when nothing is wrong.
export function jobNotes(job, d) {
  const r = d.routes?.[job];
  if (!r?.provider) return [];
  const info = d.info || {}, P = NAME[r.provider], notes = [];
  if (KEYED.includes(r.provider) && !info.keys?.[r.provider]?.saved) notes.push(`No ${P} key is saved yet, so this job refuses until you add one in the key box above.`);
  if (KEYED.includes(r.provider) && (d.terms?.[r.provider] || 'unknown') !== 'paid') notes.push(`Your plan with ${P} is not set to Paid, so projects set to Any send nothing to it. Set it to Paid in the ${P} box above if it is.`);
  if (r.provider !== 'ollama') {
    const model = (r.model || '').trim() || (job === 'image' ? pictureModel(r.provider, info) : '');
    const table = job === 'image' ? info.priced?.image : info.priced?.text;
    if (model && Array.isArray(table) && !table.includes(model)) {
      notes.push(`${r.provider === 'openrouter' ? 'OpenRouter\'s own cost figure is used when it comes back. Otherwise this' : 'This'} model's price is not in the hub's table, so no exact dollar figure is known. Each call then counts at a high fallback rate toward the project's daily dollar cap, and the calls-per-hour limit still applies.`);
    }
  }
  return notes;
}

const segN = (cur, name, choices) => `<div class="ps-seg" role="radiogroup" aria-label="${esc(name)}">${choices.map(([v, l]) =>
  `<button type="button" role="radio" aria-checked="${cur === v}" class="${cur === v ? 'on' : ''}" data-ps-seg="${esc(name)}" data-v="${esc(v)}">${esc(l)}</button>`).join('')}</div>`;

function keyBox(p, d) {
  const k = d.info?.keys?.[p], P = NAME[p], saved = !!k?.saved, replacing = !!d.replacing[p] || !saved, busy = !!d.busy[p], can = d.info?.canProtect !== false;
  const status = saved ? `<span class="ps-keystat ok">${ic('check')}Key saved, ends ${esc(k.end || '????')}</span>` : `<span class="ps-keystat warn">${ic('warn')}No key saved</span>`;
  const entry = !can ? `<p class="ps-dflt warn">${ic('warn')}This computer cannot protect a saved key (Windows only), so keys cannot be saved here.</p>`
    : replacing ? `<div class="ps-keyin"><input class="ac-field ps-keyfield" type="password" name="crux-outside-key-${p}" autocomplete="off" autocapitalize="off" spellcheck="false" data-ps-keyin="${p}" placeholder="${saved ? `Paste a new ${P} key to replace it` : `Paste your ${P} key`}" aria-label="${esc(P)} key" value="${esc(d.typed[p] || '')}">
        <button type="button" class="btn primary" data-ps-keysave="${p}" ${(d.typed[p] || '').trim() && !busy ? '' : 'disabled'}>${ic('check')}${busy ? 'Saving...' : 'Save'}</button>
        ${saved ? `<button type="button" class="btn ghost" data-ps-keycancel="${p}" title="Keep the saved key">Cancel</button>` : ''}</div>`
      : `<div class="ps-keyin"><button type="button" class="btn" data-ps-keyreplace="${p}">${ic('reset')}Replace</button>
        <button type="button" class="btn ghost" data-ps-keyremove="${p}" ${busy ? 'disabled' : ''} title="Remove the saved ${esc(P)} key from this computer">${ic('x')}Remove</button></div>`;
  return `<div class="ps-keybox" data-ps-keybox="${p}">
    <div class="ps-key-top"><span class="ps-key-name">${esc(P)}</span>${status}</div>
    ${entry}
    ${d.keyErr[p] ? `<p class="ps-dflt warn" role="alert">${ic('warn')}${esc(d.keyErr[p])}</p>` : ''}
    <div class="ps-key-plan"><span class="ps-num-label"><span>Your plan with ${esc(P)}</span></span>${help(TERMS_TIP)}${segN(d.terms[p], `terms-${p}`, TERMS)}</div>
  </div>`;
}

function jobRow(j, d) {
  const r = d.routes[j.k], notes = jobNotes(j.k, d), open = !!d.warnOpen[j.k];
  const choices = [['', 'Not set'], ...PROVIDERS.filter(([p]) => j.k !== 'image' || canPictures(p, d.info))];
  const model = r.provider ? `<input class="ps-model" type="text" autocomplete="off" spellcheck="false" maxlength="120" data-ps-jobmodel="${j.k}" value="${esc(r.model)}"
      placeholder="${esc(j.k === 'image' ? `${pictureModel(r.provider, d.info) || 'model'} (default)` : 'Model name, as the provider writes it')}" aria-label="${esc(j.label)} model">` : '';
  const err = d.errors?.[`route-${j.k}`];
  return `<div class="ps-job" data-ps-job="${j.k}">
    <div class="ps-job-top"><span class="ps-num-label"><span>${esc(j.label)}</span></span>${help(j.tip)}
      ${notes.length ? `<button type="button" class="ps-warnmark" data-ps-warn="${j.k}" aria-expanded="${open}" title="${esc(notes.join(' '))}" aria-label="${esc(notes.join(' '))}">${ic('warn')}</button>` : ''}</div>
    <div class="ps-conn">${segN(r.provider, `job-${j.k}`, choices)}</div>
    ${model}
    ${open && notes.length ? `<p class="ps-dflt warn ps-job-note">${ic('warn')}<span>${esc(notes.join(' '))}</span></p>` : ''}
    ${err ? `<p class="ps-dflt warn" role="alert">${ic('warn')}${esc(err)}</p>` : ''}
  </div>`;
}

// The two sections of the Whole hub panel. d: outsideDraft plus errors.
export function outsideSections(d) {
  const any = JOBS.some(j => d.routes[j.k].provider);
  return `<section class="ps-sec"><h3 class="ps-sec-head">Outside provider keys ${help('One key box per provider. A pasted key is protected for your Windows user on this computer and never shown again, only its last four characters. Saved when you press Save, not with Done. Ollama runs on this computer and needs none.')}</h3>
      <div class="ps-keys">${KEYED.map(p => keyBox(p, d)).join('')}</div></section>
    <section class="ps-sec ps-last"><h3 class="ps-sec-head">Who answers which job ${help('Pick a provider and model for each kind of job. Agents never choose; they just ask for a draft or a picture. Each project still has its own Outside models switch and spending allowance.')}</h3>
      ${any ? '' : `<p class="ps-keyline">${ic('warn')}Nothing is set up yet. Agents get no outside tools until a provider is chosen for a job.</p>`}
      <div class="ps-jobs">${JOBS.map(j => jobRow(j, d)).join('')}</div></section>`;
}

// What Done sends for the outside settings: only what differs from the saved settings. Returns { body, errors }.
export function outsideChanges(settings = {}, d) {
  const body = {}, errors = {};
  if (!d?.routes) return { body, errors };
  const routes = {};
  for (const j of JOBS) {
    const r = d.routes[j.k];
    if (!r.provider) continue;
    const model = (r.model || '').trim();
    if (j.k !== 'image' && !model) { errors[`route-${j.k}`] = 'Needs a model name'; continue; }
    const old = settings.outsideRoutes?.[j.k];
    routes[j.k] = { provider: r.provider, model: model || null, ...(old?.provider === r.provider && old.baseUrl ? { baseUrl: old.baseUrl } : {}), ...(old?.provider === r.provider && old.minFreeMB != null ? { minFreeMB: old.minFreeMB } : {}) };
  }
  const key = o => JOBS.map(j => `${o?.[j.k]?.provider || ''}/${o?.[j.k]?.model || ''}`).join('|');
  if (!Object.keys(errors).length && key(routes) !== key(settings.outsideRoutes)) body.outsideRoutes = routes;
  if (KEYED.some(p => d.terms[p] !== (settings.outsideTerms?.[p] || 'unknown'))) body.outsideTerms = { ...d.terms };
  return { body, errors };
}

// Typing in a model box or a key box: kept in the draft; nothing is redrawn (the box keeps its focus). Returns true if handled.
export function outsideInput(t, d) {
  if (t.matches?.('[data-ps-keyin]')) {
    const p = t.dataset.psKeyin; d.typed[p] = t.value; delete d.keyErr[p];
    const btn = t.closest('.ps-keyin')?.querySelector('[data-ps-keysave]'); if (btn && !d.busy[p]) btn.disabled = !t.value.trim();
    return true;
  }
  if (t.matches?.('[data-ps-jobmodel]')) { const j = t.dataset.psJobmodel; d.routes[j].model = t.value; d.touched = true; if (d.errors) delete d.errors[`route-${j}`]; return true; }
  return false;
}

// A click inside the outside sections. Changes the draft and returns true when it changed something to draw; a promise for a
// key save or remove (which also changes what is drawn when it ends); null when the click was not for these sections.
// host.api(path, body) posts same-origin JSON; host.outsideSaved(info) tells the page the new key list.
export function outsideClick(e, d, host) {
  const t = e.target;
  const seg = t.closest?.('[data-ps-seg]');
  if (seg) {
    const name = seg.dataset.psSeg, v = seg.dataset.v;
    if (name.startsWith('job-')) {
      const j = name.slice(4), r = d.routes[j];
      if (r && r.provider !== v && (v === '' || PROVIDERS.some(([p]) => p === v))) { r.provider = v; if (!v) r.model = ''; d.touched = true; }
      return true;
    }
    if (name.startsWith('terms-')) { const p = name.slice(6); if (KEYED.includes(p) && TERMS.some(([x]) => x === v)) { d.terms[p] = v; d.touched = true; } return true; }
    return null;
  }
  let b;
  if ((b = t.closest?.('[data-ps-warn]'))) { const j = b.dataset.psWarn; d.warnOpen[j] = !d.warnOpen[j]; return true; }
  if ((b = t.closest?.('[data-ps-keyreplace]'))) { d.replacing[b.dataset.psKeyreplace] = true; return true; }
  if ((b = t.closest?.('[data-ps-keycancel]'))) { const p = b.dataset.psKeycancel; d.replacing[p] = false; d.typed[p] = ''; delete d.keyErr[p]; return true; }
  if ((b = t.closest?.('[data-ps-keysave]'))) return outsideSaveKey(b.dataset.psKeysave, d, host);
  if ((b = t.closest?.('[data-ps-keyremove]'))) return outsideKeyCall(b.dataset.psKeyremove, { remove: true }, d, host);
  return null;
}

export function outsideSaveKey(p, d, host) {
  const k = String(d.typed[p] || '').trim();
  if (!k) return true;
  return outsideKeyCall(p, { apiKey: k }, d, host);
}

async function outsideKeyCall(p, extra, d, host) {
  if (!KEYED.includes(p) || d.busy[p]) return true;
  d.busy[p] = true; delete d.keyErr[p];
  try {
    const res = await host.api('/api/outside/key', { provider: p, ...extra });
    d.info = res.outsideInfo || d.info;
    host.outsideSaved?.(d.info);
    d.replacing[p] = false;
  } catch (err) {
    d.keyErr[p] = err?.message || 'Could not save the key.';
  } finally {
    d.typed[p] = '';   // the pasted key leaves the page whether or not the save worked
    d.busy[p] = false;
  }
  return true;
}
