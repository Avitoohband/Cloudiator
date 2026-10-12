#!/usr/bin/env node
// Regenerates every shipped art file under public/assets from the generators in this folder.
//   node assets/source/build-assets.mjs          write files
//   node assets/source/build-assets.mjs --check  verify committed files are byte-identical
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packAtlas, phaserAtlasJson } from './tools/atlas.mjs';
import { decodePng, encodePng } from './tools/png.mjs';
import { PALETTE } from './tools/palette.mjs';
import { GLADIATOR_LAYERS, renderGladiator } from './generators/gladiator.mjs';
import { NPCS, renderNpcs } from './generators/npcs.mjs';
import { CREATURES, ENCOUNTER_CREATURES, renderCreatures } from './generators/creatures.mjs';
import { renderTileset } from './generators/tiles.mjs';
import { PROP_ANIMATIONS, arenaSegment, renderCampProps, renderExpeditionProps } from './generators/props.mjs';
import { CAMP, arenaSegmentAnchors, buildCamp, buildExpedition } from './generators/maps.mjs';
import { renderEffects, renderIcons } from './generators/effects.mjs';
import { ATTACK_VARIANTS, CREATURE_ACTIONS, REQUIRED_ACTIONS, WALK_TILES_PER_SECOND } from './generators/poses.mjs';
import { ANCHOR } from './generators/rig.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(ROOT, 'public', 'assets');
const CHECK = process.argv.includes('--check');
const LICENSE = 'Project-original artwork generated from repository source (assets/source); owned by the Cloudiator project. No third-party assets.';

const files = new Map(); // relative path -> { bytes, generator, inputs }
const src = name => `assets/source/${name}`;
const COMMON = [src('build-assets.mjs'), src('tools/canvas.mjs'), src('tools/palette.mjs'), src('tools/atlas.mjs'), src('tools/png.mjs'), src('tools/random.mjs')];
const emitJson = (path, data, generator, inputs = []) => files.set(path, { bytes: Buffer.from(`${JSON.stringify(data)}\n`), generator, inputs });
/** PNG bytes depend on the zlib build; keep the committed file when its pixels are unchanged so hashes stay stable. */
function emitPng(path, sheet, generator, inputs = []) {
  let bytes = encodePng(sheet.width, sheet.height, sheet.data);
  const existing = join(OUT, path);
  if (existsSync(existing)) {
    try {
      const old = readFileSync(existing);
      const decoded = decodePng(old);
      if (decoded.width === sheet.width && decoded.height === sheet.height && Buffer.from(decoded.rgba).equals(Buffer.from(sheet.data))) bytes = old;
    } catch { /* regenerate */ }
  }
  files.set(path, { bytes, generator, inputs });
}

const atlases = {};
const animations = {};
function addAtlas(key, image, frames, kind, generator, opts, inputs = []) {
  const { sheet, frames: rects } = packAtlas(frames, opts);
  const json = phaserAtlasJson(image.split('/').pop(), sheet, rects);
  for (const f of frames) if (f.meta) json.frames[f.name].meta = f.meta;
  const data = image.replace(/\.png$/, '.json');
  emitPng(image, sheet, generator, inputs);
  emitJson(data, json, generator, inputs);
  atlases[key] = { image, data, width: sheet.width, height: sheet.height, kind };
}
const actorFrames = list => list.map(f => ({ ...f, anchorX: ANCHOR.x, anchorY: ANCHOR.y }));
const propFrames = list => list.map(({ name, canvas, anchorX, anchorY, ...meta }) => ({ name, canvas, anchorX, anchorY, meta }));

// ----------------------------------------------------------------- actors
const gladiator = renderGladiator();
const RIG = [src('generators/rig.mjs'), src('generators/poses.mjs'), src('generators/outfits.mjs')];
addAtlas('gladiators', 'actors/gladiators.png', actorFrames(gladiator.frames), 'actor', src('generators/gladiator.mjs'), { columns: 32 }, RIG);
Object.assign(animations, gladiator.animations);
const npcs = renderNpcs();
addAtlas('npcs', 'actors/npcs.png', actorFrames(npcs.frames), 'actor', src('generators/npcs.mjs'), { columns: 24 }, RIG);
Object.assign(animations, npcs.animations);
const creatures = renderCreatures();
addAtlas('creatures', 'actors/creatures.png', actorFrames(creatures.frames), 'actor', src('generators/creatures.mjs'), { columns: 24 }, RIG);
Object.assign(animations, creatures.animations);

