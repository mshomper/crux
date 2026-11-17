// The batch card for a profile import (decision 79 A), in Needs you. It reuses the lesson cards' Accept and Cancel path
// (data-lesson, data-accept -> /api/lessons): nothing is written before Accept. The proposed text lives in the hub, not in
// the event log, so the card asks for it (GET /api/profile/batch) and draws it when it arrives.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (id, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
export const IMPORT_CAP_TEXT = '60,000 characters';

// Lessons waiting: { batches: [import batches], plain: [ordinary lessons] }.
export const splitLessons = ls => ({ batches: ls.filter(l => l.batch), plain: ls.filter(l => !l.batch) });

const list = items => `<ul class="pf-list">${items.map(t => `<li>${esc(t)}</li>`).join('')}</ul>`;
// l: the lesson_proposed event (id in l.lesson, counts in l.counts). b: the proposed text, or null while it loads.
// projects: the names of the hub's projects, so a pack that matches none is labelled as not linked to a project.
export function batchCard(l, b, projects = null) {
  const packs = b ? Object.entries(b.packs || {}) : [];
  const names = projects ? new Set(projects.map(s => String(s).toLowerCase())) : null;
  return `<article class="card lessons pf-batch" data-batch="${esc(l.lesson)}">
    <div class="card-head">${ic('file-text')}<h3>Profile import: ready for your OK</h3></div>
    <p class="muted">${esc(String(l.text || '').replace(/^Profile import:\s*/, 'Found: '))}. Nothing is written until you accept. Anything private goes only to your private notes. Only the first ${IMPORT_CAP_TEXT} of an export are read.</p>
    ${!b ? '<p class="faint">Loading what was found...</p>' : `<div class="pf-body">
      ${b.core?.length ? `<h4>Core profile <span class="faint">${b.core.length}</span></h4>${list(b.core)}` : ''}
      ${packs.map(([name, items]) => `<h4>Project pack: ${esc(name)} <span class="faint">${items.length}${names && !names.has(name.toLowerCase()) ? ' · not linked to a project' : ''}</span></h4>${list(items)}`).join('')}
      ${b.private?.length ? `<h4>${ic('lock')}Your private notes <span class="faint">${b.private.length}</span></h4>${list(b.private)}` : ''}
      ${b.left ? `<p class="faint">${b.left} line${b.left === 1 ? ' was' : 's were'} left out: they read like instructions or secrets, not facts about you.</p>` : ''}</div>`}
    <div class="row"><button class="btn primary" data-lesson="${esc(l.lesson)}" data-accept="1" ${b ? '' : 'disabled'}>${ic('check')}Accept</button><button class="btn" data-lesson="${esc(l.lesson)}" data-accept="0">${ic('x')}Cancel</button></div>
  </article>`;
}
