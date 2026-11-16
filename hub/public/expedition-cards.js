// The Expedition module, phase 5: the two cards in the orchestrator's thread (decision 70 A, option C's card, and the spec's
// "Expedition finished" card, 4.8). Plain functions that return HTML, so they can be tested without a browser.
//   draftCard(ev, closed, st)        "Expedition draft": the brief in two lines, the test, the envelope, the team strip, Launch / Edit
//   finishedCard(ev, proposals)      "Expedition finished": the answer, how it ended, counts, the PR, and Launch on each next expedition
//   draftSeed(ev) / draftBody(...)   what Edit opens the panel with, and what Launch sends
// Neither card counts in Needs you (it is a done card, not a call for you) and neither is ever red (decision 31).
import { ROLE_LIST, ic, testItems, teamTotals, estimateUSD, money, startDraft } from './expedition-launch.js';
import { hueOf, family } from './models.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const warn = tip => `<span class="xc-warn" tabindex="0" role="img" title="${esc(tip)}" aria-label="${esc(tip)}">${ic('warn')}</span>`;

export const STOP_WORDS = { passed: 'The test passed', time: 'Ran out of time', budget: 'Reached its budget', 'no-progress': 'Stopped making progress', Matt: 'You stopped it' };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What the panel opens with for a draft: the same fields the backend stored.
export const draftSeed = ev => ({
  question: ev.question || '', test: ev.test, envelope: ev.envelope, roles: ev.roles, gatherers: ev.gatherers, preApprovals: ev.preApprovals, draft: ev.id
});
// What Launch on the card sends (the draft exactly as the orchestrator wrote it).
export const draftBody = (project, ev) => ({
  project, brief: ev.brief, question: ev.question || undefined, test: ev.test, envelope: ev.envelope, roles: ev.roles, gatherers: ev.gatherers, preApprovals: ev.preApprovals, draft: ev.id
});
// A proposed next expedition opens the panel with its short brief, so you can change it first (Launch there sends proposal).
export const proposalSeed = pr => ({ question: pr.question || pr.text || '', success: [], proposal: { expedition: pr.expedition, parked: pr.id }, brief: pr.brief });

// The closing event for a draft, if any (expedition_draft_closed { draft, status, expedition? }).
export const closedOf = (events, id) => events.find(e => e.type === 'expedition_draft_closed' && e.draft === id) || null;

export function draftCard(ev, closed = null, st = null) {
  const items = testItems(ev.test), n = { command: 0, checklist: 0, outside: 0 };
  for (const t of items) n[t.judge]++;
  const sites = ev.preApprovals?.sites?.length || 0, pkgs = ev.preApprovals?.packages?.length || 0;
  const env = ev.envelope || {}, usd = estimateUSD(env.percent, st);
  const edited = Object.keys(ev.roles || {}).length > 0;
  const d = startDraft(st, { roles: ev.roles, gatherers: ev.gatherers }), tot = teamTotals(d, family);
  const state = closed ? (closed.status === 'launched' ? 'launched' : 'dismissed') : 'open';
  const tag = { open: 'Not launched', launched: 'Launched', dismissed: 'Dismissed' }[state];
  const lines = String(ev.question || ev.brief || '').trim();
  const parts = [n.command && `${n.command} command`, n.checklist && `${n.checklist} checklist`, n.outside && `${n.outside} not run here`].filter(Boolean).join(' · ');
  const hasWarn = n.outside > 0 ? warn('Some items cannot run here: the report will ask you to paste those results.') : '';
  const tiles = `<div class="xc-tiles">
      <div class="xc-tile"><span class="xc-k">Success test</span><b>${plural(items.length, 'item')} ${hasWarn}</b><small>${esc(parts || 'none written')}</small></div>
      <div class="xc-tile"><span class="xc-k">Envelope</span><b>${ic('clock')}${esc(env.hours ?? 6)} h ${ic('coin')}${esc(env.percent ?? 7)} %</b><small>${usd != null ? `about ${esc(money(usd))} of the week` : 'no dollar cap yet'}</small></div>
      <div class="xc-tile"><span class="xc-k">Pre-approved</span><b>${ic('globe')}${sites} ${ic('box')}${pkgs}</b><small>sites · packages</small></div>
    </div>`;
  const team = `<div class="xc-team"><span class="xc-k">Team</span><span class="xc-roles">${ROLE_LIST.map(r => `<i style="--mh:${hueOf(d.roles[r.key].model) || '#8792ad'}" title="${esc(r.label)}">${ic(r.key)}</i>`).join('')}</span><span class="xc-teamnote">${edited ? 'edited' : 'default'} · ${tot.total} agents at most</span></div>`;
  return `<article class="card xcard xdraft ${state}" data-xdraft="${esc(ev.id)}">
    <div class="card-head"><span class="xc-kk">Expedition draft</span><span class="xc-tag ${state}">${tag}</span>
      ${state === 'open' ? `<button type="button" class="btn ghost icon-only xc-x" data-xdraft-dismiss="${esc(ev.id)}" aria-label="Dismiss this draft" title="Dismiss this draft: nothing starts">${ic('x')}</button>` : ''}</div>
    <p class="xc-q">${esc(lines)}</p>
    ${tiles}${team}
    <p class="xc-fixed">${ic('branch')}<span>Ends at one branch and a draft PR. It never merges.</span></p>
    ${state === 'open'
      ? `<div class="xc-acts"><button type="button" class="btn primary" data-xdraft-launch="${esc(ev.id)}" title="Start the expedition exactly as drafted">${ic('compass')}Launch</button><button type="button" class="btn" data-xdraft-edit="${esc(ev.id)}" title="Open the draft in the panel to change it first">Edit</button></div>`
      : `<p class="xc-done">${state === 'launched' ? 'It is running; its row is in the thread list.' : 'You dismissed this draft. Nothing started.'}</p>`}
  </article>`;
}

