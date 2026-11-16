// The Expedition module, phase 5 (decision 70 A): the "New expedition" panel. One panel, Scope on the left and Team on the
// right, in the HUD card panel the board cards use (hud.js). Opened from the sidebar button, from a draft card's Edit and
// from Launch on a proposed next expedition (the same form, pre-filled).
//   Pure parts (tested without a browser): ROLE_LIST, teamTotals, startDraft, problems, launchBody, estimateUSD
//   ExpeditionPanel: the pop-up. host: { api, toast, modelPicker, effortPicker, models, hueOf, family, modelLabel, pips }
// Red is never used for an expedition (decision 31): warnings are amber, behind a small mark.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const GATHERER_LIMIT = 4;   // fixed: at once, and one second round (expedition-lead.md); the stepper means "up to N at once"
export const HOURS = [2, 6, 12, 24];
export const PERCENTS = [3, 7, 15];
export const DEFAULT_ENVELOPE = { hours: 6, percent: 7 };
export const JUDGES = [['checklist', 'Checklist', 'Judged by the Verifier from written evidence'], ['command', 'Command', 'A command the Verifier runs; it must pass'], ['outside', 'Not run here', 'Can only run on your machine: the report asks you to paste results']];

// The seven roles, as spec section 3 names them. Defaults match lib/expedition.mjs ROLES; the hub's state (p.expedition.roles)
// wins when it sends them (hub.json can change them), so this is only the fallback.
export const ROLE_LIST = [
  { key: 'lead', label: 'Lead', blurb: 'Plans, splits the work, makes in-scope calls, writes the report', model: 'opus', effort: 'medium' },
  { key: 'advisor', label: 'Advisor', blurb: 'Reviews the plan once, then is on call for decisions and stuck points', model: 'fable', effort: 'medium' },
  { key: 'gatherer', label: 'Gatherers', blurb: 'One sub-question each, up to this many at once', model: 'haiku', effort: 'low', count: true },
  { key: 'synthesizer', label: 'Synthesizer', blurb: 'Turns the notes into findings, an options table and a recommendation', model: 'opus', effort: 'medium' },
  { key: 'skeptic', label: 'Skeptic', blurb: 'Reads the notes and the synthesis in its own context and argues against them', model: 'sonnet', effort: 'high' },
  { key: 'builder', label: 'Builder', blurb: 'Builds the prototype in its own worktree against the frozen test', model: 'sonnet', effort: 'medium' },
  { key: 'verifier', label: 'Verifier', blurb: 'Runs the frozen test for real, in its own context, and never edits it', model: 'opus', effort: 'high' }
];
export const roleOf = key => ROLE_LIST.find(r => r.key === key);

