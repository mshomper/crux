// The decision brief (decision 50 B): a short part of the record written for the human, by the agent that drafts it.
//   "lead":    one or two sentences: what is being decided and what the agent recommends.
//   "for_you": two to four lines: what changes for the human, any setup, anything hard to undo. Each line is a string
//              or { "text", "kind" } with kind "change" (the default), "setup" or "undo".
// Pictures may carry "kind" (schematic, screenshot, mockup, chart) so the brief can label them; they sit beside the
// option they name. Records written before decision 50 have neither field: the brief is then laid out from the fields
// every record has, opening with the recommendation.
// Used by the build script (the .md and the page) and the hub (the card and its brief pop-up). No dependencies.
import { placedImages } from './images.mjs';

export const FOR_YOU_KINDS = ['change', 'setup', 'undo'];
const str = v => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';

// The written lead, or '' when the record has none.
export function leadOf(d) { return str(d?.lead).slice(0, 600); }

// The "for you" lines as [{ text, kind }], at most six, empty ones dropped.
export function forYouOf(d) {
  return (Array.isArray(d?.for_you) ? d.for_you : []).map(x => {
    const text = str(typeof x === 'string' ? x : x?.text).slice(0, 300);
    const kind = FOR_YOU_KINDS.includes(x?.kind) ? x.kind : 'change';
    return { text, kind };
  }).filter(x => x.text).slice(0, 6);
}

// Option sketches are inline SVG written by agents. The hub shows them as pictures (an <img> never runs anything in
// them), so the page's colour names are swapped for the hub's own colours first.
const COLOURS = { '--accent': '#8ea8ff', '--muted': '#a2aab7', '--good': '#5fd3ae', '--warn': '#f3b955', '--bad': '#f2727a', '--text': '#e7eaf0', '--faint': '#808a99', '--line': 'rgba(255,255,255,.12)', '--chosen': '#5fd3ae' };
export function sketchUri(svg) {
  let s = typeof svg === 'string' ? svg.trim() : '';
  if (!/^<svg[\s>]/i.test(s) || s.length > 40000) return '';
  s = s.replace(/var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g, (m, v) => COLOURS[v] || '#a2aab7').replace(/currentColor/gi, '#e7eaf0');
  if (!/^<svg[^>]*\sxmlns=/i.test(s)) s = s.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (!/^<svg[^>]*\sfont-family=/i.test(s)) s = s.replace(/^<svg/i, '<svg font-family="Segoe UI, system-ui, sans-serif"');   // the page's font, not the picture's serif default
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s).replace(/['()!*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

const list = v => (Array.isArray(v) ? v : []).map(str).filter(Boolean);

// Everything the hub's brief pop-up shows for one record, plain data only.
export function briefData(d) {
  const lead = leadOf(d);
  return {
    id: d.id, title: str(d.title), status: d.status, date: d.date || '', mode: d.mode || '',
    chosen: d.chosen || null, recommended: d.recommended || null, confidence: d.confidence || '',
    written: !!lead, lead, for_you: forYouOf(d),
    context: str(d.context), recommendation: str(d.recommendation), change_mind: str(d.change_mind), reason: str(d.reason),
    depends_on: (d.depends_on || []).filter(n => Number.isFinite(Number(n))).map(Number),
    options: (d.options || []).map(o => ({
      key: str(o.key), name: str(o.name), summary: str(o.summary), effort: str(o.effort),
      pros: list(o.pros), cons: list(o.cons), sketch: sketchUri(o.sketch)
    })),
    criteria: (d.criteria || []).map(c => ({ name: str(c.name), note: str(c.note), scores: Object.fromEntries(Object.entries(c.scores || {}).filter(([, v]) => [1, 2, 3].includes(v))) })),
    images: placedImages(d)
  };
}
