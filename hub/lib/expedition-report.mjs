// The report's generated parts (spec 4.3 and 8): pure functions of the event log, so the figures are measured, not
// estimated (lesson 7 of the reference run). Section 7, "how it ran", is here; the finished card and the claims check
// come in phase 5.
import { ROLES } from './expedition.mjs';

// The order rows are shown in: the hub roles. The gatherers are subagents inside the Lead (decision 68 C): they have no row
// of their own, and the Lead's row says so.
const ROW_ORDER = ['lead', 'advisor', 'synthesizer', 'skeptic', 'builder', 'verifier'];
export const LEAD_LABEL = 'Lead (incl. gatherers)';
export const NOT_SPLIT_NOTE = 'Gatherers run inside the Lead, so their time and cost are in the Lead\'s line and are not split out.';

const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
const label = role => (role === 'lead' ? LEAD_LABEL : ROLES[role]?.label || role);

// Time, tokens and cost per role, loops and the stop reason, from the events of one expedition.
// events: the project's event log (all of it is fine; other expeditions' and non-expedition events are ignored).
export function howItRan(events, id) {
  const mine = events.filter(e => e.expedition === id);
  const started = mine.find(e => e.type === 'expedition_started') || null;
  const stopped = mine.findLast(e => e.type === 'expedition_stopped') || null;
  const roleOf = new Map(mine.filter(e => e.type === 'agent_created').map(e => [e.agent, e.expeditionRole]));
  const rows = new Map();
  const row = role => {
    if (!rows.has(role)) rows.set(role, { role, label: label(role), agents: new Set(), turns: 0, workMs: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, costUSD: 0 });
    return rows.get(role);
  };
  for (const e of mine.filter(e => e.type === 'usage')) {
    const r = row(e.expeditionRole || roleOf.get(e.agent) || 'unknown');
    r.agents.add(e.agent);
    const models = Object.values(e.models || {});
    if (models.length) r.turns++;
    for (const m of models) for (const k of Object.keys(r.tokens)) r.tokens[k] += num(m[k]);
    r.costUSD += num(e.costUSD);
  }
  // Time at work: from each agent's busy marks (agent_busy carries no expedition tag, so match by the agent's name).
  // A turn still open at the stop counts up to the stop (or the last event).
  const names = new Set(roleOf.keys());
  let end = stopped ? Date.parse(stopped.ts) : 0;
  if (!stopped) for (const e of events) end = Math.max(end, Date.parse(e.ts) || 0);
  const openSince = new Map();
  for (const e of events) {
    if (e.type !== 'agent_busy' || !names.has(e.agent)) continue;
    const role = roleOf.get(e.agent), t = Date.parse(e.ts);
    if (e.busy) { if (!openSince.has(e.agent)) openSince.set(e.agent, t); continue; }
    if (openSince.has(e.agent)) { row(role).workMs += Math.max(0, t - openSince.get(e.agent)); openSince.delete(e.agent); row(role).agents.add(e.agent); }
  }
  for (const [agent, t] of openSince) { const r = row(roleOf.get(agent)); r.workMs += Math.max(0, end - t); r.agents.add(agent); }

  const ordered = [...rows.values()].sort((a, b) => (ROW_ORDER.indexOf(a.role) + 1 || 99) - (ROW_ORDER.indexOf(b.role) + 1 || 99)).map(r => ({ ...r, agents: [...r.agents] }));
  const totals = { turns: 0, workMs: 0, costUSD: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } };
  for (const r of ordered) {
    totals.turns += r.turns; totals.workMs += r.workMs; totals.costUSD += r.costUSD;
    for (const k of Object.keys(totals.tokens)) totals.tokens[k] += r.tokens[k];
  }
  return {
    id,
    rows: ordered,
    totals,
    elapsedMs: started && stopped ? Math.max(0, Date.parse(stopped.ts) - Date.parse(started.ts)) : null,
    stopReason: stopped?.reason || null,
    loops: mine.filter(e => e.type === 'expedition_loop').map(e => ({ number: e.number, passing: e.passing, progress: !!e.progress, tampered: !!e.tampered })),
    // Phase 4 and 5: each time the hub found test/ changed after the freeze (at a loop or the finish) and what it did about it.
    integrity: mine.filter(e => e.type === 'expedition_integrity').map(e => ({ at: e.at, restored: !!e.restored, changed: e.changed || [], changedCount: e.changedCount ?? (e.changed || []).length, why: e.why || null })),
    decisions: mine.filter(e => e.type === 'expedition_decision').length,
    parked: mine.filter(e => e.type === 'expedition_parked' && e.kind !== 'lesson').length,   // outside the brief, and requests that were not allowed
    requests: mine.filter(e => e.type === 'expedition_parked' && e.kind === 'request').length,   // of those, the requests
    lessons: mine.filter(e => e.type === 'expedition_parked' && e.kind === 'lesson').length,
    notes: ordered.some(r => r.role === 'lead') ? [NOT_SPLIT_NOTE] : []
  };
}