// ----------------------------------------------------------------- camp
addAtlas('camp', 'camp/tiles.png', renderTileset('camp'), 'tiles', src('generators/tiles.mjs'), { columns: 8, padding: 2 });
const campProps = [
  ...renderCampProps(),
  ...arenaSegmentAnchors().map(({ index, anchorTile }) => ({ name: `arena-wall/${index}`, ...arenaSegment(index, CAMP.arenaCentre, anchorTile) })),
];
addAtlas('camp-props', 'camp/props.png', propFrames(campProps), 'props', src('generators/props.mjs'), { padding: 2, maxWidth: 2048 });
const meta = list => Object.fromEntries(list.map(({ name, canvas, anchorX, anchorY, ...m }) => [name, m]));
const camp = buildCamp(meta(campProps));
emitJson('camp/map.json', camp, src('generators/maps.mjs'), [src('generators/props.mjs'), src('generators/tiles.mjs'), src('generators/creatures.mjs')]);

// ----------------------------------------------------------------- expeditions
const expeditionMaps = {};
for (const id of ['woodland', 'outpost', 'mountain']) {
  const props = renderExpeditionProps(id);
  addAtlas(id, `expeditions/${id}.png`, [...renderTileset(id), ...propFrames(props)], 'environment', src('generators/props.mjs'), { padding: 2, maxWidth: 1024 }, [src('generators/tiles.mjs')]);
  expeditionMaps[id] = buildExpedition(id, meta(props));
  emitJson(`expeditions/${id}-map.json`, expeditionMaps[id], src('generators/maps.mjs'), [src('generators/props.mjs'), src('generators/tiles.mjs'), src('generators/creatures.mjs')]);
}
for (const [id, def] of Object.entries(PROP_ANIMATIONS)) {
  for (const key of ['camp-props', 'woodland', 'outpost', 'mountain']) {
    if (id === 'torch' && key !== 'camp-props') continue;
    animations[`prop-${key}-${id}`] = { atlas: key, frames: def.frames, durationsMs: def.durationsMs, loop: true };
  }
}

// ----------------------------------------------------------------- effects and icons
const effects = renderEffects();
addAtlas('effects', 'effects/combat.png', effects.frames, 'effects', src('generators/effects.mjs'), { columns: 8 });
Object.assign(animations, effects.animations);
const icons = renderIcons();
addAtlas('icons', 'ui/icons.png', icons.frames, 'icons', src('generators/effects.mjs'), { columns: 12 });

// ----------------------------------------------------------------- manifest
const actionMap = (prefix, actions, ne) => Object.fromEntries(actions.map(a => [a, {
  se: `${prefix}/${a}/se`, ...(ne.includes(a) ? { ne: `${prefix}/${a}/ne` } : {}),
}]));
const HAND_WRITTEN = ['gallery.html'];
const provenance = [
  ...[...files.entries()].map(([file, { bytes, generator, inputs }]) => ({
    file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    source: 'generated', generator, inputs: [...new Set([...inputs, ...COMMON])].sort(), command: 'node assets/source/build-assets.mjs', license: LICENSE,
  })),
  ...HAND_WRITTEN.map(file => {
    const bytes = readFileSync(join(OUT, file));
    return { file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, source: 'hand-written inspection tool', generator: 'assets/source/README.md', inputs: [], command: 'none (edit directly)', license: LICENSE };
  }),
].sort((a, b) => a.file.localeCompare(b.file));

