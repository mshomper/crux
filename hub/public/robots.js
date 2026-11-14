// A robot for each model family (M015): smooth helmets with one glowing visor, drawn on a 48 x 48 grid.
// Original drawings. The helmet's shape tells the family; everything is tinted by the model hue (decision 20).
//   Haiku   small and quick: a little egg with a pill visor and one swept antenna
//   Sonnet  balanced and sleek: a rounded helmet with an almond visor and a centre crest
//   Opus    larger, heavier frame: an angular helmet with a ridge, a slab visor with a nose guard, cheek vents
//   Fable   distinctive: a drop-shaped lantern with one round lens in a ring
// Effort is how brightly the visor burns, plus five pips on the brow from 40px up. The orchestrator wears a crown.
// State: idle blinks, working pulses, asleep goes dim, an error is amber, waiting on Matt turns the visor red
// (decision 31). All of that is in robots.css, and stops under prefers-reduced-motion.
// Classes: plain shapes are line work; .f is a plate (a faint fill); .g glows (the visor); .p is a pip.

import { family, modelOf, hueOf, pipCount } from './models.js';

const ART = {
  haiku: '<ellipse class="f" cx="24" cy="28" rx="11" ry="12"/><path d="M30.500 17.500l5-6.500"/><circle class="g a" cx="36" cy="10" r="1.700"/><rect class="g" x="16" y="25" width="16" height="6.500" rx="3.200"/>',
  sonnet: '<path class="f" d="M10 30c0-11 6-18 14-18s14 7 14 18c0 5.500-4 9-14 9s-14-3.500-14-9z"/><path d="M24 12v5.500M15 35.500c3 1.200 6 1.700 9 1.700s6-.500 9-1.700"/><path class="g" d="M13 27.500c3-3.200 7-4.500 11-4.500s8 1.300 11 4.500c-3 3.200-7 4.500-11 4.500s-8-1.300-11-4.500z"/>',
  opus: '<path class="f" d="M7 22l5-10h24l5 10v10l-6 9H13l-6-9z"/><path d="M17 12l7-5.500 7 5.500M8.500 32h3.500M36 32h3.500M18 37h12"/><path class="g" d="M11 22.500h26l-2.500 7h-8l-2.500 3.200-2.500-3.200h-8z"/>',
  fable: '<path class="f" d="M24 5c8 8.500 13 15.500 13 23.500a13 13 0 0 1-26 0C11 20.500 16 13.500 24 5z"/><circle cx="24" cy="28.500" r="9"/><circle class="g" cx="24" cy="28.500" r="5"/><path d="M17.500 39.800c4 1.700 9 1.700 13 0"/>',
  // model not known yet: a plain helmet
  plain: '<rect class="f" x="10" y="13" width="28" height="26" rx="10"/><rect class="g" x="15" y="23" width="18" height="6" rx="3"/>'
};

// Where the five effort pips sit on each helmet's brow.
const PIPS = {
  haiku: [[17.200, 21.500], [20.300, 19.300], [24, 18.500], [27.700, 19.300], [30.800, 21.500]],
  sonnet: [[16, 21], [19.800, 19.200], [24, 20.200], [28.200, 19.200], [32, 21]],
  opus: [[16, 17.500], [20, 17.500], [24, 17.500], [28, 17.500], [32, 17.500]],
  fable: [[18.200, 19.500], [20.800, 16.300], [24, 14.800], [27.200, 16.300], [29.800, 19.500]],
  plain: [[16, 18.500], [20, 18.500], [24, 18.500], [28, 18.500], [32, 18.500]]
};

const CROWN = '<path class="crown" d="M16.500 8.500l-1.500-7 5.500 3.800L24 .800l3.500 4.500 5.500-3.800-1.500 7z"/>';
// The Conductor's mark (decision 56 B, M034): a ring of four glowing nodes circling the head, the orchestrators it
// keeps in time. The nodes glow like the visor (.g), so they blink, pulse, dim and turn red with it. The back node is
// a little smaller, for depth. To change the Conductor's icon, change this mark (and its helmet offset) only.
const HALO = '<ellipse cx="24" cy="8.400" rx="16" ry="4.800" style="stroke-width:calc(var(--sw) * .7)"/>'
  + '<circle class="g" cx="8" cy="8.400" r="2.300"/><circle class="g" cx="40" cy="8.400" r="2.300"/>'
  + '<circle class="g" cx="24" cy="13.200" r="2.300"/><circle class="g" cx="24" cy="3.600" r="2"/>';
// Each mark and where it puts the helmet: the crown sits on top; the halo needs the helmet 0.8 lower to clear it.
const MARKS = {
  crown: { art: CROWN, at: 'translate(3.600 9.200) scale(.85)', first: true },
  conductor: { art: HALO, at: 'translate(3.600 10) scale(.85)', first: false }
};
const STATES = new Set(['idle', 'working', 'starting', 'asleep', 'error', 'retired']);

// How brightly the visor burns: 0.4 at low up to 1 at max; 0.7 when the effort is Claude Code's default.
export const glowFor = effort => { const n = pipCount(effort); return n ? 0.25 + 0.15 * n : 0.7; };

// The robot for an agent ({ model | modelSeen, effort, state, role }) as an SVG string.
//   size   px; pips appear from 40px up
//   needs  something of this agent's waits on Matt: the visor turns red
//   crown  defaults to true for the orchestrator
//   mark   'crown', 'conductor' (the halo) or 'none'; defaults to the role's: the orchestrator's crown, the
//          Conductor's halo. Overrides crown when given.
//   cls    extra classes for the svg
export function robot(agent, { size = 24, needs = false, crown, mark, cls = '' } = {}) {
  const a = agent || {};
  const fam = family(modelOf(a)) || 'plain', hue = hueOf(modelOf(a));
  const state = STATES.has(a.state) ? a.state : 'idle';
  const which = mark ?? (crown ?? a.role === 'orchestrator' ? 'crown' : a.role === 'conductor' ? 'conductor' : 'none');
  const m = MARKS[which];
  const lit = pipCount(a.effort);
  const pips = size >= 40 ? PIPS[fam].map(([x, y], i) => `<circle class="p${!lit ? ' hollow' : i < lit ? ' on' : ''}" cx="${x}" cy="${y}" r="1.150"/>`).join('') : '';
  // keep the line weight readable when small, and fine when large
  const sw = size < 32 ? 2.7 : size > 96 ? 1.75 : 2.4;
  const helmet = m ? `<g transform="${m.at}">${ART[fam]}${pips}</g>` : ART[fam] + pips;
  const body = m ? (m.first ? m.art + helmet : helmet + m.art) : helmet;
  const style = `--sw:${sw};--glow:${glowFor(a.effort).toFixed(2)}${hue ? `;color:${hue}` : ''}`;
  const markCls = which === 'crown' ? ' crowned' : which === 'conductor' ? ' conductor' : '';
  return `<svg class="bot bot-${fam} st-${state}${needs ? ' needs' : ''}${markCls}${cls ? ' ' + cls : ''}" viewBox="0 0 48 48" width="${size}" height="${size}" style="${style}" aria-hidden="true">${body}</svg>`;
}

// The Conductor's robot (decision 56 B): any agent drawn with the halo, whatever its role. The live map uses this.
export const conductorBot = (agent, opts = {}) => robot(agent, { ...opts, mark: 'conductor' });

// What a robot's look depends on: redraw it only when this changes.
export const robotKey = (agent, needs = false) => [family(modelOf(agent || {})) || 'plain', agent?.effort || '', agent?.state || '', agent?.role || '', needs ? 1 : 0].join('|');
