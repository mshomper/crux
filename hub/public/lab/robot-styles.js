// M015 lab: three style directions for the model-family robots (Haiku, Sonnet, Opus, Fable).
// Original drawings on a 48 x 48 grid. Classes: plain shapes are line work in the model hue;
// .f is a plate (a faint fill of the hue); .g glows (eyes, visor, core): its strength is the effort.
// Matt picks one direction; the winner moves to hub/public/robots.js.

export const STYLES = {
  glyph: {
    name: 'Line glyph',
    line: 'Pure line work, like the hub\'s other icons. Lightest; the head shape tells the family.',
    stroke: 2.6,
    art: {
      // small and quick: one eye, one antenna
      haiku: '<circle cx="24" cy="29" r="13"/><path d="M24 16V9"/><circle class="g" cx="24" cy="7" r="2.4"/><circle class="g" cx="24" cy="29" r="4.4"/>',
      // balanced: two eyes, ear nodes, a T antenna
      sonnet: '<rect x="10" y="15" width="28" height="22" rx="8"/><path d="M24 15v-5M19.5 10h9M6.5 23v6M41.5 23v6"/><circle class="g" cx="18.5" cy="26" r="2.8"/><circle class="g" cx="29.5" cy="26" r="2.8"/>',
      // larger and heavier: brow, twin antennae, lens pair, grille, bolts
      opus: '<rect x="7" y="14" width="34" height="25" rx="5"/><path d="M11 21h26M15 14V8M33 14V8M19 34h2M23 34h2M27 34h2"/><circle class="g" cx="15" cy="6.5" r="1.8"/><circle class="g" cx="33" cy="6.5" r="1.8"/><rect class="g" x="14" y="24.5" width="7" height="5" rx="1.5"/><rect class="g" x="27" y="24.5" width="7" height="5" rx="1.5"/>',
      // distinctive: a six-sided head, one diamond eye, a quill crest
      fable: '<path d="M24 12l13 7v15l-13 7-13-7V19z"/><path d="M24 12c-3.5-3-1.5-6.5 0-9 1.500 2.500 3.500 6 0 9z"/><path class="g" d="M24 20.5l6.500 5.500-6.500 5.500-6.500-5.500z"/><path d="M19 35.500l5 1.800 5-1.800"/>'
    }
  },
  mech: {
    name: 'Chunky mech',
    line: 'Head and shoulders built from plates. Most character at large sizes; busiest at 24px.',
    stroke: 2.4,
    art: {
      haiku: '<rect class="f" x="16" y="13" width="16" height="14" rx="5"/><path d="M24 13V8"/><circle class="g" cx="24" cy="6.500" r="2"/><rect class="g" x="19" y="18" width="10" height="4.500" rx="2.200"/><path class="f" d="M17.500 31h13l3.500 11H14z"/>',
      sonnet: '<rect class="f" x="13" y="9" width="22" height="16" rx="4.500"/><rect class="f" x="8" y="14" width="5" height="6.500" rx="1.500"/><rect class="f" x="35" y="14" width="5" height="6.500" rx="1.500"/><rect class="g" x="17" y="14.500" width="5" height="5" rx="1.200"/><rect class="g" x="26" y="14.500" width="5" height="5" rx="1.200"/><path d="M21 25v4h6v-4"/><rect class="f" x="10" y="29" width="28" height="13" rx="4.500"/><circle class="g" cx="24" cy="35.500" r="2.600"/>',
      opus: '<path d="M16 8V4M32 8V4"/><rect class="f" x="12" y="8" width="24" height="15" rx="3"/><path d="M12 13h24"/><rect class="g" x="16" y="15.500" width="16" height="4" rx="1.500"/><path class="f" d="M4 43v-9l6-6h28l6 6v9z"/><path d="M11 28v7M37 28v7"/><path class="g" d="M24 31.500l3.500 2v4l-3.500 2-3.500-2v-4z"/>',
      fable: '<path d="M24 7V3"/><path class="f" d="M24 7l10 6v11l-10 6-10-6V13z"/><circle cx="24" cy="18.500" r="6.500"/><circle class="g" cx="24" cy="18.500" r="3.400"/><path class="f" d="M24 30l14 13H10z"/><path d="M24 30v13"/>'
    }
  },
  visor: {
    name: 'Sleek visor',
    line: 'Smooth helmets with one glowing visor. The visor is the face; effort is how bright it burns.',
    stroke: 2.4,
    art: {
      haiku: '<ellipse class="f" cx="24" cy="28" rx="11" ry="12"/><path d="M30 17.500l5.500-7"/><rect class="g" x="16" y="25" width="16" height="6.500" rx="3.200"/>',
      sonnet: '<path class="f" d="M10 30c0-11 6-18 14-18s14 7 14 18c0 5.500-4 9-14 9s-14-3.500-14-9z"/><path d="M24 12v6"/><path class="g" d="M13 27.500c3-3.200 7-4.500 11-4.500s8 1.300 11 4.500c-3 3.200-7 4.500-11 4.500s-8-1.300-11-4.500z"/>',
      opus: '<path class="f" d="M7 22l5-10h24l5 10v10l-6 9H13l-6-9z"/><path d="M17 12l7-5.500 7 5.500M8.500 31h3.500M36 31h3.500"/><path class="g" d="M11 23h26l-3 7.500h-7l-3-3.200-3 3.200h-7z"/>',
      fable: '<path class="f" d="M24 5c8 8.500 13 15.500 13 23.500a13 13 0 0 1-26 0C11 20.500 16 13.500 24 5z"/><circle cx="24" cy="28.500" r="9"/><circle class="g" cx="24" cy="28.500" r="5"/><path d="M17.500 39.500c4 1.800 9 1.800 13 0"/>'
    }
  }
};

export const FAMILIES = [
  { id: 'haiku', name: 'Haiku', hue: '#ff7fd1', note: 'small and quick' },
  { id: 'sonnet', name: 'Sonnet', hue: '#38d9ec', note: 'balanced and sleek' },
  { id: 'opus', name: 'Opus', hue: '#b47cff', note: 'larger, heavier frame' },
  { id: 'fable', name: 'Fable', hue: '#d58a58', note: 'distinctive, in copper' }
];

// glow: 0..1, how strongly the eyes burn (effort). size in px.
export function robotSvg(style, family, { size = 24, glow = 0.8, cls = '' } = {}) {
  const s = STYLES[style];
  // keep line weight readable when small: a little heavier below 32px
  const sw = size < 32 ? s.stroke * 1.12 : size > 96 ? s.stroke * 0.72 : s.stroke;
  return `<svg class="bot ${cls}" viewBox="0 0 48 48" width="${size}" height="${size}" style="--sw:${sw};--glow:${glow}" aria-hidden="true">${s.art[family]}</svg>`;
}