const manifest = {
  version: 1,
  generatedBy: 'assets/source/build-assets.mjs',
  artDirection: 'Colorful fantasy pixel art, angled isometric world (approved reference A); hard-edged single palette; nearest-neighbour scaling.',
  pixelScale: { tileWidth: 64, tileHeight: 32, actorWidth: 64, actorHeight: 64 },
  projection: { tileWidth: 64, tileHeight: 32, rule: 'tile (x, y) north vertex at screen ((x - y) * 32, (x + y) * 16); actors stand at tile centres (x + 0.5, y + 0.5)' },
  palette: PALETTE,
  actions: REQUIRED_ACTIONS,
  directions: { se: { source: 'se', flipX: false }, sw: { source: 'se', flipX: true }, ne: { source: 'ne', flipX: false }, nw: { source: 'ne', flipX: true } },
  atlases,
  animations,
  actors: {
    gladiator: {
      atlas: 'gladiators',
      anchor: { x: ANCHOR.x, y: ANCHOR.y },
      layers: GLADIATOR_LAYERS,
      animations: actionMap('gladiator', [...REQUIRED_ACTIONS, ...Object.values(ATTACK_VARIANTS)], ['idle', 'walk']),
      attackVariants: ATTACK_VARIANTS,
      walk: { tilesPerSecond: WALK_TILES_PER_SECOND },
      notes: 'Draw layers in listed order with identical frame suffixes (layerId/action/dir/index). Multiply-tint layers by their tint key (skin, cloth, hair) per player. Two-handed weapons hide offhand-shield; head gear hides hair; head-helmet-crest only with head-helmet; accent is always drawn.',
    },
    npcs: NPCS.map(n => ({ id: n.id, name: n.name, role: n.role, atlas: 'npcs', animations: actionMap(`npc-${n.id}`, ['idle', 'walk', 'talk', 'tend'], ['idle', 'walk']) })),
    creatures: CREATURES.map(c => ({ id: c.id, name: c.name, expedition: c.expedition, atlas: 'creatures', animations: actionMap(`creature-${c.id}`, CREATURE_ACTIONS, []) })),
    encounterCreatures: ENCOUNTER_CREATURES,
  },
  /** Catalog template id (prefix of a catalog variant id such as 'sword:1:common') to gladiator layer id; null = not drawn. */
  equipmentLayers: {
    sword: 'weapon-sword', axe: 'weapon-axe', spear: 'weapon-spear', bow: 'weapon-bow', 'round-shield': 'offhand-shield',
    'leather-hood': 'head-hood', 'iron-helmet': 'head-helmet', 'light-armor': 'armor-light', 'heavy-armor': 'armor-heavy',
    'light-boots': null, 'heavy-boots': null,
  },
  depthRule: 'actors: depth = screen y of the feet. floor props: under all actors. foreground props: over all actors. props with explicit slices (arena wall segments): each slice draws its column range at anchor screen y + slice.depthOffset. other object props one tile wide: depth = anchor screen y + sortY - 0.5. wider object props: drawn as 32px vertical slices, each at the screen y of the footprint front edge under the slice centre - 0.5. The 0.5 bias means actors win ties. Implemented by drawSlices in src/game/depth.ts.',
  effects: effects.effects,
  icons: icons.icons,
  maps: [
    { id: 'camp', data: 'camp/map.json', tilesAtlas: 'camp', propsAtlas: 'camp-props' },
    ...['woodland', 'outpost', 'mountain'].map(id => ({ id, data: `expeditions/${id}-map.json`, tilesAtlas: id, propsAtlas: id })),
  ],
  provenance,
};

const sourceProvenance = {
  description: 'Every file under public/assets is generated by assets/source/build-assets.mjs from the generator modules listed per file. Re-running the command reproduces byte-identical output (verified with --check).',
  approval: 'Avi approved code-generated original pixel art for Task 11 on 2026-10-12 (instead of image-generation or licensed packs).',
  license: LICENSE,
  references: ['docs/superpowers/specs/references/art-style-comparison.png (panel A)', 'docs/superpowers/specs/references/world-perspective-comparison.png (panel A)'],
  files: provenance,
};

const outputs = new Map([...files.entries()].map(([p, f]) => [join(OUT, p), f.bytes]));
outputs.set(join(OUT, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 1)}\n`));
outputs.set(join(HERE, 'provenance.json'), Buffer.from(`${JSON.stringify(sourceProvenance, null, 2)}\n`));

function listFiles(dir) {
  return readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? listFiles(p) : [p]; });
}
if (CHECK) {
  const stale = [];
  for (const [path, bytes] of outputs) if (!existsSync(path) || !readFileSync(path).equals(bytes)) stale.push(relative(ROOT, path));
  const expected = new Set([...outputs.keys(), ...HAND_WRITTEN.map(f => join(OUT, f)), join(OUT, '.gitattributes')]);
  for (const path of listFiles(OUT)) if (!expected.has(path)) stale.push(`${relative(ROOT, path)} (orphan: not produced by the generators)`);
  if (stale.length) {
    console.error(`Generated assets are stale or missing:\n  ${stale.join('\n  ')}\nRun: node assets/source/build-assets.mjs`);
    process.exit(1);
  }
  console.log(`assets up to date (${outputs.size} files)`);
} else {
  for (const [path, bytes] of outputs) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); }
  console.log(`wrote ${outputs.size} files`);
}