const dur = ms => { if (ms == null) return 'n/a'; const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };
const tok = n => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const usd = n => `$${n.toFixed(2)}`;

// Section 7 of REPORT.md as Markdown. "Lessons" is left for the Lead to add; this part is only what the log says.
export function howItRanMarkdown(r) {
  const out = ['## How it ran', ''];
  out.push(`Generated from the hub's event log (usage events and expedition events), not estimated. Stop reason: ${r.stopReason || 'not stopped yet'}. Elapsed: ${dur(r.elapsedMs)}.`, '');
  out.push('| Role | Agents | Turns | Time at work | Tokens (in / out) | Cost |', '|---|---|---|---|---|---|');
  for (const x of r.rows) out.push(`| ${x.label} | ${x.agents.length} | ${x.turns} | ${dur(x.workMs)} | ${tok(x.tokens.input + x.tokens.cacheRead + x.tokens.cacheCreation)} / ${tok(x.tokens.output)} | ${usd(x.costUSD)} |`);
  out.push(`| **Total** | | ${r.totals.turns} | ${dur(r.totals.workMs)} | ${tok(r.totals.tokens.input + r.totals.tokens.cacheRead + r.totals.tokens.cacheCreation)} / ${tok(r.totals.tokens.output)} | ${usd(r.totals.costUSD)} |`);
  for (const n of r.notes) out.push('', n);
  out.push('', `Build-verify loops: ${r.loops.length ? r.loops.map(l => `${l.number} (${l.passing} passing${l.tampered ? ', test/ was changed: a Verifier FAIL' : l.progress ? '' : ', no progress'})`).join('; ') : 'none'}. Decisions made on the user's behalf: ${r.decisions}. Parked: ${r.parked}${r.requests ? ` (${r.requests} of them requests that were not allowed)` : ''}.${r.lessons ? ` Core lessons held: ${r.lessons}.` : ''}`);
  // Phase 5 (asked for by phase 4's builder): every time the hub found the frozen test changed, one line each.
  const tampered = r.loops.filter(l => l.tampered).length;
  if (r.integrity?.length || tampered) {
    out.push('', `Test integrity: test/ was found changed after the freeze ${r.integrity.length} time${r.integrity.length === 1 ? '' : 's'}; ${tampered} loop${tampered === 1 ? ' was' : 's were'} counted as a Verifier FAIL because of it.`);
    for (const i of r.integrity) {
      const names = i.changed.length ? `${i.changed.slice(0, 6).join(', ')}${i.changedCount > 6 ? `, and ${i.changedCount - 6} more` : ''}` : 'no names recorded';
      out.push(`- at the ${i.at || 'check'}: ${names}; ${i.restored ? 'restored from the stored copy' : `not restored${i.why ? ` (${i.why})` : ''}`}.`);
    }
  }
  out.push('', 'Spend figures here are the results\' logged usage. While a turn runs, the hub\'s watchdog counts an upper-bound estimate that each result replaces (memo M046), so a limit may trip a little early, never late.');
  return out.join('\n');
}

