// The outside-model part of the Whole hub panel (decision 81 A): a key box per provider that needs one, and a provider and
// model for each kind of job (short question, long draft, picture). Plain functions return HTML strings, so they can be
// tested without a browser; project-settings.js puts them in the panel and calls outsideClick / outsideInput for them.
//
// What the page knows of a key: whether one is saved and its last four characters (info.keys). A key typed here lives in the
// draft (d.typed) until Save sends it in one same-origin request and drops it; it is never echoed back, and closing the panel
// drops the draft. Keys are saved when you press Save; the routes and plans are saved with Done, like the other settings.
// Nothing is shown as chosen until it is saved: an unset job reads "Not set".
import { ollamaAddress, showAddress, ADDRESS_HELP } from './ollama-address.js';

const esc = s =>String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (id, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const help = tip => `<span class="ps-help" title="${esc(tip)}" aria-label="${esc(tip)}" role="img">${ic('help')}</span>`;

export const PROVIDERS = [['google', 'Google'], ['openai', 'OpenAI'], ['openrouter', 'OpenRouter'], ['ollama', 'Ollama']];
export const KEYED = ['google', 'openai', 'openrouter'];
export const NAME = Object.fromEntries(PROVIDERS);
export const TERMS = [['unknown', 'Not sure'], ['free', 'Free plan'], ['paid', 'Paid plan']];
export const TERMS_TIP = 'Paid plan: the provider does not train on what the hub sends. Not sure or Free plan: projects set to Any send nothing to it. Google\'s picture models are paid only.';
export const JOBS = [
  { k: 'ask', label: 'Short questions', tip: 'Quick one-line answers an agent asks for, such as a label or a rewording (the ask_outside_model tool).' },
  { k: 'draft', label: 'Long drafts', tip: 'A report, a document section or a summary written from text the agent passes in (the draft_with_outside_model tool).' },
  { k: 'image', label: 'Pictures', tip: 'One picture from a prompt (the make_image tool). It costs real money, a few cents each, and only projects set to Any can use it.' }
];
const DEFAULT_PICTURE_MODELS = { google: 'gemini-nano-banana-2.1', openai: 'gpt-image-2' };

// Mirrors looksSecret in lib/providers.mjs for the shapes a key pasted into a model box would have (the hub refuses them too).
const looksLikeKey = s => /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAIza[0-9A-Za-z_-]{30,}|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}/.test(String(s || ''));
// Which providers can make pictures (the hub says; without its answer, the two with a default picture model and OpenRouter).
const canPictures = (p, info) => (info?.providers?.[p] ? !!info.providers[p].images : p in DEFAULT_PICTURE_MODELS || p === 'openrouter');
export const pictureModel = (p, info) => info?.providers?.[p]?.imageModel || DEFAULT_PICTURE_MODELS[p] || '';

// The draft the panel works on. settings: the hub settings the page holds; info: what /api/state sent (keys, price table).
export function outsideDraft(settings = {}, info = null) {
  const routes = {};
  for (const j of JOBS) { const r = settings.outsideRoutes?.[j.k]; routes[j.k] = { provider: r?.provider || '', model: r?.model || '' }; }
  const terms = {};
  for (const p of KEYED) terms[p] = settings.outsideTerms?.[p] || 'unknown';
  // errors: the same object as the panel's own (project-settings.js keeps the two in step), so a key's line can be cleared here
  // Ollama's address (decision 82 A): one box for the hub, shown without the /v1/ the hub adds; empty means this PC.
  // It has its own hub-wide setting, kept whether or not a job uses Ollama (an address left on an older route is read as it too).
  const ollama = showAddress(settings.outsideOllamaAddress || JOBS.map(j => settings.outsideRoutes?.[j.k]).find(r => r?.provider === 'ollama' && r.baseUrl)?.baseUrl || '');
  return { routes, terms, ollama, info: info || null, typed: {}, replacing: {}, busy: {}, keyErr: {}, warnOpen: {}, touched: false, errors: {} };
}