// Small drawn icons (no emoji, no glyphs), one per role.
const ICON = {
  lead: '<path d="M12 3.5l7 4v9l-7 4-7-4v-9z"/><circle cx="12" cy="12" r="2.2"/>',
  advisor: '<path d="M12 4l2.4 5 5.4.7-4 3.7 1 5.4L12 16.3 7.2 18.8l1-5.4-4-3.7 5.4-.7z"/>',
  gatherer: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="M15 15l5 5"/>',
  synthesizer: '<path d="M4 5h16l-6 7.5V19l-4 1.5v-8z"/>',
  skeptic: '<path d="M12 3l7 3v5.5c0 4.3-3 7.3-7 9.5-4-2.200-7-5.200-7-9.500V6z"/><path d="M9.800 9.600a2.300 2.300 0 0 1 4.400.8c0 1.600-2.200 1.900-2.200 3.400"/><path d="M12 16.800v.2"/>',
  builder: '<path d="M12 3.500l8 4v9l-8 4-8-4v-9z"/><path d="M4 7.500l8 4 8-4M12 11.500v9"/>',
  verifier: '<path d="M12 3l7 3v5.500c0 4.300-3 7.300-7 9.500-4-2.200-7-5.200-7-9.500V6z"/><path d="M8.800 12l2.400 2.400 4-4.600"/>'
};
export const ICONS = {
  ...ICON,
  clock: '<circle cx="12" cy="12" r="8.500"/><path d="M12 7.500V12l3 2"/>',
  coin: '<circle cx="12" cy="12" r="8.500"/><path d="M14.500 9.200c-.5-.8-1.400-1.200-2.500-1.200-1.500 0-2.500.8-2.500 1.900 0 2.600 5.200 1.300 5.200 4 0 1.200-1.100 2-2.700 2-1.300 0-2.300-.5-2.800-1.400M12 6.500v1.500M12 16v1.500"/>',
  branch: '<circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="9" r="2"/><path d="M7 8v8M17 11c0 3-4 3-8 5"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.500M12 17.300v.2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.600 9.300a2.500 2.500 0 0 1 4.800.9c0 1.700-2.400 2.200-2.400 3.800"/><circle cx="12" cy="17.200" r=".6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M6 12h12"/>',
  globe: '<circle cx="12" cy="12" r="8.500"/><path d="M3.500 12h17"/><path d="M12 3.500c2.500 2.300 3.800 5.100 3.800 8.500s-1.300 6.200-3.800 8.500c-2.500-2.300-3.800-5.100-3.800-8.500S9.500 5.800 12 3.500z"/>',
  box: '<path d="M12 3.500l8 4v9l-8 4-8-4v-9z"/><path d="M4 7.500l8 4 8-4M12 11.500v9"/>',
  compass: '<circle cx="12" cy="12" r="8.500"/><path d="M15.500 8.500l-2 5-5 2 2-5z"/>',
  check: '<path d="M5 12.500l4.500 4.500L19 7.500"/>',
  terminal: '<rect x="3.500" y="5" width="17" height="14" rx="2"/><path d="M7.500 10l2.500 2-2.500 2M12.500 14.500h4"/>',
  list: '<path d="M9 7h11M9 12h11M9 17h11"/><circle cx="5" cy="7" r=".8"/><circle cx="5" cy="12" r=".8"/><circle cx="5" cy="17" r=".8"/>',
  ban: '<circle cx="12" cy="12" r="8.500"/><path d="M6 6l12 12"/>'
};
export const ic = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ---------- the draft: what the panel edits ----------
// st: the hub's per-project expedition state (hub.state() p.expedition: { roles, envelope, dollarsPerPercent, ... }), or none.
// seed: a draft card's content, or a proposed next expedition's brief: { question, success: [{ text, judge, command }],
// envelope: { hours, percent }, preApprovals: { sites: [{ host, access }], packages: [{ eco, name }] }, roles, gatherers }.
export function startDraft(state = null, seed = {}) {
  const st = state?.defaults || state || null;   // hub.state(): p.expedition.defaults { envelope, gatherers, roles }
  const roles = {};
  for (const r of ROLE_LIST) {
    const base = { model: r.model, effort: r.effort }, hub = st?.roles?.[r.key] || {}, mine = seed.roles?.[r.key] || {};
    roles[r.key] = { model: mine.model || hub.model || base.model, effort: mine.effort || hub.effort || base.effort };
  }
  const env = { ...DEFAULT_ENVELOPE, ...(st?.envelope || {}), ...(seed.envelope || {}) };
  const n = Number(seed.gatherers ?? st?.gatherers ?? 3);
  const success = seed.success || testItems(seed.test);
  return {
    question: String(seed.question || ''),
    reason: String(seed.reason || ''),   // a proposal's why, shown quietly under the box; never sent
    success,   // optional: none written means the team writes the test itself while it plans
    more: success.length > 0 || !!(seed.preApprovals?.sites?.length || seed.preApprovals?.packages?.length),   // the fold opens when it holds something
    hours: HOURS.includes(Number(env.hours)) ? Number(env.hours) : DEFAULT_ENVELOPE.hours,
    percent: PERCENTS.includes(Number(env.percent)) ? Number(env.percent) : DEFAULT_ENVELOPE.percent,
    sites: (seed.preApprovals?.sites || []).map(s => ({ host: String(s.host || s), access: s.access || 'pages' })),
    packages: (seed.preApprovals?.packages || []).map(x => ({ eco: x.eco || 'npm', name: String(x.name || x) })),
    roles, gatherers: Math.min(GATHERER_LIMIT, Math.max(1, Number.isFinite(n) ? Math.round(n) : 3)),
    editing: null,   // the role whose model and effort are open
    add: null        // 'site' | 'package': the small add form
  };
}

