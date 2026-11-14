// How an orchestrator or the Conductor is named on screen (Matt, 2026-11-14): by what it serves, with a small "vN" chip
// for which holder of the role it is. "orchestrator-6" in the project crux shows as crux v6; "conductor-3" as
// Conductor v3. Display only: agent names, ids, logs and tools stay as they are, and tooltips may keep the full name.
// Workers keep their own names.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ROLE = /^(orchestrator|conductor)-(\d+)$/;
const ANY = /\b(orchestrator|conductor)-(\d+)\b/g;

// { text, v }: the words to show and the holder number (null for anyone else). project: the project the agent is in.
export function nameParts(name, project) {
  const m = ROLE.exec(String(name ?? ''));
  if (!m) return { text: String(name ?? ''), v: null };
  return { text: m[1] === 'conductor' ? 'Conductor' : String(project || 'Orchestrator'), v: Number(m[2]) };
}

// The small chip; its hover keeps the internal name.
export const vchip = (v, title = '') => v == null ? '' : `<span class="vchip"${title ? ` title="${esc(title)}"` : ''}>v${v}</span>`;

// As HTML (escaped): "crux <chip>v6</chip>", or a worker's own name.
export function nameHtml(name, project) {
  const p = nameParts(name, project);
  return p.v == null ? esc(p.text) : `${esc(p.text)} ${vchip(p.v, name)}`;
}

// As plain text, where no HTML goes (canvas labels, titles, aria): "crux v6".
export function nameText(name, project) {
  const p = nameParts(name, project);
  return p.v == null ? p.text : `${p.text} v${p.v}`;
}

// A line of the hub's own words that names agents ("orchestrator-6 left handoff H012; orchestrator-7 takes over"):
// escaped, with every orchestrator or Conductor name shown the same way.
export function namesInHtml(text, project) {
  return esc(text).replace(ANY, m => nameHtml(m, project));
}
export function namesInText(text, project) {
  return String(text ?? '').replace(ANY, m => nameText(m, project));
}