// The amber-mark notes for one job: why it will refuse, or why its dollars are only an estimate. [] when nothing is wrong.
export function jobNotes(job, d) {
  const r = d.routes?.[job];
  if (!r?.provider) return [];
  const info = d.info || {}, P = NAME[r.provider], notes = [];
  if (KEYED.includes(r.provider) && !info.keys?.[r.provider]?.saved) notes.push(`No ${P} key is saved yet, so this job refuses until you add one in the key box above.`);
  if (KEYED.includes(r.provider) && (d.terms?.[r.provider] || 'unknown') !== 'paid') notes.push(`Your plan with ${P} is not set to Paid, so projects set to Any send nothing to it. Set it to Paid in the ${P} box above if it is.`);
  if (r.provider === 'ollama' && String(d.ollama || '').trim() && !ollamaAddress(d.ollama).ok) notes.push(`The Ollama address is refused: ${ollamaAddress(d.ollama).why} This job refuses until it is fixed in the Ollama box above.`);
  if (r.provider === 'openrouter' && /:free$/i.test((r.model || '').trim())) notes.push('OpenRouter\'s free models can train on what is sent, so projects set to Any refuse this model. Pick a paid one.');
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
  // An empty box is amber only when a job uses that provider; otherwise it is just plain text (nothing is wrong).
  const used = JOBS.some(j => d.routes[j.k].provider === p);
  const status = saved ? `<span class="ps-keystat ok">${ic('check')}Key saved, ends ${esc(k.end || '????')}</span>` : used ? `<span class="ps-keystat warn">${ic('warn')}No key saved</span>` : '<span class="ps-keystat">No key saved</span>';
  const entry = !can ? `<p class="ps-dflt warn">${ic('warn')}This computer cannot protect a saved key (Windows only), so keys cannot be saved here.</p>`
    : replacing ? `<div class="ps-keyin"><input class="ac-field ps-keyfield" type="password" name="crux-outside-key-${p}" autocomplete="off" autocapitalize="off" spellcheck="false" data-ps-keyin="${p}" placeholder="${saved ? `Paste a new ${P} key to replace it` : `Paste your ${P} key`}" aria-label="${esc(P)} key" value="${esc(d.typed[p] || '')}">
        <button type="button" class="btn primary" data-ps-keysave="${p}" ${(d.typed[p] || '').trim() && !busy ? '' : 'disabled'}>${ic('check')}${busy ? 'Saving...' : 'Save'}</button>
        ${saved ? `<button type="button" class="btn ghost" data-ps-keycancel="${p}" title="Keep the saved key">Cancel</button>` : ''}</div>`
      : `<div class="ps-keyin"><button type="button" class="btn" data-ps-keyreplace="${p}">${ic('reset')}Replace</button>
        <button type="button" class="btn ghost" data-ps-keyremove="${p}" ${busy ? 'disabled' : ''} title="Remove the saved ${esc(P)} key from this computer">${ic('x')}Remove</button></div>`;
  return `<div class="ps-keybox" data-ps-keybox="${p}">
    <div class="ps-key-top"><span class="ps-key-name">${esc(P)}</span>${status}</div>
    ${entry}
    ${d.keyErr[p] || d.errors?.[`key-${p}`] ? `<p class="ps-dflt warn" role="alert">${ic('warn')}${esc(d.keyErr[p] || d.errors[`key-${p}`])}</p>` : ''}
    <div class="ps-key-plan"><span class="ps-num-label"><span>Your plan with ${esc(P)}</span></span>${help(TERMS_TIP)}${segN(d.terms[p], `terms-${p}`, TERMS)}</div>
  </div>`;
}

// What the Ollama address box says under it: this PC, a Tailscale machine (counted as Local), or why it is refused.
export function ollamaStatus(text) {
  if (!String(text || '').trim()) return { cls: '', text: 'Using Ollama on this PC.' };
  const a = ollamaAddress(text);
  if (!a.ok) return { cls: 'warn', text: `Refused: ${a.why}` };
  if (a.kind === 'loopback') return { cls: '', text: a.port && a.port !== '11434' ? `Using Ollama on this PC, port ${a.port}.` : 'Using Ollama on this PC.' };
  return { cls: 'ok', text: `Your Tailscale machine ${a.host}. Jobs there count as Local.` };
}

function ollamaBox(d) {
  const st = ollamaStatus(d.ollama), err = d.errors?.['ollama-address'];
  return `<div class="ps-keybox" data-ps-keybox="ollama">
    <div class="ps-key-top"><span class="ps-key-name">Ollama</span>${help(ADDRESS_HELP)}<span class="ps-keystat">No key needed</span></div>
    <div class="ps-keyin"><input class="ac-field ps-keyfield" type="text" name="crux-ollama-address" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url" data-ps-ollama placeholder="This PC" aria-label="Ollama address" value="${esc(d.ollama || '')}"></div>
    <p class="ps-keyline ps-ollama-status ${st.cls}">${st.cls === 'warn' ? ic('warn') : st.cls === 'ok' ? ic('check') : ''}<span>${esc(st.text)}</span></p>
    ${err ? `<p class="ps-dflt warn" role="alert">${ic('warn')}${esc(err)}</p>` : ''}
  </div>`;
}