const OUTSIDE = 'not run here';
// The backend's success test is files (test/CHECKLIST.md, test/run.json). The panel edits items, so a draft's files are read
// back into items here, and testFiles() writes them out again. Item = { text, judge: checklist | command | outside, command }.
export function testItems(test = {}) {
  const items = [];
  for (const line of String(test?.['CHECKLIST.md'] || '').split('\n')) {
    const m = /^\s*(?:\d+[.)]|[-*]|- \[[ xX]\])\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    const out = /\s*\((?:not run here)[^)]*\)\s*$/i.exec(m[1]);
    items.push({ text: out ? m[1].slice(0, out.index) : m[1], judge: out ? 'outside' : 'checklist', command: '' });
  }
  let run = null;
  try { run = JSON.parse(test?.['run.json'] || 'null'); } catch { run = null; }
  for (const c of run?.checks || []) items.push({ text: String(c.name || c.command || ''), judge: 'command', command: String(c.command || '') });
  return items;
}
export function testFiles(items) {
  const keep = items.filter(t => t.text.trim());
  const list = keep.filter(t => t.judge !== 'command');
  const cmds = keep.filter(t => t.judge === 'command');
  const files = {};
  if (list.length) files['CHECKLIST.md'] = `${list.map((t, i) => `${i + 1}. ${t.text.trim()}${t.judge === 'outside' ? ` (${OUTSIDE}: ${'the user pastes the results'})` : ''}`).join('\n')}\n`;
  if (cmds.length) files['run.json'] = `${JSON.stringify({ checks: cmds.map(t => ({ name: t.text.trim(), command: t.command.trim() })) }, null, 2)}\n`;
  return files;
}

// "9 agents at most", and how many of each model: the five hub roles and the Lead, plus up to N gatherers inside the Lead.
export function teamTotals(d, family = id => (/opus|sonnet|haiku|fable/i.exec(id || '') || [])[0]?.toLowerCase() || null) {
  const by = {};
  let n = 0;
  for (const r of ROLE_LIST) {
    const k = r.count ? d.gatherers : 1;
    const f = family(d.roles[r.key]?.model) || 'other';
    by[f] = (by[f] || 0) + k; n += k;
  }
  return { total: n, by };
}

// The budget in dollars, from the confirmed dollars-per-plan-percent figure (decision 69), or null while it is not set.
export const estimateUSD = (percent, st) => { const f = Number(st?.defaults?.dollarsPerPercent ?? st?.dollarsPerPercent); return f > 0 ? Math.round(percent * f * 100) / 100 : null; };
export const money = v => `$${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}`;

// What stops Launch (block) and what only warns (warn), each in plain words for the amber mark. ctx: { level: 'standard' | 'auto'
// | 'trusted', check: 'off' | 'shadow' | 'on', running: bool (an expedition is live in this project), st, family }.
export function problems(d, ctx = {}) {
  const out = [], fam = ctx.family || (id => (/opus|sonnet|haiku|fable/i.exec(id || '') || [])[0]?.toLowerCase() || null);
  if (ctx.running) out.push({ id: 'running', level: 'block', text: 'An expedition is already running in this project. One at a time: stop it or wait for its report.' });
  if (ctx.level === 'standard') out.push({ id: 'ask', level: 'block', text: 'This project is at Ask. An expedition needs Auto or Trusted, because it has nobody to ask. Raise the level on the project card first.' });
  if (!d.question.trim()) out.push({ id: 'question', level: 'block', text: 'Write the question first.' });
  if (fam(d.roles.verifier.model) && fam(d.roles.verifier.model) === fam(d.roles.builder.model)) out.push({ id: 'same', level: 'block', text: 'The Verifier and the Builder run on the same model. The Verifier must be a different model from the Builder: change one of them.' });
  const items = d.success.filter(t => t.text.trim());
  const noJudge = items.filter(t => t.judge === 'command' && !t.command.trim()).length;
  if (noJudge) out.push({ id: 'nojudge', level: 'warn', text: `${noJudge === 1 ? 'One item is' : `${noJudge} items are`} set to a command with no command written. Without one nothing judges ${noJudge === 1 ? 'it' : 'them'}.` });
  if (ctx.check && ctx.check !== 'on') out.push({ id: 'check', level: 'warn', text: 'The permission check is off in this project: anything the hub cannot settle by itself is parked, never asked.' });
  if (ctx.level === 'auto' && !d.sites.length) out.push({ id: 'web', level: 'warn', text: 'At Auto, gatherers cannot open arbitrary web pages. Name the sites they should read under Pre-approved, or use Trusted.' });
  // Only once the envelope or More has been opened: on a default launch it would be permanent noise.
  if (d.touched && ctx.st && !(estimateUSD(d.percent, ctx.st) > 0)) out.push({ id: 'dollars', level: 'warn', text: ctx.st.budgetNote || 'No dollar figure is confirmed yet, so there is no dollar cap. The time limit still applies.' });
  if (ctx.st?.defaults && ctx.st.defaults.meterGuard === false) out.push({ id: 'meters', level: 'warn', text: 'The plan meters are not watching this run, so only the dollar cap guards the budget.' });
  // The hub's own answer (it also refuses at launch): shown as the reason Launch is off.
  if (ctx.st?.launch && ctx.st.launch.ok === false && ctx.st.launch.reason && !out.some(p => p.level === 'block' && (p.id === 'running' || p.id === 'ask'))) out.push({ id: 'hub', level: 'block', text: ctx.st.launch.reason });
  return out;
}

