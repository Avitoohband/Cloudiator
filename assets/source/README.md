# Art source

Every atlas, map and manifest file in `public/assets/` is generated from the code in this
folder. This code is the art source: change a generator, rebuild, and review the result. Never
edit the generated PNG or JSON files by hand. The one exception is `public/assets/gallery.html`,
a hand-written inspection page that has its own provenance record.

**Production method (approved by Avi on 2026-10-12):** original pixel art written as deterministic
code, in the colorful-fantasy, angled-isometric style of reference panels A
(`docs/superpowers/specs/references/`). No image-generation output, downloaded packs or other
third-party assets are used. The plan's wording ("image-generation tool or free licensed packs")
was replaced by this route on purpose. Task 11 records this as an approved deviation.

## Commands

| Command | Effect |
| --- | --- |
| `node assets/source/build-assets.mjs` | Rebuild every file in `public/assets` plus `provenance.json`. |
| `node assets/source/build-assets.mjs --check` | Fail if any committed file differs from a fresh build, or if an orphan file sits in `public/assets`. `tests/assets` runs this check. |
| `node assets/source/tools/review-sheets.mjs` | Rewrite the review images in `docs/operations/art-review/`. |
| `node assets/source/tools/render-map.mjs <map> <out.png> [scale] [--actors]` | Render one map offline. |
| Open `/assets/gallery.html` on any static server | Play every animation live, with layer toggles and tints. |

Output is byte-identical between runs. Randomness comes only from seeded `tools/random.mjs`.
PNG compression depends on the zlib build, so the builder keeps a committed PNG whenever its
decoded pixels are unchanged. Hashes therefore stay stable across Node versions and machines.

## Layout

- `tools/`: palette-locked `PixelCanvas` and `Mask` (`canvas.mjs`), the PNG codec, atlas packing,
  the seeded random generator, and the review and map renderers.
- `generators/rig.mjs`: the pose rig and the depth slots used to clip layers.
- `generators/poses.mjs`: keyframes for all 17 gladiator animations plus the NPC `talk` and `tend` loops.
- `generators/outfits.mjs`: layer painters for body, cloth, hair, armor, head gear, weapons,
  shield, held props, NPC clothing and troll features.
- `generators/gladiator.mjs`, `npcs.mjs`, `creatures.mjs`: actor packages.
- `generators/tiles.mjs`: corner-based 64×32 isometric autotiles. There are 16 masks per environment.
- `generators/props.mjs`: camp and expedition props, and the 16 arena wall segments.
- `generators/maps.mjs`: camp and expedition layouts, covering zones, stations, walkability, path
  graphs, lights and routes.
- `generators/effects.mjs`: combat effects and 16×16 icons.
- `provenance.json`: generated. It gives the hash, generator and license for every shipped file.

## Rules the tests enforce

- **One palette, hard edges.** Every opaque pixel uses a color from `tools/palette.mjs` at alpha 255.
  Add a color to the palette before you use it.
- **Frame sizes.** Actor frames are 64×64 with a 1px transparent border, and the ground-contact
  anchor is at (32, 58). Ground tiles are 64×32 diamonds.
- **Reusable body.** Every gladiator layer has a frame for every body frame
  (`<layer>/<action>/<dir>/<i>`). Draw the layers in manifest order. The rig clips each layer part
  by the body parts in front of it, so a fixed draw order always gives correct depth.
- **Pivots.** Atlas frames carry a normalized `pivot`, which Phaser uses as the sprite origin, and
  the pixel anchor in `anchorPx`. Never write pixel values under `anchor`: Phaser would read them
  as a normalized pivot.
- **Directions.** South-east (`se`) and north-east (`ne`) are drawn. `sw` and `nw` mirror them
  (`manifest.directions`). Only `idle` and `walk` have `ne` frames. Other actions play facing
  `se` or `sw`.
- **Projection.** The north vertex of tile (x, y) is at screen ((x − y)·32, (x + y)·16). A prop's
  anchor is the north vertex of its anchor tile. One-tile props draw at `screenY(anchor) + sortY`.
  Wider props are drawn as 32px vertical slices, each at the screen y of the footprint's front edge
  under it, so actors in front of any face draw over it. Arena wall segments ship explicit
  `slices`: each one sorts at the lowest ground point of the wall band within its own columns.
  Every sort line is biased half a pixel early, so an actor exactly on it draws in front.
  `floor` props draw under all actors and `foreground` props over them. Use `drawSlices` in
  `src/game/depth.ts` (the offline renderers use the identical `tools/depth.mjs`). The rule is also
  in `manifest.depthRule`. It is tested against every wide prop and, pixel by pixel, against the
  arena ring.

## Runtime notes for Tasks 12, 14 and 15

- Multiply-tint every layer that has a `tint` key (`skin`, `cloth` or `hair`) with that player's
  colour. The `accent` sash, the front flap and the helmet crest share the cloth colour, so
  players stay recognisable under heavy armour.
- Map equipment with `manifest.equipmentLayers`, keyed by the catalog template id (the part of
  `sword:1:common` before the first colon). When the gladiator holds a two-handed weapon (spear or
  bow), hide `offhand-shield`. When it wears head gear, hide `hair`. Draw `head-helmet-crest`
  only with `head-helmet`.
- Move walkers at `actors.gladiator.walk.tilesPerSecond`, which matches the walk stride.
- Attack variants: `thrust` for the spear and `shoot` for the bow
  (`actors.gladiator.attackVariants`).
- Use nearest-neighbour scaling everywhere. Phaser's pixel-art mode covers this.
- Lighting, sky tint and torch glow come from the scene (Task 12). Animated props reference the
  `prop-<atlas>-torch` and `prop-<atlas>-campfire` animations.