// ---------- phase 5: the end ----------
// The marker the hub's generated part of REPORT.md starts at. The Lead writes sections 1 to 6 and 8 above it; the hub writes
// what only the log knows. Running the report step again cuts at the marker first, so the part is never doubled.
export const GENERATED_MARK = '<!-- hub-generated: everything below this line is written by the hub from the event log -->';
const flat = s => String(s ?? '').replace(/\s+/g, ' ').trim();
export const clipText = (s, n) => { const t = flat(s); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

// The report's one-line answer: the first plain line under its Answer heading ("## Answer", "## 1. Answer"). null if there is none.
export function answerLine(md) {
  const lines = String(md ?? '').split(/\r?\n/);
  const i = lines.findIndex(l => /^#{1,4}\s*(\d+[.)]?\s*)?answer\b/i.test(l.trim()));
  if (i < 0) return null;
  for (const l of lines.slice(i + 1)) {
    const t = l.trim();
    if (!t) continue;
    if (/^#{1,6}\s/.test(t)) return null;
    return clipText(t.replace(/^[-*>\d.)\s]+/, '').replace(/[*_`]/g, ''), 200) || null;
  }
  return null;
}

// Parked lines of one expedition that can become a next expedition (outside the brief; not a refused request or a held lesson).
export const isProposal = e => e.type === 'expedition_parked' && (e.kind === undefined || e.kind === 'parked');
// The brief a Launch action pre-fills for a parked item.
export function proposalBrief({ expedition, question, text, reason }) {
  return [`Follow-up to expedition ${expedition}${question ? ` ("${clipText(question, 120)}")` : ''}.`, '', `Question: ${flat(text)}`, '', `Why it was parked there: ${flat(reason)}`, '', 'Write the success test before you launch: what would show this is answered?'].join('\n');
}
// Proposed next expeditions from an expedition's parked events, each with a short brief.
export function proposalsOf(events, id, question = '') {
  return events.filter(e => e.expedition === id && isProposal(e)).map(e => ({ id: e.id, expedition: id, question: flat(text0(e.text)), text: flat(e.text), reason: flat(e.reason), brief: proposalBrief({ expedition: id, question, text: e.text, reason: e.reason }) }));
}
const text0 = t => clipText(t, 140);

// The hub's part of REPORT.md: sections 6 and 7 from the log, and what the hub knows about the claims check.
// claims: 'checked' | 'not checked'. hubStop: the stop was the hub's (time, budget or the user's Stop).
export function generatedReport({ events, id, question = '', claims, hubStop, leadWrote }) {
  const r = howItRan(events, id);
  const parked = events.filter(e => e.expedition === id && e.type === 'expedition_parked');
  const next = parked.filter(isProposal), requests = parked.filter(e => e.kind === 'request'), lessons = parked.filter(e => e.kind === 'lesson');
  const out = [GENERATED_MARK, ''];
  if (!leadWrote) out.push('> The Lead did not write REPORT.md before the end, so sections 1 to 5 and 8 are missing. Read the notes, the synthesis and the verdict in the expedition folder.', '');
  out.push(`## Claims check`, '', claims === 'checked'
    ? 'The Verifier\'s claims pass ran (verify/VERDICT.md has a claims or corrections section).'
    : `Claims not checked${hubStop ? ': the hub stopped the expedition before the Verifier finished its claims pass' : ': verify/VERDICT.md has no claims or corrections section'}. Treat the numbers and claims above as the Lead's, not verified.`, '');
  out.push('## Parked, as proposed next expeditions', '');
  out.push(...(next.length ? next.map((e, i) => `${i + 1}. ${flat(e.text)} (why parked: ${flat(e.reason)}). Launch pre-fills a brief from this line.`) : ['None.']), '');
  if (requests.length) out.push('## Requests that were not allowed', '', ...requests.slice(0, 15).map(e => `- ${clipText(e.text, 160)} (${clipText(e.reason, 120)})`), ...(requests.length > 15 ? [`- and ${requests.length - 15} more in the log`] : []), '');
  if (lessons.length) out.push('## Core lessons held for you', '', ...lessons.map(e => `- ${clipText(e.text, 300)} (${e.maker || 'an agent'})`), '');
  out.push(howItRanMarkdown(r), '');
  return out.join('\n');
}
// Did the Verifier's VERDICT.md carry its claims pass? The standing instruction asks for "## Claims check"; any heading
// (level 1 to 6, numbered or not) that names claims, corrections or a fact check is taken, so small differences pass.
export function claimsStatus(verdictText) {
  return /^#{1,6}\s.*\b(claims?|corrections?|fact[- ]?check\w*)\b/im.test(String(verdictText ?? '')) ? 'checked' : 'not checked';
}

// The Lead is told not to write "how it ran", but one that does (an empty placeholder, say) must not leave two: its section,
// from that heading to the next heading of the same or a higher level, is dropped, and the hub's own is the one.
export function dropLeadHowItRan(md) {
  const lines = String(md ?? '').split(/\r?\n/), out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(\d+[.)]?\s*)?how it ran\b/i.exec(lines[i]);
    if (!m) { out.push(lines[i]); continue; }
    while (i + 1 < lines.length && !(/^(#{1,6})\s/.test(lines[i + 1]) && /^(#+)/.exec(lines[i + 1])[1].length <= m[1].length)) i++;
  }
  return out.join('\n');
}

// REPORT.md as the end leaves it: what the Lead wrote (without any earlier generated part) plus the hub's part.
export function assembleReport({ leadText, ...rest }) {
  const lead = String(leadText ?? '');
  const cut = lead.indexOf(GENERATED_MARK);
  const body = dropLeadHowItRan(cut >= 0 ? lead.slice(0, cut) : lead).trimEnd();
  const leadWrote = !!body.trim();
  return `${leadWrote ? body : '# Report'}\n\n${generatedReport({ ...rest, leadWrote })}`;
}