// The brief the hub writes to BRIEF.md: the question, how the work is judged, and what the team may use without asking.
// Matt (2026-11-16): the brief is one plain ask to the Lead, so it is the question alone. The test, limits and approvals
// travel in their own fields.
export const briefText = d => d.question.trim();

// What POST /api/expedition receives (the route is the backend's; this is the front end's side of it).
export function launchBody(project, d, st = null) {
  const roles = {};
  for (const r of ROLE_LIST) roles[r.key] = { model: d.roles[r.key].model, effort: d.roles[r.key].effort };
  const dollars = estimateUSD(d.percent, st);
  return {
    project,
    brief: briefText(d),
    question: d.question.trim(),
    ...(Object.keys(testFiles(d.success)).length ? { test: testFiles(d.success) } : {}),   // none written: only the question goes; the team writes the test while it plans
    envelope: { hours: d.hours, percent: d.percent, ...(dollars != null ? { dollars } : {}) },
    gatherers: d.gatherers,
    roles,
    preApprovals: { sites: d.sites.map(s => ({ host: s.host, access: s.access })), packages: d.packages.map(x => ({ eco: x.eco, name: x.name })) }
  };
}

// ---------- drawing ----------
const help = tip => `<span class="xp-help" tabindex="0" title="${esc(tip)}" aria-label="${esc(tip)}" role="img">${ic('help')}</span>`;
const warnMark = (items, extra = '') => items.length ? `<span class="xp-warn" tabindex="0" role="img" title="${esc(items.map(p => p.text).join('\n'))}" aria-label="${esc(items.map(p => p.text).join(' '))}">${ic('warn')}${extra}</span>` : '';
const tips = {
  question: 'The one question the team answers. Write it so you could tell from the report whether it was answered.',
  test: 'The success test is frozen once the plan is approved: the team cannot change it afterwards. Each item says how it is judged.',
  envelope: 'The expedition stops by itself at the first limit it reaches. The last tenth of each is kept for writing the report.',
  pre: 'Sites and packages the team may use without asking, for this expedition only. Nothing is added to your own lists.',
  team: 'Each role runs on the model and effort shown. Change one for this run only; lasting changes go in the project\'s .claude/agents files or hub.json.'
};

