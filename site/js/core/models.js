// Model colours and effort pips (decision 20). Each model family has one hue, kept clear of the hub's
// status colours (red needs you, amber waiting, green done, blue working); effort is five pips in that hue.
export const MODEL_HUES = {
  opus: '#b47cff',    // violet
  sonnet: '#38d9ec',  // cyan
  haiku: '#ff7fd1',   // pink
  fable: '#d58a58'    // copper
};
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const EFFORT_WORDS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

export const family = id => /opus/i.test(id || '') ? 'opus' : /sonnet/i.test(id || '') ? 'sonnet' : /haiku/i.test(id || '') ? 'haiku' : /fable/i.test(id || '') ? 'fable' : null;
export const hueOf = id => MODEL_HUES[family(id)] || null;
// What an agent runs: its pick, else what Claude Code reported when it started.
export const modelOf = a => a?.model || a?.modelSeen || null;

const KNOWN = { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5', 'claude-fable-5-2': 'Fable 5.2' };
export function modelLabel(id) {
  if (!id) return 'Default model';
  if (KNOWN[id]) return KNOWN[id];
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:\b|-)/i.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}` : id;
}

// 1 to 5 lit for low to max; all hollow when the effort is Claude Code's default.
export const pipCount = effort => EFFORTS.indexOf(effort) + 1;
export function pips(effort) {
  const n = pipCount(effort);
  return `<span class="pips ${n ? '' : 'hollow'}" aria-hidden="true">${EFFORTS.map((_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</span>`;
}

// For canvas drawing: '#b47cff' -> [0.71, 0.49, 1].
export const rgb01 = hex => hex ? [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) : null;

// One plain line, for titles and screen readers: "reviewer · Sonnet 5.5 · effort high".
export function describe(a) {
  const id = modelOf(a);
  return [a?.type, modelLabel(id), a?.effort ? `effort ${EFFORT_WORDS[a.effort].toLowerCase()}` : 'default effort'].filter(Boolean).join(' · ');
}
