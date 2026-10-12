#!/usr/bin/env node
// Regenerates every shipped art file under public/assets from the generators in this folder.
//   node assets/source/build-assets.mjs          write files
//   node assets/source/build-assets.mjs --check  verify committed files are byte-identical
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packAtlas, phaserAtlasJson } from './tools/atlas.mjs';
import { encodePng } from './tools/png.mjs';
import { PALETTE } from './tools/palette.mjs';
import { GLADIATOR_LAYERS, renderGladiator } from './generators/gladiator.mjs';
import { NPCS, renderNpcs } from './generators/npcs.mjs';
import { CREATURES, renderCreatures } from './generators/creatures.mjs';
import { renderTileset } from './generators/tiles.mjs';
import { PROP_ANIMATIONS, arenaSegment, renderCampProps, renderExpeditionProps } from './generators/props.mjs';
import { CAMP, arenaSegmentAnchors, buildCamp, buildExpedition } from './generators/maps.mjs';
import { renderEffects, renderIcons } from './generators/effects.mjs';
import { ATTACK_VARIANTS, CREATURE_ACTIONS, REQUIRED_ACTIONS } from './generators/poses.mjs';
import { ANCHOR } from './generators/rig.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(ROOT, 'public', 'assets');
const CHECK = process.argv.includes('--check');
const LICENSE = 'Project-original artwork generated from repository source (assets/source); owned by the Cloudiator project. No third-party assets.';

const files = new Map(); // relative path -> { bytes, generator }
const emitJson = (path, data, generator) => files.set(path, { bytes: Buffer.from(`${JSON.stringify(data)}\n`), generator });
const emitPng = (path, sheet, generator) => files.set(path, { bytes: encodePng(sheet.width, sheet.height, sheet.data), generator });
const src = name => `assets/source/${name}`;

const atlases = {};
const animations = {};
function addAtlas(key, image, frames, kind, generator, opts) {
  const { sheet, frames: rects } = packAtlas(frames, opts);
  const json = phaserAtlasJson(image.split('/').pop(), sheet, rects);
  for (const f of frames) if (f.meta) json.frames[f.name].meta = f.meta;
  const data = image.replace(/\.png$/, '.json');
  emitPng(image, sheet, generator);
  emitJson(data, json, generator);
  atlases[key] = { image, data, width: sheet.width, height: sheet.height, kind };
}
const actorFrames = list => list.map(f => ({ ...f, anchorX: ANCHOR.x, anchorY: ANCHOR.y }));
const propFrames = list => list.map(({ name, canvas, anchorX, anchorY, ...meta }) => ({ name, canvas, anchorX, anchorY, meta }));

// ----------------------------------------------------------------- actors
const gladiator = renderGladiator();
addAtlas('gladiators', 'actors/gladiators.png', actorFrames(gladiator.frames), 'actor', src('generators/gladiator.mjs'), { columns: 32 });
Object.assign(animations, gladiator.animations);
const npcs = renderNpcs();
addAtlas('npcs', 'actors/npcs.png', actorFrames(npcs.frames), 'actor', src('generators/npcs.mjs'), { columns: 24 });
Object.assign(animations, npcs.animations);
const creatures = renderCreatures();
addAtlas('creatures', 'actors/creatures.png', actorFrames(creatures.frames), 'actor', src('generators/creatures.mjs'), { columns: 24 });
Object.assign(animations, creatures.animations);

// ----------------------------------------------------------------- camp
addAtlas('camp', 'camp/tiles.png', renderTileset('camp'), 'tiles', src('generators/tiles.mjs'), { columns: 8 });
const campProps = [
  ...renderCampProps(),
  ...arenaSegmentAnchors().map(({ index, anchorTile }) => ({ name: `arena-wall/${index}`, ...arenaSegment(index, CAMP.arenaCentre, anchorTile) })),
];
addAtlas('camp-props', 'camp/props.png', propFrames(campProps), 'props', src('generators/props.mjs'), { padding: 2, maxWidth: 2048 });
const meta = list => Object.fromEntries(list.map(({ name, canvas, anchorX, anchorY, ...m }) => [name, m]));
const camp = buildCamp(meta(campProps));
emitJson('camp/map.json', camp, src('generators/maps.mjs'));

// ----------------------------------------------------------------- expeditions
const expeditionMaps = {};
for (const id of ['woodland', 'outpost', 'mountain']) {
  const props = renderExpeditionProps(id);
  addAtlas(id, `expeditions/${id}.png`, [...renderTileset(id), ...propFrames(props)], 'environment', src('generators/props.mjs'), { padding: 2, maxWidth: 1024 });
  expeditionMaps[id] = buildExpedition(id, meta(props));
  emitJson(`expeditions/${id}-map.json`, expeditionMaps[id], src('generators/maps.mjs'));
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
const provenance = [...files.entries()].map(([file, { bytes, generator }]) => ({
  file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
  source: 'generated', generator, command: 'node assets/source/build-assets.mjs', license: LICENSE,
})).sort((a, b) => a.file.localeCompare(b.file));

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
      notes: 'Draw layers in listed order with identical frame suffixes (layerId/action/dir/index). Tint cloth and hair per player. Two-handed weapons hide offhand-shield.',
    },
    npcs: NPCS.map(n => ({ id: n.id, name: n.name, role: n.role, atlas: 'npcs', animations: actionMap(`npc-${n.id}`, ['idle', 'walk', 'talk', 'tend'], ['idle', 'walk']) })),
    creatures: CREATURES.map(c => ({ id: c.id, name: c.name, expedition: c.expedition, atlas: 'creatures', animations: actionMap(`creature-${c.id}`, CREATURE_ACTIONS, []) })),
  },
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

if (CHECK) {
  const stale = [];
  for (const [path, bytes] of outputs) if (!existsSync(path) || !readFileSync(path).equals(bytes)) stale.push(relative(ROOT, path));
  if (stale.length) {
    console.error(`Generated assets are stale or missing:\n  ${stale.join('\n  ')}\nRun: node assets/source/build-assets.mjs`);
    process.exit(1);
  }
  console.log(`assets up to date (${outputs.size} files)`);
} else {
  for (const [path, bytes] of outputs) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); }
  console.log(`wrote ${outputs.size} files`);
}