export function panelHtml(d, ctx, h) {
  const ps = problems(d, ctx), blocks = ps.filter(p => p.level === 'block'), warns = ps.filter(p => p.level === 'warn');
  const tot = teamTotals(d, h.family);
  const usd = estimateUSD(d.percent, ctx.st);
  const segBtn = (grp, val, label, on) => `<button type="button" role="radio" aria-checked="${on}" class="xp-opt ${on ? 'on' : ''}" data-xp-${grp}="${val}">${label}</button>`;
  const judge = (t, i) => `<li class="xp-test" data-i="${i}">
      <input class="xp-in xp-t-text" data-xp-t="${i}" value="${esc(t.text)}" placeholder="What must be true when it is done" aria-label="Success test item ${i + 1}" autocomplete="off">
      <span class="xp-judge" role="radiogroup" aria-label="How item ${i + 1} is judged">${JUDGES.map(([k, label, tip]) => `<button type="button" role="radio" aria-checked="${t.judge === k}" class="xp-j ${t.judge === k ? 'on' : ''} ${k}" data-xp-judge="${i}:${k}" title="${esc(tip)}" aria-label="${esc(label)}: ${esc(tip)}">${ic(k === 'command' ? 'terminal' : k === 'outside' ? 'ban' : 'list')}<span>${label}</span></button>`).join('')}</span>
      <button type="button" class="xp-btn rm" data-xp-rm-test="${i}" title="Remove this item" aria-label="Remove item ${i + 1}">${ic('x')}</button>
      ${t.judge === 'command' ? `<input class="xp-in xp-t-cmd" data-xp-c="${i}" value="${esc(t.command)}" placeholder="Command to run, for example: npm test" aria-label="Command for item ${i + 1}" spellcheck="false" autocomplete="off">` : ''}
    </li>`;
  const chips = [...d.sites.map((s, i) => `<span class="xp-chip" title="${esc(s.host)}: ${s.access === 'downloads' ? 'pages and downloads' : 'pages'}">${ic('globe')}<b>${esc(s.host)}</b><button type="button" data-xp-rm-site="${i}" aria-label="Remove ${esc(s.host)}" title="Remove ${esc(s.host)}">${ic('x')}</button></span>`),
    ...d.packages.map((x, i) => `<span class="xp-chip" title="${esc(x.name)} (${esc(x.eco)})">${ic('box')}<b>${esc(x.name)}</b><button type="button" data-xp-rm-pkg="${i}" aria-label="Remove ${esc(x.name)}" title="Remove ${esc(x.name)}">${ic('x')}</button></span>`)].join('');
  const addForm = d.add === 'site'
    ? `<div class="xp-addform"><input class="xp-in" data-xp-new="site" placeholder="docs.example.org" aria-label="Site" inputmode="url" autocapitalize="off" spellcheck="false" autocomplete="off"><button type="button" class="btn primary" data-xp-add-ok="site">${ic('check')}Add</button><button type="button" class="btn ghost" data-xp-add-no title="Close without adding">${ic('x')}<span class="sr">Cancel</span></button></div>`
    : d.add === 'package'
      ? `<div class="xp-addform"><span class="xp-seg" role="radiogroup" aria-label="From">${['npm', 'pip'].map(e => `<button type="button" role="radio" aria-checked="${(d.addEco || 'npm') === e}" class="xp-opt ${(d.addEco || 'npm') === e ? 'on' : ''}" data-xp-eco="${e}">${e}</button>`).join('')}</span><input class="xp-in" data-xp-new="package" placeholder="exact package name" aria-label="Package name" autocapitalize="off" spellcheck="false" autocomplete="off"><button type="button" class="btn primary" data-xp-add-ok="package">${ic('check')}Add</button><button type="button" class="btn ghost" data-xp-add-no title="Close without adding">${ic('x')}<span class="sr">Cancel</span></button></div>`
      : `<div class="xp-adds"><button type="button" class="xp-add" data-xp-add="site">${ic('plus')}Site</button><button type="button" class="xp-add" data-xp-add="package">${ic('plus')}Package</button></div>`;

  const role = r => {
    const cfg = d.roles[r.key], id = cfg.model, hue = h.hueOf(id), open = d.editing === r.key;
    const chip = `<button type="button" class="mchip xp-chipbtn" style="--mh:${hue || '#8792ad'}" data-xp-edit="${r.key}" aria-expanded="${open}" title="${esc(h.modelLabel(id))}, effort ${esc(cfg.effort)}. Change model or effort for this run">${esc(h.modelLabel(id))} ${h.pips(cfg.effort)}${'<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>'}</button>`;
    const step = r.count ? `<span class="xp-step" title="Up to ${d.gatherers} at once (the limit is ${GATHERER_LIMIT}), one second round if needed"><button type="button" data-xp-step="-1" aria-label="One fewer gatherer at once" title="One fewer" ${d.gatherers <= 1 ? 'disabled' : ''}>${ic('minus')}</button><b aria-live="polite">${d.gatherers}</b><button type="button" data-xp-step="1" aria-label="One more gatherer at once" title="One more (the limit is ${GATHERER_LIMIT})" ${d.gatherers >= GATHERER_LIMIT ? 'disabled' : ''}>${ic('plus')}</button></span>` : '';
    return `<li class="xp-role ${open ? 'open' : ''}" style="--mh:${hue || '#8792ad'}" data-role="${r.key}">
      <span class="xp-ico">${ic(r.key)}</span>
      <span class="xp-rmain"><b>${esc(r.label)}${r.count ? ` <em class="xp-upto">up to</em>` : ''}</b><span class="xp-blurb">${esc(r.blurb)}</span></span>
      <span class="xp-racts">${step}${chip}</span>
      ${open ? `<div class="xp-pick"><div class="xp-pick-row"><span class="flabel">Model</span>${h.modelPicker(`xm-${r.key}`, id)}</div><div class="xp-pick-row"><span class="flabel">Effort</span>${h.effortPicker(`xe-${r.key}`, cfg.effort, hue)}</div></div>` : ''}
    </li>`;
  };
  const bar = ['opus', 'sonnet', 'haiku', 'fable'].filter(f => tot.by[f]).map(f => `<i style="flex:${tot.by[f]};background:${h.hueOf(f) || '#8792ad'}" title="${tot.by[f]} on ${f[0].toUpperCase()}${f.slice(1)}"></i>`).join('');
  const split = ['opus', 'sonnet', 'haiku', 'fable'].filter(f => tot.by[f]).map(f => `${f[0].toUpperCase()}${f.slice(1)} ${tot.by[f]}`).join(' · ');

  return `<div class="xp" aria-label="New expedition"><div class="xp-scroll">
    <div class="xp-sub"><span class="xp-proj">${esc(ctx.project || '')}</span>${ctx.level ? `<span class="xp-lvl" title="This project's permission level">${esc({ standard: 'Ask', auto: 'Auto', trusted: 'Trusted' }[ctx.level] || '')}</span>` : ''}</div>
    <div class="xp-cols">
      <div class="xp-col xp-scope">
        <section><h3 class="xp-h">What do you want done or answered? ${help(tips.question)}</h3>
          <textarea class="xp-in xp-q" data-xp-q rows="4" placeholder="Say it in your own words. The team plans the rest." aria-label="What you want done or answered" spellcheck="true">${esc(d.question)}</textarea>${d.reason ? `<p class="xp-reason">${esc(d.reason)}</p>` : ''}</section>
        <section><h3 class="xp-h">Envelope ${help(tips.envelope)}</h3>
          <div class="xp-env"><span class="xp-eico" title="Time limit">${ic('clock')}</span><span class="xp-seg" role="radiogroup" aria-label="Time limit">${HOURS.map(v => segBtn('hours', v, `${v} h`, d.hours === v)).join('')}</span></div>
          <div class="xp-env"><span class="xp-eico" title="Share of your plan">${ic('coin')}</span><span class="xp-seg" role="radiogroup" aria-label="Share of your plan">${PERCENTS.map(v => segBtn('percent', v, `${v} %`, d.percent === v)).join('')}</span><span class="xp-usd" title="${usd == null ? 'No dollar figure is confirmed yet' : 'The dollar cap the hub enforces: this share of the plan at the confirmed rate'}">${usd == null ? 'no dollar cap yet' : `≈ ${money(usd)}`}</span></div></section>
        <details class="xp-more" data-xp-more ${d.more ? 'open' : ''}><summary><span>More</span><em>${d.more ? '' : 'a success test, pre-approved sites and packages (optional)'}</em></summary>
          <section><h3 class="xp-h">Success test ${help(tips.test)}</h3>
            <p class="xp-opt-note">Optional. Leave it empty and the team writes one while it plans.</p>
            <ul class="xp-tests">${d.success.map(judge).join('')}</ul>
            <button type="button" class="xp-add" data-xp-add-test>${ic('plus')}Add an item</button></section>
          <section><h3 class="xp-h">Pre-approved ${help(tips.pre)}${ctx.level === 'auto' && !d.sites.length ? warnMark(warns.filter(p => p.id === 'web')) : ''}</h3>
            <div class="xp-chips">${chips}</div>${addForm}</section>
        </details>
      </div>
      <div class="xp-col xp-team">
        <section><h3 class="xp-h">Team ${help(tips.team)}</h3>
          <ul class="xp-roles">${ROLE_LIST.map(role).join('')}</ul>
          <div class="xp-total"><b>${tot.total} agents at most</b><span class="xp-bar" aria-hidden="true">${bar}</span><span class="xp-split">${esc(split)}</span></div>
          <p class="xp-note">${ic('check')}<span>${blocks.some(p => p.id === 'same') ? 'The Verifier and the Builder must run on different models.' : 'The Verifier runs on a different model from the Builder.'}</span></p>
        </section>
      </div>
    </div></div>
    <footer class="xp-foot">
      <p class="xp-fixed">${ic('branch')}<span>Ends at one branch and a draft PR. It never merges.</span></p>
      <div class="xp-acts">
        ${warnMark(warns)}
        <button type="button" class="btn ghost xp-cancel" data-xp-cancel title="Close without launching">Cancel</button>
        <button type="button" class="btn primary xp-go" data-xp-go ${blocks.length ? 'disabled' : ''} title="${esc(blocks.length ? blocks.map(p => p.text).join(' ') : 'Start the expedition')}">${ic('compass')}Launch</button>
      </div>
    </footer>
  </div>`;
}