// One line under "the report": where the files are. The PR is a link; the report is a path on this machine.
const prLink = pr => pr?.url ? `<a class="xc-pr" href="${esc(pr.url)}" target="_blank" rel="noopener" title="Open the draft PR on GitHub (it is never merged by the expedition)">${ic('branch')}<span>Draft PR${pr.number ? ` #${esc(pr.number)}` : ''}</span></a>` : '';

export function finishedCard(ev, proposals = [], opts = {}) {
  const why = STOP_WORDS[ev.stopReason] || String(ev.stopReason || 'Finished');
  const unchecked = ev.claimsChecked === false;
  const tiles = [['Stop reason', esc(why)], ['Test', ev.passing != null ? `${esc(ev.passing)} passing` : 'see the report'], ['Decisions', esc(ev.decisions ?? 0)], ['Parked', esc(ev.parked ?? 0)]];
  const next = proposals.length ? `<div class="xc-next"><span class="xc-k">Proposed next expeditions</span><ul>${proposals.map(pr => `<li><span class="xc-ptext" title="${esc(pr.reason || '')}">${esc(pr.question || pr.text)}</span><button type="button" class="btn xc-pl" data-xprop-launch="${esc(pr.id)}" title="Open a new expedition pre-filled with this brief">${ic('compass')}Launch</button></li>`).join('')}</ul></div>` : '';
  return `<article class="card xcard xfinished" data-xfinished="${esc(ev.expedition)}">
    <div class="card-head">${ic('check')}<span class="xc-kk">Expedition finished</span>${unchecked ? warn('The final check of the report\'s claims and numbers did not run, so treat them as unchecked.') : ''}${ev.problem ? warn(ev.problem) : ''}</div>
    <h3 class="xc-answer">${esc(ev.title || ev.answer || 'Finished')}</h3>
    ${ev.answer && ev.title && ev.answer !== ev.title ? `<p class="xc-q">${esc(ev.answer)}</p>` : ''}
    <div class="xc-tiles four">${tiles.map(([k, v]) => `<div class="xc-tile"><span class="xc-k">${k}</span><b>${v}</b></div>`).join('')}</div>
    <p class="xc-meta">${unchecked ? 'Claims not checked. ' : ''}${ev.lessons ? `${plural(ev.lessons, 'lesson')} held for your say. ` : ''}${ev.loops ? `${plural(ev.loops, 'build loop')}. ` : ''}${ev.pushed === false && ev.branch ? 'The branch was not pushed. ' : ''}</p>
    <div class="xc-links">${ev.branch ? `<span class="xc-branch" title="The branch the report is on">${ic('branch')}<code>${esc(ev.branch)}</code></span>` : ''}${prLink(ev.pr)}${ev.reportPath ? `<span class="xc-report" title="${esc(ev.reportPath)}">${ic('list')}<span>Report: ${esc(String(ev.reportPath).split(/[\\/]/).slice(-2).join('/'))}</span></span>` : ''}</div>
    ${next}
  </article>`;
}

// The sidebar row after the end: one line saying how it went (decision 70 and M049 item 1).
export const endedLine = cur => cur ? [STOP_WORDS[cur.stopReason] || cur.phase, cur.pr?.url ? 'draft PR open' : ''].filter(Boolean).join(' · ') : '';

// The small progress line while the end runs (expedition_step events: report, commit, push, pr, card, summary).
export const END_WORDS = { report: 'writing the report', commit: 'committing it', push: 'pushing the branch', pr: 'opening the draft PR', card: 'posting the card', summary: 'sending its summary' };
export function endProgress(events, id) {
  const done = events.filter(e => e.type === 'expedition_step' && e.expedition === id).map(e => e.step);
  if (!done.length) return '';
  const next = Object.keys(END_WORDS).find(s => !done.includes(s));
  return next ? `ending: ${END_WORDS[next]} (${done.length} of 6 done)` : 'ended';
}
