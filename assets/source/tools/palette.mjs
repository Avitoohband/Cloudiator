// The single colorful-fantasy palette shared by every generated sprite, tile, effect and icon.
// Matches approved reference A: warm sand, lush greens, teal and crimson cloth, stone, wood and steel.
// Generators may only paint these colors (tests reject anything else), keeping one consistent look.
export const PALETTE = {
  outline: '#1a1423',
  shadow: '#2e2433',

  white: '#ffffff',
  gray1: '#d4d4d8',
  gray2: '#a1a1aa',
  gray3: '#71717a',
  gray4: '#4b4b55',

  skin1: '#f6d2a8',
  skin2: '#e0a273',
  skin3: '#b56f45',
  skin4: '#7a432a',
  dskin1: '#a8673f',
  dskin2: '#7f4529',
  dskin3: '#55291a',

  steel1: '#eef4f7',
  steel2: '#bccad3',
  steel3: '#8394a1',
  steel4: '#4f5d69',

  wood1: '#d8995a',
  wood2: '#a8693a',
  wood3: '#744424',
  wood4: '#472813',

  leather1: '#c47d3e',
  leather2: '#93552a',
  leather3: '#5f3519',

  gold1: '#ffe48f',
  gold2: '#f2b43d',
  gold3: '#b67b1d',

  teal1: '#6fd8cf',
  teal2: '#22a39d',
  teal3: '#16716f',
  teal4: '#0d4747',

  crimson1: '#ef6450',
  crimson2: '#bd3429',
  crimson3: '#81201c',
  crimson4: '#4e1313',

  sand1: '#f5dba4',
  sand2: '#e6bd78',
  sand3: '#cc9d58',
  sand4: '#a27a41',

  grass1: '#a6d86f',
  grass2: '#76b44c',
  grass3: '#4e8d3b',
  grass4: '#30632f',

  leaf1: '#3f7d3a',
  leaf2: '#2a5a2e',
  leaf3: '#1c3f24',

  stone1: '#dcd5c8',
  stone2: '#b0a89b',
  stone3: '#837c71',
  stone4: '#59534c',
  stone5: '#3a3531',

  water1: '#8edcf4',
  water2: '#44a6dc',
  water3: '#226fab',

  fire1: '#fff4b5',
  fire2: '#ffcb42',
  fire3: '#ff8b21',
  fire4: '#d9471c',

  snow1: '#f5f8fc',
  snow2: '#d2dce9',
  snow3: '#9eadc1',

  canvas1: '#f4e8cb',
  canvas2: '#dcc9a2',
  canvas3: '#b5a07a',

  fur1: '#a8a39c',
  fur2: '#78726b',
  fur3: '#4f4a45',

  troll1: '#a3b56f',
  troll2: '#768a4c',
  troll3: '#4f6234',

  sky1: '#9fd6f2',
  violet1: '#9b7ee0',
  violet2: '#6a4fb8',
};

/** @param {string} hex */
export function hexToRgba(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 255];
}

/** @param {keyof typeof PALETTE | string} name */
export function color(name) {
  const hex = PALETTE[name];
  if (!hex) throw new Error(`Unknown palette color: ${name}`);
  return hex;
}