// ---------- the pop-up ----------
export class ExpeditionPanel {
  // host: { api(path, body), toast(msg, tone), project(): the current project view, modelPicker, effortPicker, hueOf, family, modelLabel, pips, models, afterLaunch(result) }
  constructor(host) { this.host = host; this.d = null; this.busy = false; this.dialog = null; this.error = ''; }

  open(seed = {}) {
    const p = this.host.project();
    if (!p) return;
    this.launched = false;
    this.p = p; this.seedMeta = seed.draft ? { draft: seed.draft } : seed.proposal ? { proposal: seed.proposal } : null;   // sent back so the hub closes the card
    // A question typed and then lost to a stray outside click (the panel closes on one) comes back on the next blank open.
    this.d = startDraft(p.expedition || null, !seed.question && !seed.draft && !seed.proposal && this.kept ? { ...seed, question: this.kept } : seed);
    this.paint(true);
  }
  ctx() {
    const p = this.p, level = ['standard', 'auto', 'trusted'].includes(p.permissionMode) ? p.permissionMode : 'standard';
    return { project: p.name, level, check: ['shadow', 'on'].includes(p.permissionCheck) ? p.permissionCheck : 'off', running: !!p.expedition?.current && p.expedition.current.phase !== 'ended', st: p.expedition || null, family: this.host.family };
  }
  // Roles carry model ids (from the picker); the hub's defaults carry families (opus). Both mean the same model here.
  paint(first = false) {
    const h = this.host, body = panelHtml(this.d, this.ctx(), { ...h, modelPicker: (n, v) => h.modelPicker(n, this.idOf(v)), family: h.family });
    if (first) { this.mount(body); return; }
    const hb = this.dialog.querySelector('.hc-body'), top = hb.querySelector('.xp-scroll')?.scrollTop || 0;
    hb.innerHTML = body;
    const sc = hb.querySelector('.xp-scroll'); if (sc) sc.scrollTop = top;
  }
  idOf(v) { const m = this.host.models.find(x => x.key === v || x.id === v); return m ? m.id : v; }
  mount(body) {
    this.host.openPanel(body, 'New expedition');
    const dlg = this.dialog = document.querySelector('dialog.hud-card');
    dlg.classList.add('exp-panel');
    if (!dlg.dataset.xp) {
      dlg.dataset.xp = '1';
      dlg.addEventListener('click', e => this.click(e));
      dlg.addEventListener('input', e => this.input(e));
      dlg.addEventListener('change', e => this.change(e));
      dlg.addEventListener('toggle', e => { if (this.d && e.target.matches?.('[data-xp-more]')) { this.d.more = e.target.open; if (e.target.open) { this.d.touched = true; this.refreshFoot(); } } }, true);   // the fold remembers itself across redraws
      dlg.addEventListener('close', () => { dlg.classList.remove('exp-panel'); if (this.d && !this.launched && this.d.question.trim() && !this.seedMeta) this.kept = this.d.question; this.d = null; });
    }
    dlg.querySelector('.hc-x')?.setAttribute('title', 'Close without launching');
    dlg.querySelector('.xp-q')?.focus({ preventScroll: true });
  }
  close() { this.host.closePanel(); }