function jobRow(j, d) {
  const r = d.routes[j.k], notes = jobNotes(j.k, d), open = !!d.warnOpen[j.k];
  const choices = [['', 'Not set'], ...PROVIDERS.filter(([p]) => j.k !== 'image' || canPictures(p, d.info))];
  const model = r.provider ? `<input class="ps-model" type="text" autocomplete="off" spellcheck="false" maxlength="120" data-ps-jobmodel="${j.k}" value="${esc(r.model)}"
      placeholder="${esc(j.k === 'image' ? (pictureModel(r.provider, d.info) ? `${pictureModel(r.provider, d.info)} (default)` : 'Picture model, as the provider writes it (no default)') : 'Model name, as the provider writes it')}" aria-label="${esc(j.label)} model">` : '';
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
      <div class="ps-keys">${KEYED.map(p => keyBox(p, d)).join('')}${ollamaBox(d)}</div></section>
    <section class="ps-sec ps-last"><h3 class="ps-sec-head">Who answers which job ${help('Pick a provider and model for each kind of job. Agents never choose; they just ask for a draft or a picture. Each project still has its own Outside models switch and spending allowance.')}</h3>
      ${any ? '' : `<p class="ps-keyline">${ic('warn')}Nothing is set up yet. Agents get no outside tools until a provider is chosen for a job.</p>`}
      <div class="ps-jobs">${JOBS.map(j => jobRow(j, d)).join('')}</div></section>`;
}

// What Done sends for the outside settings: only what differs from the saved settings. Returns { body, errors }.
export function outsideChanges(settings = {}, d) {
  const body = {}, errors = {};
  if (!d?.routes) return { body, errors };
  // A key typed in a box but not saved with its Save button: stay open and say so, rather than dropping it without a word.
  for (const p of KEYED) if (String(d.typed?.[p] || '').trim()) errors[`key-${p}`] = `You typed a ${NAME[p]} key but did not press Save. Press Save to keep it, or clear the box.`;
  // Ollama's address: this PC when empty; else it must pass the same rule the hub applies (the hub checks again at save and at every call)
  const typedAddress = String(d.ollama || '').trim(), addr = typedAddress ? ollamaAddress(typedAddress) : null;
  if (addr && !addr.ok) errors['ollama-address'] = addr.why;
  const routes = {};
  for (const j of JOBS) {
    const r = d.routes[j.k];
    if (!r.provider) continue;
    const model = (r.model || '').trim();
    if (looksLikeKey(model)) { errors[`route-${j.k}`] = 'That looks like a key, not a model name. Keys go in the key box above, and nothing is saved here.'; continue; }
    // a text job always needs its model; a picture job too unless the provider has a picture model of its own (OpenRouter has none)
    if (!model && (j.k !== 'image' || !pictureModel(r.provider, d.info))) { errors[`route-${j.k}`] = 'Needs a model name'; continue; }
    const old = settings.outsideRoutes?.[j.k];
    routes[j.k] = { provider: r.provider, model: model || null, ...(old?.provider === r.provider && old.minFreeMB != null ? { minFreeMB: old.minFreeMB } : {}) };
  }
  const key = o => JOBS.map(j => `${o?.[j.k]?.provider || ''}/${o?.[j.k]?.model || ''}`).join('|');
  if (!Object.keys(errors).length && key(routes) !== key(settings.outsideRoutes)) body.outsideRoutes = routes;
  // The address is a setting of its own (empty: this PC), sent when it differs from the saved one, whether or not a job uses Ollama
  if (!Object.keys(errors).length) {
    const wanted = addr?.ok ? addr.base : '';
    if (wanted !== (settings.outsideOllamaAddress || '')) body.outsideOllamaAddress = wanted;
  }
  if (KEYED.some(p => d.terms[p] !== (settings.outsideTerms?.[p] || 'unknown'))) body.outsideTerms = { ...d.terms };
  return { body, errors };
}

// Typing in a model box or a key box: kept in the draft; nothing is redrawn (the box keeps its focus). Returns true if handled.
export function outsideInput(t, d) {
  if (t.matches?.('[data-ps-keyin]')) {
    const p = t.dataset.psKeyin; d.typed[p] = t.value; delete d.keyErr[p]; delete d.errors?.[`key-${p}`];   // typing clears "typed a key but did not press Save"
    const btn = t.closest('.ps-keyin')?.querySelector('[data-ps-keysave]'); if (btn && !d.busy[p]) btn.disabled = !t.value.trim();
    return true;
  }
  if (t.matches?.('[data-ps-ollama]')) {   // the address: judged as you type, in place (the box keeps its focus)
    d.ollama = t.value; d.touched = true; delete d.errors?.['ollama-address'];
    const st = ollamaStatus(t.value), line = t.closest?.('.ps-keybox')?.querySelector?.('.ps-ollama-status');
    if (line) { line.className = `ps-keyline ps-ollama-status ${st.cls}`; line.innerHTML = `${st.cls === 'warn' ? ic('warn') : st.cls === 'ok' ? ic('check') : ''}<span>${esc(st.text)}</span>`; }
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
      if (r && r.provider !== v && (v === '' || PROVIDERS.some(([p]) => p === v))) { r.provider = v; r.model = ''; d.touched = true; }
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
  d.busy[p] = true; delete d.keyErr[p]; delete d.errors?.[`key-${p}`];   // a save or remove answers the "did not press Save" line
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