  click(e) {
    const d = this.d; if (!d) return;
    const t = e.target, q = s => t.closest(s);
    if (!q('.xp')) return;
    let b;
    if (q('[data-xp-cancel]')) return this.close();
    if (q('[data-xp-go]')) return this.launch();
    if ((b = q('[data-xp-hours]'))) { d.hours = Number(b.dataset.xpHours); d.touched = true; }
    else if ((b = q('[data-xp-percent]'))) { d.percent = Number(b.dataset.xpPercent); d.touched = true; }
    else if ((b = q('[data-xp-judge]'))) { const [i, k] = b.dataset.xpJudge.split(':'); d.success[Number(i)].judge = k; }
    else if ((b = q('[data-xp-rm-test]'))) { d.success.splice(Number(b.dataset.xpRmTest), 1); }
    else if (q('[data-xp-add-test]')) d.success.push({ text: '', judge: 'checklist', command: '' });
    else if ((b = q('[data-xp-rm-site]'))) d.sites.splice(Number(b.dataset.xpRmSite), 1);
    else if ((b = q('[data-xp-rm-pkg]'))) d.packages.splice(Number(b.dataset.xpRmPkg), 1);
    else if ((b = q('[data-xp-add]'))) d.add = b.dataset.xpAdd;
    else if (q('[data-xp-add-no]')) d.add = null;
    else if ((b = q('[data-xp-eco]'))) d.addEco = b.dataset.xpEco;
    else if ((b = q('[data-xp-add-ok]'))) { if (!this.addEntry(b.dataset.xpAddOk)) return; }
    else if ((b = q('[data-xp-step]'))) d.gatherers = Math.min(GATHERER_LIMIT, Math.max(1, d.gatherers + Number(b.dataset.xpStep)));
    else if ((b = q('[data-xp-edit]'))) d.editing = d.editing === b.dataset.xpEdit ? null : b.dataset.xpEdit;
    else return;
    this.paint();
    if (b?.dataset?.xpAdd) this.dialog.querySelector('[data-xp-new]')?.focus();
    if (q('[data-xp-add-test]') !== null && t.closest('[data-xp-add-test]')) this.dialog.querySelectorAll('.xp-t-text')[d.success.length - 1]?.focus();
  }
  addEntry(kind) {
    const inp = this.dialog.querySelector('[data-xp-new]'), v = String(inp?.value || '').trim();
    if (!v) { inp?.focus(); return false; }
    if (kind === 'site') { const host = v.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase(); if (host && !this.d.sites.some(s => s.host === host)) this.d.sites.push({ host, access: 'pages' }); }
    else if (!this.d.packages.some(x => x.name === v)) this.d.packages.push({ eco: this.d.addEco || 'npm', name: v });
    this.d.add = null;
    return true;
  }
  input(e) {
    const d = this.d, t = e.target; if (!d) return;
    if (t.matches('[data-xp-q]')) d.question = t.value;
    else if (t.matches('[data-xp-t]')) d.success[Number(t.dataset.xpT)].text = t.value;
    else if (t.matches('[data-xp-c]')) d.success[Number(t.dataset.xpC)].command = t.value;
    else return;
    this.refreshFoot();
  }
  change(e) {
    const d = this.d, t = e.target; if (!d || t.type !== 'radio') return;
    const m = /^x([me])-(\w+)$/.exec(t.name); if (!m) return;
    const r = d.roles[m[2]]; if (!r) return;
    if (m[1] === 'm') r.model = t.value; else r.effort = t.value;   // '' = what the role's agent file says
    this.paint();
  }
  // Typing changes only the footer (Launch and the amber mark), so the boxes keep their cursor.
  refreshFoot() {
    const dlg = this.dialog, ps = problems(this.d, this.ctx()), blocks = ps.filter(p => p.level === 'block');
    const go = dlg.querySelector('[data-xp-go]');
    go.disabled = blocks.length > 0;
    go.title = blocks.length ? blocks.map(p => p.text).join(' ') : 'Start the expedition';
    const mark = dlg.querySelector('.xp-acts .xp-warn');
    if (ps.length) {
      const tip = ps.map(p => p.text).join('\n');
      if (mark) { mark.title = tip; mark.setAttribute('aria-label', ps.map(p => p.text).join(' ')); }
      else this.paint();
    } else if (mark) this.paint();
  }
  async launch() {
    if (this.busy) return;
    const p = this.p, ps = problems(this.d, this.ctx());
    if (ps.some(x => x.level === 'block')) return;
    this.busy = true;
    const go = this.dialog.querySelector('[data-xp-go]'); if (go) go.disabled = true;
    try {
      const res = await this.host.api('/api/expedition', { ...launchBody(p.name, this.d, p.expedition || null), ...(this.seedMeta || {}) });
      this.launched = true; this.kept = '';
      this.close();
      this.host.toast('The expedition has started. Its Lead is planning; you will get one card when it finishes.', 'info');
      this.host.afterLaunch?.(res);
    } catch (e) {
      this.host.toast(`The expedition did not start: ${e.message}`);
      if (go) go.disabled = false;
    } finally { this.busy = false; }
  }
}
